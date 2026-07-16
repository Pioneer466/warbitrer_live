import { describe, expect, it } from "vitest";

import {
  buildMismatchRiskAudit,
  reconstructMismatchRiskAudit,
} from "@/lib/mismatch-risk-audit";
import type { MismatchRiskPolicyCheck } from "@/lib/mismatch-risk-policy";
import type {
  LiveOpportunity,
  MismatchRiskEstimate,
  OrderIntent,
} from "@/lib/types";

describe("mismatch risk counterfactual audit", () => {
  it("records the exact block_only verdict without changing the opportunity", () => {
    const audit = buildMismatchRiskAudit({
      opportunity: opportunity({ conservativeExpectedPnlUsd: -0.6 }),
      estimate: estimate(),
      policy: policy({
        allowed: false,
        blockingReasons: [
          {
            code: "fatal_probability_above_limit",
            message: "Risque fatal supérieur à la limite",
          },
        ],
      }),
      evaluatedAt: 123_000,
      source: "execution",
    });

    expect(audit).toMatchObject({
      decision: "would_block",
      source: "execution",
      economicsBasis: "executable",
      maximumAllowedFatalProbability: 0.05,
      enforceReady: false,
      enforceReasons: ["model_uncalibrated"],
      conservativePnlUsd: -0.6,
    });
  });

  it("uses reference economics for an indicative decision", () => {
    const audit = buildMismatchRiskAudit({
      opportunity: opportunity({ eligible: false }),
      estimate: estimate({
        economicsBasis: "reference",
        economicsPairSize: 5,
        economicsTotalCostUsd: 4.5,
        pFatalUpper95: 0.02,
        maximumAllowedFatalProbability: 0.05,
      }),
      policy: policy({
        economics: null,
        economicGate: null,
        diagnosticReasons: [
          {
            code: "estimate_invalid",
            message: "Taille appariée invalide",
          },
        ],
        blockingReasons: [
          {
            code: "estimate_invalid",
            message: "Taille appariée invalide",
          },
        ],
        allowed: false,
      }),
      evaluatedAt: 123_000,
      source: "scan",
    });

    expect(audit).toMatchObject({
      decision: "reference_allow",
      baseEligible: false,
      economicsBasis: "reference",
      pairSize: 5,
      totalCostUsd: 4.5,
      blockingReasonCodes: [],
      diagnosticReasonCodes: [],
      enforceReady: false,
      enforceReasons: expect.arrayContaining([
        "model_uncalibrated",
        "reference_economics_only",
      ]),
    });
  });

  it("marks a non-economic reference pair without treating it as executable", () => {
    const audit = buildMismatchRiskAudit({
      opportunity: opportunity({ eligible: false }),
      estimate: estimate({
        economicsBasis: "reference",
        economicsPairSize: 5,
        economicsTotalCostUsd: 4.75,
        pFatalUpper95: 0.08,
      }),
      policy: policy({
        allowed: false,
        economics: null,
        economicGate: null,
        diagnosticReasons: [
          { code: "estimate_invalid", message: "Taille appariée invalide" },
        ],
        blockingReasons: [
          { code: "estimate_invalid", message: "Taille appariée invalide" },
        ],
      }),
      evaluatedAt: 123_000,
      source: "scan",
    });

    expect(audit).toMatchObject({
      decision: "reference_block",
      economicsBasis: "reference",
      blockingReasonCodes: ["fatal_probability_above_limit"],
      enforceReady: false,
    });
    expect(audit.maximumAllowedFatalProbability).toBeCloseTo(0.025);
  });

  it("includes every condition that real enforce mode would reject", () => {
    const audit = buildMismatchRiskAudit({
      opportunity: opportunity(),
      estimate: estimate({ modelVersion: "calibrated-v1" }),
      policy: policy({
        diagnosticReasons: [
          { code: "invalid_capital", message: "Capital invalide" },
          {
            code: "cluster_absolute_budget_exceeded",
            message: "Budget absolu dépassé",
          },
        ],
      }),
      evaluatedAt: 123_000,
      source: "execution",
    });

    expect(audit).toMatchObject({
      enforceReady: false,
      enforceReasons: [
        "invalid_capital",
        "cluster_absolute_budget_exceeded",
      ],
    });
  });

  it("reconstructs older intents and preserves the legacy size reduction", () => {
    const audit = reconstructMismatchRiskAudit({
      createdAt: 456_000,
      entrySizingReason: "Notionnel réduit par safeguard mismatch (medium): taille x0.5",
      mismatchPFatal: 0.02,
      mismatchPFatalUpper: 0.08,
      mismatchModelVersion: "legacy-uncalibrated",
      conservativeExpectedPnlUsd: -0.2,
      fatalMismatchPnlUsd: -9,
      legs: [
        { requestedSize: 10, requestedNotionalUsd: 4, feeUsd: 0.05 },
        { requestedSize: 10, requestedNotionalUsd: 5, feeUsd: 0.05 },
      ],
    } as OrderIntent);

    expect(audit).toMatchObject({
      source: "reconstructed",
      decision: "would_block",
      legacyGuardAction: "reduce_size",
      legacySizeMultiplier: 0.5,
      executionUsable: false,
    });
    expect(audit?.maximumAllowedFatalProbability).toBeCloseTo(0.045);
  });
});

function opportunity(overrides: Partial<LiveOpportunity> = {}): LiveOpportunity {
  return {
    eligible: true,
    reasons: [],
    mismatchGuardAction: "allow",
    mismatchSizeMultiplier: 1,
    ...overrides,
  } as LiveOpportunity;
}

function estimate(
  overrides: Partial<MismatchRiskEstimate> = {},
): MismatchRiskEstimate {
  return {
    available: true,
    executionUsable: true,
    executionReason: null,
    modelVersion: "structural-uncalibrated",
    reason: null,
    pFatal: 0.04,
    pFatalUpper95: 0.08,
    pAligned: 0.91,
    pDouble: 0.05,
    expectedPnlUsd: 0.1,
    conservativePnlUsd: -0.2,
    fatalPnlUsd: -9,
    breakEvenFatalProbability: 0.1,
    maximumAllowedFatalProbability: 0.05,
    chainlinkAgeMs: 100,
    cfAgeMs: 100,
    observationCount: 100,
    economicsBasis: "executable",
    economicsPairSize: 10,
    economicsTotalCostUsd: 9,
    ...overrides,
  };
}

function policy(
  overrides: Partial<MismatchRiskPolicyCheck> = {},
): MismatchRiskPolicyCheck {
  return {
    mode: "block_only",
    allowed: true,
    diagnosticReasons: [],
    blockingReasons: [],
    economics: {
      pairSize: 10,
      totalCostUsd: 9,
      fatalLossUsd: 9,
      pFatalUpper95: 0.08,
    },
    economicGate: {
      eligible: false,
      reason: "fatal_probability_above_limit",
      pBreakEven: 0.1,
      maximumAllowedFatalProbability: 0.05,
      probabilityHeadroom: -0.03,
    },
    clusterExposure: { slotEndTs: 1, exposures: [], invalidIntentIds: [] },
    clusterBudgetBefore: null,
    clusterBudgetAfter: null,
    ...overrides,
  };
}
