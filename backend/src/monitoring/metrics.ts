import { Registry, Counter, Histogram, Gauge } from 'prom-client';
export const register = new Registry();
register.setDefaultLabels({ app: 'eth-validator-dashboard' });


/**
 * Total HTTP requests made to the local/remote Beacon node.
 */
export const beaconApiRequestsTotal = new Counter({
  name: 'beacon_api_requests_total',
  help: 'Total number of requests made to the Beacon API',
  labelNames: ['endpoint', 'status'] as const,
  registers: [register],
});

/**
 * Request duration histogram for Beacon API calls.
 * Labels:
 *   endpoint — the URL path called
 */
export const beaconApiDurationSeconds = new Histogram({
  name: 'beacon_api_duration_seconds',
  help: 'Latency of Beacon API requests in seconds',
  labelNames: ['endpoint'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

/**
 * Total HTTP requests made to beaconcha.in.
 */
export const beaconchainApiRequestsTotal = new Counter({
  name: 'beaconchain_api_requests_total',
  help: 'Total number of requests made to the beaconcha.in API',
  labelNames: ['endpoint', 'status'] as const,
  registers: [register],
});


/**
 * Cache hit and miss counter.
 */
export const cacheHitsTotal = new Counter({
  name: 'cache_hits_total',
  help: 'Total cache hits and misses',
  labelNames: ['type'] as const,
  registers: [register],
});


/**
 * Total errors encountered while fetching epoch data.
 */
export const epochFetchErrorsTotal = new Counter({
  name: 'epoch_fetch_errors_total',
  help: 'Total errors encountered during epoch data fetches',
  labelNames: ['reason'] as const,
  registers: [register],
});

/**
 * Number of missed attestations per validator, broken down by participation component.
 * Labels:
 *   validator_index — numeric validator index as string
 *   component       — 'source', 'target', or 'head'
 */
export const validatorMissedAttestations = new Gauge({
  name: 'validator_missed_attestations',
  help: 'Number of missed attestation components per validator',
  labelNames: ['validator_index', 'component'] as const,
  registers: [register],
});

/**
 * Total effective balance (in Gwei) of all active validators at a given epoch.
 */
export const activeValidatorBalanceGwei = new Gauge({
  name: 'active_validator_balance_gwei',
  help: 'Total effective balance in Gwei across all active validators',
  labelNames: ['epoch'] as const,
  registers: [register],
});
