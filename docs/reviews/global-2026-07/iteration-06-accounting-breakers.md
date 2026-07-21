# Iteration 06 - Breaker ownership and exact accounting

Date: 2026-07-21

Branch: `review/global-hardening-2026-07-19`

## Scores

- Code quality: **4.75/5**
- Trading truth and accounting safety: **4.75/5**
- Repository release readiness: **4.75/5**

The mutable financial projection has been replaced by immutable evidence and versioned accounting. The score remains below 5/5 because the first full-suite run exposed two final bypasses: a direct low-level fill write and mutable embedded leg economics under a `no_exposure` head.

## Implemented

- Added V5 multi-cause circuit-breaker incidents with stable identity, explicit ownership, append-only events, revision checks, durable exposure recovery, and database-time cooldowns.
- Added V7 accounting heads, immutable leg/fill/settlement facts, deterministic fixed-unit proofs, versioned projections, append-only P&L deltas, no-exposure closures, and quarantine.
- Added V8 lifecycle, finite-economics, parent identity, confirmed-attempt truth, and stable parent/proof constraints.
- Required exact Polygon receipt evidence from the trusted Polymarket V2 exchange before a CLOB trade becomes final accounting truth.
- Allowed provisional Kalshi fees to be promoted immutably only by exact final venue evidence.
- Quarantined late and conflicting fills, then required explicit deterministic re-accounting.
- Kept accounting backlog from blocking recovery of already exposed capital while blocking new live entry.
- Added staged deployment preflights before shutdown, before migration, and after migration.
- Added coordinated worker shutdown, submission draining, Postgres close, quiescent backup, and fail-stopped service validation.

## Verification

- PostgreSQL concurrency and rollback tests cover breaker coexistence, owner resolution, exact replay, finalization races, no-exposure closure, late-fill quarantine, re-accounting, retention, and UTC P&L aggregation.
- Migration V7-to-V8 preflight was executed against a real V7 schema before V8 existed.
- Production dependency audit reported `0 high`, `0 moderate`, and `17 low` findings.
- Lint, global formatting, typecheck, shell syntax, Next.js build, and worker build passed.

## Final Findings Before 5/5

1. `upsertFill` could still insert a valid fill without creating an immutable accounting fact.
2. A failed parent could retain its `no_exposure` head while a direct writer changed an embedded leg to positive filled size or fees.
3. Two PostgreSQL breaker tests inherited Vitest's 5-second unit timeout even though schema creation can exceed it under parallel load.

## Decision

No production deployment is authorized from this iteration. Resolve all three findings and rerun the complete suite before assigning 5/5.
