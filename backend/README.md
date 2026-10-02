# Ethereum Validator Performance Dashboard — Backend

REST API for tracking Ethereum validator attestation performance. Rewards are computed **directly from beacon node data** using the Altair spec — no third-party reward indexer is involved.

## Stack

- **Runtime**: Node.js 20+, TypeScript (ES modules, strict mode)
- **Framework**: Express 5
- **Data sources**: Ethereum Beacon node (primary), beaconcha.in (pubkey ↔ index resolution only)
- **Caching**: Redis (`ioredis`); falls back to no-op if `REDIS_URL` is unset
- **Metrics**: Prometheus (`prom-client`) + Grafana
- **Package manager**: pnpm

## Quick start

```bash
cp .env.example .env   # fill in BEACONCHAIN_API_KEY and BEACON_URL
pnpm install
pnpm dev               # ts-node, hot reload
pnpm build && pnpm start  # compiled
pnpm pipeline          # run end-to-end integration test script
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `BEACON_URL` | `https://ethereum-beacon-api.publicnode.com` | Ethereum Beacon node REST API URL |
| `BEACONCHAIN_API` | `https://beaconcha.in/api/v1` | beaconcha.in v1 base URL (pubkey resolution only) |
| `BEACONCHAIN_API_V2` | `https://beaconcha.in/api/v2` | beaconcha.in v2 base URL (pubkey resolution only) |
| `BEACONCHAIN_API_KEY` | — | beaconcha.in API key (required for pubkey resolution) |
| `PORT` | `3000` | HTTP server port |
| `MIN_REQUEST_GAP_MS` | `1000` | Minimum ms between beaconcha.in requests |
| `EPOCHS_PAGE_SIZE` | `50` | Suggested pagination page size (no hard server cap) |
| `REDIS_URL` | — | Redis connection URL. If unset, caching is disabled. |
| `CACHE_TTL_SECONDS` | `3600` | TTL for cached epoch results (1 hour default) |
| `VALIDATOR_PUBKEYS` | *(5 hardcoded pubkeys)* | Comma-separated tracked validator pubkeys |
| `LOG_LEVEL` | `info` | Winston log level (`debug`/`info`/`warn`/`error`) |

## API contract

Base URL: `http://localhost:{PORT}`

All responses are JSON. BigInt Gwei values are serialised as decimal strings.

---

### `GET /health`

Liveness check.

**Response 200**
```json
{ "status": "ok", "timestamp": "2026-03-10T09:00:00.000Z" }
```

---

### `GET /metrics`

Prometheus text exposition format. Scraped by Prometheus every 15s.

---

### `GET /api/validators/tracked`

Returns the list of tracked validator pubkeys configured via `VALIDATOR_PUBKEYS`.

**Response 200**
```json
{ "pubkeys": ["0x89ca...", "0xaf66...", "..."] }
```

---

### `GET /api/validators/:index/performance`

Attestation performance for a single validator over a selectable epoch window.

**Path params**
- `index` — numeric validator index

**Query params** (choose one mode):

| Param | Type | Description |
|---|---|---|
| `days` | integer 1–90 | Calendar days to look back (default: `7`) |
| `fromEpoch` | integer ≥ 0 | Start epoch (inclusive); overrides `days` |
| `toEpoch` | integer ≥ 0 | End epoch (inclusive); defaults to current finalized epoch |

There is **no per-request epoch cap**. The finalized epoch is fetched from the beacon node
(`GET /eth/v1/beacon/states/head/finality_checkpoints`), not derived from wall-clock math.
For very large ranges (> 100 epochs), callers should paginate using `fromEpoch`/`toEpoch`.

**Response 200**
```json
{
  "validatorIndex": 1344884,
  "pubkey": "0x89ca...",
  "fromEpoch": 433079,
  "toEpoch": 433098,
  "dataSource": "beacon_node",
  "epochs": [
    {
      "epoch": 433098,
      "included": true,
      "inclusionDelay": 1,
      "sourceCorrect": true,
      "targetCorrect": true,
      "headCorrect": true,
      "missType": "correct",
      "rewards": { "source": "2954", "target": "5908", "head": "2954", "total": "11816" },
      "missed":  { "source": "0", "target": "0", "head": "0", "total": "0" },
      "baseReward": "2954",
      "dataSource": "beacon_node"
    }
  ],
  "missingEpochs": [
    { "epoch": 433085, "reason": "compute_error", "code": "BEACON_HTTP_503" }
  ],
  "summary": {
    "epochsChecked": 19,
    "correct": 18,
    "wrongHead": 1,
    "wrongTarget": 0,
    "wrongSource": 0,
    "missed": 0,
    "lateSource": 0,
    "lateHead": 0,
    "avgInclusionDelay": 1.05,
    "totalEarnedGwei": "224504",
    "totalMissedGwei": "2954",
    "totalMissedEth": "0.000002954"
  }
}
```

