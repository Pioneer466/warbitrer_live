export type MismatchCombination = "POLY_UP_KALSHI_NO" | "POLY_DOWN_KALSHI_YES";

export type CfFinalAverageConditioningInput = {
  observedAverage: number;
  observedSampleCount: number;
  remainingMean: number;
  /** Standard deviation of the forecast mean of the remaining samples. */
  remainingMeanStdDev: number;
  strike?: number;
  totalSampleCount?: number;
};

export type CfFinalAverageConditioningResult = {
  finalAverageMean: number;
  finalAverageStdDev: number;
  observedSampleCount: number;
  remainingSampleCount: number;
  observedWeight: number;
  remainingWeight: number;
  requiredRemainingMeanToReachStrike: number | null;
};

export type JointGaussianOutcomeInput = {
  chainlinkStartPrice: number;
  chainlinkTerminalMean: number;
  chainlinkTerminalStdDev: number;
  kalshiStrikePrice: number;
  cfFinalAverageMean: number;
  cfFinalAverageStdDev: number;
  correlation: number;
};

export type JointOutcomeProbabilities = {
  polyUpKalshiYes: number;
  polyUpKalshiNo: number;
  polyDownKalshiYes: number;
  polyDownKalshiNo: number;
};

export type MismatchOutcomeProbabilities = {
  combination: MismatchCombination;
  pFatal: number;
  pAligned: number;
  pDouble: number;
  quadrants: JointOutcomeProbabilities;
};

export type MismatchRiskModelInput = JointGaussianOutcomeInput & {
  combination: MismatchCombination;
  asOfMs: number;
  chainlinkSourceTimestampMs: number;
  cfSourceTimestampMs: number;
  maxSourceAgeMs: number;
  maxFutureSkewMs?: number;
};

export type MismatchRiskUnavailableReason =
  "invalid_input" | "chainlink_stale" | "cf_stale" | "chainlink_timestamp_in_future" | "cf_timestamp_in_future";

export type MismatchRiskModelResult =
  | {
      available: true;
      probabilities: MismatchOutcomeProbabilities;
      chainlinkAgeMs: number;
      cfAgeMs: number;
    }
  | {
      available: false;
      reason: MismatchRiskUnavailableReason;
    };

export type MismatchAdjustedPnlInput = {
  pairSize: number;
  totalCostUsd: number;
  probabilities: Pick<MismatchOutcomeProbabilities, "pFatal" | "pAligned" | "pDouble">;
  pFatalUpper95: number;
};

export type FatalProbabilityCalibrationInput = {
  fatalCount: number;
  totalCount: number;
  priorAlpha?: number;
  priorBeta?: number;
  confidence?: number;
};

export type EconomicMismatchGateInput = {
  pairSize: number;
  totalCostUsd: number;
  pFatalUpper95: number;
  safetyFractionOfBreakEven?: number;
};

export type EconomicMismatchGateResult = {
  eligible: boolean;
  reason: "eligible" | "non_positive_aligned_margin" | "fatal_probability_above_limit";
  pBreakEven: number;
  maximumAllowedFatalProbability: number;
  probabilityHeadroom: number;
};

export type MismatchClusterExposure = {
  fatalLossUsd: number;
  pFatalUpper95: number;
};

export type HybridClusterBudgetInput = {
  capitalUsd: number;
  exposures: MismatchClusterExposure[];
  expectedRiskFraction?: number;
  expectedRiskCapUsd?: number;
  absoluteRiskFraction?: number;
  absoluteRiskCapUsd?: number;
};

export type HybridClusterBudgetResult = {
  expectedLossBudgetUsd: number;
  absoluteLossBudgetUsd: number;
  usedExpectedLossUsd: number;
  usedAbsoluteLossUsd: number;
  remainingExpectedLossUsd: number;
  remainingAbsoluteLossUsd: number;
  withinBudget: boolean;
  limitingBudget: "none" | "expected" | "absolute" | "both";
};

