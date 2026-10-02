import axios, { AxiosError } from "axios";
import { logger } from "../utils/logger.js";
import { beaconchainApiRequestsTotal } from "../monitoring/metrics.js";
import { cacheGet, cacheSet, epochRewardKey } from "../cache/redisClient.js";
import {
  BEACONCHAIN_API,
  BEACONCHAIN_API_V2,
  BEACONCHAIN_API_KEY,
  MIN_REQUEST_GAP_MS,
  VALIDATOR_INFO_CACHE_TTL_SECONDS,
} from "../../constants.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BeaconchainError {
  code: string;
  message: string;
  epoch?: number;
}

export interface BeaconchainValidatorInfo {
  pubkey: string;
  validatorindex: number;
  balance: number;
  status: string;
  activationepoch: number;
  exitepoch: number;
  slashed: boolean;
  lastattestationslot: number;
  [key: string]: unknown;
}

export interface BeaconchainAttestation {
  attesterslot: number;
  committeeindex: number;
  epoch: number;
  inclusionslot: number | null;
  status: number; // 0 = missed, 1 = included, 2 = included late
  week: number;
  week_start: string;
  week_end: string;
  [key: string]: unknown;
}

/** Per-component reward/penalty breakdown from v2 rewards API. */
export interface RewardComponent {
  total: string;
  reward: string;
  penalty: string;
  missed_reward: string;
}

/** Full attestation reward breakdown from v2 rewards API. */
export interface AttestationReward {
  total: string;
  head: RewardComponent;
  source: RewardComponent;
  target: RewardComponent;
  inactivity_leak_penalty: string;
  inclusion_delay: number | null;
}

/** Full validator reward record returned by the v2 rewards-list endpoint. */
export interface ValidatorReward {
  validator: { index: number; public_key: string };
  total_reward: string;
  total_penalty: string;
  total_missed: string;
  attestation: AttestationReward;
  sync_committee: RewardComponent;
  proposal: {
    total: string;
    execution_layer_reward: string;
    attestation_inclusion_reward: string;
    sync_inclusion_reward: string;
    slashing_inclusion_reward: string;
    missed_cl_reward: string;
    missed_el_reward: string;
  };
  finality: string;
  [key: string]: unknown;
}

interface RewardsListResponse {
  data: ValidatorReward[];
  paging: Record<string, unknown>;
  range: {
    slot: { start: number; end: number };
    epoch: { start: number; end: number };
    timestamp: { start: number; end: number };
  };
}

interface BeaconchainAttestationsResponse {
  status: string;
  data: BeaconchainAttestation[];
}

interface BeaconchainValidatorResponse {
  status: string;
  data: BeaconchainValidatorInfo;
}

// ─── Rate-limit queue ─────────────────────────────────────────────────────────

let requestQueue: Promise<void> = Promise.resolve();

function normalizeBeaconPath(path: string): string {
  return path
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      ":id",
    )
    .replace(/\b\d+\b/g, ":id");
}

/**
 * Serializes all requests through a promise chain with a minimum gap.
 * Prevents bursting against beaconcha.in rate limits.
 *
 * Each call atomically appends a `sleep(MIN_REQUEST_GAP_MS)` slot to the
 * shared queue and returns that slot's promise.  The caller `await`s this
 * promise before firing the HTTP request, guaranteeing at least
 * MIN_REQUEST_GAP_MS between any two consecutive outgoing requests.
 */
function throttle(): Promise<void> {
  const slot = requestQueue.then(() => sleep(MIN_REQUEST_GAP_MS));
  requestQueue = slot;
  return slot;
}

/**
 * Extends the shared throttle queue by an additional delay without consuming
 * a new "slot".  Called after receiving a 429 so that every other request
 * waiting in the queue will also pause for the back-off period before firing.
 *
 * This prevents the thundering-herd problem where multiple queued requests
 * all fire immediately after a 429 back-off completes.
 */
function extendQueueBackoff(ms: number): void {
  requestQueue = requestQueue.then(() => sleep(ms));
}

// ─── Shared retry logic ───────────────────────────────────────────────────────

const MAX_RETRIES = 3;

/**
 * Classifies an AxiosError into a BeaconchainError code.
 */
function classifyAxiosError(axiosErr: AxiosError): string {
  const status = axiosErr.response?.status;
  const isNetworkError =
    !axiosErr.response &&
    (axiosErr.code === "ECONNREFUSED" ||
      axiosErr.code === "ETIMEDOUT" ||
      axiosErr.code === "ENOTFOUND" ||
      axiosErr.code === "ECONNRESET" ||
      axiosErr.code === "ECONNABORTED");
  if (isNetworkError) return "BEACONCHAIN_UNAVAILABLE";
  if (status) return `BEACONCHAIN_HTTP_${status}`;
  return "BEACONCHAIN_UNKNOWN";
}

