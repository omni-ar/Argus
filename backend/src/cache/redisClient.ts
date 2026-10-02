import Redis from "ioredis";
import { logger } from "../utils/logger.js";
import { cacheHitsTotal } from "../monitoring/metrics.js";
import { REDIS_URL, CACHE_TTL_SECONDS } from "../../constants.js";

// ─── Redis Client ─────────────────────────────────────────────────────────────

let redis: Redis | null = null;

/**
 * Initializes the Redis connection.
 * Call this once at application startup.
 */
export function initRedis(): void {
  if (!REDIS_URL) {
    logger.warn("REDIS_URL not set, caching disabled");
    return;
  }

  redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      const delay = Math.min(times * 100, 3000);
      logger.warn("Redis connection retry", { attempt: times, delayMs: delay });
      return delay;
    },
    lazyConnect: false,
  });

  redis.on("connect", () => {
    logger.info("Redis connected", {
      url: REDIS_URL.replace(/\/\/.*@/, "//***@"),
    });
  });

  redis.on("error", (err) => {
    logger.error("Redis error", {
      code: "REDIS_ERROR",
      message: err.message,
    });
  });

  redis.on("close", () => {
    logger.warn("Redis connection closed");
  });
}

/**
 * Returns the Redis client instance.
 * Returns null if Redis is not configured or not connected.
 */
export function getRedis(): Redis | null {
  return redis;
}

/**
 * Checks if Redis is connected and healthy.
 */
export async function isRedisHealthy(): Promise<boolean> {
  if (!redis) return false;
  try {
    const pong = await redis.ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}

/**
 * Gracefully closes the Redis connection.
 * Call this on application shutdown.
 */
export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
    logger.info("Redis connection closed gracefully");
  }
}

// ─── Cache Operations ─────────────────────────────────────────────────────────

/**
 * Generates a cache key for epoch reward data.
 *
 * @param validatorIndex - Numeric validator index
 * @param epoch - Epoch number
 * @returns Cache key string
 */
export function epochRewardKey(validatorIndex: number, epoch: number): string {
  return `epoch_reward:${validatorIndex}:${epoch}`;
}

/**
 * Sentinel stored in Redis to represent a deliberately cached `null` value.
 *
 * Without this, `JSON.stringify(null)` produces the string `"null"`, which
 * `JSON.parse` turns back into JavaScript `null`.  `cacheGet` then returns
 * `null` — indistinguishable from a cache miss — so the cached result is
 * never used and the upstream fetch is repeated on every call.
 *
 * By storing this sentinel instead of raw `"null"` we can distinguish:
 *   - key absent in Redis          → cache miss  → cacheGet returns `undefined`
 *   - key present, value sentinel  → cached null → cacheGet returns `null`
 *   - key present, normal JSON     → cache hit   → cacheGet returns `T`
 */
const CACHE_NULL_SENTINEL = "__CACHE_NULL__";

/**
 * Gets a cached value from Redis.
 * Increments cache hit/miss metrics.
 *
 * @param key - Cache key
 * @returns
 *   - `T`         — cache hit, non-null value
 *   - `null`      — cache hit, null was explicitly stored (use `=== null` to check)
 *   - `undefined` — cache miss (key not in Redis)
 */
export async function cacheGet<T>(key: string): Promise<T | null | undefined> {
  if (!redis) return undefined;

  try {
    const value = await redis.get(key);
    if (value === null) {
      // Key does not exist in Redis — genuine cache miss
      cacheHitsTotal.inc({ type: "miss" });
      logger.debug("Cache miss", { key });
      return undefined;
    }

    cacheHitsTotal.inc({ type: "hit" });
    logger.debug("Cache hit", { key });

    if (value === CACHE_NULL_SENTINEL) {
      // Caller explicitly cached a null result (e.g. "no data for this epoch")
      return null;
    }

    return JSON.parse(value) as T;
  } catch (err) {
    const e = err as Error;
    logger.error("Cache get error", {
      code: "CACHE_GET_ERROR",
      message: e.message,
      key,
    });
    cacheHitsTotal.inc({ type: "miss" });
    return undefined;
  }
}

/**
 * Sets a value in Redis cache with TTL.
 *
 * @param key - Cache key
 * @param value - Value to cache (will be JSON stringified)
 * @param ttlSeconds - TTL in seconds (defaults to CACHE_TTL_SECONDS)
 */
export async function cacheSet<T>(
  key: string,
  value: T,
  ttlSeconds: number = CACHE_TTL_SECONDS,
): Promise<void> {
  if (!redis) return;

  try {
    // Store null values as a sentinel so cacheGet can distinguish
    // "key not present" (miss) from "key present, value is null".
    const serialized =
      value === null ? CACHE_NULL_SENTINEL : JSON.stringify(value);
    await redis.setex(key, ttlSeconds, serialized);
    logger.debug("Cache set", { key, ttlSeconds });
  } catch (err) {
    const e = err as Error;
    logger.error("Cache set error", {
      code: "CACHE_SET_ERROR",
      message: e.message,
      key,
    });
  }
}

/**
 * Deletes a key from cache.
 *
 * @param key - Cache key to delete
 */
export async function cacheDel(key: string): Promise<void> {
  if (!redis) return;

  try {
    await redis.del(key);
    logger.debug("Cache delete", { key });
  } catch (err) {
    const e = err as Error;
    logger.error("Cache delete error", {
      code: "CACHE_DEL_ERROR",
      message: e.message,
      key,
    });
  }
}

/**
 * Gets cache statistics.
 */
export async function getCacheStats(): Promise<{
  connected: boolean;
  keys: number;
  memoryUsed: string;
} | null> {
  if (!redis) return null;

  try {
    const info = await redis.info("memory");
    const dbsize = await redis.dbsize();

    const memMatch = info.match(/used_memory_human:(\S+)/);
    const memoryUsed = memMatch?.[1] ?? "unknown";

    return {
      connected: true,
      keys: dbsize,
      memoryUsed,
    };
  } catch {
    return null;
  }
}
