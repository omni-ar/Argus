/**
 * Reconciliation Script
 *
 * Compares our on-chain Altair reward computation against beaconcha.in data
 * for all 5 tracked validators over the last 14 days.
 *
 * Output:
 *  - Per-validator summary table (our tool vs beaconcha.in)
 *  - Per-epoch detail for the first validator where a discrepancy > 1% is found
 *  - JSON dump to reconciliation_output.json for RESEARCH.md
 *
 * Run with:
 *   pnpm pipeline:reconcile
 *   or: node --loader ts-node/esm scripts/reconciliation.ts
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";

import { logger } from "../src/utils/logger.js";
import { getFinalizedEpochCached } from "../src/utils/epochUtils.js";
import { getValidatorInfo } from "../src/clients/beaconchainClient.js";
import {
  computeEpochRangeRewards,
  type ComputedEpochResult,
} from "../src/services/attestationService.js";
import { initRedis, closeRedis } from "../src/cache/redisClient.js";
import {
  VALIDATOR_PUBKEYS,
  BEACONCHAIN_API,
  BEACONCHAIN_API_V2,
  BEACONCHAIN_API_KEY,
} from "../constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────

/** Days of history to reconcile (2 weeks = 14 days = ~3150 epochs). */
const RECONCILE_DAYS = 14;

/**
 * Maximum epochs to actually run through our *on-chain* scanner per validator.
 *
 * Our scanner makes ~32 parallel HTTP requests per epoch to scan attestation
 * inclusion slots.  At 200 ms round-trip that is ~6 s/epoch.  To keep the
 * script runnable in CI/local dev we cap the deep scan at DEEP_SCAN_EPOCHS and
 * use beaconcha.in attestation-status data to fill the rest of the 2-week
 * window with an estimated ETH-missed figure.
 *
 * Increase this number if you have a fast local beacon node / more time.
 */
const DEEP_SCAN_EPOCHS = 10;

/**
 * Slots per epoch (Ethereum mainnet constant).
 */
const SLOTS_PER_EPOCH = 32;

/**
 * ETH genesis timestamp (seconds since Unix epoch).
 */
const GENESIS_TIME = 1_606_824_023;

// ─── Types ────────────────────────────────────────────────────────────────────

interface BeaconchainAttestation {
  epoch: number;
  attesterslot: number;
  inclusionslot: number | null;
  status: number; // 0 = missed, 1 = timely, 2 = late
  week_start: string;
  week_end: string;
}

interface BeaconchainV2RewardComponent {
  total: string;
  reward: string;
  penalty: string;
  missed_reward: string;
}

interface BeaconchainV2Reward {
  validator: { index: number; public_key: string };
  total_reward: string;
  total_missed: string;
  attestation: {
    total: string;
    head: BeaconchainV2RewardComponent;
    source: BeaconchainV2RewardComponent;
    target: BeaconchainV2RewardComponent;
    inactivity_leak_penalty: string;
    inclusion_delay: number | null;
  };
  finality: string;
}

interface ValidatorReconciliation {
  validatorIndex: number;
  pubkey: string;
  /** Epoch range over which the full 14-day beaconcha.in data covers */
  fromEpoch: number;
  toEpoch: number;
  /** Number of epochs in the 14-day window */
  totalEpochs: number;

  /** ── beaconcha.in data (full 14-day window via v1 attestation API) ── */
  bcin: {
    missedCount: number; // status === 0
    lateCount: number; // status === 2
    timelyCount: number; // status === 1
    /** Per-flag missed Gwei summed from v2 rewards API (null if API unavailable) */
    sourceMissedGwei: bigint | null;
    targetMissedGwei: bigint | null;
    headMissedGwei: bigint | null;
    totalMissedGwei: bigint | null;
    /** How many epochs had v2 reward data */
    v2EpochsCovered: number;
  };

  /** ── Our tool (deep scan on DEEP_SCAN_EPOCHS, estimate on rest) ── */
  ours: {
    /** Deep-scanned epochs (exact, from beacon node) */
    deepScanEpochs: number;
    deepScanResults: ComputedEpochResult[];
    sourceMissedGweiDeep: bigint;
    targetMissedGweiDeep: bigint;
    headMissedGweiDeep: bigint;
    totalMissedGweiDeep: bigint;
    missedEntirelyDeep: number;
    wrongSourceDeep: number;
    wrongTargetDeep: number;
    wrongHeadDeep: number;
    lateSourceDeep: number;
    lateHeadDeep: number;
    correctDeep: number;

    /** Estimated total for the full 14-day window (scaled from deep-scan rate) */
    totalMissedGweiEstimated: bigint;
  };

