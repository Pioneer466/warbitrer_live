import * as postgres from "@/lib/postgres-db";
import type {
  DashboardResponse,
  HistoryPoint,
  MarketSlot,
  PairCombination,
  PaperSettings,
  PaperTrade,
  SnapshotRecord,
  TradesResponse,
  WorkerState,
} from "@/lib/types";

function usePostgres() {
  return Boolean(process.env.DATABASE_URL);
}

type SqliteModule = typeof import("@/lib/db");

let sqliteModulePromise: Promise<SqliteModule> | null = null;

async function getSqlite() {
  if (!sqliteModulePromise) {
    sqliteModulePromise = import("@/lib/db");
  }

  return sqliteModulePromise;
}

export function storageMode() {
  return usePostgres() ? "postgres" : "sqlite";
}

export async function readSettings(): Promise<PaperSettings> {
  if (usePostgres()) {
    return postgres.getSettings(await postgres.getPgDb());
  }
  const sqlite = await getSqlite();
  return sqlite.getSettings(sqlite.getDb());
}

export async function writeSettings(payload: PaperSettings) {
  if (usePostgres()) {
    return postgres.updateSettings(await postgres.getPgDb(), payload);
  }
  const sqlite = await getSqlite();
  return sqlite.updateSettings(sqlite.getDb(), payload);
}

export async function writeWorkerState(state: Partial<WorkerState>) {
  if (usePostgres()) {
    return postgres.updateWorkerState(await postgres.getPgDb(), state);
  }
  const sqlite = await getSqlite();
  return sqlite.updateWorkerState(sqlite.getDb(), state);
}

export async function readWorkerState() {
  if (usePostgres()) {
    return postgres.getWorkerState(await postgres.getPgDb());
  }
  const sqlite = await getSqlite();
  return sqlite.getWorkerState(sqlite.getDb());
}

export async function writeSnapshot(snapshot: SnapshotRecord) {
  if (usePostgres()) {
    return postgres.insertSnapshot(await postgres.getPgDb(), snapshot);
  }
  const sqlite = await getSqlite();
  return sqlite.insertSnapshot(sqlite.getDb(), snapshot);
}

export async function readLastEntryCosts(slotKey: string) {
  if (usePostgres()) {
    return postgres.getLastEntryCosts(await postgres.getPgDb(), slotKey);
  }
  const sqlite = await getSqlite();
  return sqlite.getLastEntryCosts(sqlite.getDb(), slotKey);
}

export async function writeTrade(trade: PaperTrade) {
  if (usePostgres()) {
    return postgres.insertTrade(await postgres.getPgDb(), trade);
  }
  const sqlite = await getSqlite();
  return sqlite.insertTrade(sqlite.getDb(), trade);
}

export async function resolveTrade(trade: PaperTrade) {
  if (usePostgres()) {
    return postgres.updateTradeResolution(await postgres.getPgDb(), trade);
  }
  const sqlite = await getSqlite();
  return sqlite.updateTradeResolution(sqlite.getDb(), trade);
}

export async function readOpenTrades(): Promise<PaperTrade[]> {
  if (usePostgres()) {
    return postgres.getOpenTrades(await postgres.getPgDb());
  }
  const sqlite = await getSqlite();
  return sqlite.getOpenTrades(sqlite.getDb());
}

export async function readDashboard(slot: MarketSlot): Promise<DashboardResponse> {
  if (usePostgres()) {
    return postgres.buildDashboardResponse(await postgres.getPgDb(), slot);
  }
  const sqlite = await getSqlite();
  return sqlite.buildDashboardResponse(sqlite.getDb(), slot);
}

export async function readTrades(): Promise<TradesResponse> {
  if (usePostgres()) {
    return postgres.buildTradesResponse(await postgres.getPgDb());
  }
  const sqlite = await getSqlite();
  return sqlite.buildTradesResponse(sqlite.getDb());
}

export async function resetPaperState() {
  if (usePostgres()) {
    return postgres.resetPaperState(await postgres.getPgDb());
  }
  const sqlite = await getSqlite();
  return sqlite.resetPaperState(sqlite.getDb());
}

export async function readHistoryPoints(slot: MarketSlot): Promise<HistoryPoint[]> {
  if (usePostgres()) {
    return postgres.buildHistoryPoints(await postgres.getPgDb(), slot);
  }
  const sqlite = await getSqlite();
  return sqlite.buildHistoryPoints(sqlite.getDb(), slot);
}

export async function readAllTrades(): Promise<PaperTrade[]> {
  if (usePostgres()) {
    return postgres.getAllTrades(await postgres.getPgDb());
  }
  const sqlite = await getSqlite();
  return sqlite.getAllTrades(sqlite.getDb());
}

export async function readLatestEntryCost(slotKey: string, combination: PairCombination) {
  const costs = await readLastEntryCosts(slotKey);
  return costs[combination];
}
