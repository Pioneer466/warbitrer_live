# Warbitrer - Codex Session Handoff

## Current State

- Date: 2026-08-07, Asia/Jerusalem
- Production branch: `main`
- Production runtime commit: `e5cc002b19c06a2cea9b0fbf2e91038d67498f5d`
- Local review branch: `review/global-hardening-2026-07-19`
- Target runtime: Node 22, Next.js 15.5.21, PostgreSQL 18
- Production topology: web, seven asset workers, reconciler, notifier, Postgres, and Caddy
- Active production assets expected by the service topology: BTC, ETH, SOL, XRP, DOGE, BNB, HYPE
- Review status: repository rubric completed at 5/5 in `docs/reviews/global-2026-07/iteration-07-final.md`
- Deployment status: V3 shadow fill replay is fixed and deployed; all seven assets are healthy in shadow mode
- Live authorization: `LIVE_EXECUTION_ALLOWED=false`; every asset has `enableTrading=true` and `shadowMode=true`

The global hardening review, V10 mismatch-efficiency work, and V3 shadow fill replay correction are committed,
pushed, and deployed. Real execution remains disabled. Calibration activation remains at revision 0 with no
artifact, and the 39 historical `legacy_pending` accounting heads continue to block runtime live admission.

## Weighted Leg Price Opening - 2026-08-07 (Local, Not Deployed)

The local review branch changes the default absolute per-leg entry cap from `0.49` to `0.70`. The existing
fee-aware balanced-payout sizing remains authoritative: gross pair cost must stay at or below the configured
threshold, total pair cost must fit `maxPairNotionalUsd`, and each venue cost must fit
`maxLegCapitalShare` (currently `0.70`). Depth haircuts/headroom, minimum sizes, net profit/return floors,
worst-fill profit, balances, exposure, mismatch policy, and execution buffers are unchanged. This admits the
intended `0.60 + 0.30` shape while retaining an absolute wall against extreme pairs such as `0.71 + 0.19`.

The weighted-leg implementation originally introduced by `983c8b2` was already present; the blocking behavior came
from the later absolute `0.49` wall and its REST/worst-fill enforcement. Regression coverage now proves the new
default at settings normalization, exact multi-level signal sizing, REST paired preflight, and final worst-fill
validation. Local verification passed typecheck, lint, format check, 1,029 tests (131 conditional PostgreSQL tests
skipped without `TEST_DATABASE_URL`), the Next.js production build, the worker build, and `git diff --check`.

Production still stores `maxLegPrice=0.49` in its versioned Postgres strategy configurations. Deployment of the code
alone must not silently rewrite that high-risk setting. A later explicitly authorized rollout must update the seven
asset configurations through the authenticated audited bulk-settings transaction, initially while every asset
remains shadow-only and `LIVE_EXECUTION_ALLOWED=false`.

The same read-only production review found that calibration data volume is no longer the limiting factor: a
chronological SQL reconstruction produced 138,846 labels and a 31,526-label holdout with raw AUC `0.8467`; every
curve exceeded the required raw AUC floor. The standard calibration CLI instead fails at current volume with
`Maximum call stack size exceeded`, consistent with its use of spread-based `Math.min`/`Math.max` over the full
observation arrays. No artifact was persisted or activated. The next calibration change should make extrema
streaming/reducer-based, add a production-scale deterministic fixture, complete calibrated holdout metrics, and
evaluate a candidate-conditioned layer by horizon, asset, combination, and leg-price asymmetry before any live
decision.

## V3 Shadow Fill Replay Incident - 2026-08-03 (Deployed and Recovered)

