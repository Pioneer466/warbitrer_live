import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AssetMismatchRiskOverview, GlobalRiskBudgetPanel } from "@/components/mismatch-risk-view";
import { DEFAULT_GLOBAL_RISK_CONFIG } from "@/lib/risk-settings";
import type { LiveOpportunity, MismatchRiskAudit, MismatchRiskEstimate } from "@/lib/types";

describe("mismatch risk view", () => {
  beforeAll(() => vi.stubGlobal("React", React));
  afterAll(() => vi.unstubAllGlobals());

  it("separates the active policy from the block_only audit and explains a zero limit", () => {
    const markup = renderToStaticMarkup(
      React.createElement(AssetMismatchRiskOverview, {
        mode: "shadow",
        opportunities: [buildOpportunity()],
        globalConfig: null,
        globalConfigError: null,
      }),
    );

    expect(markup).toContain("Politique active : shadow");
    expect(markup).toContain("active · shadow");
    expect(markup).toContain("Audit contrefactuel block_only");
    expect(markup).toContain("audit uniquement · block_only");
    expect(markup).toContain("Ces verdicts d’audit n’ont aucun effet sur son éligibilité");
    expect(markup).not.toContain("guard shadow");

    expect(markup).toContain("modèle non calibré");
    expect(markup).toContain("pairSize · payout");
    expect(markup).toContain("totalCost");
    expect(markup).toContain("breakEven");
    expect(markup).toContain("maximumAllowed · limite");
    expect(markup).toContain("Limite 0 % expliquée");
    expect(markup).toContain("marge alignée non positive");
  });

  it("does not display the default mismatch fraction while the global config is unavailable", () => {
    const unavailableMarkup = renderToStaticMarkup(
      React.createElement(GlobalRiskBudgetPanel, {
        config: null,
        error: null,
      }),
    );
    const loadedMarkup = renderToStaticMarkup(
      React.createElement(GlobalRiskBudgetPanel, {
        config: DEFAULT_GLOBAL_RISK_CONFIG,
        error: null,
      }),
    );

    expect(unavailableMarkup).toMatch(/Fraction limite mismatch<\/div><div[^>]*>--<\/div>/);
    expect(unavailableMarkup).not.toContain("50.00%");
    expect(loadedMarkup).toMatch(/Fraction limite mismatch<\/div><div[^>]*>50\.00%<\/div>/);
  });

  it("explains when a strictly positive mismatch limit is displayed as 0.00% after rounding", () => {
    const opportunity = buildOpportunity();
    opportunity.mismatchRiskEstimate = {
      ...opportunity.mismatchRiskEstimate!,
      breakEvenFatalProbability: 0.00008,
      maximumAllowedFatalProbability: 0.00004,
      economicsPairSize: 10,
      economicsTotalCostUsd: 9.9992,
    };
    opportunity.mismatchRiskAudit = {
      ...opportunity.mismatchRiskAudit!,
      breakEvenFatalProbability: 0.00008,
      maximumAllowedFatalProbability: 0.00004,
      pairSize: 10,
      totalCostUsd: 9.9992,
    };

    const markup = renderToStaticMarkup(
      React.createElement(AssetMismatchRiskOverview, {
        mode: "shadow",
        opportunities: [opportunity],
        globalConfig: null,
        globalConfigError: null,
      }),
    );

    expect(markup).toContain("0.00%");
    expect(markup).toContain("Limite 0,00 % par arrondi");
    expect(markup).toContain("strictement positive");
    expect(markup).toContain("pas une limite mathématiquement nulle");
    expect(markup).not.toContain("Limite 0 % expliquée");
  });

  it("keeps an active block_only policy distinct from its counterfactual audit", () => {
    const markup = renderToStaticMarkup(
      React.createElement(AssetMismatchRiskOverview, {
        mode: "block_only",
        opportunities: [buildOpportunity()],
        globalConfig: DEFAULT_GLOBAL_RISK_CONFIG,
        globalConfigError: null,
      }),
    );

    expect(markup).toContain("Politique active : block_only");
    expect(markup).toContain("active · block_only");
    expect(markup).toContain("Audit contrefactuel block_only");
    expect(markup).toContain("audit uniquement · block_only");
  });
});

