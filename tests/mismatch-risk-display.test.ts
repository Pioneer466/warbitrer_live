import {
  formatRiskAge,
  formatRiskProbability,
  getMismatchModelDisplayState,
  selectHighestRiskEstimate,
} from "@/lib/mismatch-risk-display";
import type { LiveOpportunity, MismatchRiskEstimate } from "@/lib/types";

describe("mismatch risk display", () => {
  it("distinguishes unavailable, uncalibrated and calibrated estimates", () => {
    expect(getMismatchModelDisplayState(null)).toBe("unavailable");
    expect(
      getMismatchModelDisplayState(
        buildEstimate({ available: false, modelVersion: "mismatch-v2" }),
      ),
    ).toBe("unavailable");
    expect(getMismatchModelDisplayState(buildEstimate({ available: false }))).toBe("uncalibrated");
    expect(
      getMismatchModelDisplayState(
        buildEstimate({ modelVersion: "structural-ewma-gaussian-v1-UNCALIBRATED" }),
      ),
    ).toBe("uncalibrated");
    expect(getMismatchModelDisplayState(buildEstimate({ modelVersion: "mismatch-v2" }))).toBe("calibrated");
  });

  it("selects the opportunity with the highest fatal upper bound", () => {
    const lower = buildEstimate({ pFatalUpper95: 0.03 });
    const higher = buildEstimate({ pFatalUpper95: 0.08 });
    const selected = selectHighestRiskEstimate([
      buildOpportunity(lower),
      buildOpportunity(higher),
    ]);

    expect(selected).toBe(higher);
  });

  it("formats probabilities and source ages without hiding missing values", () => {
    expect(formatRiskProbability(0.02345)).toBe("2.35%");
    expect(formatRiskProbability(null)).toBe("--");
    expect(formatRiskAge(349)).toBe("349ms");
    expect(formatRiskAge(2_540)).toBe("2.5s");
    expect(formatRiskAge(null)).toBe("--");
  });
});

function buildEstimate(overrides: Partial<MismatchRiskEstimate> = {}): MismatchRiskEstimate {
  return {
    available: true,
    modelVersion: "structural-ewma-gaussian-v1-uncalibrated",
    reason: null,
    pFatal: 0.02,
    pFatalUpper95: 0.04,
    pAligned: 0.94,
    pDouble: 0.04,
    expectedPnlUsd: 1.2,
    conservativePnlUsd: 0.4,
    fatalPnlUsd: -12,
    breakEvenFatalProbability: 0.08,
    maximumAllowedFatalProbability: 0.05,
    chainlinkAgeMs: 300,
    cfAgeMs: 400,
    observationCount: 120,
    ...overrides,
  };
}

function buildOpportunity(estimate: MismatchRiskEstimate): LiveOpportunity {
  return {
    asset: "btc",
    id: `opportunity:${estimate.pFatalUpper95}`,
    slotKey: "btc:slot-1",
    capturedAt: 1,
    combination: "POLY_UP_KALSHI_NO",
    label: "Poly UP + Kalshi NO",
    grossCost: 0.9,
    threshold: 0.93,
    thresholdMet: true,
    worstCaseProfitUsd: 1,
    mismatchRiskEstimate: estimate,
    eligible: true,
    primaryVenue: "kalshi",
    primarySelection: null,
    improvementFromLastEntry: null,
    estimatedFeesUsd: 0.1,
    projectedNetProfitUsd: 1,
    projectedNetReturn: 0.1,
    reasons: [],
    legs: [
      {
        venue: "polymarket",
        outcome: "UP",
        marketRef: "poly",
        price: 0.45,
        depth: 10,
        targetNotionalUsd: 4.5,
        size: 10,
        tickSize: 0.01,
        minOrderSize: 1,
        feeEstimateUsd: 0.1,
      },
      {
        venue: "kalshi",
        outcome: "NO",
        marketRef: "kalshi",
        price: 0.45,
        depth: 10,
        targetNotionalUsd: 4.5,
        size: 10,
        tickSize: 0.01,
        minOrderSize: 1,
        feeEstimateUsd: 0.1,
      },
    ],
    mismatchGuardAction: "allow",
    mismatchSizeMultiplier: 1,
    referencePayoutCount: 10,
    deadZoneDistanceBps: 20,
    deadZoneWidthBps: 5,
    mismatchRisk: "low",
    venueDisagreementPct: 0.01,
    secondsElapsedInSlot: 300,
    chainlinkMoveBps: 10,
    openDriftBps: 1,
    chainlinkLivePriceUsd: 100_000,
    observedSlotOpenPriceUsd: 99_900,
    kalshiTargetPriceUsd: 99_950,
  };
}