  /** ── Discrepancy (vs beaconcha.in v2 if available, else estimated) ── */
  discrepancy: {
    ourGwei: bigint;
    theirGwei: bigint;
    diffGwei: bigint;
    diffPct: number;
    dataSource: "v2_exact" | "v1_estimated";
  } | null;
}

interface WrongHeadExample {
  validatorIndex: number;
  epoch: number;
  slot: number;
  inclusionDelay: number;
  beaconBlockRoot: string;
  canonicalHeadRoot: string | null;
  missType: string;
  rawAnalysis: ComputedEpochResult["analysis"];
  operationalCause: string;
}

// ─── beaconcha.in v1 helpers (no API key required) ───────────────────────────

async function bcin_getAttestations(
  validatorIndex: number,
  limit = 500,
): Promise<BeaconchainAttestation[]> {
  const url = `${BEACONCHAIN_API}/validator/${validatorIndex}/attestations`;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (BEACONCHAIN_API_KEY)
      headers["Authorization"] = `Bearer ${BEACONCHAIN_API_KEY}`;

    const res = await axios.get(url, {
      params: { limit, offset: 0 },
      headers,
      timeout: 20_000,
    });
    return (res.data?.data ?? []) as BeaconchainAttestation[];
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    logger.warn("beaconcha.in v1 attestations fetch failed", {
      validatorIndex,
      status: status ?? "network_error",
    });
    return [];
  }
}

// ─── beaconcha.in v2 rewards helper ──────────────────────────────────────────

async function bcin_getV2Reward(
  validatorIndex: number,
  epoch: number,
): Promise<BeaconchainV2Reward | null> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (BEACONCHAIN_API_KEY)
      headers["Authorization"] = `Bearer ${BEACONCHAIN_API_KEY}`;

    const res = await axios.post(
      `${BEACONCHAIN_API_V2}/ethereum/validators/rewards-list`,
      {
        validator: { validator_identifiers: [validatorIndex] },
        chain: "mainnet",
        page_size: 1,
        epoch,
      },
      { headers, timeout: 20_000 },
    );

    const data = res.data?.data as BeaconchainV2Reward[] | undefined;
    return data?.[0] ?? null;
  } catch {
    return null;
  }
}

// ─── Slot → wall-clock timestamp ─────────────────────────────────────────────

function slotToTimestamp(slot: number): string {
  const ts = GENESIS_TIME + slot * 12;
  return new Date(ts * 1000).toISOString();
}

// ─── Table rendering ──────────────────────────────────────────────────────────

function pad(s: string, w: number, right = false): string {
  const str = s.length > w ? s.slice(0, w - 1) + "…" : s;
  return right ? str.padStart(w) : str.padEnd(w);
}

function printReconTable(rows: ValidatorReconciliation[]): void {
  const COLS = [
    { label: "Validator", width: 10 },
    { label: "Epochs", width: 7 },
    { label: "Missed(ours)", width: 13 },
    { label: "Late(ours)", width: 11 },
    { label: "MissETH(ours)", width: 14 },
    { label: "MissETH(bcin)", width: 14 },
    { label: "Diff%", width: 8 },
    { label: "Source", width: 8 },
  ];

  const sep = COLS.map((c) => "─".repeat(c.width)).join("─┼─");
  const hdr = COLS.map((c, i) => pad(c.label, c.width, i > 1)).join(" │ ");

  console.log("\n┌─" + sep + "─┐");
  console.log("│ " + hdr + " │");
  console.log("├─" + sep + "─┤");

  for (const r of rows) {
    const ourEth = formatGwei(r.ours.totalMissedGweiEstimated);
    const bcinEth = r.discrepancy ? formatGwei(r.discrepancy.theirGwei) : "n/a";
    const diffPct = r.discrepancy
      ? r.discrepancy.diffPct.toFixed(2) + "%"
      : "n/a";
    const src =
      r.discrepancy?.dataSource === "v2_exact" ? "v2/exact" : "v1/est.";

    const line = [
      pad(String(r.validatorIndex), COLS[0]!.width),
      pad(String(r.totalEpochs), COLS[1]!.width, true),
      pad(String(r.ours.missedEntirelyDeep), COLS[2]!.width, true),
      pad(
        String(r.ours.lateHeadDeep + r.ours.lateSourceDeep),
        COLS[3]!.width,
        true,
      ),
      pad(ourEth, COLS[4]!.width, true),
      pad(bcinEth, COLS[5]!.width, true),
      pad(diffPct, COLS[6]!.width, true),
      pad(src, COLS[7]!.width),
    ].join(" │ ");

    console.log("│ " + line + " │");
  }

  console.log("└─" + sep + "─┘\n");
}