Three shadow intents became durably stuck in `executing_primary`: BTC
`e2c79b25-5d7a-4ee1-8e37-749b53a79de6`, BNB `1b719f87-a792-4f3e-b051-6c3df93fc329`, and ETH
`1fac9eab-db42-41f0-ac67-2dcc960367e5`. Each had a valid filled `rest-paired-preflight-v3` audit and two filled
synthetic venue-order projections, but zero durable fills. Their asset workers repeatedly failed accounting
ingestion with `fill price has more than 8 decimal places`, leaving authenticated readiness at HTTP 503 for BTC,
ETH, and BNB. SOL, XRP, DOGE, and HYPE remained healthy. Every affected intent was shadow-only, the independent live
gate was false, and a V10 preflight found no unresolved live attempt, open live venue order, economically active
live position, owned live reservation, or active breaker. The 39 historical `legacy_pending` heads remained the
only known live blocker.

The durable proof stores a canonical leg notional, but replay previously reconstructed its fill price with raw
JavaScript division. Production values such as `4.9 / 10`, `4.352 / 10`, `8.8 / 20`, and `9.4 / 20` become binary
artifacts such as `0.49000000000000005`; exact accounting correctly rejects those inputs beyond its 1e-8 scale.
`getPreparedShadowRestFillEconomics` now quantizes only the derived price to the exported accounting scale. It does
not weaken accounting validation, mutate the durable proof, change the proof schema/model, or refetch venue data.
Existing V3 proofs can therefore replay deterministically through the normal resume path.

Regression coverage reproduces the production-style `0.44000000000000006` and `0.49000000000000005` values after a
JSON persistence round trip and verifies canonical `0.44` and `0.49` fills while bounding the notional rounding
error. Focused shadow, REST-preflight, engine, and accounting-runtime coverage passed 214 tests. Full local
verification passed the production audit, lint, format, typecheck, 1,026 non-Postgres tests, Next.js build, and
worker build. The 131 conditional PostgreSQL tests were skipped because no local test database was available; the
local Docker daemon was non-responsive and was not force-restarted. The rollout therefore used scan-only and the
canonical stopped-service path, then treated successful production proof replay and accounting/readiness checks as
mandatory gates before restoring shadow mode.

The fix was committed as `f141656df9cfa9a46a33952096804a63c8622b40`, pushed explicitly to `main`, and pulled
onto the clean production worktree. Before deployment, all seven assets were atomically switched to scan-only while
retaining `shadowMode=true` and `entryCutoffSeconds=60`. The V10 deployment preflight confirmed the live gate was
disabled and that unresolved live attempts, open live venue orders, economically active live positions, and owned
live reservations were all zero. The known 39 historical heads remained the only live-admission blocker.

The canonical deploy stopped all ten application services, repeated the preflight, created the quiescent
`warbitrer_live_20260803T203400Z.dump` backup, ran audit, lint, formatting, typecheck, 1,026 tests, both builds,
schema migration/status checks, and the final preflight, then passed four service-stability rounds. Schema V10 and
all migration checksums were unchanged. Backup retention left three dumps; the 59 GB root filesystem finished at
49% usage with about 29 GB free.

On restart, the ordinary durable-proof resume path completed all three intents without a REST refetch or manual
database edit. BNB, BTC, and ETH are now `settled`; each has two filled venue orders, two durable fills, two final
accounting fill facts, and a `stable` accounting head at revision 1. The recovered prices are exactly representable
at scale 1e-8: BNB `0.4352`/`0.49`, BTC `0.44591`/`0.47`, and ETH `0.49`/`0.44`. No
`AccountingPersistenceError` or excessive-decimal message recurred after deployment.

After a clean post-recovery preflight, all seven assets were restored atomically to `enableTrading=true` and
`shadowMode=true`, retaining the 60-second cutoff. BTC, ETH, SOL, XRP, and DOGE are at configuration revision 5;
BNB and HYPE are at revision 6. Four consecutive authenticated readiness samples returned HTTP 200 with all seven
assets healthy, all fourteen venue feeds ready, fresh scan/execute/snapshot timestamps, no active breaker, and
`liveExecutionAllowed=false`. All ten application services remained active with zero restarts, and the final
preflight again reported zero unresolved live attempt, open live venue order, economically active live position, or
owned live reservation. Password-based SSH access and protected credentials were not modified.

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

