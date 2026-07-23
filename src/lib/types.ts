import type { CircuitBreakerIncident, CircuitBreakerRecoveryProof } from "@/lib/circuit-breaker-policy";

export type MarketAsset = "btc" | "eth" | "sol" | "xrp" | "doge" | "bnb" | "hype";
export type AssetScoped<T> = Record<MarketAsset, T>;
export type Venue = "polymarket" | "kalshi";
export type PairCombination = "POLY_UP_KALSHI_NO" | "POLY_DOWN_KALSHI_YES";
export type Resolution = "UP" | "DOWN" | "YES" | "NO";
export type OrderSide = "BUY" | "SELL";
export type WorkerPhase = "idle" | "scan" | "execute" | "reconcile";
export type WorkerRole = "asset-live" | "reconciler" | "notifier" | "legacy";
export type ReadinessStatus = "ready" | "cooldown" | "degraded" | "blocked";
export type FeedSource = "ws" | "rest-bootstrap" | "rest-fallback" | "unavailable";
export type SubscriptionStatus = "idle" | "connecting" | "subscribed" | "error" | "closed";
export type OrderIntentStatus =
  | "pending"
  | "executing_primary"
  | "primary_filled"
  | "hedging"
  | "truth_pending"
  | "rescue_hedge"
  | "hedged"
  | "unwind_required"
  | "manual_required"
  | "unwound"
  | "settled"
  | "failed"
  | "skipped"
  | "canceled";
export type VenueOrderStatus = "pending" | "live" | "partially_filled" | "filled" | "canceled" | "rejected" | "expired";
export type ExecutionLegStatus = "pending" | "submitted" | "filled" | "hedged" | "unwound" | "failed";
export type CircuitBreakerKey = "global" | `asset:${MarketAsset}` | `slot:${MarketAsset}:${string}`;
export type CircuitBreakerReason =
  | "manual"
  | "hedge_failure"
  | "primary_no_fill"
  | "readiness_failed"
  | "venue_error"
  | "risk_limit"
  | "daily_loss_cap"
  | "market_degraded"
  | "rpc_unhealthy";
export type PrimarySelectionMode = "kalshi_only" | "shadow" | "dynamic";
export type MismatchRiskMode = "shadow" | "block_only" | "enforce";
export type BridgeTransferStatus = "idle" | "quoted" | "pending" | "completed" | "failed";
export type RunEventLevel = "info" | "warn" | "error";
export type NotificationKind = "trade_live" | "manual_intervention" | "incident";
export type NotificationChannel = "telegram";
export type NotificationDeliveryStatus = "pending" | "sent" | "failed";

export type MarketSlot = {
  asset: MarketAsset;
  key: string;
  startTs: number;
  endTs: number;
  startIso: string;
  endIso: string;
  label: string;
  polymarketSlug: string;
  secondsRemaining: number;
};

export type VenueMarketRef = {
  asset: MarketAsset;
  venue: Venue;
  id: string;
  title: string;
  url: string;
  startTime: string;
  endTime: string;
  slotKey?: string;
  ticker?: string;
  eventTicker?: string;
  slug?: string;
  conditionId?: string;
  tokenId?: string;
};

export type ExecutionPriceSurface = {
  buyPrice: number | null;
  sellPrice: number | null;
  midPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  depth: number | null;
  tickSize: number | null;
  minOrderSize: number | null;
  feeRateBps: number | null;
};

export type ChartPriceSurface = {
  label: "best_ask_live";
  price: number | null;
  source: FeedSource;
  lastUpdatedAt: number | null;
};

export type OutcomeQuote = {
  outcome: Resolution;
  buyPrice: number | null;
  sellPrice: number | null;
  midPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  depth: number | null;
  tickSize: number | null;
  minOrderSize: number | null;
  feeRateBps: number | null;
  execution: ExecutionPriceSurface;
  chart: ChartPriceSurface;
};

export type VenueSubscriptionState = {
  channel: string;
  status: SubscriptionStatus;
  source: FeedSource;
  lastMessageAt: number | null;
  details: string | null;
};

export type VenueFeedHealth = {
  asset: MarketAsset;
  venue: Venue;
  feedStatus: ReadinessStatus;
  source: FeedSource;
  lastMessageAt: number | null;
  stalenessMs: number | null;
  details: string[];
  subscriptions: VenueSubscriptionState[];
};

export type PolymarketQuote = {
  ref: VenueMarketRef;
  status: "open" | "closed";
  slotAligned: boolean;
  availabilityReason: string | null;
  feedHealth: VenueFeedHealth;
  lastMessageAt: number | null;
  stalenessMs: number | null;
  source: FeedSource;
  conditionId: string;
  outcomes: {
    up: OutcomeQuote;
    down: OutcomeQuote;
  };
  resolution: "UP" | "DOWN" | null;
  tokenIds: {
    up: string;
    down: string;
  };
  orderbookLevels?: {
    upBids: Array<[number, number]>;
    upAsks: Array<[number, number]>;
    downBids: Array<[number, number]>;
    downAsks: Array<[number, number]>;
  } | null;
  chainlinkLivePriceUsd: number | null;
  chainlinkLivePriceCapturedAt: number | null;
  observedSlotOpenPriceUsd: number | null;
  observedSlotOpenCapturedAt: number | null;
  feeRateBps: number;
  feeRate?: number | null;
  feeExponent?: number | null;
  /** True only when the CLOB response carried an explicit fee-data object. */
  feeMetadataPresent?: boolean;
  /** Exact enabled/disabled state; null or absent means fee provenance is unknown. */
  feesEnabled?: boolean | null;
  negRisk: boolean;
};

