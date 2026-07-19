# Iteration 02 - Execution truth and operational readiness

Date: 2026-07-19

Branch: `review/global-hardening-2026-07-19`

## Scores

- Code quality: **3.5/5**
- Execution and reconciliation safety: **4/5**
- Canary readiness: **3.5/5**

Submission ambiguity, stale venue reads, premature finality, and stale health data now fail closed. The remaining gap is below the adapter layer: database writes, breaker ownership, and settlement accounting still need stronger transactional invariants before a real-money canary.

## Implemented

- Persisted an order attempt before every live venue request.
- Added explicit `truth_pending` attempts for transport or confirmation ambiguity.
- Made client order identifiers stable across repricing and process recovery while keeping intentional retry stages distinct.
- Blocked primary failure and primary unwind while a primary or hedge submission may have reached a venue.
- Preserved success or failure independently for every orders/fills fetch; a failed fetch is no longer treated as an authoritative empty response.
- Required fresh order and fill truth before destructive reconciliation on both venues.
- Kept positive terminal fills open for hedging or recovery instead of immediately marking their intents failed.
- Paginated Kalshi orders, fills, and positions with bounded cursor loops and propagated lookup failures.
- Restricted the Kalshi soft no-fill classifier and used explicit venue fees when present.
- Used order-scoped Polymarket maker fields and authoritative asset context.
- Rejected maker fills with no maker-side evidence instead of borrowing the taker side.
- Kept Polymarket soft no-fill truth pending until the venue provides authoritative terminal zero-fill evidence.
- Required Polymarket UMA `resolved` and Kalshi `finalized` before settlement or settlement repair.
- Added a static `/api/liveness` endpoint for Caddy and kept `/api/health` as fail-closed business readiness.
- Invalidated stale health data in the live trading control after transport or non-JSON failures.
- Added worker, execution, snapshot, feed, breaker, and live-authorization readiness reasons.
- Introduced a versioned and checksummed Postgres migration runner; runtime processes now only verify schema compatibility.

## Verification

- TypeScript typecheck: passed.
- Unit and characterization tests: 40 files, 472 tests passed; 6 Postgres integration tests are environment-gated.
- PostgreSQL 18 integration tests: 6 passed against an ephemeral real server.
- Migration cases: fresh install, idempotent rerun, legacy preservation, concurrent runners, rollback, and checksum rejection passed.
- Next.js production build: passed.
- Worker production bundle: passed.
- ESLint: no errors; legacy warnings are being removed in the next cleanup iteration.
- `git diff --check`: passed.

## Independent Review

The first review found a crash gap after hedge acceptance, volatile client IDs, post-ack telemetry inside submission catches, destructive reconciliation on failed Kalshi reads, a maker-side fallback, and a terminal positive-fill regression. Each finding was corrected and covered by a focused test or pure policy test.

The review also confirmed that the application-level maker fill ID is no longer sufficient while Postgres still enforces `UNIQUE (venue, trade_id)`. That constraint and the last-write-wins order/attempt writes are assigned to migration 2.

## Open Risks

1. Venue orders and order attempts still need evidence-monotone database merge commands.
2. Fills still need immutable conflict detection and order-scoped exchange uniqueness.
3. Intent state changes still need command-specific concurrency control rather than whole-row last-write-wins upserts.
4. Settings updates need revisions, atomic bulk writes, and audit records in the same transaction.
5. Circuit breakers still store one mutable cause per scope instead of independent owned incidents.
6. Settlement still writes intent state and financial rows separately even though venue finality is now strict.
7. Production dependency audit exceptions and legacy lint/format debt remain visible.

## Decision

The execution layer is materially safer, but production remains restricted to scan or shadow operation. A live canary is not authorized until persistence, breaker, and settlement P0 items pass real-Postgres concurrency and rollback tests.