export const DEFAULT_EXPECTED_CLUSTER_RISK_FRACTION = 0.05;
export const DEFAULT_EXPECTED_CLUSTER_RISK_CAP_USD = 25;
export const DEFAULT_ABSOLUTE_CLUSTER_RISK_FRACTION = 0.15;
export const DEFAULT_ABSOLUTE_CLUSTER_RISK_CAP_USD = 75;

const DEFAULT_CF_SAMPLE_COUNT = 60;
const DEFAULT_MAX_FUTURE_SKEW_MS = 1_000;
const PROBABILITY_TOLERANCE = 1e-9;

export function conditionCfFinalAverage(input: CfFinalAverageConditioningInput): CfFinalAverageConditioningResult {
  const totalSampleCount = input.totalSampleCount ?? DEFAULT_CF_SAMPLE_COUNT;

  assertPositiveInteger(totalSampleCount, "totalSampleCount");
  assertNonNegativeInteger(input.observedSampleCount, "observedSampleCount");
  if (input.observedSampleCount > totalSampleCount) {
    throw new RangeError("observedSampleCount cannot exceed totalSampleCount");
  }

  assertPositiveFinite(input.observedAverage, "observedAverage");
  assertPositiveFinite(input.remainingMean, "remainingMean");
  assertNonNegativeFinite(input.remainingMeanStdDev, "remainingMeanStdDev");
  if (input.strike !== undefined) {
    assertPositiveFinite(input.strike, "strike");
  }

  const remainingSampleCount = totalSampleCount - input.observedSampleCount;
  const observedWeight = input.observedSampleCount / totalSampleCount;
  const remainingWeight = remainingSampleCount / totalSampleCount;
  const finalAverageMean = input.observedAverage * observedWeight + input.remainingMean * remainingWeight;
  const finalAverageStdDev = input.remainingMeanStdDev * remainingWeight;

  return {
    finalAverageMean,
    finalAverageStdDev,
    observedSampleCount: input.observedSampleCount,
    remainingSampleCount,
    observedWeight,
    remainingWeight,
    requiredRemainingMeanToReachStrike:
      input.strike === undefined || remainingSampleCount === 0
        ? null
        : (totalSampleCount * input.strike - input.observedSampleCount * input.observedAverage) / remainingSampleCount,
  };
}

export function calculateJointGaussianOutcomeProbabilities(
  input: JointGaussianOutcomeInput,
): JointOutcomeProbabilities {
  assertJointGaussianInput(input);

  if (input.chainlinkTerminalStdDev === 0 && input.cfFinalAverageStdDev === 0) {
    return deterministicQuadrants(
      input.chainlinkTerminalMean >= input.chainlinkStartPrice,
      input.cfFinalAverageMean >= input.kalshiStrikePrice,
    );
  }

  if (input.chainlinkTerminalStdDev === 0) {
    const polyUp = input.chainlinkTerminalMean >= input.chainlinkStartPrice;
    const pKalshiNo = normalCdf((input.kalshiStrikePrice - input.cfFinalAverageMean) / input.cfFinalAverageStdDev);
    return polyUp
      ? normalizeQuadrants({
          polyUpKalshiYes: 1 - pKalshiNo,
          polyUpKalshiNo: pKalshiNo,
          polyDownKalshiYes: 0,
          polyDownKalshiNo: 0,
        })
      : normalizeQuadrants({
          polyUpKalshiYes: 0,
          polyUpKalshiNo: 0,
          polyDownKalshiYes: 1 - pKalshiNo,
          polyDownKalshiNo: pKalshiNo,
        });
  }

  if (input.cfFinalAverageStdDev === 0) {
    const kalshiYes = input.cfFinalAverageMean >= input.kalshiStrikePrice;
    const pPolyDown = normalCdf(
      (input.chainlinkStartPrice - input.chainlinkTerminalMean) / input.chainlinkTerminalStdDev,
    );
    return kalshiYes
      ? normalizeQuadrants({
          polyUpKalshiYes: 1 - pPolyDown,
          polyUpKalshiNo: 0,
          polyDownKalshiYes: pPolyDown,
          polyDownKalshiNo: 0,
        })
      : normalizeQuadrants({
          polyUpKalshiYes: 0,
          polyUpKalshiNo: 1 - pPolyDown,
          polyDownKalshiYes: 0,
          polyDownKalshiNo: pPolyDown,
        });
  }

  const chainlinkBoundary = (input.chainlinkStartPrice - input.chainlinkTerminalMean) / input.chainlinkTerminalStdDev;
  const kalshiBoundary = (input.kalshiStrikePrice - input.cfFinalAverageMean) / input.cfFinalAverageStdDev;
  const pPolyDown = normalCdf(chainlinkBoundary);
  const pKalshiNo = normalCdf(kalshiBoundary);
  const pPolyDownKalshiNo = bivariateNormalCdf(chainlinkBoundary, kalshiBoundary, input.correlation);

  return normalizeQuadrants({
    polyUpKalshiYes: 1 - pPolyDown - pKalshiNo + pPolyDownKalshiNo,
    polyUpKalshiNo: pKalshiNo - pPolyDownKalshiNo,
    polyDownKalshiYes: pPolyDown - pPolyDownKalshiNo,
    polyDownKalshiNo: pPolyDownKalshiNo,
  });
}