The application fix was committed as `6b5e55936cd66d7f762e50ea4b59f2b53187bbe6`, pushed to `main`, and deployed
on 2026-07-25 with the canonical VPS script. An initial invocation was refused safely at the first preflight because
the root `sudo -E` invocation did not preserve the historical-shadow override; no service had stopped. The corrected
root invocation passed all three V9 preflights, created a fresh Postgres backup, repeated the production audit, lint,
format check, typecheck, 916 tests, both builds, migration/status checks, and four service-stability rounds.

Post-deployment health was `healthy` with no active breaker, all ten application services had zero restarts, the
backup timer was active, `LIVE_EXECUTION_ALLOWED=false`, and every asset remained shadow-only with a 60-second entry
cutoff. BNB and HYPE immediately subscribed to the public RTDS relay and accumulated observations. Because the
restart occurred after the current slot began, that slot correctly reported `chainlink_start_unavailable`; at the
next 15-minute rollover both assets captured a non-null Chainlink opening price, returned `reason=null`, and produced
non-null P-fatal and conservative P&L estimates.

A later 45-second production sample on 2026-07-27 found the diagnostic available for all 30/30 snapshots, no
subscription failure, and strict execution freshness usable for 26/30 BNB and 25/30 HYPE snapshots. The remaining
snapshots were conservatively rejected as `chainlink_stale` when a public RTDS tick exceeded the unchanged 2.5-second
execution threshold. The same control sample produced 22/30 for BTC and 28/30 for ETH, confirming that this
inter-tick fail-closed behavior is common to the public relay and not a BNB/HYPE transport defect. No oracle
freshness threshold was loosened.

The backup completed with the configured three-file retention, but the 40 GB root volume remained 90% used with
about 4.1 GB free and 4.0 GB of Postgres dumps; monitor capacity before future large backups. A read-only
`systemctl status` diagnostic also exposed the Postgres connection credential in the private operator transcript
because `pg_dump` received the URL on its command line. Do not copy that value into issues or documentation. Rotate
the production database password and update the protected environment file in a separately authorized maintenance
window; no credential was changed during this rollout.

## Production Capacity Incident and Recovery - 2026-07-28

Production returned `connect ECONNREFUSED 127.0.0.1:5432` after the original 40 GB root volume reached 100%.
PostgreSQL first reported write failures while the scheduled 03:15 UTC backup was creating a fourth dump, then
panicked at 04:53 UTC because it could not write a temporary WAL file. Recovery also failed until more disk became
available. SOL, the reconciler, and the notifier entered systemd restart loops while PostgreSQL was unavailable.
The independent live gate remained `false`, so the outage stayed fail-closed for real execution.

The database occupied about 20.5 GB. `opportunity_snapshots` alone used about 18.1 GB, including roughly 15 GB in its
TOAST table, because seven workers persist complete JSON snapshots every second and the effective retention window
was 72 hours. `oracle_slot_samples` used another 1.4 GB. The failed backup service left a roughly 1.0 GB dump that
could not be trusted; the backup script only prunes old complete-name dumps after a successful new dump.

The operator expanded the root volume to 59 GB. After the reboot, PostgreSQL recovered automatically. All ten
application services were stopped before maintenance, schema V9 status and the shadow-only deployment preflight
passed, and a fresh pre-maintenance backup was created and validated. The protected production environment now sets
`DB_RETENTION_SNAPSHOTS_HOURS=24`; no credential or trading setting changed.

The maintenance deleted 1,088,517 `opportunity_snapshots` rows older than the fixed 24-hour cutoff in batches of
5,000, leaving 398,177 rows. A targeted `VACUUM FULL ANALYZE opportunity_snapshots` reduced the table from about
17 GB after deletion to about 4.17 GB. The full database now reports about 6.85 GB. A second validated
post-maintenance backup was created; the known failed partial dump was then deleted. Three validated dumps remain.
The root volume finished at 42% usage with about 34 GB free.