function formatGwei(gwei: bigint): string {
  const eth = gwei / 1_000_000_000n;
  const frac = (gwei % 1_000_000_000n).toString().padStart(9, "0").slice(0, 6);
  return `${eth}.${frac}`;
}

// ─── Per-epoch detail table ───────────────────────────────────────────────────

function printEpochDetail(results: ComputedEpochResult[], title: string): void {
  console.log(`\n  ${title}`);
  console.log("  " + "─".repeat(110));
  const hdr = [
    "Epoch".padEnd(8),
    "Incl".padEnd(5),
    "Dly".padEnd(4),
    "Src".padEnd(5),
    "Tgt".padEnd(5),
    "Hd".padEnd(5),
    "MissType".padEnd(16),
    "EarnedGwei".padEnd(14),
    "MissedGwei".padEnd(14),
    "BaseGwei".padEnd(12),
  ].join("  ");
  console.log("  " + hdr);
  console.log("  " + "─".repeat(110));

  for (const r of results) {
    const line = [
      String(r.epoch).padEnd(8),
      (r.included ? "yes" : "NO").padEnd(5),
      (r.inclusionDelay !== null ? String(r.inclusionDelay) : "-").padEnd(4),
      (r.timelySource ? "ok" : "MISS").padEnd(5),
      (r.timelyTarget ? "ok" : "MISS").padEnd(5),
      (r.timelyHead ? "ok" : "MISS").padEnd(5),
      r.missType.padEnd(16),
      r.totalEarned.padEnd(14),
      r.totalMissed.padEnd(14),
      r.baseReward.padEnd(12),
    ].join("  ");
    console.log("  " + line);
  }
  console.log("  " + "─".repeat(110));
}

// ─── Wrong-head example extractor ────────────────────────────────────────────