export function calculateMismatchOutcomeProbabilities(
  combination: MismatchCombination,
  quadrants: JointOutcomeProbabilities,
): MismatchOutcomeProbabilities {
  assertCombination(combination);
  assertQuadrants(quadrants);

  const pAligned = quadrants.polyUpKalshiYes + quadrants.polyDownKalshiNo;
  const pFatal = combination === "POLY_UP_KALSHI_NO" ? quadrants.polyDownKalshiYes : quadrants.polyUpKalshiNo;
  const pDouble = combination === "POLY_UP_KALSHI_NO" ? quadrants.polyUpKalshiNo : quadrants.polyDownKalshiYes;

  return {
    combination,
    pFatal: clampProbability(pFatal),
    pAligned: clampProbability(pAligned),
    pDouble: clampProbability(pDouble),
    quadrants,
  };
}

export function estimateMismatchRisk(input: MismatchRiskModelInput): MismatchRiskModelResult {
  if (
    !Number.isFinite(input.asOfMs) ||
    !Number.isFinite(input.maxSourceAgeMs) ||
    input.asOfMs < 0 ||
    input.maxSourceAgeMs < 0 ||
    !Number.isFinite(input.chainlinkSourceTimestampMs) ||
    !Number.isFinite(input.cfSourceTimestampMs) ||
    input.chainlinkSourceTimestampMs < 0 ||
    input.cfSourceTimestampMs < 0
  ) {
    return { available: false, reason: "invalid_input" };
  }

  const maxFutureSkewMs = input.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS;
  if (!Number.isFinite(maxFutureSkewMs) || maxFutureSkewMs < 0) {
    return { available: false, reason: "invalid_input" };
  }

  const chainlinkAgeMs = input.asOfMs - input.chainlinkSourceTimestampMs;
  const cfAgeMs = input.asOfMs - input.cfSourceTimestampMs;
  if (chainlinkAgeMs < -maxFutureSkewMs) {
    return { available: false, reason: "chainlink_timestamp_in_future" };
  }
  if (cfAgeMs < -maxFutureSkewMs) {
    return { available: false, reason: "cf_timestamp_in_future" };
  }
  if (chainlinkAgeMs > input.maxSourceAgeMs) {
    return { available: false, reason: "chainlink_stale" };
  }
  if (cfAgeMs > input.maxSourceAgeMs) {
    return { available: false, reason: "cf_stale" };
  }

  try {
    const quadrants = calculateJointGaussianOutcomeProbabilities(input);
    return {
      available: true,
      probabilities: calculateMismatchOutcomeProbabilities(input.combination, quadrants),
      chainlinkAgeMs: Math.max(0, chainlinkAgeMs),
      cfAgeMs: Math.max(0, cfAgeMs),
    };
  } catch {
    return { available: false, reason: "invalid_input" };
  }
}