The post-maintenance V9 preflight again reported zero unresolved live attempts, open live venue orders, economically
active live positions, and owned live reservations; the 39 historical legacy accounting defects remain the only
live-admission blocker. All ten application services passed four stability rounds with zero restarts, the backup
timer is active, health is `healthy`, and there are no active breakers. All seven assets remain shadow-only with
60-second entry cutoffs. BNB/HYPE RTDS and CF feeds returned ready immediately; because workers restarted mid-slot,
their opening Chainlink value and mismatch model remain unavailable only until the next 15-minute rollover.

No repository code changed during this recovery. A future versioned hardening change should make backups write to a
partial suffix and atomically rename only after success, reserve capacity before `pg_dump`, and add disk-capacity
alerting. Do not manually alter the checksummed PostgreSQL schema to tune autovacuum; use a forward migration if
table-specific storage settings are later required.

## Mismatch History Recovery and Analysis - 2026-07-28

The mismatch analysis froze a reproducible 72-hour window from 2026-07-25 16:30 UTC through 2026-07-28 16:30 UTC.
Postgres contained 243 dual-finalized resolution slots per asset. The capacity outage and maintenance left two common
gaps on 2026-07-28, 05:00-10:45 UTC and 11:00-16:30 UTC, with the 10:45 slot present between them. A read-only
official-API recovery fetched 46 slots per asset across the affected range. All 322 recovered rows were dual
finalized with no benchmark/result conflict; the seven 10:45 overlap rows exactly matched Postgres. Deduplication
therefore added 45 slots per asset and produced 288 complete slots per asset without writing to production.

The recovered 72-hour set contains 146 mismatches across 2,016 asset-slots (7.24%). Direction is exactly balanced:
73 Poly DOWN/Kalshi YES and 73 Poly UP/Kalshi NO. Per-asset rates are BTC 5.90%, ETH 3.47%, SOL 7.64%, XRP 7.99%,
DOGE 10.76%, BNB 8.33%, and HYPE 6.60%. A longer 489-slot common window beginning 2026-07-23 14:15 UTC has rates
between 6.13% and 9.82%, so the recent values are broadly consistent with the retained history. Mismatches cluster
in time: the observed cross-asset mismatch-count variance is 1.35 times the independent-asset variance, although the
largest pairwise phi correlation is only about 0.20.

The uncalibrated structural model was evaluated from persisted observations at 5m, 3m, 2m, 1m, and 30s before close.
At 3m its mismatch AUC is 0.796 and Brier score 0.0735; at 1m these improve to 0.877 and 0.0580. The highest-risk
decile captures 49.1% of mismatches at 1m versus 28.7% at 3m. At 30s discrimination improves again, but mean
predicted mismatch falls below the observed rate and diagnostic log-loss worsens, so the model must remain shadow
and `uncalibrated`. The 60-second cutoff is supported; the data do not authorize enforcement.

The 21 BNB and 21 HYPE `chainlink_unavailable` 60-second observations all precede the public RTDS fix and end at
2026-07-25 21:30 UTC. No later recurrence appears in the evaluated data. Two HYPE
`final_minute_average_unavailable` observations occur exactly at the 60-second boundary and recover within 2-3
seconds as the first CF final-minute samples arrive; they are not persistent feed outages. Separately, 376 of 1,625
diagnostically available 60-second estimates were strict-execution unusable as `chainlink_stale`. Do not loosen the
gate; instrument source age on otherwise admissible opportunities first.

Artifacts are under `reports/mismatch/`, with the human report in
`reports/mismatch/mismatch-analysis-20260728.md`. Reproducible read-only tooling is in
`scripts/fetch-official-mismatch-history.mjs` and `scripts/analyze-mismatch-history.mjs`. The analysis scripts passed
`node --check`; the final CSV contains 2,016 data rows, the official overlap has zero conflicts, and primary artifact
SHA-256 hashes are recorded in the report. The external resolutions were intentionally not inserted into Postgres
because the missing live ticks cannot be reconstructed and no production mutation was required for the analysis.

## Mismatch Efficiency Hardening - 2026-08-02 (Deployed Shadow-Only)

