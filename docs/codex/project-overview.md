# Warbitrer - Project Overview

## Purpose

Warbitrer is an operator cockpit and execution system for cross-venue arbitrage between matching 15-minute crypto direction markets on Polymarket and Kalshi.

It evaluates two complementary pairs:

- Polymarket Up + Kalshi No
- Polymarket Down + Kalshi Yes

The system can observe markets, simulate paired execution, or submit real taker orders. A live entry chooses a primary leg, confirms durable venue evidence, and then hedges. Reconciliation and recovery remain part of the execution contract after the immediate request completes.

## Assets

The catalog contains BTC, ETH, SOL, XRP, DOGE, BNB, and HYPE.

The production worker set contains:

- BTC
- ETH
- SOL
- XRP
- DOGE

BNB and HYPE have catalog, UI, and configuration support but are not included in `ACTIVE_MARKET_ASSETS` or the VPS service list. Live settings for assets without an active worker are rejected.

## Capabilities

- Resolve the current UTC-aligned 15-minute slot.
- Discover and prove matching Polymarket and Kalshi market identities.
- Maintain Polymarket market/user and Chainlink feeds with bounded REST bootstrap or resync.
- Maintain an authenticated Kalshi WebSocket with bounded REST bootstrap or resync.
- Normalize order books, quotes, depth, venue fees, authoritative ticks, and minimum sizes.
- Calculate balanced pair sizing and fee-inclusive projected economics.
- Reject stale, unaligned, terminal, late, underfunded, illiquid, or low-profit candidates.
- Apply mismatch and dead-zone controls based on durable reference evidence.
- Run conservative shadow execution or live primary/hedge execution.
- Retry, rescue, unwind, reconcile, and require manual intervention when exposure is not proven safe.
- Persist configuration revisions, admission evidence, order attempts, venue truth, fills, settlements, accounting facts, breaker incidents, notifications, and audit events in Postgres.
- Redeem or merge eligible Polymarket positions through authenticated recovery workflows.
- Export and simulate historical snapshots through the backtest tools.

## Operator surfaces

- `/`: aggregate portfolio and worker health
- `/{asset}`: per-asset market, strategy, feed, and execution state
- `/trades`: intents, orders, fills, mismatch evidence, and outcomes
- `/recovery`: manual kill switch, wallet validation, settlement repair, and Polymarket conversion
- `/api/liveness`: static process liveness for the reverse proxy
- `/api/health`: fail-closed business readiness
- `/api/settings`: revision-checked strategy configuration
- `/api/circuit-breakers`: incident and aggregate inspection plus exact operator actions

Production application access requires Basic Auth. Mutation routes authenticate again before parsing their bodies and reject cross-site browser requests. Caddy authentication is a separate external defense, not a replacement for application checks.

## Execution modes

- Trading disabled: scan and persist observations only.
- Shadow: synthetic orders and fills are persisted through the operator surfaces.
- Live: venue orders can expose real capital.

Per-asset strategy configuration is versioned in Postgres. Environment variables hold infrastructure authorization and credentials, not strategy thresholds.

A strategy configuration cannot authorize live execution by itself. A new real entry also requires:

- `LIVE_EXECUTION_ALLOWED=true`
- `KALSHI_ENV=prod`
- an asset in `ACTIVE_MARKET_ASSETS`
- fresh, exact market and book evidence
- compatible configuration revisions
- no relevant blocking breaker incident
- no unresolved live admission or accounting blocker

Disabling the live-entry gate does not disable reconciliation, hedge, unwind, or recovery work for existing exposure.

## Persistence contract

Postgres is mandatory. Runtime processes verify the exact migration history and never apply DDL. Operators apply checksummed, forward-only migrations explicitly with `npm run db:migrate` and verify them with `npm run db:status`.

The current schema history is V1-V9:

1. legacy schema baseline
2. order-truth revisions and immutable fill identity
3. configuration revisions and append-only audit
4. transactional entry admission and reservations
5. append-only multi-cause circuit-breaker incidents
6. immutable submission deadlines and parent-stage guards
7. versioned accounting facts, proofs, quarantine, and realized-P&L ledger
8. accounting evidence integrity, exact terminal projections, mandatory fill ingestion, and parent/child identity guards
9. exact repair of inactive numeric legacy slot breakers with append-only recovery and acknowledgement evidence

See `docs/codex/architecture.md` for boundaries and `docs/codex/session-handoff.md` for the current rollout and verification state.

## Production topology

The canonical VPS runs Next.js, one worker per active asset, a reconciler, a notifier, local Postgres, and Caddy. It does not run the combined legacy worker. The legacy role exists only for the non-production Render preview.

Repository code and deployment scripts do not modify `sshd`, `PasswordAuthentication`, system passwords, or SSH credentials. Password-based VPS SSH access must remain available; an SSH key is optional and may coexist with password login.

## Operating posture

Passing tests or completing a code review does not authorize a deployment or real-money canary. Before live use, verify the exact commit, migration status, worker topology, feed health, venue truth, active incidents, accounting backlog, and capital state. Keep `LIVE_EXECUTION_ALLOWED=false` during deployment, migration, uncertain market data, or unresolved reconciliation.
