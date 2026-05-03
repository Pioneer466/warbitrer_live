import type { OpportunitySnapshot } from "@/lib/types";

export const COLD_SCAN_INTERVAL_MS = 1_000;
export const HOT_SCAN_INTERVAL_MS = 250;
export const HOT_SIGNAL_WINDOW = 0.02;
export const HOT_SIGNAL_TTL_MS = 10_000;

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