Commit `27f121aef0c06c3dba45f880a8ebbbec233f1ed5` implements the approved shadow-first correction after the historical
review found 1,265 shadow intents but only 179 synthetic fills over 14 days. Of the 1,086 no-fills, 1,072 were classified as
`price_moved_beyond_limit`: the simulator anchored a 30 bps limit to the earlier WebSocket signal even though its
decisive REST books arrived about half a second later. The apparent 15-second execution latency was only an
artificial completion delay and did not provide later fill evidence. The 179 settled synthetic fills were also not
strong enough to authorize live trading: actual P&L was positive in aggregate, but a conservative cap of double
payouts at aligned payout was negative, the chronological second half was negative, and selected-fill mismatch AUC
was close to random. Real execution remains unauthorized.

Shadow candidate handling now captures complete Polymarket and Kalshi REST books before admission, uses
authoritative ticks and absolute leg caps rather than signal-relative slippage, searches the largest common size
that passes depth, headroom, fee, pair/leg budget, profit, return, and worst-fill checks, then recomputes mismatch
risk on those exact worst-fill economics. A REST-rejected candidate is stored as immutable probe evidence but does
not create a synthetic intent. An admitted synthetic fill reuses the same captured proof and is finalized
immediately; its leg size, canonical notional, fee, total cost, and implied price are bound to the durable
`rest-paired-preflight-proof-v2` evidence. Full books and consumed levels are bounded with counts, ranges, and
SHA-256 digests. Only the explicit legacy `rest-orderbook-v2` model may use the old replay path; malformed proof,
proof on a legacy-shaped audit, or any unknown model version fails before order or fill facts are written. A REST
capture finishing at or after slot end is rejected as `slot_ended_during_rest_capture`. The durable 60-second
re-entry cooldown is unchanged. Live execution keeps its existing WebSocket, admission, reservation, and submission
contract and does not use this shadow rollout to authorize an order.

Observation-only late-entry probes run once per asset/slot at 55, 45, 35, 25, 15, and 5 seconds while the asset is
in shadow mode. They evaluate both combinations over a fixed matrix of absolute price caps (0.49, 0.60, 0.70,
0.99) and mismatch safety fractions (0.50, 0.75, 1.00). They never create an intent, reservation, order, or fill.
Probe facts are immutable, survive process restarts by stable keys, and have a fixed 45-day maintenance retention.
The production entry cutoff remains 60 seconds until this evidence demonstrates a safer alternative.

V10 `mismatch_calibration_evidence` adds immutable probe facts, immutable calibration artifacts, and a singleton
activation state with append-only, hash-bound, monotone activation events. Direct state mutation without the
matching event is rejected by database triggers. Admission and the one-shot live claim both bind the expected
calibration artifact and revision, so an activation race cannot silently change the entry policy. The calibration
core builds exactly 12 deterministic horizon/combination PAVA curves with Jeffreys posteriors and monotone upper-95
bounds. Its conservative interval applies a cross-asset design effect of 7 for clustered slot outcomes while the
mean still uses all observations. Activation eligibility requires minimum counts and span, a strict chronological
holdout, bounded activation lag, complete per-curve provenance, and AUC/Brier/log-loss thresholds. The validation
artifact is embedded and revalidated at runtime; persistence timestamps are deterministic so an identical rerun is
idempotent. Runtime use is fail-closed: no active artifact retains the explicit `uncalibrated` model, while an
invalid or incompatible active artifact makes the estimate execution-unusable. The read-only-by-default
`npm run mismatch:calibrate` command uses dual official resolutions and actual observation bands; `--persist`
stores a full-window artifact but never activates it. No artifact is currently active.

The global mismatch probability limit is no longer a hidden fixed constant. The versioned global-risk payload now
contains `mismatchFatalBudgetFractionOfAlignedMargin` with a backward-compatible default of 0.50. Signal sizing,
execution policy, counterfactual audit, and the operator display use the same value. The UI also distinguishes the
active risk mode from the counterfactual `block_only` audit and explains a 0% maximum when aligned margin is not
positive. The obsolete fixed 0.50 pre-sizing and WS-resize rejections were removed, leaving one authoritative final
policy check; tests cover a candidate accepted at 0.80 and rejected at 0.50, plus the final resize path.

