/**
 * Altair Reward Calculator
 *
 * Implements the Altair consensus specification reward formulas directly.
 * See: https://github.com/ethereum/consensus-specs/blob/dev/specs/altair/beacon-chain.md
 *
 * Key formulas implemented per spec:
 * - get_base_reward: (effective_balance / EFFECTIVE_BALANCE_INCREMENT) * base_reward_per_increment
 * - base_reward_per_increment: EFFECTIVE_BALANCE_INCREMENT * BASE_REWARD_FACTOR / sqrt(total_active_balance)
 * - Per-flag reward: base_reward * flag_weight / WEIGHT_DENOMINATOR
 * - Per-flag missed: base_reward * flag_weight / WEIGHT_DENOMINATOR (when flag not earned)
 *
 * Participation flag conditions (per Altair spec):
 * - TIMELY_SOURCE (weight 14): correct source checkpoint, included within sqrt(32) = 5 slots
 * - TIMELY_TARGET (weight 26): correct target checkpoint, included within 32 slots (full epoch)
 * - TIMELY_HEAD (weight 14): correct head vote, included in the very next slot (delay = 1)
 */

import { logger } from '../utils/logger.js';
import {
  BASE_REWARD_FACTOR,
  EFFECTIVE_BALANCE_INCREMENT,
  MAX_EFFECTIVE_BALANCE,
  WEIGHT_DENOMINATOR,
  TIMELY_SOURCE_WEIGHT,
  TIMELY_TARGET_WEIGHT,
  TIMELY_HEAD_WEIGHT,
  TIMELY_SOURCE_MAX_INCLUSION_DELAY,
  TIMELY_TARGET_MAX_INCLUSION_DELAY,
  TIMELY_HEAD_MAX_INCLUSION_DELAY,
  GWEI_PER_ETH,
  integerSquareRoot,
  type ParticipationFlags,
  type AttestationRewardBreakdown,
  type MissClassification,
  type AttestationMissAnalysis,
  type AggregatedMissedRewards,
} from './altairConstants.js';

// ─── Cache for total active balance per epoch ─────────────────────────────────

/**
 * Cache for total active balance lookups.
 * Key: epoch number, Value: total active balance in Gwei as BigInt.
 * This is populated by fetchTotalActiveBalance() and persists for the process lifetime.
 *
 * IMPORTANT: Total active balance MUST be fetched per epoch from the network.
 * It is NEVER hardcoded — this is a critical requirement for accurate reward calculation.
 */
const totalActiveBalanceCache = new Map<number, bigint>();

/**
 * Sets the cached total active balance for an epoch.
 * Called after fetching from the Beacon API.
 *
 * @param epoch - Epoch number
 * @param totalActiveBalance - Total active balance in Gwei
 */
export function setTotalActiveBalance(epoch: number, totalActiveBalance: bigint): void {
  totalActiveBalanceCache.set(epoch, totalActiveBalance);
  logger.debug('Cached total active balance', { epoch, totalActiveBalance: totalActiveBalance.toString() });
}

/**
 * Gets the cached total active balance for an epoch.
 *
 * @param epoch - Epoch number
 * @returns Cached balance or undefined if not cached
 */
export function getTotalActiveBalance(epoch: number): bigint | undefined {
  return totalActiveBalanceCache.get(epoch);
}

/**
 * Clears the total active balance cache.
 * Useful for testing or when resetting state.
 */
export function clearTotalActiveBalanceCache(): void {
  totalActiveBalanceCache.clear();
  logger.debug('Total active balance cache cleared');
}

// ─── Base Reward Calculation ──────────────────────────────────────────────────

/**
 * Calculates the base reward per increment per the Altair specification.
 *
 * Per spec (https://github.com/ethereum/consensus-specs/blob/dev/specs/altair/beacon-chain.md#get_base_reward_per_increment):
 * ```python
 * def get_base_reward_per_increment(state: BeaconState) -> Gwei:
 *     return Gwei(EFFECTIVE_BALANCE_INCREMENT * BASE_REWARD_FACTOR // integer_squareroot(get_total_active_balance(state)))
 * ```
 *
 * @param totalActiveBalance - Sum of all active validators' effective balances in Gwei (fetched per epoch, never hardcoded)
 * @returns Base reward per increment in Gwei as BigInt
 */
