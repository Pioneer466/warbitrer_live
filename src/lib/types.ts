export type Venue = "polymarket" | "kalshi";
export type PairCombination = "POLY_UP_KALSHI_NO" | "POLY_DOWN_KALSHI_YES";
export type Resolution = "UP" | "DOWN" | "YES" | "NO";
export type OrderSide = "BUY" | "SELL";
export type WorkerPhase = "idle" | "scan" | "execute" | "reconcile";
export type ReadinessStatus = "ready" | "degraded" | "blocked";
export type FeedSource = "ws" | "rest-bootstrap" | "rest-fallback" | "unavailable";
export type SubscriptionStatus = "idle" | "connecting" | "subscribed" | "error" | "closed";
export type OrderIntentStatus =
  | "pending"
  | "executing_primary"
  | "primary_filled"
  | "hedging"
  | "hedged"
  | "unwind_required"
  | "unwound"
  | "settled"
  | "failed"
  | "canceled";
export type VenueOrderStatus =
  | "pending"
  | "live"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "rejected"
  | "expired";
export type ExecutionLegStatus =
  | "pending"
  | "submitted"
  | "filled"
  | "hedged"
  | "unwound"
  | "failed";
export type CircuitBreakerKey = "global" | `slot:${string}`;
export type CircuitBreakerReason =
  | "manual"
  | "hedge_failure"
  | "readiness_failed"
  | "venue_error"
  | "risk_limit";
export type BridgeTransferStatus = "idle" | "quoted" | "pending" | "completed" | "failed";
export type RunEventLevel = "info" | "warn" | "error";

export type MarketSlot = {
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
  feeRateBps: number;
  negRisk: boolean;
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
  resolution: "YES" | "NO" | null;
  feeMultiplier: number;
  feeType: string;
  lastTradeYesPrice: number | null;
  lastTradeNoPrice: number | null;
};

export type StrategyConfig = {
  enableTrading: boolean;
  shadowMode: boolean;
  maxPairNotionalUsd: number;
  grossEntryThreshold: number;
  maxLegPrice: number;
  reentryImprovement: number;
  pollingIntervalMs: number;
  minOrderSize: number;
  maxSlippageBps: number;
  immediateOrderConfirmationTimeoutMs: number;
  executionPriceBuffer: number;
  hedgeRetryAttempts: number;
  hedgeRetryDelayMs: number;
  entryCutoffSeconds: number;
  maxOpenIntentsPerSlot: number;
  maxVenueExposureUsd: number;
  polyBridgeLowWaterUsdc: number;
};

export type VenueBalance = {
  venue: Venue;
  capturedAt: number;
  status: ReadinessStatus;
  currency: "USD" | "USDC";
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
  id: string;
  slotKey: string;
  capturedAt: number;
  combination: PairCombination;
  label: string;
  grossCost: number | null;
  threshold: number;
  thresholdMet: boolean;
  eligible: boolean;
  primaryVenue: Venue | null;
  improvementFromLastEntry: number | null;
  estimatedFeesUsd: number;
  projectedNetProfitUsd: number | null;
  projectedNetReturn: number | null;
  reasons: string[];
  legs: [OpportunityLeg, OpportunityLeg];
};

export type OpportunitySnapshot = {
  id?: number;
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
  filledPrice: number | null;
  filledSize: number;
  feeUsd: number;
  status: ExecutionLegStatus;
  venueOrderId: string | null;
  payoutUsd: number | null;
  resolvedOutcome: Resolution | null;
};

export type OrderIntent = {
  id: string;
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
  maxSlippageBps: number;
  failureReason: string | null;
  projectedNetProfitUsd: number | null;
  realizedPnlUsd: number | null;
  roi: number | null;
  polyResolution: "UP" | "DOWN" | null;
  kalshiResolution: "YES" | "NO" | null;
  legs: [OrderIntentLeg, OrderIntentLeg];
};

export type LiveOrder = {
  id: string;
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

export type LiveFill = {
  id: string;
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

export type PositionSnapshot = {
  id: string;
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
  level: RunEventLevel;
  eventType: string;
  message: string;
  payload: Record<string, unknown> | null;
  createdAt: number;
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

export type WorkerState = {
  phase: WorkerPhase;
  currentSlotKey: string | null;
  lastScanAt: number | null;
  lastExecuteAt: number | null;
  lastReconcileAt: number | null;
  lastError: string | null;
  readinessStatus: ReadinessStatus;
  readiness: ReadinessCheck[];
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
  bridgeTransfers: BridgeTransfer[];
  circuitBreakers: CircuitBreaker[];
  runEvents: RunEvent[];
};

export type TradesResponse = {
  fetchedAt: number;
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
  size: number;
  currentValueUsd: number;
  redeemable: boolean;
  mergeable: boolean;
};

export type RecoveryMarket = {
  marketRef: string;
  conditionId: string;
  title: string;
  url: string | null;
  outcomes: RecoveryOutcome[];
  redeemable: boolean;
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

export type VenueOrderRequest = {
  marketRef: string;
  tokenId?: string;
  outcome: Resolution;
  side: OrderSide;
  size: number;
  price: number | null;
  maxCostUsd: number;
  orderType: string;
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
  getOrder(orderId: string): Promise<LiveOrder | null>;
}

export interface ExecutionCoordinator {
  scan(slot: MarketSlot, now: number): Promise<OpportunitySnapshot>;
  execute(slot: MarketSlot, now: number): Promise<OrderIntent[]>;
  reconcile(slot: MarketSlot, now: number): Promise<void>;
}
