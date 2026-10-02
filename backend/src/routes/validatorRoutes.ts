import { Router, Request, Response, IRouter } from "express";
import { logger } from "../utils/logger.js";
import { getValidatorInfo as getBeaconNodeValidatorInfo } from "../clients/beaconClient.js";
import {
  computeEpochRangeRewards,
  type ComputedEpochResult,
} from "../services/attestationService.js";
import {
  getCurrentEpoch,
  getEpochRange,
  getFinalizedEpochCached,
} from "../utils/epochUtils.js";
import { validatorMissedAttestations } from "../monitoring/metrics.js";
import { VALIDATOR_PUBKEYS } from "../../constants.js";
import { DATA_MODE } from "../../constants.js";
import { getSnapshotResults } from "../services/snapshotService.js";

export const validatorRouter: IRouter = Router();

// ─── Types ────────────────────────────────────────────────────────────────────

interface EpochEntry {
  epoch: number;
  included: boolean;
  inclusionDelay: number | null;
  sourceCorrect: boolean;
  targetCorrect: boolean;
  headCorrect: boolean;
  missType: ComputedEpochResult["missType"];
  rewards: { source: string; target: string; head: string; total: string };
  missed: { source: string; target: string; head: string; total: string };
  baseReward: string;
  dataSource: "beacon_node" | "local_snapshot";
}

interface MissingEpoch {
  epoch: number;
  reason: "no_data" | "compute_error";
  code?: string;
}

interface PerformanceSummary {
  epochsChecked: number;
  correct: number;
  wrongHead: number;
  wrongTarget: number;
  wrongSource: number;
  missed: number;
  lateSource: number;
  lateHead: number;
  avgInclusionDelay: number | null;
  totalEarnedGwei: string;
  totalMissedGwei: string;
  totalMissedEth: string;
  /** Per-component missed rewards summed across all epochs (Gwei, as decimal string) */
  sourceMissedGwei: string;
  targetMissedGwei: string;
  headMissedGwei: string;
  /** Per-component missed rewards summed across all epochs (ETH, 9-decimal string) */
  sourceMissedEth: string;
  targetMissedEth: string;
  headMissedEth: string;
}

interface PerformanceResponse {
  validatorIndex: number;
  pubkey: string;
  fromEpoch: number;
  toEpoch: number;
  epochs: EpochEntry[];
  missingEpochs: MissingEpoch[];
  summary: PerformanceSummary;
  /** Always 'beacon_node' — rewards computed directly from Altair spec */
  dataSource: "beacon_node" | "local_snapshot";
}

async function resolveValidatorIdentity(
  identifier: number | string,
): Promise<{ validatorIndex: number; pubkey: string; status: string }> {
  const info = await getBeaconNodeValidatorInfo(identifier);
  return {
    validatorIndex: Number(info.index),
    pubkey: info.validator.pubkey,
    status: info.status,
  };
}

function inactiveValidatorResult(
  validatorIndex: number,
  pubkey: string,
  status: string,
  fromEpoch: number,
  toEpoch: number,
): BatchValidatorResult {
  return {
    validatorIndex,
    pubkey,
    fromEpoch,
    toEpoch,
    epochs: [],
    missingEpochs: [],
    summary: emptySummary(),
    dataSource: "beacon_node",
    error: `Validator is not active: ${status}`,
  };
}

// ─── Epoch range resolution ────────────────────────────────────────────────────

/**
 * Resolves the epoch range from query/body params.
 *
 * Priority: explicit fromEpoch/toEpoch > days lookback.
 *
 * There is NO hard per-request epoch cap.  The caller controls the window
 * via `days` (max 90) or explicit epoch params.  Pagination is the
 * caller's responsibility for very large ranges.
 */
