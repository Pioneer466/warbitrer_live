import { calculateHybridClusterBudget, evaluateEconomicMismatchGate } from "@/lib/mismatch-risk";
import type {
  EconomicMismatchGateResult,
  HybridClusterBudgetResult,
  MismatchClusterExposure,
} from "@/lib/mismatch-risk";
import { getMismatchFatalBudgetFraction, normalizeGlobalRiskConfig, type GlobalRiskConfig } from "@/lib/risk-settings";
import type {
  LiveOpportunity,
  MismatchRiskEstimate,
  MismatchRiskMode,
  OrderIntent,
  OrderIntentStatus,
} from "@/lib/types";

const TERMINAL_INTENT_STATUSES = new Set<OrderIntentStatus>(["settled", "failed", "skipped", "canceled", "unwound"]);

export type MismatchRiskPolicyReasonCode =
  | "estimate_unavailable"
  | "estimate_invalid"
  | "execution_reference_unusable"
  | "model_uncalibrated"
  | "non_positive_aligned_margin"
  | "fatal_probability_above_limit"
  | "invalid_capital"
  | "invalid_risk_config"
  | "cluster_exposure_unavailable"
  | "cluster_expected_budget_exceeded"
  | "cluster_absolute_budget_exceeded";

export type MismatchRiskPolicyReason = {
  code: MismatchRiskPolicyReasonCode;
  message: string;
};

export type IntentMismatchExposure = MismatchClusterExposure & {
  intentId: string;
  fatalLossSource: "fatal_loss_exposure" | "fatal_mismatch_pnl" | "target_notional";
  probabilitySource: "model" | "conservative_fallback";
};

export type MismatchClusterExposureSummary = {
  slotEndTs: number;
  exposures: IntentMismatchExposure[];
  invalidIntentIds: string[];
};

export type MismatchRiskCandidateEconomics = {
  pairSize: number;
  totalCostUsd: number;
  fatalLossUsd: number;
  pFatalUpper95: number;
};

export type MismatchRiskPolicyInput = {
  opportunity: LiveOpportunity;
  estimate: MismatchRiskEstimate;
  mode?: MismatchRiskMode;
  slotEndTs: number;
  openIntents: OrderIntent[];
  capitalUsd: number;
  globalRiskConfig: GlobalRiskConfig;
  candidateIntentId?: string | null;
  includeShadowIntents?: boolean;
};

export type MismatchRiskPolicyCheck = {
  mode: MismatchRiskMode;
  allowed: boolean;
  diagnosticReasons: MismatchRiskPolicyReason[];
  blockingReasons: MismatchRiskPolicyReason[];
  economics: MismatchRiskCandidateEconomics | null;
  economicGate: EconomicMismatchGateResult | null;
  clusterExposure: MismatchClusterExposureSummary;
  clusterBudgetBefore: HybridClusterBudgetResult | null;
  clusterBudgetAfter: HybridClusterBudgetResult | null;
};

export type MismatchRiskPolicyResult = MismatchRiskPolicyCheck & {
  opportunity: LiveOpportunity;
};

export function annotateOpportunityWithMismatchRisk(
  opportunity: LiveOpportunity,
  estimate: MismatchRiskEstimate,
): LiveOpportunity {
  const modeledFatalPnlUsd = estimate.available ? estimate.fatalPnlUsd : null;
  const fatalMismatchPnlUsd =
    modeledFatalPnlUsd === null
      ? (opportunity.fatalMismatchPnlUsd ?? null)
      : Math.min(modeledFatalPnlUsd, opportunity.fatalMismatchPnlUsd ?? modeledFatalPnlUsd);
  const modeledConservativePnlUsd = estimate.available ? estimate.conservativePnlUsd : null;
  const conservativeExpectedPnlUsd =
    modeledConservativePnlUsd === null
      ? (opportunity.conservativeExpectedPnlUsd ?? null)
      : Math.min(modeledConservativePnlUsd, opportunity.conservativeExpectedPnlUsd ?? modeledConservativePnlUsd);

  return {
    ...opportunity,
    mismatchRiskEstimate: estimate,
    fatalMismatchPnlUsd,
    conservativeExpectedPnlUsd,
    worstCaseProfitUsd: opportunity.worstCaseProfitUsd,
  };
}

