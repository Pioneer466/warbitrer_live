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
export const POLY_BRIDGE_BASE = "https://bridge.polymarket.com";
export const POLY_CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
export const POLY_USDCE_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
export const COINBASE_EXCHANGE_BASE = "https://api.exchange.coinbase.com";
export const DEFAULT_POLY_CHAIN_ID = 137;
export const DEFAULT_ENTRY_CUTOFF_SECONDS = 20;
export const DEFAULT_MAX_LEG_PRICE = 0.49;
export const DEFAULT_MAX_PAIR_NOTIONAL_USD = 50;
export const DEFAULT_MAX_SLIPPAGE_BPS = 30;
export const DEFAULT_IMMEDIATE_ORDER_CONFIRMATION_TIMEOUT_MS = 8_000;
export const DEFAULT_EXECUTION_PRICE_BUFFER = 0.01;
export const DEFAULT_HEDGE_RETRY_ATTEMPTS = 3;
export const DEFAULT_HEDGE_RETRY_DELAY_MS = 350;
export const DEFAULT_MAX_OPEN_INTENTS_PER_SLOT = 1;
export const DEFAULT_MAX_VENUE_EXPOSURE_USD = 1_000;
export const DEFAULT_POLY_BRIDGE_LOW_WATER_USDC = 250;
export const DEFAULT_GROSS_ENTRY_THRESHOLD = 0.93;
export const DEFAULT_MIN_ORDER_SIZE = 5;
export const POLY_SIGNATURE_TYPES = ["EOA", "POLY_PROXY", "POLY_GNOSIS_SAFE"] as const;

export const DEFAULT_STRATEGY_CONFIG = {
  enableTrading: false,
  shadowMode: true,
  maxPairNotionalUsd: DEFAULT_MAX_PAIR_NOTIONAL_USD,
  grossEntryThreshold: DEFAULT_GROSS_ENTRY_THRESHOLD,
  maxLegPrice: DEFAULT_MAX_LEG_PRICE,
  reentryImprovement: 0.01,
  pollingIntervalMs: 1_000,
  minOrderSize: DEFAULT_MIN_ORDER_SIZE,
  maxSlippageBps: DEFAULT_MAX_SLIPPAGE_BPS,
  immediateOrderConfirmationTimeoutMs: DEFAULT_IMMEDIATE_ORDER_CONFIRMATION_TIMEOUT_MS,
  executionPriceBuffer: DEFAULT_EXECUTION_PRICE_BUFFER,
  hedgeRetryAttempts: DEFAULT_HEDGE_RETRY_ATTEMPTS,
  hedgeRetryDelayMs: DEFAULT_HEDGE_RETRY_DELAY_MS,
  entryCutoffSeconds: DEFAULT_ENTRY_CUTOFF_SECONDS,
  maxOpenIntentsPerSlot: DEFAULT_MAX_OPEN_INTENTS_PER_SLOT,
  maxVenueExposureUsd: DEFAULT_MAX_VENUE_EXPOSURE_USD,
  polyBridgeLowWaterUsdc: DEFAULT_POLY_BRIDGE_LOW_WATER_USDC,
} as const;
