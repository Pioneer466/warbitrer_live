# Warbitrer - Architecture

## Runtime topology

```text
Polymarket WS/REST       Kalshi WS/REST       Chainlink RTDS
          \                  |                  /
                   MarketDataSupervisor
                            |
                    per-asset scan loop
                            |
          normalized snapshots and signal calculation
                            |
                execution candidate arbitration
                            |
              shadow or primary/hedge execution
                            |
     orders/fills/reconciliation/recovery/settlement/P&L
                            |
                         Postgres
                            |
                    Next.js API and UI
```

## Processes

Production is split into:

- `warbitrer-web`: Next.js UI and APIs on `127.0.0.1:3000`
- one `warbitrer-asset@<asset>` process per active asset
- `warbitrer-reconciler`: shared venue truth, positions, settlements, P&L, breakers, and maintenance
- `warbitrer-notifier`: queued Telegram delivery
- Postgres
- Caddy reverse proxy

The `legacy` worker role still runs all loops in one process and is used by `start:render`. It is not the canonical VPS topology.

## Source layout

### Entrypoints

- `src/worker/index.ts`: worker roles, watchdogs, scan/execution/reconcile loops, shutdown handling
- `src/worker/runtime.ts`: role and asset parsing
- `src/app`: Next.js pages and API routes
- `src/middleware.ts`: optional application Basic Auth

### Market data and venue clients

- `src/lib/market-data.ts`: long-lived feed objects, WS state, REST fallback, normalization, freshness
- `src/lib/kalshi.ts`: Kalshi discovery, REST signing, balances, positions, orders, fills
- `src/lib/polymarket.ts`: Polymarket discovery, CLOB adapter, balances, orders, trades, fills
- `src/lib/polymarket-relayer.ts`: proxy relayer signing/submission
- `src/lib/bridge.ts`, `src/lib/recovery.ts`: treasury and conditional-token recovery

`market-data.ts` owns realtime state. Venue adapters should remain responsible for transport/auth and not strategy decisions.

### Strategy and risk

- `src/lib/signals.ts`: pair eligibility, mismatch guard, economics, sizing inputs
- `src/lib/fees.ts`: fee estimates, balanced sizing, executable depth, slippage
- `src/lib/primary-selection.ts`: Kalshi/Polymarket primary scoring
- `src/lib/risk.ts`: venue exposure and balance reservations
- `src/lib/settings-schema.ts`: validated per-asset configuration
- `src/lib/settlement.ts`: intent and leg state transitions/economics

### Orchestration

`src/lib/engine.ts` coordinates scanning, candidate arbitration, live/shadow execution, retries, rescue, unwind, reconciliation, settlements, breakers, P&L, and database maintenance.

It is the largest and highest-risk module. Prefer extracting deterministic calculations into focused modules rather than adding unrelated behavior to the engine.

### Persistence

- `src/lib/storage.ts`: application-facing storage facade
- `src/lib/postgres-db.ts`: pool, schema bootstrap, SQL, and response assembly

Every process has its own Postgres pool. Schema changes are applied explicitly through checksummed, forward-only migrations serialized on one `PoolClient` with a Postgres advisory lock. Runtime processes only verify the exact compatible `schema_migrations` history and never replay DDL.

## Data flow

1. A scan loop resolves the current slot.
2. `MarketDataSupervisor` ensures both venue feeds are bootstrapped and returns normalized quotes.
3. `buildSignals` creates both pair candidates and records rejection reasons.
4. Snapshots are persisted, normally once per second per active asset.
5. Eligible fresh candidates are published for global arbitration.
6. The winning candidate acquires a global Postgres execution lock.
7. Shadow execution writes synthetic records; live execution submits and confirms the primary, then hedges.
8. The reconciler refreshes venue truth and repairs in-flight state.
9. APIs read Postgres projections for the UI.

## Important invariants

- Stale or blocked feeds cannot create eligible live signals.
- A global Postgres advisory lock serializes live execution across asset processes.
- Any unresolved exposure blocks new execution globally.
- Order attempts use stable client identifiers to improve restart recovery.
- The reconciler, not only the immediate HTTP response, determines final venue truth.
- Circuit breakers are persisted and included in readiness.
- Scan-only is the default base configuration.

## Known structural risks

- `engine.ts` is approximately 10k lines and has a large regression surface.
- The initial versioned migration remains large because it snapshots the former runtime bootstrap; future schema changes must be smaller additive migrations.
- API routes and middleware have no dedicated automated test suite.
- BNB/HYPE UI/config support does not match the active worker set.
- Kalshi WS error/sequence diagnostics are incomplete.
- Live activation lacks an independent server environment gate.