export function calculateMismatchAdjustedPnl(input: MismatchAdjustedPnlInput) {
  assertPositiveFinite(input.pairSize, "pairSize");
  assertNonNegativeFinite(input.totalCostUsd, "totalCostUsd");
  assertProbability(input.probabilities.pFatal, "pFatal");
  assertProbability(input.probabilities.pAligned, "pAligned");
  assertProbability(input.probabilities.pDouble, "pDouble");
  assertProbability(input.pFatalUpper95, "pFatalUpper95");

  const probabilitySum = input.probabilities.pFatal + input.probabilities.pAligned + input.probabilities.pDouble;
  if (Math.abs(probabilitySum - 1) > 1e-7) {
    throw new RangeError("mismatch outcome probabilities must sum to one");
  }

  const effectiveFatalProbabilityUpper95 = Math.max(input.probabilities.pFatal, input.pFatalUpper95);
  const fatalPnlUsd = -input.totalCostUsd;
  const alignedPnlUsd = input.pairSize - input.totalCostUsd;
  const doublePnlUsd = 2 * input.pairSize - input.totalCostUsd;

  return {
    fatalPnlUsd,
    alignedPnlUsd,
    doublePnlUsd,
    expectedPnlUsd:
      input.pairSize * (1 - input.probabilities.pFatal + input.probabilities.pDouble) - input.totalCostUsd,
    conservativePnlUsd: input.pairSize * (1 - effectiveFatalProbabilityUpper95) - input.totalCostUsd,
    effectiveFatalProbabilityUpper95,
  };
}

export function calculateFatalProbabilityCalibration(input: FatalProbabilityCalibrationInput) {
  const priorAlpha = input.priorAlpha ?? 0.5;
  const priorBeta = input.priorBeta ?? 0.5;
  const confidence = input.confidence ?? 0.95;

  assertNonNegativeInteger(input.fatalCount, "fatalCount");
  assertNonNegativeInteger(input.totalCount, "totalCount");
  if (input.fatalCount > input.totalCount) {
    throw new RangeError("fatalCount cannot exceed totalCount");
  }
  assertPositiveFinite(priorAlpha, "priorAlpha");
  assertPositiveFinite(priorBeta, "priorBeta");
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new RangeError("confidence must be between zero and one");
  }

  const posteriorAlpha = priorAlpha + input.fatalCount;
  const posteriorBeta = priorBeta + input.totalCount - input.fatalCount;
  const posteriorMean = posteriorAlpha / (posteriorAlpha + posteriorBeta);

  return {
    posteriorAlpha,
    posteriorBeta,
    posteriorMean,
    pFatalUpper95: inverseRegularizedBeta(confidence, posteriorAlpha, posteriorBeta),
    confidence,
  };
}

export function evaluateEconomicMismatchGate(input: EconomicMismatchGateInput): EconomicMismatchGateResult {
  const safetyFractionOfBreakEven = input.safetyFractionOfBreakEven ?? 0.5;

  assertPositiveFinite(input.pairSize, "pairSize");
  assertNonNegativeFinite(input.totalCostUsd, "totalCostUsd");
  assertProbability(input.pFatalUpper95, "pFatalUpper95");
  if (!Number.isFinite(safetyFractionOfBreakEven) || safetyFractionOfBreakEven <= 0 || safetyFractionOfBreakEven > 1) {
    throw new RangeError("safetyFractionOfBreakEven must be in (0, 1]");
  }

  const pBreakEven = 1 - input.totalCostUsd / input.pairSize;
  const maximumAllowedFatalProbability = Math.max(0, safetyFractionOfBreakEven * pBreakEven);
  const probabilityHeadroom = maximumAllowedFatalProbability - input.pFatalUpper95;

  if (pBreakEven <= 0) {
    return {
      eligible: false,
      reason: "non_positive_aligned_margin",
      pBreakEven,
      maximumAllowedFatalProbability,
      probabilityHeadroom,
    };
  }

  return {
    eligible: probabilityHeadroom >= -PROBABILITY_TOLERANCE,
    reason: probabilityHeadroom >= -PROBABILITY_TOLERANCE ? "eligible" : "fatal_probability_above_limit",
    pBreakEven,
    maximumAllowedFatalProbability,
    probabilityHeadroom,
  };
}

