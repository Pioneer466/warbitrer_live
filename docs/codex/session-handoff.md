# Warbitrer - Codex Session Handoff

## Current State

- Date: 2026-07-21, Europe/Paris
- Branch: `review/global-hardening-2026-07-19`
- Base before the current dirty review set: `e5b637f`
- Target runtime: Node 22, Next.js 15.5.20, PostgreSQL 18
- Production topology: web, five asset workers, reconciler, notifier, Postgres, and Caddy
- Active production assets expected by the service topology: BTC, ETH, SOL, XRP, DOGE
- BNB and HYPE remain catalog/configuration assets without production worker units
- Review status: repository rubric completed at 5/5 in `docs/reviews/global-2026-07/iteration-07-final.md`
- Deployment status: not deployed by this review
- Live authorization: keep `LIVE_EXECUTION_ALLOWED=false` until a separate production rollout and approval

The worktree intentionally contains the complete global hardening review. Do not discard or partially deploy it. Commit and push the coherent set only after the final diff review.

## Core Invariants

### Entry and submission

- A new live entry requires enabled live strategy state, the environment gate, exact fresh aligned venue evidence, compatible configuration revisions, no relevant incident, and no accounting blocker.
- Live admission is globally serialized in PostgreSQL; shadow admission is serialized per asset.
- Admission commits the intent, immutable evidence, reservation, and planned primary attempt together.
- A request can cross the network only after its one-shot claim and final database-clock dispatch compare-and-swap.
- Unknown submission truth remains unresolved and must never trigger a blind retry.

### Venue and recovery truth

- Kalshi order mutations use fixed-point V2 fields and authoritative price grids.
- Polymarket final fill evidence requires a trusted Polygon V2 `OrderFilled` receipt matching order, token, side, size, price, and fee.
- Recovery validates the original intent/leg/market identity, fresh books, explicit fee provenance, and fee-inclusive loss bounds.
- Disabling new entries must not disable hedge, unwind, settlement, or recovery for existing exposure.

### Breakers and accounting

- Independent breaker causes coexist as append-only owned incidents.
- Only the owner and required durable recovery proof can resolve an automatic incident; operator-owned incidents require exact acknowledgement.
- Every intent has an accounting head. Facts and versions are immutable and request replay is explicit.
- Stable P&L comes only from a complete deterministic versioned proof.
- A late or conflicting fill quarantines the head before re-accounting.
- A `no_exposure` head requires its closure fact and a zero-exposure parent projection.
- Every fill inserted after V8, including one attached to a legacy parent, must use atomic accounting ingestion.

## Database History

The exact checksummed sequence is:

1. V1 `legacy_schema_baseline`
2. V2 `order_truth_revision`
3. V3 `configuration_revision_audit`
4. V4 `entry_admission`
5. V5 `circuit_breaker_incidents`
6. V6 `order_attempt_submission_deadline`
7. V7 `accounting_ledger`
8. V8 `accounting_evidence_hardening`

V1-V7 are frozen. Any later schema change requires V9. V8 is part of the current unshipped review set and its final checksum is documented in iteration 07.

## Verification Completed

```text
Production audit       0 high, 0 moderate, 17 low
ESLint                 passed, zero warnings
Prettier               passed repository-wide
TypeScript             passed
Tests with Postgres    62 files, 1007 tests passed
Coverage               54.03% lines, 74.53% branches, 67.93% functions
Next.js build          passed
Worker bundle          passed
Fresh PG18 migration   V8/V8 ready
Shell syntax           passed
git diff --check       passed
```

Automated tests use fixture venue messages. No live venue request was made.

## Deployment Boundary

Use `deploy/vps/README.md` and `docs/codex/deployment.md`. The deploy script performs:

1. dirty-tree, commit, environment, and topology checks
2. live-state preflight before shutdown
3. stopped-service preflight and quiescent Postgres backup
4. install, audit, lint, format, typecheck, tests, and both builds
5. explicit V1-V8 migration and read-only schema status
6. post-migration preflight
7. split-service restart with repeated stability checks

The rollout must fail stopped on any contradiction. Start scan-only, then shadow. A passing repository review does not authorize live trading.

## SSH Constraint

Password-based VPS SSH access must remain available. Do not edit `sshd`, `PasswordAuthentication`, system passwords, `authorized_keys`, or private keys. A GitHub deploy key is separate and optional.

## Intentional Cleanup

- Removed obsolete `LIVE_RISK_REVIEW.md`, `PLAN.md`, `last_thread.md`, and generated `cloc` output after consolidating durable information into `docs/`.
- Removed the obsolete combined VPS worker service; the split topology is canonical.
- Removed direct repair scripts that bypassed current accounting and breaker ownership rules.
- Local backup archives remain ignored and were not modified.

## Next Actions

1. Review `git diff --stat`, the V8 checksum, and the final iteration document.
2. Commit the complete review set and push the review branch.
3. On the VPS, keep the global breaker active and `LIVE_EXECUTION_ALLOWED=false`.
4. Follow the documented deploy flow without skipping any preflight or backup.
5. Validate V8 status, service topology, health, Polygon chain 137, venue feeds, incidents, order truth, and accounting backlog.
6. Observe scan-only and shadow across several slots before a separate live decision.

## Resume Prompt

```text
Read AGENTS.md, README.md, docs/codex/session-handoff.md, docs/codex/trading-safety.md, and docs/reviews/global-2026-07/iteration-07-final.md. Preserve password-based VPS SSH access. Do not deploy or enable live trading without explicit approval. Continue from the current review branch and verify the complete diff before committing.
```
