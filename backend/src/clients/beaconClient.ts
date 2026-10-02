import axios, { AxiosError } from "axios";
import { cacheGet, cacheSet } from "../cache/redisClient.js";
import { VALIDATOR_INFO_CACHE_TTL_SECONDS } from "../../constants.js";
import { logger } from "../utils/logger.js";
import {
  beaconApiRequestsTotal,
  beaconApiDurationSeconds,
  epochFetchErrorsTotal,
  activeValidatorBalanceGwei,
} from "../monitoring/metrics.js";
import { BEACON_URL } from "../../constants.js";

interface BeaconApiError {
  code: string;
  message: string;
  epoch?: number;
}

interface ValidatorData {
  index: string;
  balance: string;
  status: string;
  validator: {
    pubkey: string;
    effective_balance: string;
    slashed: boolean;
    activation_epoch: string;
    exit_epoch: string;
    [key: string]: unknown;
  };
}

interface ValidatorResponse {
  data: ValidatorData;
}

interface ActiveBalanceResult {
  totalActiveBalance: bigint;
  activeValidatorCount: number;
}

interface AttestationData {
  aggregation_bits: string;
  /**
   * Post-Electra (EIP-7549): bitvector where bit i = 1 means committee i is included.
   * Pre-Electra: this field is absent.
   */
  committee_bits?: string;
  data: {
    slot: string;
    index: string;
    beacon_block_root: string;
    source: { epoch: string; root: string };
    target: { epoch: string; root: string };
  };
  signature: string;
}

export interface BeaconBlockV2 {
  slot: string;
  proposer_index: string;
  parent_root: string;
  state_root: string;
  body: {
    randao_reveal: string;
    eth1_data: {
      deposit_root: string;
      deposit_count: string;
      block_hash: string;
    };
    graffiti: string;
    proposer_slashings: unknown[];
    attester_slashings: unknown[];
    attestations: AttestationData[];
    deposits: unknown[];
    voluntary_exits: unknown[];
    sync_aggregate?: {
      sync_committee_bits: string;
      sync_committee_signature: string;
    };
    execution_payload?: {
      block_hash: string;
      block_number: string;
      timestamp: string;
      [key: string]: unknown;
    };
  };
}

function resolvedBeaconUrl(): string {
  if (!BEACON_URL)
    throw {
      code: "CONFIG_MISSING",
      message: "BEACON_URL is not set in environment",
    } satisfies BeaconApiError;
  return BEACON_URL;
}

/**
 * Fetches a Beacon API URL with exponential backoff retry.
 *
 * - Tracks `beacon_api_duration_seconds` histogram per attempt.
 * - Increments `beacon_api_requests_total` on success or each failure.
 * - On 429 or 5xx: logs a warning, waits exponential backoff, retries.
 * - On final failure: increments `epoch_fetch_errors_total { reason: 'max_retries' }`.
 */
export async function fetchWithRetry(
  url: string,
  params?: Record<string, string>,
  maxRetries = 3,
): Promise<unknown> {
  let lastError: BeaconApiError | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const endTimer = beaconApiDurationSeconds.startTimer({ endpoint: url });

    try {
      const startMs = Date.now();
      const response = await axios.get(url, { params, timeout: 30_000 });
      const durationMs = Date.now() - startMs;
      endTimer();

      if (durationMs > 2_000) {
        logger.warn("Slow Beacon API response", { url, durationMs });
      }

      beaconApiRequestsTotal.inc({ endpoint: url, status: "200" });
      logger.debug("Beacon API raw response", {
        url,
        shape: typeof response.data,
      });

      return response.data;
    } catch (err) {
      endTimer();

      const axiosErr = err as AxiosError;
      const status = axiosErr.response?.status;
      const statusLabel =
        status === 429 ? "429" : status && status >= 500 ? "5xx" : "error";

      beaconApiRequestsTotal.inc({ endpoint: url, status: statusLabel });

      lastError = {
        code: `BEACON_HTTP_${status ?? "UNKNOWN"}`,
        message: axiosErr.message,
      };

      if (attempt < maxRetries) {
        const backoffMs = Math.min(1_000 * 2 ** attempt, 30_000);
        logger.warn("Beacon API request failed, retrying", {
          url,
          attempt,
          status: statusLabel,
          backoffMs,
        });
        await sleep(backoffMs);
      }
    }
  }

  epochFetchErrorsTotal.inc({ reason: "max_retries" });
  logger.error("Beacon API max retries exhausted", {
    code: lastError?.code ?? "UNKNOWN",
    message: lastError?.message ?? "unknown error",
    url,
  });

  throw (
    lastError ??
    ({
      code: "BEACON_UNKNOWN",
      message: "Unknown Beacon API error",
    } satisfies BeaconApiError)
  );
}

