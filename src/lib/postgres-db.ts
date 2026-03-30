import { Pool, types } from "pg";

import { DEFAULT_SETTINGS } from "@/lib/constants";
import type {
  DashboardResponse,
  HistoryPoint,
  MarketSlot,
  PairCombination,
  PairSignal,
  PaperMetrics,
  PaperSettings,
  PaperTrade,
  SnapshotRecord,
  TradesResponse,
  WorkerState,
} from "@/lib/types";

types.setTypeParser(20, (value) => Number(value));

let poolSingleton: Pool | null = null;
let bootstrapPromise: Promise<void> | null = null;

export async function getPgDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL est requis pour utiliser Postgres");
  }

  if (!poolSingleton) {
    poolSingleton = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
    });
  }

  if (!bootstrapPromise) {
    bootstrapPromise = bootstrapDatabase(poolSingleton);
  }

  await bootstrapPromise;
  return poolSingleton;
}

async function bootstrapDatabase(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worker_state (
      id INTEGER PRIMARY KEY,
      last_tick_at BIGINT,
      current_slot_key TEXT,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id BIGSERIAL PRIMARY KEY,
      slot_key TEXT NOT NULL,
      slot_start_ts BIGINT NOT NULL,
      slot_end_ts BIGINT NOT NULL,
      captured_at BIGINT NOT NULL,
      polymarket_json JSONB NOT NULL,
      kalshi_json JSONB NOT NULL,
      signals_json JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS snapshots_slot_key_idx ON snapshots(slot_key, captured_at);
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      slot_key TEXT NOT NULL,
      slot_start_ts BIGINT NOT NULL,
      slot_end_ts BIGINT NOT NULL,
      entered_at BIGINT NOT NULL,
      resolved_at BIGINT,
      combination TEXT NOT NULL,
      status TEXT NOT NULL,
      gross_pair_cost DOUBLE PRECISION NOT NULL,
      threshold_met BOOLEAN NOT NULL,
      units INTEGER NOT NULL,
      budget_allocated DOUBLE PRECISION NOT NULL,
      capital_deployed DOUBLE PRECISION NOT NULL,
      fees_total DOUBLE PRECISION NOT NULL,
      realized_pnl DOUBLE PRECISION,
      roi DOUBLE PRECISION,
      theoretical_same_resolution_profit DOUBLE PRECISION NOT NULL,
      poly_resolution TEXT,
      kalshi_resolution TEXT
    );
    CREATE INDEX IF NOT EXISTS trades_slot_idx ON trades(slot_key, entered_at);
    CREATE TABLE IF NOT EXISTS trade_legs (
      id TEXT PRIMARY KEY,
      trade_id TEXT NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
      venue TEXT NOT NULL,
      outcome TEXT NOT NULL,
      market_ref TEXT NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      units INTEGER NOT NULL,
      gross_cost DOUBLE PRECISION NOT NULL,
      fee_usd DOUBLE PRECISION NOT NULL,
      fee_shares DOUBLE PRECISION NOT NULL,
      net_shares DOUBLE PRECISION NOT NULL,
      payout DOUBLE PRECISION,
      resolved_outcome TEXT,
      status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trade_legs_trade_idx ON trade_legs(trade_id);
  `);

  await pool.query(
    `
      INSERT INTO settings (id, payload, updated_at)
      VALUES (1, $1::jsonb, $2)
      ON CONFLICT (id) DO NOTHING
    `,
    [JSON.stringify(DEFAULT_SETTINGS), Date.now()],
  );

  await pool.query(
    `
      INSERT INTO worker_state (id, last_tick_at, current_slot_key, last_error)
      VALUES (1, NULL, NULL, NULL)
      ON CONFLICT (id) DO NOTHING
    `,
  );
}

export async function getSettings(pool: Pool): Promise<PaperSettings> {
  const result = await pool.query("SELECT payload FROM settings WHERE id = 1");
  return result.rows[0].payload as PaperSettings;
}

export async function updateSettings(pool: Pool, payload: PaperSettings) {
  await pool.query("UPDATE settings SET payload = $1::jsonb, updated_at = $2 WHERE id = 1", [
    JSON.stringify(payload),
    Date.now(),
  ]);
  return payload;
}

export async function updateWorkerState(pool: Pool, state: Partial<WorkerState>) {
  await pool.query(
    `
      UPDATE worker_state
      SET
        last_tick_at = COALESCE($1, last_tick_at),
        current_slot_key = COALESCE($2, current_slot_key),
        last_error = $3
      WHERE id = 1
    `,
    [state.lastTickAt ?? null, state.currentSlotKey ?? null, state.lastError ?? null],
  );
}

export async function getWorkerState(pool: Pool): Promise<WorkerState> {
  const result = await pool.query(
    "SELECT last_tick_at, current_slot_key, last_error FROM worker_state WHERE id = 1",
  );
  const row = result.rows[0];
  return {
    lastTickAt: row.last_tick_at,
    currentSlotKey: row.current_slot_key,
    lastError: row.last_error,
  };
}

export async function insertSnapshot(pool: Pool, snapshot: SnapshotRecord) {
  await pool.query(
    `
      INSERT INTO snapshots (
        slot_key, slot_start_ts, slot_end_ts, captured_at,
        polymarket_json, kalshi_json, signals_json
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)
    `,
    [
      snapshot.slotKey,
      snapshot.slotStartTs,
      snapshot.slotEndTs,
      snapshot.capturedAt,
      JSON.stringify(snapshot.polymarket),
      JSON.stringify(snapshot.kalshi),
      JSON.stringify(snapshot.signals),
    ],
  );
}

export async function getLatestSnapshot(pool: Pool): Promise<SnapshotRecord | null> {
  const result = await pool.query(
    `
      SELECT *
      FROM snapshots
      ORDER BY captured_at DESC
      LIMIT 1
    `,
  );
  return result.rows[0] ? mapSnapshotRow(result.rows[0]) : null;
}

export async function getLatestSnapshotForSlot(pool: Pool, slotKey: string) {
  const result = await pool.query(
    `
      SELECT *
      FROM snapshots
      WHERE slot_key = $1
      ORDER BY captured_at DESC
      LIMIT 1
    `,
    [slotKey],
  );
  return result.rows[0] ? mapSnapshotRow(result.rows[0]) : null;
}

export async function getSnapshotsForSlot(pool: Pool, slotKey: string) {
  const result = await pool.query(
    `
      SELECT *
      FROM snapshots
      WHERE slot_key = $1
      ORDER BY captured_at ASC
    `,
    [slotKey],
  );
  return result.rows.map(mapSnapshotRow);
}

export async function getLastEntryCosts(pool: Pool, slotKey: string) {
  const result = await pool.query<{
    combination: PairCombination;
    gross_pair_cost: number;
  }>(
    `
      SELECT combination, gross_pair_cost
      FROM trades
      WHERE slot_key = $1
      ORDER BY entered_at DESC
    `,
    [slotKey],
  );

  return result.rows.reduce<Partial<Record<PairCombination, number>>>((accumulator, row) => {
    if (accumulator[row.combination] === undefined) {
      accumulator[row.combination] = row.gross_pair_cost;
    }
    return accumulator;
  }, {});
}

export async function insertTrade(pool: Pool, trade: PaperTrade) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO trades (
          id, slot_key, slot_start_ts, slot_end_ts, entered_at, resolved_at,
          combination, status, gross_pair_cost, threshold_met, units,
          budget_allocated, capital_deployed, fees_total, realized_pnl, roi,
          theoretical_same_resolution_profit, poly_resolution, kalshi_resolution
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      `,
      [
        trade.id,
        trade.slotKey,
        trade.slotStartTs,
        trade.slotEndTs,
        trade.enteredAt,
        trade.resolvedAt,
        trade.combination,
        trade.status,
        trade.grossPairCost,
        trade.thresholdMet,
        trade.units,
        trade.budgetAllocated,
        trade.capitalDeployed,
        trade.feesTotal,
        trade.realizedPnl,
        trade.roi,
        trade.theoreticalSameResolutionProfit,
        trade.polyResolution,
        trade.kalshiResolution,
      ],
    );

    for (const leg of trade.legs) {
      await client.query(
        `
          INSERT INTO trade_legs (
            id, trade_id, venue, outcome, market_ref, price, units, gross_cost,
            fee_usd, fee_shares, net_shares, payout, resolved_outcome, status
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        `,
        [
          leg.id,
          leg.tradeId,
          leg.venue,
          leg.outcome,
          leg.marketRef,
          leg.price,
          leg.units,
          leg.grossCost,
          leg.feeUsd,
          leg.feeShares,
          leg.netShares,
          leg.payout,
          leg.resolvedOutcome,
          leg.status,
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

export async function updateTradeResolution(pool: Pool, trade: PaperTrade) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        UPDATE trades
        SET
          status = $1,
          resolved_at = $2,
          realized_pnl = $3,
          roi = $4,
          poly_resolution = $5,
          kalshi_resolution = $6
        WHERE id = $7
      `,
      [
        trade.status,
        trade.resolvedAt,
        trade.realizedPnl,
        trade.roi,
        trade.polyResolution,
        trade.kalshiResolution,
        trade.id,
      ],
    );

    for (const leg of trade.legs) {
      await client.query(
        `
          UPDATE trade_legs
          SET payout = $1, resolved_outcome = $2, status = $3
          WHERE id = $4
        `,
        [leg.payout, leg.resolvedOutcome, leg.status, leg.id],
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

export async function getOpenTrades(pool: Pool) {
  const result = await pool.query(
    `
      SELECT *
      FROM trades
      WHERE status = 'open'
      ORDER BY entered_at DESC
    `,
  );
  return Promise.all(result.rows.map((row) => mapTradeRow(pool, row)));
}

export async function getAllTrades(pool: Pool) {
  const result = await pool.query(
    `
      SELECT *
      FROM trades
      ORDER BY entered_at DESC
    `,
  );
  return Promise.all(result.rows.map((row) => mapTradeRow(pool, row)));
}

export async function buildMetrics(pool: Pool, settings: PaperSettings): Promise<PaperMetrics> {
  const result = await pool.query(
    `
      SELECT status, realized_pnl, capital_deployed, fees_total
      FROM trades
    `,
  );

  const totalTrades = result.rows.length;
  const resolvedRows = result.rows.filter((row) => row.status === "resolved");
  const openRows = result.rows.filter((row) => row.status === "open");
  const realizedPnl = resolvedRows.reduce(
    (sum, row) => sum + (row.realized_pnl ?? 0),
    0,
  );
  const deployedCapital = openRows.reduce(
    (sum, row) => sum + row.capital_deployed,
    0,
  );
  const feesPaid = result.rows.reduce((sum, row) => sum + row.fees_total, 0);
  const totalEquity = settings.initialCapital + realizedPnl;
  const availableCapital = totalEquity - deployedCapital;
  const wins = resolvedRows.filter((row) => (row.realized_pnl ?? 0) > 0).length;

  return {
    totalEquity: round4(totalEquity),
    availableCapital: round4(availableCapital),
    deployedCapital: round4(deployedCapital),
    realizedPnl: round4(realizedPnl),
    feesPaid: round4(feesPaid),
    openTrades: openRows.length,
    totalTrades,
    resolvedTrades: resolvedRows.length,
    winRate: resolvedRows.length > 0 ? wins / resolvedRows.length : 0,
  };
}

export async function buildDashboardResponse(pool: Pool, slot: MarketSlot): Promise<DashboardResponse> {
  const settings = await getSettings(pool);
  const latestSnapshot = await getLatestSnapshotForSlot(pool, slot.key);
  const openTrades = await getOpenTrades(pool);

  return {
    fetchedAt: Date.now(),
    slot,
    metrics: await buildMetrics(pool, settings),
    latestSnapshot,
    signals: latestSnapshot?.signals ?? [],
    openTrades,
    workerState: await getWorkerState(pool),
    settings,
  };
}

export async function buildTradesResponse(pool: Pool): Promise<TradesResponse> {
  return {
    fetchedAt: Date.now(),
    trades: await getAllTrades(pool),
  };
}

export async function buildHistoryPoints(pool: Pool, slot: MarketSlot): Promise<HistoryPoint[]> {
  const snapshots = await getSnapshotsForSlot(pool, slot.key);
  return snapshots.map((snapshot) => ({
    ts: snapshot.capturedAt,
    polyUpBuy: snapshot.polymarket.outcomes.up.buyPrice,
    polyDownBuy: snapshot.polymarket.outcomes.down.buyPrice,
    kalshiYesAsk: snapshot.kalshi.outcomes.yes.buyPrice,
    kalshiNoAsk: snapshot.kalshi.outcomes.no.buyPrice,
  }));
}

async function mapTradeRow(pool: Pool, row: TradeRow): Promise<PaperTrade> {
  const legsResult = await pool.query(
    `
      SELECT *
      FROM trade_legs
      WHERE trade_id = $1
      ORDER BY venue ASC
    `,
    [row.id],
  );

  return {
    id: row.id,
    slotKey: row.slot_key,
    slotStartTs: row.slot_start_ts,
    slotEndTs: row.slot_end_ts,
    enteredAt: row.entered_at,
    resolvedAt: row.resolved_at,
    combination: row.combination,
    status: row.status,
    grossPairCost: row.gross_pair_cost,
    thresholdMet: row.threshold_met,
    units: row.units,
    budgetAllocated: row.budget_allocated,
    capitalDeployed: row.capital_deployed,
    feesTotal: row.fees_total,
    realizedPnl: row.realized_pnl,
    roi: row.roi,
    theoreticalSameResolutionProfit: row.theoretical_same_resolution_profit,
    polyResolution: row.poly_resolution,
    kalshiResolution: row.kalshi_resolution,
    legs: legsResult.rows.map((leg) => ({
      id: leg.id,
      tradeId: leg.trade_id,
      venue: leg.venue,
      outcome: leg.outcome,
      marketRef: leg.market_ref,
      price: leg.price,
      units: leg.units,
      grossCost: leg.gross_cost,
      feeUsd: leg.fee_usd,
      feeShares: leg.fee_shares,
      netShares: leg.net_shares,
      payout: leg.payout,
      resolvedOutcome: leg.resolved_outcome,
      status: leg.status,
    })),
  };
}

function mapSnapshotRow(row: SnapshotRow): SnapshotRecord {
  return {
    id: Number(row.id),
    slotKey: row.slot_key,
    slotStartTs: row.slot_start_ts,
    slotEndTs: row.slot_end_ts,
    capturedAt: row.captured_at,
    polymarket: row.polymarket_json,
    kalshi: row.kalshi_json,
    signals: row.signals_json as PairSignal[],
  };
}

type SnapshotRow = {
  id: number;
  slot_key: string;
  slot_start_ts: number;
  slot_end_ts: number;
  captured_at: number;
  polymarket_json: SnapshotRecord["polymarket"];
  kalshi_json: SnapshotRecord["kalshi"];
  signals_json: PairSignal[];
};

type TradeRow = {
  id: string;
  slot_key: string;
  slot_start_ts: number;
  slot_end_ts: number;
  entered_at: number;
  resolved_at: number | null;
  combination: PairCombination;
  status: "open" | "resolved";
  gross_pair_cost: number;
  threshold_met: boolean;
  units: number;
  budget_allocated: number;
  capital_deployed: number;
  fees_total: number;
  realized_pnl: number | null;
  roi: number | null;
  theoretical_same_resolution_profit: number;
  poly_resolution: "UP" | "DOWN" | null;
  kalshi_resolution: "YES" | "NO" | null;
};

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
