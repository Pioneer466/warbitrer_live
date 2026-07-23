# Warbitrer - Architecture

## Runtime topology

```text
Polymarket WS/REST       Kalshi WS/REST       Chainlink RTDS
          \                  |                  /
                   MarketDataSupervisor
                            |
                    per-asset scan loop
                            |
             deterministic signal and risk logic
                            |
               final market-evidence validation
                            |
          Postgres admission, reservation, and claim
                            |
              shadow or primary/hedge execution
                            |
       venue truth, reconciliation, recovery, settlement
                            |
              accounting and breaker incident state
                            |
                         Postgres
                            |
                    Next.js API and UI
```

## Processes

Production is split into:

- `warbitrer-web`: Next.js UI and APIs on `127.0.0.1:3000`
- `warbitrer-asset@<asset>`: one `asset-live` process for each active asset
- `warbitrer-reconciler`: shared venue truth, positions, settlements, P&L, breakers, and maintenance
- `warbitrer-notifier`: queued Telegram delivery
- local Postgres
- Caddy reverse proxy

The `legacy` role runs the loops in one process for `start:render`. It is not part of the canonical VPS topology and must never run beside the split services against the same database.

## Source boundaries

### Entrypoints and lifecycle

- `src/worker/index.ts`: worker roles, watchdogs, loops, and shutdown orchestration
- `src/worker/runtime.ts`: role, asset, jitter, and arbitration parsing
- `src/worker/shutdown.ts`: bounded cleanup coordination
- `src/app`: Next.js pages and API routes
- `src/middleware.ts`: fail-closed production application Basic Auth
- `src/lib/api-mutation-auth.ts`: independent mutation authentication and same-site checks

### Market data and venue clients

- `src/lib/market-data.ts`: long-lived feed objects, WebSocket state, REST resync, normalization, and freshness
- `src/lib/kalshi.ts`: Kalshi discovery, REST signing, balances, positions, orders, and fills
- `src/lib/polymarket.ts`: Polymarket discovery, CLOB adapter, balances, orders, trades, and fills
- `src/lib/polymarket-relayer.ts`: proxy relayer signing and submission
- `src/lib/bridge.ts`, `src/lib/recovery.ts`: treasury and conditional-token recovery

`market-data.ts` owns realtime state. Venue adapters own transport, authentication, and venue response mapping. They do not decide strategy eligibility.

### Strategy, admission, and recovery policy

- `src/lib/signals.ts`: pair eligibility, mismatch guard, economics, and sizing inputs
- `src/lib/fees.ts`: fee estimates, balanced sizing, executable depth, and slippage
- `src/lib/primary-selection.ts`: primary venue scoring
- `src/lib/risk.ts`: venue exposure and balance reservations
- `src/lib/settings-schema.ts`: validated per-asset configuration
- `src/lib/entry-admission-policy.ts`: exact final entry identity, freshness, tick, and deadline checks
- `src/lib/recovery-order-policy.ts`: exact recovery market proof and fee-inclusive recovery limits
- `src/lib/execution-safety.ts`: independent live environment authorization
- `src/lib/settlement.ts`: deterministic intent and leg state transitions and economics

These modules should remain deterministic where possible. Network and database orchestration belongs in the engine or persistence layer.

### Circuit breakers

- `src/lib/circuit-breaker-incidents.ts`: canonical incident creation by subsystem
- `src/lib/circuit-breaker-policy.ts`: scope aggregation and resolution policy
- `src/lib/postgres-db.ts`: append-only incident/event persistence and exact mutation concurrency

The source of truth is an incident set, not one mutable row per scope. Each incident has a stable identity, owner, impact, resolution policy, revision, exposure state, and event history. Multiple independent causes may coexist at global, asset, or slot scope.

Execution and readiness consume incidents or their scope aggregates. The legacy `CircuitBreaker[]` shape is a lossy UI projection only. An owner may resolve its own recovered condition; an operator acknowledgement cannot manufacture missing venue or exposure evidence.

### Accounting

- `src/lib/accounting-ledger.ts`: deterministic fixed-unit evidence and ledger calculations
- `src/lib/accounting-runtime.ts`: fill finality, provenance, deterministic mutation identity, and projection orchestration
- `src/lib/polymarket-onchain-fill.ts`: trusted Polygon V2 `OrderFilled` receipt decoding and exact Polymarket fill evidence
- `src/lib/postgres-db.ts`: accounting heads, immutable facts, versions, proofs, quarantine, no-exposure closures, mutation idempotency, and realized-P&L deltas
- `src/lib/storage.ts`: application-facing accounting operations

Migrations V7-V8 define the accounting contract. Every intent has an accounting head whose state can be `open`, `stable`, `quarantined`, `no_exposure`, or `legacy_pending`. Facts and versions are append-only. Late or conflicting facts are quarantined instead of silently rewriting a terminal financial projection. Mutation request IDs and proof hashes make replay explicit. A confirmed Polymarket CLOB trade becomes final only after its Polygon receipt proves the trusted V2 exchange, order hash, token, side, size, price, and exact emitted fee.

### Orchestration

`src/lib/engine.ts` coordinates scanning, candidate arbitration, live and shadow execution, rescue, unwind, reconciliation, settlements, breakers, accounting, and database maintenance.