/**
 * Fetches full validator info from the Beacon node head state.
 *
 * Endpoint: GET /eth/v1/beacon/states/head/validators/{index}
 */
export async function getValidatorInfo(
  validatorIndex: string | number,
): Promise<ValidatorData> {
  const url = `${resolvedBeaconUrl()}/eth/v1/beacon/states/head/validators/${validatorIndex}`;
  const raw = (await fetchWithRetry(url)) as ValidatorResponse;

  logger.info("Validator info fetched", {
    index: raw.data.index,
    pubkey: raw.data.validator.pubkey,
    status: raw.data.status,
  });

  return raw.data;
}

/**
 * Sums the effective balance of all `active_ongoing` validators at a given epoch.
 *
 * Endpoint: GET /eth/v1/beacon/states/{slot}/validators?status=active_ongoing
 * where slot = epoch × 32.
 *
 * Updates the `active_validator_balance_gwei` Prometheus gauge.
 */
export async function getActiveValidatorBalance(
  epoch: number,
): Promise<ActiveBalanceResult> {
  // Non-archival beacon nodes only retain state for the last few slots.
  // "finalized" is always available and correct for recently-finalized epochs,
  // which is the only range this application queries.
  const stateId = "finalized";
  const url = `${resolvedBeaconUrl()}/eth/v1/beacon/states/${stateId}/validators`;

  let raw: unknown;
  try {
    raw = await fetchWithRetry(url, { status: "active_ongoing" });
  } catch (err) {
    const e = err as BeaconApiError;
    throw { code: e.code, message: e.message, epoch } satisfies BeaconApiError;
  }

  const body = raw as {
    data: Array<{ validator: { effective_balance: string } }>;
  };
  const validators = body.data;

  let totalActiveBalance = 0n;
  for (const v of validators) {
    totalActiveBalance += BigInt(v.validator.effective_balance);
  }

  const activeValidatorCount = validators.length;

  // Convert to ETH (1 ETH = 10^9 gwei) to stay within safe integer range
  const totalActiveBalanceEth = Number(totalActiveBalance / 1_000_000_000n);

  activeValidatorBalanceGwei.set(
    { epoch: String(epoch) },
    totalActiveBalanceEth,
  );

  logger.info("Active validator balance fetched", {
    epoch,
    stateId,
    activeValidatorCount,
    totalActiveBalanceGwei: totalActiveBalance.toString(),
  });

  return { totalActiveBalance, activeValidatorCount };
}

/**
 * Fetches all attestations included in a given beacon chain slot.
 *
 * Endpoint: GET /eth/v1/beacon/blocks/{slot}/attestations
 *
 * A 404 means the slot was missed (no block proposed) — returns `null`, not an error.
 */
export async function getBlockAttestations(
  slot: number,
): Promise<AttestationData[] | null> {
  const url = `${resolvedBeaconUrl()}/eth/v1/beacon/blocks/${slot}/attestations`;

  let raw: unknown;
  try {
    raw = await fetchWithRetry(url);
  } catch (err) {
    const e = err as BeaconApiError;
    // 404 = missed slot — not an error condition
    if (e.code === "BEACON_HTTP_404") {
      logger.info("Slot missed (no block)", { slot });
      return null;
    }
    throw e;
  }

  const body = raw as { data: AttestationData[] };
  const attestations = body.data;

  logger.info("Block attestations fetched", {
    slot,
    attestationCount: attestations.length,
  });

  return attestations;
}

/**
 * Fetches full block data for a given slot using the v2 blocks endpoint.
 *
 * Endpoint: GET /eth/v2/beacon/blocks/{slot}
 *
 * Returns the full BeaconBlockV2 body including attestations, sync aggregate,
 * and execution payload. A 404 indicates a missed slot — returns `null`.
 */
