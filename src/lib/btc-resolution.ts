import { COINBASE_EXCHANGE_BASE } from "@/lib/constants";
import { fetchJson } from "@/lib/fetch-json";

type CoinbaseCandle = [time: number, low: number, high: number, open: number, close: number, volume: number];

export async function fetchBtcSlotResolution(slotStartTs: number, slotEndTs: number) {
  const startIso = new Date(slotStartTs).toISOString();
  const endIso = new Date(slotEndTs).toISOString();
  const candles = await fetchJson<CoinbaseCandle[]>(
    `${COINBASE_EXCHANGE_BASE}/products/BTC-USD/candles?granularity=900&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`,
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

  return deriveBtcResolution(candle[3], candle[4]);
}

export function deriveBtcResolution(open: number, close: number) {
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
