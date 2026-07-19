# Iteration 01 - Safety gates and verification baseline

Date: 2026-07-19

Branch: `review/global-hardening-2026-07-19`

## Scores

- Code quality: **3/5**
- Canary readiness: **3/5**

The application now has enforceable build gates and independent live-execution authorization. It is not yet safe enough for a real-money canary because submission truth, reconciliation, breaker ownership, and persistence atomicity still have high-severity gaps.

## Implemented

- Added the fail-closed `LIVE_EXECUTION_ALLOWED` environment gate.
- Required `KALSHI_ENV=prod` before a new live pair can start.
- Rejected blocked live settings server-side, including assets without an active worker.
- Rechecked settings and the environment gate immediately before primary submission.
- Kept hedge, unwind, and recovery paths available when new live entries are disabled.
- Made production Basic Auth fail closed when credentials are absent or partial.
- Hardened malformed Basic Auth parsing and added authentication tests.
- Exposed live authorization state in `/api/health` and tightened its readiness result.
- Added a confirmation step and server-derived disabled state to the live UI control.
- Added ESLint, Prettier, coverage, production dependency audit, and GitHub Actions verification.
- Updated compatible direct dependencies and pinned vulnerable transitive `form-data` and `ws` versions.

## Verification

- TypeScript typecheck: passed.
- Unit and characterization tests: 35 files, 413 tests passed.
- Targeted authentication/live-gate tests: 15 passed.
- Coverage: 38.10% lines/statements, 52.06% functions, 68.27% branches.
- ESLint: passed with 123 recorded warnings and no errors.
- Next.js production build: passed on 15.5.20.
- Worker production bundle: passed, 763.5 kB.
- Production dependency audit: 22 findings (2 high, 3 moderate, 17 low), down from 25 findings (5 high, 7 moderate, 13 low).
- Remaining high findings are confined to `@polymarket/builder-relayer-client` and its Axios path; no compatible upstream fix is currently available, so they are explicit temporary exceptions rather than silently ignored findings.

## Independent review findings still open

1. A venue may accept an order before the process crashes and before `venue_orders` is persisted. The current restart path can later mark that intent failed without proving venue truth.
2. Kalshi recovery converts lookup failures to an empty result, conflating an unavailable API with an absent order.
3. Polymarket soft no-fill recovery treats elapsed time as proof of no fill.
4. Health still needs heartbeat and snapshot freshness checks, breaker awareness, and a non-200 degraded status contract.
5. Settings updates need optimistic concurrency, durable audit records, and transactional bulk writes.
6. Global breaker causes overwrite each other because they share one key.
7. Settlement requires stronger finality checks on both venues.
8. The codebase still has 123 lint warnings and legacy formatting debt; a full formatting pass is intentionally deferred to a standalone mechanical commit.
9. Production password SSH access remains enabled by explicit owner requirement. The added SSH public key is only an alternative access method.

## Decision

Shadow operation remains the only approved runtime mode. No VPS deployment or live canary is authorized by this iteration. Iteration 02 must make unknown submission truth durable and fail closed before any score can reach 4/5.
