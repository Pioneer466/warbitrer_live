import * as postgres from "@/lib/postgres-db";
import type {
  BridgeTransfer,
  CircuitBreaker,
  DatabaseMaintenanceSummary,
  DatabaseMetrics,
  DashboardResponse,
  HistoryPoint,
  LiveFill,
  LiveOrder,
  MarketSlot,
  OpportunitySnapshot,
  OrderIntent,
  PnlSnapshot,
  PositionSnapshot,
  RunEvent,
  StrategyConfig,
  TradesResponse,
  Venue,
  VenueBalance,
  WorkerState,
} from "@/lib/types";

export function storageMode() {
  return "postgres";
}

async function db() {
  return postgres.getPgDb();
}

export async function readSettings(): Promise<StrategyConfig> {
  return postgres.getStrategyConfig(await db());
}

export async function writeSettings(payload: StrategyConfig) {
  return postgres.updateStrategyConfig(await db(), payload);
}

export async function readWorkerState(): Promise<WorkerState> {
  return postgres.getWorkerState(await db());
}

export async function writeWorkerState(state: Partial<WorkerState>) {
  return postgres.updateWorkerState(await db(), state);
}

export async function writeSnapshot(snapshot: {
  slotKey: string;
  slotStartTs: number;
  slotEndTs: number;
  capturedAt: number;
  polymarket: unknown;
  kalshi: unknown;
  opportunities: any[];
}) {
  return postgres.insertOpportunitySnapshot(await db(), snapshot);
}

export async function readLatestSnapshot(slotKey?: string): Promise<OpportunitySnapshot | null> {
  return postgres.getLatestOpportunitySnapshot(await db(), slotKey);
}

export async function readLastEntryCosts(slotKey: string) {
  return postgres.getLastEntryCosts(await db(), slotKey);
}

export async function writeVenueBalance(balance: VenueBalance) {
  return postgres.upsertVenueBalance(await db(), balance);
}

export async function readVenueBalances() {
  return postgres.listVenueBalances(await db());
}

export async function writeOrderIntent(intent: OrderIntent) {
  return postgres.upsertOrderIntent(await db(), intent);
}

export async function readOpenOrderIntents() {
  return postgres.listOpenOrderIntents(await db());
}

export async function readRecentOrderIntents(limit?: number) {
  return postgres.listRecentOrderIntents(await db(), limit);
}

export async function findOrderIntent(intentId: string) {
  return postgres.findOrderIntent(await db(), intentId);
}

export async function writeVenueOrder(order: LiveOrder) {
  return postgres.upsertVenueOrder(await db(), order);
}

export async function readOpenVenueOrders() {
  return postgres.listOpenVenueOrders(await db());
}

export async function readRecentVenueOrders(limit?: number) {
  return postgres.listRecentVenueOrders(await db(), limit);
}

export async function findVenueOrder(venue: string, venueOrderId: string) {
  return postgres.findVenueOrderByExchangeId(await db(), venue, venueOrderId);
}

export async function writeFill(fill: LiveFill) {
  return postgres.upsertFill(await db(), fill);
}

export async function readRecentFills(limit?: number) {
  return postgres.listRecentFills(await db(), limit);
}

export async function readFillsForIntentVenue(intentId: string, venue: Venue) {
  return postgres.listFillsForIntentVenue(await db(), intentId, venue);
}

export async function replaceVenuePositions(venue: "polymarket" | "kalshi", positions: PositionSnapshot[]) {
  return postgres.replaceVenuePositions(await db(), venue, positions);
}

export async function readPositions() {
  return postgres.listPositions(await db());
}

export async function writeSettlement(settlement: Parameters<typeof postgres.upsertSettlement>[1]) {
  return postgres.upsertSettlement(await db(), settlement);
}

export async function writePnlSnapshot(snapshot: PnlSnapshot) {
  return postgres.insertPnlSnapshot(await db(), snapshot);
}

export async function readLatestPnlSnapshot() {
  return postgres.getLatestPnlSnapshot(await db());
}

export async function writeBridgeTransfer(transfer: BridgeTransfer) {
  return postgres.upsertBridgeTransfer(await db(), transfer);
}

export async function readBridgeTransfers(limit?: number) {
  return postgres.listRecentBridgeTransfers(await db(), limit);
}

export async function writeRunEvent(event: RunEvent) {
  return postgres.insertRunEvent(await db(), event);
}

export async function readRunEvents(limit?: number) {
  return postgres.listRecentRunEvents(await db(), limit);
}

export async function readDatabaseMetrics(): Promise<DatabaseMetrics> {
  return postgres.getDatabaseMetrics(await db());
}

export async function runDatabaseMaintenance(
  config: Parameters<typeof postgres.runDatabaseMaintenance>[1],
  now?: number,
): Promise<DatabaseMaintenanceSummary> {
  return postgres.runDatabaseMaintenance(await db(), config, now);
}

export async function writeCircuitBreaker(breaker: CircuitBreaker) {
  return postgres.upsertCircuitBreaker(await db(), breaker);
}

export async function readCircuitBreakers() {
  return postgres.listCircuitBreakers(await db());
}

export async function readDashboard(slot: MarketSlot): Promise<DashboardResponse> {
  return postgres.buildDashboardResponse(await db(), slot);
}

export async function readTrades(): Promise<TradesResponse> {
  return postgres.buildTradesResponse(await db());
}

export async function readHistoryPoints(slot: MarketSlot): Promise<HistoryPoint[]> {
  return postgres.buildHistoryPoints(await db(), slot);
}
