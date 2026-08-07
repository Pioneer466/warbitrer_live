import { createHash } from "node:crypto";

import { AccountingLedgerError, type AccountingEvidenceFinality } from "@/lib/accounting-ledger";
import {
  attachAccountingFillProvenance,
  buildAccountingFillMutationRequestId,
  buildAccountingMutationRequestId,
  buildShadowAccountingFillIdentity,
  buildTerminalAccountingProjection,
  classifyKalshiAccountingFee,
  classifyPolymarketAccountingFee,
} from "@/lib/accounting-runtime";
import { readDatabaseMaintenanceConfig } from "@/lib/db-maintenance";
import {
  CIRCUIT_BREAKER_INCIDENT_OWNERS,
  createDailyLossIncident,
  createExecutionIncident,
  createMarketDegradedIncident,
  createMarketFeedIncident,
} from "@/lib/circuit-breaker-incidents";
import {
  aggregateCircuitBreakerIncidents,
  getEffectiveCircuitBreakerImpact,
  getRelevantCircuitBreakerAggregates,
  shouldPauseExecutionForCircuitBreakerImpact,
} from "@/lib/circuit-breaker-policy";
import type {
  CircuitBreakerIncident,
  CircuitBreakerRecoveryProof,
  CircuitBreakerScopeAggregate,
} from "@/lib/circuit-breaker-policy";
import { hasKalshiCredentials, hasPolymarketCredentials } from "@/lib/env";
import {
  assertNewLiveExecutionAllowed,
  isLiveExecutionAllowed,
  isLiveMismatchRiskEnforced,
} from "@/lib/execution-safety";
import {
  applyKalshiPrimaryDepthSafetyFactor,
  applySlippage,
  calculateKalshiFee,
  deriveMultiLevelPairedQuote,
  getKalshiPrimaryMultiClipCapacity,
  getVenueExecutableDepth,
  getVenueMinimumOrderSize,
  normalizeVenueTargetSize,
  quoteMultiLevelBuyLeg,
} from "@/lib/fees";
import { moveKalshiOutcomePriceByTicks, normalizeKalshiOutcomePrice } from "@/lib/kalshi-price-grid";
import {
  computeKalshiBuyDepthWithinPriceRange,
  createKalshiAdapter,
  deriveKalshiBuyPriceLevels,
  fetchKalshiOrderbook,
  fetchKalshiFills,
  fetchFinalizedKalshiResolutionObservation,
  fetchKalshiOrders,
  fetchKalshiSeries,
  getKalshiOrderPriceUsd,
  mapKalshiFillToLiveFill,
  mapKalshiOrderStatus,
  matchesKalshiOrderRequest,
  normalizeKalshiNumericOrderbookLevels,
} from "@/lib/kalshi";
import { getMarketDataSupervisor } from "@/lib/market-data";
import { normalizePriceToAuthoritativeTick, validateInitialEntryAdmission } from "@/lib/entry-admission-policy";
import { ACTIVE_MARKET_ASSETS, getMarketCatalogEntry, MARKET_ASSETS } from "@/lib/market-catalog";
import { buildPnlSnapshot } from "@/lib/pnl";
import {
  confirmPolymarketOrderExecution,
  createPolymarketAdapter,
  extractPolymarketTradesForOrder,
  fetchFinalizedPolymarketResolutionObservation,
  fetchPolymarketBook,
  fetchPolymarketOpenOrders,
  getPolymarketConditionalSellableBalance,
  fetchPolymarketResolution,
  fetchPolymarketTrades,
  getPolymarketTradeOrderMappingIssue,
  isConfirmedPolymarketTrade,
  mapPolymarketOrder,
  mapPolymarketTradeToFill,
  resolvePolymarketOrderTruth,
} from "@/lib/polymarket";
import {
  applyPolymarketOrderFilledEvidence,
  fetchPolymarketOrderFilledEvidence,
  PolymarketOnchainEvidenceError,
} from "@/lib/polymarket-onchain-fill";
import { autoConvertPolymarketIfConfigured, reconcilePolymarketProxyConversions } from "@/lib/recovery";
import {
  deriveKalshiRecoveryOrderPrice,
  derivePolymarketRecoveryOrderPrice,
  evaluateRecoveryLossCap,
  normalizePolymarketBuyPriceCap,
  validateRecoveryMarketState,
  type AuthoritativeRecoveryOrderPrice,
  type RecoveryFeeSchedule,
  type RecoveryMarketStateDecision,
} from "@/lib/recovery-order-policy";
import { isRiskActivePosition } from "@/lib/positions";
import {
  applyVenueBalanceReservations,
  calculateVenueExposureUsd,
  countShadowExecutionBlockers,
  countSlotExecutionBlockers,
  hasUnresolvedExposureBlocker,
} from "@/lib/risk";
import {
  buildCompletedShadowAudit,
  buildCompletedShadowAuditFromPreparedRestExecution,
  buildPreparedShadowRestExecutionProof,
  buildScheduledShadowAudit,
  applyRestPairedPreflightToIntent,
  deriveRestPairedPreflight,
  deriveShadowPairExecution,
  getPreparedShadowRestFillEconomics,
  getShadowRestAdmissionRejection,
  getShadowReentryCooldownRemainingMs,
  planShadowRestRecovery,
  SHADOW_EXECUTION_MODEL_VERSION,
  type RestPairedPreflightDecision,
  type ShadowPairExecutionDecision,
} from "@/lib/shadow-execution";
import {
  buildLateEntryProbeCombinationKey,
  ENTRY_PROBE_VARIANTS,
  getEntryProbeEstimateReadinessRejection,
  getLateEntryProbeCaptureRejection,
  getMissingLateEntryProbeCombinations,
  nextLateEntryProbeIdentity,
  summarizeRawBookLevelsForProbe,
  summarizeRestPairedPreflightForProbe,
  type LateEntryProbeIdentity,
} from "@/lib/entry-probes";
import { buildSignals } from "@/lib/signals";
import { POLYMARKET_MIN_MARKET_BUY_AMOUNT_USD } from "@/lib/constants";
import { fetchVenueSettlementResolutions } from "@/lib/settlement-finality";
import {
  calculateWinningPayout,
  calculateLegSpentUsd,
  createIntentFromOpportunity,
  deriveHedgedPairEconomics,
  finalizeIntent,
  finalizeUnwoundIntent,
  markIntentStatus,
  summarizeVenueFills,
} from "@/lib/settlement";
import { getCurrentSlot } from "@/lib/slot";
import { shouldPersistOracleSample } from "@/lib/oracle-history";
import {
  calculateHybridClusterBudget,
  calculateMismatchAdjustedPnl,
  evaluateEconomicMismatchGate,
} from "@/lib/mismatch-risk";
import { applyActiveMismatchCalibrationToEstimate } from "@/lib/mismatch-calibration";
import { deriveMismatchEstimateEconomics } from "@/lib/mismatch-reference-economics";
import { MISMATCH_DIAGNOSTIC_MAX_SOURCE_AGE_MS, MismatchRiskRuntime } from "@/lib/mismatch-risk-runtime";
import { buildMismatchRiskAudit } from "@/lib/mismatch-risk-audit";
import { applyMismatchRiskPolicy, recheckMismatchRiskCandidate } from "@/lib/mismatch-risk-policy";
import { DEFAULT_GLOBAL_RISK_CONFIG, getMismatchFatalBudgetFraction, type GlobalRiskConfig } from "@/lib/risk-settings";
import {
  findOrderIntent,
  findVenueOrder,
  closeIntentAccountingWithoutExposure,
  finalizeIntentAccounting,
  admitLiveEntry,
  admitShadowEntry,
  claimAdmittedLiveOrderAttempt,
  claimLiveOrderAttemptForSubmission,
  revalidateLiveOrderAttemptBeforeDispatch,
  hashOrderAttemptRequest,
  readCurrentCircuitBreakerIncidents,
  readExecutionConfiguration,
  readExecutionCandidates,
  readEntryExecutionProbes,
  readFillsForIntentVenue,
  readLastAuthorizedEntryCosts,
  readLatestSnapshot,
  readGlobalRiskConfig,
  readActiveMismatchCalibration,
  readAccountingHead,
  readAccountingFillEvidenceForIntent,
  readHistoricalTerminalLegacyPendingIntentIds,
  readAccountingRealizedPnlForUtcDay,
  readAllTimeAccountingLedger,
  readOpenOrderIntents,
  readOrderAttemptsForIntent,
  LiveOrderAttemptClaimError,
  OrderIntentRevisionConflictError,
  readPendingSlotResolutions,
  readPolymarketCashAdjustmentObservation,
  readPositions,
  readRecentOrderIntents,
  readRecentSettledOrderIntents,
  readRecentVenueOrders,
  readSettings,
  readSettingsMap,
  readStableAccountingProjectionBacklog,
  readVenueBalances,
  readDegradedMarketFillQualityCounts,
  replaceVenuePositions,
  runDatabaseMaintenance,
  tryWithGlobalLiveExecutionLock,
  tryWithShadowExecutionLock,
  updateStablePnlChangeFromIntent,
  writeStablePnlChange,
  resolveCircuitBreakerIncident,
  writeCircuitBreakerIncident,
  writeCircuitBreakerExposureRecovery,
  writeExecutionCandidate,
  writeEntryExecutionProbe,
  ingestVenueFillAccounting,
  reaccountIntent,
  writeMarketFillQualityEvent,
  writeOrderAttempt,
  writeOrderIntent,
  writeOracleSlotSample,
  writePnlSnapshot,
  writeRunEvent,
  writeSnapshot,
  writeSlotResolution,
  writeVenueBalance,
  writeVenueOrder,
  writeWorkerState,
  CircuitBreakerIncidentPersistenceError,
} from "@/lib/storage";
import type {
  AccountingHeadState,
  ExecutionCoordinator,
  CircuitBreaker,
  ExecutionCandidate,
  LiveFill,
  LiveOpportunity,
  LiveOrder,
  MarketFillQualityOutcome,
  MarketAsset,
  MarketSlot,
  OpportunitySnapshot,
  OrderAttempt,
  OrderIntent,
  KalshiPriceRange,
  MismatchRiskEstimate,
  PairCombination,
  PositionSnapshot,
  StrategyConfig,
  RunEvent,
  VenueAdapter,
  VenueBalance,
  VenueFeedHealth,
  Venue,
  VenueOrderRequest,
  VenueOrderResult,
  VersionedConfiguration,
  VersionedStrategyConfig,
  VersionedStrategyConfigMap,
  WorkerState,
} from "@/lib/types";

export { deriveSettledVenueResolutions } from "@/lib/settlement-finality";

const RESOLUTION_GRACE_MS = 5_000;
const IN_FLIGHT_INTENT_STALE_MS = 15_000;
const LATE_PRIMARY_FILL_RESCUE_WINDOW_MS = 15 * 60 * 1000;
const ORDER_SIZE_TOLERANCE = 1e-6;
const STABLE_PNL_BALANCE_TOLERANCE_USD = 0.01;
const RECONCILE_STEP_TIMEOUT_MS = 30_000;
const KALSHI_SOFT_HEDGE_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const SETTLED_RESOLUTION_REPAIR_LOOKBACK_MS = 12 * 60 * 60 * 1000;
const SETTLED_RESOLUTION_REPAIR_INTERVAL_MS = 5 * 60 * 1000;
const SETTLED_RESOLUTION_REPAIR_LIMIT = 500;
const EXECUTOR_STALE_SIGNAL_LOG_INTERVAL_MS = 5_000;
const EXECUTION_CANDIDATE_WRITE_THROTTLE_MS = 1_000;
const EXECUTION_CANDIDATE_LOG_INTERVAL_MS = 2_000;
const SNAPSHOT_PERSIST_INTERVAL_MS = 1_000;
const IDLE_EXECUTION_REFRESH_INTERVAL_MS = 1_000;
const FEED_BREAKER_SYNC_INTERVAL_MS = 5_000;
const SETTINGS_CACHE_TTL_MS = 1_000;
const VENUE_BALANCES_CACHE_TTL_MS = 750;
const OPEN_INTENTS_CACHE_TTL_MS = 750;
const KALSHI_FEE_MULTIPLIER_CACHE_TTL_MS = 60 * 60 * 1000;
const PRIMARY_NO_FILL_COOLDOWN_MS = 10_000;
const CONSERVATIVE_REMAINING_BUY_FEE_USD_PER_UNIT = 0.07;
const HEDGE_FAILURE_RECOVERED_COOLDOWN_MS = 10_000;
const HEDGE_FAILURE_UNWIND_PENDING_COOLDOWN_MS = 10_000;
const LAST_ENTRY_COSTS_CACHE_TTL_MS = 750;
const EXECUTION_ARBITER_WINDOW_MS = resolveExecutionArbiterWindowMs();
const EXECUTION_LOCK_BUSY_LOG_INTERVAL_MS = 2_000;
const SCAN_SLOW_LOG_THRESHOLD_MS = 1_000;
const EXECUTION_SLOW_LOG_THRESHOLD_MS = 2_000;
const RECONCILE_SLOW_LOG_THRESHOLD_MS = 5_000;
const SETTLEMENT_RECONCILE_INTERVAL_MS = 30_000;
const PNL_RECONCILE_INTERVAL_MS = 15_000;
const DATABASE_MAINTENANCE_RECONCILE_INTERVAL_MS = 60_000;
const MARKET_DEGRADED_WINDOW_MS = 30 * 60 * 1000;
const MARKET_DEGRADED_THRESHOLD = 3;
const MARKET_DEGRADED_COOLDOWN_MS = 30 * 60 * 1000;
const POLYMARKET_CASH_ADJUSTMENT_MIN_USD = 0.005;
const POLYMARKET_CASH_ADJUSTMENT_MAX_USD = 1;
const POLYMARKET_CASH_ADJUSTMENT_MAX_RATIO = 0.25;
const POLYMARKET_CASH_ADJUSTMENT_MAX_SNAPSHOT_LAG_MS = 5 * 60 * 1000;
const POSITION_WRITE_THROTTLE_MS = 10_000;

const kalshiAdapter = createKalshiAdapter();
const polymarketAdapter = createPolymarketAdapter();
const marketDataSupervisor = getMarketDataSupervisor();
let lastDatabaseMaintenanceAttemptAt: number | null = null;
const lastSettledResolutionRepairAtByAsset: Partial<Record<MarketAsset, number>> = {};
const lastPositionWriteByVenueAsset = new Map<string, { signature: string; writtenAt: number }>();
let nextScanSequence = 1;
let executionTickInFlight = false;
const latestScanByAsset = new Map<MarketAsset, RealtimeScanState>();
const executionTickInFlightByAsset: Partial<Record<MarketAsset, boolean>> = {};
const lastExecutedScanSequenceByAsset: Partial<Record<MarketAsset, number>> = {};
const lastPersistedScanSnapshotAtByAsset: Partial<Record<MarketAsset, number>> = {};
const lastExecutionCandidateWriteByAsset = new Map<MarketAsset, { signature: string; writtenAt: number }>();
const lastExecutionCandidateLogAtByAsset: Partial<Record<MarketAsset, number>> = {};
const lastPersistedWorkerStateAtByAsset: Partial<Record<MarketAsset, number>> = {};
const lastIdleExecutionRefreshAtByAsset: Partial<Record<MarketAsset, number>> = {};
const lastFeedBreakerSyncByAsset: Partial<Record<MarketAsset, { signature: string; syncedAt: number }>> = {};
const lastStaleSignalLogAtByAsset: Partial<Record<MarketAsset, number>> = {};
const lastExecutionLockBusyLogAtByAsset: Partial<Record<MarketAsset, number>> = {};
const lastReconcileCadenceAtByAsset: Partial<Record<MarketAsset, Partial<Record<ReconcileCadenceKey, number>>>> = {};
const loopHealthByAsset: Partial<Record<MarketAsset, WorkerState["loopHealth"]>> = {};
const settingsCacheByAsset: Partial<Record<MarketAsset, { value: VersionedStrategyConfig; capturedAt: number }>> = {};
const kalshiFeeMultiplierCacheByAsset: Partial<Record<MarketAsset, { value: number; capturedAt: number }>> = {};
let venueBalancesCache: { value: VenueBalance[]; capturedAt: number } | null = null;
let openIntentsCache: { value: OrderIntent[]; capturedAt: number } | null = null;
const lastEntryCostsCache = new Map<
  string,
  { value: Awaited<ReturnType<typeof readLastAuthorizedEntryCosts>>; capturedAt: number }
>();
const lateEntryProbeIdentitiesByAsset: Partial<Record<MarketAsset, LateEntryProbeIdentity[]>> = {};
const lateEntryProbeCaptureInFlightByAsset: Partial<Record<MarketAsset, Promise<void>>> = {};
const lastOracleSampleAtBySlot = new Map<string, number>();
const observedResolutionSlots = new Map<string, string>();
const oraclePersistenceInFlightByAsset: Partial<Record<MarketAsset, Promise<void>>> = {};
let observedSlotResolutionReconcileInFlight = false;
const mismatchRiskRuntime = new MismatchRiskRuntime();
let globalRiskConfigCache: { value: VersionedConfiguration<GlobalRiskConfig>; capturedAt: number } | null = null;
type ActiveMismatchCalibration = Awaited<ReturnType<typeof readActiveMismatchCalibration>>;
let mismatchCalibrationCache: { value: ActiveMismatchCalibration; capturedAt: number } | null = null;

export type ExecutionConfigurationSnapshot = {
  strategyRevision: number;
  globalRisk: VersionedConfiguration<GlobalRiskConfig>;
  mismatchCalibration: {
    artifactId: string | null;
    revision: number;
  };
};

type RealtimeScanState = {
  sequence: number;
  asset: MarketAsset;
  slot: MarketSlot;
  settings: StrategyConfig;
  executionConfiguration: ExecutionConfigurationSnapshot;
  snapshot: OpportunitySnapshot;
  capturedAt: number;
  scanDurationMs: number;
  hasOpenIntent: boolean;
};

type ReconcileCadenceKey = "settlements" | "pnl" | "database_maintenance";

type OrderExecutionTiming = {
  quoteObservedAt: number;
  decisionAt: number;
  submitStartedAt: number;
  venueAckAt: number;
  fillObservedAt: number;
};

function buildPairExecutionTiming(primary: OrderExecutionTiming | null, hedge: OrderExecutionTiming | null) {
  if (!primary && !hedge) {
    return null;
  }

  return {
    quoteObservedAt: primary?.quoteObservedAt ?? hedge?.quoteObservedAt ?? null,
    decisionAt: primary?.decisionAt ?? hedge?.decisionAt ?? null,
    primarySubmitStartedAt: primary?.submitStartedAt ?? null,
    primaryVenueAckAt: primary?.venueAckAt ?? null,
    primaryFillObservedAt: primary?.fillObservedAt ?? null,
    hedgeSubmitStartedAt: hedge?.submitStartedAt ?? null,
    hedgeVenueAckAt: hedge?.venueAckAt ?? null,
    hedgeFillObservedAt: hedge?.fillObservedAt ?? null,
    decisionToPrimarySubmitMs: primary ? Math.max(0, primary.submitStartedAt - primary.decisionAt) : null,
    primaryFillToHedgeSubmitMs: primary && hedge ? Math.max(0, hedge.submitStartedAt - primary.fillObservedAt) : null,
  };
}

export function deriveKalshiPrimaryFallbackClipPlan(requestedContracts: number) {
  const normalizedRequestedContracts = normalizeVenueTargetSize("kalshi", requestedContracts, 1, 1);
  if (normalizedRequestedContracts <= 0) {
    return [];
  }

  const preferredClipSizes = [20, 10, 5];
  const plan = [
    Math.min(normalizedRequestedContracts, preferredClipSizes[0]),
    ...preferredClipSizes.slice(1).filter((clipSize) => clipSize < normalizedRequestedContracts),
  ];

  return [...new Set(plan)].filter((clipSize) => clipSize > 0).sort((left, right) => right - left);
}

export function deriveFastKalshiPrimaryClipIntent(
  intent: OrderIntent,
  primaryLegId: OrderIntent["legs"][number]["id"],
  clipSize: number,
  now: number,
) {
  const normalizedClipSize = normalizeVenueTargetSize("kalshi", clipSize, 1, 1);
  if (normalizedClipSize <= 0) {
    return null;
  }

  let foundPrimaryLeg = false;
  const legs = intent.legs.map((leg) => {
    if (leg.id !== primaryLegId) {
      return leg;
    }

    foundPrimaryLeg = true;
    if (leg.venue !== "kalshi" || leg.requestedPrice === null) {
      return null;
    }

    const requestedSize = Math.min(leg.requestedSize, normalizedClipSize);
    if (requestedSize <= 0) {
      return null;
    }

    return {
      ...leg,
      requestedSize,
      requestedNotionalUsd: round4(requestedSize * leg.requestedPrice),
    };
  });

  if (!foundPrimaryLeg || legs.some((leg) => leg === null)) {
    return null;
  }

  return {
    ...intent,
    updatedAt: now,
    legs: legs as OrderIntent["legs"],
  };
}

function buildSlotBreakerKey(slotKey: string): CircuitBreaker["key"] {
  return `slot:${slotKey}` as CircuitBreaker["key"];
}

function buildAssetBreakerKey(asset: MarketAsset): CircuitBreaker["key"] {
  return `asset:${asset}` as CircuitBreaker["key"];
}

function buildPolymarketSlotSlug(asset: MarketAsset, slotStartTs: number) {
  return `${getMarketCatalogEntry(asset).polymarketSlugPrefix}-${Math.floor(slotStartTs / 1000)}`;
}

export type VenueReconcileFetchState = {
  ok: boolean;
  error: string | null;
};

export type VenueReconcileFetchStates = {
  polymarketOrders: VenueReconcileFetchState;
  polymarketFills: VenueReconcileFetchState;
  kalshiOrders: VenueReconcileFetchState;
  kalshiFills: VenueReconcileFetchState;
};

type TickSharedContext = {
  venueBalances?: VenueBalance[];
  openIntents?: OrderIntent[];
  recentVenueOrders?: LiveOrder[];
  lastEntryCosts?: Awaited<ReturnType<typeof readLastAuthorizedEntryCosts>>;
  venuePositions?: {
    polymarket: PositionSnapshot[];
    kalshi: PositionSnapshot[];
  } | null;
  storedPositions?: PositionSnapshot[];
  venueOrderReconcileData?: {
    polyOpenOrders: Awaited<ReturnType<typeof fetchPolymarketOpenOrders>>;
    kalshiOrders: Awaited<ReturnType<typeof fetchKalshiOrders>>;
    polyTrades: Awaited<ReturnType<typeof fetchPolymarketTrades>>;
    kalshiFills: Awaited<ReturnType<typeof fetchKalshiFills>>;
    fetchStates: VenueReconcileFetchStates;
  };
  executionConfiguration?: ExecutionConfigurationSnapshot;
  mismatchCalibration?: ActiveMismatchCalibration;
};

export async function processTick(now = new Date()) {
  await processScanTick(now);
  await processExecutionTick(now);
  await processReconcileTick(now);
}

export async function processScanTick(now = new Date()) {
  const nowTs = now.getTime();
  const scanStartedAt = Date.now();
  const errors: string[] = [];
  const snapshots: OpportunitySnapshot[] = [];
  const [settingsMap, globalRisk, mismatchCalibration, sharedVenueBalances, sharedOpenIntents] = await Promise.all([
    readCachedSettingsMap(nowTs),
    getCachedGlobalRiskConfig(nowTs),
    getCachedMismatchCalibration(nowTs),
    readCachedVenueBalances(nowTs),
    readCachedOpenIntents(nowTs),
  ]);

  await Promise.all(
    ACTIVE_MARKET_ASSETS.map(async (asset) => {
      const settings = settingsMap[asset];
      const slot = getCurrentSlot(asset, now);

      try {
        const snapshot = await scanAsset(asset, slot, settings, globalRisk, nowTs, {
          venueBalances: sharedVenueBalances,
          openIntents: sharedOpenIntents,
          mismatchCalibration,
          lastEntryCosts: await readCachedLastEntryCosts(
            asset,
            slot.key,
            settings.config.shadowMode ? "shadow" : "live",
            nowTs,
          ),
        });
        snapshots.push(snapshot);
      } catch (error) {
        const message = `[${asset}] ${toErrorMessage(error)}`;
        errors.push(message);
        await writeAssetWorkerState(
          asset,
          {
            phase: "scan",
            currentSlotKey: slot.key,
            lastError: message,
          },
          nowTs,
          true,
        );
      }
    }),
  );

  const scanDurationMs = Date.now() - scanStartedAt;
  if (scanDurationMs > SCAN_SLOW_LOG_THRESHOLD_MS) {
    console.warn(`[worker] scan slow: total=${scanDurationMs}ms assets=${ACTIVE_MARKET_ASSETS.length}`);
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" | "));
  }

  return snapshots;
}

export async function processAssetScanTick(asset: MarketAsset, now = new Date()) {
  const nowTs = now.getTime();
  const slot = getCurrentSlot(asset, now);
  const [settings, globalRisk, mismatchCalibration] = await Promise.all([
    readCachedSettings(asset, nowTs),
    getCachedGlobalRiskConfig(nowTs),
    getCachedMismatchCalibration(nowTs),
  ]);
  try {
    return await scanAsset(asset, slot, settings, globalRisk, nowTs, {
      venueBalances: await readCachedVenueBalances(nowTs),
      openIntents: await readCachedOpenIntents(nowTs),
      mismatchCalibration,
      lastEntryCosts: await readCachedLastEntryCosts(
        asset,
        slot.key,
        settings.config.shadowMode ? "shadow" : "live",
        nowTs,
      ),
    });
  } catch (error) {
    const message = `[${asset}] ${toErrorMessage(error)}`;
    await writeAssetWorkerState(
      asset,
      {
        phase: "scan",
        currentSlotKey: slot.key,
        lastError: message,
      },
      nowTs,
      true,
    );
    throw error;
  }
}

async function scanAsset(
  asset: MarketAsset,
  slot: MarketSlot,
  settingsRecord: VersionedStrategyConfig,
  globalRisk: VersionedConfiguration<GlobalRiskConfig>,
  nowTs: number,
  sharedContext: TickSharedContext,
) {
  const settings = settingsRecord.config;
  const executionConfiguration = {
    strategyRevision: settingsRecord.revision,
    globalRisk,
    mismatchCalibration: {
      artifactId: sharedContext.mismatchCalibration?.artifact?.id ?? null,
      revision: sharedContext.mismatchCalibration?.revision ?? -1,
    },
  };
  const coordinator = createExecutionCoordinator(asset, settings, {
    ...sharedContext,
    executionConfiguration,
  });
  const assetScanStartedAt = Date.now();
  const persistSnapshot = shouldPersistScanSnapshot(asset, nowTs);
  const snapshot = await coordinator.scan(slot, nowTs, { persistSnapshot });
  if (persistSnapshot) {
    lastPersistedScanSnapshotAtByAsset[asset] = nowTs;
  }

  const scanState: RealtimeScanState = {
    sequence: nextScanSequence++,
    asset,
    slot,
    settings,
    executionConfiguration,
    snapshot,
    capturedAt: snapshot.capturedAt,
    scanDurationMs: Date.now() - assetScanStartedAt,
    hasOpenIntent: Boolean(sharedContext.openIntents?.some((intent) => intent.asset === asset)),
  };
  latestScanByAsset.set(asset, scanState);

  const candidate = buildExecutionCandidate(scanState, nowTs);
  if (candidate && shouldWriteExecutionCandidate(candidate, nowTs)) {
    await writeExecutionCandidate(candidate);
    markExecutionCandidateWritten(candidate, nowTs);
    maybeLogExecutionCandidatePublished(candidate, nowTs);
  }

  const loopHealth = updateLoopHealth(
    asset,
    {
      lastScanDurationMs: scanState.scanDurationMs,
      lastScanAgeMs: Math.max(0, Date.now() - scanState.capturedAt),
      lastCandidateScore: candidate?.projectedNetProfitUsd ?? null,
    },
    nowTs,
  );
  await writeAssetWorkerState(
    asset,
    {
      phase: "scan",
      currentSlotKey: slot.key,
      lastScanAt: nowTs,
      lastError: null,
      loopHealth,
    },
    nowTs,
    persistSnapshot,
  );

  return snapshot;
}

function shouldPersistScanSnapshot(asset: MarketAsset, now: number) {
  const lastPersistedAt = lastPersistedScanSnapshotAtByAsset[asset] ?? null;
  return lastPersistedAt === null || now - lastPersistedAt >= SNAPSHOT_PERSIST_INTERVAL_MS;
}

export async function processExecutionTick(now = new Date()) {
  if (executionTickInFlight) {
    return [];
  }

  executionTickInFlight = true;
  try {
    return await processExecutionTickUnlocked(now);
  } finally {
    executionTickInFlight = false;
  }
}

async function processExecutionTickUnlocked(now = new Date()) {
  const nowTs = now.getTime();
  const executeStartedAt = Date.now();
  const errors: string[] = [];
  const created: OrderIntent[] = [];
  const pendingScanStates: RealtimeScanState[] = [];

  for (const asset of ACTIVE_MARKET_ASSETS) {
    const scanState = latestScanByAsset.get(asset);
    if (!scanState || lastExecutedScanSequenceByAsset[asset] === scanState.sequence) {
      continue;
    }

    const currentSlot = getCurrentSlot(asset, now);
    if (scanState.slot.key !== currentSlot.key) {
      lastExecutedScanSequenceByAsset[asset] = scanState.sequence;
      continue;
    }

    pendingScanStates.push(scanState);
  }

  if (pendingScanStates.length === 0) {
    return created;
  }

  for (const scanState of pendingScanStates) {
    try {
      const assetCreated = await executeScanState(scanState, nowTs);
      created.push(...assetCreated);
    } catch (error) {
      const message = `[${scanState.asset}] ${toErrorMessage(error)}`;
      errors.push(message);
      await writeAssetWorkerState(
        scanState.asset,
        {
          phase: "execute",
          currentSlotKey: scanState.slot.key,
          lastError: message,
        },
        nowTs,
        true,
      );
    } finally {
      lastExecutedScanSequenceByAsset[scanState.asset] = scanState.sequence;
    }
  }

  const executeDurationMs = Date.now() - executeStartedAt;
  if (executeDurationMs > EXECUTION_SLOW_LOG_THRESHOLD_MS) {
    console.warn(`[worker] executor slow: total=${executeDurationMs}ms created=${created.length}`);
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" | "));
  }

  return created;
}

export async function processAssetExecutionTick(asset: MarketAsset, now = new Date()) {
  if (executionTickInFlightByAsset[asset]) {
    return [];
  }

  executionTickInFlightByAsset[asset] = true;
  try {
    const scanState = latestScanByAsset.get(asset);
    if (!scanState || lastExecutedScanSequenceByAsset[asset] === scanState.sequence) {
      return [];
    }

    const currentSlot = getCurrentSlot(asset, now);
    if (scanState.slot.key !== currentSlot.key) {
      lastExecutedScanSequenceByAsset[asset] = scanState.sequence;
      return [];
    }

    const remainingArbiterWindowMs = Math.max(0, EXECUTION_ARBITER_WINDOW_MS - (Date.now() - scanState.capturedAt));
    if (remainingArbiterWindowMs > 0) {
      await sleep(remainingArbiterWindowMs);
    }

    try {
      const created = await executeScanState(scanState, Date.now());
      lastExecutedScanSequenceByAsset[asset] = scanState.sequence;
      return created;
    } catch (error) {
      const message = `[${asset}] ${toErrorMessage(error)}`;
      await writeAssetWorkerState(
        asset,
        {
          phase: "execute",
          currentSlotKey: scanState.slot.key,
          lastError: message,
        },
        Date.now(),
        true,
      );
      lastExecutedScanSequenceByAsset[asset] = scanState.sequence;
      throw error;
    }
  } finally {
    executionTickInFlightByAsset[asset] = false;
  }
}

async function executeScanState(scanState: RealtimeScanState, nowTs: number) {
  const executeStartedAt = Date.now();
  const created: OrderIntent[] = [];
  const settings = scanState.settings;
  const candidate = buildExecutionCandidate({ ...scanState, settings }, nowTs);
  if ((!settings.enableTrading || !candidate) && !scanState.hasOpenIntent) {
    const lastRefreshAt = lastIdleExecutionRefreshAtByAsset[scanState.asset] ?? null;
    if (!shouldRefreshIdleExecution(lastRefreshAt, nowTs)) {
      return created;
    }
    lastIdleExecutionRefreshAtByAsset[scanState.asset] = nowTs;

    const readiness = await computeReadiness(scanState.snapshot, scanState.asset, nowTs);
    await persistExecutionTickState(scanState, nowTs, executeStartedAt, {
      readinessStatus: readiness.state.readinessStatus,
      readiness: readiness.state.readiness,
    });
    return created;
  }

  if (candidate && !(settings.shadowMode && scanState.hasOpenIntent)) {
    const candidates = await readExecutionCandidates(nowTs);
    const winner = selectWinningExecutionCandidate(candidates, nowTs);
    if (!winner || !isWinningCandidateForScanState(winner, scanState, nowTs)) {
      await persistExecutionTickState(scanState, nowTs, executeStartedAt);
      return created;
    }
    console.log(
      `[worker] candidate won: asset=${winner.asset} slot=${winner.slotKey} profit=${winner.projectedNetProfitUsd.toFixed(4)} age=${Math.max(0, nowTs - winner.capturedAt)}ms`,
    );
  }

  const coordinator = createExecutionCoordinator(scanState.asset, settings, {
    executionConfiguration: scanState.executionConfiguration,
  });
  const assetCreated = await coordinator.execute(scanState.slot, nowTs, scanState.snapshot);
  created.push(...assetCreated);
  await persistExecutionTickState(scanState, nowTs, executeStartedAt);
  return created;
}

async function persistExecutionTickState(
  scanState: RealtimeScanState,
  nowTs: number,
  executeStartedAt: number,
  state: Partial<WorkerState> = {},
) {
  const loopHealth = updateLoopHealth(
    scanState.asset,
    {
      lastExecutionDurationMs: Date.now() - executeStartedAt,
      lastScanAgeMs: Math.max(0, Date.now() - scanState.capturedAt),
    },
    nowTs,
  );
  await writeAssetWorkerState(
    scanState.asset,
    {
      phase: "execute",
      currentSlotKey: scanState.slot.key,
      lastExecuteAt: nowTs,
      lastError: null,
      loopHealth,
      ...state,
    },
    nowTs,
    true,
  );
}

export function shouldRefreshIdleExecution(
  lastRefreshAt: number | null,
  now: number,
  intervalMs = IDLE_EXECUTION_REFRESH_INTERVAL_MS,
) {
  return lastRefreshAt === null || now - lastRefreshAt >= intervalMs;
}

export async function processReconcileTick(now = new Date()) {
  const nowTs = now.getTime();
  const reconcileStartedAt = Date.now();
  const errors: string[] = [];
  const settingsMap = await readSettingsMap();
  const sharedVenueBalances = await refreshBalances(getGlobalPolyBridgeLowWaterUsdc(settingsMap), nowTs);
  const sharedVenuePositions = await refreshVenuePositions();
  const storedPositions = sharedVenuePositions === null ? await readPositions() : undefined;
  const [sharedOpenIntents, sharedRecentVenueOrders, venueOrderReconcileData] = await Promise.all([
    readOpenOrderIntents(),
    readRecentVenueOrders(1_000),
    prefetchVenueOrderReconcileData(),
  ]);

  for (const asset of ACTIVE_MARKET_ASSETS) {
    const settings = settingsMap[asset].config;
    const slot = getCurrentSlot(asset, now);
    const coordinator = createExecutionCoordinator(asset, settings, {
      venueBalances: sharedVenueBalances,
      openIntents: sharedOpenIntents,
      recentVenueOrders: sharedRecentVenueOrders,
      venuePositions: sharedVenuePositions,
      storedPositions,
      venueOrderReconcileData,
    });

    try {
      const assetReconcileStartedAt = Date.now();
      await coordinator.reconcile(slot, nowTs);
      const loopHealth = updateLoopHealth(
        asset,
        {
          lastReconcileDurationMs: Date.now() - assetReconcileStartedAt,
        },
        nowTs,
      );
      await writeAssetWorkerState(
        asset,
        {
          phase: "reconcile",
          currentSlotKey: slot.key,
          lastReconcileAt: nowTs,
          lastError: null,
          loopHealth,
        },
        nowTs,
        true,
      );
    } catch (error) {
      const message = `[${asset}] ${toErrorMessage(error)}`;
      errors.push(message);
      await writeAssetWorkerState(
        asset,
        {
          phase: "reconcile",
          currentSlotKey: slot.key,
          lastError: message,
        },
        nowTs,
        true,
      );
    }
  }

  const reconcileDurationMs = Date.now() - reconcileStartedAt;
  if (reconcileDurationMs > RECONCILE_SLOW_LOG_THRESHOLD_MS) {
    console.warn(`[worker] reconcile slow: total=${reconcileDurationMs}ms assets=${ACTIVE_MARKET_ASSETS.length}`);
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" | "));
  }
}

async function prefetchVenueOrderReconcileData(): Promise<NonNullable<TickSharedContext["venueOrderReconcileData"]>> {
  const polymarketCredentialsAvailable = hasPolymarketCredentials();
  const kalshiCredentialsAvailable = hasKalshiCredentials();
  const [polyOpenOrders, kalshiOrders, polyTrades, kalshiFills] = await Promise.all([
    captureVenueReconcileFetch(() => {
      if (!polymarketCredentialsAvailable) {
        throw new Error("Polymarket credentials unavailable");
      }
      return fetchPolymarketOpenOrders();
    }, []),
    captureVenueReconcileFetch(() => {
      if (!kalshiCredentialsAvailable) {
        throw new Error("Kalshi credentials unavailable");
      }
      return fetchKalshiOrders();
    }, []),
    captureVenueReconcileFetch(() => {
      if (!polymarketCredentialsAvailable) {
        throw new Error("Polymarket credentials unavailable");
      }
      return fetchPolymarketTrades();
    }, []),
    captureVenueReconcileFetch(() => {
      if (!kalshiCredentialsAvailable) {
        throw new Error("Kalshi credentials unavailable");
      }
      return fetchKalshiFills();
    }, []),
  ]);

  return {
    polyOpenOrders: polyOpenOrders.value,
    kalshiOrders: kalshiOrders.value,
    polyTrades: polyTrades.value,
    kalshiFills: kalshiFills.value,
    fetchStates: {
      polymarketOrders: polyOpenOrders.state,
      polymarketFills: polyTrades.state,
      kalshiOrders: kalshiOrders.state,
      kalshiFills: kalshiFills.state,
    },
  };
}

export async function captureVenueReconcileFetch<T>(operation: () => Promise<T>, fallback: T) {
  try {
    return {
      value: await operation(),
      state: { ok: true, error: null } satisfies VenueReconcileFetchState,
    };
  } catch (error) {
    return {
      value: fallback,
      state: { ok: false, error: toErrorMessage(error) } satisfies VenueReconcileFetchState,
    };
  }
}

export function isVenueReconcileTruthFresh(venue: Venue, fetchStates: VenueReconcileFetchStates | undefined) {
  if (!fetchStates) {
    return false;
  }

  return venue === "polymarket"
    ? fetchStates.polymarketOrders.ok && fetchStates.polymarketFills.ok
    : fetchStates.kalshiOrders.ok && fetchStates.kalshiFills.ok;
}

export function shouldHoldDestructiveReconcileForVenueTruth(input: {
  venue: Venue;
  fetchStates: VenueReconcileFetchStates | undefined;
}) {
  return !isVenueReconcileTruthFresh(input.venue, input.fetchStates);
}

export function buildSkippedInvalidPolymarketMakerFillEvent(input: {
  asset: MarketAsset;
  intentId: string;
  venueOrderId: string;
  tradeId: string;
  issue: string;
  now: number;
}): RunEvent {
  return {
    asset: input.asset,
    level: "error",
    eventType: "fills.polymarket.skipped_invalid_maker",
    message: "Polymarket maker fill skipped because required order-side truth is missing",
    payload: {
      intentId: input.intentId,
      venueOrderId: input.venueOrderId,
      tradeId: input.tradeId,
      issue: input.issue,
    },
    createdAt: input.now,
  };
}

async function replaceVenuePositionsIfChanged(
  venue: "polymarket" | "kalshi",
  asset: MarketAsset,
  positions: PositionSnapshot[],
  now: number,
) {
  const key = `${venue}:${asset}`;
  const signature = serializePositionSignature(positions);
  const previous = lastPositionWriteByVenueAsset.get(key);
  if (previous && previous.signature === signature && now - previous.writtenAt < POSITION_WRITE_THROTTLE_MS) {
    return;
  }

  await replaceVenuePositions(venue, asset, positions);
  lastPositionWriteByVenueAsset.set(key, { signature, writtenAt: now });
}

function serializePositionSignature(positions: PositionSnapshot[]) {
  return JSON.stringify(
    positions
      .map((position) => ({
        venue: position.venue,
        asset: position.asset,
        marketRef: position.marketRef,
        outcome: position.outcome,
        size: round4(position.size),
        averagePrice: position.averagePrice === null ? null : round4(position.averagePrice),
        currentPrice: position.currentPrice === null ? null : round4(position.currentPrice),
        currentValueUsd: round4(position.currentValueUsd),
        redeemable: position.redeemable,
        mergeable: position.mergeable,
      }))
      .sort((left, right) =>
        `${left.venue}:${left.asset}:${left.marketRef}:${left.outcome}`.localeCompare(
          `${right.venue}:${right.asset}:${right.marketRef}:${right.outcome}`,
        ),
      ),
  );
}

async function getCachedGlobalRiskConfig(
  now: number,
  failClosed = false,
): Promise<VersionedConfiguration<GlobalRiskConfig>> {
  if (globalRiskConfigCache && now - globalRiskConfigCache.capturedAt <= SETTINGS_CACHE_TTL_MS) {
    return globalRiskConfigCache.value;
  }

  let value: VersionedConfiguration<GlobalRiskConfig>;
  try {
    value = await readGlobalRiskConfig();
  } catch (error) {
    if (failClosed) {
      throw error;
    }
    console.warn(`[risk] global config unavailable, using defaults for diagnostics: ${toErrorMessage(error)}`);
    return {
      config: { ...DEFAULT_GLOBAL_RISK_CONFIG },
      revision: -1,
      updatedAt: 0,
    };
  }
  globalRiskConfigCache = { value, capturedAt: now };
  return value;
}

async function getCachedMismatchCalibration(now: number): Promise<ActiveMismatchCalibration> {
  if (mismatchCalibrationCache && now - mismatchCalibrationCache.capturedAt <= SETTINGS_CACHE_TTL_MS) {
    return mismatchCalibrationCache.value;
  }

  try {
    const value = await readActiveMismatchCalibration();
    mismatchCalibrationCache = { value, capturedAt: now };
    return value;
  } catch (error) {
    console.warn(
      `[risk] mismatch calibration unavailable, retaining uncalibrated diagnostics: ${toErrorMessage(error)}`,
    );
    return {
      artifact: null,
      revision: -1,
      updatedAt: 0,
    };
  }
}

function estimateMismatchRiskByCombination(input: {
  asset: MarketAsset;
  slotStartTs: number;
  slotEndTs: number;
  now: number;
  polymarket: OpportunitySnapshot["polymarket"];
  kalshi: OpportunitySnapshot["kalshi"];
  opportunities: LiveOpportunity[];
  oracleMaxAgeMs: number;
  settings: StrategyConfig;
  mismatchCalibration: ActiveMismatchCalibration;
}): Partial<Record<PairCombination, MismatchRiskEstimate>> {
  const estimates: Partial<Record<PairCombination, MismatchRiskEstimate>> = {};
  const diagnosticMaxSourceAgeMs = Math.max(input.oracleMaxAgeMs, MISMATCH_DIAGNOSTIC_MAX_SOURCE_AGE_MS);
  for (const opportunity of input.opportunities) {
    const economics = deriveMismatchEstimateEconomics({
      opportunity,
      polymarket: input.polymarket,
      kalshi: input.kalshi,
      settings: input.settings,
    });
    const estimate = mismatchRiskRuntime.estimate({
      asset: input.asset,
      polymarket: input.polymarket,
      kalshi: input.kalshi,
      now: input.now,
      maxSourceAgeMs: diagnosticMaxSourceAgeMs,
      maxPairSkewMs: diagnosticMaxSourceAgeMs,
      executionMaxSourceAgeMs: input.oracleMaxAgeMs,
      executionMaxPairSkewMs: input.oracleMaxAgeMs,
      combination: opportunity.combination,
      slotStartTs: input.slotStartTs,
      slotEndTs: input.slotEndTs,
      pairSize: economics.pairSize ?? 0,
      totalCostUsd: economics.totalCostUsd ?? 0,
    });
    const estimateWithEconomics: MismatchRiskEstimate = {
      ...estimate,
      reason:
        economics.basis === "unavailable" && estimate.reason === "economics_unavailable"
          ? "reference_economics_unavailable"
          : estimate.reason,
      economicsBasis: economics.basis,
      economicsPairSize: economics.pairSize,
      economicsTotalCostUsd: economics.totalCostUsd,
    };
    estimates[opportunity.combination] = applyActiveMismatchCalibrationToEstimate({
      estimate: estimateWithEconomics,
      activation: input.mismatchCalibration,
      combination: opportunity.combination,
      secondsRemaining: Math.max(0, (input.slotEndTs - input.now) / 1_000),
    });
  }
  return estimates;
}

function buildMismatchClusterBudget(input: {
  slotEndTs: number;
  now: number;
  balances: VenueBalance[];
  openIntents: OrderIntent[];
  config: GlobalRiskConfig;
}) {
  const capitalUsd = deriveRiskCapitalUsd(input.balances, input.now, input.config);
  const exposures = input.openIntents
    .filter((intent) => !intent.shadow && intent.slotEndTs === input.slotEndTs)
    .map((intent) => ({
      fatalLossUsd:
        intent.fatalLossExposureUsd ??
        intent.legs.reduce(
          (sum, leg) =>
            sum +
            Math.max(
              0,
              leg.requestedNotionalUsd,
              leg.requestedPrice === null ? 0 : leg.requestedSize * leg.requestedPrice,
            ) +
            Math.max(0, leg.feeUsd),
          0,
        ),
      pFatalUpper95: intent.mismatchPFatalUpper ?? 1,
    }));

  return calculateHybridClusterBudget({
    capitalUsd,
    exposures,
    expectedRiskFraction: input.config.clusterExpectedFatalLossShare,
    expectedRiskCapUsd: input.config.clusterExpectedFatalLossCapUsd,
    absoluteRiskFraction: input.config.clusterAbsoluteFatalLossShare,
    absoluteRiskCapUsd: input.config.clusterAbsoluteFatalLossCapUsd,
  });
}

function deriveRiskCapitalUsd(balances: VenueBalance[], now: number, config: GlobalRiskConfig) {
  const requiredVenues: Venue[] = ["polymarket", "kalshi"];
  const freshBalances = requiredVenues.map((venue) =>
    balances.find(
      (balance) =>
        balance.venue === venue && balance.status === "ready" && now - balance.capturedAt <= config.balanceMaxAgeMs,
    ),
  );
  return freshBalances.every(Boolean)
    ? freshBalances.reduce((sum, balance) => sum + (balance?.totalBalanceUsd ?? 0), 0)
    : 0;
}

function rescaleMismatchEstimate(
  opportunity: LiveOpportunity,
  estimate: MismatchRiskEstimate | null,
  safetyFractionOfBreakEven = 0.5,
): MismatchRiskEstimate | null {
  if (
    !estimate?.available ||
    estimate.pFatal === null ||
    estimate.pFatalUpper95 === null ||
    estimate.pAligned === null ||
    estimate.pDouble === null
  ) {
    return estimate;
  }

  const pairSize = Math.min(opportunity.legs[0].size, opportunity.legs[1].size);
  const totalCostUsd = Math.max(
    0,
    -(opportunity.fatalMismatchPnlUsd ?? 0) ||
      opportunity.legs.reduce((sum, leg) => sum + leg.targetNotionalUsd + leg.feeEstimateUsd, 0),
  );
  if (pairSize <= 0) {
    return estimate;
  }

  const pnl = calculateMismatchAdjustedPnl({
    pairSize,
    totalCostUsd,
    probabilities: {
      pFatal: estimate.pFatal,
      pAligned: estimate.pAligned,
      pDouble: estimate.pDouble,
    },
    pFatalUpper95: estimate.pFatalUpper95,
  });
  const gate = evaluateEconomicMismatchGate({
    pairSize,
    totalCostUsd,
    pFatalUpper95: estimate.pFatalUpper95,
    safetyFractionOfBreakEven,
  });
  return {
    ...estimate,
    expectedPnlUsd: pnl.expectedPnlUsd,
    conservativePnlUsd: pnl.conservativePnlUsd,
    fatalPnlUsd: pnl.fatalPnlUsd,
    breakEvenFatalProbability: gate.pBreakEven,
    maximumAllowedFatalProbability: gate.maximumAllowedFatalProbability,
    economicsBasis: "executable",
    economicsPairSize: pairSize,
    economicsTotalCostUsd: totalCostUsd,
  };
}

async function recheckMismatchRiskForExecution(input: {
  opportunity: LiveOpportunity;
  intent?: OrderIntent | null;
  slot: MarketSlot;
  settings: StrategyConfig;
  openIntents: OrderIntent[];
  venueExposureUsd: Record<Venue, number>;
  now: number;
  globalRiskConfig?: GlobalRiskConfig;
  marketState?: {
    polymarket: { quote: OpportunitySnapshot["polymarket"] };
    kalshi: { quote: OpportunitySnapshot["kalshi"] };
  };
  balances?: VenueBalance[];
  /** The supplied opportunity already contains exact REST limit-price worst-fill costs. */
  usePrecomputedWorstFillEconomics?: boolean;
}): Promise<
  | { allowed: true; opportunity: LiveOpportunity }
  | {
      allowed: false;
      reason: string;
      estimate: MismatchRiskEstimate | null;
      opportunity?: LiveOpportunity;
    }
> {
  let config = input.globalRiskConfig;
  if (!config) {
    try {
      config = (await getCachedGlobalRiskConfig(input.now, input.settings.mismatchRiskMode === "enforce")).config;
    } catch (error) {
      return {
        allowed: false,
        reason: `Global risk configuration unavailable: ${toErrorMessage(error)}`,
        estimate: null,
      };
    }
  }
  const [{ polymarket, kalshi }, balances] = await Promise.all([
    input.marketState ?? marketDataSupervisor.readSlotState(input.slot, input.now),
    input.balances ?? readCachedVenueBalances(input.now),
  ]);
  const candidateOpportunity = input.usePrecomputedWorstFillEconomics
    ? input.opportunity
    : input.intent
      ? buildWorstFillRiskOpportunity({
          opportunity: input.opportunity,
          intent: input.intent,
          polymarket: polymarket.quote,
          kalshi: kalshi.quote,
          settings: input.settings,
        })
      : input.opportunity;
  if (!candidateOpportunity) {
    return {
      allowed: false,
      reason: "Worst-fill execution economics unavailable",
      estimate: null,
    };
  }
  if (!input.settings.shadowMode) {
    const deterministicIssue = validateWorstFillExecutionCaps({
      opportunity: candidateOpportunity,
      intent: input.intent ?? null,
      settings: input.settings,
      balances,
      openIntents: input.openIntents,
      venueExposureUsd: input.venueExposureUsd,
      balanceMaxAgeMs: config.balanceMaxAgeMs,
      now: input.now,
    });
    if (deterministicIssue) {
      return {
        allowed: false,
        reason: deterministicIssue,
        estimate: null,
      };
    }
  }
  const riskBoundedOpportunity = applyHedgeRecoveryReserveToOpportunity(
    candidateOpportunity,
    input.intent ?? null,
    input.settings,
  );
  const pairSize = Math.min(candidateOpportunity.legs[0].size, candidateOpportunity.legs[1].size);
  const totalCostUsd = candidateOpportunity.legs.reduce(
    (sum, leg) => sum + leg.targetNotionalUsd + leg.feeEstimateUsd,
    0,
  );
  const rawEstimate = mismatchRiskRuntime.estimate({
    asset: input.slot.asset,
    polymarket: polymarket.quote,
    kalshi: kalshi.quote,
    now: input.now,
    maxSourceAgeMs: Math.max(config.oracleMaxAgeMs, MISMATCH_DIAGNOSTIC_MAX_SOURCE_AGE_MS),
    maxPairSkewMs: Math.max(config.oracleMaxAgeMs, MISMATCH_DIAGNOSTIC_MAX_SOURCE_AGE_MS),
    executionMaxSourceAgeMs: config.oracleMaxAgeMs,
    executionMaxPairSkewMs: config.oracleMaxAgeMs,
    combination: candidateOpportunity.combination,
    slotStartTs: input.slot.startTs,
    slotEndTs: input.slot.endTs,
    pairSize,
    totalCostUsd,
  });
  let executionCalibration: ActiveMismatchCalibration;
  try {
    executionCalibration = await readActiveMismatchCalibration();
  } catch {
    executionCalibration = { artifact: null, revision: -1, updatedAt: 0 };
  }
  const estimateWithEconomics: MismatchRiskEstimate = {
    ...rawEstimate,
    economicsBasis: pairSize > 0 && totalCostUsd > 0 ? "executable" : "unavailable",
    economicsPairSize: pairSize > 0 ? pairSize : null,
    economicsTotalCostUsd: totalCostUsd > 0 ? totalCostUsd : null,
  };
  const calibratedEstimate = applyActiveMismatchCalibrationToEstimate({
    estimate: estimateWithEconomics,
    activation: executionCalibration,
    combination: candidateOpportunity.combination,
    secondsRemaining: Math.max(0, (input.slot.endTs - input.now) / 1_000),
  });
  const estimate =
    rescaleMismatchEstimate(candidateOpportunity, calibratedEstimate, getMismatchFatalBudgetFraction(config)) ??
    calibratedEstimate;

  const policyInput = {
    opportunity: riskBoundedOpportunity,
    estimate,
    slotEndTs: input.slot.endTs,
    openIntents: input.openIntents,
    capitalUsd: deriveRiskCapitalUsd(balances, input.now, config),
    globalRiskConfig: config,
    candidateIntentId: input.intent?.id ?? null,
  };
  const blockOnlyPolicy = recheckMismatchRiskCandidate({
    ...policyInput,
    mode: "block_only",
  });
  const mismatchRiskAudit = buildMismatchRiskAudit({
    opportunity: riskBoundedOpportunity,
    estimate,
    policy: blockOnlyPolicy,
    evaluatedAt: input.now,
    source: "execution",
    safetyFractionOfBreakEven: getMismatchFatalBudgetFraction(config),
  });
  const policy = applyMismatchRiskPolicy({
    ...policyInput,
    mode: input.settings.mismatchRiskMode,
  });
  if (!policy.allowed) {
    return {
      allowed: false,
      reason: policy.blockingReasons.map((reason) => reason.message).join(" | "),
      estimate,
      opportunity: {
        ...policy.opportunity,
        mismatchRiskAudit,
      },
    };
  }

  return {
    allowed: true,
    opportunity: {
      ...policy.opportunity,
      mismatchRiskAudit,
    },
  };
}

export function validateWorstFillExecutionCaps(input: {
  opportunity: LiveOpportunity;
  intent: OrderIntent | null;
  settings: Pick<
    StrategyConfig,
    | "grossEntryThreshold"
    | "executionPriceBuffer"
    | "maxPairNotionalUsd"
    | "maxLegCapitalShare"
    | "maxLegPrice"
    | "minProjectedNetProfitUsd"
    | "minProjectedNetReturn"
    | "minWorstCaseProfitUsd"
    | "maxVenueExposureUsd"
    | "hedgeRescueEnabled"
    | "hedgeRescueMaxLossUsd"
    | "forcedUnwindMaxLossUsd"
  >;
  balances: VenueBalance[];
  openIntents: OrderIntent[];
  venueExposureUsd: Record<Venue, number>;
  balanceMaxAgeMs: number;
  now: number;
}) {
  const allowedGrossCost = input.settings.grossEntryThreshold + input.settings.executionPriceBuffer;
  const grossCost = input.opportunity.grossCost;
  if (grossCost === null || !Number.isFinite(grossCost) || grossCost > allowedGrossCost + ORDER_SIZE_TOLERANCE) {
    return `Worst-fill gross cost ${grossCost?.toFixed(4) ?? "n/a"} exceeds ${allowedGrossCost.toFixed(4)}`;
  }

  const venueCosts: Record<Venue, number> = { polymarket: 0, kalshi: 0 };
  let pairSize = Number.POSITIVE_INFINITY;
  for (const leg of input.opportunity.legs) {
    if (leg.price === null || !Number.isFinite(leg.price) || leg.price <= 0) {
      return `Worst-fill ${leg.venue} ${leg.outcome} order price is unavailable`;
    }
    if (leg.price > input.settings.maxLegPrice + ORDER_SIZE_TOLERANCE) {
      return `Worst-fill ${leg.venue} ${leg.outcome} price ${leg.price.toFixed(4)} exceeds max leg price ${input.settings.maxLegPrice.toFixed(4)}`;
    }
    const legCostUsd = leg.targetNotionalUsd + leg.feeEstimateUsd;
    if (!Number.isFinite(legCostUsd) || legCostUsd <= 0) {
      return `Worst-fill ${leg.venue} ${leg.outcome} cost is invalid`;
    }
    venueCosts[leg.venue] += legCostUsd;
    pairSize = Math.min(pairSize, leg.size);
  }

  const totalCostUsd = venueCosts.polymarket + venueCosts.kalshi;
  if (totalCostUsd > input.settings.maxPairNotionalUsd + ORDER_SIZE_TOLERANCE) {
    return `Worst-fill pair cost ${totalCostUsd.toFixed(4)} exceeds pair budget ${input.settings.maxPairNotionalUsd.toFixed(4)}`;
  }
  const maxLegCostUsd = input.settings.maxPairNotionalUsd * input.settings.maxLegCapitalShare;
  for (const venue of ["polymarket", "kalshi"] as const) {
    if (venueCosts[venue] > maxLegCostUsd + ORDER_SIZE_TOLERANCE) {
      return `Worst-fill ${venue} cost ${venueCosts[venue].toFixed(4)} exceeds leg budget ${maxLegCostUsd.toFixed(4)}`;
    }
  }

  const projectedNetProfitUsd = pairSize - totalCostUsd;
  const projectedNetReturn = totalCostUsd > 0 ? projectedNetProfitUsd / totalCostUsd : null;
  if (!doesSizingMeetProfitThresholds(projectedNetProfitUsd, projectedNetReturn, input.settings)) {
    return `Worst-fill aligned economics fail configured profit thresholds (profit=${projectedNetProfitUsd.toFixed(4)}, return=${projectedNetReturn?.toFixed(6) ?? "n/a"})`;
  }

  const candidateIntentId = input.intent?.id ?? null;
  const effectiveBalances = applyVenueBalanceReservations(
    input.balances,
    input.openIntents.filter((intent) => intent.id !== candidateIntentId),
  );
  const hedgeRecoveryReserveUsd = calculateHedgeRecoveryReserveUsd({
    pairSize,
    standardWorstFillCostUsd: totalCostUsd,
    intent: input.intent,
    settings: input.settings,
  });
  for (const venue of ["polymarket", "kalshi"] as const) {
    const reserveUsd = venue === input.intent?.hedgeVenue ? hedgeRecoveryReserveUsd : 0;
    const requiredUsd = venueCosts[venue] + reserveUsd;
    const balance = effectiveBalances.find((candidate) => candidate.venue === venue);
    if (!balance || balance.status !== "ready" || input.now - balance.capturedAt > input.balanceMaxAgeMs) {
      return `Fresh ready balance unavailable for ${venue}`;
    }
    if (requiredUsd > balance.availableBalanceUsd + ORDER_SIZE_TOLERANCE) {
      return `Worst-fill ${venue} requirement ${requiredUsd.toFixed(4)} exceeds available balance ${balance.availableBalanceUsd.toFixed(4)}`;
    }
    if (input.venueExposureUsd[venue] + requiredUsd > input.settings.maxVenueExposureUsd + ORDER_SIZE_TOLERANCE) {
      return `Worst-fill ${venue} exposure ${(input.venueExposureUsd[venue] + requiredUsd).toFixed(4)} exceeds venue limit ${input.settings.maxVenueExposureUsd.toFixed(4)}`;
    }
  }

  return null;
}

function calculateHedgeRecoveryReserveUsd(input: {
  pairSize: number;
  standardWorstFillCostUsd: number;
  intent: OrderIntent | null;
  settings: Pick<StrategyConfig, "hedgeRescueEnabled" | "hedgeRescueMaxLossUsd" | "forcedUnwindMaxLossUsd">;
}) {
  if (!input.settings.hedgeRescueEnabled || input.intent?.hedgeVenue !== "polymarket" || input.pairSize <= 0) {
    return 0;
  }
  const effectiveLossCapUsd = Math.min(
    input.settings.hedgeRescueMaxLossUsd,
    input.settings.forcedUnwindMaxLossUsd > 0
      ? input.settings.forcedUnwindMaxLossUsd
      : input.settings.hedgeRescueMaxLossUsd,
  );
  const rescueTotalCostCapUsd = input.pairSize + effectiveLossCapUsd;
  return round4(Math.max(0, rescueTotalCostCapUsd - input.standardWorstFillCostUsd));
}

function applyHedgeRecoveryReserveToOpportunity(
  opportunity: LiveOpportunity,
  intent: OrderIntent | null,
  settings: Pick<StrategyConfig, "hedgeRescueEnabled" | "hedgeRescueMaxLossUsd" | "forcedUnwindMaxLossUsd">,
): LiveOpportunity {
  const pairSize = Math.min(opportunity.legs[0].size, opportunity.legs[1].size);
  const standardWorstFillCostUsd = opportunity.legs.reduce(
    (sum, leg) => sum + leg.targetNotionalUsd + leg.feeEstimateUsd,
    0,
  );
  const reserveUsd = calculateHedgeRecoveryReserveUsd({
    pairSize,
    standardWorstFillCostUsd,
    intent,
    settings,
  });
  if (reserveUsd <= 0) {
    return opportunity;
  }
  return {
    ...opportunity,
    fatalMismatchPnlUsd: round4(-(standardWorstFillCostUsd + reserveUsd)),
    conservativeExpectedPnlUsd:
      opportunity.conservativeExpectedPnlUsd === null || opportunity.conservativeExpectedPnlUsd === undefined
        ? null
        : round4(opportunity.conservativeExpectedPnlUsd - reserveUsd),
  };
}

function buildWorstFillRiskOpportunity(input: {
  opportunity: LiveOpportunity;
  intent: OrderIntent;
  polymarket: OpportunitySnapshot["polymarket"];
  kalshi: OpportunitySnapshot["kalshi"];
  settings: StrategyConfig;
  reserveHedgeRetryBuffer?: boolean;
}): LiveOpportunity | null {
  const maximumHedgeSlippageBps = Math.max(
    input.intent.maxSlippageBps,
    input.settings.maxSlippageBps,
    input.settings.adaptiveSlippageTightBps,
    input.settings.adaptiveSlippageDefaultBps,
    input.settings.adaptiveSlippageThinBps,
  );
  const riskLegs = input.intent.legs.map((leg) => {
    const isPrimary = leg.venue === input.intent.primaryVenue;
    const riskLeg =
      input.reserveHedgeRetryBuffer !== false && !isPrimary && leg.side === "BUY" && leg.requestedPrice !== null
        ? {
            ...leg,
            requestedPrice: Math.min(0.99, leg.requestedPrice + input.settings.executionPriceBuffer),
            requestedNotionalUsd: round4(
              leg.requestedSize * Math.min(0.99, leg.requestedPrice + input.settings.executionPriceBuffer),
            ),
          }
        : leg;
    const request = buildVenueOrderRequest(
      riskLeg,
      isPrimary ? input.intent.maxSlippageBps : maximumHedgeSlippageBps,
      isPrimary ? primaryImmediateOrderType(riskLeg.venue) : immediatePartialOrderType(riskLeg.venue),
      false,
      {
        kalshiPriceTicksSlippage:
          isPrimary && riskLeg.venue === "kalshi" ? input.settings.kalshiPrimaryPriceTicksSlippage : undefined,
        kalshiPriceRanges: riskLeg.venue === "kalshi" ? input.kalshi.priceRanges : undefined,
        authoritativeTickSize:
          riskLeg.venue === "polymarket"
            ? input.polymarket.outcomes[riskLeg.outcome === "UP" ? "up" : "down"].tickSize
            : undefined,
      },
    );
    if (request.price === null || request.price <= 0 || request.size <= 0) {
      return null;
    }
    const quote =
      leg.venue === "polymarket"
        ? quoteMultiLevelBuyLeg({
            venue: "polymarket",
            levels: [{ price: request.price, size: request.size }],
            size: request.size,
            feeRateBps:
              input.polymarket.outcomes[leg.outcome === "UP" ? "up" : "down"].feeRateBps ?? input.polymarket.feeRateBps,
            feeRate: input.polymarket.feeRate ?? undefined,
            feeExponent: input.polymarket.feeExponent ?? undefined,
          })
        : quoteMultiLevelBuyLeg({
            venue: "kalshi",
            levels: [{ price: request.price, size: request.size }],
            size: request.size,
            feeMultiplier: input.kalshi.feeMultiplier,
          });
    if (!quote) {
      return null;
    }
    const sourceLeg = input.opportunity.legs.find(
      (candidate) => candidate.venue === leg.venue && candidate.outcome === leg.outcome,
    );
    return {
      ...(sourceLeg ?? {
        venue: leg.venue,
        outcome: leg.outcome,
        marketRef: leg.marketRef,
        tokenId: leg.tokenId,
        depth: null,
        tickSize: null,
        minOrderSize: null,
      }),
      price: request.price,
      size: request.size,
      targetNotionalUsd: quote.worstFillNotionalUsd,
      feeEstimateUsd: quote.worstFillFeeUsd,
    };
  });
  if (riskLegs.some((leg) => leg === null)) {
    return null;
  }
  const legs = riskLegs as LiveOpportunity["legs"];
  const pairSize = Math.min(legs[0].size, legs[1].size);
  const worstFillCostUsd = legs.reduce((sum, leg) => sum + leg.targetNotionalUsd + leg.feeEstimateUsd, 0);
  const projectedNetProfitUsd = round4(pairSize - worstFillCostUsd);
  const conservativeExpectedPnlUsd =
    input.intent.mismatchPFatalUpper === null || input.intent.mismatchPFatalUpper === undefined
      ? projectedNetProfitUsd
      : round4(pairSize * (1 - input.intent.mismatchPFatalUpper) - worstFillCostUsd);
  return {
    ...input.opportunity,
    grossCost: round4(legs.reduce((sum, leg) => sum + (leg.price ?? 0), 0)),
    worstCaseProfitUsd: projectedNetProfitUsd,
    fatalMismatchPnlUsd: round4(-worstFillCostUsd),
    conservativeExpectedPnlUsd,
    estimatedFeesUsd: round4(legs.reduce((sum, leg) => sum + leg.feeEstimateUsd, 0)),
    projectedNetProfitUsd,
    projectedNetReturn: worstFillCostUsd > 0 ? round4(projectedNetProfitUsd / worstFillCostUsd) : null,
    legs,
  };
}

function applyWorstFillEconomicsToIntent(intent: OrderIntent, opportunity: LiveOpportunity, now: number): OrderIntent {
  const pairSize = Math.min(opportunity.legs[0].size, opportunity.legs[1].size);
  const fatalLossExposureUsd = Math.max(0, -(opportunity.fatalMismatchPnlUsd ?? 0));
  const conservativeExpectedPnlUsd =
    intent.mismatchPFatalUpper === null || intent.mismatchPFatalUpper === undefined
      ? (opportunity.conservativeExpectedPnlUsd ?? null)
      : round4(pairSize * (1 - intent.mismatchPFatalUpper) - fatalLossExposureUsd);
  return {
    ...intent,
    grossCost: opportunity.grossCost ?? intent.grossCost,
    targetNotionalUsd: round4(intent.legs.reduce((sum, leg) => sum + leg.requestedNotionalUsd, 0)),
    projectedNetProfitUsd: opportunity.projectedNetProfitUsd,
    fatalMismatchPnlUsd: opportunity.fatalMismatchPnlUsd ?? null,
    conservativeExpectedPnlUsd,
    fatalLossExposureUsd,
    legs: applyOpportunityRiskReservationsToLegs(intent, opportunity),
    updatedAt: now,
  };
}

function applyOpportunityRiskReservationsToLegs(
  intent: OrderIntent,
  opportunity: LiveOpportunity,
): OrderIntent["legs"] {
  const standardWorstFillCostUsd = opportunity.legs.reduce(
    (sum, leg) => sum + leg.targetNotionalUsd + leg.feeEstimateUsd,
    0,
  );
  const fatalLossExposureUsd = Math.max(standardWorstFillCostUsd, Math.max(0, -(opportunity.fatalMismatchPnlUsd ?? 0)));
  const recoveryReserveUsd = Math.max(0, fatalLossExposureUsd - standardWorstFillCostUsd);

  return intent.legs.map((leg) => {
    const opportunityLeg = opportunity.legs.find(
      (candidate) => candidate.venue === leg.venue && candidate.outcome === leg.outcome,
    );
    const worstFillCostUsd = opportunityLeg
      ? opportunityLeg.targetNotionalUsd + opportunityLeg.feeEstimateUsd
      : leg.requestedNotionalUsd + Math.max(0, leg.feeUsd);
    return {
      ...leg,
      worstFillCostUsd: round4(Math.max(0, worstFillCostUsd)),
      recoveryReserveUsd: leg.venue === intent.hedgeVenue ? round4(recoveryReserveUsd) : 0,
    };
  }) as OrderIntent["legs"];
}

function applyConservativeHedgeRiskFallback(
  intent: OrderIntent,
  settings: Pick<StrategyConfig, "hedgeRescueEnabled" | "hedgeRescueMaxLossUsd" | "forcedUnwindMaxLossUsd">,
  now: number,
) {
  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  const pairSize = Math.max(
    0,
    primaryLeg?.filledSize ?? 0,
    Math.min(intent.legs[0].requestedSize, intent.legs[1].requestedSize),
  );
  const limitLossUsd = intent.legs.reduce((sum, leg) => {
    const filledCostUsd =
      leg.filledSize > 0 && leg.filledPrice !== null ? leg.filledSize * leg.filledPrice + Math.max(0, leg.feeUsd) : 0;
    const remainingSize = Math.max(0, leg.requestedSize - leg.filledSize);
    const remainingCostUsd = remainingSize * (0.99 + CONSERVATIVE_REMAINING_BUY_FEE_USD_PER_UNIT);
    return sum + filledCostUsd + remainingCostUsd;
  }, 0);
  const recoveryReserveUsd = calculateHedgeRecoveryReserveUsd({
    pairSize,
    standardWorstFillCostUsd: limitLossUsd,
    intent,
    settings,
  });
  const fatalLossExposureUsd = round4(Math.max(intent.fatalLossExposureUsd ?? 0, limitLossUsd + recoveryReserveUsd));
  const riskLegs = intent.legs.map((leg) => {
    const filledCostUsd =
      leg.filledSize > 0 && leg.filledPrice !== null ? leg.filledSize * leg.filledPrice + Math.max(0, leg.feeUsd) : 0;
    const remainingSize = Math.max(0, leg.requestedSize - leg.filledSize);
    const worstFillCostUsd = filledCostUsd + remainingSize * (0.99 + CONSERVATIVE_REMAINING_BUY_FEE_USD_PER_UNIT);
    return {
      ...leg,
      worstFillCostUsd: round4(Math.max(leg.worstFillCostUsd ?? 0, worstFillCostUsd)),
      recoveryReserveUsd:
        leg.venue === intent.hedgeVenue ? round4(Math.max(leg.recoveryReserveUsd ?? 0, recoveryReserveUsd)) : 0,
    };
  }) as OrderIntent["legs"];
  return {
    ...intent,
    fatalMismatchPnlUsd: -fatalLossExposureUsd,
    fatalLossExposureUsd,
    conservativeExpectedPnlUsd:
      intent.mismatchPFatalUpper === null || intent.mismatchPFatalUpper === undefined
        ? -fatalLossExposureUsd
        : round4(pairSize * (1 - intent.mismatchPFatalUpper) - fatalLossExposureUsd),
    legs: riskLegs,
    updatedAt: now,
  };
}

function applyRiskCheckedOpportunityToIntent(
  intent: OrderIntent,
  opportunity: LiveOpportunity,
  now: number,
): OrderIntent {
  const estimate = opportunity.mismatchRiskEstimate;
  return {
    ...intent,
    mismatchPFatal: estimate ? estimate.pFatal : (intent.mismatchPFatal ?? null),
    mismatchPFatalUpper: estimate ? estimate.pFatalUpper95 : (intent.mismatchPFatalUpper ?? null),
    mismatchModelVersion: estimate ? estimate.modelVersion : (intent.mismatchModelVersion ?? null),
    mismatchRiskAudit: opportunity.mismatchRiskAudit ?? intent.mismatchRiskAudit ?? null,
    fatalMismatchPnlUsd: opportunity.fatalMismatchPnlUsd ?? null,
    conservativeExpectedPnlUsd: opportunity.conservativeExpectedPnlUsd ?? null,
    fatalLossExposureUsd:
      opportunity.fatalMismatchPnlUsd === null || opportunity.fatalMismatchPnlUsd === undefined
        ? null
        : round4(Math.max(0, -opportunity.fatalMismatchPnlUsd)),
    legs: applyOpportunityRiskReservationsToLegs(intent, opportunity),
    updatedAt: now,
  };
}

export function applyFinalEntryRiskOpportunityToIntent(
  intent: OrderIntent,
  opportunity: LiveOpportunity,
  now: number,
): OrderIntent {
  const riskChecked = applyRiskCheckedOpportunityToIntent(intent, opportunity, now);
  const legs = riskChecked.legs.map((leg) => {
    const opportunityLeg = opportunity.legs.find(
      (candidate) => candidate.venue === leg.venue && candidate.outcome === leg.outcome,
    );
    return opportunityLeg
      ? {
          ...leg,
          requestedSize: opportunityLeg.size,
          requestedNotionalUsd: opportunityLeg.targetNotionalUsd,
        }
      : leg;
  }) as OrderIntent["legs"];
  return {
    ...riskChecked,
    grossCost: opportunity.grossCost ?? riskChecked.grossCost,
    targetNotionalUsd: round4(opportunity.legs.reduce((sum, leg) => sum + leg.targetNotionalUsd, 0)),
    projectedNetProfitUsd: opportunity.projectedNetProfitUsd,
    legs,
  };
}

function buildRiskOpportunityTemplateFromIntent(intent: OrderIntent, settings: StrategyConfig): LiveOpportunity {
  const legs = intent.legs.map((leg) => ({
    venue: leg.venue,
    outcome: leg.outcome,
    marketRef: leg.marketRef,
    tokenId: leg.tokenId,
    price: leg.requestedPrice,
    depth: null,
    targetNotionalUsd: leg.requestedNotionalUsd,
    size: leg.requestedSize,
    tickSize: null,
    minOrderSize: null,
    feeEstimateUsd: leg.feeUsd,
  })) as LiveOpportunity["legs"];
  return {
    asset: intent.asset,
    id: intent.id,
    slotKey: intent.slotKey,
    capturedAt: intent.updatedAt,
    combination: intent.combination,
    label: intent.combination,
    grossCost: intent.grossCost,
    threshold: settings.grossEntryThreshold,
    thresholdMet: intent.grossCost <= settings.grossEntryThreshold,
    worstCaseProfitUsd: intent.projectedNetProfitUsd,
    fatalMismatchPnlUsd: intent.fatalMismatchPnlUsd ?? null,
    conservativeExpectedPnlUsd: intent.conservativeExpectedPnlUsd ?? null,
    mismatchRiskEstimate: null,
    mismatchRiskAudit: intent.mismatchRiskAudit ?? null,
    eligible: true,
    primaryVenue: intent.primaryVenue,
    primarySelection: null,
    improvementFromLastEntry: null,
    estimatedFeesUsd: round4(intent.legs.reduce((sum, leg) => sum + leg.feeUsd, 0)),
    projectedNetProfitUsd: intent.projectedNetProfitUsd,
    projectedNetReturn: null,
    reasons: [],
    legs,
    mismatchGuardAction: "allow",
    mismatchSizeMultiplier: 1,
    referencePayoutCount: null,
    deadZoneDistanceBps: null,
    deadZoneWidthBps: null,
    mismatchRisk: null,
    venueDisagreementPct: null,
    secondsElapsedInSlot: null,
    chainlinkMoveBps: null,
    openDriftBps: null,
    chainlinkLivePriceUsd: null,
    observedSlotOpenPriceUsd: null,
    kalshiTargetPriceUsd: null,
  };
}

export function createExecutionCoordinator(
  asset: MarketAsset,
  settings: StrategyConfig,
  sharedContext: TickSharedContext = {},
): ExecutionCoordinator {
  let latestScanSnapshot: OpportunitySnapshot | null = null;

  return {
    async scan(slot, now, options = {}) {
      const balances = sharedContext.venueBalances ?? (await readVenueBalances());
      const openIntents = sharedContext.openIntents ?? (await readOpenOrderIntents());
      const effectiveBalances = applyVenueBalanceReservations(balances, openIntents);
      const { polymarket: polymarketState, kalshi: kalshiState } = await marketDataSupervisor.readSlotState(slot, now);
      const polymarket = polymarketState.quote;
      const kalshi = kalshiState.quote;
      const lastEntryCosts =
        sharedContext.lastEntryCosts ??
        (await readLastAuthorizedEntryCosts(slot.asset, slot.key, settings.shadowMode ? "shadow" : "live"));
      const signalInput = {
        slotKey: slot.key,
        now,
        slotStartTs: slot.startTs,
        polymarket,
        kalshi,
        settings,
        balances: effectiveBalances,
        lastEntryCosts,
        secondsRemaining: slot.secondsRemaining,
      };
      const baseOpportunities = buildSignals({
        ...signalInput,
        settings: getMismatchEstimationSettings(settings),
      });
      const globalRiskConfig =
        sharedContext.executionConfiguration?.globalRisk.config ?? (await getCachedGlobalRiskConfig(now)).config;
      const mismatchCalibration = sharedContext.mismatchCalibration ?? (await getCachedMismatchCalibration(now));
      const mismatchRiskEstimates = estimateMismatchRiskByCombination({
        asset: slot.asset,
        slotStartTs: slot.startTs,
        slotEndTs: slot.endTs,
        now,
        polymarket,
        kalshi,
        opportunities: baseOpportunities,
        oracleMaxAgeMs: globalRiskConfig.oracleMaxAgeMs,
        settings,
        mismatchCalibration,
      });
      const clusterBudget =
        settings.mismatchRiskMode === "enforce"
          ? buildMismatchClusterBudget({
              slotEndTs: slot.endTs,
              now,
              balances,
              openIntents,
              config: globalRiskConfig,
            })
          : null;
      const riskSizedOpportunities = buildSignals({
        ...signalInput,
        mismatchRiskEstimates,
        riskBudget: clusterBudget
          ? {
              remainingExpectedFatalLossUsd: clusterBudget.remainingExpectedLossUsd,
              remainingAbsoluteFatalLossUsd: clusterBudget.remainingAbsoluteLossUsd,
              fatalProbabilityBudgetFractionOfAlignedMargin: getMismatchFatalBudgetFraction(globalRiskConfig),
            }
          : null,
      });
      const opportunities = riskSizedOpportunities.map((opportunity) => {
        const estimate = rescaleMismatchEstimate(
          opportunity,
          mismatchRiskEstimates[opportunity.combination] ?? null,
          getMismatchFatalBudgetFraction(globalRiskConfig),
        );
        if (!estimate) {
          return opportunity;
        }
        const policyInput = {
          opportunity,
          estimate,
          slotEndTs: slot.endTs,
          openIntents,
          capitalUsd: deriveRiskCapitalUsd(balances, now, globalRiskConfig),
          globalRiskConfig,
        };
        const blockOnlyPolicy = recheckMismatchRiskCandidate({
          ...policyInput,
          mode: "block_only",
        });
        const mismatchRiskAudit = buildMismatchRiskAudit({
          opportunity,
          estimate,
          policy: blockOnlyPolicy,
          evaluatedAt: now,
          source: "scan",
          safetyFractionOfBreakEven: getMismatchFatalBudgetFraction(globalRiskConfig),
        });
        const configuredPolicy = applyMismatchRiskPolicy({
          ...policyInput,
          mode: settings.mismatchRiskMode,
        });
        return {
          ...configuredPolicy.opportunity,
          mismatchRiskAudit,
        };
      });

      if (options.persistSnapshot !== false) {
        await writeSnapshot({
          asset: slot.asset,
          slotKey: slot.key,
          slotStartTs: slot.startTs,
          slotEndTs: slot.endTs,
          capturedAt: now,
          polymarket,
          kalshi,
          opportunities,
        });
      }

      scheduleOracleObservation({
        asset: slot.asset,
        slotKey: slot.key,
        slotStartTs: slot.startTs,
        slotEndTs: slot.endTs,
        capturedAt: now,
        polymarket,
        kalshi,
        opportunities,
      });

      await syncFeedCircuitBreaker(slot, [polymarket.feedHealth, kalshi.feedHealth], now);

      const nextSnapshot: OpportunitySnapshot = {
        asset: slot.asset,
        slotKey: slot.key,
        slotStartTs: slot.startTs,
        slotEndTs: slot.endTs,
        capturedAt: now,
        polymarket,
        kalshi,
        opportunities,
      };

      if (settings.shadowMode && sharedContext.executionConfiguration) {
        scheduleLateEntryProbeCapture({
          snapshot: nextSnapshot,
          slot,
          settings,
          globalRiskConfig,
          strategyRevision: sharedContext.executionConfiguration.strategyRevision,
          globalRiskRevision: sharedContext.executionConfiguration.globalRisk.revision,
        });
      }

      latestScanSnapshot = nextSnapshot;
      return nextSnapshot;
    },

    async execute(slot, now, providedSnapshot = null) {
      const snapshot = providedSnapshot ?? latestScanSnapshot ?? (await refreshLatestSnapshot(slot));
      const readiness = await computeReadiness(snapshot, slot.asset, now);
      const pausingBreakers = readiness.breakers.filter((breaker) =>
        shouldPauseExecutionForCircuitBreakerImpact(breaker.worstImpact),
      );

      await writeAssetWorkerState(
        slot.asset,
        {
          readinessStatus: readiness.state.readinessStatus,
          readiness: readiness.state.readiness,
        },
        now,
        false,
      );

      const snapshotFresh = snapshot ? isOpportunitySnapshotFresh(snapshot, now, settings.maxSignalAgeMs) : false;
      if (snapshot && !snapshotFresh) {
        await maybeWriteStaleSignalRunEvent(slot.asset, snapshot, settings, now);
      }
      const eligible = snapshotFresh
        ? (snapshot?.opportunities.filter((opportunity) => opportunity.eligible) ?? [])
        : [];

      const executeWithinLock = async () => {
        const initialOpenIntents = await readOpenOrderIntents(slot.asset);
        const activeSlotIntents = initialOpenIntents.filter((intent) => intent.slotEndTs + RESOLUTION_GRACE_MS > now);
        const resumed = [
          ...(snapshot
            ? await resumeShadowIntents(
                initialOpenIntents.filter((intent) => intent.shadow),
                snapshot,
                settings,
              )
            : []),
          ...(await resumeInFlightIntents(
            activeSlotIntents.filter((intent) => !intent.shadow),
            slot.asset,
            settings,
            now,
          )),
        ];

        const expectedConfiguration = sharedContext.executionConfiguration;
        if (!expectedConfiguration) {
          return resumed;
        }
        const currentConfiguration = await readExecutionConfiguration(slot.asset);
        if (!executionConfigurationMatches(expectedConfiguration, currentConfiguration)) {
          await writeConfigurationRevisionChangedEvent({
            asset: slot.asset,
            slotKey: slot.key,
            stage: "under_execution_lock",
            expected: expectedConfiguration,
            actual: currentConfiguration,
            now: Date.now(),
          });
          return resumed;
        }

        if (
          !settings.enableTrading ||
          !currentConfiguration.strategy.config.enableTrading ||
          currentConfiguration.strategy.config.shadowMode !== settings.shadowMode ||
          (!settings.shadowMode &&
            (pausingBreakers.length > 0 || readiness.state.readinessStatus !== "ready" || !isLiveExecutionAllowed())) ||
          !snapshotFresh ||
          !snapshot ||
          (!settings.shadowMode && eligible.length === 0)
        ) {
          return resumed;
        }

        const openIntents = await readOpenOrderIntents();
        const assetOpenIntents = openIntents.filter((intent) => intent.asset === slot.asset);

        if (hasUnresolvedExposureBlocker(openIntents.filter((intent) => !intent.shadow))) {
          return resumed;
        }

        const blockingOpenForSlot = countSlotExecutionBlockers(assetOpenIntents, slot.key);
        const shadowExecutionBlockers = countShadowExecutionBlockers(assetOpenIntents, slot.asset);
        const latestShadowIntent = settings.shadowMode
          ? ((await readRecentOrderIntents(200, slot.asset)).find((intent) => intent.shadow) ?? null)
          : null;
        const shadowCooldownRemainingMs = getShadowReentryCooldownRemainingMs(latestShadowIntent, Date.now());
        if (
          settings.shadowMode
            ? shadowExecutionBlockers > 0 || shadowCooldownRemainingMs > 0
            : blockingOpenForSlot >= settings.maxOpenIntentsPerSlot
        ) {
          return resumed;
        }

        const created: OrderIntent[] = [...resumed];
        const positions =
          sharedContext.venuePositions === null
            ? await readPositions()
            : sharedContext.venuePositions
              ? [...sharedContext.venuePositions.polymarket, ...sharedContext.venuePositions.kalshi]
              : await readPositions();
        const exposureUsd = calculateVenueExposureUsd(positions, openIntents);
        const creationBudget = settings.shadowMode ? 1 : settings.maxOpenIntentsPerSlot - blockingOpenForSlot;
        let createdCount = 0;

        for (const opportunity of eligible) {
          if (createdCount >= creationBudget) {
            break;
          }

          const currentBreakers = getRelevantCircuitBreakerAggregates(
            aggregateCircuitBreakerIncidents(await readCurrentCircuitBreakerIncidents(), Date.now()),
            slot.asset,
            slot.key,
          ).filter((breaker) => shouldPauseExecutionForCircuitBreakerImpact(breaker.worstImpact));
          if (currentBreakers.length > 0) {
            break;
          }

          if (!settings.shadowMode && !isLiveExecutionAllowed()) {
            break;
          }

          const currentOpenIntents = await readOpenOrderIntents();
          const currentAssetOpenIntents = currentOpenIntents.filter((intent) => intent.asset === slot.asset);
          if (hasUnresolvedExposureBlocker(currentOpenIntents.filter((intent) => !intent.shadow))) {
            break;
          }

          const currentSlotBlockers = countSlotExecutionBlockers(currentAssetOpenIntents, slot.key);
          const currentShadowBlockers = countShadowExecutionBlockers(currentAssetOpenIntents, slot.asset);
          if (settings.shadowMode ? currentShadowBlockers > 0 : currentSlotBlockers >= settings.maxOpenIntentsPerSlot) {
            break;
          }

          const baseIntent = createIntentFromOpportunity({
            opportunity,
            slotStartTs: slot.startTs,
            slotEndTs: slot.endTs,
            now,
            maxSlippageBps: settings.maxSlippageBps,
            shadow: settings.shadowMode,
          });

          const preparedIntent = settings.shadowMode
            ? { intent: baseIntent, reason: null }
            : await prepareIntentForLiveExecution(baseIntent, slot, settings, Date.now());
          if (!preparedIntent.intent) {
            await writeRunEvent({
              level: "warn",
              eventType:
                preparedIntent.reason === "unsafe_polymarket_primary"
                  ? "intent.skipped.unsafe_primary_sequence"
                  : "intent.skipped.execution_window",
              message:
                preparedIntent.reason === "unsafe_polymarket_primary"
                  ? `Intent ${baseIntent.id} skipped because Kalshi hedge capacity is not robust enough to lead with Polymarket`
                  : `Intent ${baseIntent.id} skipped because the live pair no longer fits the execution window`,
              payload: {
                intentId: baseIntent.id,
                slotKey: baseIntent.slotKey,
                combination: baseIntent.combination,
                primaryVenue: baseIntent.primaryVenue,
                reason: preparedIntent.reason,
              },
              createdAt: now,
            });
            continue;
          }
          let executionOpportunity = opportunity;
          let draftIntent = preparedIntent.intent;
          if (!settings.shadowMode) {
            const mismatchRecheckAt = Date.now();
            const mismatchRecheck = await recheckMismatchRiskForExecution({
              opportunity,
              intent: preparedIntent.intent,
              slot,
              settings,
              openIntents: currentOpenIntents,
              venueExposureUsd: exposureUsd,
              now: mismatchRecheckAt,
              globalRiskConfig: currentConfiguration.globalRisk.config,
            });
            if (!mismatchRecheck.allowed) {
              await writeRunEvent({
                asset: slot.asset,
                level: "warn",
                eventType: "intent.skipped.mismatch_risk_recheck",
                message: `Prepared opportunity ${opportunity.combination} rejected by execution-time mismatch risk check`,
                payload: {
                  slotKey: slot.key,
                  combination: opportunity.combination,
                  reason: mismatchRecheck.reason,
                  estimate: mismatchRecheck.estimate,
                  mismatchRiskAudit: mismatchRecheck.opportunity?.mismatchRiskAudit ?? null,
                },
                createdAt: mismatchRecheckAt,
              });
              continue;
            }
            executionOpportunity = mismatchRecheck.opportunity;
            draftIntent = applyRiskCheckedOpportunityToIntent(
              preparedIntent.intent,
              executionOpportunity,
              mismatchRecheckAt,
            );
          }

          const executed = settings.shadowMode
            ? await admitAndExecuteShadowIntent(
                draftIntent,
                slot,
                snapshot,
                settings,
                expectedConfiguration,
                executionOpportunity.primarySelection ?? null,
              )
            : await executeIntent(
                draftIntent,
                slot,
                settings,
                now,
                expectedConfiguration,
                executionOpportunity.primarySelection ?? null,
              );
          if (!executed) {
            continue;
          }
          for (const leg of executionOpportunity.legs) {
            exposureUsd[leg.venue] += leg.targetNotionalUsd + leg.feeEstimateUsd;
          }
          const standardWorstFillCostUsd = executionOpportunity.legs.reduce(
            (sum, leg) => sum + leg.targetNotionalUsd + leg.feeEstimateUsd,
            0,
          );
          const recoveryReserveUsd = Math.max(
            0,
            -(executionOpportunity.fatalMismatchPnlUsd ?? -standardWorstFillCostUsd) - standardWorstFillCostUsd,
          );
          if (recoveryReserveUsd > 0) {
            exposureUsd[draftIntent.hedgeVenue] += recoveryReserveUsd;
          }
          created.push(executed);
          createdCount += 1;
        }

        return created;
      };

      const lockResult = await tryWithExecutionLock(settings.shadowMode, slot.asset, slot.key, executeWithinLock);
      if (!lockResult.acquired) {
        await recordExecutionLockBusy(slot.asset, slot.key, now);
        return [];
      }

      return lockResult.value;
    },

    async reconcile(slot, now) {
      const [polyPositions, kalshiPositions] = sharedContext.venuePositions
        ? [sharedContext.venuePositions.polymarket, sharedContext.venuePositions.kalshi]
        : sharedContext.venuePositions === null
          ? [
              (sharedContext.storedPositions ?? []).filter((position) => position.venue === "polymarket"),
              (sharedContext.storedPositions ?? []).filter((position) => position.venue === "kalshi"),
            ]
          : await Promise.all([polymarketAdapter.getPositions(now), kalshiAdapter.getPositions(now)]);

      const reconcileErrors: string[] = [];
      let venueOrderReconcileData = sharedContext.venueOrderReconcileData;
      const assetPolyPositions = polyPositions.filter((position) => position.asset === asset);
      const assetKalshiPositions = kalshiPositions.filter((position) => position.asset === asset);
      const allVenuePositions = [...polyPositions, ...kalshiPositions];

      reconcileErrors.push(
        ...(await runReconcileStep("replace_positions", now, async () => {
          await Promise.all([
            replaceVenuePositionsIfChanged("polymarket", asset, assetPolyPositions, now),
            replaceVenuePositionsIfChanged("kalshi", asset, assetKalshiPositions, now),
          ]);
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("reconcile_polymarket_convert_status", now, async () => {
          if (asset === "btc") {
            await reconcilePolymarketProxyConversions(now);
          }
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("auto_convert_polymarket", now, async () => {
          if (asset === "btc") {
            await autoConvertPolymarketIfConfigured(polyPositions, now);
          }
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("reconcile_venue_orders", now, async () => {
          venueOrderReconcileData = await reconcileVenueOrders(asset, now, sharedContext);
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("reconcile_inflight_intents", now, async () => {
          await reconcileInFlightIntentStates(asset, now, settings, {
            ...sharedContext,
            venueOrderReconcileData,
          });
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("clear_recovered_intent_messages", now, async () => {
          await clearRecoveredIntentFailureReasons(asset, now);
        })),
      );

      if (shouldRunReconcileCadence(asset, "settlements", now, SETTLEMENT_RECONCILE_INTERVAL_MS)) {
        reconcileErrors.push(
          ...(await runReconcileStep("reconcile_settlements", now, async () => {
            await reconcileSettlements(asset, now);
          })),
        );

        reconcileErrors.push(
          ...(await runReconcileStep("repair_recent_settled_resolutions", now, async () => {
            await repairRecentSettledIntentResolutions(asset, now);
          })),
        );

        reconcileErrors.push(
          ...(await runReconcileStep("reconcile_observed_slot_resolutions", now, async () => {
            if (asset === "btc") {
              await reconcileObservedSlotResolutions(now);
            }
          })),
        );

        reconcileErrors.push(
          ...(await runReconcileStep("backfill_unwound_pnl", now, async () => {
            await backfillUnwoundIntentPnl(asset, now);
          })),
        );
      }

      if (shouldRunReconcileCadence(asset, "pnl", now, PNL_RECONCILE_INTERVAL_MS)) {
        reconcileErrors.push(
          ...(await runReconcileStep("refresh_pnl", now, async () => {
            if (asset === "btc") {
              await refreshPnl(now, allVenuePositions);
            }
          })),
        );

        reconcileErrors.push(
          ...(await runReconcileStep("record_stable_pnl_changes", now, async () => {
            if (asset === "btc") {
              await recordStablePnlChanges(now, await readVenueBalances(), allVenuePositions);
            }
          })),
        );

        reconcileErrors.push(
          ...(await runReconcileStep("enforce_daily_loss_cap", now, async () => {
            if (asset === "btc") {
              await enforceDailyLossCap(now);
            }
          })),
        );
      }

      reconcileErrors.push(
        ...(await runReconcileStep("evaluate_market_blacklist", now, async () => {
          await evaluateMarketDegradedBreakers(asset, now);
        })),
      );

      if (shouldRunReconcileCadence(asset, "database_maintenance", now, DATABASE_MAINTENANCE_RECONCILE_INTERVAL_MS)) {
        reconcileErrors.push(
          ...(await runReconcileStep("database_maintenance", now, async () => {
            if (asset === "btc") {
              await maybeRunDatabaseMaintenance(now);
            }
          })),
        );
      }

      if (reconcileErrors.length > 0) {
        throw new Error(reconcileErrors.join(" | "));
      }
    },
  };
}

export async function tryWithExecutionLock<T>(
  shadowMode: boolean,
  asset: MarketAsset,
  slotKey: string,
  callback: () => Promise<T>,
  acquireLive: typeof tryWithGlobalLiveExecutionLock = tryWithGlobalLiveExecutionLock,
  acquireShadow: typeof tryWithShadowExecutionLock = tryWithShadowExecutionLock,
) {
  if (shadowMode) {
    return acquireShadow(asset, slotKey, `shadow:${asset}:${slotKey}`, callback);
  }
  return acquireLive(`live:${asset}:${slotKey}`, callback);
}

export function executionConfigurationMatches(
  expected: ExecutionConfigurationSnapshot,
  actual: Awaited<ReturnType<typeof readExecutionConfiguration>>,
) {
  return (
    expected.strategyRevision === actual.strategy.revision &&
    expected.globalRisk.revision === actual.globalRisk.revision &&
    expected.mismatchCalibration.revision === actual.mismatchCalibration.revision &&
    expected.mismatchCalibration.artifactId === actual.mismatchCalibration.artifactId
  );
}

async function writeConfigurationRevisionChangedEvent(input: {
  asset: MarketAsset;
  slotKey: string;
  intentId?: string;
  stage: "under_execution_lock" | "before_primary_submission";
  expected: ExecutionConfigurationSnapshot;
  actual: Awaited<ReturnType<typeof readExecutionConfiguration>>;
  now: number;
}) {
  await writeRunEvent({
    asset: input.asset,
    level: "info",
    eventType: "execution.skipped.configuration_revision_changed",
    message: `New entry skipped because configuration changed (${input.stage})`,
    payload: {
      intentId: input.intentId ?? null,
      slotKey: input.slotKey,
      stage: input.stage,
      expectedStrategyRevision: input.expected.strategyRevision,
      actualStrategyRevision: input.actual.strategy.revision,
      expectedGlobalRiskRevision: input.expected.globalRisk.revision,
      actualGlobalRiskRevision: input.actual.globalRisk.revision,
      expectedMismatchCalibrationRevision: input.expected.mismatchCalibration.revision,
      actualMismatchCalibrationRevision: input.actual.mismatchCalibration.revision,
      expectedMismatchCalibrationArtifactId: input.expected.mismatchCalibration.artifactId,
      actualMismatchCalibrationArtifactId: input.actual.mismatchCalibration.artifactId,
    },
    createdAt: input.now,
  });
}

export function getMismatchEstimationSettings(settings: StrategyConfig): StrategyConfig {
  return settings.mismatchRiskMode === "enforce" ? { ...settings, mismatchRiskMode: "shadow" } : settings;
}

async function persistOracleObservation(snapshot: OpportunitySnapshot) {
  const resolutionKey = `${snapshot.asset}:${snapshot.slotKey}`;
  const polymarketSlug = snapshot.polymarket.ref.slug ?? buildPolymarketSlotSlug(snapshot.asset, snapshot.slotStartTs);
  const polymarketMarketRef = snapshot.polymarket.ref.conditionId ?? snapshot.polymarket.ref.id ?? null;
  const kalshiMarketRef = snapshot.kalshi.slotAligned ? snapshot.kalshi.ref.id || null : null;
  const resolutionSignature = JSON.stringify({
    polymarketSlug,
    polymarketMarketRef,
    kalshiMarketRef,
    polymarketResolution: snapshot.polymarket.resolution,
    kalshiResolution: snapshot.kalshi.resolution,
  });
  if (observedResolutionSlots.get(resolutionKey) !== resolutionSignature) {
    try {
      await writeSlotResolution({
        asset: snapshot.asset,
        slotKey: snapshot.slotKey,
        slotStartTs: snapshot.slotStartTs,
        slotEndTs: snapshot.slotEndTs,
        polymarketSlug,
        polymarketMarketRef,
        kalshiMarketRef,
        polymarketResolution: snapshot.polymarket.resolution,
        kalshiResolution: snapshot.kalshi.resolution,
        polymarketSettlementValueUsd: null,
        kalshiSettlementValueUsd: null,
        firstObservedAt: snapshot.capturedAt,
        updatedAt: snapshot.capturedAt,
        resolvedAt: null,
        source: "market-data-observation",
        raw: {},
      });
      observedResolutionSlots.set(resolutionKey, resolutionSignature);
    } catch (error) {
      console.warn(`[oracle] failed to register slot ${resolutionKey}: ${toErrorMessage(error)}`);
    }
  }

  const hotOpportunity = snapshot.opportunities.some(
    (opportunity) => opportunity.grossCost !== null && opportunity.grossCost <= opportunity.threshold,
  );
  const lastCapturedAt = lastOracleSampleAtBySlot.get(resolutionKey) ?? null;
  if (!shouldPersistOracleSample(lastCapturedAt, snapshot.slotEndTs, snapshot.capturedAt, hotOpportunity)) {
    return;
  }

  const cf = snapshot.kalshi.cfBenchmarks ?? null;
  const mismatchEstimate =
    snapshot.opportunities.find((opportunity) => opportunity.mismatchRiskEstimate)?.mismatchRiskEstimate ?? null;
  try {
    await writeOracleSlotSample({
      asset: snapshot.asset,
      slotKey: snapshot.slotKey,
      slotStartTs: snapshot.slotStartTs,
      slotEndTs: snapshot.slotEndTs,
      capturedAt: snapshot.capturedAt,
      chainlinkStartPriceUsd: snapshot.polymarket.observedSlotOpenPriceUsd,
      chainlinkStartCapturedAt: snapshot.polymarket.observedSlotOpenCapturedAt,
      chainlinkLivePriceUsd: snapshot.polymarket.chainlinkLivePriceUsd,
      chainlinkSourceTs: snapshot.polymarket.chainlinkLivePriceCapturedAt,
      cfIndexId: cf?.indexId ?? null,
      cfLivePriceUsd: cf?.liveValueUsd ?? null,
      cfSourceTs: cf?.sourceTimestampMs ?? null,
      cfTrailingAverageUsd: cf?.trailing60s.valueUsd ?? null,
      cfTrailingWindowSize: cf?.trailing60s.windowSize ?? null,
      cfFinalMinuteAverageUsd: cf?.finalMinuteAverage15m?.valueUsd ?? null,
      cfFinalMinuteWindowSize: cf?.finalMinuteAverage15m?.windowSize ?? null,
      kalshiTargetPriceUsd: snapshot.kalshi.targetPriceUsd,
      modelVersion: mismatchEstimate?.rawModelVersion ?? mismatchEstimate?.modelVersion ?? null,
      riskByCombination: Object.fromEntries(
        snapshot.opportunities.map((opportunity) => [
          opportunity.combination,
          {
            model: opportunity.mismatchRiskEstimate ?? null,
            heuristicRisk: opportunity.mismatchRisk,
            guardAction: opportunity.mismatchGuardAction,
            deadZoneDistanceBps: opportunity.deadZoneDistanceBps,
            venueDisagreementPct: opportunity.venueDisagreementPct,
          },
        ]),
      ),
      economicsByCombination: Object.fromEntries(
        snapshot.opportunities.map((opportunity) => [
          opportunity.combination,
          {
            grossCost: opportunity.grossCost,
            pairSize: Math.min(opportunity.legs[0].size, opportunity.legs[1].size),
            projectedNetProfitUsd: opportunity.projectedNetProfitUsd,
            conservativeExpectedPnlUsd: opportunity.conservativeExpectedPnlUsd ?? null,
            fatalMismatchPnlUsd: opportunity.fatalMismatchPnlUsd ?? null,
            eligible: opportunity.eligible,
          },
        ]),
      ),
    });
    lastOracleSampleAtBySlot.set(resolutionKey, snapshot.capturedAt);
  } catch (error) {
    console.warn(`[oracle] failed to persist sample ${resolutionKey}: ${toErrorMessage(error)}`);
  }
}

function scheduleOracleObservation(snapshot: OpportunitySnapshot) {
  if (oraclePersistenceInFlightByAsset[snapshot.asset]) {
    return;
  }
  const pending = persistOracleObservation(snapshot)
    .catch((error) => {
      console.warn(`[oracle] asynchronous persistence failed for ${snapshot.slotKey}: ${toErrorMessage(error)}`);
    })
    .finally(() => {
      if (oraclePersistenceInFlightByAsset[snapshot.asset] === pending) {
        delete oraclePersistenceInFlightByAsset[snapshot.asset];
      }
    });
  oraclePersistenceInFlightByAsset[snapshot.asset] = pending;
}

export function isOpportunitySnapshotFresh(
  snapshot: Pick<OpportunitySnapshot, "capturedAt">,
  now: number,
  maxSignalAgeMs: number,
) {
  return getOpportunitySnapshotAgeMs(snapshot, now) <= maxSignalAgeMs;
}

export function getOpportunitySnapshotAgeMs(snapshot: Pick<OpportunitySnapshot, "capturedAt">, now: number) {
  return Math.max(0, now - snapshot.capturedAt);
}

export function selectWinningExecutionCandidate(candidates: ExecutionCandidate[], now: number) {
  const activeCandidates = candidates.filter(
    (candidate) =>
      candidate.expiresAt >= now &&
      candidate.projectedNetProfitUsd > 0 &&
      Number.isFinite(candidate.projectedNetProfitUsd) &&
      Number.isFinite(candidate.grossCost),
  );
  if (activeCandidates.length === 0) {
    return null;
  }

  return [...activeCandidates].sort((left, right) => {
    const profitDelta = right.projectedNetProfitUsd - left.projectedNetProfitUsd;
    if (Math.abs(profitDelta) > ORDER_SIZE_TOLERANCE) {
      return profitDelta;
    }

    const leftAge = Math.max(0, now - left.capturedAt);
    const rightAge = Math.max(0, now - right.capturedAt);
    if (leftAge !== rightAge) {
      return leftAge - rightAge;
    }

    return ACTIVE_MARKET_ASSETS.indexOf(left.asset) - ACTIVE_MARKET_ASSETS.indexOf(right.asset);
  })[0];
}

function buildExecutionCandidate(scanState: RealtimeScanState, now: number): ExecutionCandidate | null {
  const bestOpportunity = scanState.snapshot.opportunities
    .filter(
      (opportunity) =>
        opportunity.eligible &&
        opportunity.projectedNetProfitUsd !== null &&
        opportunity.projectedNetProfitUsd > 0 &&
        opportunity.grossCost !== null,
    )
    .sort((left, right) => {
      const profitDelta = (right.projectedNetProfitUsd ?? 0) - (left.projectedNetProfitUsd ?? 0);
      if (Math.abs(profitDelta) > ORDER_SIZE_TOLERANCE) {
        return profitDelta;
      }
      return (left.grossCost ?? Number.POSITIVE_INFINITY) - (right.grossCost ?? Number.POSITIVE_INFINITY);
    })[0];

  if (!bestOpportunity || bestOpportunity.projectedNetProfitUsd === null || bestOpportunity.grossCost === null) {
    return null;
  }

  return {
    asset: scanState.asset,
    slotKey: scanState.slot.key,
    scanSequence: scanState.sequence,
    capturedAt: scanState.capturedAt,
    expiresAt: scanState.capturedAt + scanState.settings.maxSignalAgeMs,
    combination: bestOpportunity.combination,
    projectedNetProfitUsd: bestOpportunity.projectedNetProfitUsd,
    grossCost: bestOpportunity.grossCost,
    signalAgeMs: Math.max(0, now - scanState.capturedAt),
    updatedAt: now,
  };
}

function shouldWriteExecutionCandidate(candidate: ExecutionCandidate, now: number) {
  const signature = buildExecutionCandidateSignature(candidate);
  const previous = lastExecutionCandidateWriteByAsset.get(candidate.asset);
  if (
    previous &&
    previous.signature === signature &&
    now - previous.writtenAt < EXECUTION_CANDIDATE_WRITE_THROTTLE_MS
  ) {
    return false;
  }

  return true;
}

function markExecutionCandidateWritten(candidate: ExecutionCandidate, now: number) {
  lastExecutionCandidateWriteByAsset.set(candidate.asset, {
    signature: buildExecutionCandidateSignature(candidate),
    writtenAt: now,
  });
}

function buildExecutionCandidateSignature(candidate: ExecutionCandidate) {
  return [
    candidate.slotKey,
    candidate.combination,
    round4(candidate.projectedNetProfitUsd),
    round4(candidate.grossCost),
  ].join(":");
}

function isWinningCandidateForScanState(winner: ExecutionCandidate, scanState: RealtimeScanState, now: number) {
  if (winner.asset !== scanState.asset || winner.slotKey !== scanState.slot.key) {
    return false;
  }
  if (winner.scanSequence === scanState.sequence) {
    return true;
  }

  return now - winner.updatedAt <= EXECUTION_CANDIDATE_WRITE_THROTTLE_MS + EXECUTION_ARBITER_WINDOW_MS;
}

function maybeLogExecutionCandidatePublished(candidate: ExecutionCandidate, now: number) {
  const lastLogAt = lastExecutionCandidateLogAtByAsset[candidate.asset] ?? 0;
  if (now - lastLogAt < EXECUTION_CANDIDATE_LOG_INTERVAL_MS) {
    return;
  }

  lastExecutionCandidateLogAtByAsset[candidate.asset] = now;
  console.log(
    `[worker] candidate published: asset=${candidate.asset} slot=${candidate.slotKey} profit=${candidate.projectedNetProfitUsd.toFixed(4)} age=${candidate.signalAgeMs}ms`,
  );
}

function resolveExecutionArbiterWindowMs() {
  const raw = process.env.WARBITRER_EXECUTION_ARBITER_WINDOW_MS;
  if (!raw) {
    return 25;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(250, Math.floor(parsed))) : 25;
}

async function readCachedSettings(asset: MarketAsset, now: number) {
  const cached = settingsCacheByAsset[asset];
  if (cached && now - cached.capturedAt <= SETTINGS_CACHE_TTL_MS) {
    return cached.value;
  }

  const value = await readSettings(asset);
  settingsCacheByAsset[asset] = { value, capturedAt: now };
  return value;
}

async function readCachedSettingsMap(now: number): Promise<VersionedStrategyConfigMap> {
  const entries = await Promise.all(
    ACTIVE_MARKET_ASSETS.map(async (asset) => [asset, await readCachedSettings(asset, now)] as const),
  );
  return Object.fromEntries(entries) as VersionedStrategyConfigMap;
}

async function readCachedVenueBalances(now: number) {
  if (venueBalancesCache && now - venueBalancesCache.capturedAt <= VENUE_BALANCES_CACHE_TTL_MS) {
    return venueBalancesCache.value;
  }

  const value = await readVenueBalances();
  venueBalancesCache = { value, capturedAt: now };
  return value;
}

async function readCachedOpenIntents(now: number) {
  if (openIntentsCache && now - openIntentsCache.capturedAt <= OPEN_INTENTS_CACHE_TTL_MS) {
    return openIntentsCache.value;
  }

  const value = await readOpenOrderIntents();
  openIntentsCache = { value, capturedAt: now };
  return value;
}

async function readCachedLastEntryCosts(asset: MarketAsset, slotKey: string, mode: "live" | "shadow", now: number) {
  const key = `${mode}:${asset}:${slotKey}`;
  const cached = lastEntryCostsCache.get(key);
  if (cached && now - cached.capturedAt <= LAST_ENTRY_COSTS_CACHE_TTL_MS) {
    return cached.value;
  }

  const value = await readLastAuthorizedEntryCosts(asset, slotKey, mode);
  lastEntryCostsCache.set(key, { value, capturedAt: now });
  return value;
}

function getLoopHealth(asset: MarketAsset): WorkerState["loopHealth"] {
  return (
    loopHealthByAsset[asset] ?? {
      lastScanDurationMs: null,
      lastExecutionDurationMs: null,
      lastReconcileDurationMs: null,
      lastScanAgeMs: null,
      lastCandidateScore: null,
      lockBusyCount: 0,
      staleSignalCount: 0,
      updatedAt: null,
    }
  );
}

function updateLoopHealth(asset: MarketAsset, patch: Partial<WorkerState["loopHealth"]>, now: number) {
  const next = {
    ...getLoopHealth(asset),
    ...patch,
    updatedAt: now,
  };
  loopHealthByAsset[asset] = next;
  return next;
}

async function writeAssetWorkerState(asset: MarketAsset, state: Partial<WorkerState>, now: number, force: boolean) {
  const shouldWrite = force || shouldPersistWorkerState(asset, now);
  if (!shouldWrite) {
    return;
  }

  lastPersistedWorkerStateAtByAsset[asset] = now;
  await writeWorkerState(asset, {
    ...state,
    loopHealth: state.loopHealth ?? getLoopHealth(asset),
  });
}

function shouldPersistWorkerState(asset: MarketAsset, now: number) {
  const lastPersistedAt = lastPersistedWorkerStateAtByAsset[asset] ?? null;
  return lastPersistedAt === null || now - lastPersistedAt >= SNAPSHOT_PERSIST_INTERVAL_MS;
}

async function recordExecutionLockBusy(asset: MarketAsset, slotKey: string, now: number) {
  const previousHealth = getLoopHealth(asset);
  const loopHealth = updateLoopHealth(
    asset,
    {
      lockBusyCount: previousHealth.lockBusyCount + 1,
    },
    now,
  );
  await writeAssetWorkerState(
    asset,
    {
      phase: "execute",
      currentSlotKey: slotKey,
      lastExecuteAt: now,
      loopHealth,
    },
    now,
    true,
  );

  const lastLogAt = lastExecutionLockBusyLogAtByAsset[asset] ?? 0;
  if (now - lastLogAt < EXECUTION_LOCK_BUSY_LOG_INTERVAL_MS) {
    return;
  }

  lastExecutionLockBusyLogAtByAsset[asset] = now;
  console.warn(`[worker] execution lock busy: asset=${asset} slot=${slotKey}`);
  await writeRunEvent({
    asset,
    level: "warn",
    eventType: "execution.lock_busy",
    message: `Execution lock busy for ${asset.toUpperCase()} ${slotKey}`,
    payload: {
      asset,
      slotKey,
    },
    createdAt: now,
  });
}

async function maybeWriteStaleSignalRunEvent(
  asset: MarketAsset,
  snapshot: OpportunitySnapshot,
  settings: StrategyConfig,
  now: number,
) {
  if (!snapshot.opportunities.some((opportunity) => opportunity.eligible)) {
    return;
  }

  const lastLogAt = lastStaleSignalLogAtByAsset[asset] ?? 0;
  if (now - lastLogAt < EXECUTOR_STALE_SIGNAL_LOG_INTERVAL_MS) {
    return;
  }

  lastStaleSignalLogAtByAsset[asset] = now;
  const previousHealth = getLoopHealth(asset);
  updateLoopHealth(
    asset,
    {
      staleSignalCount: previousHealth.staleSignalCount + 1,
      lastScanAgeMs: getOpportunitySnapshotAgeMs(snapshot, now),
    },
    now,
  );
  const signalAgeMs = getOpportunitySnapshotAgeMs(snapshot, now);
  console.warn(
    `[worker] executor skipped stale signal: asset=${asset} slot=${snapshot.slotKey} age=${signalAgeMs}ms max=${settings.maxSignalAgeMs}ms`,
  );
  await writeRunEvent({
    level: "warn",
    eventType: "executor.skipped.stale_signal",
    message: `Executor skipped stale ${asset.toUpperCase()} signal before live order`,
    payload: {
      asset,
      slotKey: snapshot.slotKey,
      capturedAt: snapshot.capturedAt,
      signalAgeMs,
      maxSignalAgeMs: settings.maxSignalAgeMs,
      eligibleOpportunities: snapshot.opportunities.filter((opportunity) => opportunity.eligible).length,
    },
    createdAt: now,
  });
}

function shouldRunReconcileCadence(asset: MarketAsset, key: ReconcileCadenceKey, now: number, intervalMs: number) {
  const byAsset = (lastReconcileCadenceAtByAsset[asset] ??= {});
  const lastRunAt = byAsset[key] ?? null;
  if (lastRunAt !== null && now - lastRunAt < intervalMs) {
    return false;
  }

  byAsset[key] = now;
  return true;
}

async function refreshBalances(polyBridgeLowWaterUsdc: number, now: number): Promise<VenueBalance[]> {
  const balances = await Promise.allSettled([polymarketAdapter.getBalance(), kalshiAdapter.getBalance()]);
  const mapped = balances.map((result, index) => {
    const venue = index === 0 ? "polymarket" : "kalshi";
    if (result.status === "fulfilled") {
      const balance = result.value;
      if (venue === "polymarket" && balance.availableBalanceUsd < polyBridgeLowWaterUsdc) {
        balance.notes = [...balance.notes, "pUSD disponible sous le seuil bridge configuré."];
      }
      return balance;
    }

    return {
      venue,
      capturedAt: now,
      status: "blocked",
      currency: venue === "polymarket" ? "pUSD" : "USD",
      availableBalanceUsd: 0,
      totalBalanceUsd: 0,
      portfolioValueUsd: 0,
      allowanceUsd: venue === "polymarket" ? 0 : null,
      notes: [toErrorMessage(result.reason)],
      raw: {},
    } as VenueBalance;
  });

  for (const balance of mapped) {
    await writeVenueBalance(balance);
  }

  return mapped;
}

async function refreshVenuePositions(): Promise<{
  polymarket: PositionSnapshot[];
  kalshi: PositionSnapshot[];
} | null> {
  try {
    const [polymarket, kalshi] = await Promise.all([
      polymarketAdapter.getPositions(Date.now()),
      kalshiAdapter.getPositions(Date.now()),
    ]);
    return { polymarket, kalshi };
  } catch {
    return null;
  }
}

function getGlobalPolyBridgeLowWaterUsdc(settingsMap: VersionedStrategyConfigMap) {
  return Math.max(...ACTIVE_MARKET_ASSETS.map((asset) => settingsMap[asset].config.polyBridgeLowWaterUsdc));
}

async function observeCircuitBreakerIncident(incident: CircuitBreakerIncident) {
  return writeCircuitBreakerIncident({
    incident,
    actor: incident.owner,
    requestId: `observe:${incident.id}`,
  });
}

async function resolveOwnedCircuitBreakerSafely(
  incident: CircuitBreakerIncident,
  conditionRecovered: boolean,
  exposureRecoveryProof?: CircuitBreakerRecoveryProof,
) {
  try {
    return await resolveCircuitBreakerIncident({
      incidentId: incident.id,
      expectedRevision: incident.revision,
      owner: incident.owner,
      conditionRecovered,
      exposureRecoveryProof,
      actor: incident.owner,
      requestId: `resolve:${incident.id}:${incident.revision}`,
    });
  } catch (error) {
    if (
      error instanceof CircuitBreakerIncidentPersistenceError &&
      (error.code === "already_resolved" || error.code === "revision_conflict")
    ) {
      return null;
    }
    throw error;
  }
}

async function recordCircuitBreakerExposureRecoverySafely(
  incident: CircuitBreakerIncident,
  recoveryProof: CircuitBreakerRecoveryProof,
) {
  try {
    return await writeCircuitBreakerExposureRecovery({
      incidentId: incident.id,
      expectedRevision: incident.revision,
      owner: incident.owner,
      recoveryProof,
      actor: incident.owner,
      requestId: `exposure:${incident.id}:${incident.revision}`,
    });
  } catch (error) {
    if (
      error instanceof CircuitBreakerIncidentPersistenceError &&
      (error.code === "already_resolved" || error.code === "revision_conflict")
    ) {
      return null;
    }
    throw error;
  }
}

function describeCircuitBreakerAggregate(aggregate: CircuitBreakerScopeAggregate, now?: number) {
  const remainingMs =
    now === undefined || aggregate.cooldownUntil === null ? null : Math.max(0, aggregate.cooldownUntil - now);
  const base = `${aggregate.scopeKey}:${aggregate.reasons.join(",")}:${aggregate.activeIncidentCount}`;
  return remainingMs === null ? base : `${base}:retry_in=${remainingMs}ms`;
}

function sanitizeCircuitBreakerText(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1_024) || "unknown";
}

async function computeReadiness(
  snapshot: OpportunitySnapshot | null,
  asset: MarketAsset,
  now: number,
): Promise<{ state: Partial<WorkerState>; breakers: CircuitBreakerScopeAggregate[] }> {
  const balances = await readVenueBalances();
  const slotKey = snapshot?.slotKey ?? null;
  const breakers = getRelevantCircuitBreakerAggregates(
    aggregateCircuitBreakerIncidents(await readCurrentCircuitBreakerIncidents(), now),
    asset,
    slotKey,
  );
  const checks = balances.map((balance) => ({
    key: `${balance.venue}:balance`,
    label: `${balance.venue} readiness`,
    status: balance.status,
    details: balance.notes.join(" | ") || "Venue ready",
    checkedAt: now,
  }));
  const feedHealth = snapshot ? [snapshot.polymarket.feedHealth, snapshot.kalshi.feedHealth] : [];
  checks.push(
    ...feedHealth.map((feed) => ({
      key: `${feed.venue}:market-data`,
      label: `${feed.venue} market data`,
      status: feed.feedStatus,
      details: [
        `source=${feed.source}`,
        feed.stalenessMs === null ? "staleness=na" : `staleness=${feed.stalenessMs}ms`,
        ...feed.details,
      ].join(" | "),
      checkedAt: now,
    })),
  );
  const blockingBreakers = breakers.filter((breaker) => breaker.worstImpact === "blocked");
  const cooldownBreakers = breakers.filter((breaker) => breaker.worstImpact === "cooldown");
  const degradedBreakers = breakers.filter((breaker) => breaker.worstImpact === "degraded");
  if (blockingBreakers.length > 0) {
    checks.push({
      key: "circuit-breaker",
      label: "Circuit breaker",
      status: "blocked",
      details: blockingBreakers.map(describeCircuitBreakerAggregate).join(" | "),
      checkedAt: now,
    });
  }
  if (cooldownBreakers.length > 0) {
    checks.push({
      key: "circuit-breaker-cooldown",
      label: "Circuit breaker cooldown",
      status: "cooldown",
      details: cooldownBreakers.map((breaker) => describeCircuitBreakerAggregate(breaker, now)).join(" | "),
      checkedAt: now,
    });
  }
  if (degradedBreakers.length > 0) {
    checks.push({
      key: "circuit-breaker-degraded",
      label: "Circuit breaker degraded",
      status: "degraded",
      details: degradedBreakers.map(describeCircuitBreakerAggregate).join(" | "),
      checkedAt: now,
    });
  }

  return {
    state: {
      readinessStatus: checks.some((check) => check.status === "blocked")
        ? "blocked"
        : checks.some((check) => check.status === "cooldown")
          ? "cooldown"
          : checks.some((check) => check.status === "degraded")
            ? "degraded"
            : "ready",
      readiness: checks,
    },
    breakers,
  };
}

async function syncFeedCircuitBreaker(slot: MarketSlot, feedHealth: VenueFeedHealth[], now: number) {
  const signature = buildFeedBreakerSignature(slot, feedHealth);
  const previous = lastFeedBreakerSyncByAsset[slot.asset] ?? null;
  if (!shouldSyncFeedCircuitBreaker(previous, signature, now)) {
    return;
  }

  await persistFeedCircuitBreaker(slot, feedHealth, now);
  lastFeedBreakerSyncByAsset[slot.asset] = { signature, syncedAt: now };
}

export function shouldSyncFeedCircuitBreaker(
  previous: { signature: string; syncedAt: number } | null,
  signature: string,
  now: number,
  intervalMs = FEED_BREAKER_SYNC_INTERVAL_MS,
) {
  return previous === null || previous.signature !== signature || now - previous.syncedAt >= intervalMs;
}

function buildFeedBreakerSignature(slot: MarketSlot, feedHealth: VenueFeedHealth[]) {
  const blocked = feedHealth
    .filter((feed) => feed.feedStatus === "blocked")
    .map((feed) => `${feed.venue}:${feed.source}`)
    .sort()
    .join(",");
  return `${slot.key}:${blocked || "ready"}`;
}

async function persistFeedCircuitBreaker(slot: MarketSlot, feedHealth: VenueFeedHealth[], now: number) {
  const incidents = await readCurrentCircuitBreakerIncidents();
  const feedIncidents = incidents.filter(
    (incident) =>
      incident.owner === CIRCUIT_BREAKER_INCIDENT_OWNERS.marketFeed &&
      incident.scope.type === "slot" &&
      incident.scope.asset === slot.asset,
  );
  const blockedFeeds = feedHealth.filter((feed) => feed.feedStatus === "blocked");
  const blockedVenues = new Set(blockedFeeds.map((feed) => feed.venue));

  for (const incident of feedIncidents) {
    if (incident.scope.type !== "slot") {
      continue;
    }
    const venue = incident.payload?.venue;
    const currentSlotIncident = incident.scope.slotKey === slot.key;
    if (!currentSlotIncident || (typeof venue === "string" && !blockedVenues.has(venue as Venue))) {
      await resolveOwnedCircuitBreakerSafely(incident, true);
    }
  }

  for (const feed of blockedFeeds) {
    const existing = feedIncidents.find(
      (incident) =>
        incident.scope.type === "slot" && incident.scope.slotKey === slot.key && incident.payload?.venue === feed.venue,
    );
    if (existing?.payload?.source === feed.source) {
      continue;
    }
    await observeCircuitBreakerIncident(
      createMarketFeedIncident({
        asset: slot.asset,
        slotKey: slot.key,
        venue: feed.venue,
        source: feed.source,
        triggeredAt: now,
        stalenessMs: feed.stalenessMs,
        details: feed.details.slice(0, 32).map(sanitizeCircuitBreakerText),
      }),
    );
  }
}

type InitialEntryMarketState = Awaited<ReturnType<typeof marketDataSupervisor.readSlotState>>;

function evaluateFinalInitialEntryPolicy(input: {
  intent: OrderIntent;
  slot: MarketSlot;
  settings: StrategyConfig;
  marketState: InitialEntryMarketState;
  now: number;
  submissionBudgetMs: number;
}) {
  return validateInitialEntryAdmission({
    now: input.now,
    slot: input.slot,
    intent: input.intent,
    polymarket: input.marketState.polymarket.quote,
    kalshi: input.marketState.kalshi.quote,
    entryCutoffSeconds: input.settings.entryCutoffSeconds,
    submissionBudgetMs: input.submissionBudgetMs,
    maxFeedAgeMs: input.settings.maxSignalAgeMs,
    maxBookAgeMs: {
      polymarket: Math.min(input.settings.maxSignalAgeMs, input.settings.polymarketHedgeBookMaxAgeMs),
      kalshi: input.settings.maxSignalAgeMs,
    },
    maxPairBookSkewMs: Math.min(input.settings.maxSignalAgeMs, input.settings.polymarketHedgeBookMaxAgeMs),
  });
}

async function recordInitialEntryRejection(input: {
  intent: OrderIntent;
  stage: string;
  code: string;
  reason: string;
  now: number;
  payload?: Record<string, unknown>;
}) {
  await writeRunEvent({
    asset: input.intent.asset,
    level: "warn",
    eventType: "intent.entry_admission.rejected",
    message: `Entry ${input.intent.id} rejected before initial submission (${input.reason})`,
    payload: {
      intentId: input.intent.id,
      slotKey: input.intent.slotKey,
      combination: input.intent.combination,
      mode: input.intent.shadow ? "shadow" : "live",
      stage: input.stage,
      code: input.code,
      ...input.payload,
    },
    createdAt: input.now,
  });
}

async function writeAdmittedIntentCreatedEvent(
  intent: OrderIntent,
  primarySelection: LiveOpportunity["primarySelection"],
  now: number,
) {
  await writeRunEvent({
    asset: intent.asset,
    level: "info",
    eventType: "intent.created",
    message: `Intent ${intent.id} admitted for ${intent.combination}`,
    payload: {
      intentId: intent.id,
      slotKey: intent.slotKey,
      primaryVenue: intent.primaryVenue,
      primarySelection,
      mismatchRiskAudit: intent.mismatchRiskAudit ?? null,
      admissionMode: intent.shadow ? "shadow" : "live",
    },
    createdAt: now,
  });
}

function findMismatchEstimate(snapshot: OpportunitySnapshot, combination: PairCombination) {
  return (
    snapshot.opportunities.find((opportunity) => opportunity.combination === combination)?.mismatchRiskEstimate ?? null
  );
}

async function writeCandidateEntryProbe(input: {
  intent: OrderIntent;
  signalSnapshot: OpportunitySnapshot;
  restCapture: ShadowRestCapture;
  restPreflight: RestPairedPreflightDecision;
  settings: StrategyConfig;
  expectedConfiguration: ExecutionConfigurationSnapshot;
  riskEstimate: MismatchRiskEstimate | null;
  decision: string;
  firstRejectionStage: "rest" | "risk" | "admission" | null;
  firstRejectionCode: string | null;
  restStartedAt: number;
}) {
  await writeEntryExecutionProbe({
    probeKey: `candidate-preflight-v1:${input.intent.id}`,
    asset: input.intent.asset,
    slotKey: input.intent.slotKey,
    slotStartTs: input.intent.slotStartTs,
    slotEndTs: input.intent.slotEndTs,
    combination: input.intent.combination,
    probeKind: "candidate_preflight",
    targetSecondsRemaining: null,
    signalCapturedAt: input.signalSnapshot.capturedAt,
    restStartedAt: input.restStartedAt,
    restCapturedAt: input.restCapture.capturedAt,
    decision: input.decision,
    firstRejectionStage: input.firstRejectionStage,
    firstRejectionCode: input.firstRejectionCode,
    strategyRevision: input.expectedConfiguration.strategyRevision,
    globalRiskRevision: input.expectedConfiguration.globalRisk.revision,
    signal: buildProbeSignalEvidence(input.signalSnapshot, input.intent.combination),
    rest: buildProbeRestEvidence(input.intent, input.restCapture, input.restPreflight),
    risk: toJsonRecord({ estimate: input.riskEstimate }),
    variants: buildEntryProbeVariants(input.intent, input.restCapture.snapshot, input.settings, input.riskEstimate),
    recordedAt: Math.max(Date.now(), input.restCapture.capturedAt),
  });
}

function scheduleLateEntryProbeCapture(input: {
  snapshot: OpportunitySnapshot;
  slot: MarketSlot;
  settings: StrategyConfig;
  globalRiskConfig: GlobalRiskConfig;
  strategyRevision: number;
  globalRiskRevision: number;
}) {
  const asset = input.slot.asset;
  if (lateEntryProbeCaptureInFlightByAsset[asset]) {
    return;
  }
  const previous = (lateEntryProbeIdentitiesByAsset[asset] ?? []).filter(
    (identity) => identity.slotKey === input.slot.key,
  );
  lateEntryProbeIdentitiesByAsset[asset] = previous;
  const identity = nextLateEntryProbeIdentity({
    asset,
    slotKey: input.slot.key,
    secondsRemaining: input.slot.secondsRemaining,
    seen: previous,
  });
  if (!identity) {
    return;
  }

  const task = captureLateEntryProbe({ ...input, identity })
    .then(() => {
      previous.push(identity);
    })
    .catch((error) => {
      console.warn(
        `[entry-probe] ${asset} ${identity.slotKey} t-${identity.targetSeconds}s failed: ${toErrorMessage(error)}`,
      );
    })
    .finally(() => {
      delete lateEntryProbeCaptureInFlightByAsset[asset];
    });
  lateEntryProbeCaptureInFlightByAsset[asset] = task;
}

type LateEntryProbeCaptureInput = {
  snapshot: OpportunitySnapshot;
  slot: MarketSlot;
  settings: StrategyConfig;
  globalRiskConfig: GlobalRiskConfig;
  strategyRevision: number;
  globalRiskRevision: number;
  identity: LateEntryProbeIdentity;
};

async function captureLateEntryProbe(input: LateEntryProbeCaptureInput) {
  const existing = await readEntryExecutionProbes({
    since: input.slot.startTs,
    until: input.slot.endTs + 15 * 60_000,
    asset: input.slot.asset,
    limit: 1_000,
  });
  const missingCombinations = getMissingLateEntryProbeCombinations(
    input.identity,
    existing.map((probe) => probe.probeKey),
  );
  if (missingCombinations.length === 0) {
    return;
  }

  const kalshiBookRequests = new Map<string, ReturnType<typeof fetchKalshiOrderbook>>();
  await Promise.all(
    missingCombinations.map(async (combination) => {
      const opportunity = input.snapshot.opportunities.find((candidate) => candidate.combination === combination);
      const probeKey = buildLateEntryProbeCombinationKey(input.identity, combination);
      if (!opportunity) {
        await writeLateEntryProbeWithoutRest({
          input,
          probeKey,
          combination,
          opportunity: null,
          firstRejectionStage: "signal",
          firstRejectionCode: "opportunity_unavailable",
        });
        return;
      }

      const captureRejection = getLateEntryProbeCaptureRejection({
        now: Date.now(),
        slot: input.slot,
        snapshot: input.snapshot,
        opportunity,
      });
      if (captureRejection) {
        await writeLateEntryProbeWithoutRest({
          input,
          probeKey,
          combination,
          opportunity,
          firstRejectionStage: "rest",
          firstRejectionCode: captureRejection,
        });
        return;
      }

      if (opportunity.grossCost === null) {
        await writeLateEntryProbeWithoutRest({
          input,
          probeKey,
          combination,
          opportunity,
          firstRejectionStage: "signal",
          firstRejectionCode: "reference_economics_unavailable",
        });
        return;
      }

      let intent: OrderIntent;
      try {
        intent = createIntentFromOpportunity({
          opportunity: { ...opportunity, eligible: true },
          slotStartTs: input.slot.startTs,
          slotEndTs: input.slot.endTs,
          now: input.snapshot.capturedAt,
          maxSlippageBps: input.settings.maxSlippageBps,
          shadow: true,
        });
      } catch (error) {
        await writeLateEntryProbeWithoutRest({
          input,
          probeKey,
          combination,
          opportunity,
          firstRejectionStage: "signal",
          firstRejectionCode: "intent_template_unavailable",
          rest: toJsonRecord({ error: toErrorMessage(error) }),
        });
        return;
      }

      const restStartedAt = Date.now();
      const preRestRejection = getLateEntryProbeCaptureRejection({
        now: restStartedAt,
        slot: input.slot,
        snapshot: input.snapshot,
        opportunity,
      });
      if (preRestRejection) {
        await writeLateEntryProbeWithoutRest({
          input,
          probeKey,
          combination,
          opportunity,
          firstRejectionStage: "rest",
          firstRejectionCode: preRestRejection,
          recordedAt: restStartedAt,
        });
        return;
      }
      const kalshiMarketRef = intent.legs.find((leg) => leg.venue === "kalshi")?.marketRef ?? null;
      let sharedKalshiBook: ReturnType<typeof fetchKalshiOrderbook> | undefined;
      if (kalshiMarketRef) {
        sharedKalshiBook = kalshiBookRequests.get(kalshiMarketRef);
        if (!sharedKalshiBook) {
          sharedKalshiBook = fetchKalshiOrderbook(kalshiMarketRef);
          kalshiBookRequests.set(kalshiMarketRef, sharedKalshiBook);
        }
      }
      const restCapture = await captureShadowRestSnapshot(intent, input.snapshot, restStartedAt, {
        kalshiBook: sharedKalshiBook,
      });
      const preflight = deriveRestPairedPreflight({
        intent,
        snapshot: restCapture.snapshot,
        settings: input.settings,
      });
      const captureEndedAfterSlot = restCapture.capturedAt >= input.slot.endTs;
      const disposition = captureEndedAfterSlot
        ? {
            decision: "rejected" as const,
            firstRejectionStage: "rest" as const,
            firstRejectionCode: "slot_ended_during_rest_capture",
          }
        : classifyLateEntryProbeDisposition(
            restCapture.errors,
            preflight,
            opportunity.mismatchRiskEstimate ?? null,
            input.globalRiskConfig,
          );
      await writeEntryExecutionProbe({
        probeKey,
        asset: input.slot.asset,
        slotKey: input.slot.key,
        slotStartTs: input.slot.startTs,
        slotEndTs: input.slot.endTs,
        combination,
        probeKind: "late_probe",
        targetSecondsRemaining: input.identity.targetSeconds,
        signalCapturedAt: input.snapshot.capturedAt,
        restStartedAt,
        restCapturedAt: restCapture.capturedAt,
        decision: disposition.decision,
        firstRejectionStage: disposition.firstRejectionStage,
        firstRejectionCode: disposition.firstRejectionCode,
        strategyRevision: input.strategyRevision,
        globalRiskRevision: input.globalRiskRevision,
        signal: buildProbeSignalEvidence(input.snapshot, opportunity.combination),
        rest: buildProbeRestEvidence(intent, restCapture, preflight),
        risk: toJsonRecord({ estimate: opportunity.mismatchRiskEstimate ?? null }),
        variants: captureEndedAfterSlot
          ? []
          : buildEntryProbeVariants(
              intent,
              restCapture.snapshot,
              input.settings,
              opportunity.mismatchRiskEstimate ?? null,
            ),
        recordedAt: Math.max(Date.now(), restCapture.capturedAt),
      });
    }),
  );
}

async function writeLateEntryProbeWithoutRest(input: {
  input: LateEntryProbeCaptureInput;
  probeKey: string;
  combination: PairCombination;
  opportunity: LiveOpportunity | null;
  firstRejectionStage: "signal" | "rest";
  firstRejectionCode: string;
  rest?: Record<string, unknown>;
  recordedAt?: number;
}) {
  const recordedAt = Math.max(input.recordedAt ?? Date.now(), input.input.snapshot.capturedAt);
  await writeEntryExecutionProbe({
    probeKey: input.probeKey,
    asset: input.input.slot.asset,
    slotKey: input.input.slot.key,
    slotStartTs: input.input.slot.startTs,
    slotEndTs: input.input.slot.endTs,
    combination: input.combination,
    probeKind: "late_probe",
    targetSecondsRemaining: input.input.identity.targetSeconds,
    signalCapturedAt: input.input.snapshot.capturedAt,
    restStartedAt: recordedAt,
    restCapturedAt: recordedAt,
    decision: "rejected",
    firstRejectionStage: input.firstRejectionStage,
    firstRejectionCode: input.firstRejectionCode,
    strategyRevision: input.input.strategyRevision,
    globalRiskRevision: input.input.globalRiskRevision,
    signal: buildProbeSignalEvidence(input.input.snapshot, input.combination),
    rest: input.rest ?? {},
    risk: toJsonRecord({ estimate: input.opportunity?.mismatchRiskEstimate ?? null }),
    variants: [],
    recordedAt,
  });
}

function classifyLateEntryProbeDisposition(
  restErrors: string[],
  preflight: RestPairedPreflightDecision,
  estimate: MismatchRiskEstimate | null,
  globalRiskConfig: GlobalRiskConfig,
): {
  decision: "eligible" | "rejected";
  firstRejectionStage: "rest" | "risk" | null;
  firstRejectionCode: string | null;
} {
  if (restErrors.length > 0) {
    return { decision: "rejected", firstRejectionStage: "rest", firstRejectionCode: "rest_orderbook_unavailable" };
  }
  if (!preflight.allowed) {
    return { decision: "rejected", firstRejectionStage: "rest", firstRejectionCode: preflight.code };
  }
  const readinessRejection = getEntryProbeEstimateReadinessRejection(estimate);
  if (readinessRejection) {
    return { decision: "rejected", firstRejectionStage: "risk", firstRejectionCode: readinessRejection };
  }
  const fatalProbabilityUpper95 = estimate?.pFatalUpper95;
  if (fatalProbabilityUpper95 === null || fatalProbabilityUpper95 === undefined) {
    return { decision: "rejected", firstRejectionStage: "risk", firstRejectionCode: "risk_unavailable" };
  }
  const gate = evaluateEconomicMismatchGate({
    pairSize: preflight.quote.commonSize,
    totalCostUsd: preflight.quote.worstFillCostUsd,
    pFatalUpper95: fatalProbabilityUpper95,
    safetyFractionOfBreakEven: getMismatchFatalBudgetFraction(globalRiskConfig),
  });
  if (!gate.eligible) {
    return { decision: "rejected", firstRejectionStage: "risk", firstRejectionCode: gate.reason };
  }
  return { decision: "eligible", firstRejectionStage: null, firstRejectionCode: null };
}

function buildEntryProbeVariants(
  intent: OrderIntent,
  restSnapshot: OpportunitySnapshot,
  settings: StrategyConfig,
  estimate: MismatchRiskEstimate | null,
) {
  return ENTRY_PROBE_VARIANTS.map((variant) => {
    const preflight = deriveRestPairedPreflight({
      intent,
      snapshot: restSnapshot,
      settings: { ...settings, maxLegPrice: variant.maxLegPriceCap },
    });
    if (!preflight.allowed) {
      return toJsonRecord({
        ...variant,
        diagnosticOnly: true,
        verdictSemantics: "counterfactual_probability_economics_only",
        eligible: false,
        rejectionCode: preflight.code,
        preflight: summarizeRestPairedPreflightForProbe(preflight),
        fatalProbabilityUpper95: estimate?.pFatalUpper95 ?? null,
        maximumAllowedFatalProbability: null,
      });
    }
    if (!estimate?.available || !isProbeProbability(estimate.pFatalUpper95)) {
      return toJsonRecord({
        ...variant,
        diagnosticOnly: true,
        verdictSemantics: "counterfactual_probability_economics_only",
        eligible: false,
        rejectionCode: "risk_unavailable",
        preflight: summarizeRestPairedPreflightForProbe(preflight),
        fatalProbabilityUpper95: estimate?.pFatalUpper95 ?? null,
        maximumAllowedFatalProbability: null,
      });
    }
    const gate = evaluateEconomicMismatchGate({
      pairSize: preflight.quote.commonSize,
      totalCostUsd: preflight.quote.worstFillCostUsd,
      pFatalUpper95: estimate.pFatalUpper95,
      safetyFractionOfBreakEven: variant.safetyFraction,
    });
    return toJsonRecord({
      ...variant,
      diagnosticOnly: true,
      verdictSemantics: "counterfactual_probability_economics_only",
      eligible: gate.eligible,
      rejectionCode: gate.eligible ? null : gate.reason,
      preflight: summarizeRestPairedPreflightForProbe(preflight),
      fatalProbabilityUpper95: estimate.pFatalUpper95,
      maximumAllowedFatalProbability: gate.maximumAllowedFatalProbability,
      breakEvenFatalProbability: gate.pBreakEven,
    });
  });
}

function buildProbeSignalEvidence(snapshot: OpportunitySnapshot, combination: PairCombination) {
  const opportunity = snapshot.opportunities.find((candidate) => candidate.combination === combination) ?? null;
  return toJsonRecord({
    capturedAt: snapshot.capturedAt,
    secondsRemaining: Math.max(0, (snapshot.slotEndTs - snapshot.capturedAt) / 1_000),
    eligible: opportunity?.eligible ?? false,
    reasons: opportunity?.reasons ?? ["opportunity_unavailable"],
    grossCost: opportunity?.grossCost ?? null,
    threshold: opportunity?.threshold ?? null,
    projectedNetProfitUsd: opportunity?.projectedNetProfitUsd ?? null,
    legs:
      opportunity?.legs.map((leg) => ({
        venue: leg.venue,
        outcome: leg.outcome,
        marketRef: leg.marketRef,
        tokenId: leg.tokenId,
        price: leg.price,
        size: leg.size,
        targetNotionalUsd: leg.targetNotionalUsd,
      })) ?? [],
  });
}

function buildProbeRestEvidence(
  intent: OrderIntent,
  capture: ShadowRestCapture,
  preflight: RestPairedPreflightDecision,
) {
  const polymarketLeg = intent.legs.find((leg) => leg.venue === "polymarket");
  const kalshiLeg = intent.legs.find((leg) => leg.venue === "kalshi");
  const polymarketAsks =
    polymarketLeg?.outcome === "UP"
      ? capture.snapshot.polymarket.orderbookLevels?.upAsks
      : capture.snapshot.polymarket.orderbookLevels?.downAsks;
  const kalshiLevels =
    kalshiLeg?.outcome === "YES"
      ? deriveKalshiBuyPriceLevels(capture.snapshot.kalshi.orderbookLevels, "YES")
      : deriveKalshiBuyPriceLevels(capture.snapshot.kalshi.orderbookLevels, "NO");
  const polymarketBook = summarizeRawBookLevelsForProbe(polymarketAsks ?? []);
  const kalshiBook = summarizeRawBookLevelsForProbe(kalshiLevels);
  return toJsonRecord({
    capturedAt: capture.capturedAt,
    errors: capture.errors,
    preflight: summarizeRestPairedPreflightForProbe(preflight),
    polymarket: {
      marketRef: polymarketLeg?.marketRef ?? null,
      tokenId: polymarketLeg?.tokenId ?? null,
      outcome: polymarketLeg?.outcome ?? null,
      tickSize:
        polymarketLeg?.outcome === "UP"
          ? capture.snapshot.polymarket.outcomes.up.tickSize
          : capture.snapshot.polymarket.outcomes.down.tickSize,
      asks: polymarketBook.levels,
      askLevelCount: polymarketBook.levelCount,
      retainedAskLevelCount: polymarketBook.retainedLevelCount,
      asksTruncated: polymarketBook.truncated,
      asksSha256: polymarketBook.sha256,
      asksRetainedRanges: polymarketBook.retainedRanges,
    },
    kalshi: {
      marketRef: kalshiLeg?.marketRef ?? null,
      outcome: kalshiLeg?.outcome ?? null,
      priceRanges: capture.snapshot.kalshi.priceRanges,
      asks: kalshiBook.levels,
      askLevelCount: kalshiBook.levelCount,
      retainedAskLevelCount: kalshiBook.retainedLevelCount,
      asksTruncated: kalshiBook.truncated,
      asksSha256: kalshiBook.sha256,
      asksRetainedRanges: kalshiBook.retainedRanges,
    },
  });
}

function toJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isProbeProbability(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

async function admitAndExecuteShadowIntent(
  intent: OrderIntent,
  slot: MarketSlot,
  snapshot: OpportunitySnapshot,
  settings: StrategyConfig,
  expectedConfiguration: ExecutionConfigurationSnapshot,
  primarySelection: LiveOpportunity["primarySelection"],
): Promise<OrderIntent | null> {
  const signalGrossCost = intent.grossCost;
  const [openIntents, positions, balances] = await Promise.all([
    readOpenOrderIntents(),
    readPositions(),
    readVenueBalances(),
  ]);
  const finalSnapshotAt = Date.now();
  const marketState = await marketDataSupervisor.readSlotState(slot, finalSnapshotAt);
  let candidate = markIntentStatus(intent, "pending", finalSnapshotAt);
  const initialPolicy = evaluateFinalInitialEntryPolicy({
    intent: candidate,
    slot,
    settings,
    marketState,
    now: finalSnapshotAt,
    submissionBudgetMs: 0,
  });
  if (!initialPolicy.allowed) {
    await recordInitialEntryRejection({
      intent: candidate,
      stage: "final_ws_policy",
      code: initialPolicy.code,
      reason: initialPolicy.reason,
      now: finalSnapshotAt,
    });
    return null;
  }

  const depthPreflight = await preflightEntryDepthAndAdjustIntent(
    candidate,
    slot,
    settings,
    marketState,
    finalSnapshotAt,
  );
  if (depthPreflight.status === "skipped") {
    await recordInitialEntryRejection({
      intent: candidate,
      stage: "final_depth",
      code: "insufficient_depth",
      reason: depthPreflight.reason,
      now: finalSnapshotAt,
      payload: { depthPreflight },
    });
    return null;
  }
  candidate = markIntentStatus(depthPreflight.intent, "pending", finalSnapshotAt);

  const finalSignalSnapshot: OpportunitySnapshot = {
    ...snapshot,
    capturedAt: finalSnapshotAt,
    polymarket: marketState.polymarket.quote,
    kalshi: marketState.kalshi.quote,
  };
  const restStartedAt = Date.now();
  const preflightProbeIntent = candidate;
  const restCapture = await captureShadowRestSnapshot(preflightProbeIntent, finalSignalSnapshot, restStartedAt);
  const restPreflight = deriveRestPairedPreflight({
    intent: preflightProbeIntent,
    snapshot: restCapture.snapshot,
    settings,
  });
  const restRejection = getShadowRestAdmissionRejection({
    slotEndTs: slot.endTs,
    restCapturedAt: restCapture.capturedAt,
    restErrors: restCapture.errors,
    preflight: restPreflight,
  });
  if (restRejection) {
    await writeCandidateEntryProbe({
      intent: preflightProbeIntent,
      signalSnapshot: finalSignalSnapshot,
      restCapture,
      restPreflight,
      settings,
      expectedConfiguration,
      riskEstimate: findMismatchEstimate(finalSignalSnapshot, candidate.combination),
      decision: "rejected",
      firstRejectionStage: "rest",
      firstRejectionCode: restRejection.code,
      restStartedAt,
    });
    await recordInitialEntryRejection({
      intent: candidate,
      stage: "final_rest_preflight",
      code: restRejection.code,
      reason: restRejection.reason,
      now: restCapture.capturedAt,
      payload: { restPreflight, restErrors: restCapture.errors },
    });
    return null;
  }
  if (!restPreflight.allowed) {
    throw new Error("Shadow REST admission rejection classifier accepted a rejected preflight");
  }
  candidate = markIntentStatus(
    applyRestPairedPreflightToIntent(candidate, restPreflight, restCapture.capturedAt),
    "pending",
    restCapture.capturedAt,
  );

  const riskEvaluatedAt = Date.now();
  const risk = await recheckMismatchRiskForExecution({
    opportunity: buildRiskOpportunityTemplateFromIntent(candidate, settings),
    intent: candidate,
    slot,
    settings,
    openIntents,
    venueExposureUsd: calculateVenueExposureUsd(positions, openIntents),
    now: riskEvaluatedAt,
    globalRiskConfig: expectedConfiguration.globalRisk.config,
    marketState,
    balances,
    usePrecomputedWorstFillEconomics: true,
  });
  if (!risk.allowed) {
    await writeCandidateEntryProbe({
      intent: preflightProbeIntent,
      signalSnapshot: finalSignalSnapshot,
      restCapture,
      restPreflight,
      settings,
      expectedConfiguration,
      riskEstimate: risk.estimate,
      decision: "rejected",
      firstRejectionStage: "risk",
      firstRejectionCode: "mismatch_risk_recheck",
      restStartedAt,
    });
    await recordInitialEntryRejection({
      intent: candidate,
      stage: "final_mismatch_risk",
      code: "mismatch_risk_recheck",
      reason: risk.reason,
      now: riskEvaluatedAt,
      payload: {
        estimate: risk.estimate,
        mismatchRiskAudit: risk.opportunity?.mismatchRiskAudit ?? null,
      },
    });
    return null;
  }
  candidate = markIntentStatus(
    applyFinalEntryRiskOpportunityToIntent(candidate, risk.opportunity, riskEvaluatedAt),
    "pending",
    riskEvaluatedAt,
  );
  const preparedRestExecution = buildPreparedShadowRestExecutionProof(candidate, restPreflight, restCapture.capturedAt);
  candidate = {
    ...candidate,
    shadowExecution: buildScheduledShadowAudit(candidate, restStartedAt, {
      signalGrossCost,
      restCapturedAt: restCapture.capturedAt,
      restErrors: restCapture.errors,
      preparedRestExecution,
    }),
  };

  const policyEvaluatedAt = Date.now();
  candidate = markIntentStatus(candidate, "pending", policyEvaluatedAt);
  const policy = evaluateFinalInitialEntryPolicy({
    intent: candidate,
    slot,
    settings,
    marketState,
    now: policyEvaluatedAt,
    submissionBudgetMs: 0,
  });
  if (!policy.allowed) {
    await writeCandidateEntryProbe({
      intent: preflightProbeIntent,
      signalSnapshot: finalSignalSnapshot,
      restCapture,
      restPreflight,
      settings,
      expectedConfiguration,
      riskEstimate: risk.opportunity.mismatchRiskEstimate ?? null,
      decision: "rejected",
      firstRejectionStage: "admission",
      firstRejectionCode: policy.code,
      restStartedAt,
    });
    await recordInitialEntryRejection({
      intent: candidate,
      stage: "pre_admission_policy",
      code: policy.code,
      reason: policy.reason,
      now: policyEvaluatedAt,
    });
    return null;
  }

  const admission = await admitShadowEntry({
    now: policyEvaluatedAt,
    intent: candidate,
    expectedStrategyRevision: expectedConfiguration.strategyRevision,
    expectedGlobalRiskRevision: expectedConfiguration.globalRisk.revision,
    expectedMismatchCalibrationArtifactId: expectedConfiguration.mismatchCalibration.artifactId,
    expectedMismatchCalibrationRevision: expectedConfiguration.mismatchCalibration.revision,
    policyEvaluatedAt,
    evidence: buildInitialEntryAdmissionEvidence("shadow", marketState, policy, {
      source: "rest-paired-preflight-v1",
      restCapturedAt: restCapture.capturedAt,
      restFetchDurationMs: restCapture.capturedAt - restStartedAt,
      quote: summarizeRestPairedPreflightForProbe(restPreflight, { includeConsumedLevels: true }),
    }),
  });
  if (!admission.admitted) {
    await writeCandidateEntryProbe({
      intent: preflightProbeIntent,
      signalSnapshot: finalSignalSnapshot,
      restCapture,
      restPreflight,
      settings,
      expectedConfiguration,
      riskEstimate: risk.opportunity.mismatchRiskEstimate ?? null,
      decision: "rejected",
      firstRejectionStage: "admission",
      firstRejectionCode: admission.code,
      restStartedAt,
    });
    await recordInitialEntryRejection({
      intent: candidate,
      stage: "atomic_admission",
      code: admission.code,
      reason: admission.reason,
      now: policyEvaluatedAt,
      payload: {
        blockingIntentId: admission.blockingIntentId ?? null,
        activeBreakerKeys: admission.activeBreakerKeys ?? [],
        nextEligibleAt: admission.nextEligibleAt ?? null,
        retryAfterMs: admission.retryAfterMs ?? null,
        previousGrossCost: admission.previousGrossCost ?? null,
        maximumAllowedCost: admission.maximumAllowedCost ?? null,
      },
    });
    return null;
  }
  if (!admission.fresh) {
    return admission.intent;
  }

  try {
    await writeCandidateEntryProbe({
      intent: preflightProbeIntent,
      signalSnapshot: finalSignalSnapshot,
      restCapture,
      restPreflight,
      settings,
      expectedConfiguration,
      riskEstimate: risk.opportunity.mismatchRiskEstimate ?? null,
      decision: "admitted",
      firstRejectionStage: null,
      firstRejectionCode: null,
      restStartedAt,
    });
  } catch (error) {
    console.error(`Candidate entry probe persistence failed after admission: ${toErrorMessage(error)}`);
  }

  await writeAdmittedIntentCreatedEvent(admission.intent, primarySelection, policyEvaluatedAt);
  return executeShadowIntent(admission.intent, restCapture.snapshot, settings, policyEvaluatedAt);
}

function buildInitialEntryAdmissionEvidence(
  mode: "live" | "shadow",
  marketState: InitialEntryMarketState,
  policy: Extract<ReturnType<typeof evaluateFinalInitialEntryPolicy>, { allowed: true }>,
  request: Record<string, unknown> | null,
) {
  return {
    version: "initial-entry-v1",
    mode,
    policy: {
      cutoffAt: policy.cutoffAt,
      latestSubmissionStartAt: policy.latestSubmissionStartAt,
      marketEvidenceValidUntil: policy.marketEvidenceValidUntil,
      polymarketBookUpdatedAt: policy.polymarketBookUpdatedAt,
      kalshiBookUpdatedAt: policy.kalshiBookUpdatedAt,
      pairBookSkewMs: policy.pairBookSkewMs,
    },
    feeds: {
      polymarket: {
        source: marketState.polymarket.quote.source,
        lastMessageAt: marketState.polymarket.quote.lastMessageAt,
        stalenessMs: marketState.polymarket.quote.stalenessMs,
      },
      kalshi: {
        source: marketState.kalshi.quote.source,
        lastMessageAt: marketState.kalshi.quote.lastMessageAt,
        stalenessMs: marketState.kalshi.quote.stalenessMs,
        priceLevelStructure: marketState.kalshi.quote.priceLevelStructure,
        priceRanges: marketState.kalshi.quote.priceRanges,
      },
    },
    polymarketFees: {
      metadataPresent: marketState.polymarket.quote.feeMetadataPresent ?? false,
      enabled: marketState.polymarket.quote.feesEnabled ?? null,
      rate: marketState.polymarket.quote.feeRate ?? null,
      exponent: marketState.polymarket.quote.feeExponent ?? null,
      upEffectiveRateBps: marketState.polymarket.quote.outcomes.up.feeRateBps,
      downEffectiveRateBps: marketState.polymarket.quote.outcomes.down.feeRateBps,
    },
    request,
  };
}

function getAuthoritativeOrderPricingOptions(
  leg: Pick<OrderIntent["legs"][number], "venue" | "outcome">,
  marketState: InitialEntryMarketState,
) {
  if (leg.venue === "kalshi") {
    if ((leg.outcome !== "YES" && leg.outcome !== "NO") || marketState.kalshi.quote.priceRanges === null) {
      throw new Error("Authoritative Kalshi price_ranges are unavailable for order pricing");
    }
    return {
      kalshiPriceRanges: marketState.kalshi.quote.priceRanges,
    };
  }

  const outcome =
    leg.outcome === "UP"
      ? marketState.polymarket.quote.outcomes.up
      : leg.outcome === "DOWN"
        ? marketState.polymarket.quote.outcomes.down
        : null;
  if (!outcome?.tickSize) {
    throw new Error("Authoritative Polymarket tick size is unavailable for order pricing");
  }
  return {
    authoritativeTickSize: outcome.tickSize,
  };
}

function validateRecoveryLegMarketState(input: {
  intent: OrderIntent;
  leg: OrderIntent["legs"][number];
  slot: MarketSlot;
  marketState: InitialEntryMarketState;
  orderSide: "BUY" | "SELL";
  settings: StrategyConfig;
  now: number;
}): RecoveryMarketStateDecision {
  return validateRecoveryMarketState({
    now: input.now,
    slot: input.slot,
    intent: input.intent,
    leg: input.leg,
    orderSide: input.orderSide,
    marketState: input.leg.venue === "polymarket" ? input.marketState.polymarket : input.marketState.kalshi,
    maxFeedAgeMs: input.settings.maxSignalAgeMs,
    maxBookAgeMs:
      input.leg.venue === "polymarket"
        ? Math.min(input.settings.maxSignalAgeMs, input.settings.polymarketHedgeBookMaxAgeMs)
        : input.settings.maxSignalAgeMs,
  });
}

export function buildRecoveryFeeSchedule(
  leg: Pick<OrderIntent["legs"][number], "venue" | "outcome">,
  marketState: InitialEntryMarketState,
): RecoveryFeeSchedule {
  if (leg.venue === "kalshi") {
    const feeMultiplier = marketState.kalshi.quote.feeMultiplier;
    const feeType = marketState.kalshi.quote.feeType;
    if (
      (feeType !== "quadratic" && feeType !== "quadratic_with_maker_fees") ||
      !Number.isFinite(feeMultiplier) ||
      feeMultiplier < 0
    ) {
      throw new Error("Authoritative Kalshi recovery fee schedule is unavailable");
    }
    return {
      venue: "kalshi",
      feeMultiplier,
      maker: false,
    };
  }

  const outcome =
    leg.outcome === "UP"
      ? marketState.polymarket.quote.outcomes.up
      : leg.outcome === "DOWN"
        ? marketState.polymarket.quote.outcomes.down
        : null;
  const feeRateBps = outcome?.feeRateBps ?? marketState.polymarket.quote.feeRateBps;
  const feeMetadataPresent = marketState.polymarket.quote.feeMetadataPresent;
  const feesEnabled = marketState.polymarket.quote.feesEnabled;
  const feeRate = marketState.polymarket.quote.feeRate;
  const feeExponent = marketState.polymarket.quote.feeExponent;
  if (
    feeMetadataPresent !== true ||
    typeof feesEnabled !== "boolean" ||
    !Number.isFinite(feeRateBps) ||
    feeRateBps < 0 ||
    (feesEnabled &&
      (typeof feeRate !== "number" ||
        !Number.isFinite(feeRate) ||
        feeRate <= 0 ||
        typeof feeExponent !== "number" ||
        !Number.isFinite(feeExponent) ||
        feeExponent < 0)) ||
    (!feesEnabled &&
      (feeRateBps !== 0 ||
        (feeRate !== null && feeRate !== undefined && feeRate !== 0) ||
        (feeExponent !== null && feeExponent !== undefined && (!Number.isFinite(feeExponent) || feeExponent < 0))))
  ) {
    throw new Error("Authoritative Polymarket recovery fee schedule is unavailable");
  }
  return {
    venue: "polymarket",
    feeRateBps,
    feeRate: feesEnabled ? (feeRate as number) : null,
    feeExponent: feesEnabled ? (feeExponent as number) : null,
  };
}

function allocateRecoveryEntryFeeUsd(leg: Pick<OrderIntent["legs"][number], "feeUsd" | "filledSize">, size: number) {
  if (
    !Number.isFinite(leg.feeUsd) ||
    leg.feeUsd < 0 ||
    !Number.isFinite(leg.filledSize) ||
    leg.filledSize <= 0 ||
    !Number.isFinite(size) ||
    size <= 0 ||
    size > leg.filledSize + ORDER_SIZE_TOLERANCE
  ) {
    throw new Error("Durable entry fee allocation is unavailable for recovery pricing");
  }
  return (leg.feeUsd * size) / leg.filledSize;
}

async function executeIntent(
  intent: OrderIntent,
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
  expectedConfiguration: ExecutionConfigurationSnapshot,
  primarySelection: LiveOpportunity["primarySelection"],
): Promise<OrderIntent | null> {
  if (!isLiveMismatchRiskEnforced(settings)) {
    await recordInitialEntryRejection({
      intent,
      stage: "mismatch_risk_mode",
      code: "mismatch_risk_not_enforced",
      reason: "Live execution requires the calibrated mismatch-risk policy in enforce mode",
      now: Date.now(),
    });
    return null;
  }
  let primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  let hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
  if (!primaryLeg || !hedgeLeg) {
    throw new Error(`Intent ${intent.id} missing legs`);
  }

  let currentIntent = markIntentStatus(intent, "executing_primary", Date.now());
  const [finalOpenIntents, finalPositions, finalBalances] = await Promise.all([
    readOpenOrderIntents(),
    readPositions(),
    readVenueBalances(),
  ]);
  const finalEntrySnapshotAt = Date.now();
  const finalEntryState = await marketDataSupervisor.readSlotState(slot, finalEntrySnapshotAt);
  const initialPolicy = evaluateFinalInitialEntryPolicy({
    intent: currentIntent,
    slot,
    settings,
    marketState: finalEntryState,
    now: finalEntrySnapshotAt,
    submissionBudgetMs: settings.immediateOrderConfirmationTimeoutMs,
  });
  if (!initialPolicy.allowed) {
    await recordInitialEntryRejection({
      intent: currentIntent,
      stage: "final_ws_policy",
      code: initialPolicy.code,
      reason: initialPolicy.reason,
      now: finalEntrySnapshotAt,
    });
    return null;
  }

  const entryDepthPreflight = await preflightEntryDepthAndAdjustIntent(
    currentIntent,
    slot,
    settings,
    finalEntryState,
    finalEntrySnapshotAt,
  );
  if (entryDepthPreflight.status === "skipped") {
    await recordInitialEntryRejection({
      intent: currentIntent,
      stage: "final_depth",
      code: "insufficient_depth",
      reason: entryDepthPreflight.reason,
      now: Date.now(),
      payload: { entryDepthPreflight },
    });
    return null;
  }
  if (entryDepthPreflight.intent !== currentIntent) {
    currentIntent = entryDepthPreflight.intent;
    primaryLeg = currentIntent.legs.find((leg) => leg.venue === currentIntent.primaryVenue);
    hedgeLeg = currentIntent.legs.find((leg) => leg.venue === currentIntent.hedgeVenue);
    if (!primaryLeg || !hedgeLeg) {
      throw new Error(`Intent ${currentIntent.id} missing legs after entry depth preflight`);
    }
  }
  const finalRiskCheckAt = Date.now();
  const finalRiskCheck = await recheckMismatchRiskForExecution({
    opportunity: buildRiskOpportunityTemplateFromIntent(currentIntent, settings),
    intent: currentIntent,
    slot,
    settings,
    openIntents: finalOpenIntents,
    venueExposureUsd: calculateVenueExposureUsd(
      finalPositions,
      finalOpenIntents.filter((candidate) => candidate.id !== currentIntent.id),
    ),
    now: finalRiskCheckAt,
    globalRiskConfig: expectedConfiguration.globalRisk.config,
    marketState: finalEntryState,
    balances: finalBalances,
  });
  if (!finalRiskCheck.allowed) {
    await recordInitialEntryRejection({
      intent: currentIntent,
      stage: "final_mismatch_risk",
      code: "mismatch_risk_recheck",
      reason: finalRiskCheck.reason,
      now: finalRiskCheckAt,
      payload: {
        estimate: finalRiskCheck.estimate,
        mismatchRiskAudit: finalRiskCheck.opportunity?.mismatchRiskAudit ?? null,
      },
    });
    return null;
  }
  currentIntent = applyFinalEntryRiskOpportunityToIntent(currentIntent, finalRiskCheck.opportunity, finalRiskCheckAt);
  primaryLeg = currentIntent.legs.find((leg) => leg.venue === currentIntent.primaryVenue);
  hedgeLeg = currentIntent.legs.find((leg) => leg.venue === currentIntent.hedgeVenue);
  if (!primaryLeg || !hedgeLeg) {
    throw new Error(`Intent ${currentIntent.id} missing legs after final mismatch risk check`);
  }
  const primaryMaxSlippageBps = entryDepthPreflight.maxSlippageBps;
  const executionPrimaryLeg = primaryLeg;
  const primaryOutcome =
    executionPrimaryLeg.venue === "polymarket"
      ? finalEntryState.polymarket.quote.outcomes[executionPrimaryLeg.outcome === "UP" ? "up" : "down"]
      : finalEntryState.kalshi.quote.outcomes[executionPrimaryLeg.outcome === "YES" ? "yes" : "no"];
  const primaryRequest = buildVenueOrderRequest(
    executionPrimaryLeg,
    primaryMaxSlippageBps,
    primaryImmediateOrderType(executionPrimaryLeg.venue),
    false,
    {
      kalshiPriceTicksSlippage:
        currentIntent.primaryVenue === "kalshi" ? settings.kalshiPrimaryPriceTicksSlippage : undefined,
      kalshiPriceRanges: currentIntent.primaryVenue === "kalshi" ? finalEntryState.kalshi.quote.priceRanges : undefined,
      authoritativeTickSize: currentIntent.primaryVenue === "polymarket" ? primaryOutcome.tickSize : undefined,
    },
  );
  primaryRequest.clientOrderId = buildStableClientOrderId({
    intent: currentIntent,
    leg: executionPrimaryLeg,
    request: primaryRequest,
    stage: "primary",
  });
  const exactPrimaryDepthIssue = validateInitialPrimaryRequestDepth(
    executionPrimaryLeg,
    primaryRequest,
    finalEntryState,
    settings,
  );
  if (exactPrimaryDepthIssue) {
    await recordInitialEntryRejection({
      intent: currentIntent,
      stage: "exact_primary_request_depth",
      code: "insufficient_depth",
      reason: exactPrimaryDepthIssue,
      now: Date.now(),
    });
    return null;
  }

  const admissionAt = Date.now();
  currentIntent = markIntentStatus(currentIntent, "executing_primary", admissionAt);
  const finalPolicy = evaluateFinalInitialEntryPolicy({
    intent: currentIntent,
    slot,
    settings,
    marketState: finalEntryState,
    now: admissionAt,
    submissionBudgetMs: settings.immediateOrderConfirmationTimeoutMs,
  });
  if (!finalPolicy.allowed) {
    await recordInitialEntryRejection({
      intent: currentIntent,
      stage: "pre_admission_policy",
      code: finalPolicy.code,
      reason: finalPolicy.reason,
      now: admissionAt,
    });
    return null;
  }
  if (!isLiveExecutionAllowed()) {
    await recordInitialEntryRejection({
      intent: currentIntent,
      stage: "environment_gate",
      code: "live_execution_disabled",
      reason: "Live execution is not independently authorized by the runtime environment",
      now: admissionAt,
    });
    return null;
  }
  assertNewLiveExecutionAllowed();

  const plannedAttempt = buildPlannedInitialEntryAttempt(
    currentIntent,
    executionPrimaryLeg,
    primaryRequest,
    admissionAt,
  );
  const admission = await admitLiveEntry({
    now: admissionAt,
    intent: currentIntent,
    plannedAttempt,
    expectedStrategyRevision: expectedConfiguration.strategyRevision,
    expectedGlobalRiskRevision: expectedConfiguration.globalRisk.revision,
    expectedMismatchCalibrationArtifactId: expectedConfiguration.mismatchCalibration.artifactId,
    expectedMismatchCalibrationRevision: expectedConfiguration.mismatchCalibration.revision,
    policyEvaluatedAt: admissionAt,
    cutoffAt: finalPolicy.cutoffAt,
    latestSubmissionStartAt: finalPolicy.latestSubmissionStartAt,
    evidence: buildInitialEntryAdmissionEvidence(
      "live",
      finalEntryState,
      finalPolicy,
      serializeVenueOrderRequest(primaryRequest),
    ),
  });
  if (!admission.admitted) {
    await recordInitialEntryRejection({
      intent: currentIntent,
      stage: "atomic_admission",
      code: admission.code,
      reason: admission.reason,
      now: admissionAt,
      payload: {
        blockingIntentId: admission.blockingIntentId ?? null,
        activeBreakerKeys: admission.activeBreakerKeys ?? [],
        previousGrossCost: admission.previousGrossCost ?? null,
        maximumAllowedCost: admission.maximumAllowedCost ?? null,
      },
    });
    return null;
  }
  currentIntent = admission.intent;
  primaryLeg = currentIntent.legs.find((leg) => leg.venue === currentIntent.primaryVenue);
  hedgeLeg = currentIntent.legs.find((leg) => leg.venue === currentIntent.hedgeVenue);
  if (!primaryLeg || !hedgeLeg || !admission.plannedAttempt) {
    throw new Error(`Admitted intent ${currentIntent.id} is missing its canonical primary attempt`);
  }
  if (!admission.fresh) {
    return currentIntent;
  }
  await writeAdmittedIntentCreatedEvent(currentIntent, primarySelection, admissionAt);
  let primaryResult: Awaited<ReturnType<VenueAdapter["placeOrder"]>>;
  let primaryOrder: LiveOrder;
  let primaryExecutionTiming: OrderExecutionTiming | null = null;
  let persistPrimaryConfirmation: (() => Promise<void>) | null = null;
  try {
    assertNewLiveExecutionAllowed();
    const primaryExecution = await submitAndConfirmOrder({
      intent: currentIntent,
      leg: primaryLeg,
      request: primaryRequest,
      stage: "primary",
      now: admissionAt,
      timeoutMs: settings.immediateOrderConfirmationTimeoutMs,
      quoteObservedAt:
        currentIntent.primaryVenue === "polymarket"
          ? finalPolicy.polymarketBookUpdatedAt
          : finalPolicy.kalshiBookUpdatedAt,
      submissionDeadlineAt: finalPolicy.latestSubmissionStartAt,
      deferConfirmedPersistence: true,
      admittedInitialAttemptId: admission.plannedAttempt.id,
    });
    primaryResult = primaryExecution.result;
    primaryOrder = primaryExecution.order;
    primaryExecutionTiming = "timing" in primaryExecution ? primaryExecution.timing : null;
    persistPrimaryConfirmation = "persistConfirmed" in primaryExecution ? primaryExecution.persistConfirmed : null;
  } catch (error) {
    if (isDefinitiveInitialSubmissionClaimRejection(error) || error instanceof OrderSubmissionNotStartedError) {
      const rejectedAt = Date.now();
      const claimCode = error instanceof OrderSubmissionNotStartedError ? error.reason : error.code;
      const reason = `Initial submission authorization was rejected before the venue request started (${claimCode})`;
      if (!(error instanceof OrderSubmissionNotStartedError)) {
        await writeOrderAttempt({
          ...admission.plannedAttempt,
          status: "failed",
          truthStatus: "not_submitted",
          error: reason,
          updatedAt: rejectedAt,
        });
      }
      currentIntent = await closeIntentWithoutExposureAccounting({
        intent: currentIntent,
        status: "skipped",
        now: rejectedAt,
        stage: "initial_submission_claim_rejected",
        reason,
        proof: {
          attemptId: admission.plannedAttempt.id,
          attemptTruth: "not_submitted",
          claimCode,
        },
      });
      await writeRunEvent({
        asset: currentIntent.asset,
        level: "warn",
        eventType: "intent.skipped.initial_submission_claim_rejected",
        message: `Intent ${currentIntent.id} skipped because its initial submission claim was rejected`,
        payload: {
          intentId: currentIntent.id,
          slotKey: currentIntent.slotKey,
          attemptId: admission.plannedAttempt.id,
          clientOrderId: primaryRequest.clientOrderId,
          claimCode,
          claimReason: error.reason,
        },
        createdAt: rejectedAt,
      });
      return currentIntent;
    }

    return markIntentManualRequired(
      currentIntent,
      Date.now(),
      `${currentIntent.primaryVenue}_primary_submission_truth_unknown`,
      `${currentIntent.primaryVenue} primary may have reached the venue before submission truth was persisted (${toErrorMessage(error)})`,
      {
        attemptId: error instanceof OrderSubmissionTruthUnknownError ? error.attemptId : null,
        clientOrderId: primaryRequest.clientOrderId,
        error: toErrorMessage(error),
      },
    );
  }

  if (primaryOrder.filledSize > 0 && shouldTreatPrimaryExecutionAsFilled(currentIntent, primaryResult, primaryOrder)) {
    const primaryFillObservedAt = Date.now();
    currentIntent = markIntentStatus(currentIntent, "primary_filled", primaryFillObservedAt);
    const primaryEvidence = await persistPostSubmissionLegEvidence(
      currentIntent,
      primaryOrder,
      "filled",
      primaryFillObservedAt,
      "primary_fill_persistence",
    );
    currentIntent = primaryEvidence.intent;
    if (!primaryEvidence.durable) {
      await persistPrimaryConfirmation?.();
      persistPrimaryConfirmation = null;
      return currentIntent;
    }
    const primaryWasPartial = primaryOrder.filledSize + ORDER_SIZE_TOLERANCE < primaryOrder.requestedSize;
    let hedgedIntent: OrderIntent;
    try {
      hedgedIntent = await executeHedgeLeg(
        currentIntent,
        slot,
        settings,
        primaryFillObservedAt,
        primaryExecutionTiming,
      );
    } finally {
      await persistPrimaryConfirmation?.();
      persistPrimaryConfirmation = null;
    }
    await writeRunEvent({
      level: "info",
      eventType: "order.primary.submitted",
      message: `Primary ${currentIntent.primaryVenue} order ${primaryOrder.venueOrderId}`,
      payload: {
        intentId: currentIntent.id,
        venue: currentIntent.primaryVenue,
        orderType: primaryRequest.orderType,
        requestedPrice: executionPrimaryLeg.requestedPrice,
        orderPrice: primaryRequest.price,
        requestedSize: primaryRequest.size,
        entryDepthPreflight,
        computedMaxSlippageBps: primaryMaxSlippageBps,
        executionTiming: buildPairExecutionTiming(primaryExecutionTiming, null),
      },
      createdAt: Date.now(),
    });
    if (primaryWasPartial) {
      await writeRunEvent({
        level: "warn",
        eventType: "order.primary.partial_filled",
        message: `Primary ${currentIntent.primaryVenue} order ${primaryOrder.venueOrderId} filled partially; hedging the executed size`,
        payload: {
          intentId: currentIntent.id,
          slotKey: currentIntent.slotKey,
          venue: currentIntent.primaryVenue,
          orderId: primaryOrder.venueOrderId,
          orderStatus: primaryResult.status,
          filledSize: primaryOrder.filledSize,
          requestedSize: primaryOrder.requestedSize,
        },
        createdAt: Date.now(),
      });
    }
    return hedgedIntent;
  }

  await persistPrimaryConfirmation?.();
  persistPrimaryConfirmation = null;

  if (isTerminalOrderStatus(primaryResult.status)) {
    currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "failed", now);
    const terminalNoFillReason = describeTerminalNoFill("Primary", primaryResult);
    currentIntent = await closeIntentWithoutExposureAccounting({
      intent: currentIntent,
      status: "failed",
      now,
      stage: "primary_terminal_no_fill",
      reason: terminalNoFillReason,
      proof: {
        venue: primaryOrder.venue,
        orderId: primaryOrder.venueOrderId,
        orderStatus: primaryOrder.status,
        filledSize: primaryOrder.filledSize,
        venueResultStatus: primaryResult.status,
      },
    });
    if (shouldTripBreakerForTerminalNoFill(primaryResult)) {
      await observeCircuitBreakerIncident(
        createExecutionIncident({
          asset: currentIntent.asset,
          slotKey: currentIntent.slotKey,
          intentId: currentIntent.id,
          stage: "primary_confirmation",
          reason: "venue_error",
          disposition: "cooldown",
          venue: currentIntent.primaryVenue,
          orderId: primaryOrder.venueOrderId,
          triggeredAt: now,
          cooldownUntil: now + PRIMARY_NO_FILL_COOLDOWN_MS,
        }),
      );
    } else {
      const failureKalshiBookWs =
        currentIntent.primaryVenue === "kalshi"
          ? await buildKalshiPrimaryBookTelemetry(
              slot,
              primaryLeg,
              settings,
              now,
              primaryOrder.requestedPrice,
              primaryOrder.requestedSize,
            )
          : null;
      const failureKalshiBookRest =
        currentIntent.primaryVenue === "kalshi"
          ? await buildKalshiPrimaryRestFailureBookTelemetry(
              primaryLeg,
              settings,
              primaryOrder.requestedPrice,
              primaryOrder.requestedSize,
            )
          : null;
      await armPrimarySoftNoFillGuard(currentIntent, primaryOrder, primaryResult, now);
      await writeRunEvent({
        level: "warn",
        eventType: "order.primary.no_fill",
        message: `Intent ${currentIntent.id} closed after primary order was killed without fill`,
        payload: {
          intentId: currentIntent.id,
          slotKey: currentIntent.slotKey,
          venue: currentIntent.primaryVenue,
          orderId: primaryOrder.venueOrderId,
          orderStatus: primaryResult.status,
          orderType: primaryOrder.orderType,
          detail: extractTerminalNoFillDetail(primaryResult),
          softNoFill: Boolean(primaryResult.raw?.softNoFill),
          kalshiBookWsAtFailure: failureKalshiBookWs,
          kalshiBookRestAtFailure: failureKalshiBookRest,
        },
        createdAt: now,
      });
      await recordMarketFillQualityForIntent(currentIntent, "no_fill", "primary_no_fill", now, {
        venue: currentIntent.primaryVenue,
        orderId: primaryOrder.venueOrderId,
        orderStatus: primaryResult.status,
        softNoFill: Boolean(primaryResult.raw?.softNoFill),
      });
    }
    return currentIntent;
  }

  currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "submitted", now);
  currentIntent = await writeOrderIntent(currentIntent);
  await writeRunEvent({
    level: "info",
    eventType: "order.primary.awaiting_confirmation",
    message: `Primary ${currentIntent.primaryVenue} order ${primaryOrder.venueOrderId} awaiting authoritative confirmation`,
    payload: {
      intentId: currentIntent.id,
      venue: currentIntent.primaryVenue,
      orderId: primaryOrder.venueOrderId,
      orderStatus: primaryResult.status,
    },
    createdAt: now,
  });
  return currentIntent;
}

async function acceptBenignOverfilledHedge(
  intent: OrderIntent,
  hedgeOrder: LiveOrder | null,
  settings: Pick<StrategyConfig, "minWorstCaseProfitUsd">,
  now: number,
  stage: string,
  eventType: string,
  message: string,
  payload: Record<string, unknown>,
) {
  const evaluation = evaluateBenignHedgeOverfill(intent, settings);
  if (!evaluation.benign) {
    return null;
  }

  const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
  if (!hedgeLeg) {
    return null;
  }

  const hedgedCandidate = {
    ...intent,
    legs: intent.legs.map((leg) =>
      leg.id === hedgeLeg.id
        ? {
            ...leg,
            status: "hedged",
          }
        : leg,
    ) as OrderIntent["legs"],
  };

  const currentIntent = await markIntentHedgedAfterEconomicCheck(hedgedCandidate, now, stage, hedgeOrder, {
    ...payload,
    benignOverfill: evaluation,
  });
  await writeRunEvent({
    asset: currentIntent.asset,
    level: "warn",
    eventType,
    message,
    payload: {
      intentId: currentIntent.id,
      slotKey: currentIntent.slotKey,
      hedgeOrderId: hedgeOrder?.venueOrderId ?? null,
      primaryVenue: currentIntent.primaryVenue,
      hedgeVenue: currentIntent.hedgeVenue,
      ...payload,
      benignOverfill: evaluation,
    },
    createdAt: now,
  });
  if (currentIntent.status === "hedged") {
    await writeLiveTradeRunEvent(currentIntent, now, "hedged");
  }

  return currentIntent;
}

export function shouldHoldPolymarketHedgeFailurePendingTruth(
  intent: Pick<OrderIntent, "hedgeVenue" | "status" | "updatedAt">,
  hedgeLeg: Pick<OrderIntent["legs"][number], "venue" | "side">,
  result: Pick<LiveOrder, "filledSize" | "raw" | "status" | "venueOrderId"> | null,
  _now = Date.now(),
) {
  if (intent.hedgeVenue !== "polymarket" || hedgeLeg.venue !== "polymarket" || hedgeLeg.side !== "BUY") {
    return false;
  }

  if (!result || result.filledSize > ORDER_SIZE_TOLERANCE) {
    return false;
  }

  const truth = extractPolymarketOrderTruthFromRaw(result.raw);
  if (truth?.terminalZeroFill === true) {
    return false;
  }

  if (hasPolymarketPendingExposureTruth(truth)) {
    return true;
  }

  return true;
}

export function shouldHoldHedgeRescueOrderPendingTruth(
  intent: Pick<OrderIntent, "hedgeVenue" | "status" | "updatedAt">,
  hedgeLeg: Pick<OrderIntent["legs"][number], "venue" | "side">,
  result: Pick<LiveOrder, "filledSize" | "raw" | "status" | "venueOrderId">,
  now = Date.now(),
) {
  return (
    result.filledSize <= ORDER_SIZE_TOLERANCE &&
    (!isTerminalOrderStatus(result.status) ||
      shouldHoldPolymarketHedgeFailurePendingTruth(intent, hedgeLeg, result, now))
  );
}

export function shouldFailClosedOnSubmissionError(_leg: Pick<OrderIntent["legs"][number], "venue">) {
  // A transport failure is not authoritative zero-fill evidence. Kalshi can
  // often recover by client_order_id, but an unavailable or lagging lookup
  // must remain truth_pending just like an untraceable Polymarket request.
  return true;
}

export function isExpiredInitialSubmissionCapability(error: unknown) {
  return error instanceof LiveOrderAttemptClaimError && error.code === "submission_capability_expired";
}

const DEFINITIVE_INITIAL_SUBMISSION_REJECTION_CODES = new Set([
  "strategy_revision_changed",
  "global_risk_revision_changed",
  "mismatch_calibration_revision_changed",
  "trading_disabled",
  "execution_mode_mismatch",
  "circuit_breaker_active",
  "submission_capability_expired",
]);

export function isDefinitiveInitialSubmissionClaimRejection(error: unknown): error is LiveOrderAttemptClaimError {
  return error instanceof LiveOrderAttemptClaimError && DEFINITIVE_INITIAL_SUBMISSION_REJECTION_CODES.has(error.code);
}

export class OrderSubmissionTruthUnknownError extends Error {
  readonly attemptId: string;

  constructor(attemptId: string, message: string) {
    super(message);
    this.name = "OrderSubmissionTruthUnknownError";
    this.attemptId = attemptId;
  }
}

export class OrderSubmissionNotStartedError extends Error {
  constructor(
    public readonly attemptId: string,
    public readonly reason: "submission_deadline_expired",
  ) {
    super(`Order submission ${attemptId} was not started (${reason})`);
    this.name = "OrderSubmissionNotStartedError";
  }
}

export function isOrderAttemptTruthUnresolved(attempt: Pick<OrderAttempt, "status" | "truthStatus">) {
  if (attempt.status === "planned" && attempt.truthStatus === "admitted_not_claimed") {
    return false;
  }

  if (attempt.status === "confirmed") {
    return !isConclusiveOrderAttemptTruthStatus(attempt.truthStatus);
  }

  return (
    attempt.status === "planned" ||
    attempt.status === "submitting" ||
    attempt.status === "submitted" ||
    attempt.status === "truth_pending" ||
    (attempt.status === "failed" && attempt.truthStatus !== "not_submitted")
  );
}

const CONCLUSIVE_ORDER_ATTEMPT_TRUTH_STATUSES = new Set([
  "pending",
  "live",
  "filled",
  "partially_filled",
  "canceled",
  "expired",
  "rejected",
  "terminal_zero_fill",
]);

export function isConclusiveOrderAttemptTruthStatus(truthStatus: string | null) {
  return truthStatus !== null && CONCLUSIVE_ORDER_ATTEMPT_TRUTH_STATUSES.has(truthStatus.trim().toLowerCase());
}

export function hasUnresolvedPrimarySubmissionAttempt(
  attempts: Array<Pick<OrderAttempt, "legId" | "stage" | "status" | "truthStatus">>,
  primaryLegId: string,
) {
  return attempts.some(
    (attempt) =>
      attempt.legId === primaryLegId &&
      isPrimaryEntryAttemptStage(attempt.stage) &&
      isOrderAttemptTruthUnresolved(attempt),
  );
}

function isPrimaryEntryAttemptStage(stage: string) {
  return stage === "primary" || stage.startsWith("primary_legacy_multi_clip:") || stage.startsWith("primary_retry:");
}

export function hasUnresolvedHedgeSubmissionAttempt(
  attempts: Array<Pick<OrderAttempt, "legId" | "stage" | "status" | "truthStatus">>,
  hedgeLegId: string,
) {
  return attempts.some(
    (attempt) =>
      attempt.legId === hedgeLegId && isHedgeEntryAttemptStage(attempt.stage) && isOrderAttemptTruthUnresolved(attempt),
  );
}

function isHedgeEntryAttemptStage(stage: string) {
  return (
    stage === "hedge" ||
    stage.startsWith("incremental_hedge:") ||
    stage.startsWith("hedge_retry:") ||
    stage.startsWith("hedge_rescue:")
  );
}

function hasPolymarketPendingExposureTruth(
  truth:
    | {
        effectiveFilledSize?: number;
        confirmedFilledSize?: number;
        pendingFilledSize?: number;
        hasPendingExposure?: boolean;
      }
    | null
    | undefined,
) {
  return Boolean(
    truth?.hasPendingExposure ||
    (truth?.effectiveFilledSize ?? 0) > ORDER_SIZE_TOLERANCE ||
    (truth?.confirmedFilledSize ?? 0) > ORDER_SIZE_TOLERANCE ||
    (truth?.pendingFilledSize ?? 0) > ORDER_SIZE_TOLERANCE,
  );
}

async function holdPolymarketHedgeFailurePendingTruth(
  intent: OrderIntent,
  hedgeLeg: OrderIntent["legs"][number],
  hedgeOrder: LiveOrder | null,
  now: number,
  stage: string,
  payload: Record<string, unknown>,
) {
  const pendingTruthReason = "Polymarket hedge no-fill awaiting authoritative zero-fill truth; primary unwind blocked";
  const alreadyPendingSameOrder =
    intent.status === "truth_pending" &&
    intent.failureReason === pendingTruthReason &&
    (hedgeOrder === null || hedgeLeg.venueOrderId === hedgeOrder.venueOrderId);
  const incident = createExecutionIncident({
    asset: intent.asset,
    slotKey: intent.slotKey,
    intentId: intent.id,
    stage: "polymarket_hedge_no_fill_truth_pending",
    reason: "hedge_failure",
    disposition: "truth_pending",
    venue: intent.hedgeVenue,
    orderId: hedgeOrder?.venueOrderId ?? null,
    triggeredAt: now,
  });
  const existingPendingTruthIncident = (await readCurrentCircuitBreakerIncidents()).some(
    (candidate) =>
      candidate.owner === incident.owner &&
      candidate.incidentKey === incident.incidentKey &&
      candidate.scope.type === "global",
  );

  let currentIntent = intent;
  if (!alreadyPendingSameOrder) {
    currentIntent = hedgeOrder ? updateIntentLeg(intent, hedgeLeg.venue, hedgeOrder, "submitted", now) : intent;
    currentIntent = markIntentStatus(currentIntent, "truth_pending", now, pendingTruthReason);
    currentIntent = await writeOrderIntent(currentIntent);
  }

  if (!alreadyPendingSameOrder || !existingPendingTruthIncident) {
    await writeHedgeRetryBlockedPendingTruthEvent(currentIntent, hedgeLeg, hedgeOrder, now, {
      stage,
      ...payload,
    });
    await writeIntentIncidentRunEvent(currentIntent, now, "truth_pending", pendingTruthReason, {
      hedgeOrderId: hedgeOrder?.venueOrderId ?? null,
      ...payload,
    });
  }

  if (!existingPendingTruthIncident) {
    await observeCircuitBreakerIncident(incident);
  }
  return currentIntent;
}

async function executeHedgeLeg(
  intent: OrderIntent,
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
  primaryExecutionTiming: OrderExecutionTiming | null = null,
) {
  const resizedIntent = resizeHedgeLegToFilledPrimary(intent, now);
  const primaryLeg = resizedIntent.legs.find((leg) => leg.venue === resizedIntent.primaryVenue);
  const hedgeLeg = resizedIntent.legs.find((leg) => leg.venue === resizedIntent.hedgeVenue);
  if (!primaryLeg || !hedgeLeg) {
    throw new Error(`Intent ${intent.id} missing legs for hedge execution`);
  }

  const hedgeMinimumSize = getVenueMinimumOrderSize(hedgeLeg.venue, null, settings.minOrderSize);
  if (hedgeLeg.requestedSize + ORDER_SIZE_TOLERANCE < hedgeMinimumSize) {
    await writeRunEvent({
      level: "warn",
      eventType: "order.hedge.below_minimum",
      message: `Hedge size ${hedgeLeg.requestedSize} below ${hedgeLeg.venue} minimum ${hedgeMinimumSize}; flattening primary instead`,
      payload: {
        intentId: resizedIntent.id,
        hedgeVenue: hedgeLeg.venue,
        hedgeRequestedSize: hedgeLeg.requestedSize,
        hedgeMinimumSize,
        primaryVenue: primaryLeg.venue,
        primaryFilledSize: primaryLeg.filledSize,
      },
      createdAt: now,
    });
    return attemptPrimaryUnwindAfterHedgeFailure(
      resizedIntent,
      primaryLeg,
      hedgeLeg,
      null,
      settings,
      now,
      `Hedge size ${hedgeLeg.requestedSize} below ${hedgeLeg.venue} minimum ${hedgeMinimumSize}; flattening primary`,
    );
  }

  const polymarketSubmissionBlock = getPolymarketHedgeSubmissionBlock(hedgeLeg);
  if (polymarketSubmissionBlock) {
    return markIntentManualRequired(
      resizedIntent,
      now,
      polymarketSubmissionBlock.stage,
      `Resized Polymarket hedge notional ${polymarketSubmissionBlock.requestedNotionalUsd.toFixed(4)} USD is below the ${polymarketSubmissionBlock.minimumNotionalUsd.toFixed(2)} USD venue minimum`,
      {
        hedgeVenue: hedgeLeg.venue,
        hedgeRequestedSize: hedgeLeg.requestedSize,
        primaryVenue: primaryLeg.venue,
        primaryFilledSize: primaryLeg.filledSize,
        ...polymarketSubmissionBlock,
      },
    );
  }

  let currentIntent = markIntentStatus(resizedIntent, "hedging", now);

  const hedgePricing = await resolveAdaptiveSlippageForLiveLeg(hedgeLeg, slot, settings, now);
  const hedgeMarketProof = validateRecoveryLegMarketState({
    intent: resizedIntent,
    leg: hedgeLeg,
    slot,
    marketState: hedgePricing.marketState,
    orderSide: "BUY",
    settings,
    now,
  });
  if (!hedgeMarketProof.allowed) {
    await writeRunEvent({
      asset: resizedIntent.asset,
      level: "error",
      eventType: "order.hedge.market_proof_rejected",
      message: `Hedge market proof rejected for intent ${resizedIntent.id}`,
      payload: {
        intentId: resizedIntent.id,
        slotKey: resizedIntent.slotKey,
        venue: hedgeLeg.venue,
        code: hedgeMarketProof.code,
        reason: hedgeMarketProof.reason,
      },
      createdAt: now,
    });
    return attemptPrimaryUnwindAfterHedgeFailure(
      resizedIntent,
      primaryLeg,
      hedgeLeg,
      null,
      settings,
      now,
      `Hedge market proof rejected before submission (${hedgeMarketProof.code}: ${hedgeMarketProof.reason})`,
    );
  }
  const hedgeMaxSlippageBps = hedgePricing.maxSlippageBps;
  const hedgeRequest = buildVenueOrderRequest(
    hedgeLeg,
    hedgeMaxSlippageBps,
    immediatePartialOrderType(hedgeLeg.venue),
    false,
    getAuthoritativeOrderPricingOptions(hedgeLeg, hedgePricing.marketState),
  );
  let hedgeResult: Awaited<ReturnType<VenueAdapter["placeOrder"]>>;
  let hedgeOrder: LiveOrder;
  let hedgeExecutionTiming: OrderExecutionTiming | null = null;
  try {
    const hedgeExecution = await submitAndConfirmOrder({
      intent: currentIntent,
      leg: hedgeLeg,
      request: hedgeRequest,
      stage: "hedge",
      now,
      timeoutMs: settings.immediateOrderConfirmationTimeoutMs,
      quoteObservedAt: hedgeMarketProof.bookObservedAt,
      submissionDeadlineAt: hedgeMarketProof.validUntil,
    });
    hedgeResult = hedgeExecution.result;
    hedgeOrder = hedgeExecution.order;
    hedgeExecutionTiming = "timing" in hedgeExecution ? hedgeExecution.timing : null;
  } catch (error) {
    if (error instanceof OrderSubmissionNotStartedError) {
      await writeRunEvent({
        asset: currentIntent.asset,
        level: "warn",
        eventType: "order.hedge.submission_not_started",
        message: `Hedge submission was rejected before the venue request for intent ${currentIntent.id}`,
        payload: {
          intentId: currentIntent.id,
          slotKey: currentIntent.slotKey,
          attemptId: error.attemptId,
          reason: error.reason,
          clientOrderId: hedgeRequest.clientOrderId,
        },
        createdAt: Date.now(),
      });
      return attemptPrimaryUnwindAfterHedgeFailure(
        currentIntent,
        primaryLeg,
        hedgeLeg,
        null,
        settings,
        Date.now(),
        `Hedge submission was not started (${error.reason})`,
      );
    }
    return markIntentManualRequired(
      currentIntent,
      Date.now(),
      `${currentIntent.hedgeVenue}_hedge_submission_truth_unknown`,
      `${currentIntent.hedgeVenue} hedge may have reached the venue before submission truth was persisted (${toErrorMessage(error)})`,
      {
        attemptId: error instanceof OrderSubmissionTruthUnknownError ? error.attemptId : null,
        clientOrderId: hedgeRequest.clientOrderId,
        error: toErrorMessage(error),
      },
    );
  }
  await writeRunEvent({
    level: "info",
    eventType: "order.hedge.submitted",
    message: `Hedge ${currentIntent.hedgeVenue} order ${hedgeOrder.venueOrderId}`,
    payload: {
      intentId: currentIntent.id,
      venue: currentIntent.hedgeVenue,
      computedMaxSlippageBps: hedgeMaxSlippageBps,
    },
    createdAt: now,
  });

  if (shouldTreatHedgeOrderAsComplete(hedgeLeg, hedgeOrder)) {
    currentIntent = await finalizeCompletedHedgeAfterSubmission(
      currentIntent,
      hedgeOrder,
      now,
      "hedge_filled",
      "hedge_full_fill_persistence",
      {
        executionTiming: buildPairExecutionTiming(primaryExecutionTiming, hedgeExecutionTiming),
      },
    );
    if (currentIntent.status === "hedged") {
      await writeLiveTradeRunEvent(currentIntent, now, "hedged");
    }
    return currentIntent;
  }

  if (hedgeOrder.filledSize > 0) {
    const evidence = await persistPostSubmissionLegEvidence(
      currentIntent,
      hedgeOrder,
      "submitted",
      now,
      "hedge_partial_fill_persistence",
    );
    currentIntent = evidence.intent;
    if (!evidence.durable) {
      return currentIntent;
    }
    await writeRunEvent({
      level: "warn",
      eventType: "order.hedge.partial_fill_rescue",
      message: `Hedge ${currentIntent.hedgeVenue} partially filled for intent ${currentIntent.id}; entering recovery`,
      payload: {
        intentId: currentIntent.id,
        venue: currentIntent.hedgeVenue,
        orderId: hedgeOrder.venueOrderId,
        requestedSize: hedgeOrder.requestedSize,
        filledSize: hedgeOrder.filledSize,
        orderStatus: hedgeResult.status,
      },
      createdAt: now,
    });
    return continuePartialHedgeRecoveryAfterSubmission(
      currentIntent,
      hedgeOrder,
      settings,
      now,
      `Hedge order partially filled or not final (${hedgeResult.status})`,
      hedgeResult,
      "hedge_partial_fill_recovery",
    );
  }

  if (isTerminalOrderStatus(hedgeResult.status)) {
    if (!shouldRetryTerminalZeroFillHedge(currentIntent, hedgeLeg, hedgeResult)) {
      return holdPolymarketHedgeFailurePendingTruth(
        currentIntent,
        hedgeLeg,
        hedgeOrder,
        now,
        "hedge_no_fill_truth_pending",
        {
          orderStatus: hedgeResult.status,
        },
      );
    }

    const retried = await retryLegWithinExecutionBufferWithAttempts(
      currentIntent,
      hedgeLeg,
      slot,
      settings,
      now,
      settings.hedgeRetryAttempts,
      settings.hedgeRetryDelayMs,
    );
    if (retried) {
      currentIntent = retried.intent;
      hedgeResult = retried.result;
      hedgeOrder = retried.order;

      if (shouldTreatHedgeOrderAsComplete(hedgeLeg, hedgeOrder)) {
        currentIntent = await finalizeCompletedHedgeAfterSubmission(
          currentIntent,
          hedgeOrder,
          now,
          "hedge_retry_filled",
          "hedge_retry_full_fill_persistence",
        );
        if (currentIntent.status === "hedged") {
          await writeLiveTradeRunEvent(currentIntent, now, "hedged");
        }
        return currentIntent;
      }

      if (hedgeOrder.filledSize > 0) {
        const evidence = await persistPostSubmissionLegEvidence(
          currentIntent,
          hedgeOrder,
          "submitted",
          now,
          "hedge_retry_partial_fill_persistence",
        );
        currentIntent = evidence.intent;
        if (!evidence.durable) {
          return currentIntent;
        }
        await writeRunEvent({
          level: "warn",
          eventType: "order.hedge_retry.partial_fill_rescue",
          message: `Hedge retry ${currentIntent.hedgeVenue} partially filled for intent ${currentIntent.id}; entering recovery`,
          payload: {
            intentId: currentIntent.id,
            venue: currentIntent.hedgeVenue,
            orderId: hedgeOrder.venueOrderId,
            requestedSize: hedgeOrder.requestedSize,
            filledSize: hedgeOrder.filledSize,
            orderStatus: hedgeResult.status,
          },
          createdAt: now,
        });
        return continuePartialHedgeRecoveryAfterSubmission(
          currentIntent,
          hedgeOrder,
          settings,
          now,
          `Hedge retry partially filled or not final (${hedgeResult.status})`,
          hedgeResult,
          "hedge_retry_partial_fill_recovery",
        );
      }
    }
  }

  if (!isTerminalOrderStatus(hedgeResult.status)) {
    currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "submitted", now);
    currentIntent = await writeOrderIntent(currentIntent);
    await writeRunEvent({
      level: "info",
      eventType: "order.hedge.awaiting_confirmation",
      message: `Hedge ${currentIntent.hedgeVenue} order ${hedgeOrder.venueOrderId} awaiting authoritative confirmation`,
      payload: {
        intentId: currentIntent.id,
        venue: currentIntent.hedgeVenue,
        orderId: hedgeOrder.venueOrderId,
        orderStatus: hedgeResult.status,
      },
      createdAt: now,
    });
    return currentIntent;
  }

  const hedgeFailureReason = describeTerminalNoFill("Hedge", hedgeResult);
  await writeRunEvent({
    level: shouldTripBreakerForTerminalNoFill(hedgeResult) ? "error" : "warn",
    eventType: "order.hedge.no_fill",
    message: `Hedge ${currentIntent.hedgeVenue} order ended without fill for intent ${currentIntent.id}`,
    payload: {
      intentId: currentIntent.id,
      venue: currentIntent.hedgeVenue,
      orderId: hedgeOrder.venueOrderId,
      orderStatus: hedgeResult.status,
      detail: extractTerminalNoFillDetail(hedgeResult),
      softNoFill: Boolean(hedgeResult.raw?.softNoFill),
    },
    createdAt: now,
  });

  if (shouldHoldPolymarketHedgeFailurePendingTruth(currentIntent, hedgeLeg, hedgeOrder, now)) {
    return holdPolymarketHedgeFailurePendingTruth(
      currentIntent,
      hedgeLeg,
      hedgeOrder,
      now,
      "hedge_no_fill_truth_pending",
      {
        venue: currentIntent.hedgeVenue,
        orderId: hedgeOrder.venueOrderId,
        orderStatus: hedgeResult.status,
        detail: extractTerminalNoFillDetail(hedgeResult),
        softNoFill: Boolean(hedgeResult.raw?.softNoFill),
      },
    );
  }

  return attemptPrimaryUnwindAfterHedgeFailure(
    currentIntent,
    primaryLeg,
    hedgeLeg,
    hedgeOrder,
    settings,
    now,
    hedgeFailureReason,
    hedgeResult,
  );
}

async function finalizeCompletedHedgeAfterSubmission(
  intent: OrderIntent,
  hedgeOrder: LiveOrder,
  now: number,
  economicStage: string,
  incidentStage: string,
  extraPayload: Record<string, unknown> = {},
) {
  const evidence = await persistPostSubmissionLegEvidence(intent, hedgeOrder, "hedged", now, incidentStage);
  let currentIntent = evidence.intent;
  if (!evidence.durable) {
    return currentIntent;
  }

  try {
    if (currentIntent.hedgeVenue === "polymarket") {
      currentIntent = await attachRecentPolymarketFillsSafely(currentIntent, "hedge", now);
    }
    return await markIntentHedgedAfterEconomicCheck(currentIntent, now, economicStage, hedgeOrder, extraPayload);
  } catch (error) {
    if (!(error instanceof OrderIntentRevisionConflictError)) {
      throw error;
    }
    await recordPostSubmissionIntentPersistenceIncident({
      intent: currentIntent,
      order: hedgeOrder,
      stage: `${incidentStage}_finalize`,
      error,
    });
    return (await findOrderIntent(currentIntent.id).catch(() => null)) ?? currentIntent;
  }
}

async function continuePartialHedgeRecoveryAfterSubmission(
  intent: OrderIntent,
  hedgeOrder: LiveOrder,
  settings: StrategyConfig,
  now: number,
  failureReason: string,
  hedgeResult: Awaited<ReturnType<VenueAdapter["placeOrder"]>>,
  stage: string,
) {
  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
  if (!primaryLeg || !hedgeLeg) {
    const error = new Error(`Intent ${intent.id} missing canonical legs after hedge submission`);
    await recordPostSubmissionIntentPersistenceIncident({ intent, order: hedgeOrder, stage, error });
    return intent;
  }

  try {
    return await attemptPrimaryUnwindAfterHedgeFailure(
      intent,
      primaryLeg,
      hedgeLeg,
      hedgeOrder,
      settings,
      now,
      failureReason,
      hedgeResult,
    );
  } catch (error) {
    if (!(error instanceof OrderIntentRevisionConflictError)) {
      throw error;
    }
    await recordPostSubmissionIntentPersistenceIncident({ intent, order: hedgeOrder, stage, error });
    return (await findOrderIntent(intent.id).catch(() => null)) ?? intent;
  }
}

type ShadowRestCapture = Awaited<ReturnType<typeof captureShadowRestSnapshot>>;

async function executeShadowIntent(
  intent: OrderIntent,
  snapshot: OpportunitySnapshot,
  settings: StrategyConfig,
  now: number,
) {
  const restStartedAt = intent.shadowExecution?.restStartedAt ?? now;
  const scheduledAudit = intent.shadowExecution ?? buildScheduledShadowAudit(intent, restStartedAt);
  let currentIntent = markIntentStatus(
    {
      ...intent,
      shadowExecution: scheduledAudit,
    },
    "executing_primary",
    now,
  );

  const primaryLeg = currentIntent.legs.find((leg) => leg.venue === currentIntent.primaryVenue);
  const hedgeLeg = currentIntent.legs.find((leg) => leg.venue === currentIntent.hedgeVenue);
  if (!primaryLeg || !hedgeLeg) {
    throw new Error(`Intent ${intent.id} missing legs for shadow execution`);
  }

  const primaryOrder = buildPendingShadowOrder(currentIntent, primaryLeg, now, "primary");
  const hedgeOrder = buildPendingShadowOrder(currentIntent, hedgeLeg, now, "hedge");
  await writeVenueOrder(primaryOrder);
  await writeVenueOrder(hedgeOrder);
  currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "submitted", now);
  currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "submitted", now);
  currentIntent = await writeOrderIntent(currentIntent);
  await writeRunEvent({
    asset: currentIntent.asset,
    level: "info",
    eventType: "intent.shadow.scheduled",
    message: `Shadow intent ${currentIntent.id} started immediate REST orderbook execution`,
    payload: {
      intentId: currentIntent.id,
      slotKey: currentIntent.slotKey,
      primaryVenue: currentIntent.primaryVenue,
      modelVersion: currentIntent.shadowExecution?.modelVersion ?? SHADOW_EXECUTION_MODEL_VERSION,
      restStartedAt,
      requestedPairSize: currentIntent.shadowExecution?.requestedPairSize ?? null,
    },
    createdAt: now,
  });

  return completeShadowIntent(currentIntent, snapshot, settings, restStartedAt);
}

async function resumeShadowIntents(intents: OrderIntent[], snapshot: OpportunitySnapshot, settings: StrategyConfig) {
  const resumed: OrderIntent[] = [];
  for (const intent of intents) {
    if (!intent.shadow) {
      continue;
    }

    // Every persisted pending shadow intent was atomically admitted. Resume v3
    // from its proof and retire legacy proof-less crash remnants fail closed.
    if (intent.status === "pending") {
      resumed.push(await executeShadowIntent(intent, snapshot, settings, Date.now()));
      continue;
    }
    if (intent.status !== "executing_primary") {
      continue;
    }

    const existingAudit = intent.shadowExecution;
    const restStartedAt = existingAudit?.restStartedAt ?? Date.now();
    let currentIntent = intent;
    if (!existingAudit) {
      currentIntent = await writeOrderIntent({
        ...intent,
        shadowExecution: buildScheduledShadowAudit(intent, restStartedAt),
      });
    }
    resumed.push(await completeShadowIntent(currentIntent, snapshot, settings, restStartedAt));
  }

  return resumed;
}

async function completeShadowIntent(
  intent: OrderIntent,
  signalSnapshot: OpportunitySnapshot,
  settings: StrategyConfig,
  restStartedAt: number,
) {
  if (intent.shadowExecution?.status === "filled" || intent.shadowExecution?.status === "no_fill") {
    return persistCompletedShadowExecution(intent, intent.shadowExecution);
  }

  const scheduledAudit = intent.shadowExecution ?? buildScheduledShadowAudit(intent, restStartedAt);
  const recoveryPlan = planShadowRestRecovery(scheduledAudit);
  if (recoveryPlan.action === "prepared_proof") {
    const preparedProof = scheduledAudit.preparedRestExecution;
    const evaluatedAt = Date.now();
    let completedAudit: NonNullable<OrderIntent["shadowExecution"]>;
    try {
      completedAudit = buildCompletedShadowAuditFromPreparedRestExecution(intent, preparedProof, evaluatedAt);
    } catch (error) {
      const reason = `Durable REST execution proof is invalid: ${toErrorMessage(error)}`;
      completedAudit = buildCompletedShadowAudit(
        intent,
        buildUnavailableShadowRecoveryDecision(intent, "prepared_rest_proof_invalid", reason),
        evaluatedAt,
        {
          startedAt: scheduledAudit.restStartedAt,
          capturedAt: scheduledAudit.restCapturedAt ?? evaluatedAt,
          errors: [...scheduledAudit.restErrors, reason],
        },
      );
    }
    await writeRunEvent({
      asset: intent.asset,
      level: completedAudit.status === "filled" ? "info" : "warn",
      eventType: "intent.shadow.rest_proof_replayed",
      message:
        completedAudit.status === "filled"
          ? `Shadow intent ${intent.id} replayed its durable REST execution proof`
          : `Shadow intent ${intent.id} rejected an invalid durable REST execution proof`,
      payload: {
        intentId: intent.id,
        slotKey: intent.slotKey,
        modelVersion: completedAudit.modelVersion,
        restFetchDurationMs: completedAudit.restFetchDurationMs,
        preparedDecision: completedAudit.status,
        restErrors: completedAudit.restErrors,
      },
      createdAt: evaluatedAt,
    });
    const currentIntent = await writeOrderIntent({ ...intent, shadowExecution: completedAudit });
    return persistCompletedShadowExecution(currentIntent, completedAudit);
  }

  if (recoveryPlan.action === "fail_closed") {
    const evaluatedAt = Date.now();
    const completedAudit = buildCompletedShadowAudit(
      intent,
      buildUnavailableShadowRecoveryDecision(intent, recoveryPlan.reasonCode, recoveryPlan.reason),
      evaluatedAt,
      {
        startedAt: scheduledAudit.restStartedAt,
        capturedAt: scheduledAudit.restCapturedAt ?? evaluatedAt,
        errors: [...scheduledAudit.restErrors, recoveryPlan.reason],
      },
    );
    await writeRunEvent({
      asset: intent.asset,
      level: "warn",
      eventType: "intent.shadow.recovery_blocked",
      message: `Shadow intent ${intent.id} cannot recover its execution evidence`,
      payload: {
        intentId: intent.id,
        slotKey: intent.slotKey,
        modelVersion: scheduledAudit.modelVersion,
        reasonCode: recoveryPlan.reasonCode,
        reason: recoveryPlan.reason,
      },
      createdAt: evaluatedAt,
    });
    const currentIntent = await writeOrderIntent({ ...intent, shadowExecution: completedAudit });
    return persistCompletedShadowExecution(currentIntent, completedAudit);
  }

  const legacySnapshotMatchesIntent =
    signalSnapshot.asset === intent.asset &&
    signalSnapshot.slotKey === intent.slotKey &&
    signalSnapshot.slotStartTs === intent.slotStartTs &&
    signalSnapshot.slotEndTs === intent.slotEndTs &&
    Date.now() < intent.slotEndTs;
  if (!legacySnapshotMatchesIntent) {
    const evaluatedAt = Date.now();
    const reason = "Legacy REST recovery requires a current snapshot for the intent's exact active slot";
    const completedAudit = buildCompletedShadowAudit(
      intent,
      buildUnavailableShadowRecoveryDecision(intent, "legacy_rest_refetch_unavailable", reason),
      evaluatedAt,
      {
        startedAt: scheduledAudit.restStartedAt,
        capturedAt: evaluatedAt,
        errors: [...scheduledAudit.restErrors, reason],
      },
    );
    const currentIntent = await writeOrderIntent({ ...intent, shadowExecution: completedAudit });
    return persistCompletedShadowExecution(currentIntent, completedAudit);
  }

  const restCapture = await captureShadowRestSnapshot(intent, signalSnapshot, restStartedAt);
  const rawDecision = deriveShadowPairExecution({
    intent,
    snapshot: restCapture.snapshot,
    settings,
  });
  const decision: ShadowPairExecutionDecision =
    restCapture.errors.length === 0
      ? rawDecision
      : {
          ...rawDecision,
          status: "no_fill",
          reasonCode: "rest_orderbook_unavailable",
          reason: restCapture.errors.join("; "),
          filledPairSize: 0,
          realizedGrossCost: null,
          realizedTotalCostUsd: null,
          projectedNetProfitUsd: null,
        };
  let capturedIntent: OrderIntent = {
    ...intent,
    shadowExecution: {
      ...scheduledAudit,
      restStartedAt,
      restCapturedAt: restCapture.capturedAt,
      restFetchDurationMs: Math.max(0, restCapture.capturedAt - restStartedAt),
      restErrors: restCapture.errors,
    },
  };
  capturedIntent = await writeOrderIntent(capturedIntent);
  await writeRunEvent({
    asset: intent.asset,
    level: "info",
    eventType: "intent.shadow.rest_captured",
    message: `Shadow intent ${intent.id} captured execution books through REST`,
    payload: {
      intentId: intent.id,
      slotKey: intent.slotKey,
      modelVersion: scheduledAudit.modelVersion,
      restFetchDurationMs: capturedIntent.shadowExecution?.restFetchDurationMs ?? null,
      completionNotBeforeAt: capturedIntent.shadowExecution?.completionNotBeforeAt ?? null,
      preparedDecision: decision.status,
      restErrors: restCapture.errors,
    },
    createdAt: restCapture.capturedAt,
  });
  if (decision.status === "filled") {
    const remainingCompletionDelayMs = Math.max(0, scheduledAudit.completionNotBeforeAt - Date.now());
    if (remainingCompletionDelayMs > 0) {
      await sleep(remainingCompletionDelayMs);
    }
  }
  const evaluatedAt = Date.now();
  const completedAudit = buildCompletedShadowAudit(capturedIntent, decision, evaluatedAt, {
    startedAt: restStartedAt,
    capturedAt: restCapture.capturedAt,
    errors: restCapture.errors,
  });
  const currentIntent = await writeOrderIntent({ ...capturedIntent, shadowExecution: completedAudit });
  return persistCompletedShadowExecution(currentIntent, completedAudit);
}

function buildUnavailableShadowRecoveryDecision(
  intent: OrderIntent,
  reasonCode:
    | "legacy_rest_refetch_unavailable"
    | "prepared_rest_proof_invalid"
    | "prepared_rest_proof_unavailable"
    | "unsupported_shadow_model_version",
  reason: string,
): ShadowPairExecutionDecision {
  return {
    status: "no_fill",
    reasonCode,
    reason,
    filledPairSize: 0,
    realizedGrossCost: null,
    realizedTotalCostUsd: null,
    projectedNetProfitUsd: null,
    legs: intent.legs.map((leg) => ({
      leg,
      limitPrice: leg.requestedPrice,
      executableSize: 0,
      quote: null,
      levelsAvailable: false,
    })) as ShadowPairExecutionDecision["legs"],
  };
}

async function persistCompletedShadowExecution(
  intent: OrderIntent,
  completedAudit: NonNullable<OrderIntent["shadowExecution"]>,
) {
  const evaluatedAt = completedAudit.evaluatedAt;
  if (evaluatedAt === null || (completedAudit.status !== "filled" && completedAudit.status !== "no_fill")) {
    throw new Error(`Intent ${intent.id} is missing a completed shadow execution audit`);
  }
  const completedOrders = intent.legs.map((leg) =>
    buildCompletedShadowOrder(intent, leg, completedAudit, evaluatedAt),
  ) as [LiveOrder, LiveOrder];
  await Promise.all(completedOrders.map((order) => writeVenueOrder(order)));

  let currentIntent = intent;
  if (completedAudit.status === "no_fill") {
    for (const order of completedOrders) {
      currentIntent = updateIntentLeg(currentIntent, order.venue, order, "failed", evaluatedAt);
    }
    currentIntent = await closeIntentWithoutExposureAccounting({
      intent: currentIntent,
      status: "skipped",
      now: evaluatedAt,
      stage: "shadow_no_fill",
      reason: `Shadow non exécuté: ${completedAudit.reason ?? completedAudit.reasonCode ?? "liquidité indisponible"}`,
      proof: {
        modelVersion: completedAudit.modelVersion,
        auditStatus: completedAudit.status,
        restCapturedAt: completedAudit.restCapturedAt,
        orderIds: completedOrders.map((order) => order.venueOrderId),
      },
    });
    await writeRunEvent({
      asset: currentIntent.asset,
      level: "info",
      eventType: "intent.shadow.no_fill",
      message: `Shadow intent ${currentIntent.id} produced no executable pair from REST books`,
      payload: {
        intentId: currentIntent.id,
        slotKey: currentIntent.slotKey,
        modelVersion: completedAudit.modelVersion,
        latencyMs: completedAudit.latencyMs,
        restFetchDurationMs: completedAudit.restFetchDurationMs,
        nextEligibleAt: completedAudit.nextEligibleAt,
        reasonCode: completedAudit.reasonCode,
        reason: completedAudit.reason,
        legs: completedAudit.legs,
      },
      createdAt: evaluatedAt,
    });
    return currentIntent;
  }

  for (const order of completedOrders) {
    const leg = currentIntent.legs.find((candidate) => candidate.venue === order.venue);
    if (!leg) {
      throw new Error(`Intent ${intent.id} missing ${order.venue} leg during shadow completion`);
    }
    const auditLeg = completedAudit.legs.find((candidate) => candidate.venue === order.venue);
    if (!auditLeg || auditLeg.vwapPrice === null) {
      throw new Error(`Intent ${intent.id} missing ${order.venue} shadow fill audit`);
    }
    await ingestFillAccounting(
      buildShadowFill(currentIntent, leg, order, auditLeg, completedAudit),
      {
        finality: "final",
        venueTruth: "shadow_deterministic_execution",
        feeProvenance: "synthetic_exact",
      },
      "shadow_completion",
    );
    currentIntent = updateIntentLeg(
      currentIntent,
      order.venue,
      order,
      order.venue === currentIntent.hedgeVenue ? "hedged" : "filled",
      evaluatedAt,
    );
  }
  currentIntent = markIntentStatus(currentIntent, "hedged", evaluatedAt, null);
  currentIntent = await writeOrderIntent(currentIntent);
  await writeRunEvent({
    asset: currentIntent.asset,
    level: "info",
    eventType: "intent.shadow.filled",
    message: `Shadow intent ${currentIntent.id} filled from immediate REST orderbook depth`,
    payload: {
      intentId: currentIntent.id,
      slotKey: currentIntent.slotKey,
      modelVersion: completedAudit.modelVersion,
      latencyMs: completedAudit.latencyMs,
      restFetchDurationMs: completedAudit.restFetchDurationMs,
      nextEligibleAt: completedAudit.nextEligibleAt,
      requestedPairSize: completedAudit.requestedPairSize,
      filledPairSize: completedAudit.filledPairSize,
      fillRatio: completedAudit.fillRatio,
      signalGrossCost: completedAudit.signalGrossCost,
      realizedGrossCost: completedAudit.realizedGrossCost,
      realizedTotalCostUsd: completedAudit.realizedTotalCostUsd,
      projectedNetProfitUsd: completedAudit.projectedNetProfitUsd,
      legs: completedAudit.legs,
    },
    createdAt: evaluatedAt,
  });
  return currentIntent;
}

async function captureShadowRestSnapshot(
  intent: OrderIntent,
  signalSnapshot: OpportunitySnapshot,
  restStartedAt: number,
  sharedRequests: {
    polymarketBook?: ReturnType<typeof fetchPolymarketBook>;
    kalshiBook?: ReturnType<typeof fetchKalshiOrderbook>;
  } = {},
) {
  const polymarketLeg = intent.legs.find((leg) => leg.venue === "polymarket");
  const kalshiLeg = intent.legs.find((leg) => leg.venue === "kalshi");
  const [polymarketResult, kalshiResult] = await Promise.allSettled([
    polymarketLeg?.tokenId
      ? (sharedRequests.polymarketBook ?? fetchPolymarketBook(polymarketLeg.tokenId))
      : Promise.reject(new Error("référence de marché absente")),
    kalshiLeg?.marketRef
      ? (sharedRequests.kalshiBook ?? fetchKalshiOrderbook(kalshiLeg.marketRef))
      : Promise.reject(new Error("référence de marché absente")),
  ]);
  const capturedAt = Date.now();
  const errors: string[] = [];
  const previousPolymarketLevels = signalSnapshot.polymarket.orderbookLevels ?? {
    upBids: [],
    upAsks: [],
    downBids: [],
    downAsks: [],
  };
  const polymarketAsks =
    polymarketResult.status === "fulfilled"
      ? polymarketResult.value.asks
          .map((level) => [Number(level.price), Number(level.size)] as [number, number])
          .filter(([price, size]) => Number.isFinite(price) && Number.isFinite(size) && size > 0)
      : [];
  if (polymarketResult.status === "rejected") {
    errors.push(`Polymarket REST: ${toErrorMessage(polymarketResult.reason)}`);
  }
  const polymarketLevels = {
    ...previousPolymarketLevels,
    ...(polymarketLeg?.outcome === "UP" ? { upAsks: polymarketAsks } : { downAsks: polymarketAsks }),
  };

  const kalshiLevels =
    kalshiResult.status === "fulfilled"
      ? normalizeKalshiNumericOrderbookLevels(kalshiResult.value)
      : { yesBids: [], noBids: [] };
  if (kalshiResult.status === "rejected") {
    errors.push(`Kalshi REST: ${toErrorMessage(kalshiResult.reason)}`);
  }

  return {
    capturedAt,
    errors,
    snapshot: {
      ...signalSnapshot,
      capturedAt,
      polymarket: {
        ...signalSnapshot.polymarket,
        slotAligned: true,
        source: "rest-fallback" as const,
        lastMessageAt: capturedAt,
        stalenessMs: 0,
        orderbookLevels: polymarketLevels,
        feedHealth: {
          ...signalSnapshot.polymarket.feedHealth,
          feedStatus: polymarketResult.status === "fulfilled" ? ("ready" as const) : ("degraded" as const),
          source: "rest-fallback" as const,
          lastMessageAt: capturedAt,
          stalenessMs: 0,
          details:
            polymarketResult.status === "fulfilled"
              ? [`Shadow REST book captured in ${capturedAt - restStartedAt}ms`]
              : errors,
        },
      },
      kalshi: {
        ...signalSnapshot.kalshi,
        slotAligned: true,
        source: "rest-fallback" as const,
        lastMessageAt: capturedAt,
        stalenessMs: 0,
        orderbookLevels: kalshiLevels,
        feedHealth: {
          ...signalSnapshot.kalshi.feedHealth,
          feedStatus: kalshiResult.status === "fulfilled" ? ("ready" as const) : ("degraded" as const),
          source: "rest-fallback" as const,
          lastMessageAt: capturedAt,
          stalenessMs: 0,
          details:
            kalshiResult.status === "fulfilled"
              ? [`Shadow REST book captured in ${capturedAt - restStartedAt}ms`]
              : errors,
        },
      },
    } satisfies OpportunitySnapshot,
  };
}

async function attachRecentPolymarketFills(intent: OrderIntent) {
  const trades = await fetchPolymarketTrades();
  const polymarketLegs = intent.legs.filter((leg) => leg.venue === "polymarket" && leg.venueOrderId);
  for (const leg of polymarketLegs) {
    const orderId = leg.venueOrderId as string;
    const matching = extractPolymarketTradesForOrder(trades, orderId).filter(isConfirmedPolymarketTrade);
    for (const trade of matching) {
      await ingestPolymarketFillAccounting(trade, intent.id, orderId, intent.asset, "intent_sync");
    }
  }

  return (await syncIntentFromStoredVenueFills(intent.id, "polymarket", intent)) ?? intent;
}

async function attachRecentPolymarketFillsSafely(intent: OrderIntent, stage: "primary" | "hedge", now: number) {
  void stage;
  void now;
  return attachRecentPolymarketFills(intent);
}

export function deriveCanonicalIntentSlot(
  intent: Pick<OrderIntent, "asset" | "slotKey" | "slotStartTs" | "slotEndTs">,
) {
  if (!Number.isSafeInteger(intent.slotStartTs) || !Number.isSafeInteger(intent.slotEndTs)) {
    throw new Error(`Intent ${intent.slotKey} has invalid slot timestamps`);
  }

  const slot = getCurrentSlot(intent.asset, new Date(intent.slotStartTs + 1));
  if (slot.key !== intent.slotKey || slot.startTs !== intent.slotStartTs || slot.endTs !== intent.slotEndTs) {
    throw new Error(`Intent ${intent.slotKey} does not match its canonical ${intent.asset} slot`);
  }
  return slot;
}

async function resumeInFlightIntents(
  intents: OrderIntent[],
  workerAsset: MarketAsset,
  settings: StrategyConfig,
  now: number,
) {
  const recentOrders = await readRecentVenueOrders(200, workerAsset);
  const resumed: OrderIntent[] = [];

  for (const intent of intents) {
    if (intent.shadow) {
      continue;
    }
    if (intent.status !== "executing_primary" && intent.status !== "primary_filled") {
      continue;
    }

    const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
    const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
    if (!primaryLeg || !hedgeLeg) {
      continue;
    }

    let intentSlot: MarketSlot;
    try {
      intentSlot = deriveCanonicalIntentSlot(intent);
    } catch (error) {
      resumed.push(
        await markIntentManualRequired(
          intent,
          now,
          "intent_slot_identity_invalid",
          `Intent recovery blocked because its persisted slot identity is invalid (${toErrorMessage(error)})`,
          {
            workerAsset,
            intentAsset: intent.asset,
            slotKey: intent.slotKey,
            slotStartTs: intent.slotStartTs,
            slotEndTs: intent.slotEndTs,
          },
        ),
      );
      continue;
    }

    let currentIntent = intent;
    const intentOrders = recentOrders.filter((order) => order.intentId === intent.id);
    const primaryOrderSummary = summarizeIntentLegOrders(intentOrders, intent, primaryLeg, "entry");
    if (
      primaryOrderSummary &&
      isPrimaryFillSizeHedgable(intent, {
        filledSize: primaryOrderSummary.filledSize,
        requestedSize: primaryLeg.requestedSize,
      })
    ) {
      currentIntent = updateIntentLegFromFillSummary(currentIntent, primaryLeg.id, primaryOrderSummary, now);
      currentIntent = markIntentStatus(currentIntent, "primary_filled", now);
      currentIntent = await writeOrderIntent(currentIntent);
      await writeLiveTradeRunEvent(currentIntent, now);

      const latestHedgeOrder = findLatestIntentOrderForLeg(intentOrders, intent, hedgeLeg);
      if (latestHedgeOrder) {
        continue;
      }

      await writeRunEvent({
        level: "warn",
        eventType: "intent.resume.hedge",
        message: `Resuming hedge submission for intent ${intent.id}`,
        payload: {
          intentId: intent.id,
          slotKey: intent.slotKey,
          resumedFromMultiClip: true,
        },
        createdAt: now,
      });

      resumed.push(await executeHedgeLeg(currentIntent, intentSlot, settings, now));
      continue;
    }

    const primaryOrder = findLatestIntentOrderForLeg(recentOrders, intent, primaryLeg);
    if (!primaryOrder || !shouldTreatPrimaryOrderAsFilled(intent, primaryOrder)) {
      continue;
    }

    currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "filled", now);
    currentIntent = markIntentStatus(currentIntent, "primary_filled", now);
    currentIntent = await writeOrderIntent(currentIntent);
    await writeLiveTradeRunEvent(currentIntent, now);

    if (currentIntent.primaryVenue === "polymarket") {
      currentIntent = await attachRecentPolymarketFillsSafely(currentIntent, "primary", now);
    }

    const latestHedgeOrder = findLatestIntentOrderForLeg(recentOrders, intent, hedgeLeg);
    if (latestHedgeOrder) {
      continue;
    }

    await writeRunEvent({
      level: "warn",
      eventType: "intent.resume.hedge",
      message: `Resuming hedge submission for intent ${intent.id}`,
      payload: {
        intentId: intent.id,
        slotKey: intent.slotKey,
      },
      createdAt: now,
    });

    resumed.push(await executeHedgeLeg(currentIntent, intentSlot, settings, now));
  }

  return resumed;
}

async function resolvePrimaryExitSize(intent: OrderIntent, primaryLeg: OrderIntent["legs"][number], now: number) {
  if (primaryLeg.venue !== "polymarket") {
    return primaryLeg.filledSize;
  }

  const [positions, sellableBalance] = await Promise.all([
    polymarketAdapter.getPositions(now).catch(() => []),
    primaryLeg.tokenId ? getPolymarketConditionalSellableBalance(primaryLeg.tokenId).catch(() => null) : null,
  ]);
  const matchingPosition = positions.find(
    (position) => position.marketRef === primaryLeg.marketRef && position.outcome === primaryLeg.outcome,
  );

  return derivePrimaryExitSize({
    filledSize: primaryLeg.filledSize,
    positionSize: matchingPosition?.size ?? null,
    sellableSize: sellableBalance?.sellable ?? null,
  });
}

async function resolvePrimaryExitPrice(intent: OrderIntent, primaryLeg: OrderIntent["legs"][number], now: number) {
  if (primaryLeg.venue === "kalshi") {
    const restSellPrice = await resolveKalshiPrimaryRestSellPrice(primaryLeg).catch(() => null);
    if (restSellPrice !== null) {
      return restSellPrice;
    }
  }

  const slot = getCurrentSlot(intent.asset, new Date(intent.slotStartTs + 1));
  const { polymarket: polymarketState, kalshi: kalshiState } = await marketDataSupervisor.readSlotState(slot, now);

  if (primaryLeg.venue === "polymarket") {
    const outcome =
      primaryLeg.outcome === "UP" ? polymarketState.quote.outcomes.up : polymarketState.quote.outcomes.down;
    return outcome.sellPrice ?? outcome.bestBid ?? null;
  }

  const outcome = primaryLeg.outcome === "YES" ? kalshiState.quote.outcomes.yes : kalshiState.quote.outcomes.no;
  return outcome.sellPrice ?? outcome.bestBid ?? null;
}

async function resolveKalshiPrimaryRestSellPrice(primaryLeg: OrderIntent["legs"][number]) {
  if (primaryLeg.venue !== "kalshi" || primaryLeg.side !== "BUY") {
    return null;
  }

  const orderbook = await fetchKalshiOrderbook(primaryLeg.marketRef);
  const levels = normalizeKalshiNumericOrderbookLevels(orderbook);
  const bids = primaryLeg.outcome === "YES" ? levels.yesBids : levels.noBids;
  const bestBid = [...bids]
    .filter(([price, size]) => Number.isFinite(price) && Number.isFinite(size) && size > 0)
    .sort((left, right) => right[0] - left[0])[0]?.[0];

  return bestBid ?? null;
}

async function unwindPrimaryLeg(
  intent: OrderIntent,
  settings: StrategyConfig,
  now: number,
  attempt: number,
  force?: {
    attempt: number;
    ticks: number;
  },
) {
  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  if (!primaryLeg || primaryLeg.filledSize <= 0) {
    throw new Error(`Unable to unwind intent ${intent.id}: no primary fill`);
  }

  const requestedSize = await resolvePrimaryExitSize(intent, primaryLeg, now);
  const unhedgedPrimarySize = deriveUnhedgedPrimarySize(intent);
  const effectiveRequestedSize =
    unhedgedPrimarySize > ORDER_SIZE_TOLERANCE ? Math.min(requestedSize, unhedgedPrimarySize) : requestedSize;
  if (effectiveRequestedSize <= 0) {
    throw new Error(`Unable to unwind intent ${intent.id}: no exitable size`);
  }

  if (effectiveRequestedSize + ORDER_SIZE_TOLERANCE < primaryLeg.filledSize) {
    await writeRunEvent({
      level: "warn",
      eventType: "order.unwind.size_capped",
      message: `Primary unwind size capped for intent ${intent.id}`,
      payload: {
        intentId: intent.id,
        venue: primaryLeg.venue,
        filledSize: primaryLeg.filledSize,
        requestedSize: effectiveRequestedSize,
        unhedgedPrimarySize,
      },
      createdAt: now,
    });
  }

  if (primaryLeg.filledPrice === null || settings.forcedUnwindMaxLossUsd <= 0) {
    throw new Error(`Unable to price unwind ${intent.id}: entry price or positive loss cap is unavailable`);
  }

  const pricingAt = Date.now();
  const slot = deriveCanonicalIntentSlot(intent);
  const unwindMarketState = await marketDataSupervisor.readSlotState(slot, pricingAt);
  const marketProof = validateRecoveryLegMarketState({
    intent,
    leg: primaryLeg,
    slot,
    marketState: unwindMarketState,
    orderSide: "SELL",
    settings,
    now: pricingAt,
  });
  if (!marketProof.allowed) {
    throw new Error(`Primary unwind market proof rejected (${marketProof.code}: ${marketProof.reason})`);
  }

  const slippageReferencePrice = applySlippage(marketProof.referencePrice, settings.maxSlippageBps, "SELL");
  const orderPrice:
    AuthoritativeRecoveryOrderPrice | Extract<ReturnType<typeof derivePolymarketRecoveryOrderPrice>, { ok: false }> =
    marketProof.venue === "polymarket"
      ? derivePolymarketRecoveryOrderPrice({
          referencePrice: slippageReferencePrice,
          tickSize: marketProof.tickSize,
          side: "SELL",
          ticks: force?.ticks ?? 0,
        })
      : deriveKalshiRecoveryOrderPrice({
          referencePrice: slippageReferencePrice,
          outcome: marketProof.outcome,
          side: "SELL",
          ticks: force?.ticks ?? 0,
          priceRanges: marketProof.priceRanges,
        });
  if (!orderPrice.ok) {
    throw new Error(`Unable to derive authoritative unwind price (${orderPrice.code}: ${orderPrice.reason})`);
  }

  const executionLeg = {
    ...primaryLeg,
    requestedPrice: orderPrice.price,
    side: "SELL" as const,
    requestedSize: effectiveRequestedSize,
    requestedNotionalUsd: effectiveRequestedSize * orderPrice.price,
  };
  const request = buildVenueOrderRequest(executionLeg, 0, primaryLeg.venue === "polymarket" ? "FAK" : "IOC", true, {
    overridePrice: orderPrice.price,
    ...(marketProof.venue === "polymarket"
      ? { authoritativeTickSize: marketProof.tickSize }
      : { kalshiPriceRanges: marketProof.priceRanges }),
  });
  if (request.price !== orderPrice.price) {
    throw new Error(`Authoritative unwind price changed while building request for ${intent.id}`);
  }

  const fee = buildRecoveryFeeSchedule(primaryLeg, unwindMarketState);
  const economics = evaluateRecoveryLossCap({
    action: "unwind",
    orderPrice,
    size: effectiveRequestedSize,
    entryPrice: primaryLeg.filledPrice,
    allocatedEntryFeeUsd: allocateRecoveryEntryFeeUsd(primaryLeg, effectiveRequestedSize),
    fee,
    maxLossUsd: settings.forcedUnwindMaxLossUsd,
  });
  await writeRunEvent({
    asset: intent.asset,
    level: economics.allowed && economics.worstCaseLossUsd <= ORDER_SIZE_TOLERANCE ? "info" : "warn",
    eventType: "order.unwind.economic_check",
    message: `Primary unwind economic check for intent ${intent.id}`,
    payload: {
      intentId: intent.id,
      venue: primaryLeg.venue,
      requestedSize: effectiveRequestedSize,
      unhedgedPrimarySize,
      entryPrice: primaryLeg.filledPrice,
      referenceExitPrice: marketProof.referencePrice,
      slippageReferencePrice,
      expectedExitPrice: orderPrice.price,
      forcedAttempt: force?.attempt ?? null,
      forcedTicks: force?.ticks ?? null,
      economics,
      maxLossUsd: settings.forcedUnwindMaxLossUsd,
      marketEvidenceValidUntil: marketProof.validUntil,
      bookObservedAt: marketProof.bookObservedAt,
    },
    createdAt: pricingAt,
  });
  if (!economics.allowed) {
    throw new Error(`Primary unwind blocked by loss policy (${economics.code}: ${economics.reason})`);
  }
  if (force) {
    await writeRunEvent({
      level: "warn",
      eventType: "order.unwind.forced_attempt",
      message: `Forced primary unwind attempt ${force.attempt} for intent ${intent.id}`,
      payload: {
        intentId: intent.id,
        venue: primaryLeg.venue,
        attempt: force.attempt,
        ticks: force.ticks,
        requestedSize: effectiveRequestedSize,
        referencePrice: marketProof.referencePrice,
        orderPrice: request.price,
        maxLossUsd: settings.forcedUnwindMaxLossUsd,
        worstCaseLossUsd: economics.worstCaseLossUsd,
      },
      createdAt: pricingAt,
    });
  }
  const unwindExecution = await submitAndConfirmOrder({
    intent,
    leg: executionLeg,
    request,
    stage: `${force ? "primary_unwind_forced" : "primary_unwind"}:${attempt}`,
    now: pricingAt,
    timeoutMs: settings.immediateOrderConfirmationTimeoutMs,
    quoteObservedAt: marketProof.bookObservedAt,
    submissionDeadlineAt: marketProof.validUntil,
  });
  return unwindExecution.order;
}

export function deriveForcedUnwindOrderPrice(
  primaryLeg: OrderIntent["legs"][number],
  referencePrice: number | null,
  maxSlippageBps: number,
  ticks: number,
  kalshiPriceRanges: readonly KalshiPriceRange[] | null = null,
  polymarketTickSize: number | null = null,
) {
  if (referencePrice === null || !Number.isFinite(referencePrice) || referencePrice <= 0) {
    return null;
  }

  if (primaryLeg.venue === "kalshi") {
    if ((primaryLeg.outcome !== "YES" && primaryLeg.outcome !== "NO") || kalshiPriceRanges === null) {
      return null;
    }
    try {
      const decision = deriveKalshiRecoveryOrderPrice({
        referencePrice: applySlippage(referencePrice, maxSlippageBps, "SELL"),
        outcome: primaryLeg.outcome,
        side: "SELL",
        ticks,
        priceRanges: kalshiPriceRanges,
      });
      return decision.ok ? decision.price : null;
    } catch {
      return null;
    }
  }

  if (polymarketTickSize === null) {
    return null;
  }
  const decision = derivePolymarketRecoveryOrderPrice({
    referencePrice: applySlippage(referencePrice, maxSlippageBps, "SELL"),
    tickSize: polymarketTickSize,
    side: "SELL",
    ticks,
  });
  return decision.ok ? decision.price : null;
}

export function estimatePrimaryUnwindLossUsd(
  primaryLeg: OrderIntent["legs"][number],
  requestedSize: number,
  expectedExitPrice: number | null,
) {
  if (expectedExitPrice === null || primaryLeg.filledPrice === null || requestedSize <= 0) {
    return null;
  }

  return round4(requestedSize * Math.max(0, primaryLeg.filledPrice - expectedExitPrice));
}

async function retryLegWithinExecutionBuffer(
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
  retryAttempt = 1,
) {
  if (settings.executionPriceBuffer <= 0) {
    return null;
  }

  const retryOrderMarketState = await marketDataSupervisor.readSlotState(slot, now);
  const marketProof = validateRecoveryLegMarketState({
    intent,
    leg,
    slot,
    marketState: retryOrderMarketState,
    orderSide: "BUY",
    settings,
    now,
  });
  if (!marketProof.allowed) {
    await writeRunEvent({
      asset: intent.asset,
      level: "warn",
      eventType: "order.hedge.retry_market_proof_rejected",
      message: `Hedge retry market proof rejected for intent ${intent.id}`,
      payload: {
        intentId: intent.id,
        slotKey: intent.slotKey,
        venue: leg.venue,
        retryAttempt,
        code: marketProof.code,
        reason: marketProof.reason,
      },
      createdAt: now,
    });
    return null;
  }
  const repricedLeg = await repriceSingleHedgeLegWithinExecutionBuffer(
    intent,
    leg,
    retryOrderMarketState,
    settings,
    retryAttempt,
  );
  if (!repricedLeg) {
    return null;
  }

  let repricedIntent: OrderIntent = {
    ...intent,
    updatedAt: now,
    legs: intent.legs.map((candidate) => (candidate.id === leg.id ? repricedLeg : candidate)) as OrderIntent["legs"],
  };
  const { polymarket, kalshi } = retryOrderMarketState;
  const worstFillOpportunity = buildWorstFillRiskOpportunity({
    opportunity: buildRiskOpportunityTemplateFromIntent(repricedIntent, settings),
    intent: repricedIntent,
    polymarket: polymarket.quote,
    kalshi: kalshi.quote,
    settings,
    reserveHedgeRetryBuffer: false,
  });
  if (worstFillOpportunity) {
    repricedIntent = applyWorstFillEconomicsToIntent(
      repricedIntent,
      applyHedgeRecoveryReserveToOpportunity(worstFillOpportunity, repricedIntent, settings),
      now,
    );
  } else {
    repricedIntent = applyConservativeHedgeRiskFallback(repricedIntent, settings, now);
    await writeRunEvent({
      asset: intent.asset,
      level: "error",
      eventType: "order.hedge.retry_risk_fallback",
      message: `Hedge retry risk calculation unavailable for intent ${intent.id}; conservative fallback persisted`,
      payload: {
        intentId: intent.id,
        retryAttempt,
        fatalLossExposureUsd: repricedIntent.fatalLossExposureUsd,
      },
      createdAt: now,
    });
  }
  repricedIntent = await writeOrderIntent(repricedIntent);
  const persistedRepricedLeg = repricedIntent.legs.find((candidate) => candidate.id === repricedLeg.id);
  if (!persistedRepricedLeg) {
    return null;
  }
  const retryPriceLadderTicks = getRetryPriceLadderTicks(persistedRepricedLeg, retryAttempt);
  const request = buildVenueOrderRequest(
    persistedRepricedLeg,
    settings.maxSlippageBps,
    immediatePartialOrderType(persistedRepricedLeg.venue),
    false,
    getAuthoritativeOrderPricingOptions(persistedRepricedLeg, retryOrderMarketState),
  );
  await writeRunEvent({
    level: "info",
    eventType: "order.hedge.repriced",
    message: `Hedge leg repriced within execution buffer for intent ${intent.id}${
      retryPriceLadderTicks > 0
        ? ` (+${retryPriceLadderTicks} retry rung${retryPriceLadderTicks === 1 ? "" : "s"})`
        : ""
    }`,
    payload: {
      intentId: intent.id,
      venue: persistedRepricedLeg.venue,
      requestedPrice: persistedRepricedLeg.requestedPrice,
      requestedSize: persistedRepricedLeg.requestedSize,
      orderPrice: request.price,
      grossCost: repricedIntent.grossCost,
      executionPriceBuffer: settings.executionPriceBuffer,
      retryAttempt,
      retryPriceLadderTicks,
    },
    createdAt: now,
  });

  let retryExecution: Awaited<ReturnType<typeof submitAndConfirmOrder>>;
  try {
    retryExecution = await submitAndConfirmOrder({
      intent: repricedIntent,
      leg: persistedRepricedLeg,
      request,
      stage: `hedge_retry:${retryAttempt}`,
      now,
      timeoutMs: settings.immediateOrderConfirmationTimeoutMs,
      quoteObservedAt: marketProof.bookObservedAt,
      submissionDeadlineAt: marketProof.validUntil,
    });
  } catch (error) {
    if (error instanceof OrderSubmissionNotStartedError) {
      await writeRunEvent({
        asset: repricedIntent.asset,
        level: "warn",
        eventType: "order.hedge.retry_submission_not_started",
        message: `Hedge retry submission was rejected before the venue request for intent ${repricedIntent.id}`,
        payload: {
          intentId: repricedIntent.id,
          retryAttempt,
          attemptId: error.attemptId,
          reason: error.reason,
          clientOrderId: request.clientOrderId,
        },
        createdAt: Date.now(),
      });
      return null;
    }
    if (shouldFailClosedOnSubmissionError(persistedRepricedLeg)) {
      await markIntentManualRequired(
        repricedIntent,
        Date.now(),
        `${persistedRepricedLeg.venue}_hedge_retry_submission_truth_unknown`,
        `${persistedRepricedLeg.venue} hedge retry may have reached the venue before the submission error (${toErrorMessage(error)})`,
        {
          retryAttempt,
          clientOrderId: request.clientOrderId,
          error: toErrorMessage(error),
        },
      );
    }
    throw error;
  }
  const result = retryExecution.result;
  const order = retryExecution.order;
  await writeRunEvent({
    level: "info",
    eventType: "order.hedge.resubmitted",
    message: `Hedge ${persistedRepricedLeg.venue} order ${order.venueOrderId} resubmitted after reprice`,
    payload: {
      intentId: repricedIntent.id,
      venue: persistedRepricedLeg.venue,
      orderId: order.venueOrderId,
      orderStatus: result.status,
      orderType: request.orderType,
      retryAttempt,
      retryPriceLadderTicks,
      requestedPrice: persistedRepricedLeg.requestedPrice,
      orderPrice: request.price,
    },
    createdAt: now,
  });

  return {
    intent: repricedIntent,
    order,
    result,
  };
}

async function retryLegWithinExecutionBufferWithAttempts(
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
  attempts: number,
  retryDelayMs: number,
) {
  if (attempts <= 0) {
    return null;
  }

  let currentIntent = intent;
  let lastResult: Awaited<ReturnType<typeof retryLegWithinExecutionBuffer>> = null;
  let attemptsSubmitted = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1 && retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }

    const retried = await retryLegWithinExecutionBuffer(currentIntent, leg, slot, settings, Date.now(), attempt);
    if (!retried) {
      if (lastResult) {
        await writeRunEvent({
          level: "warn",
          eventType: "order.hedge.retry_aborted",
          message: `Hedge retry ${attempt}/${attempts} skipped because repricing was no longer valid`,
          payload: {
            intentId: currentIntent.id,
            venue: leg.venue,
            attempt,
            attempts,
            reason: "repricing_unavailable",
          },
          createdAt: Date.now(),
        });
      }
      return lastResult ? { ...lastResult, attemptsSubmitted } : null;
    }

    attemptsSubmitted += 1;
    lastResult = retried;
    currentIntent = retried.intent;

    if (!isTerminalOrderStatus(retried.result.status) || retried.order.filledSize > 0) {
      return { ...retried, attemptsSubmitted };
    }

    if (!shouldRetryTerminalZeroFillHedge(retried.intent, leg, retried.result)) {
      await writeHedgeRetryBlockedPendingTruthEvent(retried.intent, leg, retried.order, Date.now(), {
        attempt,
        attempts,
        orderStatus: retried.result.status,
      });
      return { ...retried, attemptsSubmitted };
    }

    await writeRunEvent({
      level: "warn",
      eventType: "order.hedge.retry_terminal",
      message: `Hedge retry ${attempt}/${attempts} ended without fill`,
      payload: {
        intentId: retried.intent.id,
        venue: leg.venue,
        attempt,
        attempts,
        orderId: retried.order.venueOrderId,
        orderStatus: retried.result.status,
        detail: extractTerminalNoFillDetail(retried.result),
      },
      createdAt: Date.now(),
    });
  }

  return lastResult ? { ...lastResult, attemptsSubmitted } : null;
}

async function repriceIntentWithinExecutionBuffer(
  intent: OrderIntent,
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
  pairSizeCap?: number | null,
) {
  const { polymarket: polymarketState, kalshi: kalshiState } = await marketDataSupervisor.readSlotState(slot, now);
  const pair = getLivePairSnapshot(intent, polymarketState.quote, kalshiState.quote, settings);
  if (!pair) {
    return null;
  }

  const allowedGrossCost = settings.grossEntryThreshold + settings.executionPriceBuffer;
  if (pair.grossCost > allowedGrossCost + ORDER_SIZE_TOLERANCE) {
    return null;
  }

  const polyLeg = intent.legs.find((leg) => leg.venue === "polymarket");
  const kalshiLeg = intent.legs.find((leg) => leg.venue === "kalshi");
  if (!polyLeg || !kalshiLeg) {
    return null;
  }

  const desiredPairSize = Math.min(
    polyLeg.requestedSize,
    kalshiLeg.requestedSize,
    pairSizeCap ?? Number.POSITIVE_INFINITY,
    getKalshiPrimaryMultiClipCapacity(settings.kalshiPrimaryMaxClipContracts, settings.kalshiPrimaryMaxClips) ??
      Number.POSITIVE_INFINITY,
  );
  const polyLevels =
    (polyLeg.outcome === "UP"
      ? polymarketState.quote.orderbookLevels?.upAsks
      : polymarketState.quote.orderbookLevels?.downAsks
    )?.map(([price, size]) => ({ price, size })) ?? [];
  const kalshiLevels = deriveKalshiBuyPriceLevels(
    kalshiState.quote.orderbookLevels,
    kalshiLeg.outcome === "YES" ? "YES" : "NO",
  ).map(([price, size]) => ({ price, size }));
  if (polyLevels.length === 0 || kalshiLevels.length === 0) {
    return null;
  }
  const multiLevelSizing = deriveMultiLevelPairedQuote({
    targetPairBudgetUsd: settings.maxPairNotionalUsd,
    maxLegCapitalShare: settings.maxLegCapitalShare,
    pairSizeCap: desiredPairSize,
    minPairSize: Math.max(settings.minOrderSize, pair.poly.minOrderSize ?? 0, pair.kalshi.minOrderSize ?? 1),
    minProjectedNetProfitUsd: settings.minProjectedNetProfitUsd,
    minProjectedNetReturn: settings.minProjectedNetReturn,
    minConservativeNetProfitUsd: settings.minWorstCaseProfitUsd,
    polymarket: {
      levels: polyLevels,
      maxPrice: settings.maxLegPrice,
      depthSafetyFactor: settings.polymarketHedgeDepthSafetyFactor,
      feeRateBps: pair.poly.feeRateBps,
      feeRate: polymarketState.quote.feeRate ?? undefined,
      feeExponent: polymarketState.quote.feeExponent ?? undefined,
    },
    kalshi: {
      levels: kalshiLevels,
      maxPrice: settings.maxLegPrice,
      depthSafetyFactor: settings.kalshiPrimaryDepthSafetyFactor,
      depthHeadroomContracts: settings.kalshiDepthHeadroomContracts,
      feeMultiplier: pair.kalshi.feeMultiplier,
    },
  });
  if (multiLevelSizing.commonSize <= 0) {
    return null;
  }
  const repricedGrossCost = round4(
    (multiLevelSizing.polymarket.notionalUsd + multiLevelSizing.kalshi.notionalUsd) / multiLevelSizing.commonSize,
  );
  if (repricedGrossCost > allowedGrossCost + ORDER_SIZE_TOLERANCE) {
    return null;
  }
  if (
    !doesSizingMeetProfitThresholds(
      multiLevelSizing.projectedNetProfitUsd,
      multiLevelSizing.projectedNetReturn,
      settings,
    )
  ) {
    return null;
  }

  const updatedLegs = intent.legs.map((leg) => {
    const quote = leg.venue === "polymarket" ? multiLevelSizing.polymarket : multiLevelSizing.kalshi;
    if (quote.size <= 0 || quote.limitPrice === null) {
      return null;
    }

    return {
      ...leg,
      requestedPrice: quote.limitPrice,
      requestedSize: quote.size,
      requestedNotionalUsd: quote.notionalUsd,
    };
  });

  if (updatedLegs.some((leg) => leg === null)) {
    return null;
  }

  return {
    ...intent,
    grossCost: repricedGrossCost,
    targetNotionalUsd: round4(multiLevelSizing.polymarket.notionalUsd + multiLevelSizing.kalshi.notionalUsd),
    projectedNetProfitUsd: multiLevelSizing.projectedNetProfitUsd,
    fatalMismatchPnlUsd: round4(-multiLevelSizing.worstFillCostUsd),
    conservativeExpectedPnlUsd:
      intent.mismatchPFatalUpper === null || intent.mismatchPFatalUpper === undefined
        ? (intent.conservativeExpectedPnlUsd ?? null)
        : round4(multiLevelSizing.commonSize * (1 - intent.mismatchPFatalUpper) - multiLevelSizing.worstFillCostUsd),
    fatalLossExposureUsd: round4(multiLevelSizing.worstFillCostUsd),
    updatedAt: now,
    legs: updatedLegs as OrderIntent["legs"],
  };
}

function doesSizingMeetProfitThresholds(
  projectedNetProfitUsd: number | null,
  projectedNetReturn: number | null,
  settings: Pick<StrategyConfig, "minProjectedNetProfitUsd" | "minProjectedNetReturn" | "minWorstCaseProfitUsd">,
  options: { allowUnknownReturn?: boolean } = {},
) {
  if (projectedNetProfitUsd === null || !Number.isFinite(projectedNetProfitUsd)) {
    return false;
  }
  if (projectedNetProfitUsd + ORDER_SIZE_TOLERANCE < settings.minProjectedNetProfitUsd) {
    return false;
  }
  if (projectedNetProfitUsd + ORDER_SIZE_TOLERANCE < settings.minWorstCaseProfitUsd) {
    return false;
  }
  if (projectedNetReturn === null) {
    return options.allowUnknownReturn === true || settings.minProjectedNetReturn <= ORDER_SIZE_TOLERANCE;
  }

  return projectedNetReturn + ORDER_SIZE_TOLERANCE >= settings.minProjectedNetReturn;
}

async function repriceSingleHedgeLegWithinExecutionBuffer(
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
  marketState: InitialEntryMarketState,
  settings: StrategyConfig,
  retryAttempt = 1,
) {
  const { polymarket: polymarketState, kalshi: kalshiState } = marketState;
  const liveLeg = getLiveIntentLegSnapshot(leg, polymarketState.quote, kalshiState.quote);
  if (!liveLeg) {
    return null;
  }

  return deriveBufferedRetryLeg(
    leg,
    liveLeg,
    {
      executionPriceBuffer: settings.executionPriceBuffer,
      maxLegPrice: settings.maxLegPrice,
      maxSlippageBps: settings.maxSlippageBps,
      minOrderSize: settings.minOrderSize,
      kalshiDepthHeadroomContracts: settings.kalshiDepthHeadroomContracts,
    },
    retryAttempt,
  );
}

function getLiveIntentLegSnapshot(
  leg: OrderIntent["legs"][number],
  polymarket: OpportunitySnapshot["polymarket"],
  kalshi: OpportunitySnapshot["kalshi"],
) {
  if (leg.venue === "polymarket") {
    const outcome =
      leg.outcome === "UP" ? polymarket.outcomes.up : leg.outcome === "DOWN" ? polymarket.outcomes.down : null;
    if (!outcome) {
      return null;
    }

    return {
      price: leg.side === "SELL" ? outcome.sellPrice : outcome.buyPrice,
      depth: outcome.depth,
      minOrderSize: outcome.minOrderSize,
      tickSize: outcome.tickSize,
      priceRanges: null,
    };
  }

  const outcome = leg.outcome === "YES" ? kalshi.outcomes.yes : leg.outcome === "NO" ? kalshi.outcomes.no : null;
  if (!outcome) {
    return null;
  }

  return {
    price: leg.side === "SELL" ? outcome.sellPrice : outcome.buyPrice,
    depth: outcome.depth,
    minOrderSize: outcome.minOrderSize,
    tickSize: outcome.tickSize,
    priceRanges: kalshi.priceRanges,
  };
}

export function deriveBufferedRetryLeg<
  T extends Pick<
    OrderIntent["legs"][number],
    | "venue"
    | "requestedNotionalUsd"
    | "requestedPrice"
    | "requestedSize"
    | "side"
    | "outcome"
    | "id"
    | "intentId"
    | "status"
    | "marketRef"
  >,
>(
  leg: T,
  liveLeg: {
    price: number | null;
    depth: number | null;
    minOrderSize: number | null;
    tickSize?: number | null;
    priceRanges?: readonly KalshiPriceRange[] | null;
  },
  settings: Pick<
    StrategyConfig,
    "executionPriceBuffer" | "maxLegPrice" | "maxSlippageBps" | "minOrderSize" | "kalshiDepthHeadroomContracts"
  >,
  retryAttempt = 1,
) {
  if (liveLeg.price === null) {
    return null;
  }

  let requestedPrice: number | null;
  try {
    requestedPrice = deriveRetryReferencePrice(
      leg,
      liveLeg.price,
      liveLeg.tickSize ?? null,
      liveLeg.priceRanges ?? null,
      retryAttempt,
    );
  } catch {
    return null;
  }
  if (requestedPrice === null) {
    return null;
  }

  const boundedPrice =
    leg.venue === "kalshi"
      ? deriveEffectiveKalshiRetryOrderPrice(
          requestedPrice,
          leg.outcome,
          leg.side,
          settings.maxSlippageBps,
          liveLeg.priceRanges ?? null,
        )
      : requestedPrice;
  if (boundedPrice === null) {
    return null;
  }
  const referencePrice = leg.requestedPrice;
  if (referencePrice !== null) {
    if (leg.side === "SELL") {
      const allowedWorstPrice = referencePrice - settings.executionPriceBuffer;
      if (boundedPrice + ORDER_SIZE_TOLERANCE < allowedWorstPrice) {
        return null;
      }
    } else {
      const allowedWorstPrice = referencePrice + settings.executionPriceBuffer;
      if (boundedPrice > allowedWorstPrice + ORDER_SIZE_TOLERANCE) {
        return null;
      }
    }
  }

  const fallbackMinOrderSize = leg.venue === "polymarket" ? settings.minOrderSize : 1;
  const minimumSize = getVenueMinimumOrderSize(leg.venue, liveLeg.minOrderSize, fallbackMinOrderSize);
  const normalizedRequestedSize = normalizeVenueTargetSize(
    leg.venue,
    leg.requestedSize,
    liveLeg.minOrderSize,
    fallbackMinOrderSize,
  );
  if (
    normalizedRequestedSize <= 0 ||
    normalizedRequestedSize + ORDER_SIZE_TOLERANCE < minimumSize ||
    normalizedRequestedSize + ORDER_SIZE_TOLERANCE < leg.requestedSize
  ) {
    return null;
  }

  const executableDepth = getVenueExecutableDepth(leg.venue, liveLeg.depth, settings.kalshiDepthHeadroomContracts);
  if (executableDepth !== null && normalizedRequestedSize > executableDepth + ORDER_SIZE_TOLERANCE) {
    return null;
  }

  return {
    ...leg,
    requestedPrice,
    requestedSize: normalizedRequestedSize,
    requestedNotionalUsd: round4(normalizedRequestedSize * requestedPrice),
  };
}

function deriveRetryReferencePrice(
  leg: Pick<OrderIntent["legs"][number], "venue" | "outcome" | "side">,
  livePrice: number,
  liveTickSize: number | null,
  kalshiPriceRanges: readonly KalshiPriceRange[] | null,
  retryAttempt: number,
) {
  const retryPriceLadderTicks = getRetryPriceLadderTicks(leg, retryAttempt);
  if (retryPriceLadderTicks <= 0) {
    if (leg.venue !== "kalshi") {
      return livePrice;
    }
    if ((leg.outcome !== "YES" && leg.outcome !== "NO") || kalshiPriceRanges === null) {
      return null;
    }
    return normalizeKalshiOutcomePrice({
      price: livePrice,
      outcome: leg.outcome,
      side: leg.side,
      priceRanges: kalshiPriceRanges,
    }).price;
  }

  if (leg.venue === "kalshi") {
    if ((leg.outcome !== "YES" && leg.outcome !== "NO") || kalshiPriceRanges === null) {
      return null;
    }
    return moveKalshiOutcomePriceByTicks({
      price: livePrice,
      outcome: leg.outcome,
      side: leg.side,
      ticks: retryPriceLadderTicks,
      priceRanges: kalshiPriceRanges,
    }).price;
  }

  const priceStep = leg.venue === "polymarket" ? Math.max(0.001, liveTickSize ?? 0.001) : 0;
  if (priceStep <= 0) {
    return livePrice;
  }

  const priceDelta = retryPriceLadderTicks * priceStep;
  return round4(Math.max(priceStep, livePrice + (leg.side === "SELL" ? -priceDelta : priceDelta)));
}

function deriveEffectiveKalshiRetryOrderPrice(
  requestedPrice: number,
  outcome: OrderIntent["legs"][number]["outcome"],
  side: OrderIntent["legs"][number]["side"],
  maxSlippageBps: number,
  priceRanges: readonly KalshiPriceRange[] | null,
) {
  if ((outcome !== "YES" && outcome !== "NO") || priceRanges === null) {
    return null;
  }
  try {
    return normalizeKalshiOutcomePrice({
      price: applySlippage(requestedPrice, maxSlippageBps, side),
      outcome,
      side,
      priceRanges,
    }).price;
  } catch {
    return null;
  }
}

export function resolvePrimaryRetryPlan(
  primaryVenue: Venue,
  result: Pick<Awaited<ReturnType<VenueAdapter["placeOrder"]>>, "raw">,
  settings: Pick<StrategyConfig, "primaryRetryAttempts" | "primaryRetryDelayMs">,
) {
  if (primaryVenue === "kalshi" && Boolean(result.raw?.softNoFill)) {
    return {
      attempts: Math.max(1, settings.primaryRetryAttempts),
      retryDelayMs: settings.primaryRetryDelayMs,
    };
  }

  return {
    attempts: 1,
    retryDelayMs: 0,
  };
}

export function resolveKalshiPrimaryMultiClipRetryPlan(
  primaryVenue: Venue,
  result: Pick<Awaited<ReturnType<VenueAdapter["placeOrder"]>>, "raw">,
) {
  if (primaryVenue === "kalshi" && Boolean(result.raw?.softNoFill)) {
    return {
      attempts: 0,
      retryDelayMs: 0,
    };
  }

  return {
    attempts: 1,
    retryDelayMs: 0,
  };
}

export function shouldKeepPolymarketLegForResolution(
  leg: Pick<OrderIntent["legs"][number], "venue" | "outcome" | "filledSize" | "payoutUsd"> | null | undefined,
  resolvedOutcome: "UP" | "DOWN" | null | undefined,
) {
  return (
    leg?.venue === "polymarket" &&
    leg.filledSize > 0 &&
    leg.payoutUsd === null &&
    resolvedOutcome !== null &&
    resolvedOutcome !== undefined &&
    leg.outcome === resolvedOutcome
  );
}

function getRetryPriceLadderTicks(leg: Pick<OrderIntent["legs"][number], "venue">, retryAttempt: number) {
  return leg.venue === "kalshi" || leg.venue === "polymarket" ? Math.max(0, retryAttempt - 1) : 0;
}

function resolveKalshiPrimarySizingDepth(
  kalshi: OpportunitySnapshot["kalshi"],
  outcome: "YES" | "NO",
  price: number | null,
  ticksSlippage: number,
) {
  if (price === null) {
    return null;
  }

  if (!kalshi.priceRanges) {
    return null;
  }
  const maxBuyPrice = moveKalshiOutcomePriceByTicks({
    price,
    outcome,
    side: "BUY",
    ticks: Math.max(0, ticksSlippage),
    priceRanges: kalshi.priceRanges,
  }).price;
  return computeKalshiBuyDepthWithinPriceRange(kalshi.orderbookLevels, outcome, maxBuyPrice);
}

function getLivePairSnapshot(
  intent: OrderIntent,
  polymarket: OpportunitySnapshot["polymarket"],
  kalshi: OpportunitySnapshot["kalshi"],
  settings: Pick<StrategyConfig, "kalshiPrimaryPriceTicksSlippage" | "kalshiPrimaryDepthSafetyFactor">,
) {
  const isDownYes = intent.combination === "POLY_DOWN_KALSHI_YES";
  const polyOutcome = isDownYes ? polymarket.outcomes.down : polymarket.outcomes.up;
  const kalshiOutcome = isDownYes ? kalshi.outcomes.yes : kalshi.outcomes.no;
  const polyPrice = polyOutcome.buyPrice;
  const kalshiPrice = kalshiOutcome.buyPrice;
  const kalshiSizingDepth = applyKalshiPrimaryDepthSafetyFactor(
    resolveKalshiPrimarySizingDepth(
      kalshi,
      isDownYes ? "YES" : "NO",
      kalshiPrice,
      settings.kalshiPrimaryPriceTicksSlippage,
    ) ?? kalshiOutcome.depth,
    settings.kalshiPrimaryDepthSafetyFactor,
  );

  if (polyPrice === null || kalshiPrice === null) {
    return null;
  }

  return {
    grossCost: round4(polyPrice + kalshiPrice),
    poly: {
      price: polyPrice,
      depth: polyOutcome.depth,
      minOrderSize: polyOutcome.minOrderSize,
      feeRateBps: polyOutcome.feeRateBps ?? polymarket.feeRateBps,
    },
    kalshi: {
      price: kalshiPrice,
      depth: kalshiSizingDepth,
      minOrderSize: kalshiOutcome.minOrderSize,
      feeMultiplier: kalshi.feeMultiplier,
    },
  };
}

async function buildKalshiPrimaryBookTelemetry(
  slot: MarketSlot,
  leg: Pick<OrderIntent["legs"][number], "outcome" | "side" | "venue">,
  settings: Pick<StrategyConfig, "kalshiPrimaryPriceTicksSlippage" | "kalshiPrimaryDepthSafetyFactor">,
  now: number,
  orderPrice: number | null,
  requestedSize: number,
) {
  if (leg.venue !== "kalshi" || leg.side !== "BUY") {
    return null;
  }

  const { kalshi } = await marketDataSupervisor.readSlotState(slot, now);
  const kalshiOutcome = leg.outcome === "YES" ? "YES" : "NO";
  const outcomeKey = kalshiOutcome === "YES" ? "yes" : "no";
  const topDepth = kalshi.quote.outcomes[outcomeKey].depth;
  const topPrice = kalshi.quote.outcomes[outcomeKey].buyPrice;
  const cumulativeDepth = computeKalshiBuyDepthWithinPriceRange(
    kalshi.quote.orderbookLevels,
    kalshiOutcome,
    orderPrice,
  );
  const safetyAdjustedCumulativeDepth = applyKalshiPrimaryDepthSafetyFactor(
    cumulativeDepth ?? topDepth,
    settings.kalshiPrimaryDepthSafetyFactor,
  );
  const topLevels = deriveKalshiBuyPriceLevels(kalshi.quote.orderbookLevels, kalshiOutcome)
    .slice(0, 3)
    .map(([price, size]) => ({ price, size }));

  return {
    source: kalshi.quote.source,
    feedStalenessMs: kalshi.quote.stalenessMs,
    topPrice,
    topDepth,
    limitPrice: orderPrice,
    requestedSize,
    cumulativeDepthWithinLimit: cumulativeDepth,
    depthSafetyFactor: settings.kalshiPrimaryDepthSafetyFactor,
    safetyAdjustedCumulativeDepthWithinLimit: safetyAdjustedCumulativeDepth,
    ticksSlippage: settings.kalshiPrimaryPriceTicksSlippage,
    topLevels,
  };
}

async function buildKalshiPrimaryRestFailureBookTelemetry(
  leg: Pick<OrderIntent["legs"][number], "marketRef" | "outcome" | "side" | "venue">,
  settings: Pick<StrategyConfig, "kalshiPrimaryDepthSafetyFactor">,
  orderPrice: number | null,
  requestedSize: number,
) {
  if (leg.venue !== "kalshi" || leg.side !== "BUY") {
    return null;
  }

  try {
    const orderbook = await fetchKalshiOrderbook(leg.marketRef);
    const levels = normalizeKalshiNumericOrderbookLevels(orderbook);
    const kalshiOutcome = leg.outcome === "YES" ? "YES" : "NO";
    const topLevels = deriveKalshiBuyPriceLevels(levels, kalshiOutcome)
      .slice(0, 3)
      .map(([price, size]) => ({ price, size }));
    const cumulativeDepth = computeKalshiBuyDepthWithinPriceRange(levels, kalshiOutcome, orderPrice);

    return {
      source: "rest-direct",
      topPrice: topLevels[0]?.price ?? null,
      topDepth: topLevels[0]?.size ?? null,
      limitPrice: orderPrice,
      requestedSize,
      cumulativeDepthWithinLimit: cumulativeDepth,
      depthSafetyFactor: settings.kalshiPrimaryDepthSafetyFactor,
      safetyAdjustedCumulativeDepthWithinLimit: applyKalshiPrimaryDepthSafetyFactor(
        cumulativeDepth ?? topLevels[0]?.size ?? null,
        settings.kalshiPrimaryDepthSafetyFactor,
      ),
      topLevels,
      seq: orderbook.seq ?? null,
    };
  } catch (error) {
    return {
      source: "rest-direct",
      limitPrice: orderPrice,
      requestedSize,
      error: toErrorMessage(error),
    };
  }
}

export async function preflightEntryDepthAndAdjustIntent(
  intent: OrderIntent,
  slot: MarketSlot,
  settings: StrategyConfig,
  providedMarketState?: InitialEntryMarketState,
  evaluatedAt?: number,
): Promise<
  | {
      status: "ready";
      intent: OrderIntent;
      maxSlippageBps: number;
      primary: EntryDepthCheck;
      hedge: EntryDepthCheck;
      resized: boolean;
    }
  | {
      status: "skipped";
      reason: string;
      maxSlippageBps: number;
      primary: EntryDepthCheck | null;
      hedge: EntryDepthCheck | null;
    }
> {
  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
  if (!primaryLeg || !hedgeLeg) {
    return {
      status: "skipped",
      reason: "Entry depth preflight skipped primary submission (missing leg)",
      maxSlippageBps: settings.maxSlippageBps,
      primary: null,
      hedge: null,
    };
  }

  const preflightNow = evaluatedAt ?? Date.now();
  const { polymarket: polymarketState, kalshi: kalshiState } =
    providedMarketState ?? (await marketDataSupervisor.readSlotState(slot, preflightNow));
  const wsSnapshotIssue = validateFinalWsEntrySnapshot(
    slot,
    primaryLeg,
    hedgeLeg,
    polymarketState.quote,
    kalshiState.quote,
    settings,
    preflightNow,
  );
  if (wsSnapshotIssue) {
    return {
      status: "skipped",
      reason: `Entry WS preflight skipped primary submission (${wsSnapshotIssue})`,
      maxSlippageBps: settings.maxSlippageBps,
      primary: null,
      hedge: null,
    };
  }
  const primaryLive = getLiveIntentLegSnapshot(primaryLeg, polymarketState.quote, kalshiState.quote);
  const hedgeLive = getLiveIntentLegSnapshot(hedgeLeg, polymarketState.quote, kalshiState.quote);
  const primaryCheck = buildWsEntryDepthCheck(
    primaryLeg,
    primaryLive,
    polymarketState.quote,
    kalshiState.quote,
    settings,
  );
  const hedgeCheck = buildWsEntryDepthCheck(hedgeLeg, hedgeLive, polymarketState.quote, kalshiState.quote, settings);
  const limitingCoverage = Math.min(primaryCheck.coverageRatio, hedgeCheck.coverageRatio);
  const maxSlippageBps = deriveAdaptiveSlippageBps(limitingCoverage, settings);

  if (
    primaryCheck.coverageRatio + ORDER_SIZE_TOLERANCE < settings.minimumEntryDepthCoverageRatio ||
    hedgeCheck.coverageRatio + ORDER_SIZE_TOLERANCE < settings.minimumEntryDepthCoverageRatio
  ) {
    return {
      status: "skipped",
      reason: `Entry depth preflight skipped primary submission (coverage ${limitingCoverage.toFixed(2)} below ${settings.minimumEntryDepthCoverageRatio.toFixed(2)})`,
      maxSlippageBps,
      primary: primaryCheck,
      hedge: hedgeCheck,
    };
  }

  if (limitingCoverage + ORDER_SIZE_TOLERANCE >= 1) {
    return {
      status: "ready",
      intent: {
        ...intent,
        maxSlippageBps,
      },
      maxSlippageBps,
      primary: primaryCheck,
      hedge: hedgeCheck,
      resized: false,
    };
  }

  const safePairSize = Math.min(primaryCheck.executableDepth, hedgeCheck.executableDepth);
  const resizedIntent = resizeIntentFromWsBookSnapshot(
    intent,
    polymarketState.quote,
    kalshiState.quote,
    settings,
    preflightNow,
    safePairSize,
  );
  if (!resizedIntent) {
    return {
      status: "skipped",
      reason: "Entry depth preflight skipped primary submission (depth downsize failed economics or minimum size)",
      maxSlippageBps,
      primary: primaryCheck,
      hedge: hedgeCheck,
    };
  }

  return {
    status: "ready",
    intent: {
      ...resizedIntent,
      maxSlippageBps,
      entrySizingReason:
        resizedIntent.entrySizingReason ??
        `Notionnel réduit par preflight depth: coverage ${(limitingCoverage * 100).toFixed(1)}%`,
    },
    maxSlippageBps,
    primary: primaryCheck,
    hedge: hedgeCheck,
    resized: true,
  };
}

type EntryDepthCheck = {
  venue: Venue;
  requestedSize: number;
  livePrice: number | null;
  displayedDepth: number | null;
  executableDepth: number;
  coverageRatio: number;
};

function validateInitialPrimaryRequestDepth(
  leg: OrderIntent["legs"][number],
  request: VenueOrderRequest,
  marketState: InitialEntryMarketState,
  settings: StrategyConfig,
) {
  if (request.price === null || request.size <= 0) {
    return "Initial primary request has no executable price or size";
  }
  const exactLeg = {
    ...leg,
    requestedPrice: request.price,
    requestedSize: request.size,
  };
  const liveLeg = getLiveIntentLegSnapshot(exactLeg, marketState.polymarket.quote, marketState.kalshi.quote);
  const depth = buildWsEntryDepthCheck(
    exactLeg,
    liveLeg,
    marketState.polymarket.quote,
    marketState.kalshi.quote,
    settings,
  );
  return depth.coverageRatio + ORDER_SIZE_TOLERANCE >= 1
    ? null
    : `${leg.venue} ${leg.outcome} exact request depth coverage ${depth.coverageRatio.toFixed(4)} is below 1.0000`;
}

export function validateFinalWsEntrySnapshot(
  slot: MarketSlot,
  primaryLeg: OrderIntent["legs"][number],
  hedgeLeg: OrderIntent["legs"][number],
  polymarket: OpportunitySnapshot["polymarket"],
  kalshi: OpportunitySnapshot["kalshi"],
  settings: StrategyConfig,
  now: number,
) {
  if (
    !polymarket.slotAligned ||
    !kalshi.slotAligned ||
    polymarket.ref.slotKey !== slot.key ||
    kalshi.ref.slotKey !== slot.key
  ) {
    return "market slot alignment changed";
  }
  if (polymarket.feedHealth.feedStatus !== "ready" || kalshi.feedHealth.feedStatus !== "ready") {
    return "feed health is not ready";
  }
  if (polymarket.source !== "ws" || kalshi.source !== "ws") {
    return `non-WS source poly=${polymarket.source} kalshi=${kalshi.source}`;
  }
  if (!polymarket.orderbookLevels || !kalshi.orderbookLevels) {
    return "multi-level WS orderbook unavailable";
  }

  for (const leg of [primaryLeg, hedgeLeg]) {
    const quote = leg.venue === "polymarket" ? polymarket : kalshi;
    const outcome =
      leg.venue === "polymarket"
        ? leg.outcome === "UP"
          ? polymarket.outcomes.up
          : polymarket.outcomes.down
        : leg.outcome === "YES"
          ? kalshi.outcomes.yes
          : kalshi.outcomes.no;
    const maxAgeMs =
      leg.venue === "polymarket"
        ? Math.min(settings.maxSignalAgeMs, settings.polymarketHedgeBookMaxAgeMs)
        : settings.maxSignalAgeMs;
    const ageMs =
      outcome.chart.lastUpdatedAt === null ? Number.POSITIVE_INFINITY : Math.max(0, now - outcome.chart.lastUpdatedAt);
    if (
      outcome.chart.source !== "ws" ||
      quote.stalenessMs === null ||
      quote.stalenessMs > maxAgeMs ||
      ageMs > maxAgeMs
    ) {
      return `${leg.venue} ${leg.outcome} book is stale or not WS`;
    }
  }
  return null;
}

export function validateFinalWsEntryDepthCoverage(
  slot: MarketSlot,
  primaryLeg: OrderIntent["legs"][number],
  hedgeLeg: OrderIntent["legs"][number],
  polymarket: OpportunitySnapshot["polymarket"],
  kalshi: OpportunitySnapshot["kalshi"],
  settings: StrategyConfig,
  now: number,
) {
  const snapshotIssue = validateFinalWsEntrySnapshot(slot, primaryLeg, hedgeLeg, polymarket, kalshi, settings, now);
  if (snapshotIssue) {
    return snapshotIssue;
  }

  for (const leg of [primaryLeg, hedgeLeg]) {
    const liveLeg = getLiveIntentLegSnapshot(leg, polymarket, kalshi);
    const depth = buildWsEntryDepthCheck(leg, liveLeg, polymarket, kalshi, settings);
    if (depth.coverageRatio + ORDER_SIZE_TOLERANCE < 1) {
      return `${leg.venue} ${leg.outcome} executable depth coverage ${depth.coverageRatio.toFixed(4)} is below 1.0000`;
    }
  }

  return null;
}

function buildWsEntryDepthCheck(
  leg: OrderIntent["legs"][number],
  liveLeg: ReturnType<typeof getLiveIntentLegSnapshot>,
  polymarket: OpportunitySnapshot["polymarket"],
  kalshi: OpportunitySnapshot["kalshi"],
  settings: StrategyConfig,
): EntryDepthCheck {
  const maxPrice = leg.requestedPrice;
  const levels =
    leg.venue === "polymarket"
      ? ((leg.outcome === "UP" ? polymarket.orderbookLevels?.upAsks : polymarket.orderbookLevels?.downAsks) ?? [])
      : deriveKalshiBuyPriceLevels(kalshi.orderbookLevels, leg.outcome === "YES" ? "YES" : "NO");
  const displayedDepth =
    maxPrice === null
      ? 0
      : levels.reduce(
          (sum, [price, size]) =>
            Number.isFinite(price) && Number.isFinite(size) && price <= maxPrice + ORDER_SIZE_TOLERANCE
              ? sum + Math.max(0, size)
              : sum,
          0,
        );
  const executableDepth = deriveEntryExecutableDepth(leg, displayedDepth, settings);
  return {
    venue: leg.venue,
    requestedSize: leg.requestedSize,
    livePrice: liveLeg?.price ?? null,
    displayedDepth,
    executableDepth,
    coverageRatio: leg.requestedSize > 0 ? executableDepth / leg.requestedSize : 0,
  };
}

function resizeIntentFromWsBookSnapshot(
  intent: OrderIntent,
  polymarket: OpportunitySnapshot["polymarket"],
  kalshi: OpportunitySnapshot["kalshi"],
  settings: StrategyConfig,
  now: number,
  safePairSize: number,
) {
  const pairSize = normalizeVenueTargetSize("kalshi", safePairSize, 1, 1);
  const polyLeg = intent.legs.find((leg) => leg.venue === "polymarket");
  const kalshiLeg = intent.legs.find((leg) => leg.venue === "kalshi");
  if (!polyLeg || !kalshiLeg || pairSize <= 0) {
    return null;
  }
  const minimumPairSize = Math.max(
    polyLeg.requestedSize > 0
      ? (polymarket.outcomes[polyLeg.outcome === "UP" ? "up" : "down"].minOrderSize ?? settings.minOrderSize)
      : 0,
    kalshi.outcomes[kalshiLeg.outcome === "YES" ? "yes" : "no"].minOrderSize ?? 1,
  );
  if (pairSize + ORDER_SIZE_TOLERANCE < minimumPairSize) {
    return null;
  }

  const polyOutcome = polymarket.outcomes[polyLeg.outcome === "UP" ? "up" : "down"];
  const kalshiOutcome = kalshiLeg.outcome === "YES" ? "YES" : "NO";
  const polyQuote = quoteMultiLevelBuyLeg({
    venue: "polymarket",
    levels:
      (polyLeg.outcome === "UP" ? polymarket.orderbookLevels?.upAsks : polymarket.orderbookLevels?.downAsks)?.map(
        ([price, size]) => ({ price, size }),
      ) ?? [],
    size: pairSize,
    maxPrice: polyLeg.requestedPrice,
    depthSafetyFactor: settings.polymarketHedgeDepthSafetyFactor,
    depthHeadroom: settings.polymarketHedgeHeadroomShares,
    feeRateBps: polyOutcome.feeRateBps ?? polymarket.feeRateBps,
    feeRate: polymarket.feeRate ?? undefined,
    feeExponent: polymarket.feeExponent ?? undefined,
  });
  const kalshiQuote = quoteMultiLevelBuyLeg({
    venue: "kalshi",
    levels: deriveKalshiBuyPriceLevels(kalshi.orderbookLevels, kalshiOutcome).map(([price, size]) => ({ price, size })),
    size: pairSize,
    maxPrice: kalshiLeg.requestedPrice,
    depthSafetyFactor: settings.kalshiPrimaryDepthSafetyFactor,
    depthHeadroom: settings.kalshiDepthHeadroomContracts,
    feeMultiplier: kalshi.feeMultiplier,
  });
  if (!polyQuote || !kalshiQuote || polyQuote.limitPrice === null || kalshiQuote.limitPrice === null) {
    return null;
  }

  const totalCostUsd = polyQuote.costUsd + kalshiQuote.costUsd;
  const worstFillCostUsd = polyQuote.worstFillCostUsd + kalshiQuote.worstFillCostUsd;
  const projectedNetProfitUsd = round4(pairSize - totalCostUsd);
  const projectedNetReturn = totalCostUsd > 0 ? round4(projectedNetProfitUsd / totalCostUsd) : null;
  if (!doesSizingMeetProfitThresholds(projectedNetProfitUsd, projectedNetReturn, settings)) {
    return null;
  }
  const legs = intent.legs.map((leg) => {
    const quote = leg.venue === "polymarket" ? polyQuote : kalshiQuote;
    return {
      ...leg,
      requestedPrice: quote.limitPrice,
      requestedSize: pairSize,
      requestedNotionalUsd: quote.notionalUsd,
    };
  }) as OrderIntent["legs"];
  const conservativeExpectedPnlUsd =
    intent.mismatchPFatalUpper === null || intent.mismatchPFatalUpper === undefined
      ? (intent.conservativeExpectedPnlUsd ?? null)
      : round4(pairSize * (1 - intent.mismatchPFatalUpper) - worstFillCostUsd);

  return {
    ...intent,
    updatedAt: now,
    grossCost: round4((polyQuote.notionalUsd + kalshiQuote.notionalUsd) / pairSize),
    targetNotionalUsd: round4(polyQuote.notionalUsd + kalshiQuote.notionalUsd),
    projectedNetProfitUsd,
    fatalMismatchPnlUsd: round4(-worstFillCostUsd),
    conservativeExpectedPnlUsd,
    fatalLossExposureUsd: round4(worstFillCostUsd),
    legs,
  };
}

function buildEntryDepthCheck(
  leg: OrderIntent["legs"][number],
  liveLeg: ReturnType<typeof getLiveIntentLegSnapshot>,
  settings: StrategyConfig,
): EntryDepthCheck {
  const displayedDepth = liveLeg?.depth ?? null;
  const executableDepth = deriveEntryExecutableDepth(leg, displayedDepth, settings);
  return {
    venue: leg.venue,
    requestedSize: leg.requestedSize,
    livePrice: liveLeg?.price ?? null,
    displayedDepth,
    executableDepth,
    coverageRatio: leg.requestedSize > 0 ? executableDepth / leg.requestedSize : 0,
  };
}

function deriveEntryExecutableDepth(
  leg: Pick<OrderIntent["legs"][number], "venue" | "side">,
  displayedDepth: number | null,
  settings: Pick<
    StrategyConfig,
    | "kalshiPrimaryDepthSafetyFactor"
    | "kalshiDepthHeadroomContracts"
    | "polymarketHedgeDepthSafetyFactor"
    | "polymarketHedgeHeadroomShares"
  >,
) {
  if (displayedDepth === null || !Number.isFinite(displayedDepth) || displayedDepth <= 0) {
    return 0;
  }

  if (leg.venue === "kalshi") {
    return (
      getVenueExecutableDepth(
        "kalshi",
        applyKalshiPrimaryDepthSafetyFactor(displayedDepth, settings.kalshiPrimaryDepthSafetyFactor),
        settings.kalshiDepthHeadroomContracts,
      ) ?? 0
    );
  }

  if (leg.venue === "polymarket" && leg.side === "BUY") {
    return deriveSafePolymarketHedgeDepth(
      displayedDepth,
      settings.polymarketHedgeDepthSafetyFactor,
      settings.polymarketHedgeHeadroomShares,
    );
  }

  return displayedDepth;
}

export function deriveAdaptiveSlippageBps(
  coverageRatio: number,
  settings: Pick<
    StrategyConfig,
    "adaptiveSlippageTightBps" | "adaptiveSlippageDefaultBps" | "adaptiveSlippageThinBps" | "maxSlippageBps"
  >,
) {
  if (coverageRatio >= 2) {
    return Math.min(settings.maxSlippageBps, settings.adaptiveSlippageTightBps);
  }
  if (coverageRatio >= 1) {
    return Math.min(settings.maxSlippageBps, settings.adaptiveSlippageDefaultBps);
  }
  return Math.min(settings.maxSlippageBps, settings.adaptiveSlippageThinBps);
}

async function resolveAdaptiveSlippageForLiveLeg(
  leg: OrderIntent["legs"][number],
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
) {
  const marketState = await marketDataSupervisor.readSlotState(slot, now);
  const { polymarket: polymarketState, kalshi: kalshiState } = marketState;
  const liveLeg = getLiveIntentLegSnapshot(leg, polymarketState.quote, kalshiState.quote);
  const check = buildEntryDepthCheck(leg, liveLeg, settings);
  return {
    maxSlippageBps: deriveAdaptiveSlippageBps(check.coverageRatio, settings),
    marketState,
  };
}

export function getPolymarketHedgeMinNotionalViolation(
  hedgeLeg: Pick<OrderIntent["legs"][number], "venue" | "side" | "requestedNotionalUsd">,
) {
  if (
    hedgeLeg.venue !== "polymarket" ||
    hedgeLeg.side !== "BUY" ||
    hedgeLeg.requestedNotionalUsd + ORDER_SIZE_TOLERANCE >= POLYMARKET_MIN_MARKET_BUY_AMOUNT_USD
  ) {
    return null;
  }

  return {
    requestedNotionalUsd: round4(hedgeLeg.requestedNotionalUsd),
    minimumNotionalUsd: POLYMARKET_MIN_MARKET_BUY_AMOUNT_USD,
  };
}

export function getPolymarketHedgeSubmissionBlock(
  hedgeLeg: Pick<OrderIntent["legs"][number], "venue" | "side" | "requestedNotionalUsd">,
) {
  const violation = getPolymarketHedgeMinNotionalViolation(hedgeLeg);
  return violation
    ? {
        action: "manual_required" as const,
        stage: "polymarket_hedge_below_minimum_notional",
        ...violation,
      }
    : null;
}

export function sumPolymarketAskDepthWithinLimit(asks: Array<{ price: string; size: string }>, limitPrice: number) {
  return round4(
    asks.reduce((sum, level) => {
      const price = Number(level.price);
      const size = Number(level.size);
      if (!Number.isFinite(price) || !Number.isFinite(size) || price > limitPrice + ORDER_SIZE_TOLERANCE) {
        return sum;
      }

      return sum + size;
    }, 0),
  );
}

export function deriveSafePolymarketHedgeDepth(rawDepth: number, safetyFactor: number, headroomShares: number) {
  if (!Number.isFinite(rawDepth) || rawDepth <= 0) {
    return 0;
  }

  return round4(Math.max(0, rawDepth * safetyFactor - Math.max(0, headroomShares)));
}

export function quotePolymarketBuyFromAsks(
  asks: Array<{ price: string; size: string }>,
  limitPrice: number,
  targetSize: number,
) {
  if (targetSize <= 0) {
    return {
      filledSize: 0,
      costUsd: 0,
      vwap: null,
    };
  }

  let remaining = targetSize;
  let filledSize = 0;
  let costUsd = 0;
  const sortedAsks = [...asks]
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter(
      (level) =>
        Number.isFinite(level.price) &&
        Number.isFinite(level.size) &&
        level.size > 0 &&
        level.price <= limitPrice + ORDER_SIZE_TOLERANCE,
    )
    .sort((left, right) => left.price - right.price);

  for (const level of sortedAsks) {
    if (remaining <= ORDER_SIZE_TOLERANCE) {
      break;
    }

    const fillSize = Math.min(remaining, level.size);
    filledSize += fillSize;
    costUsd += fillSize * level.price;
    remaining -= fillSize;
  }

  return {
    filledSize: roundToSixDecimals(filledSize),
    costUsd: round4(costUsd),
    vwap: filledSize > 0 ? round4(costUsd / filledSize) : null,
  };
}

type RecoveryDecision = "rescue_hedge_full" | "rescue_hedge_partial" | "unwind" | "hold_to_settlement";

export function estimateRescueHedgeLossUsd(input: {
  primaryEntryPrice: number | null;
  hedgePrice: number | null;
  size: number;
  primaryFeeUsd?: number | null;
  hedgeFeeUsd?: number | null;
}) {
  if (input.primaryEntryPrice === null || input.hedgePrice === null || input.size <= 0) {
    return null;
  }

  const primaryFeeUsd = input.primaryFeeUsd ?? 0;
  const hedgeFeeUsd = input.hedgeFeeUsd ?? 0;
  return round4(
    Math.max(
      0,
      input.size * input.primaryEntryPrice + input.size * input.hedgePrice + primaryFeeUsd + hedgeFeeUsd - input.size,
    ),
  );
}

export function deriveFeeSafePolymarketRescuePrice(input: {
  maximumBuyPrice: number;
  tickSize: number;
  size: number;
  entryPrice: number;
  allocatedEntryFeeUsd: number;
  fee: Extract<RecoveryFeeSchedule, { venue: "polymarket" }>;
  maxLossUsd: number;
}) {
  const cap = normalizePolymarketBuyPriceCap({
    maximumBuyPrice: input.maximumBuyPrice,
    tickSize: input.tickSize,
  });
  if (!cap.ok) {
    return { ok: false as const, code: cap.code, reason: cap.reason };
  }

  for (let tickIndex = cap.tickIndex; tickIndex > 0; tickIndex -= 1) {
    const candidatePrice = tickIndex * input.tickSize;
    const orderPrice = derivePolymarketRecoveryOrderPrice({
      referencePrice: candidatePrice,
      tickSize: input.tickSize,
      side: "BUY",
      ticks: 0,
      maximumBuyPrice: candidatePrice,
    });
    if (!orderPrice.ok) {
      continue;
    }
    const economics = evaluateRecoveryLossCap({
      action: "rescue",
      orderPrice,
      size: input.size,
      entryPrice: input.entryPrice,
      allocatedEntryFeeUsd: input.allocatedEntryFeeUsd,
      fee: input.fee,
      maxLossUsd: input.maxLossUsd,
    });
    if (economics.allowed) {
      return { ok: true as const, orderPrice, economics };
    }
  }

  return {
    ok: false as const,
    code: "loss_cap_exceeded" as const,
    reason: "No authoritative Polymarket BUY tick remains inside the fee-inclusive recovery loss cap",
  };
}

export function isHedgedPairEconomicsWithinLossCap(
  economics: ReturnType<typeof deriveHedgedPairEconomics>,
  maximumAcceptedLossUsd = 0,
) {
  if (economics.polymarketFilledSize <= ORDER_SIZE_TOLERANCE || economics.kalshiFilledSize <= ORDER_SIZE_TOLERANCE) {
    return false;
  }
  return maximumAcceptedLossUsd > 0
    ? economics.netWorstCaseUsd + maximumAcceptedLossUsd >= -ORDER_SIZE_TOLERANCE
    : economics.netWorstCaseUsd > ORDER_SIZE_TOLERANCE;
}

export function evaluateExposureRecoveryOptions(input: {
  rescueHedgeLossUsd: number | null;
  rescueHedgeSize: number;
  unhedgedSize: number;
  unwindLossUsd: number | null;
  holdExpectedLossUsd: number | null;
  holdWorstCaseLossUsd: number | null;
  hedgeRescueMaxLossUsd: number;
  hedgeRescueMinAdvantageUsd: number;
  secondsToSettlement: number;
  holdWindowSeconds: number;
  allowPartial: boolean;
}) {
  const fullHedge =
    input.rescueHedgeSize + ORDER_SIZE_TOLERANCE >= input.unhedgedSize &&
    input.rescueHedgeLossUsd !== null &&
    input.rescueHedgeLossUsd <= input.hedgeRescueMaxLossUsd + ORDER_SIZE_TOLERANCE;
  if (fullHedge) {
    return {
      decision: "rescue_hedge_full" as RecoveryDecision,
      reason: "full_hedge_within_loss_cap",
    };
  }

  const partialHedge =
    input.allowPartial &&
    input.rescueHedgeSize > ORDER_SIZE_TOLERANCE &&
    input.rescueHedgeLossUsd !== null &&
    input.rescueHedgeLossUsd <= input.hedgeRescueMaxLossUsd + ORDER_SIZE_TOLERANCE &&
    (input.unwindLossUsd === null ||
      input.rescueHedgeLossUsd + input.hedgeRescueMinAdvantageUsd <= input.unwindLossUsd);
  if (partialHedge) {
    return {
      decision: "rescue_hedge_partial" as RecoveryDecision,
      reason: "partial_hedge_cheaper_than_unwind",
    };
  }

  const holdToSettlement =
    input.secondsToSettlement >= 0 &&
    input.secondsToSettlement <= input.holdWindowSeconds &&
    input.holdExpectedLossUsd !== null &&
    input.holdWorstCaseLossUsd !== null &&
    input.holdWorstCaseLossUsd <= input.hedgeRescueMaxLossUsd + ORDER_SIZE_TOLERANCE &&
    (input.unwindLossUsd === null ||
      input.holdExpectedLossUsd + input.hedgeRescueMinAdvantageUsd <= input.unwindLossUsd) &&
    (input.rescueHedgeLossUsd === null ||
      input.holdExpectedLossUsd + input.hedgeRescueMinAdvantageUsd <= input.rescueHedgeLossUsd);
  if (holdToSettlement) {
    return {
      decision: "hold_to_settlement" as RecoveryDecision,
      reason: "hold_ev_better_near_settlement",
    };
  }

  return {
    decision: "unwind" as RecoveryDecision,
    reason: "unwind_best_available_recovery",
  };
}

async function attemptHedgeRescueBeforeUnwind(intent: OrderIntent, settings: StrategyConfig, now: number) {
  if (!settings.hedgeRescueEnabled) {
    return { intent, recovered: false, hold: false };
  }

  let currentIntent = resizeHedgeLegToUnhedgedPrimary(intent, now);
  let primaryLeg = currentIntent.legs.find((leg) => leg.venue === currentIntent.primaryVenue);
  let hedgeLeg = currentIntent.legs.find((leg) => leg.venue === currentIntent.hedgeVenue);
  if (
    !primaryLeg ||
    !hedgeLeg ||
    primaryLeg.filledSize <= 0 ||
    hedgeLeg.venue !== "polymarket" ||
    hedgeLeg.side !== "BUY" ||
    !hedgeLeg.tokenId
  ) {
    return { intent: currentIntent, recovered: false, hold: false };
  }

  const maxRescueLossUsd = Math.min(
    settings.hedgeRescueMaxLossUsd,
    settings.forcedUnwindMaxLossUsd > 0 ? settings.forcedUnwindMaxLossUsd : settings.hedgeRescueMaxLossUsd,
  );
  const slot = deriveCanonicalIntentSlot(currentIntent);

  for (let attempt = 1; attempt <= settings.hedgeRescueMaxAttempts; attempt += 1) {
    if (attempt > 1 && settings.hedgeRescueDelayMs > 0) {
      await sleep(settings.hedgeRescueDelayMs);
    }

    const attemptNow = Date.now();
    currentIntent = resizeHedgeLegToUnhedgedPrimary(currentIntent, attemptNow);
    primaryLeg = currentIntent.legs.find((leg) => leg.venue === currentIntent.primaryVenue);
    hedgeLeg = currentIntent.legs.find((leg) => leg.venue === currentIntent.hedgeVenue);
    if (!primaryLeg || !hedgeLeg || !hedgeLeg.tokenId) {
      return { intent: currentIntent, recovered: false, hold: false };
    }

    const unhedgedSize = deriveUnhedgedPrimarySize(currentIntent);
    if (unhedgedSize <= ORDER_SIZE_TOLERANCE) {
      currentIntent = await markIntentHedgedAfterEconomicCheck(
        currentIntent,
        attemptNow,
        "hedge_rescue_already_complete",
        null,
        {},
        maxRescueLossUsd,
      );
      await writeRunEvent({
        asset: currentIntent.asset,
        level: "info",
        eventType: "order.hedge_rescue.completed",
        message: `Hedge rescue completed for intent ${currentIntent.id}`,
        payload: {
          intentId: currentIntent.id,
          slotKey: currentIntent.slotKey,
          attempt,
          unhedgedSize,
        },
        createdAt: attemptNow,
      });
      return { intent: currentIntent, recovered: currentIntent.status === "hedged", hold: false };
    }

    const primaryEntryPrice = primaryLeg.filledPrice;
    if (primaryEntryPrice === null) {
      return { intent: currentIntent, recovered: false, hold: false };
    }

    const rescueMarketState = await marketDataSupervisor.readSlotState(slot, attemptNow);
    const marketProof = validateRecoveryLegMarketState({
      intent: currentIntent,
      leg: hedgeLeg,
      slot,
      marketState: rescueMarketState,
      orderSide: "BUY",
      settings,
      now: attemptNow,
    });
    if (!marketProof.allowed || marketProof.venue !== "polymarket") {
      await writeRunEvent({
        asset: currentIntent.asset,
        level: "warn",
        eventType: "order.hedge_rescue.market_proof_rejected",
        message: `Hedge rescue market proof rejected for intent ${currentIntent.id}`,
        payload: {
          intentId: currentIntent.id,
          slotKey: currentIntent.slotKey,
          attempt,
          code: marketProof.allowed ? "venue_mismatch" : marketProof.code,
          reason: marketProof.allowed ? "Expected Polymarket recovery proof" : marketProof.reason,
        },
        createdAt: attemptNow,
      });
      return { intent: currentIntent, recovered: false, hold: false };
    }

    const fee = buildRecoveryFeeSchedule(hedgeLeg, rescueMarketState);
    if (fee.venue !== "polymarket") {
      throw new Error(`Polymarket rescue received a ${fee.venue} fee schedule`);
    }
    const normalizedTargetSize = Math.min(
      unhedgedSize,
      normalizeVenueTargetSize("polymarket", unhedgedSize, null, settings.minOrderSize),
    );
    if (normalizedTargetSize <= ORDER_SIZE_TOLERANCE) {
      return { intent: currentIntent, recovered: false, hold: false };
    }
    const allocatedEntryFeeUsd = allocateRecoveryEntryFeeUsd(primaryLeg, normalizedTargetSize);
    const rawMaximumBuyPrice = 1 - primaryEntryPrice + (maxRescueLossUsd - allocatedEntryFeeUsd) / normalizedTargetSize;
    const maximumBuyPrice = Math.min(1 - Number.EPSILON, rawMaximumBuyPrice);
    const safePricing =
      maximumBuyPrice > 0
        ? deriveFeeSafePolymarketRescuePrice({
            maximumBuyPrice,
            tickSize: marketProof.tickSize,
            size: normalizedTargetSize,
            entryPrice: primaryEntryPrice,
            allocatedEntryFeeUsd,
            fee,
            maxLossUsd: maxRescueLossUsd,
          })
        : {
            ok: false as const,
            code: "loss_cap_exceeded" as const,
            reason: "Entry cost and fees consume the entire rescue loss budget",
          };
    const maxHedgePrice = safePricing.ok ? safePricing.orderPrice.price : null;
    const asks =
      (hedgeLeg.outcome === "UP"
        ? rescueMarketState.polymarket.quote.orderbookLevels?.upAsks
        : rescueMarketState.polymarket.quote.orderbookLevels?.downAsks
      )?.map(([price, size]) => ({ price: String(price), size: String(size) })) ?? [];
    const rawDepth = maxHedgePrice === null ? 0 : sumPolymarketAskDepthWithinLimit(asks, maxHedgePrice);
    const executableDepth = deriveSafePolymarketHedgeDepth(
      rawDepth,
      settings.polymarketHedgeDepthSafetyFactor,
      settings.polymarketHedgeHeadroomShares,
    );
    const minimumHedgeSize = getVenueMinimumOrderSize("polymarket", null, settings.minOrderSize);
    const quote =
      maxHedgePrice === null
        ? { filledSize: 0, costUsd: 0, vwap: null }
        : quotePolymarketBuyFromAsks(asks, maxHedgePrice, normalizedTargetSize);
    const fullExecutableRescue =
      normalizedTargetSize + ORDER_SIZE_TOLERANCE >= unhedgedSize &&
      executableDepth + ORDER_SIZE_TOLERANCE >= normalizedTargetSize &&
      quote.filledSize + ORDER_SIZE_TOLERANCE >= normalizedTargetSize;
    const hedgeLossUsd = safePricing.ok && fullExecutableRescue ? safePricing.economics.worstCaseLossUsd : null;
    const hedgeFeeUsd = safePricing.ok ? safePricing.economics.orderFeeUsd : null;
    const unwindEstimate = await estimatePrimaryUnwindRecoveryLoss(currentIntent, primaryLeg, attemptNow, settings);
    const holdEstimate = await estimateHoldToSettlementLoss(currentIntent, primaryLeg, attemptNow);
    const secondsToSettlement = Math.ceil((currentIntent.slotEndTs - attemptNow) / 1_000);
    const decision = evaluateExposureRecoveryOptions({
      rescueHedgeLossUsd: hedgeLossUsd,
      rescueHedgeSize: fullExecutableRescue ? normalizedTargetSize : quote.filledSize,
      unhedgedSize,
      unwindLossUsd: unwindEstimate.expectedLossUsd,
      holdExpectedLossUsd: holdEstimate.expectedLossUsd,
      holdWorstCaseLossUsd: holdEstimate.worstCaseLossUsd,
      hedgeRescueMaxLossUsd: maxRescueLossUsd,
      hedgeRescueMinAdvantageUsd: settings.hedgeRescueMinAdvantageUsd,
      secondsToSettlement,
      holdWindowSeconds: settings.forcedUnwindHoldSecondsToSettlement,
      allowPartial: false,
    });

    await writeRunEvent({
      asset: currentIntent.asset,
      level: "info",
      eventType: "order.hedge_rescue.evaluated",
      message: `Hedge rescue evaluated for intent ${currentIntent.id}`,
      payload: {
        intentId: currentIntent.id,
        slotKey: currentIntent.slotKey,
        attempt,
        decision: decision.decision,
        reason: decision.reason,
        unhedgedSize,
        rawDepth,
        executableDepth,
        targetSize: normalizedTargetSize,
        quote,
        maxHedgePrice,
        maximumBuyPrice,
        pricePolicy: safePricing,
        hedgeFeeUsd,
        hedgeLossUsd,
        unwindLossUsd: unwindEstimate.expectedLossUsd,
        holdExpectedLossUsd: holdEstimate.expectedLossUsd,
        holdWorstCaseLossUsd: holdEstimate.worstCaseLossUsd,
        secondsToSettlement,
      },
      createdAt: Date.now(),
    });
    await writeRunEvent({
      asset: currentIntent.asset,
      level: decision.decision === "unwind" ? "warn" : "info",
      eventType: "order.recovery.decision",
      message: `Recovery decision ${decision.decision} for intent ${currentIntent.id}`,
      payload: {
        intentId: currentIntent.id,
        slotKey: currentIntent.slotKey,
        attempt,
        decision: decision.decision,
        reason: decision.reason,
        unhedgedSize,
        hedgeLossUsd,
        hedgeFeeUsd,
        unwindLossUsd: unwindEstimate.expectedLossUsd,
        holdExpectedLossUsd: holdEstimate.expectedLossUsd,
        holdWorstCaseLossUsd: holdEstimate.worstCaseLossUsd,
      },
      createdAt: Date.now(),
    });

    if (decision.decision === "hold_to_settlement") {
      await writeRunEvent({
        asset: currentIntent.asset,
        level: "warn",
        eventType: "order.recovery.hold_to_settlement",
        message: `Recovery held to settlement for intent ${currentIntent.id}`,
        payload: {
          intentId: currentIntent.id,
          slotKey: currentIntent.slotKey,
          unhedgedSize,
          holdExpectedLossUsd: holdEstimate.expectedLossUsd,
          holdWorstCaseLossUsd: holdEstimate.worstCaseLossUsd,
          unwindLossUsd: unwindEstimate.expectedLossUsd,
        },
        createdAt: Date.now(),
      });
      return { intent: currentIntent, recovered: false, hold: true };
    }

    if (decision.decision !== "rescue_hedge_full") {
      return { intent: currentIntent, recovered: false, hold: false };
    }

    if (!safePricing.ok || normalizedTargetSize + ORDER_SIZE_TOLERANCE < minimumHedgeSize) {
      return { intent: currentIntent, recovered: false, hold: false };
    }

    const rescueLeg = {
      ...hedgeLeg,
      requestedPrice: safePricing.orderPrice.price,
      requestedSize: normalizedTargetSize,
      requestedNotionalUsd: round4(normalizedTargetSize * safePricing.orderPrice.price),
    };
    const orderType = "FOK";
    const rescueRequest = buildVenueOrderRequest(rescueLeg, 0, orderType, false, {
      overridePrice: safePricing.orderPrice.price,
      authoritativeTickSize: marketProof.tickSize,
    });
    if (rescueRequest.price !== safePricing.orderPrice.price) {
      throw new Error(`Authoritative rescue price changed while building request for ${currentIntent.id}`);
    }
    let rescueOrder: LiveOrder;
    currentIntent = markIntentStatus(
      currentIntent,
      "rescue_hedge",
      Date.now(),
      "Attempting full hedge rescue before primary unwind",
    );
    currentIntent = await writeOrderIntent(currentIntent);
    try {
      const rescueExecution = await submitAndConfirmOrder({
        intent: currentIntent,
        leg: rescueLeg,
        request: rescueRequest,
        stage: `hedge_rescue:${attempt}`,
        now: Date.now(),
        timeoutMs: settings.immediateOrderConfirmationTimeoutMs,
        quoteObservedAt: marketProof.bookObservedAt,
        submissionDeadlineAt: marketProof.validUntil,
      });
      rescueOrder = rescueExecution.order;
    } catch (error) {
      if (error instanceof OrderSubmissionNotStartedError) {
        await writeRunEvent({
          asset: currentIntent.asset,
          level: "warn",
          eventType: "order.hedge_rescue.submission_not_started",
          message: `Hedge rescue submission was rejected before the venue request for intent ${currentIntent.id}`,
          payload: {
            intentId: currentIntent.id,
            slotKey: currentIntent.slotKey,
            attempt,
            attemptId: error.attemptId,
            reason: error.reason,
            orderType,
          },
          createdAt: Date.now(),
        });
        continue;
      }
      const ambiguousSubmissionAt = Date.now();
      const errorMessage = toErrorMessage(error);
      await writeRunEvent({
        asset: currentIntent.asset,
        level: "error",
        eventType: "order.hedge_rescue.submit_failed",
        message: `Hedge rescue submission truth is unknown for intent ${currentIntent.id}`,
        payload: {
          intentId: currentIntent.id,
          slotKey: currentIntent.slotKey,
          attempt,
          orderType,
          error: errorMessage,
        },
        createdAt: ambiguousSubmissionAt,
      });
      currentIntent = await markIntentManualRequired(
        currentIntent,
        ambiguousSubmissionAt,
        "hedge_rescue_submission_truth_unknown",
        `Polymarket hedge rescue may have reached the venue before the submission error (${errorMessage})`,
        {
          attempt,
          orderType,
          error: errorMessage,
        },
      );
      return { intent: currentIntent, recovered: false, hold: true };
    }
    await writeRunEvent({
      asset: currentIntent.asset,
      level: rescueOrder.filledSize > 0 ? "warn" : "info",
      eventType: "order.hedge_rescue.submitted",
      message: `Hedge rescue ${orderType} submitted for intent ${currentIntent.id}`,
      payload: {
        intentId: currentIntent.id,
        slotKey: currentIntent.slotKey,
        attempt,
        orderType,
        orderId: rescueOrder.venueOrderId,
        orderStatus: rescueOrder.status,
        requestedSize: rescueOrder.requestedSize,
        filledSize: rescueOrder.filledSize,
        averageFillPrice: rescueOrder.averageFillPrice,
      },
      createdAt: Date.now(),
    });

    if (shouldHoldHedgeRescueOrderPendingTruth(currentIntent, hedgeLeg, rescueOrder, Date.now())) {
      const pendingTruthAt = Date.now();
      currentIntent = await holdPolymarketHedgeFailurePendingTruth(
        currentIntent,
        hedgeLeg,
        rescueOrder,
        pendingTruthAt,
        "hedge_rescue_truth_pending",
        {
          attempt,
          orderType,
          orderId: rescueOrder.venueOrderId,
          orderStatus: rescueOrder.status,
          requestedSize: rescueOrder.requestedSize,
          filledSize: rescueOrder.filledSize,
        },
      );
      return { intent: currentIntent, recovered: false, hold: true };
    }

    if (rescueOrder.filledSize > 0) {
      const rescueFillObservedAt = Date.now();
      const observedIntent = accumulateIntentLegOrder(
        currentIntent,
        hedgeLeg.id,
        rescueOrder,
        "hedged",
        rescueFillObservedAt,
      );
      const evidence = await persistPostSubmissionIntentEvidence(
        observedIntent,
        rescueOrder,
        rescueFillObservedAt,
        "hedge_rescue_fill_persistence",
      );
      currentIntent = evidence.intent;
      if (!evidence.durable) {
        return { intent: currentIntent, recovered: false, hold: true };
      }
      try {
        currentIntent = await attachRecentPolymarketFillsSafely(currentIntent, "hedge", Date.now());
      } catch (error) {
        if (!(error instanceof OrderIntentRevisionConflictError)) {
          throw error;
        }
        await recordPostSubmissionIntentPersistenceIncident({
          intent: currentIntent,
          order: rescueOrder,
          stage: "hedge_rescue_fill_sync",
          error,
        });
        return {
          intent: (await findOrderIntent(currentIntent.id).catch(() => null)) ?? currentIntent,
          recovered: false,
          hold: true,
        };
      }
      const remainingSize = deriveUnhedgedPrimarySize(currentIntent);
      await writeRunEvent({
        asset: currentIntent.asset,
        level: remainingSize <= ORDER_SIZE_TOLERANCE ? "info" : "warn",
        eventType:
          remainingSize <= ORDER_SIZE_TOLERANCE ? "order.hedge_rescue.completed" : "order.hedge_rescue.partial_filled",
        message:
          remainingSize <= ORDER_SIZE_TOLERANCE
            ? `Hedge rescue completed for intent ${currentIntent.id}`
            : `Hedge rescue partially filled for intent ${currentIntent.id}`,
        payload: {
          intentId: currentIntent.id,
          slotKey: currentIntent.slotKey,
          attempt,
          orderId: rescueOrder.venueOrderId,
          filledSize: rescueOrder.filledSize,
          remainingSize,
        },
        createdAt: Date.now(),
      });

      if (remainingSize <= ORDER_SIZE_TOLERANCE) {
        const completedNow = Date.now();
        currentIntent = await markIntentHedgedAfterEconomicCheck(
          currentIntent,
          completedNow,
          "hedge_rescue_completed",
          rescueOrder,
          {
            maximumAcceptedLossUsd: maxRescueLossUsd,
          },
          maxRescueLossUsd,
        );
        if (currentIntent.status === "hedged") {
          await writeLiveTradeRunEvent(currentIntent, completedNow, "hedged");
        }
        return { intent: currentIntent, recovered: currentIntent.status === "hedged", hold: false };
      }

      currentIntent = await markIntentManualRequired(
        currentIntent,
        Date.now(),
        "hedge_rescue_partial_fill",
        `Full hedge rescue filled only partially; remaining hedge size ${remainingSize.toFixed(6)}`,
        {
          orderId: rescueOrder.venueOrderId,
          filledSize: rescueOrder.filledSize,
          remainingSize,
        },
      );
      return { intent: currentIntent, recovered: false, hold: true };
    }
  }

  return { intent: currentIntent, recovered: false, hold: false };
}

async function estimatePrimaryUnwindRecoveryLoss(
  intent: OrderIntent,
  primaryLeg: OrderIntent["legs"][number],
  now: number,
  settings: StrategyConfig,
) {
  const exitableSize = await resolvePrimaryExitSize(intent, primaryLeg, now).catch(() => 0);
  const unhedgedPrimarySize = deriveUnhedgedPrimarySize(intent);
  const requestedSize =
    unhedgedPrimarySize > ORDER_SIZE_TOLERANCE ? Math.min(exitableSize, unhedgedPrimarySize) : exitableSize;
  if (requestedSize <= 0 || primaryLeg.filledPrice === null || settings.forcedUnwindMaxLossUsd <= 0) {
    return { requestedSize, expectedExitPrice: null, expectedLossUsd: null };
  }

  try {
    const slot = deriveCanonicalIntentSlot(intent);
    const marketState = await marketDataSupervisor.readSlotState(slot, now);
    const proof = validateRecoveryLegMarketState({
      intent,
      leg: primaryLeg,
      slot,
      marketState,
      orderSide: "SELL",
      settings,
      now,
    });
    if (!proof.allowed) {
      return { requestedSize, expectedExitPrice: null, expectedLossUsd: null };
    }
    const referencePrice = applySlippage(proof.referencePrice, settings.maxSlippageBps, "SELL");
    const orderPrice =
      proof.venue === "polymarket"
        ? derivePolymarketRecoveryOrderPrice({
            referencePrice,
            tickSize: proof.tickSize,
            side: "SELL",
            ticks: 0,
          })
        : deriveKalshiRecoveryOrderPrice({
            referencePrice,
            outcome: proof.outcome,
            side: "SELL",
            ticks: 0,
            priceRanges: proof.priceRanges,
          });
    if (!orderPrice.ok) {
      return { requestedSize, expectedExitPrice: null, expectedLossUsd: null };
    }
    const economics = evaluateRecoveryLossCap({
      action: "unwind",
      orderPrice,
      size: requestedSize,
      entryPrice: primaryLeg.filledPrice,
      allocatedEntryFeeUsd: allocateRecoveryEntryFeeUsd(primaryLeg, requestedSize),
      fee: buildRecoveryFeeSchedule(primaryLeg, marketState),
      maxLossUsd: settings.forcedUnwindMaxLossUsd,
    });
    if (!("worstCaseLossUsd" in economics)) {
      return { requestedSize, expectedExitPrice: orderPrice.price, expectedLossUsd: null };
    }

    return {
      requestedSize,
      expectedExitPrice: orderPrice.price,
      expectedLossUsd: economics.worstCaseLossUsd,
    };
  } catch {
    return { requestedSize, expectedExitPrice: null, expectedLossUsd: null };
  }
}

async function estimateHoldToSettlementLoss(intent: OrderIntent, primaryLeg: OrderIntent["legs"][number], now: number) {
  const unhedgedPrimarySize = deriveUnhedgedPrimarySize(intent);
  if (unhedgedPrimarySize <= ORDER_SIZE_TOLERANCE || primaryLeg.filledPrice === null) {
    return {
      expectedLossUsd: null,
      worstCaseLossUsd: null,
    };
  }

  const liveExitPrice = await resolvePrimaryExitPrice(intent, primaryLeg, now).catch(() => null);
  const currentMark = liveExitPrice ?? primaryLeg.filledPrice;
  const entryCostUsd = unhedgedPrimarySize * primaryLeg.filledPrice;
  return {
    expectedLossUsd: round4(Math.max(0, entryCostUsd - unhedgedPrimarySize * currentMark)),
    worstCaseLossUsd: round4(entryCostUsd),
  };
}

async function attemptPrimaryUnwindAfterHedgeFailure(
  intent: OrderIntent,
  primaryLeg: OrderIntent["legs"][number],
  hedgeLeg: OrderIntent["legs"][number],
  hedgeOrder: LiveOrder | null,
  settings: StrategyConfig,
  now: number,
  failureReason: string,
  hedgeResult?: Awaited<ReturnType<VenueAdapter["placeOrder"]>>,
) {
  let currentIntent = hedgeOrder ? updateIntentLeg(intent, hedgeLeg.venue, hedgeOrder, "failed", now) : intent;
  if (shouldHoldPolymarketHedgeFailurePendingTruth(currentIntent, hedgeLeg, hedgeOrder ?? hedgeResult ?? null, now)) {
    return holdPolymarketHedgeFailurePendingTruth(
      currentIntent,
      hedgeLeg,
      hedgeOrder,
      now,
      "hedge_no_fill_truth_pending",
      {
        failureReason,
        orderStatus: hedgeOrder?.status ?? hedgeResult?.status ?? null,
        hedgeOrderId: hedgeOrder?.venueOrderId ?? hedgeResult?.venueOrderId ?? null,
      },
    );
  }

  const exposureResolution = await resolveHedgeExposureBeforePrimaryUnwind(currentIntent, hedgeOrder, settings, now);
  if (exposureResolution) {
    return exposureResolution;
  }

  currentIntent = markIntentStatus(currentIntent, "unwind_required", now, failureReason);
  currentIntent = await writeOrderIntent(currentIntent);
  await armHedgeFailureGuards(currentIntent, hedgeOrder, hedgeResult ?? null, now);

  const rescue = await attemptHedgeRescueBeforeUnwind(currentIntent, settings, Date.now());
  currentIntent = rescue.intent;
  if (rescue.recovered || rescue.hold) {
    return currentIntent;
  }

  const partiallyHedgedLeg = currentIntent.legs.find((leg) => leg.venue === currentIntent.hedgeVenue);
  const residualPrimarySize = deriveUnhedgedPrimarySize(currentIntent);
  if (residualPrimarySize <= ORDER_SIZE_TOLERANCE) {
    const maximumAcceptedLossUsd = Math.min(
      settings.hedgeRescueMaxLossUsd,
      settings.forcedUnwindMaxLossUsd > 0 ? settings.forcedUnwindMaxLossUsd : settings.hedgeRescueMaxLossUsd,
    );
    return markIntentHedgedAfterEconomicCheck(
      currentIntent,
      Date.now(),
      "hedge_rescue_covered_before_unwind",
      hedgeOrder,
      {
        maximumAcceptedLossUsd,
      },
      maximumAcceptedLossUsd,
    );
  }
  if ((partiallyHedgedLeg?.filledSize ?? 0) > ORDER_SIZE_TOLERANCE && residualPrimarySize > ORDER_SIZE_TOLERANCE) {
    return markIntentManualRequired(
      currentIntent,
      Date.now(),
      "partial_hedge_residual_unresolved",
      `Hedge rescue left ${residualPrimarySize.toFixed(6)} primary units uncovered; automatic full-intent unwind is unsafe`,
      {
        hedgeFilledSize: partiallyHedgedLeg?.filledSize ?? 0,
        residualPrimarySize,
      },
      hedgeOrder,
    );
  }

  if (shouldDeferPolymarketUnwindToSettlement(currentIntent, now)) {
    await writeRunEvent({
      level: "warn",
      eventType: "order.unwind.polymarket_deferred_to_settlement",
      message: `Polymarket primary unwind deferred to settlement/redeem for intent ${currentIntent.id}`,
      payload: {
        intentId: currentIntent.id,
        slotKey: currentIntent.slotKey,
        primaryVenue: currentIntent.primaryVenue,
        slotEndTs: currentIntent.slotEndTs,
        ageAfterSlotEndMs: now - currentIntent.slotEndTs,
      },
      createdAt: now,
    });
    return currentIntent;
  }

  const secondsToSettlement = Math.ceil((currentIntent.slotEndTs - now) / 1_000);
  const shouldHoldToSettlement =
    settings.forcedUnwindEnabled &&
    secondsToSettlement >= 0 &&
    secondsToSettlement <= settings.forcedUnwindHoldSecondsToSettlement;
  if (shouldHoldToSettlement) {
    await writeRunEvent({
      level: "warn",
      eventType: "order.unwind.forced_hold_to_settlement",
      message: `Primary unwind held to settlement for intent ${currentIntent.id}`,
      payload: {
        intentId: currentIntent.id,
        slotKey: currentIntent.slotKey,
        primaryVenue: currentIntent.primaryVenue,
        secondsToSettlement,
        thresholdSeconds: settings.forcedUnwindHoldSecondsToSettlement,
      },
      createdAt: now,
    });
    return currentIntent;
  }

  const currentPrimaryLeg = currentIntent.legs.find((leg) => leg.venue === currentIntent.primaryVenue) ?? primaryLeg;
  const unwindEstimate = await estimatePrimaryUnwindRecoveryLoss(
    currentIntent,
    currentPrimaryLeg,
    Date.now(),
    settings,
  );
  const unwindCapUsd = settings.forcedUnwindMaxLossUsd;
  if (
    unwindCapUsd <= 0 ||
    unwindEstimate.expectedLossUsd === null ||
    unwindEstimate.expectedLossUsd > unwindCapUsd + ORDER_SIZE_TOLERANCE
  ) {
    return markIntentManualRequired(
      currentIntent,
      Date.now(),
      "primary_unwind_loss_cap_blocked",
      unwindEstimate.expectedLossUsd === null
        ? "Primary unwind loss could not be estimated"
        : `Primary unwind expected loss ${unwindEstimate.expectedLossUsd.toFixed(4)} exceeds cap ${unwindCapUsd.toFixed(4)}`,
      {
        requestedSize: unwindEstimate.requestedSize,
        expectedExitPrice: unwindEstimate.expectedExitPrice,
        expectedLossUsd: unwindEstimate.expectedLossUsd,
        forcedUnwindMaxLossUsd: unwindCapUsd,
      },
      hedgeOrder,
    );
  }

  const normalAttempts = Math.max(1, settings.hedgeRetryAttempts);
  const forcedAttempts = settings.forcedUnwindEnabled ? Math.max(0, settings.forcedUnwindMaxAttempts) : 0;
  const maxAttempts = normalAttempts + forcedAttempts;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1 && settings.hedgeRetryDelayMs > 0) {
      await sleep(settings.hedgeRetryDelayMs);
    }
    const forcedAttempt = attempt > normalAttempts ? attempt - normalAttempts : 0;
    const force =
      forcedAttempt > 0
        ? {
            attempt: forcedAttempt,
            ticks:
              settings.forcedUnwindTickLadder[
                Math.min(forcedAttempt - 1, settings.forcedUnwindTickLadder.length - 1)
              ] ?? 0,
          }
        : undefined;

    let unwindResult: LiveOrder;
    try {
      unwindResult = await unwindPrimaryLeg(currentIntent, settings, Date.now(), attempt, force);
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      if (error instanceof OrderSubmissionNotStartedError) {
        await writeRunEvent({
          asset: currentIntent.asset,
          level: "warn",
          eventType: "order.unwind.submission_not_started",
          message: `Primary unwind submission was rejected before the venue request for intent ${currentIntent.id}`,
          payload: {
            intentId: currentIntent.id,
            venue: currentIntent.primaryVenue,
            attempt,
            attempts: maxAttempts,
            attemptId: error.attemptId,
            reason: error.reason,
          },
          createdAt: Date.now(),
        });
        if (attempt < maxAttempts) {
          continue;
        }
        currentIntent = await markIntentManualRequired(
          currentIntent,
          Date.now(),
          "primary_unwind_submission_window_exhausted",
          "Every primary unwind attempt expired before venue submission; manual intervention required",
          {
            venue: currentIntent.primaryVenue,
            attempts: maxAttempts,
            lastAttemptId: error.attemptId,
          },
          hedgeOrder,
        );
        break;
      }
      if (
        isPolymarketOrderbookUnavailableError(error) &&
        currentIntent.primaryVenue === "polymarket" &&
        currentIntent.slotEndTs + RESOLUTION_GRACE_MS <= now
      ) {
        currentIntent = await closeIntentAfterPolymarketOrderbookUnavailable(
          currentIntent,
          primaryLeg,
          now,
          errorMessage,
        );
        break;
      }

      if (isRetryablePolymarketInventorySyncError(error)) {
        currentIntent = markIntentStatus(
          currentIntent,
          "unwind_required",
          now,
          `Primary unwind waiting for inventory sync (${errorMessage})`,
        );
        currentIntent = await writeOrderIntent(currentIntent);
        await writeRunEvent({
          level: "warn",
          eventType: "order.unwind.inventory_sync_pending",
          message: `Primary unwind delayed for intent ${currentIntent.id}`,
          payload: {
            intentId: currentIntent.id,
            venue: currentIntent.primaryVenue,
            attempt,
            attempts: maxAttempts,
            forcedAttempt,
            error: errorMessage,
          },
          createdAt: now,
        });
        continue;
      }

      currentIntent = await markIntentManualRequired(
        currentIntent,
        now,
        "primary_unwind_submit_failed",
        `Primary unwind submission failed (${errorMessage}); manual intervention required`,
        {
          venue: currentIntent.primaryVenue,
          error: errorMessage,
        },
        hedgeOrder,
      );
      await writeRunEvent({
        level: "error",
        eventType: "order.unwind.submit_failed",
        message: `Primary unwind submission failed for intent ${currentIntent.id}`,
        payload: {
          intentId: currentIntent.id,
          venue: currentIntent.primaryVenue,
          error: errorMessage,
        },
        createdAt: now,
      });
      break;
    }

    await writeVenueOrder(unwindResult);

    if (shouldTreatPrimaryUnwindOrderAsComplete(unwindResult)) {
      await maybeWritePrimaryUnwindFilledSizeMismatchEvent(currentIntent, unwindResult, now);
      const averageExitPrice = unwindResult.averageFillPrice ?? primaryLeg.filledPrice ?? 0;
      const payoutUsd = round4(unwindResult.filledSize * averageExitPrice - (unwindResult.feeUsd ?? 0));
      currentIntent = markIntentStatus(
        {
          ...currentIntent,
          legs: currentIntent.legs.map((leg) =>
            leg.id === primaryLeg.id ? { ...leg, status: "unwound", payoutUsd } : leg,
          ) as OrderIntent["legs"],
        },
        "unwind_required",
        now,
        `${describeUnwoundAfterFailure(failureReason)}; awaiting final accounting fill evidence`,
      );
      currentIntent = await writeOrderIntent(currentIntent);
      await writeRunEvent({
        asset: currentIntent.asset,
        level: "info",
        eventType: "accounting.unwind.awaiting_fill_evidence",
        message: `Intent ${currentIntent.id} awaits immutable unwind fill evidence before terminalization`,
        payload: {
          intentId: currentIntent.id,
          venue: currentIntent.primaryVenue,
          unwindOrderId: unwindResult.venueOrderId,
        },
        createdAt: now,
      });
      break;
    }

    if (unwindResult.filledSize > 0) {
      currentIntent = markIntentStatus(
        currentIntent,
        "unwind_required",
        now,
        `Primary unwind partially filled (${unwindResult.status}); manual intervention required`,
      );
      currentIntent = await writeOrderIntent(currentIntent);
      await writeManualInterventionRunEvent(currentIntent, now, "primary_unwind_partial_fill", {
        venue: currentIntent.primaryVenue,
        orderId: unwindResult.venueOrderId,
        orderStatus: unwindResult.status,
      });
      await tripManualInterventionBreaker(currentIntent, now, hedgeOrder, "primary_unwind_partial_fill");
      break;
    }

    if (!isTerminalOrderStatus(unwindResult.status)) {
      await writeRunEvent({
        level: "warn",
        eventType: "order.unwind.awaiting_confirmation",
        message: `Primary unwind order ${unwindResult.venueOrderId} awaiting authoritative confirmation`,
        payload: {
          intentId: currentIntent.id,
          venue: currentIntent.primaryVenue,
          orderId: unwindResult.venueOrderId,
          orderStatus: unwindResult.status,
        },
        createdAt: now,
      });
      break;
    }

    if (attempt < maxAttempts) {
      await writeRunEvent({
        level: "warn",
        eventType: force ? "order.unwind.forced_retry_terminal" : "order.unwind.retry_terminal",
        message: `Primary unwind ${attempt}/${maxAttempts} ended without fill for intent ${currentIntent.id}`,
        payload: {
          intentId: currentIntent.id,
          venue: currentIntent.primaryVenue,
          orderId: unwindResult.venueOrderId,
          orderStatus: unwindResult.status,
          attempt,
          attempts: maxAttempts,
          forcedAttempt,
          forcedTicks: force?.ticks ?? null,
        },
        createdAt: now,
      });
      continue;
    }

    currentIntent = markIntentStatus(
      currentIntent,
      "unwind_required",
      now,
      `Primary unwind failed (${unwindResult.status}); manual intervention required`,
    );
    currentIntent = await writeOrderIntent(currentIntent);
    await writeManualInterventionRunEvent(currentIntent, now, "primary_unwind_failed", {
      venue: currentIntent.primaryVenue,
      orderId: unwindResult.venueOrderId,
      orderStatus: unwindResult.status,
    });
    await tripManualInterventionBreaker(currentIntent, now, hedgeOrder, "primary_unwind_failed");
  }

  return currentIntent;
}

async function resolveHedgeExposureBeforePrimaryUnwind(
  intent: OrderIntent,
  hedgeOrder: LiveOrder | null,
  settings: StrategyConfig,
  now: number,
) {
  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
  if (!primaryLeg || !hedgeLeg || primaryLeg.filledSize <= 0) {
    return null;
  }

  const overfilledHedgeSize = deriveOverfilledHedgeSize(intent);
  if (overfilledHedgeSize > ORDER_SIZE_TOLERANCE) {
    const acceptedIntent = await acceptBenignOverfilledHedge(
      intent,
      hedgeOrder,
      settings,
      now,
      "recovery_overhedged_accepted",
      "order.recovery.overhedged_accepted",
      `Accepted small overhedged recovery exposure for intent ${intent.id}`,
      {
        primaryVenue: intent.primaryVenue,
        hedgeVenue: intent.hedgeVenue,
        primaryFilledSize: primaryLeg.filledSize,
        hedgeFilledSize: hedgeLeg.filledSize,
        overfilledHedgeSize,
        hedgeOrderId: hedgeOrder?.venueOrderId ?? null,
        maxSlippageBps: settings.maxSlippageBps,
      },
    );
    if (acceptedIntent) {
      return acceptedIntent;
    }

    let currentIntent = markIntentStatus(
      intent,
      "manual_required",
      now,
      `Hedge exposure exceeds primary by ${overfilledHedgeSize.toFixed(6)}; manual intervention required`,
    );
    currentIntent = await writeOrderIntent(currentIntent);
    await writeRunEvent({
      asset: currentIntent.asset,
      level: "error",
      eventType: "order.recovery.overhedged",
      message: `Intent ${currentIntent.id} is overhedged; primary unwind blocked`,
      payload: {
        intentId: currentIntent.id,
        slotKey: currentIntent.slotKey,
        primaryVenue: currentIntent.primaryVenue,
        hedgeVenue: currentIntent.hedgeVenue,
        primaryFilledSize: primaryLeg.filledSize,
        hedgeFilledSize: hedgeLeg.filledSize,
        overfilledHedgeSize,
        hedgeOrderId: hedgeOrder?.venueOrderId ?? null,
        maxSlippageBps: settings.maxSlippageBps,
      },
      createdAt: now,
    });
    await writeManualInterventionRunEvent(currentIntent, now, "overhedged_primary_unwind_blocked", {
      primaryVenue: currentIntent.primaryVenue,
      hedgeVenue: currentIntent.hedgeVenue,
      primaryFilledSize: primaryLeg.filledSize,
      hedgeFilledSize: hedgeLeg.filledSize,
      overfilledHedgeSize,
      hedgeOrderId: hedgeOrder?.venueOrderId ?? null,
    });
    await tripManualInterventionBreaker(currentIntent, now, hedgeOrder, "overhedged_primary_unwind_blocked");
    return currentIntent;
  }

  const unhedgedPrimarySize = deriveUnhedgedPrimarySize(intent);
  if (unhedgedPrimarySize <= ORDER_SIZE_TOLERANCE && hedgeLeg.filledSize > 0) {
    const hedgedCandidate = {
      ...intent,
      legs: intent.legs.map((leg) =>
        leg.id === hedgeLeg.id
          ? {
              ...leg,
              status: "hedged",
            }
          : leg,
      ) as OrderIntent["legs"],
    };
    const currentIntent = await markIntentHedgedAfterEconomicCheck(
      hedgedCandidate,
      now,
      "recovery_hedge_truth_complete",
      hedgeOrder,
    );
    await writeRunEvent({
      asset: currentIntent.asset,
      level: "warn",
      eventType: "order.recovery.hedge_truth_complete",
      message: `Hedge exposure already covers primary for intent ${currentIntent.id}; primary unwind blocked`,
      payload: {
        intentId: currentIntent.id,
        slotKey: currentIntent.slotKey,
        primaryVenue: currentIntent.primaryVenue,
        hedgeVenue: currentIntent.hedgeVenue,
        primaryFilledSize: primaryLeg.filledSize,
        hedgeFilledSize: hedgeLeg.filledSize,
        hedgeOrderId: hedgeOrder?.venueOrderId ?? null,
      },
      createdAt: now,
    });
    if (currentIntent.status === "hedged") {
      await writeLiveTradeRunEvent(currentIntent, now, "hedged");
    }
    return currentIntent;
  }

  return null;
}

async function attemptPrimaryUnwindAfterHedgeFailureFromReconcile(
  intent: OrderIntent,
  primaryLeg: OrderIntent["legs"][number],
  hedgeLeg: OrderIntent["legs"][number],
  hedgeOrder: LiveOrder | null,
  settings: StrategyConfig,
  now: number,
  failureReason: string,
  fetchStates: VenueReconcileFetchStates | undefined,
  hedgeResult?: Awaited<ReturnType<VenueAdapter["placeOrder"]>>,
) {
  if (
    shouldHoldDestructiveReconcileForVenueTruth({
      venue: hedgeLeg.venue,
      fetchStates,
    })
  ) {
    return holdIntentForUnavailableVenueReconcileTruth({
      intent,
      venue: hedgeLeg.venue,
      orderStatus: hedgeOrder?.status ?? null,
      orderId: hedgeOrder?.venueOrderId ?? null,
      stage: "hedge_truth_for_primary_unwind_unavailable",
      now,
      fetchStates,
    });
  }

  if (
    shouldHoldDestructiveReconcileForVenueTruth({
      venue: primaryLeg.venue,
      fetchStates,
    })
  ) {
    return holdIntentForUnavailableVenueReconcileTruth({
      intent,
      venue: primaryLeg.venue,
      orderStatus: null,
      stage: "primary_unwind_reconcile_truth_unavailable",
      now,
      fetchStates,
    });
  }

  const lockResult = await tryWithGlobalLiveExecutionLock(`reconcile-unwind:${intent.asset}:${intent.id}`, () =>
    attemptPrimaryUnwindAfterHedgeFailure(
      intent,
      primaryLeg,
      hedgeLeg,
      hedgeOrder,
      settings,
      now,
      failureReason,
      hedgeResult,
    ),
  );

  if (lockResult.acquired) {
    return lockResult.value;
  }

  await recordExecutionLockBusy(intent.asset, intent.slotKey, now);
  return intent;
}

export function shouldTreatPrimaryUnwindOrderAsComplete(
  order: Pick<LiveOrder, "status" | "filledSize" | "requestedSize">,
) {
  return order.status === "filled" && order.filledSize > 0;
}

async function maybeWritePrimaryUnwindFilledSizeMismatchEvent(
  intent: OrderIntent,
  order: Pick<LiveOrder, "venue" | "venueOrderId" | "filledSize" | "requestedSize" | "status">,
  now: number,
) {
  if (order.filledSize + ORDER_SIZE_TOLERANCE >= order.requestedSize) {
    return;
  }

  await writeRunEvent({
    asset: intent.asset,
    level: "warn",
    eventType: "order.unwind.filled_size_mismatch",
    message: `Primary unwind order ${order.venueOrderId} reported filled below requested local size`,
    payload: {
      intentId: intent.id,
      slotKey: intent.slotKey,
      venue: order.venue,
      orderId: order.venueOrderId,
      orderStatus: order.status,
      requestedSize: order.requestedSize,
      filledSize: order.filledSize,
    },
    createdAt: now,
  });
}

async function tripManualInterventionBreaker(
  intent: OrderIntent,
  now: number,
  hedgeOrder: LiveOrder | null,
  stage: string,
) {
  await observeCircuitBreakerIncident(
    createExecutionIncident({
      asset: intent.asset,
      slotKey: intent.slotKey,
      intentId: intent.id,
      stage,
      reason: "hedge_failure",
      disposition: "manual_intervention",
      venue: intent.primaryVenue,
      orderId: hedgeOrder?.venueOrderId ?? null,
      triggeredAt: now,
    }),
  );
}

async function closeIntentWithoutExposureAccounting(input: {
  intent: OrderIntent;
  status: "failed" | "skipped" | "canceled";
  now: number;
  stage: string;
  reason: string;
  proof?: Record<string, unknown>;
}) {
  const head = await readAccountingHead(input.intent.id);
  if (!head) {
    throw new Error(`Accounting head missing for intent ${input.intent.id}`);
  }
  const terminalIntent: OrderIntent = {
    ...markIntentStatus(input.intent, input.status, input.now, input.reason),
    resolvedAt: input.intent.resolvedAt ?? input.now,
    realizedPnlUsd: 0,
    roi: null,
  };
  const proof = {
    schema: "warbitrer.no-exposure-proof.v1",
    stage: input.stage,
    reason: input.reason,
    intentRevision: input.intent.revision,
    legs: input.intent.legs.map((leg) => ({
      legId: leg.id,
      venue: leg.venue,
      venueOrderId: leg.venueOrderId,
      filledSize: leg.filledSize,
      status: leg.status,
    })),
    ...input.proof,
  };

  try {
    await closeIntentAccountingWithoutExposure({
      context: {
        actor: `engine.${input.stage}`,
        requestId: buildAccountingMutationRequestId(
          "close_no_exposure",
          input.intent.id,
          input.intent.revision,
          input.status,
          input.now,
          proof,
        ),
        occurredAt: input.now,
      },
      expectedHeadRevision: head.revision,
      expectedIntentRevision: input.intent.revision,
      terminalIntent,
      proof,
    });
  } catch (error) {
    const code = readAccountingPersistenceErrorCode(error);
    if (code === "exposure_present" || code === "unresolved_submission") {
      return markIntentManualRequired(
        input.intent,
        input.now,
        `accounting_no_exposure_${input.stage}`,
        `Intent cannot close without exposure proof (${toErrorMessage(error)})`,
        {
          requestedTerminalStatus: input.status,
          accountingErrorCode: code,
        },
      );
    }
    if (code === "revision_conflict" || code === "state_conflict") {
      const current = await findOrderIntent(input.intent.id);
      if (current && (current.status === "failed" || current.status === "skipped" || current.status === "canceled")) {
        return current;
      }
    }
    throw error;
  }

  const persisted = await findOrderIntent(input.intent.id);
  if (!persisted) {
    throw new Error(`Intent ${input.intent.id} disappeared after no-exposure accounting closure`);
  }
  return persisted;
}

async function finalizeTerminalIntentWithAccounting(input: {
  intent: OrderIntent;
  terminalIntent: OrderIntent;
  now: number;
  stage: string;
  stability: Record<string, unknown>;
}) {
  const { mutationNow, terminalIntent } = normalizeTerminalAccountingMutation(input);
  const head = await readAccountingHead(input.intent.id);
  if (!head) {
    throw new Error(`Accounting head missing for intent ${input.intent.id}`);
  }
  const operation = head.currentVersion === null ? "finalize" : "reaccount";
  let projectedTerminalIntent: OrderIntent | null = null;

  try {
    const fills = await readAccountingFillEvidenceForIntent(input.intent.id);
    const accounting = buildTerminalAccountingProjection({
      terminalIntent,
      fills,
      version: operation === "finalize" ? 1 : (head.currentVersion ?? 0) + 1,
      capturedAt: mutationNow,
      settlementObservedAt: mutationNow,
    });
    projectedTerminalIntent = accounting.terminalIntent;
    const persistenceInput = {
      context: {
        actor: `engine.${input.stage}`,
        requestId: buildAccountingMutationRequestId(
          operation,
          input.intent.id,
          input.intent.revision,
          accounting.projection.proofSha256,
          input.stability,
        ),
        occurredAt: mutationNow,
      },
      expectedHeadRevision: head.revision,
      expectedIntentRevision: input.intent.revision,
      terminalIntent: accounting.terminalIntent,
      ledgerInput: accounting.ledgerInput,
      stability: {
        schema: "warbitrer.accounting-stability.v1",
        stage: input.stage,
        observedAt: mutationNow,
        ...input.stability,
      },
    };
    if (operation === "finalize") {
      await finalizeIntentAccounting(persistenceInput);
    } else {
      await reaccountIntent(persistenceInput);
    }
  } catch (error) {
    const accountingCode =
      error instanceof AccountingLedgerError ? error.code : readAccountingPersistenceErrorCode(error);
    const [concurrentIntent, concurrentHead] = await Promise.all([
      findOrderIntent(input.intent.id).catch(() => null),
      readAccountingHead(input.intent.id).catch(() => null),
    ]);
    if (
      concurrentIntent &&
      concurrentHead &&
      projectedTerminalIntent &&
      concurrentHead.currentVersion !== null &&
      concurrentHead.currentVersion >= (operation === "finalize" ? 1 : (head.currentVersion ?? 0) + 1) &&
      isStableAccountingTerminalConcordant(concurrentIntent, concurrentHead, projectedTerminalIntent)
    ) {
      await writeRunEvent({
        asset: concurrentIntent.asset,
        level: "info",
        eventType: "accounting.terminalization.concurrent_commit_observed",
        message: `Accounting ${operation} was already committed for intent ${input.intent.id}`,
        payload: {
          intentId: input.intent.id,
          stage: input.stage,
          accountingVersion: concurrentHead.currentVersion,
          accountingProofSha256: concurrentHead.currentProofSha256,
          observedError: toErrorMessage(error),
        },
        createdAt: mutationNow,
      });
      return concurrentIntent;
    }
    await writeRunEvent({
      asset: input.intent.asset,
      level: "error",
      eventType: "accounting.terminalization.blocked",
      message: `Accounting ${operation} blocked for intent ${input.intent.id}`,
      payload: {
        intentId: input.intent.id,
        requestedStatus: terminalIntent.status,
        stage: input.stage,
        accountingCode,
        error: toErrorMessage(error),
      },
      createdAt: mutationNow,
    });
    if (!shouldEscalateAccountingTerminalizationFailure(input.intent)) {
      await writeRunEvent({
        asset: input.intent.asset,
        level: "warn",
        eventType: "accounting.terminalization.shadow_deferred",
        message: `Shadow accounting terminalization deferred for intent ${input.intent.id}`,
        payload: {
          intentId: input.intent.id,
          requestedStatus: terminalIntent.status,
          stage: input.stage,
          accountingCode,
          error: toErrorMessage(error),
        },
        createdAt: mutationNow,
      });
      return concurrentIntent ?? input.intent;
    }
    if (input.intent.status !== "settled" && input.intent.status !== "unwound") {
      return markIntentManualRequired(
        input.intent,
        mutationNow,
        `accounting_terminalization_${input.stage}`,
        `Stable accounting evidence is incomplete (${toErrorMessage(error)})`,
        {
          requestedStatus: terminalIntent.status,
          accountingCode,
        },
      );
    }
    await observeCircuitBreakerIncident(
      createExecutionIncident({
        asset: input.intent.asset,
        slotKey: input.intent.slotKey,
        intentId: input.intent.id,
        stage: `accounting_reaccount_${input.stage}`,
        reason: "venue_error",
        disposition: "manual_intervention",
        venue: input.intent.primaryVenue,
        triggeredAt: mutationNow,
      }),
    );
    return input.intent;
  }

  const persisted = await findOrderIntent(input.intent.id);
  if (!persisted) {
    throw new Error(`Intent ${input.intent.id} disappeared after accounting ${operation}`);
  }
  return persisted;
}

export function normalizeTerminalAccountingMutation(input: {
  intent: Pick<OrderIntent, "updatedAt">;
  terminalIntent: OrderIntent;
  now: number;
}) {
  const mutationNow = Math.max(
    input.now,
    input.intent.updatedAt,
    input.terminalIntent.updatedAt,
    input.terminalIntent.resolvedAt ?? 0,
  );
  return {
    mutationNow,
    terminalIntent: {
      ...input.terminalIntent,
      updatedAt: mutationNow,
    },
  };
}

export function shouldEscalateAccountingTerminalizationFailure(intent: Pick<OrderIntent, "shadow">) {
  return !intent.shadow;
}

export function isStableAccountingTerminalConcordant(
  current: OrderIntent,
  head: Pick<
    NonNullable<Awaited<ReturnType<typeof readAccountingHead>>>,
    "state" | "currentVersion" | "currentProofSha256"
  >,
  requested: OrderIntent,
) {
  if (
    head.state !== "stable" ||
    head.currentVersion === null ||
    head.currentProofSha256 === null ||
    current.status !== requested.status ||
    current.resolvedAt === null ||
    current.realizedPnlUsd === null ||
    (current.status !== "settled" && current.status !== "unwound")
  ) {
    return false;
  }
  if (current.status === "settled") {
    if (
      current.polyResolution !== requested.polyResolution ||
      current.kalshiResolution !== requested.kalshiResolution
    ) {
      return false;
    }
  }
  if (current.realizedPnlUsd !== requested.realizedPnlUsd || current.roi !== requested.roi) {
    return false;
  }
  if (current.legs.length !== requested.legs.length) {
    return false;
  }
  const requestedLegs = new Map(requested.legs.map((leg) => [leg.id, leg]));
  return current.legs.every((leg) => {
    const expected = requestedLegs.get(leg.id);
    return Boolean(
      expected &&
      leg.intentId === expected.intentId &&
      leg.venue === expected.venue &&
      leg.outcome === expected.outcome &&
      leg.marketRef === expected.marketRef &&
      (leg.tokenId ?? null) === (expected.tokenId ?? null) &&
      leg.side === expected.side &&
      leg.filledPrice === expected.filledPrice &&
      leg.filledSize === expected.filledSize &&
      leg.feeUsd === expected.feeUsd &&
      leg.status === expected.status &&
      leg.venueOrderId === expected.venueOrderId &&
      leg.payoutUsd === expected.payoutUsd &&
      leg.resolvedOutcome === expected.resolvedOutcome,
    );
  });
}

function readAccountingPersistenceErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") {
    return null;
  }
  return error.code;
}

async function markIntentManualRequired(
  intent: OrderIntent,
  now: number,
  stage: string,
  reason: string,
  payload: Record<string, unknown> = {},
  hedgeOrder: LiveOrder | null = null,
) {
  const failureReason = reason.toLowerCase().includes("manual intervention required")
    ? reason
    : `${reason}; manual intervention required`;
  let currentIntent = markIntentStatus(intent, "manual_required", now, failureReason);
  currentIntent = await writeOrderIntent(currentIntent);
  await recordMarketFillQualityForIntent(currentIntent, "manual_required", stage, now, payload);
  await writeManualInterventionRunEvent(currentIntent, now, stage, payload);
  await tripManualInterventionBreaker(currentIntent, now, hedgeOrder, stage);
  return currentIntent;
}

async function markIntentHedgedAfterEconomicCheck(
  intent: OrderIntent,
  now: number,
  stage: string,
  hedgeOrder: LiveOrder | null = null,
  extraPayload: Record<string, unknown> = {},
  maximumAcceptedLossUsd = 0,
) {
  const economics = deriveHedgedPairEconomics(intent.legs);
  if (!isHedgedPairEconomicsWithinLossCap(economics, maximumAcceptedLossUsd)) {
    let currentIntent = markIntentStatus(
      intent,
      "manual_required",
      now,
      `Hedged pair worst-case PnL ${economics.netWorstCaseUsd.toFixed(4)} USD; manual intervention required`,
    );
    currentIntent = await writeOrderIntent(currentIntent);
    await recordMarketFillQualityForIntent(currentIntent, "manual_required", "hedged_pair_economic_guard_failed", now, {
      stage,
      economics,
      ...extraPayload,
    });
    await writeRunEvent({
      asset: currentIntent.asset,
      level: "error",
      eventType: "intent.hedge.economic_guard_failed",
      message: `Intent ${currentIntent.id} failed the hedged-pair economic guard`,
      payload: {
        intentId: currentIntent.id,
        slotKey: currentIntent.slotKey,
        stage,
        primaryVenue: currentIntent.primaryVenue,
        hedgeVenue: currentIntent.hedgeVenue,
        economics,
        hedgeOrderId: hedgeOrder?.venueOrderId ?? null,
        ...extraPayload,
      },
      createdAt: now,
    });
    await writeManualInterventionRunEvent(currentIntent, now, "hedged_pair_economic_guard_failed", {
      stage,
      economics,
      hedgeOrderId: hedgeOrder?.venueOrderId ?? null,
      ...extraPayload,
    });
    await tripManualInterventionBreaker(currentIntent, now, hedgeOrder, "hedged_pair_economic_guard_failed");
    return currentIntent;
  }

  let currentIntent = markIntentStatus(intent, "hedged", now, null);
  currentIntent = await writeOrderIntent(currentIntent);
  await recordMarketFillQualityForIntent(
    currentIntent,
    stage.includes("rescue") ? "rescue" : "full_fill",
    stage,
    now,
    extraPayload,
  );
  return currentIntent;
}

async function reconcileVenueOrders(asset: MarketAsset, now: number, sharedContext: TickSharedContext = {}) {
  const candidateRecentOrders = sharedContext.recentVenueOrders
    ? sharedContext.recentVenueOrders.filter((order) => order.asset === asset).slice(0, 200)
    : await readRecentVenueOrders(200, asset);
  const historicalTerminalIntentIds = new Set(
    await readHistoricalTerminalLegacyPendingIntentIds(candidateRecentOrders.map((order) => order.intentId)),
  );
  const recentOrders = candidateRecentOrders.filter((order) => !historicalTerminalIntentIds.has(order.intentId));
  const reconcileData = sharedContext.venueOrderReconcileData ?? (await prefetchVenueOrderReconcileData());
  const { polyOpenOrders, kalshiOrders, polyTrades, kalshiFills } = reconcileData;
  const recentOrderByVenueId = new Map(recentOrders.map((order) => [`${order.venue}:${order.venueOrderId}`, order]));
  const touchedIntentLegs = new Set<string>();

  for (const order of polyOpenOrders) {
    const existing =
      recentOrderByVenueId.get(`polymarket:${order.id}`) ?? (await findVenueOrder("polymarket", order.id));
    if (!existing) {
      continue;
    }
    if (existing.asset !== asset) {
      continue;
    }
    const mappedOrder = {
      ...mapPolymarketOrder(order, existing.intentId, { asset: existing.asset }),
      intentId: existing.intentId,
      id: existing.id,
    };
    await writeVenueOrder({
      ...mappedOrder,
      filledSize: Math.max(existing.filledSize, mappedOrder.filledSize),
      averageFillPrice: mappedOrder.averageFillPrice ?? existing.averageFillPrice,
      status: mergePolymarketOrderStatusForNonDowngrade(existing, mappedOrder),
    });
  }

  for (const order of kalshiOrders) {
    const existing =
      recentOrderByVenueId.get(`kalshi:${order.order_id}`) ?? (await findVenueOrder("kalshi", order.order_id));
    if (!existing) {
      continue;
    }
    if (existing.asset !== asset) {
      continue;
    }
    const outcomePrice =
      existing.outcome === "YES" || existing.outcome === "NO"
        ? getKalshiOrderPriceUsd(existing.outcome, {
            yes_price_dollars: order.yes_price_dollars,
            no_price_dollars: order.no_price_dollars,
          })
        : null;
    const filledSize = Number(order.fill_count_fp ?? existing.filledSize);
    const explicitFeeUsd = getExplicitKalshiFeeUsd(order);
    const estimatedFeeUsd =
      explicitFeeUsd ??
      (await estimateKalshiFeeUsd({
        asset: existing.asset,
        contracts: filledSize,
        price: outcomePrice ?? existing.averageFillPrice,
        liquidity: "TAKER",
        now,
      }));
    await writeVenueOrder({
      ...existing,
      status: mapKalshiOrderStatus(order.status, filledSize, Number(order.remaining_count_fp ?? 0)),
      filledSize,
      averageFillPrice: outcomePrice ?? existing.averageFillPrice,
      feeUsd: Math.max(existing.feeUsd ?? 0, estimatedFeeUsd ?? 0),
      updatedAt: now,
      raw: order as unknown as Record<string, unknown>,
    });
  }

  for (const existingOrder of recentOrders.filter((order) => order.venue === "polymarket")) {
    const matchingTrades = extractPolymarketTradesForOrder(polyTrades, existingOrder.venueOrderId);
    if (matchingTrades.length === 0) {
      continue;
    }

    const usableMatchingTrades = [] as typeof matchingTrades;
    for (const trade of matchingTrades) {
      const mappingIssue = getPolymarketTradeOrderMappingIssue(trade, existingOrder.venueOrderId);
      if (!mappingIssue) {
        usableMatchingTrades.push(trade);
        continue;
      }

      reconcileData.fetchStates.polymarketFills = {
        ok: false,
        error: "Polymarket maker fill mapping is incomplete",
      };
      await writeRunEvent(
        buildSkippedInvalidPolymarketMakerFillEvent({
          asset: existingOrder.asset,
          intentId: existingOrder.intentId,
          venueOrderId: existingOrder.venueOrderId,
          tradeId: trade.id,
          issue: mappingIssue,
          now,
        }),
      );
    }

    const accountingTrades = usableMatchingTrades.filter(isConfirmedPolymarketTrade);
    const truth = resolvePolymarketOrderTruth({
      orderId: existingOrder.venueOrderId,
      order: extractPolymarketOpenOrderFromRaw(existingOrder.raw),
      trades: usableMatchingTrades,
      expectedSize: existingOrder.requestedSize,
      expectedSizeIsExact: existingOrder.side !== "BUY",
      orderType: existingOrder.orderType,
    });
    if (truth.effectiveFilledSize > 0) {
      await writeVenueOrder({
        ...existingOrder,
        status:
          truth.status === "filled" && truth.confirmedFilledSize > 0
            ? deriveConfirmedVenueOrderStatus(existingOrder, truth.confirmedFilledSize)
            : truth.status,
        filledSize: Math.max(existingOrder.filledSize, truth.effectiveFilledSize),
        averageFillPrice: truth.averageFillPrice ?? existingOrder.averageFillPrice,
        feeUsd: Math.max(existingOrder.feeUsd ?? 0, truth.feeUsd),
        updatedAt: now,
        raw: {
          ...(existingOrder.raw ?? {}),
          trades: usableMatchingTrades,
          orderTruth: truth,
        },
      });
      const accountingFillsById = new Map<string, LiveFill>();
      for (const trade of accountingTrades) {
        const accountingFill = await ingestPolymarketFillAccounting(
          trade,
          existingOrder.intentId,
          existingOrder.venueOrderId,
          existingOrder.asset,
          "reconcile",
        );
        accountingFillsById.set(accountingFill.id, accountingFill);
      }
      const accountingFills = [...accountingFillsById.values()];
      const exactAccountingSize = accountingFills.reduce((sum, fill) => sum + fill.size, 0);
      if (
        accountingFills.length > 0 &&
        Math.abs(exactAccountingSize - truth.effectiveFilledSize) <= ORDER_SIZE_TOLERANCE
      ) {
        await writeVenueOrder({
          ...existingOrder,
          status:
            truth.status === "filled" && truth.confirmedFilledSize > 0
              ? deriveConfirmedVenueOrderStatus(existingOrder, truth.confirmedFilledSize)
              : truth.status,
          filledSize: Math.max(existingOrder.filledSize, truth.effectiveFilledSize),
          averageFillPrice: truth.averageFillPrice ?? existingOrder.averageFillPrice,
          feeUsd: accountingFills.reduce((sum, fill) => sum + fill.feeUsd, 0),
          updatedAt: now,
          raw: {
            ...(existingOrder.raw ?? {}),
            trades: usableMatchingTrades,
            orderTruth: truth,
            exactAccountingFills: accountingFills.map((fill) => ({
              id: fill.id,
              tradeId: fill.tradeId,
              price: fill.price,
              size: fill.size,
              feeUsd: fill.feeUsd,
              onchainOrderFilled: fill.raw.onchainOrderFilled,
            })),
          },
        });
      }
      touchedIntentLegs.add(`${existingOrder.intentId}:polymarket`);
      continue;
    }

    if (truth.hasPendingExposure) {
      await writeVenueOrder({
        ...existingOrder,
        status: mergePolymarketTradeObservationStatus(existingOrder.status, "pending", truth.hasUnknownTradeTruth),
        filledSize: Math.max(existingOrder.filledSize, truth.effectiveFilledSize),
        averageFillPrice: truth.averageFillPrice ?? existingOrder.averageFillPrice,
        feeUsd: Math.max(existingOrder.feeUsd ?? 0, truth.feeUsd),
        updatedAt: now,
        raw: {
          ...(existingOrder.raw ?? {}),
          trades: usableMatchingTrades,
          orderTruth: truth,
        },
      });
    }
  }

  for (const fill of kalshiFills) {
    const existingOrder = recentOrders.find(
      (order) => order.venue === "kalshi" && order.venueOrderId === fill.order_id,
    );
    if (!existingOrder) {
      continue;
    }
    if (existingOrder.outcome !== "YES" && existingOrder.outcome !== "NO") {
      continue;
    }
    const canonicalKalshiOrder = {
      intentId: existingOrder.intentId,
      venueOrderId: existingOrder.venueOrderId,
      marketRef: existingOrder.marketRef,
      side: existingOrder.side,
      outcome: existingOrder.outcome,
    };

    const mappedFill = mapKalshiFillToLiveFill(fill, canonicalKalshiOrder, now);
    const explicitFeeUsd = getExplicitKalshiFeeUsd(fill);
    const estimatedFeeUsd =
      explicitFeeUsd ??
      (await estimateKalshiFeeUsd({
        asset: mappedFill.asset,
        contracts: mappedFill.size,
        price: mappedFill.price,
        liquidity: mappedFill.liquidity,
        now,
      }));
    const feeClassification = classifyKalshiAccountingFee(fill, estimatedFeeUsd);
    await ingestFillAccounting(
      {
        ...mappedFill,
        feeUsd: feeClassification.feeUsd,
        raw: {
          ...mappedFill.raw,
          estimatedFeeUsd: feeClassification.feeProvenance === "estimated" ? estimatedFeeUsd : undefined,
        },
      },
      feeClassification,
      "reconcile",
    );
    touchedIntentLegs.add(`${existingOrder.intentId}:kalshi`);
  }

  for (const entry of touchedIntentLegs) {
    const [intentId, venue] = entry.split(":") as [string, "polymarket" | "kalshi"];
    await syncIntentFromStoredVenueFills(intentId, venue);
  }

  await reconcileLatePrimaryFillRescue(asset, now);
  return reconcileData;
}

function getExplicitKalshiFeeUsd(raw: {
  fee_cost?: string;
  fees_paid_dollars?: string;
  taker_fees_dollars?: string;
  maker_fees_dollars?: string;
}) {
  const value = raw.fee_cost ?? raw.fees_paid_dollars ?? raw.taker_fees_dollars ?? raw.maker_fees_dollars;
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function estimateKalshiFeeUsd(input: {
  asset: MarketAsset;
  contracts: number;
  price: number | null;
  liquidity: LiveFill["liquidity"];
  now: number;
}) {
  if (
    !Number.isFinite(input.contracts) ||
    input.contracts <= 0 ||
    input.price === null ||
    !Number.isFinite(input.price) ||
    input.price <= 0 ||
    input.price >= 1
  ) {
    return null;
  }

  const feeMultiplier = await readCachedKalshiFeeMultiplier(input.asset, input.now);
  return calculateKalshiFee({
    contracts: input.contracts,
    price: input.price,
    feeMultiplier,
    maker: input.liquidity === "MAKER",
  });
}

async function readCachedKalshiFeeMultiplier(asset: MarketAsset, now: number) {
  const cached = kalshiFeeMultiplierCacheByAsset[asset];
  if (cached && now - cached.capturedAt <= KALSHI_FEE_MULTIPLIER_CACHE_TTL_MS) {
    return cached.value;
  }

  const value = await fetchKalshiSeries(asset)
    .then((response) => {
      const parsed = Number(response.series.fee_multiplier);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    })
    .catch(() => 1);
  kalshiFeeMultiplierCacheByAsset[asset] = { value, capturedAt: now };
  return value;
}

async function ingestPolymarketFillAccounting(
  trade: Parameters<typeof mapPolymarketTradeToFill>[0],
  intentId: string,
  venueOrderId: string,
  asset: MarketAsset,
  stage: "intent_sync" | "reconcile",
) {
  const mappedFill = mapPolymarketTradeToFill(trade, intentId, { venueOrderId, asset });
  let onchainEvidence;
  try {
    onchainEvidence = await fetchPolymarketOrderFilledEvidence(trade, mappedFill);
  } catch (error) {
    await recordPolymarketAccountingEvidenceFailure({
      intentId,
      asset,
      venueOrderId,
      tradeId: trade.id,
      transactionHash: trade.transaction_hash ?? null,
      stage,
      error,
    });
    throw error;
  }
  const feeClassification = classifyPolymarketAccountingFee({
    tradeStatus: trade.status,
    onchainFeeUsd: onchainEvidence.feeUsd,
    onchainEvidencePresent: true,
  });
  const accountingFill = applyPolymarketOrderFilledEvidence(mappedFill, onchainEvidence);
  return ingestFillAccounting(
    {
      ...accountingFill,
      feeUsd: feeClassification.feeUsd,
    },
    feeClassification,
    stage,
  );
}

async function recordPolymarketAccountingEvidenceFailure(input: {
  intentId: string;
  asset: MarketAsset;
  venueOrderId: string;
  tradeId: string;
  transactionHash: string | null;
  stage: "intent_sync" | "reconcile";
  error: unknown;
}) {
  const now = Date.now();
  const evidenceCode =
    input.error instanceof PolymarketOnchainEvidenceError ? input.error.code : "unexpected_evidence_error";
  await writeRunEvent({
    asset: input.asset,
    level: "error",
    eventType: "accounting.polymarket.onchain_evidence_unavailable",
    message: `Exact Polygon fill evidence unavailable for Polymarket trade ${input.tradeId}`,
    payload: {
      intentId: input.intentId,
      venueOrderId: input.venueOrderId,
      tradeId: input.tradeId,
      transactionHash: input.transactionHash,
      stage: input.stage,
      evidenceCode,
      error: toErrorMessage(input.error),
    },
    createdAt: now,
  });

  const intent = await findOrderIntent(input.intentId);
  if (!intent) {
    return;
  }
  await observeCircuitBreakerIncident(
    createExecutionIncident({
      asset: intent.asset,
      slotKey: intent.slotKey,
      intentId: intent.id,
      stage: `accounting_polymarket_onchain_${input.stage}`,
      reason: "venue_error",
      disposition: "manual_intervention",
      venue: "polymarket",
      orderId: input.venueOrderId,
      triggeredAt: now,
    }),
  );
}

class AccountingFillQuarantinedError extends Error {
  constructor(
    readonly intentId: string,
    readonly fillId: string,
    readonly reason: string,
  ) {
    super(`Accounting quarantined fill ${fillId} for intent ${intentId}: ${reason}`);
    this.name = "AccountingFillQuarantinedError";
  }
}

async function ingestFillAccounting(
  fill: LiveFill,
  classification: {
    finality: AccountingEvidenceFinality;
    venueTruth: string;
    feeProvenance:
      "venue_explicit" | "onchain_event" | "protocol_zero" | "estimated" | "missing" | "invalid" | "synthetic_exact";
  },
  stage: string,
) {
  const intent = await findOrderIntent(fill.intentId);
  if (!intent) {
    throw new Error(`Accounting fill ${fill.id} references missing intent ${fill.intentId}`);
  }
  const leg = resolveAccountingLegForFill(intent, fill);
  if (!leg) {
    await observeCircuitBreakerIncident(
      createExecutionIncident({
        asset: intent.asset,
        slotKey: intent.slotKey,
        intentId: intent.id,
        stage: `accounting_fill_identity_${stage}`,
        reason: "venue_error",
        disposition: "manual_intervention",
        venue: fill.venue,
        orderId: fill.venueOrderId,
        triggeredAt: Date.now(),
      }),
    );
    throw new Error(`Accounting fill ${fill.id} does not match a canonical leg of intent ${intent.id}`);
  }
  const head = await readAccountingHead(intent.id);
  if (!head) {
    throw new Error(`Accounting head missing for intent ${intent.id}`);
  }
  const accountingFill = attachAccountingFillProvenance(fill, classification);
  const result = await ingestVenueFillAccounting({
    context: {
      actor: "engine.fill_ingestion",
      requestId: buildAccountingFillMutationRequestId(accountingFill, leg.id, classification),
      occurredAt: accountingFill.filledAt,
    },
    expectedHeadRevision: head.revision,
    legId: leg.id,
    finality: classification.finality,
    fill: accountingFill,
  });
  if ("reason" in result) {
    await writeRunEvent({
      asset: intent.asset,
      level: "error",
      eventType: "accounting.fill.quarantined",
      message: `Fill ${fill.id} quarantined during ${stage}`,
      payload: {
        intentId: intent.id,
        fillId: fill.id,
        venue: fill.venue,
        venueOrderId: fill.venueOrderId,
        tradeId: fill.tradeId,
        finality: classification.finality,
        reason: result.reason,
        quarantineId: result.quarantineId,
      },
      createdAt: Date.now(),
    });
    await observeCircuitBreakerIncident(
      createExecutionIncident({
        asset: intent.asset,
        slotKey: intent.slotKey,
        intentId: intent.id,
        stage: `accounting_fill_quarantined_${stage}`,
        reason: "venue_error",
        disposition: "manual_intervention",
        venue: fill.venue,
        orderId: fill.venueOrderId,
        triggeredAt: Date.now(),
      }),
    );
    throw new AccountingFillQuarantinedError(intent.id, fill.id, result.reason);
  }
  return accountingFill;
}

export function resolveAccountingLegForFill(intent: OrderIntent, fill: LiveFill) {
  if (fill.intentId !== intent.id || fill.asset !== intent.asset || fill.shadow !== intent.shadow) {
    return null;
  }
  return (
    intent.legs.find(
      (leg) =>
        leg.venue === fill.venue &&
        leg.marketRef === fill.marketRef &&
        leg.outcome === fill.outcome &&
        (leg.tokenId ?? null) === (fill.tokenId ?? null),
    ) ?? null
  );
}

async function reconcileLatePrimaryFillRescue(asset: MarketAsset, now: number) {
  const [recentIntents, recentOrders] = await Promise.all([
    readRecentOrderIntents(200, asset),
    readRecentVenueOrders(200, asset),
  ]);

  for (const intent of recentIntents) {
    if (intent.status !== "failed") {
      continue;
    }
    if (
      now - intent.updatedAt > LATE_PRIMARY_FILL_RESCUE_WINDOW_MS ||
      intent.failureReason?.includes("Late primary fill detected")
    ) {
      continue;
    }

    const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
    const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
    if (!primaryLeg || !hedgeLeg) {
      continue;
    }
    if (!isLatePrimaryFillRescueEligible(intent, recentOrders)) {
      continue;
    }

    const intentOrders = recentOrders.filter((order) => order.intentId === intent.id);
    const primaryOrder = findLatestIntentOrderForLeg(intentOrders, intent, primaryLeg);
    const primaryOrderSummary = summarizeIntentLegOrders(intentOrders, intent, primaryLeg, "entry");
    if (
      (!primaryOrderSummary || primaryOrderSummary.filledSize <= 0) &&
      (!primaryOrder || !shouldTreatPrimaryOrderAsFilled(intent, primaryOrder))
    ) {
      continue;
    }

    const hedgeOrder = findLatestIntentOrderForLeg(intentOrders, intent, hedgeLeg);
    if (hedgeOrder?.status === "filled" || (hedgeOrder?.filledSize ?? 0) > 0) {
      continue;
    }

    let rescued =
      primaryOrderSummary && primaryOrderSummary.filledSize > 0
        ? updateIntentLegFromFillSummary(intent, primaryLeg.id, primaryOrderSummary, now)
        : updateIntentLeg(intent, primaryLeg.venue, primaryOrder!, "filled", now);
    if (intent.slotEndTs + RESOLUTION_GRACE_MS > now) {
      rescued = markIntentStatus(rescued, "primary_filled", now, "Late primary fill detected; resuming hedge");
      rescued = await writeOrderIntent(rescued);
      await writeLiveTradeRunEvent(rescued, now);
      await writeRunEvent({
        level: "error",
        eventType: "intent.reopened.late_primary_fill",
        message: `Intent ${intent.id} reopened after primary fill was confirmed late`,
        payload: {
          intentId: intent.id,
          slotKey: intent.slotKey,
          venue: intent.primaryVenue,
          orderId: primaryOrder?.venueOrderId ?? primaryOrderSummary?.venueOrderId ?? null,
        },
        createdAt: now,
      });
      continue;
    }

    rescued = await markIntentManualRequired(
      rescued,
      now,
      "late_primary_fill_after_failure",
      "Late primary fill detected after intent had already failed; manual intervention required",
      {
        venue: intent.primaryVenue,
        orderId: primaryOrder?.venueOrderId ?? primaryOrderSummary?.venueOrderId ?? null,
      },
    );
    await writeManualInterventionRunEvent(rescued, now, "late_primary_fill_after_failure", {
      venue: intent.primaryVenue,
      orderId: primaryOrder?.venueOrderId ?? primaryOrderSummary?.venueOrderId ?? null,
    });
    await observeCircuitBreakerIncident(
      createExecutionIncident({
        asset: intent.asset,
        slotKey: intent.slotKey,
        intentId: intent.id,
        stage: "late_primary_fill_after_close",
        reason: "hedge_failure",
        disposition: "manual_intervention",
        venue: intent.primaryVenue,
        orderId: primaryOrder?.venueOrderId ?? primaryOrderSummary?.venueOrderId ?? null,
        triggeredAt: now,
      }),
    );
    await writeRunEvent({
      level: "error",
      eventType: "intent.failed.late_primary_fill",
      message: `Late primary fill detected after intent ${intent.id} was already closed`,
      payload: {
        intentId: intent.id,
        slotKey: intent.slotKey,
        venue: intent.primaryVenue,
        orderId: primaryOrder?.venueOrderId ?? primaryOrderSummary?.venueOrderId ?? null,
      },
      createdAt: now,
    });
  }
}

async function reconcileSettlements(asset: MarketAsset, now: number) {
  const openIntents = await readOpenOrderIntents(asset);
  const settledCandidates = openIntents.filter(
    (intent) => intent.status === "hedged" && intent.slotEndTs + RESOLUTION_GRACE_MS <= now,
  );

  for (const intent of settledCandidates) {
    const venueResolutions = await fetchVenueSettlementResolutions(intent);
    if (!venueResolutions) {
      await writeRunEvent({
        asset: intent.asset,
        level: "warn",
        eventType: "intent.settlement.waiting_venue_resolution",
        message: `Intent ${intent.id} remains hedged while waiting for venue settlement outcomes`,
        payload: {
          intentId: intent.id,
          slotKey: intent.slotKey,
          slotEndTs: intent.slotEndTs,
          ageAfterSlotEndMs: now - intent.slotEndTs,
          legs: intent.legs.map((leg) => ({
            venue: leg.venue,
            marketRef: leg.marketRef,
            outcome: leg.outcome,
            filledSize: leg.filledSize,
          })),
        },
        createdAt: now,
      });
      continue;
    }

    const settlementIntent = await refreshIntentFromStoredFills(intent, now);
    const payoutUsd = calculateWinningPayout(
      settlementIntent.legs,
      venueResolutions.polyResolution,
      venueResolutions.kalshiResolution,
    );
    await finalizeTerminalIntentWithAccounting({
      intent: settlementIntent,
      terminalIntent: finalizeIntent({
        intent: settlementIntent,
        polyResolution: venueResolutions.polyResolution,
        kalshiResolution: venueResolutions.kalshiResolution,
        payoutUsd,
        now,
      }),
      now,
      stage: "venue_settlement",
      stability: {
        resolutionSource: "official_venue_resolution",
        polyResolution: venueResolutions.polyResolution,
        kalshiResolution: venueResolutions.kalshiResolution,
      },
    });
  }
}

async function repairRecentSettledIntentResolutions(asset: MarketAsset, now: number) {
  const lastRepairAt = lastSettledResolutionRepairAtByAsset[asset];
  if (lastRepairAt !== undefined && now - lastRepairAt < SETTLED_RESOLUTION_REPAIR_INTERVAL_MS) {
    return;
  }
  lastSettledResolutionRepairAtByAsset[asset] = now;

  const recentSettledIntents = await readRecentSettledOrderIntents(SETTLED_RESOLUTION_REPAIR_LIMIT, asset);
  const candidates = recentSettledIntents.filter(
    (intent) =>
      !intent.shadow && intent.resolvedAt !== null && now - intent.resolvedAt <= SETTLED_RESOLUTION_REPAIR_LOOKBACK_MS,
  );

  for (const intent of candidates) {
    await repairSettledIntentResolution(intent, now);
  }
}

async function reconcileObservedSlotResolutions(now: number) {
  if (observedSlotResolutionReconcileInFlight) {
    return;
  }
  observedSlotResolutionReconcileInFlight = true;
  try {
    const pending = await readPendingSlotResolutions(now - RESOLUTION_GRACE_MS, 10);
    for (const slot of pending) {
      const [polymarketObservation, kalshiObservation] = await Promise.all([
        fetchFinalizedPolymarketResolutionObservation(slot.polymarketSlug, slot.polymarketMarketRef ?? undefined).catch(
          () => null,
        ),
        slot.kalshiMarketRef
          ? fetchFinalizedKalshiResolutionObservation(slot.kalshiMarketRef).catch(() => null)
          : Promise.resolve(null),
      ]);
      const { polymarketResolution: nextPolymarketResolution, kalshiResolution: nextKalshiResolution } =
        mergeObservedSlotResolutionOutcomes({
          storedSource: slot.source,
          storedPolymarketResolution: slot.polymarketResolution,
          storedKalshiResolution: slot.kalshiResolution,
          fetchedPolymarketResolution: polymarketObservation?.resolution ?? null,
          fetchedKalshiResolution: kalshiObservation?.resolution ?? null,
        });
      const polymarketBenchmarkConflict = hasOfficialBenchmarkConflict(
        slot.polymarketSettlementValueUsd,
        polymarketObservation?.benchmarkValueUsd ?? null,
      );
      const kalshiBenchmarkConflict = hasOfficialBenchmarkConflict(
        slot.kalshiSettlementValueUsd,
        kalshiObservation?.benchmarkValueUsd ?? null,
      );
      if (polymarketBenchmarkConflict || kalshiBenchmarkConflict) {
        await writeRunEvent({
          asset: slot.asset,
          level: "warn",
          eventType: "oracle.resolution_benchmark_conflict",
          message: `Official terminal benchmark conflict for ${slot.slotKey}`,
          payload: {
            slotKey: slot.slotKey,
            stored: {
              polymarket: slot.polymarketSettlementValueUsd,
              kalshi: slot.kalshiSettlementValueUsd,
            },
            observed: {
              polymarket: polymarketObservation?.benchmarkValueUsd ?? null,
              kalshi: kalshiObservation?.benchmarkValueUsd ?? null,
            },
          },
          createdAt: now,
        });
      }
      const resolvedAt = nextPolymarketResolution && nextKalshiResolution ? now : null;
      await writeSlotResolution({
        ...slot,
        polymarketResolution: nextPolymarketResolution,
        kalshiResolution: nextKalshiResolution,
        polymarketSettlementValueUsd:
          slot.polymarketSettlementValueUsd ?? polymarketObservation?.benchmarkValueUsd ?? null,
        kalshiSettlementValueUsd: slot.kalshiSettlementValueUsd ?? kalshiObservation?.benchmarkValueUsd ?? null,
        updatedAt: now,
        resolvedAt,
        source: "official-venue-resolution",
        raw: {
          outcomeMismatch:
            nextPolymarketResolution && nextKalshiResolution
              ? (nextPolymarketResolution === "UP") !== (nextKalshiResolution === "YES")
              : null,
          fatalByCombination:
            nextPolymarketResolution && nextKalshiResolution
              ? {
                  POLY_UP_KALSHI_NO: nextPolymarketResolution === "DOWN" && nextKalshiResolution === "YES",
                  POLY_DOWN_KALSHI_YES: nextPolymarketResolution === "UP" && nextKalshiResolution === "NO",
                }
              : null,
          benchmarkSources: {
            polymarket: polymarketObservation?.benchmarkSource ?? null,
            kalshi: kalshiObservation?.benchmarkSource ?? null,
          },
          benchmarkConflict: {
            polymarket: polymarketBenchmarkConflict,
            kalshi: kalshiBenchmarkConflict,
          },
        },
      });
    }
  } finally {
    observedSlotResolutionReconcileInFlight = false;
  }
}

function hasOfficialBenchmarkConflict(stored: number | null, observed: number | null) {
  return stored !== null && observed !== null && Math.abs(stored - observed) > 1e-6;
}

export function mergeObservedSlotResolutionOutcomes(input: {
  storedSource: string;
  storedPolymarketResolution: "UP" | "DOWN" | null;
  storedKalshiResolution: "YES" | "NO" | null;
  fetchedPolymarketResolution: "UP" | "DOWN" | null;
  fetchedKalshiResolution: "YES" | "NO" | null;
}) {
  return {
    polymarketResolution:
      input.fetchedPolymarketResolution ??
      (input.storedSource === "official-venue-resolution" ? input.storedPolymarketResolution : null),
    kalshiResolution:
      input.fetchedKalshiResolution ??
      (input.storedSource === "official-venue-resolution" ? input.storedKalshiResolution : null),
  };
}

async function repairSettledIntentResolution(intent: OrderIntent, now: number) {
  const [venueResolutions, accountingHead] = await Promise.all([
    fetchVenueSettlementResolutions(intent),
    readAccountingHead(intent.id),
  ]);
  if (!venueResolutions) {
    return {
      status: "unavailable" as const,
      intent,
    };
  }

  const refreshedIntent = intent;
  const payoutUsd = calculateWinningPayout(
    refreshedIntent.legs,
    venueResolutions.polyResolution,
    venueResolutions.kalshiResolution,
  );
  const repaired = finalizeIntent({
    intent: refreshedIntent,
    polyResolution: venueResolutions.polyResolution,
    kalshiResolution: venueResolutions.kalshiResolution,
    payoutUsd,
    now: intent.resolvedAt ?? now,
  });

  if (!isSettledIntentAccountingRepairRequired(intent, repaired, accountingHead?.state ?? null)) {
    return {
      status: "unchanged" as const,
      intent,
    };
  }

  const repairedCandidate: OrderIntent = {
    ...repaired,
    updatedAt: now,
    resolvedAt: intent.resolvedAt ?? repaired.resolvedAt,
  };

  const repairedIntent = await finalizeTerminalIntentWithAccounting({
    intent,
    terminalIntent: repairedCandidate,
    now,
    stage: "settlement_resolution_repair",
    stability: {
      resolutionSource: "official_venue_resolution",
      previousPolyResolution: intent.polyResolution,
      previousKalshiResolution: intent.kalshiResolution,
      polyResolution: venueResolutions.polyResolution,
      kalshiResolution: venueResolutions.kalshiResolution,
      previousAccountingState: accountingHead?.state ?? "missing",
    },
  });
  if (
    repairedIntent.polyResolution !== venueResolutions.polyResolution ||
    repairedIntent.kalshiResolution !== venueResolutions.kalshiResolution
  ) {
    return {
      status: "unavailable" as const,
      intent: repairedIntent,
    };
  }
  await updateStablePnlChangeFromIntent(repairedIntent);

  await writeRunEvent({
    level: "warn",
    eventType: "intent.settlement.repaired",
    message: `Intent ${intent.id} settlement corrected from venue outcomes`,
    payload: {
      intentId: intent.id,
      slotKey: intent.slotKey,
      previousPolyResolution: intent.polyResolution,
      previousKalshiResolution: intent.kalshiResolution,
      repairedPolyResolution: venueResolutions.polyResolution,
      repairedKalshiResolution: venueResolutions.kalshiResolution,
      previousRealizedPnlUsd: intent.realizedPnlUsd,
      repairedRealizedPnlUsd: repairedIntent.realizedPnlUsd,
      previousRoi: intent.roi,
      repairedRoi: repairedIntent.roi,
    },
    createdAt: now,
  });

  return {
    status: "repaired" as const,
    intent: repairedIntent,
  };
}

export function isSettledIntentAccountingRepairRequired(
  current: Pick<OrderIntent, "polyResolution" | "kalshiResolution" | "realizedPnlUsd" | "roi">,
  repaired: Pick<OrderIntent, "polyResolution" | "kalshiResolution" | "realizedPnlUsd" | "roi">,
  accountingState: AccountingHeadState | null,
) {
  return (
    accountingState === "quarantined" ||
    current.polyResolution !== repaired.polyResolution ||
    current.kalshiResolution !== repaired.kalshiResolution ||
    current.realizedPnlUsd !== repaired.realizedPnlUsd ||
    current.roi !== repaired.roi
  );
}

async function refreshIntentFromStoredFills(intent: OrderIntent, now: number) {
  let refreshed = intent;
  for (const venue of ["polymarket", "kalshi"] as const) {
    refreshed = (await syncIntentFromStoredVenueFills(intent.id, venue, refreshed)) ?? refreshed;
  }

  refreshed = await applyPolymarketCashAdjustmentFromSnapshots(refreshed, now);

  return {
    ...refreshed,
    updatedAt: Math.max(now, refreshed.updatedAt),
  };
}

async function applyPolymarketCashAdjustmentFromSnapshots(intent: OrderIntent, now: number): Promise<OrderIntent> {
  const polymarketLeg = intent.legs.find((leg) => leg.venue === "polymarket");
  if (!polymarketLeg || polymarketLeg.filledSize <= ORDER_SIZE_TOLERANCE) {
    return intent;
  }

  const observation = await readPolymarketCashAdjustmentObservation(intent.id).catch(() => null);
  if (!observation) {
    return intent;
  }

  const cashAdjustmentUsd = deriveValidPolymarketCashAdjustmentUsd(observation);
  if (cashAdjustmentUsd === null) {
    return intent;
  }

  if (round4(polymarketLeg.cashAdjustmentUsd ?? 0) === cashAdjustmentUsd) {
    return intent;
  }

  return {
    ...intent,
    updatedAt: now,
    legs: intent.legs.map((leg) =>
      leg.id === polymarketLeg.id
        ? {
            ...leg,
            cashAdjustmentUsd,
          }
        : leg,
    ) as OrderIntent["legs"],
  };
}

function deriveValidPolymarketCashAdjustmentUsd(
  observation: Awaited<ReturnType<typeof readPolymarketCashAdjustmentObservation>>,
) {
  if (!observation) {
    return null;
  }

  const beforeLagMs = observation.firstOrderCreatedAt - observation.beforeCapturedAt;
  const afterLagMs = observation.afterCapturedAt - observation.lastOrderCreatedAt;
  if (
    beforeLagMs < 0 ||
    afterLagMs < 0 ||
    beforeLagMs > POLYMARKET_CASH_ADJUSTMENT_MAX_SNAPSHOT_LAG_MS ||
    afterLagMs > POLYMARKET_CASH_ADJUSTMENT_MAX_SNAPSHOT_LAG_MS
  ) {
    return null;
  }

  if (
    !Number.isFinite(observation.theoreticalCashDebitUsd) ||
    !Number.isFinite(observation.observedCashDebitUsd) ||
    observation.theoreticalCashDebitUsd <= 0 ||
    observation.observedCashDebitUsd <= 0
  ) {
    return null;
  }

  const adjustmentUsd = round4(observation.adjustmentUsd);
  if (adjustmentUsd < POLYMARKET_CASH_ADJUSTMENT_MIN_USD) {
    return 0;
  }

  const maxAllowedUsd = Math.min(
    POLYMARKET_CASH_ADJUSTMENT_MAX_USD,
    observation.theoreticalCashDebitUsd * POLYMARKET_CASH_ADJUSTMENT_MAX_RATIO,
  );
  if (adjustmentUsd > maxAllowedUsd) {
    return null;
  }

  return adjustmentUsd;
}

export async function repairSettledIntentResolutions(options?: {
  asset?: MarketAsset | "all";
  intentId?: string;
  lookbackHours?: number;
  limit?: number;
  includeShadow?: boolean;
  now?: number;
}) {
  const now = options?.now ?? Date.now();
  const lookbackMs = Math.max(1, options?.lookbackHours ?? 24) * 60 * 60 * 1000;
  const limit = Math.max(1, options?.limit ?? SETTLED_RESOLUTION_REPAIR_LIMIT);
  const includeShadow = options?.includeShadow === true;

  if (options?.intentId) {
    const intent = await findOrderIntent(options.intentId);
    if (!intent) {
      throw new Error(`Intent ${options.intentId} introuvable`);
    }
    if (intent.status !== "settled") {
      throw new Error(`Intent ${options.intentId} n'est pas settled`);
    }

    const result = await repairSettledIntentResolution(intent, now);
    return {
      mode: "intent",
      intentId: options.intentId,
      result: result.status,
      polyResolution: result.intent.polyResolution,
      kalshiResolution: result.intent.kalshiResolution,
      realizedPnlUsd: result.intent.realizedPnlUsd,
      polymarketCashAdjustmentUsd: result.intent.legs.find((leg) => leg.venue === "polymarket")?.cashAdjustmentUsd ?? 0,
    };
  }

  const assets = options?.asset && options.asset !== "all" ? [options.asset] : MARKET_ASSETS;
  const summaries = [];

  for (const asset of assets) {
    const intents = await readRecentSettledOrderIntents(limit, asset);
    const candidates = intents.filter(
      (intent) =>
        (includeShadow || !intent.shadow) && intent.resolvedAt !== null && now - intent.resolvedAt <= lookbackMs,
    );

    let repaired = 0;
    let unchanged = 0;
    let unavailable = 0;

    for (const intent of candidates) {
      const result = await repairSettledIntentResolution(intent, now);
      if (result.status === "repaired") repaired += 1;
      else if (result.status === "unchanged") unchanged += 1;
      else unavailable += 1;
    }

    summaries.push({
      asset,
      scanned: candidates.length,
      repaired,
      unchanged,
      unavailable,
    });
  }

  return {
    mode: "batch",
    lookbackHours: lookbackMs / (60 * 60 * 1000),
    limit,
    includeShadow,
    assets: summaries,
  };
}

async function clearRecoveredIntentFailureReasons(asset: MarketAsset, now: number) {
  const openIntents = await readOpenOrderIntents(asset);
  for (const intent of openIntents) {
    if (intent.status !== "hedged" || !intent.failureReason) {
      continue;
    }

    await writeOrderIntent({
      ...intent,
      updatedAt: now,
      failureReason: null,
    });
  }
}

async function backfillUnwoundIntentPnl(asset: MarketAsset, now: number) {
  const recentIntents = await readRecentOrderIntents(200, asset);
  for (const intent of recentIntents) {
    if (intent.shadow || intent.status !== "unwound" || intent.realizedPnlUsd !== null) {
      continue;
    }

    if (!intent.legs.some((leg) => leg.payoutUsd !== null)) {
      continue;
    }

    await finalizeTerminalIntentWithAccounting({
      intent,
      terminalIntent: finalizeUnwoundIntent({
        intent,
        now,
        failureReason: intent.failureReason,
      }),
      now,
      stage: "legacy_unwind_backfill",
      stability: {
        source: "immutable_accounting_fill_evidence",
      },
    });
  }
}

async function holdIntentForUnavailableVenueReconcileTruth(input: {
  intent: OrderIntent;
  venue: Venue;
  orderStatus: LiveOrder["status"] | null;
  orderId?: string | null;
  stage: string;
  now: number;
  fetchStates: VenueReconcileFetchStates | undefined;
}) {
  const sourceStates =
    input.venue === "polymarket"
      ? [
          ["orders", input.fetchStates?.polymarketOrders] as const,
          ["fills", input.fetchStates?.polymarketFills] as const,
        ]
      : [["orders", input.fetchStates?.kalshiOrders] as const, ["fills", input.fetchStates?.kalshiFills] as const];
  const unavailableSources = sourceStates.filter(([, state]) => state?.ok !== true).map(([source]) => source);
  const reason = `${input.venue} ${unavailableSources.join(" and ")} reconciliation unavailable; authoritative venue truth remains pending`;
  const actions = deriveUnavailableVenueTruthActions(input.intent, reason);
  let currentIntent = actions.writeIntentAndIncident
    ? markIntentStatus(input.intent, "truth_pending", input.now, reason)
    : input.intent;
  if (actions.writeIntentAndIncident) {
    currentIntent = await writeOrderIntent(currentIntent);
    await writeIntentIncidentRunEvent(currentIntent, input.now, input.stage, reason, {
      venue: input.venue,
      orderId: input.orderId ?? null,
      orderStatus: input.orderStatus,
      unavailableSources,
    });
  }

  if (actions.armBreaker) {
    await observeCircuitBreakerIncident(
      createExecutionIncident({
        asset: currentIntent.asset,
        slotKey: currentIntent.slotKey,
        intentId: currentIntent.id,
        stage: input.stage,
        reason: "venue_error",
        disposition: "truth_pending",
        venue: input.venue,
        orderId: input.orderId ?? null,
        triggeredAt: input.now,
      }),
    );
  }
  return currentIntent;
}

export function deriveUnavailableVenueTruthActions(
  intent: Pick<OrderIntent, "status" | "failureReason">,
  reason: string,
) {
  return {
    writeIntentAndIncident: intent.status !== "truth_pending" || intent.failureReason !== reason,
    armBreaker: true,
  };
}

async function reconcileInFlightIntentStates(
  asset: MarketAsset,
  now: number,
  settings: StrategyConfig,
  sharedContext: TickSharedContext = {},
) {
  const openIntents = await readOpenOrderIntents(asset);
  const recentOrders = await readRecentVenueOrders(200, asset);
  const venueReconcileFetchStates = sharedContext.venueOrderReconcileData?.fetchStates;
  const livePositions =
    sharedContext.venuePositions === null
      ? (sharedContext.storedPositions ?? []).filter((position) => position.asset === asset)
      : sharedContext.venuePositions
        ? [...sharedContext.venuePositions.polymarket, ...sharedContext.venuePositions.kalshi].filter(
            (position) => position.asset === asset,
          )
        : await readPositions(asset);

  for (const intent of openIntents) {
    if (intent.shadow) {
      continue;
    }
    if (
      intent.status !== "executing_primary" &&
      intent.status !== "primary_filled" &&
      intent.status !== "truth_pending" &&
      intent.status !== "rescue_hedge" &&
      intent.status !== "hedging" &&
      intent.status !== "unwind_required"
    ) {
      continue;
    }

    const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
    const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
    if (!primaryLeg || !hedgeLeg) {
      continue;
    }

    const intentOrders = recentOrders.filter((order) => order.intentId === intent.id);
    const primaryOrder = findLatestIntentOrderForLeg(intentOrders, intent, primaryLeg);
    const hedgeOrder = findLatestIntentOrderForLeg(intentOrders, intent, hedgeLeg);
    const unwindOrder = findLatestIntentReduceOnlyOrder(intentOrders, intent, primaryLeg);
    const primaryOrderSummary = summarizeIntentLegOrders(intentOrders, intent, primaryLeg, "entry");
    const stale = isInFlightIntentStale(intent, now);
    let currentIntent = intent;

    if (intent.status === "unwind_required") {
      const primaryVenueFills = (await readFillsForIntentVenue(intent.id, primaryLeg.venue)).filter(
        (fill) => resolveAccountingLegForFill(currentIntent, fill)?.id === primaryLeg.id,
      );
      const entryFillSummary = summarizeIntentLegFills(primaryVenueFills, primaryLeg, "entry");
      const exitFillSummary = summarizeIntentLegFills(primaryVenueFills, primaryLeg, "exit");
      const entryFilledSize = entryFillSummary?.filledSize ?? primaryLeg.filledSize;
      const exitFilledSize = exitFillSummary?.filledSize ?? 0;
      const liveRemainingSize = deriveLiveRemainingLegSize(livePositions, primaryLeg);
      const remainingExposureSize = deriveRemainingExposureSize(entryFilledSize, exitFilledSize);
      const exitAverageFillPrice =
        exitFillSummary?.averageFillPrice ?? unwindOrder?.averageFillPrice ?? primaryLeg.filledPrice ?? 0;
      const exitFeeUsd = exitFillSummary?.feeUsd ?? unwindOrder?.feeUsd ?? 0;

      if (entryFillSummary) {
        currentIntent = updateIntentLegFromFillSummary(currentIntent, primaryLeg.id, entryFillSummary, now);
        currentIntent = await writeOrderIntent(currentIntent);
      }

      const hedgeOrderSummary = summarizeIntentLegOrders(intentOrders, intent, hedgeLeg, "entry");
      if (hedgeOrderSummary && hedgeOrderSummary.filledSize > 0) {
        currentIntent = updateIntentLegFromFillSummary(currentIntent, hedgeLeg.id, hedgeOrderSummary, now);
        currentIntent = await writeOrderIntent(currentIntent);
      } else if (hedgeOrder && hedgeOrder.filledSize > 0) {
        currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "submitted", now);
        currentIntent = await writeOrderIntent(currentIntent);
      }

      const exposureResolution = await resolveHedgeExposureBeforePrimaryUnwind(
        currentIntent,
        hedgeOrder,
        settings,
        now,
      );
      if (exposureResolution) {
        continue;
      }

      if (currentIntent.primaryVenue === "polymarket" && currentIntent.slotEndTs + RESOLUTION_GRACE_MS <= now) {
        const polyResolution =
          currentIntent.polyResolution ??
          (await fetchPolymarketResolution(
            buildPolymarketSlotSlug(currentIntent.asset, currentIntent.slotStartTs),
            primaryLeg.marketRef,
          ).catch(() => null));
        if (polyResolution !== null) {
          const residualPayoutUsd = primaryLeg.outcome === polyResolution ? remainingExposureSize : 0;
          const payoutUsd = round4(exitFilledSize * exitAverageFillPrice - exitFeeUsd + residualPayoutUsd);
          const failureReason =
            exitFilledSize > 0 && remainingExposureSize > ORDER_SIZE_TOLERANCE
              ? "Primary partially unwound before Polymarket settlement"
              : exitFilledSize > 0
                ? "Primary unwound after hedge failure"
                : "Primary settled on Polymarket after hedge failure";

          const terminalCandidate = finalizeUnwoundIntent({
            intent: {
              ...currentIntent,
              polyResolution,
              legs: currentIntent.legs.map((leg) =>
                leg.id === primaryLeg.id
                  ? {
                      ...leg,
                      status: "unwound",
                      payoutUsd,
                      resolvedOutcome: polyResolution,
                    }
                  : leg,
              ) as OrderIntent["legs"],
            },
            now,
            failureReason,
          });
          currentIntent = await finalizeTerminalIntentWithAccounting({
            intent: currentIntent,
            terminalIntent: terminalCandidate,
            now,
            stage: "primary_unwind_polymarket_settlement",
            stability: {
              source: "official_venue_resolution_and_final_fills",
              polyResolution,
              exitFilledSize,
              remainingExposureSize,
            },
          });
          if (currentIntent.status === "unwound") {
            await recordMarketFillQualityForIntent(currentIntent, "unwind", "primary_unwound_after_reconcile", now, {
              venue: currentIntent.primaryVenue,
              exitFilledSize,
              remainingExposureSize,
            });
            await armRecoveredHedgeFailureCooldown(currentIntent, now, "primary_unwound_after_reconcile");
          }
          continue;
        }
      }

      if (
        (liveRemainingSize <= ORDER_SIZE_TOLERANCE && exitFilledSize > 0) ||
        (exitFillSummary && exitFilledSize + ORDER_SIZE_TOLERANCE >= entryFilledSize && entryFilledSize > 0)
      ) {
        const payoutUsd = round4(exitFilledSize * exitAverageFillPrice - exitFeeUsd);
        const terminalCandidate = finalizeUnwoundIntent({
          intent: {
            ...currentIntent,
            legs: currentIntent.legs.map((leg) =>
              leg.id === primaryLeg.id
                ? {
                    ...leg,
                    status: "unwound",
                    payoutUsd,
                  }
                : leg,
            ) as OrderIntent["legs"],
          },
          now,
          failureReason: "Primary unwound after hedge failure",
        });
        currentIntent = await finalizeTerminalIntentWithAccounting({
          intent: currentIntent,
          terminalIntent: terminalCandidate,
          now,
          stage: "primary_unwind_final_fills",
          stability: {
            source: "final_fills_and_position_truth",
            exitFilledSize,
            liveRemainingSize,
          },
        });
        if (currentIntent.status === "unwound") {
          await recordMarketFillQualityForIntent(currentIntent, "unwind", "primary_unwound_after_reconcile", now, {
            venue: currentIntent.primaryVenue,
            exitFilledSize,
          });
          await armRecoveredHedgeFailureCooldown(currentIntent, now, "primary_unwound_after_reconcile");
        }
        continue;
      }

      if (!unwindOrder) {
        if (stale) {
          currentIntent = await attemptPrimaryUnwindAfterHedgeFailureFromReconcile(
            currentIntent,
            primaryLeg,
            hedgeLeg,
            hedgeOrder,
            settings,
            now,
            currentIntent.failureReason ?? "Retrying primary unwind after hedge failure",
            venueReconcileFetchStates,
          );
        }
        continue;
      }

      if (shouldTreatPrimaryUnwindOrderAsComplete(unwindOrder)) {
        await maybeWritePrimaryUnwindFilledSizeMismatchEvent(currentIntent, unwindOrder, now);
        const averageExitPrice = unwindOrder.averageFillPrice ?? primaryLeg.filledPrice ?? 0;
        const payoutUsd = round4(unwindOrder.filledSize * averageExitPrice - (unwindOrder.feeUsd ?? 0));
        const terminalCandidate = finalizeUnwoundIntent({
          intent: {
            ...currentIntent,
            legs: currentIntent.legs.map((leg) =>
              leg.id === primaryLeg.id
                ? {
                    ...leg,
                    status: "unwound",
                    payoutUsd,
                  }
                : leg,
            ) as OrderIntent["legs"],
          },
          now,
          failureReason: "Primary unwound after hedge failure",
        });
        currentIntent = await finalizeTerminalIntentWithAccounting({
          intent: currentIntent,
          terminalIntent: terminalCandidate,
          now,
          stage: "primary_unwind_order_complete",
          stability: {
            source: "terminal_order_and_final_fills",
            venue: unwindOrder.venue,
            orderId: unwindOrder.venueOrderId,
            orderStatus: unwindOrder.status,
          },
        });
        if (currentIntent.status === "unwound") {
          await armRecoveredHedgeFailureCooldown(currentIntent, now, "primary_unwound_after_reconcile");
        }
        continue;
      }

      if (unwindOrder.filledSize > 0) {
        currentIntent = markIntentStatus(
          currentIntent,
          "unwind_required",
          now,
          `Primary unwind partially filled (${unwindOrder.status}); manual intervention required`,
        );
        currentIntent = await writeOrderIntent(currentIntent);
        await writeManualInterventionRunEvent(currentIntent, now, "primary_unwind_partial_fill_reconcile", {
          venue: currentIntent.primaryVenue,
          orderId: unwindOrder.venueOrderId,
          orderStatus: unwindOrder.status,
        });
        await tripManualInterventionBreaker(currentIntent, now, hedgeOrder, "primary_unwind_partial_fill_reconcile");
        continue;
      }

      if (stale && (isTerminalOrderStatus(unwindOrder.status) || isAwaitingOrderConfirmation(unwindOrder.status))) {
        currentIntent = markIntentStatus(
          currentIntent,
          "unwind_required",
          now,
          `Primary unwind not completed (${unwindOrder.status}); manual intervention required`,
        );
        currentIntent = await writeOrderIntent(currentIntent);
        await writeManualInterventionRunEvent(currentIntent, now, "primary_unwind_not_completed", {
          venue: currentIntent.primaryVenue,
          orderId: unwindOrder.venueOrderId,
          orderStatus: unwindOrder.status,
        });
        await tripManualInterventionBreaker(currentIntent, now, hedgeOrder, "primary_unwind_not_completed");
      }
      continue;
    }

    if (primaryOrderSummary && primaryOrderSummary.filledSize > 0) {
      currentIntent = updateIntentLegFromFillSummary(currentIntent, primaryLeg.id, primaryOrderSummary, now);
      if (currentIntent.status === "executing_primary") {
        currentIntent = markIntentStatus(currentIntent, hedgeOrder ? "hedging" : "primary_filled", now);
      }
      currentIntent = await writeOrderIntent(currentIntent);
      if (currentIntent.status === "primary_filled" || currentIntent.status === "hedging") {
        await writeLiveTradeRunEvent(currentIntent, now, "primary_filled");
      }
    }

    if (!primaryOrder && !primaryOrderSummary) {
      if (intent.status === "executing_primary" && stale) {
        const attempts = await readOrderAttemptsForIntent(intent.id);
        if (hasUnresolvedPrimarySubmissionAttempt(attempts, primaryLeg.id)) {
          currentIntent = markIntentStatus(
            intent,
            "truth_pending",
            now,
            "Primary submission may have reached the venue; venue truth is still unresolved",
          );
          currentIntent = await writeOrderIntent(currentIntent);
          await writeRunEvent({
            asset: currentIntent.asset,
            level: "error",
            eventType: "intent.truth_pending.primary_submission",
            message: `Intent ${intent.id} kept open because a primary submission attempt has unresolved venue truth`,
            payload: {
              intentId: intent.id,
              slotKey: intent.slotKey,
              attemptIds: attempts
                .filter((attempt) => attempt.legId === primaryLeg.id && isOrderAttemptTruthUnresolved(attempt))
                .map((attempt) => attempt.id),
            },
            createdAt: now,
          });
          await observeCircuitBreakerIncident(
            createExecutionIncident({
              asset: currentIntent.asset,
              slotKey: currentIntent.slotKey,
              intentId: currentIntent.id,
              stage: "primary_submission_truth_pending",
              reason: "venue_error",
              disposition: "truth_pending",
              venue: primaryLeg.venue,
              triggeredAt: now,
            }),
          );
          continue;
        }

        if (
          shouldHoldDestructiveReconcileForVenueTruth({
            venue: primaryLeg.venue,
            fetchStates: venueReconcileFetchStates,
          })
        ) {
          await holdIntentForUnavailableVenueReconcileTruth({
            intent: currentIntent,
            venue: primaryLeg.venue,
            orderStatus: null,
            stage: "primary_missing_reconcile_truth_unavailable",
            now,
            fetchStates: venueReconcileFetchStates,
          });
          continue;
        }

        currentIntent = await closeIntentWithoutExposureAccounting({
          intent,
          status: "failed",
          now,
          stage: "primary_missing_after_timeout",
          reason: "Primary order not observed before timeout or slot end",
          proof: {
            observedOrder: false,
            observedFillSummary: false,
            attemptIds: attempts.map((attempt) => attempt.id),
          },
        });
        await writeRunEvent({
          level: "warn",
          eventType: "intent.failed.primary_missing",
          message: `Intent ${intent.id} closed after primary was never observed`,
          payload: {
            intentId: intent.id,
            slotKey: intent.slotKey,
          },
          createdAt: now,
        });
      }
      continue;
    }

    if (primaryOrder) {
      if (
        !primaryOrderSummary &&
        (primaryOrder.venueOrderId !== primaryLeg.venueOrderId ||
          primaryOrder.filledSize !== primaryLeg.filledSize ||
          primaryOrder.averageFillPrice !== primaryLeg.filledPrice ||
          (primaryOrder.feeUsd ?? 0) !== primaryLeg.feeUsd)
      ) {
        currentIntent = updateIntentLeg(
          currentIntent,
          primaryLeg.venue,
          primaryOrder,
          shouldTreatPrimaryOrderAsFilled(currentIntent, primaryOrder) ? "filled" : primaryLeg.status,
          now,
        );
        currentIntent = await writeOrderIntent(currentIntent);
      }

      if (
        !primaryOrderSummary &&
        shouldTreatPrimaryOrderAsFilled(currentIntent, primaryOrder) &&
        currentIntent.status === "executing_primary"
      ) {
        currentIntent = markIntentStatus(currentIntent, hedgeOrder ? "hedging" : "primary_filled", now);
        currentIntent = await writeOrderIntent(currentIntent);
        await writeLiveTradeRunEvent(currentIntent, now, "primary_filled");
      }

      if (!primaryOrderSummary && isTerminalPrimaryOrderWithNoObservedFill(primaryOrder) && stale) {
        if (
          shouldHoldDestructiveReconcileForVenueTruth({
            venue: primaryOrder.venue,
            fetchStates: venueReconcileFetchStates,
          })
        ) {
          await holdIntentForUnavailableVenueReconcileTruth({
            intent: currentIntent,
            venue: primaryOrder.venue,
            orderStatus: primaryOrder.status,
            orderId: primaryOrder.venueOrderId,
            stage: "primary_terminal_reconcile_truth_unavailable",
            now,
            fetchStates: venueReconcileFetchStates,
          });
          continue;
        }

        currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "failed", now);
        currentIntent = await closeIntentWithoutExposureAccounting({
          intent: currentIntent,
          status: "failed",
          now,
          stage: "primary_terminal_reconciled_no_fill",
          reason: `Primary order ${primaryOrder.status}`,
          proof: {
            venue: primaryOrder.venue,
            orderId: primaryOrder.venueOrderId,
            orderStatus: primaryOrder.status,
            filledSize: primaryOrder.filledSize,
          },
        });
        await writeRunEvent({
          level: "warn",
          eventType: "intent.failed.primary_terminal",
          message: `Intent ${intent.id} closed after primary order ended in status ${primaryOrder.status}`,
          payload: {
            intentId: intent.id,
            slotKey: intent.slotKey,
            orderId: primaryOrder.venueOrderId,
            orderStatus: primaryOrder.status,
          },
          createdAt: now,
        });
        continue;
      }

      if (
        !primaryOrderSummary &&
        primaryOrder.filledSize <= ORDER_SIZE_TOLERANCE &&
        stale &&
        isAwaitingOrderConfirmation(primaryOrder.status)
      ) {
        if (
          shouldHoldDestructiveReconcileForVenueTruth({
            venue: primaryOrder.venue,
            fetchStates: venueReconcileFetchStates,
          })
        ) {
          await holdIntentForUnavailableVenueReconcileTruth({
            intent: currentIntent,
            venue: primaryOrder.venue,
            orderStatus: primaryOrder.status,
            orderId: primaryOrder.venueOrderId,
            stage: "primary_timeout_reconcile_truth_unavailable",
            now,
            fetchStates: venueReconcileFetchStates,
          });
          continue;
        }

        currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "failed", now);
        currentIntent = await closeIntentWithoutExposureAccounting({
          intent: currentIntent,
          status: "failed",
          now,
          stage: "primary_unresolved_after_timeout",
          reason: `Primary order not completed before timeout or slot end (${primaryOrder.status})`,
          proof: {
            venue: primaryOrder.venue,
            orderId: primaryOrder.venueOrderId,
            orderStatus: primaryOrder.status,
            filledSize: primaryOrder.filledSize,
          },
        });
        await writeRunEvent({
          level: "warn",
          eventType: "intent.failed.primary_timeout",
          message: `Intent ${intent.id} closed after primary order stayed unresolved`,
          payload: {
            intentId: intent.id,
            slotKey: intent.slotKey,
            orderId: primaryOrder.venueOrderId,
            orderStatus: primaryOrder.status,
          },
          createdAt: now,
        });
        continue;
      }

      if (!primaryOrderSummary && !shouldTreatPrimaryOrderAsFilled(currentIntent, primaryOrder)) {
        continue;
      }
    } else if (
      currentIntent.status !== "primary_filled" &&
      currentIntent.status !== "truth_pending" &&
      currentIntent.status !== "rescue_hedge" &&
      currentIntent.status !== "hedging"
    ) {
      continue;
    }

    if (!hedgeOrder) {
      if (
        stale &&
        (currentIntent.status === "primary_filled" ||
          currentIntent.status === "truth_pending" ||
          currentIntent.status === "rescue_hedge" ||
          currentIntent.status === "hedging")
      ) {
        const attempts = await readOrderAttemptsForIntent(intent.id);
        const unresolvedHedgeAttempts = attempts.filter(
          (attempt) =>
            attempt.legId === hedgeLeg.id &&
            isHedgeEntryAttemptStage(attempt.stage) &&
            isOrderAttemptTruthUnresolved(attempt),
        );
        if (hasUnresolvedHedgeSubmissionAttempt(attempts, hedgeLeg.id)) {
          await markIntentManualRequired(
            currentIntent,
            now,
            "hedge_submission_truth_pending_reconcile",
            "A hedge submission may have reached the venue; primary unwind is blocked until venue truth is resolved",
            {
              attemptIds: unresolvedHedgeAttempts.map((attempt) => attempt.id),
              stages: unresolvedHedgeAttempts.map((attempt) => attempt.stage),
              venue: currentIntent.hedgeVenue,
            },
          );
          continue;
        }

        if (
          shouldHoldDestructiveReconcileForVenueTruth({
            venue: hedgeLeg.venue,
            fetchStates: venueReconcileFetchStates,
          })
        ) {
          await holdIntentForUnavailableVenueReconcileTruth({
            intent: currentIntent,
            venue: hedgeLeg.venue,
            orderStatus: null,
            stage: "hedge_missing_reconcile_truth_unavailable",
            now,
            fetchStates: venueReconcileFetchStates,
          });
          continue;
        }

        await writeRunEvent({
          level: "error",
          eventType: "intent.failed.hedge_missing",
          message: `Intent ${intent.id} has no observable hedge order after primary fill`,
          payload: {
            intentId: intent.id,
            slotKey: intent.slotKey,
            venue: intent.hedgeVenue,
          },
          createdAt: now,
        });
        await attemptPrimaryUnwindAfterHedgeFailureFromReconcile(
          currentIntent,
          primaryLeg,
          hedgeLeg,
          null,
          settings,
          now,
          "Hedge order not observed before timeout or slot end",
          venueReconcileFetchStates,
        );
      }
      continue;
    }

    if (
      hedgeOrder.venueOrderId !== hedgeLeg.venueOrderId ||
      hedgeOrder.filledSize !== hedgeLeg.filledSize ||
      hedgeOrder.averageFillPrice !== hedgeLeg.filledPrice ||
      (hedgeOrder.feeUsd ?? 0) !== hedgeLeg.feeUsd
    ) {
      currentIntent = updateIntentLeg(
        currentIntent,
        hedgeLeg.venue,
        hedgeOrder,
        hedgeOrder.status === "filled" ? "hedged" : hedgeLeg.status,
        now,
      );
      currentIntent = await writeOrderIntent(currentIntent);
    }

    if (shouldTreatHedgeOrderAsComplete(hedgeLeg, hedgeOrder)) {
      currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "hedged", now);
      currentIntent = await markIntentHedgedAfterEconomicCheck(
        currentIntent,
        now,
        "reconcile_hedge_filled",
        hedgeOrder,
      );
      if (currentIntent.status === "hedged") {
        await writeLiveTradeRunEvent(currentIntent, now, "hedged");
      }
      continue;
    }

    if (hedgeOrder.filledSize > 0) {
      currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "submitted", now);
      currentIntent = await writeOrderIntent(currentIntent);
      if (
        shouldHoldDestructiveReconcileForVenueTruth({
          venue: hedgeOrder.venue,
          fetchStates: venueReconcileFetchStates,
        })
      ) {
        await holdIntentForUnavailableVenueReconcileTruth({
          intent: currentIntent,
          venue: hedgeOrder.venue,
          orderStatus: hedgeOrder.status,
          orderId: hedgeOrder.venueOrderId,
          stage: "hedge_partial_reconcile_truth_unavailable",
          now,
          fetchStates: venueReconcileFetchStates,
        });
        continue;
      }
      await writeRunEvent({
        asset: currentIntent.asset,
        level: "warn",
        eventType: "order.hedge.partial_fill_rescue_reconcile",
        message: `Hedge order partially filled for intent ${currentIntent.id}; entering recovery`,
        payload: {
          intentId: currentIntent.id,
          venue: currentIntent.hedgeVenue,
          orderId: hedgeOrder.venueOrderId,
          orderStatus: hedgeOrder.status,
          requestedSize: hedgeOrder.requestedSize,
          filledSize: hedgeOrder.filledSize,
        },
        createdAt: now,
      });
      await attemptPrimaryUnwindAfterHedgeFailureFromReconcile(
        currentIntent,
        primaryLeg,
        hedgeLeg,
        hedgeOrder,
        settings,
        now,
        `Hedge order partially filled or not final (${hedgeOrder.status})`,
        venueReconcileFetchStates,
      );
      continue;
    }

    if (stale && (isTerminalOrderStatus(hedgeOrder.status) || isAwaitingOrderConfirmation(hedgeOrder.status))) {
      if (
        shouldHoldDestructiveReconcileForVenueTruth({
          venue: hedgeOrder.venue,
          fetchStates: venueReconcileFetchStates,
        })
      ) {
        await holdIntentForUnavailableVenueReconcileTruth({
          intent: currentIntent,
          venue: hedgeOrder.venue,
          orderStatus: hedgeOrder.status,
          orderId: hedgeOrder.venueOrderId,
          stage: "hedge_stale_reconcile_truth_unavailable",
          now,
          fetchStates: venueReconcileFetchStates,
        });
        continue;
      }

      if (shouldHoldPolymarketHedgeFailurePendingTruth(currentIntent, hedgeLeg, hedgeOrder, now)) {
        await holdPolymarketHedgeFailurePendingTruth(
          currentIntent,
          hedgeLeg,
          hedgeOrder,
          now,
          "reconcile_hedge_no_fill_truth_pending",
          {
            venue: currentIntent.hedgeVenue,
            orderId: hedgeOrder.venueOrderId,
            orderStatus: hedgeOrder.status,
            requestedSize: hedgeOrder.requestedSize,
            filledSize: hedgeOrder.filledSize,
          },
        );
        continue;
      }

      await attemptPrimaryUnwindAfterHedgeFailureFromReconcile(
        currentIntent,
        primaryLeg,
        hedgeLeg,
        hedgeOrder,
        settings,
        now,
        `Hedge order not completed (${hedgeOrder.status})`,
        venueReconcileFetchStates,
      );
    }
  }

  await syncActiveSlotExecutionBreakers(now);
}

async function syncActiveSlotExecutionBreakers(now: number) {
  const incidents = (await readCurrentCircuitBreakerIncidents()).filter(
    (incident) => incident.owner === CIRCUIT_BREAKER_INCIDENT_OWNERS.execution,
  );

  for (const incident of incidents) {
    const intent = incident.intentId === null ? null : await findOrderIntent(incident.intentId);
    const exposureRecovered = intent ? isIntentExposureDurablyResolved(intent) : false;
    const recoveryProof =
      intent && exposureRecovered
        ? {
            owner: incident.owner,
            confirmedAt: now,
            evidenceId: `intent:${intent.id}:revision:${intent.revision}:status:${intent.status}`,
          }
        : undefined;

    if (incident.exposure.state === "unresolved") {
      if (!recoveryProof) {
        continue;
      }
      if (incident.resolutionPolicy === "operator") {
        await recordCircuitBreakerExposureRecoverySafely(incident, recoveryProof);
      } else {
        await resolveOwnedCircuitBreakerSafely(incident, true, recoveryProof);
      }
      continue;
    }

    if (incident.resolutionPolicy === "owner" && getEffectiveCircuitBreakerImpact(incident, now) === null) {
      await resolveOwnedCircuitBreakerSafely(incident, true);
    }
  }
}

export function isIntentExposureDurablyResolved(intent: OrderIntent) {
  if (intent.status === "settled") {
    const hasDurableVenueResolutions =
      intent.polyResolution !== null &&
      intent.kalshiResolution !== null &&
      intent.legs.every((leg) => {
        const venueResolution = leg.venue === "polymarket" ? intent.polyResolution : intent.kalshiResolution;
        return leg.resolvedOutcome === venueResolution;
      });
    if (hasDurableVenueResolutions) {
      return true;
    }
  }
  if (intent.status === "hedged" || intent.status === "settled") {
    const [first, second] = intent.legs;
    return Boolean(
      first &&
      second &&
      first.filledSize > ORDER_SIZE_TOLERANCE &&
      second.filledSize > ORDER_SIZE_TOLERANCE &&
      Math.abs(first.filledSize - second.filledSize) <= ORDER_SIZE_TOLERANCE,
    );
  }
  if (intent.status === "unwound") {
    return intent.legs.some((leg) => leg.venue === intent.primaryVenue && leg.status === "unwound");
  }
  if (intent.status === "failed" || intent.status === "skipped" || intent.status === "canceled") {
    return intent.legs.every((leg) => leg.filledSize <= ORDER_SIZE_TOLERANCE);
  }
  return false;
}

async function enforceDailyLossCap(now: number) {
  const settingsMap = await readCachedSettingsMap(now);
  const dayStart = startOfUtcDay(now);
  const incidents = (await readCurrentCircuitBreakerIncidents()).filter(
    (incident) => incident.owner === CIRCUIT_BREAKER_INCIDENT_OWNERS.dailyLoss,
  );
  for (const incident of incidents) {
    const incidentDayEnd = incident.payload?.dayEnd;
    if (typeof incidentDayEnd === "number" && incidentDayEnd <= now) {
      await resolveOwnedCircuitBreakerSafely(incident, true);
    }
  }

  const enabledSettings = Object.values(settingsMap).filter((settings) => settings.config.dailyLossCapEnabled);
  if (enabledSettings.length === 0) {
    return;
  }
  const capUsd = Math.min(...enabledSettings.map((settings) => settings.config.dailyLossHardCapUsd));
  const realizedToday = (await readAccountingRealizedPnlForUtcDay(dayStart, false)).usd;

  if (realizedToday <= -capUsd + ORDER_SIZE_TOLERANCE) {
    const incident = createDailyLossIncident({
      triggeredAt: now,
      dayStart,
      realizedPnlUsd: realizedToday,
      lossCapUsd: capUsd,
    });
    const existing = incidents.some(
      (candidate) => candidate.owner === incident.owner && candidate.incidentKey === incident.incidentKey,
    );
    if (!existing) {
      await observeCircuitBreakerIncident(incident);
      await writeRunEvent({
        level: "error",
        eventType: "killswitch.daily_loss_cap",
        message: `Daily stable realized PnL ${realizedToday.toFixed(2)} breached cap -${capUsd.toFixed(2)}`,
        payload: {
          realizedToday,
          thresholdUsd: -capUsd,
          dayStart,
        },
        createdAt: now,
      });
    }
  }
}

async function evaluateMarketDegradedBreakers(asset: MarketAsset, now: number) {
  const since = now - MARKET_DEGRADED_WINDOW_MS;
  const degradedCounts = await readDegradedMarketFillQualityCounts(since, asset);
  const incidents = (await readCurrentCircuitBreakerIncidents()).filter(
    (incident) =>
      incident.owner === CIRCUIT_BREAKER_INCIDENT_OWNERS.marketDegraded &&
      incident.scope.type === "slot" &&
      incident.scope.asset === asset,
  );
  const degradedSlotKeys = new Set<string>();

  for (const count of degradedCounts) {
    if (count.degradedCount < MARKET_DEGRADED_THRESHOLD) {
      continue;
    }
    degradedSlotKeys.add(count.slotKey);
    const existing = incidents.find(
      (incident) => incident.scope.type === "slot" && incident.scope.slotKey === count.slotKey,
    );
    const cooldownUntil = now + MARKET_DEGRADED_COOLDOWN_MS;
    const existingCooldownUntil = existing?.timestamps.cooldownUntil ?? null;
    if (existingCooldownUntil !== null && existingCooldownUntil > now + FEED_BREAKER_SYNC_INTERVAL_MS) {
      continue;
    }
    await observeCircuitBreakerIncident(
      createMarketDegradedIncident({
        asset: count.asset,
        slotKey: count.slotKey,
        triggeredAt: now,
        cooldownUntil,
        degradedCount: count.degradedCount,
        windowMs: MARKET_DEGRADED_WINDOW_MS,
      }),
    );
    if (!existing) {
      await writeRunEvent({
        asset: count.asset,
        level: "warn",
        eventType: "breaker.market_degraded",
        message: `Slot ${count.slotKey} degraded after ${count.degradedCount} bad fill outcomes`,
        payload: {
          slotKey: count.slotKey,
          degradedCount: count.degradedCount,
          cooldownUntil,
        },
        createdAt: now,
      });
    }
  }

  for (const incident of incidents) {
    if (
      incident.scope.type === "slot" &&
      !degradedSlotKeys.has(incident.scope.slotKey) &&
      getEffectiveCircuitBreakerImpact(incident, now) === null
    ) {
      await resolveOwnedCircuitBreakerSafely(incident, true);
    }
  }
}

function startOfUtcDay(now: number) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

async function refreshPnl(now: number, positions: PositionSnapshot[]) {
  const [balances, accounting] = await Promise.all([readVenueBalances(), readAllTimeAccountingLedger(false)]);

  await writePnlSnapshot(
    buildPnlSnapshot({
      capturedAt: now,
      balances,
      positions,
      realizedPnlUsd: accounting.realizedPnlUsd,
      feesUsd: accounting.feesUsd,
    }),
  );
}

async function recordStablePnlChanges(now: number, balances: VenueBalance[], positions: PositionSnapshot[]) {
  const candidates = await readStableAccountingProjectionBacklog(100);

  for (const candidate of candidates) {
    const intent: OrderIntent = {
      ...candidate.intent,
      realizedPnlUsd: candidate.realizedPnlUsd,
      roi: candidate.roi,
    };
    if (intent.shadow || intent.status !== "settled") {
      continue;
    }
    const readiness = evaluateStablePnlChangeReadiness(intent, balances, positions);
    if (!readiness.ready) {
      continue;
    }

    const inserted = await writeStablePnlChange(intent, now, readiness.stability);
    if (!inserted) {
      continue;
    }

    await writeRunEvent({
      asset: intent.asset,
      level: "info",
      eventType: "pnl.stable_change.recorded",
      message: `Stable P&L change recorded for intent ${intent.id}`,
      payload: {
        intentId: intent.id,
        asset: intent.asset,
        combination: intent.combination,
        accountingVersion: candidate.accountingVersion,
        accountingProofSha256: candidate.proofSha256,
        realizedPnlUsd: intent.realizedPnlUsd,
        ...readiness.stability,
      },
      createdAt: now,
    });
  }
}

export function evaluateStablePnlChangeReadiness(
  intent: OrderIntent,
  balances: VenueBalance[],
  positions: PositionSnapshot[],
  toleranceUsd = STABLE_PNL_BALANCE_TOLERANCE_USD,
) {
  const polymarketBalance = balances.find((balance) => balance.venue === "polymarket") ?? null;
  const kalshiBalance = balances.find((balance) => balance.venue === "kalshi") ?? null;
  const polymarketLeg = intent.legs.find((leg) => leg.venue === "polymarket") ?? null;
  const kalshiLeg = intent.legs.find((leg) => leg.venue === "kalshi") ?? null;
  const polymarketBalanceStable = isVenueCashEqualToPortfolio(polymarketBalance, toleranceUsd);
  const kalshiBalanceStable = isVenueCashEqualToPortfolio(kalshiBalance, toleranceUsd);
  const polymarketActivePosition = polymarketLeg ? hasRiskActivePositionForLeg(positions, polymarketLeg) : false;
  const kalshiActivePosition = kalshiLeg ? hasRiskActivePositionForLeg(positions, kalshiLeg) : false;
  const kalshiWon =
    kalshiLeg !== null &&
    intent.kalshiResolution !== null &&
    intent.kalshiResolution !== undefined &&
    kalshiLeg.outcome === intent.kalshiResolution;

  const checks = {
    settled: intent.status === "settled" && intent.realizedPnlUsd !== null,
    polymarketCashEqualsPortfolio: polymarketBalanceStable,
    polymarketIntentPositionCleared: !polymarketActivePosition,
    kalshiCashEqualsPortfolio: kalshiBalanceStable,
    kalshiIntentPositionCleared: !kalshiActivePosition,
  };
  const ready = Object.values(checks).every(Boolean);

  return {
    ready,
    stability: {
      ...checks,
      toleranceUsd,
      polymarket: {
        availableBalanceUsd: polymarketBalance?.availableBalanceUsd ?? null,
        portfolioValueUsd: polymarketBalance?.portfolioValueUsd ?? null,
        differenceUsd: polymarketBalance
          ? round4(polymarketBalance.portfolioValueUsd - polymarketBalance.availableBalanceUsd)
          : null,
        activeIntentPosition: polymarketActivePosition,
      },
      kalshi: {
        won: kalshiWon,
        availableBalanceUsd: kalshiBalance?.availableBalanceUsd ?? null,
        portfolioValueUsd: kalshiBalance?.portfolioValueUsd ?? null,
        differenceUsd: kalshiBalance
          ? round4(kalshiBalance.portfolioValueUsd - kalshiBalance.availableBalanceUsd)
          : null,
        activeIntentPosition: kalshiActivePosition,
      },
    },
  };
}

function isVenueCashEqualToPortfolio(
  balance: Pick<VenueBalance, "availableBalanceUsd" | "portfolioValueUsd" | "status"> | null,
  toleranceUsd: number,
) {
  return (
    balance !== null &&
    balance.status === "ready" &&
    Math.abs(balance.portfolioValueUsd - balance.availableBalanceUsd) <= toleranceUsd
  );
}

function hasRiskActivePositionForLeg(
  positions: PositionSnapshot[],
  leg: Pick<OrderIntent["legs"][number], "venue" | "marketRef" | "outcome" | "tokenId">,
) {
  return positions.some(
    (position) =>
      isRiskActivePosition(position) &&
      position.venue === leg.venue &&
      position.marketRef === leg.marketRef &&
      position.outcome === leg.outcome &&
      (leg.tokenId === undefined || extractPositionTokenId(position) === leg.tokenId),
  );
}

export function buildVenueOrderRequest(
  leg: OrderIntent["legs"][number],
  maxSlippageBps: number,
  orderType: "FOK" | "IOC" | "FAK",
  reduceOnly: boolean,
  options?: {
    kalshiPriceTicksSlippage?: number;
    kalshiPriceRanges?: readonly KalshiPriceRange[] | null;
    authoritativeTickSize?: number | null;
    overridePrice?: number | null;
    polymarketBuyMode?: "shares" | "amount";
  },
): VenueOrderRequest {
  const slippageAdjustedPrice =
    options?.overridePrice !== undefined
      ? options.overridePrice
      : leg.requestedPrice === null
        ? null
        : applySlippage(leg.requestedPrice, maxSlippageBps, leg.side);
  let price = slippageAdjustedPrice;
  if (leg.venue === "kalshi") {
    const priceRanges = options?.kalshiPriceRanges;
    if (!priceRanges || (leg.outcome !== "YES" && leg.outcome !== "NO")) {
      throw new Error("Authoritative Kalshi price_ranges are required for order pricing");
    }
    if (leg.requestedPrice === null && options.overridePrice === undefined) {
      price = null;
    } else if (options.kalshiPriceTicksSlippage !== undefined) {
      price = moveKalshiOutcomePriceByTicks({
        price: leg.requestedPrice ?? 0,
        outcome: leg.outcome,
        side: leg.side,
        ticks: options.kalshiPriceTicksSlippage,
        priceRanges,
      }).price;
    } else if (slippageAdjustedPrice !== null) {
      price = normalizeKalshiOutcomePrice({
        price: slippageAdjustedPrice,
        outcome: leg.outcome,
        side: leg.side,
        priceRanges,
      }).price;
    }
  } else if (price !== null && options?.authoritativeTickSize !== undefined) {
    const normalized = normalizePriceToAuthoritativeTick({
      price,
      tickSize: options.authoritativeTickSize ?? Number.NaN,
      side: leg.side,
    });
    if (!normalized.ok) {
      throw new Error(`Invalid authoritative Polymarket order tick: ${normalized.reason}`);
    }
    price = normalized.price;
  }
  const maxCostUsd =
    leg.venue === "polymarket" && leg.side === "BUY"
      ? round4(leg.requestedNotionalUsd)
      : leg.venue === "kalshi" && leg.side === "BUY" && price !== null
        ? round4(leg.requestedSize * price)
        : leg.requestedNotionalUsd * (1 + maxSlippageBps / 10_000);

  return {
    marketRef: leg.marketRef,
    tokenId: leg.tokenId,
    outcome: leg.outcome,
    side: leg.side,
    size: leg.requestedSize,
    price,
    maxCostUsd,
    orderType,
    buyMode: leg.venue === "polymarket" && leg.side === "BUY" ? (options?.polymarketBuyMode ?? "shares") : undefined,
    reduceOnly,
    clientOrderId: crypto.randomUUID(),
  };
}

export function immediatePartialOrderType(venue: Venue): "FAK" | "IOC" {
  return venue === "polymarket" ? "FAK" : "IOC";
}

export function primaryImmediateOrderType(venue: Venue): "FOK" | "IOC" {
  return venue === "polymarket" ? "FOK" : "IOC";
}

function buildLiveOrderRecord(
  asset: MarketAsset,
  intentId: string,
  leg: OrderIntent["legs"][number] & { side?: "BUY" | "SELL" },
  request: VenueOrderRequest,
  result: Awaited<ReturnType<VenueAdapter["placeOrder"]>>,
  now: number,
): LiveOrder {
  return {
    id: `${result.venue}:${result.venueOrderId}`,
    asset,
    shadow: false,
    intentId,
    venue: result.venue,
    venueOrderId: result.venueOrderId,
    clientOrderId: request.clientOrderId,
    marketRef: request.marketRef,
    tokenId: request.tokenId,
    side: request.side,
    outcome: leg.outcome,
    orderType: request.orderType,
    requestedPrice: request.price,
    requestedSize: request.size,
    filledSize: result.filledSize,
    averageFillPrice: result.averageFillPrice,
    feeUsd: result.feeUsd,
    status: result.status,
    createdAt: now,
    updatedAt: Date.now(),
    raw: result.raw,
  };
}

export function buildPlannedInitialEntryAttempt(
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
  request: VenueOrderRequest,
  now: number,
): OrderAttempt {
  const clientOrderId = buildStableClientOrderId({ intent, leg, request, stage: "primary" });
  const stableRequest = {
    ...request,
    clientOrderId,
  };
  return {
    id: `${intent.id}:${leg.id}:primary:${clientOrderId}`,
    asset: intent.asset,
    shadow: false,
    intentId: intent.id,
    legId: leg.id,
    stage: "primary",
    venue: leg.venue,
    side: stableRequest.side,
    orderType: stableRequest.orderType,
    clientOrderId,
    venueOrderId: null,
    status: "planned",
    truthStatus: "admitted_not_claimed",
    request: serializeVenueOrderRequest(stableRequest),
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function submitAndConfirmOrder(input: {
  intent: OrderIntent;
  leg: OrderIntent["legs"][number] & { side?: "BUY" | "SELL" };
  request: VenueOrderRequest;
  stage: string;
  now: number;
  timeoutMs: number;
  quoteObservedAt: number;
  submissionDeadlineAt: number;
  deferConfirmedPersistence?: boolean;
  admittedInitialAttemptId?: string;
}) {
  input.request.clientOrderId = buildStableClientOrderId(input);
  const attemptId = `${input.intent.id}:${input.leg.id}:${input.stage}:${input.request.clientOrderId}`;
  const serializedRequest = serializeVenueOrderRequest(input.request);
  let claimedAttempt: OrderAttempt;
  if (input.admittedInitialAttemptId !== undefined) {
    if (input.stage !== "primary" || input.admittedInitialAttemptId !== attemptId) {
      throw new Error(`Initial entry submission capability does not match ${attemptId}`);
    }
    claimedAttempt = await claimAdmittedLiveOrderAttempt({
      intentId: input.intent.id,
      attemptId,
      request: serializedRequest,
      claimedAt: Date.now(),
    });
  } else {
    const plannedAttempt: OrderAttempt = {
      id: attemptId,
      asset: input.intent.asset,
      shadow: input.intent.shadow,
      intentId: input.intent.id,
      legId: input.leg.id,
      stage: input.stage,
      venue: input.leg.venue,
      side: input.request.side,
      orderType: input.request.orderType,
      clientOrderId: input.request.clientOrderId,
      venueOrderId: null,
      status: "planned",
      truthStatus: null,
      request: serializedRequest,
      submissionDeadlineAt: input.submissionDeadlineAt,
      result: null,
      error: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    const claim = await claimLiveOrderAttemptForSubmission({
      plannedAttempt,
      submissionDeadlineAt: input.submissionDeadlineAt,
    });
    if (claim.decision === "reusable") {
      return reuseExistingOrderAttempt(input, claim.attempt);
    }
    if (claim.decision === "ambiguous") {
      if (input.leg.venue === "kalshi") {
        try {
          const recovered = await recoverSubmittedKalshiOrderAttempt(input, attemptId);
          if (recovered) {
            return recovered;
          }
        } catch (error) {
          throw new OrderSubmissionTruthUnknownError(
            attemptId,
            `Kalshi ${input.stage} recovery lookup failed after an ambiguous claim: ${toErrorMessage(error)}`,
          );
        }
      }
      throw new OrderSubmissionTruthUnknownError(
        attemptId,
        `Existing ${input.stage} order attempt ${attemptId} has ambiguous submission truth (${claim.reason}); resubmission blocked`,
      );
    }
    if (claim.decision === "rejected") {
      throw new OrderSubmissionNotStartedError(attemptId, claim.reason);
    }
    claimedAttempt = claim.attempt;
  }

  if (!Number.isSafeInteger(claimedAttempt.revision) || (claimedAttempt.revision ?? -1) < 0) {
    throw new Error(`Claimed order attempt ${attemptId} is missing its durable revision`);
  }
  assertOrderAttemptMatchesIntentLeg(claimedAttempt, input.intent, input.leg, input.request, input.stage);

  let acknowledgedSubmission: Awaited<ReturnType<VenueAdapter["placeOrder"]>> | null = null;
  let acknowledgedAt: number | null = null;
  let submissionStartedAt: number | null = null;
  try {
    const dispatch = await dispatchClaimedLiveOrderAttempt({
      attemptId,
      revalidate: () =>
        revalidateLiveOrderAttemptBeforeDispatch({
          intentId: input.intent.id,
          attemptId,
          request: serializedRequest,
          submissionDeadlineAt: input.submissionDeadlineAt,
          expectedRevision: claimedAttempt.revision as number,
        }),
      onSubmissionStarted: (startedAt) => {
        submissionStartedAt = startedAt;
      },
      placeOrder: () => adapterFor(input.leg.venue).placeOrder(input.request),
    });
    const { submission, submitStartedAt } = dispatch;
    const venueAckAt = Date.now();
    acknowledgedSubmission = submission;
    acknowledgedAt = venueAckAt;
    const submittedTiming: OrderExecutionTiming = {
      quoteObservedAt: input.quoteObservedAt,
      decisionAt: input.now,
      submitStartedAt,
      venueAckAt,
      fillObservedAt: venueAckAt,
    };
    await writeOrderAttempt({
      id: attemptId,
      asset: input.intent.asset,
      shadow: input.intent.shadow,
      intentId: input.intent.id,
      legId: input.leg.id,
      stage: input.stage,
      venue: input.leg.venue,
      side: input.request.side,
      orderType: input.request.orderType,
      clientOrderId: input.request.clientOrderId,
      venueOrderId: submission.venueOrderId,
      status: "submitted",
      truthStatus: extractVenueTruthStatus(submission.raw),
      request: serializeVenueOrderRequest(input.request),
      result: {
        ...serializeVenueOrderResult(submission),
        executionTiming: submittedTiming,
      },
      error: null,
      createdAt: input.now,
      updatedAt: Date.now(),
    });

    const result = await confirmImmediateOrderExecution(input.leg.venue, input.request, submission, input.timeoutMs);
    const timing: OrderExecutionTiming = {
      ...submittedTiming,
      fillObservedAt: Date.now(),
    };
    const order = buildLiveOrderRecord(
      input.intent.asset,
      input.intent.id,
      input.leg,
      input.request,
      result,
      input.now,
    );
    await writeVenueOrder(order);
    const persistConfirmed = async () => {
      await writeOrderAttempt({
        id: attemptId,
        asset: input.intent.asset,
        shadow: input.intent.shadow,
        intentId: input.intent.id,
        legId: input.leg.id,
        stage: input.stage,
        venue: input.leg.venue,
        side: input.request.side,
        orderType: input.request.orderType,
        clientOrderId: input.request.clientOrderId,
        venueOrderId: result.venueOrderId,
        status: "confirmed",
        truthStatus: extractVenueTruthStatus(result.raw) ?? result.status,
        request: serializeVenueOrderRequest(input.request),
        result: {
          ...serializeVenueOrderResult(result),
          executionTiming: timing,
        },
        error: null,
        createdAt: input.now,
        updatedAt: Date.now(),
      });
    };
    if (!input.deferConfirmedPersistence) {
      await persistConfirmed();
    }

    return {
      submission,
      result,
      order,
      timing,
      persistConfirmed: input.deferConfirmedPersistence ? persistConfirmed : null,
    };
  } catch (error) {
    if (submissionStartedAt === null) {
      throw error;
    }
    let recoveryError: unknown = null;
    let recovered: Awaited<ReturnType<typeof recoverSubmittedKalshiOrderAttempt>> = null;
    try {
      recovered = await recoverSubmittedKalshiOrderAttempt(input, attemptId);
    } catch (candidateRecoveryError) {
      recoveryError = candidateRecoveryError;
    }
    if (recovered) {
      return recovered;
    }

    if (acknowledgedSubmission) {
      const confirmationError = toErrorMessage(error);
      const unresolvedAcknowledgement = holdAcknowledgedOrderPendingAfterConfirmationFailure(
        acknowledgedSubmission,
        confirmationError,
      );
      const timing: OrderExecutionTiming = {
        quoteObservedAt: input.quoteObservedAt,
        decisionAt: input.now,
        submitStartedAt: submissionStartedAt ?? input.now,
        venueAckAt: acknowledgedAt ?? input.now,
        fillObservedAt: acknowledgedAt ?? input.now,
      };
      await writeOrderAttempt({
        id: attemptId,
        asset: input.intent.asset,
        shadow: input.intent.shadow,
        intentId: input.intent.id,
        legId: input.leg.id,
        stage: input.stage,
        venue: input.leg.venue,
        side: input.request.side,
        orderType: input.request.orderType,
        clientOrderId: input.request.clientOrderId,
        venueOrderId: unresolvedAcknowledgement.venueOrderId,
        status: "truth_pending",
        truthStatus: "confirmation_unknown",
        request: serializeVenueOrderRequest(input.request),
        result: {
          ...serializeVenueOrderResult(unresolvedAcknowledgement),
          executionTiming: timing,
        },
        error: `Confirmation failed after venue acknowledgement: ${confirmationError}`,
        createdAt: input.now,
        updatedAt: Date.now(),
      });
      const order = buildLiveOrderRecord(
        input.intent.asset,
        input.intent.id,
        input.leg,
        input.request,
        unresolvedAcknowledgement,
        input.now,
      );
      await writeVenueOrder(order);
      return {
        submission: acknowledgedSubmission,
        result: unresolvedAcknowledgement,
        order,
        timing,
        persistConfirmed: null,
      };
    }

    await writeOrderAttempt({
      id: attemptId,
      asset: input.intent.asset,
      shadow: input.intent.shadow,
      intentId: input.intent.id,
      legId: input.leg.id,
      stage: input.stage,
      venue: input.leg.venue,
      side: input.request.side,
      orderType: input.request.orderType,
      clientOrderId: input.request.clientOrderId,
      venueOrderId: null,
      status: "truth_pending",
      truthStatus: "submission_unknown",
      request: serializeVenueOrderRequest(input.request),
      result: null,
      error: recoveryError
        ? `${toErrorMessage(error)}; recovery lookup failed: ${toErrorMessage(recoveryError)}`
        : toErrorMessage(error),
      createdAt: input.now,
      updatedAt: Date.now(),
    });
    throw new OrderSubmissionTruthUnknownError(
      attemptId,
      `${input.leg.venue} ${input.stage} submission truth is unknown: ${toErrorMessage(error)}`,
    );
  }
}

export async function dispatchClaimedLiveOrderAttempt<T>(input: {
  attemptId: string;
  revalidate: () => Promise<{
    decision: "ready" | "expired";
    reason?: "submission_deadline_expired";
  }>;
  onSubmissionStarted: (startedAt: number) => void;
  placeOrder: () => Promise<T>;
}) {
  const decision = await input.revalidate();
  if (decision.decision === "expired") {
    throw new OrderSubmissionNotStartedError(input.attemptId, "submission_deadline_expired");
  }
  const submitStartedAt = Date.now();
  input.onSubmissionStarted(submitStartedAt);
  const submission = await input.placeOrder();
  return { submission, submitStartedAt };
}

export function buildStableClientOrderId(input: {
  intent: OrderIntent;
  leg: OrderIntent["legs"][number] & { side?: "BUY" | "SELL" };
  request: VenueOrderRequest;
  stage: string;
}) {
  const seed = JSON.stringify({
    intentId: input.intent.id,
    legId: input.leg.id,
    stage: input.stage,
    venue: input.leg.venue,
    marketRef: input.request.marketRef,
    tokenId: input.request.tokenId ?? null,
    outcome: input.request.outcome,
    side: input.request.side,
    orderType: input.request.orderType,
    reduceOnly: input.request.reduceOnly ?? false,
  });
  return `wa-${stableHexHash(seed, 30)}`;
}

function stableHexHash(value: string, length: number) {
  if (!Number.isSafeInteger(length) || length < 1 || length > 64) {
    throw new Error(`SHA-256 hex truncation length must be between 1 and 64, received ${length}`);
  }
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}

async function reuseExistingOrderAttempt(
  input: {
    intent: OrderIntent;
    leg: OrderIntent["legs"][number] & { side?: "BUY" | "SELL" };
    request: VenueOrderRequest;
    stage: string;
    now: number;
    timeoutMs: number;
  },
  existing: OrderAttempt,
) {
  const attemptId = existing.id;

  assertOrderAttemptMatchesIntentLeg(existing, input.intent, input.leg, input.request, input.stage);
  assertReusableOrderAttemptRequestProof(existing, input.request);

  if (existing.status === "confirmed" && existing.result) {
    const result = deserializeVenueOrderResult(existing.result, input.leg.venue, existing.venueOrderId);
    const order = buildLiveOrderRecord(
      input.intent.asset,
      input.intent.id,
      input.leg,
      input.request,
      result,
      input.now,
    );
    await writeVenueOrder(order);
    return {
      submission: result,
      result,
      order,
    };
  }

  if (
    (existing.status === "submitted" || existing.status === "truth_pending" || existing.status === "failed") &&
    existing.venueOrderId
  ) {
    const submission = existing.result
      ? deserializeVenueOrderResult(existing.result, input.leg.venue, existing.venueOrderId)
      : buildPendingVenueOrderResult(input.leg.venue, existing.venueOrderId, {
          recoveredFromOrderAttempt: true,
          clientOrderId: existing.clientOrderId,
        });
    const result = await confirmImmediateOrderExecution(input.leg.venue, input.request, submission, input.timeoutMs);
    const order = buildLiveOrderRecord(
      input.intent.asset,
      input.intent.id,
      input.leg,
      input.request,
      result,
      input.now,
    );
    await writeVenueOrder(order);
    await writeOrderAttempt({
      ...existing,
      venueOrderId: result.venueOrderId,
      status: "confirmed",
      truthStatus: extractVenueTruthStatus(result.raw) ?? result.status,
      result: serializeVenueOrderResult(result),
      error: null,
      updatedAt: Date.now(),
    });
    return {
      submission,
      result,
      order,
    };
  }

  if (
    (existing.status === "planned" || existing.status === "submitting" || existing.status === "truth_pending") &&
    input.leg.venue === "kalshi"
  ) {
    try {
      const recovered = await recoverSubmittedKalshiOrderAttempt(input, attemptId);
      if (recovered) {
        return recovered;
      }
    } catch (error) {
      throw new OrderSubmissionTruthUnknownError(
        attemptId,
        `Kalshi ${input.stage} recovery lookup failed: ${toErrorMessage(error)}`,
      );
    }
  }

  throw new OrderSubmissionTruthUnknownError(
    attemptId,
    `Existing ${input.stage} order attempt ${existing.id} has no reusable venue truth; resubmission blocked`,
  );
}

export function assertReusableOrderAttemptRequestProof(
  existing: Pick<OrderAttempt, "id" | "request" | "requestSha256">,
  request: VenueOrderRequest,
) {
  let storedRequestSha256: string;
  let requestedRequestSha256: string;
  try {
    storedRequestSha256 = hashOrderAttemptRequest(existing.request);
    requestedRequestSha256 = hashOrderAttemptRequest(serializeVenueOrderRequest(request));
  } catch (error) {
    throw new OrderSubmissionTruthUnknownError(
      existing.id,
      `Existing order attempt ${existing.id} has an invalid request proof; reuse and recovery blocked: ${toErrorMessage(error)}`,
    );
  }

  const persistedRequestSha256 = existing.requestSha256;
  if (
    persistedRequestSha256 === undefined ||
    persistedRequestSha256 === null ||
    persistedRequestSha256 !== storedRequestSha256 ||
    storedRequestSha256 !== requestedRequestSha256
  ) {
    throw new OrderSubmissionTruthUnknownError(
      existing.id,
      `Existing order attempt ${existing.id} does not match the canonical order request; reuse and recovery blocked`,
    );
  }

  return requestedRequestSha256;
}

export function assertOrderAttemptMatchesIntentLeg(
  attempt: Pick<
    OrderAttempt,
    "id" | "asset" | "shadow" | "intentId" | "legId" | "stage" | "venue" | "side" | "orderType" | "clientOrderId"
  >,
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
  request: VenueOrderRequest,
  stage: string,
) {
  if (
    attempt.asset !== intent.asset ||
    attempt.shadow !== intent.shadow ||
    attempt.intentId !== intent.id ||
    attempt.legId !== leg.id ||
    attempt.stage !== stage ||
    attempt.venue !== leg.venue ||
    attempt.side !== request.side ||
    attempt.orderType !== request.orderType ||
    attempt.clientOrderId !== request.clientOrderId
  ) {
    throw new OrderSubmissionTruthUnknownError(
      attempt.id,
      `Persisted order attempt ${attempt.id} does not match its canonical intent leg; reuse and dispatch blocked`,
    );
  }
}

async function recoverSubmittedKalshiOrderAttempt(
  input: {
    intent: OrderIntent;
    leg: OrderIntent["legs"][number] & { side?: "BUY" | "SELL" };
    request: VenueOrderRequest;
    stage: string;
    now: number;
  },
  attemptId: string,
) {
  const recovered = await recoverKalshiOrderSubmissionForIntent(
    input.intent,
    input.leg,
    input.request,
    input.now,
    input.stage.includes("primary") ? "primary" : "hedge",
  );
  if (!recovered) {
    return null;
  }

  await writeOrderAttempt({
    id: attemptId,
    asset: input.intent.asset,
    shadow: input.intent.shadow,
    intentId: input.intent.id,
    legId: input.leg.id,
    stage: input.stage,
    venue: input.leg.venue,
    side: input.request.side,
    orderType: input.request.orderType,
    clientOrderId: input.request.clientOrderId,
    venueOrderId: recovered.result.venueOrderId,
    status: "confirmed",
    truthStatus: extractVenueTruthStatus(recovered.result.raw) ?? recovered.result.status,
    request: serializeVenueOrderRequest(input.request),
    result: serializeVenueOrderResult(recovered.result),
    error: null,
    createdAt: input.now,
    updatedAt: Date.now(),
  });

  return {
    submission: recovered.result,
    result: recovered.result,
    order: recovered.order,
  };
}

function serializeVenueOrderRequest(request: VenueOrderRequest): Record<string, unknown> {
  return {
    marketRef: request.marketRef,
    tokenId: request.tokenId ?? null,
    outcome: request.outcome,
    side: request.side,
    size: request.size,
    price: request.price,
    maxCostUsd: request.maxCostUsd,
    orderType: request.orderType,
    buyMode: request.buyMode ?? null,
    reduceOnly: request.reduceOnly ?? false,
    clientOrderId: request.clientOrderId,
  };
}

function serializeVenueOrderResult(result: Awaited<ReturnType<VenueAdapter["placeOrder"]>>): Record<string, unknown> {
  return {
    venue: result.venue,
    venueOrderId: result.venueOrderId,
    status: result.status,
    filledSize: result.filledSize,
    averageFillPrice: result.averageFillPrice,
    feeUsd: result.feeUsd,
    raw: result.raw,
  };
}

function deserializeVenueOrderResult(
  result: Record<string, unknown>,
  venue: Venue,
  fallbackOrderId: string | null,
): Awaited<ReturnType<VenueAdapter["placeOrder"]>> {
  return {
    venue,
    venueOrderId: typeof result.venueOrderId === "string" ? result.venueOrderId : (fallbackOrderId ?? "unknown"),
    status: isVenueOrderStatus(result.status) ? result.status : "pending",
    filledSize: typeof result.filledSize === "number" ? result.filledSize : 0,
    averageFillPrice: typeof result.averageFillPrice === "number" ? result.averageFillPrice : null,
    feeUsd: typeof result.feeUsd === "number" ? result.feeUsd : 0,
    raw: result.raw && typeof result.raw === "object" ? (result.raw as Record<string, unknown>) : result,
  };
}

function buildPendingVenueOrderResult(
  venue: Venue,
  venueOrderId: string,
  raw: Record<string, unknown>,
): Awaited<ReturnType<VenueAdapter["placeOrder"]>> {
  return {
    venue,
    venueOrderId,
    status: "pending",
    filledSize: 0,
    averageFillPrice: null,
    feeUsd: 0,
    raw,
  };
}

export function holdAcknowledgedOrderPendingAfterConfirmationFailure(
  result: VenueOrderResult,
  error: string,
): VenueOrderResult {
  const terminalZeroFill = isTerminalOrderStatus(result.status) && result.filledSize <= ORDER_SIZE_TOLERANCE;
  return {
    ...result,
    status: terminalZeroFill ? "pending" : result.status,
    raw: {
      ...result.raw,
      acknowledgedStatus: result.status,
      confirmationTruthPending: true,
      confirmationError: error,
    },
  };
}

function isVenueOrderStatus(value: unknown): value is Awaited<ReturnType<VenueAdapter["placeOrder"]>>["status"] {
  return (
    value === "pending" ||
    value === "live" ||
    value === "filled" ||
    value === "partially_filled" ||
    value === "canceled" ||
    value === "expired" ||
    value === "rejected"
  );
}

function extractVenueTruthStatus(raw: Record<string, unknown> | null | undefined) {
  const truth = raw?.orderTruth;
  if (truth && typeof truth === "object" && "status" in truth && typeof truth.status === "string") {
    return truth.status;
  }

  if (truth && typeof truth === "object" && "terminalZeroFill" in truth && truth.terminalZeroFill === true) {
    return "terminal_zero_fill";
  }

  return null;
}

function buildPendingShadowOrder(
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
  now: number,
  suffix: string,
): LiveOrder {
  return {
    id: `shadow:${intent.id}:${leg.venue}:${suffix}`,
    asset: intent.asset,
    shadow: true,
    intentId: intent.id,
    venue: leg.venue,
    venueOrderId: `shadow-${suffix}-${intent.id}-${leg.venue}`,
    clientOrderId: `shadow-${suffix}-${intent.id}`,
    marketRef: leg.marketRef,
    tokenId: leg.tokenId,
    side: leg.side,
    outcome: leg.outcome,
    orderType: "SHADOW_REST_IOC",
    requestedPrice: leg.requestedPrice,
    requestedSize: leg.requestedSize,
    filledSize: 0,
    averageFillPrice: null,
    feeUsd: 0,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    raw: {
      shadow: true,
      modelVersion: intent.shadowExecution?.modelVersion ?? SHADOW_EXECUTION_MODEL_VERSION,
      restStartedAt: intent.shadowExecution?.restStartedAt ?? null,
      completionNotBeforeAt: intent.shadowExecution?.completionNotBeforeAt ?? null,
    },
  };
}

function buildCompletedShadowOrder(
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
  audit: NonNullable<OrderIntent["shadowExecution"]>,
  now: number,
): LiveOrder {
  const suffix = leg.venue === intent.primaryVenue ? "primary" : "hedge";
  const pending = buildPendingShadowOrder(intent, leg, intent.createdAt, suffix);
  const auditLeg = audit.legs.find((candidate) => candidate.venue === leg.venue);
  const preparedFill = audit.status === "filled" ? getPreparedShadowRestFillEconomics(intent, audit, leg.id) : null;
  const filledSize = audit.status === "filled" ? (preparedFill?.size ?? audit.filledPairSize) : 0;
  return {
    ...pending,
    filledSize,
    averageFillPrice: audit.status === "filled" ? (preparedFill?.price ?? auditLeg?.vwapPrice ?? null) : null,
    feeUsd: audit.status === "filled" ? (preparedFill?.feeUsd ?? auditLeg?.feeUsd ?? 0) : 0,
    status:
      audit.status === "no_fill"
        ? "canceled"
        : filledSize + ORDER_SIZE_TOLERANCE >= leg.requestedSize
          ? "filled"
          : "partially_filled",
    updatedAt: now,
    raw: {
      ...pending.raw,
      modelVersion: audit.modelVersion,
      evaluatedAt: now,
      latencyMs: audit.latencyMs,
      restFetchDurationMs: audit.restFetchDurationMs,
      nextEligibleAt: audit.nextEligibleAt,
      decision: audit.status,
      reasonCode: audit.reasonCode,
      reason: audit.reason,
      limitPrice: auditLeg?.limitPrice ?? null,
      executableSize: auditLeg?.executableSize ?? 0,
    },
  };
}

function buildShadowFill(
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
  order: LiveOrder,
  auditLeg: NonNullable<OrderIntent["shadowExecution"]>["legs"][number],
  audit: NonNullable<OrderIntent["shadowExecution"]>,
) {
  const filledAt = audit.evaluatedAt;
  if (filledAt === null || auditLeg.vwapPrice === null) {
    throw new Error(`Intent ${intent.id} is missing final shadow fill evidence for leg ${leg.id}`);
  }
  const preparedFill = getPreparedShadowRestFillEconomics(intent, audit, leg.id);
  if (preparedFill && Math.abs(order.filledSize - preparedFill.size) > ORDER_SIZE_TOLERANCE) {
    throw new Error(`Intent ${intent.id} has a shadow order size that conflicts with its durable REST proof`);
  }
  const identity = buildShadowAccountingFillIdentity(intent.id, leg.id);
  return {
    id: identity.fillId,
    asset: intent.asset,
    shadow: true,
    intentId: intent.id,
    venue: leg.venue,
    venueOrderId: order.venueOrderId,
    tradeId: identity.tradeId,
    marketRef: leg.marketRef,
    tokenId: leg.tokenId,
    side: leg.side,
    outcome: leg.outcome,
    price: preparedFill?.price ?? auditLeg.vwapPrice,
    size: preparedFill?.size ?? order.filledSize,
    feeUsd: preparedFill?.feeUsd ?? auditLeg.feeUsd,
    liquidity: "TAKER" as const,
    filledAt,
    raw: {
      shadow: true,
      modelVersion: audit.modelVersion,
      latencyMs: audit.latencyMs,
      limitPrice: auditLeg.limitPrice,
      requestedSize: leg.requestedSize,
      fillRatio: audit.fillRatio,
      preparedNotionalUsd: preparedFill?.notionalUsd ?? null,
      preparedTotalCostUsd: preparedFill?.totalCostUsd ?? null,
    },
  };
}

export function updateIntentLeg(
  intent: OrderIntent,
  venue: OrderIntent["legs"][number]["venue"],
  order: LiveOrder,
  status: OrderIntent["legs"][number]["status"],
  now: number,
) {
  return {
    ...intent,
    updatedAt: now,
    legs: intent.legs.map((leg) => {
      if (leg.venue !== venue) {
        return leg;
      }

      const filledSize = Math.max(leg.filledSize, order.filledSize);
      const incomingFillRegresses = order.filledSize < leg.filledSize;
      const incomingHasNoFillAgainstExistingFill = leg.filledSize > 0 && order.filledSize <= 0;
      const preserveExistingEvidence = incomingFillRegresses || incomingHasNoFillAgainstExistingFill;
      const mergedStatus = mergeIntentLegStatus(leg.status, status, leg.filledSize, order.filledSize);
      const filledAt = order.filledSize > 0 ? Math.max(leg.filledAt ?? 0, order.updatedAt) : leg.filledAt;
      return {
        ...leg,
        venueOrderId: preserveExistingEvidence ? leg.venueOrderId : order.venueOrderId,
        filledSize,
        filledPrice: preserveExistingEvidence ? leg.filledPrice : (order.averageFillPrice ?? leg.filledPrice),
        ...(filledAt === undefined ? {} : { filledAt }),
        feeUsd: Math.max(leg.feeUsd, order.feeUsd ?? 0),
        status: mergedStatus,
      };
    }) as OrderIntent["legs"],
  };
}

function mergeIntentLegStatus(
  current: OrderIntent["legs"][number]["status"],
  incoming: OrderIntent["legs"][number]["status"],
  currentFilledSize: number,
  incomingFilledSize: number,
) {
  if (current === "unwound") {
    return current;
  }
  if (incoming === "unwound") {
    return incoming;
  }
  if (current === "hedged") {
    return current;
  }
  if (incoming === "hedged") {
    return incoming;
  }
  if (incoming === "filled") {
    return incoming;
  }
  if (current === "filled") {
    return current;
  }
  if (incomingFilledSize < currentFilledSize || (currentFilledSize > 0 && incomingFilledSize <= 0)) {
    return current;
  }
  if (current === "failed" && incoming === "submitted" && incomingFilledSize <= currentFilledSize) {
    return current;
  }
  return incoming;
}

type PostSubmissionEvidenceDependencies = {
  writeIntent: (intent: OrderIntent) => Promise<OrderIntent>;
  readIntent: (intentId: string) => Promise<OrderIntent | null>;
  recordIncident: (input: { intent: OrderIntent; order: LiveOrder; stage: string; error: unknown }) => Promise<void>;
};

export async function persistPostSubmissionLegEvidence(
  intent: OrderIntent,
  order: LiveOrder,
  status: OrderIntent["legs"][number]["status"],
  now: number,
  stage: string,
  dependencies: PostSubmissionEvidenceDependencies = {
    writeIntent: writeOrderIntent,
    readIntent: findOrderIntent,
    recordIncident: recordPostSubmissionIntentPersistenceIncident,
  },
) {
  return persistPostSubmissionIntentEvidence(
    updateIntentLeg(intent, order.venue, order, status, now),
    order,
    now,
    stage,
    dependencies,
  );
}

export async function persistPostSubmissionIntentEvidence(
  observedIntent: OrderIntent,
  order: LiveOrder,
  now: number,
  stage: string,
  dependencies: PostSubmissionEvidenceDependencies = {
    writeIntent: writeOrderIntent,
    readIntent: findOrderIntent,
    recordIncident: recordPostSubmissionIntentPersistenceIncident,
  },
) {
  let candidate = observedIntent;
  let lastError: unknown = null;
  let recoveredFromConflict = false;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return {
        intent: await dependencies.writeIntent(candidate),
        durable: true as const,
        recoveredFromConflict,
      };
    } catch (error) {
      lastError = error;
      if (!(error instanceof OrderIntentRevisionConflictError)) {
        break;
      }
      recoveredFromConflict = true;

      try {
        const latest = await dependencies.readIntent(observedIntent.id);
        if (!latest) {
          break;
        }
        const merged = mergePostSubmissionIntentEvidence(latest, candidate, now);
        if (merged.status === latest.status && JSON.stringify(merged.legs) === JSON.stringify(latest.legs)) {
          return {
            intent: latest,
            durable: true as const,
            recoveredFromConflict,
          };
        }
        candidate = merged;
      } catch (readError) {
        lastError = readError;
        break;
      }
    }
  }

  await dependencies.recordIncident({
    intent: candidate,
    order,
    stage,
    error: lastError,
  });
  const latest = await dependencies.readIntent(observedIntent.id).catch(() => null);
  return {
    intent: latest ?? candidate,
    durable: false as const,
    recoveredFromConflict,
  };
}

function mergePostSubmissionIntentEvidence(canonical: OrderIntent, observed: OrderIntent, now: number) {
  const observedLegs = new Map(observed.legs.map((leg) => [leg.id, leg]));
  return {
    ...canonical,
    status: mergePostSubmissionIntentStatus(canonical, observed),
    updatedAt: Math.max(canonical.updatedAt, now),
    legs: canonical.legs.map((leg) => {
      const incoming = observedLegs.get(leg.id);
      if (!incoming) {
        return leg;
      }

      const incomingFillAdvances = incoming.filledSize > leg.filledSize;
      const preserveExistingEvidence =
        incoming.filledSize < leg.filledSize || (leg.filledSize > 0 && incoming.filledSize <= 0);
      const filledAt = Math.max(leg.filledAt ?? 0, incoming.filledAt ?? 0);
      return {
        ...leg,
        venueOrderId:
          preserveExistingEvidence || (leg.filledSize > 0 && incoming.filledSize === leg.filledSize)
            ? leg.venueOrderId
            : (incoming.venueOrderId ?? leg.venueOrderId),
        filledSize: Math.max(leg.filledSize, incoming.filledSize),
        filledPrice: incomingFillAdvances || leg.filledPrice === null ? incoming.filledPrice : leg.filledPrice,
        ...(filledAt === 0 ? {} : { filledAt }),
        feeUsd: Math.max(leg.feeUsd, incoming.feeUsd),
        status: mergeIntentLegStatus(leg.status, incoming.status, leg.filledSize, incoming.filledSize),
      };
    }) as OrderIntent["legs"],
  };
}

function mergePostSubmissionIntentStatus(canonical: OrderIntent, observed: OrderIntent) {
  if (observed.status !== "primary_filled") {
    return canonical.status;
  }
  const primaryLeg = observed.legs.find((leg) => leg.venue === observed.primaryVenue);
  if (!primaryLeg || primaryLeg.filledSize <= 0) {
    return canonical.status;
  }
  if (canonical.status === "pending" || canonical.status === "executing_primary" || canonical.status === "failed") {
    return "primary_filled" as const;
  }
  return canonical.status;
}

async function recordPostSubmissionIntentPersistenceIncident(input: {
  intent: OrderIntent;
  order: LiveOrder;
  stage: string;
  error: unknown;
}) {
  const incidentAt = Date.now();
  await observeCircuitBreakerIncident(
    createExecutionIncident({
      asset: input.intent.asset,
      slotKey: input.intent.slotKey,
      intentId: input.intent.id,
      stage: input.stage,
      reason: "hedge_failure",
      disposition: "manual_intervention",
      venue: input.order.venue,
      orderId: input.order.venueOrderId,
      triggeredAt: incidentAt,
    }),
  );
  await writeIntentIncidentRunEvent(
    input.intent,
    incidentAt,
    input.stage,
    "Post-submission order evidence could not be attached to the canonical intent",
    {
      venue: input.order.venue,
      orderId: input.order.venueOrderId,
      orderStatus: input.order.status,
      filledSize: input.order.filledSize,
      persistenceError: toErrorMessage(input.error),
    },
  );
}

function accumulateIntentLegOrder(
  intent: OrderIntent,
  legId: OrderIntent["legs"][number]["id"],
  order: LiveOrder,
  status: OrderIntent["legs"][number]["status"],
  now: number,
) {
  return {
    ...intent,
    updatedAt: now,
    legs: intent.legs.map((leg) => {
      if (leg.id !== legId) {
        return leg;
      }

      const nextFilledSize = roundToSixDecimals(leg.filledSize + order.filledSize);
      const nextGrossNotionalUsd =
        leg.filledSize * (leg.filledPrice ?? 0) + order.filledSize * (order.averageFillPrice ?? 0);
      const filledAt = order.filledSize > 0 ? Math.max(leg.filledAt ?? 0, order.updatedAt) : leg.filledAt;

      return {
        ...leg,
        venueOrderId: order.venueOrderId,
        filledSize: nextFilledSize,
        filledPrice: nextFilledSize > 0 ? round4(nextGrossNotionalUsd / nextFilledSize) : leg.filledPrice,
        ...(filledAt === undefined ? {} : { filledAt }),
        feeUsd: round4(leg.feeUsd + (order.feeUsd ?? 0)),
        status,
      };
    }) as OrderIntent["legs"],
  };
}

function updateIntentLegFromFillSummary(
  intent: OrderIntent,
  legId: OrderIntent["legs"][number]["id"],
  summary: ReturnType<typeof summarizeVenueFills>,
  now: number,
) {
  return {
    ...intent,
    updatedAt: now,
    legs: intent.legs.map((leg) => {
      if (leg.id !== legId) {
        return leg;
      }

      const filledSize = Math.max(leg.filledSize, summary.filledSize);
      const filledAt = summary.filledSize > 0 ? Math.max(leg.filledAt ?? 0, summary.lastFilledAt ?? now) : leg.filledAt;
      return {
        ...leg,
        venueOrderId: summary.venueOrderId ?? leg.venueOrderId,
        filledSize,
        filledPrice: summary.filledSize >= leg.filledSize ? summary.averageFillPrice : leg.filledPrice,
        ...(filledAt === undefined ? {} : { filledAt }),
        feeUsd: Math.max(leg.feeUsd, summary.feeUsd),
        status:
          leg.status === "unwound"
            ? "unwound"
            : leg.status === "hedged"
              ? "hedged"
              : filledSize > 0
                ? leg.venue === intent.hedgeVenue
                  ? "hedged"
                  : "filled"
                : leg.status,
      };
    }) as OrderIntent["legs"],
  };
}

export function summarizeIntentLegOrders(
  orders: LiveOrder[],
  intent: Pick<OrderIntent, "id" | "asset" | "shadow">,
  leg: OrderIntent["legs"][number],
  mode: "entry" | "exit",
) {
  const matchingOrders = orders.filter((order) => isVenueOrderCanonicalForIntentLeg(order, intent, leg, mode));
  if (matchingOrders.length === 0) {
    return null;
  }

  const filledOrders = matchingOrders
    .filter((order) => order.filledSize > 0 && order.averageFillPrice !== null)
    .map((order) => ({
      venueOrderId: order.venueOrderId,
      size: order.filledSize,
      price: order.averageFillPrice ?? 0,
      feeUsd: order.feeUsd ?? 0,
      filledAt: order.updatedAt,
    }));
  if (filledOrders.length === 0) {
    return null;
  }

  const summary = summarizeVenueFills(filledOrders);
  return {
    ...summary,
    venueOrderId: matchingOrders[0]?.venueOrderId ?? summary.venueOrderId,
  };
}

export function isVenueOrderCanonicalForIntentLeg(
  order: LiveOrder,
  intent: Pick<OrderIntent, "id" | "asset" | "shadow">,
  leg: OrderIntent["legs"][number],
  mode: "entry" | "exit",
) {
  const expectedSide = mode === "entry" ? leg.side : leg.side === "BUY" ? "SELL" : "BUY";
  return (
    order.asset === intent.asset &&
    order.shadow === intent.shadow &&
    order.intentId === intent.id &&
    leg.intentId === intent.id &&
    order.venue === leg.venue &&
    order.marketRef === leg.marketRef &&
    order.outcome === leg.outcome &&
    order.side === expectedSide &&
    (order.tokenId ?? null) === (leg.tokenId ?? null)
  );
}

function resizeHedgeLegToFilledPrimary(intent: OrderIntent, now: number) {
  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
  if (!primaryLeg || !hedgeLeg || primaryLeg.filledSize <= 0) {
    return intent;
  }

  const resizedHedgeSize = normalizeVenueTargetSize(
    hedgeLeg.venue,
    primaryLeg.filledSize,
    null,
    hedgeLeg.venue === "polymarket" ? 0.01 : 1,
  );
  if (resizedHedgeSize <= 0) {
    return intent;
  }

  return {
    ...intent,
    updatedAt: now,
    legs: intent.legs.map((leg) =>
      leg.id === hedgeLeg.id
        ? {
            ...leg,
            requestedSize: resizedHedgeSize,
            requestedNotionalUsd: round4(resizedHedgeSize * (leg.requestedPrice ?? 0)),
          }
        : leg,
    ) as OrderIntent["legs"],
  };
}

function deriveUnhedgedPrimarySize(intent: Pick<OrderIntent, "primaryVenue" | "hedgeVenue" | "legs">) {
  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
  if (!primaryLeg || !hedgeLeg) {
    return 0;
  }

  return roundToSixDecimals(Math.max(0, primaryLeg.filledSize - hedgeLeg.filledSize));
}

function deriveOverfilledHedgeSize(intent: Pick<OrderIntent, "primaryVenue" | "hedgeVenue" | "legs">) {
  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
  if (!primaryLeg || !hedgeLeg) {
    return 0;
  }

  return roundToSixDecimals(Math.max(0, hedgeLeg.filledSize - primaryLeg.filledSize));
}

export function evaluateBenignHedgeOverfill(
  intent: Pick<OrderIntent, "primaryVenue" | "hedgeVenue" | "legs">,
  settings: Pick<StrategyConfig, "minWorstCaseProfitUsd">,
) {
  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
  const overfilledHedgeSize = deriveOverfilledHedgeSize(intent);
  const economics = deriveHedgedPairEconomics(intent.legs);
  const hedgeFilledPrice = hedgeLeg?.filledPrice ?? null;
  const hedgeRequestedPrice = hedgeLeg?.requestedPrice ?? null;
  const hedgePrice =
    hedgeFilledPrice !== null && Number.isFinite(hedgeFilledPrice) && hedgeFilledPrice > 0
      ? hedgeFilledPrice
      : hedgeRequestedPrice !== null && Number.isFinite(hedgeRequestedPrice) && hedgeRequestedPrice > 0
        ? hedgeRequestedPrice
        : null;
  const overfillNotionalUsd =
    hedgePrice !== null && Number.isFinite(hedgePrice) ? round4(overfilledHedgeSize * hedgePrice) : null;
  const maxBenignOverfillNotionalUsd = round4(Math.max(0, settings.minWorstCaseProfitUsd));
  const economicallyCovered =
    economics.polymarketFilledSize > ORDER_SIZE_TOLERANCE &&
    economics.kalshiFilledSize > ORDER_SIZE_TOLERANCE &&
    economics.netWorstCaseUsd > ORDER_SIZE_TOLERANCE;
  const withinBenignBudget =
    overfillNotionalUsd !== null &&
    overfillNotionalUsd > ORDER_SIZE_TOLERANCE &&
    overfillNotionalUsd <= maxBenignOverfillNotionalUsd + ORDER_SIZE_TOLERANCE;

  return {
    benign: overfilledHedgeSize > ORDER_SIZE_TOLERANCE && economicallyCovered && withinBenignBudget,
    overfilledHedgeSize,
    overfillNotionalUsd,
    maxBenignOverfillNotionalUsd,
    economicallyCovered,
    economics,
    primaryFilledSize: primaryLeg?.filledSize ?? 0,
    hedgeFilledSize: hedgeLeg?.filledSize ?? 0,
  };
}

function resizeHedgeLegToUnhedgedPrimary(intent: OrderIntent, now: number) {
  const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
  if (!hedgeLeg) {
    return intent;
  }

  const unhedgedPrimarySize = deriveUnhedgedPrimarySize(intent);
  const resizedHedgeSize = normalizeVenueTargetSize(
    hedgeLeg.venue,
    unhedgedPrimarySize,
    null,
    hedgeLeg.venue === "polymarket" ? 0.01 : 1,
  );
  if (resizedHedgeSize <= 0) {
    return intent;
  }

  return {
    ...intent,
    updatedAt: now,
    legs: intent.legs.map((leg) =>
      leg.id === hedgeLeg.id
        ? {
            ...leg,
            requestedSize: resizedHedgeSize,
            requestedNotionalUsd: round4(resizedHedgeSize * (leg.requestedPrice ?? 0)),
          }
        : leg,
    ) as OrderIntent["legs"],
  };
}

async function syncIntentFromStoredVenueFills(
  intentId: string,
  venue: OrderIntent["legs"][number]["venue"],
  currentIntent?: OrderIntent,
) {
  let intent = currentIntent ?? (await findOrderIntent(intentId));
  if (!intent) {
    return currentIntent ?? null;
  }

  const fills = await readFillsForIntentVenue(intentId, venue);
  if (fills.length === 0) {
    return intent;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const canonicalIntent = intent;
    const leg = intent.legs.find((candidate) => candidate.venue === venue);
    if (!leg) {
      return intent;
    }

    const canonicalFills = fills.filter((fill) => resolveAccountingLegForFill(canonicalIntent, fill)?.id === leg.id);
    const summary = summarizeIntentLegFills(canonicalFills, leg, "entry");
    if (!summary) {
      return intent;
    }

    const updatedIntent = updateIntentLegFromFillSummary(intent, leg.id, summary, Date.now());
    if (JSON.stringify(updatedIntent.legs) === JSON.stringify(intent.legs)) {
      return intent;
    }

    try {
      return await writeOrderIntent(updatedIntent);
    } catch (error) {
      if (!(error instanceof OrderIntentRevisionConflictError) || attempt === 2) {
        throw error;
      }
      const latestIntent = await findOrderIntent(intentId);
      if (!latestIntent) {
        throw error;
      }
      intent = latestIntent;
    }
  }

  return intent;
}

async function confirmImmediateOrderExecution(
  venue: OrderIntent["primaryVenue"],
  request: VenueOrderRequest,
  submission: Awaited<ReturnType<VenueAdapter["placeOrder"]>>,
  timeoutMs: number,
) {
  if (venue === "polymarket") {
    const canQueryOrderTruth =
      typeof submission.venueOrderId === "string" &&
      submission.venueOrderId.length > 0 &&
      !submission.venueOrderId.startsWith("killed:");
    if (!canQueryOrderTruth) {
      return submission;
    }

    const fillWakeup = marketDataSupervisor.waitForOrderFill({
      venue,
      venueOrderId: submission.venueOrderId,
      clientOrderId: request.clientOrderId,
      marketRef: request.marketRef,
      timeoutMs,
    });

    const confirmation = await confirmPolymarketOrderExecution({
      orderId: submission.venueOrderId,
      expectedSize: request.size,
      expectedSizeIsExact: request.side !== "BUY" || request.buyMode !== "amount",
      orderType: request.orderType,
      timeoutMs,
      pollWakeup: fillWakeup,
    });
    const confirmedResult = {
      ...confirmation.result,
      raw: {
        ...(submission.raw ?? {}),
        ...(confirmation.result.raw ?? {}),
        initialSubmissionStatus: submission.status,
      },
    };
    if (request.orderType === "FOK" && confirmation.result.status === "live") {
      await polymarketAdapter.cancelOrder(submission.venueOrderId).catch(() => null);
      const canceledConfirmation = await confirmPolymarketOrderExecution({
        orderId: submission.venueOrderId,
        expectedSize: request.size,
        expectedSizeIsExact: request.side !== "BUY" || request.buyMode !== "amount",
        orderType: request.orderType,
        timeoutMs: Math.min(1_000, timeoutMs),
        pollWakeup: fillWakeup,
      });
      return {
        ...canceledConfirmation.result,
        raw: {
          ...(submission.raw ?? {}),
          ...(canceledConfirmation.result.raw ?? {}),
          initialSubmissionStatus: submission.status,
          cancelAttemptedAfterTimeout: true,
        },
      };
    }

    return confirmedResult;
  }

  if (submission.status === "rejected" || submission.status === "canceled" || submission.status === "expired") {
    return submission;
  }

  if (submission.status !== "live" && submission.status !== "pending" && submission.status !== "partially_filled") {
    return submission;
  }

  const deadline = Date.now() + timeoutMs;
  let latest = submission;
  let fillWakeup: Promise<boolean> | null = marketDataSupervisor
    .waitForOrderFill({
      venue,
      venueOrderId: submission.venueOrderId,
      clientOrderId: request.clientOrderId,
      marketRef: request.marketRef,
      timeoutMs,
    })
    .then(
      () => true,
      () => true,
    );
  while (Date.now() <= deadline) {
    const liveOrder = await kalshiAdapter.getOrder(submission.venueOrderId, request).catch(() => null);
    if (liveOrder) {
      latest = normalizeOrderResultFromLiveOrder(liveOrder, submission.raw);
      if (latest.status !== "live" && latest.status !== "pending") {
        return latest;
      }
    }
    if (fillWakeup) {
      const wokeForFill = await Promise.race([sleep(200).then(() => false), fillWakeup]);
      if (wokeForFill) {
        fillWakeup = null;
      }
    } else {
      await sleep(200);
    }
  }

  if (request.orderType === "FOK" && (latest.status === "live" || latest.status === "pending")) {
    await kalshiAdapter.cancelOrder(submission.venueOrderId).catch(() => null);
    const liveOrder = await kalshiAdapter.getOrder(submission.venueOrderId, request).catch(() => null);
    if (liveOrder) {
      latest = normalizeOrderResultFromLiveOrder(liveOrder, {
        ...(latest.raw ?? {}),
        cancelAttemptedAfterTimeout: true,
      });
    }
  }

  return latest;
}

function normalizeOrderResultFromLiveOrder(
  order: LiveOrder,
  fallbackRaw: Record<string, unknown>,
): Awaited<ReturnType<VenueAdapter["placeOrder"]>> {
  return {
    venue: order.venue,
    venueOrderId: order.venueOrderId,
    status: order.status,
    filledSize: order.filledSize,
    averageFillPrice: order.averageFillPrice,
    feeUsd: order.feeUsd ?? 0,
    raw: order.raw ?? fallbackRaw,
  };
}

async function recoverKalshiOrderSubmissionForIntent(
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
  request: VenueOrderRequest,
  now: number,
  stage: "primary" | "hedge",
) {
  if (leg.venue !== "kalshi") {
    return null;
  }

  const kalshiOrders = await fetchKalshiOrders();
  const recoveredOrder = kalshiOrders.find(
    (order) => order.client_order_id === request.clientOrderId && matchesKalshiOrderRequest(order, request),
  );
  if (!recoveredOrder) {
    return null;
  }
  if (leg.outcome !== "YES" && leg.outcome !== "NO") {
    return null;
  }

  const filledSize = Number(recoveredOrder.fill_count_fp ?? 0);
  const remainingSize = Number(recoveredOrder.remaining_count_fp ?? 0);
  const result: Awaited<ReturnType<VenueAdapter["placeOrder"]>> = {
    venue: "kalshi",
    venueOrderId: recoveredOrder.order_id,
    status: mapKalshiOrderStatus(recoveredOrder.status, filledSize, remainingSize),
    filledSize,
    averageFillPrice:
      getKalshiOrderPriceUsd(leg.outcome, {
        yes_price_dollars: recoveredOrder.yes_price_dollars,
        no_price_dollars: recoveredOrder.no_price_dollars,
      }) ?? null,
    feeUsd: Number(recoveredOrder.taker_fees_dollars ?? recoveredOrder.maker_fees_dollars ?? 0),
    raw: recoveredOrder as unknown as Record<string, unknown>,
  };
  const order = buildLiveOrderRecord(intent.asset, intent.id, leg, request, result, now);
  await writeVenueOrder(order);
  await writeRunEvent({
    level: "warn",
    eventType: `order.${stage}.recovered`,
    message: `${stage === "primary" ? "Primary" : "Hedge"} Kalshi order recovered via client_order_id`,
    payload: {
      intentId: intent.id,
      venue: leg.venue,
      clientOrderId: request.clientOrderId,
      orderId: order.venueOrderId,
      orderStatus: order.status,
    },
    createdAt: now,
  });

  return {
    result,
    order,
  };
}

function isTerminalOrderStatus(status: LiveOrder["status"]) {
  return status === "canceled" || status === "rejected" || status === "expired";
}

export function isBreakerRelevantToSlot(
  breaker: Pick<CircuitBreaker, "key">,
  asset: MarketAsset,
  slotKey: string | null,
) {
  return (
    breaker.key === "global" ||
    breaker.key === buildAssetBreakerKey(asset) ||
    (slotKey !== null && breaker.key === buildSlotBreakerKey(slotKey))
  );
}

export function isFeedHealthBreaker(breaker: Pick<CircuitBreaker, "reason" | "payload"> | null | undefined) {
  return (
    breaker?.reason === "venue_error" &&
    breaker.payload !== null &&
    typeof breaker.payload === "object" &&
    Array.isArray((breaker.payload as { feeds?: unknown }).feeds)
  );
}

export function shouldManageFeedHealthBreaker(
  breaker: Pick<CircuitBreaker, "active" | "reason" | "payload"> | null | undefined,
) {
  return !breaker?.active || isFeedHealthBreaker(breaker);
}

function isSlotExecutionBreakerReason(reason: CircuitBreaker["reason"]): reason is "hedge_failure" | "primary_no_fill" {
  return reason === "hedge_failure" || reason === "primary_no_fill";
}

function getCircuitBreakerReadinessStatus(
  breaker: Pick<CircuitBreaker, "active" | "key" | "payload" | "reason">,
  now: number,
): "ready" | "cooldown" | "degraded" | "blocked" {
  if (!breaker.active) {
    return "ready";
  }

  const cooldownUntil = getPayloadNumber(breaker.payload, "cooldownUntil");
  if (isSlotExecutionBreakerReason(breaker.reason)) {
    if (getPayloadBoolean(breaker.payload, "requiresManualClear")) {
      return "blocked";
    }

    if (cooldownUntil !== null && now < cooldownUntil) {
      return "cooldown";
    }

    if (breaker.key === "global") {
      return "blocked";
    }

    return "degraded";
  }

  if (cooldownUntil !== null && now < cooldownUntil) {
    return "cooldown";
  }

  return "blocked";
}

export function shouldPauseExecutionForBreaker(
  breaker: Pick<CircuitBreaker, "active" | "key" | "payload" | "reason">,
  now: number,
  asset: MarketAsset,
  slotKey: string | null,
) {
  if (!isBreakerRelevantToSlot(breaker, asset, slotKey)) {
    return false;
  }

  if (breaker.active && breaker.key === "global") {
    return true;
  }

  const status = getCircuitBreakerReadinessStatus(breaker, now);
  return status === "blocked" || status === "cooldown";
}

export function shouldKeepSlotExecutionBreakerActive(
  breaker: Pick<CircuitBreaker, "active" | "key" | "payload" | "reason">,
  now: number,
  currentSlotKeys: Set<string>,
  unresolvedSlots: Set<string>,
) {
  if (!breaker.active || !isSlotExecutionBreakerReason(breaker.reason)) {
    return false;
  }

  const cooldownUntil = getPayloadNumber(breaker.payload, "cooldownUntil");
  if (cooldownUntil !== null && now < cooldownUntil) {
    return true;
  }

  if (breaker.key === "global") {
    if (getPayloadBoolean(breaker.payload, "requiresManualClear")) {
      return true;
    }

    return unresolvedSlots.size > 0;
  }

  if (!breaker.key.startsWith("slot:")) {
    return false;
  }

  const slotKey = breaker.key.slice("slot:".length);
  if (unresolvedSlots.has(slotKey)) {
    return true;
  }

  return getPayloadBoolean(breaker.payload, "requiresManualClear") && currentSlotKeys.has(slotKey);
}

export function countRecentKalshiSoftHedgeNoFillEvents(
  events: Pick<RunEvent, "createdAt" | "eventType" | "payload">[],
  now: number,
  windowMs = KALSHI_SOFT_HEDGE_FAILURE_WINDOW_MS,
) {
  return countRecentSoftHedgeNoFillEvents(events, now, "kalshi", windowMs);
}

export function countRecentKalshiSoftPrimaryNoFillEvents(
  events: Pick<RunEvent, "createdAt" | "eventType" | "payload">[],
  now: number,
  windowMs = KALSHI_SOFT_HEDGE_FAILURE_WINDOW_MS,
) {
  return countRecentSoftPrimaryNoFillEvents(events, now, "kalshi", windowMs);
}

export function hasKalshiHedgeRetryCapacity(
  leg: Pick<
    OrderIntent["legs"][number],
    | "venue"
    | "requestedNotionalUsd"
    | "requestedPrice"
    | "requestedSize"
    | "side"
    | "outcome"
    | "id"
    | "intentId"
    | "status"
    | "marketRef"
  >,
  liveLeg: {
    price: number | null;
    depth: number | null;
    minOrderSize: number | null;
    tickSize?: number | null;
    priceRanges?: readonly KalshiPriceRange[] | null;
  },
  settings: Pick<
    StrategyConfig,
    "executionPriceBuffer" | "maxLegPrice" | "maxSlippageBps" | "minOrderSize" | "kalshiDepthHeadroomContracts"
  >,
  hedgeRetryAttempts: number,
) {
  return deriveBufferedRetryLeg(leg, liveLeg, settings, Math.max(1, hedgeRetryAttempts)) !== null;
}

function shouldTripBreakerForTerminalNoFill(result: Awaited<ReturnType<VenueAdapter["placeOrder"]>>) {
  return !Boolean(result.raw?.softNoFill);
}

export function shouldRetryTerminalZeroFillHedge(
  intent: Pick<OrderIntent, "hedgeVenue">,
  hedgeLeg: Pick<OrderIntent["legs"][number], "venue" | "side">,
  result: Pick<Awaited<ReturnType<VenueAdapter["placeOrder"]>>, "raw" | "status" | "filledSize">,
) {
  if (intent.hedgeVenue !== "polymarket" || hedgeLeg.venue !== "polymarket" || hedgeLeg.side !== "BUY") {
    return true;
  }

  if (result.filledSize > ORDER_SIZE_TOLERANCE) {
    return false;
  }

  const truth = extractPolymarketOrderTruthFromRaw(result.raw);
  return truth?.terminalZeroFill === true;
}

async function writeHedgeRetryBlockedPendingTruthEvent(
  intent: Pick<OrderIntent, "id" | "asset" | "slotKey" | "hedgeVenue">,
  hedgeLeg: Pick<OrderIntent["legs"][number], "venue" | "side" | "requestedSize" | "filledSize">,
  hedgeOrder: Pick<LiveOrder, "venueOrderId" | "requestedSize" | "filledSize" | "status"> | null,
  now: number,
  payload: Record<string, unknown> = {},
) {
  await writeRunEvent({
    asset: intent.asset,
    level: "warn",
    eventType: "order.hedge.retry_blocked_pending_truth",
    message: `Blocked Polymarket BUY hedge retry until order truth is final for intent ${intent.id}`,
    payload: {
      intentId: intent.id,
      slotKey: intent.slotKey,
      hedgeVenue: intent.hedgeVenue,
      hedgeLegVenue: hedgeLeg.venue,
      hedgeSide: hedgeLeg.side,
      hedgeRequestedSize: hedgeLeg.requestedSize,
      hedgeFilledSize: hedgeLeg.filledSize,
      priorOrderId: hedgeOrder?.venueOrderId ?? null,
      priorOrderStatus: hedgeOrder?.status ?? null,
      priorOrderRequestedSize: hedgeOrder?.requestedSize ?? null,
      priorOrderFilledSize: hedgeOrder?.filledSize ?? null,
      ...payload,
    },
    createdAt: now,
  });
}

function extractPolymarketOrderTruthFromRaw(raw: Record<string, unknown> | undefined | null) {
  const truth = raw?.orderTruth;
  if (!truth || typeof truth !== "object") {
    return null;
  }

  return truth as {
    terminalZeroFill?: boolean;
    effectiveFilledSize?: number;
    confirmedFilledSize?: number;
    pendingFilledSize?: number;
  };
}

export function shouldTreatPrimaryOrderAsFilled(
  intent: Pick<OrderIntent, "primaryVenue">,
  order: Pick<LiveOrder, "filledSize" | "orderType" | "requestedSize" | "status">,
) {
  if (!isPrimaryFillSizeHedgable(intent, order)) {
    return false;
  }

  if (intent.primaryVenue === "polymarket") {
    return order.status === "filled" || (order.orderType === "FOK" && order.status === "pending");
  }

  return order.status === "filled" || order.status === "partially_filled";
}

export function isTerminalPrimaryOrderWithNoObservedFill(order: Pick<LiveOrder, "filledSize" | "status">) {
  return isTerminalOrderStatus(order.status) && order.filledSize <= ORDER_SIZE_TOLERANCE;
}

export function isPrimaryFillSizeHedgable(
  intent: Pick<OrderIntent, "primaryVenue">,
  order: Pick<LiveOrder, "filledSize" | "requestedSize">,
) {
  if (order.filledSize <= 0) {
    return false;
  }

  return intent.primaryVenue === "kalshi" || order.filledSize + ORDER_SIZE_TOLERANCE >= order.requestedSize;
}

export function shouldTreatHedgeOrderAsComplete(
  hedgeLeg: Pick<OrderIntent["legs"][number], "venue" | "requestedSize">,
  order: Pick<LiveOrder, "filledSize" | "status">,
) {
  if (order.filledSize <= 0) {
    return false;
  }

  if (hedgeLeg.venue === "polymarket") {
    return Math.abs(order.filledSize - hedgeLeg.requestedSize) <= ORDER_SIZE_TOLERANCE;
  }

  return order.status === "filled" && order.filledSize + ORDER_SIZE_TOLERANCE >= hedgeLeg.requestedSize;
}

export function shouldTreatPrimaryExecutionAsFilled(
  intent: Pick<OrderIntent, "primaryVenue">,
  result: Awaited<ReturnType<VenueAdapter["placeOrder"]>>,
  order: Pick<LiveOrder, "filledSize" | "orderType" | "requestedSize" | "status">,
) {
  if (shouldTreatPrimaryOrderAsFilled(intent, order)) {
    return true;
  }

  return intent.primaryVenue === "kalshi" && result.status === "partially_filled" && order.filledSize > 0;
}

async function writeLiveTradeRunEvent(
  intent: Pick<
    OrderIntent,
    | "id"
    | "asset"
    | "shadow"
    | "slotKey"
    | "combination"
    | "primaryVenue"
    | "hedgeVenue"
    | "grossCost"
    | "targetNotionalUsd"
    | "entrySizingReason"
    | "legs"
  >,
  now: number,
  stage: "primary_filled" | "hedged" = "primary_filled",
) {
  if (intent.shadow) {
    return;
  }

  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue) ?? null;
  const polymarketLeg = intent.legs.find((leg) => leg.venue === "polymarket") ?? null;
  const kalshiLeg = intent.legs.find((leg) => leg.venue === "kalshi") ?? null;
  const polymarketInvestedUsd = polymarketLeg ? calculateLegSpentUsd(polymarketLeg) : null;
  const kalshiInvestedUsd = kalshiLeg ? calculateLegSpentUsd(kalshiLeg) : null;
  const investedNotionalUsd = (polymarketInvestedUsd ?? 0) + (kalshiInvestedUsd ?? 0);
  await writeRunEvent({
    asset: intent.asset,
    level: "info",
    eventType: "intent.live_traded",
    message: `Live trade engaged for intent ${intent.id}`,
    payload: {
      intentId: intent.id,
      asset: intent.asset,
      slotKey: intent.slotKey,
      combination: intent.combination,
      primaryVenue: intent.primaryVenue,
      hedgeVenue: intent.hedgeVenue,
      grossCost: intent.grossCost,
      targetNotionalUsd: intent.targetNotionalUsd,
      investedNotionalUsd,
      entrySizingReason: intent.entrySizingReason ?? null,
      stage,
      primaryFilledSize: primaryLeg?.filledSize ?? null,
      primaryFilledPrice: primaryLeg?.filledPrice ?? null,
      primaryRequestedSize: primaryLeg?.requestedSize ?? null,
      polymarketOutcome: polymarketLeg?.outcome ?? null,
      polymarketRequestedNotionalUsd: polymarketLeg?.requestedNotionalUsd ?? null,
      polymarketInvestedUsd,
      polymarketFilledSize: polymarketLeg?.filledSize ?? null,
      kalshiOutcome: kalshiLeg?.outcome ?? null,
      kalshiRequestedNotionalUsd: kalshiLeg?.requestedNotionalUsd ?? null,
      kalshiInvestedUsd,
      kalshiFilledSize: kalshiLeg?.filledSize ?? null,
    },
    createdAt: now,
  });
}

async function writeManualInterventionRunEvent(
  intent: Pick<
    OrderIntent,
    "id" | "asset" | "shadow" | "slotKey" | "combination" | "primaryVenue" | "hedgeVenue" | "failureReason"
  >,
  now: number,
  stage: string,
  extraPayload: Record<string, unknown> = {},
) {
  if (intent.shadow || !intent.failureReason?.includes("manual intervention required")) {
    return;
  }

  await writeRunEvent({
    asset: intent.asset,
    level: "error",
    eventType: "intent.manual_intervention_required",
    message: `Manual intervention required for intent ${intent.id}`,
    payload: {
      intentId: intent.id,
      asset: intent.asset,
      slotKey: intent.slotKey,
      combination: intent.combination,
      primaryVenue: intent.primaryVenue,
      hedgeVenue: intent.hedgeVenue,
      failureReason: intent.failureReason,
      stage,
      ...extraPayload,
    },
    createdAt: now,
  });
}

async function writeIntentIncidentRunEvent(
  intent: Pick<OrderIntent, "id" | "asset" | "shadow" | "slotKey" | "combination" | "primaryVenue" | "hedgeVenue">,
  now: number,
  stage: string,
  reason: string,
  extraPayload: Record<string, unknown> = {},
) {
  if (intent.shadow) {
    return;
  }

  await writeRunEvent({
    asset: intent.asset,
    level: "error",
    eventType: "intent.incident",
    message: `Incident for intent ${intent.id}: ${reason}`,
    payload: {
      intentId: intent.id,
      asset: intent.asset,
      slotKey: intent.slotKey,
      combination: intent.combination,
      primaryVenue: intent.primaryVenue,
      hedgeVenue: intent.hedgeVenue,
      stage,
      reason,
      ...extraPayload,
    },
    createdAt: now,
  });
}

async function recordMarketFillQualityForIntent(
  intent: Pick<
    OrderIntent,
    "id" | "asset" | "shadow" | "slotKey" | "combination" | "primaryVenue" | "hedgeVenue" | "legs"
  >,
  outcome: MarketFillQualityOutcome,
  stage: string,
  now: number,
  payload: Record<string, unknown> = {},
) {
  if (intent.shadow) {
    return;
  }

  await writeMarketFillQualityEvent({
    id: `mfq:${intent.id}:${outcome}:${stage}`,
    asset: intent.asset,
    slotKey: intent.slotKey,
    intentId: intent.id,
    combination: intent.combination,
    primaryVenue: intent.primaryVenue,
    hedgeVenue: intent.hedgeVenue,
    outcome,
    stage,
    slippageBps: deriveIntentAverageSlippageBps(intent.legs),
    payload,
    createdAt: now,
  });
}

function deriveIntentAverageSlippageBps(legs: Pick<OrderIntent["legs"][number], "requestedPrice" | "filledPrice">[]) {
  const samples = legs
    .map((leg) => {
      if (
        leg.requestedPrice === null ||
        leg.filledPrice === null ||
        !Number.isFinite(leg.requestedPrice) ||
        !Number.isFinite(leg.filledPrice) ||
        leg.requestedPrice <= 0
      ) {
        return null;
      }
      return Math.abs((leg.filledPrice - leg.requestedPrice) / leg.requestedPrice) * 10_000;
    })
    .filter((value): value is number => value !== null && Number.isFinite(value));

  return samples.length > 0 ? round4(samples.reduce((sum, value) => sum + value, 0) / samples.length) : null;
}

function extractTerminalNoFillDetail(result: Awaited<ReturnType<VenueAdapter["placeOrder"]>>) {
  return typeof result.raw?.error === "string" ? result.raw.error : null;
}

async function prepareIntentForLiveExecution(
  intent: OrderIntent,
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
  options: {
    useFastKalshiPrimaryPreparation?: boolean;
  } = {},
) {
  if (options.useFastKalshiPrimaryPreparation) {
    return {
      intent,
      reason: null,
    };
  }

  const repricedIntent = await repriceIntentWithinExecutionBuffer(intent, slot, settings, now);
  if (!repricedIntent) {
    return {
      intent: null,
      reason: "pair_outside_execution_window" as const,
    };
  }

  if (!(await canSafelyLeadWithPolymarket(repricedIntent, slot, settings, now))) {
    return {
      intent: null,
      reason: "unsafe_polymarket_primary" as const,
    };
  }

  return {
    intent: repricedIntent,
    reason: null,
  };
}

export function shouldUseFastKalshiPrimaryPreparation(
  intent: Pick<OrderIntent, "primaryVenue">,
  snapshotCapturedAt: number | null | undefined,
  now: number,
) {
  return intent.primaryVenue === "kalshi" && snapshotCapturedAt === now;
}

async function canSafelyLeadWithPolymarket(
  intent: OrderIntent,
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
) {
  if (intent.primaryVenue !== "polymarket" || intent.hedgeVenue !== "kalshi") {
    return true;
  }

  const hedgeLeg = intent.legs.find((leg) => leg.venue === "kalshi");
  if (!hedgeLeg) {
    return false;
  }

  const { polymarket: polymarketState, kalshi: kalshiState } = await marketDataSupervisor.readSlotState(slot, now);
  const liveLeg = getLiveIntentLegSnapshot(hedgeLeg, polymarketState.quote, kalshiState.quote);
  if (!liveLeg) {
    return false;
  }

  return hasKalshiHedgeRetryCapacity(
    hedgeLeg,
    liveLeg,
    {
      executionPriceBuffer: settings.executionPriceBuffer,
      maxLegPrice: settings.maxLegPrice,
      maxSlippageBps: settings.maxSlippageBps,
      minOrderSize: settings.minOrderSize,
      kalshiDepthHeadroomContracts: settings.kalshiDepthHeadroomContracts,
    },
    settings.hedgeRetryAttempts,
  );
}

async function armPrimarySoftNoFillGuard(
  intent: OrderIntent,
  primaryOrder: LiveOrder,
  primaryResult: Awaited<ReturnType<VenueAdapter["placeOrder"]>>,
  now: number,
) {
  if (!Boolean(primaryResult.raw?.softNoFill)) {
    return;
  }

  await observeCircuitBreakerIncident(
    createExecutionIncident({
      asset: intent.asset,
      slotKey: intent.slotKey,
      intentId: intent.id,
      stage: "primary_no_fill_cooldown",
      reason: "primary_no_fill",
      disposition: "cooldown",
      venue: intent.primaryVenue,
      orderId: primaryOrder.venueOrderId,
      triggeredAt: now,
      cooldownUntil: now + PRIMARY_NO_FILL_COOLDOWN_MS,
    }),
  );
}

async function armHedgeFailureGuards(
  intent: OrderIntent,
  hedgeOrder: LiveOrder | null,
  _hedgeResult: Awaited<ReturnType<VenueAdapter["placeOrder"]>> | null,
  now: number,
) {
  await observeCircuitBreakerIncident(
    createExecutionIncident({
      asset: intent.asset,
      slotKey: intent.slotKey,
      intentId: intent.id,
      stage: "hedge_failure_unwind_pending",
      reason: "hedge_failure",
      disposition: "cooldown",
      venue: intent.hedgeVenue,
      orderId: hedgeOrder?.venueOrderId ?? null,
      triggeredAt: now,
      cooldownUntil: now + HEDGE_FAILURE_UNWIND_PENDING_COOLDOWN_MS,
    }),
  );
}

async function armRecoveredHedgeFailureCooldown(intent: OrderIntent, now: number, stage: string) {
  await observeCircuitBreakerIncident(
    createExecutionIncident({
      asset: intent.asset,
      slotKey: intent.slotKey,
      intentId: intent.id,
      stage,
      reason: "hedge_failure",
      disposition: "cooldown",
      venue: intent.hedgeVenue,
      triggeredAt: now,
      cooldownUntil: now + HEDGE_FAILURE_RECOVERED_COOLDOWN_MS,
    }),
  );
}

function isRecentSoftHedgeNoFillEvent(
  event: Pick<RunEvent, "createdAt" | "eventType" | "payload">,
  now: number,
  windowMs: number,
  venue?: "kalshi" | "polymarket",
) {
  return (
    event.eventType === "order.hedge.no_fill" &&
    event.createdAt >= now - windowMs &&
    (venue === undefined || getPayloadString(event.payload, "venue") === venue) &&
    getPayloadBoolean(event.payload, "softNoFill")
  );
}

function countRecentSoftHedgeNoFillEvents(
  events: Pick<RunEvent, "createdAt" | "eventType" | "payload">[],
  now: number,
  venue: "kalshi" | "polymarket",
  windowMs: number,
) {
  return events.filter((event) => isRecentSoftHedgeNoFillEvent(event, now, windowMs, venue)).length;
}

function isRecentSoftPrimaryNoFillEvent(
  event: Pick<RunEvent, "createdAt" | "eventType" | "payload">,
  now: number,
  windowMs: number,
  venue?: "kalshi" | "polymarket",
) {
  return (
    event.eventType === "order.primary.no_fill" &&
    event.createdAt >= now - windowMs &&
    (venue === undefined || getPayloadString(event.payload, "venue") === venue) &&
    getPayloadBoolean(event.payload, "softNoFill")
  );
}

function countRecentSoftPrimaryNoFillEvents(
  events: Pick<RunEvent, "createdAt" | "eventType" | "payload">[],
  now: number,
  venue: "kalshi" | "polymarket",
  windowMs: number,
) {
  return events.filter((event) => isRecentSoftPrimaryNoFillEvent(event, now, windowMs, venue)).length;
}

function getPayloadBoolean(payload: Record<string, unknown> | null, key: string) {
  return payload !== null && payload[key] === true;
}

function getPayloadNumber(payload: Record<string, unknown> | null, key: string) {
  return payload !== null && typeof payload[key] === "number" ? payload[key] : null;
}

function getPayloadString(payload: Record<string, unknown> | null, key: string) {
  return payload !== null && typeof payload[key] === "string" ? payload[key] : null;
}

function describeTerminalNoFill(label: string, result: Awaited<ReturnType<VenueAdapter["placeOrder"]>>) {
  const detail = extractTerminalNoFillDetail(result);
  if (detail) {
    return `${label} order not filled (${detail})`;
  }

  return `${label} order not authoritatively filled (${result.status})`;
}

function describeUnwoundAfterFailure(failureReason: string) {
  return failureReason.toLowerCase().includes("primary unwound") ? failureReason : `${failureReason}; primary unwound`;
}

function isAwaitingOrderConfirmation(status: LiveOrder["status"]) {
  return status === "pending" || status === "live";
}

function deriveConfirmedVenueOrderStatus(order: LiveOrder, filledSize: number): LiveOrder["status"] {
  if (order.orderType === "FOK") {
    return filledSize > 0 ? "filled" : order.status;
  }

  return filledSize + ORDER_SIZE_TOLERANCE >= order.requestedSize ? "filled" : "partially_filled";
}

function findLatestIntentOrderForLeg(recentOrders: LiveOrder[], intent: OrderIntent, leg: OrderIntent["legs"][number]) {
  return recentOrders.find((order) => isVenueOrderCanonicalForIntentLeg(order, intent, leg, "entry")) ?? null;
}

function findLatestIntentReduceOnlyOrder(
  recentOrders: LiveOrder[],
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
) {
  return recentOrders.find((order) => isVenueOrderCanonicalForIntentLeg(order, intent, leg, "exit")) ?? null;
}

function adapterFor(venue: OrderIntent["primaryVenue"]) {
  return venue === "polymarket" ? polymarketAdapter : kalshiAdapter;
}

async function refreshLatestSnapshot(slot: MarketSlot) {
  return readLatestSnapshot(slot.asset, slot.key);
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Erreur inconnue";
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function roundToSixDecimals(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function floorToSixDecimals(value: number) {
  return Math.floor(value * 1_000_000) / 1_000_000;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function maybeRunDatabaseMaintenance(now: number) {
  const config = readDatabaseMaintenanceConfig();
  if (lastDatabaseMaintenanceAttemptAt !== null && now - lastDatabaseMaintenanceAttemptAt < config.intervalMs) {
    return;
  }

  lastDatabaseMaintenanceAttemptAt = now;

  try {
    const summary = await runDatabaseMaintenance(config, now);
    const deletedEntries = Object.entries(summary.deleted).filter(([, count]) => count > 0);
    if (deletedEntries.length === 0) {
      return;
    }

    await writeRunEvent({
      level: "info",
      eventType: "db.maintenance.completed",
      message: `Database retention cleanup deleted ${deletedEntries.reduce((sum, [, count]) => sum + count, 0)} rows`,
      payload: {
        deleted: Object.fromEntries(deletedEntries),
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
      },
      createdAt: Date.now(),
    });
  } catch (error) {
    await writeRunEvent({
      level: "warn",
      eventType: "db.maintenance.failed",
      message: error instanceof Error ? error.message : "Database retention cleanup failed",
      payload: null,
      createdAt: Date.now(),
    }).catch(() => undefined);
  }
}

function isInFlightIntentStale(intent: OrderIntent, now: number) {
  return intent.slotEndTs + RESOLUTION_GRACE_MS <= now || now - intent.updatedAt >= IN_FLIGHT_INTENT_STALE_MS;
}

export function shouldDeferPolymarketUnwindToSettlement(
  intent: Pick<OrderIntent, "primaryVenue" | "slotEndTs">,
  now: number,
) {
  return intent.primaryVenue === "polymarket" && intent.slotEndTs + RESOLUTION_GRACE_MS <= now;
}

export function isLatePrimaryFillRescueEligible(intent: OrderIntent, recentOrders: LiveOrder[]) {
  const failureReason = intent.failureReason?.toLowerCase() ?? "";
  if (
    failureReason.includes("hedge") ||
    failureReason.includes("unwind") ||
    failureReason.includes("manual cleanup") ||
    failureReason.includes("manual intervention required")
  ) {
    return false;
  }

  if (intent.legs.some((leg) => leg.status === "unwound" || leg.payoutUsd !== null)) {
    return false;
  }

  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  if (!primaryLeg) {
    return false;
  }

  return !Boolean(findLatestIntentReduceOnlyOrder(recentOrders, intent, primaryLeg));
}

export function derivePrimaryExitSize(params: {
  filledSize: number;
  positionSize?: number | null;
  sellableSize?: number | null;
}) {
  const candidates = [params.filledSize, params.positionSize ?? null, params.sellableSize ?? null].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );

  if (candidates.length === 0) {
    return 0;
  }

  return floorToSixDecimals(Math.min(...candidates));
}

export function deriveRemainingExposureSize(entryFilledSize: number, exitFilledSize: number) {
  return roundToSixDecimals(Math.max(0, entryFilledSize - exitFilledSize));
}

export function deriveLiveRemainingLegSize(
  positions: PositionSnapshot[],
  leg: Pick<OrderIntent["legs"][number], "venue" | "marketRef" | "outcome" | "tokenId">,
) {
  const matchingPositions = positions.filter(
    (position) =>
      position.venue === leg.venue && position.marketRef === leg.marketRef && position.outcome === leg.outcome,
  );
  if (matchingPositions.length === 0) {
    return 0;
  }

  const exactMatch =
    leg.tokenId === undefined
      ? null
      : matchingPositions.find((position) => {
          const rawTokenId = extractPositionTokenId(position);
          return rawTokenId !== null && rawTokenId === leg.tokenId;
        });
  const matchedPosition = exactMatch ?? matchingPositions[0];
  return roundToSixDecimals(Math.max(0, matchedPosition.size));
}

export function summarizeIntentLegFills(
  fills: LiveFill[],
  leg: Pick<OrderIntent["legs"][number], "venue" | "marketRef" | "outcome" | "tokenId" | "side">,
  mode: "entry" | "exit",
) {
  const expectedSide = mode === "entry" ? leg.side : leg.side === "BUY" ? "SELL" : "BUY";
  const matchingFills = fills.filter(
    (fill) =>
      fill.venue === leg.venue &&
      fill.marketRef === leg.marketRef &&
      fill.outcome === leg.outcome &&
      fill.side === expectedSide &&
      (leg.tokenId === undefined || fill.tokenId === undefined || fill.tokenId === leg.tokenId),
  );

  if (matchingFills.length === 0) {
    return null;
  }

  return summarizeVenueFills(matchingFills);
}

export function isRetryablePolymarketInventorySyncError(error: unknown) {
  const normalized = toErrorMessage(error).toLowerCase();
  return (
    normalized.includes("no exitable size") ||
    normalized.includes("not enough balance / allowance") ||
    normalized.includes("balance is not enough") ||
    normalized.includes("allowance is not enough")
  );
}

export function isPolymarketOrderbookUnavailableError(error: unknown) {
  const normalized = toErrorMessage(error).toLowerCase();
  return normalized.includes("orderbook") && normalized.includes("does not exist");
}

async function closeIntentAfterPolymarketOrderbookUnavailable(
  intent: OrderIntent,
  primaryLeg: OrderIntent["legs"][number],
  now: number,
  errorMessage: string,
) {
  const slotSlug = buildPolymarketSlotSlug(intent.asset, intent.slotStartTs);
  const polyResolution = await fetchPolymarketResolution(slotSlug, primaryLeg.marketRef).catch(() => null);
  const failureReason =
    polyResolution === null
      ? `Primary unwind impossible after Polymarket market close (${errorMessage}); waiting for venue settlement / reclaim`
      : `Primary unwind impossible after Polymarket market close (${errorMessage}); market resolved ${polyResolution}, waiting for reclaim`;

  let deferredIntent: OrderIntent = {
    ...intent,
    status: "unwind_required",
    updatedAt: now,
    resolvedAt: null,
    failureReason,
    polyResolution: polyResolution ?? intent.polyResolution,
    legs: intent.legs.map((leg) =>
      leg.id === primaryLeg.id
        ? {
            ...leg,
            resolvedOutcome: polyResolution ?? leg.resolvedOutcome,
          }
        : leg,
    ) as OrderIntent["legs"],
  };

  deferredIntent = await writeOrderIntent(deferredIntent);
  await writeRunEvent({
    level: "warn",
    eventType: "intent.unwind.awaiting_polymarket_settlement",
    message: `Intent ${intent.id} deferred to Polymarket settlement after the orderbook disappeared`,
    payload: {
      intentId: intent.id,
      slotKey: intent.slotKey,
      orderbookUnavailable: true,
      error: errorMessage,
      polyResolution,
    },
    createdAt: now,
  });
  return deferredIntent;
}

function extractPositionTokenId(position: PositionSnapshot) {
  if (typeof position.raw.asset === "string") {
    return position.raw.asset;
  }
  if (typeof position.raw.asset_id === "string") {
    return position.raw.asset_id;
  }
  if (typeof position.raw.tokenId === "string") {
    return position.raw.tokenId;
  }
  if (typeof position.raw.token_id === "string") {
    return position.raw.token_id;
  }
  if (position.id.startsWith("polymarket:")) {
    return position.id.slice("polymarket:".length);
  }
  return null;
}

async function runReconcileStep(step: string, now: number, fn: () => Promise<void>) {
  try {
    await withTimeout(
      fn,
      RECONCILE_STEP_TIMEOUT_MS,
      `reconcile step ${step} timed out after ${RECONCILE_STEP_TIMEOUT_MS}ms`,
    );
    return [] as string[];
  } catch (error) {
    const message = `${step}: ${toErrorMessage(error)}`;
    await writeRunEvent({
      level: "warn",
      eventType: "reconcile.step_failed",
      message,
      payload: {
        step,
      },
      createdAt: now,
    });
    return [message];
  }
}

function mergePolymarketOrderStatusForNonDowngrade(existing: LiveOrder, mapped: LiveOrder): LiveOrder["status"] {
  if (existing.filledSize > ORDER_SIZE_TOLERANCE && mapped.filledSize <= ORDER_SIZE_TOLERANCE) {
    return existing.status;
  }

  return mapped.status;
}

export function mergePolymarketTradeObservationStatus(
  existingStatus: LiveOrder["status"],
  observedStatus: LiveOrder["status"],
  forcePending = false,
) {
  return observedStatus === "pending" && !forcePending ? existingStatus : observedStatus;
}

function extractPolymarketOpenOrderFromRaw(raw: Record<string, unknown> | null | undefined) {
  const direct = raw?.order;
  if (direct && typeof direct === "object") {
    return direct as Parameters<typeof resolvePolymarketOrderTruth>[0]["order"];
  }

  if (
    raw &&
    typeof raw.id === "string" &&
    typeof raw.status === "string" &&
    typeof raw.original_size !== "undefined" &&
    typeof raw.size_matched !== "undefined"
  ) {
    return raw as unknown as Parameters<typeof resolvePolymarketOrderTruth>[0]["order"];
  }

  return null;
}

function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });

  return Promise.race([fn(), timeoutPromise]).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }) as Promise<T>;
}