export function getBaseRewardPerIncrement(totalActiveBalance: bigint): bigint {
  if (totalActiveBalance <= 0n) {
    throw {
      code: 'INVALID_TOTAL_BALANCE',
      message: 'totalActiveBalance must be positive',
    };
  }

  const sqrtTotalBalance = integerSquareRoot(totalActiveBalance);
  return (EFFECTIVE_BALANCE_INCREMENT * BASE_REWARD_FACTOR) / sqrtTotalBalance;
}

/**
 * Calculates the base reward for a validator per the Altair specification.
 *
 * Per spec (https://github.com/ethereum/consensus-specs/blob/dev/specs/altair/beacon-chain.md#get_base_reward):
 * ```python
 * def get_base_reward(state: BeaconState, index: ValidatorIndex) -> Gwei:
 *     """
 *     Return the base reward for the validator defined by ``index`` with respect to the current ``state``.
 *     """
 *     increments = state.validators[index].effective_balance // EFFECTIVE_BALANCE_INCREMENT
 *     return Gwei(increments * get_base_reward_per_increment(state))
 * ```
 *
 * The total_active_balance is the sum of effective balances of all active validators.
 * It MUST be fetched from the network per epoch — never hardcoded.
 *
 * @param effectiveBalance - Validator's effective balance in Gwei (capped at 32 ETH)
 * @param totalActiveBalance - Sum of all active validators' effective balances in Gwei (fetched per epoch)
 * @returns Base reward in Gwei as BigInt
 */
export function getBaseReward(effectiveBalance: bigint, totalActiveBalance: bigint): bigint {
  if (totalActiveBalance <= 0n) {
    logger.error('getBaseReward called with non-positive total active balance', {
      code: 'INVALID_TOTAL_BALANCE',
      message: 'totalActiveBalance must be positive',
      totalActiveBalance: totalActiveBalance.toString(),
    });
    throw {
      code: 'INVALID_TOTAL_BALANCE',
      message: 'totalActiveBalance must be positive',
    };
  }

  // Cap effective balance at MAX_EFFECTIVE_BALANCE (32 ETH) per spec
  const cappedBalance = effectiveBalance > MAX_EFFECTIVE_BALANCE
    ? MAX_EFFECTIVE_BALANCE
    : effectiveBalance;

  // Calculate increments: effective_balance // EFFECTIVE_BALANCE_INCREMENT
  const increments = cappedBalance / EFFECTIVE_BALANCE_INCREMENT;

  // Calculate base reward per increment per spec
  const baseRewardPerIncrement = getBaseRewardPerIncrement(totalActiveBalance);

  // Final base reward: increments * base_reward_per_increment
  const baseReward = increments * baseRewardPerIncrement;

  logger.debug('Base reward calculated per Altair spec', {
    effectiveBalance: effectiveBalance.toString(),
    cappedBalance: cappedBalance.toString(),
    increments: increments.toString(),
    totalActiveBalance: totalActiveBalance.toString(),
    sqrtTotalBalance: integerSquareRoot(totalActiveBalance).toString(),
    baseRewardPerIncrement: baseRewardPerIncrement.toString(),
    baseReward: baseReward.toString(),
  });

  return baseReward;
}

// ─── Participation Flag Determination ─────────────────────────────────────────

/**
 * Determines which participation flags were earned based on attestation data.
 *
 * Per Altair spec, the conditions for each flag are:
 *
 * TIMELY_SOURCE (index 0, weight 14):
 *   - Attestation source matches justified checkpoint
 *   - Included within integer_squareroot(SLOTS_PER_EPOCH) = 5 slots
 *
 * TIMELY_TARGET (index 1, weight 26):
 *   - Attestation target matches epoch boundary block
 *   - Included within SLOTS_PER_EPOCH = 32 slots
 *
 * TIMELY_HEAD (index 2, weight 14):
 *   - Attestation head matches the head at attestation slot
 *   - Included in the very next slot (inclusion_delay = 1)
 *
 * @param included - Whether the attestation was included in any block
 * @param inclusionDelay - Number of slots between attestation slot and inclusion slot (null if not included)
 * @param sourceCorrect - Whether the source checkpoint was correct
 * @param targetCorrect - Whether the target checkpoint was correct
 * @param headCorrect - Whether the head vote was correct
 * @returns Participation flags indicating which rewards were earned
 */