export function calculateMismatchClusterExposure(input: {
  slotEndTs: number;
  intents: OrderIntent[];
  excludeIntentId?: string | null;
  includeShadowIntents?: boolean;
}): MismatchClusterExposureSummary {
  const exposures: IntentMismatchExposure[] = [];
  const invalidIntentIds: string[] = [];

  for (const intent of input.intents) {
    if (
      intent.slotEndTs !== input.slotEndTs ||
      intent.id === input.excludeIntentId ||
      TERMINAL_INTENT_STATUSES.has(intent.status) ||
      (!input.includeShadowIntents && intent.shadow)
    ) {
      continue;
    }

    const fatalLoss = readIntentFatalLoss(intent);
    if (!fatalLoss) {
      invalidIntentIds.push(intent.id);
      continue;
    }
    const modelProbability = intent.mismatchPFatalUpper;
    const hasModelProbability = isProbability(modelProbability);
    exposures.push({
      intentId: intent.id,
      fatalLossUsd: fatalLoss.value,
      pFatalUpper95: hasModelProbability ? modelProbability : 1,
      fatalLossSource: fatalLoss.source,
      probabilitySource: hasModelProbability ? "model" : "conservative_fallback",
    });
  }

  return { slotEndTs: input.slotEndTs, exposures, invalidIntentIds };
}

