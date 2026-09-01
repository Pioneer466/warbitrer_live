# Warbitrer Live Multi-Asset 15m

Live cockpit and worker for a 15-minute crypto arbitrage strategy between Polymarket and Kalshi.

## What the system does

* `WS-first` live market data with fallback REST resync for Polymarket and Kalshi
* scans the current BTC, ETH, SOL, XRP, DOGE, BNB, and HYPE 15m markets on Polymarket and Kalshi
* computes `Poly Up + Kalshi No` and `Poly Down + Kalshi Yes` arbitrage opportunities
* live `taker-only` execution with a primary leg followed by an immediate hedge
* reconciliation of orders, fills, positions, P&L, and settlements
* Polymarket funding monitoring through the official bridge
* database-backed circuit breakers exposed through the API

## Requirements

* Node 22+
* Postgres required
* Kalshi credentials
* a Polymarket wallet that is already set up, funded, and authorized

## Environment variables

See `.env.example`.

Main variables:

* `DATABASE_URL`
* `APP_BASIC_AUTH_USER`
* `APP_BASIC_AUTH_PASSWORD`
* `LIVE_EXECUTION_ALLOWED=false|true`
* `TELEGRAM_ENABLED`
* `TELEGRAM_BOT_TOKEN`
* `TELEGRAM_CHAT_ID`
* `KALSHI_API_KEY_ID`
* `KALSHI_PRIVATE_KEY_PEM`
* `KALSHI_PRIVATE_KEY_PATH`
* `KALSHI_ENV=demo|prod`
* `POLY_PRIVATE_KEY`
* `POLY_PRIVATE_KEY_PATH`
* `POLY_API_KEY`
* `POLY_API_SECRET`
* `POLY_API_PASSPHRASE`
* `POLY_RELAYER_API_KEY`
* `POLY_RELAYER_URL`
* `POLY_FUNDER_ADDRESS`
* `POLY_SIGNATURE_TYPE=EOA|POLY_PROXY|POLY_GNOSIS_SAFE`
* `POLY_AUTO_CONVERT`
* `POLY_BRIDGE_LOW_WATER_USDC`

For Polymarket:

* `POLY_PRIVATE_KEY_PATH` contains the signer private key `0x...`
* `POLY_API_KEY`, `POLY_API_SECRET`, and `POLY_API_PASSPHRASE` are derived using `npm run poly:derive-api-key`
* in `POLY_PROXY` mode, `POLY_FUNDER_ADDRESS` is the proxy wallet address displayed on Polymarket, and `POLY_RELAYER_API_KEY` enables gasless `redeem + merge` conversion
* in `EOA` mode, `POLY_FUNDER_ADDRESS` must exactly match the signer's public address
* `POLY_RELAYER_URL` can remain set to `https://relayer-v2.polymarket.com`

Strategy configuration is stored in the database through `strategy_configs`, not in environment variables.
It can be managed through `GET /api/settings`, `PUT /api/settings`, `GET /api/settings/[asset]`, and `PUT /api/settings/[asset]`.

In production, `APP_BASIC_AUTH_USER` and `APP_BASIC_AUTH_PASSWORD` are required for the application. API mutations explicitly verify them and also reject cross-site browser requests. `LIVE_EXECUTION_ALLOWED` is an independent, fail-closed authorization layer for new live entries; leave it set to `false` for scanning and shadow mode.

Important fields:

* `enableTrading`
* `shadowMode`
* `maxPairNotionalUsd`
* `maxSlippageBps`
* `maxOpenIntentsPerSlot`

## Local setup

1. `npm install`
2. create `.env.local`
3. start Postgres
4. `node --env-file=.env.local --import tsx scripts/db-migrate.ts`
5. `npm run dev:all`
6. open `http://localhost:3000`

The web app and worker run together. At startup, the runtime performs a read-only validation of the Postgres schema and refuses to start if `db:migrate` has not applied the expected version.

## Verification

* `npm run typecheck`
* `npm test`
* `npm run build`
* `npm run build:worker`
* `npm run db:status`

## Useful endpoints

* `GET /api/dashboard`
* `GET /api/dashboard/[asset]`
* `GET /api/trades`
* `GET /api/trades?asset=btc|eth|sol|xrp|doge|bnb|hype|all`
* `GET /api/history/current-slot?asset=btc|eth|sol|xrp|doge|bnb|hype`
* `GET /api/health`
* `GET /api/recovery`
* `GET /api/settings`
* `GET /api/settings/[asset]`
* `PUT /api/settings`
* `PUT /api/settings/[asset]`
* `GET /api/circuit-breakers`
* `PUT /api/circuit-breakers`

## Shadow vs live

