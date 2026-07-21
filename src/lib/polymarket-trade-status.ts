const POLYMARKET_TRADE_STATUSES = new Set(["CONFIRMED", "MATCHED", "MINED", "RETRYING", "FAILED"] as const);

export type PolymarketTradeStatus = "CONFIRMED" | "MATCHED" | "MINED" | "RETRYING" | "FAILED";

export function normalizePolymarketTradeStatus(value: unknown): PolymarketTradeStatus | null {
  if (typeof value !== "string") {
    return null;
  }
  const upper = value.trim().toUpperCase();
  const normalized = upper.startsWith("TRADE_STATUS_") ? upper.slice("TRADE_STATUS_".length) : upper;
  return POLYMARKET_TRADE_STATUSES.has(normalized as PolymarketTradeStatus)
    ? (normalized as PolymarketTradeStatus)
    : null;
}