export function recheckMismatchRiskCandidate(input: MismatchRiskPolicyInput): MismatchRiskPolicyCheck {
  const mode = input.mode ?? "shadow";
  const diagnosticReasons: MismatchRiskPolicyReason[] = [];
  const blockingReasons: MismatchRiskPolicyReason[] = [];
  const clusterExposure = calculateMismatchClusterExposure({
    slotEndTs: input.slotEndTs,
    intents: input.openIntents,
    excludeIntentId: input.candidateIntentId,
    includeShadowIntents: input.includeShadowIntents,
  });

  const economicsResult = readCandidateEconomics(input.opportunity, input.estimate);
  const economics = economicsResult.economics;
  const economicGate = economics
    ? evaluateEconomicMismatchGate({
        pairSize: economics.pairSize,
        totalCostUsd: economics.totalCostUsd,
        pFatalUpper95: economics.pFatalUpper95,
        safetyFractionOfBreakEven: getMismatchFatalBudgetFraction(input.globalRiskConfig),
      })
    : null;

  if (isUncalibratedModelVersion(input.estimate.modelVersion)) {
    diagnosticReasons.push(policyReason("model_uncalibrated", input.estimate.modelVersion));
  }

  if (!input.estimate.available) {
    diagnosticReasons.push(policyReason("estimate_unavailable", input.estimate.reason ?? "raison inconnue"));
  } else if (input.estimate.executionUsable === false) {
    diagnosticReasons.push(
      policyReason("execution_reference_unusable", input.estimate.executionReason ?? "références non synchronisées"),
    );
  }

  if (input.estimate.available && !economics) {
    diagnosticReasons.push(policyReason("estimate_invalid", economicsResult.reason ?? "données invalides"));
  } else if (economicGate && !economicGate.eligible) {
    diagnosticReasons.push(
      policyReason(
        economicGate.reason === "non_positive_aligned_margin"
          ? "non_positive_aligned_margin"
          : "fatal_probability_above_limit",
      ),
    );
  }

  if (clusterExposure.invalidIntentIds.length > 0) {
    diagnosticReasons.push(policyReason("cluster_exposure_unavailable", clusterExposure.invalidIntentIds.join(", ")));
  }

  let normalizedConfig: GlobalRiskConfig | null = null;
  let clusterBudgetBefore: HybridClusterBudgetResult | null = null;
  let clusterBudgetAfter: HybridClusterBudgetResult | null = null;
  if (!isPositiveFinite(input.capitalUsd)) {
    diagnosticReasons.push(policyReason("invalid_capital"));
  } else {
    try {
      normalizedConfig = normalizeGlobalRiskConfig(input.globalRiskConfig);
    } catch {
      diagnosticReasons.push(policyReason("invalid_risk_config"));
    }
  }

  if (normalizedConfig) {
    const baseBudgetInput = {
      capitalUsd: input.capitalUsd,
      expectedRiskFraction: normalizedConfig.clusterExpectedFatalLossShare,
      expectedRiskCapUsd: normalizedConfig.clusterExpectedFatalLossCapUsd,
      absoluteRiskFraction: normalizedConfig.clusterAbsoluteFatalLossShare,
      absoluteRiskCapUsd: normalizedConfig.clusterAbsoluteFatalLossCapUsd,
    };
    clusterBudgetBefore = calculateHybridClusterBudget({
      ...baseBudgetInput,
      exposures: clusterExposure.exposures,
    });
    if (economics) {
      clusterBudgetAfter = calculateHybridClusterBudget({
        ...baseBudgetInput,
        exposures: [
          ...clusterExposure.exposures,
          {
            fatalLossUsd: economics.fatalLossUsd,
            pFatalUpper95: economics.pFatalUpper95,
          },
        ],
      });
      if (clusterBudgetAfter.usedExpectedLossUsd > clusterBudgetAfter.expectedLossBudgetUsd + 1e-9) {
        diagnosticReasons.push(policyReason("cluster_expected_budget_exceeded"));
      }
      if (clusterBudgetAfter.usedAbsoluteLossUsd > clusterBudgetAfter.absoluteLossBudgetUsd + 1e-9) {
        diagnosticReasons.push(policyReason("cluster_absolute_budget_exceeded"));
      }
    }
  }

  if (mode === "block_only" && input.estimate.available) {
    copyBlockingReasons(
      diagnosticReasons,
      blockingReasons,
      new Set(["estimate_invalid", "non_positive_aligned_margin", "fatal_probability_above_limit"]),
    );
  } else if (mode === "enforce") {
    copyBlockingReasons(
      diagnosticReasons,
      blockingReasons,
      new Set([
        "estimate_unavailable",
        "estimate_invalid",
        "execution_reference_unusable",
        "model_uncalibrated",
        "non_positive_aligned_margin",
        "fatal_probability_above_limit",
        "invalid_capital",
        "invalid_risk_config",
        "cluster_exposure_unavailable",
        "cluster_expected_budget_exceeded",
        "cluster_absolute_budget_exceeded",
      ]),
    );
  }

  return {
    mode,
    allowed: blockingReasons.length === 0,
    diagnosticReasons: uniqueReasons(diagnosticReasons),
    blockingReasons: uniqueReasons(blockingReasons),
    economics,
    economicGate,
    clusterExposure,
    clusterBudgetBefore,
    clusterBudgetAfter,
  };
}

export function applyMismatchRiskPolicy(input: MismatchRiskPolicyInput): MismatchRiskPolicyResult {
  const check = recheckMismatchRiskCandidate(input);
  const annotated = annotateOpportunityWithMismatchRisk(input.opportunity, input.estimate);
  const blockingMessages = check.blockingReasons.map((reason) => reason.message);
  return {
    ...check,
    opportunity: {
      ...annotated,
      eligible: annotated.eligible && check.allowed,
      reasons: uniqueStrings([...annotated.reasons, ...blockingMessages]),
    },
  };
}

