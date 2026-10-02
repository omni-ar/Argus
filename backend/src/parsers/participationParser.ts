import { logger } from '../utils/logger.js';
import type { ValidatorReward } from '../clients/beaconchainClient.js';


export type ParsedAttestation = {
  epoch: number;
  validatorIndex: number;
  included: boolean;
  inclusionDelay: number | null;
  sourceCorrect: boolean;
  targetCorrect: boolean;
  headCorrect: boolean;
  missType: 'missed' | 'wrong_source' | 'wrong_target' | 'wrong_head' | 'correct';
  rewards: { source: bigint; target: bigint; head: bigint; total: bigint };
  missed: { source: bigint; target: bigint; head: bigint; total: bigint };
  rawFields: Record<string, unknown>;
};


export function parseValidatorReward(
  reward: ValidatorReward,
  epoch: number
): ParsedAttestation {
  logger.debug('Parsing v2 validator reward', { epoch, validatorIndex: reward.validator.index });

  const rawFields: Record<string, unknown> = { ...reward };
  const att = reward.attestation;
  const validatorIndex = reward.validator.index;

  const sourceMissed = parseBigIntField(att.source.missed_reward, 'source.missed_reward', epoch);
  const targetMissed = parseBigIntField(att.target.missed_reward, 'target.missed_reward', epoch);
  const headMissed   = parseBigIntField(att.head.missed_reward,   'head.missed_reward',   epoch);
  const totalMissed  = parseBigIntField(reward.total_missed,      'total_missed',          epoch);
  const sourceReward = parseBigIntField(att.source.reward,        'source.reward',         epoch);
  const targetReward = parseBigIntField(att.target.reward,        'target.reward',         epoch);
  const headReward   = parseBigIntField(att.head.reward,          'head.reward',           epoch);
  // Use total_reward (top-level) as the canonical total earned — att.total is the
  // attestation sub-total and may omit sync/proposal rewards or carry sign chars.
  const totalReward  = parseBigIntField(reward.total_reward,      'total_reward',          epoch);

  const sourceCorrect = sourceMissed === 0n;
  const targetCorrect = targetMissed === 0n;
  const headCorrect   = headMissed   === 0n;

  const included = totalReward > 0n || totalMissed === 0n;

  const inclusionDelay = included
    ? (typeof att.inclusion_delay === 'number' ? att.inclusion_delay : null)
    : null;

  const missType: ParsedAttestation['missType'] =
    !included        ? 'missed'
    : !sourceCorrect ? 'wrong_source'
    : !targetCorrect ? 'wrong_target'
    : !headCorrect   ? 'wrong_head'
    : 'correct';

  return {
    epoch,
    validatorIndex,
    included,
    inclusionDelay,
    sourceCorrect,
    targetCorrect,
    headCorrect,
    missType,
    rewards: { source: sourceReward, target: targetReward, head: headReward, total: totalReward },
    missed:  { source: sourceMissed, target: targetMissed, head: headMissed, total: totalMissed },
    rawFields,
  };
}


/**
 * Safely parses a Gwei decimal string to BigInt.
 * Logs a warning and returns 0n if the field is missing or non-numeric.
 */
function parseBigIntField(value: unknown, fieldName: string, epoch: number): bigint {
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  logger.warn(`parseValidatorReward: field "${fieldName}" is not a numeric string, defaulting to 0`, {
    epoch, fieldName, value,
  });
  return 0n;
}