export type KalshiCfBenchmarkIndexId =
  "BRTI" | "ETHUSD_RTI" | "SOLUSD_RTI" | "XRPUSD_RTI" | "DOGEUSD_RTI" | "BNBUSD_RTI" | "HYPEUSD_RTI";

export type KalshiCfBenchmarkWindow = {
  valueUsd: number;
  windowSize: number;
  windowStartTsMs: number;
  windowEndTsExclusive: number;
};

export type KalshiCfBenchmarkState = {
  indexId: KalshiCfBenchmarkIndexId;
  liveValueUsd: number;
  sourceTimestampMs: number;
  receivedAtMs: number;
  capturedAt: number;
  trailing60s: KalshiCfBenchmarkWindow;
  finalMinuteAverage15m: KalshiCfBenchmarkWindow | null;
};

export type KalshiPriceRange = {
  start: string;
  end: string;
  step: string;
};

export type KalshiQuote = {
  ref: VenueMarketRef;
  status: string;
  slotAligned: boolean;
  availabilityReason: string | null;
  feedHealth: VenueFeedHealth;
  lastMessageAt: number | null;
  stalenessMs: number | null;
  source: FeedSource;
  outcomes: {
    yes: OutcomeQuote;
    no: OutcomeQuote;
  };
  targetPriceUsd: number | null;
  resolution: "YES" | "NO" | null;
  feeMultiplier: number;
  feeType: string;
  lastTradeYesPrice: number | null;
  lastTradeNoPrice: number | null;
  priceLevelStructure: string | null;
  priceRanges: KalshiPriceRange[] | null;
  cfBenchmarks?: KalshiCfBenchmarkState | null;
  orderbookLevels?: {
    yesBids: Array<[number, number]>;
    noBids: Array<[number, number]>;
  } | null;
};

export type StrategyConfig = {
  enableTrading: boolean;
  shadowMode: boolean;
  maxPairNotionalUsd: number;
  maxLegCapitalShare: number;
  maxSignalAgeMs: number;
  grossEntryThreshold: number;
  minProjectedNetProfitUsd: number;
  minProjectedNetReturn: number;
  minWorstCaseProfitUsd: number;
  maxLegPrice: number;
  reentryImprovement: number;
  pollingIntervalMs: number;
  minOrderSize: number;
  maxSlippageBps: number;
  primarySelectionMode: PrimarySelectionMode;
  minimumEntryDepthCoverageRatio: number;
  adaptiveSlippageTightBps: number;
  adaptiveSlippageDefaultBps: number;
  adaptiveSlippageThinBps: number;
  dailyLossCapEnabled: boolean;
  dailyLossHardCapUsd: number;
  immediateOrderConfirmationTimeoutMs: number;
  executionPriceBuffer: number;
  kalshiDepthHeadroomContracts: number;
  kalshiPrimaryDepthSafetyFactor: number;
  kalshiPrimaryPriceTicksSlippage: number;
  kalshiPrimaryProbeClipContracts: number;
  kalshiPrimaryMaxClipContracts: number;
  kalshiPrimaryMaxClips: number;
  polymarketHedgeDepthSafetyFactor: number;
  polymarketHedgeHeadroomShares: number;
  polymarketHedgeBookMaxAgeMs: number;
  primaryRetryAttempts: number;
  primaryRetryDelayMs: number;
  hedgeRetryAttempts: number;
  hedgeRetryDelayMs: number;
  hedgeRescueEnabled: boolean;
  hedgeRescueMaxAttempts: number;
  hedgeRescueDelayMs: number;
  hedgeRescueMaxLossUsd: number;
  hedgeRescueMinAdvantageUsd: number;
  hedgeRescueAllowPartial: boolean;
  forcedUnwindEnabled: boolean;
  forcedUnwindMaxAttempts: number;
  forcedUnwindTickLadder: readonly number[];
  forcedUnwindMaxLossUsd: number;
  forcedUnwindHoldSecondsToSettlement: number;
  entryCutoffSeconds: number;
  maxOpenIntentsPerSlot: number;
  maxVenueExposureUsd: number;
  polyBridgeLowWaterUsdc: number;
  mismatchGuardEnabled: boolean;
  mismatchGuardMinElapsedSeconds: number;
  mismatchGuardMinMoveBps: number;
  mismatchGuardPhase2StartSeconds: number;
  mismatchGuardPhase2MinMoveBps: number;
  mismatchGuardMaxVenueDisagreementPct: number;
  mismatchRiskMode: MismatchRiskMode;
};

export type StrategyConfigMap = AssetScoped<StrategyConfig>;

export type VersionedConfiguration<T> = {
  config: T;
  revision: number;
  updatedAt: number;
};

export type VersionedStrategyConfig = VersionedConfiguration<StrategyConfig> & {
  asset: MarketAsset;
};

