import type { MarketAsset, PairCombination } from "@/lib/types";

const DAY_MS = 24 * 60 * 60_000;

// Keep dense oracle curves long enough for several thousand slots per asset,
// while retaining the much smaller outcome labels for longer-term calibration.
export const ORACLE_SAMPLE_RETENTION_MS = 45 * DAY_MS;
export const SLOT_RESOLUTION_RETENTION_MS = 365 * DAY_MS;

export const ORACLE_COLD_SAMPLE_CADENCE_MS = 15_000;
export const ORACLE_HOT_SAMPLE_CADENCE_MS = 5_000;
export const ORACLE_FINAL_MINUTE_SAMPLE_CADENCE_MS = 1_000;

export type OracleSlotSample = {
  asset: MarketAsset;
  slotKey: string;
  slotStartTs: number;
  slotEndTs: number;
  capturedAt: number;
  chainlinkStartPriceUsd: number | null;
  chainlinkStartCapturedAt: number | null;
  chainlinkLivePriceUsd: number | null;
  chainlinkSourceTs: number | null;
  cfIndexId: string | null;
  cfLivePriceUsd: number | null;
  cfSourceTs: number | null;
  cfTrailingAverageUsd: number | null;
  cfTrailingWindowSize: number | null;
  cfFinalMinuteAverageUsd: number | null;
  cfFinalMinuteWindowSize: number | null;
  kalshiTargetPriceUsd: number | null;
  modelVersion: string | null;
  riskByCombination: Partial<Record<PairCombination, Record<string, unknown>>>;
  economicsByCombination: Partial<Record<PairCombination, Record<string, unknown>>>;
};

export type SlotResolutionRecord = {
  asset: MarketAsset;
  slotKey: string;
  slotStartTs: number;
  slotEndTs: number;
  polymarketSlug: string;
  polymarketMarketRef: string | null;
  kalshiMarketRef: string | null;
  polymarketResolution: "UP" | "DOWN" | null;
  kalshiResolution: "YES" | "NO" | null;
  polymarketSettlementValueUsd: number | null;
  kalshiSettlementValueUsd: number | null;
  firstObservedAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  source: string;
  raw: Record<string, unknown>;
};

export function oracleSampleCadenceMs(slotEndTs: number, now: number, hotOpportunity: boolean) {
  if (slotEndTs - now <= 60_000) {
    return ORACLE_FINAL_MINUTE_SAMPLE_CADENCE_MS;
  }
  return hotOpportunity ? ORACLE_HOT_SAMPLE_CADENCE_MS : ORACLE_COLD_SAMPLE_CADENCE_MS;
}

export function shouldPersistOracleSample(
  lastCapturedAt: number | null,
  slotEndTs: number,
  now: number,
  hotOpportunity: boolean,
) {
  return lastCapturedAt === null || now - lastCapturedAt >= oracleSampleCadenceMs(slotEndTs, now, hotOpportunity);
}
