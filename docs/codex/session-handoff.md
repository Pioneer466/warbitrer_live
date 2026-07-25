# Warbitrer - Codex Session Handoff

## Current State

- Date: 2026-07-23, Europe/Paris
- Branch: `review/global-hardening-2026-07-19`
- Base before the current dirty review set: `e5b637f`
- Target runtime: Node 22, Next.js 15.5.21, PostgreSQL 18
- Production topology: web, seven asset workers, reconciler, notifier, Postgres, and Caddy
- Active production assets expected by the service topology: BTC, ETH, SOL, XRP, DOGE, BNB, HYPE
- Review status: repository rubric completed at 5/5 in `docs/reviews/global-2026-07/iteration-07-final.md`
- Deployment status: seven-worker shadow topology deployed from `beb45c9`; V9 ready and all ten application services stable
- Live authorization: keep `LIVE_EXECUTION_ALLOWED=false`; BNB/HYPE must start with `enableTrading=true` and `shadowMode=true`

The global hardening review is committed and pushed. The rollout keeps real execution disabled and must complete the canonical preflight, backup, migration, build, and stability sequence before the new runtime is considered deployed.

## Production Configuration Change - 2026-07-25

The production `entryCutoffSeconds` setting was changed atomically through the authenticated bulk settings API to
`60` for BTC, ETH, SOL, XRP, DOGE, BNB, and HYPE. BTC through DOGE previously used `180`; BNB and HYPE previously
used `300`. No other strategy field changed.

The mutation ran against production `main` commit `35e8fcc1503d` with a clean tree. Before the change, the V9
deployment preflight confirmed `LIVE_EXECUTION_ALLOWED=false`, zero unresolved current live order attempts, zero
open live venue orders, zero economically active live positions, and zero owned live reservations. The 39 known
historical `legacy_pending` accounting heads remain visible and continue to block runtime live admission.

After the change, all seven configurations remained `enableTrading=true` and `shadowMode=true`; the application
reported healthy with no active breaker, and the web, seven asset workers, reconciler, and notifier were all active.
No code, service, environment, SSH, database row outside the versioned configuration transaction, or deployment
artifact was changed.

## BNB/HYPE Public Price Stream Fix - 2026-07-25

BNB and HYPE mismatch diagnostics were blocked by `chainlink_unavailable` even though their Polymarket and Kalshi
market feeds were healthy. The workers selected the direct Chainlink Data Streams transport solely because the
catalog entries contained direct feed IDs; production intentionally has no direct Chainlink credentials. A
read-only probe from the VPS confirmed that Polymarket's public RTDS endpoint publishes both `bnb/usd` and
`hype/usd` without credentials, with 14 valid updates for each single-symbol subscription over 15 seconds.

`src/lib/market-data.ts` now prefers the optional direct transport only when both direct credentials are present and
otherwise uses the public Polymarket RTDS relay for every asset. Partial direct credentials still follow the
fail-closed direct configuration error path. `tests/market-data.test.ts` covers the credential-free BNB/HYPE fallback
and retention of the fully configured direct path. The environment examples now describe direct credentials as
optional.

Focused market-data, direct-stream, and environment tests passed (49 tests). The full verification also passed:
production dependency audit, lint, format check, typecheck, 916 tests, Next.js build, and worker build. Eight
database integration suites remain skipped locally because `TEST_DATABASE_URL` is not configured.

## Rollout Note - BNB/HYPE Shadow Reactivation

BNB and HYPE are restored to `ACTIVE_MARKET_ASSETS` and the canonical VPS service list to collect current opportunity,
execution-simulation, and mismatch evidence. Their initial production configuration must remain shadow-only. The
independent environment gate remains false, and the historical accounting backlog still prevents live admission.
Observe feed readiness, REST/WS rate limits, CPU, memory, Postgres connections, snapshot cadence, and worker restarts
before considering any further mode change.

Production activation completed with both assets at configuration revision 1:

- `enableTrading=true`, `shadowMode=true`
- Polymarket and Kalshi feeds `ready` from WebSocket data
- fresh scan, execution, heartbeat, and snapshot timestamps
- roughly 100 snapshots per asset during the first observation window
- no open breaker incident and no service restart
- no initial shadow intent because all four combinations failed the configured economics or depth requirements
- `LIVE_EXECUTION_ALLOWED=false` and password-based SSH access preserved
- verified quiescent backup `warbitrer_live_20260723T140511Z.dump`

