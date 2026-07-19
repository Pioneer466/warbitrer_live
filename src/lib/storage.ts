import * as postgres from "@/lib/postgres-db";
import { isMarketAsset } from "@/lib/market-catalog";
import { queueRunEventNotification } from "@/lib/notifications";
import type { OracleSlotSample, SlotResolutionRecord } from "@/lib/oracle-history";
import type { GlobalRiskConfig } from "@/lib/risk-settings";
import type {
  MarketAsset,
  BridgeTransfer,
  CircuitBreaker,
  DatabaseMaintenanceSummary,
  DatabaseMetrics,
  ExecutionCandidate,
  DashboardResponse,
  HistoryPoint,
  LiveFill,
  LiveOpportunity,
  LiveOrder,
  MarketSlot,
  MarketFillQualityEvent,
  NotificationDelivery,
  OpportunitySnapshot,
  OrderAttempt,
  OrderIntent,
  PortfolioDashboardResponse,
  PnlSnapshot,
  PositionSnapshot,
  RunEvent,
  StrategyConfig,
  StrategyConfigMap,
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

export async function readSettings(asset: MarketAsset): Promise<StrategyConfig> {
  return postgres.getStrategyConfig(await db(), asset);
}

export async function readSettingsMap(): Promise<StrategyConfigMap> {
  return postgres.listStrategyConfigs(await db());
}

export async function writeSettings(asset: MarketAsset, payload: StrategyConfig) {
  return postgres.updateStrategyConfig(await db(), asset, payload);
}

export async function readGlobalRiskConfig(): Promise<GlobalRiskConfig> {
  return postgres.getGlobalRiskConfig(await db());
}

export async function writeGlobalRiskConfig(payload: GlobalRiskConfig) {
  return postgres.updateGlobalRiskConfig(await db(), payload);
}

export async function readWorkerState(asset: MarketAsset): Promise<WorkerState> {
  return postgres.getWorkerState(await db(), asset);
}

export async function readWorkerStates() {
  return postgres.listWorkerStates(await db());
}

export async function writeWorkerState(asset: MarketAsset, state: Partial<WorkerState>) {
  return postgres.updateWorkerState(await db(), asset, state);
}

export async function writeSnapshot(snapshot: {
  asset: MarketAsset;
  slotKey: string;
  slotStartTs: number;
  slotEndTs: number;
  capturedAt: number;
  polymarket: unknown;
  kalshi: unknown;
  opportunities: LiveOpportunity[];
}) {
  return postgres.insertOpportunitySnapshot(await db(), snapshot);
}

export async function writeOracleSlotSample(sample: OracleSlotSample) {
  return postgres.insertOracleSlotSample(await db(), sample);
}

export async function writeSlotResolution(resolution: SlotResolutionRecord) {
  return postgres.upsertSlotResolution(await db(), resolution);
}

export async function readPendingSlotResolutions(now: number, limit?: number) {
  return postgres.listPendingSlotResolutions(await db(), now, limit);
}

export async function readLatestSnapshot(asset: MarketAsset, slotKey?: string): Promise<OpportunitySnapshot | null> {
  return postgres.getLatestOpportunitySnapshot(await db(), asset, slotKey);
}

export async function readLastEntryCosts(asset: MarketAsset, slotKey: string) {
  return postgres.getLastEntryCosts(await db(), asset, slotKey);
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

export async function readOpenOrderIntents(asset?: MarketAsset) {
  return postgres.listOpenOrderIntents(await db(), asset);
}

export async function readRecentOrderIntents(limit?: number, asset?: MarketAsset) {
  return postgres.listRecentOrderIntents(await db(), limit, asset);
}

export async function readRecentSettledOrderIntents(limit?: number, asset?: MarketAsset) {
  return postgres.listRecentSettledOrderIntents(await db(), limit, asset);
}

export async function findOrderIntent(intentId: string) {
  return postgres.findOrderIntent(await db(), intentId);
}

export async function writeVenueOrder(order: LiveOrder) {
  return postgres.upsertVenueOrder(await db(), order);
}

export async function writeOrderAttempt(attempt: OrderAttempt) {
  return postgres.upsertOrderAttempt(await db(), attempt);
}

export async function readRecentOrderAttempts(limit?: number, asset?: MarketAsset) {
  return postgres.listRecentOrderAttempts(await db(), limit, asset);
}

export async function findOrderAttemptById(attemptId: string) {
  return postgres.findOrderAttemptById(await db(), attemptId);
}

export async function readOrderAttemptsForIntent(intentId: string) {
  return postgres.listOrderAttemptsForIntent(await db(), intentId);
}

export async function writeMarketFillQualityEvent(event: MarketFillQualityEvent) {
  return postgres.insertMarketFillQualityEvent(await db(), event);
}

export async function readDegradedMarketFillQualityCounts(since: number, asset?: MarketAsset) {
  return postgres.listDegradedMarketFillQualityCounts(await db(), since, asset);
}

export async function readStableRealizedPnlSince(since: number, until: number) {
  return postgres.sumStableRealizedPnlSince(await db(), since, until);
}

export async function readOpenVenueOrders(asset?: MarketAsset) {
  return postgres.listOpenVenueOrders(await db(), asset);
}

export async function readRecentVenueOrders(limit?: number, asset?: MarketAsset) {
  return postgres.listRecentVenueOrders(await db(), limit, asset);
}

export async function findVenueOrder(venue: string, venueOrderId: string) {
  return postgres.findVenueOrderByExchangeId(await db(), venue, venueOrderId);
}

export async function writeFill(fill: LiveFill) {
  return postgres.upsertFill(await db(), fill);
}

export async function readRecentFills(limit?: number, asset?: MarketAsset) {
  return postgres.listRecentFills(await db(), limit, asset);
}

export async function readFillsForIntentVenue(intentId: string, venue: Venue) {
  return postgres.listFillsForIntentVenue(await db(), intentId, venue);
}

export async function replaceVenuePositions(
  venue: "polymarket" | "kalshi",
  asset: MarketAsset,
  positions: PositionSnapshot[],
) {
  return postgres.replaceVenuePositions(await db(), venue, asset, positions);
}

export async function readPositions(asset?: MarketAsset) {
  return postgres.listPositions(await db(), asset);
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

export async function readPolymarketCashAdjustmentObservation(intentId: string) {
  return postgres.getPolymarketCashAdjustmentObservation(await db(), intentId);
}

export async function writeStablePnlChange(intent: OrderIntent, changedAt: number, stability: Record<string, unknown>) {
  return postgres.insertStablePnlChange(await db(), intent, changedAt, stability);
}

export async function updateStablePnlChangeFromIntent(intent: OrderIntent) {
  return postgres.updateStablePnlChangeFromIntent(await db(), intent);
}

export async function readLiveRealizedPnlUsd() {
  return postgres.getLiveRealizedPnlUsd(await db());
}

export async function readLiveFeesUsd() {
  return postgres.getLiveFeesUsd(await db());
}

export async function writeBridgeTransfer(transfer: BridgeTransfer) {
  return postgres.upsertBridgeTransfer(await db(), transfer);
}

export async function readBridgeTransfers(limit?: number) {
  return postgres.listRecentBridgeTransfers(await db(), limit);
}

export async function writeRunEvent(event: RunEvent) {
  if (event.level === "warn" || event.level === "error") {
    const logger = event.level === "error" ? console.error : console.warn;
    logger(`[run-event] ${event.eventType}: ${event.message}`, event.payload ?? {});
  }

  const resolvedEvent = {
    ...event,
    asset: await inferRunEventAsset(event),
  };
  await postgres.insertRunEvent(await db(), resolvedEvent);
  try {
    await queueRunEventNotification(resolvedEvent);
  } catch (error) {
    console.warn("[notifications] queue failed", error);
  }
}

export async function readRunEvents(limit?: number, asset?: MarketAsset | null) {
  return postgres.listRecentRunEvents(await db(), limit, asset);
}

export async function writeNotificationDelivery(
  delivery: Omit<NotificationDelivery, "id" | "status" | "updatedAt" | "sentAt" | "error">,
) {
  return postgres.enqueueNotificationDelivery(await db(), delivery);
}

export async function readPendingNotificationDeliveries(limit?: number) {
  return postgres.listPendingNotificationDeliveries(await db(), limit);
}

export async function markNotificationDeliverySent(id: number, sentAt: number) {
  return postgres.markNotificationDeliverySent(await db(), id, sentAt);
}

export async function markNotificationDeliveryFailed(id: number, error: string, updatedAt: number) {
  return postgres.markNotificationDeliveryFailed(await db(), id, error, updatedAt);
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

export async function writeExecutionCandidate(candidate: ExecutionCandidate) {
  return postgres.upsertExecutionCandidate(await db(), candidate);
}

export async function readExecutionCandidates(now?: number) {
  return postgres.listExecutionCandidates(await db(), now);
}

export async function tryWithGlobalLiveExecutionLock<T>(owner: string, fn: () => Promise<T>) {
  return postgres.tryWithGlobalLiveExecutionLock(await db(), owner, fn);
}

export async function readDashboard(slot: MarketSlot): Promise<DashboardResponse> {
  return postgres.buildDashboardResponse(await db(), slot);
}

export async function readPortfolioDashboard(slots: MarketSlot[]): Promise<PortfolioDashboardResponse> {
  return postgres.buildPortfolioDashboardResponse(await db(), slots);
}

export async function readTrades(asset: MarketAsset | "all" = "all"): Promise<TradesResponse> {
  return postgres.buildTradesResponse(await db(), asset);
}

export async function readHistoryPoints(slot: MarketSlot): Promise<HistoryPoint[]> {
  return postgres.buildHistoryPoints(await db(), slot);
}

async function inferRunEventAsset(event: RunEvent): Promise<MarketAsset | null> {
  if (event.asset) {
    return event.asset;
  }

  const payloadAsset = inferRunEventAssetFromPayload(event.payload);
  if (payloadAsset) {
    return payloadAsset;
  }

  const intentId =
    event.payload && typeof event.payload === "object" && typeof event.payload.intentId === "string"
      ? event.payload.intentId
      : null;

  if (!intentId) {
    return null;
  }

  try {
    return (await findOrderIntent(intentId))?.asset ?? null;
  } catch {
    return null;
  }
}

function inferRunEventAssetFromPayload(payload: RunEvent["payload"]): MarketAsset | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (typeof payload.asset === "string" && isMarketAsset(payload.asset)) {
    return payload.asset;
  }

  const directSlotAsset = inferSlotAsset(payload.slotKey) ?? inferSlotAsset(payload.currentSlotKey);
  if (directSlotAsset) {
    return directSlotAsset;
  }

  if (!Array.isArray(payload.slotKeys)) {
    return null;
  }

  const inferredAssets = payload.slotKeys.map(inferSlotAsset).filter((asset): asset is MarketAsset => asset !== null);
  return inferredAssets.length > 0 && new Set(inferredAssets).size === 1 ? inferredAssets[0] : null;
}

function inferSlotAsset(value: unknown): MarketAsset | null {
  if (typeof value !== "string") {
    return null;
  }

  const [candidate] = value.split(":");
  return candidate && isMarketAsset(candidate) ? candidate : null;
}
