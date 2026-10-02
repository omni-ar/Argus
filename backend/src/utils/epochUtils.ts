import "dotenv/config";
import { logger } from "./logger.js";
import { getFinalizedEpoch } from "../clients/beaconClient.js";

const GENESIS_TIME_SECONDS = 1_606_824_023;

const SECONDS_PER_SLOT = 12;

const SLOTS_PER_EPOCH = 32;

const SECONDS_PER_EPOCH = SECONDS_PER_SLOT * SLOTS_PER_EPOCH;

/**
 * In-process cache for the finalized epoch.
 * Invalidated after FINALIZED_EPOCH_CACHE_TTL_MS milliseconds so the server
 * always tracks the chain within ~1 minute without hammering the beacon node.
 */
const FINALIZED_EPOCH_CACHE_TTL_MS = 60_000; // 1 minute

let _cachedFinalizedEpoch: number | null = null;
let _cachedFinalizedEpochAt = 0;

/**
 * Returns the finalized epoch fetched from the beacon node, with a 60-second
 * in-process cache so routes don't hammer the node on every request.
 *
 * Falls back to the wall-clock estimate (`getCurrentEpoch()`) if the beacon
 * node is unreachable.
 *
 * @returns Finalized epoch as a non-negative integer.
 */
export async function getFinalizedEpochCached(): Promise<number> {
  const now = Date.now();
  if (
    _cachedFinalizedEpoch !== null &&
    now - _cachedFinalizedEpochAt < FINALIZED_EPOCH_CACHE_TTL_MS
  ) {
    return _cachedFinalizedEpoch;
  }

  const fromNode = await getFinalizedEpoch();

  if (fromNode !== null) {
    _cachedFinalizedEpoch = fromNode;
    _cachedFinalizedEpochAt = now;
    return fromNode;
  }

  // Beacon node unreachable — fall back to wall-clock estimate
  const wallClock = getCurrentEpoch();
  logger.warn(
    "Beacon node did not return finalized epoch; falling back to wall-clock estimate",
    { wallClockEpoch: wallClock },
  );
  return wallClock;
}

/**
 * Returns the latest safely queryable finalized epoch on Ethereum mainnet
 * using wall-clock math only.
 *
 * The wall-clock estimate subtracts 5 epochs to avoid querying epochs that
 * are not yet finalized.  Prefer `getFinalizedEpochCached()` for production
 * use; this function is kept as a fallback / utility.
 *
 * @returns Estimated finalized epoch as a non-negative integer.
 */
export function getCurrentEpoch(): number {
  const nowSeconds = Date.now() / 1_000;
  const headEpoch = Math.floor(
    (nowSeconds - GENESIS_TIME_SECONDS) / SECONDS_PER_EPOCH,
  );
  return Math.max(0, headEpoch - 5);
}

/**
 * Returns the first slot number of a given epoch.
 *
 * @param epoch - The epoch number.
 * @returns The first slot in that epoch (epoch × 32).
 */
export function epochToSlot(epoch: number): number {
  return epoch * SLOTS_PER_EPOCH;
}

/**
 * Returns the last slot number of a given epoch (inclusive).
 * Useful when scanning all attestations within an epoch.
 *
 * @param epoch - The epoch number.
 * @returns The last slot in that epoch (epochToSlot(epoch + 1) - 1).
 */
export function epochEndSlot(epoch: number): number {
  return epochToSlot(epoch + 1) - 1;
}

/**
 * Returns the epoch that contains the given slot number.
 *
 * @param slot - A beacon chain slot number.
 * @returns The epoch that slot belongs to.
 */
export function slotToEpoch(slot: number): number {
  return Math.floor(slot / SLOTS_PER_EPOCH);
}

/**
 * Returns the inclusive epoch range covering the last `days` of chain history.
 *
 * `toEpoch` is taken from `finalizedEpoch` when provided (preferred — fetched
 * from the beacon node).  If omitted, falls back to `getCurrentEpoch()`.
 *
 * @param days - Number of calendar days to look back (e.g. 7).
 * @param finalizedEpoch - The known finalized epoch (from beacon node). Optional.
 * @returns `{ fromEpoch, toEpoch }` where toEpoch is the finalized epoch.
 */
export function getEpochRange(
  days: number,
  finalizedEpoch?: number,
): {
  fromEpoch: number;
  toEpoch: number;
} {
  const toEpoch = finalizedEpoch ?? getCurrentEpoch();
  const epochsPerDay = (24 * 60 * 60) / SECONDS_PER_EPOCH; // 225
  const fromEpoch = Math.max(0, toEpoch - Math.floor(epochsPerDay * days));
  return { fromEpoch, toEpoch };
}
