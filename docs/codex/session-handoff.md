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

## 2026-07-17 - Shadow execution realism

### Objective and evidence

The shadow executor was audited after analyzing `warbitrer-mismatch-20260717T170222Z.tar.gz`. The archive contained 408 exact mismatch-audited intents but only 75 independent asset/slot/combination situations. The old shadow path filled both legs completely at the requested price in 1 ms and allowed repeated hedged entries, materially overstating trade count and executable P&L.

### Implemented behavior

- New deterministic model `rest-orderbook-v2` in `src/lib/shadow-execution.ts`.
- A shadow intent is persisted as `executing_primary` with two pending `SHADOW_REST_IOC` orders. Full Polymarket and Kalshi books are fetched immediately and in parallel, rather than being observed only after a delay.
- A prepared fill completes no earlier than 15 seconds after intent creation to represent order/confirmation time. REST failures and immediately demonstrable `no_fill` decisions terminate without an artificial wait.
- Quotes apply configured venue depth safety factors and headroom, original price/slippage limits, multi-level VWAP, venue fees, pair/leg capital limits, and profit/return thresholds.
- The simulator fills only the common executable integer pair size. It records a partial paired fill when sufficient minimum size remains, otherwise `no_fill`.
- Degraded/unaligned feeds, missing books, price movement beyond the limit, insufficient common depth, and invalid delayed economics are durable `no_fill` reasons.
- Only in-flight shadow intents block another attempt on the same asset. After every completed attempt, a durable 60-second cooldown replaces the previous one-intent-per-slot ceiling.
- Pending shadow work is resumed from Postgres after normal loop iterations or worker restart and is excluded from live venue reconciliation.
- Audit data is stored in `order_intents.shadow_execution_json` and shown in `/trades`, including model version, REST duration, total latency, next eligible time, fill ratio, realized gross cost, and rejection reason.
- Live order submission, confirmation, rescue, unwind, and global live execution locking were not changed.

### Modified files

- `src/lib/shadow-execution.ts`
- `src/lib/engine.ts`
- `src/lib/risk.ts`
- `src/lib/types.ts`
- `src/lib/postgres-db.ts`
- `src/components/trades-client.tsx`
- `tests/shadow-execution.test.ts`
- `tests/risk.test.ts`
- `tests/postgres-db.test.ts`
- `README.md`
- `docs/codex/session-handoff.md`

### Verification and remaining limits

- `npm run typecheck`: passed.
- `npm test`: 32 files and 388 tests passed.
- `npm run build`: passed (Next.js production build).
- `npm run build:worker`: passed (Node 22 worker bundle).
- No live venue call or production database integration test was run.
- This v2 model is intentionally conservative but still models both legs from one immediate paired REST capture. It does not yet replay sub-second queue position, adverse movement between primary and hedge, or real account-specific fill probability.
- Keep trading and mismatch risk in shadow until delayed fill/no-fill distributions have been observed across several days. Do not compare new trade counts directly with the old instant-fill dataset.
