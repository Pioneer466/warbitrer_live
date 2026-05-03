import type { StrategyConfigMap } from "@/lib/types";

export const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
export const KALSHI_PROD_BASE = "https://api.elections.kalshi.com/trade-api/v2";
export const KALSHI_DEMO_BASE = "https://demo-api.kalshi.co/trade-api/v2";
export const KALSHI_WS_PROD_BASE = "wss://api.elections.kalshi.com/trade-api/ws/v2";
export const KALSHI_WS_DEMO_BASE = "wss://demo-api.kalshi.co/trade-api/ws/v2";
export const POLY_GAMMA_BASE = "https://gamma-api.polymarket.com";
export const POLY_CLOB_BASE = "https://clob.polymarket.com";
export const POLY_DATA_BASE = "https://data-api.polymarket.com";
export const POLY_MARKET_WS_BASE = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
export const POLY_USER_WS_BASE = "wss://ws-subscriptions-clob.polymarket.com/ws/user";
export const POLY_RTDS_WS_BASE = "wss://ws-live-data.polymarket.com";
export const POLY_BRIDGE_BASE = "https://bridge.polymarket.com";
export const POLY_CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
export const POLY_CTF_EXCHANGE_ADDRESS = "0xE111180000d2663C0091e4f400237545B87B996B";
export const POLY_NEG_RISK_CTF_EXCHANGE_ADDRESS = "0xe2222d279d744050d28e00520010520000310F59";
export const POLY_PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
export const POLY_COLLATERAL_ONRAMP_ADDRESS = "0x93070a847efEf7F70739046A929D47a521F5B8ee";
export const POLY_COLLATERAL_OFFRAMP_ADDRESS = "0x2957922Eb93258b93368531d39fAcCA3B4dC5854";
export const POLY_USDCE_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
export const COINBASE_EXCHANGE_BASE = "https://api.exchange.coinbase.com";
export const DEFAULT_POLY_CHAIN_ID = 137;
export const DEFAULT_ENTRY_CUTOFF_SECONDS = 180;
export const DEFAULT_MAX_LEG_PRICE = 0.49;
export const DEFAULT_MAX_PAIR_NOTIONAL_USD = 50;
export const DEFAULT_MAX_LEG_CAPITAL_SHARE = 0.7;
export const DEFAULT_MAX_SIGNAL_AGE_MS = 1_000;
export const DEFAULT_MAX_SLIPPAGE_BPS = 30;
export const DEFAULT_PRIMARY_SELECTION_MODE = "shadow";
export const DEFAULT_MINIMUM_ENTRY_DEPTH_COVERAGE_RATIO = 0.5;
export const DEFAULT_ADAPTIVE_SLIPPAGE_TIGHT_BPS = 15;
export const DEFAULT_ADAPTIVE_SLIPPAGE_DEFAULT_BPS = 30;
export const DEFAULT_ADAPTIVE_SLIPPAGE_THIN_BPS = 60;
export const DEFAULT_DAILY_LOSS_CAP_ENABLED = true;
export const DEFAULT_DAILY_LOSS_HARD_CAP_USD = 20;
export const DEFAULT_IMMEDIATE_ORDER_CONFIRMATION_TIMEOUT_MS = 8_000;
export const DEFAULT_EXECUTION_PRICE_BUFFER = 0.01;
export const DEFAULT_KALSHI_DEPTH_HEADROOM_CONTRACTS = 2;
export const DEFAULT_KALSHI_PRIMARY_DEPTH_SAFETY_FACTOR = 0.7;
export const DEFAULT_KALSHI_PRIMARY_PRICE_TICKS_SLIPPAGE = 2;
export const DEFAULT_KALSHI_PRIMARY_PROBE_CLIP_CONTRACTS = 5;
export const DEFAULT_KALSHI_PRIMARY_MAX_CLIP_CONTRACTS = 10;
export const DEFAULT_KALSHI_PRIMARY_MAX_CLIPS = 4;
export const DEFAULT_POLYMARKET_HEDGE_DEPTH_SAFETY_FACTOR = 0.8;
export const DEFAULT_POLYMARKET_HEDGE_HEADROOM_SHARES = 1;
export const DEFAULT_POLYMARKET_HEDGE_BOOK_MAX_AGE_MS = 500;
export const DEFAULT_PRIMARY_RETRY_ATTEMPTS = 2;
export const DEFAULT_PRIMARY_RETRY_DELAY_MS = 200;
export const DEFAULT_HEDGE_RETRY_ATTEMPTS = 3;
export const DEFAULT_HEDGE_RETRY_DELAY_MS = 350;
export const DEFAULT_HEDGE_RESCUE_ENABLED = true;
export const DEFAULT_HEDGE_RESCUE_MAX_ATTEMPTS = 3;
export const DEFAULT_HEDGE_RESCUE_DELAY_MS = 150;
export const DEFAULT_HEDGE_RESCUE_MAX_LOSS_USD = 1;
export const DEFAULT_HEDGE_RESCUE_MIN_ADVANTAGE_USD = 0.05;
export const DEFAULT_HEDGE_RESCUE_ALLOW_PARTIAL = true;
export const DEFAULT_FORCED_UNWIND_ENABLED = true;
export const DEFAULT_FORCED_UNWIND_MAX_ATTEMPTS = 3;
export const DEFAULT_FORCED_UNWIND_TICK_LADDER: number[] = [1, 3, 6];
export const DEFAULT_FORCED_UNWIND_MAX_LOSS_USD = 2;
export const DEFAULT_FORCED_UNWIND_HOLD_SECONDS_TO_SETTLEMENT = 45;
export const DEFAULT_MAX_OPEN_INTENTS_PER_SLOT = 1;
export const DEFAULT_MAX_VENUE_EXPOSURE_USD = 1_000;
export const DEFAULT_POLY_BRIDGE_LOW_WATER_USDC = 250;
export const DEFAULT_GROSS_ENTRY_THRESHOLD = 0.93;
export const DEFAULT_MIN_PROJECTED_NET_PROFIT_USD = 0.25;
export const DEFAULT_MIN_PROJECTED_NET_RETURN = 0.02;
export const DEFAULT_MIN_WORST_CASE_PROFIT_USD = 0.25;
export const DEFAULT_MIN_ORDER_SIZE = 5;
export const POLYMARKET_MIN_MARKET_BUY_AMOUNT_USD = 1;
export const DEFAULT_MISMATCH_GUARD_ENABLED = true;
export const DEFAULT_MISMATCH_GUARD_MIN_ELAPSED_SECONDS = 60;
export const DEFAULT_MISMATCH_GUARD_MIN_MOVE_BPS = 5;
export const DEFAULT_MISMATCH_GUARD_PHASE2_START_SECONDS = 480;
export const DEFAULT_MISMATCH_GUARD_PHASE2_MIN_MOVE_BPS = 10;
export const DEFAULT_MISMATCH_GUARD_MAX_VENUE_DISAGREEMENT_PCT = 0.12;
export const POLY_SIGNATURE_TYPES = ["EOA", "POLY_PROXY", "POLY_GNOSIS_SAFE"] as const;

