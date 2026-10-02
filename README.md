# Argus: Explainable Ethereum Validator Consensus Diagnostics

Argus is an on-chain attestation reconstruction and diagnostic framework for Ethereum Proof-of-Stake (PoS) validators. Rather than abstracting validator performance into an opaque percentage efficiency score, Argus reconstructs individual validator voting duties directly from canonical Beacon blocks, evaluates them against the consensus specification (Altair), and maps attestation failures to deterministic operational root causes.

---

## 1. System Motivation & Problem Definition

In Ethereum's Gasper consensus mechanism (combining Casper-FFG checkpoint finalization with LMD-GHOST fork choice), active validators cast attestations every epoch (32 slots $\times$ 12 seconds = 6.4 minutes). An attestation comprises three independent consensus assertions:

$$\text{Attestation} = \langle \text{Source Checkpoint } s, \text{Target Checkpoint } t, \text{Head Block Root } h \rangle$$

### The Observability Gap
Commercial block explorers (such as beaconcha.in) provide aggregate validator performance metrics (e.g., "94.2% Effectiveness"). Such aggregates obscure the underlying protocol failure:
- **Network propagation delay:** The validator voted for the correct head, but gossipsub latency caused the attestation to be included $>1$ slot late.
- **Short-range reorganization:** The validator cast a timely vote for head block $B$, but a subsequent 1-slot reorganization caused $B'$ to become canonical, forfeiting head rewards.
- **Clock synchronization drift:** The validator failed to justify the target epoch boundary on time.
- **Full hardware downtime:** The validator produced no signature, leading to inactivity penalties.

### The Verification Bottleneck
The official Beacon State stores participation bitmaps in `state.previous_epoch_participation`. Querying this state directly requires fetching the full SSZ-serialized Beacon State:
- **Payload size:** 120–150 MB per epoch for $\sim 950,000$ active validators.
- **Hardware constraint:** Public RPC endpoints (`Infura`, `Alchemy`, `PublicNode`) block or truncate `debug_getState` queries. Only dedicated multi-terabyte archival nodes retain non-recent states.

**Argus eliminates this dependency.** By resolving committee duty assignments and decompressing raw bitfields from canonical blocks over a 32-slot window, Argus reduces per-epoch data ingestion from **150 MB down to $\sim 45\text{ KB}$ (a 99.97% bandwidth reduction)** while maintaining spec-level mathematical precision.

---

## 2. End-to-End System Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                     INGESTION & DATA SOURCE                                      │
├────────────────────────────────────────┬─────────────────────────────────────────────────────────┤
│    Ethereum Consensus Layer (Beacon)   │                 beaconcha.in Indexer                    │
│   GET /eth/v1/beacon/states/head/...   │              GET /api/v1/validator/{pubkey}             │
│   GET /eth/v1/beacon/blocks/{slot}     │         (Used solely for pubkey ↔ index lookup;         │
│   GET /eth/v1/beacon/headers/{slot}    │           rate-limited at 2 req/s with fallback)        │
└───────────────────┬────────────────────┴────────────────────────────┬────────────────────────────┘
                    │                                                 │
                    ▼                                                 ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   ARGUS INGESTION & PIPELINE LAYER                               │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│  1. Committee Position Resolver                                                                  │
│     Maps Validator Index $i$ → $\langle \text{Slot } S, \text{Committee Index } C, \text{Index in Committee } P \rangle$ │
│                                                                                                  │
│  2. Attestation Bitlist Decompressor                                                             │
│     Parallel scan of slots $[S+1 \dots S+32]$ → decodes raw SSZ bitlists (LSB-first)             │
│     Locates bit $P$ to extract: Inclusion Slot $S_{\text{inc}}$, Source $s$, Target $t$, Head $h$  │
│                                                                                                  │
│  3. Multi-Flag Consensus Verifier                                                                │
│     ├── Source: $(s.\text{epoch} == e-1) \land (S_{\text{inc}} - S \le 5)$                       │
│     ├── Target: $(t.\text{epoch} == e) \land (S_{\text{inc}} - S \le 32)$                        │
│     └── Head:   $(h == \text{canonicalRoot}(S)) \land (S_{\text{inc}} - S == 1)$                 │
│                                                                                                  │
│  4. Altair Reward Calculator                                                                     │
│     Computes Base Reward via BigInt Newton Raphson:                                              │
│     $\text{BaseReward} = \lfloor \frac{\text{EffBalance} \times 64}{4 \times \lfloor\sqrt{\text{TotalActiveBalance}}\rfloor} \rfloor$ │
│     Computes component deltas ($W_{\text{src}}=14, W_{\text{tgt}}=26, W_{\text{head}}=14$)       │
└───────────────────┬─────────────────────────────────────────────────┬────────────────────────────┘
                    │                                                 │
                    ▼                                                 ▼