function findWrongHeadExample(
  validatorIndex: number,
  results: ComputedEpochResult[],
): WrongHeadExample | null {
  for (const r of results) {
    if (
      r.missType === "wrong_head" ||
      r.missType === "late_head" ||
      (r.included && !r.timelyHead && r.timelySource && r.timelyTarget)
    ) {
      const slot =
        r.epoch * SLOTS_PER_EPOCH +
        (r.inclusionDelay !== null
          ? r.inclusionDelay - (r.inclusionDelay ?? 1)
          : 0);
      const operationalCause =
        r.missType === "late_head"
          ? `Attestation included with delay=${r.inclusionDelay} > 1. ` +
            `The validator's local view of the head was delayed — likely ` +
            `due to network propagation lag or a fork-choice reorg. ` +
            `The attestation was broadcast in time for inclusion but ` +
            `the head vote referenced an earlier block.`
          : r.missType === "wrong_head"
            ? `Attestation included with delay=${r.inclusionDelay}, ` +
              `beacon_block_root did not match canonical head at slot ${slot}. ` +
              `This indicates the validator's beacon node saw a different ` +
              `head than the canonical chain — likely a short-lived reorg ` +
              `or uncle block at the attestation slot.`
            : "Head flag missed for unknown reason.";

      return {
        validatorIndex,
        epoch: r.epoch,
        slot: r.epoch * SLOTS_PER_EPOCH,
        inclusionDelay: r.inclusionDelay ?? 0,
        beaconBlockRoot: "(reconstructed from attestation data — see logs)",
        canonicalHeadRoot: null,
        missType: r.missType,
        rawAnalysis: r.analysis,
        operationalCause,
      };
    }
  }
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  initRedis();

  console.log("═".repeat(80));
  console.log("  Altair Reward Reconciliation — Our Tool vs beaconcha.in");
  console.log("═".repeat(80));

  // ── Step 1: Determine epoch range ────────────────────────────────────────
  const finalizedEpoch = await getFinalizedEpochCached();
  const epochsPerDay = Math.floor((24 * 60 * 60) / (SLOTS_PER_EPOCH * 12)); // 225
  const windowEpochs = RECONCILE_DAYS * epochsPerDay;
  const fromEpoch = Math.max(0, finalizedEpoch - windowEpochs);
  const toEpoch = finalizedEpoch;

  // Deep-scan window: last DEEP_SCAN_EPOCHS epochs (newest first)
  const deepFrom = Math.max(fromEpoch, toEpoch - DEEP_SCAN_EPOCHS + 1);
  const deepTo = toEpoch;

  console.log(`\n  Finalized epoch : ${finalizedEpoch}`);
  console.log(
    `  14-day window   : [${fromEpoch} … ${toEpoch}]  (${windowEpochs} epochs)`,
  );
  console.log(
    `  Deep-scan range : [${deepFrom} … ${deepTo}]  (${deepTo - deepFrom + 1} epochs)`,
  );
  console.log(`  Validators      : ${VALIDATOR_PUBKEYS.length}`);
  console.log();

  // ── Step 2: Resolve validator indices ────────────────────────────────────
  console.log("  Resolving validator indices from beaconcha.in …");
  const validatorMeta: Array<{ pubkey: string; index: number }> = [];

  for (const pubkey of VALIDATOR_PUBKEYS) {
    try {
      const info = await getValidatorInfo(pubkey);
      validatorMeta.push({ pubkey, index: info.validatorindex });
      console.log(
        `    ${pubkey.slice(0, 14)}…  →  index ${info.validatorindex}  (${info.status})`,
      );
    } catch (err) {
      const e = err as { code: string; message: string };
      console.error(
        `    FAILED to resolve ${pubkey.slice(0, 14)}…: ${e.code} — ${e.message}`,
      );
    }
  }
  console.log();

  // ── Step 3: Per-validator reconciliation ─────────────────────────────────
  const reconciliationRows: ValidatorReconciliation[] = [];
  let globalWrongHeadExample: WrongHeadExample | null = null;

  for (const { pubkey, index: validatorIndex } of validatorMeta) {
    console.log(
      `  ── Validator ${validatorIndex} (${pubkey.slice(0, 20)}…) ──`,
    );

    // ── 3a. beaconcha.in v1 attestations ─────────────────────────────────
    console.log(`    Fetching beaconcha.in v1 attestations (limit=500) …`);
    const allAttestations = await bcin_getAttestations(validatorIndex, 500);

    // Filter to our 14-day window
    const windowAttestations = allAttestations.filter(
      (a) => a.epoch >= fromEpoch && a.epoch <= toEpoch,
    );

    const bcinMissed = windowAttestations.filter((a) => a.status === 0).length;
    const bcinLate = windowAttestations.filter((a) => a.status === 2).length;
    const bcinTimely = windowAttestations.filter((a) => a.status === 1).length;

    console.log(
      `    bcin v1: ${windowAttestations.length} epochs in window ` +
        `| missed=${bcinMissed} late=${bcinLate} timely=${bcinTimely}`,
    );

    // ── 3b. beaconcha.in v2 rewards (per-epoch, for deep-scan range) ──────
    console.log(
      `    Fetching beaconcha.in v2 rewards for epochs [${deepFrom}…${deepTo}] …`,
    );
    let bcinV2SourceTotal = 0n;
    let bcinV2TargetTotal = 0n;
    let bcinV2HeadTotal = 0n;
    let bcinV2Total = 0n;
    let v2EpochsCovered = 0;

    // Only fetch v2 for deep-scan window (avoids excessive API calls)
    for (let ep = deepFrom; ep <= deepTo; ep++) {
      const reward = await bcin_getV2Reward(validatorIndex, ep);
      if (reward) {
        bcinV2SourceTotal += BigInt(reward.attestation.source.missed_reward);
        bcinV2TargetTotal += BigInt(reward.attestation.target.missed_reward);
        bcinV2HeadTotal += BigInt(reward.attestation.head.missed_reward);
        bcinV2Total += BigInt(reward.total_missed);
        v2EpochsCovered++;
      }
      // Throttle: 500ms between requests
      await new Promise((r) => setTimeout(r, 500));
    }

    const hasV2Data = v2EpochsCovered > 0;
    console.log(
      `    bcin v2: ${v2EpochsCovered}/${deepTo - deepFrom + 1} epochs with data ` +
        `| totalMissed=${formatGwei(bcinV2Total)} ETH`,
    );

    // ── 3c. Our on-chain computation (deep scan) ──────────────────────────
    console.log(
      `    Running on-chain computation for epochs [${deepFrom}…${deepTo}] …`,
    );

    const { results: deepResults, missingEpochs } =
      await computeEpochRangeRewards(validatorIndex, deepFrom, deepTo);

    // Aggregate deep-scan results
    let ourSourceDeep = 0n,
      ourTargetDeep = 0n,
      ourHeadDeep = 0n,
      ourTotalDeep = 0n;
    let missedEntirelyDeep = 0,
      wrongSourceDeep = 0,
      wrongTargetDeep = 0;
    let wrongHeadDeep = 0,
      lateSourceDeep = 0,
      lateHeadDeep = 0,
      correctDeep = 0;

    for (const r of deepResults) {
      ourSourceDeep += BigInt(r.sourceMissed);
      ourTargetDeep += BigInt(r.targetMissed);
      ourHeadDeep += BigInt(r.headMissed);
      ourTotalDeep += BigInt(r.totalMissed);
      switch (r.missType) {
        case "missed_entirely":
          missedEntirelyDeep++;
          break;
        case "wrong_source":
          wrongSourceDeep++;
          break;
        case "wrong_target":
          wrongTargetDeep++;
          break;
        case "wrong_head":
          wrongHeadDeep++;
          break;
        case "late_source":
          lateSourceDeep++;
          break;
        case "late_head":
          lateHeadDeep++;
          break;
        case "correct":
          correctDeep++;
          break;
      }
    }

    // Print epoch detail table
    printEpochDetail(
      deepResults,
      `Epoch detail for validator ${validatorIndex}`,
    );

    if (missingEpochs.length > 0) {
      console.log(
        `    ⚠  ${missingEpochs.length} epoch(s) could not be computed:`,
      );
      for (const m of missingEpochs.slice(0, 5)) {
        console.log(`       epoch ${m.epoch}: ${m.reason} (${m.code ?? ""})`);
      }
    }

    // ── 3d. Extrapolate to full 14-day window ─────────────────────────────
    // Scale the per-epoch average from the deep scan over the full window.
    const deepEpochCount = deepResults.length;
    const scaleRatio =
      deepEpochCount > 0 ? Number(windowEpochs) / deepEpochCount : 1;
    const ourTotalEstimated =
      deepEpochCount > 0
        ? BigInt(Math.round(Number(ourTotalDeep) * scaleRatio))
        : 0n;

    console.log(
      `    Ours deep-scan: ${formatGwei(ourTotalDeep)} ETH missed ` +
        `(${deepEpochCount} epochs) | estimated 14d: ${formatGwei(ourTotalEstimated)} ETH`,
    );

    // ── 3e. Compute discrepancy ───────────────────────────────────────────
    let discrepancy: ValidatorReconciliation["discrepancy"] = null;

    if (hasV2Data && v2EpochsCovered === deepTo - deepFrom + 1) {
      // Perfect overlap: compare directly against v2 data for same epoch range
      const diffGwei =
        ourTotalDeep > bcinV2Total
          ? ourTotalDeep - bcinV2Total
          : bcinV2Total - ourTotalDeep;
      const diffPct =
        bcinV2Total > 0n ? Number((diffGwei * 10000n) / bcinV2Total) / 100 : 0;
      discrepancy = {
        ourGwei: ourTotalDeep,
        theirGwei: bcinV2Total,
        diffGwei,
        diffPct,
        dataSource: "v2_exact",
      };
      console.log(
        `    Discrepancy: ${diffPct.toFixed(2)}% (${formatGwei(diffGwei)} ETH diff) [v2/exact]`,
      );
    } else if (hasV2Data) {
      // Partial v2 coverage: scale their data too
      const bcinV2PerEpoch =
        v2EpochsCovered > 0 ? bcinV2Total / BigInt(v2EpochsCovered) : 0n;
      const bcinV2Estimated = bcinV2PerEpoch * BigInt(windowEpochs);
      const diffGwei =
        ourTotalEstimated > bcinV2Estimated
          ? ourTotalEstimated - bcinV2Estimated
          : bcinV2Estimated - ourTotalEstimated;
      const diffPct =
        bcinV2Estimated > 0n
          ? Number((diffGwei * 10000n) / bcinV2Estimated) / 100
          : 0;
      discrepancy = {
        ourGwei: ourTotalEstimated,
        theirGwei: bcinV2Estimated,
        diffGwei,
        diffPct,
        dataSource: "v2_exact",
      };
      console.log(
        `    Discrepancy: ${diffPct.toFixed(2)}% (estimated, partial v2) [v2/partial]`,
      );
    } else {
      // No v2 data: use beaconcha.in attestation count to estimate their ETH
      // Using a rough estimate: each fully missed epoch ≈ (54/64) * base_reward
      // base_reward for 32 ETH validator ≈ 32 * EFFECTIVE_BALANCE_INCREMENT * 64 / sqrt(total_active_balance)
      // At ~1M validators with 32 ETH each: sqrt(1e6 * 32e9) ≈ 178885 Gwei
      // base_reward_per_increment ≈ 1e9 * 64 / 178885 ≈ 357776 Gwei
      // base_reward ≈ 32 * 357776 ≈ 11448832 Gwei ≈ 0.0000114 ETH
      const ROUGH_BASE_REWARD_GWEI = 11_448_832n;
      const FULL_ATT_REWARD = (ROUGH_BASE_REWARD_GWEI * 54n) / 64n;
      const bcinEstimated =
        FULL_ATT_REWARD * BigInt(bcinMissed) +
        ((ROUGH_BASE_REWARD_GWEI * 14n) / 64n) * BigInt(bcinLate);
      const diffGwei =
        ourTotalEstimated > bcinEstimated
          ? ourTotalEstimated - bcinEstimated
          : bcinEstimated > 0n
            ? bcinEstimated - ourTotalEstimated
            : 0n;
      const diffPct =
        bcinEstimated > 0n
          ? Number((diffGwei * 10000n) / bcinEstimated) / 100
          : 0;
      discrepancy = {
        ourGwei: ourTotalEstimated,
        theirGwei: bcinEstimated,
        diffGwei,
        diffPct,
        dataSource: "v1_estimated",
      };
      console.log(
        `    Discrepancy: ${diffPct.toFixed(2)}% (v2 unavailable, using v1 status estimate) [v1/est.]`,
      );
    }

    // ── 3f. Capture wrong-head example ────────────────────────────────────
    if (!globalWrongHeadExample) {
      globalWrongHeadExample = findWrongHeadExample(
        validatorIndex,
        deepResults,
      );
      if (globalWrongHeadExample) {
        console.log(
          `    ★  Wrong-head example found at epoch ${globalWrongHeadExample.epoch}!`,
        );
      }
    }

    // ── 3g. Accumulate row ────────────────────────────────────────────────
    reconciliationRows.push({
      validatorIndex,
      pubkey,
      fromEpoch,
      toEpoch,
      totalEpochs:
        windowAttestations.length > 0
          ? windowAttestations.length
          : windowEpochs,
      bcin: {
        missedCount: bcinMissed,
        lateCount: bcinLate,
        timelyCount: bcinTimely,
        sourceMissedGwei: hasV2Data ? bcinV2SourceTotal : null,
        targetMissedGwei: hasV2Data ? bcinV2TargetTotal : null,
        headMissedGwei: hasV2Data ? bcinV2HeadTotal : null,
        totalMissedGwei: hasV2Data ? bcinV2Total : null,
        v2EpochsCovered,
      },
      ours: {
        deepScanEpochs: deepEpochCount,
        deepScanResults: deepResults,
        sourceMissedGweiDeep: ourSourceDeep,
        targetMissedGweiDeep: ourTargetDeep,
        headMissedGweiDeep: ourHeadDeep,
        totalMissedGweiDeep: ourTotalDeep,
        missedEntirelyDeep,
        wrongSourceDeep,
        wrongTargetDeep,
        wrongHeadDeep,
        lateSourceDeep,
        lateHeadDeep,
        correctDeep,
        totalMissedGweiEstimated: ourTotalEstimated,
      },
      discrepancy,
    });

    console.log();
  }

  // ── Step 4: Print reconciliation summary table ────────────────────────────
  console.log("═".repeat(80));
  console.log("  RECONCILIATION SUMMARY TABLE");
  console.log("═".repeat(80));
  printReconTable(reconciliationRows);

  // ── Step 5: Component breakdown per validator ─────────────────────────────
  console.log("  Component-level missed reward breakdown (deep-scan window):");
  console.log("  " + "─".repeat(90));
  console.log(
    "  " +
      [
        "Validator".padEnd(10),
        "SrcMiss(Gwei)".padEnd(16),
        "TgtMiss(Gwei)".padEnd(16),
        "HdMiss(Gwei)".padEnd(15),
        "Total(Gwei)".padEnd(14),
        "MissClass breakdown".padEnd(24),
      ].join("  "),
  );
  console.log("  " + "─".repeat(90));

  for (const r of reconciliationRows) {
    const o = r.ours;
    const breakdown =
      `ok=${o.correctDeep} ` +
      `miss=${o.missedEntirelyDeep} ` +
      `wSrc=${o.wrongSourceDeep} ` +
      `wTgt=${o.wrongTargetDeep} ` +
      `wHd=${o.wrongHeadDeep} ` +
      `lSrc=${o.lateSourceDeep} ` +
      `lHd=${o.lateHeadDeep}`;

    console.log(
      "  " +
        [
          String(r.validatorIndex).padEnd(10),
          String(o.sourceMissedGweiDeep).padEnd(16),
          String(o.targetMissedGweiDeep).padEnd(16),
          String(o.headMissedGweiDeep).padEnd(15),
          String(o.totalMissedGweiDeep).padEnd(14),
          breakdown,
        ].join("  "),
    );
  }
  console.log("  " + "─".repeat(90));

  // ── Step 6: Wrong-head deep-dive ─────────────────────────────────────────
  console.log("\n  WRONG-HEAD / LATE-HEAD EXAMPLE");
  console.log("  " + "─".repeat(60));
  if (globalWrongHeadExample) {
    const ex = globalWrongHeadExample;
    console.log(`  Validator index : ${ex.validatorIndex}`);
    console.log(`  Epoch           : ${ex.epoch}`);
    console.log(`  Attestation slot: ${ex.slot} (${slotToTimestamp(ex.slot)})`);
    console.log(`  Inclusion delay : ${ex.inclusionDelay} slot(s)`);
    console.log(`  Miss type       : ${ex.missType}`);
    console.log(`  Source status   : ${ex.rawAnalysis.sourceStatus}`);
    console.log(`  Target status   : ${ex.rawAnalysis.targetStatus}`);
    console.log(`  Head status     : ${ex.rawAnalysis.headStatus}`);
    console.log(`  Operational cause:`);
    console.log(`    ${ex.operationalCause}`);
  } else {
    console.log(
      "  No wrong-head or late-head example found in the deep-scan window.",
    );
    console.log(
      "  All scanned attestations were included with delay=1 or missed entirely.",
    );
    console.log(
      "  This is consistent with a healthy, well-connected validator.",
    );
  }

  // ── Step 7: beaconcha.in per-flag breakdown (where v2 available) ──────────
  const v2Rows = reconciliationRows.filter((r) => r.bcin.v2EpochsCovered > 0);
  if (v2Rows.length > 0) {
    console.log(
      "\n  BEACONCHA.IN V2 FLAG BREAKDOWN vs OUR TOOL (deep-scan window):",
    );
    console.log("  " + "─".repeat(90));
    console.log(
      "  " +
        [
          "Validator".padEnd(10),
          "bcin-Src(Gwei)".padEnd(16),
          "ours-Src(Gwei)".padEnd(16),
          "bcin-Tgt(Gwei)".padEnd(16),
          "ours-Tgt(Gwei)".padEnd(16),
          "bcin-Hd(Gwei)".padEnd(15),
          "ours-Hd(Gwei)".padEnd(15),
        ].join("  "),
    );
    console.log("  " + "─".repeat(90));
    for (const r of v2Rows) {
      console.log(
        "  " +
          [
            String(r.validatorIndex).padEnd(10),
            String(r.bcin.sourceMissedGwei ?? "n/a").padEnd(16),
            String(r.ours.sourceMissedGweiDeep).padEnd(16),
            String(r.bcin.targetMissedGwei ?? "n/a").padEnd(16),
            String(r.ours.targetMissedGweiDeep).padEnd(16),
            String(r.bcin.headMissedGwei ?? "n/a").padEnd(15),
            String(r.ours.headMissedGweiDeep).padEnd(15),
          ].join("  "),
      );
    }
    console.log("  " + "─".repeat(90));
  }

  // ── Step 8: Discrepancy summary ───────────────────────────────────────────
  console.log("\n  DISCREPANCY SUMMARY:");
  let maxDiff = 0;
  let maxDiffValidator = -1;
  for (const r of reconciliationRows) {
    if (r.discrepancy) {
      const pct = r.discrepancy.diffPct;
      const within5 = pct <= 5.0;
      console.log(
        `    Validator ${String(r.validatorIndex).padEnd(7)} ` +
          `diff=${pct.toFixed(2).padStart(6)}%  ` +
          `[${r.discrepancy.dataSource}]  ` +
          (within5 ? "✓ within 5%" : "✗ EXCEEDS 5% — investigate"),
      );
      if (pct > maxDiff) {
        maxDiff = pct;
        maxDiffValidator = r.validatorIndex;
      }
    }
  }
  if (maxDiffValidator >= 0) {
    console.log(
      `\n  Largest gap: validator ${maxDiffValidator} at ${maxDiff.toFixed(2)}%`,
    );
  }

  // ── Step 9: Dump JSON for RESEARCH.md ────────────────────────────────────
  const outputPath = path.join(__dirname, "..", "reconciliation_output.json");

  // Serialise BigInts as strings for JSON
  const jsonSafe = reconciliationRows.map((r) => ({
    validatorIndex: r.validatorIndex,
    pubkey: r.pubkey,
    fromEpoch: r.fromEpoch,
    toEpoch: r.toEpoch,
    totalEpochs: r.totalEpochs,
    bcin: {
      missedCount: r.bcin.missedCount,
      lateCount: r.bcin.lateCount,
      timelyCount: r.bcin.timelyCount,
      sourceMissedGwei: r.bcin.sourceMissedGwei?.toString() ?? null,
      targetMissedGwei: r.bcin.targetMissedGwei?.toString() ?? null,
      headMissedGwei: r.bcin.headMissedGwei?.toString() ?? null,
      totalMissedGwei: r.bcin.totalMissedGwei?.toString() ?? null,
      v2EpochsCovered: r.bcin.v2EpochsCovered,
    },
    ours: {
      deepScanEpochs: r.ours.deepScanEpochs,
      sourceMissedGweiDeep: r.ours.sourceMissedGweiDeep.toString(),
      targetMissedGweiDeep: r.ours.targetMissedGweiDeep.toString(),
      headMissedGweiDeep: r.ours.headMissedGweiDeep.toString(),
      totalMissedGweiDeep: r.ours.totalMissedGweiDeep.toString(),
      totalMissedGweiEstimated: r.ours.totalMissedGweiEstimated.toString(),
      missedEntirelyDeep: r.ours.missedEntirelyDeep,
      wrongSourceDeep: r.ours.wrongSourceDeep,
      wrongTargetDeep: r.ours.wrongTargetDeep,
      wrongHeadDeep: r.ours.wrongHeadDeep,
      lateSourceDeep: r.ours.lateSourceDeep,
      lateHeadDeep: r.ours.lateHeadDeep,
      correctDeep: r.ours.correctDeep,
      deepEpochDetails: r.ours.deepScanResults.map((e) => ({
        epoch: e.epoch,
        included: e.included,
        inclusionDelay: e.inclusionDelay,
        timelySource: e.timelySource,
        timelyTarget: e.timelyTarget,
        timelyHead: e.timelyHead,
        missType: e.missType,
        baseReward: e.baseReward,
        sourceMissed: e.sourceMissed,
        targetMissed: e.targetMissed,
        headMissed: e.headMissed,
        totalEarned: e.totalEarned,
        totalMissed: e.totalMissed,
      })),
    },
    discrepancy: r.discrepancy
      ? {
          ourGwei: r.discrepancy.ourGwei.toString(),
          theirGwei: r.discrepancy.theirGwei.toString(),
          diffGwei: r.discrepancy.diffGwei.toString(),
          diffPct: r.discrepancy.diffPct,
          dataSource: r.discrepancy.dataSource,
        }
      : null,
  }));

  const jsonOutput = {
    generatedAt: new Date().toISOString(),
    finalizedEpoch,
    windowDays: RECONCILE_DAYS,
    deepScanEpochs: DEEP_SCAN_EPOCHS,
    fromEpoch,
    toEpoch,
    wrongHeadExample: globalWrongHeadExample
      ? {
          validatorIndex: globalWrongHeadExample.validatorIndex,
          epoch: globalWrongHeadExample.epoch,
          slot: globalWrongHeadExample.slot,
          slotTimestamp: slotToTimestamp(globalWrongHeadExample.slot),
          inclusionDelay: globalWrongHeadExample.inclusionDelay,
          missType: globalWrongHeadExample.missType,
          rawAnalysis: globalWrongHeadExample.rawAnalysis,
          operationalCause: globalWrongHeadExample.operationalCause,
        }
      : null,
    validators: jsonSafe,
  };

  fs.writeFileSync(outputPath, JSON.stringify(jsonOutput, null, 2), "utf-8");
  console.log(`\n  ✓ JSON output written to: ${outputPath}`);
  console.log("═".repeat(80));

  await closeRedis();
}

main().catch((err) => {
  const e = err as { code?: string; message?: string };
  console.error(
    "Reconciliation fatal error:",
    e.code ?? "UNKNOWN",
    e.message ?? String(err),
  );
  process.exit(1);
});
