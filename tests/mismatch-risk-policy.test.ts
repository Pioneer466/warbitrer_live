import { DEFAULT_GLOBAL_RISK_CONFIG } from "@/lib/risk-settings";
import {
  annotateOpportunityWithMismatchRisk,
  applyMismatchRiskPolicy,
  calculateMismatchClusterExposure,
  recheckMismatchRiskCandidate,
} from "@/lib/mismatch-risk-policy";
import type {
  LiveOpportunity,
  MismatchRiskEstimate,
  OrderIntent,
} from "@/lib/types";

const SLOT_END_TS = 1_800_000_900_000;

function opportunity(overrides: Partial<LiveOpportunity> = {}): LiveOpportunity {
  return {
    asset: "btc",
    id: "candidate",
    slotKey: "btc-slot",
    capturedAt: SLOT_END_TS - 300_000,
    combination: "POLY_UP_KALSHI_NO",
    label: "Poly Up + Kalshi No",
    grossCost: 0.9,
    threshold: 0.93,
    thresholdMet: true,
    worstCaseProfitUsd: -9,
    fatalMismatchPnlUsd: -9,
    conservativeExpectedPnlUsd: 0.6,
    mismatchRiskEstimate: null,
    eligible: true,
    primaryVenue: "kalshi",
    primarySelection: null,
    improvementFromLastEntry: null,
    estimatedFeesUsd: 0.2,
    projectedNetProfitUsd: 1,
    projectedNetReturn: 1 / 9,
    reasons: [],
    legs: [
      {
        venue: "polymarket",
        outcome: "UP",
        marketRef: "poly",
        price: 0.45,
        depth: 100,
        targetNotionalUsd: 4.4,
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
        depth: 100,
        targetNotionalUsd: 4.4,
        size: 10,
        tickSize: 0.01,
        minOrderSize: 1,
        feeEstimateUsd: 0.1,
      },
    ],
    mismatchGuardAction: "allow",
    mismatchSizeMultiplier: 1,
    referencePayoutCount: 1,
    deadZoneDistanceBps: 10,
    deadZoneWidthBps: 5,
    mismatchRisk: "low",
    venueDisagreementPct: 0.01,
    secondsElapsedInSlot: 600,
    chainlinkMoveBps: 20,
    openDriftBps: 5,
    chainlinkLivePriceUsd: 100_100,
    observedSlotOpenPriceUsd: 100_000,
    kalshiTargetPriceUsd: 100_050,
    ...overrides,
  };
}

function estimate(
  overrides: Partial<MismatchRiskEstimate> = {},
): MismatchRiskEstimate {
  return {
    available: true,
    modelVersion: "test-v1-calibrated",
    reason: null,
    pFatal: 0.01,
    pFatalUpper95: 0.02,
    pAligned: 0.98,
    pDouble: 0.01,
    expectedPnlUsd: 0.9,
    conservativePnlUsd: 0.8,
    fatalPnlUsd: -9,
    breakEvenFatalProbability: 0.1,
    maximumAllowedFatalProbability: 0.05,
    chainlinkAgeMs: 100,
    cfAgeMs: 100,
    observationCount: 300,
    ...overrides,
  };
}

function intent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    id: "intent-1",
    asset: "eth",
    shadow: false,
    slotKey: "eth-slot",
    slotStartTs: SLOT_END_TS - 900_000,
    slotEndTs: SLOT_END_TS,
    status: "hedged",
    targetNotionalUsd: 65,
    fatalLossExposureUsd: 65,
    mismatchPFatalUpper: 0.384,
    ...overrides,
  } as OrderIntent;
}

function policyInput(overrides: Record<string, unknown> = {}) {
  return {
    opportunity: opportunity(),
    estimate: estimate(),
    mode: "shadow" as const,
    slotEndTs: SLOT_END_TS,
    openIntents: [] as OrderIntent[],
    capitalUsd: 1_000,
    globalRiskConfig: DEFAULT_GLOBAL_RISK_CONFIG,
    ...overrides,
  };
}

describe("mismatch risk annotation", () => {
  it("annotates without mutating the original opportunity", () => {
    const original = opportunity();
    const risk = estimate({ fatalPnlUsd: -9.25, conservativePnlUsd: 0.4 });
    const annotated = annotateOpportunityWithMismatchRisk(original, risk);

    expect(annotated).not.toBe(original);
    expect(original.mismatchRiskEstimate).toBeNull();
    expect(annotated).toMatchObject({
      mismatchRiskEstimate: risk,
      fatalMismatchPnlUsd: -9.25,
      conservativeExpectedPnlUsd: 0.4,
      worstCaseProfitUsd: -9,
    });
  });
});

describe("mismatch cluster exposure", () => {
  it("uses all live assets in the same time slot and conservative legacy fallbacks", () => {
    const summary = calculateMismatchClusterExposure({
      slotEndTs: SLOT_END_TS,
      intents: [
        intent(),
        intent({
          id: "legacy",
          asset: "sol",
          fatalLossExposureUsd: null,
          fatalMismatchPnlUsd: null,
          mismatchPFatalUpper: null,
          targetNotionalUsd: 12,
        }),
        intent({ id: "shadow", shadow: true }),
        intent({ id: "terminal", status: "unwound" }),
        intent({ id: "next-slot", slotEndTs: SLOT_END_TS + 900_000 }),
      ],
    });

    expect(summary.exposures).toHaveLength(2);
    expect(summary.exposures[0]).toMatchObject({
      intentId: "intent-1",
      fatalLossUsd: 65,
      pFatalUpper95: 0.384,
      fatalLossSource: "fatal_loss_exposure",
      probabilitySource: "model",
    });
    expect(summary.exposures[1]).toMatchObject({
      intentId: "legacy",
      fatalLossUsd: 12,
      pFatalUpper95: 1,
      fatalLossSource: "target_notional",
      probabilitySource: "conservative_fallback",
    });
  });
});