async function resolveEpochRange(
  rawDays: unknown,
  rawFrom: unknown,
  rawTo: unknown,
  rawMinutes?: unknown,
): Promise<{ fromEpoch: number; toEpoch: number; error?: string }> {
  const finalizedEpoch = await getFinalizedEpochCached();

  if (rawFrom !== undefined || rawTo !== undefined) {
    const from = Number(rawFrom);
    const to = Number(rawTo ?? finalizedEpoch);
    if (!Number.isInteger(from) || from < 0)
      return {
        fromEpoch: 0,
        toEpoch: 0,
        error: "fromEpoch must be a non-negative integer",
      };
    if (!Number.isInteger(to) || to < 0)
      return {
        fromEpoch: 0,
        toEpoch: 0,
        error: "toEpoch must be a non-negative integer",
      };
    if (from > to)
      return {
        fromEpoch: 0,
        toEpoch: 0,
        error: "fromEpoch must be <= toEpoch",
      };

    const cappedTo = Math.min(to, finalizedEpoch);
    return { fromEpoch: from, toEpoch: cappedTo };
  }

  if (rawMinutes !== undefined) {
    const minutes = Number(rawMinutes);
    if (!Number.isInteger(minutes) || minutes < 1)
      return {
        fromEpoch: 0,
        toEpoch: 0,
        error: "minutes must be a positive integer",
      };

    // 1 epoch = 384 seconds (32 slots * 12s)
    const epochsToSubtract = Math.ceil((minutes * 60) / 384);
    const toEpoch = finalizedEpoch;
    const fromEpoch = Math.max(0, toEpoch - epochsToSubtract);
    return { fromEpoch, toEpoch };
  }

  const days = rawDays !== undefined ? Number(rawDays) : 7;
  if (!Number.isInteger(days) || days < 1 || days > 90)
    return {
      fromEpoch: 0,
      toEpoch: 0,
      error: "days must be an integer between 1 and 90",
    };

  const { fromEpoch, toEpoch } = getEpochRange(days, finalizedEpoch);
  return { fromEpoch, toEpoch };
}

// ─── Core fetch + compute helper ──────────────────────────────────────────────

/**
 * Runs the on-chain computation pipeline for a single validator over a range.
 *
 * Each epoch is computed from beacon node data via attestationService.
 * The Altair reward formula (rewardCalculator.ts) is invoked for every epoch.
 */
async function fetchValidatorEpochs(
  validatorIndex: number,
  fromEpoch: number,
  toEpoch: number,
): Promise<{
  epochs: EpochEntry[];
  missingEpochs: MissingEpoch[];
  missCounts: { source: number; target: number; head: number };
}> {
  const { results, missingEpochs: rawMissing } = await computeEpochRangeRewards(
    validatorIndex,
    fromEpoch,
    toEpoch,
  );

  const epochs: EpochEntry[] = results.map((r) => ({
    epoch: r.epoch,
    included: r.included,
    inclusionDelay: r.inclusionDelay,
    sourceCorrect: r.timelySource,
    targetCorrect: r.timelyTarget,
    headCorrect: r.timelyHead,
    missType: r.missType,
    rewards: {
      source: r.sourceReward,
      target: r.targetReward,
      head: r.headReward,
      total: r.totalEarned,
    },
    missed: {
      source: r.sourceMissed,
      target: r.targetMissed,
      head: r.headMissed,
      total: r.totalMissed,
    },
    baseReward: r.baseReward,
    dataSource: "beacon_node",
  }));

  const missingEpochs: MissingEpoch[] = rawMissing.map((m) => ({
    epoch: m.epoch,
    reason: "compute_error",
    code: m.code,
  }));

  const missCounts = { source: 0, target: 0, head: 0 };
  for (const e of epochs) {
    if (!e.sourceCorrect) missCounts.source++;
    if (!e.targetCorrect) missCounts.target++;
    if (!e.headCorrect) missCounts.head++;
  }

  return { epochs, missingEpochs, missCounts };
}

// ─── Summary builder ──────────────────────────────────────────────────────────

function gweiToEthString(gwei: bigint): string {
  const gweiPerEth = 1_000_000_000n;
  const ethWhole = gwei / gweiPerEth;
  const ethFrac = (gwei % gweiPerEth).toString().padStart(9, "0");
  return `${ethWhole}.${ethFrac}`;
}