┌──────────────────────────────────────┐            ┌──────────────────────────────────────────────┐
│       CACHE & STORAGE SUBSYSTEM      │            │          TELEMETRY & OBSERVABILITY           │
├──────────────────────────────────────┤            ├──────────────────────────────────────────────┤
│  • Redis Cluster / Standalone        │            │  • Prometheus Metrics Exporter (/metrics)    │
│  • Epoch Data TTL: 3600s (immutable) │            │    - `argus_pipeline_execution_seconds`      │
│  • Validator Metadata TTL: 3600s     │            │    - `argus_attestation_miss_total{flag}`    │
│  • In-Memory NodeCache Fallback      │            │  • Grafana Dashboard Monitoring Stack        │
└───────────────────┬──────────────────┘            └──────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                  PRESENTATION & CLIENT DASHBOARD                                 │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│  React 19 + TypeScript + Vite + Tailwind CSS + Recharts                                          │
│  • Per-validator interactive performance breakdown across 10-epoch sliding windows              │
│  • Real-time diagnostic state classifications (Wrong Head, Late Source, Target Miss, Perfect)     │
│  • Exact Gwei financial delta visualization per reward component                                 │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Protocol Verification & Attestation State Machine

Argus implements the consensus specifications defined in the Ethereum Altair Hard Fork. Every epoch attestation evaluated for validator index $i$ at slot $S$ is categorized into one of seven deterministic states:

```
                                      [ Start Attestation Evaluation ]
                                                      │
                                                      ▼
                                       Found in slots [S+1 ... S+32]?
                                                      │
                                      ┌───────────────┴───────────────┐
                                      │ NO                            │ YES
                                      ▼                               ▼
                             [ MISSED_ENTIRELY ]             Extract Inclusion Slot
                               (0 Gwei earned)              Calculate Delay δ = S_inc - S
                                                                      │
                                   ┌──────────────────────────────────┴──────────────────────────────────┐
                                   │                                                                     │
                         Check Source Validity                                                 Check Target Validity
                  (s.epoch == e-1) ∧ (δ ≤ 5)                                            (t.epoch == e) ∧ (δ ≤ 32)
                     ┌─────────────┴─────────────┐                                         ┌─────────────┴─────────────┐
                     │ TRUE                      │ FALSE                                   │ TRUE                      │ FALSE
                     ▼                           ▼                                         ▼                           ▼
              [ Source Valid ]           [ LATE_SOURCE or ]                         [ Target Valid ]           [ WRONG_TARGET ]
             (+2,310 Gwei)               [ WRONG_SOURCE   ]                        (+4,290 Gwei)               (-4,290 Gwei)
                                                │
                                                ▼
                                      Check Head Validity
                               (h == canonicalRoot(S)) ∧ (δ == 1)
                                   ┌────────────┴────────────┐
                                   │ TRUE                    │ FALSE
                                   ▼                         ▼
                             [ Head Valid ]           [ WRONG_HEAD or ]
                            (+2,310 Gwei)             [ LATE_HEAD     ]
                                                             │
                                                             ▼
                                                    [ Full Classification ]
```

### Participation Flag Specifications

| Flag Name | Flag Index | Weight ($W_i/64$) | Max Inclusion Delay ($\delta$) | Checkpoint Matching Requirement |
| :--- | :---: | :---: | :---: | :--- |
| **`TIMELY_SOURCE`** | $0$ | $14 / 64$ ($21.875\%$) | $\lfloor\sqrt{32}\rfloor = 5$ slots | Source epoch matches previous finalized epoch |
| **`TIMELY_TARGET`** | $1$ | $26 / 64$ ($40.625\%$) | $32$ slots ($1$ epoch) | Target epoch matches current boundary block |
| **`TIMELY_HEAD`** | $2$ | $14 / 64$ ($21.875\%$) | $1$ slot | Beacon block root matches canonical block root at slot $S$ |

*(Note: The remaining $10/64$ consensus weight is allocated to Proposer rewards [$8/64$] and Sync Committees [$2/64$]).*

### Root-Cause Operational Taxonomy

1. **`correct`**: All three consensus assertions ($s, t, h$) satisfied within timing gates. Maximum base reward awarded.
2. **`wrong_head`**: Included on time ($\delta = 1$), source and target correct, but attested root differs from canonical root. Caused by short-range forks, 1-slot reorganizations, or MEV-boost block proposal latency.
3. **`late_head`**: Root matches canonical header, but inclusion delay $\delta > 1$. Head rewards forfeited due to gossip propagation latency.
4. **`late_source`**: Source checkpoint correct, but inclusion delay $\delta > 5$. Source reward forfeited.
5. **`wrong_target`**: Target checkpoint does not match epoch boundary. Indicates local consensus split or validator running on a stalled fork.
6. **`missed_entirely`**: No attestation observed across the entire 32-slot inclusion window. Indicates validator process downtime, client crash, or local peering disconnection.

---

## 4. Algorithmic Implementation

### 1. Integer Square Root (Spec Invariant)
Ethereum consensus mandates exact floor square-root arithmetic using integer arithmetic to prevent cross-platform floating-point nondeterminism:

```typescript
export function integerSquareRoot(n: bigint): bigint {
  if (n === 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
```

