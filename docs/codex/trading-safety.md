# Warbitrer - Trading Safety

## Scope

Warbitrer can submit real orders to Kalshi and Polymarket. Changes to settings, execution, reconciliation, recovery, balances, positions, or circuit breakers can expose capital.

## Current execution controls

Per-asset strategy settings are stored in Postgres:

```text
enableTrading=false                         scan only
enableTrading=true + shadowMode=true        synthetic execution
enableTrading=true + shadowMode=false       real execution
```

Base defaults are scan-only for BTC and ETH and shadow-enabled for several other catalog assets. Persisted database configuration overrides defaults, so always inspect the effective API/database state rather than relying on constants.

## Required live posture

Before real execution:

- Confirm the intended server, branch, commit, build, and worker topology.
- Confirm application authentication and HTTPS/private access.
- Confirm Kalshi and Polymarket credentials without printing them.
- Confirm both feeds are fresh, aligned, and genuinely WS-backed where required.
- Confirm no active global, asset, or slot breaker.
- Confirm there are no unresolved intents, open orders, or unhedged positions.
- Confirm balances, allowances, notional limits, loss cap, slippage, depth, and minimum sizes.
- Confirm Postgres backup and rollback procedures.
- Start with scan-only, then shadow, and only then consider live.

## Implemented safeguards

The code currently includes:

- `enableTrading` and `shadowMode`
- stale snapshot and feed readiness checks
- global/asset/slot circuit breakers
- per-slot open-intent limits
- venue exposure limits and balance reservations
- maximum pair notional and leg capital share
- minimum projected profit/return and gross-cost thresholds
- entry cutoff near settlement
- orderbook depth and minimum-order preflight
- adaptive slippage and bounded retry counts
- stable client order IDs and order-attempt persistence
- primary confirmation, hedge rescue, forced unwind, and manual intervention states
- daily realized-loss breaker
- global Postgres live-execution lock
- reconciliation against venue orders, fills, and positions

## Known gaps

These are not hypothetical recommendations; they are current risks:

1. There is no independent environment-level authorization required for live trading.
2. The UI can change an asset directly from off/shadow to live without a confirmation challenge.
3. Basic Auth becomes disabled when either auth environment variable is absent.
4. Recovery and settings APIs rely on that same optional middleware.
5. Kalshi WS protocol errors and sequence gaps are not observed durably enough.
6. Startup schema changes are not versioned migrations.

Do not represent these gaps as already solved.

## Order truth

An order submission timeout, network error, or ambiguous venue response does not prove zero fill. Preserve:

- stable client order identifiers
- persisted request/attempt state before or around submission
- bounded immediate confirmation
- subsequent order/fill/position reconciliation
- `truth_pending` when venue truth is ambiguous
- manual intervention and breaker activation when exposure cannot be proven safe

Do not clear an unresolved intent merely to clean the UI. Closing an intent is an operator assertion about exposure and must be backed by venue truth.

## Market data safety

- Do not trade from `rest-bootstrap`, stale `rest-fallback`, or `unavailable` feeds unless the implemented readiness rules explicitly prove freshness and eligibility.
- Preserve full WS envelopes when sequence numbers or subscription IDs are outside `msg`.
- Load a new orderbook snapshot before accepting deltas after a sequence gap.
- A subscription acknowledgement is not market data freshness.
- Avoid increasing REST polling in response to rate limiting.

## Secrets

Never log or commit:

- Kalshi API key IDs paired with private keys
- Polymarket private keys or L2 API credentials
- relayer credentials
- database passwords/URLs
- Basic Auth passwords
- backup archives or database dumps

Operational transcripts must be sanitized before publication.

## Review requirements

Any execution-related change should include tests for the affected state transition and at least one failure/ambiguity path. Run:

```bash
npm run typecheck
npm test
npm run build
npm run build:worker
```

Do not run live connector calls as automated tests and do not enable live trading for validation.
