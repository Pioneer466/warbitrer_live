import { readDatabaseMaintenanceConfig } from "@/lib/db-maintenance";
import {
  applyKalshiPrimaryDepthSafetyFactor,
  applySlippage,
  calculateKalshiFee,
  calculatePolymarketLevelFee,
  deriveBalancedPayoutPairSize,
  deriveMultiLevelPairedQuote,
  deriveKalshiPrimaryClipPlan,
  getKalshiPrimaryMultiClipCapacity,
  getVenueExecutableDepth,
  getVenueMinimumOrderSize,
  normalizeVenueTargetSize,
  quoteMultiLevelBuyLeg,
} from "@/lib/fees";
import {
  computeKalshiBuyDepthWithinPriceRange,
  createKalshiAdapter,
  deriveKalshiBuyPriceLevels,
  fetchKalshiOrderbook,
  fetchKalshiFills,
  fetchFinalizedKalshiResolutionObservation,
  fetchKalshiOrders,
  fetchKalshiResolution,
  fetchKalshiSeries,
  getKalshiOrderPriceUsd,
  KALSHI_ORDER_PRICE_STEP_USD,
  mapKalshiFillToLiveFill,
  mapKalshiOrderStatus,
  normalizeKalshiOrderPrice,
  normalizeKalshiNumericOrderbookLevels,
} from "@/lib/kalshi";
import { getMarketDataSupervisor } from "@/lib/market-data";
import { ACTIVE_MARKET_ASSETS, getMarketCatalogEntry, isMarketAsset, MARKET_ASSETS } from "@/lib/market-catalog";
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
  isConfirmedPolymarketTrade,
  isPendingPolymarketTrade,
  mapPolymarketOrder,
  mapPolymarketTradeToFill,
  resolvePolymarketOrderTruth,
  summarizePolymarketTrades,
} from "@/lib/polymarket";
import { autoConvertPolymarketIfConfigured, reconcilePolymarketProxyConversions } from "@/lib/recovery";
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
  buildScheduledShadowAudit,
  deriveShadowPairExecution,
  getShadowReentryCooldownRemainingMs,
  SHADOW_EXECUTION_MODEL_VERSION,
  type ShadowPairExecutionDecision,
} from "@/lib/shadow-execution";
import { buildSignals } from "@/lib/signals";
import { POLYMARKET_MIN_MARKET_BUY_AMOUNT_USD } from "@/lib/constants";
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
import { deriveMismatchEstimateEconomics } from "@/lib/mismatch-reference-economics";
import {
  MISMATCH_DIAGNOSTIC_MAX_SOURCE_AGE_MS,
  MismatchRiskRuntime,
} from "@/lib/mismatch-risk-runtime";
import { buildMismatchRiskAudit } from "@/lib/mismatch-risk-audit";
import {
  applyMismatchRiskPolicy,
  recheckMismatchRiskCandidate,
} from "@/lib/mismatch-risk-policy";
import {
  DEFAULT_GLOBAL_RISK_CONFIG,
  type GlobalRiskConfig,
} from "@/lib/risk-settings";
import {
  findOrderAttemptById,
  findOrderIntent,
  findVenueOrder,
  readCircuitBreakers,
  readExecutionCandidates,
  readFillsForIntentVenue,
  readLastEntryCosts,
  readLatestSnapshot,
  readGlobalRiskConfig,
  readLiveFeesUsd,
  readLiveRealizedPnlUsd,
  readOpenOrderIntents,
  readPendingSlotResolutions,
  readPolymarketCashAdjustmentObservation,
  readPositions,
  readRunEvents,
  readRecentFills,
  readRecentOrderIntents,
  readRecentSettledOrderIntents,
  readRecentVenueOrders,
  readSettings,
  readSettingsMap,
  readStableRealizedPnlSince,
  readVenueBalances,
  readDegradedMarketFillQualityCounts,
  replaceVenuePositions,
  runDatabaseMaintenance,
  tryWithGlobalLiveExecutionLock,
  updateStablePnlChangeFromIntent,
  writeStablePnlChange,
  writeCircuitBreaker,
  writeExecutionCandidate,
  writeFill,
  writeMarketFillQualityEvent,
  writeOrderAttempt,
  writeOrderIntent,
  writeOracleSlotSample,
  writePnlSnapshot,
  writeRunEvent,
  writeSettlement,
  writeSnapshot,
  writeSlotResolution,
  writeVenueBalance,
  writeVenueOrder,
  writeWorkerState,
} from "@/lib/storage";
import type {
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
  OrderIntent,
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
  WorkerState,
} from "@/lib/types";

const RESOLUTION_GRACE_MS = 5_000;
const IN_FLIGHT_INTENT_STALE_MS = 15_000;
const LATE_PRIMARY_FILL_RESCUE_WINDOW_MS = 15 * 60 * 1000;
const ORDER_SIZE_TOLERANCE = 1e-6;
const STABLE_PNL_BALANCE_TOLERANCE_USD = 0.01;
const STABLE_PNL_SETTLED_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const RECONCILE_STEP_TIMEOUT_MS = 30_000;
const KALSHI_SOFT_HEDGE_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const KALSHI_SOFT_HEDGE_FAILURE_THRESHOLD = 2;
const KALSHI_SOFT_HEDGE_FAILURE_GLOBAL_COOLDOWN_MS = 30 * 60 * 1000;
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
const POLYMARKET_CRYPTO_RESCUE_FEE_RATE = 0.07;
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
const settingsCacheByAsset: Partial<Record<MarketAsset, { value: StrategyConfig; capturedAt: number }>> = {};
const kalshiFeeMultiplierCacheByAsset: Partial<Record<MarketAsset, { value: number; capturedAt: number }>> = {};
let venueBalancesCache: { value: VenueBalance[]; capturedAt: number } | null = null;
let openIntentsCache: { value: OrderIntent[]; capturedAt: number } | null = null;
const lastEntryCostsCache = new Map<string, { value: Awaited<ReturnType<typeof readLastEntryCosts>>; capturedAt: number }>();
const lastOracleSampleAtBySlot = new Map<string, number>();
const observedResolutionSlots = new Map<string, string>();
const oraclePersistenceInFlightByAsset: Partial<Record<MarketAsset, Promise<void>>> = {};
let observedSlotResolutionReconcileInFlight = false;
const mismatchRiskRuntime = new MismatchRiskRuntime();
let globalRiskConfigCache: { value: GlobalRiskConfig; capturedAt: number } | null = null;