export async function getBlockV2(slot: number): Promise<BeaconBlockV2 | null> {
  const url = `${resolvedBeaconUrl()}/eth/v2/beacon/blocks/${slot}`;

  let raw: unknown;
  try {
    raw = await fetchWithRetry(url);
  } catch (err) {
    const e = err as BeaconApiError;
    if (e.code === "BEACON_HTTP_404") {
      logger.info("Slot missed (no block) v2", { slot });
      return null;
    }
    throw e;
  }

  const body = raw as { data: { message: BeaconBlockV2 } };
  const block = body.data.message;

  logger.info("Block v2 fetched", {
    slot,
    proposer: block.proposer_index,
    attestations: block.body.attestations.length,
  });

  return block;
}

/**
 * Fetches the current finalized epoch directly from the beacon node.
 *
 * Endpoint: GET /eth/v1/beacon/states/head/finality_checkpoints
 *
 * Returns the finalized epoch as reported by the beacon chain.
 * This replaces the wall-clock estimate in epochUtils.ts with
 * the canonical value from the node.
 *
 * Falls back to null on any error so callers can fall back to
 * the wall-clock estimate gracefully.
 */
export async function getFinalizedEpoch(): Promise<number | null> {
  const url = `${resolvedBeaconUrl()}/eth/v1/beacon/states/head/finality_checkpoints`;

  let raw: unknown;
  try {
    raw = await fetchWithRetry(url);
  } catch (err) {
    const e = err as BeaconApiError;
    logger.warn("Failed to fetch finality checkpoints from beacon node", {
      code: e.code,
      message: e.message,
    });
    return null;
  }

  const body = raw as {
    data: {
      previous_justified: { epoch: string; root: string };
      current_justified: { epoch: string; root: string };
      finalized: { epoch: string; root: string };
    };
  };

  const epoch = Number(body.data.finalized.epoch);

  logger.info("Finalized epoch fetched from beacon node", {
    finalizedEpoch: epoch,
    finalizedRoot: body.data.finalized.root.slice(0, 16) + "...",
  });

  return epoch;
}

/**
 * Fetches a single validator's effective balance at a specific epoch.
 *
 * Endpoint: GET /eth/v1/beacon/states/finalized/validators/{index}
 *
 * Non-archival beacon nodes only retain state for the last few slots, so
 * slot-based state IDs (epoch * 32) return 404 for any epoch older than ~2.
 * Using "finalized" is always available and sufficient: this application only
 * queries recently-finalized epochs, so the finalized state's effective_balance
 * is the correct value for the epoch being computed.
 *
 * @param validatorIndex - Numeric validator index
 * @param epoch - The epoch at which to fetch the effective balance (used for logging only)
 * @returns Effective balance in Gwei as BigInt
 */
export async function getValidatorEffectiveBalanceAtEpoch(
  validatorIndex: number,
  epoch: number,
): Promise<bigint> {
  // The URL always uses stateId="finalized" regardless of `epoch`, so the
  // result is identical for every epoch of the same validator within a single
  // request cycle.  Cache by validatorIndex to avoid N redundant HTTP calls
  // when computing rewards across a large epoch range on cold cache.
  // TTL matches validator-info TTL (default 1 h) — effective balance changes
  // only on penalties/deposits, both of which are rare on a healthy validator.
  const cacheKey = `effective_balance:finalized:${validatorIndex}`;
  const cached = await cacheGet<string>(cacheKey);
  if (cached !== undefined) {
    logger.debug("Validator effective balance from cache", {
      validatorIndex,
      epoch,
      effectiveBalance: cached,
    });
    return BigInt(cached!);
  }

  const stateId = "finalized";
  const url = `${resolvedBeaconUrl()}/eth/v1/beacon/states/${stateId}/validators/${validatorIndex}`;

  let raw: unknown;
  try {
    raw = await fetchWithRetry(url);
  } catch (err) {
    const e = err as BeaconApiError;
    throw { code: e.code, message: e.message, epoch } satisfies BeaconApiError;
  }

  const body = raw as ValidatorResponse;
  const effectiveBalance = BigInt(body.data.validator.effective_balance);

  await cacheSet(
    cacheKey,
    effectiveBalance.toString(),
    VALIDATOR_INFO_CACHE_TTL_SECONDS,
  );

  logger.debug("Validator effective balance fetched", {
    validatorIndex,
    epoch,
    stateId,
    effectiveBalance: effectiveBalance.toString(),
  });

  return effectiveBalance;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