* `enableTrading=false`: no execution
* `enableTrading=true` and `shadowMode=true`: `rest-paired-preflight-v3` simulation, with no orders submitted to either venue. Before admission, Polymarket and Kalshi REST order books are requested in parallel. The largest admissible common pair is identified subject to absolute price caps, authoritative ticks, haircuts, headroom, fees, budgets, and economic thresholds. Mismatch risk is then recalculated using worst-case fill cost. A REST candidate that cannot be executed is recorded as a probe but no longer creates an artificially unfilled intent.
* `enableTrading=true` and `shadowMode=false`: real live execution only if `LIVE_EXECUTION_ALLOWED=true` and all other live controls are ready

In shadow mode, `maxOpenIntentsPerSlot` no longer limits the entire slot. Only one intent may be active per asset at a time, followed by a persistent 60-second cooldown after finalization. A new attempt is then allowed if the opportunity still exists or another one appears. The deterministic synthetic fill is finalized immediately once REST proof is available, with no artificial 15-second delay. REST duration, total latency, the next eligible timestamp, and rejection reasons are persisted.

The `/` dashboard aggregates the global portfolio, while `/btc`, `/eth`, `/sol`, `/xrp`, `/doge`, `/bnb`, and `/hype` expose per-asset operator dashboards. `/trades` remains the cross-asset view.
The `/recovery` page provides the global kill switch, Polymarket recovery tools, and wallet validation.

## VPS deployment

If you deploy to a VPS in Israel, the repository no longer depends on Railway. The infrastructure requires:

* persistent Postgres
* `systemd` with one web service, one worker per asset, a reconciler, and a notifier
* a reverse proxy such as Nginx or Caddy for HTTPS
* reliable NTP / system clock synchronization
* a restrictive firewall; password-based SSH access remains available, with an optional SSH key as an additional authentication method
* environment variables injected at the system service level rather than stored in the repository

The files and scripts in this repository do not modify `sshd`, `PasswordAuthentication`, system passwords, or SSH keys, and do not enforce key-only access.

Store secrets either:

* in `/etc/warbitrer/warbitrer.env`, loaded by `systemd`
* or in container environment variables if using Docker

Avoid storing real keys in `.env.local` on the server.

The ready-to-copy deployment package is available in [`deploy/vps`](./deploy/vps).

For a public VPS, the recommended setup is:

* `Caddy` in front of `127.0.0.1:3000`
* mandatory application-level `BasicAuth` in production
* Caddy-level `BasicAuth` as an independent external defense layer
* expose only ports `80/443`

The template is available in [`deploy/vps/Caddyfile`](./deploy/vps/Caddyfile).

## Free online preview

If you mainly want to access the cockpit remotely to check its status, the repository includes a [`render.yaml`](./render.yaml) blueprint for Render.

This setup runs:

* the public Next.js web app
* the live worker in the same service
* a separate managed Postgres instance

Important points:

* this is suitable for a remote preview, not for reliable live operation
* a Render `free` web service goes to sleep without incoming traffic, which also stops the worker
* Render's `free` Postgres offering is subject to the provider's plan limits; the application does not implement automatic history cleanup
* make sure `APP_BASIC_AUTH_USER` and `APP_BASIC_AUTH_PASSWORD` are configured before exposing the application publicly

Deployment:

1. push the repository
2. create a new Render Blueprint from the repository
3. let Render create the `warbitrer-live-preview` web service and the `warbitrer-live-db` database
4. configure sensitive environment variables in the Render UI
5. open the generated Render URL

For this mode, the application starts through `npm run start:render`.

Why not Vercel alone:

* the application depends on a long-running Node worker that runs continuously
* Vercel is suitable for the Next.js web app, but not as the sole host for this live worker
* for true live operation accessible from anywhere, you need either a small VPS or a provider capable of hosting the web app, worker, and Postgres together

## Operational notes

* live trading remains disabled as long as `enableTrading` is `false` in the configuration
* a live configuration alone is not enough: `LIVE_EXECUTION_ALLOWED=true` and a working Polygon mainnet `POLYGON_RPC_URL` must also be present in the runtime environment
* the recommended rollout path is to first use `enableTrading=true` with `shadowMode=true`
* if a venue is not ready or a circuit breaker is active, the worker refuses to open new intents
* a Polymarket fill is only considered final after validation of its Polygon receipt and the V2 `OrderFilled` event, including exact fees
* every fill inserted after V8, including fills on legacy intents, must go through the atomic accounting transaction; a late fill quarantines the intent before any recalculation
* never deploy while a live intent, live order attempt, or capital exposure is non-terminal; reconcile venue truth first, especially when changing client order ID generations
* if Telegram is configured, the worker sends only two types of notifications: `trade_live` when a live intent actually commits capital, and `manual_intervention_required` when human action is required
* automatic rebalancing between Kalshi cash and Polygon USDC is not implemented; treasury management is limited to the official Polymarket bridge
