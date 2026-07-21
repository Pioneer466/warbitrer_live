import { reconstructMismatchRiskAudit } from "@/lib/mismatch-risk-audit";
import type {
  LiveOpportunity,
  MismatchEconomicsBasis,
  MismatchRiskCounterfactualDecision,
  MismatchRiskEstimate,
  OrderIntent,
} from "@/lib/types";

export type MismatchModelDisplayState = "unavailable" | "uncalibrated" | "calibrated";

export type MismatchSettlementClassification = "aligned" | "double_payout" | "fatal_mismatch";

export type MismatchAuditSummary = {
  auditedCount: number;
  allowCount: number;
  blockCount: number;
  failOpenCount: number;
  unavailableCount: number;
  enforceReadyCount: number;
  enforceNotReadyCount: number;
  classifiedSettlementCount: number;
  alignedSettlementCount: number;
  doublePayoutCount: number;
  fatalMismatchCount: number;
};

export function getMismatchModelDisplayState(
  estimate: MismatchRiskEstimate | null | undefined,
): MismatchModelDisplayState {
  if (!estimate) {
    return "unavailable";
  }

  if (estimate.modelVersion.toLowerCase().includes("uncalibrated")) {
    return "uncalibrated";
  }

  return estimate.available ? "calibrated" : "unavailable";
}

export function selectHighestRiskEstimate(opportunities: LiveOpportunity[]): MismatchRiskEstimate | null {
  const estimates = opportunities
    .map((opportunity) => opportunity.mismatchRiskEstimate ?? null)
    .filter((estimate): estimate is MismatchRiskEstimate => estimate !== null);

  return estimates.reduce<MismatchRiskEstimate | null>((selected, estimate) => {
    if (!selected) {
      return estimate;
    }

    return readComparableProbability(estimate) > readComparableProbability(selected) ? estimate : selected;
  }, null);
}

export function formatRiskProbability(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }

  const factor = 10 ** digits;
  const percent = Math.max(0, value) * 100;
  const rounded = Math.round((percent + 1e-12) * factor) / factor;
  return `${rounded.toFixed(digits)}%`;
}

export function formatRiskAge(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) {
    return "--";
  }

  if (value < 1_000) {
    return `${Math.round(value)}ms`;
  }

  return `${(value / 1_000).toFixed(1)}s`;
}

export function formatMismatchAuditDecision(decision: MismatchRiskCounterfactualDecision) {
  const labels: Record<MismatchRiskCounterfactualDecision, string> = {
    would_allow: "aurait autorisé",
    would_block: "aurait bloqué",
    would_allow_fail_open: "autorisé fail-open",
    reference_allow: "référence autorisée",
    reference_block: "référence bloquée",
    unavailable: "verdict indisponible",
  };
  return labels[decision];
}

export function formatMismatchEconomicsBasis(basis: MismatchEconomicsBasis) {
  const labels: Record<MismatchEconomicsBasis, string> = {
    executable: "économie exécutable",
    reference: "économie de référence",
    unavailable: "économie indisponible",
  };
  return labels[basis];
}

export function isMismatchBlockingDecision(decision: MismatchRiskCounterfactualDecision) {
  return decision === "would_block" || decision === "reference_block";
}

export function readOpportunityMismatchEconomics(opportunity: LiveOpportunity) {
  const audit = opportunity.mismatchRiskAudit;
  if (audit) {
    return {
      basis: audit.economicsBasis,
      pairSize: audit.pairSize,
      totalCostUsd: audit.totalCostUsd,
      source: "audit" as const,
    };
  }

  const estimate = opportunity.mismatchRiskEstimate;
  if (!estimate?.economicsBasis) {
    return null;
  }

  return {
    basis: estimate.economicsBasis,
    pairSize: estimate.economicsPairSize ?? null,
    totalCostUsd: estimate.economicsTotalCostUsd ?? null,
    source: "estimate" as const,
  };
}