## Rollout Note - Legacy V0 Preflight

The first production preflight correctly ran before any service stop, but exposed an ordering defect: the deploy script checks live state before V1 migration while the preflight previously rejected every complete legacy database lacking `schema_migrations`. The preflight now accepts only the exact uninitialized V0 state (no applied history, every V1-V8 migration pending, and no migration problems other than the missing history table and pending migrations). It still validates the required legacy table shape and durable live state before migration; initialized V0, partial schemas, history gaps, unknown migrations, and checksum mismatches remain blocked.

Coverage includes a unit-level V0 query simulation and a PostgreSQL integration case that builds a complete baseline schema without initializing migration history. The full PostgreSQL 18 suite passed before rollout.

## Rollout Note - Audited V8 Legacy Bridge

The production restore rehearsal identified 74 old non-BTC fills stored with the former BTC default and 238 terminal
Polymarket FOK/FAK order projections with stale `pending` status or a rounded requested size below the durable fill.
The one-time `db:repair-v8-legacy` command repairs only those parent- and fill-proven rows, records complete before/after
evidence, and refuses count drift. A compact production clone proved that V1-V8 then migrate successfully.

Thirty-nine historical failed live intents still contain fills without enough evidence for exact re-accounting. They
must not be rewritten as settled or unwound. They remain `legacy_pending` and continue to block runtime live entry.
The deployment preflight can admit only this exact historical category under the transient
`ALLOW_HISTORICAL_LEGACY_ACCOUNTING_DEPLOY=true` shadow-only override while `LIVE_EXECUTION_ALLOWED=false`.

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
9. V9 `inactive_legacy_slot_breaker_repair`

V1-V7 are frozen. Any later schema change requires V9. V8 is part of the current unshipped review set and its final checksum is documented in iteration 07.

## Verification Completed

```text
Production audit       0 high, 0 moderate, 17 low
ESLint                 passed, zero warnings
Prettier               passed repository-wide
TypeScript             passed
Unit/runtime tests     55 files, 897 tests passed
Coverage               54.03% lines, 74.53% branches, 67.93% functions
Next.js build          passed
Worker bundle          passed
Production PG18 schema V9/V9 ready
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
5. explicit V1-V9 migration and read-only schema status
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

1. Keep `LIVE_EXECUTION_ALLOWED=false`.
2. Observe BNB/HYPE shadow results and resource/rate-limit health across several slots.
3. Review qualified and rejected opportunities without lowering safety thresholds merely to create trades.
4. Keep the 39 historical live-accounting blockers visible until exact evidence permits deterministic repair.
5. Require a separate explicit live decision after the accounting backlog is clean.

## Resume Prompt

```text
Read AGENTS.md, README.md, docs/codex/session-handoff.md, docs/codex/trading-safety.md, and docs/reviews/global-2026-07/iteration-07-final.md. Preserve password-based VPS SSH access. Do not deploy or enable live trading without explicit approval. Continue from the current review branch and verify the complete diff before committing.
```

## Shadow Admission Verification - 2026-07-23

Production inspection confirmed that `LIVE_EXECUTION_ALLOWED=false` does not stop shadow orchestration and that the
39 blocking `legacy_pending` accounting heads are checked only by live PostgreSQL admission. A disposable
PostgreSQL integration test reproduced one blocking `legacy_pending` head: live admission was rejected with
`circuit_breaker_active`, while shadow admission was accepted in the same durable state.

The inspection also found a separate systematic blocker. Gamma `startDate` is the recurring market listing creation
timestamp, currently about one day before the actual 15-minute slot for all seven assets. The final identity policy
therefore rejected every eligible candidate as `polymarket_identity_mismatch`; BNB recorded 22 such shadow rejections
between 14:23:58 and 14:24:15 UTC.

The fix normalizes tradable Polymarket reference times from the canonical slot while retaining exact Gamma slug and
end-time validation. Unit coverage exercises the real shifted `startDate` shape and verifies final feed references.
The focused unit suite and isolated PostgreSQL proof pass. Deployment must keep the live gate false; no accounting row
or trading threshold needs to change.