describe("mismatch risk policy modes", () => {
  it("uses a recovery reserve for cluster loss without changing aligned cost", () => {
    const result = recheckMismatchRiskCandidate(
      policyInput({
        opportunity: opportunity({ fatalMismatchPnlUsd: -11 }),
      }),
    );

    expect(result.economics).toMatchObject({
      totalCostUsd: 9,
      fatalLossUsd: 11,
    });
  });

  it("diagnoses uncalibrated models but blocks them only in enforce", () => {
    const uncalibrated = estimate({
      modelVersion: "test-v2-UNCALIBRATED-shadow",
    });

    for (const mode of ["shadow", "block_only"] as const) {
      const result = recheckMismatchRiskCandidate(
        policyInput({ mode, estimate: uncalibrated }),
      );
      expect(result.allowed).toBe(true);
      expect(result.diagnosticReasons.map((reason) => reason.code)).toContain(
        "model_uncalibrated",
      );
      expect(result.blockingReasons.map((reason) => reason.code)).not.toContain(
        "model_uncalibrated",
      );
    }

    const enforced = recheckMismatchRiskCandidate(
      policyInput({ mode: "enforce", estimate: uncalibrated }),
    );
    expect(enforced.allowed).toBe(false);
    expect(enforced.blockingReasons.map((reason) => reason.code)).toContain(
      "model_uncalibrated",
    );
  });

  it("keeps shadow purely observational even when the economic gate fails", () => {
    const result = applyMismatchRiskPolicy(
      policyInput({ estimate: estimate({ pFatalUpper95: 0.2 }) }),
    );

    expect(result.allowed).toBe(true);
    expect(result.blockingReasons).toEqual([]);
    expect(result.diagnosticReasons.map((reason) => reason.code)).toContain(
      "fatal_probability_above_limit",
    );
    expect(result.opportunity.eligible).toBe(true);
    expect(result.opportunity.reasons).toEqual([]);
  });

  it("makes block_only ignore unavailable estimates and budgets, but enforce its gate", () => {
    const unavailable = estimate({
      available: false,
      reason: "insufficient_history",
      pFatalUpper95: null,
    });
    expect(
      recheckMismatchRiskCandidate(
        policyInput({ mode: "block_only", estimate: unavailable }),
      ).allowed,
    ).toBe(true);

    const overBudgetButEconomic = recheckMismatchRiskCandidate(
      policyInput({
        mode: "block_only",
        openIntents: [intent()],
      }),
    );
    expect(overBudgetButEconomic.clusterBudgetAfter?.withinBudget).toBe(false);
    expect(overBudgetButEconomic.allowed).toBe(true);

    const failedGate = applyMismatchRiskPolicy(
      policyInput({
        mode: "block_only",
        estimate: estimate({ pFatalUpper95: 0.2 }),
      }),
    );
    expect(failedGate.allowed).toBe(false);
    expect(failedGate.blockingReasons.map((reason) => reason.code)).toEqual([
      "fatal_probability_above_limit",
    ]);
    expect(failedGate.opportunity.eligible).toBe(false);
  });

  it("fails closed in enforce and applies both hybrid cluster budgets", () => {
    const unavailable = recheckMismatchRiskCandidate(
      policyInput({
        mode: "enforce",
        estimate: estimate({
          available: false,
          reason: "cf_stale",
          pFatalUpper95: null,
        }),
      }),
    );
    expect(unavailable.allowed).toBe(false);
    expect(unavailable.blockingReasons.map((reason) => reason.code)).toContain(
      "estimate_unavailable",
    );

    const expectedBudget = recheckMismatchRiskCandidate(
      policyInput({
        mode: "enforce",
        openIntents: [intent()],
      }),
    );
    expect(expectedBudget.clusterBudgetBefore?.withinBudget).toBe(true);
    expect(expectedBudget.clusterBudgetAfter).toMatchObject({
      withinBudget: false,
      limitingBudget: "expected",
    });
    expect(expectedBudget.blockingReasons.map((reason) => reason.code)).toContain(
      "cluster_expected_budget_exceeded",
    );

    const absoluteBudget = recheckMismatchRiskCandidate(
      policyInput({
        mode: "enforce",
        openIntents: [
          intent({ fatalLossExposureUsd: 70, mismatchPFatalUpper: 0.1 }),
        ],
      }),
    );
    expect(absoluteBudget.clusterBudgetAfter).toMatchObject({
      withinBudget: false,
      limitingBudget: "absolute",
    });
    expect(absoluteBudget.blockingReasons.map((reason) => reason.code)).toContain(
      "cluster_absolute_budget_exceeded",
    );
  });

  it("excludes the candidate intent during an idempotent recheck", () => {
    const existingCandidate = intent({
      id: "candidate-intent",
      fatalLossExposureUsd: 70,
      mismatchPFatalUpper: 0.1,
    });
    const result = recheckMismatchRiskCandidate(
      policyInput({
        mode: "enforce",
        openIntents: [existingCandidate],
        candidateIntentId: "candidate-intent",
      }),
    );

    expect(result.clusterExposure.exposures).toEqual([]);
    expect(result.clusterBudgetAfter?.withinBudget).toBe(true);
    expect(result.allowed).toBe(true);
  });
});