/**
 * Internal GET wrapper for beaconcha.in v1 API calls.
 *
 * - Enforces MIN_REQUEST_GAP_MS rate limit via `throttle()` (once, before the
 *   first attempt — retries do NOT re-throttle to avoid inflating the queue).
 * - On 429/5xx: extends the shared queue by the back-off duration so that all
 *   queued requests also pause, then waits locally before retrying.
 * - Retries up to MAX_RETRIES times with exponential backoff + jitter.
 * - Throws `{ code, message, epoch? }` on exhausted retries or 4xx (non-429).
 * - Increments `beaconchain_api_requests_total` on every outcome.
 */
async function beaconchainGet(path: string, epoch?: number): Promise<unknown> {
  if (!BEACONCHAIN_API) {
    throw {
      code: "CONFIG_MISSING",
      message: "BEACONCHAIN_API is not set in environment",
    } satisfies BeaconchainError;
  }

  const url = `${BEACONCHAIN_API}${path}`;
  const normalizedPath = normalizeBeaconPath(path);
  let lastCode = "BEACONCHAIN_UNKNOWN";
  let lastMessage = "unknown error";

  // Throttle once before the first attempt.  Retries share the same queue
  // slot via extendQueueBackoff so we don't re-queue on every retry.
  await throttle();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: 30_000,
        headers: {
          ...(BEACONCHAIN_API_KEY && {
            // V1 uses an `apikey` header; Bearer authentication is V2-only.
            apikey: BEACONCHAIN_API_KEY,
          }),
        },
      });

      beaconchainApiRequestsTotal.inc({
        endpoint: normalizedPath,
        status: "200",
      });
      logger.debug("beaconcha.in GET raw response", {
        path,
        shape: typeof response.data,
      });
      return response.data;
    } catch (err) {
      const axiosErr = err as AxiosError;
      const status = axiosErr.response?.status;
      const code = classifyAxiosError(axiosErr);
      lastCode = code;
      lastMessage = axiosErr.message;

      const statusLabel =
        status === 429 ? "429" : status && status >= 500 ? "5xx" : "error";
      beaconchainApiRequestsTotal.inc({
        endpoint: normalizedPath,
        status: statusLabel,
      });

      if (isRetryable(code) && attempt < MAX_RETRIES) {
        const baseMs = Math.min(1_000 * 2 ** attempt, 30_000);
        const jitter = Math.floor(Math.random() * baseMs * 0.2); // ±20 % jitter
        const backoffMs = baseMs + jitter;
        logger.warn("beaconcha.in GET retryable error, backing off", {
          path,
          attempt,
          code,
          backoffMs,
          ...(epoch !== undefined && { epoch }),
        });
        // Pause the shared queue so subsequent queued requests also wait.
        extendQueueBackoff(backoffMs);
        await sleep(backoffMs);
        continue;
      }

      // Non-retryable or retries exhausted
      logger.error("beaconcha.in GET request failed", {
        code,
        message: axiosErr.message,
        path,
        ...(epoch !== undefined && { epoch }),
      });
      throw {
        code,
        message: axiosErr.message,
        ...(epoch !== undefined && { epoch }),
      } satisfies BeaconchainError;
    }
  }

  // Retries exhausted
  logger.error("beaconcha.in GET max retries exhausted", {
    code: lastCode,
    message: lastMessage,
    path,
    ...(epoch !== undefined && { epoch }),
  });
  throw {
    code: lastCode,
    message: lastMessage,
    ...(epoch !== undefined && { epoch }),
  } satisfies BeaconchainError;
}

// ─── POST wrapper ─────────────────────────────────────────────────────────────

/**
 * Internal POST wrapper for beaconcha.in v2 API calls.
 *
 * - Requires Bearer API key in Authorization header.
 * - Throttles once before the first attempt (same queue as GET).
 * - On 429/5xx: extends the shared queue by the back-off duration.
 * - Retries up to MAX_RETRIES times with exponential backoff + jitter.
 * - Throws `{ code, message, epoch? }` on exhausted retries or 4xx (non-429).
 */