export function determineParticipationFlags(
  included: boolean,
  inclusionDelay: number | null,
  sourceCorrect: boolean,
  targetCorrect: boolean,
  headCorrect: boolean,
): ParticipationFlags {
  // If not included, no flags can be earned
  if (!included || inclusionDelay === null) {
    return {
      timelySource: false,
      timelyTarget: false,
      timelyHead: false,
    };
  }

  // TIMELY_SOURCE: correct source AND included within 5 slots
  const timelySource = sourceCorrect && inclusionDelay <= TIMELY_SOURCE_MAX_INCLUSION_DELAY;

  // TIMELY_TARGET: correct target AND included within 32 slots (full epoch)
  const timelyTarget = targetCorrect && inclusionDelay <= TIMELY_TARGET_MAX_INCLUSION_DELAY;

  // TIMELY_HEAD: correct head AND included in the very next slot (delay = 1)
  const timelyHead = headCorrect && inclusionDelay <= TIMELY_HEAD_MAX_INCLUSION_DELAY;

  logger.debug('Participation flags determined', {
    included,
    inclusionDelay,
    sourceCorrect,
    targetCorrect,
    headCorrect,
    timelySource,
    timelyTarget,
    timelyHead,
  });

  return {
    timelySource,
    timelyTarget,
    timelyHead,
  };
}

// ─── Flag Reward Calculation ──────────────────────────────────────────────────

/**
 * Calculates the reward/missed reward for a specific participation flag.
 *
 * Per Altair spec (get_flag_index_deltas):
 * - If flag is set: reward = base_reward * flag_weight / WEIGHT_DENOMINATOR
 * - If flag is not set: the validator misses this reward component
 *
 * The formula for missed_reward is:
 *   missed_reward = (base_reward × flag_weight) / 64
 *
 * @param baseReward - Validator's base reward for this epoch
 * @param flagWeight - Weight of the flag (14 for source/head, 26 for target)
 * @param flagEarned - Whether the flag was earned
 * @returns { earned: bigint, missed: bigint }
 */
export function calculateFlagReward(
  baseReward: bigint,
  flagWeight: bigint,
  flagEarned: boolean,
): { earned: bigint; missed: bigint } {
  // Per spec: reward = base_reward * flag_weight / WEIGHT_DENOMINATOR
  const reward = (baseReward * flagWeight) / WEIGHT_DENOMINATOR;

  if (flagEarned) {
    return { earned: reward, missed: 0n };
  } else {
    // Missed reward is the same amount — the validator didn't earn it
    return { earned: 0n, missed: reward };
  }
}

/**
 * Calculates individual component rewards/missed for source, target, and head.
 *
 * Per the specification:
 * - Source missed = (base_reward × 14) / 64
 * - Target missed = (base_reward × 26) / 64
 * - Head missed = (base_reward × 14) / 64
 *
 * @param baseReward - Validator's base reward
 * @param flags - Which participation flags were earned
 */
export function calculateComponentRewards(
  baseReward: bigint,
  flags: ParticipationFlags,
): {
  source: { earned: bigint; missed: bigint };
  target: { earned: bigint; missed: bigint };
  head: { earned: bigint; missed: bigint };
} {
  return {
    source: calculateFlagReward(baseReward, TIMELY_SOURCE_WEIGHT, flags.timelySource),
    target: calculateFlagReward(baseReward, TIMELY_TARGET_WEIGHT, flags.timelyTarget),
    head: calculateFlagReward(baseReward, TIMELY_HEAD_WEIGHT, flags.timelyHead),
  };
}

// ─── Miss Classification ──────────────────────────────────────────────────────

