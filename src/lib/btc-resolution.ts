import { deriveDirectionalResolution, fetchSlotResolution, toKalshiResolution } from "@/lib/market-resolution";

export async function fetchBtcSlotResolution(slotStartTs: number, slotEndTs: number) {
  return fetchSlotResolution("btc", slotStartTs, slotEndTs);
}

export function deriveBtcResolution(open: number, close: number) {
  return deriveDirectionalResolution(open, close);
}

export { toKalshiResolution };
