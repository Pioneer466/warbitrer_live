import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_DB_PATH, DEFAULT_SETTINGS } from "@/lib/constants";
import { normalizeSettings } from "@/lib/settings-schema";
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

let singleton: DatabaseSync | null = null;
let singletonPath: string | null = null;

export function getDb(filePath = DEFAULT_DB_PATH) {
  if (!singleton || singletonPath !== filePath) {
    ensureDbDirectory(filePath);
    singleton = new DatabaseSync(filePath);
    singletonPath = filePath;
    bootstrapDatabase(singleton);
  }

  return singleton;
}

export function createDb(filePath = ":memory:") {
  const db = new DatabaseSync(filePath);
  bootstrapDatabase(db);
  return db;
}

export function bootstrapDatabase(db: DatabaseSync) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worker_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_tick_at INTEGER,
      current_slot_key TEXT,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_key TEXT NOT NULL,
      slot_start_ts INTEGER NOT NULL,
      slot_end_ts INTEGER NOT NULL,
      captured_at INTEGER NOT NULL,
      polymarket_json TEXT NOT NULL,
      kalshi_json TEXT NOT NULL,
      signals_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS snapshots_slot_key_idx ON snapshots(slot_key, captured_at);
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      slot_key TEXT NOT NULL,
      slot_start_ts INTEGER NOT NULL,
      slot_end_ts INTEGER NOT NULL,
      entered_at INTEGER NOT NULL,
      resolved_at INTEGER,
      combination TEXT NOT NULL,
      status TEXT NOT NULL,
      gross_pair_cost REAL NOT NULL,
      threshold_met INTEGER NOT NULL,
      units INTEGER NOT NULL,
      budget_allocated REAL NOT NULL,
      capital_deployed REAL NOT NULL,
      fees_total REAL NOT NULL,
      realized_pnl REAL,
      roi REAL,
      theoretical_same_resolution_profit REAL NOT NULL,
      poly_resolution TEXT,
      kalshi_resolution TEXT
    );
    CREATE INDEX IF NOT EXISTS trades_slot_idx ON trades(slot_key, entered_at);
    CREATE TABLE IF NOT EXISTS trade_legs (
      id TEXT PRIMARY KEY,
      trade_id TEXT NOT NULL,
      venue TEXT NOT NULL,
      outcome TEXT NOT NULL,
      market_ref TEXT NOT NULL,
      price REAL NOT NULL,
      units REAL NOT NULL,
      gross_cost REAL NOT NULL,
      fee_usd REAL NOT NULL,
      fee_shares REAL NOT NULL,
      net_shares REAL NOT NULL,
      payout REAL,
      resolved_outcome TEXT,
      status TEXT NOT NULL,
      FOREIGN KEY(trade_id) REFERENCES trades(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS trade_legs_trade_idx ON trade_legs(trade_id);
  `);

  const settingsCount = db.prepare("SELECT COUNT(*) AS count FROM settings").get() as {
    count: number;
  };
  if (settingsCount.count === 0) {
    db.prepare("INSERT INTO settings (id, payload, updated_at) VALUES (1, ?, ?)")
      .run(JSON.stringify(DEFAULT_SETTINGS), Date.now());
  }

  const workerCount = db.prepare("SELECT COUNT(*) AS count FROM worker_state").get() as {
    count: number;
  };
  if (workerCount.count === 0) {
    db.prepare(
      "INSERT INTO worker_state (id, last_tick_at, current_slot_key, last_error) VALUES (1, NULL, NULL, NULL)",
    ).run();
  }
}

export function getSettings(db: DatabaseSync): PaperSettings {
  const row = db.prepare("SELECT payload FROM settings WHERE id = 1").get() as {
    payload: string;
  };
  return normalizeSettings(JSON.parse(row.payload) as Partial<PaperSettings>);
}

export function updateSettings(db: DatabaseSync, payload: PaperSettings) {
  db.prepare("UPDATE settings SET payload = ?, updated_at = ? WHERE id = 1")
    .run(JSON.stringify(payload), Date.now());
  return payload;
}

export function updateWorkerState(db: DatabaseSync, state: Partial<WorkerState>) {
  db.prepare(
    `
      UPDATE worker_state
      SET
        last_tick_at = COALESCE(?, last_tick_at),
        current_slot_key = COALESCE(?, current_slot_key),
        last_error = ?
      WHERE id = 1
    `,
  ).run(
    state.lastTickAt ?? null,
    state.currentSlotKey ?? null,
    state.lastError ?? null,
  );
}

export function getWorkerState(db: DatabaseSync): WorkerState {
  const row = db.prepare(
    "SELECT last_tick_at, current_slot_key, last_error FROM worker_state WHERE id = 1",
  ).get() as {
    last_tick_at: number | null;
    current_slot_key: string | null;
    last_error: string | null;
  };

  return {
    lastTickAt: row.last_tick_at,
    currentSlotKey: row.current_slot_key,
    lastError: row.last_error,
  };
}

export function insertSnapshot(db: DatabaseSync, snapshot: SnapshotRecord) {
  db.prepare(
    `
      INSERT INTO snapshots (
        slot_key, slot_start_ts, slot_end_ts, captured_at,
        polymarket_json, kalshi_json, signals_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    snapshot.slotKey,
    snapshot.slotStartTs,
    snapshot.slotEndTs,
    snapshot.capturedAt,
    JSON.stringify(snapshot.polymarket),
    JSON.stringify(snapshot.kalshi),
    JSON.stringify(snapshot.signals),
  );
}

export function getLatestSnapshot(db: DatabaseSync): SnapshotRecord | null {
  const row = db.prepare(
    `
      SELECT *
      FROM snapshots
      ORDER BY captured_at DESC
      LIMIT 1
    `,
  ).get() as SnapshotDbRow | undefined;

  return row ? mapSnapshotRow(row) : null;
}

export function getLatestSnapshotForSlot(db: DatabaseSync, slotKey: string) {
  const row = db.prepare(
    `
      SELECT *
      FROM snapshots
      WHERE slot_key = ?
      ORDER BY captured_at DESC
      LIMIT 1
    `,
  ).get(slotKey) as SnapshotDbRow | undefined;

  return row ? mapSnapshotRow(row) : null;
}

export function getSnapshotsForSlot(db: DatabaseSync, slotKey: string) {
  const rows = db.prepare(
    `
      SELECT *
      FROM snapshots
      WHERE slot_key = ?
      ORDER BY captured_at ASC
    `,
  ).all(slotKey) as SnapshotDbRow[];

  return rows.map(mapSnapshotRow);
}

export function getLastEntryCosts(db: DatabaseSync, slotKey: string) {
  const rows = db.prepare(
    `
      SELECT combination, gross_pair_cost
      FROM trades
      WHERE slot_key = ?
      ORDER BY entered_at DESC
    `,
  ).all(slotKey) as Array<{
    combination: PairCombination;
    gross_pair_cost: number;
  }>;

  return rows.reduce<Partial<Record<PairCombination, number>>>((accumulator, row) => {
    if (accumulator[row.combination] === undefined) {
      accumulator[row.combination] = row.gross_pair_cost;
    }
    return accumulator;
  }, {});
}

export function insertTrade(db: DatabaseSync, trade: PaperTrade) {
  db.exec("BEGIN");
  try {
    db.prepare(
      `
        INSERT INTO trades (
          id, slot_key, slot_start_ts, slot_end_ts, entered_at, resolved_at,
          combination, status, gross_pair_cost, threshold_met, units,
          budget_allocated, capital_deployed, fees_total, realized_pnl, roi,
          theoretical_same_resolution_profit, poly_resolution, kalshi_resolution
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      trade.id,
      trade.slotKey,
      trade.slotStartTs,
      trade.slotEndTs,
      trade.enteredAt,
      trade.resolvedAt,
      trade.combination,
      trade.status,
      trade.grossPairCost,
      trade.thresholdMet ? 1 : 0,
      trade.units,
      trade.budgetAllocated,
      trade.capitalDeployed,
      trade.feesTotal,
      trade.realizedPnl,
      trade.roi,
      trade.theoreticalSameResolutionProfit,
      trade.polyResolution,
      trade.kalshiResolution,
    );

    const insertLeg = db.prepare(
      `
        INSERT INTO trade_legs (
          id, trade_id, venue, outcome, market_ref, price, units, gross_cost,
          fee_usd, fee_shares, net_shares, payout, resolved_outcome, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    for (const leg of trade.legs) {
      insertLeg.run(
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
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function updateTradeResolution(db: DatabaseSync, trade: PaperTrade) {
  db.exec("BEGIN");
  try {
    db.prepare(
      `
        UPDATE trades
        SET
          status = ?,
          resolved_at = ?,
          realized_pnl = ?,
          roi = ?,
          poly_resolution = ?,
          kalshi_resolution = ?
        WHERE id = ?
      `,
    ).run(
      trade.status,
      trade.resolvedAt,
      trade.realizedPnl,
      trade.roi,
      trade.polyResolution,
      trade.kalshiResolution,
      trade.id,
    );

    const updateLeg = db.prepare(
      `
        UPDATE trade_legs
        SET payout = ?, resolved_outcome = ?, status = ?
        WHERE id = ?
      `,
    );

    for (const leg of trade.legs) {
      updateLeg.run(leg.payout, leg.resolvedOutcome, leg.status, leg.id);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getOpenTrades(db: DatabaseSync) {
  const rows = db.prepare(
    `
      SELECT *
      FROM trades
      WHERE status = 'open'
      ORDER BY entered_at DESC
    `,
  ).all() as TradeDbRow[];

  return rows.map((row) => mapTradeRow(db, row));
}

export function getAllTrades(db: DatabaseSync) {
  const rows = db.prepare(
    `
      SELECT *
      FROM trades
      ORDER BY entered_at DESC
    `,
  ).all() as TradeDbRow[];

  return rows.map((row) => mapTradeRow(db, row));
}

export function buildMetrics(db: DatabaseSync, settings: PaperSettings): PaperMetrics {
  const tradeRows = db.prepare(
    `
      SELECT
        status,
        realized_pnl,
        capital_deployed,
        fees_total
      FROM trades
    `,
  ).all() as Array<{
    status: "open" | "resolved";
    realized_pnl: number | null;
    capital_deployed: number;
    fees_total: number;
  }>;

  const totalTrades = tradeRows.length;
  const resolvedRows = tradeRows.filter((row) => row.status === "resolved");
  const openRows = tradeRows.filter((row) => row.status === "open");
  const realizedPnl = resolvedRows.reduce((sum, row) => sum + (row.realized_pnl ?? 0), 0);
  const deployedCapital = openRows.reduce((sum, row) => sum + row.capital_deployed, 0);
  const feesPaid = tradeRows.reduce((sum, row) => sum + row.fees_total, 0);
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

export function buildDashboardResponse(
  db: DatabaseSync,
  slot: MarketSlot,
): DashboardResponse {
  const settings = getSettings(db);
  const latestSnapshot = getLatestSnapshotForSlot(db, slot.key);
  const openTrades = getOpenTrades(db);

  return {
    fetchedAt: Date.now(),
    slot,
    metrics: buildMetrics(db, settings),
    latestSnapshot,
    signals: latestSnapshot?.signals ?? [],
    openTrades,
    workerState: getWorkerState(db),
    settings,
  };
}

export function buildTradesResponse(db: DatabaseSync): TradesResponse {
  return {
    fetchedAt: Date.now(),
    trades: getAllTrades(db),
  };
}

export function resetPaperState(db: DatabaseSync) {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM trade_legs").run();
    db.prepare("DELETE FROM trades").run();
    db.prepare("DELETE FROM snapshots").run();
    db.prepare(
      "UPDATE worker_state SET last_tick_at = NULL, current_slot_key = NULL, last_error = NULL WHERE id = 1",
    ).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function buildHistoryPoints(db: DatabaseSync, slot: MarketSlot): HistoryPoint[] {
  return getSnapshotsForSlot(db, slot.key).map((snapshot) => ({
    ts: snapshot.capturedAt,
    polyUpBuy: snapshot.polymarket.outcomes.up.buyPrice,
    polyDownBuy: snapshot.polymarket.outcomes.down.buyPrice,
    kalshiYesAsk: snapshot.kalshi.outcomes.yes.buyPrice,
    kalshiNoAsk: snapshot.kalshi.outcomes.no.buyPrice,
  }));
}

type SnapshotDbRow = {
  id: number;
  slot_key: string;
  slot_start_ts: number;
  slot_end_ts: number;
  captured_at: number;
  polymarket_json: string;
  kalshi_json: string;
  signals_json: string;
};

type TradeDbRow = {
  id: string;
  slot_key: string;
  slot_start_ts: number;
  slot_end_ts: number;
  entered_at: number;
  resolved_at: number | null;
  combination: PairCombination;
  status: "open" | "resolved";
  gross_pair_cost: number;
  threshold_met: 0 | 1;
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

function mapSnapshotRow(row: SnapshotDbRow): SnapshotRecord {
  return {
    id: row.id,
    slotKey: row.slot_key,
    slotStartTs: row.slot_start_ts,
    slotEndTs: row.slot_end_ts,
    capturedAt: row.captured_at,
    polymarket: JSON.parse(row.polymarket_json),
    kalshi: JSON.parse(row.kalshi_json),
    signals: JSON.parse(row.signals_json) as PairSignal[],
  };
}

function mapTradeRow(db: DatabaseSync, row: TradeDbRow): PaperTrade {
  const legs = db.prepare(
    `
      SELECT *
      FROM trade_legs
      WHERE trade_id = ?
      ORDER BY venue ASC
    `,
  ).all(row.id) as Array<{
    id: string;
    trade_id: string;
    venue: "polymarket" | "kalshi";
    outcome: string;
    market_ref: string;
    price: number;
    units: number;
    gross_cost: number;
    fee_usd: number;
    fee_shares: number;
    net_shares: number;
    payout: number | null;
    resolved_outcome: string | null;
    status: "open" | "won" | "lost";
  }>;

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
    thresholdMet: Boolean(row.threshold_met),
    units: row.units,
    budgetAllocated: row.budget_allocated,
    capitalDeployed: row.capital_deployed,
    feesTotal: row.fees_total,
    realizedPnl: row.realized_pnl,
    roi: row.roi,
    theoreticalSameResolutionProfit: row.theoretical_same_resolution_profit,
    polyResolution: row.poly_resolution,
    kalshiResolution: row.kalshi_resolution,
    legs: legs.map((leg) => ({
      id: leg.id,
      tradeId: leg.trade_id,
      venue: leg.venue,
      outcome: leg.outcome as never,
      marketRef: leg.market_ref,
      price: leg.price,
      units: leg.units,
      grossCost: leg.gross_cost,
      feeUsd: leg.fee_usd,
      feeShares: leg.fee_shares,
      netShares: leg.net_shares,
      payout: leg.payout,
      resolvedOutcome: leg.resolved_outcome as never,
      status: leg.status,
    })),
  };
}

function ensureDbDirectory(filePath: string) {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