/**
 * Classifies the type of miss for an attestation.
 *
 * Classification hierarchy:
 * 1. 'missed_entirely' — Attestation was never included in any block
 * 2. 'wrong_source' — Source checkpoint was incorrect (most severe, implies target/head also failed)
 * 3. 'late_source' — Source was correct but included too late (>5 slots)
 * 4. 'wrong_target' — Target checkpoint was incorrect
 * 5. 'wrong_head' — Head vote was incorrect
 * 6. 'late_head' — Head was correct but included too late (>1 slot)
 * 7. 'correct' — All flags earned
 *
 * @param included - Whether attestation was included
 * @param inclusionDelay - Slots between attestation and inclusion
 * @param sourceCorrect - Whether source checkpoint matched
 * @param targetCorrect - Whether target checkpoint matched
 * @param headCorrect - Whether head vote matched
 */
export function classifyMiss(
  included: boolean,
  inclusionDelay: number | null,
  sourceCorrect: boolean,
  targetCorrect: boolean,
  headCorrect: boolean,
): MissClassification {
  // Not included at all — most severe
  if (!included || inclusionDelay === null) {
    return 'missed_entirely';
  }

  // Check source first (highest priority error)
  if (!sourceCorrect) {
    return 'wrong_source';
  }

  // Source correct but late (>5 slots)
  if (inclusionDelay > TIMELY_SOURCE_MAX_INCLUSION_DELAY) {
    return 'late_source';
  }

  // Check target
  if (!targetCorrect) {
    return 'wrong_target';
  }

  // Check head
  if (!headCorrect) {
    return 'wrong_head';
  }

  // Head correct but late (>1 slot)
  if (inclusionDelay > TIMELY_HEAD_MAX_INCLUSION_DELAY) {
    return 'late_head';
  }

  // All conditions met
  return 'correct';
}

/**
 * Provides detailed miss analysis for an attestation.
 *
 * @param included - Whether attestation was included
 * @param inclusionDelay - Slots between attestation and inclusion
 * @param sourceCorrect - Whether source checkpoint matched
 * @param targetCorrect - Whether target checkpoint matched
 * @param headCorrect - Whether head vote matched
 */
export function analyzeAttestation(
  included: boolean,
  inclusionDelay: number | null,
  sourceCorrect: boolean,
  targetCorrect: boolean,
  headCorrect: boolean,
): AttestationMissAnalysis {
  const classification = classifyMiss(included, inclusionDelay, sourceCorrect, targetCorrect, headCorrect);

  // Determine individual component statuses
  const sourceStatus: 'earned' | 'wrong' | 'late' =
    !included || !sourceCorrect ? 'wrong' :
    inclusionDelay !== null && inclusionDelay > TIMELY_SOURCE_MAX_INCLUSION_DELAY ? 'late' :
    'earned';

  const targetStatus: 'earned' | 'wrong' | 'late' =
    !included || !targetCorrect ? 'wrong' :
    inclusionDelay !== null && inclusionDelay > TIMELY_TARGET_MAX_INCLUSION_DELAY ? 'late' :
    'earned';

  const headStatus: 'earned' | 'wrong' | 'late' =
    !included || !headCorrect ? 'wrong' :
    inclusionDelay !== null && inclusionDelay > TIMELY_HEAD_MAX_INCLUSION_DELAY ? 'late' :
    'earned';

  return {
    classification,
    included,
    inclusionDelay,
    sourceStatus,
    targetStatus,
    headStatus,
  };
}

// ─── Full Attestation Reward Calculation ──────────────────────────────────────

/**
 * Calculates the full attestation reward breakdown for a validator.
 *
 * This implements the core Altair reward logic per the consensus specification:
 * 1. Computes base_reward from effective_balance and total_active_balance
 * 2. Determines which participation flags were earned
 * 3. Applies flag weights to calculate per-component rewards/missed
 * 4. Sums up totals
 *
 * @param effectiveBalance - Validator's effective balance in Gwei
 * @param totalActiveBalance - Network total active balance in Gwei (fetched per epoch, NEVER hardcoded)
 * @param flags - Which participation flags were earned
 * @returns Full breakdown of rewards and missed rewards
 */