export type VersionedStrategyConfigMap = AssetScoped<VersionedStrategyConfig>;

export type ConfigurationMutationContext = {
  actor: string;
  requestId: string;
};

export type ConfigurationRevisionConflict = {
  configurationType: "strategy" | "global_risk";
  key: string;
  expectedRevision: number;
  actualRevision: number;
};

export type StrategyConfigUpdate = {
  config: StrategyConfig;
  expectedRevision: number;
};

export type StrategyConfigMapUpdate = AssetScoped<StrategyConfigUpdate>;

export type VenueBalance = {
  venue: Venue;
  capturedAt: number;
  status: ReadinessStatus;
  currency: "USD" | "USDC" | "pUSD";
  availableBalanceUsd: number;
  totalBalanceUsd: number;
  portfolioValueUsd: number;
  allowanceUsd: number | null;
  notes: string[];
  raw: Record<string, unknown>;
};

export type ReadinessCheck = {
  key: string;
  label: string;
  status: ReadinessStatus;
  details: string;
  checkedAt: number;
};

export type OpportunityLeg = {
  venue: Venue;
  outcome: Resolution;
  marketRef: string;
  tokenId?: string;
  price: number | null;
  depth: number | null;
  targetNotionalUsd: number;
  size: number;
  tickSize: number | null;
  minOrderSize: number | null;
  feeEstimateUsd: number;
};

export type LiveOpportunity = {
  asset: MarketAsset;
  id: string;
  slotKey: string;
  capturedAt: number;
  combination: PairCombination;
  label: string;
  grossCost: number | null;
  threshold: number;
  thresholdMet: boolean;
  worstCaseProfitUsd: number | null;
  fatalMismatchPnlUsd?: number | null;
  conservativeExpectedPnlUsd?: number | null;
  mismatchRiskEstimate?: MismatchRiskEstimate | null;
  mismatchRiskAudit?: MismatchRiskAudit | null;
  eligible: boolean;
  primaryVenue: Venue | null;
  primarySelection: PrimarySelectionAudit | null;
  improvementFromLastEntry: number | null;
  estimatedFeesUsd: number;
  projectedNetProfitUsd: number | null;
  projectedNetReturn: number | null;
  reasons: string[];
  legs: [OpportunityLeg, OpportunityLeg];
  mismatchGuardAction: "allow" | "reduce_size" | "block";
  mismatchSizeMultiplier: number;
  referencePayoutCount: number | null;
  deadZoneDistanceBps: number | null;
  deadZoneWidthBps: number | null;
  mismatchRisk: "low" | "medium" | "high" | null;
  venueDisagreementPct: number | null;
  secondsElapsedInSlot: number | null;
  chainlinkMoveBps: number | null;
  openDriftBps: number | null;
  chainlinkLivePriceUsd: number | null;
  observedSlotOpenPriceUsd: number | null;
  kalshiTargetPriceUsd: number | null;
};

export type MismatchEconomicsBasis = "executable" | "reference" | "unavailable";

export type MismatchRiskCounterfactualDecision =
  "would_allow" | "would_block" | "would_allow_fail_open" | "reference_allow" | "reference_block" | "unavailable";

export type MismatchRiskAudit = {
  evaluatedAt: number;
  policyMode: "block_only";
  decision: MismatchRiskCounterfactualDecision;
  source: "scan" | "execution" | "reconstructed";
  baseEligible: boolean;
  baseReasons: string[];
  blockingReasonCodes: string[];
  blockingReasons: string[];
  diagnosticReasonCodes: string[];
  economicsBasis: MismatchEconomicsBasis;
  pairSize: number | null;
  totalCostUsd: number | null;
  breakEvenFatalProbability: number | null;
  maximumAllowedFatalProbability: number | null;
  pFatal: number | null;
  pFatalUpper95: number | null;
  conservativePnlUsd: number | null;
  fatalPnlUsd: number | null;
  estimateAvailable: boolean;
  executionUsable: boolean;
  executionReason: string | null;
  modelVersion: string;
  enforceReady: boolean;
  enforceReasons: string[];
  legacyGuardAction: "allow" | "reduce_size" | "block";
  legacySizeMultiplier: number;
};

export type MismatchRiskEstimate = {
  available: boolean;
  executionUsable?: boolean;
  executionReason?: string | null;
  modelVersion: string;
  reason: string | null;
  pFatal: number | null;
  pFatalUpper95: number | null;
  pAligned: number | null;
  pDouble: number | null;
  expectedPnlUsd: number | null;
  conservativePnlUsd: number | null;
  fatalPnlUsd: number | null;
  breakEvenFatalProbability: number | null;
  maximumAllowedFatalProbability: number | null;
  chainlinkAgeMs: number | null;
  cfAgeMs: number | null;
  sourceTimestampSkewMs?: number | null;
  observationCount: number;
  economicsBasis?: MismatchEconomicsBasis;
  economicsPairSize?: number | null;
  economicsTotalCostUsd?: number | null;
};

export type PrimarySelectionAudit = {
  mode: PrimarySelectionMode;
  livePrimaryVenue: Venue | null;
  recommendedPrimaryVenue: Venue | null;
  polymarketScore: number | null;
  kalshiScore: number | null;
  polymarketCoveredSize: number | null;
  kalshiCoveredSize: number | null;
  polymarketCoverageRatio: number | null;
  kalshiCoverageRatio: number | null;
  reason: string | null;
};

