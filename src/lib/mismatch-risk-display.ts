import type { LiveOpportunity, MismatchRiskEstimate } from "@/lib/types";

export type MismatchModelDisplayState = "unavailable" | "uncalibrated" | "calibrated";

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

export function selectHighestRiskEstimate(
  opportunities: LiveOpportunity[],
): MismatchRiskEstimate | null {
  const estimates = opportunities
    .map((opportunity) => opportunity.mismatchRiskEstimate ?? null)
    .filter((estimate): estimate is MismatchRiskEstimate => estimate !== null);

  return estimates.reduce<MismatchRiskEstimate | null>((selected, estimate) => {
    if (!selected) {
      return estimate;
    }

    return readComparableProbability(estimate) > readComparableProbability(selected)
      ? estimate
      : selected;
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

function readComparableProbability(estimate: MismatchRiskEstimate) {
  if (!estimate.available) {
    return Number.NEGATIVE_INFINITY;
  }

  return estimate.pFatalUpper95 ?? estimate.pFatal ?? Number.NEGATIVE_INFINITY;
}
