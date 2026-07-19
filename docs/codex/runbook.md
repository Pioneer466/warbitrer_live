# Warbitrer - Local Runbook

## Stack

- Node.js 22+
- npm with `package-lock.json`
- Next.js web application
- TypeScript worker processes
- Postgres

There is no Docker, Docker Compose, Python, SQLite, or Redis runtime. Postgres schema changes use the repository migration CLI.

## First checks

```bash
pwd
git status --short --branch
node --version
npm --version
test -f .env.local && echo '.env.local present' || echo '.env.local missing'
```

Do not print `.env.local` or use unfiltered `env`/`printenv` in shared output.

## Install

```bash
npm ci
```

Use `npm ci` for reproducibility. On a memory-constrained VPS, a killed install leaves `node_modules` incomplete; do not continue to build until installation succeeds.

## Postgres

Postgres is mandatory. Create a local database/user by your normal Postgres method and set a matching `DATABASE_URL` based on `.env.example`.

Apply migrations explicitly before starting any web or worker process:

```bash
node --env-file=.env.local --import tsx scripts/db-migrate.ts
node --env-file=.env.local --import tsx scripts/db-status.ts
```

`db:migrate` serializes migration work with a Postgres advisory lock and records the version and SHA-256 checksum in `schema_migrations`. The runtime only checks for the exact compatible migration history; it does not execute DDL. A missing, pending, unknown, renamed, or checksum-mismatched migration fails closed.

`PG_POOL_MAX` must be an integer of at least 2. Each process owns a separate pool, so budget total Postgres connections as `process count x PG_POOL_MAX`, plus capacity for migrations, backups, and operator sessions.

The version 1 migration is an immutable snapshot of the former idempotent bootstrap. It upgrades an existing legacy database without dropping tables or replacing existing business rows. Never edit an applied migration; add the next version instead.

Do not point local development at production Postgres.

## Environment

```bash
cp .env.example .env.local
```

At minimum, set `DATABASE_URL`. Kalshi WS and authenticated venue state require Kalshi credentials. Real execution also requires complete Polymarket credentials and funded/approved accounts.

Important: Next.js loads `.env.local`, but the standalone worker does not automatically load it.

## Start locally

Recommended two-terminal workflow:

```bash
# terminal 1: Next.js, automatically reads .env.local
npm run dev
```

```bash
# terminal 2: legacy all-asset worker with explicit env file
node --env-file=.env.local --import tsx src/worker/index.ts
```

Open `http://localhost:3000`.

`npm run dev:all` is valid only when the required variables have already been exported into the parent shell. Creating `.env.local` alone is insufficient for its worker child.

## Run split worker roles locally

To mirror the VPS topology, start individual processes with the environment loaded explicitly:

```bash
node --env-file=.env.local --import tsx src/worker/index.ts --role asset-live --asset btc
node --env-file=.env.local --import tsx src/worker/index.ts --role reconciler
node --env-file=.env.local --import tsx src/worker/index.ts --role notifier
```

Do not start legacy and split workers against the same database simultaneously. That duplicates scan/reconcile activity and can complicate execution arbitration.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run build:worker
```

Expected build artifacts are ignored:

- `.next/`
- `dist/worker/index.mjs`

## Useful local endpoints

```text
GET /api/health
GET /api/dashboard
GET /api/dashboard/{asset}
GET /api/trades
GET /api/settings
GET /api/circuit-breakers?details=1
GET /api/recovery
```

Mutation endpoints can alter trading state or trigger recovery. Do not call them casually.

## Operational scripts

Read a script before running it, then use the package command when available:

```bash
npm run logs:events
npm run incident:report
npm run intent:audit -- --intent <intent-id>
npm run breaker:audit
npm run slot:audit -- --asset btc
npm run backtest:strategies -- --help
```

Cleanup and recovery scripts can change state. They require an explicit operator decision.

## Common failures

### Worker says `DATABASE_URL` is required

The worker did not receive `.env.local`. Start it with `node --env-file=.env.local --import tsx ...` or export the variables safely in the parent shell.

### `next`, `tsx`, `vitest`, or `esbuild` not found

`npm ci` did not complete or `node_modules` ownership is wrong. Fix installation before building.

### Kalshi shows `rest-bootstrap`

This means the current slot has REST data but no accepted WS orderbook snapshot. A ticker update or subscription acknowledgement alone is intentionally insufficient.

Keep trading disabled and inspect the sanitized lifecycle logs:

```bash
sudo journalctl -u warbitrer-asset@btc -n 300 --no-pager | grep '\[kalshi-ws\]'
```

A healthy bootstrap contains, in order:

```text
[kalshi-ws] open
[kalshi-ws] subscribe-sent            # ticker, trade, orderbook_delta
[kalshi-ws] subscribed                # acknowledgement for each accepted channel
[kalshi-ws] orderbook-ready           # required before source=ws
```

`protocol error`, `bootstrap timeout`, `heartbeat timeout`, transport `error`, and `close` now fail the session and trigger an exponential reconnect. Failed initialization alternates between Kalshi's dedicated and officially supported shared WebSocket hosts. Logs include endpoint, slot, market ticker, command/channel, close code, and reason, but no credentials or signatures.

Do not compensate by polling REST faster. The 4 second REST fallback explains roughly 3 second observed latency and is only a safety fallback, not an HFT data path.

### API returns 401

When `APP_BASIC_AUTH_USER` and `APP_BASIC_AUTH_PASSWORD` are configured, every non-static route requires Basic Auth.

### UI has BNB/HYPE but no current data

Those assets are catalogued but are not active workers. This is the current code/config mismatch, not necessarily a feed outage.
