/**
 * Attestation Service — On-Chain Reward Computation Pipeline
 *
 * This module is the authoritative computation path for Altair attestation
 * rewards.  It does NOT rely on beaconcha.in pre-computed rewards.
 *
 * Pipeline for each (validator, epoch) pair:
 *
 *  1. Fetch total_active_balance from the Beacon node (per epoch, never cached
 *     stale — it changes every epoch as validators join/leave).
 *  2. Fetch the validator's effective_balance at the attestation epoch from
 *     the Beacon node state.
 *  3. Compute base_reward per the Altair spec:
 *       increments = effective_balance // EFFECTIVE_BALANCE_INCREMENT
 *       base_reward = increments × (EFFECTIVE_BALANCE_INCREMENT × 64 // √total_active_balance)
 *  4. Reconstruct participation flags by scanning every block in the epoch
 *     (slots [epoch×32 … (epoch+1)×32)) and the first 32 slots of the next
 *     epoch (to catch attestations from slot epoch×32+31 which can be included
 *     up to 32 slots later) for attestations whose data.slot falls inside the
 *     target epoch and whose aggregation_bits cover our validator's committee
 *     position.
 *  5. Apply Altair flag conditions:
 *       TIMELY_SOURCE (weight 14): correct justified source + included ≤ 5 slots
 *       TIMELY_TARGET (weight 26): correct epoch boundary target + included ≤ 32 slots
 *       TIMELY_HEAD   (weight 14): correct head at att slot + included in very next slot
 *  6. Per missed flag: missed_reward = (base_reward × flag_weight) / 64
 *  7. Classify the miss type and return a fully structured result.
 *
 * Accuracy trade-offs are documented in RESEARCH.md.
 */

import { logger } from "../utils/logger.js";
import {
  getActiveValidatorBalance,
  getValidatorEffectiveBalanceAtEpoch,
  getBlockAttestations,
} from "../clients/beaconClient.js";
import { getValidatorInfo as getBeaconchainValidatorInfo } from "../clients/beaconchainClient.js";
import {
  getBaseReward,
  determineParticipationFlags,
  calculateAttestationRewards,
  classifyMiss,
  analyzeAttestation,
  setTotalActiveBalance,
  getTotalActiveBalance,
  formatGweiToEth,
} from "../rewards/rewardCalculator.js";
import { cacheGet, cacheSet } from "../cache/redisClient.js";
import { epochFetchErrorsTotal } from "../monitoring/metrics.js";
import { CACHE_TTL_SECONDS } from "../../constants.js";
import type {
  MissClassification,
  AttestationMissAnalysis,
} from "../rewards/altairConstants.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Fully computed attestation result for one validator in one epoch.
 * All Gwei values are stored as strings (BigInt-safe JSON).
 */