export type OpportunitySnapshot = {
  id?: number;
  asset: MarketAsset;
  slotKey: string;
  slotStartTs: number;
  slotEndTs: number;
  capturedAt: number;
  polymarket: PolymarketQuote;
  kalshi: KalshiQuote;
  opportunities: LiveOpportunity[];
};

export type OrderIntentLeg = {
  id: string;
  intentId: string;
  venue: Venue;
  outcome: Resolution;
  marketRef: string;
  tokenId?: string;
  side: OrderSide;
  requestedPrice: number | null;
  requestedSize: number;
  requestedNotionalUsd: number;
  /** Durable worst-fill cost, including fees, reserved for this venue. */
  worstFillCostUsd?: number;
  /** Additional durable recovery envelope reserved on the hedge venue. */
  recoveryReserveUsd?: number;
  filledPrice: number | null;
  filledSize: number;
  /** Latest observed fill timestamp used to retire stale cash reservations safely. */
  filledAt?: number;
  feeUsd: number;
  cashAdjustmentUsd?: number;
  status: ExecutionLegStatus;
  venueOrderId: string | null;
  payoutUsd: number | null;
  resolvedOutcome: Resolution | null;
};

export type ShadowExecutionAudit = {
  modelVersion: string;
  status: "scheduled" | "filled" | "no_fill";
  scheduledAt: number;
  completionNotBeforeAt: number;
  restStartedAt: number;
  restCapturedAt: number | null;
  restFetchDurationMs: number | null;
  restErrors: string[];
  evaluatedAt: number | null;
  latencyMs: number | null;
  nextEligibleAt: number | null;
  requestedPairSize: number;
  filledPairSize: number;
  fillRatio: number;
  signalGrossCost: number;
  realizedGrossCost: number | null;
  realizedTotalCostUsd: number | null;
  projectedNetProfitUsd: number | null;
  reasonCode: string | null;
  reason: string | null;
  legs: Array<{
    venue: Venue;
    outcome: Resolution;
    requestedSize: number;
    executableSize: number;
    limitPrice: number | null;
    vwapPrice: number | null;
    feeUsd: number;
    slippageBps: number | null;
  }>;
};

export type OrderIntent = {
  id: string;
  /** Optimistic-concurrency token incremented by every durable update. */
  revision: number;
  asset: MarketAsset;
  shadow: boolean;
  slotKey: string;
  slotStartTs: number;
  slotEndTs: number;
  combination: PairCombination;
  status: OrderIntentStatus;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  primaryVenue: Venue;
  hedgeVenue: Venue;
  grossCost: number;
  targetNotionalUsd: number;
  entrySizingReason?: string | null;
  maxSlippageBps: number;
  failureReason: string | null;
  projectedNetProfitUsd: number | null;
  mismatchPFatal?: number | null;
  mismatchPFatalUpper?: number | null;
  mismatchModelVersion?: string | null;
  fatalMismatchPnlUsd?: number | null;
  conservativeExpectedPnlUsd?: number | null;
  fatalLossExposureUsd?: number | null;
  mismatchRiskAudit?: MismatchRiskAudit | null;
  shadowExecution?: ShadowExecutionAudit | null;
  realizedPnlUsd: number | null;
  roi: number | null;
  polyResolution: "UP" | "DOWN" | null;
  kalshiResolution: "YES" | "NO" | null;
  legs: [OrderIntentLeg, OrderIntentLeg];
};

export type LiveOrder = {
  id: string;
  asset: MarketAsset;
  shadow: boolean;
  intentId: string;
  venue: Venue;
  venueOrderId: string;
  clientOrderId: string | null;
  marketRef: string;
  tokenId?: string;
  side: OrderSide;
  outcome: Resolution;
  orderType: string;
  requestedPrice: number | null;
  requestedSize: number;
  filledSize: number;
  averageFillPrice: number | null;
  feeUsd: number | null;
  status: VenueOrderStatus;
  createdAt: number;
  updatedAt: number;
  raw: Record<string, unknown>;
};

export type OrderAttemptStatus = "planned" | "submitting" | "submitted" | "truth_pending" | "confirmed" | "failed";

