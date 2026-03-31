export type Venue = "polymarket" | "kalshi";
export type PairCombination = "POLY_UP_KALSHI_NO" | "POLY_DOWN_KALSHI_YES";
export type TradeStatus = "open" | "resolved";
export type LegStatus = "open" | "won" | "lost";
export type Resolution = "UP" | "DOWN" | "YES" | "NO";

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
  seriesTicker?: string;
  title: string;
  slotKey?: string;
  slug?: string;
  ticker?: string;
  url: string;
  startTime: string;
  endTime: string;
};

export type OutcomeQuote = {
  outcome: Resolution;
  buyPrice: number | null;
  sellPrice: number | null;
  midPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  depth: number | null;
};

export type PolymarketQuote = {
  ref: VenueMarketRef;
  status: "open" | "closed";
  slotAligned: boolean;
  availabilityReason: string | null;
  outcomes: {
    up: OutcomeQuote;
    down: OutcomeQuote;
  };
  feeRate: number;
  feeExponent: number;
  feeType: string | null;
  feeScheduleRaw: {
    rate: number;
    exponent: number;
    takerOnly: boolean;
    rebateRate: number;
  } | null;
  resolution: "UP" | "DOWN" | null;
  tokenIds: {
    up: string;
    down: string;
  };
};

export type KalshiQuote = {
  ref: VenueMarketRef;
  status: string;
  slotAligned: boolean;
  availabilityReason: string | null;
  outcomes: {
    yes: OutcomeQuote;
    no: OutcomeQuote;
  };
  feeMultiplier: number;
  feeType: string;
  resolution: "YES" | "NO" | null;
};

export type SignalLeg = {
  venue: Venue;
  outcome: Resolution;
  price: number | null;
  depth: number | null;
  marketRef: string;
  stakeUsd: number;
  units: number;
};

export type PairSignal = {
  combination: PairCombination;
  label: string;
  grossCost: number | null;
  threshold: number;
  thresholdMet: boolean;
  eligible: boolean;
  units: number;
  maxAffordableUnits: number;
  maxDepthUnits: number;
  estimatedFees: number;
  improvementFromLastEntry: number | null;
  reason: string | null;
  legs: [SignalLeg, SignalLeg];
};

export type SnapshotRecord = {
  id?: number;
  slotKey: string;
  slotStartTs: number;
  slotEndTs: number;
  capturedAt: number;
  polymarket: PolymarketQuote;
  kalshi: KalshiQuote;
  signals: PairSignal[];
};

export type PaperSettings = {
  initialCapital: number;
  budgetPerTrade: number;
  grossEntryThreshold: number;
  maxLegPrice: number;
  reentryImprovement: number;
  pollingIntervalMs: number;
  minOrderSize: number;
};

export type PaperTradeLeg = {
  id: string;
  tradeId: string;
  venue: Venue;
  outcome: Resolution;
  marketRef: string;
  price: number;
  units: number;
  grossCost: number;
  feeUsd: number;
  feeShares: number;
  netShares: number;
  payout: number | null;
  resolvedOutcome: Resolution | null;
  status: LegStatus;
};

export type PaperTrade = {
  id: string;
  slotKey: string;
  slotStartTs: number;
  slotEndTs: number;
  enteredAt: number;
  resolvedAt: number | null;
  combination: PairCombination;
  status: TradeStatus;
  grossPairCost: number;
  thresholdMet: boolean;
  units: number;
  budgetAllocated: number;
  capitalDeployed: number;
  feesTotal: number;
  realizedPnl: number | null;
  roi: number | null;
  theoreticalSameResolutionProfit: number;
  polyResolution: "UP" | "DOWN" | null;
  kalshiResolution: "YES" | "NO" | null;
  legs: PaperTradeLeg[];
};

export type WorkerState = {
  lastTickAt: number | null;
  currentSlotKey: string | null;
  lastError: string | null;
};

export type PaperMetrics = {
  totalEquity: number;
  availableCapital: number;
  deployedCapital: number;
  realizedPnl: number;
  feesPaid: number;
  openTrades: number;
  totalTrades: number;
  resolvedTrades: number;
  winRate: number;
};

export type DashboardResponse = {
  fetchedAt: number;
  slot: MarketSlot;
  metrics: PaperMetrics;
  latestSnapshot: SnapshotRecord | null;
  signals: PairSignal[];
  openTrades: PaperTrade[];
  workerState: WorkerState;
  settings: PaperSettings;
};

export type TradesResponse = {
  fetchedAt: number;
  trades: PaperTrade[];
};

export type HistoryPoint = {
  ts: number;
  polyUpBuy: number | null;
  polyDownBuy: number | null;
  kalshiYesAsk: number | null;
  kalshiNoAsk: number | null;
};

export type HistoryResponse = {
  fetchedAt: number;
  slot: MarketSlot;
  points: HistoryPoint[];
};
