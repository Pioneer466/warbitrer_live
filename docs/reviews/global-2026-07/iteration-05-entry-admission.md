# Iteration 05 - Entry admission and submission capability

Date: 2026-07-20

Branch: `review/global-hardening-2026-07-19`

## Scores

- Code quality: **4.5/5**
- Entry and submission safety: **5/5**
- Repository release readiness: **4.25/5**

Entry authorization is now a durable database decision rather than an in-memory timing check. The global score remains below 5/5 because multi-cause breaker ownership and terminal accounting are still incomplete at this point in the review.

## Implemented

- Added checksummed migrations V4 and V6 for admission reservations, immutable evidence, canonical request hashes, and submission deadlines.
- Serialized live admission globally and shadow admission per asset while preserving mode-aware cooldown history.
- Committed the intent, admission, reservation, and planned primary attempt atomically.
- Added a one-shot `planned -> submitting` claim with compare-and-swap semantics.
- Revalidated strategy revisions, global-risk revisions, breaker scopes, parent stage, leg identity, and request identity while holding database locks.
- Derived one immutable evidence-validity deadline from both venue feeds and books.
- Rechecked the PostgreSQL clock at claim time and in a final compare-and-swap immediately before the network request.
- Prevented a claimed or ambiguous request from being submitted again.
- Preserved hedge, unwind, and recovery paths when new entry is disabled.
- Migrated Kalshi order mutation payloads to fixed-point V2 fields and authoritative tick handling.

## Verification

- Real PostgreSQL tests cover competing admissions, claim races, deadline crossings under row-lock contention, configuration and breaker races, replay, rollback, and parent-stage rejection.
- Pure policy tests cover slot identity, evidence freshness, tick normalization, economics, and recovery authorization.
- Typecheck, lint, formatting, migration checksum binding, Next.js build, and worker build passed.
- No venue request, VPS deployment, or live setting change was made.

## Open Risks

1. Independent breaker causes still need append-only ownership so one recovery cannot clear another cause.
2. Terminal intent state and realized P&L still need one immutable, idempotent accounting transaction.
3. Late or conflicting fills need quarantine and deterministic re-accounting.
4. Production deployment still needs stopped-service preflight, quiescent backup, and fail-stopped restart validation.

## Decision

The bounded entry/submission layer reaches 5/5. Overall code remains below 5/5 until breaker and accounting invariants are enforced in PostgreSQL.
