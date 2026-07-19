# Iteration 03 - Intent concurrency and monotone evidence

Date: 2026-07-19

Branch: `review/global-hardening-2026-07-19`

## Scores

- Code quality: **3.75/5**
- Persistence and concurrency safety: **4.5/5**
- Canary readiness: **3.75/5**

Order intents no longer use last-write-wins upserts, and post-submission fill evidence now survives concurrent writers without triggering another venue submission. The score remains below 5/5 because entry deduplication, versioned settings, multi-cause breakers, and atomic settlement are still incomplete.

## Implemented

- Replaced order-intent upserts with strict inserts and revision-checked updates.
- Returned the canonical persisted revision after every successful intent write.
- Rejected immutable parent or leg identity changes, malformed leg sets, and duplicate inserts.
- Preserved mutable execution parameters such as the preflight-adjusted slippage limit.
- Added a dedicated Postgres advisory lock for shadow execution, scoped by asset and slot and isolated from the global live lock.
- Made leg fill size, fee evidence, and execution status monotone when stale observations arrive.
- Added bounded CAS reread, merge, and retry for positive primary, partial hedge, complete hedge, retry hedge, and rescue hedge evidence.
- Stopped recovery immediately and armed a fail-closed incident when post-submission evidence cannot converge.
- Kept the CAS retry path persistence-only: it never repeats a venue submission.
- Propagated persisted revisions through settlement, recovery, breaker, shadow, and reconciliation callers.

## Verification

- TypeScript typecheck: passed.
- Unit and characterization tests: 42 files, 546 tests passed; 12 Postgres tests are environment-gated in the default run.
- PostgreSQL 18 integration tests: 12 passed against the review database.
- Concurrency cases: one-writer CAS, strict duplicate insert, immutable identity, shadow lock isolation, global live lock independence, and positive-fill merge passed.
- Targeted ESLint: passed.
- Targeted Prettier check: passed.
- Worker production bundle: passed.
- `git diff --check`: passed.

## Review Findings

The first implementation covered only partial hedge evidence. Independent review expanded the same reducer to positive primary fills, complete hedge fills, and rescue fills before any subsequent decision. A failed post-proof parent transition now preserves durable evidence, records an incident, and leaves recovery to reconciliation or an operator instead of risking a repeated order.

The remaining terminal-state concern is intentionally assigned to the settlement iteration: a late fill against a settled, unwound, or failed intent must trigger transactional re-settlement or quarantine rather than mutate only the embedded leg.

## Open Risks

1. The entry-improvement cache can still admit repeated trades in the same slot; it needs a fresh mode-aware database check under the execution lock.
2. Configuration writes still need revision checks, atomic bulk updates, and append-only audit records.
3. Circuit breakers still store one mutable cause per key and allow unrelated recovery paths to clear each other.
4. Settlement state, ledger rows, and stable P&L are not yet committed in one idempotent transaction.
5. Terminal intents with late fills need explicit quarantine or atomic re-settlement semantics.
6. Final admission still needs cutoff, exact market identity, finality, and tick-normalized economic checks immediately before primary submission.

## Operational Constraint

VPS SSH password authentication remains enabled by explicit owner requirement. Repository authentication and application API authentication are separate controls and must not alter `sshd`, `PasswordAuthentication`, or the VPS password.

## Decision

The persistence layer is ready for the next hardening iteration, but production remains restricted to scan or shadow operation. A real-money canary is not authorized until all open P1 items above pass unit and PostgreSQL concurrency or rollback tests.
