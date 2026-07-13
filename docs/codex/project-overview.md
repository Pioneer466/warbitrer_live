# Warbitrer - Project Overview

## Purpose

Warbitrer is an operator cockpit and execution worker for cross-venue arbitrage between matching 15-minute crypto direction markets on Polymarket and Kalshi.

It evaluates two complementary pairs:

- Polymarket Up + Kalshi No
- Polymarket Down + Kalshi Yes

The system can observe, simulate, or place real taker orders. Real execution uses a primary leg followed by an immediate hedge and includes reconciliation and exposure-recovery workflows.

## Assets

The catalog contains BTC, ETH, SOL, XRP, DOGE, BNB, and HYPE.

The actual worker set currently runs only:

- BTC
- ETH
- SOL
- XRP
- DOGE

BNB and HYPE have pages and configuration records but are not included in `ACTIVE_MARKET_ASSETS` or the VPS service list.

## Main capabilities

- Resolve the current UTC-aligned 15-minute slot.
- Discover matching Polymarket and Kalshi markets.
- Maintain Polymarket market/user/Chainlink WebSockets with REST resync.
- Maintain an authenticated Kalshi WebSocket with REST bootstrap/resync.
- Normalize order books, quotes, depths, fees, ticks, and minimum sizes.
- Calculate balanced pair sizing and projected economics.
- Reject stale, unaligned, terminal, late, underfunded, illiquid, or low-profit signals.
- Apply mismatch/dead-zone risk controls based on reference prices.
- Run shadow or live primary/hedge execution.
- Retry, rescue, unwind, reconcile, and mark manual intervention when exposure is unresolved.
- Persist snapshots, configuration, orders, fills, positions, P&L, settlements, breakers, notifications, and audit events.
- Redeem or merge eligible Polymarket positions through recovery workflows.
- Export and simulate historical snapshots through the backtest tools.

## Operator surfaces

- `/`: aggregate portfolio and worker health
- `/{asset}`: per-asset market, strategy, feed, and execution state
- `/trades`: intents, orders, fills, and outcomes
- `/recovery`: kill switch, wallet validation, settlement repair, and Polymarket conversion
- `/api/health`: workers, feeds, breakers, settings, and database metrics
- `/api/settings`: strategy configuration
- `/api/circuit-breakers`: breaker inspection and operator actions

## Execution modes

- Trading disabled: market scan only.
- Shadow: synthetic execution persisted through the same operator surfaces.
- Live: real venue orders and real capital exposure.

Configuration is stored per asset in Postgres. Environment variables hold infrastructure and credentials, not strategy thresholds.

## Current objective

The immediate objective is to diagnose and stabilize Kalshi WebSocket ingestion on the VPS. REST should remain bootstrap/resync/fallback rather than the normal primary source. Live trading should remain disabled until this is demonstrated with fresh feed health and durable diagnostics.