export function calculateHybridClusterBudget(input: HybridClusterBudgetInput): HybridClusterBudgetResult {
  const expectedRiskFraction = input.expectedRiskFraction ?? DEFAULT_EXPECTED_CLUSTER_RISK_FRACTION;
  const expectedRiskCapUsd = input.expectedRiskCapUsd ?? DEFAULT_EXPECTED_CLUSTER_RISK_CAP_USD;
  const absoluteRiskFraction = input.absoluteRiskFraction ?? DEFAULT_ABSOLUTE_CLUSTER_RISK_FRACTION;
  const absoluteRiskCapUsd = input.absoluteRiskCapUsd ?? DEFAULT_ABSOLUTE_CLUSTER_RISK_CAP_USD;

  assertNonNegativeFinite(input.capitalUsd, "capitalUsd");
  assertRiskLimit(expectedRiskFraction, "expectedRiskFraction", true);
  assertRiskLimit(absoluteRiskFraction, "absoluteRiskFraction", true);
  assertRiskLimit(expectedRiskCapUsd, "expectedRiskCapUsd", false);
  assertRiskLimit(absoluteRiskCapUsd, "absoluteRiskCapUsd", false);

  let usedExpectedLossUsd = 0;
  let usedAbsoluteLossUsd = 0;
  for (const exposure of input.exposures) {
    assertNonNegativeFinite(exposure.fatalLossUsd, "fatalLossUsd");
    assertProbability(exposure.pFatalUpper95, "pFatalUpper95");
    usedExpectedLossUsd += exposure.fatalLossUsd * exposure.pFatalUpper95;
    usedAbsoluteLossUsd += exposure.fatalLossUsd;
  }

  const expectedLossBudgetUsd = Math.min(input.capitalUsd * expectedRiskFraction, expectedRiskCapUsd);
  const absoluteLossBudgetUsd = Math.min(input.capitalUsd * absoluteRiskFraction, absoluteRiskCapUsd);
  const exceedsExpected = usedExpectedLossUsd > expectedLossBudgetUsd + 1e-9;
  const exceedsAbsolute = usedAbsoluteLossUsd > absoluteLossBudgetUsd + 1e-9;

  return {
    expectedLossBudgetUsd,
    absoluteLossBudgetUsd,
    usedExpectedLossUsd,
    usedAbsoluteLossUsd,
    remainingExpectedLossUsd: Math.max(0, expectedLossBudgetUsd - usedExpectedLossUsd),
    remainingAbsoluteLossUsd: Math.max(0, absoluteLossBudgetUsd - usedAbsoluteLossUsd),
    withinBudget: !exceedsExpected && !exceedsAbsolute,
    limitingBudget:
      exceedsExpected && exceedsAbsolute
        ? "both"
        : exceedsExpected
          ? "expected"
          : exceedsAbsolute
            ? "absolute"
            : "none",
  };
}

export function calculateMaximumAdditionalFatalLossUsd(
  budget: Pick<HybridClusterBudgetResult, "remainingExpectedLossUsd" | "remainingAbsoluteLossUsd">,
  pFatalUpper95: number,
) {
  assertNonNegativeFinite(budget.remainingExpectedLossUsd, "remainingExpectedLossUsd");
  assertNonNegativeFinite(budget.remainingAbsoluteLossUsd, "remainingAbsoluteLossUsd");
  assertProbability(pFatalUpper95, "pFatalUpper95");

  const expectedLimitedLoss =
    pFatalUpper95 === 0 ? Number.POSITIVE_INFINITY : budget.remainingExpectedLossUsd / pFatalUpper95;
  return Math.max(0, Math.min(budget.remainingAbsoluteLossUsd, expectedLimitedLoss));
}

function deterministicQuadrants(polyUp: boolean, kalshiYes: boolean): JointOutcomeProbabilities {
  return {
    polyUpKalshiYes: polyUp && kalshiYes ? 1 : 0,
    polyUpKalshiNo: polyUp && !kalshiYes ? 1 : 0,
    polyDownKalshiYes: !polyUp && kalshiYes ? 1 : 0,
    polyDownKalshiNo: !polyUp && !kalshiYes ? 1 : 0,
  };
}

