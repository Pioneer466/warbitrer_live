# Iteration 04 - Configuration integrity

Date: 2026-07-20

Branch: `review/global-hardening-2026-07-19`

## Scores

- Code quality: **4/5**
- Configuration safety: **5/5**
- Canary readiness: **4/5**

Configuration is now versioned, authenticated, auditable, and serialized with live execution. The global score remains below 5/5 because final entry admission, circuit-breaker ownership, venue API compatibility, and settlement accounting still need hardening.

## Implemented

- Added checksummed migration 3 for strategy and global-risk revisions.
- Added append-only configuration audit events with UUID request identifiers and revision transitions.
- Rejected incomplete or unknown strategy configuration sets instead of filling gaps with defaults.
- Added optimistic compare-and-swap writes for individual, bulk, and global-risk updates.
- Made the seven-asset bulk update atomic and rolled it back on any stale revision or audit failure.
- Kept no-op writes revision-neutral and made update timestamps monotonic.
- Required application mutation authentication before parsing request bodies.
- Returned structured HTTP 409 responses for revision conflicts.
- Made the dashboard send expected revisions and refresh authoritative state after writes or conflicts.
- Carried strategy and global-risk revisions through each scan and revalidated them immediately before primary submission.
- Serialized every configuration mutation with the global live-execution advisory lock.
- Persisted the global-risk run event in the same transaction as the configuration and append-only audit event.
- Kept recovery paths ahead of new-entry authorization so disabling entries does not disable hedging or unwind recovery.

## Verification

- PostgreSQL 18 targeted suite: 197 tests passed, including 14 real-database configuration tests.
- Full suite with PostgreSQL 18: 48 files, 698 tests passed.
- Concurrency cases passed in both directions between configuration mutation and live execution.
- Atomic rollback passed when configuration audit or run-event insertion fails.
- TypeScript typecheck: passed.
- ESLint: passed.
- Prettier on touched files and `git diff --check`: passed.
- Next.js and worker production builds: passed.

## Open Risks

1. Final entry authorization still needs a durable, mode-aware, under-lock database decision to prevent repeated entries in the same slot.
2. Kalshi order endpoints and tick handling must be reconciled with the current fixed-point V2 contract.
3. Circuit breakers still use a mutable projection that can overwrite or clear an unrelated cause.
4. Settlement, intent accounting, ledger writes, and stable P&L still need one idempotent transaction.
5. Late fills against terminal intents need quarantine or atomic re-accounting semantics.
6. The adaptive thin-book slippage branch can exceed its configured maximum.
7. The repository-wide Prettier check still reports 55 legacy files and remains assigned to the final cleanup iteration.

## Operational Constraint

VPS SSH password authentication remains enabled by explicit owner requirement. This iteration changes application HTTP mutation authentication only; it does not edit `sshd`, `PasswordAuthentication`, VPS passwords, or server login keys.

## Decision

Configuration safety reaches 5/5 for its bounded scope. Overall code and canary readiness remain below 5/5, so production stays in scan or shadow mode while entry admission, breakers, venue compatibility, and accounting are completed.