async function beaconchainPost(
  path: string,
  body: unknown,
  epoch?: number,
): Promise<unknown> {
  if (!BEACONCHAIN_API_V2) {
    throw {
      code: "CONFIG_MISSING",
      message: "BEACONCHAIN_API_V2 is not set in environment",
    } satisfies BeaconchainError;
  }
  if (!BEACONCHAIN_API_KEY) {
    throw {
      code: "CONFIG_MISSING",
      message: "BEACONCHAIN_API_KEY is not set in environment",
    } satisfies BeaconchainError;
  }

  const url = `${BEACONCHAIN_API_V2}${path}`;
  const normalizedPath = normalizeBeaconPath(path);
  let lastCode = "BEACONCHAIN_UNKNOWN";
  let lastMessage = "unknown error";

  // Throttle once before the first attempt.
  await throttle();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(url, body, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BEACONCHAIN_API_KEY}`,
        },
        timeout: 30_000,
      });

      beaconchainApiRequestsTotal.inc({
        endpoint: normalizedPath,
        status: "200",
      });
      logger.debug("beaconcha.in POST raw response", {
        path,
        shape: typeof response.data,
      });
      return response.data;
    } catch (err) {
      const axiosErr = err as AxiosError;
      const status = axiosErr.response?.status;
      const code = classifyAxiosError(axiosErr);
      lastCode = code;
      lastMessage = axiosErr.message;

      const statusLabel =
        status === 429 ? "429" : status && status >= 500 ? "5xx" : "error";
      beaconchainApiRequestsTotal.inc({
        endpoint: normalizedPath,
        status: statusLabel,
      });

      if (isRetryable(code) && attempt < MAX_RETRIES) {
        const baseMs = Math.min(1_000 * 2 ** attempt, 30_000);
        const jitter = Math.floor(Math.random() * baseMs * 0.2); // ±20 % jitter
        const backoffMs = baseMs + jitter;
        logger.warn("beaconcha.in POST retryable error, backing off", {
          path,
          attempt,
          code,
          backoffMs,
          ...(epoch !== undefined && { epoch }),
        });
        // Pause the shared queue so subsequent queued requests also wait.
        extendQueueBackoff(backoffMs);
        await sleep(backoffMs);
        continue;
      }

      logger.error("beaconcha.in POST request failed", {
        code,
        message: axiosErr.message,
        path,
        ...(epoch !== undefined && { epoch }),
      });
      throw {
        code,
        message: axiosErr.message,
        ...(epoch !== undefined && { epoch }),
      } satisfies BeaconchainError;
    }
  }

  logger.error("beaconcha.in POST max retries exhausted", {
    code: lastCode,
    message: lastMessage,
    path,
    ...(epoch !== undefined && { epoch }),
  });
  throw {
    code: lastCode,
    message: lastMessage,
    ...(epoch !== undefined && { epoch }),
  } satisfies BeaconchainError;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetches validator metadata from beaconcha.in by numeric index or pubkey (0x-prefixed hex).
 *
 * Results are cached in Redis for VALIDATOR_INFO_CACHE_TTL_SECONDS (default: 1 hour)
 * to prevent redundant lookups — especially during batch requests where the same
 * validator identifier is resolved multiple times.
 *
 * Endpoint: GET /validator/{index_or_pubkey}
 */
export async function getValidatorInfo(
  validatorIdentifier: number | string,
): Promise<BeaconchainValidatorInfo> {
  const cacheKey = `validator_info:${validatorIdentifier}`;

  const cached = await cacheGet<BeaconchainValidatorInfo>(cacheKey);
  if (cached !== undefined) {
    logger.debug("beaconcha.in validator info cache hit", {
      identifier: validatorIdentifier,
    });
    return cached!;
  }

  const path = `/validator/${validatorIdentifier}`;
  const raw = (await beaconchainGet(path)) as BeaconchainValidatorResponse;

  logger.info("beaconcha.in validator info fetched", {
    index: raw.data.validatorindex,
    pubkey: raw.data.pubkey,
    status: raw.data.status,
  });

  await cacheSet(cacheKey, raw.data, VALIDATOR_INFO_CACHE_TTL_SECONDS);
  return raw.data;
}

/**
 * Fetches attestation records for a validator and filters to the requested epoch.
 *
 * Endpoint: GET /validator/{index}/attestations
 *
 * beaconcha.in returns the last ~100 attestations across all epochs.
 * We filter client-side to the requested epoch.
 */
export async function getValidatorAttestations(
  validatorIndex: number,
  epoch: number,
): Promise<BeaconchainAttestation[]> {
  const path = `/validator/${validatorIndex}/attestations`;
  const raw = (await beaconchainGet(
    path,
    epoch,
  )) as BeaconchainAttestationsResponse;

  const filtered = raw.data.filter((a) => a.epoch === epoch);

  logger.debug("beaconcha.in attestations filtered", {
    validatorIndex,
    epoch,
    totalReturned: raw.data.length,
    matchingEpoch: filtered.length,
  });

  return filtered;
}

/**
 * Fetches per-epoch reward breakdown for a validator using the v2 rewards-list API.
 * Results are cached in Redis for 1 hour (finalized epochs are immutable).
 *
 * Endpoint: POST /api/v2/ethereum/validators/rewards-list
 *
 * Cache key: `epoch_reward:${validatorIndex}:${epoch}`
 *
 * @param validatorIndex - Numeric validator index.
 * @param epoch          - Epoch to fetch rewards for.
 * @returns Full reward record, or null if no data returned for that epoch.
 * @throws `{ code, message, epoch }` on HTTP or network failure after retries.
 */
export async function getValidatorEpochRewards(
  validatorIndex: number,
  epoch: number,
): Promise<ValidatorReward | null> {
  const key = epochRewardKey(validatorIndex, epoch);

  // Check Redis cache first
  // cacheGet returns:
  //   undefined  → key not in Redis (cache miss)
  //   null       → explicitly cached null (no data for this epoch)
  //   ValidatorReward → cached result
  const cached = await cacheGet<ValidatorReward | null>(key);
  if (cached !== undefined) {
    logger.debug("beaconcha.in epoch rewards cache hit", {
      validatorIndex,
      epoch,
      hasData: cached !== null,
    });
    return cached;
  }

  const path = "/ethereum/validators/rewards-list";
  const body = {
    validator: { validator_identifiers: [validatorIndex] },
    chain: "mainnet",
    page_size: 1,
    epoch,
  };

  const raw = (await beaconchainPost(path, body, epoch)) as RewardsListResponse;

  if (!raw.data || raw.data.length === 0) {
    logger.warn("beaconcha.in rewards-list returned no data", {
      validatorIndex,
      epoch,
    });
    // Cache null result to avoid repeated lookups for missing epochs
    await cacheSet(key, null);
    return null;
  }

  const reward = raw.data[0];
  if (!reward) {
    logger.warn("beaconcha.in rewards-list returned empty first record", {
      validatorIndex,
      epoch,
    });
    await cacheSet(key, null);
    return null;
  }

  logger.info("beaconcha.in epoch rewards fetched", {
    validatorIndex,
    epoch,
    finality: reward.finality,
    totalReward: reward.total_reward,
    totalMissed: reward.total_missed,
    headMissed: reward.attestation.head.missed_reward,
    sourceMissed: reward.attestation.source.missed_reward,
    targetMissed: reward.attestation.target.missed_reward,
    inclusionDelay: reward.attestation.inclusion_delay,
  });

  // Cache the result
  await cacheSet(key, reward);
  return reward;
}

/**
 * Normalised validator info shape — compatible with both beaconClient and beaconchainClient callers.
 * `effective_balance` is expressed in Gwei as a string (32 ETH = "32000000000").
 */
export interface NormalisedValidatorInfo {
  index: string;
  validator: {
    pubkey: string;
    effective_balance: string;
  };
}

/**
 * Resolves a validator by index or pubkey via beaconcha.in and returns a normalised shape
 * that matches the Beacon node `/eth/v1/beacon/states/head/validators/{id}` response.
 *
 * Use this instead of the Beacon node validator lookup, which is not reliably available
 * on public RPC endpoints.
 *
 * Throws `{ code: "BEACON_HTTP_404", message }` when not found (same code as beaconClient)
 * so callers can handle it uniformly.
 *
 * @param identifier - Numeric validator index or 0x-prefixed pubkey string
 */
export async function resolveValidatorInfo(
  identifier: number | string,
): Promise<NormalisedValidatorInfo> {
  const raw = await getValidatorInfo(identifier);

  // beaconcha.in does not expose effective_balance directly —
  // ETH validators are capped at 32 ETH = 32_000_000_000 Gwei.
  // For the Altair base_reward formula this is the correct value for
  // any active validator that has not been penalised below the cap.
  const effective_balance = String(Math.min(raw.balance, 32_000_000_000));

  return {
    index: String(raw.validatorindex),
    validator: {
      pubkey: raw.pubkey,
      effective_balance,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(code: string): boolean {
  if (code === "BEACONCHAIN_HTTP_429" || code === "BEACONCHAIN_UNAVAILABLE") {
    return true;
  }
  const match = code.match(/BEACONCHAIN_HTTP_(\d+)/);
  if (match) {
    const status = Number(match[1]);
    return status >= 500;
  }
  return false;
}
