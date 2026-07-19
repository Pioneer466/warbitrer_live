# Iteration 00 - Baseline

Date: 2026-07-19

Branch: `review/global-hardening-2026-07-19`

Base commit: `a960b41f56e93fdef980ac256661b1d438f79a5b`

## Scores

- Code quality: **2/5**
- Canary readiness: **2/5**

The project has a working baseline, but strict 5/5 gates are not met. Passing builds do not compensate for unresolved production security, integration, architecture, persistence, and live-safety risks.

## Verified baseline

- Node.js target: 22
- TypeScript typecheck: passed
- Unit tests: 32 files, 398 tests passed
- Next.js production build: passed
- Worker production bundle: passed, 761.1 kB
- VPS web, five asset workers, reconciler, and notifier: active on the base commit
- VPS execution mode: shadow remains the required operating mode
- SSH password authentication remains enabled by explicit owner request; a public key was added as a non-exclusive fallback

## Measured risks

- Production dependency audit: 25 findings (5 high, 7 moderate, 13 low)
- Directly relevant high-risk dependency paths include Next.js, `ws`, Polymarket relayer dependencies, Axios, and `form-data`
- No GitHub Actions workflow, project lint configuration, browser test suite, or real PostgreSQL integration suite
- Approximately 53,420 lines across TypeScript and deployment scripts
- `src/lib/engine.ts`: 12,620 lines
- `src/lib/postgres-db.ts`: 3,350 lines with startup `CREATE TABLE` and `ALTER TABLE` statements rather than versioned migrations
- `src/lib/market-data.ts`: 3,084 lines and multiple long-lived WebSocket responsibilities
- Authentication is optional and fails open when application Basic Auth variables are absent
- Database trading configuration can switch directly from shadow to live without an independent environment authorization gate
- The current mismatch risk model is uncalibrated and must not be treated as positive live authorization

## Existing live-risk blockers

1. Post-slot Polymarket exits are too permissive.
2. Pending confirmations need a second authoritative reconciliation pass.
3. Reserved capital does not fully cover hedging and `unwind_required` states.
4. Polymarket best-bid/ask updates can drift from depth maps.
5. Application authentication depends too heavily on the proxy configuration.
6. Bridge low-water monitoring is informational rather than enforcing.
7. A dormant Polymarket-primary execution path increases untested surface area.

## Iteration result

Commit `532794d` keeps local backups and TypeScript build metadata out of Git. No trading behavior changed. The next iteration must introduce an independent live gate, fail-closed production authentication, CI, targeted dependency upgrades, and characterization tests before deeper refactoring.