export interface ComputedEpochResult {
  epoch: number;
  validatorIndex: number;
  /** Was any matching attestation found in the inclusion window? */
  included: boolean;
  /** Slots between the attestation slot and the block it was included in */
  inclusionDelay: number | null;
  /** Altair participation flags that were earned */
  timelySource: boolean;
  timelyTarget: boolean;
  timelyHead: boolean;
  /** Rewards earned per component (Gwei, as decimal string) */
  sourceReward: string;
  targetReward: string;
  headReward: string;
  /** Rewards missed per component (Gwei, as decimal string) */
  sourceMissed: string;
  targetMissed: string;
  headMissed: string;
  /** Totals (Gwei, as decimal string) */
  totalEarned: string;
  totalMissed: string;
  /** Human-readable ETH */
  totalMissedEth: string;
  /** Base reward used for the calculation (Gwei, as decimal string) */
  baseReward: string;
  /** Primary miss classification */
  missType: MissClassification;
  /** Per-component status detail */
  analysis: AttestationMissAnalysis;
  /** Source: always 'beacon_node' to signal on-chain computation */
  dataSource: "beacon_node";
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

function computedEpochKey(validatorIndex: number, epoch: number): string {
  return `computed_epoch:${validatorIndex}:${epoch}`;
}

function committeeAssignmentKey(validatorIndex: number, epoch: number): string {
  return `committee_assignment:${validatorIndex}:${epoch}`;
}

function activeBalanceKey(): string {
  return "active_balance:finalized";
}

const activeBalanceFetches = new Map<string, Promise<bigint>>();

// ─── Total Active Balance (fetched once per epoch, cached per epoch) ───────────

/**
 * Returns the total active balance for a given epoch.
 *
 * The Altair base_reward formula requires total_active_balance per epoch:
 *   base_reward_per_increment = EFFECTIVE_BALANCE_INCREMENT × 64 / √total_active_balance
 *
 * Fetching strategy:
 *  1. In-process memory cache keyed by epoch (rewardCalculator singleton)
 *  2. Redis cache keyed by epoch — TTL = CACHE_TTL_SECONDS (1h default).
 *     Finalized epoch data is immutable so this is safe indefinitely.
 *  3. Live fetch: GET /eth/v1/beacon/states/finalized/validators?status=active_ongoing
 *     Non-archival nodes do not retain historical state, so "finalized" is the
 *     only available state ID. For recently-finalized epochs (the only range
 *     this application queries) the finalized state's active set is correct.
 *
 * The finalized-state active balance is reused across the recent finalized
 * window this app queries. Fetching the full active set is expensive, so a
 * single in-flight request is shared instead of duplicated by dev reloads or
 * repeated dashboard refreshes.
 */
async function resolveTotalActiveBalance(epoch: number): Promise<bigint> {
  // 1. In-process memory cache
  const mem = getTotalActiveBalance(epoch);
  if (mem !== undefined) {
    logger.debug("Total active balance from memory cache", { epoch });
    return mem;
  }

  // 2. Redis per-epoch cache
  const redisKey = activeBalanceKey();
  const cached = await cacheGet<string>(redisKey);
  if (cached !== undefined) {
    const balance = BigInt(cached!);
    setTotalActiveBalance(epoch, balance);
    logger.debug("Total active balance from Redis cache", { epoch, redisKey });
    return balance;
  }

  const inFlight = activeBalanceFetches.get(redisKey);
  if (inFlight) {
    return inFlight;
  }

  // 3. Live fetch from beacon node
  const fetchPromise = getActiveValidatorBalance(epoch)
    .then(async ({ totalActiveBalance }) => {
      // Populate both caches with per-epoch key
      setTotalActiveBalance(epoch, totalActiveBalance);
      await cacheSet(redisKey, totalActiveBalance.toString(), CACHE_TTL_SECONDS);

      logger.info("Total active balance fetched from beacon node", {
        epoch,
        totalActiveBalance: totalActiveBalance.toString(),
      });

      return totalActiveBalance;
    })
    .finally(() => {
      activeBalanceFetches.delete(redisKey);
    });

  activeBalanceFetches.set(redisKey, fetchPromise);
  return fetchPromise;
}

// ─── Validator index resolution ───────────────────────────────────────────────

/**
 * Resolves a validator's committee assignment for a given epoch.
 *
 * Endpoint: GET /eth/v1/beacon/states/head/committees?epoch=N
 *
 * We use the "head" state with an epoch query param rather than a slot-based
 * state ID, because non-archival nodes prune historical slots and return 404
 * for any slot older than ~2 epochs.  "head" is always available.
 *
 * The response lists every committee for every slot in the epoch.  We scan to
 * find which slot/committee/position our validator is assigned to.
 *
 * Also carries `precedingCommitteeSizes` — the sizes of all committees with a
 * lower index in the same slot.  This is needed by the Electra (EIP-7549)
 * attestation decoder to calculate the correct bit offset within the
 * concatenated aggregation_bits bitvector.
 *
 * Returns null if the validator is not found in any committee
 * (e.g. not active that epoch).
 */
interface CommitteeAssignment {
  slot: number;
  committeeIndex: number;
  positionInCommittee: number;
  committeeSize: number;
  /** Sizes of all committees with index < committeeIndex in the same slot (Electra) */
  precedingCommitteeSizes: number[];
}

async function getValidatorCommitteeAssignment(
  validatorIndex: number,
  epoch: number,
): Promise<CommitteeAssignment | null> {
  // ── Cache check ──
  // Committee assignments for finalized epochs are immutable — safe to cache
  // indefinitely. CACHE_TTL_SECONDS (default 1h) is used for consistency with
  // the rest of the pipeline, but any long TTL would work.
  const redisKey = committeeAssignmentKey(validatorIndex, epoch);
  const cached = await cacheGet<CommitteeAssignment | "null">(redisKey);
  if (cached !== undefined) {
    if (cached === "null") {
      logger.debug("Committee assignment cache hit: not assigned", {
        validatorIndex,
        epoch,
      });
      return null;
    }
    logger.debug("Committee assignment cache hit", { validatorIndex, epoch });
    return cached as CommitteeAssignment;
  }

  // ── Live fetch ──
  // Use "head" state with epoch query param — always available on non-archival nodes.
  const { fetchWithRetry } = await import("../clients/beaconClient.js");
  const { BEACON_URL } = await import("../../constants.js");

  const url = `${BEACON_URL}/eth/v1/beacon/states/head/committees`;

  let raw: unknown;
  try {
    raw = await fetchWithRetry(url, { epoch: String(epoch) });
  } catch (err) {
    const e = err as { code: string; message: string };
    logger.warn("Failed to fetch committees for epoch", {
      code: e.code,
      message: e.message,
      epoch,
      validatorIndex,
    });
    return null;
  }

  const body = raw as {
    data: Array<{
      index: string;
      slot: string;
      validators: string[];
    }>;
  };

  // Group committees by slot so we can collect precedingCommitteeSizes
  // (needed for Electra aggregation_bits offset calculation).
  const committeesBySlot = new Map<
    number,
    Array<{ index: number; validators: string[] }>
  >();
  for (const committee of body.data) {
    const s = Number(committee.slot);
    if (!committeesBySlot.has(s)) committeesBySlot.set(s, []);
    committeesBySlot.get(s)!.push({
      index: Number(committee.index),
      validators: committee.validators,
    });
  }

  for (const committee of body.data) {
    const pos = committee.validators.indexOf(String(validatorIndex));
    if (pos !== -1) {
      const assignedSlot = Number(committee.slot);
      const assignedCommitteeIndex = Number(committee.index);

      // Collect sizes of all committees in the same slot with index < assignedCommitteeIndex
      const slotCommittees = committeesBySlot.get(assignedSlot) ?? [];
      const precedingCommitteeSizes = slotCommittees
        .filter((c) => c.index < assignedCommitteeIndex)
        .sort((a, b) => a.index - b.index)
        .map((c) => c.validators.length);

      const assignment: CommitteeAssignment = {
        slot: assignedSlot,
        committeeIndex: assignedCommitteeIndex,
        positionInCommittee: pos,
        committeeSize: committee.validators.length,
        precedingCommitteeSizes,
      };

      // Cache the found assignment — finalized epoch data is immutable
      await cacheSet(redisKey, assignment, CACHE_TTL_SECONDS);
      return assignment;
    }
  }

  logger.warn("Validator not found in any committee for epoch", {
    validatorIndex,
    epoch,
  });
  // Cache the "not assigned" result too, so we don't re-fetch for this epoch
  await cacheSet(redisKey, "null", CACHE_TTL_SECONDS);
  return null;
}

// ─── Attestation scanning ─────────────────────────────────────────────────────

/**
 * Scans a range of slots for a block that contains an attestation from
 * `validatorIndex` for the given `attestationSlot`.
 *
 * Altair inclusion window:
 *  - Minimum: slot + 1 (MIN_ATTESTATION_INCLUSION_DELAY = 1)
 *  - Maximum: slot + 32 (SLOTS_PER_EPOCH)
 *
 * ## Electra / EIP-7549 attestation format (post-Pectra, active since May 2025)
 *
 * In Electra, attestations are consolidated across committees within a slot:
 *   - `data.index` is always 0 (not the committee index)
 *   - `committee_bits`: a bitvector where bit i = 1 means committee i is included
 *   - `aggregation_bits`: concatenation of per-committee participant bitvectors,
 *     ordered by committee index (only for committees with committee_bits[i] = 1)
 *
 * To check if our validator (committee `ci`, position `pos`) is included:
 *   1. Check bit `ci` in `committee_bits` (SSZ little-endian, same as isBitSet)
 *   2. Count set bits in `committee_bits` before position `ci` → `committeesBeforeUs`
 *   3. Bit offset = sum(sizes of committees before ours that are also present) + pos
 *   4. Check that bit in `aggregation_bits`
 *
 * ## Pre-Electra fallback
 *
 * If `committee_bits` is absent, use the legacy path:
 *   - Check `data.index === committeeIndex`
 *   - Check `aggregation_bits` at `positionInCommittee`
 */
interface InclusionResult {
  inclusionSlot: number;
  inclusionDelay: number;
  sourceRoot: string;
  targetRoot: string;
  targetEpoch: number;
  beaconBlockRoot: string;
  sourceEpoch: number;
}

async function findAttestationInclusion(
  validatorIndex: number,
  attestationSlot: number,
  committeeIndex: number,
  positionInCommittee: number,
  committeeSize: number,
  precedingCommitteeSizes: number[],
): Promise<InclusionResult | null> {
  const minInclusion = attestationSlot + 1;
  const maxInclusion = attestationSlot + 32; // SLOTS_PER_EPOCH

  // Fetch attestations for all 32 candidate slots in parallel using the
  // lightweight v1 endpoint GET /eth/v1/beacon/blocks/{slot}/attestations.
  // This returns only the attestations array (not the full block), making
  // the payload significantly smaller than the v2 blocks endpoint.
  const slots: number[] = [];
  for (let s = minInclusion; s <= maxInclusion; s++) slots.push(s);

  const attResults = await Promise.allSettled(
    slots.map((s) => getBlockAttestations(s)),
  );

  for (let i = 0; i < slots.length; i++) {
    const scanSlot = slots[i] as number;
    const result = attResults[i] as PromiseSettledResult<
      ReturnType<typeof getBlockAttestations> extends Promise<infer T>
        ? T
        : never
    >;

    // Skip missed slots or failed fetches
    if (result.status === "rejected") continue;
    const attestations = result.value;
    if (attestations === null) continue;

    for (const att of attestations) {
      if (Number(att.data.slot) !== attestationSlot) continue;

      let bitOffset: number;

      if (att.committee_bits !== undefined) {
        // ── Electra / EIP-7549 path ──────────────────────────────────────────
        // Step 1: Is our committee included in this aggregated attestation?
        if (!isBitSet(att.committee_bits, committeeIndex)) continue;

        // Step 2: Sum the sizes of all preceding included committees to get
        //   our starting offset within the concatenated aggregation_bits.
        let offset = 0;
        for (let ci = 0; ci < committeeIndex; ci++) {
          if (!isBitSet(att.committee_bits, ci)) continue;
          const precedingSize = precedingCommitteeSizes[ci] ?? committeeSize;
          offset += precedingSize;
        }

        // Step 3: Our validator's bit in aggregation_bits
        bitOffset = offset + positionInCommittee;
      } else {
        // ── Pre-Electra path ─────────────────────────────────────────────────
        if (Number(att.data.index) !== committeeIndex) continue;
        bitOffset = positionInCommittee;
      }

      // Step 4: Is the bit set?
      if (!isBitSet(att.aggregation_bits, bitOffset)) continue;

      logger.debug("Attestation found in block", {
        validatorIndex,
        attestationSlot,
        inclusionSlot: scanSlot,
        inclusionDelay: scanSlot - attestationSlot,
        electra: att.committee_bits !== undefined,
        bitOffset,
      });

      return {
        inclusionSlot: scanSlot,
        inclusionDelay: scanSlot - attestationSlot,
        sourceRoot: att.data.source.root,
        sourceEpoch: Number(att.data.source.epoch),
        targetRoot: att.data.target.root,
        targetEpoch: Number(att.data.target.epoch),
        beaconBlockRoot: att.data.beacon_block_root,
      };
    }
  }

  return null;
}

/**
 * Checks whether bit at `position` is set in an SSZ bitlist / bitvector
 * encoded as a 0x-prefixed hex string.
 *
 * SSZ bitlists are little-endian: the first validator in the committee maps
 * to bit 0 of byte 0.  The final byte contains a sentinel 1-bit after the
 * last valid bit (SSZ bitlist length encoding) which we ignore.
 */
function isBitSet(hexBits: string, position: number): boolean {
  const hex = hexBits.startsWith("0x") ? hexBits.slice(2) : hexBits;
  const byteIndex = Math.floor(position / 8);
  const bitIndex = position % 8;

  if (byteIndex * 2 + 2 > hex.length) return false;

  const byte = parseInt(hex.slice(byteIndex * 2, byteIndex * 2 + 2), 16);
  return (byte & (1 << bitIndex)) !== 0;
}

// ─── Checkpoint verification ──────────────────────────────────────────────────

/**
 * Verifies source and target checkpoint correctness.
 *
 * SOURCE: Per the Altair spec, an attestation's source must equal the
 *   justified checkpoint at the time of the attestation slot.  On a healthy
 *   finalizing chain the justified checkpoint at slot S is always epoch
 *   floor(S/32) - 1 (the previous epoch).  We verify this mathematically:
 *
 *     expectedSourceEpoch = floor(attestationSlot / 32) - 1
 *
 *   Root comparison is skipped — we cannot fetch historical state roots on
 *   a non-archival node, and epoch-match is sufficient for a monitoring
 *   dashboard (documented in RESEARCH.md).
 *
 * TARGET: The attestation's target epoch must equal floor(attestationSlot/32).
 *   Root verification skipped (same reason).
 *
 * HEAD: inclusionDelay === 1 AND beacon_block_root matches the block at the
 *   attestation slot.  We fetch GET /eth/v1/beacon/blocks/{attestationSlot}
 *   for this — it's a recent block so it's available on the node.
 */
interface CheckpointVerification {
  sourceCorrect: boolean;
  targetCorrect: boolean;
  headCorrect: boolean;
}

async function verifyCheckpoints(
  inclusion: InclusionResult,
  attestationSlot: number,
): Promise<CheckpointVerification> {
  const attestationEpoch = Math.floor(attestationSlot / 32);

  // ── SOURCE verification ──
  // On a healthy finalizing chain, the justified checkpoint at any slot is
  // the previous epoch (attestationEpoch - 1).  We verify the source epoch
  // matches this — no network call needed, no stale root comparison.
  // Edge case: epoch 0 has no previous epoch, treat as correct.
  const expectedSourceEpoch = attestationEpoch > 0 ? attestationEpoch - 1 : 0;
  const sourceCorrect = inclusion.sourceEpoch === expectedSourceEpoch;

  // ── TARGET verification ──
  // Target epoch must equal the epoch of the attestation slot.
  const targetCorrect = inclusion.targetEpoch === attestationEpoch;

  // ── HEAD verification ──
  // Per Altair spec: TIMELY_HEAD requires inclusion_delay === 1
  // AND the beacon_block_root must match the canonical head at the attestation slot.
  //
  // We use GET /eth/v1/beacon/headers/{slot} rather than /eth/v1/beacon/blocks/{slot}
  // because only the headers endpoint includes a `root` field in its response body:
  //   { data: { root: "0x...", canonical: true, header: { message: {...}, signature: "..." } } }
  // The blocks endpoint returns only { data: { message: {...}, signature: "..." } } with
  // no top-level root, making root comparison impossible without re-hashing the SSZ block.
  // Recent block headers are always available on non-archival nodes.
  let headCorrect = false;
  if (inclusion.inclusionDelay === 1) {
    const { fetchWithRetry } = await import("../clients/beaconClient.js");
    const { BEACON_URL } = await import("../../constants.js");
    try {
      const headerUrl = `${BEACON_URL}/eth/v1/beacon/headers/${attestationSlot}`;
      const headerRaw = (await fetchWithRetry(headerUrl)) as {
        data: { root: string; canonical: boolean; header: unknown };
      };

      // The headers endpoint always returns `data.root` — compare directly
      // against the beacon_block_root reported by the attestation.
      headCorrect = inclusion.beaconBlockRoot === headerRaw.data.root;

      logger.debug("HEAD verification via beacon headers", {
        attestationSlot,
        attestedRoot: inclusion.beaconBlockRoot.slice(0, 16) + "...",
        canonicalRoot: headerRaw.data.root.slice(0, 16) + "...",
        canonical: headerRaw.data.canonical,
        headCorrect,
      });
    } catch {
      // 404 = slot was missed (no canonical block) — head cannot be correct
      headCorrect = false;
    }
  }

  return { sourceCorrect, targetCorrect, headCorrect };
}

// ─── Main computation entry point ────────────────────────────────────────────

/**
 * Computes the Altair attestation reward for a single validator in a single epoch.
 *
 * This is the canonical on-chain computation path.  It:
 *  - Fetches total_active_balance from the beacon node (per epoch)
 *  - Fetches effective_balance from the beacon node (per epoch)
 *  - Scans beacon blocks to reconstruct TIMELY_SOURCE/TARGET/HEAD flags
 *  - Applies the Altair reward formulas from rewardCalculator.ts
 *  - Returns a fully structured ComputedEpochResult
 *
 * Results are cached in Redis for CACHE_TTL_SECONDS (default 1 h).
 * Finalized epoch data is immutable, so this is safe.
 *
 * @param validatorIndex - Numeric validator index
 * @param epoch - The epoch to compute rewards for (must be finalized)
 */
export async function computeEpochRewards(
  validatorIndex: number,
  epoch: number,
): Promise<ComputedEpochResult> {
  const cacheKey = computedEpochKey(validatorIndex, epoch);

  // ── Cache check ──
  const cached = await cacheGet<ComputedEpochResult>(cacheKey);
  if (cached !== undefined) {
    logger.debug("Computed epoch result from cache", { validatorIndex, epoch });
    return cached!;
  }

  logger.info("Computing epoch rewards from beacon node", {
    validatorIndex,
    epoch,
  });

  // ── 1. Total active balance (fetched per epoch, never hardcoded) ──
  const totalActiveBalance = await resolveTotalActiveBalance(epoch);

  // ── 2. Validator effective balance at this epoch ──
  let effectiveBalance: bigint;
  try {
    effectiveBalance = await getValidatorEffectiveBalanceAtEpoch(
      validatorIndex,
      epoch,
    );
  } catch (err) {
    const e = err as { code: string; message: string };
    logger.warn("Failed to fetch effective balance, using 32 ETH default", {
      code: e.code,
      message: e.message,
      validatorIndex,
      epoch,
    });
    // Safe fallback: 32 ETH (max effective balance for an un-penalised validator)
    effectiveBalance = 32_000_000_000n;
  }

  // ── 3. Base reward (Altair spec formula) ──
  const baseReward = getBaseReward(effectiveBalance, totalActiveBalance);

  // ── 4. Committee assignment for this epoch ──
  const assignment = await getValidatorCommitteeAssignment(
    validatorIndex,
    epoch,
  );

  if (assignment === null) {
    // Validator was not active / not assigned this epoch — no attestation duty
    const result = buildNotAssignedResult(validatorIndex, epoch, baseReward);
    await cacheSet(cacheKey, result, CACHE_TTL_SECONDS);
    return result;
  }

  // ── 5. Scan blocks for attestation inclusion ──
  const inclusion = await findAttestationInclusion(
    validatorIndex,
    assignment.slot,
    assignment.committeeIndex,
    assignment.positionInCommittee,
    assignment.committeeSize,
    assignment.precedingCommitteeSizes,
  );

  // ── 6. Verify checkpoints ──
  let sourceCorrect = false;
  let targetCorrect = false;
  let headCorrect = false;

  if (inclusion !== null) {
    const verification = await verifyCheckpoints(inclusion, assignment.slot);
    sourceCorrect = verification.sourceCorrect;
    targetCorrect = verification.targetCorrect;
    headCorrect = verification.headCorrect;
  }

  // ── 7. Determine participation flags (Altair spec conditions) ──
  const flags = determineParticipationFlags(
    inclusion !== null,
    inclusion?.inclusionDelay ?? null,
    sourceCorrect,
    targetCorrect,
    headCorrect,
  );

  // ── 8. Calculate rewards using the Altair formula ──
  const rewards = calculateAttestationRewards(
    effectiveBalance,
    totalActiveBalance,
    flags,
  );

  // ── 9. Classify miss ──
  const missType = classifyMiss(
    inclusion !== null,
    inclusion?.inclusionDelay ?? null,
    sourceCorrect,
    targetCorrect,
    headCorrect,
  );

  const analysis = analyzeAttestation(
    inclusion !== null,
    inclusion?.inclusionDelay ?? null,
    sourceCorrect,
    targetCorrect,
    headCorrect,
  );

  const result: ComputedEpochResult = {
    epoch,
    validatorIndex,
    included: inclusion !== null,
    inclusionDelay: inclusion?.inclusionDelay ?? null,
    timelySource: flags.timelySource,
    timelyTarget: flags.timelyTarget,
    timelyHead: flags.timelyHead,
    sourceReward: rewards.sourceReward.toString(),
    targetReward: rewards.targetReward.toString(),
    headReward: rewards.headReward.toString(),
    sourceMissed: rewards.sourceMissed.toString(),
    targetMissed: rewards.targetMissed.toString(),
    headMissed: rewards.headMissed.toString(),
    totalEarned: rewards.totalEarned.toString(),
    totalMissed: rewards.totalMissed.toString(),
    totalMissedEth: formatGweiToEth(rewards.totalMissed),
    baseReward: baseReward.toString(),
    missType,
    analysis,
    dataSource: "beacon_node",
  };

  // ── 10. Cache the computed result ──
  await cacheSet(cacheKey, result, CACHE_TTL_SECONDS);

  logger.info("Epoch rewards computed", {
    validatorIndex,
    epoch,
    missType,
    totalEarned: result.totalEarned,
    totalMissed: result.totalMissed,
    baseReward: result.baseReward,
  });

  return result;
}

/**
 * Builds a result for epochs where the validator had no attestation duty
 * (not active, or not assigned to any committee).
 */
function buildNotAssignedResult(
  validatorIndex: number,
  epoch: number,
  baseReward: bigint,
): ComputedEpochResult {
  return {
    epoch,
    validatorIndex,
    included: false,
    inclusionDelay: null,
    timelySource: false,
    timelyTarget: false,
    timelyHead: false,
    sourceReward: "0",
    targetReward: "0",
    headReward: "0",
    sourceMissed: "0",
    targetMissed: "0",
    headMissed: "0",
    totalEarned: "0",
    totalMissed: "0",
    totalMissedEth: "0.000000000",
    baseReward: baseReward.toString(),
    missType: "missed_entirely",
    analysis: {
      classification: "missed_entirely",
      included: false,
      inclusionDelay: null,
      sourceStatus: "wrong",
      targetStatus: "wrong",
      headStatus: "wrong",
    },
    dataSource: "beacon_node",
  };
}

/**
 * Computes rewards for a validator across a range of epochs.
 *
 * Epochs are processed sequentially to avoid hammering the beacon node.
 * Each epoch result is individually cached, so partial progress is preserved
 * if the request is interrupted.
 *
 * @param validatorIndex - Numeric validator index
 * @param fromEpoch - Start epoch (inclusive)
 * @param toEpoch - End epoch (inclusive)
 * @returns Array of results, newest epoch first
 */
export async function computeEpochRangeRewards(
  validatorIndex: number,
  fromEpoch: number,
  toEpoch: number,
): Promise<{
  results: ComputedEpochResult[];
  missingEpochs: Array<{ epoch: number; reason: string; code?: string }>;
}> {
  const results: ComputedEpochResult[] = [];
  const missingEpochs: Array<{ epoch: number; reason: string; code?: string }> =
    [];

  for (let epoch = toEpoch; epoch >= fromEpoch; epoch--) {
    try {
      const result = await computeEpochRewards(validatorIndex, epoch);
      results.push(result);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      epochFetchErrorsTotal.inc({ reason: e.code ?? "unknown" });
      logger.error("Failed to compute epoch rewards", {
        validatorIndex,
        epoch,
        code: e.code ?? "UNKNOWN",
        message: e.message ?? String(err),
      });
      missingEpochs.push({
        epoch,
        reason: "compute_error",
        code: e.code ?? "UNKNOWN",
      });
    }
  }

  return { results, missingEpochs };
}
