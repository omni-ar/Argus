/**
 * Altair Consensus Specification Constants
 *
 * These values are taken directly from the Ethereum Altair consensus specification:
 * https://github.com/ethereum/consensus-specs/blob/dev/specs/altair/beacon-chain.md
 *
 * All numeric constants are defined as BigInt for precision in reward calculations.
 *
 * References:
 * - Participation flags: https://github.com/ethereum/consensus-specs/blob/dev/specs/altair/beacon-chain.md#participation-flag-indices
 * - Incentivization weights: https://github.com/ethereum/consensus-specs/blob/dev/specs/altair/beacon-chain.md#incentivization-weights
 * - Rewards processing: https://github.com/ethereum/consensus-specs/blob/dev/specs/altair/beacon-chain.md#get_flag_index_deltas
 */

// ─── Participation Flag Indices ───────────────────────────────────────────────
// https://github.com/ethereum/consensus-specs/blob/dev/specs/altair/beacon-chain.md#participation-flag-indices

/** TIMELY_SOURCE flag index (0) */
export const TIMELY_SOURCE_FLAG_INDEX = 0;

/** TIMELY_TARGET flag index (1) */
export const TIMELY_TARGET_FLAG_INDEX = 1;

/** TIMELY_HEAD flag index (2) */
export const TIMELY_HEAD_FLAG_INDEX = 2;

// ─── Participation Flag Weights ───────────────────────────────────────────────
// https://github.com/ethereum/consensus-specs/blob/dev/specs/altair/beacon-chain.md#incentivization-weights
//
// The weights sum to WEIGHT_DENOMINATOR (64):
//   TIMELY_SOURCE_WEIGHT (14) + TIMELY_TARGET_WEIGHT (26) + TIMELY_HEAD_WEIGHT (14)
//   + SYNC_REWARD_WEIGHT (2) + PROPOSER_WEIGHT (8) = 64

/** Weight for TIMELY_SOURCE attestations (14/64 ≈ 21.9%) */
export const TIMELY_SOURCE_WEIGHT = 14n;

/** Weight for TIMELY_TARGET attestations (26/64 ≈ 40.6%) */
export const TIMELY_TARGET_WEIGHT = 26n;

/** Weight for TIMELY_HEAD attestations (14/64 ≈ 21.9%) */
export const TIMELY_HEAD_WEIGHT = 14n;

/** Sync committee reward weight (2/64 ≈ 3.1%) */
export const SYNC_REWARD_WEIGHT = 2n;

/** Proposer reward weight (8/64 = 12.5%) */
export const PROPOSER_WEIGHT = 8n;

/** Sum of all weights (64) — used as denominator in reward calculations */
export const WEIGHT_DENOMINATOR = 64n;

/**
 * Total attestation weight = TIMELY_SOURCE + TIMELY_TARGET + TIMELY_HEAD = 54
 * This is the maximum attestation reward factor (54/64 of base reward).
 */
export const TOTAL_ATTESTATION_WEIGHT = TIMELY_SOURCE_WEIGHT + TIMELY_TARGET_WEIGHT + TIMELY_HEAD_WEIGHT;

// ─── Time Parameters ──────────────────────────────────────────────────────────
// https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#time-parameters

/** Slots per epoch (32) */
export const SLOTS_PER_EPOCH = 32n;

/** Seconds per slot (12) */
export const SECONDS_PER_SLOT = 12n;

/**
 * Maximum inclusion delay for TIMELY_SOURCE — must be included within 5 slots.
 * Per Altair spec: integer_squareroot(SLOTS_PER_EPOCH) = sqrt(32) = 5
 */
export const TIMELY_SOURCE_MAX_INCLUSION_DELAY = 5;

/**
 * Maximum inclusion delay for TIMELY_TARGET — must be included within 32 slots (entire epoch).
 * Per Altair spec: SLOTS_PER_EPOCH = 32
 */
export const TIMELY_TARGET_MAX_INCLUSION_DELAY = 32;

/**
 * Maximum inclusion delay for TIMELY_HEAD — must be included in the very next slot (1).
 * Per Altair spec: MIN_ATTESTATION_INCLUSION_DELAY = 1
 */
export const TIMELY_HEAD_MAX_INCLUSION_DELAY = 1;

// ─── Reward/Penalty Constants ─────────────────────────────────────────────────
// https://github.com/ethereum/consensus-specs/blob/dev/specs/altair/beacon-chain.md#incentivization-weights

/**
 * BASE_REWARD_FACTOR (64)
 * Used in base_reward calculation: effective_balance * BASE_REWARD_FACTOR / sqrt(total_active_balance)
 *
 * Per Altair spec:
 *   base_reward_per_increment = EFFECTIVE_BALANCE_INCREMENT * BASE_REWARD_FACTOR // integer_squareroot(total_active_balance)
 *   base_reward = increments * base_reward_per_increment
 *
 * where increments = effective_balance // EFFECTIVE_BALANCE_INCREMENT
 */
export const BASE_REWARD_FACTOR = 64n;

/**
 * Effective balance increment (1 ETH = 10^9 Gwei)
 * All effective balances are multiples of this value.
 * https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#gwei-values
 */
export const EFFECTIVE_BALANCE_INCREMENT = 1_000_000_000n;

