import { Pool, types } from "pg";

import { DEFAULT_STRATEGY_CONFIG } from "@/lib/constants";
import type { DatabaseMaintenanceConfig } from "@/lib/db-maintenance";
import { enrichPnlSnapshot } from "@/lib/pnl";
import { normalizeSettings } from "@/lib/settings-schema";
import type {
  DatabaseMaintenanceSummary,
  DatabaseMetrics,
  BridgeTransfer,
  CircuitBreaker,
  DashboardResponse,
  HistoryPoint,
  LiveFill,
  LiveOpportunity,
  LiveOrder,
  MarketSlot,
  OrderIntent,
  PairCombination,
  PnlSnapshot,
  PositionSnapshot,
  RunEvent,
  StrategyConfig,
  TradesResponse,
  Venue,
  VenueBalance,
  WorkerState,
} from "@/lib/types";

types.setTypeParser(20, (value) => Number(value));

let poolSingleton: Pool | null = null;
let bootstrapPromise: Promise<void> | null = null;

export async function getPgDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL est requis pour utiliser le système live");
  }

  if (!poolSingleton) {
    poolSingleton = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  if (!bootstrapPromise) {
    bootstrapPromise = bootstrapDatabase(poolSingleton).catch((error) => {
      bootstrapPromise = null;
      throw error;
    });
  }

  await bootstrapPromise;
  return poolSingleton;
}

