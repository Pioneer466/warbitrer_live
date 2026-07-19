# Warbitrer - Testing Strategy

## Toolchain

- TypeScript 5.8
- Vitest 3
- Next.js production build
- esbuild worker bundle

Canonical checks:

```bash
npm run typecheck
npm test
npm run build
npm run build:worker
```

The suite is expected to grow with each safety iteration; use the current `npm test` output rather than a static count in this document.

## Existing strengths

The suite covers deterministic behavior for:

- slot resolution and asset catalog
- Kalshi and Polymarket mapping/signing helpers
- market-data normalization and feed source transitions
- signal eligibility and mismatch guard
- fees, depth, balanced sizing, and slippage
- primary selection
- exposure and reservations
- intent state/economics and settlements
- many execution/retry/recovery decisions in `engine.ts`
- P&L, notifications, database retention configuration, and backtesting
- worker role parsing and hot/cold cadence

## Important gaps

- No API route tests.
- No middleware/authentication tests.
- No UI interaction tests for live activation or breaker/recovery actions.
- Real Postgres coverage currently focuses on migrations; broader query, retention, and concurrent-worker coverage remains incomplete.
- No end-to-end shadow workflow across worker and database.
- No CI workflow.
- No lint script.
- No live contract test against current venue schemas.
- Incomplete fixture coverage for full Kalshi WS envelopes, errors, close behavior, and sequence gaps.

## Test priorities

1. Ambiguous order submission and restart recovery.
2. Hedge partial/no-fill, rescue, unwind, and manual intervention.
3. Stale or unaligned market-data rejection.
4. WS snapshot/delta sequencing and reconnect.
5. Live-mode authorization and API authentication.
6. Postgres locking and migration/bootstrap behavior.
7. Fee, sizing, P&L, and settlement correctness.

## Connector tests

Use captured, sanitized fixtures. Preserve the entire wire envelope, not only the nested message:

```text
tests/fixtures/kalshi/
  subscribed.json
  error.json
  ticker.json
  orderbook_snapshot.json
  orderbook_delta.json
  trade.json
```

Tests must not call live venue APIs or use real credentials.

## Database tests

Set `TEST_DATABASE_URL` only to an isolated disposable Postgres instance. Migration integration tests are skipped when it is absent, create a unique temporary schema per test, and drop that schema afterward. CI supplies a dedicated Postgres service; never point this variable at a developer or production database.

Current migration integration coverage includes:

- fresh migration and idempotent rerun
- upgrade from representative legacy state without replacing persisted rows
- advisory-lock serialization across multiple pools
- transaction rollback and checksum mismatch refusal
- read-only runtime compatibility status

Broader database tests should add:

- execution-candidate arbitration
- open-intent and fill idempotency
- retention boundaries
- dashboard query behavior

## Change-based verification

- Pure formatter/helper: targeted test and typecheck.
- Strategy/risk calculation: targeted tests, full suite, typecheck.
- Connector/WS: fixture tests, full suite, both builds.
- Database/API: targeted integration tests when available, full suite, both builds.
- Execution/reconciliation/recovery: failure-path tests, full suite, typecheck, both builds, scan/shadow observation before deployment.

Passing unit tests do not prove venue authentication, VPS service topology, network reachability, account funding, or live safety.