function buildSummary(epochs: EpochEntry[]): PerformanceSummary {
  let correct = 0,
    wrongHead = 0,
    wrongTarget = 0,
    wrongSource = 0,
    missed = 0,
    lateSource = 0,
    lateHead = 0;
  let totalDelay = 0,
    delayCount = 0;
  let totalEarned = 0n,
    totalMissed = 0n;
  let sourceMissed = 0n,
    targetMissed = 0n,
    headMissed = 0n;

  for (const e of epochs) {
    switch (e.missType) {
      case "correct":
        correct++;
        break;
      case "wrong_head":
        wrongHead++;
        break;
      case "wrong_target":
        wrongTarget++;
        break;
      case "wrong_source":
        wrongSource++;
        break;
      case "missed_entirely":
        missed++;
        break;
      case "late_source":
        lateSource++;
        break;
      case "late_head":
        lateHead++;
        break;
    }
    if (e.inclusionDelay !== null) {
      totalDelay += e.inclusionDelay;
      delayCount++;
    }
    totalEarned += BigInt(e.rewards.total);
    totalMissed += BigInt(e.missed.total);
    sourceMissed += BigInt(e.missed.source);
    targetMissed += BigInt(e.missed.target);
    headMissed += BigInt(e.missed.head);
  }

  return {
    epochsChecked: epochs.length,
    correct,
    wrongHead,
    wrongTarget,
    wrongSource,
    missed,
    lateSource,
    lateHead,
    avgInclusionDelay:
      delayCount > 0 ? Math.round((totalDelay / delayCount) * 100) / 100 : null,
    totalEarnedGwei: totalEarned.toString(),
    totalMissedGwei: totalMissed.toString(),
    totalMissedEth: gweiToEthString(totalMissed),
    sourceMissedGwei: sourceMissed.toString(),
    targetMissedGwei: targetMissed.toString(),
    headMissedGwei: headMissed.toString(),
    sourceMissedEth: gweiToEthString(sourceMissed),
    targetMissedEth: gweiToEthString(targetMissed),
    headMissedEth: gweiToEthString(headMissed),
  };
}

function emptySummary(): PerformanceSummary {
  return {
    epochsChecked: 0,
    correct: 0,
    wrongHead: 0,
    wrongTarget: 0,
    wrongSource: 0,
    missed: 0,
    lateSource: 0,
    lateHead: 0,
    avgInclusionDelay: null,
    totalEarnedGwei: "0",
    totalMissedGwei: "0",
    totalMissedEth: "0.000000000",
    sourceMissedGwei: "0",
    targetMissedGwei: "0",
    headMissedGwei: "0",
    sourceMissedEth: "0.000000000",
    targetMissedEth: "0.000000000",
    headMissedEth: "0.000000000",
  };
}

// ─── GET /api/validators/tracked ─────────────────────────────────────────────

validatorRouter.get("/tracked", (_req: Request, res: Response): void => {
  res.json({ pubkeys: VALIDATOR_PUBKEYS });
});

// ─── GET /api/validators/:index/performance ───────────────────────────────────

/**
 * Returns on-chain computed attestation performance for a single validator.
 *
 * Query params (choose one mode):
 *   days       — calendar days to look back (default: 7, max: 90)
 *   fromEpoch  — explicit start epoch (inclusive); overrides days
 *   toEpoch    — explicit end epoch (inclusive, defaults to finalized)
 *
 * The finalized epoch is fetched live from the beacon node
 * (GET /eth/v1/beacon/states/head/finality_checkpoints), not derived
 * from wall-clock math.
 *
 * There is no per-request epoch cap; the full requested range is returned.
 * For very large ranges (>100 epochs) callers should use pagination via
 * fromEpoch/toEpoch slices.
 */
