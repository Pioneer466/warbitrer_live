import {
  classifySettledIntentMismatch,
  formatMismatchAuditDecision,
  formatMismatchAuditSettlementLabel,
  formatMismatchEconomicsBasis,
  formatRiskAge,
  formatRiskProbability,
  getMismatchModelDisplayState,
  readIntentMismatchRiskAudit,
  readOpportunityMismatchEconomics,
  selectHighestRiskEstimate,
  summarizeMismatchRiskAudits,
} from "@/lib/mismatch-risk-display";
import type { LiveOpportunity, MismatchRiskAudit, MismatchRiskEstimate, OrderIntent } from "@/lib/types";

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

  it("labels block-only decisions and keeps reference economics distinct", () => {
    expect(formatMismatchAuditDecision("would_block")).toBe("aurait bloqué");
    expect(formatMismatchAuditDecision("reference_allow")).toBe("référence autorisée");
    expect(formatMismatchEconomicsBasis("executable")).toBe("économie exécutable");
    expect(formatMismatchEconomicsBasis("reference")).toBe("économie de référence");
    expect(formatMismatchAuditSettlementLabel("would_allow", "fatal_mismatch")).toBe("autorisé + fatal");

    const opportunity = buildOpportunity(buildEstimate({
      economicsBasis: "reference",
      economicsPairSize: 7,
      economicsTotalCostUsd: 6.2,
    }));
    expect(readOpportunityMismatchEconomics(opportunity)).toEqual({
      basis: "reference",
      pairSize: 7,
      totalCostUsd: 6.2,
      source: "estimate",
    });

    opportunity.mismatchRiskAudit = buildAudit({
      economicsBasis: "executable",
      pairSize: 12,
      totalCostUsd: 10.8,
    });
    expect(readOpportunityMismatchEconomics(opportunity)).toEqual({
      basis: "executable",
      pairSize: 12,
      totalCostUsd: 10.8,
      source: "audit",
    });
  });

  it("classifies settled intent payouts from the two held legs", () => {
    expect(classifySettledIntentMismatch(buildIntent({ polyResolution: "UP", kalshiResolution: "YES" }))).toBe("aligned");
    expect(classifySettledIntentMismatch(buildIntent({ polyResolution: "UP", kalshiResolution: "NO" }))).toBe("double_payout");
    expect(classifySettledIntentMismatch(buildIntent({ polyResolution: "DOWN", kalshiResolution: "YES" }))).toBe("fatal_mismatch");
    const reverseCombination = buildIntent({
      combination: "POLY_DOWN_KALSHI_YES",
      polyResolution: "UP",
      kalshiResolution: "NO",
    });
    reverseCombination.legs[0].outcome = "DOWN";
    reverseCombination.legs[1].outcome = "YES";
    expect(classifySettledIntentMismatch(reverseCombination)).toBe("fatal_mismatch");
    expect(classifySettledIntentMismatch(buildIntent({ status: "hedged", polyResolution: null, kalshiResolution: null }))).toBeNull();
  });

  it("summarizes only exact execution audits and their settled outcomes", () => {
    const intents = [
      buildIntent({ mismatchRiskAudit: buildAudit({ decision: "would_allow", enforceReady: true, source: "execution" }) }),
      buildIntent({ mismatchRiskAudit: buildAudit({ decision: "would_block", enforceReady: false, source: "execution" }) }),
      buildIntent({
        mismatchRiskAudit: buildAudit({ decision: "would_allow_fail_open", enforceReady: false, source: "execution" }),
        polyResolution: "UP",
        kalshiResolution: "NO",
      }),
      buildIntent({ mismatchRiskAudit: null, polyResolution: "DOWN", kalshiResolution: "YES" }),
    ];

    expect(summarizeMismatchRiskAudits(intents)).toMatchObject({
      auditedCount: 3,
      allowCount: 1,
      blockCount: 1,
      failOpenCount: 1,
      enforceReadyCount: 1,
      enforceNotReadyCount: 2,
      classifiedSettlementCount: 3,
      alignedSettlementCount: 2,
      doublePayoutCount: 1,
      fatalMismatchCount: 0,
    });
  });

  it("reconstructs an audit only when historical probability and economics are complete", () => {
    const completeLegacy = buildIntent({
      mismatchPFatal: 0.02,
      mismatchPFatalUpper: 0.04,
      mismatchModelVersion: "mismatch-v1",
      conservativeExpectedPnlUsd: 0.3,
      fatalMismatchPnlUsd: -9,
    });
    const incompleteLegacy = buildIntent({ mismatchPFatal: 0.02, mismatchPFatalUpper: null });
    const scanOnly = buildIntent({ mismatchRiskAudit: buildAudit({ source: "scan" }) });

    expect(readIntentMismatchRiskAudit(completeLegacy)).toMatchObject({
      source: "reconstructed",
      decision: "would_allow",
      enforceReady: false,
    });
    expect(readIntentMismatchRiskAudit(incompleteLegacy)).toBeNull();
    expect(summarizeMismatchRiskAudits([completeLegacy, incompleteLegacy, scanOnly])).toMatchObject({
      auditedCount: 0,
      classifiedSettlementCount: 0,
      enforceReadyCount: 0,
      enforceNotReadyCount: 0,
    });
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

function buildAudit(overrides: Partial<MismatchRiskAudit> = {}): MismatchRiskAudit {
  return {
    evaluatedAt: 1_000,
    policyMode: "block_only",
    decision: "would_allow",
    source: "scan",
    baseEligible: true,
    baseReasons: [],
    blockingReasonCodes: [],
    blockingReasons: [],
    diagnosticReasonCodes: [],
    economicsBasis: "executable",
    pairSize: 10,
    totalCostUsd: 9,
    breakEvenFatalProbability: 0.08,
    maximumAllowedFatalProbability: 0.05,
    pFatal: 0.02,
    pFatalUpper95: 0.04,
    conservativePnlUsd: 0.4,
    fatalPnlUsd: -9,
    estimateAvailable: true,
    executionUsable: true,
    executionReason: null,
    modelVersion: "mismatch-v2",
    enforceReady: true,
    enforceReasons: [],
    legacyGuardAction: "allow",
    legacySizeMultiplier: 1,
    ...overrides,
  };
}

function buildIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    id: "intent",
    asset: "btc",
    shadow: true,
    slotKey: "btc:slot-1",
    slotStartTs: 0,
    slotEndTs: 900_000,
    combination: "POLY_UP_KALSHI_NO",
    status: "settled",
    createdAt: 1,
    updatedAt: 2,
    resolvedAt: 2,
    primaryVenue: "polymarket",
    hedgeVenue: "kalshi",
    grossCost: 0.9,
    targetNotionalUsd: 9,
    maxSlippageBps: 50,
    failureReason: null,
    projectedNetProfitUsd: 1,
    mismatchRiskAudit: null,
    realizedPnlUsd: 1,
    roi: 0.1,
    polyResolution: "UP",
    kalshiResolution: "YES",
    legs: [
      {
        id: "poly-leg",
        intentId: "intent",
        venue: "polymarket",
        outcome: "UP",
        marketRef: "poly",
        side: "BUY",
        requestedPrice: 0.45,
        requestedSize: 10,
        requestedNotionalUsd: 4.5,
        filledPrice: 0.45,
        filledSize: 10,
        feeUsd: 0,
        status: "hedged",
        venueOrderId: "poly-order",
        payoutUsd: null,
        resolvedOutcome: "UP",
      },
      {
        id: "kalshi-leg",
        intentId: "intent",
        venue: "kalshi",
        outcome: "NO",
        marketRef: "kalshi",
        side: "BUY",
        requestedPrice: 0.45,
        requestedSize: 10,
        requestedNotionalUsd: 4.5,
        filledPrice: 0.45,
        filledSize: 10,
        feeUsd: 0,
        status: "hedged",
        venueOrderId: "kalshi-order",
        payoutUsd: null,
        resolvedOutcome: "YES",
      },
    ],
    ...overrides,
  };
}
