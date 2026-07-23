import * as postgres from "@/lib/postgres-db";
export {
  AccountingPersistenceError,
  CircuitBreakerIncidentPersistenceError,
  ConfigurationRevisionConflictError,
  EntryAdmissionConflictError,
  hashOrderAttemptRequest,
  LiveOrderAttemptClaimError,
  LiveOrderAttemptSubmissionError,
  OrderIntentRevisionConflictError,
} from "@/lib/postgres-db";
import { isMarketAsset } from "@/lib/market-catalog";
import { queueRunEventNotification } from "@/lib/notifications";
import type { OracleSlotSample, SlotResolutionRecord } from "@/lib/oracle-history";
import type { GlobalRiskConfig } from "@/lib/risk-settings";
import type {
  MarketAsset,
  BridgeTransfer,
  AcknowledgeCircuitBreakerIncidentInput,
  CircuitBreaker,
  ConfigurationMutationContext,
  DatabaseMaintenanceSummary,
  DatabaseMetrics,
  ExecutionCandidate,
  DashboardResponse,
  HistoryPoint,
  LiveEntryAdmissionInput,
  LiveOrderAttemptClaimInput,
  LiveOrderAttemptDispatchInput,
  LiveOrderAttemptSubmissionInput,
  LiveOpportunity,
  LiveOrder,
  MarketSlot,
  MarketFillQualityEvent,
  NotificationDelivery,
  ObserveCircuitBreakerIncidentInput,
  OpportunitySnapshot,
  OrderAttempt,
  OrderIntent,
  PortfolioDashboardResponse,
  PnlSnapshot,
  PositionSnapshot,
  RecordCircuitBreakerExposureRecoveryInput,
  ResolveOwnedCircuitBreakerIncidentInput,
  RunEvent,
  ShadowEntryAdmissionInput,
  StrategyConfigMapUpdate,
  StrategyConfigUpdate,
  TradesResponse,
  Venue,
  VenueBalance,
  WorkerState,
} from "@/lib/types";

export function storageMode() {
  return "postgres";
}

export async function closeStorage() {
  return postgres.closePgDb();
}

async function db() {
  return postgres.getPgDb();
}

export async function readSettings(asset: MarketAsset) {
  return postgres.getStrategyConfig(await db(), asset);
}

export async function readSettingsMap() {
  return postgres.listStrategyConfigs(await db());
}

export async function readExecutionConfiguration(asset: MarketAsset) {
  return postgres.getExecutionConfiguration(await db(), asset);
}

export async function writeSettings(
  asset: MarketAsset,
  update: StrategyConfigUpdate,
  context: ConfigurationMutationContext,
) {
  return postgres.updateStrategyConfig(await db(), asset, update, context);
}

export async function writeSettingsMap(updates: StrategyConfigMapUpdate, context: ConfigurationMutationContext) {
  return postgres.updateStrategyConfigs(await db(), updates, context);
}

export async function readGlobalRiskConfig() {
  return postgres.getGlobalRiskConfig(await db());
}

