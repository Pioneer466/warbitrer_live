# Warbitrer - Codex Session Handoff

## Date

2026-07-14 (Europe/Paris)

## Current objective

Deploy and verify the implemented Kalshi WebSocket recovery fix on the VPS. Kalshi should use an authenticated WS orderbook as the primary quote source, with REST limited to discovery, bootstrap, resync, and cautious fallback.

Keep live trading disabled until this is verified.

## Repository state

- Branch: `main`
- HEAD: `53887fd` (`Document repository context and modernize TS paths`)
- Working tree: Kalshi WS fix implemented but not committed or deployed
- Remote tracking: `origin/main`
- Runtime: Node 22, Next.js 15, React 19, TypeScript 5.8, Postgres
- Active workers: BTC, ETH, SOL, XRP, DOGE
- BNB/HYPE exist in catalog/UI/config but are not active workers
- Production topology: Next.js web, per-asset workers, reconciler, notifier, Postgres, Caddy

This publication adds the repository-specific context files (`AGENTS.md`, `README-CODEX-CONTEXT.md`, and `docs/codex/`). The previous raw discussion was removed after its non-sensitive operational state was consolidated here.

## Last operational history

1. A new VPS was restored from a historical backup containing Postgres and service configuration.
2. Repository ownership and memory pressure caused failed `npm ci` runs; a 2 GB swap was recommended.
3. Portfolio UI/API support was added for displaying and closing manual-intervention intents.
4. Kalshi REST discovery was narrowed to the current/next slot and production REST/WS hosts were updated.
5. Kalshi still reportedly remained on REST bootstrap/fallback after deployment.
6. The final pasted VPS diagnostic was referenced by the old transcript but its content is not present in this repository.

## 2026-07-14 Kalshi assessment

- Kalshi's official endpoint, RSA-PSS signing path, subscription form, fixed-point payload fields, and ping/pong protocol match the integration.
- Historical code marked every WS message, including ACK/error, as realtime. That could report `ws` without receiving quote data.
- Commit `cd2d44e` changed unhealthy Kalshi REST resync from roughly 1 second to 4 seconds. This matches the observed approximately 3 second fallback latency but did not itself prove a WS protocol break.
- The current persistent failure mechanism was definite: protocol errors or an ACK-only socket could remain open forever, preventing `ensureWs()` from creating a new session.
- The recent source-selection correction exposed that state as `rest-bootstrap` instead of masking it as `ws`.

## Implemented fix

- Require a valid `orderbook_snapshot` before aggregate Kalshi source becomes `ws`.
- Close and reconnect on protocol error, malformed/missing snapshot, transport failure, heartbeat timeout, or orderbook sequence gap.
- Respect reconnect backoff even while the asset scan loop continues.
- Read snapshot/delta sequence from the official outer envelope.
- Keep the book live through ping/pong transport health after the initial snapshot.
- Alternate between the dedicated and officially supported shared WS hosts when initialization fails.
- Log sanitized `open`, `subscribe-sent`, `subscribed`, `orderbook-ready`, `session-failed`, `error`, and `close` lifecycle events.

## Remaining repository findings

- `deploy/vps/deploy.sh` is stale: it omits `build:worker` and restarts the legacy service.
- `.env.local` is loaded by Next.js but not automatically by the standalone worker.
- Live activation has no independent environment-level gate and application Basic Auth is optional.
- Codex docs were generic templates and have now been replaced with repository-specific context.
- Cursor's TypeScript 6 warning was caused by the now-deprecated `baseUrl` option. The line dated from the initial commit, not the current session. It was removed because `paths` already uses the explicit `./src/*` target.

## Files modified in the Kalshi fix

- `src/lib/constants.ts`
- `src/lib/kalshi.ts`
- `src/lib/market-data.ts`
- `tests/kalshi.test.ts`
- `tests/market-data.test.ts`
- `docs/codex/runbook.md`
- `docs/codex/websocket-debugging.md`
- `docs/codex/session-handoff.md`

No execution/order logic, trading setting, deployment script, or secret was changed.

## Commands and checks

```bash
git status --short --branch
node -p "require('typescript/package.json').version"
tsc --showConfig -p tsconfig.json
npm run typecheck
npm test
npm run build
npm run build:worker
```

Results after the Kalshi fix:

- TypeScript 5.8.3 configuration parsed successfully.
- Typecheck passed.
- 23 test files passed, 259 tests total.
- Next.js production build passed.
- Worker bundle build passed.

No live API or real Postgres integration test was run.

## Blockers

- The new worker bundle has not yet been deployed and observed against authenticated Kalshi production WS.
- Missing post-deploy sanitized `[kalshi-ws]` lifecycle logs from each asset worker.
- Live safety gate and deployment script still need correction before live use.

## Safest next steps

1. Keep `enableTrading=false` and preserve a global breaker during diagnosis.
2. Commit/push, pull on the VPS, run `npm ci`, `npm run build`, and `npm run build:worker`, then restart the split services.
3. Confirm each asset logs `open -> subscribe-sent -> subscribed -> orderbook-ready` and `/api/health` reports Kalshi source `ws`.
4. If initialization fails, use the first `protocol error`, `session-failed`, or `close` record as the root-cause evidence; do not increase REST polling.
5. Keep trading disabled through several slot rollovers and verify no recurring REST fallback or sequence gaps.
6. Correct the stale VPS deploy script and add a server-side live authorization gate before considering real trading.

## Resume prompt

```text
Read AGENTS.md, README.md, README-CODEX-CONTEXT.md, and docs/codex/session-handoff.md. Continue the unresolved Kalshi WebSocket diagnosis. Keep live trading disabled, do not print secrets, and do not modify execution logic until feed evidence identifies the smallest safe change.
```