function normalizeQuadrants(input: JointOutcomeProbabilities): JointOutcomeProbabilities {
  const values = [
    clampProbability(input.polyUpKalshiYes),
    clampProbability(input.polyUpKalshiNo),
    clampProbability(input.polyDownKalshiYes),
    clampProbability(input.polyDownKalshiNo),
  ];
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new RangeError("joint outcome probabilities are invalid");
  }

  return {
    polyUpKalshiYes: values[0] / total,
    polyUpKalshiNo: values[1] / total,
    polyDownKalshiYes: values[2] / total,
    polyDownKalshiNo: values[3] / total,
  };
}

function assertJointGaussianInput(input: JointGaussianOutcomeInput) {
  assertPositiveFinite(input.chainlinkStartPrice, "chainlinkStartPrice");
  assertPositiveFinite(input.chainlinkTerminalMean, "chainlinkTerminalMean");
  assertNonNegativeFinite(input.chainlinkTerminalStdDev, "chainlinkTerminalStdDev");
  assertPositiveFinite(input.kalshiStrikePrice, "kalshiStrikePrice");
  assertPositiveFinite(input.cfFinalAverageMean, "cfFinalAverageMean");
  assertNonNegativeFinite(input.cfFinalAverageStdDev, "cfFinalAverageStdDev");
  if (!Number.isFinite(input.correlation) || input.correlation < -1 || input.correlation > 1) {
    throw new RangeError("correlation must be between -1 and one");
  }
}

function assertQuadrants(quadrants: JointOutcomeProbabilities) {
  const values = [
    quadrants.polyUpKalshiYes,
    quadrants.polyUpKalshiNo,
    quadrants.polyDownKalshiYes,
    quadrants.polyDownKalshiNo,
  ];
  for (const [index, value] of values.entries()) {
    assertProbability(value, `quadrant[${index}]`);
  }
  if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 1e-7) {
    throw new RangeError("joint outcome probabilities must sum to one");
  }
}

function assertCombination(combination: string): asserts combination is MismatchCombination {
  if (combination !== "POLY_UP_KALSHI_NO" && combination !== "POLY_DOWN_KALSHI_YES") {
    throw new RangeError("unsupported mismatch combination");
  }
}

function assertProbability(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${field} must be between zero and one`);
  }
}

function assertPositiveFinite(value: number, field: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive finite number`);
  }
}

function assertNonNegativeFinite(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative finite number`);
  }
}

function assertPositiveInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer`);
  }
}

function assertRiskLimit(value: number, field: string, fraction: boolean) {
  assertNonNegativeFinite(value, field);
  if (fraction && value > 1) {
    throw new RangeError(`${field} cannot exceed one`);
  }
}

function clampProbability(value: number) {
  return Math.min(1, Math.max(0, value));
}

function normalCdf(value: number) {
  if (value <= -8) {
    return 0;
  }
  if (value >= 8) {
    return 1;
  }

  const absolute = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * absolute);
  const density = Math.exp((-absolute * absolute) / 2) / Math.sqrt(2 * Math.PI);
  const tail =
    density * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return value >= 0 ? 1 - tail : tail;
}

function normalPdf(value: number) {
  return Math.exp((-value * value) / 2) / Math.sqrt(2 * Math.PI);
}

function bivariateNormalCdf(a: number, b: number, correlation: number) {
  if (a <= -8 || b <= -8) {
    return 0;
  }
  if (a >= 8) {
    return normalCdf(b);
  }
  if (b >= 8) {
    return normalCdf(a);
  }
  if (correlation >= 1 - 1e-10) {
    return normalCdf(Math.min(a, b));
  }
  if (correlation <= -1 + 1e-10) {
    return Math.max(0, normalCdf(a) - normalCdf(-b));
  }

  const conditionalStdDev = Math.sqrt(1 - correlation * correlation);
  const integrand = (x: number) => normalPdf(x) * normalCdf((b - correlation * x) / conditionalStdDev);
  const lower = -8;
  const upper = Math.min(a, 8);
  const midpoint = (lower + upper) / 2;
  const whole = simpson(integrand, lower, upper, midpoint);
  return clampProbability(adaptiveSimpson(integrand, lower, upper, 1e-9, whole, 18));
}