It is the largest and highest-risk module. Extract deterministic policy or calculation code into focused modules rather than expanding it with transport, UI, or persistence rules.

### Persistence

- `src/lib/storage.ts`: application-facing storage facade and singleton pool lifecycle
- `src/lib/postgres-db.ts`: pool, migrations, transactions, SQL commands, and read projections

Every process has its own bounded Postgres pool. Schema changes are checksummed, forward-only migrations serialized on one `PoolClient` with a Postgres advisory lock. Runtime processes only verify exact `schema_migrations` compatibility and never replay DDL.

The migration sequence is:

| Version | Name                                | Contract                                                         |
| ------- | ----------------------------------- | ---------------------------------------------------------------- |
| V1      | `legacy_schema_baseline`            | Additive baseline and catalog seeds                              |
| V2      | `order_truth_revision`              | Monotone revisions and order-scoped fill identity                |
| V3      | `configuration_revision_audit`      | CAS configuration writes and append-only audit                   |
| V4      | `entry_admission`                   | Durable admission evidence and live/shadow reservations          |
| V5      | `circuit_breaker_incidents`         | Multi-cause append-only incidents and scope coordination         |
| V6      | `order_attempt_submission_deadline` | Submission capabilities, deadlines, and stage/parent guards      |
| V7      | `accounting_ledger`                 | Immutable facts, versioned proofs, quarantine, and P&L delta     |
| V8      | `accounting_evidence_hardening`     | Finality, exact parent projections, and mandatory fill ingestion |

Applied migration source is immutable. Any schema change requires a new version.

## New-entry data flow

1. An asset worker resolves the current canonical slot.
2. `MarketDataSupervisor` bootstraps both venues and returns normalized feed and book evidence.
3. `buildSignals` evaluates both pair combinations and records all rejection reasons.
4. Snapshots and reference evidence are persisted.
5. Eligible candidates enter global arbitration.
6. The engine refreshes exact venue state and applies the final entry policy, including identity, alignment, finality, WebSocket source, freshness, pair skew, authoritative tick, depth, economics, and submission budget.
7. Live admission locks the global reservation, accounting gate, configuration revisions, and relevant breaker scopes in Postgres. The intent, immutable evidence, and planned primary attempt are committed together.
8. The one-shot claim rechecks configuration, breakers, accounting, identity, and the database clock. A final pre-network dispatch CAS refuses an expired or changed capability.
9. The venue request uses a stable client order ID. Request and response state move monotonically through `planned`, `submitting`, `submitted`, `truth_pending`, `confirmed`, or definitive `failed` evidence.
10. A confirmed positive primary fill moves to hedge or recovery. Ambiguous truth blocks resubmission and remains for authoritative reconciliation.
11. The reconciler refreshes orders, fills, positions, resolutions, incidents, and financial state from venue evidence.
12. APIs read Postgres projections for the operator UI.

Shadow execution uses a separate per-asset/slot advisory lock, while shadow admission uses a durable per-asset reservation. It never consumes the global live reservation or submits a venue order.

## Core invariants

- Scan-only is the fail-closed base posture.
- New live execution requires effective live settings, `LIVE_EXECUTION_ALLOWED=true`, and `KALSHI_ENV=prod`.
- Stale, fallback-only, unaligned, or identity-mismatched feeds cannot authorize a new live entry.
- Initial live admission is committed before a venue request and is globally serialized in Postgres.
- Configuration revisions and breaker incidents are rechecked at claim time.
- A submission deadline cannot be extended by a caller-supplied clock.
- An ambiguous request is not a zero fill and cannot be blindly resubmitted.
- Client order IDs and canonical request hashes are stable across restart recovery.
- Reconciliation, not an HTTP response alone, determines final venue truth.
- Polymarket settlement requires authoritative resolved truth; Kalshi requires finalized truth.
- Independent breaker causes cannot overwrite or clear one another.
- Unknown exposure or accounting defects block new live admission.
- A fill inserted after V8 cannot commit without matching immutable accounting evidence, including on a legacy parent; a stable fill must belong to the current version.
- A `no_exposure` head requires an append-only closure and an exact zero-exposure parent projection.
- Runtime startup fails when migration history is missing, pending, unknown, renamed, or checksum-mismatched.

## Security boundaries

- Caddy provides HTTPS and an external Basic Auth defense.
- Production middleware independently fails closed when application credentials are absent or partial.
- Mutating APIs authenticate before body parsing and reject cross-site browser requests.
- `LIVE_EXECUTION_ALLOWED` authorizes new live entries only; it is not an HTTP credential.
- Secret files and private keys remain outside the repository.
- Repository scripts do not change `sshd`, `PasswordAuthentication`, system passwords, or login keys. Password-based SSH must remain available; keys are optional.

## Structural risks

- `engine.ts`, `postgres-db.ts`, and `market-data.ts` remain large, high-blast-radius modules.
- V1 is intentionally large because it snapshots the former bootstrap; later migrations must remain focused and additive.
- The seven active asset workers increase feed, REST, database, and process load; production capacity and rate-limit health must be observed after topology changes.
- Passing deterministic tests cannot reproduce all venue latency, outage, rate-limit, or market-microstructure behavior.

Use `docs/codex/session-handoff.md` and the current review iteration for date-specific rollout state. Do not infer deployment or live-canary approval from this architecture document.
