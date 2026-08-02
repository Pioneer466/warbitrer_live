import { evaluateEconomicMismatchGate } from "@/lib/mismatch-risk";
import type { MismatchRiskPolicyCheck } from "@/lib/mismatch-risk-policy";
import type {
  LiveOpportunity,
  MismatchEconomicsBasis,
  MismatchRiskAudit,
  MismatchRiskEstimate,
  OrderIntent,
} from "@/lib/types";

export function buildMismatchRiskAudit(input: {
  opportunity: LiveOpportunity;
  estimate: MismatchRiskEstimate;
  policy: MismatchRiskPolicyCheck;
  evaluatedAt: number;
  source: "scan" | "execution";
  safetyFractionOfBreakEven?: number;
}): MismatchRiskAudit {
  if (input.policy.mode !== "block_only") {
    throw new Error("Mismatch counterfactual audit requires block_only policy");
  }

  const economicsBasis = readEconomicsBasis(input.estimate, input.policy);
  const pairSize = input.estimate.economicsPairSize ?? input.policy.economics?.pairSize ?? null;
  const totalCostUsd = input.estimate.economicsTotalCostUsd ?? input.policy.economics?.totalCostUsd ?? null;
  const referenceGate =
    economicsBasis === "reference" &&
    isPositiveFinite(pairSize) &&
    isNonNegativeFinite(totalCostUsd) &&
    isProbability(input.estimate.pFatalUpper95)
      ? evaluateEconomicMismatchGate({
          pairSize,
          totalCostUsd,
          pFatalUpper95: input.estimate.pFatalUpper95,
          safetyFractionOfBreakEven: input.safetyFractionOfBreakEven,
        })
      : null;
  const economicGate = input.policy.economicGate ?? referenceGate;
  const diagnosticReasonCodes = input.policy.diagnosticReasons
    .map((reason) => reason.code)
    .filter((code) => economicsBasis !== "reference" || code !== "estimate_invalid");
  const enforceReasons = deriveEnforceReasons(input.estimate, diagnosticReasonCodes, economicsBasis);
  const blockingReasons = readAuditBlockingReasons(economicsBasis, input.policy, referenceGate);

  return {
    evaluatedAt: input.evaluatedAt,
    policyMode: "block_only",
    decision: deriveDecision({
      basis: economicsBasis,
      estimate: input.estimate,
      policy: input.policy,
      referenceGate,
    }),
    source: input.source,
    baseEligible: input.opportunity.eligible,
    baseReasons: [...input.opportunity.reasons],
    blockingReasonCodes: blockingReasons.codes,
    blockingReasons: blockingReasons.messages,
    diagnosticReasonCodes,
    economicsBasis,
    pairSize,
    totalCostUsd,
    breakEvenFatalProbability: economicGate?.pBreakEven ?? input.estimate.breakEvenFatalProbability,
    maximumAllowedFatalProbability:
      economicGate?.maximumAllowedFatalProbability ?? input.estimate.maximumAllowedFatalProbability,
    pFatal: input.estimate.pFatal,
    pFatalUpper95: input.estimate.pFatalUpper95,
    conservativePnlUsd:
      economicsBasis === "executable" && input.estimate.available
        ? (input.opportunity.conservativeExpectedPnlUsd ?? input.estimate.conservativePnlUsd)
        : input.estimate.conservativePnlUsd,
    fatalPnlUsd:
      economicsBasis === "executable"
        ? (input.opportunity.fatalMismatchPnlUsd ?? input.estimate.fatalPnlUsd)
        : input.estimate.fatalPnlUsd,
    estimateAvailable: input.estimate.available,
    executionUsable: input.estimate.executionUsable !== false,
    executionReason: input.estimate.executionReason ?? null,
    modelVersion: input.estimate.modelVersion,
    enforceReady: enforceReasons.length === 0,
    enforceReasons,
    legacyGuardAction: input.opportunity.mismatchGuardAction,
    legacySizeMultiplier: input.opportunity.mismatchSizeMultiplier,
  };
}

function readAuditBlockingReasons(
  basis: MismatchEconomicsBasis,
  policy: MismatchRiskPolicyCheck,
  referenceGate: ReturnType<typeof evaluateEconomicMismatchGate> | null,
) {
  if (basis === "reference") {
    if (!referenceGate || referenceGate.eligible) {
      return { codes: [], messages: [] };
    }
    return {
      codes: [referenceGate.reason],
      messages: [
        referenceGate.reason === "non_positive_aligned_margin"
          ? "Marge alignée de référence non positive"
          : "Probabilité fatale supérieure à la limite de référence",
      ],
    };
  }
  if (basis === "unavailable") {
    return { codes: [], messages: [] };
  }
  return {
    codes: policy.blockingReasons.map((reason) => reason.code),
    messages: policy.blockingReasons.map((reason) => reason.message),
  };
}