type RealtimeScanState = {
  sequence: number;
  asset: MarketAsset;
  slot: MarketSlot;
  settings: StrategyConfig;
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

function buildPairExecutionTiming(
  primary: OrderExecutionTiming | null,
  hedge: OrderExecutionTiming | null,
) {
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
    decisionToPrimarySubmitMs:
      primary ? Math.max(0, primary.submitStartedAt - primary.decisionAt) : null,
    primaryFillToHedgeSubmitMs:
      primary && hedge ? Math.max(0, hedge.submitStartedAt - primary.fillObservedAt) : null,
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

  return [...new Set(plan)]
    .filter((clipSize) => clipSize > 0)
    .sort((left, right) => right - left);
}

function annotateThirdKalshiFallbackEntry(
  intent: OrderIntent,
  clipIndex: number,
  clipPlan: number[],
  failedClipCount: number,
  requestedSize: number,
): OrderIntent {
  if (clipIndex < 2) {
    return intent;
  }

  return {
    ...intent,
    entrySizingReason: `Notionnel réduit par fallback Kalshi: entrée au clip ${clipIndex + 1}/${clipPlan.length} après ${failedClipCount} échecs d'entrée; taille ${requestedSize.toFixed(2)}`,
  };
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

type TickSharedContext = {
  venueBalances?: VenueBalance[];
  openIntents?: OrderIntent[];
  recentVenueOrders?: LiveOrder[];
  circuitBreakers?: CircuitBreaker[];
  lastEntryCosts?: Awaited<ReturnType<typeof readLastEntryCosts>>;
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
  };
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
  const settingsMap = await readCachedSettingsMap(nowTs);
  const sharedVenueBalances = await readCachedVenueBalances(nowTs);
  const sharedOpenIntents = await readCachedOpenIntents(nowTs);

  await Promise.all(
    ACTIVE_MARKET_ASSETS.map(async (asset) => {
      const settings = settingsMap[asset];
      const slot = getCurrentSlot(asset, now);

      try {
        const snapshot = await scanAsset(asset, slot, settings, nowTs, {
          venueBalances: sharedVenueBalances,
          openIntents: sharedOpenIntents,
          lastEntryCosts: await readCachedLastEntryCosts(asset, slot.key, nowTs),
        });
        snapshots.push(snapshot);
      } catch (error) {
        const message = `[${asset}] ${toErrorMessage(error)}`;
        errors.push(message);
        await writeAssetWorkerState(asset, {
          phase: "scan",
          currentSlotKey: slot.key,
          lastError: message,
        }, nowTs, true);
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
  const settings = await readCachedSettings(asset, nowTs);
  try {
    return await scanAsset(asset, slot, settings, nowTs, {
      venueBalances: await readCachedVenueBalances(nowTs),
      openIntents: await readCachedOpenIntents(nowTs),
      lastEntryCosts: await readCachedLastEntryCosts(asset, slot.key, nowTs),
    });
  } catch (error) {
    const message = `[${asset}] ${toErrorMessage(error)}`;
    await writeAssetWorkerState(asset, {
      phase: "scan",
      currentSlotKey: slot.key,
      lastError: message,
    }, nowTs, true);
    throw error;
  }
}

async function scanAsset(
  asset: MarketAsset,
  slot: MarketSlot,
  settings: StrategyConfig,
  nowTs: number,
  sharedContext: TickSharedContext,
) {
  const coordinator = createExecutionCoordinator(asset, settings, sharedContext);
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

  const loopHealth = updateLoopHealth(asset, {
    lastScanDurationMs: scanState.scanDurationMs,
    lastScanAgeMs: Math.max(0, Date.now() - scanState.capturedAt),
    lastCandidateScore: candidate?.projectedNetProfitUsd ?? null,
  }, nowTs);
  await writeAssetWorkerState(asset, {
    phase: "scan",
    currentSlotKey: slot.key,
    lastScanAt: nowTs,
    lastError: null,
    loopHealth,
  }, nowTs, persistSnapshot);

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
      await writeAssetWorkerState(scanState.asset, {
        phase: "execute",
        currentSlotKey: scanState.slot.key,
        lastError: message,
      }, nowTs, true);
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
      await writeAssetWorkerState(asset, {
        phase: "execute",
        currentSlotKey: scanState.slot.key,
        lastError: message,
      }, Date.now(), true);
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
    const loopHealth = updateLoopHealth(scanState.asset, {
      lastExecutionDurationMs: Date.now() - executeStartedAt,
      lastScanAgeMs: Math.max(0, Date.now() - scanState.capturedAt),
    }, nowTs);
    await writeAssetWorkerState(scanState.asset, {
      phase: "execute",
      currentSlotKey: scanState.slot.key,
      lastExecuteAt: nowTs,
      lastError: null,
      readinessStatus: readiness.state.readinessStatus,
      readiness: readiness.state.readiness,
      loopHealth,
    }, nowTs, true);
    return created;
  }

  if (candidate && !(settings.shadowMode && scanState.hasOpenIntent)) {
    const candidates = await readExecutionCandidates(nowTs);
    const winner = selectWinningExecutionCandidate(candidates, nowTs);
    if (!winner || !isWinningCandidateForScanState(winner, scanState, nowTs)) {
      return created;
    }
    console.log(
      `[worker] candidate won: asset=${winner.asset} slot=${winner.slotKey} profit=${winner.projectedNetProfitUsd.toFixed(4)} age=${Math.max(0, nowTs - winner.capturedAt)}ms`,
    );
  }

  const coordinator = createExecutionCoordinator(scanState.asset, settings);
  const assetCreated = await coordinator.execute(scanState.slot, nowTs, scanState.snapshot);
  created.push(...assetCreated);
  const loopHealth = updateLoopHealth(scanState.asset, {
    lastExecutionDurationMs: Date.now() - executeStartedAt,
    lastScanAgeMs: Math.max(0, Date.now() - scanState.capturedAt),
  }, nowTs);
  await writeAssetWorkerState(scanState.asset, {
    phase: "execute",
    currentSlotKey: scanState.slot.key,
    lastExecuteAt: nowTs,
    lastError: null,
    loopHealth,
  }, nowTs, true);
  return created;
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
  const [sharedOpenIntents, sharedRecentVenueOrders, sharedCircuitBreakers, venueOrderReconcileData] =
    await Promise.all([
      readOpenOrderIntents(),
      readRecentVenueOrders(1_000),
      readCircuitBreakers(),
      prefetchVenueOrderReconcileData(),
    ]);

  for (const asset of ACTIVE_MARKET_ASSETS) {
    const settings = settingsMap[asset];
    const slot = getCurrentSlot(asset, now);
    const coordinator = createExecutionCoordinator(asset, settings, {
      venueBalances: sharedVenueBalances,
      openIntents: sharedOpenIntents,
      recentVenueOrders: sharedRecentVenueOrders,
      circuitBreakers: sharedCircuitBreakers,
      venuePositions: sharedVenuePositions,
      storedPositions,
      venueOrderReconcileData,
    });

    try {
      const assetReconcileStartedAt = Date.now();
      await coordinator.reconcile(slot, nowTs);
      const loopHealth = updateLoopHealth(asset, {
        lastReconcileDurationMs: Date.now() - assetReconcileStartedAt,
      }, nowTs);
      await writeAssetWorkerState(asset, {
        phase: "reconcile",
        currentSlotKey: slot.key,
        lastReconcileAt: nowTs,
        lastError: null,
        loopHealth,
      }, nowTs, true);
    } catch (error) {
      const message = `[${asset}] ${toErrorMessage(error)}`;
      errors.push(message);
      await writeAssetWorkerState(asset, {
        phase: "reconcile",
        currentSlotKey: slot.key,
        lastError: message,
      }, nowTs, true);
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
  const [polyOpenOrders, kalshiOrders, polyTrades, kalshiFills] = await Promise.all([
    fetchPolymarketOpenOrders().catch(() => []),
    fetchKalshiOrders().catch(() => []),
    fetchPolymarketTrades().catch(() => []),
    fetchKalshiFills().catch(() => []),
  ]);

  return {
    polyOpenOrders,
    kalshiOrders,
    polyTrades,
    kalshiFills,
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
): Promise<GlobalRiskConfig> {
  if (globalRiskConfigCache && now - globalRiskConfigCache.capturedAt <= SETTINGS_CACHE_TTL_MS) {
    return globalRiskConfigCache.value;
  }

  let value: GlobalRiskConfig;
  try {
    value = await readGlobalRiskConfig();
  } catch (error) {
    if (failClosed) {
      throw error;
    }
    console.warn(`[risk] global config unavailable, using defaults for diagnostics: ${toErrorMessage(error)}`);
    return { ...DEFAULT_GLOBAL_RISK_CONFIG };
  }
  globalRiskConfigCache = { value, capturedAt: now };
  return value;
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
}): Partial<Record<PairCombination, MismatchRiskEstimate>> {
  const estimates: Partial<Record<PairCombination, MismatchRiskEstimate>> = {};
  const diagnosticMaxSourceAgeMs = Math.max(
    input.oracleMaxAgeMs,
    MISMATCH_DIAGNOSTIC_MAX_SOURCE_AGE_MS,
  );
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
    estimates[opportunity.combination] = {
      ...estimate,
      reason:
        economics.basis === "unavailable" &&
        estimate.reason === "economics_unavailable"
          ? "reference_economics_unavailable"
          : estimate.reason,
      economicsBasis: economics.basis,
      economicsPairSize: economics.pairSize,
      economicsTotalCostUsd: economics.totalCostUsd,
    };
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
    .filter(
      (intent) =>
        !intent.shadow &&
        intent.slotEndTs === input.slotEndTs,
    )
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

function deriveRiskCapitalUsd(
  balances: VenueBalance[],
  now: number,
  config: GlobalRiskConfig,
) {
  const requiredVenues: Venue[] = ["polymarket", "kalshi"];
  const freshBalances = requiredVenues.map((venue) =>
    balances.find(
      (balance) =>
        balance.venue === venue &&
        balance.status === "ready" &&
        now - balance.capturedAt <= config.balanceMaxAgeMs,
    ),
  );
  return freshBalances.every(Boolean)
    ? freshBalances.reduce((sum, balance) => sum + (balance?.totalBalanceUsd ?? 0), 0)
    : 0;
}

function applyFinalMismatchEstimate(
  opportunity: LiveOpportunity,
  estimate: MismatchRiskEstimate | null,
): LiveOpportunity {
  if (!estimate) {
    return opportunity;
  }
  return {
    ...opportunity,
    mismatchRiskEstimate: estimate,
    fatalMismatchPnlUsd: estimate.available ? estimate.fatalPnlUsd : opportunity.fatalMismatchPnlUsd,
    conservativeExpectedPnlUsd: estimate.available
      ? estimate.conservativePnlUsd
      : opportunity.conservativeExpectedPnlUsd,
  };
}

function rescaleMismatchEstimate(
  opportunity: LiveOpportunity,
  estimate: MismatchRiskEstimate | null,
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
      opportunity.legs.reduce(
        (sum, leg) => sum + leg.targetNotionalUsd + leg.feeEstimateUsd,
        0,
      ),
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
}): Promise<
  | { allowed: true; opportunity: LiveOpportunity }
  | {
      allowed: false;
      reason: string;
      estimate: MismatchRiskEstimate | null;
      opportunity?: LiveOpportunity;
    }
> {
  let config: GlobalRiskConfig;
  try {
    config = await getCachedGlobalRiskConfig(
      input.now,
      input.settings.mismatchRiskMode === "enforce",
    );
  } catch (error) {
    return {
      allowed: false,
      reason: `Global risk configuration unavailable: ${toErrorMessage(error)}`,
      estimate: null,
    };
  }
  const [{ polymarket, kalshi }, balances] = await Promise.all([
    marketDataSupervisor.readSlotState(input.slot, input.now),
    readCachedVenueBalances(input.now),
  ]);
  const candidateOpportunity = input.intent
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
    maxSourceAgeMs: Math.max(
      config.oracleMaxAgeMs,
      MISMATCH_DIAGNOSTIC_MAX_SOURCE_AGE_MS,
    ),
    maxPairSkewMs: Math.max(
      config.oracleMaxAgeMs,
      MISMATCH_DIAGNOSTIC_MAX_SOURCE_AGE_MS,
    ),
    executionMaxSourceAgeMs: config.oracleMaxAgeMs,
    executionMaxPairSkewMs: config.oracleMaxAgeMs,
    combination: candidateOpportunity.combination,
    slotStartTs: input.slot.startTs,
    slotEndTs: input.slot.endTs,
    pairSize,
    totalCostUsd,
  });
  const estimate: MismatchRiskEstimate = {
    ...rawEstimate,
    economicsBasis: pairSize > 0 && totalCostUsd > 0 ? "executable" : "unavailable",
    economicsPairSize: pairSize > 0 ? pairSize : null,
    economicsTotalCostUsd: totalCostUsd > 0 ? totalCostUsd : null,
  };

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
  if (
    grossCost === null ||
    !Number.isFinite(grossCost) ||
    grossCost > allowedGrossCost + ORDER_SIZE_TOLERANCE
  ) {
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
  if (
    !doesSizingMeetProfitThresholds(
      projectedNetProfitUsd,
      projectedNetReturn,
      input.settings,
    )
  ) {
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
    if (
      !balance ||
      balance.status !== "ready" ||
      input.now - balance.capturedAt > input.balanceMaxAgeMs
    ) {
      return `Fresh ready balance unavailable for ${venue}`;
    }
    if (requiredUsd > balance.availableBalanceUsd + ORDER_SIZE_TOLERANCE) {
      return `Worst-fill ${venue} requirement ${requiredUsd.toFixed(4)} exceeds available balance ${balance.availableBalanceUsd.toFixed(4)}`;
    }
    if (
      input.venueExposureUsd[venue] + requiredUsd >
      input.settings.maxVenueExposureUsd + ORDER_SIZE_TOLERANCE
    ) {
      return `Worst-fill ${venue} exposure ${(input.venueExposureUsd[venue] + requiredUsd).toFixed(4)} exceeds venue limit ${input.settings.maxVenueExposureUsd.toFixed(4)}`;
    }
  }

  return null;
}

function calculateHedgeRecoveryReserveUsd(input: {
  pairSize: number;
  standardWorstFillCostUsd: number;
  intent: OrderIntent | null;
  settings: Pick<
    StrategyConfig,
    "hedgeRescueEnabled" | "hedgeRescueMaxLossUsd" | "forcedUnwindMaxLossUsd"
  >;
}) {
  if (
    !input.settings.hedgeRescueEnabled ||
    input.intent?.hedgeVenue !== "polymarket" ||
    input.pairSize <= 0
  ) {
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
  settings: Pick<
    StrategyConfig,
    "hedgeRescueEnabled" | "hedgeRescueMaxLossUsd" | "forcedUnwindMaxLossUsd"
  >,
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
      opportunity.conservativeExpectedPnlUsd === null ||
      opportunity.conservativeExpectedPnlUsd === undefined
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
      input.reserveHedgeRetryBuffer !== false &&
      !isPrimary &&
      leg.side === "BUY" &&
      leg.requestedPrice !== null
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
          isPrimary && riskLeg.venue === "kalshi"
            ? input.settings.kalshiPrimaryPriceTicksSlippage
            : undefined,
      },
    );
    if (request.price === null || request.price <= 0 || request.size <= 0) {
      return null;
    }
    const quote = leg.venue === "polymarket"
      ? quoteMultiLevelBuyLeg({
          venue: "polymarket",
          levels: [{ price: request.price, size: request.size }],
          size: request.size,
          feeRateBps:
            input.polymarket.outcomes[leg.outcome === "UP" ? "up" : "down"].feeRateBps ??
            input.polymarket.feeRateBps,
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
  const worstFillCostUsd = legs.reduce(
    (sum, leg) => sum + leg.targetNotionalUsd + leg.feeEstimateUsd,
    0,
  );
  const projectedNetProfitUsd = round4(pairSize - worstFillCostUsd);
  const conservativeExpectedPnlUsd =
    input.intent.mismatchPFatalUpper === null || input.intent.mismatchPFatalUpper === undefined
      ? projectedNetProfitUsd
      : round4(
          pairSize * (1 - input.intent.mismatchPFatalUpper) - worstFillCostUsd,
        );
  return {
    ...input.opportunity,
    grossCost: round4(legs.reduce((sum, leg) => sum + (leg.price ?? 0), 0)),
    worstCaseProfitUsd: projectedNetProfitUsd,
    fatalMismatchPnlUsd: round4(-worstFillCostUsd),
    conservativeExpectedPnlUsd,
    estimatedFeesUsd: round4(legs.reduce((sum, leg) => sum + leg.feeEstimateUsd, 0)),
    projectedNetProfitUsd,
    projectedNetReturn: worstFillCostUsd > 0
      ? round4(projectedNetProfitUsd / worstFillCostUsd)
      : null,
    legs,
  };
}

function applyWorstFillEconomicsToIntent(
  intent: OrderIntent,
  opportunity: LiveOpportunity,
  now: number,
): OrderIntent {
  const pairSize = Math.min(opportunity.legs[0].size, opportunity.legs[1].size);
  const fatalLossExposureUsd = Math.max(0, -(opportunity.fatalMismatchPnlUsd ?? 0));
  const conservativeExpectedPnlUsd =
    intent.mismatchPFatalUpper === null || intent.mismatchPFatalUpper === undefined
      ? opportunity.conservativeExpectedPnlUsd ?? null
      : round4(pairSize * (1 - intent.mismatchPFatalUpper) - fatalLossExposureUsd);
  return {
    ...intent,
    grossCost: opportunity.grossCost ?? intent.grossCost,
    targetNotionalUsd: round4(
      intent.legs.reduce((sum, leg) => sum + leg.requestedNotionalUsd, 0),
    ),
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
  const fatalLossExposureUsd = Math.max(
    standardWorstFillCostUsd,
    Math.max(0, -(opportunity.fatalMismatchPnlUsd ?? 0)),
  );
  const recoveryReserveUsd = Math.max(
    0,
    fatalLossExposureUsd - standardWorstFillCostUsd,
  );

  return intent.legs.map((leg) => {
    const opportunityLeg = opportunity.legs.find(
      (candidate) =>
        candidate.venue === leg.venue && candidate.outcome === leg.outcome,
    );
    const worstFillCostUsd = opportunityLeg
      ? opportunityLeg.targetNotionalUsd + opportunityLeg.feeEstimateUsd
      : leg.requestedNotionalUsd + Math.max(0, leg.feeUsd);
    return {
      ...leg,
      worstFillCostUsd: round4(Math.max(0, worstFillCostUsd)),
      recoveryReserveUsd:
        leg.venue === intent.hedgeVenue ? round4(recoveryReserveUsd) : 0,
    };
  }) as OrderIntent["legs"];
}

function applyConservativeHedgeRiskFallback(
  intent: OrderIntent,
  settings: Pick<
    StrategyConfig,
    "hedgeRescueEnabled" | "hedgeRescueMaxLossUsd" | "forcedUnwindMaxLossUsd"
  >,
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
      leg.filledSize > 0 && leg.filledPrice !== null
        ? leg.filledSize * leg.filledPrice + Math.max(0, leg.feeUsd)
        : 0;
    const remainingSize = Math.max(0, leg.requestedSize - leg.filledSize);
    const remainingCostUsd =
      remainingSize *
      (0.99 + CONSERVATIVE_REMAINING_BUY_FEE_USD_PER_UNIT);
    return sum + filledCostUsd + remainingCostUsd;
  }, 0);
  const recoveryReserveUsd = calculateHedgeRecoveryReserveUsd({
    pairSize,
    standardWorstFillCostUsd: limitLossUsd,
    intent,
    settings,
  });
  const fatalLossExposureUsd = round4(Math.max(
    intent.fatalLossExposureUsd ?? 0,
    limitLossUsd + recoveryReserveUsd,
  ));
  const riskLegs = intent.legs.map((leg) => {
    const filledCostUsd =
      leg.filledSize > 0 && leg.filledPrice !== null
        ? leg.filledSize * leg.filledPrice + Math.max(0, leg.feeUsd)
        : 0;
    const remainingSize = Math.max(0, leg.requestedSize - leg.filledSize);
    const worstFillCostUsd =
      filledCostUsd +
      remainingSize *
        (0.99 + CONSERVATIVE_REMAINING_BUY_FEE_USD_PER_UNIT);
    return {
      ...leg,
      worstFillCostUsd: round4(
        Math.max(leg.worstFillCostUsd ?? 0, worstFillCostUsd),
      ),
      recoveryReserveUsd:
        leg.venue === intent.hedgeVenue
          ? round4(Math.max(leg.recoveryReserveUsd ?? 0, recoveryReserveUsd))
          : 0,
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
    mismatchPFatal: estimate ? estimate.pFatal : intent.mismatchPFatal ?? null,
    mismatchPFatalUpper: estimate ? estimate.pFatalUpper95 : intent.mismatchPFatalUpper ?? null,
    mismatchModelVersion: estimate ? estimate.modelVersion : intent.mismatchModelVersion ?? null,
    mismatchRiskAudit: opportunity.mismatchRiskAudit ?? intent.mismatchRiskAudit ?? null,
    fatalMismatchPnlUsd: opportunity.fatalMismatchPnlUsd ?? null,
    conservativeExpectedPnlUsd: opportunity.conservativeExpectedPnlUsd ?? null,
    fatalLossExposureUsd: opportunity.fatalMismatchPnlUsd === null || opportunity.fatalMismatchPnlUsd === undefined
      ? null
      : round4(Math.max(0, -opportunity.fatalMismatchPnlUsd)),
    legs: applyOpportunityRiskReservationsToLegs(intent, opportunity),
    updatedAt: now,
  };
}

function buildRiskOpportunityTemplateFromIntent(
  intent: OrderIntent,
  settings: StrategyConfig,
): LiveOpportunity {
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
      const lastEntryCosts = sharedContext.lastEntryCosts ?? (await readLastEntryCosts(slot.asset, slot.key));
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
      const globalRiskConfig = await getCachedGlobalRiskConfig(now);
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
      });
      const clusterBudget = settings.mismatchRiskMode === "enforce"
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
            }
          : null,
      });
      const opportunities = riskSizedOpportunities.map((opportunity) => {
        const estimate = rescaleMismatchEstimate(
          opportunity,
          mismatchRiskEstimates[opportunity.combination] ?? null,
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

      latestScanSnapshot = nextSnapshot;
      return nextSnapshot;
    },

    async execute(slot, now, providedSnapshot = null) {
      const snapshot = providedSnapshot ?? latestScanSnapshot ?? (await refreshLatestSnapshot(slot));
      const readiness = await computeReadiness(snapshot, slot.asset, now);
      const pausingBreakers = readiness.breakers.filter((breaker) =>
        shouldPauseExecutionForBreaker(breaker, now, slot.asset, snapshot?.slotKey ?? slot.key),
      );

      await writeAssetWorkerState(slot.asset, {
        readinessStatus: readiness.state.readinessStatus,
        readiness: readiness.state.readiness,
      }, now, false);

      if (!settings.enableTrading || (!settings.shadowMode && pausingBreakers.length > 0)) {
        return [];
      }

      if (!settings.shadowMode && readiness.state.readinessStatus !== "ready") {
        return [];
      }

      if (!snapshot) {
        return [];
      }

      if (!isOpportunitySnapshotFresh(snapshot, now, settings.maxSignalAgeMs)) {
        await maybeWriteStaleSignalRunEvent(slot.asset, snapshot, settings, now);
        return [];
      }

      const eligible = snapshot.opportunities.filter((opportunity) => opportunity.eligible);
      if (!settings.shadowMode && eligible.length === 0) {
        return [];
      }

      const executeWithinLock = async () => {
        const initialOpenIntents = await readOpenOrderIntents(slot.asset);
        const activeSlotIntents = initialOpenIntents.filter(
          (intent) => intent.slotEndTs + RESOLUTION_GRACE_MS > now,
        );
        const resumed = [
          ...(await resumeShadowIntents(
            initialOpenIntents.filter((intent) => intent.shadow),
            snapshot,
            settings,
          )),
          ...(await resumeInFlightIntents(
            activeSlotIntents.filter((intent) => !intent.shadow),
            slot,
            settings,
            now,
          )),
        ];
        const openIntents = await readOpenOrderIntents();
        const assetOpenIntents = openIntents.filter((intent) => intent.asset === slot.asset);

        if (hasUnresolvedExposureBlocker(openIntents.filter((intent) => !intent.shadow))) {
          return resumed;
        }

        const blockingOpenForSlot = countSlotExecutionBlockers(assetOpenIntents, slot.key);
        const shadowExecutionBlockers = countShadowExecutionBlockers(assetOpenIntents, slot.asset);
        const latestShadowIntent = settings.shadowMode
          ? (await readRecentOrderIntents(200, slot.asset)).find((intent) => intent.shadow) ?? null
          : null;
        const shadowCooldownRemainingMs = getShadowReentryCooldownRemainingMs(
          latestShadowIntent,
          Date.now(),
        );
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
        const creationBudget = settings.shadowMode
          ? 1
          : settings.maxOpenIntentsPerSlot - blockingOpenForSlot;
        let createdCount = 0;

        for (const opportunity of eligible) {
          if (createdCount >= creationBudget) {
            break;
          }

          const currentBreakers = (await readCircuitBreakers()).filter(
            (breaker) => shouldPauseExecutionForBreaker(breaker, now, slot.asset, slot.key),
          );
          if (currentBreakers.length > 0) {
            break;
          }

          const currentOpenIntents = await readOpenOrderIntents();
          const currentAssetOpenIntents = currentOpenIntents.filter((intent) => intent.asset === slot.asset);
          if (hasUnresolvedExposureBlocker(currentOpenIntents.filter((intent) => !intent.shadow))) {
            break;
          }

          const currentSlotBlockers = countSlotExecutionBlockers(currentAssetOpenIntents, slot.key);
          const currentShadowBlockers = countShadowExecutionBlockers(
            currentAssetOpenIntents,
            slot.asset,
          );
          if (
            settings.shadowMode
              ? currentShadowBlockers > 0
              : currentSlotBlockers >= settings.maxOpenIntentsPerSlot
          ) {
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

          const preparedIntent =
            settings.shadowMode
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
          const mismatchRecheckAt = Date.now();
          const mismatchRecheck = await recheckMismatchRiskForExecution({
            opportunity,
            intent: preparedIntent.intent,
            slot,
            settings,
            openIntents: currentOpenIntents,
            venueExposureUsd: exposureUsd,
            now: mismatchRecheckAt,
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
                mismatchRiskAudit:
                  mismatchRecheck.opportunity?.mismatchRiskAudit ?? null,
              },
              createdAt: mismatchRecheckAt,
            });
            continue;
          }
          const executionOpportunity = mismatchRecheck.opportunity;
          const intent = applyRiskCheckedOpportunityToIntent(
            preparedIntent.intent,
            executionOpportunity,
            mismatchRecheckAt,
          );

          for (const leg of executionOpportunity.legs) {
            exposureUsd[leg.venue] += leg.targetNotionalUsd + leg.feeEstimateUsd;
          }
          const standardWorstFillCostUsd = executionOpportunity.legs.reduce(
            (sum, leg) => sum + leg.targetNotionalUsd + leg.feeEstimateUsd,
            0,
          );
          const recoveryReserveUsd = Math.max(
            0,
            -(executionOpportunity.fatalMismatchPnlUsd ?? -standardWorstFillCostUsd) -
              standardWorstFillCostUsd,
          );
          if (recoveryReserveUsd > 0) {
            exposureUsd[intent.hedgeVenue] += recoveryReserveUsd;
          }

          await writeOrderIntent(intent);
          await writeRunEvent({
            level: "info",
            eventType: "intent.created",
            message: `Intent ${intent.id} created for ${intent.combination}`,
            payload: {
              slotKey: intent.slotKey,
              primaryVenue: intent.primaryVenue,
              primarySelection: executionOpportunity.primarySelection ?? null,
              mismatchRiskAudit: intent.mismatchRiskAudit ?? null,
            },
            createdAt: now,
          });

          const executed = settings.shadowMode
            ? await executeShadowIntent(intent, snapshot, settings, Date.now())
            : await executeIntent(intent, slot, settings, now);
          created.push(executed);
          createdCount += 1;
        }

        return created;
      };

      if (settings.shadowMode) {
        return executeWithinLock();
      }

      const lockResult = await tryWithGlobalLiveExecutionLock(
        `execute:${slot.asset}:${slot.key}`,
        executeWithinLock,
      );
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
          await reconcileVenueOrders(asset, now, sharedContext);
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("reconcile_inflight_intents", now, async () => {
          await reconcileInFlightIntentStates(asset, now, settings, sharedContext);
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

export function getMismatchEstimationSettings(
  settings: StrategyConfig,
): StrategyConfig {
  return settings.mismatchRiskMode === "enforce"
    ? { ...settings, mismatchRiskMode: "shadow" }
    : settings;
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
      modelVersion:
        snapshot.opportunities.find((opportunity) => opportunity.mismatchRiskEstimate)?.mismatchRiskEstimate
          ?.modelVersion ?? null,
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

export function selectWinningExecutionCandidate(
  candidates: ExecutionCandidate[],
  now: number,
) {
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

function isWinningCandidateForScanState(
  winner: ExecutionCandidate,
  scanState: RealtimeScanState,
  now: number,
) {
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

async function readCachedSettingsMap(now: number) {
  const entries = await Promise.all(
    ACTIVE_MARKET_ASSETS.map(async (asset) => [asset, await readCachedSettings(asset, now)] as const),
  );
  return Object.fromEntries(entries) as Record<MarketAsset, StrategyConfig>;
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

async function readCachedLastEntryCosts(asset: MarketAsset, slotKey: string, now: number) {
  const key = `${asset}:${slotKey}`;
  const cached = lastEntryCostsCache.get(key);
  if (cached && now - cached.capturedAt <= LAST_ENTRY_COSTS_CACHE_TTL_MS) {
    return cached.value;
  }

  const value = await readLastEntryCosts(asset, slotKey);
  lastEntryCostsCache.set(key, { value, capturedAt: now });
  return value;
}

function getLoopHealth(asset: MarketAsset): WorkerState["loopHealth"] {
  return loopHealthByAsset[asset] ?? {
    lastScanDurationMs: null,
    lastExecutionDurationMs: null,
    lastReconcileDurationMs: null,
    lastScanAgeMs: null,
    lastCandidateScore: null,
    lockBusyCount: 0,
    staleSignalCount: 0,
    updatedAt: null,
  };
}

function updateLoopHealth(
  asset: MarketAsset,
  patch: Partial<WorkerState["loopHealth"]>,
  now: number,
) {
  const next = {
    ...getLoopHealth(asset),
    ...patch,
    updatedAt: now,
  };
  loopHealthByAsset[asset] = next;
  return next;
}

async function writeAssetWorkerState(
  asset: MarketAsset,
  state: Partial<WorkerState>,
  now: number,
  force: boolean,
) {
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
  const loopHealth = updateLoopHealth(asset, {
    lockBusyCount: previousHealth.lockBusyCount + 1,
  }, now);
  await writeAssetWorkerState(asset, {
    phase: "execute",
    currentSlotKey: slotKey,
    lastExecuteAt: now,
    loopHealth,
  }, now, true);

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
  updateLoopHealth(asset, {
    staleSignalCount: previousHealth.staleSignalCount + 1,
    lastScanAgeMs: getOpportunitySnapshotAgeMs(snapshot, now),
  }, now);
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

function shouldRunReconcileCadence(
  asset: MarketAsset,
  key: ReconcileCadenceKey,
  now: number,
  intervalMs: number,
) {
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

async function refreshVenuePositions(): Promise<
  | {
      polymarket: PositionSnapshot[];
      kalshi: PositionSnapshot[];
    }
  | null
> {
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

function getGlobalPolyBridgeLowWaterUsdc(settingsMap: Record<MarketAsset, StrategyConfig>) {
  return Math.max(...ACTIVE_MARKET_ASSETS.map((asset) => settingsMap[asset].polyBridgeLowWaterUsdc));
}

async function computeReadiness(
  snapshot: OpportunitySnapshot | null,
  asset: MarketAsset,
  now: number,
): Promise<{ state: Partial<WorkerState>; breakers: Awaited<ReturnType<typeof readCircuitBreakers>> }> {
  const balances = await readVenueBalances();
  const slotKey = snapshot?.slotKey ?? null;
  const breakers = (await readCircuitBreakers()).filter((breaker) => isBreakerRelevantToSlot(breaker, asset, slotKey));
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
  const activeBreakers = breakers.filter((breaker) => breaker.active);
  const blockingBreakers = activeBreakers.filter((breaker) => getCircuitBreakerReadinessStatus(breaker, now) === "blocked");
  const cooldownBreakers = activeBreakers.filter((breaker) => getCircuitBreakerReadinessStatus(breaker, now) === "cooldown");
  const degradedBreakers = activeBreakers.filter((breaker) => getCircuitBreakerReadinessStatus(breaker, now) === "degraded");
  if (blockingBreakers.length > 0) {
    checks.push({
      key: "circuit-breaker",
      label: "Circuit breaker",
      status: "blocked",
      details: blockingBreakers.map((breaker) => `${breaker.key}:${breaker.reason}`).join(" | "),
      checkedAt: now,
    });
  }
  if (cooldownBreakers.length > 0) {
    checks.push({
      key: "circuit-breaker-cooldown",
      label: "Circuit breaker cooldown",
      status: "cooldown",
      details: cooldownBreakers.map((breaker) => describeCircuitBreakerForReadiness(breaker, now)).join(" | "),
      checkedAt: now,
    });
  }
  if (degradedBreakers.length > 0) {
    checks.push({
      key: "circuit-breaker-degraded",
      label: "Circuit breaker degraded",
      status: "degraded",
      details: degradedBreakers.map((breaker) => `${breaker.key}:${breaker.reason}`).join(" | "),
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

function buildPersistedFeedBreakerSignature(slot: MarketSlot, breaker: CircuitBreaker) {
  if (!isFeedHealthBreaker(breaker)) {
    return null;
  }
  const payload = breaker.payload as { feeds: Array<{ venue?: unknown; source?: unknown }> };
  const blocked = payload.feeds
    .map((feed) => `${String(feed.venue ?? "unknown")}:${String(feed.source ?? "unknown")}`)
    .sort()
    .join(",");
  return `${slot.key}:${blocked || "ready"}`;
}

async function persistFeedCircuitBreaker(slot: MarketSlot, feedHealth: VenueFeedHealth[], now: number) {
  const key = buildSlotBreakerKey(slot.key);
  const breakers = await readCircuitBreakers();
  const currentBreaker = breakers.find((breaker) => breaker.key === key) ?? null;
  for (const breaker of breakers) {
    const breakerAsset = getBreakerAsset(breaker.key);

    if (
      breaker.active &&
      breaker.key.startsWith("slot:") &&
      breaker.key !== key &&
      breakerAsset === slot.asset &&
      isFeedHealthBreaker(breaker)
    ) {
      await writeCircuitBreaker({
        key: breaker.key,
        active: false,
        reason: null,
        triggeredAt: null,
        payload: null,
      });
    }
  }
  const blockedFeeds = feedHealth.filter((feed) => feed.feedStatus === "blocked");

  if (blockedFeeds.length === 0) {
    if (!currentBreaker?.active) {
      return;
    }
    if (!shouldManageFeedHealthBreaker(currentBreaker)) {
      return;
    }
    await writeCircuitBreaker({
      key,
      active: false,
      reason: null,
      triggeredAt: null,
      payload: null,
    });
    return;
  }

  if (!shouldManageFeedHealthBreaker(currentBreaker)) {
    return;
  }

  if (
    currentBreaker?.active &&
    buildPersistedFeedBreakerSignature(slot, currentBreaker) === buildFeedBreakerSignature(slot, feedHealth)
  ) {
    return;
  }

  await writeCircuitBreaker({
    key,
    active: true,
    reason: "venue_error",
    triggeredAt: now,
    payload: {
      feeds: blockedFeeds.map((feed) => ({
        venue: feed.venue,
        source: feed.source,
        stalenessMs: feed.stalenessMs,
        details: feed.details,
      })),
    },
  });
}

async function executeIntent(intent: OrderIntent, slot: MarketSlot, settings: StrategyConfig, now: number) {
  let primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  let hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
  if (!primaryLeg || !hedgeLeg) {
    throw new Error(`Intent ${intent.id} missing legs`);
  }

  let currentIntent = markIntentStatus(intent, "executing_primary", now);
  await writeOrderIntent(currentIntent);
  const entryDepthPreflight = await preflightEntryDepthAndAdjustIntent(currentIntent, slot, settings, now);
  if (entryDepthPreflight.status === "skipped") {
    return skipIntentBeforeSubmission(
      currentIntent,
      Date.now(),
      entryDepthPreflight.reason,
      "insufficient_depth",
      { entryDepthPreflight },
    );
  }
  if (entryDepthPreflight.intent !== currentIntent) {
    currentIntent = entryDepthPreflight.intent;
    await writeOrderIntent(currentIntent);
    primaryLeg = currentIntent.legs.find((leg) => leg.venue === currentIntent.primaryVenue);
    hedgeLeg = currentIntent.legs.find((leg) => leg.venue === currentIntent.hedgeVenue);
    if (!primaryLeg || !hedgeLeg) {
      throw new Error(`Intent ${currentIntent.id} missing legs after entry depth preflight`);
    }
  }
  const finalRiskCheckAt = Date.now();
  const [finalOpenIntents, finalPositions] = await Promise.all([
    readOpenOrderIntents(),
    readPositions(),
  ]);
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
  });
  if (!finalRiskCheck.allowed) {
    if (finalRiskCheck.opportunity) {
      currentIntent = applyRiskCheckedOpportunityToIntent(
        currentIntent,
        finalRiskCheck.opportunity,
        finalRiskCheckAt,
      );
    }
    currentIntent = markIntentStatus(
      currentIntent,
      "skipped",
      finalRiskCheckAt,
      `Final mismatch risk check failed: ${finalRiskCheck.reason}`,
    );
    await writeOrderIntent(currentIntent);
    await writeRunEvent({
      asset: currentIntent.asset,
      level: "warn",
      eventType: "intent.skipped.final_mismatch_risk_recheck",
      message: `Intent ${currentIntent.id} rejected after final WS preflight`,
      payload: {
        intentId: currentIntent.id,
        slotKey: currentIntent.slotKey,
        combination: currentIntent.combination,
        reason: finalRiskCheck.reason,
        estimate: finalRiskCheck.estimate,
        mismatchRiskAudit:
          finalRiskCheck.opportunity?.mismatchRiskAudit ?? null,
      },
      createdAt: finalRiskCheckAt,
    });
    return currentIntent;
  }
  currentIntent = applyRiskCheckedOpportunityToIntent(
    currentIntent,
    finalRiskCheck.opportunity,
    finalRiskCheckAt,
  );
  await writeOrderIntent(currentIntent);
  primaryLeg = currentIntent.legs.find((leg) => leg.venue === currentIntent.primaryVenue);
  hedgeLeg = currentIntent.legs.find((leg) => leg.venue === currentIntent.hedgeVenue);
  if (!primaryLeg || !hedgeLeg) {
    throw new Error(`Intent ${currentIntent.id} missing legs after final mismatch risk check`);
  }
  const primaryMaxSlippageBps = entryDepthPreflight.maxSlippageBps;

  const finalEntrySnapshotAt = Date.now();
  const finalEntryState = await marketDataSupervisor.readSlotState(
    slot,
    finalEntrySnapshotAt,
  );
  const finalEntryIssue = validateFinalWsEntryDepthCoverage(
    slot,
    primaryLeg,
    hedgeLeg,
    finalEntryState.polymarket.quote,
    finalEntryState.kalshi.quote,
    settings,
    finalEntrySnapshotAt,
  );
  if (finalEntryIssue) {
    return skipIntentBeforeSubmission(
      currentIntent,
      finalEntrySnapshotAt,
      `Final entry snapshot rejected primary submission (${finalEntryIssue})`,
      "final_ws_depth_recheck",
      { issue: finalEntryIssue },
    );
  }

  const executionPrimaryLeg = primaryLeg;
  const primaryRequest = buildVenueOrderRequest(executionPrimaryLeg, primaryMaxSlippageBps, primaryImmediateOrderType(executionPrimaryLeg.venue), false, {
    kalshiPriceTicksSlippage: currentIntent.primaryVenue === "kalshi" ? settings.kalshiPrimaryPriceTicksSlippage : undefined,
  });
  let primaryResult: Awaited<ReturnType<VenueAdapter["placeOrder"]>>;
  let primaryOrder: LiveOrder;
  let primaryExecutionTiming: OrderExecutionTiming | null = null;
  let persistPrimaryConfirmation: (() => Promise<void>) | null = null;
  try {
    const primaryExecution = await submitAndConfirmOrder({
      intent: currentIntent,
      leg: executionPrimaryLeg,
      request: primaryRequest,
      stage: "primary",
      now,
      timeoutMs: settings.immediateOrderConfirmationTimeoutMs,
      deferConfirmedPersistence: true,
    });
    primaryResult = primaryExecution.result;
    primaryOrder = primaryExecution.order;
    primaryExecutionTiming = "timing" in primaryExecution ? primaryExecution.timing : null;
    persistPrimaryConfirmation = "persistConfirmed" in primaryExecution
      ? primaryExecution.persistConfirmed
      : null;
  } catch (error) {
    const recovered = await recoverKalshiOrderSubmissionForIntent(
      currentIntent,
      executionPrimaryLeg,
      primaryRequest,
      now,
      "primary",
    );
    if (!recovered) {
      if (shouldFailClosedOnSubmissionError(executionPrimaryLeg)) {
        return markIntentManualRequired(
          currentIntent,
          Date.now(),
          "polymarket_primary_submission_truth_unknown",
          `Polymarket primary may have reached the venue before the submission error (${toErrorMessage(error)})`,
          {
            clientOrderId: primaryRequest.clientOrderId,
            error: toErrorMessage(error),
          },
        );
      }
      currentIntent = markIntentStatus(
        currentIntent,
        "failed",
        now,
        `Primary submission failed (${toErrorMessage(error)})`,
      );
      await writeOrderIntent(currentIntent);
      await writeRunEvent({
        level: "error",
        eventType: "order.primary.submit_failed",
        message: `Primary ${currentIntent.primaryVenue} submission failed for intent ${currentIntent.id}`,
        payload: {
          intentId: currentIntent.id,
          venue: currentIntent.primaryVenue,
          clientOrderId: primaryRequest.clientOrderId,
          error: toErrorMessage(error),
        },
        createdAt: now,
      });
      await writeCircuitBreaker({
        key: buildSlotBreakerKey(currentIntent.slotKey),
        active: true,
        reason: "venue_error",
        triggeredAt: now,
        payload: {
          intentId: currentIntent.id,
          venue: currentIntent.primaryVenue,
          stage: "primary_submission",
        },
      });
      return currentIntent;
    }

    primaryResult = recovered.result;
    primaryOrder = recovered.order;
  }

  if (primaryOrder.filledSize > 0 && shouldTreatPrimaryExecutionAsFilled(currentIntent, primaryResult, primaryOrder)) {
    const primaryFillObservedAt = Date.now();
    currentIntent = updateIntentLeg(currentIntent, executionPrimaryLeg.venue, primaryOrder, "filled", primaryFillObservedAt);
    currentIntent = markIntentStatus(currentIntent, "primary_filled", primaryFillObservedAt);
    const primaryWasPartial =
      primaryOrder.filledSize + ORDER_SIZE_TOLERANCE < primaryOrder.requestedSize;
    let hedgedIntent: OrderIntent;
    try {
      hedgedIntent = await executeHedgeLeg(currentIntent, slot, settings, primaryFillObservedAt, primaryExecutionTiming);
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
    currentIntent = markIntentStatus(
      currentIntent,
      "failed",
      now,
      describeTerminalNoFill("Primary", primaryResult),
    );
    await writeOrderIntent(currentIntent);
    if (shouldTripBreakerForTerminalNoFill(primaryResult)) {
      await writeCircuitBreaker({
        key: buildSlotBreakerKey(currentIntent.slotKey),
        active: true,
        reason: "venue_error",
        triggeredAt: now,
        payload: {
          intentId: currentIntent.id,
          venue: currentIntent.primaryVenue,
          stage: "primary_confirmation",
          orderId: primaryOrder.venueOrderId,
        },
      });
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
  await writeOrderIntent(currentIntent);
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

async function executeKalshiPrimaryMultiClip(
  intent: OrderIntent,
  primaryLeg: OrderIntent["legs"][number],
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
  clipPlan: number[],
): Promise<{ intent: OrderIntent; outcome: "filled" | "hedged" | "failed" | "awaiting_confirmation" }> {
  let currentIntent = intent;
  const requestedPrimarySize = primaryLeg.requestedSize;
  const estimatedRequestedSizeFee =
    primaryLeg.requestedPrice === null
      ? null
      : calculateKalshiFee({
          contracts: requestedPrimarySize,
          price: primaryLeg.requestedPrice,
          feeMultiplier: 1,
        });
  const estimatedFallbackFeeByClip =
    primaryLeg.requestedPrice === null
      ? null
      : clipPlan.map((clipSize) => ({
          clipSize,
          feeUsd: calculateKalshiFee({
            contracts: clipSize,
            price: primaryLeg.requestedPrice ?? 0,
            feeMultiplier: 1,
          }),
        }));

  await writeRunEvent({
    level: "info",
    eventType: "order.primary.multi_clip_plan",
    message: `Primary Kalshi fallback clip plan armed for intent ${intent.id}`,
    payload: {
      intentId: intent.id,
      slotKey: intent.slotKey,
      mode: "descending_fallback",
      requestedSize: requestedPrimarySize,
      clipPlan,
      clipCount: clipPlan.length,
      priceMode: "fast_original_signal",
      estimatedRequestedSizeFeeUsd: estimatedRequestedSizeFee,
      estimatedFallbackFeeUsdByClip: estimatedFallbackFeeByClip,
    },
    createdAt: now,
  });

  let totalPrimaryOrderAttempts = 0;
  const failedClipSummaries: Array<{
    clipIndex: number;
    requestedSize: number;
    attempts: number;
    status: LiveOrder["status"];
    detail: string | null;
  }> = [];

  for (let clipIndex = 0; clipIndex < clipPlan.length; clipIndex += 1) {
    const clipAttemptNow = Date.now();
    const clipSize = clipPlan[clipIndex];
    const repricedIntent = await repriceIntentWithinExecutionBuffer(
      currentIntent,
      slot,
      settings,
      clipAttemptNow,
      clipSize,
    );

    if (!repricedIntent) {
      const repriceDiagnostic = await diagnoseRepriceIntentFailure(
        currentIntent,
        slot,
        settings,
        Date.now(),
        clipSize,
      );
      if (currentIntent.legs.find((leg) => leg.id === primaryLeg.id)?.filledSize ?? 0 > 0) {
        const unhedgedPrimarySize = deriveUnhedgedPrimarySize(currentIntent);
        if (unhedgedPrimarySize <= ORDER_SIZE_TOLERANCE) {
          currentIntent = await markIntentHedgedAfterEconomicCheck(
            currentIntent,
            clipAttemptNow,
            "primary_multi_clip_stopped_already_hedged",
          );
          if (currentIntent.status === "hedged") {
            await writeLiveTradeRunEvent(currentIntent, clipAttemptNow, "hedged");
          }
        } else {
          currentIntent = markIntentStatus(resizeHedgeLegToFilledPrimary(currentIntent, clipAttemptNow), "primary_filled", clipAttemptNow);
          await writeOrderIntent(currentIntent);
          await writeLiveTradeRunEvent(currentIntent, clipAttemptNow);
        }
        await writeRunEvent({
          level: "warn",
          eventType: "order.primary.multi_clip_stopped",
          message: `Primary Kalshi multi-clip stopped before clip ${clipIndex + 1}/${clipPlan.length}; hedging the executed size`,
          payload: {
            intentId: currentIntent.id,
            slotKey: currentIntent.slotKey,
            clipIndex: clipIndex + 1,
            clipCount: clipPlan.length,
            reason: "pair_outside_execution_window",
            repriceDiagnostic,
            totalFilledSize: currentIntent.legs.find((leg) => leg.id === primaryLeg.id)?.filledSize ?? 0,
          },
          createdAt: clipAttemptNow,
        });
        return {
          intent: currentIntent,
          outcome: unhedgedPrimarySize <= ORDER_SIZE_TOLERANCE ? "hedged" : "filled",
        };
      }

      if (clipIndex < clipPlan.length - 1) {
        await writeRunEvent({
          level: "warn",
          eventType: "order.primary.clip_fallback",
          message: `Primary Kalshi fallback moved from clip ${clipIndex + 1}/${clipPlan.length} before submission`,
          payload: {
            intentId: currentIntent.id,
            slotKey: currentIntent.slotKey,
            clipIndex: clipIndex + 1,
            clipCount: clipPlan.length,
            clipSize,
            nextClipSize: clipPlan[clipIndex + 1],
            reason: "pair_outside_execution_window",
            repriceDiagnostic,
          },
          createdAt: clipAttemptNow,
        });
        continue;
      }

      currentIntent = markIntentStatus(
        currentIntent,
        "failed",
        clipAttemptNow,
        `Primary fallback moved outside the execution window before any fill (${repriceDiagnostic.reason})`,
      );
      await writeOrderIntent(currentIntent);
      await writeRunEvent({
        level: "warn",
        eventType: "order.primary.multi_clip_aborted",
        message: `Primary Kalshi multi-clip aborted for intent ${currentIntent.id} before any fill`,
        payload: {
          intentId: currentIntent.id,
          slotKey: currentIntent.slotKey,
          clipIndex: clipIndex + 1,
          clipCount: clipPlan.length,
          reason: "pair_outside_execution_window",
          repriceDiagnostic,
        },
        createdAt: clipAttemptNow,
      });
      return {
        intent: currentIntent,
        outcome: "failed",
      };
    }

    const repricedPrimaryLeg = repricedIntent.legs.find((leg) => leg.id === primaryLeg.id);
    if (!repricedPrimaryLeg) {
      currentIntent = markIntentStatus(currentIntent, "failed", clipAttemptNow, "Primary leg missing after multi-clip repricing");
      await writeOrderIntent(currentIntent);
      return {
        intent: currentIntent,
        outcome: "failed",
      };
    }

    let primaryExecutionIntent: OrderIntent = repricedIntent;
    let executionPrimaryLeg = repricedPrimaryLeg;
    let primaryRequest = buildVenueOrderRequest(executionPrimaryLeg, settings.maxSlippageBps, "IOC", false, {
      kalshiPriceTicksSlippage: settings.kalshiPrimaryPriceTicksSlippage,
    });
    const restPreflight = await preflightKalshiPrimaryRestLiquidity(
      executionPrimaryLeg,
      primaryRequest,
      settings,
    );
    if (restPreflight.status === "insufficient") {
      const clippedIntent = await resizeKalshiPrimaryIntentFromRestPreflight(
        primaryExecutionIntent,
        primaryLeg.id,
        slot,
        settings,
        clipAttemptNow,
        restPreflight,
      );
      const clippedPrimaryLeg = clippedIntent?.legs.find((leg) => leg.id === primaryLeg.id) ?? null;

      if (clippedIntent && clippedPrimaryLeg) {
        primaryExecutionIntent = clippedIntent;
        executionPrimaryLeg = clippedPrimaryLeg;
        primaryRequest = buildVenueOrderRequest(executionPrimaryLeg, settings.maxSlippageBps, "IOC", false, {
          kalshiPriceTicksSlippage: settings.kalshiPrimaryPriceTicksSlippage,
        });
        await writeRunEvent({
          level: "warn",
          eventType: "order.primary.clip_rest_resized",
          message: `Primary Kalshi clip ${clipIndex + 1}/${clipPlan.length} reduced by REST book preflight`,
          payload: {
            intentId: currentIntent.id,
            slotKey: currentIntent.slotKey,
            clipIndex: clipIndex + 1,
            clipCount: clipPlan.length,
            originalClipSize: clipSize,
            resizedClipSize: primaryRequest.size,
            restPreflight,
          },
          createdAt: clipAttemptNow,
        });
      } else {
        totalPrimaryOrderAttempts += 1;
        failedClipSummaries.push({
          clipIndex: clipIndex + 1,
          requestedSize: executionPrimaryLeg.requestedSize,
          attempts: 0,
          status: "rejected",
          detail: "kalshi_rest_preflight_insufficient_depth",
        });

        if (clipIndex < clipPlan.length - 1) {
          await writeRunEvent({
            level: "warn",
            eventType: "order.primary.clip_fallback",
            message: `Primary Kalshi fallback moved from clip ${clipIndex + 1}/${clipPlan.length} after REST book preflight`,
            payload: {
              intentId: currentIntent.id,
              slotKey: currentIntent.slotKey,
              clipIndex: clipIndex + 1,
              clipCount: clipPlan.length,
              clipSize,
              nextClipSize: clipPlan[clipIndex + 1],
              reason: "kalshi_rest_preflight_insufficient_depth",
              restPreflight,
            },
            createdAt: clipAttemptNow,
          });
          continue;
        }

        currentIntent = await skipIntentBeforeSubmission(
          currentIntent,
          clipAttemptNow,
          `Primary fallback exhausted at clip ${clipIndex + 1}/${clipPlan.length} before submission (Kalshi REST depth insufficient); attempted ${totalPrimaryOrderAttempts} preflight${totalPrimaryOrderAttempts === 1 ? "" : "s"} across fallback clips ${clipPlan.join(" -> ")}; last requested ${executionPrimaryLeg.requestedSize.toFixed(2)}`,
          "kalshi_rest_preflight_insufficient_depth",
          {
            intentId: currentIntent.id,
            slotKey: currentIntent.slotKey,
            venue: currentIntent.primaryVenue,
            clipIndex: clipIndex + 1,
            clipCount: clipPlan.length,
            clipPlan,
            failedClipSummaries,
            restPreflight,
          },
        );
        return {
          intent: currentIntent,
          outcome: "failed",
        };
      }
    }
    const hedgePreflight = await preflightPolymarketHedgeLiquidity(primaryExecutionIntent, settings);
    if (hedgePreflight.status === "insufficient" || hedgePreflight.status === "unavailable") {
      currentIntent = await skipIntentBeforeSubmission(
        primaryExecutionIntent,
        clipAttemptNow,
        `Primary Kalshi clip skipped before submission (Polymarket hedge preflight ${hedgePreflight.status})`,
        "polymarket_hedge_preflight_unavailable",
        {
          clipIndex: clipIndex + 1,
          clipCount: clipPlan.length,
          hedgePreflight,
        },
      );
      return {
        intent: currentIntent,
        outcome: "failed",
      };
    }
    let primaryOrderAttempts = 1;
    let primaryResult: Awaited<ReturnType<VenueAdapter["placeOrder"]>>;
    let primaryOrder: LiveOrder;

    try {
      const primaryExecution = await submitAndConfirmOrder({
        intent: currentIntent,
        leg: executionPrimaryLeg,
        request: primaryRequest,
        stage: "primary_legacy_multi_clip",
        now: clipAttemptNow,
        timeoutMs: settings.immediateOrderConfirmationTimeoutMs,
      });
      primaryResult = primaryExecution.result;
      primaryOrder = primaryExecution.order;
      await writeRunEvent({
        level: "info",
        eventType: "order.primary.clip_submitted",
        message: `Primary Kalshi clip ${clipIndex + 1}/${clipPlan.length} order ${primaryOrder.venueOrderId}`,
        payload: {
          intentId: currentIntent.id,
          venue: currentIntent.primaryVenue,
          orderType: primaryRequest.orderType,
          clipIndex: clipIndex + 1,
          clipCount: clipPlan.length,
          clipSize,
          orderId: primaryOrder.venueOrderId,
          requestedPrice: executionPrimaryLeg.requestedPrice,
          orderPrice: primaryRequest.price,
          restPreflight,
        },
        createdAt: clipAttemptNow,
      });
    } catch (error) {
      const recovered = await recoverKalshiOrderSubmissionForIntent(
        currentIntent,
        executionPrimaryLeg,
        primaryRequest,
        clipAttemptNow,
        "primary",
      );
      if (!recovered) {
        currentIntent = markIntentStatus(
          currentIntent,
          "failed",
          clipAttemptNow,
          `Primary multi-clip submission failed (${toErrorMessage(error)})`,
        );
        await writeOrderIntent(currentIntent);
        await writeRunEvent({
          level: "error",
          eventType: "order.primary.submit_failed",
          message: `Primary ${currentIntent.primaryVenue} multi-clip submission failed for intent ${currentIntent.id}`,
          payload: {
            intentId: currentIntent.id,
            venue: currentIntent.primaryVenue,
            clientOrderId: primaryRequest.clientOrderId,
            clipIndex: clipIndex + 1,
            clipCount: clipPlan.length,
            error: toErrorMessage(error),
          },
          createdAt: clipAttemptNow,
        });
        await writeCircuitBreaker({
          key: buildSlotBreakerKey(currentIntent.slotKey),
          active: true,
          reason: "venue_error",
          triggeredAt: clipAttemptNow,
          payload: {
            intentId: currentIntent.id,
            venue: currentIntent.primaryVenue,
            stage: "primary_multi_clip_submission",
            clipIndex: clipIndex + 1,
          },
        });
        return {
          intent: currentIntent,
          outcome: "failed",
        };
      }

      primaryResult = recovered.result;
      primaryOrder = recovered.order;
    }

    if (primaryOrder.filledSize > 0 && shouldTreatPrimaryExecutionAsFilled(currentIntent, primaryResult, primaryOrder)) {
      currentIntent = accumulateIntentLegOrder(primaryExecutionIntent, primaryLeg.id, primaryOrder, "filled", clipAttemptNow);
      currentIntent = annotateThirdKalshiFallbackEntry(
        currentIntent,
        clipIndex,
        clipPlan,
        failedClipSummaries.length,
        primaryOrder.requestedSize,
      );
      await writeOrderIntent(currentIntent);
      await writeRunEvent({
        level: primaryResult.status === "filled" ? "info" : "warn",
        eventType: primaryResult.status === "filled" ? "order.primary.clip_filled" : "order.primary.clip_partially_filled",
        message:
          primaryResult.status === "filled"
            ? `Primary Kalshi clip ${clipIndex + 1}/${clipPlan.length} filled for intent ${currentIntent.id}`
            : `Primary Kalshi clip ${clipIndex + 1}/${clipPlan.length} partially filled for intent ${currentIntent.id}`,
        payload: {
          intentId: currentIntent.id,
          slotKey: currentIntent.slotKey,
          clipIndex: clipIndex + 1,
          clipCount: clipPlan.length,
          clipSize,
          orderId: primaryOrder.venueOrderId,
          clipFilledSize: primaryOrder.filledSize,
          totalFilledSize: currentIntent.legs.find((leg) => leg.id === primaryLeg.id)?.filledSize ?? 0,
          entrySizingReason: currentIntent.entrySizingReason ?? null,
        },
        createdAt: clipAttemptNow,
      });
      const incrementalHedge = await executeIncrementalHedgeLeg(
        currentIntent,
        slot,
        settings,
        Date.now(),
        {
          clipIndex: clipIndex + 1,
          clipCount: clipPlan.length,
          clipSize,
          retried: false,
        },
      );
      currentIntent = incrementalHedge.intent;
      if (incrementalHedge.outcome !== "hedged") {
        return incrementalHedge;
      }
      await writeRunEvent({
        level: "info",
        eventType: "order.primary.clip_hedged",
        message: `Primary Kalshi clip ${clipIndex + 1}/${clipPlan.length} hedged; fallback plan complete`,
        payload: {
          intentId: currentIntent.id,
          slotKey: currentIntent.slotKey,
          clipIndex: clipIndex + 1,
          clipCount: clipPlan.length,
          totalFilledSize: currentIntent.legs.find((leg) => leg.id === primaryLeg.id)?.filledSize ?? 0,
          totalHedgedSize: currentIntent.legs.find((leg) => leg.venue === currentIntent.hedgeVenue)?.filledSize ?? 0,
        },
        createdAt: clipAttemptNow,
      });
      return {
        intent: currentIntent,
        outcome: "hedged",
      };
    }

    if (isTerminalOrderStatus(primaryResult.status)) {
      const primaryRetryPlan = resolveKalshiPrimaryMultiClipRetryPlan(currentIntent.primaryVenue, primaryResult);
      const retried = await retryLegWithinExecutionBufferWithAttempts(
        currentIntent,
        executionPrimaryLeg,
        slot,
        settings,
        clipAttemptNow,
        "primary",
        primaryRetryPlan.attempts,
        primaryRetryPlan.retryDelayMs,
        {
          pairSizeCap: executionPrimaryLeg.requestedSize,
          persistRepricedIntent: false,
        },
      );
      if (retried) {
        primaryOrderAttempts += retried.attemptsSubmitted;
        primaryExecutionIntent = retried.intent;
        primaryResult = retried.result;
        primaryOrder = retried.order;
      }

      if (primaryOrder.filledSize > 0 && shouldTreatPrimaryExecutionAsFilled(currentIntent, primaryResult, primaryOrder)) {
        currentIntent = accumulateIntentLegOrder(primaryExecutionIntent, primaryLeg.id, primaryOrder, "filled", Date.now());
        currentIntent = annotateThirdKalshiFallbackEntry(
          currentIntent,
          clipIndex,
          clipPlan,
          failedClipSummaries.length,
          primaryOrder.requestedSize,
        );
        await writeOrderIntent(currentIntent);
        await writeRunEvent({
          level: primaryResult.status === "filled" ? "info" : "warn",
          eventType: primaryResult.status === "filled" ? "order.primary.clip_filled" : "order.primary.clip_partially_filled",
          message:
            primaryResult.status === "filled"
              ? `Primary Kalshi clip ${clipIndex + 1}/${clipPlan.length} filled after retry for intent ${currentIntent.id}`
              : `Primary Kalshi clip ${clipIndex + 1}/${clipPlan.length} partially filled after retry for intent ${currentIntent.id}`,
          payload: {
            intentId: currentIntent.id,
            slotKey: currentIntent.slotKey,
            clipIndex: clipIndex + 1,
            clipCount: clipPlan.length,
            clipSize,
            orderId: primaryOrder.venueOrderId,
            clipFilledSize: primaryOrder.filledSize,
            totalFilledSize: currentIntent.legs.find((leg) => leg.id === primaryLeg.id)?.filledSize ?? 0,
            entrySizingReason: currentIntent.entrySizingReason ?? null,
            retried: true,
          },
          createdAt: Date.now(),
        });
        const incrementalHedge = await executeIncrementalHedgeLeg(
          currentIntent,
          slot,
          settings,
          Date.now(),
          {
            clipIndex: clipIndex + 1,
            clipCount: clipPlan.length,
            clipSize,
            retried: true,
          },
        );
        currentIntent = incrementalHedge.intent;
        if (incrementalHedge.outcome !== "hedged") {
          return incrementalHedge;
        }
        await writeRunEvent({
          level: "info",
          eventType: "order.primary.clip_hedged",
          message: `Primary Kalshi clip ${clipIndex + 1}/${clipPlan.length} hedged after retry; fallback plan complete`,
          payload: {
            intentId: currentIntent.id,
            slotKey: currentIntent.slotKey,
            clipIndex: clipIndex + 1,
            clipCount: clipPlan.length,
            totalFilledSize: currentIntent.legs.find((leg) => leg.id === primaryLeg.id)?.filledSize ?? 0,
            totalHedgedSize: currentIntent.legs.find((leg) => leg.venue === currentIntent.hedgeVenue)?.filledSize ?? 0,
            retried: true,
          },
          createdAt: Date.now(),
        });
        return {
          intent: currentIntent,
          outcome: "hedged",
        };
      }
    }

    if (isTerminalOrderStatus(primaryResult.status)) {
      totalPrimaryOrderAttempts += primaryOrderAttempts;
      failedClipSummaries.push({
        clipIndex: clipIndex + 1,
        requestedSize: primaryOrder.requestedSize,
        attempts: primaryOrderAttempts,
        status: primaryOrder.status,
        detail: extractTerminalNoFillDetail(primaryResult),
      });
      const totalFilledSize = currentIntent.legs.find((leg) => leg.id === primaryLeg.id)?.filledSize ?? 0;
      if (totalFilledSize > 0) {
        const stopNow = Date.now();
        const unhedgedPrimarySize = deriveUnhedgedPrimarySize(currentIntent);
        if (unhedgedPrimarySize <= ORDER_SIZE_TOLERANCE) {
          currentIntent = await markIntentHedgedAfterEconomicCheck(
            currentIntent,
            stopNow,
            "primary_multi_clip_terminal_already_hedged",
          );
        } else {
          currentIntent = markIntentStatus(resizeHedgeLegToFilledPrimary(currentIntent, stopNow), "primary_filled", stopNow);
          await writeOrderIntent(currentIntent);
        }
        await writeLiveTradeRunEvent(
          currentIntent,
          stopNow,
          currentIntent.status === "hedged" ? "hedged" : "primary_filled",
        );
        await writeRunEvent({
          level: "warn",
          eventType: "order.primary.multi_clip_stopped",
          message: `Primary Kalshi multi-clip stopped after clip ${clipIndex + 1}/${clipPlan.length}; hedging the executed size`,
          payload: {
            intentId: currentIntent.id,
            slotKey: currentIntent.slotKey,
            clipIndex: clipIndex + 1,
            clipCount: clipPlan.length,
            orderId: primaryOrder.venueOrderId,
            orderStatus: primaryResult.status,
            detail: extractTerminalNoFillDetail(primaryResult),
            totalFilledSize,
            totalHedgedSize: currentIntent.legs.find((leg) => leg.venue === currentIntent.hedgeVenue)?.filledSize ?? 0,
            unhedgedPrimarySize,
          },
          createdAt: stopNow,
        });
        return {
          intent: currentIntent,
          outcome: unhedgedPrimarySize <= ORDER_SIZE_TOLERANCE ? "hedged" : "filled",
        };
      }

      if (clipIndex < clipPlan.length - 1) {
        await writeRunEvent({
          level: "warn",
          eventType: "order.primary.clip_fallback",
          message: `Primary Kalshi fallback reducing after clip ${clipIndex + 1}/${clipPlan.length} received no fill`,
          payload: {
            intentId: currentIntent.id,
            slotKey: currentIntent.slotKey,
            clipIndex: clipIndex + 1,
            clipCount: clipPlan.length,
            clipSize,
            requestedSize: primaryOrder.requestedSize,
            orderAttempts: primaryOrderAttempts,
            totalOrderAttempts: totalPrimaryOrderAttempts,
            orderId: primaryOrder.venueOrderId,
            orderStatus: primaryResult.status,
            detail: extractTerminalNoFillDetail(primaryResult),
            nextClipSize: clipPlan[clipIndex + 1],
          },
          createdAt: Date.now(),
        });
        continue;
      }

      currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "failed", Date.now());
      currentIntent = markIntentStatus(
        currentIntent,
        "failed",
        Date.now(),
        `${describeTerminalNoFill(
          `Primary fallback exhausted at clip ${clipIndex + 1}/${clipPlan.length}`,
          primaryResult,
        )}; attempted ${totalPrimaryOrderAttempts} order${totalPrimaryOrderAttempts === 1 ? "" : "s"} across fallback clips ${clipPlan.join(" -> ")}; last requested ${primaryOrder.requestedSize.toFixed(2)}`,
      );
      await writeOrderIntent(currentIntent);
      if (shouldTripBreakerForTerminalNoFill(primaryResult)) {
        await writeCircuitBreaker({
          key: buildSlotBreakerKey(currentIntent.slotKey),
          active: true,
          reason: "venue_error",
          triggeredAt: Date.now(),
          payload: {
            intentId: currentIntent.id,
            venue: currentIntent.primaryVenue,
            stage: "primary_multi_clip_confirmation",
            clipIndex: clipIndex + 1,
            orderId: primaryOrder.venueOrderId,
          },
        });
      } else {
        const failureKalshiBookWs = await buildKalshiPrimaryBookTelemetry(
          slot,
          executionPrimaryLeg,
          settings,
          Date.now(),
          primaryOrder.requestedPrice,
          primaryOrder.requestedSize,
        );
        const failureKalshiBookRest = await buildKalshiPrimaryRestFailureBookTelemetry(
          executionPrimaryLeg,
          settings,
          primaryOrder.requestedPrice,
          primaryOrder.requestedSize,
        );
        await armPrimarySoftNoFillGuard(currentIntent, primaryOrder, primaryResult, Date.now());
        await writeRunEvent({
          level: "warn",
          eventType: "order.primary.no_fill",
          message: `Intent ${currentIntent.id} closed after multi-clip primary order was killed without fill`,
          payload: {
            intentId: currentIntent.id,
            slotKey: currentIntent.slotKey,
            venue: currentIntent.primaryVenue,
            orderId: primaryOrder.venueOrderId,
            orderStatus: primaryResult.status,
            orderType: primaryOrder.orderType,
            detail: extractTerminalNoFillDetail(primaryResult),
            softNoFill: Boolean(primaryResult.raw?.softNoFill),
            clipIndex: clipIndex + 1,
            clipCount: clipPlan.length,
            orderAttempts: primaryOrderAttempts,
            totalOrderAttempts: totalPrimaryOrderAttempts,
            clipPlan,
            failedClipSummaries,
            kalshiBookWsAtFailure: failureKalshiBookWs,
            kalshiBookRestAtFailure: failureKalshiBookRest,
          },
          createdAt: Date.now(),
        });
      }
      return {
        intent: currentIntent,
        outcome: "failed",
      };
    }

    currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "submitted", Date.now());
    await writeOrderIntent(currentIntent);
    await writeRunEvent({
      level: "info",
      eventType: "order.primary.awaiting_confirmation",
      message: `Primary ${currentIntent.primaryVenue} multi-clip order ${primaryOrder.venueOrderId} awaiting authoritative confirmation`,
      payload: {
        intentId: currentIntent.id,
        venue: currentIntent.primaryVenue,
        orderId: primaryOrder.venueOrderId,
        orderStatus: primaryResult.status,
        clipIndex: clipIndex + 1,
        clipCount: clipPlan.length,
      },
      createdAt: Date.now(),
    });
    return {
      intent: currentIntent,
      outcome: "awaiting_confirmation",
    };
  }

  const completedNow = Date.now();
  const unhedgedPrimarySize = deriveUnhedgedPrimarySize(currentIntent);
  if (unhedgedPrimarySize <= ORDER_SIZE_TOLERANCE) {
    currentIntent = await markIntentHedgedAfterEconomicCheck(
      currentIntent,
      completedNow,
      "primary_multi_clip_completed_already_hedged",
    );
  } else {
    currentIntent = markIntentStatus(resizeHedgeLegToFilledPrimary(currentIntent, completedNow), "primary_filled", completedNow);
    await writeOrderIntent(currentIntent);
  }
  await writeLiveTradeRunEvent(
    currentIntent,
    completedNow,
    currentIntent.status === "hedged" ? "hedged" : "primary_filled",
  );
  await writeRunEvent({
    level: "info",
    eventType: "order.primary.multi_clip_completed",
    message: `Primary Kalshi multi-clip completed for intent ${currentIntent.id}`,
    payload: {
      intentId: currentIntent.id,
      slotKey: currentIntent.slotKey,
      clipPlan,
      clipCount: clipPlan.length,
      totalFilledSize: currentIntent.legs.find((leg) => leg.id === primaryLeg.id)?.filledSize ?? 0,
      totalHedgedSize: currentIntent.legs.find((leg) => leg.venue === currentIntent.hedgeVenue)?.filledSize ?? 0,
      unhedgedPrimarySize,
    },
    createdAt: completedNow,
  });
  return {
    intent: currentIntent,
    outcome: unhedgedPrimarySize <= ORDER_SIZE_TOLERANCE ? "hedged" : "filled",
  };
}

async function skipIntentBeforeSubmission(
  intent: OrderIntent,
  now: number,
  failureReason: string,
  reason: string,
  payload: Record<string, unknown>,
) {
  const currentIntent = markIntentStatus(intent, "skipped", now, failureReason);
  await writeOrderIntent(currentIntent);
  await writeRunEvent({
    level: "info",
    eventType: "order.primary.preflight_skipped",
    message: `Intent ${currentIntent.id} skipped before submission (${reason})`,
    payload: {
      intentId: currentIntent.id,
      slotKey: currentIntent.slotKey,
      reason,
      ...payload,
    },
    createdAt: now,
  });
  await writeCircuitBreaker({
    key: buildSlotBreakerKey(currentIntent.slotKey),
    active: true,
    reason: "primary_no_fill",
    triggeredAt: now,
    payload: {
      intentId: currentIntent.id,
      slotKey: currentIntent.slotKey,
      stage: "preflight_skipped_cooldown",
      reason,
      cooldownUntil: now + PRIMARY_NO_FILL_COOLDOWN_MS,
    },
  });
  return currentIntent;
}

async function executeIncrementalHedgeLeg(
  intent: OrderIntent,
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
  clip: {
    clipIndex: number;
    clipCount: number;
    clipSize: number;
    retried: boolean;
  },
): Promise<{ intent: OrderIntent; outcome: "hedged" | "failed" | "awaiting_confirmation" }> {
  const resizedIntent = resizeHedgeLegToUnhedgedPrimary(intent, now);
  const primaryLeg = resizedIntent.legs.find((leg) => leg.venue === resizedIntent.primaryVenue);
  const hedgeLeg = resizedIntent.legs.find((leg) => leg.venue === resizedIntent.hedgeVenue);
  if (!primaryLeg || !hedgeLeg) {
    throw new Error(`Intent ${intent.id} missing legs for incremental hedge execution`);
  }

  const unhedgedPrimarySize = deriveUnhedgedPrimarySize(resizedIntent);
  if (unhedgedPrimarySize <= ORDER_SIZE_TOLERANCE) {
    const currentIntent = await markIntentHedgedAfterEconomicCheck(
      resizedIntent,
      now,
      "incremental_hedge_already_complete",
      null,
    );
    return {
      intent: currentIntent,
      outcome: currentIntent.status === "hedged" ? "hedged" : "failed",
    };
  }

  const hedgeMinimumSize = getVenueMinimumOrderSize(hedgeLeg.venue, null, settings.minOrderSize);
  if (hedgeLeg.requestedSize + ORDER_SIZE_TOLERANCE < hedgeMinimumSize) {
    await writeRunEvent({
      level: "warn",
      eventType: "order.hedge.incremental_below_minimum",
      message: `Incremental hedge size ${hedgeLeg.requestedSize} below ${hedgeLeg.venue} minimum ${hedgeMinimumSize}; entering recovery`,
      payload: {
        intentId: resizedIntent.id,
        hedgeVenue: hedgeLeg.venue,
        hedgeRequestedSize: hedgeLeg.requestedSize,
        hedgeMinimumSize,
        primaryVenue: primaryLeg.venue,
        primaryFilledSize: primaryLeg.filledSize,
        hedgeFilledSize: hedgeLeg.filledSize,
        unhedgedPrimarySize,
        clipIndex: clip.clipIndex,
        clipCount: clip.clipCount,
      },
      createdAt: now,
    });
    return {
      intent: await attemptPrimaryUnwindAfterHedgeFailure(
        resizedIntent,
        primaryLeg,
        hedgeLeg,
        null,
        settings,
        now,
        `Incremental hedge size ${hedgeLeg.requestedSize} below ${hedgeLeg.venue} minimum ${hedgeMinimumSize}`,
      ),
      outcome: "failed",
    };
  }

  let currentIntent = markIntentStatus(resizedIntent, "hedging", now);
  await writeOrderIntent(currentIntent);

  const hedgeMaxSlippageBps = await resolveAdaptiveSlippageForLiveLeg(hedgeLeg, slot, settings, now);
  const hedgeRequest = buildVenueOrderRequest(hedgeLeg, hedgeMaxSlippageBps, immediatePartialOrderType(hedgeLeg.venue), false);
  let hedgeResult: Awaited<ReturnType<VenueAdapter["placeOrder"]>>;
  let hedgeOrder: LiveOrder;
  try {
    const hedgeExecution = await submitAndConfirmOrder({
      intent: currentIntent,
      leg: hedgeLeg,
      request: hedgeRequest,
      stage: `incremental_hedge:${clip.clipIndex}`,
      now,
      timeoutMs: settings.immediateOrderConfirmationTimeoutMs,
    });
    hedgeResult = hedgeExecution.result;
    hedgeOrder = hedgeExecution.order;
    await writeRunEvent({
      level: "info",
      eventType: "order.hedge.incremental_submitted",
      message: `Incremental hedge ${currentIntent.hedgeVenue} order ${hedgeOrder.venueOrderId}`,
      payload: {
        intentId: currentIntent.id,
        venue: currentIntent.hedgeVenue,
        orderId: hedgeOrder.venueOrderId,
        requestedSize: hedgeRequest.size,
        computedMaxSlippageBps: hedgeMaxSlippageBps,
        unhedgedPrimarySize,
        clipIndex: clip.clipIndex,
        clipCount: clip.clipCount,
        primaryClipRetried: clip.retried,
      },
      createdAt: now,
    });
  } catch (error) {
    const recovered = await recoverKalshiOrderSubmissionForIntent(
      currentIntent,
      hedgeLeg,
      hedgeRequest,
      now,
      "hedge",
    );
    if (!recovered) {
      if (shouldFailClosedOnSubmissionError(hedgeLeg)) {
        return {
          intent: await markIntentManualRequired(
            currentIntent,
            Date.now(),
            "polymarket_incremental_hedge_submission_truth_unknown",
            `Polymarket incremental hedge may have reached the venue before the submission error (${toErrorMessage(error)})`,
            {
              clientOrderId: hedgeRequest.clientOrderId,
              error: toErrorMessage(error),
              unhedgedPrimarySize,
              clipIndex: clip.clipIndex,
              clipCount: clip.clipCount,
            },
          ),
          outcome: "awaiting_confirmation" as const,
        };
      }
      return failIncrementalHedge(
        currentIntent,
        null,
        settings,
        now,
        `Incremental hedge submission failed (${toErrorMessage(error)})`,
        "incremental_hedge_submit_failed",
        {
          venue: currentIntent.hedgeVenue,
          clientOrderId: hedgeRequest.clientOrderId,
          error: toErrorMessage(error),
          unhedgedPrimarySize,
          clipIndex: clip.clipIndex,
          clipCount: clip.clipCount,
        },
      );
    }

    hedgeResult = recovered.result;
    hedgeOrder = recovered.order;
  }

  if (shouldTreatHedgeOrderAsComplete(hedgeLeg, hedgeOrder)) {
    currentIntent = accumulateIntentLegOrder(currentIntent, hedgeLeg.id, hedgeOrder, "hedged", now);
    const remainingUnhedgedPrimarySize = deriveUnhedgedPrimarySize(currentIntent);
    if (remainingUnhedgedPrimarySize <= ORDER_SIZE_TOLERANCE) {
      currentIntent = await markIntentHedgedAfterEconomicCheck(currentIntent, now, "incremental_hedge_filled", hedgeOrder, {
        remainingUnhedgedPrimarySize,
        clipIndex: clip.clipIndex,
        clipCount: clip.clipCount,
      });
    } else {
      currentIntent = markIntentStatus(currentIntent, "primary_filled", now, null);
      await writeOrderIntent(currentIntent);
    }
    await writeRunEvent({
      level: "info",
      eventType: "order.hedge.incremental_filled",
      message: `Incremental hedge filled for intent ${currentIntent.id}`,
      payload: {
        intentId: currentIntent.id,
        venue: currentIntent.hedgeVenue,
        orderId: hedgeOrder.venueOrderId,
        hedgeFilledSize: hedgeOrder.filledSize,
        totalPrimaryFilledSize: currentIntent.legs.find((leg) => leg.venue === currentIntent.primaryVenue)?.filledSize ?? 0,
        totalHedgeFilledSize: currentIntent.legs.find((leg) => leg.venue === currentIntent.hedgeVenue)?.filledSize ?? 0,
        remainingUnhedgedPrimarySize,
        clipIndex: clip.clipIndex,
        clipCount: clip.clipCount,
      },
      createdAt: now,
    });
    return {
      intent: currentIntent,
      outcome: currentIntent.status === "hedged" ? "hedged" : "failed",
    };
  }

  if (hedgeOrder.filledSize > 0) {
    currentIntent = accumulateIntentLegOrder(currentIntent, hedgeLeg.id, hedgeOrder, "submitted", now);
    const overfilledHedgeSize = deriveOverfilledHedgeSize(currentIntent);
    if (overfilledHedgeSize > ORDER_SIZE_TOLERANCE) {
      const acceptedIntent = await acceptBenignOverfilledHedge(
        currentIntent,
        hedgeOrder,
        settings,
        now,
        "incremental_hedge_overfill_accepted",
        "order.hedge.incremental_overfill_accepted",
        `Accepted small incremental hedge overfill for intent ${currentIntent.id}`,
        {
          venue: currentIntent.hedgeVenue,
          orderId: hedgeOrder.venueOrderId,
          requestedSize: hedgeOrder.requestedSize,
          filledSize: hedgeOrder.filledSize,
          overfilledHedgeSize,
          orderStatus: hedgeResult.status,
          clipIndex: clip.clipIndex,
          clipCount: clip.clipCount,
        },
      );
      if (acceptedIntent) {
        return {
          intent: acceptedIntent,
          outcome: acceptedIntent.status === "hedged" ? "hedged" : "failed",
        };
      }

      return failOverfilledIncrementalHedge(
        currentIntent,
        hedgeOrder,
        settings,
        now,
        "incremental_hedge_overfilled",
        {
          venue: currentIntent.hedgeVenue,
          orderId: hedgeOrder.venueOrderId,
          requestedSize: hedgeOrder.requestedSize,
          filledSize: hedgeOrder.filledSize,
          overfilledHedgeSize,
          orderStatus: hedgeResult.status,
          clipIndex: clip.clipIndex,
          clipCount: clip.clipCount,
        },
      );
    }
    await writeOrderIntent(currentIntent);
    await writeRunEvent({
      level: "warn",
      eventType: "order.hedge.incremental_partial_fill_rescue",
      message: `Incremental hedge ${currentIntent.hedgeVenue} partially filled for intent ${currentIntent.id}; entering recovery`,
      payload: {
        intentId: currentIntent.id,
        venue: currentIntent.hedgeVenue,
        orderId: hedgeOrder.venueOrderId,
        requestedSize: hedgeOrder.requestedSize,
        filledSize: hedgeOrder.filledSize,
        orderStatus: hedgeResult.status,
        unhedgedPrimarySize: deriveUnhedgedPrimarySize(currentIntent),
        clipIndex: clip.clipIndex,
        clipCount: clip.clipCount,
      },
      createdAt: now,
    });
    return {
      intent: await attemptPrimaryUnwindAfterHedgeFailure(
        currentIntent,
        currentIntent.legs.find((leg) => leg.venue === currentIntent.primaryVenue)!,
        currentIntent.legs.find((leg) => leg.venue === currentIntent.hedgeVenue)!,
        hedgeOrder,
        settings,
        now,
        `Incremental hedge partially filled or not final (${hedgeResult.status})`,
        hedgeResult,
      ),
      outcome: "failed",
    };
  }

  if (isTerminalOrderStatus(hedgeResult.status)) {
    if (!shouldRetryTerminalZeroFillHedge(currentIntent, hedgeLeg, hedgeResult)) {
      currentIntent = await holdPolymarketHedgeFailurePendingTruth(
        currentIntent,
        hedgeLeg,
        hedgeOrder,
        now,
        "incremental_hedge_no_fill_truth_pending",
        {
          orderStatus: hedgeResult.status,
          clipIndex: clip.clipIndex,
          clipCount: clip.clipCount,
        },
      );
      return {
        intent: currentIntent,
        outcome: "awaiting_confirmation",
      };
    }

    const retried = await retryLegWithinExecutionBufferWithAttempts(
      currentIntent,
      hedgeLeg,
      slot,
      settings,
      now,
      "hedge",
      settings.hedgeRetryAttempts,
      settings.hedgeRetryDelayMs,
    );
    if (retried) {
      currentIntent = retried.intent;
      hedgeResult = retried.result;
      hedgeOrder = retried.order;

      if (shouldTreatHedgeOrderAsComplete(hedgeLeg, hedgeOrder)) {
        const retryNow = Date.now();
        currentIntent = accumulateIntentLegOrder(currentIntent, hedgeLeg.id, hedgeOrder, "hedged", retryNow);
        const remainingUnhedgedPrimarySize = deriveUnhedgedPrimarySize(currentIntent);
        currentIntent = markIntentStatus(
          currentIntent,
          remainingUnhedgedPrimarySize <= ORDER_SIZE_TOLERANCE ? "hedged" : "primary_filled",
          retryNow,
          null,
        );
        await writeOrderIntent(currentIntent);
        await writeRunEvent({
          level: "info",
          eventType: "order.hedge.incremental_filled",
          message: `Incremental hedge filled after retry for intent ${currentIntent.id}`,
          payload: {
            intentId: currentIntent.id,
            venue: currentIntent.hedgeVenue,
            orderId: hedgeOrder.venueOrderId,
            hedgeFilledSize: hedgeOrder.filledSize,
            totalPrimaryFilledSize: currentIntent.legs.find((leg) => leg.venue === currentIntent.primaryVenue)?.filledSize ?? 0,
            totalHedgeFilledSize: currentIntent.legs.find((leg) => leg.venue === currentIntent.hedgeVenue)?.filledSize ?? 0,
            remainingUnhedgedPrimarySize,
            clipIndex: clip.clipIndex,
            clipCount: clip.clipCount,
            retried: true,
          },
          createdAt: retryNow,
        });
        return {
          intent: currentIntent,
          outcome: "hedged",
        };
      }

      if (hedgeOrder.filledSize > 0) {
        const retryNow = Date.now();
        currentIntent = accumulateIntentLegOrder(currentIntent, hedgeLeg.id, hedgeOrder, "submitted", retryNow);
        const overfilledHedgeSize = deriveOverfilledHedgeSize(currentIntent);
        if (overfilledHedgeSize > ORDER_SIZE_TOLERANCE) {
          const acceptedIntent = await acceptBenignOverfilledHedge(
            currentIntent,
            hedgeOrder,
            settings,
            retryNow,
            "incremental_hedge_retry_overfill_accepted",
            "order.hedge.incremental_retry_overfill_accepted",
            `Accepted small incremental hedge retry overfill for intent ${currentIntent.id}`,
            {
              venue: currentIntent.hedgeVenue,
              orderId: hedgeOrder.venueOrderId,
              requestedSize: hedgeOrder.requestedSize,
              filledSize: hedgeOrder.filledSize,
              overfilledHedgeSize,
              orderStatus: hedgeResult.status,
              clipIndex: clip.clipIndex,
              clipCount: clip.clipCount,
            },
          );
          if (acceptedIntent) {
            return {
              intent: acceptedIntent,
              outcome: acceptedIntent.status === "hedged" ? "hedged" : "failed",
            };
          }

          return failOverfilledIncrementalHedge(
            currentIntent,
            hedgeOrder,
            settings,
            retryNow,
            "incremental_hedge_retry_overfilled",
            {
              venue: currentIntent.hedgeVenue,
              orderId: hedgeOrder.venueOrderId,
              requestedSize: hedgeOrder.requestedSize,
              filledSize: hedgeOrder.filledSize,
              overfilledHedgeSize,
              orderStatus: hedgeResult.status,
              clipIndex: clip.clipIndex,
              clipCount: clip.clipCount,
            },
          );
        }
        await writeOrderIntent(currentIntent);
        await writeRunEvent({
          level: "warn",
          eventType: "order.hedge.incremental_retry_partial_fill_rescue",
          message: `Incremental hedge retry ${currentIntent.hedgeVenue} partially filled for intent ${currentIntent.id}; entering recovery`,
          payload: {
            intentId: currentIntent.id,
            venue: currentIntent.hedgeVenue,
            orderId: hedgeOrder.venueOrderId,
            requestedSize: hedgeOrder.requestedSize,
            filledSize: hedgeOrder.filledSize,
            orderStatus: hedgeResult.status,
            unhedgedPrimarySize: deriveUnhedgedPrimarySize(currentIntent),
            clipIndex: clip.clipIndex,
            clipCount: clip.clipCount,
          },
          createdAt: retryNow,
        });
        return {
          intent: await attemptPrimaryUnwindAfterHedgeFailure(
            currentIntent,
            currentIntent.legs.find((leg) => leg.venue === currentIntent.primaryVenue)!,
            currentIntent.legs.find((leg) => leg.venue === currentIntent.hedgeVenue)!,
            hedgeOrder,
            settings,
            retryNow,
            `Incremental hedge retry partially filled or not final (${hedgeResult.status})`,
            hedgeResult,
          ),
          outcome: "failed",
        };
      }
    }
  }

  if (!isTerminalOrderStatus(hedgeResult.status)) {
    currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "submitted", now);
    await writeOrderIntent(currentIntent);
    await writeRunEvent({
      level: "info",
      eventType: "order.hedge.incremental_awaiting_confirmation",
      message: `Incremental hedge ${currentIntent.hedgeVenue} order ${hedgeOrder.venueOrderId} awaiting authoritative confirmation`,
      payload: {
        intentId: currentIntent.id,
        venue: currentIntent.hedgeVenue,
        orderId: hedgeOrder.venueOrderId,
        orderStatus: hedgeResult.status,
        unhedgedPrimarySize,
        clipIndex: clip.clipIndex,
        clipCount: clip.clipCount,
      },
      createdAt: now,
    });
    return {
      intent: currentIntent,
      outcome: "awaiting_confirmation",
    };
  }

  await writeRunEvent({
    level: shouldTripBreakerForTerminalNoFill(hedgeResult) ? "error" : "warn",
    eventType: "order.hedge.incremental_no_fill",
    message: `Incremental hedge ${currentIntent.hedgeVenue} order ended without fill for intent ${currentIntent.id}`,
    payload: {
      intentId: currentIntent.id,
      venue: currentIntent.hedgeVenue,
      orderId: hedgeOrder.venueOrderId,
      orderStatus: hedgeResult.status,
      detail: extractTerminalNoFillDetail(hedgeResult),
      softNoFill: Boolean(hedgeResult.raw?.softNoFill),
      unhedgedPrimarySize,
      clipIndex: clip.clipIndex,
      clipCount: clip.clipCount,
    },
    createdAt: now,
  });

  return failIncrementalHedge(
    currentIntent,
    hedgeOrder,
    settings,
    now,
    describeTerminalNoFill("Incremental hedge", hedgeResult),
    "incremental_hedge_no_fill",
    {
      hedgeVenue: hedgeLeg.venue,
      orderId: hedgeOrder.venueOrderId,
      orderStatus: hedgeResult.status,
      unhedgedPrimarySize,
      clipIndex: clip.clipIndex,
      clipCount: clip.clipCount,
    },
    hedgeResult,
  );
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
  now = Date.now(),
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

  return !isAgedPolymarketSoftNoFillSafeToRecover(intent, result, now);
}

export function shouldHoldHedgeRescueOrderPendingTruth(
  intent: Pick<OrderIntent, "hedgeVenue" | "status" | "updatedAt">,
  hedgeLeg: Pick<OrderIntent["legs"][number], "venue" | "side">,
  result: Pick<LiveOrder, "filledSize" | "raw" | "status" | "venueOrderId">,
  now = Date.now(),
) {
  return (
    result.filledSize <= ORDER_SIZE_TOLERANCE &&
    (
      !isTerminalOrderStatus(result.status) ||
      shouldHoldPolymarketHedgeFailurePendingTruth(
        intent,
        hedgeLeg,
        result,
        now,
      )
    )
  );
}

export function shouldFailClosedOnSubmissionError(
  leg: Pick<OrderIntent["legs"][number], "venue">,
) {
  // A lost Polymarket HTTP response cannot prove zero exposure because the
  // signed client id is not available through the venue recovery APIs.
  return leg.venue === "polymarket";
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

function isAgedPolymarketSoftNoFillSafeToRecover(
  intent: Pick<OrderIntent, "status" | "updatedAt">,
  result: Pick<LiveOrder, "filledSize" | "raw" | "status" | "venueOrderId">,
  now: number,
) {
  if (intent.status !== "truth_pending") {
    return false;
  }

  if (now - intent.updatedAt < HEDGE_FAILURE_UNWIND_PENDING_COOLDOWN_MS) {
    return false;
  }

  if (result.filledSize > ORDER_SIZE_TOLERANCE || !isTerminalOrderStatus(result.status)) {
    return false;
  }

  return Boolean(result.raw?.softNoFill || result.venueOrderId.startsWith("killed:"));
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
  const breakerKey = buildSlotBreakerKey(intent.slotKey);
  const existingBreaker = (await readCircuitBreakers()).find((breaker) => breaker.key === breakerKey) ?? null;
  const alreadyPendingSameOrder =
    intent.status === "truth_pending" &&
    intent.failureReason === pendingTruthReason &&
    (hedgeOrder === null || hedgeLeg.venueOrderId === hedgeOrder.venueOrderId);
  const existingPendingTruthBreaker =
    existingBreaker?.active === true &&
    existingBreaker.reason === "hedge_failure" &&
    existingBreaker.payload?.intentId === intent.id &&
    existingBreaker.payload?.stage === "polymarket_hedge_no_fill_truth_pending";

  let currentIntent = intent;
  if (!alreadyPendingSameOrder) {
    currentIntent = hedgeOrder ? updateIntentLeg(intent, hedgeLeg.venue, hedgeOrder, "submitted", now) : intent;
    currentIntent = markIntentStatus(
      currentIntent,
      "truth_pending",
      now,
      pendingTruthReason,
    );
    await writeOrderIntent(currentIntent);
  }

  if (!alreadyPendingSameOrder || !existingPendingTruthBreaker) {
    await writeHedgeRetryBlockedPendingTruthEvent(currentIntent, hedgeLeg, hedgeOrder, now, {
      stage,
      ...payload,
    });
    await writeIntentIncidentRunEvent(
      currentIntent,
      now,
      "truth_pending",
      pendingTruthReason,
      {
        hedgeOrderId: hedgeOrder?.venueOrderId ?? null,
        ...payload,
      },
    );
  }

  if (!existingPendingTruthBreaker) {
    await writeCircuitBreaker({
      key: breakerKey,
      active: true,
      reason: "hedge_failure",
      triggeredAt: now,
      payload: {
        intentId: currentIntent.id,
        slotKey: currentIntent.slotKey,
        venue: currentIntent.hedgeVenue,
        stage: "polymarket_hedge_no_fill_truth_pending",
        hedgeOrderId: hedgeOrder?.venueOrderId ?? null,
        cooldownUntil: now + HEDGE_FAILURE_UNWIND_PENDING_COOLDOWN_MS,
        ...payload,
      },
    });
  }
  return currentIntent;
}

async function failOverfilledIncrementalHedge(
  intent: OrderIntent,
  hedgeOrder: LiveOrder,
  settings: StrategyConfig,
  now: number,
  stage: string,
  payload: Record<string, unknown>,
): Promise<{ intent: OrderIntent; outcome: "failed" }> {
  const overfilledHedgeSize = deriveOverfilledHedgeSize(intent);
  const failureReason = `Incremental hedge overfilled by ${overfilledHedgeSize.toFixed(6)}; manual intervention required`;
  const currentIntent = markIntentStatus(intent, "manual_required", now, failureReason);
  await writeOrderIntent(currentIntent);
  await writeManualInterventionRunEvent(currentIntent, now, stage, {
    ...payload,
    hedgeOrderId: hedgeOrder.venueOrderId,
    overfilledHedgeSize,
  });
  await writeCircuitBreaker({
    key: buildSlotBreakerKey(currentIntent.slotKey),
    active: true,
    reason: "hedge_failure",
    triggeredAt: now,
    payload: {
      intentId: currentIntent.id,
      slotKey: currentIntent.slotKey,
      stage,
      requiresManualClear: true,
      overfilledHedgeSize,
      maxSlippageBps: settings.maxSlippageBps,
      ...payload,
    },
  });
  return {
    intent: currentIntent,
    outcome: "failed",
  };
}

async function failIncrementalHedge(
  intent: OrderIntent,
  hedgeOrder: LiveOrder | null,
  settings: StrategyConfig,
  now: number,
  failureReason: string,
  stage: string,
  payload: Record<string, unknown>,
  hedgeResult?: Awaited<ReturnType<VenueAdapter["placeOrder"]>>,
): Promise<{ intent: OrderIntent; outcome: "failed" | "awaiting_confirmation" }> {
  const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  if (primaryLeg && hedgeLeg) {
    if (shouldHoldPolymarketHedgeFailurePendingTruth(intent, hedgeLeg, hedgeOrder ?? hedgeResult ?? null, now)) {
      return {
        intent: await holdPolymarketHedgeFailurePendingTruth(intent, hedgeLeg, hedgeOrder, now, stage, {
          ...payload,
          orderStatus: hedgeOrder?.status ?? hedgeResult?.status ?? null,
          hedgeOrderId: hedgeOrder?.venueOrderId ?? hedgeResult?.venueOrderId ?? null,
        }),
        outcome: "awaiting_confirmation",
      };
    }

    return {
      intent: await attemptPrimaryUnwindAfterHedgeFailure(
        intent,
        primaryLeg,
        hedgeLeg,
        hedgeOrder,
        settings,
        now,
        failureReason,
        hedgeResult,
      ),
      outcome: "failed",
    };
  }

  let currentIntent = hedgeOrder ? updateIntentLeg(intent, intent.hedgeVenue, hedgeOrder, "failed", now) : intent;
  currentIntent = markIntentStatus(currentIntent, "failed", now, failureReason);
  await writeOrderIntent(currentIntent);
  await writeManualInterventionRunEvent(currentIntent, now, stage, payload);
  await writeCircuitBreaker({
    key: buildSlotBreakerKey(currentIntent.slotKey),
    active: true,
    reason: "hedge_failure",
    triggeredAt: now,
    payload: {
      intentId: currentIntent.id,
      slotKey: currentIntent.slotKey,
      stage,
      requiresManualClear: true,
      ...payload,
    },
  });

  return {
    intent: currentIntent,
    outcome: "failed",
  };
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

  const hedgeMaxSlippageBps = await resolveAdaptiveSlippageForLiveLeg(hedgeLeg, slot, settings, now);
  const hedgeRequest = buildVenueOrderRequest(hedgeLeg, hedgeMaxSlippageBps, immediatePartialOrderType(hedgeLeg.venue), false);
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
    });
    hedgeResult = hedgeExecution.result;
    hedgeOrder = hedgeExecution.order;
    hedgeExecutionTiming = "timing" in hedgeExecution ? hedgeExecution.timing : null;
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
  } catch (error) {
    const recovered = await recoverKalshiOrderSubmissionForIntent(
      currentIntent,
      hedgeLeg,
      hedgeRequest,
      now,
      "hedge",
    );
    if (!recovered) {
      if (shouldFailClosedOnSubmissionError(hedgeLeg)) {
        return markIntentManualRequired(
          currentIntent,
          Date.now(),
          "polymarket_hedge_submission_truth_unknown",
          `Polymarket hedge may have reached the venue before the submission error (${toErrorMessage(error)})`,
          {
            clientOrderId: hedgeRequest.clientOrderId,
            error: toErrorMessage(error),
          },
        );
      }
      await writeRunEvent({
        level: "error",
        eventType: "order.hedge.submit_failed",
        message: `Hedge ${currentIntent.hedgeVenue} submission failed for intent ${currentIntent.id}`,
        payload: {
          intentId: currentIntent.id,
          venue: currentIntent.hedgeVenue,
          clientOrderId: hedgeRequest.clientOrderId,
          error: toErrorMessage(error),
        },
        createdAt: now,
      });
      return attemptPrimaryUnwindAfterHedgeFailure(
        currentIntent,
        primaryLeg,
        hedgeLeg,
        null,
        settings,
        now,
        `Hedge submission failed (${toErrorMessage(error)})`,
      );
    }

    hedgeResult = recovered.result;
    hedgeOrder = recovered.order;
  }

  if (shouldTreatHedgeOrderAsComplete(hedgeLeg, hedgeOrder)) {
    if (currentIntent.hedgeVenue === "polymarket") {
      currentIntent = await attachRecentPolymarketFillsSafely(currentIntent, "hedge", now);
    }
    currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "hedged", now);
    currentIntent = await markIntentHedgedAfterEconomicCheck(currentIntent, now, "hedge_filled", hedgeOrder, {
      executionTiming: buildPairExecutionTiming(primaryExecutionTiming, hedgeExecutionTiming),
    });
    if (currentIntent.status === "hedged") {
      await writeLiveTradeRunEvent(currentIntent, now, "hedged");
    }
    return currentIntent;
  }

  if (hedgeOrder.filledSize > 0) {
    currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "submitted", now);
    await writeOrderIntent(currentIntent);
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
    return attemptPrimaryUnwindAfterHedgeFailure(
      currentIntent,
      primaryLeg,
      hedgeLeg,
      hedgeOrder,
      settings,
      now,
      `Hedge order partially filled or not final (${hedgeResult.status})`,
      hedgeResult,
    );
  }

  if (isTerminalOrderStatus(hedgeResult.status)) {
    if (!shouldRetryTerminalZeroFillHedge(currentIntent, hedgeLeg, hedgeResult)) {
      return holdPolymarketHedgeFailurePendingTruth(currentIntent, hedgeLeg, hedgeOrder, now, "hedge_no_fill_truth_pending", {
        orderStatus: hedgeResult.status,
      });
    }

    const retried = await retryLegWithinExecutionBufferWithAttempts(
      currentIntent,
      hedgeLeg,
      slot,
      settings,
      now,
      "hedge",
      settings.hedgeRetryAttempts,
      settings.hedgeRetryDelayMs,
    );
    if (retried) {
      currentIntent = retried.intent;
      hedgeResult = retried.result;
      hedgeOrder = retried.order;

      if (shouldTreatHedgeOrderAsComplete(hedgeLeg, hedgeOrder)) {
        if (currentIntent.hedgeVenue === "polymarket") {
          currentIntent = await attachRecentPolymarketFillsSafely(currentIntent, "hedge", now);
        }
        currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "hedged", now);
        currentIntent = await markIntentHedgedAfterEconomicCheck(currentIntent, now, "hedge_retry_filled", hedgeOrder);
        if (currentIntent.status === "hedged") {
          await writeLiveTradeRunEvent(currentIntent, now, "hedged");
        }
        return currentIntent;
      }

      if (hedgeOrder.filledSize > 0) {
        currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "submitted", now);
        await writeOrderIntent(currentIntent);
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
        return attemptPrimaryUnwindAfterHedgeFailure(
          currentIntent,
          primaryLeg,
          hedgeLeg,
          hedgeOrder,
          settings,
          now,
          `Hedge retry partially filled or not final (${hedgeResult.status})`,
          hedgeResult,
        );
      }
    }
  }

  if (!isTerminalOrderStatus(hedgeResult.status)) {
    currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "submitted", now);
    await writeOrderIntent(currentIntent);
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

async function executeShadowIntent(
  intent: OrderIntent,
  snapshot: OpportunitySnapshot,
  settings: StrategyConfig,
  now: number,
) {
  const restStartedAt = now;
  let currentIntent = markIntentStatus(
    {
      ...intent,
      shadowExecution: buildScheduledShadowAudit(intent, restStartedAt),
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
  await writeOrderIntent(currentIntent);
  await writeRunEvent({
    asset: currentIntent.asset,
    level: "info",
    eventType: "intent.shadow.scheduled",
    message: `Shadow intent ${currentIntent.id} started immediate REST orderbook execution`,
    payload: {
      intentId: currentIntent.id,
      slotKey: currentIntent.slotKey,
      primaryVenue: currentIntent.primaryVenue,
      modelVersion: SHADOW_EXECUTION_MODEL_VERSION,
      restStartedAt,
      requestedPairSize: currentIntent.shadowExecution?.requestedPairSize ?? null,
    },
    createdAt: now,
  });

  return completeShadowIntent(currentIntent, snapshot, settings, restStartedAt);
}

async function resumeShadowIntents(
  intents: OrderIntent[],
  snapshot: OpportunitySnapshot,
  settings: StrategyConfig,
) {
  const resumed: OrderIntent[] = [];
  for (const intent of intents) {
    if (!intent.shadow || intent.status !== "executing_primary") {
      continue;
    }

    const restStartedAt = Date.now();
    const currentIntent = {
      ...intent,
      shadowExecution: buildScheduledShadowAudit(intent, restStartedAt),
    };
    await writeOrderIntent(currentIntent);
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
  const restCapture = await captureShadowRestSnapshot(intent, signalSnapshot, restStartedAt);
  const rawDecision = deriveShadowPairExecution({
    intent,
    snapshot: restCapture.snapshot,
    settings,
  });
  const decision: ShadowPairExecutionDecision = restCapture.errors.length === 0
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
  const scheduledAudit = intent.shadowExecution ?? buildScheduledShadowAudit(intent, restStartedAt);
  const capturedIntent: OrderIntent = {
    ...intent,
    shadowExecution: {
      ...scheduledAudit,
      restStartedAt,
      restCapturedAt: restCapture.capturedAt,
      restFetchDurationMs: Math.max(0, restCapture.capturedAt - restStartedAt),
      restErrors: restCapture.errors,
    },
  };
  await writeOrderIntent(capturedIntent);
  await writeRunEvent({
    asset: intent.asset,
    level: "info",
    eventType: "intent.shadow.rest_captured",
    message: `Shadow intent ${intent.id} captured execution books through REST`,
    payload: {
      intentId: intent.id,
      slotKey: intent.slotKey,
      modelVersion: SHADOW_EXECUTION_MODEL_VERSION,
      restFetchDurationMs: capturedIntent.shadowExecution?.restFetchDurationMs ?? null,
      completionNotBeforeAt: capturedIntent.shadowExecution?.completionNotBeforeAt ?? null,
      preparedDecision: decision.status,
      restErrors: restCapture.errors,
    },
    createdAt: restCapture.capturedAt,
  });
  if (decision.status === "filled") {
    const remainingCompletionDelayMs = Math.max(
      0,
      scheduledAudit.completionNotBeforeAt - Date.now(),
    );
    if (remainingCompletionDelayMs > 0) {
      await sleep(remainingCompletionDelayMs);
    }
  }
  const evaluatedAt = Date.now();
  const completedAudit = buildCompletedShadowAudit(intent, decision, evaluatedAt, {
    startedAt: restStartedAt,
    capturedAt: restCapture.capturedAt,
    errors: restCapture.errors,
  });
  const completedOrders = intent.legs.map((leg) =>
    buildCompletedShadowOrder(intent, leg, decision, completedAudit, evaluatedAt),
  ) as [LiveOrder, LiveOrder];
  await Promise.all(completedOrders.map((order) => writeVenueOrder(order)));

  let currentIntent: OrderIntent = { ...intent, shadowExecution: completedAudit };
  if (decision.status === "no_fill") {
    for (const order of completedOrders) {
      currentIntent = updateIntentLeg(currentIntent, order.venue, order, "failed", evaluatedAt);
    }
    currentIntent = markIntentStatus(
      currentIntent,
      "skipped",
      evaluatedAt,
      `Shadow non exécuté: ${decision.reason ?? decision.reasonCode ?? "liquidité indisponible"}`,
    );
    await writeOrderIntent(currentIntent);
    await writeRunEvent({
      asset: currentIntent.asset,
      level: "info",
      eventType: "intent.shadow.no_fill",
      message: `Shadow intent ${currentIntent.id} produced no executable pair from REST books`,
      payload: {
        intentId: currentIntent.id,
        slotKey: currentIntent.slotKey,
        modelVersion: SHADOW_EXECUTION_MODEL_VERSION,
        latencyMs: completedAudit.latencyMs,
        restFetchDurationMs: completedAudit.restFetchDurationMs,
        nextEligibleAt: completedAudit.nextEligibleAt,
        reasonCode: decision.reasonCode,
        reason: decision.reason,
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
    const capacity = decision.legs.find((candidate) => candidate.leg.venue === order.venue);
    if (!capacity?.quote) {
      throw new Error(`Intent ${intent.id} missing ${order.venue} shadow fill quote`);
    }
    await writeFill(
      buildShadowFill(currentIntent, leg, order, capacity.quote, completedAudit, evaluatedAt),
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
  await writeOrderIntent(currentIntent);
  await writeRunEvent({
    asset: currentIntent.asset,
    level: "info",
    eventType: "intent.shadow.filled",
    message: `Shadow intent ${currentIntent.id} filled from immediate REST orderbook depth`,
    payload: {
      intentId: currentIntent.id,
      slotKey: currentIntent.slotKey,
      modelVersion: SHADOW_EXECUTION_MODEL_VERSION,
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
) {
  const polymarketLeg = intent.legs.find((leg) => leg.venue === "polymarket");
  const kalshiLeg = intent.legs.find((leg) => leg.venue === "kalshi");
  const [polymarketResult, kalshiResult] = await Promise.allSettled([
    polymarketLeg?.tokenId
      ? fetchPolymarketBook(polymarketLeg.tokenId)
      : Promise.reject(new Error("référence de marché absente")),
    kalshiLeg?.marketRef
      ? fetchKalshiOrderbook(kalshiLeg.marketRef)
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
  const polymarketAsks = polymarketResult.status === "fulfilled"
    ? polymarketResult.value.asks
        .map((level) => [Number(level.price), Number(level.size)] as [number, number])
        .filter(([price, size]) => Number.isFinite(price) && Number.isFinite(size) && size > 0)
    : [];
  if (polymarketResult.status === "rejected") {
    errors.push(`Polymarket REST: ${toErrorMessage(polymarketResult.reason)}`);
  }
  const polymarketLevels = {
    ...previousPolymarketLevels,
    ...(polymarketLeg?.outcome === "UP"
      ? { upAsks: polymarketAsks }
      : { downAsks: polymarketAsks }),
  };

  const kalshiLevels = kalshiResult.status === "fulfilled"
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
          feedStatus: polymarketResult.status === "fulfilled" ? "ready" as const : "degraded" as const,
          source: "rest-fallback" as const,
          lastMessageAt: capturedAt,
          stalenessMs: 0,
          details: polymarketResult.status === "fulfilled"
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
          feedStatus: kalshiResult.status === "fulfilled" ? "ready" as const : "degraded" as const,
          source: "rest-fallback" as const,
          lastMessageAt: capturedAt,
          stalenessMs: 0,
          details: kalshiResult.status === "fulfilled"
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
      await writePolymarketFillSafely(trade, intent.id, orderId, "intent_sync");
    }
  }

  intent = (await syncIntentFromStoredVenueFills(intent.id, "polymarket", intent)) ?? intent;
  await writeOrderIntent(intent);
  return intent;
}

async function attachRecentPolymarketFillsSafely(
  intent: OrderIntent,
  stage: "primary" | "hedge",
  now: number,
) {
  try {
    return await attachRecentPolymarketFills(intent);
  } catch (error) {
    await writeRunEvent({
      level: "warn",
      eventType: "fills.polymarket.sync_failed",
      message: `Polymarket fill sync failed during ${stage} for intent ${intent.id}`,
      payload: {
        intentId: intent.id,
        stage,
        error: toErrorMessage(error),
      },
      createdAt: now,
    });
    return intent;
  }
}

async function resumeInFlightIntents(intents: OrderIntent[], slot: MarketSlot, settings: StrategyConfig, now: number) {
  const recentOrders = await readRecentVenueOrders(200, slot.asset);
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

    let currentIntent = intent;
    const intentOrders = recentOrders.filter((order) => order.intentId === intent.id);
    const primaryOrderSummary = summarizeIntentLegOrders(intentOrders, primaryLeg, "entry");
    if (
      primaryOrderSummary &&
      isPrimaryFillSizeHedgable(intent, {
        filledSize: primaryOrderSummary.filledSize,
        requestedSize: primaryLeg.requestedSize,
      })
    ) {
      currentIntent = updateIntentLegFromFillSummary(currentIntent, primaryLeg.id, primaryOrderSummary, now);
      currentIntent = markIntentStatus(currentIntent, "primary_filled", now);
      await writeOrderIntent(currentIntent);
      await writeLiveTradeRunEvent(currentIntent, now);

      const latestHedgeOrder = findLatestIntentOrderForLeg(intentOrders, intent.id, hedgeLeg);
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

      resumed.push(await executeHedgeLeg(currentIntent, slot, settings, now));
      continue;
    }

    const primaryOrder = findLatestIntentOrderForLeg(recentOrders, intent.id, primaryLeg);
    if (!primaryOrder || !shouldTreatPrimaryOrderAsFilled(intent, primaryOrder)) {
      continue;
    }

    currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "filled", now);
    currentIntent = markIntentStatus(currentIntent, "primary_filled", now);
    await writeOrderIntent(currentIntent);
    await writeLiveTradeRunEvent(currentIntent, now);

    if (currentIntent.primaryVenue === "polymarket") {
      currentIntent = await attachRecentPolymarketFillsSafely(currentIntent, "primary", now);
    }

    const latestHedgeOrder = findLatestIntentOrderForLeg(recentOrders, intent.id, hedgeLeg);
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

    resumed.push(await executeHedgeLeg(currentIntent, slot, settings, now));
  }

  return resumed;
}

async function resolvePrimaryExitSize(
  intent: OrderIntent,
  primaryLeg: OrderIntent["legs"][number],
  now: number,
) {
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
    const outcome = primaryLeg.outcome === "UP" ? polymarketState.quote.outcomes.up : polymarketState.quote.outcomes.down;
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
    unhedgedPrimarySize > ORDER_SIZE_TOLERANCE
      ? Math.min(requestedSize, unhedgedPrimarySize)
      : requestedSize;
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

  const liveExitPrice = await resolvePrimaryExitPrice(intent, primaryLeg, now).catch(() => null);
  const fallbackExitPrice =
    primaryLeg.filledPrice === null ? primaryLeg.requestedPrice : primaryLeg.filledPrice * 0.99;
  const requestedPrice = liveExitPrice ?? fallbackExitPrice;
  const forcedPrice = force
    ? deriveForcedUnwindOrderPrice(primaryLeg, requestedPrice, settings.maxSlippageBps, force.ticks)
    : null;
  const expectedExitPrice = forcedPrice ?? applySlippage(requestedPrice ?? 0, settings.maxSlippageBps, "SELL");
  const expectedLossUsd = estimatePrimaryUnwindLossUsd(primaryLeg, effectiveRequestedSize, expectedExitPrice);
  await writeRunEvent({
    asset: intent.asset,
    level: expectedLossUsd !== null && expectedLossUsd > 0 ? "warn" : "info",
    eventType: "order.unwind.economic_check",
    message: `Primary unwind economic check for intent ${intent.id}`,
    payload: {
      intentId: intent.id,
      venue: primaryLeg.venue,
      requestedSize: effectiveRequestedSize,
      unhedgedPrimarySize,
      entryPrice: primaryLeg.filledPrice,
      referenceExitPrice: requestedPrice,
      expectedExitPrice,
      forcedAttempt: force?.attempt ?? null,
      forcedTicks: force?.ticks ?? null,
      expectedLossUsd,
      maxLossUsd: settings.forcedUnwindMaxLossUsd,
    },
    createdAt: now,
  });
  if (
    force &&
    shouldBlockForcedUnwindLoss(primaryLeg, effectiveRequestedSize, expectedExitPrice, settings.forcedUnwindMaxLossUsd)
  ) {
    throw new Error(
      `Forced unwind blocked by max loss: expected exit ${expectedExitPrice.toFixed(4)} exceeds configured loss cap`,
    );
  }

  const request = buildVenueOrderRequest(
    {
      ...primaryLeg,
      requestedPrice,
      side: "SELL",
      requestedSize: effectiveRequestedSize,
      requestedNotionalUsd: effectiveRequestedSize * (requestedPrice ?? primaryLeg.filledPrice ?? primaryLeg.requestedPrice ?? 0),
    },
    settings.maxSlippageBps,
    primaryLeg.venue === "polymarket" ? "FAK" : "IOC",
    true,
    forcedPrice !== null ? { overridePrice: forcedPrice } : undefined,
  );
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
        referencePrice: requestedPrice,
        orderPrice: request.price,
        maxLossUsd: settings.forcedUnwindMaxLossUsd,
      },
      createdAt: now,
    });
  }
  const unwindExecution = await submitAndConfirmOrder({
    intent,
    leg: { ...primaryLeg, side: "SELL" },
    request,
    stage: force ? "primary_unwind_forced" : "primary_unwind",
    now,
    timeoutMs: settings.immediateOrderConfirmationTimeoutMs,
  });
  return unwindExecution.order;
}

function deriveForcedUnwindOrderPrice(
  primaryLeg: OrderIntent["legs"][number],
  referencePrice: number | null,
  maxSlippageBps: number,
  ticks: number,
) {
  if (referencePrice === null || !Number.isFinite(referencePrice) || referencePrice <= 0) {
    return null;
  }

  if (primaryLeg.venue === "kalshi") {
    return normalizeKalshiOrderPrice(
      Math.max(KALSHI_ORDER_PRICE_STEP_USD, referencePrice - ticks * KALSHI_ORDER_PRICE_STEP_USD),
      "SELL",
    );
  }

  return round4(Math.max(0.001, applySlippage(referencePrice, maxSlippageBps + ticks * 100, "SELL")));
}

export function estimatePrimaryUnwindLossUsd(
  primaryLeg: OrderIntent["legs"][number],
  requestedSize: number,
  expectedExitPrice: number | null,
) {
  if (
    expectedExitPrice === null ||
    primaryLeg.filledPrice === null ||
    requestedSize <= 0
  ) {
    return null;
  }

  return round4(requestedSize * Math.max(0, primaryLeg.filledPrice - expectedExitPrice));
}

function shouldBlockForcedUnwindLoss(
  primaryLeg: OrderIntent["legs"][number],
  requestedSize: number,
  expectedExitPrice: number | null,
  maxLossUsd: number,
) {
  if (maxLossUsd <= 0) {
    return false;
  }

  const expectedLossUsd = estimatePrimaryUnwindLossUsd(primaryLeg, requestedSize, expectedExitPrice);
  if (expectedLossUsd === null) {
    return false;
  }

  return expectedLossUsd > maxLossUsd + ORDER_SIZE_TOLERANCE;
}

async function retryLegWithinExecutionBuffer(
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
  stage: "primary" | "hedge",
  retryAttempt = 1,
  options?: {
    pairSizeCap?: number | null;
    persistRepricedIntent?: boolean;
  },
) {
  if (settings.executionPriceBuffer <= 0) {
    return null;
  }

  const repriced = await repriceRetryLegWithinExecutionBuffer(
    intent,
    leg,
    slot,
    settings,
    now,
    stage,
    retryAttempt,
    options?.pairSizeCap,
  );
  if (!repriced) {
    return null;
  }
  let repricedIntent = repriced.intent;
  let repricedLeg = repriced.leg;
  if (stage === "primary") {
    const riskCheckAt = Date.now();
    const [retryOpenIntents, retryPositions] = await Promise.all([
      readOpenOrderIntents(),
      readPositions(),
    ]);
    const riskCheck = await recheckMismatchRiskForExecution({
      opportunity: buildRiskOpportunityTemplateFromIntent(repricedIntent, settings),
      intent: repricedIntent,
      slot,
      settings,
      openIntents: retryOpenIntents,
      venueExposureUsd: calculateVenueExposureUsd(
        retryPositions,
        retryOpenIntents.filter((candidate) => candidate.id !== repricedIntent.id),
      ),
      now: riskCheckAt,
    });
    if (!riskCheck.allowed) {
      await writeRunEvent({
        asset: intent.asset,
        level: "warn",
        eventType: "order.primary.retry_blocked_mismatch_risk",
        message: `Primary retry blocked after worst-fill mismatch risk recheck for intent ${intent.id}`,
        payload: {
          intentId: intent.id,
          reason: riskCheck.reason,
          estimate: riskCheck.estimate,
          mismatchRiskAudit: riskCheck.opportunity?.mismatchRiskAudit ?? null,
          retryAttempt,
        },
        createdAt: riskCheckAt,
      });
      return null;
    }
    repricedIntent = applyRiskCheckedOpportunityToIntent(
      repricedIntent,
      riskCheck.opportunity,
      riskCheckAt,
    );
    repricedLeg = repricedIntent.legs.find((candidate) => candidate.id === repricedLeg.id) ?? repricedLeg;
  } else {
    const economicsAt = Date.now();
    const { polymarket, kalshi } = await marketDataSupervisor.readSlotState(slot, economicsAt);
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
        applyHedgeRecoveryReserveToOpportunity(
          worstFillOpportunity,
          repricedIntent,
          settings,
        ),
        economicsAt,
      );
      repricedLeg = repricedIntent.legs.find((candidate) => candidate.id === repricedLeg.id) ?? repricedLeg;
    } else {
      repricedIntent = applyConservativeHedgeRiskFallback(
        repricedIntent,
        settings,
        economicsAt,
      );
      repricedLeg = repricedIntent.legs.find((candidate) => candidate.id === repricedLeg.id) ?? repricedLeg;
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
        createdAt: economicsAt,
      });
    }
  }
  const retryOrderType = stage === "primary"
    ? primaryImmediateOrderType(repricedLeg.venue)
    : immediatePartialOrderType(repricedLeg.venue);
  const request = buildVenueOrderRequest(repricedLeg, settings.maxSlippageBps, retryOrderType, false, {
    kalshiPriceTicksSlippage:
      stage === "primary" && repricedLeg.venue === "kalshi" ? settings.kalshiPrimaryPriceTicksSlippage : undefined,
  });
  const retryPriceLadderTicks = getRetryPriceLadderTicks(repricedLeg, retryAttempt);

  if (stage === "primary") {
    const primaryLeg = repricedIntent.legs.find((candidate) => candidate.venue === repricedIntent.primaryVenue);
    const hedgeLeg = repricedIntent.legs.find((candidate) => candidate.venue === repricedIntent.hedgeVenue);
    if (!primaryLeg || !hedgeLeg) {
      return null;
    }
    const retrySnapshotAt = Date.now();
    const { polymarket, kalshi } = await marketDataSupervisor.readSlotState(slot, retrySnapshotAt);
    const wsSnapshotIssue = validateFinalWsEntryDepthCoverage(
      slot,
      primaryLeg,
      hedgeLeg,
      polymarket.quote,
      kalshi.quote,
      settings,
      retrySnapshotAt,
    );
    if (wsSnapshotIssue) {
      await writeRunEvent({
        asset: intent.asset,
        level: "warn",
        eventType: "order.primary.retry_blocked_ws_preflight",
        message: `Primary retry blocked by final WS preflight for intent ${intent.id}`,
        payload: {
          intentId: intent.id,
          slotKey: intent.slotKey,
          retryAttempt,
          reason: wsSnapshotIssue,
        },
        createdAt: retrySnapshotAt,
      });
      return null;
    }
  }

  if (options?.persistRepricedIntent !== false) {
    await writeOrderIntent(repricedIntent);
  }
  await writeRunEvent({
    level: "info",
    eventType: `order.${stage}.repriced`,
    message: `${stage === "primary" ? "Primary" : "Hedge"} leg repriced within execution buffer for intent ${intent.id}${
      retryPriceLadderTicks > 0 ? ` (+${retryPriceLadderTicks} retry rung${retryPriceLadderTicks === 1 ? "" : "s"})` : ""
    }`,
    payload: {
      intentId: intent.id,
      venue: repricedLeg.venue,
      requestedPrice: repricedLeg.requestedPrice,
      requestedSize: repricedLeg.requestedSize,
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
      leg: repricedLeg,
      request,
      stage: `${stage}_retry:${retryAttempt}`,
      now,
      timeoutMs: settings.immediateOrderConfirmationTimeoutMs,
    });
  } catch (error) {
    if (shouldFailClosedOnSubmissionError(repricedLeg)) {
      await markIntentManualRequired(
        repricedIntent,
        Date.now(),
        `polymarket_${stage}_retry_submission_truth_unknown`,
        `Polymarket ${stage} retry may have reached the venue before the submission error (${toErrorMessage(error)})`,
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
    eventType: `order.${stage}.resubmitted`,
    message: `${stage === "primary" ? "Primary" : "Hedge"} ${repricedLeg.venue} order ${order.venueOrderId} resubmitted after reprice`,
    payload: {
      intentId: repricedIntent.id,
      venue: repricedLeg.venue,
      orderId: order.venueOrderId,
      orderStatus: result.status,
      orderType: request.orderType,
      retryAttempt,
      retryPriceLadderTicks,
      requestedPrice: repricedLeg.requestedPrice,
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

async function repriceRetryLegWithinExecutionBuffer(
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
  stage: "primary" | "hedge",
  retryAttempt = 1,
  pairSizeCap?: number | null,
) {
  if (stage === "primary") {
    const repricedIntent = await repriceIntentWithinExecutionBuffer(intent, slot, settings, now, pairSizeCap);
    if (!repricedIntent) {
      return null;
    }

    const repricedLeg = repricedIntent.legs.find((candidate) => candidate.id === leg.id);
    if (!repricedLeg) {
      return null;
    }

    return {
      intent: repricedIntent,
      leg: repricedLeg,
    };
  }

  const repricedLeg = await repriceSingleHedgeLegWithinExecutionBuffer(intent, leg, slot, settings, now, retryAttempt);
  if (!repricedLeg) {
    return null;
  }

  return {
    intent: {
      ...intent,
      updatedAt: now,
      legs: intent.legs.map((candidate) => (candidate.id === leg.id ? repricedLeg : candidate)) as OrderIntent["legs"],
    },
    leg: repricedLeg,
  };
}

async function retryLegWithinExecutionBufferWithAttempts(
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
  stage: "primary" | "hedge",
  attempts: number,
  retryDelayMs: number,
  options?: {
    pairSizeCap?: number | null;
    persistRepricedIntent?: boolean;
  },
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

    const retried = await retryLegWithinExecutionBuffer(
      currentIntent,
      leg,
      slot,
      settings,
      Date.now(),
      stage,
      attempt,
      options,
    );
    if (!retried) {
      if (lastResult) {
        await writeRunEvent({
          level: "warn",
          eventType: `order.${stage}.retry_aborted`,
          message: `${stage === "primary" ? "Primary" : "Hedge"} retry ${attempt}/${attempts} skipped because repricing was no longer valid`,
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

    if (stage === "hedge" && !shouldRetryTerminalZeroFillHedge(retried.intent, leg, retried.result)) {
      await writeHedgeRetryBlockedPendingTruthEvent(retried.intent, leg, retried.order, Date.now(), {
        attempt,
        attempts,
        orderStatus: retried.result.status,
      });
      return { ...retried, attemptsSubmitted };
    }

    await writeRunEvent({
      level: "warn",
      eventType: `order.${stage}.retry_terminal`,
      message: `${stage === "primary" ? "Primary" : "Hedge"} retry ${attempt}/${attempts} ended without fill`,
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
    getKalshiPrimaryMultiClipCapacity(
      settings.kalshiPrimaryMaxClipContracts,
      settings.kalshiPrimaryMaxClips,
    ) ?? Number.POSITIVE_INFINITY,
  );
  const polyLevels = (
    polyLeg.outcome === "UP"
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
    minPairSize: Math.max(
      settings.minOrderSize,
      pair.poly.minOrderSize ?? 0,
      pair.kalshi.minOrderSize ?? 1,
    ),
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
    (multiLevelSizing.polymarket.notionalUsd + multiLevelSizing.kalshi.notionalUsd) /
      multiLevelSizing.commonSize,
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
    const quote = leg.venue === "polymarket"
      ? multiLevelSizing.polymarket
      : multiLevelSizing.kalshi;
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
    targetNotionalUsd: round4(
      multiLevelSizing.polymarket.notionalUsd + multiLevelSizing.kalshi.notionalUsd,
    ),
    projectedNetProfitUsd: multiLevelSizing.projectedNetProfitUsd,
    fatalMismatchPnlUsd: round4(-multiLevelSizing.worstFillCostUsd),
    conservativeExpectedPnlUsd:
      intent.mismatchPFatalUpper === null || intent.mismatchPFatalUpper === undefined
        ? intent.conservativeExpectedPnlUsd ?? null
        : round4(
            multiLevelSizing.commonSize * (1 - intent.mismatchPFatalUpper) -
              multiLevelSizing.worstFillCostUsd,
          ),
    fatalLossExposureUsd: round4(multiLevelSizing.worstFillCostUsd),
    updatedAt: now,
    legs: updatedLegs as OrderIntent["legs"],
  };
}

async function diagnoseRepriceIntentFailure(
  intent: OrderIntent,
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
  pairSizeCap?: number | null,
) {
  const { polymarket: polymarketState, kalshi: kalshiState } = await marketDataSupervisor.readSlotState(slot, now);
  const pair = getLivePairSnapshot(intent, polymarketState.quote, kalshiState.quote, settings);
  const allowedGrossCost = settings.grossEntryThreshold + settings.executionPriceBuffer;

  if (!pair) {
    return {
      reason: "missing_live_pair",
      slotKey: slot.key,
      feedSources: {
        polymarket: polymarketState.quote.source,
        kalshi: kalshiState.quote.source,
      },
      feedStalenessMs: {
        polymarket: polymarketState.quote.stalenessMs,
        kalshi: kalshiState.quote.stalenessMs,
      },
    };
  }

  const priceReasons = [];
  if (pair.grossCost > allowedGrossCost + ORDER_SIZE_TOLERANCE) {
    priceReasons.push("gross_above_allowed_cost");
  }

  if (priceReasons.length > 0) {
    return {
      reason: priceReasons.join("+"),
      slotKey: slot.key,
      grossCost: pair.grossCost,
      allowedGrossCost,
      polyPrice: pair.poly.price,
      kalshiPrice: pair.kalshi.price,
      pairSizeCap: pairSizeCap ?? null,
    };
  }

  const polyLeg = intent.legs.find((leg) => leg.venue === "polymarket");
  const kalshiLeg = intent.legs.find((leg) => leg.venue === "kalshi");
  if (!polyLeg || !kalshiLeg) {
    return {
      reason: "missing_intent_leg",
      slotKey: slot.key,
      hasPolymarketLeg: Boolean(polyLeg),
      hasKalshiLeg: Boolean(kalshiLeg),
    };
  }

  const desiredPairSize = Math.min(
    polyLeg.requestedSize,
    kalshiLeg.requestedSize,
    pairSizeCap ?? Number.POSITIVE_INFINITY,
    getKalshiPrimaryMultiClipCapacity(
      settings.kalshiPrimaryMaxClipContracts,
      settings.kalshiPrimaryMaxClips,
    ) ?? Number.POSITIVE_INFINITY,
  );
  const balancedSizing = deriveBalancedPayoutPairSize({
    targetPairBudgetUsd: settings.maxPairNotionalUsd,
    maxLegCapitalShare: settings.maxLegCapitalShare,
    pairSizeCap: desiredPairSize,
    polymarket: {
      price: pair.poly.price,
      depth: pair.poly.depth,
      minOrderSize: pair.poly.minOrderSize,
      fallbackMinOrderSize: settings.minOrderSize,
      feeRateBps: pair.poly.feeRateBps,
    },
    kalshi: {
      price: pair.kalshi.price,
      depth: pair.kalshi.depth,
      minOrderSize: pair.kalshi.minOrderSize,
      fallbackMinOrderSize: 1,
      feeMultiplier: pair.kalshi.feeMultiplier,
    },
    kalshiDepthHeadroomContracts: settings.kalshiDepthHeadroomContracts,
  });

  return {
    reason: balancedSizing.commonSize <= 0 ? "insufficient_balanced_payout_size" : "unknown_reprice_failure",
    slotKey: slot.key,
    desiredPairSize,
    pairSizeCap: pairSizeCap ?? null,
    balancedSizing,
    polyPrice: pair.poly.price,
    polyDepth: pair.poly.depth,
    polyMinOrderSize: pair.poly.minOrderSize,
    kalshiPrice: pair.kalshi.price,
    kalshiSafetyAdjustedDepth: pair.kalshi.depth,
    kalshiMinOrderSize: pair.kalshi.minOrderSize,
    kalshiDepthHeadroomContracts: settings.kalshiDepthHeadroomContracts,
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
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
  retryAttempt = 1,
) {
  const { polymarket: polymarketState, kalshi: kalshiState } = await marketDataSupervisor.readSlotState(slot, now);
  const liveLeg = getLiveIntentLegSnapshot(leg, polymarketState.quote, kalshiState.quote);
  if (!liveLeg) {
    return null;
  }

  return deriveBufferedRetryLeg(leg, liveLeg, {
    executionPriceBuffer: settings.executionPriceBuffer,
    maxLegPrice: settings.maxLegPrice,
    maxSlippageBps: settings.maxSlippageBps,
    minOrderSize: settings.minOrderSize,
    kalshiDepthHeadroomContracts: settings.kalshiDepthHeadroomContracts,
  }, retryAttempt);
}

function getLiveIntentLegSnapshot(
  leg: OrderIntent["legs"][number],
  polymarket: OpportunitySnapshot["polymarket"],
  kalshi: OpportunitySnapshot["kalshi"],
) {
  if (leg.venue === "polymarket") {
    const outcome = leg.outcome === "UP" ? polymarket.outcomes.up : leg.outcome === "DOWN" ? polymarket.outcomes.down : null;
    if (!outcome) {
      return null;
    }

    return {
      price: leg.side === "SELL" ? outcome.sellPrice : outcome.buyPrice,
      depth: outcome.depth,
      minOrderSize: outcome.minOrderSize,
      tickSize: outcome.tickSize,
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
  };
}

export function deriveBufferedRetryLeg<
  T extends Pick<
    OrderIntent["legs"][number],
    "venue" | "requestedNotionalUsd" | "requestedPrice" | "requestedSize" | "side" | "outcome" | "id" | "intentId" | "status" | "marketRef"
  >,
>(
  leg: T,
  liveLeg: {
    price: number | null;
    depth: number | null;
    minOrderSize: number | null;
    tickSize?: number | null;
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

  const requestedPrice = deriveRetryReferencePrice(leg, liveLeg.price, liveLeg.tickSize ?? null, retryAttempt);
  if (requestedPrice === null) {
    return null;
  }

  const boundedPrice =
    leg.venue === "kalshi"
      ? deriveEffectiveKalshiRetryOrderPrice(requestedPrice, leg.side, settings.maxSlippageBps) ?? requestedPrice
      : requestedPrice;
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

  const executableDepth = getVenueExecutableDepth(
    leg.venue,
    liveLeg.depth,
    settings.kalshiDepthHeadroomContracts,
  );
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
  leg: Pick<OrderIntent["legs"][number], "venue" | "side">,
  livePrice: number,
  liveTickSize: number | null,
  retryAttempt: number,
) {
  const retryPriceLadderTicks = getRetryPriceLadderTicks(leg, retryAttempt);
  if (retryPriceLadderTicks <= 0) {
    return livePrice;
  }

  const priceStep =
    leg.venue === "kalshi"
      ? KALSHI_ORDER_PRICE_STEP_USD
      : leg.venue === "polymarket"
        ? Math.max(0.001, liveTickSize ?? 0.001)
        : 0;
  if (priceStep <= 0) {
    return livePrice;
  }

  const priceDelta = retryPriceLadderTicks * priceStep;
  return round4(
    Math.max(
      priceStep,
      livePrice + (leg.side === "SELL" ? -priceDelta : priceDelta),
    ),
  );
}

function deriveEffectiveKalshiRetryOrderPrice(
  requestedPrice: number,
  side: OrderIntent["legs"][number]["side"],
  maxSlippageBps: number,
) {
  return normalizeKalshiOrderPrice(applySlippage(requestedPrice, maxSlippageBps, side), side);
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
  leg:
    | Pick<OrderIntent["legs"][number], "venue" | "outcome" | "filledSize" | "payoutUsd">
    | null
    | undefined,
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

function getRetryPriceLadderTicks(
  leg: Pick<OrderIntent["legs"][number], "venue">,
  retryAttempt: number,
) {
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

  const maxBuyPrice = normalizeKalshiOrderPrice(
    price + Math.max(0, ticksSlippage) * KALSHI_ORDER_PRICE_STEP_USD,
    "BUY",
  );
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
  const cumulativeDepth = computeKalshiBuyDepthWithinPriceRange(kalshi.quote.orderbookLevels, kalshiOutcome, orderPrice);
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

async function preflightKalshiPrimaryRestLiquidity(
  leg: Pick<OrderIntent["legs"][number], "marketRef" | "outcome" | "side" | "venue">,
  request: Pick<VenueOrderRequest, "price" | "size">,
  settings: Pick<StrategyConfig, "kalshiPrimaryDepthSafetyFactor" | "kalshiDepthHeadroomContracts">,
) {
  if (leg.venue !== "kalshi" || leg.side !== "BUY") {
    return {
      status: "skipped" as const,
      reason: "not_kalshi_buy",
      requestedSize: request.size,
      orderPrice: request.price,
      cumulativeDepthWithinLimit: null,
      executableDepth: null,
      topLevels: [],
    };
  }

  if (request.price === null) {
    return {
      status: "insufficient" as const,
      reason: "missing_order_price",
      requestedSize: request.size,
      orderPrice: request.price,
      cumulativeDepthWithinLimit: null,
      executableDepth: 0,
      topLevels: [],
    };
  }

  try {
    const orderbook = await fetchKalshiOrderbook(leg.marketRef);
    const levels = normalizeKalshiNumericOrderbookLevels(orderbook);
    const kalshiOutcome = leg.outcome === "YES" ? "YES" : "NO";
    const cumulativeDepth = computeKalshiBuyDepthWithinPriceRange(levels, kalshiOutcome, request.price);
    const safetyAdjustedDepth = applyKalshiPrimaryDepthSafetyFactor(
      cumulativeDepth,
      settings.kalshiPrimaryDepthSafetyFactor,
    );
    const executableDepth = getVenueExecutableDepth(
      "kalshi",
      safetyAdjustedDepth,
      settings.kalshiDepthHeadroomContracts,
    );
    const topLevels = deriveKalshiBuyPriceLevels(levels, kalshiOutcome)
      .slice(0, 3)
      .map(([price, size]) => ({ price, size }));
    const insufficient =
      executableDepth !== null && executableDepth + ORDER_SIZE_TOLERANCE < request.size;

    return {
      status: insufficient ? "insufficient" as const : "ready" as const,
      reason: insufficient ? "rest_depth_below_requested_size" : null,
      requestedSize: request.size,
      orderPrice: request.price,
      cumulativeDepthWithinLimit: cumulativeDepth,
      depthSafetyFactor: settings.kalshiPrimaryDepthSafetyFactor,
      safetyAdjustedCumulativeDepthWithinLimit: safetyAdjustedDepth,
      kalshiDepthHeadroomContracts: settings.kalshiDepthHeadroomContracts,
      executableDepth,
      topLevels,
      seq: orderbook.seq ?? null,
    };
  } catch (error) {
    return {
      status: "unavailable" as const,
      reason: toErrorMessage(error),
      requestedSize: request.size,
      orderPrice: request.price,
      cumulativeDepthWithinLimit: null,
      executableDepth: null,
      topLevels: [],
    };
  }
}

async function preflightEntryDepthAndAdjustIntent(
  intent: OrderIntent,
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
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

  const preflightNow = Date.now();
  const { polymarket: polymarketState, kalshi: kalshiState } = await marketDataSupervisor.readSlotState(slot, preflightNow);
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
  const hedgeCheck = buildWsEntryDepthCheck(
    hedgeLeg,
    hedgeLive,
    polymarketState.quote,
    kalshiState.quote,
    settings,
  );
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
  if (
    polymarket.feedHealth.feedStatus !== "ready" ||
    kalshi.feedHealth.feedStatus !== "ready"
  ) {
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
    const outcome = leg.venue === "polymarket"
      ? leg.outcome === "UP"
        ? polymarket.outcomes.up
        : polymarket.outcomes.down
      : leg.outcome === "YES"
        ? kalshi.outcomes.yes
        : kalshi.outcomes.no;
    const maxAgeMs = leg.venue === "polymarket"
      ? Math.min(settings.maxSignalAgeMs, settings.polymarketHedgeBookMaxAgeMs)
      : settings.maxSignalAgeMs;
    const ageMs = outcome.chart.lastUpdatedAt === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, now - outcome.chart.lastUpdatedAt);
    if (outcome.chart.source !== "ws" || quote.stalenessMs === null || quote.stalenessMs > maxAgeMs || ageMs > maxAgeMs) {
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
  const snapshotIssue = validateFinalWsEntrySnapshot(
    slot,
    primaryLeg,
    hedgeLeg,
    polymarket,
    kalshi,
    settings,
    now,
  );
  if (snapshotIssue) {
    return snapshotIssue;
  }

  for (const leg of [primaryLeg, hedgeLeg]) {
    const liveLeg = getLiveIntentLegSnapshot(leg, polymarket, kalshi);
    const depth = buildWsEntryDepthCheck(
      leg,
      liveLeg,
      polymarket,
      kalshi,
      settings,
    );
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
  const levels = leg.venue === "polymarket"
    ? (leg.outcome === "UP"
        ? polymarket.orderbookLevels?.upAsks
        : polymarket.orderbookLevels?.downAsks) ?? []
    : deriveKalshiBuyPriceLevels(
        kalshi.orderbookLevels,
        leg.outcome === "YES" ? "YES" : "NO",
      );
  const displayedDepth = maxPrice === null
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
    polyLeg.requestedSize > 0 ? polymarket.outcomes[polyLeg.outcome === "UP" ? "up" : "down"].minOrderSize ?? settings.minOrderSize : 0,
    kalshi.outcomes[kalshiLeg.outcome === "YES" ? "yes" : "no"].minOrderSize ?? 1,
  );
  if (pairSize + ORDER_SIZE_TOLERANCE < minimumPairSize) {
    return null;
  }

  const polyOutcome = polymarket.outcomes[polyLeg.outcome === "UP" ? "up" : "down"];
  const kalshiOutcome = kalshiLeg.outcome === "YES" ? "YES" : "NO";
  const polyQuote = quoteMultiLevelBuyLeg({
    venue: "polymarket",
    levels: (
      polyLeg.outcome === "UP"
        ? polymarket.orderbookLevels?.upAsks
        : polymarket.orderbookLevels?.downAsks
    )?.map(([price, size]) => ({ price, size })) ?? [],
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
    levels: deriveKalshiBuyPriceLevels(kalshi.orderbookLevels, kalshiOutcome).map(
      ([price, size]) => ({ price, size }),
    ),
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
  if (settings.mismatchRiskMode === "enforce") {
    const pFatalUpper = intent.mismatchPFatalUpper;
    const breakEvenFatalProbability = Math.max(0, projectedNetProfitUsd / pairSize);
    if (
      pFatalUpper === null ||
      pFatalUpper === undefined ||
      pFatalUpper > 0.5 * breakEvenFatalProbability + ORDER_SIZE_TOLERANCE
    ) {
      return null;
    }
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
  const conservativeExpectedPnlUsd = intent.mismatchPFatalUpper === null || intent.mismatchPFatalUpper === undefined
    ? intent.conservativeExpectedPnlUsd ?? null
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
    "kalshiPrimaryDepthSafetyFactor" | "kalshiDepthHeadroomContracts" | "polymarketHedgeDepthSafetyFactor" | "polymarketHedgeHeadroomShares"
  >,
) {
  if (displayedDepth === null || !Number.isFinite(displayedDepth) || displayedDepth <= 0) {
    return 0;
  }

  if (leg.venue === "kalshi") {
    return getVenueExecutableDepth(
      "kalshi",
      applyKalshiPrimaryDepthSafetyFactor(displayedDepth, settings.kalshiPrimaryDepthSafetyFactor),
      settings.kalshiDepthHeadroomContracts,
    ) ?? 0;
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

function deriveAdaptiveSlippageBps(
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
  return Math.max(settings.maxSlippageBps, settings.adaptiveSlippageThinBps);
}

async function resolveAdaptiveSlippageForLiveLeg(
  leg: OrderIntent["legs"][number],
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
) {
  const { polymarket: polymarketState, kalshi: kalshiState } = await marketDataSupervisor.readSlotState(slot, now);
  const liveLeg = getLiveIntentLegSnapshot(leg, polymarketState.quote, kalshiState.quote);
  const check = buildEntryDepthCheck(leg, liveLeg, settings);
  return deriveAdaptiveSlippageBps(check.coverageRatio, settings);
}

async function resizeKalshiPrimaryIntentFromRestPreflight(
  intent: OrderIntent,
  primaryLegId: OrderIntent["legs"][number]["id"],
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
  restPreflight: Awaited<ReturnType<typeof preflightKalshiPrimaryRestLiquidity>>,
) {
  if (restPreflight.status !== "insufficient" || restPreflight.executableDepth === null) {
    return null;
  }

  const safePairSize = normalizeVenueTargetSize("kalshi", restPreflight.executableDepth, 1, 1);
  if (safePairSize <= 0) {
    return null;
  }

  const resizedIntent = await repriceIntentWithinExecutionBuffer(intent, slot, settings, now, safePairSize);
  if (
    !resizedIntent ||
    resizedIntent.projectedNetProfitUsd === null ||
    !doesSizingMeetProfitThresholds(
      resizedIntent.projectedNetProfitUsd,
      null,
      settings,
      { allowUnknownReturn: true },
    )
  ) {
    return null;
  }

  const primaryLeg = resizedIntent.legs.find((leg) => leg.id === primaryLegId);
  if (!primaryLeg || primaryLeg.requestedSize <= 0 || primaryLeg.requestedSize > safePairSize + ORDER_SIZE_TOLERANCE) {
    return null;
  }

  return {
    ...resizedIntent,
    entrySizingReason:
      resizedIntent.entrySizingReason ??
      `Notionnel réduit par profondeur REST Kalshi: taille ${primaryLeg.requestedSize.toFixed(2)}`,
  };
}

async function preflightPolymarketHedgeLiquidity(
  intent: OrderIntent,
  settings: Pick<
    StrategyConfig,
    | "maxSlippageBps"
    | "polymarketHedgeDepthSafetyFactor"
    | "polymarketHedgeHeadroomShares"
    | "polymarketHedgeBookMaxAgeMs"
  >,
) {
  const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
  if (!hedgeLeg || hedgeLeg.venue !== "polymarket" || hedgeLeg.side !== "BUY") {
    return {
      status: "skipped" as const,
      reason: "not_polymarket_buy_hedge",
    };
  }

  const request = buildVenueOrderRequest(hedgeLeg, settings.maxSlippageBps, "FOK", false);
  const minNotionalCheck = getPolymarketHedgeMinNotionalViolation(hedgeLeg);
  if (minNotionalCheck) {
    return {
      status: "insufficient" as const,
      reason: "polymarket_hedge_notional_below_minimum",
      requestedSize: request.size,
      requestedNotionalUsd: minNotionalCheck.requestedNotionalUsd,
      minimumNotionalUsd: minNotionalCheck.minimumNotionalUsd,
      orderPrice: request.price,
      executableDepth: null,
    };
  }

  if (!hedgeLeg.tokenId || request.price === null) {
    return {
      status: "unavailable" as const,
      reason: "missing_token_or_price",
      requestedSize: request.size,
      orderPrice: request.price,
      executableDepth: null,
    };
  }

  try {
    const fetchStartedAt = Date.now();
    const book = await fetchPolymarketBook(hedgeLeg.tokenId);
    const capturedAt = Date.now();
    const bookAgeMs = capturedAt - fetchStartedAt;
    if (bookAgeMs > settings.polymarketHedgeBookMaxAgeMs) {
      return {
        status: "unavailable" as const,
        reason: "polymarket_book_too_slow",
        requestedSize: request.size,
        orderPrice: request.price,
        bookAgeMs,
        maxBookAgeMs: settings.polymarketHedgeBookMaxAgeMs,
        executableDepth: null,
      };
    }

    const rawDepth = sumPolymarketAskDepthWithinLimit(book.asks, request.price);
    const executableDepth = deriveSafePolymarketHedgeDepth(
      rawDepth,
      settings.polymarketHedgeDepthSafetyFactor,
      settings.polymarketHedgeHeadroomShares,
    );
    const executableQuote = quotePolymarketBuyFromAsks(book.asks, request.price, Math.min(request.size, executableDepth));
    const insufficient = executableDepth + ORDER_SIZE_TOLERANCE < request.size;
    return {
      status: insufficient ? "insufficient" as const : "ready" as const,
      reason: insufficient ? "polymarket_depth_below_requested_size" : null,
      requestedSize: request.size,
      orderPrice: request.price,
      rawDepth,
      depthSafetyFactor: settings.polymarketHedgeDepthSafetyFactor,
      headroomShares: settings.polymarketHedgeHeadroomShares,
      executableDepth,
      executableVwap: executableQuote.vwap,
      bookAgeMs,
      topLevels: book.asks
        .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
        .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size))
        .sort((left, right) => left.price - right.price)
        .slice(0, 3),
    };
  } catch (error) {
    return {
      status: "unavailable" as const,
      reason: toErrorMessage(error),
      requestedSize: request.size,
      orderPrice: request.price,
      executableDepth: null,
    };
  }
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

export function sumPolymarketAskDepthWithinLimit(
  asks: Array<{ price: string; size: string }>,
  limitPrice: number,
) {
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
  if (
    input.primaryEntryPrice === null ||
    input.hedgePrice === null ||
    input.size <= 0
  ) {
    return null;
  }

  const primaryFeeUsd = input.primaryFeeUsd ?? 0;
  const hedgeFeeUsd = input.hedgeFeeUsd ?? 0;
  return round4(Math.max(0, input.size * input.primaryEntryPrice + input.size * input.hedgePrice + primaryFeeUsd + hedgeFeeUsd - input.size));
}

export function isHedgedPairEconomicsWithinLossCap(
  economics: ReturnType<typeof deriveHedgedPairEconomics>,
  maximumAcceptedLossUsd = 0,
) {
  if (
    economics.polymarketFilledSize <= ORDER_SIZE_TOLERANCE ||
    economics.kalshiFilledSize <= ORDER_SIZE_TOLERANCE
  ) {
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

async function attemptHedgeRescueBeforeUnwind(
  intent: OrderIntent,
  settings: StrategyConfig,
  now: number,
) {
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
    settings.forcedUnwindMaxLossUsd > 0
      ? settings.forcedUnwindMaxLossUsd
      : settings.hedgeRescueMaxLossUsd,
  );

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

    const primaryEntryPrice = primaryLeg.filledPrice ?? primaryLeg.requestedPrice;
    if (primaryEntryPrice === null) {
      return { intent: currentIntent, recovered: false, hold: false };
    }

    const maxHedgePrice = Math.min(0.99, Math.max(0.001, 1 - primaryEntryPrice + maxRescueLossUsd / unhedgedSize));
    const bookFetchStartedAt = Date.now();
    let book: Awaited<ReturnType<typeof fetchPolymarketBook>>;
    try {
      book = await fetchPolymarketBook(hedgeLeg.tokenId);
    } catch (error) {
      await writeRunEvent({
        asset: currentIntent.asset,
        level: "warn",
        eventType: "order.hedge_rescue.evaluated",
        message: `Hedge rescue book unavailable for intent ${currentIntent.id}`,
        payload: {
          intentId: currentIntent.id,
          slotKey: currentIntent.slotKey,
          attempt,
          error: toErrorMessage(error),
        },
        createdAt: Date.now(),
      });
      return { intent: currentIntent, recovered: false, hold: false };
    }

    const bookAgeMs = Date.now() - bookFetchStartedAt;
    if (bookAgeMs > settings.polymarketHedgeBookMaxAgeMs) {
      await writeRunEvent({
        asset: currentIntent.asset,
        level: "warn",
        eventType: "order.hedge_rescue.evaluated",
        message: `Hedge rescue book too slow for intent ${currentIntent.id}`,
        payload: {
          intentId: currentIntent.id,
          slotKey: currentIntent.slotKey,
          attempt,
          bookAgeMs,
          maxBookAgeMs: settings.polymarketHedgeBookMaxAgeMs,
        },
        createdAt: Date.now(),
      });
      return { intent: currentIntent, recovered: false, hold: false };
    }

    const rawDepth = sumPolymarketAskDepthWithinLimit(book.asks, maxHedgePrice);
    const executableDepth = deriveSafePolymarketHedgeDepth(
      rawDepth,
      settings.polymarketHedgeDepthSafetyFactor,
      settings.polymarketHedgeHeadroomShares,
    );
    const minimumHedgeSize = getVenueMinimumOrderSize("polymarket", null, settings.minOrderSize);
    const targetSize = Math.min(unhedgedSize, executableDepth);
    const normalizedTargetSize = normalizeVenueTargetSize("polymarket", targetSize, null, settings.minOrderSize);
    const quote = quotePolymarketBuyFromAsks(book.asks, maxHedgePrice, normalizedTargetSize);
    const latestSnapshot = await readLatestSnapshot(currentIntent.asset, currentIntent.slotKey).catch(() => null);
    const polymarketQuote = latestSnapshot?.polymarket ?? null;
    const outcomeQuote = hedgeLeg.outcome === "UP"
      ? polymarketQuote?.outcomes.up
      : polymarketQuote?.outcomes.down;
    const feeRateBps = outcomeQuote?.feeRateBps ?? polymarketQuote?.feeRateBps ?? 0;
    const hedgeFeeUsd = calculatePolymarketLevelFee({
      shares: quote.filledSize,
      price: quote.vwap ?? maxHedgePrice,
      feeRateBps,
      feeRate:
        polymarketQuote?.feeRate ??
        (feeRateBps > 0 ? undefined : POLYMARKET_CRYPTO_RESCUE_FEE_RATE),
      feeExponent: polymarketQuote?.feeExponent ?? 1,
    });
    const hedgeLossUsd = estimateRescueHedgeLossUsd({
      primaryEntryPrice,
      hedgePrice: quote.vwap ?? maxHedgePrice,
      size: quote.filledSize,
      primaryFeeUsd: primaryLeg.feeUsd ? (primaryLeg.feeUsd * quote.filledSize) / Math.max(primaryLeg.filledSize, ORDER_SIZE_TOLERANCE) : 0,
      hedgeFeeUsd,
    });
    const unwindEstimate = await estimatePrimaryUnwindRecoveryLoss(currentIntent, primaryLeg, attemptNow, settings);
    const holdEstimate = await estimateHoldToSettlementLoss(currentIntent, primaryLeg, attemptNow);
    const secondsToSettlement = Math.ceil((currentIntent.slotEndTs - attemptNow) / 1_000);
    const decision = evaluateExposureRecoveryOptions({
      rescueHedgeLossUsd: hedgeLossUsd,
      rescueHedgeSize: quote.filledSize,
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

    if (quote.filledSize + ORDER_SIZE_TOLERANCE < minimumHedgeSize) {
      return { intent: currentIntent, recovered: false, hold: false };
    }

    const rescueLeg = {
      ...hedgeLeg,
      requestedPrice: maxHedgePrice,
      requestedSize: quote.filledSize,
      requestedNotionalUsd: round4(quote.filledSize * maxHedgePrice),
    };
    const orderType = "FOK";
    const rescueRequest = buildVenueOrderRequest(rescueLeg, 0, orderType, false, { overridePrice: maxHedgePrice });
    let rescueResult: Awaited<ReturnType<VenueAdapter["placeOrder"]>>;
    let rescueOrder: LiveOrder;
    currentIntent = markIntentStatus(currentIntent, "rescue_hedge", Date.now(), "Attempting full hedge rescue before primary unwind");
    await writeOrderIntent(currentIntent);
    try {
      const rescueExecution = await submitAndConfirmOrder({
        intent: currentIntent,
        leg: rescueLeg,
        request: rescueRequest,
        stage: `hedge_rescue:${attempt}`,
        now: Date.now(),
        timeoutMs: settings.immediateOrderConfirmationTimeoutMs,
      });
      rescueResult = rescueExecution.result;
      rescueOrder = rescueExecution.order;
    } catch (error) {
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

    if (
      shouldHoldHedgeRescueOrderPendingTruth(
        currentIntent,
        hedgeLeg,
        rescueOrder,
        Date.now(),
      )
    ) {
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
      currentIntent = accumulateIntentLegOrder(currentIntent, hedgeLeg.id, rescueOrder, "hedged", Date.now());
      await writeOrderIntent(currentIntent);
      await attachRecentPolymarketFillsSafely(currentIntent, "hedge", Date.now()).then((updated) => {
        currentIntent = updated;
      });
      const remainingSize = deriveUnhedgedPrimarySize(currentIntent);
      await writeRunEvent({
        asset: currentIntent.asset,
        level: remainingSize <= ORDER_SIZE_TOLERANCE ? "info" : "warn",
        eventType:
          remainingSize <= ORDER_SIZE_TOLERANCE
            ? "order.hedge_rescue.completed"
            : "order.hedge_rescue.partial_filled",
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
  const liveExitPrice = await resolvePrimaryExitPrice(intent, primaryLeg, now).catch(() => null);
  const fallbackExitPrice =
    primaryLeg.filledPrice === null ? primaryLeg.requestedPrice : primaryLeg.filledPrice * 0.99;
  const expectedExitPrice = applySlippage(liveExitPrice ?? fallbackExitPrice ?? 0, settings.maxSlippageBps, "SELL");

  return {
    requestedSize,
    expectedExitPrice,
    expectedLossUsd: estimatePrimaryUnwindLossUsd(primaryLeg, requestedSize, expectedExitPrice),
  };
}

async function estimateHoldToSettlementLoss(
  intent: OrderIntent,
  primaryLeg: OrderIntent["legs"][number],
  now: number,
) {
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
  let currentIntent = hedgeOrder
    ? updateIntentLeg(intent, hedgeLeg.venue, hedgeOrder, "failed", now)
    : intent;
  if (shouldHoldPolymarketHedgeFailurePendingTruth(currentIntent, hedgeLeg, hedgeOrder ?? hedgeResult ?? null, now)) {
    return holdPolymarketHedgeFailurePendingTruth(currentIntent, hedgeLeg, hedgeOrder, now, "hedge_no_fill_truth_pending", {
      failureReason,
      orderStatus: hedgeOrder?.status ?? hedgeResult?.status ?? null,
      hedgeOrderId: hedgeOrder?.venueOrderId ?? hedgeResult?.venueOrderId ?? null,
    });
  }

  const exposureResolution = await resolveHedgeExposureBeforePrimaryUnwind(currentIntent, hedgeOrder, settings, now);
  if (exposureResolution) {
    return exposureResolution;
  }

  currentIntent = markIntentStatus(currentIntent, "unwind_required", now, failureReason);
  await writeOrderIntent(currentIntent);
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
      settings.forcedUnwindMaxLossUsd > 0
        ? settings.forcedUnwindMaxLossUsd
        : settings.hedgeRescueMaxLossUsd,
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
  const unwindEstimate = await estimatePrimaryUnwindRecoveryLoss(currentIntent, currentPrimaryLeg, Date.now(), settings);
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
            ticks: settings.forcedUnwindTickLadder[
              Math.min(forcedAttempt - 1, settings.forcedUnwindTickLadder.length - 1)
            ] ?? 0,
          }
        : undefined;

    let unwindResult: LiveOrder;
    try {
      unwindResult = await unwindPrimaryLeg(currentIntent, settings, Date.now(), force);
    } catch (error) {
      const errorMessage = toErrorMessage(error);
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
        await writeOrderIntent(currentIntent);
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
      currentIntent = finalizeUnwoundIntent({
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
        failureReason: describeUnwoundAfterFailure(failureReason),
      });
      await writeOrderIntent(currentIntent);
      await recordMarketFillQualityForIntent(currentIntent, "unwind", "primary_unwound_after_hedge_failure", now, {
        venue: currentIntent.primaryVenue,
        unwindOrderId: unwindResult.venueOrderId,
      });
      await armRecoveredHedgeFailureCooldown(currentIntent, Date.now(), "primary_unwound_after_hedge_failure");
      break;
    }

    if (unwindResult.filledSize > 0) {
      currentIntent = markIntentStatus(
        currentIntent,
        "unwind_required",
        now,
        `Primary unwind partially filled (${unwindResult.status}); manual intervention required`,
      );
      await writeOrderIntent(currentIntent);
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
    await writeOrderIntent(currentIntent);
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

    const currentIntent = markIntentStatus(
      intent,
      "manual_required",
      now,
      `Hedge exposure exceeds primary by ${overfilledHedgeSize.toFixed(6)}; manual intervention required`,
    );
    await writeOrderIntent(currentIntent);
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
  hedgeResult?: Awaited<ReturnType<VenueAdapter["placeOrder"]>>,
) {
  const lockResult = await tryWithGlobalLiveExecutionLock(
    `reconcile-unwind:${intent.asset}:${intent.id}`,
    () => attemptPrimaryUnwindAfterHedgeFailure(
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
  await writeCircuitBreaker({
    key: "global",
    active: true,
    reason: "hedge_failure",
    triggeredAt: now,
    payload: {
      intentId: intent.id,
      slotKey: intent.slotKey,
      venue: intent.primaryVenue,
      stage,
      hedgeOrderId: hedgeOrder?.venueOrderId ?? null,
      requiresManualClear: true,
    },
  });
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
  const currentIntent = markIntentStatus(intent, "manual_required", now, failureReason);
  await writeOrderIntent(currentIntent);
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
    const currentIntent = markIntentStatus(
      intent,
      "manual_required",
      now,
      `Hedged pair worst-case PnL ${economics.netWorstCaseUsd.toFixed(4)} USD; manual intervention required`,
    );
    await writeOrderIntent(currentIntent);
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

  const currentIntent = markIntentStatus(intent, "hedged", now, null);
  await writeOrderIntent(currentIntent);
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
  const recentOrders = sharedContext.recentVenueOrders
    ? sharedContext.recentVenueOrders.filter((order) => order.asset === asset).slice(0, 200)
    : await readRecentVenueOrders(200, asset);
  const { polyOpenOrders, kalshiOrders, polyTrades, kalshiFills } =
    sharedContext.venueOrderReconcileData ?? (await prefetchVenueOrderReconcileData());
  const recentOrderByVenueId = new Map(recentOrders.map((order) => [`${order.venue}:${order.venueOrderId}`, order]));
  const touchedIntentLegs = new Set<string>();

  for (const order of polyOpenOrders) {
    const existing = recentOrderByVenueId.get(`polymarket:${order.id}`) ?? (await findVenueOrder("polymarket", order.id));
    if (!existing) {
      continue;
    }
    if (existing.asset !== asset) {
      continue;
    }
    const mappedOrder = {
      ...mapPolymarketOrder(order, existing.intentId),
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
    const existing = recentOrderByVenueId.get(`kalshi:${order.order_id}`) ?? (await findVenueOrder("kalshi", order.order_id));
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
      await estimateKalshiFeeUsd({
        asset: existing.asset,
        contracts: filledSize,
        price: outcomePrice ?? existing.averageFillPrice,
        liquidity: "TAKER",
        now,
      });
    await writeVenueOrder({
      ...existing,
      status: mapKalshiOrderStatus(
        order.status,
        filledSize,
        Number(order.remaining_count_fp ?? 0),
      ),
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

    const confirmedTrades = matchingTrades.filter(isConfirmedPolymarketTrade);
    const truth = resolvePolymarketOrderTruth({
      orderId: existingOrder.venueOrderId,
      order: extractPolymarketOpenOrderFromRaw(existingOrder.raw),
      trades: matchingTrades,
      expectedSize: existingOrder.requestedSize,
      expectedSizeIsExact: existingOrder.side !== "BUY",
      orderType: existingOrder.orderType,
    });
    if (truth.effectiveFilledSize > 0) {
      await writeVenueOrder({
        ...existingOrder,
        status: truth.status === "filled" && truth.confirmedFilledSize > 0
          ? deriveConfirmedVenueOrderStatus(existingOrder, truth.confirmedFilledSize)
          : truth.status,
        filledSize: Math.max(existingOrder.filledSize, truth.effectiveFilledSize),
        averageFillPrice: truth.averageFillPrice ?? existingOrder.averageFillPrice,
        feeUsd: Math.max(existingOrder.feeUsd ?? 0, truth.feeUsd),
        updatedAt: now,
        raw: {
          ...(existingOrder.raw ?? {}),
          trades: matchingTrades,
          orderTruth: truth,
        },
      });
      for (const trade of confirmedTrades) {
        await writePolymarketFillSafely(trade, existingOrder.intentId, existingOrder.venueOrderId, "reconcile");
      }
      touchedIntentLegs.add(`${existingOrder.intentId}:polymarket`);
      continue;
    }

    if (matchingTrades.some(isPendingPolymarketTrade)) {
      await writeVenueOrder({
        ...existingOrder,
        status: "pending",
        filledSize: Math.max(existingOrder.filledSize, truth.effectiveFilledSize),
        averageFillPrice: truth.averageFillPrice ?? existingOrder.averageFillPrice,
        feeUsd: Math.max(existingOrder.feeUsd ?? 0, truth.feeUsd),
        updatedAt: now,
        raw: {
          ...(existingOrder.raw ?? {}),
          trades: matchingTrades,
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
      await estimateKalshiFeeUsd({
        asset: mappedFill.asset,
        contracts: mappedFill.size,
        price: mappedFill.price,
        liquidity: mappedFill.liquidity,
        now,
      });
    await writeFill({
      ...mappedFill,
      feeUsd: estimatedFeeUsd ?? mappedFill.feeUsd,
      raw: {
        ...mappedFill.raw,
        estimatedFeeUsd: explicitFeeUsd === null ? estimatedFeeUsd : undefined,
      },
    });
    touchedIntentLegs.add(`${existingOrder.intentId}:kalshi`);
  }

  for (const entry of touchedIntentLegs) {
    const [intentId, venue] = entry.split(":") as [string, "polymarket" | "kalshi"];
    await syncIntentFromStoredVenueFills(intentId, venue);
  }

  await reconcileLatePrimaryFillRescue(asset, now);
}

function getExplicitKalshiFeeUsd(raw: {
  fees_paid_dollars?: string;
  taker_fees_dollars?: string;
  maker_fees_dollars?: string;
}) {
  const value = raw.fees_paid_dollars ?? raw.taker_fees_dollars ?? raw.maker_fees_dollars;
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

async function writePolymarketFillSafely(
  trade: Parameters<typeof mapPolymarketTradeToFill>[0],
  intentId: string,
  venueOrderId: string,
  stage: "intent_sync" | "reconcile",
) {
  try {
    await writeFill(mapPolymarketTradeToFill(trade, intentId, venueOrderId));
  } catch (error) {
    await writeRunEvent({
      level: "warn",
      eventType: "fills.polymarket.write_failed",
      message: `Polymarket fill write failed during ${stage} for intent ${intentId}`,
      payload: {
        intentId,
        stage,
        venueOrderId,
        tradeId: trade.id,
        error: toErrorMessage(error),
      },
      createdAt: Date.now(),
    });
  }
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
    const primaryOrder = findLatestIntentOrderForLeg(intentOrders, intent.id, primaryLeg);
    const primaryOrderSummary = summarizeIntentLegOrders(intentOrders, primaryLeg, "entry");
    if (
      (!primaryOrderSummary || primaryOrderSummary.filledSize <= 0) &&
      (!primaryOrder || !shouldTreatPrimaryOrderAsFilled(intent, primaryOrder))
    ) {
      continue;
    }

    const hedgeOrder = findLatestIntentOrderForLeg(intentOrders, intent.id, hedgeLeg);
    if (hedgeOrder?.status === "filled" || (hedgeOrder?.filledSize ?? 0) > 0) {
      continue;
    }

    let rescued =
      primaryOrderSummary && primaryOrderSummary.filledSize > 0
        ? updateIntentLegFromFillSummary(intent, primaryLeg.id, primaryOrderSummary, now)
        : updateIntentLeg(intent, primaryLeg.venue, primaryOrder!, "filled", now);
    if (intent.slotEndTs + RESOLUTION_GRACE_MS > now) {
      rescued = markIntentStatus(rescued, "primary_filled", now, "Late primary fill detected; resuming hedge");
      await writeOrderIntent(rescued);
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

    rescued = markIntentStatus(
      rescued,
      "failed",
      now,
      "Late primary fill detected after intent had already failed; manual intervention required",
    );
    await writeOrderIntent(rescued);
    await writeManualInterventionRunEvent(rescued, now, "late_primary_fill_after_failure", {
      venue: intent.primaryVenue,
      orderId: primaryOrder?.venueOrderId ?? primaryOrderSummary?.venueOrderId ?? null,
    });
    await writeCircuitBreaker({
      key: "global",
      active: true,
      reason: "hedge_failure",
      triggeredAt: now,
        payload: {
          intentId: intent.id,
          slotKey: intent.slotKey,
          venue: intent.primaryVenue,
          orderId: primaryOrder?.venueOrderId ?? primaryOrderSummary?.venueOrderId ?? null,
          stage: "late_primary_fill_after_close",
          requiresManualClear: true,
        },
    });
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
    const settled = finalizeIntent({
      intent: settlementIntent,
      polyResolution: venueResolutions.polyResolution,
      kalshiResolution: venueResolutions.kalshiResolution,
      payoutUsd,
      now,
    });
    await writeOrderIntent(settled);
    for (const leg of settled.legs) {
      const resolvedOutcome =
        leg.venue === "polymarket" ? venueResolutions.polyResolution : venueResolutions.kalshiResolution;
      const legPayoutUsd = leg.payoutUsd ?? (leg.outcome === resolvedOutcome ? leg.filledSize : 0);
      await writeSettlement({
        id: `${settled.id}:${leg.venue}:${leg.marketRef}:${leg.outcome}`,
        asset: settled.asset,
        intentId: settled.id,
        venue: leg.venue,
        marketRef: leg.marketRef,
        outcome: leg.outcome,
        resolvedOutcome,
        payoutUsd: legPayoutUsd,
        settledAt: now,
        raw: {
          slotKey: settled.slotKey,
          filledSize: leg.filledSize,
          filledPrice: leg.filledPrice,
          cashAdjustmentUsd: leg.cashAdjustmentUsd ?? 0,
          legPayoutUsd,
          polyResolution: venueResolutions.polyResolution,
          kalshiResolution: venueResolutions.kalshiResolution,
        },
      });
    }
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
      !intent.shadow &&
      intent.resolvedAt !== null &&
      now - intent.resolvedAt <= SETTLED_RESOLUTION_REPAIR_LOOKBACK_MS,
  );

  for (const intent of candidates) {
    await repairSettledIntentResolution(intent, now);
  }
}

async function fetchVenueSettlementResolutions(intent: OrderIntent) {
  const slotSlug = buildPolymarketSlotSlug(intent.asset, intent.slotStartTs);
  const polymarketLeg = intent.legs.find((leg) => leg.venue === "polymarket");
  const kalshiLeg = intent.legs.find((leg) => leg.venue === "kalshi");
  const [polymarketResolution, kalshiResolution] = await Promise.all([
    fetchPolymarketResolution(slotSlug, polymarketLeg?.marketRef).catch(() => null),
    kalshiLeg?.marketRef ? fetchKalshiResolution(kalshiLeg.marketRef).catch(() => null) : Promise.resolve(null),
  ]);

  return deriveSettledVenueResolutions({
    polymarketResolution,
    kalshiResolution,
  });
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
        fetchFinalizedPolymarketResolutionObservation(
          slot.polymarketSlug,
          slot.polymarketMarketRef ?? undefined,
        ).catch(() => null),
        slot.kalshiMarketRef
          ? fetchFinalizedKalshiResolutionObservation(slot.kalshiMarketRef).catch(
              () => null,
            )
          : Promise.resolve(null),
      ]);
      const {
        polymarketResolution: nextPolymarketResolution,
        kalshiResolution: nextKalshiResolution,
      } = mergeObservedSlotResolutionOutcomes({
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
          slot.polymarketSettlementValueUsd ??
          polymarketObservation?.benchmarkValueUsd ??
          null,
        kalshiSettlementValueUsd:
          slot.kalshiSettlementValueUsd ??
          kalshiObservation?.benchmarkValueUsd ??
          null,
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
                  POLY_UP_KALSHI_NO:
                    nextPolymarketResolution === "DOWN" && nextKalshiResolution === "YES",
                  POLY_DOWN_KALSHI_YES:
                    nextPolymarketResolution === "UP" && nextKalshiResolution === "NO",
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

function hasOfficialBenchmarkConflict(
  stored: number | null,
  observed: number | null,
) {
  return (
    stored !== null &&
    observed !== null &&
    Math.abs(stored - observed) > 1e-6
  );
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
      (input.storedSource === "official-venue-resolution"
        ? input.storedPolymarketResolution
        : null),
    kalshiResolution:
      input.fetchedKalshiResolution ??
      (input.storedSource === "official-venue-resolution"
        ? input.storedKalshiResolution
        : null),
  };
}

export function deriveSettledVenueResolutions({
  polymarketResolution,
  kalshiResolution,
}: {
  polymarketResolution: "UP" | "DOWN" | null;
  kalshiResolution: "YES" | "NO" | null;
}) {
  if (!polymarketResolution || !kalshiResolution) {
    return null;
  }

  return {
    polyResolution: polymarketResolution,
    kalshiResolution,
  };
}

async function repairSettledIntentResolution(intent: OrderIntent, now: number) {
  const venueResolutions = await fetchVenueSettlementResolutions(intent);
  if (!venueResolutions) {
    return {
      status: "unavailable" as const,
      intent,
    };
  }

  const refreshedIntent = await refreshIntentFromStoredFills(intent, now);
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

  if (
    intent.polyResolution === venueResolutions.polyResolution &&
    intent.kalshiResolution === venueResolutions.kalshiResolution &&
    intent.realizedPnlUsd === repaired.realizedPnlUsd &&
    intent.roi === repaired.roi
  ) {
    return {
      status: "unchanged" as const,
      intent,
    };
  }

  const repairedIntent: OrderIntent = {
    ...repaired,
    updatedAt: now,
    resolvedAt: intent.resolvedAt ?? repaired.resolvedAt,
  };

  await writeOrderIntent(repairedIntent);
  await updateStablePnlChangeFromIntent(repairedIntent);
  for (const leg of repairedIntent.legs) {
    const resolvedOutcome =
      leg.venue === "polymarket" ? venueResolutions.polyResolution : venueResolutions.kalshiResolution;
    const legPayoutUsd = leg.payoutUsd ?? (leg.outcome === resolvedOutcome ? leg.filledSize : 0);
    await writeSettlement({
      id: `${repairedIntent.id}:${leg.venue}:${leg.marketRef}:${leg.outcome}`,
      asset: repairedIntent.asset,
      intentId: repairedIntent.id,
      venue: leg.venue,
      marketRef: leg.marketRef,
      outcome: leg.outcome,
      resolvedOutcome,
      payoutUsd: legPayoutUsd,
      settledAt: repairedIntent.resolvedAt ?? now,
      raw: {
        slotKey: repairedIntent.slotKey,
        filledSize: leg.filledSize,
        filledPrice: leg.filledPrice,
        cashAdjustmentUsd: leg.cashAdjustmentUsd ?? 0,
        legPayoutUsd,
        polyResolution: venueResolutions.polyResolution,
        kalshiResolution: venueResolutions.kalshiResolution,
        repairedFrom: {
          polyResolution: intent.polyResolution,
          kalshiResolution: intent.kalshiResolution,
          realizedPnlUsd: intent.realizedPnlUsd,
          roi: intent.roi,
        },
      },
    });
  }

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

async function refreshIntentFromStoredFills(intent: OrderIntent, now: number) {
  let refreshed = intent;
  for (const venue of ["polymarket", "kalshi"] as const) {
    refreshed = await syncIntentFromStoredVenueFills(intent.id, venue, refreshed) ?? refreshed;
  }

  refreshed = await applyPolymarketCashAdjustmentFromSnapshots(refreshed, now);

  return {
    ...refreshed,
    updatedAt: now,
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
        (includeShadow || !intent.shadow) &&
        intent.resolvedAt !== null &&
        now - intent.resolvedAt <= lookbackMs,
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

    await writeOrderIntent(
      finalizeUnwoundIntent({
        intent,
        now,
        failureReason: intent.failureReason,
      }),
    );
  }
}

async function reconcileInFlightIntentStates(
  asset: MarketAsset,
  now: number,
  settings: StrategyConfig,
  sharedContext: TickSharedContext = {},
) {
  const openIntents = await readOpenOrderIntents(asset);
  const recentOrders = await readRecentVenueOrders(200, asset);
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
    const primaryOrder = findLatestIntentOrderForLeg(intentOrders, intent.id, primaryLeg);
    const hedgeOrder = findLatestIntentOrderForLeg(intentOrders, intent.id, hedgeLeg);
    const unwindOrder = findLatestIntentReduceOnlyOrder(intentOrders, intent.id, primaryLeg);
    const primaryOrderSummary = summarizeIntentLegOrders(intentOrders, primaryLeg, "entry");
    const stale = isInFlightIntentStale(intent, now);
    let currentIntent = intent;

    if (intent.status === "unwind_required") {
      const primaryVenueFills = await readFillsForIntentVenue(intent.id, primaryLeg.venue);
      const entryFillSummary = summarizeIntentLegFills(primaryVenueFills, primaryLeg, "entry");
      const exitFillSummary = summarizeIntentLegFills(primaryVenueFills, primaryLeg, "exit");
      const entryFilledSize = entryFillSummary?.filledSize ?? primaryLeg.filledSize;
      const exitFilledSize = exitFillSummary?.filledSize ?? 0;
      const liveRemainingSize = deriveLiveRemainingLegSize(livePositions, primaryLeg);
      const remainingExposureSize = deriveRemainingExposureSize(entryFilledSize, exitFilledSize);
      const exitAverageFillPrice =
        exitFillSummary?.averageFillPrice ?? unwindOrder?.averageFillPrice ?? primaryLeg.filledPrice ?? 0;
      const exitFeeUsd = exitFillSummary?.feeUsd ?? (unwindOrder?.feeUsd ?? 0);

      if (entryFillSummary) {
        currentIntent = updateIntentLegFromFillSummary(currentIntent, primaryLeg.id, entryFillSummary, now);
        await writeOrderIntent(currentIntent);
      }

      const hedgeOrderSummary = summarizeIntentLegOrders(intentOrders, hedgeLeg, "entry");
      if (hedgeOrderSummary && hedgeOrderSummary.filledSize > 0) {
        currentIntent = updateIntentLegFromFillSummary(currentIntent, hedgeLeg.id, hedgeOrderSummary, now);
        await writeOrderIntent(currentIntent);
      } else if (hedgeOrder && hedgeOrder.filledSize > 0) {
        currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "submitted", now);
        await writeOrderIntent(currentIntent);
      }

      const exposureResolution = await resolveHedgeExposureBeforePrimaryUnwind(currentIntent, hedgeOrder, settings, now);
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

          currentIntent = finalizeUnwoundIntent({
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
          await writeOrderIntent(currentIntent);
          await recordMarketFillQualityForIntent(currentIntent, "unwind", "primary_unwound_after_reconcile", now, {
            venue: currentIntent.primaryVenue,
            exitFilledSize,
            remainingExposureSize,
          });
          await armRecoveredHedgeFailureCooldown(currentIntent, now, "primary_unwound_after_reconcile");
          continue;
        }
      }

      if (
        (liveRemainingSize <= ORDER_SIZE_TOLERANCE && exitFilledSize > 0) ||
        (exitFillSummary && exitFilledSize + ORDER_SIZE_TOLERANCE >= entryFilledSize && entryFilledSize > 0)
      ) {
        const payoutUsd = round4(exitFilledSize * exitAverageFillPrice - exitFeeUsd);
        currentIntent = finalizeUnwoundIntent({
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
        await writeOrderIntent(currentIntent);
        await recordMarketFillQualityForIntent(currentIntent, "unwind", "primary_unwound_after_reconcile", now, {
          venue: currentIntent.primaryVenue,
          exitFilledSize,
        });
        await armRecoveredHedgeFailureCooldown(currentIntent, now, "primary_unwound_after_reconcile");
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
          );
        }
        continue;
      }

      if (shouldTreatPrimaryUnwindOrderAsComplete(unwindOrder)) {
        await maybeWritePrimaryUnwindFilledSizeMismatchEvent(currentIntent, unwindOrder, now);
        const averageExitPrice = unwindOrder.averageFillPrice ?? primaryLeg.filledPrice ?? 0;
        const payoutUsd = round4(unwindOrder.filledSize * averageExitPrice - (unwindOrder.feeUsd ?? 0));
        currentIntent = finalizeUnwoundIntent({
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
        await writeOrderIntent(currentIntent);
        await armRecoveredHedgeFailureCooldown(currentIntent, now, "primary_unwound_after_reconcile");
        continue;
      }

      if (unwindOrder.filledSize > 0) {
        currentIntent = markIntentStatus(
          currentIntent,
          "unwind_required",
          now,
          `Primary unwind partially filled (${unwindOrder.status}); manual intervention required`,
        );
        await writeOrderIntent(currentIntent);
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
        await writeOrderIntent(currentIntent);
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
      await writeOrderIntent(currentIntent);
      if (currentIntent.status === "primary_filled" || currentIntent.status === "hedging") {
        await writeLiveTradeRunEvent(currentIntent, now, "primary_filled");
      }
    }

    if (!primaryOrder && !primaryOrderSummary) {
      if (intent.status === "executing_primary" && stale) {
        currentIntent = markIntentStatus(
          intent,
          "failed",
          now,
          "Primary order not observed before timeout or slot end",
        );
        await writeOrderIntent(currentIntent);
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
        (
          primaryOrder.venueOrderId !== primaryLeg.venueOrderId ||
          primaryOrder.filledSize !== primaryLeg.filledSize ||
          primaryOrder.averageFillPrice !== primaryLeg.filledPrice ||
          (primaryOrder.feeUsd ?? 0) !== primaryLeg.feeUsd
        )
      ) {
        currentIntent = updateIntentLeg(
          currentIntent,
          primaryLeg.venue,
          primaryOrder,
          shouldTreatPrimaryOrderAsFilled(currentIntent, primaryOrder) ? "filled" : primaryLeg.status,
          now,
        );
        await writeOrderIntent(currentIntent);
      }

      if (
        !primaryOrderSummary &&
        shouldTreatPrimaryOrderAsFilled(currentIntent, primaryOrder) &&
        currentIntent.status === "executing_primary"
      ) {
        currentIntent = markIntentStatus(currentIntent, hedgeOrder ? "hedging" : "primary_filled", now);
        await writeOrderIntent(currentIntent);
        await writeLiveTradeRunEvent(currentIntent, now, "primary_filled");
      }

      if (!primaryOrderSummary && isTerminalOrderStatus(primaryOrder.status) && stale) {
        currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "failed", now);
        currentIntent = markIntentStatus(
          currentIntent,
          "failed",
          now,
          `Primary order ${primaryOrder.status}`,
        );
        await writeOrderIntent(currentIntent);
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

      if (!primaryOrderSummary && stale && isAwaitingOrderConfirmation(primaryOrder.status)) {
        currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "failed", now);
        currentIntent = markIntentStatus(
          currentIntent,
          "failed",
          now,
          `Primary order not completed before timeout or slot end (${primaryOrder.status})`,
        );
        await writeOrderIntent(currentIntent);
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
        (
          currentIntent.status === "primary_filled" ||
          currentIntent.status === "truth_pending" ||
          currentIntent.status === "rescue_hedge" ||
          currentIntent.status === "hedging"
        )
      ) {
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
      await writeOrderIntent(currentIntent);
    }

    if (shouldTreatHedgeOrderAsComplete(hedgeLeg, hedgeOrder)) {
      currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "hedged", now);
      currentIntent = await markIntentHedgedAfterEconomicCheck(currentIntent, now, "reconcile_hedge_filled", hedgeOrder);
      if (currentIntent.status === "hedged") {
        await writeLiveTradeRunEvent(currentIntent, now, "hedged");
      }
      continue;
    }

    if (hedgeOrder.filledSize > 0) {
      currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "submitted", now);
      await writeOrderIntent(currentIntent);
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
      );
      continue;
    }

    if (stale && (isTerminalOrderStatus(hedgeOrder.status) || isAwaitingOrderConfirmation(hedgeOrder.status))) {
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
      );
    }
  }

  await syncActiveSlotExecutionBreakers(now, sharedContext);
}

async function syncActiveSlotExecutionBreakers(now: number, sharedContext: TickSharedContext = {}) {
  const [openIntents, breakers] = await Promise.all([
    sharedContext.openIntents ?? readOpenOrderIntents(),
    sharedContext.circuitBreakers ?? readCircuitBreakers(),
  ]);
  const unresolvedSlots = new Set(
    openIntents
      .filter((intent) =>
        intent.status === "unwind_required" ||
        intent.status === "manual_required" ||
        intent.status === "truth_pending" ||
        intent.status === "rescue_hedge"
      )
      .map((intent) => intent.slotKey),
  );
  const currentSlotKeys = new Set(ACTIVE_MARKET_ASSETS.map((asset) => getCurrentSlot(asset, new Date(now)).key));

  for (const breaker of breakers) {
    if (shouldKeepSlotExecutionBreakerActive(breaker, now, currentSlotKeys, unresolvedSlots)) {
      continue;
    }

    if (!breaker.active || !isSlotExecutionBreakerReason(breaker.reason)) {
      continue;
    }

    if (breaker.key === "global") {
      await writeCircuitBreaker({
        key: "global",
        active: false,
        reason: null,
        triggeredAt: null,
        payload: null,
      });
      continue;
    }

    if (breaker.key.startsWith("slot:")) {
      const slotKey = breaker.key.slice("slot:".length);
      if (!unresolvedSlots.has(slotKey)) {
        await writeCircuitBreaker({
          key: breaker.key,
          active: false,
          reason: null,
          triggeredAt: null,
          payload: null,
        });
      }
    }
  }
}

async function enforceDailyLossCap(now: number) {
  const settingsMap = await readCachedSettingsMap(now);
  const enabled = Object.values(settingsMap).some((settings) => settings.dailyLossCapEnabled);
  if (!enabled) {
    return;
  }
  const capUsd = Math.min(...Object.values(settingsMap).map((settings) => settings.dailyLossHardCapUsd));
  const dayStart = startOfUtcDay(now);
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  const realizedToday = await readStableRealizedPnlSince(dayStart, dayEnd);
  const breakers = await readCircuitBreakers();
  const globalBreaker = breakers.find((breaker) => breaker.key === "global") ?? null;

  if (realizedToday <= -capUsd + ORDER_SIZE_TOLERANCE) {
    if (globalBreaker?.active && globalBreaker.reason === "daily_loss_cap") {
      return;
    }
    await writeCircuitBreaker({
      key: "global",
      active: true,
      reason: "daily_loss_cap",
      triggeredAt: now,
      payload: {
        realizedToday,
        thresholdUsd: -capUsd,
        dayStart,
        requiresManualClear: false,
      },
    });
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
    return;
  }

  if (
    globalBreaker?.active &&
    globalBreaker.reason === "daily_loss_cap" &&
    typeof globalBreaker.payload?.dayStart === "number" &&
    globalBreaker.payload.dayStart < dayStart
  ) {
    await writeCircuitBreaker({
      key: "global",
      active: false,
      reason: null,
      triggeredAt: null,
      payload: null,
    });
  }
}

async function evaluateMarketDegradedBreakers(asset: MarketAsset, now: number) {
  const since = now - MARKET_DEGRADED_WINDOW_MS;
  const degradedCounts = await readDegradedMarketFillQualityCounts(since, asset);
  const breakers = await readCircuitBreakers();
  const degradedSlotKeys = new Set<string>();

  for (const count of degradedCounts) {
    if (count.degradedCount < MARKET_DEGRADED_THRESHOLD) {
      continue;
    }
    degradedSlotKeys.add(count.slotKey);
    const key = buildSlotBreakerKey(count.slotKey);
    const existing = breakers.find((breaker) => breaker.key === key);
    const cooldownUntil = now + MARKET_DEGRADED_COOLDOWN_MS;
    if (existing?.active && existing.reason === "market_degraded") {
      continue;
    }
    await writeCircuitBreaker({
      key,
      active: true,
      reason: "market_degraded",
      triggeredAt: now,
      payload: {
        asset: count.asset,
        slotKey: count.slotKey,
        degradedCount: count.degradedCount,
        windowMs: MARKET_DEGRADED_WINDOW_MS,
        cooldownUntil,
      },
    });
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

  for (const breaker of breakers) {
    if (!breaker.active || breaker.reason !== "market_degraded" || !breaker.key.startsWith("slot:")) {
      continue;
    }
    const slotKey = breaker.key.slice("slot:".length);
    const cooldownUntil = typeof breaker.payload?.cooldownUntil === "number" ? breaker.payload.cooldownUntil : null;
    if (!degradedSlotKeys.has(slotKey) && cooldownUntil !== null && cooldownUntil <= now) {
      await writeCircuitBreaker({
        key: breaker.key,
        active: false,
        reason: null,
        triggeredAt: null,
        payload: null,
      });
    }
  }
}

function startOfUtcDay(now: number) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

async function refreshPnl(now: number, positions: PositionSnapshot[]) {
  const [balances, realizedPnlUsd, feesUsd] = await Promise.all([
    readVenueBalances(),
    readLiveRealizedPnlUsd(),
    readLiveFeesUsd(),
  ]);

  await writePnlSnapshot(
    buildPnlSnapshot({
      capturedAt: now,
      balances,
      positions,
      realizedPnlUsd,
      feesUsd,
    }),
  );
}

async function recordStablePnlChanges(now: number, balances: VenueBalance[], positions: PositionSnapshot[]) {
  const settledIntents = await readRecentSettledOrderIntents(200);
  const candidates = settledIntents.filter((intent) => {
    const settledAt = intent.resolvedAt ?? intent.updatedAt;
    return (
      !intent.shadow &&
      intent.status === "settled" &&
      intent.realizedPnlUsd !== null &&
      now - settledAt <= STABLE_PNL_SETTLED_LOOKBACK_MS
    );
  });

  for (const intent of candidates) {
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
  const polymarketActivePosition = polymarketLeg
    ? hasRiskActivePositionForLeg(positions, polymarketLeg)
    : false;
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
    overridePrice?: number | null;
    polymarketBuyMode?: "shares" | "amount";
  },
): VenueOrderRequest {
  const slippageAdjustedPrice =
    options?.overridePrice !== undefined
      ? options.overridePrice
      : leg.requestedPrice === null ? null : applySlippage(leg.requestedPrice, maxSlippageBps, leg.side);
  const kalshiTickAdjustedPrice =
    leg.venue === "kalshi" && leg.side === "BUY" && options?.kalshiPriceTicksSlippage
      ? normalizeKalshiOrderPrice(
          (leg.requestedPrice ?? 0) + options.kalshiPriceTicksSlippage * KALSHI_ORDER_PRICE_STEP_USD,
          leg.side,
        )
      : null;
  const price =
    leg.venue === "kalshi"
      ? kalshiTickAdjustedPrice ?? normalizeKalshiOrderPrice(slippageAdjustedPrice, leg.side)
      : slippageAdjustedPrice;
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
    buyMode: leg.venue === "polymarket" && leg.side === "BUY"
      ? options?.polymarketBuyMode ?? "shares"
      : undefined,
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

async function submitAndConfirmOrder(input: {
  intent: OrderIntent;
  leg: OrderIntent["legs"][number] & { side?: "BUY" | "SELL" };
  request: VenueOrderRequest;
  stage: string;
  now: number;
  timeoutMs: number;
  deferConfirmedPersistence?: boolean;
}) {
  input.request.clientOrderId = buildStableClientOrderId(input);
  const attemptId = `${input.intent.id}:${input.leg.id}:${input.stage}:${input.request.clientOrderId}`;
  const reusableAttempt = await findReusableOrderAttempt(input, attemptId);
  if (reusableAttempt) {
    return reusableAttempt;
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
    status: "planned",
    truthStatus: null,
    request: serializeVenueOrderRequest(input.request),
    result: null,
    error: null,
    createdAt: input.now,
    updatedAt: input.now,
  });

  let acknowledgedSubmission: Awaited<ReturnType<VenueAdapter["placeOrder"]>> | null = null;
  let acknowledgedAt: number | null = null;
  let submissionStartedAt: number | null = null;
  try {
    const submitStartedAt = Date.now();
    submissionStartedAt = submitStartedAt;
    const submission = await adapterFor(input.leg.venue).placeOrder(input.request);
    const venueAckAt = Date.now();
    acknowledgedSubmission = submission;
    acknowledgedAt = venueAckAt;
    const submittedTiming: OrderExecutionTiming = {
      quoteObservedAt: input.intent.createdAt,
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

    const result = await confirmImmediateOrderExecution(
      input.leg.venue,
      input.request,
      submission,
      input.timeoutMs,
    );
    const timing: OrderExecutionTiming = {
      ...submittedTiming,
      fillObservedAt: Date.now(),
    };
    const order = buildLiveOrderRecord(input.intent.asset, input.intent.id, input.leg, input.request, result, input.now);
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
    const recovered = await recoverSubmittedKalshiOrderAttempt(input, attemptId);
    if (recovered) {
      return recovered;
    }

    if (acknowledgedSubmission) {
      const timing: OrderExecutionTiming = {
        quoteObservedAt: input.intent.createdAt,
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
        venueOrderId: acknowledgedSubmission.venueOrderId,
        status: "submitted",
        truthStatus: extractVenueTruthStatus(acknowledgedSubmission.raw) ?? "truth_pending",
        request: serializeVenueOrderRequest(input.request),
        result: {
          ...serializeVenueOrderResult(acknowledgedSubmission),
          executionTiming: timing,
        },
        error: `Confirmation failed after venue acknowledgement: ${toErrorMessage(error)}`,
        createdAt: input.now,
        updatedAt: Date.now(),
      });
      const order = buildLiveOrderRecord(
        input.intent.asset,
        input.intent.id,
        input.leg,
        input.request,
        acknowledgedSubmission,
        input.now,
      );
      await writeVenueOrder(order);
      return {
        submission: acknowledgedSubmission,
        result: acknowledgedSubmission,
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
      status: "failed",
      truthStatus: null,
      request: serializeVenueOrderRequest(input.request),
      result: null,
      error: toErrorMessage(error),
      createdAt: input.now,
      updatedAt: Date.now(),
    });
    throw error;
  }
}

function buildStableClientOrderId(input: {
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
    size: input.request.size,
    price: input.request.price,
    maxCostUsd: input.request.maxCostUsd,
    orderType: input.request.orderType,
    buyMode: input.request.buyMode ?? null,
    reduceOnly: input.request.reduceOnly ?? false,
  });
  return `wa-${stableHexHash(seed, 30)}`;
}

function stableHexHash(value: string, length: number) {
  let hashA = 0x811c9dc5;
  let hashB = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hashA ^= code;
    hashA = Math.imul(hashA, 0x01000193) >>> 0;
    hashB ^= code + index;
    hashB = Math.imul(hashB, 0x85ebca6b) >>> 0;
  }
  const hex = `${hashA.toString(16).padStart(8, "0")}${hashB.toString(16).padStart(8, "0")}`;
  return hex.repeat(Math.ceil(length / hex.length)).slice(0, length);
}

async function findReusableOrderAttempt(
  input: {
    intent: OrderIntent;
    leg: OrderIntent["legs"][number] & { side?: "BUY" | "SELL" };
    request: VenueOrderRequest;
    stage: string;
    now: number;
    timeoutMs: number;
  },
  attemptId: string,
) {
  const existing = await findOrderAttemptById(attemptId);

  if (!existing) {
    return null;
  }

  if (existing.status === "confirmed" && existing.result) {
    const result = deserializeVenueOrderResult(existing.result, input.leg.venue, existing.venueOrderId);
    const order = buildLiveOrderRecord(input.intent.asset, input.intent.id, input.leg, input.request, result, input.now);
    await writeVenueOrder(order);
    return {
      submission: result,
      result,
      order,
    };
  }

  if ((existing.status === "submitted" || existing.status === "failed") && existing.venueOrderId) {
    const submission = existing.result
      ? deserializeVenueOrderResult(existing.result, input.leg.venue, existing.venueOrderId)
      : buildPendingVenueOrderResult(input.leg.venue, existing.venueOrderId, {
          recoveredFromOrderAttempt: true,
          clientOrderId: existing.clientOrderId,
        });
    const result = await confirmImmediateOrderExecution(input.leg.venue, input.request, submission, input.timeoutMs);
    const order = buildLiveOrderRecord(input.intent.asset, input.intent.id, input.leg, input.request, result, input.now);
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

  if (existing.status === "planned" && input.leg.venue === "kalshi") {
    return recoverSubmittedKalshiOrderAttempt(input, attemptId);
  }

  throw new Error(`Existing ${input.stage} order attempt ${existing.id} has no reusable venue truth; resubmission blocked`);
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
    venueOrderId: typeof result.venueOrderId === "string" ? result.venueOrderId : fallbackOrderId ?? "unknown",
    status: isVenueOrderStatus(result.status) ? result.status : "pending",
    filledSize: typeof result.filledSize === "number" ? result.filledSize : 0,
    averageFillPrice: typeof result.averageFillPrice === "number" ? result.averageFillPrice : null,
    feeUsd: typeof result.feeUsd === "number" ? result.feeUsd : 0,
    raw: result.raw && typeof result.raw === "object" ? result.raw as Record<string, unknown> : result,
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
      modelVersion: SHADOW_EXECUTION_MODEL_VERSION,
      restStartedAt: intent.shadowExecution?.restStartedAt ?? null,
      completionNotBeforeAt: intent.shadowExecution?.completionNotBeforeAt ?? null,
    },
  };
}

function buildCompletedShadowOrder(
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
  decision: ShadowPairExecutionDecision,
  audit: NonNullable<OrderIntent["shadowExecution"]>,
  now: number,
): LiveOrder {
  const suffix = leg.venue === intent.primaryVenue ? "primary" : "hedge";
  const pending = buildPendingShadowOrder(intent, leg, intent.createdAt, suffix);
  const capacity = decision.legs.find((candidate) => candidate.leg.venue === leg.venue);
  const quote = decision.status === "filled" ? capacity?.quote ?? null : null;
  return {
    ...pending,
    filledSize: decision.status === "filled" ? decision.filledPairSize : 0,
    averageFillPrice: quote?.vwapPrice ?? null,
    feeUsd: quote?.feeUsd ?? 0,
    status:
      decision.status === "no_fill"
        ? "canceled"
        : decision.filledPairSize + ORDER_SIZE_TOLERANCE >= leg.requestedSize
          ? "filled"
          : "partially_filled",
    updatedAt: now,
    raw: {
      ...pending.raw,
      evaluatedAt: now,
      latencyMs: audit.latencyMs,
      restFetchDurationMs: audit.restFetchDurationMs,
      nextEligibleAt: audit.nextEligibleAt,
      decision: decision.status,
      reasonCode: decision.reasonCode,
      reason: decision.reason,
      limitPrice: capacity?.limitPrice ?? null,
      executableSize: capacity?.executableSize ?? 0,
      consumedLevels: quote?.consumedLevels ?? [],
    },
  };
}

function buildShadowFill(
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
  order: LiveOrder,
  quote: NonNullable<ReturnType<typeof quoteMultiLevelBuyLeg>>,
  audit: NonNullable<OrderIntent["shadowExecution"]>,
  now: number,
) {
  return {
    id: `shadow-fill:${intent.id}:${leg.venue}:${leg.outcome}:${now}`,
    asset: intent.asset,
    shadow: true,
    intentId: intent.id,
    venue: leg.venue,
    venueOrderId: order.venueOrderId,
    tradeId: `shadow-trade:${intent.id}:${leg.venue}:${now}`,
    marketRef: leg.marketRef,
    tokenId: leg.tokenId,
    side: leg.side,
    outcome: leg.outcome,
    price: quote.vwapPrice ?? 0,
    size: order.filledSize,
    feeUsd: quote.feeUsd,
    liquidity: "TAKER" as const,
    filledAt: now,
    raw: {
      shadow: true,
      modelVersion: SHADOW_EXECUTION_MODEL_VERSION,
      latencyMs: audit.latencyMs,
      limitPrice: quote.limitPrice,
      requestedSize: leg.requestedSize,
      fillRatio: audit.fillRatio,
      consumedLevels: quote.consumedLevels,
    },
  };
}

function updateIntentLeg(
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

      const filledSize =
        leg.venue === "polymarket"
          ? Math.max(leg.filledSize, order.filledSize)
          : order.filledSize || leg.filledSize;
      return {
        ...leg,
        venueOrderId: order.venueOrderId,
        filledSize,
        filledPrice: order.averageFillPrice ?? leg.filledPrice,
        filledAt:
          order.filledSize > 0
            ? Math.max(leg.filledAt ?? 0, order.updatedAt)
            : leg.filledAt,
        feeUsd: order.feeUsd ?? leg.feeUsd,
        status,
      };
    }) as OrderIntent["legs"],
  };
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

      return {
        ...leg,
        venueOrderId: order.venueOrderId,
        filledSize: nextFilledSize,
        filledPrice: nextFilledSize > 0 ? round4(nextGrossNotionalUsd / nextFilledSize) : leg.filledPrice,
        filledAt:
          order.filledSize > 0
            ? Math.max(leg.filledAt ?? 0, order.updatedAt)
            : leg.filledAt,
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

      const filledSize = leg.venue === "polymarket" ? Math.max(leg.filledSize, summary.filledSize) : summary.filledSize;
      return {
        ...leg,
        venueOrderId: summary.venueOrderId ?? leg.venueOrderId,
        filledSize,
        filledPrice: summary.filledSize >= leg.filledSize ? summary.averageFillPrice : leg.filledPrice,
        filledAt:
          summary.filledSize > 0
            ? Math.max(leg.filledAt ?? 0, summary.lastFilledAt ?? now)
            : leg.filledAt,
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
  leg: Pick<OrderIntent["legs"][number], "venue" | "marketRef" | "outcome" | "tokenId" | "side">,
  mode: "entry" | "exit",
) {
  const expectedSide = mode === "entry" ? leg.side : leg.side === "BUY" ? "SELL" : "BUY";
  const matchingOrders = orders.filter(
    (order) =>
      order.venue === leg.venue &&
      order.marketRef === leg.marketRef &&
      order.outcome === leg.outcome &&
      order.side === expectedSide &&
      (leg.tokenId === undefined || order.tokenId === undefined || order.tokenId === leg.tokenId),
  );
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
  const intent = currentIntent ?? (await findOrderIntent(intentId));
  if (!intent) {
    return currentIntent ?? null;
  }

  const fills = await readFillsForIntentVenue(intentId, venue);
  if (fills.length === 0) {
    return intent;
  }

  const leg = intent.legs.find((candidate) => candidate.venue === venue);
  if (!leg) {
    return intent;
  }

  const summary = summarizeIntentLegFills(fills, leg, "entry");
  if (!summary) {
    return intent;
  }

  const updatedIntent = updateIntentLegFromFillSummary(intent, leg.id, summary, Date.now());
  await writeOrderIntent(updatedIntent);
  return updatedIntent;
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
  let fillWakeup: Promise<boolean> | null = marketDataSupervisor.waitForOrderFill({
    venue,
    venueOrderId: submission.venueOrderId,
    clientOrderId: request.clientOrderId,
    marketRef: request.marketRef,
    timeoutMs,
  }).then(
    () => true,
    () => true,
  );
  while (Date.now() <= deadline) {
    const liveOrder = await kalshiAdapter.getOrder(submission.venueOrderId).catch(() => null);
    if (liveOrder) {
      latest = normalizeOrderResultFromLiveOrder(liveOrder, submission.raw);
      if (latest.status !== "live" && latest.status !== "pending") {
        return latest;
      }
    }
    if (fillWakeup) {
      const wokeForFill = await Promise.race([
        sleep(200).then(() => false),
        fillWakeup,
      ]);
      if (wokeForFill) {
        fillWakeup = null;
      }
    } else {
      await sleep(200);
    }
  }

  if (request.orderType === "FOK" && (latest.status === "live" || latest.status === "pending")) {
    await kalshiAdapter.cancelOrder(submission.venueOrderId).catch(() => null);
    const liveOrder = await kalshiAdapter.getOrder(submission.venueOrderId).catch(() => null);
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

  const kalshiOrders = await fetchKalshiOrders().catch(() => []);
  const recoveredOrder = kalshiOrders.find((order) => order.client_order_id === request.clientOrderId);
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

export function isFeedHealthBreaker(
  breaker: Pick<CircuitBreaker, "reason" | "payload"> | null | undefined,
) {
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

function describeCircuitBreakerForReadiness(
  breaker: Pick<CircuitBreaker, "key" | "payload" | "reason">,
  now: number,
) {
  const cooldownUntil = getPayloadNumber(breaker.payload, "cooldownUntil");
  const remainingMs = cooldownUntil === null ? null : Math.max(0, cooldownUntil - now);
  return remainingMs === null
    ? `${breaker.key}:${breaker.reason}`
    : `${breaker.key}:${breaker.reason}:retry_in=${remainingMs}ms`;
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
    "venue" | "requestedNotionalUsd" | "requestedPrice" | "requestedSize" | "side" | "outcome" | "id" | "intentId" | "status" | "marketRef"
  >,
  liveLeg: {
    price: number | null;
    depth: number | null;
    minOrderSize: number | null;
    tickSize?: number | null;
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

export function isPrimaryFillSizeHedgable(
  intent: Pick<OrderIntent, "primaryVenue">,
  order: Pick<LiveOrder, "filledSize" | "requestedSize">,
) {
  if (order.filledSize <= 0) {
    return false;
  }

  return (
    intent.primaryVenue === "kalshi" ||
    order.filledSize + ORDER_SIZE_TOLERANCE >= order.requestedSize
  );
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
  intent: Pick<OrderIntent, "id" | "asset" | "shadow" | "slotKey" | "combination" | "primaryVenue" | "hedgeVenue" | "legs">,
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

async function canSafelyLeadWithPolymarket(intent: OrderIntent, slot: MarketSlot, settings: StrategyConfig, now: number) {
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

  await writeCircuitBreaker({
    key: buildSlotBreakerKey(intent.slotKey),
    active: true,
    reason: "primary_no_fill",
    triggeredAt: now,
    payload: {
      intentId: intent.id,
      slotKey: intent.slotKey,
      venue: intent.primaryVenue,
      stage: "primary_no_fill_cooldown",
      primaryOrderId: primaryOrder.venueOrderId,
      cooldownUntil: now + PRIMARY_NO_FILL_COOLDOWN_MS,
      softNoFill: true,
    },
  });
}

async function armHedgeFailureGuards(
  intent: OrderIntent,
  hedgeOrder: LiveOrder | null,
  _hedgeResult: Awaited<ReturnType<VenueAdapter["placeOrder"]>> | null,
  now: number,
) {
  await writeCircuitBreaker({
    key: buildSlotBreakerKey(intent.slotKey),
    active: true,
    reason: "hedge_failure",
    triggeredAt: now,
    payload: {
      intentId: intent.id,
      slotKey: intent.slotKey,
      venue: intent.hedgeVenue,
      stage: "hedge_failure_unwind_pending",
      hedgeOrderId: hedgeOrder?.venueOrderId ?? null,
      cooldownUntil: now + HEDGE_FAILURE_UNWIND_PENDING_COOLDOWN_MS,
    },
  });
}

async function armRecoveredHedgeFailureCooldown(intent: OrderIntent, now: number, stage: string) {
  await writeCircuitBreaker({
    key: buildSlotBreakerKey(intent.slotKey),
    active: true,
    reason: "hedge_failure",
    triggeredAt: now,
    payload: {
      intentId: intent.id,
      slotKey: intent.slotKey,
      venue: intent.hedgeVenue,
      stage,
      recovered: true,
      cooldownUntil: now + HEDGE_FAILURE_RECOVERED_COOLDOWN_MS,
    },
  });
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

function getAssetFromSlotKey(slotKey: string | null | undefined): MarketAsset | null {
  if (!slotKey) {
    return null;
  }

  const [candidate] = slotKey.split(":");
  return candidate && isMarketAsset(candidate) ? candidate : null;
}

function getBreakerAsset(key: CircuitBreaker["key"]): MarketAsset | null {
  if (key.startsWith("asset:")) {
    const candidate = key.slice("asset:".length);
    return isMarketAsset(candidate) ? candidate : null;
  }

  if (key.startsWith("slot:")) {
    return getAssetFromSlotKey(key.slice("slot:".length));
  }

  return null;
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
  return failureReason.toLowerCase().includes("primary unwound")
    ? failureReason
    : `${failureReason}; primary unwound`;
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

function findLatestIntentOrderForLeg(
  recentOrders: LiveOrder[],
  intentId: string,
  leg: OrderIntent["legs"][number],
) {
  return recentOrders.find(
    (order) =>
      order.intentId === intentId &&
      order.venue === leg.venue &&
      order.side === leg.side,
  ) ?? null;
}

function findLatestIntentReduceOnlyOrder(
  recentOrders: LiveOrder[],
  intentId: string,
  leg: OrderIntent["legs"][number],
) {
  return recentOrders.find(
    (order) =>
      order.intentId === intentId &&
      order.venue === leg.venue &&
      order.side === "SELL",
  ) ?? null;
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
  if (
    lastDatabaseMaintenanceAttemptAt !== null &&
    now - lastDatabaseMaintenanceAttemptAt < config.intervalMs
  ) {
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

  return !Boolean(findLatestIntentReduceOnlyOrder(recentOrders, intent.id, primaryLeg));
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
      position.venue === leg.venue &&
      position.marketRef === leg.marketRef &&
      position.outcome === leg.outcome,
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

  const deferredIntent: OrderIntent = {
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

  await writeOrderIntent(deferredIntent);
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
    await withTimeout(fn, RECONCILE_STEP_TIMEOUT_MS, `reconcile step ${step} timed out after ${RECONCILE_STEP_TIMEOUT_MS}ms`);
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