validatorRouter.get(
  "/:index/performance",
  async (req: Request, res: Response): Promise<void> => {
    const rawIndex = req.params["index"];
    const validatorIndex = Number(rawIndex);

    if (!Number.isInteger(validatorIndex) || validatorIndex < 0) {
      res.status(400).json({
        error: "Invalid validator index — must be a non-negative integer",
      });
      return;
    }

    if (DATA_MODE === "snapshot") {
      const snapshotResults = getSnapshotResults([validatorIndex]);
      if (snapshotResults.length > 0) {
        res.json(snapshotResults[0]);
        return;
      }
    }

    const range = await resolveEpochRange(
      req.query["days"],
      req.query["fromEpoch"],
      req.query["toEpoch"],
      req.query["minutes"],
    );
    if (range.error) {
      res.status(400).json({ error: range.error });
      return;
    }

    logger.info("Validator performance request", {
      validatorIndex,
      fromEpoch: range.fromEpoch,
      toEpoch: range.toEpoch,
    });

    // Resolve pubkey via Beacon node metadata. This avoids consuming
    // beaconcha.in quota for simple index/pubkey translation.
    let pubkey: string;
    try {
      const info = await resolveValidatorIdentity(validatorIndex);
      pubkey = info.pubkey;
    } catch (err) {
      const e = err as { code: string; message: string };
      if (e.code === "BEACON_HTTP_404") {
        res
          .status(404)
          .json({ error: `Validator ${validatorIndex} not found` });
        return;
      }
      if (e.code === "BEACON_HTTP_429" || e.code.startsWith("BEACON_HTTP_5")) {
        res
          .status(503)
          .json({ error: "Beacon node is currently unreachable or rate limited" });
        return;
      }
      logger.error("Unexpected error resolving validator info", {
        code: e.code,
        message: e.message,
        validatorIndex,
      });
      res.status(500).json({ error: "Internal server error" });
      return;
    }

    // On-chain computation via attestationService
    let epochs: EpochEntry[];
    let missingEpochs: MissingEpoch[];
    let missCounts: { source: number; target: number; head: number };

    try {
      ({ epochs, missingEpochs, missCounts } = await fetchValidatorEpochs(
        validatorIndex,
        range.fromEpoch,
        range.toEpoch,
      ));
    } catch (err) {
      logger.error("Failed to compute epoch rewards", {
        code: (err as { code?: string }).code ?? "UNKNOWN",
        message: String(err),
        validatorIndex,
      });
      res.status(500).json({ error: "Internal server error" });
      return;
    }

    const summary = buildSummary(epochs);

    validatorMissedAttestations.set(
      { validator_index: String(validatorIndex), component: "source" },
      missCounts.source,
    );
    validatorMissedAttestations.set(
      { validator_index: String(validatorIndex), component: "target" },
      missCounts.target,
    );
    validatorMissedAttestations.set(
      { validator_index: String(validatorIndex), component: "head" },
      missCounts.head,
    );

    const response: PerformanceResponse = {
      validatorIndex,
      pubkey,
      fromEpoch: range.fromEpoch,
      toEpoch: range.toEpoch,
      epochs,
      missingEpochs,
      summary,
      dataSource: "beacon_node",
    };
    res.json(response);
  },
);

// ─── POST /api/validators/batch/performance ───────────────────────────────────

interface BatchRequestBody {
  validators?: unknown[];
  days?: unknown;
  minutes?: unknown;
  fromEpoch?: unknown;
  toEpoch?: unknown;
}

interface BatchValidatorResult {
  validatorIndex: number;
  pubkey: string;
  fromEpoch: number;
  toEpoch: number;
  epochs: EpochEntry[];
  missingEpochs: MissingEpoch[];
  summary: PerformanceSummary;
  dataSource: "beacon_node" | "local_snapshot";
  error?: string;
}