export type OrderAttempt = {
  id: string;
  asset: MarketAsset;
  shadow: boolean;
  intentId: string;
  legId: string;
  stage: string;
  venue: Venue;
  side: OrderSide;
  orderType: string;
  clientOrderId: string;
  venueOrderId: string | null;
  status: OrderAttemptStatus;
  truthStatus: string | null;
  request: Record<string, unknown>;
  /** SHA-256 of the canonical, complete request payload persisted before submission. */
  requestSha256?: string | null;
  /** Absolute database-clock deadline before which this attempt may start submission. */
  submissionDeadlineAt?: number | null;
  /** Monotone persistence revision used to fence the final pre-dispatch CAS. */
  revision?: number;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export type EntryAdmissionMode = "live" | "shadow";

export type EntryReservation = {
  scopeKey: string;
  mode: EntryAdmissionMode;
  asset: MarketAsset | null;
  ownerIntentId: string | null;
  reservedAt: number | null;
  revision: number;
};

export type EntryAdmission = {
  id: string;
  sequence: number;
  intentId: string;
  attemptId: string | null;
  mode: EntryAdmissionMode;
  asset: MarketAsset;
  slotKey: string;
  combination: PairCombination;
  grossCost: number;
  requestSha256: string | null;
  strategyRevision: number;
  globalRiskRevision: number;
  policyEvaluatedAt: number;
  cutoffAt: number | null;
  latestSubmissionStartAt: number | null;
  evidence: Record<string, unknown>;
  authorizedAt: number;
};

export type LiveEntryAdmissionInput = {
  now: number;
  intent: OrderIntent;
  plannedAttempt: OrderAttempt;
  expectedStrategyRevision: number;
  expectedGlobalRiskRevision: number;
  policyEvaluatedAt: number;
  cutoffAt: number;
  latestSubmissionStartAt: number;
  evidence: Record<string, unknown>;
};

export type LiveOrderAttemptClaimInput = {
  intentId: string;
  attemptId: string;
  request: Record<string, unknown>;
  claimedAt: number;
};

export type LiveOrderAttemptSubmissionInput = {
  plannedAttempt: OrderAttempt;
  submissionDeadlineAt: number;
};

export type LiveOrderAttemptSubmissionDecision =
  | {
      decision: "claimed";
      fresh: boolean;
      attempt: OrderAttempt;
    }
  | {
      decision: "rejected";
      reason: "submission_deadline_expired";
      attempt: OrderAttempt;
    }
  | {
      decision: "reusable";
      reason: "venue_order_recorded" | "confirmed_result_recorded";
      attempt: OrderAttempt;
    }
  | {
      decision: "ambiguous";
      reason: "submission_in_progress" | "submission_truth_unknown";
      attempt: OrderAttempt;
    };

export type LiveOrderAttemptDispatchInput = {
  intentId: string;
  attemptId: string;
  request: Record<string, unknown>;
  submissionDeadlineAt: number;
  expectedRevision: number;
};

export type LiveOrderAttemptDispatchDecision =
  | {
      decision: "ready";
      attempt: OrderAttempt;
    }
  | {
      decision: "expired";
      reason: "submission_deadline_expired";
      attempt: OrderAttempt;
    };

export type ShadowEntryAdmissionInput = {
  now: number;
  intent: OrderIntent;
  expectedStrategyRevision: number;
  expectedGlobalRiskRevision: number;
  policyEvaluatedAt: number;
  evidence: Record<string, unknown>;
};

export type EntryAdmissionRejectionCode =
  | "trading_disabled"
  | "execution_mode_mismatch"
  | "circuit_breaker_active"
  | "reservation_conflict"
  | "shadow_cooldown_active"
  | "reentry_insufficient_improvement"
  | "slot_closed"
  | "submission_window_closed";

export type EntryAdmissionDecision =
  | {
      admitted: true;
      fresh: boolean;
      reservation: EntryReservation;
      admission: EntryAdmission;
      intent: OrderIntent;
      plannedAttempt: OrderAttempt | null;
    }
  | {
      admitted: false;
      code: EntryAdmissionRejectionCode;
      reason: string;
      blockingIntentId?: string;
      activeBreakerKeys?: CircuitBreakerKey[];
      nextEligibleAt?: number;
      retryAfterMs?: number;
      previousGrossCost?: number;
      maximumAllowedCost?: number | null;
    };

export type LiveFill = {
  id: string;
  asset: MarketAsset;
  shadow: boolean;
  intentId: string;
  venue: Venue;
  venueOrderId: string;
  tradeId: string;
  marketRef: string;
  tokenId?: string;
  side: OrderSide;
  outcome: Resolution;
  price: number;
  size: number;
  feeUsd: number;
  liquidity: "TAKER" | "MAKER" | null;
  filledAt: number;
  raw: Record<string, unknown>;
};

export type AccountingHeadState = "open" | "stable" | "quarantined" | "no_exposure" | "legacy_pending";

export type AccountingMutationOperation = "ingest_fill" | "close_no_exposure" | "finalize" | "reaccount";

export type AccountingMutationContext = {
  actor: string;
  requestId: string;
  occurredAt: number;
};

export type AccountingHead = {
  intentId: string;
  state: AccountingHeadState;
  currentVersion: number | null;
  currentProofSha256: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export type AccountingQuarantineReason =
  "late_terminal_fill" | "fill_identity_conflict" | "fill_economic_conflict" | "head_already_closed";

export type AccountingFillIngestionDecision =
  | {
      decision: "recorded" | "replayed";
      head: AccountingHead;
      factSha256: string;
    }
  | {
      decision: "quarantined" | "replayed";
      head: AccountingHead;
      quarantineId: number;
      reason: AccountingQuarantineReason;
    };

export type AccountingMutationResult = {
  replayed: boolean;
  head: AccountingHead;
  version: number | null;
  proofSha256: string | null;
};

export type AccountingBacklogSummary = {
  /** Number of live accounting defects that currently block order dispatch. */
  total: number;
  /** Live intents whose mandatory accounting head is missing. */
  missingHeads: number;
  /** Blocking legacy heads, excluding terminal history before the current UTC risk day. */
  legacyPending: number;
  quarantined: number;
  terminalOpen: number;
  /** Visible migration debt that is old enough not to contaminate the current UTC risk day. */
  historicalLegacyPending: number;
  oldestIntentId: string | null;
};

export type RealtimeOrderFill = {
  venue: Venue;
  venueOrderId: string;
  clientOrderId: string | null;
  tradeId: string;
  marketRef: string | null;
  tokenId: string | null;
  side: OrderSide | null;
  outcome: Resolution | null;
  price: number;
  size: number;
  liquidity: "TAKER" | "MAKER" | null;
  status: string | null;
  filledAt: number;
  capturedAt: number;
  raw: Record<string, unknown>;
};

export type WaitForOrderFillRequest = {
  venue: Venue;
  venueOrderId: string;
  clientOrderId?: string | null;
  marketRef?: string | null;
  afterCapturedAt?: number;
  timeoutMs: number;
};

export type ReadRecentOrderFillsRequest = {
  venue?: Venue;
  venueOrderId?: string;
  clientOrderId?: string | null;
  marketRef?: string | null;
  afterCapturedAt?: number;
  limit?: number;
};

export type PositionSnapshot = {
  id: string;
  asset: MarketAsset;
  venue: Venue;
  marketRef: string;
  outcome: Resolution;
  size: number;
  averagePrice: number | null;
  currentPrice: number | null;
  currentValueUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  redeemable: boolean;
  mergeable: boolean;
  updatedAt: number;
  raw: Record<string, unknown>;
};

export type SettlementRecord = {
  id: string;
  asset: MarketAsset;
  intentId: string;
  venue: Venue;
  marketRef: string;
  outcome: Resolution;
  resolvedOutcome: Resolution | null;
  payoutUsd: number;
  settledAt: number;
  raw: Record<string, unknown>;
};

export type PnlSnapshot = {
  id?: number;
  capturedAt: number;
  equityUsd: number;
  cashUsd: number;
  positionsValueUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  strategyPnlUsd: number;
  accountDeltaUsd: number;
  baselineEquityUsd: number | null;
  peakEquityUsd: number | null;
  drawdownUsd: number;
  feesUsd: number;
  venueBreakdown: VenueBalance[];
};

export type VenueCashAdjustmentObservation = {
  intentId: string;
  venue: Venue;
  orderCount: number;
  firstOrderCreatedAt: number;
  lastOrderCreatedAt: number;
  beforeCapturedAt: number;
  afterCapturedAt: number;
  cashBeforeUsd: number;
  cashAfterUsd: number;
  observedCashDebitUsd: number;
  theoreticalCashDebitUsd: number;
  adjustmentUsd: number;
};

export type MarketFillQualityOutcome =
  "full_fill" | "partial_fill" | "no_fill" | "rescue" | "unwind" | "manual_required";

export type MarketFillQualityEvent = {
  id: string;
  asset: MarketAsset;
  slotKey: string;
  intentId: string | null;
  combination: PairCombination | null;
  primaryVenue: Venue | null;
  hedgeVenue: Venue | null;
  outcome: MarketFillQualityOutcome;
  stage: string;
  slippageBps: number | null;
  payload: Record<string, unknown>;
  createdAt: number;
};

export type FillQualityBucket = {
  attempts: number;
  fullFills: number;
  partialFills: number;
  noFills: number;
  rescues: number;
  unwinds: number;
  manualRequired: number;
  fullRate: number;
  partialRate: number;
  noFillRate: number;
  rescueRate: number;
  avgSlippageBps: number | null;
};

export type FillQualitySummary = {
  last24h: FillQualityBucket;
  perAsset: Array<{
    asset: MarketAsset;
    bucket: FillQualityBucket;
  }>;
  blacklisted: Array<{
    key: CircuitBreakerKey;
    asset: MarketAsset | null;
    slotKey: string | null;
    until: number | null;
    reason: CircuitBreakerReason | null;
  }>;
};

export type StablePnlChange = {
  intentId: string;
  asset: MarketAsset;
  combination: PairCombination;
  changedAt: number;
  realizedPnlUsd: number;
  equityUsd: number;
  cashUsd: number;
  positionsValueUsd: number;
  strategyPnlUsd: number;
  accountDeltaUsd: number;
  baselineEquityUsd: number | null;
  peakEquityUsd: number | null;
  drawdownUsd: number;
  roi: number | null;
  targetNotionalUsd: number;
  stability: Record<string, unknown>;
};

export type BridgeTransfer = {
  id: string;
  venue: "polymarket";
  status: BridgeTransferStatus;
  createdAt: number;
  updatedAt: number;
  quoteId: string | null;
  sourceChain: string | null;
  sourceAsset: string | null;
  targetAsset: string;
  amountInUsd: number | null;
  amountOutUsd: number | null;
  txHash: string | null;
  depositAddresses: {
    evm?: string;
    svm?: string;
    btc?: string;
  } | null;
  raw: Record<string, unknown>;
};

export type RunEvent = {
  id?: number;
  asset?: MarketAsset | null;
  level: RunEventLevel;
  eventType: string;
  message: string;
  payload: Record<string, unknown> | null;
  createdAt: number;
};

export type NotificationDelivery = {
  id?: number;
  asset?: MarketAsset | null;
  channel: NotificationChannel;
  kind: NotificationKind;
  dedupeKey: string;
  message: string;
  payload: Record<string, unknown> | null;
  status: NotificationDeliveryStatus;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  error: string | null;
};

export type DatabaseTableMetric = {
  tableName: string;
  totalBytes: number;
};

export type DatabaseMetrics = {
  capturedAt: number;
  storageMode: "postgres";
  databaseSizeBytes: number;
  largestTables: DatabaseTableMetric[];
};

export type DatabaseMaintenanceSummary = {
  startedAt: number;
  finishedAt: number;
  deleted: {
    snapshots: number;
    oracleSamples: number;
    slotResolutions: number;
    pnlSnapshots: number;
    runEvents: number;
    fills: number;
    venueOrders: number;
    closedIntents: number;
    settlements: number;
    bridgeTransfers: number;
  };
};

export type CircuitBreaker = {
  key: CircuitBreakerKey;
  active: boolean;
  reason: CircuitBreakerReason | null;
  triggeredAt: number | null;
  payload: Record<string, unknown> | null;
};

export type CircuitBreakerMutationContext = {
  actor: string;
  requestId: string;
};

export type ObserveCircuitBreakerIncidentInput = CircuitBreakerMutationContext & {
  incident: CircuitBreakerIncident;
};

export type ResolveOwnedCircuitBreakerIncidentInput = CircuitBreakerMutationContext & {
  incidentId: string;
  expectedRevision: number;
  owner: string;
  conditionRecovered: boolean;
  exposureRecoveryProof?: CircuitBreakerRecoveryProof | null;
};

export type RecordCircuitBreakerExposureRecoveryInput = CircuitBreakerMutationContext & {
  incidentId: string;
  expectedRevision: number;
  owner: string;
  recoveryProof: CircuitBreakerRecoveryProof;
};

export type AcknowledgeCircuitBreakerIncidentInput = CircuitBreakerMutationContext & {
  incidentId: string;
  expectedRevision: number;
  operatorId: string;
};

export type WorkerState = {
  asset: MarketAsset;
  phase: WorkerPhase;
  currentSlotKey: string | null;
  lastScanAt: number | null;
  lastExecuteAt: number | null;
  lastReconcileAt: number | null;
  lastError: string | null;
  readinessStatus: ReadinessStatus;
  readiness: ReadinessCheck[];
  loopHealth: WorkerLoopHealth;
};

export type WorkerLoopHealth = {
  lastScanDurationMs: number | null;
  lastExecutionDurationMs: number | null;
  lastReconcileDurationMs: number | null;
  lastScanAgeMs: number | null;
  lastCandidateScore: number | null;
  lockBusyCount: number;
  staleSignalCount: number;
  updatedAt: number | null;
};

export type ExecutionCandidate = {
  asset: MarketAsset;
  slotKey: string;
  scanSequence: number;
  capturedAt: number;
  expiresAt: number;
  combination: PairCombination;
  projectedNetProfitUsd: number;
  grossCost: number;
  signalAgeMs: number;
  updatedAt: number;
};

export type DashboardResponse = {
  fetchedAt: number;
  slot: MarketSlot;
  config: StrategyConfig;
  workerState: WorkerState;
  latestSnapshot: OpportunitySnapshot | null;
  feedHealth: VenueFeedHealth[];
  opportunities: LiveOpportunity[];
  venueBalances: VenueBalance[];
  openIntents: OrderIntent[];
  recentOrders: LiveOrder[];
  recentFills: LiveFill[];
  positions: PositionSnapshot[];
  pnl: PnlSnapshot | null;
  stablePnlChanges: StablePnlChange[];
  fillQuality: FillQualitySummary;
  bridgeTransfers: BridgeTransfer[];
  circuitBreakers: CircuitBreaker[];
  runEvents: RunEvent[];
};

export type AssetDashboardSummary = {
  asset: MarketAsset;
  slot: MarketSlot;
  config: StrategyConfig;
  workerState: WorkerState;
  latestSnapshot: OpportunitySnapshot | null;
  bestOpportunity: LiveOpportunity | null;
  feedHealth: VenueFeedHealth[];
  activeBreakers: CircuitBreaker[];
};

export type PortfolioDashboardResponse = {
  fetchedAt: number;
  assets: AssetDashboardSummary[];
  openPositionsCount: number;
  venueBalances: VenueBalance[];
  pnl: PnlSnapshot | null;
  stablePnlChanges: StablePnlChange[];
  fillQuality: FillQualitySummary;
  activeBreakers: CircuitBreaker[];
  manualRequiredIntents: OrderIntent[];
};

export type TradesResponse = {
  fetchedAt: number;
  asset: MarketAsset | "all";
  intents: OrderIntent[];
  orders: LiveOrder[];
  fills: LiveFill[];
};

export type HistoryPoint = {
  ts: number;
  polyUpBuy: number | null;
  polyDownBuy: number | null;
  kalshiYesLast: number | null;
  kalshiNoLast: number | null;
  grossCostUpNo: number | null;
  grossCostDownYes: number | null;
};

export type HistoryResponse = {
  fetchedAt: number;
  slot: MarketSlot;
  feedHealth: VenueFeedHealth[];
  points: HistoryPoint[];
};

export type RecoveryOutcome = {
  outcome: Resolution;
  tokenId?: string;
  size: number;
  currentValueUsd: number;
  redeemable: boolean;
  mergeable: boolean;
};

export type RecoveryMarket = {
  asset: MarketAsset;
  marketRef: string;
  conditionId: string;
  title: string;
  url: string | null;
  outcomes: RecoveryOutcome[];
  redeemable: boolean;
  redeemableSize: number | null;
  mergeable: boolean;
  conversionAction: "redeem" | "merge" | null;
  mergeableSize: number | null;
  directConversionSupported: boolean;
  notes: string[];
};

export type RecoveryResponse = {
  fetchedAt: number;
  globalKillSwitchActive: boolean;
  signatureType: "EOA" | "POLY_PROXY" | "POLY_GNOSIS_SAFE" | "unknown";
  funderAddress: string | null;
  walletValidation: {
    canDirectConversion: boolean;
    checks: ReadinessCheck[];
  };
  markets: RecoveryMarket[];
  kalshiSettlementMode: "automatic";
};

export type HealthIssueCode =
  | "circuit_breaker_active"
  | "feed_not_ready"
  | "feed_timestamp_missing"
  | "feed_stale"
  | "live_execution_blocked"
  | "snapshot_missing"
  | "snapshot_stale"
  | "worker_execute_missing"
  | "worker_execute_stale"
  | "worker_heartbeat_missing"
  | "worker_heartbeat_stale"
  | "worker_not_ready"
  | "worker_scan_missing"
  | "worker_scan_stale"
  | "worker_slot_mismatch";

export type HealthIssue = {
  asset: MarketAsset;
  code: HealthIssueCode;
  details: string;
};

export type HealthAssetStatus = {
  asset: MarketAsset;
  phase: WorkerPhase;
  readinessStatus: ReadinessStatus;
  tradingEnabled: boolean;
  shadowMode: boolean;
  healthy: boolean;
  reasons: HealthIssue[];
  workerHeartbeatAgeMs: number | null;
  lastScanAgeMs: number | null;
  lastExecuteAgeMs: number | null;
  snapshotAgeMs: number | null;
  feedHealth: VenueFeedHealth[];
};

type HealthReadinessPayload = {
  timestamp: number;
  storageMode: "postgres";
  reasons: HealthIssue[];
  thresholds: {
    workerMaxAgeMs: number;
    executeMaxAgeMs: number;
    snapshotMaxAgeMs: number;
    feedMaxAgeMs: number;
  };
  liveExecutionAllowed: boolean;
  liveExecutionGateEnabled: boolean;
  kalshiEnvironment: "prod" | "demo" | "missing" | "invalid";
  polygonRpcConfigured: boolean;
  liveExecutionBlockReasons: Array<"environment_gate_disabled" | "kalshi_not_production" | "polygon_rpc_missing">;
  activeBreakers: number;
  tradingEnabledAssets: MarketAsset[];
  assets: HealthAssetStatus[];
  database: DatabaseMetrics | null;
};

export type HealthReadinessResponse = HealthReadinessPayload &
  (
    | {
        status: "healthy";
        ok: true;
      }
    | {
        status: "unhealthy";
        ok: false;
      }
  );

export type HealthErrorResponse = {
  status: "error";
  ok: false;
  error: "health_check_failed";
  timestamp: number;
  liveExecutionAllowed: false;
};

export type HealthResponse = HealthReadinessResponse | HealthErrorResponse;

export type VenueOrderRequest = {
  marketRef: string;
  tokenId?: string;
  outcome: Resolution;
  side: OrderSide;
  size: number;
  price: number | null;
  maxCostUsd: number;
  orderType: string;
  buyMode?: "shares" | "amount";
  reduceOnly?: boolean;
  clientOrderId: string;
};

export type VenueOrderResult = {
  venue: Venue;
  venueOrderId: string;
  status: VenueOrderStatus;
  filledSize: number;
  averageFillPrice: number | null;
  feeUsd: number;
  raw: Record<string, unknown>;
};

export type LiveMarketState<TQuote extends PolymarketQuote | KalshiQuote = PolymarketQuote | KalshiQuote> = {
  venue: Venue;
  slotKey: string;
  marketRef: string | null;
  quote: TQuote;
  lastBootstrapAt: number | null;
  lastSyncAt: number | null;
};

export type VenueQuoteBundle = {
  polymarket: PolymarketQuote;
  kalshi: KalshiQuote;
};

export interface VenueAdapter {
  readonly venue: Venue;
  getBalance(): Promise<VenueBalance>;
  getPositions(now?: number): Promise<PositionSnapshot[]>;
  placeOrder(order: VenueOrderRequest): Promise<VenueOrderResult>;
  cancelOrder(orderId: string): Promise<void>;
  getOrder(orderId: string, expectedOrder?: VenueOrderRequest): Promise<LiveOrder | null>;
}

export interface ExecutionCoordinator {
  scan(slot: MarketSlot, now: number, options?: { persistSnapshot?: boolean }): Promise<OpportunitySnapshot>;
  execute(slot: MarketSlot, now: number, snapshot?: OpportunitySnapshot | null): Promise<OrderIntent[]>;
  reconcile(slot: MarketSlot, now: number): Promise<void>;
}