export function readIntentMismatchRiskAudit(intent: OrderIntent) {
  return reconstructMismatchRiskAudit(intent);
}

export function classifySettledIntentMismatch(intent: OrderIntent): MismatchSettlementClassification | null {
  if (intent.status !== "settled" || intent.polyResolution === null || intent.kalshiResolution === null) {
    return null;
  }

  const polymarketLeg = intent.legs.find((leg) => leg.venue === "polymarket");
  const kalshiLeg = intent.legs.find((leg) => leg.venue === "kalshi");
  if (!polymarketLeg || !kalshiLeg) {
    return null;
  }

  const winningLegCount =
    Number(polymarketLeg.outcome === intent.polyResolution) + Number(kalshiLeg.outcome === intent.kalshiResolution);
  if (winningLegCount === 0) {
    return "fatal_mismatch";
  }
  if (winningLegCount === 2) {
    return "double_payout";
  }
  return "aligned";
}

export function formatMismatchSettlementClassification(classification: MismatchSettlementClassification) {
  const labels: Record<MismatchSettlementClassification, string> = {
    aligned: "aligné · 1 payout",
    double_payout: "mismatch favorable · 2 payouts",
    fatal_mismatch: "mismatch fatal · 0 payout",
  };
  return labels[classification];
}

export function formatMismatchAuditSettlementLabel(
  decision: MismatchRiskCounterfactualDecision,
  classification: MismatchSettlementClassification,
) {
  const decisionLabels: Record<MismatchRiskCounterfactualDecision, string> = {
    would_allow: "autorisé",
    would_block: "bloqué",
    would_allow_fail_open: "fail-open",
    reference_allow: "référence autorisée",
    reference_block: "référence bloquée",
    unavailable: "sans verdict",
  };
  const settlementLabels: Record<MismatchSettlementClassification, string> = {
    aligned: "aligné",
    double_payout: "double payout",
    fatal_mismatch: "fatal",
  };
  return `${decisionLabels[decision]} + ${settlementLabels[classification]}`;
}

export function summarizeMismatchRiskAudits(intents: OrderIntent[]): MismatchAuditSummary {
  const summary: MismatchAuditSummary = {
    auditedCount: 0,
    allowCount: 0,
    blockCount: 0,
    failOpenCount: 0,
    unavailableCount: 0,
    enforceReadyCount: 0,
    enforceNotReadyCount: 0,
    classifiedSettlementCount: 0,
    alignedSettlementCount: 0,
    doublePayoutCount: 0,
    fatalMismatchCount: 0,
  };

  for (const intent of intents) {
    const audit = intent.mismatchRiskAudit;
    if (!audit || audit.source !== "execution") {
      continue;
    }

    summary.auditedCount += 1;
    if (isMismatchBlockingDecision(audit.decision)) {
      summary.blockCount += 1;
    } else if (audit.decision === "would_allow_fail_open") {
      summary.failOpenCount += 1;
    } else if (audit.decision === "unavailable") {
      summary.unavailableCount += 1;
    } else {
      summary.allowCount += 1;
    }

    if (audit.enforceReady) {
      summary.enforceReadyCount += 1;
    } else {
      summary.enforceNotReadyCount += 1;
    }

    const settlement = classifySettledIntentMismatch(intent);
    if (settlement) {
      summary.classifiedSettlementCount += 1;
      if (settlement === "fatal_mismatch") {
        summary.fatalMismatchCount += 1;
      } else if (settlement === "double_payout") {
        summary.doublePayoutCount += 1;
      } else {
        summary.alignedSettlementCount += 1;
      }
    }
  }

  return summary;
}

function readComparableProbability(estimate: MismatchRiskEstimate) {
  if (!estimate.available) {
    return Number.NEGATIVE_INFINITY;
  }

  return estimate.pFatalUpper95 ?? estimate.pFatal ?? Number.NEGATIVE_INFINITY;
}