function buildOpportunity(): LiveOpportunity {
  const estimate: MismatchRiskEstimate = {
    available: true,
    executionUsable: true,
    executionReason: null,
    modelVersion: "structural-ewma-gaussian-v1-uncalibrated",
    reason: null,
    pFatal: 0.02,
    pFatalUpper95: 0.04,
    pAligned: 0.94,
    pDouble: 0.04,
    expectedPnlUsd: -0.2,
    conservativePnlUsd: -0.4,
    fatalPnlUsd: -10.2,
    breakEvenFatalProbability: -0.02,
    maximumAllowedFatalProbability: 0,
    chainlinkAgeMs: 300,
    cfAgeMs: 400,
    sourceTimestampSkewMs: 100,
    observationCount: 120,
    economicsBasis: "reference",
    economicsPairSize: 10,
    economicsTotalCostUsd: 10.2,
  };
  const audit: MismatchRiskAudit = {
    evaluatedAt: 1_000,
    policyMode: "block_only",
    decision: "reference_block",
    source: "scan",
    baseEligible: true,
    baseReasons: [],
    blockingReasonCodes: ["non_positive_aligned_margin"],
    blockingReasons: ["Marge alignée de référence non positive"],
    diagnosticReasonCodes: ["model_uncalibrated"],
    economicsBasis: "reference",
    pairSize: 10,
    totalCostUsd: 10.2,
    breakEvenFatalProbability: -0.02,
    maximumAllowedFatalProbability: 0,
    pFatal: 0.02,
    pFatalUpper95: 0.04,
    conservativePnlUsd: -0.4,
    fatalPnlUsd: -10.2,
    estimateAvailable: true,
    executionUsable: true,
    executionReason: null,
    modelVersion: "structural-ewma-gaussian-v1-uncalibrated",
    enforceReady: false,
    enforceReasons: ["reference_economics_only", "model_uncalibrated"],
    legacyGuardAction: "allow",
    legacySizeMultiplier: 1,
  };

  return {
    asset: "btc",
    id: "opportunity:zero-limit",
    slotKey: "btc:slot-1",
    capturedAt: 1,
    combination: "POLY_UP_KALSHI_NO",
    label: "Poly UP + Kalshi NO",
    grossCost: 1.02,
    threshold: 0.93,
    thresholdMet: false,
    worstCaseProfitUsd: -0.2,
    fatalMismatchPnlUsd: -10.2,
    conservativeExpectedPnlUsd: -0.4,
    mismatchRiskEstimate: estimate,
    mismatchRiskAudit: audit,
    eligible: false,
    primaryVenue: null,
    primarySelection: null,
    improvementFromLastEntry: null,
    estimatedFeesUsd: 0,
    projectedNetProfitUsd: -0.2,
    projectedNetReturn: -0.02,
    reasons: ["Coût brut supérieur au seuil"],
    legs: [
      {
        venue: "polymarket",
        outcome: "UP",
        marketRef: "poly",
        price: 0.51,
        depth: 10,
        targetNotionalUsd: 5.1,
        size: 10,
        tickSize: 0.01,
        minOrderSize: 1,
        feeEstimateUsd: 0,
      },
      {
        venue: "kalshi",
        outcome: "NO",
        marketRef: "kalshi",
        price: 0.51,
        depth: 10,
        targetNotionalUsd: 5.1,
        size: 10,
        tickSize: 0.01,
        minOrderSize: 1,
        feeEstimateUsd: 0,
      },
    ],
    mismatchGuardAction: "allow",
    mismatchSizeMultiplier: 1,
    referencePayoutCount: 10,
    deadZoneDistanceBps: 20,
    deadZoneWidthBps: 5,
    mismatchRisk: "medium",
    venueDisagreementPct: 0.01,
    secondsElapsedInSlot: 300,
    chainlinkMoveBps: 10,
    openDriftBps: 1,
    chainlinkLivePriceUsd: 100_000,
    observedSlotOpenPriceUsd: 99_900,
    kalshiTargetPriceUsd: 99_950,
  };
}
