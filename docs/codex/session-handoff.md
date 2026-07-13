# Warbitrer - Codex Session Handoff

## Date

2026-07-13 (Europe/Paris)

## Current objective

Stabilize Kalshi WebSocket market data on the VPS. Kalshi should use authenticated WS data as the primary source, with REST limited to discovery, bootstrap, resync, and cautious fallback.

Keep live trading disabled until this is verified.

## Repository state

- Branch: `main`
- HEAD: `01b3ae0` (`upgraded kalshi rest-bootstrap and websocket dynamic to focus on ws`)
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

## Current findings

- Official endpoint/auth/subscription forms used by the current code are broadly valid.
- Kalshi WS protocol errors are not durable enough for production diagnosis.
- Kalshi outer-envelope sequence numbers are not passed to the delta gap detector.
- `deploy/vps/deploy.sh` is stale: it omits `build:worker` and restarts the legacy service.
- `.env.local` is loaded by Next.js but not automatically by the standalone worker.
- Live activation has no independent environment-level gate and application Basic Auth is optional.
- Codex docs were generic templates and have now been replaced with repository-specific context.
- Cursor's TypeScript 6 warning was caused by the now-deprecated `baseUrl` option. The line dated from the initial commit, not the current session. It was removed because `paths` already uses the explicit `./src/*` target.

## Files modified in this documentation pass

- `AGENTS.md`
- `README-CODEX-CONTEXT.md`
- all Markdown files under `docs/codex/`

No application source or deployment script was modified. `tsconfig.json` only had obsolete `baseUrl` removed; the `@/* -> ./src/*` mapping is unchanged.

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

Results from the repository audit:

- TypeScript 5.8.3 configuration parsed successfully.
- Typecheck passed.
- 23 test files passed, 257 tests total.
- Next.js production build passed.
- Worker bundle build passed.

No live API or real Postgres integration test was run.

## Blockers

- Missing sanitized final VPS Kalshi WS logs/error payload and close code.
- Unknown whether the worker bundle currently running on the VPS exactly matches `01b3ae0`.
- No durable WS protocol-error events in the current implementation.
- Live safety gate and deployment script still need correction before live use.

## Safest next steps

1. Keep `enableTrading=false` and preserve a global breaker during diagnosis.
2. Collect sanitized VPS service/build/feed evidence.
3. Add durable Kalshi WS open/ack/error/close observability.
4. Pass outer envelope sequence into orderbook delta handling and add full-envelope fixtures.
5. Run targeted tests, full suite, typecheck, and both builds.
6. Correct the VPS deploy script and environment loading.
7. Add a server-side live authorization gate before considering real trading.

## Resume prompt

```text
Read AGENTS.md, README.md, README-CODEX-CONTEXT.md, and docs/codex/session-handoff.md. Continue the unresolved Kalshi WebSocket diagnosis. Keep live trading disabled, do not print secrets, and do not modify execution logic until feed evidence identifies the smallest safe change.
```