**`missingEpochs`** contains every epoch that was attempted but failed to compute — the frontend should display these as explicit gaps, not silently omit them.

**`missType`** values: `correct` | `wrong_head` | `wrong_target` | `wrong_source` | `missed_entirely` | `late_source` | `late_head`

**Error responses**

| Status | Condition |
|---|---|
| 400 | Invalid index or epoch params |
| 404 | Validator not found on beaconcha.in |
| 503 | beaconcha.in unreachable |
| 500 | Internal server error |

---

### `POST /api/validators/batch/performance`

Attestation performance for multiple validators in a single request.

**Request body (JSON)**
```json
{
  "validators": [1344884, 1344886, "0x8d35..."],
  "days": 7
}
```

Or with an explicit epoch range:
```json
{
  "fromEpoch": 432000,
  "toEpoch": 432019
}
```

| Field | Type | Description |
|---|---|---|
| `validators` | `(number \| string)[]` | Validator indices or pubkeys. Omit to use tracked VALIDATOR_PUBKEYS. Max 50. |
| `days` | integer 1–90 | Calendar days lookback (default: 7) |
| `fromEpoch` | integer | Start epoch; overrides `days` |
| `toEpoch` | integer | End epoch; defaults to current finalized |

**Response 200**
```json
{
  "fromEpoch": 433079,
  "toEpoch": 433098,
  "results": [
    {
      "validatorIndex": 1344884,
      "pubkey": "0x89ca...",
      "fromEpoch": 433079,
      "toEpoch": 433098,
      "epochs": [...],
      "missingEpochs": [],
      "summary": { ... },
      "dataSource": "beacon_node"
    },
    {
      "validatorIndex": -1,
      "pubkey": "0xdead...",
      "error": "Validator 0xdead... not found",
      "epochs": [],
      "missingEpochs": [],
      "summary": { "epochsChecked": 0, ... }
    }
  ]
}
```

Validators that fail lookup carry an `error` string. The rest of the batch still succeeds.

---

## Reward computation

All rewards are computed **on-chain** from the Altair specification. The pipeline for each `(validator, epoch)` pair:

