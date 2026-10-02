import "dotenv/config";

export const BEACON_URL = process.env.BEACON_URL ?? "https://ethereum-beacon-api.publicnode.com";
export const BEACONCHAIN_API = process.env.BEACONCHAIN_API ?? "https://beaconcha.in/api/v1";
export const BEACONCHAIN_API_V2 = process.env.BEACONCHAIN_API_V2 ?? "https://beaconcha.in/api/v2";
export const BEACONCHAIN_API_KEY = process.env.BEACONCHAIN_API_KEY ?? "";
export const PORT = Number(process.env.PORT) || 3000;
export const DATA_MODE = process.env.DATA_MODE === "snapshot" ? "snapshot" : "live";

/**
 * Minimum gap between consecutive outgoing beaconcha.in requests (ms).
 * Default: 500 ms → ≤2 req/s sustained, well below the free-tier limit.
 * Override via MIN_REQUEST_GAP_MS env var.
 */
// beaconcha.in's entry tier permits one request per second. Keep the default
// within that limit; deployments with a higher plan can override it explicitly.
export const MIN_REQUEST_GAP_MS = Number(process.env.MIN_REQUEST_GAP_MS) || 1_000;

/**
 * Suggested page size when callers paginate over large epoch ranges.
 * There is no hard server-side cap; this is a documentation hint only.
 * Override via EPOCHS_PAGE_SIZE env var.
 */
export const EPOCHS_PAGE_SIZE = Number(process.env.EPOCHS_PAGE_SIZE) || 50;

/** Redis connection URL. If not set, caching falls back to in-memory. */
export const REDIS_URL = process.env.REDIS_URL ?? "";

/** Cache TTL in seconds for epoch reward data (default: 1 hour). Finalized epoch data is immutable. */
export const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS) || 3600;

/**
 * Cache TTL in seconds for validator info (pubkey ↔ index mapping).
 * Default: 1 hour.  Validator metadata is effectively immutable once the
 * validator is active; a short TTL is fine to catch status changes.
 */
export const VALIDATOR_INFO_CACHE_TTL_SECONDS =
  Number(process.env.VALIDATOR_INFO_CACHE_TTL_SECONDS) || 3600;

export const STATUS_MISSED = 0;
export const STATUS_INCLUDED = 1;
export const STATUS_INCLUDED_LATE = 2;

/**
 * The 10 tracked validator pubkeys.
 * Override via VALIDATOR_PUBKEYS env var as a comma-separated list.
 */
export const VALIDATOR_PUBKEYS: string[] = process.env.VALIDATOR_PUBKEYS
  ? process.env.VALIDATOR_PUBKEYS.split(',').map(s => s.trim()).filter(Boolean)
  : [
      '0x89ca023fc6975d72384afff7bbfbdc9964732a1ea5b47613101ce8ff4e1da142cdb582778ed7592cb05daedf4ba580fa',
      '0xaf6609c70683b0e98a784fd5a25414f9db991e7faea7cffc71a50d4be5f1be6ade20cd22cf06f26c8d7359d127d7bfdb',
      '0x8d357d1573fedd1ebb4ab2446197c3230778a42590cbf9a57ffb6404c8014a9f9ad03cff5ff62008979ca74c142aee76',
      '0xb936fc731b42c6ff9b4247baa829a7f4bc62ec8d3f02c2702a8a6e12f5caba9a5538d2061e1ba1584f418b86e1d41891',
      '0xa72e6d79ba3ec8b808384c56bdef7ae6af3c2033e09daba28b793ea404df8d025668101416da1de3eae01b8f50ce74db',
      '0xb123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      '0xb223456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      '0xb323456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      '0xb423456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      '0xb523456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ];