export function calculateAttestationRewards(
  effectiveBalance: bigint,
  totalActiveBalance: bigint,
  flags: ParticipationFlags,
): AttestationRewardBreakdown {
  const baseReward = getBaseReward(effectiveBalance, totalActiveBalance);

  const source = calculateFlagReward(baseReward, TIMELY_SOURCE_WEIGHT, flags.timelySource);
  const target = calculateFlagReward(baseReward, TIMELY_TARGET_WEIGHT, flags.timelyTarget);
  const head = calculateFlagReward(baseReward, TIMELY_HEAD_WEIGHT, flags.timelyHead);

  const totalEarned = source.earned + target.earned + head.earned;
  const totalMissed = source.missed + target.missed + head.missed;

  logger.debug('Attestation rewards calculated per Altair spec', {
    baseReward: baseReward.toString(),
    sourceEarned: source.earned.toString(),
    sourceMissed: source.missed.toString(),
    targetEarned: target.earned.toString(),
    targetMissed: target.missed.toString(),
    headEarned: head.earned.toString(),
    headMissed: head.missed.toString(),
    totalEarned: totalEarned.toString(),
    totalMissed: totalMissed.toString(),
    flags,
  });

  return {
    baseReward,
    sourceReward: source.earned,
    targetReward: target.earned,
    headReward: head.earned,
    sourceMissed: source.missed,
    targetMissed: target.missed,
    headMissed: head.missed,
    totalEarned,
    totalMissed,
    flags,
  };
}

/**
 * Calculates attestation rewards from raw attestation data.
 *
 * Convenience function that combines flag determination and reward calculation.
 *
 * @param effectiveBalance - Validator's effective balance in Gwei
 * @param totalActiveBalance - Network total active balance (fetched per epoch)
 * @param included - Whether attestation was included
 * @param inclusionDelay - Slots between attestation and inclusion
 * @param sourceCorrect - Whether source checkpoint matched
 * @param targetCorrect - Whether target checkpoint matched
 * @param headCorrect - Whether head vote matched
 */
export function calculateRewardsFromAttestationData(
  effectiveBalance: bigint,
  totalActiveBalance: bigint,
  included: boolean,
  inclusionDelay: number | null,
  sourceCorrect: boolean,
  targetCorrect: boolean,
  headCorrect: boolean,
): AttestationRewardBreakdown & { classification: MissClassification; analysis: AttestationMissAnalysis } {
  const flags = determineParticipationFlags(included, inclusionDelay, sourceCorrect, targetCorrect, headCorrect);
  const rewards = calculateAttestationRewards(effectiveBalance, totalActiveBalance, flags);
  const classification = classifyMiss(included, inclusionDelay, sourceCorrect, targetCorrect, headCorrect);
  const analysis = analyzeAttestation(included, inclusionDelay, sourceCorrect, targetCorrect, headCorrect);

  return {
    ...rewards,
    classification,
    analysis,
  };
}

// ─── Aggregation Functions ────────────────────────────────────────────────────

/**
 * Aggregates missed rewards across multiple epochs.
 *
 * Sums up:
 * - Total missed rewards per component (source, target, head)
 * - Total earned rewards
 * - Counts of each miss classification type
 *
 * @param epochRewards - Array of reward breakdowns per epoch
 * @returns Aggregated missed rewards with ETH conversion
 */