1. **Total active balance** — fetched from `GET /eth/v1/beacon/states/{slot}/validators?status=active_ongoing` at the epoch boundary slot. Never hardcoded.
2. **Effective balance** — fetched from `GET /eth/v1/beacon/states/{slot}/validators/{index}` at the attestation epoch. Never hardcoded.
3. **Base reward** — `increments × (EFFECTIVE_BALANCE_INCREMENT × BASE_REWARD_FACTOR // √total_active_balance)` per [Altair spec §get_base_reward](https://github.com/ethereum/consensus-specs/blob/dev/specs/altair/beacon-chain.md#get_base_reward).
4. **Committee assignment** — fetched from `GET /eth/v1/beacon/states/{slot}/committees`.
5. **Attestation inclusion** — blocks `[att_slot+1 … att_slot+32]` are scanned for attestations matching `data.slot`, `data.index`, and the validator's `aggregation_bits` position (SSZ little-endian bitlist).
6. **Participation flags** — `TIMELY_SOURCE` (delay ≤ 5), `TIMELY_TARGET` (delay ≤ 32, correct epoch boundary), `TIMELY_HEAD` (delay = 1, correct head root).
7. **Rewards** — `(base_reward × flag_weight × participating_increments) / (64 × total_increments)` per component.

beaconcha.in is used **only** for pubkey ↔ index resolution.

---

## Caching strategy

**What is cached**: Fully computed on-chain `ComputedEpochResult` objects per `(validator, epoch)` pair.

**Cache backend**: Redis via `ioredis`. If `REDIS_URL` is not set the `cacheGet`/`cacheSet` helpers are no-ops and every request hits the beacon node.

**Cache key**: `computed_epoch:{validatorIndex}:{epoch}` and `active_balance:{epoch}`.

**TTL**: `CACHE_TTL_SECONDS` (default 3600 s = 1 hour). Finalized epoch data is immutable on-chain; the TTL exists only to bound memory usage.

**Cache scope**: Shared across all replicas that point at the same Redis instance. On Redis restart or key expiry, the next request recomputes from the beacon node.

---

## Retry strategy

**beaconcha.in client** (`src/clients/beaconchainClient.ts`):
- Retries on HTTP 429 and 5xx with exponential backoff: `min(1000 × 2^attempt, 30000)` ms
- Max 3 retries (4 total attempts)
- All requests serialised through a queue with `MIN_REQUEST_GAP_MS` gap

**Beacon node client** (`src/clients/beaconClient.ts`):
- Same exponential backoff, max 3 retries
- 404 on block slots treated as missed slots (not an error)

---

## Prometheus metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `beacon_api_requests_total` | counter | `endpoint`, `status` | Requests to Beacon node |
| `beacon_api_duration_seconds` | histogram | `endpoint` | Beacon node request latency |
| `beaconchain_api_requests_total` | counter | `endpoint`, `status` | Requests to beaconcha.in |
| `cache_hits_total` | counter | `type` (`hit`/`miss`) | Epoch reward cache hit rate |
| `epoch_fetch_errors_total` | counter | `reason` | Epoch fetch failures |
| `validator_missed_attestations` | gauge | `validator_index`, `component` | Missed attestation components per validator |
| `active_validator_balance_gwei` | gauge | `epoch` | Total active validator effective balance |

---

## Beacon API endpoints used

| Endpoint | Function | Usage |
|---|---|---|
| `GET /eth/v1/beacon/states/head/finality_checkpoints` | `getFinalizedEpoch` | Fetch canonical finalized epoch |
| `GET /eth/v1/beacon/states/head/validators/{index}` | `getValidatorInfo` | Resolve validator pubkey and status |
| `GET /eth/v1/beacon/states/{slot}/validators` | `getActiveValidatorBalance` | Total active balance at epoch |
| `GET /eth/v1/beacon/states/{slot}/validators/{index}` | `getValidatorEffectiveBalanceAtEpoch` | Per-validator effective balance at epoch |
| `GET /eth/v1/beacon/states/{slot}/committees` | `getValidatorCommitteeAssignment` | Committee membership for epoch |
| `GET /eth/v1/beacon/states/{slot}/finality_checkpoints` | checkpoint verification | Source/target correctness check |
| `GET /eth/v1/beacon/blocks/{slot}` | checkpoint verification | Head block root check |
| `GET /eth/v2/beacon/blocks/{slot}` | `getBlockV2` | Block body + attestations for inclusion scan |

---

## Project structure

```
backend/
├── constants.ts              # All env vars + VALIDATOR_PUBKEYS
├── RESEARCH.md               # Data approach, accuracy trade-offs, spec references
├── src/
│   ├── index.ts              # Express server entry point
│   ├── utils/
│   │   ├── logger.ts         # Winston logger
│   │   └── epochUtils.ts     # Epoch/slot math + getFinalizedEpochCached
│   ├── monitoring/
│   │   └── metrics.ts        # All 7 Prometheus metrics
│   ├── clients/
│   │   ├── beaconClient.ts   # Beacon node client (v1 + v2 endpoints)
│   │   └── beaconchainClient.ts  # beaconcha.in client (pubkey resolution only)
│   ├── rewards/
│   │   ├── altairConstants.ts    # Altair spec weights, types, JSDoc
│   │   └── rewardCalculator.ts   # Base reward, flag determination, reward math
│   ├── services/
│   │   └── attestationService.ts # On-chain computation pipeline
│   ├── cache/
│   │   └── redisClient.ts    # ioredis-backed cacheGet / cacheSet
│   ├── parsers/
│   │   └── participationParser.ts  # Legacy beaconcha.in parser (unused in main path)
│   └── routes/
│       └── validatorRoutes.ts      # GET /:index/performance, POST /batch/performance
└── scripts/
    └── testPipeline.ts       # End-to-end integration test (on-chain path)
```
