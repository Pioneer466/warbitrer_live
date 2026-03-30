import path from "node:path";

export const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
export const DEFAULT_DB_PATH =
  process.env.PAPER_ARB_DB_PATH ?? path.join(process.cwd(), "data", "paper-arb.db");
export const POLY_GAMMA_BASE = "https://gamma-api.polymarket.com";
export const POLY_CLOB_BASE = "https://clob.polymarket.com";
export const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
export const COINBASE_EXCHANGE_BASE = "https://api.exchange.coinbase.com";
export const FIXED_TRADE_NOTIONAL_USD = 50;
export const FIXED_LEG_NOTIONAL_USD = FIXED_TRADE_NOTIONAL_USD / 2;

export const DEFAULT_SETTINGS = {
  initialCapital: 10_000,
  budgetPerTrade: FIXED_TRADE_NOTIONAL_USD,
  grossEntryThreshold: 0.93,
  reentryImprovement: 0.01,
  pollingIntervalMs: 1_000,
  minOrderSize: 5,
} as const;