function readCandidateEconomics(
  opportunity: LiveOpportunity,
  estimate: MismatchRiskEstimate,
): { economics: MismatchRiskCandidateEconomics | null; reason: string | null } {
  if (!estimate.available) {
    return { economics: null, reason: estimate.reason };
  }
  const pairSize = Math.min(...opportunity.legs.map((leg) => leg.size));
  const totalCostUsd = opportunity.legs.reduce((total, leg) => total + leg.targetNotionalUsd + leg.feeEstimateUsd, 0);
  if (!isPositiveFinite(pairSize)) {
    return { economics: null, reason: "taille appariée invalide" };
  }
  if (!isPositiveFinite(totalCostUsd)) {
    return { economics: null, reason: "coût candidat invalide" };
  }
  if (!isProbability(estimate.pFatalUpper95)) {
    return { economics: null, reason: "borne pFatalUpper95 invalide" };
  }

  return {
    economics: {
      pairSize,
      totalCostUsd,
      fatalLossUsd: Math.max(totalCostUsd, Math.abs(Math.min(0, opportunity.fatalMismatchPnlUsd ?? 0))),
      pFatalUpper95: estimate.pFatalUpper95,
    },
    reason: null,
  };
}

function readIntentFatalLoss(intent: OrderIntent): {
  value: number;
  source: IntentMismatchExposure["fatalLossSource"];
} | null {
  if (isNonNegativeFinite(intent.fatalLossExposureUsd)) {
    return { value: intent.fatalLossExposureUsd, source: "fatal_loss_exposure" };
  }
  if (isNonPositiveFinite(intent.fatalMismatchPnlUsd)) {
    return {
      value: Math.abs(intent.fatalMismatchPnlUsd),
      source: "fatal_mismatch_pnl",
    };
  }
  if (isNonNegativeFinite(intent.targetNotionalUsd)) {
    const conservativeLegCost = (Array.isArray(intent.legs) ? intent.legs : []).reduce((sum, leg) => {
      const limitNotional = leg.requestedPrice === null ? 0 : Math.max(0, leg.requestedSize * leg.requestedPrice);
      return sum + Math.max(0, leg.requestedNotionalUsd, limitNotional) + Math.max(0, leg.feeUsd);
    }, 0);
    return {
      value: Math.max(intent.targetNotionalUsd, conservativeLegCost),
      source: "target_notional",
    };
  }
  return null;
}

function policyReason(code: MismatchRiskPolicyReasonCode, details?: string): MismatchRiskPolicyReason {
  const suffix = details ? ` (${details})` : "";
  switch (code) {
    case "estimate_unavailable":
      return { code, message: `Modèle mismatch indisponible${suffix}` };
    case "estimate_invalid":
      return { code, message: `Estimation mismatch invalide${suffix}` };
    case "execution_reference_unusable":
      return { code, message: `Références trop anciennes ou désynchronisées pour exécution${suffix}` };
    case "model_uncalibrated":
      return { code, message: `Modèle mismatch non calibré${suffix}` };
    case "non_positive_aligned_margin":
      return { code, message: "Marge alignée non positive après frais" };
    case "fatal_probability_above_limit":
      return {
        code,
        message: "Probabilité fatale supérieure à la limite économique",
      };
    case "invalid_capital":
      return { code, message: "Capital global invalide pour le budget mismatch" };
    case "invalid_risk_config":
      return { code, message: "Configuration globale du risque mismatch invalide" };
    case "cluster_exposure_unavailable":
      return {
        code,
        message: `Exposition mismatch du cluster indéterminée${suffix}`,
      };
    case "cluster_expected_budget_exceeded":
      return { code, message: "Budget de perte fatale probabilisée dépassé" };
    case "cluster_absolute_budget_exceeded":
      return { code, message: "Budget de perte fatale absolue dépassé" };
  }
}

function copyBlockingReasons(
  source: MismatchRiskPolicyReason[],
  target: MismatchRiskPolicyReason[],
  blockingCodes: Set<MismatchRiskPolicyReasonCode>,
): void {
  target.push(...source.filter((reason) => blockingCodes.has(reason.code)));
}

function uniqueReasons(reasons: MismatchRiskPolicyReason[]): MismatchRiskPolicyReason[] {
  const byCode = new Map<MismatchRiskPolicyReasonCode, MismatchRiskPolicyReason>();
  for (const reason of reasons) {
    if (!byCode.has(reason.code)) {
      byCode.set(reason.code, reason);
    }
  }
  return [...byCode.values()];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isUncalibratedModelVersion(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase().includes("uncalibrated");
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value <= 0;
}
