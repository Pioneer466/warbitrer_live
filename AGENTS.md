# Warbitrer - Codex Instructions

## Mission

Warbitrer monitors and can trade 15-minute crypto direction markets shared by Polymarket and Kalshi.
It is a real-money system. Correctness, execution safety, observability, and reproducible operations take priority over speed of development.

## Required reading order

Before changing code:

1. Read `README.md`.
2. Read `README-CODEX-CONTEXT.md`.
3. Read `docs/codex/project-overview.md`.
4. Read `docs/codex/architecture.md`.
5. Read `docs/codex/trading-safety.md`.
6. Read `docs/codex/session-handoff.md`.
7. Inspect the relevant implementation and tests before proposing changes.

Do not assume the generic recommendations in old prompts are implemented. The code and current handoff are authoritative.

## Repository facts

- Runtime: Node.js 22+, TypeScript, Next.js 15, React 19.
- State: Postgres only. There is no Docker or SQLite runtime.
- Market data: Polymarket and Kalshi WebSockets with REST bootstrap/resync.
- Worker topology: one `asset-live` process per active asset, plus a reconciler and notifier.
- Active worker assets: BTC, ETH, SOL, XRP, DOGE.
- BNB and HYPE exist in the catalog/UI/config but are not in `ACTIVE_MARKET_ASSETS`.
- Strategy configuration is stored in Postgres, not environment variables.
- Production deployment: `systemd` + Caddy + local Postgres on a VPS.
- Database schema changes are checksummed, forward-only migrations defined in `src/lib/postgres-db.ts`.
- Migrations V1-V8 are applied explicitly with `npm run db:migrate` and verified with `npm run db:status`; runtime processes only verify compatibility.

## Standard workflow

For code tasks:

1. Summarize current understanding and safety impact.
2. Identify the smallest safe change.
3. Check the working tree and preserve unrelated changes.
4. Implement focused code and deterministic tests.
5. Run the smallest relevant check, then broaden based on risk.
6. Update `docs/codex/session-handoff.md` for significant work.

Never deploy, push, commit, clear breakers, close intents, restore a database, or execute recovery actions unless explicitly requested.

## Trading safety

Treat order placement, credentials, balances, positions, settings, circuit breakers, settlement, recovery, and Polymarket conversion as high risk.

Current execution modes are stored per asset:

- `enableTrading=false`: scan only.
- `enableTrading=true`, `shadowMode=true`: synthetic intents/orders/fills.
- `enableTrading=true`, `shadowMode=false`: real orders.

Live mode has an independent, fail-closed environment authorization gate. Real execution requires both an effective live strategy configuration and `LIVE_EXECUTION_ALLOWED=true`; keep the environment gate false while market data, reconciliation, or deployment state is uncertain.

Production API mutations require application Basic Auth and reject cross-site browser requests. Caddy Basic Auth remains an independent external defense and does not replace application authentication.

Before any live order, preserve or strengthen:

- fresh aligned venue data
- circuit-breaker checks
- balance and exposure checks
- maximum pair notional
- depth and minimum-size checks
- projected profit and return thresholds
- bounded slippage, retries, confirmation timeouts, rescue, and unwind
- durable order attempts, fills, run events, and reconciliation

Never infer that an HTTP response alone proves an order did or did not fill. Reconciliation and venue truth are part of the execution contract.

## Credentials and sensitive material

- Never print or commit `.env`, private keys, API secrets, database dumps, backup archives, auth passwords, cookies, or complete auth headers.
- Use `.env.example` and `deploy/vps/warbitrer.env.example` only as schemas.
- Check secret presence/readability without printing values.
- Prior operational history is summarized in `docs/codex/session-handoff.md`; do not recreate or commit raw transcripts containing credentials.
- Do not inspect backup contents beyond what is required and approved.

## Architecture boundaries

The repository is not split into idealized connector/strategy packages. Respect the existing boundaries:

- `src/lib/market-data.ts`: realtime feed state and normalization
- `src/lib/kalshi.ts`, `src/lib/polymarket.ts`: venue REST/auth/order adapters
- `src/lib/signals.ts`, `fees.ts`, `primary-selection.ts`, `risk.ts`: deterministic strategy/risk logic
- `src/lib/engine.ts`: orchestration, execution, recovery, reconciliation
- `src/lib/postgres-db.ts`, `storage.ts`: persistence
- `src/worker`: process roles and loop lifecycle
- `src/app`, `src/components`: operator UI/API

Avoid expanding `engine.ts` unless the change truly belongs in orchestration. Do not mix UI changes with execution behavior without a clear reason.

## WebSocket work

For Kalshi or Polymarket changes, check:

- environment and endpoint
- authenticated handshake/signing path
- subscription command and acknowledgement
- error and close payloads
- snapshot-before-delta behavior
- sequence continuity using the full WS envelope
- reconnect/resubscribe behavior
- stale-data fallback and breaker behavior
- rate-limit handling and REST request fan-out

Use fixture messages. Do not require live APIs in automated tests.

## Commands

Install and verify:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run build:worker
```

Local development requires Postgres and environment variables visible to both processes. Next loads `.env.local`; the standalone worker does not automatically do so:

```bash
# terminal 1
npm run dev

# terminal 2
node --env-file=.env.local --import tsx src/worker/index.ts
```

There is no Docker workflow in this repository.

## Production topology

Canonical services:

- `warbitrer-web`
- `warbitrer-asset@btc`
- `warbitrer-asset@eth`
- `warbitrer-asset@sol`
- `warbitrer-asset@xrp`
- `warbitrer-asset@doge`
- `warbitrer-reconciler`
- `warbitrer-notifier`
- `warbitrer-postgres-backup.timer`

The VPS does not use a combined `warbitrer-worker` service. `deploy/vps/deploy.sh` targets the split topology, creates a database backup, stops all application services, runs verification and both builds, applies migrations, verifies schema status, then starts and checks every split service.

Do not deploy while any live intent, live order attempt, or capital exposure is non-terminal. This is especially important across client-order-ID changes: reconcile venue truth first and never repair the state by editing Postgres manually.

## SSH access constraint

Password-based SSH access must remain available for the operator. Repository code, documentation, and deployment scripts must not modify `sshd`, change `PasswordAuthentication`, rotate SSH credentials, or impose key-only access. SSH keys are optional and may coexist with password login.

## Documentation continuity

After meaningful work, update `docs/codex/session-handoff.md` with:

- objective and current state
- files modified
- commands and tests
- blockers and risks
- decisions and next steps
- no secrets