export const DEFAULT_STRATEGY_CONFIG = {
  enableTrading: false,
  shadowMode: true,
  maxPairNotionalUsd: DEFAULT_MAX_PAIR_NOTIONAL_USD,
  maxLegCapitalShare: DEFAULT_MAX_LEG_CAPITAL_SHARE,
  maxSignalAgeMs: DEFAULT_MAX_SIGNAL_AGE_MS,
  grossEntryThreshold: DEFAULT_GROSS_ENTRY_THRESHOLD,
  minProjectedNetProfitUsd: DEFAULT_MIN_PROJECTED_NET_PROFIT_USD,
  minProjectedNetReturn: DEFAULT_MIN_PROJECTED_NET_RETURN,
  minWorstCaseProfitUsd: DEFAULT_MIN_WORST_CASE_PROFIT_USD,
  maxLegPrice: DEFAULT_MAX_LEG_PRICE,
  reentryImprovement: 0.01,
  pollingIntervalMs: 1_000,
  minOrderSize: DEFAULT_MIN_ORDER_SIZE,
  maxSlippageBps: DEFAULT_MAX_SLIPPAGE_BPS,
  primarySelectionMode: DEFAULT_PRIMARY_SELECTION_MODE,
  minimumEntryDepthCoverageRatio: DEFAULT_MINIMUM_ENTRY_DEPTH_COVERAGE_RATIO,
  adaptiveSlippageTightBps: DEFAULT_ADAPTIVE_SLIPPAGE_TIGHT_BPS,
  adaptiveSlippageDefaultBps: DEFAULT_ADAPTIVE_SLIPPAGE_DEFAULT_BPS,
  adaptiveSlippageThinBps: DEFAULT_ADAPTIVE_SLIPPAGE_THIN_BPS,
  dailyLossCapEnabled: DEFAULT_DAILY_LOSS_CAP_ENABLED,
  dailyLossHardCapUsd: DEFAULT_DAILY_LOSS_HARD_CAP_USD,
  immediateOrderConfirmationTimeoutMs: DEFAULT_IMMEDIATE_ORDER_CONFIRMATION_TIMEOUT_MS,
  executionPriceBuffer: DEFAULT_EXECUTION_PRICE_BUFFER,
  kalshiDepthHeadroomContracts: DEFAULT_KALSHI_DEPTH_HEADROOM_CONTRACTS,
  kalshiPrimaryDepthSafetyFactor: DEFAULT_KALSHI_PRIMARY_DEPTH_SAFETY_FACTOR,
  kalshiPrimaryPriceTicksSlippage: DEFAULT_KALSHI_PRIMARY_PRICE_TICKS_SLIPPAGE,
  kalshiPrimaryProbeClipContracts: DEFAULT_KALSHI_PRIMARY_PROBE_CLIP_CONTRACTS,
  kalshiPrimaryMaxClipContracts: DEFAULT_KALSHI_PRIMARY_MAX_CLIP_CONTRACTS,
  kalshiPrimaryMaxClips: DEFAULT_KALSHI_PRIMARY_MAX_CLIPS,
  polymarketHedgeDepthSafetyFactor: DEFAULT_POLYMARKET_HEDGE_DEPTH_SAFETY_FACTOR,
  polymarketHedgeHeadroomShares: DEFAULT_POLYMARKET_HEDGE_HEADROOM_SHARES,
  polymarketHedgeBookMaxAgeMs: DEFAULT_POLYMARKET_HEDGE_BOOK_MAX_AGE_MS,
  primaryRetryAttempts: DEFAULT_PRIMARY_RETRY_ATTEMPTS,
  primaryRetryDelayMs: DEFAULT_PRIMARY_RETRY_DELAY_MS,
  hedgeRetryAttempts: DEFAULT_HEDGE_RETRY_ATTEMPTS,
  hedgeRetryDelayMs: DEFAULT_HEDGE_RETRY_DELAY_MS,
  hedgeRescueEnabled: DEFAULT_HEDGE_RESCUE_ENABLED,
  hedgeRescueMaxAttempts: DEFAULT_HEDGE_RESCUE_MAX_ATTEMPTS,
  hedgeRescueDelayMs: DEFAULT_HEDGE_RESCUE_DELAY_MS,
  hedgeRescueMaxLossUsd: DEFAULT_HEDGE_RESCUE_MAX_LOSS_USD,
  hedgeRescueMinAdvantageUsd: DEFAULT_HEDGE_RESCUE_MIN_ADVANTAGE_USD,
  hedgeRescueAllowPartial: DEFAULT_HEDGE_RESCUE_ALLOW_PARTIAL,
  forcedUnwindEnabled: DEFAULT_FORCED_UNWIND_ENABLED,
  forcedUnwindMaxAttempts: DEFAULT_FORCED_UNWIND_MAX_ATTEMPTS,
  forcedUnwindTickLadder: [...DEFAULT_FORCED_UNWIND_TICK_LADDER],
  forcedUnwindMaxLossUsd: DEFAULT_FORCED_UNWIND_MAX_LOSS_USD,
  forcedUnwindHoldSecondsToSettlement: DEFAULT_FORCED_UNWIND_HOLD_SECONDS_TO_SETTLEMENT,
  entryCutoffSeconds: DEFAULT_ENTRY_CUTOFF_SECONDS,
  maxOpenIntentsPerSlot: DEFAULT_MAX_OPEN_INTENTS_PER_SLOT,
  maxVenueExposureUsd: DEFAULT_MAX_VENUE_EXPOSURE_USD,
  polyBridgeLowWaterUsdc: DEFAULT_POLY_BRIDGE_LOW_WATER_USDC,
  mismatchGuardEnabled: DEFAULT_MISMATCH_GUARD_ENABLED,
  mismatchGuardMinElapsedSeconds: DEFAULT_MISMATCH_GUARD_MIN_ELAPSED_SECONDS,
  mismatchGuardMinMoveBps: DEFAULT_MISMATCH_GUARD_MIN_MOVE_BPS,
  mismatchGuardPhase2StartSeconds: DEFAULT_MISMATCH_GUARD_PHASE2_START_SECONDS,
  mismatchGuardPhase2MinMoveBps: DEFAULT_MISMATCH_GUARD_PHASE2_MIN_MOVE_BPS,
  mismatchGuardMaxVenueDisagreementPct: DEFAULT_MISMATCH_GUARD_MAX_VENUE_DISAGREEMENT_PCT,
} as const;

export const DEFAULT_STRATEGY_CONFIGS: StrategyConfigMap = {
  btc: {
    ...DEFAULT_STRATEGY_CONFIG,
  },
  eth: {
    ...DEFAULT_STRATEGY_CONFIG,
    enableTrading: false,
    shadowMode: true,
  },
  sol: {
    ...DEFAULT_STRATEGY_CONFIG,
    enableTrading: true,
    shadowMode: true,
  },
  xrp: {
    ...DEFAULT_STRATEGY_CONFIG,
    enableTrading: true,
    shadowMode: true,
  },
  doge: {
    ...DEFAULT_STRATEGY_CONFIG,
    enableTrading: true,
    shadowMode: true,
  },
  bnb: {
    ...DEFAULT_STRATEGY_CONFIG,
    enableTrading: true,
    shadowMode: true,
  },
  hype: {
    ...DEFAULT_STRATEGY_CONFIG,
    enableTrading: true,
    shadowMode: true,
  },
};