export function reconstructMismatchRiskAudit(
  intent: OrderIntent,
  evaluatedAt = intent.mismatchRiskAudit?.evaluatedAt ?? intent.createdAt,
): MismatchRiskAudit | null {
  if (intent.mismatchRiskAudit) {
    return intent.mismatchRiskAudit;
  }
  if (!isProbability(intent.mismatchPFatalUpper)) {
    return null;
  }
  const pairSize = Math.min(...intent.legs.map((leg) => leg.requestedSize));
  const totalCostUsd = intent.legs.reduce((sum, leg) => sum + leg.requestedNotionalUsd + Math.max(0, leg.feeUsd), 0);
  if (!isPositiveFinite(pairSize) || !isNonNegativeFinite(totalCostUsd)) {
    return null;
  }

  const gate = evaluateEconomicMismatchGate({
    pairSize,
    totalCostUsd,
    pFatalUpper95: intent.mismatchPFatalUpper,
  });
  const blockingReasonCode = gate.eligible ? null : gate.reason;
  const legacySizeMultiplier = readLegacySizeMultiplier(intent.entrySizingReason);
  const modelVersion = intent.mismatchModelVersion ?? "historical-model-unknown";
  const enforceReasons = ["historical_execution_quality_unavailable"];
  if (modelVersion.toLowerCase().includes("uncalibrated")) {
    enforceReasons.push("model_uncalibrated");
  }

  return {
    evaluatedAt,
    policyMode: "block_only",
    decision: gate.eligible ? "would_allow" : "would_block",
    source: "reconstructed",
    baseEligible: true,
    baseReasons: [],
    blockingReasonCodes: blockingReasonCode ? [blockingReasonCode] : [],
    blockingReasons: blockingReasonCode ? [blockingReasonCode] : [],
    diagnosticReasonCodes: blockingReasonCode ? [blockingReasonCode] : [],
    economicsBasis: "executable",
    pairSize,
    totalCostUsd,
    breakEvenFatalProbability: gate.pBreakEven,
    maximumAllowedFatalProbability: gate.maximumAllowedFatalProbability,
    pFatal: intent.mismatchPFatal ?? null,
    pFatalUpper95: intent.mismatchPFatalUpper,
    conservativePnlUsd: intent.conservativeExpectedPnlUsd ?? null,
    fatalPnlUsd: intent.fatalMismatchPnlUsd ?? null,
    estimateAvailable: true,
    executionUsable: false,
    executionReason: "historical_execution_quality_unavailable",
    modelVersion,
    enforceReady: false,
    enforceReasons,
    legacyGuardAction: legacySizeMultiplier < 1 ? "reduce_size" : "allow",
    legacySizeMultiplier,
  };
}

function deriveDecision(input: {
  basis: MismatchEconomicsBasis;
  estimate: MismatchRiskEstimate;
  policy: MismatchRiskPolicyCheck;
  referenceGate: ReturnType<typeof evaluateEconomicMismatchGate> | null;
}): MismatchRiskAudit["decision"] {
  if (input.basis === "reference") {
    if (!input.referenceGate) {
      return "unavailable";
    }
    return input.referenceGate.eligible ? "reference_allow" : "reference_block";
  }
  if (input.basis === "unavailable") {
    return "unavailable";
  }
  if (!input.estimate.available) {
    return "would_allow_fail_open";
  }
  return input.policy.allowed ? "would_allow" : "would_block";
}

function readEconomicsBasis(estimate: MismatchRiskEstimate, policy: MismatchRiskPolicyCheck): MismatchEconomicsBasis {
  if (estimate.economicsBasis) {
    return estimate.economicsBasis;
  }
  return policy.economics ? "executable" : "unavailable";
}

function deriveEnforceReasons(
  estimate: MismatchRiskEstimate,
  diagnosticReasonCodes: string[],
  economicsBasis: MismatchEconomicsBasis,
) {
  const reasons = [...diagnosticReasonCodes];
  if (economicsBasis === "reference") {
    reasons.push("reference_economics_only");
  }
  if (estimate.modelVersion.toLowerCase().includes("uncalibrated") && !reasons.includes("model_uncalibrated")) {
    reasons.push("model_uncalibrated");
  }
  return [...new Set(reasons)];
}

function readLegacySizeMultiplier(reason: string | null | undefined) {
  const match = reason?.match(/taille x(\d+(?:\.\d+)?)/i);
  const parsed = match ? Number(match[1]) : 1;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 1;
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isProbability(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