/**
 * Maximum effective balance per validator (32 ETH = 32 × 10^9 Gwei)
 * https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#gwei-values
 */
export const MAX_EFFECTIVE_BALANCE = 32_000_000_000n;

/**
 * Minimum effective balance to be considered an active validator.
 * Below this, the validator provides no security contribution.
 */
export const MIN_EFFECTIVE_BALANCE = EFFECTIVE_BALANCE_INCREMENT;

/**
 * GWEI per ETH (10^9)
 */
export const GWEI_PER_ETH = 1_000_000_000n;

/**
 * Integer square root (floor) — required for base_reward calculation.
 * Implements the same algorithm as the Python spec's integer_squareroot.
 *
 * Per Altair spec (https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#integer_squareroot):
 * ```python
 * def integer_squareroot(n: uint64) -> uint64:
 *     """
 *     Return the largest integer ``x`` such that ``x**2 <= n``.
 *     """
 *     if n == UINT64_MAX:
 *         return UINT32_MAX
 *     x = n
 *     y = (x + 1) // 2
 *     while y < x:
 *         x = y
 *         y = (x + n // x) // 2
 *     return x
 * ```
 *
 * @param n - Non-negative BigInt
 * @returns floor(sqrt(n)) as BigInt
 */
export function integerSquareRoot(n: bigint): bigint {
  if (n < 0n) {
    throw { code: 'MATH_ERROR', message: 'integerSquareRoot: negative input' };
  }
  if (n === 0n) return 0n;

  // Newton's method — matches Python spec exactly
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

// ─── Type Definitions ─────────────────────────────────────────────────────────

/** Participation flag result for a single attestation duty */
export interface ParticipationFlags {
  /** True if TIMELY_SOURCE was earned (correct source checkpoint, included within 5 slots) */
  timelySource: boolean;
  /** True if TIMELY_TARGET was earned (correct target checkpoint, included within 32 slots) */
  timelyTarget: boolean;
  /** True if TIMELY_HEAD was earned (correct head vote, included in very next slot) */
  timelyHead: boolean;
}

/** Calculated rewards/penalties for a single attestation */
export interface AttestationRewardBreakdown {
  /** Base reward for this validator in this epoch (Gwei) */
  baseReward: bigint;
  /** Reward earned for timely source (Gwei) — 0 if missed */
  sourceReward: bigint;
  /** Reward earned for timely target (Gwei) — 0 if missed */
  targetReward: bigint;
  /** Reward earned for timely head (Gwei) — 0 if missed */
  headReward: bigint;
  /** Missed reward for source component (Gwei) — 0 if earned */
  sourceMissed: bigint;
  /** Missed reward for target component (Gwei) — 0 if earned */
  targetMissed: bigint;
  /** Missed reward for head component (Gwei) — 0 if earned */
  headMissed: bigint;
  /** Total attestation rewards earned (Gwei) */
  totalEarned: bigint;
  /** Total attestation rewards missed (Gwei) */
  totalMissed: bigint;
  /** Which participation flags were earned */
  flags: ParticipationFlags;
}

/**
 * Miss classification per the spec requirements:
 * - 'correct': All participation flags earned
 * - 'missed_entirely': No attestation included at all
 * - 'wrong_source': Source checkpoint was incorrect (implies target/head also failed)
 * - 'wrong_target': Target checkpoint was incorrect (source may be correct, head failed)
 * - 'wrong_head': Head vote was incorrect or late (source/target correct)
 * - 'late_source': Correct source but included too late (>5 slots)
 * - 'late_head': Correct head but included too late (>1 slot, ≤5 slots)
 */
export type MissClassification =
  | 'correct'          
  | 'missed_entirely'   
  | 'wrong_source'     
  | 'wrong_target'     
  | 'wrong_head'        
  | 'late_source'       
  | 'late_head';

/**
 * Detailed miss analysis for a single attestation
 */
export interface AttestationMissAnalysis {
  /** The primary classification of the miss */
  classification: MissClassification;
  /** Was the attestation included in any block? */
  included: boolean;
  /** Inclusion delay in slots (null if not included) */
  inclusionDelay: number | null;
  /** Individual flag details */
  sourceStatus: 'earned' | 'wrong' | 'late';
  targetStatus: 'earned' | 'wrong' | 'late';
  headStatus: 'earned' | 'wrong' | 'late';
}

/**
 * Aggregated missed rewards across multiple epochs
 */
export interface AggregatedMissedRewards {
  /** Total base reward across all epochs (Gwei) */
  totalBaseReward: bigint;
  /** Total missed source rewards (Gwei) */
  sourceMissed: bigint;
  /** Total missed target rewards (Gwei) */
  targetMissed: bigint;
  /** Total missed head rewards (Gwei) */
  headMissed: bigint;
  /** Total missed rewards (Gwei) */
  totalMissed: bigint;
  /** Total earned rewards (Gwei) */
  totalEarned: bigint;
  /** Converted to ETH for readability */
  totalMissedEth: string;
  totalEarnedEth: string;
  /** Count of epochs analyzed */
  epochCount: number;
  /** Breakdown by miss classification */
  missCounts: {
    correct: number;
    missedEntirely: number;
    wrongSource: number;
    wrongTarget: number;
    wrongHead: number;
    lateSource: number;
    lateHead: number;
  };
}        