### 2. Base Reward Formulation
Given active balance $B_{\text{active}}$ and validator effective balance $B_{\text{eff}}$:

$$\text{BaseRewardPerIncrement} = \left\lfloor \frac{10^9 \times 64}{\lfloor\sqrt{B_{\text{active}}}\rfloor} \right\rfloor$$

$$\text{BaseReward} = \left( \frac{B_{\text{eff}}}{10^9} \right) \times \text{BaseRewardPerIncrement}$$

For standard $32\text{ ETH}$ validators under mainnet conditions ($B_{\text{active}} \approx 37,563,402\text{ ETH}$):
- $\text{BaseRewardPerIncrement} = 330\text{ Gwei}$
- $\text{BaseReward} = 32 \times 330 = 10,560\text{ Gwei}$
- **Max Attestation Reward:** $2,310 + 4,290 + 2,310 = 8,910\text{ Gwei / epoch}$

---

## 5. Technology Stack & Directory Structure

```text
Argus/
├── backend/                  Express.js, TypeScript 5.9, Node.js 20+
│   ├── src/
│   │   ├── clients/          Beacon Node REST client & beaconcha.in resolver
│   │   ├── parsers/          SSZ bitlist decompressor & attestation parser
│   │   ├── rewards/          Altair mathematical specifications & constants
│   │   ├── services/         Attestation extraction & checkpoint verifier
│   │   ├── cache/            Redis client with fallback to NodeCache
│   │   ├── monitoring/       Prometheus metrics & Winston logger
│   │   └── routes/           REST API endpoint handlers
│   └── scripts/
│       ├── testPipeline.ts   Live Beacon RPC verification harness
│       └── reconciliation.ts Multi-validator 14-day empirical reconciliation
│
├── client/                   React 19, Vite 7, Tailwind CSS 3.4, Recharts
│   └── src/
│       ├── components/       Validator cards, timeline charts, epoch tables
│       └── hooks/            Performance fetching & polling state hooks
│
├── monitoring/               Prometheus & Grafana infrastructure
│   ├── prometheus.yml        Scrape configurations (30s interval)
│   └── docker-compose.yml    Telemetry container definitions
│
├── RESEARCH.md               Empirical research paper, traces, and proof analysis
└── README.md                 System architecture and technical documentation
```

---

## 6. Local Deployment & Setup

### Prerequisites
- **Node.js:** `v20.0.0` or higher
- **Package Manager:** `pnpm` (backend) and `npm` (client)
- **Redis:** `v6.0+` (optional, falls back to in-memory caching if unavailable)
- **Docker:** (optional, for Prometheus/Grafana monitoring stack)

### 1. Backend Service

```bash
cd backend

# Configure environment variables
cp .env.example .env

# Install dependencies and start development server
pnpm install
pnpm dev
```
The backend starts at `http://localhost:3000`.

### 2. Client Dashboard

```bash
cd client
npm install
npm run dev
```
The dashboard starts at `http://localhost:5173`.

### 3. Monitoring Stack (Optional)

```bash
cd monitoring
docker compose up -d
```
- **Prometheus:** `http://localhost:9090`
- **Grafana:** `http://localhost:3001` (Default credentials: `admin` / `admin`)

---

## 7. API Reference

### Get Single Validator Performance
```http
GET /api/validators/:indexOrPubkey/performance?epochs=10
```
**Sample Response:**
```json
{
  "validatorIndex": 1344884,
  "pubkey": "0x89ca023fc6975d72384afff7bbfbdc9964732a1ea5b47613101ce8ff4e1da142cdb582778ed7592cb05daedf4ba580fa",
  "epochsScanned": 10,
  "summary": {
    "correct": 9,
    "wrongHead": 1,
    "wrongTarget": 0,
    "wrongSource": 0,
    "missedEntirely": 0,
    "totalEarnedGwei": 88200,
    "totalMissedGwei": 2310
  },
  "history": [
    {
      "epoch": 433236,
      "slot": 13863552,
      "status": "wrong_head",
      "inclusionDelay": 1,
      "earnedGwei": 6600,
      "missedGwei": 2310,
      "flags": {
        "source": { "earned": true, "reward": 2310 },
        "target": { "earned": true, "reward": 4290 },
        "head":   { "earned": false, "missed": 2310 }
      },
      "explanation": "Wrong-head vote, included on time. A short reorganisation or block-propagation delay caused the validator to observe a non-canonical head."
    }
  ]
}
```

### System Health & Telemetry
- `GET /health` — Verifies process uptime, Redis cache status, and Beacon RPC connectivity.
- `GET /metrics` — Exposes Prometheus operational metrics for scraping.

---

## 8. Verification & Empirical Research

Run the empirical reconciliation pipeline directly against active Ethereum mainnet nodes:

```bash
cd backend
pnpm pipeline:reconcile
```

For complete empirical logs, mathematical proofs of checkpoint equivalence, deep-dives into single-slot reorgs, and EIP-7251 (MaxEB) scalability analysis, see [RESEARCH.md](RESEARCH.md).