validatorRouter.post(
  "/batch/performance",
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as BatchRequestBody;

    const rawValidators: unknown[] =
      Array.isArray(body.validators) && body.validators.length > 0
        ? body.validators
        : VALIDATOR_PUBKEYS;

    if (DATA_MODE === "snapshot") {
      const snapshotFilter =
        Array.isArray(body.validators) && body.validators.length > 0
          ? body.validators
          : [];
      const results = getSnapshotResults(snapshotFilter);
      const range = results[0];
      res.json({
        fromEpoch: range?.fromEpoch ?? 0,
        toEpoch: range?.toEpoch ?? 0,
        results,
        dataSource: "local_snapshot",
      });
      return;
    }

    const range = await resolveEpochRange(
      body.days,
      body.fromEpoch,
      body.toEpoch,
      body.minutes,
    );
    if (range.error) {
      res.status(400).json({ error: range.error });
      return;
    }

    if (rawValidators.length === 0) {
      res.status(400).json({
        error: "No validators provided and VALIDATOR_PUBKEYS is empty",
      });
      return;
    }
    if (rawValidators.length > 50) {
      res
        .status(400)
        .json({ error: "Maximum 50 validators per batch request" });
      return;
    }

    logger.info("Batch performance request", {
      validatorCount: rawValidators.length,
      fromEpoch: range.fromEpoch,
      toEpoch: range.toEpoch,
    });

    // Sentinel thrown when the Beacon node is completely unreachable.
    // Promise.all rejects immediately on the first throw, so a single
    // BEACONCHAIN_UNAVAILABLE error aborts the whole batch rather than
    // silently returning partial results.
    class BeaconNodeUnavailableError extends Error {}

    const processValidator = async (
      raw: unknown,
    ): Promise<BatchValidatorResult> => {
      const identifier =
        typeof raw === "number" || typeof raw === "string" ? raw : null;
      if (identifier === null) {
        return {
          validatorIndex: -1,
          pubkey: String(raw),
          fromEpoch: range.fromEpoch,
          toEpoch: range.toEpoch,
          epochs: [],
          missingEpochs: [],
          summary: emptySummary(),
          dataSource: "beacon_node",
          error:
            "Invalid validator identifier — must be a number or 0x-prefixed string",
        };
      }

      let validatorIndex: number;
      let pubkey: string;

      try {
        const info = await resolveValidatorIdentity(identifier);
        validatorIndex = info.validatorIndex;
        pubkey = info.pubkey;
        if (!info.status.startsWith("active_")) {
          return inactiveValidatorResult(
            validatorIndex,
            pubkey,
            info.status,
            range.fromEpoch,
            range.toEpoch,
          );
        }
      } catch (err) {
        const e = err as { code: string; message: string };
        if (e.code === "BEACON_HTTP_429" || e.code.startsWith("BEACON_HTTP_5")) {
          // Abort the entire batch — service-level failure affects all validators
          throw new BeaconNodeUnavailableError();
        }
        return {
          validatorIndex: -1,
          pubkey: String(identifier),
          fromEpoch: range.fromEpoch,
          toEpoch: range.toEpoch,
          epochs: [],
          missingEpochs: [],
          summary: emptySummary(),
          dataSource: "beacon_node",
          error:
            e.code === "BEACON_HTTP_404"
              ? `Validator ${identifier} not found`
              : `Failed to resolve validator: ${e.message || e.code}`,
        };
      }

      try {
        const { epochs, missingEpochs, missCounts } =
          await fetchValidatorEpochs(
            validatorIndex,
            range.fromEpoch,
            range.toEpoch,
          );

        validatorMissedAttestations.set(
          { validator_index: String(validatorIndex), component: "source" },
          missCounts.source,
        );
        validatorMissedAttestations.set(
          { validator_index: String(validatorIndex), component: "target" },
          missCounts.target,
        );
        validatorMissedAttestations.set(
          { validator_index: String(validatorIndex), component: "head" },
          missCounts.head,
        );

        return {
          validatorIndex,
          pubkey,
          fromEpoch: range.fromEpoch,
          toEpoch: range.toEpoch,
          epochs,
          missingEpochs,
          summary: buildSummary(epochs),
          dataSource: "beacon_node",
        };
      } catch (err) {
        logger.error("Error computing batch epoch rewards", {
          validatorIndex,
          code: (err as { code?: string }).code ?? "UNKNOWN",
        });
        return {
          validatorIndex,
          pubkey,
          fromEpoch: range.fromEpoch,
          toEpoch: range.toEpoch,
          epochs: [],
          missingEpochs: [],
          summary: emptySummary(),
          dataSource: "beacon_node",
          error: "Internal error computing epoch data",
        };
      }
    };

    // Process all validators concurrently.  Each validator's epoch loop
    // remains sequential internally (avoids beacon-node overload), but
    // multiple validators now run in parallel — a 5× speedup on cold cache.
    let results: BatchValidatorResult[];
    try {
      results = await Promise.all(rawValidators.map(processValidator));
    } catch (err) {
      if (err instanceof BeaconNodeUnavailableError) {
        res
          .status(503)
          .json({ error: "Beacon node is currently unreachable or rate limited" });
        return;
      }
      throw err;
    }

    logger.info("Batch performance response built", {
      total: results.length,
      errors: results.filter((r) => r.error).length,
    });

    res.json({ fromEpoch: range.fromEpoch, toEpoch: range.toEpoch, results });
  },
);
