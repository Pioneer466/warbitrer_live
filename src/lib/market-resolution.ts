import { COINBASE_EXCHANGE_BASE } from "@/lib/constants";
import { getMarketCatalogEntry } from "@/lib/market-catalog";
import { fetchJson } from "@/lib/fetch-json";
import type { MarketAsset } from "@/lib/types";

type CoinbaseCandle = [time: number, low: number, high: number, open: number, close: number, volume: number];

export async function fetchSlotResolution(asset: MarketAsset, slotStartTs: number, slotEndTs: number) {
  const startIso = new Date(slotStartTs).toISOString();
  const endIso = new Date(slotEndTs).toISOString();
  const market = getMarketCatalogEntry(asset);
  const candles = await fetchJson<CoinbaseCandle[]>(
    `${COINBASE_EXCHANGE_BASE}/products/${market.coinbaseProductId}/candles?granularity=900&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`,
  );

  if (candles.length === 0) {
    return null;
  }

  const targetTime = Math.floor(slotStartTs / 1000);
  const candle =
    candles.find((entry) => entry[0] === targetTime) ??
    [...candles].sort((left, right) => Math.abs(left[0] - targetTime) - Math.abs(right[0] - targetTime))[0];

  if (!candle) {
    return null;
  }

  return deriveDirectionalResolution(candle[3], candle[4]);
}

export function deriveDirectionalResolution(open: number, close: number) {
  if (close > open) {
    return "UP" as const;
  }

  if (close < open) {
    return "DOWN" as const;
  }

  return null;
}

export function toKalshiResolution(direction: "UP" | "DOWN") {
  return direction === "UP" ? ("YES" as const) : ("NO" as const);
}
