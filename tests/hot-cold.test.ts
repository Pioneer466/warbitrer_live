import {
  deriveNextScanIntervalMs,
  HOT_SCAN_INTERVAL_MS,
  COLD_SCAN_INTERVAL_MS,
  isHotOpportunitySnapshot,
  resolveHotColdConfig,
} from "@/worker/hot-cold";
import type { OpportunitySnapshot } from "@/lib/types";

describe("hot/cold scan cadence", () => {
  it("uses hot interval while the hot TTL is active", () => {
    expect(deriveNextScanIntervalMs(1_000, 1_001)).toBe(HOT_SCAN_INTERVAL_MS);
  });

  it("uses cold interval after the hot TTL expires", () => {
    expect(deriveNextScanIntervalMs(1_002, 1_001)).toBe(COLD_SCAN_INTERVAL_MS);
  });

  it("classifies a snapshot as hot when the best gross cost is near threshold", () => {
    const snapshot = {
      opportunities: [
        { grossCost: 0.951, threshold: 0.93 },
        { grossCost: 0.949, threshold: 0.93 },
      ],
    } as Pick<OpportunitySnapshot, "opportunities">;

    expect(isHotOpportunitySnapshot(snapshot)).toBe(true);
  });

  it("keeps cold cadence when all opportunities are far from threshold", () => {
    const snapshot = {
      opportunities: [
        { grossCost: 0.98, threshold: 0.93 },
        { grossCost: null, threshold: 0.93 },
      ],
    } as Pick<OpportunitySnapshot, "opportunities">;

    expect(isHotOpportunitySnapshot(snapshot)).toBe(false);
  });

  it("keeps cold cadence while either market-data feed is not ready", () => {
    const snapshot = {
      opportunities: [{ grossCost: 0.94, threshold: 0.93 }],
      kalshi: { feedHealth: { feedStatus: "blocked" } },
      polymarket: { feedHealth: { feedStatus: "ready" } },
    } as unknown as OpportunitySnapshot;

    expect(isHotOpportunitySnapshot(snapshot)).toBe(false);
  });

  it("reads configurable hot/cold intervals from env-like input", () => {
    expect(
      resolveHotColdConfig({
        WARBITRER_COLD_SCAN_INTERVAL_MS: "1500",
        WARBITRER_HOT_SCAN_INTERVAL_MS: "300",
        WARBITRER_HOT_SIGNAL_TTL_MS: "12000",
      }),
    ).toEqual({
      coldScanIntervalMs: 1500,
      hotScanIntervalMs: 300,
      hotSignalTtlMs: 12000,
    });
  });
});
