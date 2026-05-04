import type { OpportunitySnapshot } from "@/lib/types";

const DEFAULT_COLD_SCAN_INTERVAL_MS = 1_000;
const DEFAULT_HOT_SCAN_INTERVAL_MS = 250;
const DEFAULT_HOT_SIGNAL_TTL_MS = 10_000;

export function resolveHotColdConfig(env: Record<string, string | undefined> = process.env) {
  return {
    coldScanIntervalMs: readPositiveIntEnv(env, "WARBITRER_COLD_SCAN_INTERVAL_MS", DEFAULT_COLD_SCAN_INTERVAL_MS, 250, 10_000),
    hotScanIntervalMs: readPositiveIntEnv(env, "WARBITRER_HOT_SCAN_INTERVAL_MS", DEFAULT_HOT_SCAN_INTERVAL_MS, 100, 5_000),
    hotSignalTtlMs: readPositiveIntEnv(env, "WARBITRER_HOT_SIGNAL_TTL_MS", DEFAULT_HOT_SIGNAL_TTL_MS, 1_000, 60_000),
  };
}

export const COLD_SCAN_INTERVAL_MS = resolveHotColdConfig().coldScanIntervalMs;
export const HOT_SCAN_INTERVAL_MS = resolveHotColdConfig().hotScanIntervalMs;
export const HOT_SIGNAL_WINDOW = 0.02;
export const HOT_SIGNAL_TTL_MS = resolveHotColdConfig().hotSignalTtlMs;

export function deriveNextScanIntervalMs(now: number, hotUntil: number) {
  return now <= hotUntil ? HOT_SCAN_INTERVAL_MS : COLD_SCAN_INTERVAL_MS;
}

export function isHotOpportunitySnapshot(snapshot: Pick<OpportunitySnapshot, "opportunities">) {
  return snapshot.opportunities.some(
    (opportunity) =>
      opportunity.grossCost !== null &&
      opportunity.grossCost <= opportunity.threshold + HOT_SIGNAL_WINDOW,
  );
}

function readPositiveIntEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const raw = env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(parsed)));
}