The V10 deployment preflight accepts a clean V9 state before migration but rejects partial V10 state. On V10 it
validates exact column types/nullability/defaults, required PK/UNIQUE/FK/CHECK constraints, probe indexes, trigger
placement and flags, the five critical PL/pgSQL function bodies, the activation singleton, every hash-bound event in
the monotone activation chain, and active-artifact eligibility. A PostgreSQL integration test creates a real V9
admission, applies V10, and checks the backfilled null-artifact/revision-zero binding. It passed as part of the
complete 1,156-test suite against disposable PostgreSQL 18.4 before rollout.

Main implementation files are `src/lib/shadow-execution.ts`, `src/lib/entry-probes.ts`,
`src/lib/mismatch-calibration.ts`, `src/lib/engine.ts`, `src/lib/postgres-db.ts`, `src/lib/risk-settings.ts`, and
`src/components/mismatch-risk-view.tsx`. The calibration CLI is `scripts/calibrate-mismatch-risk.ts`. Production was
rolled out through the canonical stopped-service migration path with `LIVE_EXECUTION_ALLOWED=false`; no calibration
artifact was persisted or activated and no live order, position, reservation, breaker, or accounting state was
mutated. Residual limitation: recovery of a persisted V3 shadow proof currently runs through the normal scan/resume
loop; it reuses durable evidence without a REST refetch, but there is not yet a dedicated recovery-only loop when
scans repeatedly fail.

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

The first production preflight correctly ran before any service stop, but exposed an ordering defect: the deploy script checks live state before V1 migration while the preflight previously rejected every complete legacy database lacking `schema_migrations`. The preflight now accepts only the exact uninitialized V0 state (no applied history, every registered migration, currently V1-V10, pending, and no migration problems other than the missing history table and pending migrations). It still validates the required legacy table shape and durable live state before migration; initialized V0, partial schemas, history gaps, unknown migrations, and checksum mismatches remain blocked.

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
10. V10 `mismatch_calibration_evidence`

V1-V10 remain frozen. Any later schema change requires a new forward migration after V10.

## Historical Verification Baseline (Pre-V10)

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

## Local V10 Verification - 2026-08-02

```text
Production audit       0 high, 0 moderate, 17 low
ESLint                 passed, zero warnings
Prettier               passed repository-wide
TypeScript             passed
Full test suite        71 files, 1,156 tests passed
PostgreSQL 18.4        9 integration files passed
Next.js build          passed
Worker bundle          passed
git diff --check       passed
```

All nine conditional integration files ran against a local disposable PostgreSQL 18.4 container bound only to
loopback. They cover V9-admission-to-V10 migration, calibration persistence/activation concurrency, admission and
claim fencing, deployment preflight, accounting, configuration, breaker, CAS, and order truth. The first real-catalog
run exposed that `node-postgres` does not parse PostgreSQL `name[]` as a JavaScript array and that PostgreSQL shortens
one generated FK identifier; the preflight now casts catalog names to `text[]`, attests the actual identifier, and
has regression coverage. The final rerun passed all 1,156 tests with no skips. The V10 migration checksum remains
`d165c2d5bf3cbd93ad4d684b90e03ea4cc77409f9d0f163ac0e98912650fa375` and its deterministic
checksum test passed. No live venue request or production mutation occurred during this local verification.

## Production V10 Rollout - 2026-08-02

The verified implementation was committed as `27f121aef0c06c3dba45f880a8ebbbec233f1ed5`, pushed explicitly to
`main`, pulled onto the clean production `main` worktree, and deployed with `deploy/vps/deploy.sh`. Before shutdown,
all seven assets were atomically changed to scan-only while retaining `shadowMode=true` and the 60-second cutoff.
Under the transient `ALLOW_HISTORICAL_LEGACY_ACCOUNTING_DEPLOY=true` shadow-only override, the V9 preflight then
confirmed that the only blockers were the known 39 historical `legacy_pending` accounting heads: unresolved live
attempts, open live venue orders, economically active live positions, and owned live entry reservations were all
zero. The live environment gate remained disabled.