export function aggregateMissedRewards(
  epochRewards: Array<AttestationRewardBreakdown & { classification: MissClassification }>,
): AggregatedMissedRewards {
  let totalBaseReward = 0n;
  let sourceMissed = 0n;
  let targetMissed = 0n;
  let headMissed = 0n;
  let totalEarned = 0n;

  const missCounts = {
    correct: 0,
    missedEntirely: 0,
    wrongSource: 0,
    wrongTarget: 0,
    wrongHead: 0,
    lateSource: 0,
    lateHead: 0,
  };

  for (const epoch of epochRewards) {
    totalBaseReward += epoch.baseReward;
    sourceMissed += epoch.sourceMissed;
    targetMissed += epoch.targetMissed;
    headMissed += epoch.headMissed;
    totalEarned += epoch.totalEarned;

    switch (epoch.classification) {
      case 'correct':
        missCounts.correct++;
        break;
      case 'missed_entirely':
        missCounts.missedEntirely++;
        break;
      case 'wrong_source':
        missCounts.wrongSource++;
        break;
      case 'wrong_target':
        missCounts.wrongTarget++;
        break;
      case 'wrong_head':
        missCounts.wrongHead++;
        break;
      case 'late_source':
        missCounts.lateSource++;
        break;
      case 'late_head':
        missCounts.lateHead++;
        break;
    }
  }

  const totalMissed = sourceMissed + targetMissed + headMissed;

  // Convert Gwei to ETH for readability (1 ETH = 10^9 Gwei)
  const totalMissedEth = formatGweiToEth(totalMissed);
  const totalEarnedEth = formatGweiToEth(totalEarned);

  return {
    totalBaseReward,
    sourceMissed,
    targetMissed,
    headMissed,
    totalMissed,
    totalEarned,
    totalMissedEth,
    totalEarnedEth,
    epochCount: epochRewards.length,
    missCounts,
  };
}

// ─── Formatting Utilities ─────────────────────────────────────────────────────

/**
 * Formats Gwei to ETH string with 9 decimal places.
 *
 * @param gwei - Amount in Gwei as BigInt
 * @returns ETH amount as string
 */
export function formatGweiToEth(gwei: bigint): string {
  const eth = gwei / GWEI_PER_ETH;
  const remainder = gwei % GWEI_PER_ETH;
  const decimalPart = remainder.toString().padStart(9, '0');
  return `${eth}.${decimalPart}`;
}

/**
 * Formats reward breakdown values to strings for JSON serialization.
 * BigInt cannot be serialized directly to JSON.
 *
 * @param breakdown - Reward breakdown with BigInt values
 * @returns Same structure with string values
 */
export function formatRewardBreakdown(breakdown: AttestationRewardBreakdown): {
  baseReward: string;
  sourceReward: string;
  targetReward: string;
  headReward: string;
  sourceMissed: string;
  targetMissed: string;
  headMissed: string;
  totalEarned: string;
  totalMissed: string;
  flags: ParticipationFlags;
} {
  return {
    baseReward: breakdown.baseReward.toString(),
    sourceReward: breakdown.sourceReward.toString(),
    targetReward: breakdown.targetReward.toString(),
    headReward: breakdown.headReward.toString(),
    sourceMissed: breakdown.sourceMissed.toString(),
    targetMissed: breakdown.targetMissed.toString(),
    headMissed: breakdown.headMissed.toString(),
    totalEarned: breakdown.totalEarned.toString(),
    totalMissed: breakdown.totalMissed.toString(),
    flags: breakdown.flags,
  };
}

/**
 * Formats aggregated missed rewards for JSON serialization.
 *
 * @param aggregated - Aggregated rewards with BigInt values
 * @returns Same structure with string values
 */
export function formatAggregatedRewards(aggregated: AggregatedMissedRewards): {
  totalBaseReward: string;
  sourceMissed: string;
  targetMissed: string;
  headMissed: string;
  totalMissed: string;
  totalEarned: string;
  totalMissedEth: string;
  totalEarnedEth: string;
  epochCount: number;
  missCounts: AggregatedMissedRewards['missCounts'];
} {
  return {
    totalBaseReward: aggregated.totalBaseReward.toString(),
    sourceMissed: aggregated.sourceMissed.toString(),
    targetMissed: aggregated.targetMissed.toString(),
    headMissed: aggregated.headMissed.toString(),
    totalMissed: aggregated.totalMissed.toString(),
    totalEarned: aggregated.totalEarned.toString(),
    totalMissedEth: aggregated.totalMissedEth,
    totalEarnedEth: aggregated.totalEarnedEth,
    epochCount: aggregated.epochCount,
    missCounts: aggregated.missCounts,
  };
}