export async function writeGlobalRiskConfig(
  update: { config: GlobalRiskConfig; expectedRevision: number },
  context: ConfigurationMutationContext,
) {
  return postgres.updateGlobalRiskConfig(await db(), update, context);
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

export async function readLastAuthorizedEntryCosts(asset: MarketAsset, slotKey: string, mode: "live" | "shadow") {
  return postgres.getLastAuthorizedEntryCosts(await db(), asset, slotKey, mode);
}

export async function writeVenueBalance(balance: VenueBalance) {
  return postgres.upsertVenueBalance(await db(), balance);
}

export async function readVenueBalances() {
  return postgres.listVenueBalances(await db());
}

export async function insertOrderIntent(intent: OrderIntent) {
  return postgres.insertOrderIntent(await db(), intent);
}

export async function admitLiveEntry(input: LiveEntryAdmissionInput) {
  return postgres.admitLiveEntryAtomically(await db(), input);
}

export async function admitShadowEntry(input: ShadowEntryAdmissionInput) {
  return postgres.admitShadowEntryAtomically(await db(), input);
}

export async function claimAdmittedLiveOrderAttempt(input: LiveOrderAttemptClaimInput) {
  return postgres.claimAdmittedLiveOrderAttemptAtomically(await db(), input);
}

export async function claimLiveOrderAttemptForSubmission(input: LiveOrderAttemptSubmissionInput) {
  return postgres.claimLiveOrderAttemptForSubmissionAtomically(await db(), input);
}

export async function revalidateLiveOrderAttemptBeforeDispatch(input: LiveOrderAttemptDispatchInput) {
  return postgres.revalidateLiveOrderAttemptBeforeDispatchAtomically(await db(), input);
}

export async function writeOrderIntent(intent: OrderIntent) {
  return postgres.updateOrderIntent(await db(), intent);
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

export async function ingestVenueFillAccounting(input: postgres.IngestVenueFillAccountingInput) {
  return postgres.ingestVenueFillAtomically(await db(), input);
}

export async function closeIntentAccountingWithoutExposure(input: postgres.CloseIntentWithoutExposureInput) {
  return postgres.closeIntentWithoutExposureAtomically(await db(), input);
}

export async function finalizeIntentAccounting(input: postgres.FinalizeIntentAccountingInput) {
  return postgres.finalizeIntentAccountingAtomically(await db(), input);
}

export async function reaccountIntent(input: postgres.ReaccountIntentInput) {
  return postgres.reaccountIntentAtomically(await db(), input);
}

export async function readAccountingHead(intentId: string) {
  return postgres.getAccountingHead(await db(), intentId);
}

export async function readHistoricalTerminalLegacyPendingIntentIds(intentIds: readonly string[]) {
  return postgres.listHistoricalTerminalLegacyPendingIntentIds(await db(), intentIds);
}

export async function readAccountingFillEvidenceForIntent(intentId: string) {
  return postgres.listAccountingFillEvidenceForIntent(await db(), intentId);
}

export async function readLiveAccountingBacklog() {
  return postgres.getLiveAccountingBacklog(await db());
}

export async function readAccountingRealizedPnlForUtcDay(dayStart: number, shadow = false) {
  return postgres.sumAccountingRealizedPnlForUtcDay(await db(), dayStart, shadow);
}

export async function readAllTimeAccountingLedger(shadow = false) {
  return postgres.sumAllTimeAccountingLedger(await db(), shadow);
}

export async function readStableAccountingProjectionBacklog(limit = 100) {
  return postgres.listStableAccountingProjectionBacklog(await db(), limit);
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

export async function writeCircuitBreakerIncident(input: ObserveCircuitBreakerIncidentInput) {
  return postgres.observeCircuitBreakerIncident(await db(), input);
}

export async function readCurrentCircuitBreakerIncidents(options?: { includeResolved?: boolean }) {
  return postgres.listCurrentCircuitBreakerIncidents(await db(), options);
}

export async function writeCircuitBreakerExposureRecovery(input: RecordCircuitBreakerExposureRecoveryInput) {
  return postgres.recordCircuitBreakerExposureRecovery(await db(), input);
}

export async function resolveCircuitBreakerIncident(input: ResolveOwnedCircuitBreakerIncidentInput) {
  return postgres.resolveOwnedCircuitBreakerIncident(await db(), input);
}

export async function acknowledgeCircuitBreaker(input: AcknowledgeCircuitBreakerIncidentInput) {
  return postgres.acknowledgeCircuitBreakerIncident(await db(), input);
}

export async function acknowledgeManualKillBreaker(input: AcknowledgeCircuitBreakerIncidentInput) {
  return postgres.acknowledgeManualKillCircuitBreaker(await db(), input);
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

export async function tryWithShadowExecutionLock<T>(
  asset: MarketAsset,
  slotKey: string,
  owner: string,
  fn: () => Promise<T>,
) {
  return postgres.tryWithShadowExecutionLock(await db(), asset, slotKey, owner, fn);
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