The canonical deployment stopped all ten application services, repeated the preflight, created a quiescent backup,
installed dependencies, ran the production audit, lint, repository formatting check, typecheck, tests, the Next.js
build, and the worker build, then applied V10 and validated its exact checksum. The VPS unit/runtime suite passed
1,025 tests; its 131 PostgreSQL integration tests were skipped because production intentionally has no
`TEST_DATABASE_URL`. Those same integration tests had already passed against disposable PostgreSQL 18.4 locally.
The post-migration V10 preflight re-attested the schema and the same zero counts for unresolved live attempts, open
live venue orders, economically active live positions, and owned live reservations, with the 39 historical heads
retained as a runtime live-entry block.

After restart, all ten services were active with zero restarts, the backup timer was waiting, liveness returned 200,
and authenticated readiness was healthy. Every Polymarket and Kalshi feed was `ready` from WebSocket data, including
BNB and HYPE; there were no active breakers or warning-or-higher application log lines in the initial post-restart
observation window. The root filesystem was 43% used with about 33 GB free. Three backup files occupied about
2.3 GB, including the fresh rollout backup.

The seven configurations were then restored atomically to shadow execution. BTC, ETH, SOL, XRP, and DOGE are at
revision 3; BNB and HYPE are at revision 4. Every configuration has `enableTrading=true`, `shadowMode=true`, and
`entryCutoffSeconds=60`. Four consecutive post-activation samples reported HTTP 200 health, seven ready workers,
fourteen ready WebSocket feeds, no breaker, and `liveExecutionAllowed=false`. Mismatch calibration remains inactive
at revision 0 with no persisted artifact or activation event. Password-based SSH access was not modified.

The first complete late-probe window then wrote 84 immutable observations: 12 per asset, covering both combinations
at each of 55, 45, 35, 25, 15, and 5 seconds. All were diagnostic rejections at the signal, REST, or risk stage; the
probe path created no live attempt, open venue order, economically active live position, or owned reservation. A
fresh V10 preflight confirmed those four zero counts after capture. At the next slot rollover, BNB and HYPE both
reported ready WebSocket feeds and two available, execution-fresh mismatch estimates with `reason=null`; the model
correctly remains `structural-ewma-gaussian-v1-uncalibrated` until independently reviewed evidence supports an
activation.

## Deployment Boundary

Use `deploy/vps/README.md` and `docs/codex/deployment.md`. The deploy script performs:

1. dirty-tree, commit, environment, and topology checks
2. live-state preflight before shutdown
3. stopped-service preflight and quiescent Postgres backup
4. install, audit, lint, format, typecheck, tests, and both builds
5. explicit V1-V10 migration and read-only schema status
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
2. Keep every production `entryCutoffSeconds` at 60 and leave the calibration activation at revision 0 with no
   artifact until probe evidence and an independently reviewed eligible artifact justify a later decision.
3. Observe late probes, the preflight rejection funnel, REST request rates, worker restarts, and
   storage growth across several days before calibrating or changing the cutoff.
4. Add a recovery-only pass for durable V3 shadow proofs if completion during prolonged scan/feed failure becomes a
   rollout requirement; the current normal scan/resume path is deterministic but can leave a shadow reservation
   open until scans recover.
5. Keep the 39 historical live-accounting blockers visible until exact evidence permits deterministic repair, and
   require a separate explicit live decision after that backlog is clean.

## Resume Prompt

```text
Read AGENTS.md, README.md, docs/codex/session-handoff.md, docs/codex/trading-safety.md, and docs/reviews/global-2026-07/iteration-07-final.md. Production is on main at the documented V10 shadow-only rollout. Preserve password-based VPS SSH access. Do not deploy or enable live trading without explicit approval. Observe the production probes and funnel before proposing a calibration or cutoff change.
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