function simpson(fn: (value: number) => number, lower: number, upper: number, midpoint: number) {
  return ((upper - lower) / 6) * (fn(lower) + 4 * fn(midpoint) + fn(upper));
}

function adaptiveSimpson(
  fn: (value: number) => number,
  lower: number,
  upper: number,
  tolerance: number,
  whole: number,
  depth: number,
): number {
  const midpoint = (lower + upper) / 2;
  const leftMidpoint = (lower + midpoint) / 2;
  const rightMidpoint = (midpoint + upper) / 2;
  const left = simpson(fn, lower, midpoint, leftMidpoint);
  const right = simpson(fn, midpoint, upper, rightMidpoint);
  const delta = left + right - whole;

  if (depth <= 0 || Math.abs(delta) <= 15 * tolerance) {
    return left + right + delta / 15;
  }

  return (
    adaptiveSimpson(fn, lower, midpoint, tolerance / 2, left, depth - 1) +
    adaptiveSimpson(fn, midpoint, upper, tolerance / 2, right, depth - 1)
  );
}

function inverseRegularizedBeta(probability: number, alpha: number, beta: number) {
  let lower = 0;
  let upper = 1;

  for (let iteration = 0; iteration < 80; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    if (regularizedIncompleteBeta(midpoint, alpha, beta) < probability) {
      lower = midpoint;
    } else {
      upper = midpoint;
    }
  }

  return (lower + upper) / 2;
}

function regularizedIncompleteBeta(value: number, alpha: number, beta: number) {
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }

  const factor = Math.exp(
    logGamma(alpha + beta) - logGamma(alpha) - logGamma(beta) + alpha * Math.log(value) + beta * Math.log1p(-value),
  );

  if (value < (alpha + 1) / (alpha + beta + 2)) {
    return (factor * betaContinuedFraction(value, alpha, beta)) / alpha;
  }

  return 1 - (factor * betaContinuedFraction(1 - value, beta, alpha)) / beta;
}

function betaContinuedFraction(value: number, alpha: number, beta: number) {
  const maxIterations = 200;
  const epsilon = 3e-14;
  const floor = 1e-300;
  const qab = alpha + beta;
  const qap = alpha + 1;
  const qam = alpha - 1;
  let c = 1;
  let d = 1 - (qab * value) / qap;
  d = (1 / Math.max(Math.abs(d), floor)) * Math.sign(d || 1);
  let result = d;

  for (let index = 1; index <= maxIterations; index += 1) {
    const evenCoefficient = (index * (beta - index) * value) / ((qam + 2 * index) * (alpha + 2 * index));
    d = 1 + evenCoefficient * d;
    d = Math.abs(d) < floor ? floor : d;
    c = 1 + evenCoefficient / c;
    c = Math.abs(c) < floor ? floor : c;
    d = 1 / d;
    result *= d * c;

    const oddCoefficient = (-(alpha + index) * (qab + index) * value) / ((alpha + 2 * index) * (qap + 2 * index));
    d = 1 + oddCoefficient * d;
    d = Math.abs(d) < floor ? floor : d;
    c = 1 + oddCoefficient / c;
    c = Math.abs(c) < floor ? floor : c;
    d = 1 / d;
    const delta = d * c;
    result *= delta;

    if (Math.abs(delta - 1) < epsilon) {
      return result;
    }
  }

  throw new RangeError("beta continued fraction did not converge");
}

function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905,
    -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
  ];

  if (value < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  }

  const shifted = value - 1;
  let series = 0.9999999999998099;
  for (let index = 0; index < coefficients.length; index += 1) {
    series += coefficients[index] / (shifted + index + 1);
  }
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(series);
}