async function bootstrapDatabase(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS strategy_config (
      id INTEGER PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worker_state (
      id INTEGER PRIMARY KEY,
      phase TEXT NOT NULL,
      current_slot_key TEXT,
      last_scan_at BIGINT,
      last_execute_at BIGINT,
      last_reconcile_at BIGINT,
      last_error TEXT,
      readiness_status TEXT NOT NULL,
      readiness_json JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS opportunity_snapshots (
      id BIGSERIAL PRIMARY KEY,
      slot_key TEXT NOT NULL,
      slot_start_ts BIGINT NOT NULL,
      slot_end_ts BIGINT NOT NULL,
      captured_at BIGINT NOT NULL,
      polymarket_json JSONB NOT NULL,
      kalshi_json JSONB NOT NULL,
      opportunities_json JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS opportunity_snapshots_slot_idx
      ON opportunity_snapshots(slot_key, captured_at DESC);
    CREATE INDEX IF NOT EXISTS opportunity_snapshots_captured_idx
      ON opportunity_snapshots(captured_at DESC);

    CREATE TABLE IF NOT EXISTS venue_balances (
      venue TEXT PRIMARY KEY,
      captured_at BIGINT NOT NULL,
      status TEXT NOT NULL,
      currency TEXT NOT NULL,
      available_balance_usd DOUBLE PRECISION NOT NULL,
      total_balance_usd DOUBLE PRECISION NOT NULL,
      portfolio_value_usd DOUBLE PRECISION NOT NULL,
      allowance_usd DOUBLE PRECISION,
      notes_json JSONB NOT NULL,
      raw_json JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_intents (
      id TEXT PRIMARY KEY,
      shadow BOOLEAN NOT NULL DEFAULT false,
      slot_key TEXT NOT NULL,
      slot_start_ts BIGINT NOT NULL,
      slot_end_ts BIGINT NOT NULL,
      combination TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      resolved_at BIGINT,
      primary_venue TEXT NOT NULL,
      hedge_venue TEXT NOT NULL,
      gross_cost DOUBLE PRECISION NOT NULL,
      target_notional_usd DOUBLE PRECISION NOT NULL,
      max_slippage_bps INTEGER NOT NULL,
      failure_reason TEXT,
      projected_net_profit_usd DOUBLE PRECISION,
      realized_pnl_usd DOUBLE PRECISION,
      roi DOUBLE PRECISION,
      poly_resolution TEXT,
      kalshi_resolution TEXT,
      legs_json JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS order_intents_slot_idx ON order_intents(slot_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS order_intents_created_idx ON order_intents(created_at DESC);
    CREATE INDEX IF NOT EXISTS order_intents_resolved_idx ON order_intents(resolved_at DESC)
      WHERE resolved_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS venue_orders (
      id TEXT PRIMARY KEY,
      shadow BOOLEAN NOT NULL DEFAULT false,
      intent_id TEXT NOT NULL REFERENCES order_intents(id) ON DELETE CASCADE,
      venue TEXT NOT NULL,
      venue_order_id TEXT NOT NULL,
      client_order_id TEXT,
      market_ref TEXT NOT NULL,
      token_id TEXT,
      side TEXT NOT NULL,
      outcome TEXT NOT NULL,
      order_type TEXT NOT NULL,
      requested_price DOUBLE PRECISION,
      requested_size DOUBLE PRECISION NOT NULL,
      filled_size DOUBLE PRECISION NOT NULL,
      average_fill_price DOUBLE PRECISION,
      fee_usd DOUBLE PRECISION,
      status TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      raw_json JSONB NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS venue_orders_exchange_idx
      ON venue_orders(venue, venue_order_id);
    CREATE INDEX IF NOT EXISTS venue_orders_updated_idx
      ON venue_orders(updated_at DESC);

    CREATE TABLE IF NOT EXISTS fills (
      id TEXT PRIMARY KEY,
      shadow BOOLEAN NOT NULL DEFAULT false,
      intent_id TEXT REFERENCES order_intents(id) ON DELETE SET NULL,
      venue TEXT NOT NULL,
      venue_order_id TEXT NOT NULL,
      trade_id TEXT NOT NULL,
      market_ref TEXT NOT NULL,
      token_id TEXT,
      side TEXT NOT NULL,
      outcome TEXT NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      size DOUBLE PRECISION NOT NULL,
      fee_usd DOUBLE PRECISION NOT NULL,
      liquidity TEXT,
      filled_at BIGINT NOT NULL,
      raw_json JSONB NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS fills_exchange_trade_idx ON fills(venue, trade_id);
    CREATE INDEX IF NOT EXISTS fills_intent_idx ON fills(intent_id, filled_at DESC);
    CREATE INDEX IF NOT EXISTS fills_filled_idx ON fills(filled_at DESC);

    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      venue TEXT NOT NULL,
      market_ref TEXT NOT NULL,
      outcome TEXT NOT NULL,
      size DOUBLE PRECISION NOT NULL,
      average_price DOUBLE PRECISION,
      current_price DOUBLE PRECISION,
      current_value_usd DOUBLE PRECISION NOT NULL,
      realized_pnl_usd DOUBLE PRECISION NOT NULL,
      unrealized_pnl_usd DOUBLE PRECISION NOT NULL,
      redeemable BOOLEAN NOT NULL,
      mergeable BOOLEAN NOT NULL,
      updated_at BIGINT NOT NULL,
      raw_json JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS positions_venue_idx ON positions(venue, updated_at DESC);

    CREATE TABLE IF NOT EXISTS settlements (
      id TEXT PRIMARY KEY,
      intent_id TEXT REFERENCES order_intents(id) ON DELETE SET NULL,
      venue TEXT NOT NULL,
      market_ref TEXT NOT NULL,
      outcome TEXT NOT NULL,
      resolved_outcome TEXT,
      payout_usd DOUBLE PRECISION NOT NULL,
      settled_at BIGINT NOT NULL,
      raw_json JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS settlements_settled_idx ON settlements(settled_at DESC);

    CREATE TABLE IF NOT EXISTS pnl_snapshots (
      id BIGSERIAL PRIMARY KEY,
      captured_at BIGINT NOT NULL,
      equity_usd DOUBLE PRECISION NOT NULL,
      cash_usd DOUBLE PRECISION NOT NULL,
      positions_value_usd DOUBLE PRECISION NOT NULL,
      realized_pnl_usd DOUBLE PRECISION NOT NULL,
      unrealized_pnl_usd DOUBLE PRECISION NOT NULL,
      fees_usd DOUBLE PRECISION NOT NULL,
      venue_breakdown_json JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pnl_snapshots_captured_idx ON pnl_snapshots(captured_at DESC);

    CREATE TABLE IF NOT EXISTS bridge_transfers (
      id TEXT PRIMARY KEY,
      venue TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      quote_id TEXT,
      source_chain TEXT,
      source_asset TEXT,
      target_asset TEXT NOT NULL,
      amount_in_usd DOUBLE PRECISION,
      amount_out_usd DOUBLE PRECISION,
      tx_hash TEXT,
      deposit_addresses_json JSONB,
      raw_json JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bridge_transfers_updated_idx ON bridge_transfers(updated_at DESC);

    CREATE TABLE IF NOT EXISTS run_events (
      id BIGSERIAL PRIMARY KEY,
      level TEXT NOT NULL,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json JSONB,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS run_events_created_idx ON run_events(created_at DESC);

    CREATE TABLE IF NOT EXISTS circuit_breakers (
      key TEXT PRIMARY KEY,
      active BOOLEAN NOT NULL,
      reason TEXT,
      triggered_at BIGINT,
      payload_json JSONB
    );
  `);

  await pool.query(
    `
      INSERT INTO strategy_config (id, payload, updated_at)
      VALUES (1, $1::jsonb, $2)
      ON CONFLICT (id) DO NOTHING
    `,
    [JSON.stringify(DEFAULT_STRATEGY_CONFIG), Date.now()],
  );

  await pool.query(
    `
      INSERT INTO worker_state (
        id, phase, current_slot_key, last_scan_at, last_execute_at, last_reconcile_at,
        last_error, readiness_status, readiness_json
      )
      VALUES (1, 'idle', NULL, NULL, NULL, NULL, NULL, 'blocked', '[]'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `,
  );

  await pool.query(
    `
      INSERT INTO circuit_breakers (key, active, reason, triggered_at, payload_json)
      VALUES ('global', false, NULL, NULL, NULL)
      ON CONFLICT (key) DO NOTHING
    `,
  );

  await pool.query(`
    ALTER TABLE order_intents
    ADD COLUMN IF NOT EXISTS shadow BOOLEAN NOT NULL DEFAULT false
  `);

  await pool.query(`
    ALTER TABLE venue_orders
    ADD COLUMN IF NOT EXISTS shadow BOOLEAN NOT NULL DEFAULT false
  `);

  await pool.query(`
    ALTER TABLE fills
    ADD COLUMN IF NOT EXISTS shadow BOOLEAN NOT NULL DEFAULT false
  `);
}

export async function getStrategyConfig(pool: Pool): Promise<StrategyConfig> {
  const result = await pool.query("SELECT payload FROM strategy_config WHERE id = 1");
  return normalizeSettings(result.rows[0].payload as Partial<StrategyConfig>);
}

export async function updateStrategyConfig(pool: Pool, payload: StrategyConfig) {
  await pool.query(
    "UPDATE strategy_config SET payload = $1::jsonb, updated_at = $2 WHERE id = 1",
    [JSON.stringify(payload), Date.now()],
  );
  return payload;
}

export async function getWorkerState(pool: Pool): Promise<WorkerState> {
  const result = await pool.query(
    `
      SELECT phase, current_slot_key, last_scan_at, last_execute_at, last_reconcile_at,
        last_error, readiness_status, readiness_json
      FROM worker_state
      WHERE id = 1
    `,
  );
  const row = result.rows[0];
  return {
    phase: row.phase,
    currentSlotKey: row.current_slot_key,
    lastScanAt: row.last_scan_at,
    lastExecuteAt: row.last_execute_at,
    lastReconcileAt: row.last_reconcile_at,
    lastError: row.last_error,
    readinessStatus: row.readiness_status,
    readiness: (row.readiness_json ?? []) as WorkerState["readiness"],
  };
}

export async function updateWorkerState(pool: Pool, state: Partial<WorkerState>) {
  await pool.query(
    `
      UPDATE worker_state
      SET
        phase = COALESCE($1, phase),
        current_slot_key = COALESCE($2, current_slot_key),
        last_scan_at = COALESCE($3, last_scan_at),
        last_execute_at = COALESCE($4, last_execute_at),
        last_reconcile_at = COALESCE($5, last_reconcile_at),
        last_error = $6,
        readiness_status = COALESCE($7, readiness_status),
        readiness_json = COALESCE($8::jsonb, readiness_json)
      WHERE id = 1
    `,
    [
      state.phase ?? null,
      state.currentSlotKey ?? null,
      state.lastScanAt ?? null,
      state.lastExecuteAt ?? null,
      state.lastReconcileAt ?? null,
      state.lastError ?? null,
      state.readinessStatus ?? null,
      state.readiness ? JSON.stringify(state.readiness) : null,
    ],
  );
}

export async function insertOpportunitySnapshot(
  pool: Pool,
  snapshot: {
    slotKey: string;
    slotStartTs: number;
    slotEndTs: number;
    capturedAt: number;
    polymarket: unknown;
    kalshi: unknown;
    opportunities: LiveOpportunity[];
  },
) {
  await pool.query(
    `
      INSERT INTO opportunity_snapshots (
        slot_key, slot_start_ts, slot_end_ts, captured_at, polymarket_json, kalshi_json, opportunities_json
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)
    `,
    [
      snapshot.slotKey,
      snapshot.slotStartTs,
      snapshot.slotEndTs,
      snapshot.capturedAt,
      JSON.stringify(snapshot.polymarket),
      JSON.stringify(snapshot.kalshi),
      JSON.stringify(snapshot.opportunities),
    ],
  );
}

export async function getLatestOpportunitySnapshot(pool: Pool, slotKey?: string) {
  const result = await pool.query(
    `
      SELECT *
      FROM opportunity_snapshots
      ${slotKey ? "WHERE slot_key = $1" : ""}
      ORDER BY captured_at DESC
      LIMIT 1
    `,
    slotKey ? [slotKey] : [],
  );

  return result.rows[0] ? mapOpportunitySnapshotRow(result.rows[0]) : null;
}

export async function getOpportunitySnapshotsForSlot(pool: Pool, slotKey: string) {
  const result = await pool.query(
    `
      SELECT *
      FROM opportunity_snapshots
      WHERE slot_key = $1
      ORDER BY captured_at ASC
    `,
    [slotKey],
  );

  return result.rows.map(mapOpportunitySnapshotRow);
}

export async function upsertVenueBalance(pool: Pool, balance: VenueBalance) {
  await pool.query(
    `
      INSERT INTO venue_balances (
        venue, captured_at, status, currency, available_balance_usd, total_balance_usd,
        portfolio_value_usd, allowance_usd, notes_json, raw_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
      ON CONFLICT (venue) DO UPDATE SET
        captured_at = EXCLUDED.captured_at,
        status = EXCLUDED.status,
        currency = EXCLUDED.currency,
        available_balance_usd = EXCLUDED.available_balance_usd,
        total_balance_usd = EXCLUDED.total_balance_usd,
        portfolio_value_usd = EXCLUDED.portfolio_value_usd,
        allowance_usd = EXCLUDED.allowance_usd,
        notes_json = EXCLUDED.notes_json,
        raw_json = EXCLUDED.raw_json
    `,
    [
      balance.venue,
      balance.capturedAt,
      balance.status,
      balance.currency,
      balance.availableBalanceUsd,
      balance.totalBalanceUsd,
      balance.portfolioValueUsd,
      balance.allowanceUsd,
      JSON.stringify(balance.notes),
      JSON.stringify(balance.raw),
    ],
  );
}

export async function listVenueBalances(pool: Pool): Promise<VenueBalance[]> {
  const result = await pool.query("SELECT * FROM venue_balances ORDER BY venue ASC");
  return result.rows.map((row) => ({
    venue: row.venue,
    capturedAt: row.captured_at,
    status: row.status,
    currency: row.currency,
    availableBalanceUsd: row.available_balance_usd,
    totalBalanceUsd: row.total_balance_usd,
    portfolioValueUsd: row.portfolio_value_usd,
    allowanceUsd: row.allowance_usd,
    notes: row.notes_json ?? [],
    raw: row.raw_json ?? {},
  }));
}

export async function getLastEntryCosts(pool: Pool, slotKey: string) {
  const result = await pool.query<{
    combination: PairCombination;
    gross_cost: number;
  }>(
    `
      SELECT combination, gross_cost
      FROM order_intents
      WHERE slot_key = $1
      ORDER BY created_at DESC
    `,
    [slotKey],
  );

  return result.rows.reduce<Partial<Record<PairCombination, number>>>((accumulator, row) => {
    if (accumulator[row.combination] === undefined) {
      accumulator[row.combination] = row.gross_cost;
    }
    return accumulator;
  }, {});
}

export async function upsertOrderIntent(pool: Pool, intent: OrderIntent) {
  await pool.query(
    `
      INSERT INTO order_intents (
        id, shadow, slot_key, slot_start_ts, slot_end_ts, combination, status, created_at, updated_at,
        resolved_at, primary_venue, hedge_venue, gross_cost, target_notional_usd, max_slippage_bps,
        failure_reason, projected_net_profit_usd, realized_pnl_usd, roi, poly_resolution,
        kalshi_resolution, legs_json
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20,
        $21, $22::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at,
        resolved_at = EXCLUDED.resolved_at,
        failure_reason = EXCLUDED.failure_reason,
        projected_net_profit_usd = EXCLUDED.projected_net_profit_usd,
        realized_pnl_usd = EXCLUDED.realized_pnl_usd,
        roi = EXCLUDED.roi,
        poly_resolution = EXCLUDED.poly_resolution,
        kalshi_resolution = EXCLUDED.kalshi_resolution,
        legs_json = EXCLUDED.legs_json
    `,
    [
      intent.id,
      intent.shadow,
      intent.slotKey,
      intent.slotStartTs,
      intent.slotEndTs,
      intent.combination,
      intent.status,
      intent.createdAt,
      intent.updatedAt,
      intent.resolvedAt,
      intent.primaryVenue,
      intent.hedgeVenue,
      intent.grossCost,
      intent.targetNotionalUsd,
      intent.maxSlippageBps,
      intent.failureReason,
      intent.projectedNetProfitUsd,
      intent.realizedPnlUsd,
      intent.roi,
      intent.polyResolution,
      intent.kalshiResolution,
      JSON.stringify(intent.legs),
    ],
  );
}

export async function listOpenOrderIntents(pool: Pool): Promise<OrderIntent[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM order_intents
      WHERE status NOT IN ('settled', 'failed', 'canceled', 'unwound')
      ORDER BY updated_at DESC
    `,
  );
  return result.rows.map(mapOrderIntentRow);
}

export async function listRecentOrderIntents(pool: Pool, limit = 50): Promise<OrderIntent[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM order_intents
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [limit],
  );
  return result.rows.map(mapOrderIntentRow);
}

export async function findOrderIntent(pool: Pool, intentId: string) {
  const result = await pool.query("SELECT * FROM order_intents WHERE id = $1 LIMIT 1", [intentId]);
  return result.rows[0] ? mapOrderIntentRow(result.rows[0]) : null;
}

export async function getLiveRealizedPnlUsd(pool: Pool) {
  const result = await pool.query<{ realized_pnl_usd: number }>(
    `
      SELECT COALESCE(SUM(realized_pnl_usd), 0) AS realized_pnl_usd
      FROM order_intents
      WHERE shadow = false
        AND realized_pnl_usd IS NOT NULL
    `,
  );
  return Number(result.rows[0]?.realized_pnl_usd ?? 0);
}

export async function upsertVenueOrder(pool: Pool, order: LiveOrder) {
  await pool.query(
    `
      INSERT INTO venue_orders (
        id, shadow, intent_id, venue, venue_order_id, client_order_id, market_ref, token_id, side, outcome,
        order_type, requested_price, requested_size, filled_size, average_fill_price, fee_usd,
        status, created_at, updated_at, raw_json
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        filled_size = EXCLUDED.filled_size,
        average_fill_price = EXCLUDED.average_fill_price,
        fee_usd = EXCLUDED.fee_usd,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at,
        raw_json = EXCLUDED.raw_json
    `,
    [
      order.id,
      order.shadow,
      order.intentId,
      order.venue,
      order.venueOrderId,
      order.clientOrderId,
      order.marketRef,
      order.tokenId,
      order.side,
      order.outcome,
      order.orderType,
      order.requestedPrice,
      order.requestedSize,
      order.filledSize,
      order.averageFillPrice,
      order.feeUsd,
      order.status,
      order.createdAt,
      order.updatedAt,
      JSON.stringify(order.raw),
    ],
  );
}

export async function listRecentVenueOrders(pool: Pool, limit = 50): Promise<LiveOrder[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM venue_orders
      ORDER BY updated_at DESC
      LIMIT $1
    `,
    [limit],
  );
  return result.rows.map(mapVenueOrderRow);
}

export async function listOpenVenueOrders(pool: Pool) {
  const result = await pool.query(
    `
      SELECT *
      FROM venue_orders
      WHERE status IN ('pending', 'live', 'partially_filled')
      ORDER BY updated_at DESC
    `,
  );
  return result.rows.map(mapVenueOrderRow);
}

export async function findVenueOrderByExchangeId(pool: Pool, venue: string, venueOrderId: string) {
  const result = await pool.query(
    `
      SELECT *
      FROM venue_orders
      WHERE venue = $1 AND venue_order_id = $2
      LIMIT 1
    `,
    [venue, venueOrderId],
  );
  return result.rows[0] ? mapVenueOrderRow(result.rows[0]) : null;
}

export async function upsertFill(pool: Pool, fill: LiveFill) {
  await pool.query(
    `
      INSERT INTO fills (
        id, shadow, intent_id, venue, venue_order_id, trade_id, market_ref, token_id, side,
        outcome, price, size, fee_usd, liquidity, filled_at, raw_json
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        fee_usd = EXCLUDED.fee_usd,
        raw_json = EXCLUDED.raw_json
    `,
    [
      fill.id,
      fill.shadow,
      fill.intentId,
      fill.venue,
      fill.venueOrderId,
      fill.tradeId,
      fill.marketRef,
      fill.tokenId,
      fill.side,
      fill.outcome,
      fill.price,
      fill.size,
      fill.feeUsd,
      fill.liquidity,
      fill.filledAt,
      JSON.stringify(fill.raw),
    ],
  );
}

export async function listRecentFills(pool: Pool, limit = 100): Promise<LiveFill[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM fills
      ORDER BY filled_at DESC
      LIMIT $1
    `,
    [limit],
  );
  return result.rows.map(mapFillRow);
}

export async function getLiveFeesUsd(pool: Pool) {
  const result = await pool.query<{ fees_usd: number }>(
    `
      SELECT COALESCE(SUM(fee_usd), 0) AS fees_usd
      FROM fills
      WHERE shadow = false
    `,
  );
  return Number(result.rows[0]?.fees_usd ?? 0);
}

export async function listFillsForIntentVenue(pool: Pool, intentId: string, venue: Venue): Promise<LiveFill[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM fills
      WHERE intent_id = $1 AND venue = $2
      ORDER BY filled_at ASC, trade_id ASC
    `,
    [intentId, venue],
  );
  return result.rows.map(mapFillRow);
}

export async function replaceVenuePositions(pool: Pool, venue: "polymarket" | "kalshi", positions: PositionSnapshot[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM positions WHERE venue = $1", [venue]);
    for (const position of positions) {
      await client.query(
        `
          INSERT INTO positions (
            id, venue, market_ref, outcome, size, average_price, current_price, current_value_usd,
            realized_pnl_usd, unrealized_pnl_usd, redeemable, mergeable, updated_at, raw_json
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11, $12, $13, $14::jsonb
          )
        `,
        [
          position.id,
          position.venue,
          position.marketRef,
          position.outcome,
          position.size,
          position.averagePrice,
          position.currentPrice,
          position.currentValueUsd,
          position.realizedPnlUsd,
          position.unrealizedPnlUsd,
          position.redeemable,
          position.mergeable,
          position.updatedAt,
          JSON.stringify(position.raw),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listPositions(pool: Pool): Promise<PositionSnapshot[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM positions
      ORDER BY venue ASC, current_value_usd DESC
    `,
  );
  return result.rows.map(mapPositionRow);
}

export async function upsertSettlement(pool: Pool, settlement: {
  id: string;
  intentId: string;
  venue: string;
  marketRef: string;
  outcome: string;
  resolvedOutcome: string | null;
  payoutUsd: number;
  settledAt: number;
  raw: Record<string, unknown>;
}) {
  await pool.query(
    `
      INSERT INTO settlements (
        id, intent_id, venue, market_ref, outcome, resolved_outcome, payout_usd, settled_at, raw_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        resolved_outcome = EXCLUDED.resolved_outcome,
        payout_usd = EXCLUDED.payout_usd,
        settled_at = EXCLUDED.settled_at,
        raw_json = EXCLUDED.raw_json
    `,
    [
      settlement.id,
      settlement.intentId,
      settlement.venue,
      settlement.marketRef,
      settlement.outcome,
      settlement.resolvedOutcome,
      settlement.payoutUsd,
      settlement.settledAt,
      JSON.stringify(settlement.raw),
    ],
  );
}

export async function insertPnlSnapshot(pool: Pool, snapshot: PnlSnapshot) {
  await pool.query(
    `
      INSERT INTO pnl_snapshots (
        captured_at, equity_usd, cash_usd, positions_value_usd,
        realized_pnl_usd, unrealized_pnl_usd, fees_usd, venue_breakdown_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    `,
    [
      snapshot.capturedAt,
      snapshot.equityUsd,
      snapshot.cashUsd,
      snapshot.positionsValueUsd,
      snapshot.realizedPnlUsd,
      snapshot.unrealizedPnlUsd,
      snapshot.feesUsd,
      JSON.stringify(snapshot.venueBreakdown),
    ],
  );
}

export async function getLatestPnlSnapshot(pool: Pool): Promise<PnlSnapshot | null> {
  const result = await pool.query(
    `
      SELECT *
      FROM pnl_snapshots
      ORDER BY captured_at DESC
      LIMIT 1
    `,
  );
  return result.rows[0] ? mapPnlSnapshotRow(result.rows[0]) : null;
}

async function getFirstTrackedEquityUsd(pool: Pool) {
  const result = await pool.query<{ equity_usd: number }>(
    `
      SELECT equity_usd
      FROM pnl_snapshots
      ORDER BY captured_at ASC, id ASC
      LIMIT 1
    `,
  );
  return result.rows[0] ? Number(result.rows[0].equity_usd) : null;
}

export async function upsertBridgeTransfer(pool: Pool, transfer: BridgeTransfer) {
  await pool.query(
    `
      INSERT INTO bridge_transfers (
        id, venue, status, created_at, updated_at, quote_id, source_chain, source_asset, target_asset,
        amount_in_usd, amount_out_usd, tx_hash, deposit_addresses_json, raw_json
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13::jsonb, $14::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at,
        quote_id = EXCLUDED.quote_id,
        tx_hash = EXCLUDED.tx_hash,
        amount_in_usd = EXCLUDED.amount_in_usd,
        amount_out_usd = EXCLUDED.amount_out_usd,
        deposit_addresses_json = EXCLUDED.deposit_addresses_json,
        raw_json = EXCLUDED.raw_json
    `,
    [
      transfer.id,
      transfer.venue,
      transfer.status,
      transfer.createdAt,
      transfer.updatedAt,
      transfer.quoteId,
      transfer.sourceChain,
      transfer.sourceAsset,
      transfer.targetAsset,
      transfer.amountInUsd,
      transfer.amountOutUsd,
      transfer.txHash,
      JSON.stringify(transfer.depositAddresses),
      JSON.stringify(transfer.raw),
    ],
  );
}

export async function getDatabaseMetrics(pool: Pool): Promise<DatabaseMetrics> {
  const [sizeResult, tablesResult] = await Promise.all([
    pool.query<{ size_bytes: number }>("SELECT pg_database_size(current_database()) AS size_bytes"),
    pool.query<{ table_name: string; total_bytes: number }>(`
      SELECT
        c.relname AS table_name,
        pg_total_relation_size(c.oid) AS total_bytes
      FROM pg_class c
      INNER JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
      ORDER BY total_bytes DESC, table_name ASC
      LIMIT 8
    `),
  ]);

  return {
    capturedAt: Date.now(),
    storageMode: "postgres",
    databaseSizeBytes: sizeResult.rows[0]?.size_bytes ?? 0,
    largestTables: tablesResult.rows.map((row) => ({
      tableName: row.table_name,
      totalBytes: row.total_bytes,
    })),
  };
}

export async function runDatabaseMaintenance(
  pool: Pool,
  config: DatabaseMaintenanceConfig,
  now = Date.now(),
): Promise<DatabaseMaintenanceSummary> {
  const startedAt = Date.now();
  const deleted: DatabaseMaintenanceSummary["deleted"] = {
    snapshots: 0,
    pnlSnapshots: 0,
    runEvents: 0,
    fills: 0,
    venueOrders: 0,
    closedIntents: 0,
    settlements: 0,
    bridgeTransfers: 0,
  };

  deleted.fills = await deleteBefore(pool, config.retention.fillsMs, now, `
    DELETE FROM fills
    WHERE filled_at < $1
  `);

  deleted.venueOrders = await deleteBefore(pool, config.retention.venueOrdersMs, now, `
    DELETE FROM venue_orders
    WHERE status IN ('filled', 'canceled', 'rejected', 'expired')
      AND updated_at < $1
  `);

  deleted.closedIntents = await deleteBefore(pool, config.retention.closedIntentsMs, now, `
    DELETE FROM order_intents
    WHERE status IN ('settled', 'failed', 'canceled', 'unwound')
      AND COALESCE(resolved_at, updated_at, created_at) < $1
  `);

  deleted.settlements = await deleteBefore(pool, config.retention.settlementsMs, now, `
    DELETE FROM settlements
    WHERE settled_at < $1
  `);

  deleted.bridgeTransfers = await deleteBefore(pool, config.retention.bridgeTransfersMs, now, `
    DELETE FROM bridge_transfers
    WHERE updated_at < $1
  `);

  deleted.runEvents = await deleteBefore(pool, config.retention.runEventsMs, now, `
    DELETE FROM run_events
    WHERE created_at < $1
  `);

  deleted.pnlSnapshots = await deleteBefore(pool, config.retention.pnlSnapshotsMs, now, `
    DELETE FROM pnl_snapshots
    WHERE captured_at < $1
  `);

  deleted.snapshots = await deleteBefore(pool, config.retention.snapshotsMs, now, `
    DELETE FROM opportunity_snapshots
    WHERE captured_at < $1
  `);

  return {
    startedAt,
    finishedAt: Date.now(),
    deleted,
  };
}

export async function listRecentBridgeTransfers(pool: Pool, limit = 10): Promise<BridgeTransfer[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM bridge_transfers
      ORDER BY updated_at DESC
      LIMIT $1
    `,
    [limit],
  );
  return result.rows.map(mapBridgeTransferRow);
}

export async function insertRunEvent(pool: Pool, event: RunEvent) {
  await pool.query(
    `
      INSERT INTO run_events (level, event_type, message, payload_json, created_at)
      VALUES ($1, $2, $3, $4::jsonb, $5)
    `,
    [
      event.level,
      event.eventType,
      event.message,
      JSON.stringify(event.payload),
      event.createdAt,
    ],
  );
}

export async function listRecentRunEvents(pool: Pool, limit = 20): Promise<RunEvent[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM run_events
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    level: row.level,
    eventType: row.event_type,
    message: row.message,
    payload: row.payload_json,
    createdAt: row.created_at,
  }));
}

export async function upsertCircuitBreaker(pool: Pool, breaker: CircuitBreaker) {
  await pool.query(
    `
      INSERT INTO circuit_breakers (key, active, reason, triggered_at, payload_json)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (key) DO UPDATE SET
        active = EXCLUDED.active,
        reason = EXCLUDED.reason,
        triggered_at = EXCLUDED.triggered_at,
        payload_json = EXCLUDED.payload_json
    `,
    [
      breaker.key,
      breaker.active,
      breaker.reason,
      breaker.triggeredAt,
      JSON.stringify(breaker.payload),
    ],
  );
}

export async function listCircuitBreakers(pool: Pool): Promise<CircuitBreaker[]> {
  const result = await pool.query("SELECT * FROM circuit_breakers ORDER BY key ASC");
  return result.rows.map((row) => ({
    key: row.key,
    active: row.active,
    reason: row.reason,
    triggeredAt: row.triggered_at,
    payload: row.payload_json,
  }));
}

export async function buildDashboardResponse(pool: Pool, slot: MarketSlot): Promise<DashboardResponse> {
  const latestSnapshot = await getLatestOpportunitySnapshot(pool, slot.key);
  const allBreakers = await listCircuitBreakers(pool);
  const relevantBreakers = allBreakers.filter(
    (breaker) => breaker.key === "global" || breaker.key === `slot:${slot.key}`,
  );
  const pnl = await getLatestPnlSnapshot(pool);
  const baselineEquityUsd = pnl ? await getFirstTrackedEquityUsd(pool) : null;
  return {
    fetchedAt: Date.now(),
    slot,
    config: await getStrategyConfig(pool),
    workerState: await getWorkerState(pool),
    latestSnapshot,
    feedHealth: latestSnapshot ? [latestSnapshot.polymarket.feedHealth, latestSnapshot.kalshi.feedHealth] : [],
    opportunities: latestSnapshot?.opportunities ?? [],
    venueBalances: await listVenueBalances(pool),
    openIntents: await listOpenOrderIntents(pool),
    recentOrders: await listRecentVenueOrders(pool, 20),
    recentFills: await listRecentFills(pool, 20),
    positions: await listPositions(pool),
    pnl: pnl ? enrichPnlSnapshot(pnl, baselineEquityUsd) : null,
    bridgeTransfers: await listRecentBridgeTransfers(pool, 5),
    circuitBreakers: relevantBreakers,
    runEvents: await listRecentRunEvents(pool, 10),
  };
}

export async function buildTradesResponse(pool: Pool): Promise<TradesResponse> {
  return {
    fetchedAt: Date.now(),
    intents: await listRecentOrderIntents(pool),
    orders: await listRecentVenueOrders(pool),
    fills: await listRecentFills(pool),
  };
}

export async function buildHistoryPoints(pool: Pool, slot: MarketSlot): Promise<HistoryPoint[]> {
  const snapshots = await getOpportunitySnapshotsForSlot(pool, slot.key);

  return snapshots.map((snapshot) => {
    const first = snapshot.opportunities[0];
    const second = snapshot.opportunities[1];

    return {
      ts: snapshot.capturedAt,
      polyUpBuy: snapshot.polymarket.outcomes.up.chart.price,
      polyDownBuy: snapshot.polymarket.outcomes.down.chart.price,
      kalshiYesLast: snapshot.kalshi.outcomes.yes.chart.price,
      kalshiNoLast: snapshot.kalshi.outcomes.no.chart.price,
      grossCostUpNo: first?.combination === "POLY_UP_KALSHI_NO" ? first.grossCost : second?.grossCost ?? null,
      grossCostDownYes:
        first?.combination === "POLY_DOWN_KALSHI_YES" ? first.grossCost : second?.grossCost ?? null,
    };
  });
}

function mapOpportunitySnapshotRow(row: any) {
  return {
    id: row.id,
    shadow: row.shadow,
    slotKey: row.slot_key,
    slotStartTs: row.slot_start_ts,
    slotEndTs: row.slot_end_ts,
    capturedAt: row.captured_at,
    polymarket: row.polymarket_json,
    kalshi: row.kalshi_json,
    opportunities: row.opportunities_json ?? [],
  };
}

function mapOrderIntentRow(row: any): OrderIntent {
  return {
    id: row.id,
    shadow: row.shadow,
    slotKey: row.slot_key,
    slotStartTs: row.slot_start_ts,
    slotEndTs: row.slot_end_ts,
    combination: row.combination,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    primaryVenue: row.primary_venue,
    hedgeVenue: row.hedge_venue,
    grossCost: row.gross_cost,
    targetNotionalUsd: row.target_notional_usd,
    maxSlippageBps: row.max_slippage_bps,
    failureReason: row.failure_reason,
    projectedNetProfitUsd: row.projected_net_profit_usd,
    realizedPnlUsd: row.realized_pnl_usd,
    roi: row.roi,
    polyResolution: row.poly_resolution,
    kalshiResolution: row.kalshi_resolution,
    legs: row.legs_json,
  };
}

function mapVenueOrderRow(row: any): LiveOrder {
  return {
    id: row.id,
    shadow: row.shadow,
    intentId: row.intent_id,
    venue: row.venue,
    venueOrderId: row.venue_order_id,
    clientOrderId: row.client_order_id,
    marketRef: row.market_ref,
    tokenId: row.token_id,
    side: row.side,
    outcome: row.outcome,
    orderType: row.order_type,
    requestedPrice: row.requested_price,
    requestedSize: row.requested_size,
    filledSize: row.filled_size,
    averageFillPrice: row.average_fill_price,
    feeUsd: row.fee_usd,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    raw: row.raw_json ?? {},
  };
}

function mapFillRow(row: any): LiveFill {
  return {
    id: row.id,
    shadow: row.shadow,
    intentId: row.intent_id,
    venue: row.venue,
    venueOrderId: row.venue_order_id,
    tradeId: row.trade_id,
    marketRef: row.market_ref,
    tokenId: row.token_id,
    side: row.side,
    outcome: row.outcome,
    price: row.price,
    size: row.size,
    feeUsd: row.fee_usd,
    liquidity: row.liquidity,
    filledAt: row.filled_at,
    raw: row.raw_json ?? {},
  };
}

function mapPositionRow(row: any): PositionSnapshot {
  return {
    id: row.id,
    venue: row.venue,
    marketRef: row.market_ref,
    outcome: row.outcome,
    size: row.size,
    averagePrice: row.average_price,
    currentPrice: row.current_price,
    currentValueUsd: row.current_value_usd,
    realizedPnlUsd: row.realized_pnl_usd,
    unrealizedPnlUsd: row.unrealized_pnl_usd,
    redeemable: row.redeemable,
    mergeable: row.mergeable,
    updatedAt: row.updated_at,
    raw: row.raw_json ?? {},
  };
}

function mapPnlSnapshotRow(row: any): PnlSnapshot {
  return enrichPnlSnapshot({
    id: row.id,
    capturedAt: row.captured_at,
    equityUsd: row.equity_usd,
    cashUsd: row.cash_usd,
    positionsValueUsd: row.positions_value_usd,
    realizedPnlUsd: row.realized_pnl_usd,
    unrealizedPnlUsd: row.unrealized_pnl_usd,
    feesUsd: row.fees_usd,
    venueBreakdown: row.venue_breakdown_json,
  });
}

function mapBridgeTransferRow(row: any): BridgeTransfer {
  return {
    id: row.id,
    venue: row.venue,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    quoteId: row.quote_id,
    sourceChain: row.source_chain,
    sourceAsset: row.source_asset,
    targetAsset: row.target_asset,
    amountInUsd: row.amount_in_usd,
    amountOutUsd: row.amount_out_usd,
    txHash: row.tx_hash,
    depositAddresses: row.deposit_addresses_json,
    raw: row.raw_json ?? {},
  };
}

async function deleteBefore(
  pool: Pool,
  retentionMs: number | null,
  now: number,
  sql: string,
) {
  if (retentionMs === null) {
    return 0;
  }

  const cutoff = now - retentionMs;
  const result = await pool.query(sql, [cutoff]);
  return result.rowCount ?? 0;
}
