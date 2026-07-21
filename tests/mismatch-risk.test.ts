import {
  calculateFatalProbabilityCalibration,
  calculateHybridClusterBudget,
  calculateJointGaussianOutcomeProbabilities,
  calculateMaximumAdditionalFatalLossUsd,
  calculateMismatchAdjustedPnl,
  calculateMismatchOutcomeProbabilities,
  conditionCfFinalAverage,
  estimateMismatchRisk,
  evaluateEconomicMismatchGate,
} from "@/lib/mismatch-risk";

describe("CF final-average conditioning", () => {
  it("conditions the final 60-sample average on the observed partial window", () => {
    const result = conditionCfFinalAverage({
      observedAverage: 100,
      observedSampleCount: 20,
      remainingMean: 110,
      remainingMeanStdDev: 4,
      strike: 105,
    });

    expect(result.finalAverageMean).toBeCloseTo(106.6666667, 7);
    expect(result.finalAverageStdDev).toBeCloseTo(2.6666667, 7);
    expect(result.requiredRemainingMeanToReachStrike).toBeCloseTo(107.5, 8);
    expect(result.remainingSampleCount).toBe(40);
  });

  it("becomes deterministic once all samples are observed", () => {
    const result = conditionCfFinalAverage({
      observedAverage: 101,
      observedSampleCount: 60,
      remainingMean: 120,
      remainingMeanStdDev: 5,
      strike: 100,
    });

    expect(result.finalAverageMean).toBe(101);
    expect(result.finalAverageStdDev).toBe(0);
    expect(result.requiredRemainingMeanToReachStrike).toBeNull();
  });

  it("rejects impossible sample counts and non-finite prices", () => {
    expect(() =>
      conditionCfFinalAverage({
        observedAverage: 100,
        observedSampleCount: 61,
        remainingMean: 100,
        remainingMeanStdDev: 1,
      }),
    ).toThrow(RangeError);
    expect(() =>
      conditionCfFinalAverage({
        observedAverage: Number.NaN,
        observedSampleCount: 10,
        remainingMean: 100,
        remainingMeanStdDev: 1,
      }),
    ).toThrow(RangeError);
  });
});

describe("joint mismatch probabilities", () => {
  const symmetricModel = {
    chainlinkStartPrice: 100,
    chainlinkTerminalMean: 100,
    chainlinkTerminalStdDev: 10,
    kalshiStrikePrice: 200,
    cfFinalAverageMean: 200,
    cfFinalAverageStdDev: 20,
    correlation: 0,
  };

  it("produces symmetric quadrants at both means with independent references", () => {
    const quadrants = calculateJointGaussianOutcomeProbabilities(symmetricModel);

    expect(quadrants.polyUpKalshiYes).toBeCloseTo(0.25, 6);
    expect(quadrants.polyUpKalshiNo).toBeCloseTo(0.25, 6);
    expect(quadrants.polyDownKalshiYes).toBeCloseTo(0.25, 6);
    expect(quadrants.polyDownKalshiNo).toBeCloseTo(0.25, 6);
    expect(Object.values(quadrants).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
  });

  it("swaps fatal and double probabilities between complementary combinations", () => {
    const quadrants = calculateJointGaussianOutcomeProbabilities({
      ...symmetricModel,
      chainlinkTerminalMean: 94,
      cfFinalAverageMean: 208,
      correlation: 0.35,
    });
    const upNo = calculateMismatchOutcomeProbabilities("POLY_UP_KALSHI_NO", quadrants);
    const downYes = calculateMismatchOutcomeProbabilities("POLY_DOWN_KALSHI_YES", quadrants);

    expect(upNo.pFatal).toBeCloseTo(downYes.pDouble, 12);
    expect(upNo.pDouble).toBeCloseTo(downYes.pFatal, 12);
    expect(upNo.pAligned).toBeCloseTo(downYes.pAligned, 12);
    expect(upNo.pFatal + upNo.pAligned + upNo.pDouble).toBeCloseTo(1, 12);
  });

  it("increases Up+No fatal risk as Chainlink trends down and CF trends above strike", () => {
    const base = calculateMismatchOutcomeProbabilities(
      "POLY_UP_KALSHI_NO",
      calculateJointGaussianOutcomeProbabilities(symmetricModel),
    );
    const adverse = calculateMismatchOutcomeProbabilities(
      "POLY_UP_KALSHI_NO",
      calculateJointGaussianOutcomeProbabilities({
        ...symmetricModel,
        chainlinkTerminalMean: 90,
        cfFinalAverageMean: 220,
      }),
    );

    expect(adverse.pFatal).toBeGreaterThan(base.pFatal);
    expect(adverse.pDouble).toBeLessThan(base.pDouble);
  });

  it("handles deterministic terminal values without inventing uncertainty", () => {
    const quadrants = calculateJointGaussianOutcomeProbabilities({
      ...symmetricModel,
      chainlinkTerminalMean: 101,
      chainlinkTerminalStdDev: 0,
      cfFinalAverageMean: 199,
      cfFinalAverageStdDev: 0,
    });

    expect(quadrants).toEqual({
      polyUpKalshiYes: 0,
      polyUpKalshiNo: 1,
      polyDownKalshiYes: 0,
      polyDownKalshiNo: 0,
    });
  });

  it("fails closed for stale, future, or invalid reference data", () => {
    const common = {
      ...symmetricModel,
      combination: "POLY_UP_KALSHI_NO" as const,
      asOfMs: 10_000,
      maxSourceAgeMs: 1_000,
      chainlinkSourceTimestampMs: 9_500,
      cfSourceTimestampMs: 9_500,
    };

    expect(estimateMismatchRisk(common).available).toBe(true);
    expect(estimateMismatchRisk({ ...common, chainlinkSourceTimestampMs: 8_999 })).toEqual({
      available: false,
      reason: "chainlink_stale",
    });
    expect(estimateMismatchRisk({ ...common, cfSourceTimestampMs: 12_000 })).toEqual({
      available: false,
      reason: "cf_timestamp_in_future",
    });
    expect(estimateMismatchRisk({ ...common, correlation: 2 })).toEqual({ available: false, reason: "invalid_input" });
  });
});

describe("mismatch economics", () => {
  it("computes fatal, aligned, double, expected, and conservative PnL", () => {
    const pnl = calculateMismatchAdjustedPnl({
      pairSize: 20,
      totalCostUsd: 18,
      probabilities: {
        pFatal: 0.05,
        pAligned: 0.9,
        pDouble: 0.05,
      },
      pFatalUpper95: 0.1,
    });

    expect(pnl.fatalPnlUsd).toBe(-18);
    expect(pnl.alignedPnlUsd).toBe(2);
    expect(pnl.doublePnlUsd).toBe(22);
    expect(pnl.expectedPnlUsd).toBe(2);
    expect(pnl.conservativePnlUsd).toBe(0);
  });

  it("uses at most half of break-even fatal probability", () => {
    const accepted = evaluateEconomicMismatchGate({
      pairSize: 20,
      totalCostUsd: 18,
      pFatalUpper95: 0.05,
    });
    const rejected = evaluateEconomicMismatchGate({
      pairSize: 20,
      totalCostUsd: 18,
      pFatalUpper95: 0.051,
    });

    expect(accepted.eligible).toBe(true);
    expect(accepted.maximumAllowedFatalProbability).toBeCloseTo(0.05, 12);
    expect(rejected).toMatchObject({
      eligible: false,
      reason: "fatal_probability_above_limit",
    });
    expect(
      evaluateEconomicMismatchGate({
        pairSize: 20,
        totalCostUsd: 20,
        pFatalUpper95: 0,
      }),
    ).toMatchObject({
      eligible: false,
      reason: "non_positive_aligned_margin",
    });
  });

  it("raises the beta-binomial upper bound with failures and lowers it with evidence", () => {
    const zeroOfTen = calculateFatalProbabilityCalibration({ fatalCount: 0, totalCount: 10 });
    const oneOfTen = calculateFatalProbabilityCalibration({ fatalCount: 1, totalCount: 10 });
    const zeroOfHundred = calculateFatalProbabilityCalibration({
      fatalCount: 0,
      totalCount: 100,
    });

    expect(zeroOfTen.pFatalUpper95).toBeGreaterThan(zeroOfTen.posteriorMean);
    expect(oneOfTen.pFatalUpper95).toBeGreaterThan(zeroOfTen.pFatalUpper95);
    expect(zeroOfHundred.pFatalUpper95).toBeLessThan(zeroOfTen.pFatalUpper95);
  });
});

describe("hybrid mismatch cluster budget", () => {
  it("caps probability-weighted and absolute losses independently", () => {
    const smallCapital = calculateHybridClusterBudget({ capitalUsd: 100, exposures: [] });
    const largeCapital = calculateHybridClusterBudget({ capitalUsd: 1_000, exposures: [] });

    expect(smallCapital.expectedLossBudgetUsd).toBe(5);
    expect(smallCapital.absoluteLossBudgetUsd).toBe(15);
    expect(largeCapital.expectedLossBudgetUsd).toBe(25);
    expect(largeCapital.absoluteLossBudgetUsd).toBe(75);
  });

  it("aggregates all exposures and calculates remaining candidate capacity", () => {
    const budget = calculateHybridClusterBudget({
      capitalUsd: 1_000,
      exposures: [
        { fatalLossUsd: 10, pFatalUpper95: 0.1 },
        { fatalLossUsd: 10, pFatalUpper95: 0.1 },
      ],
    });

    expect(budget.usedExpectedLossUsd).toBeCloseTo(2, 12);
    expect(budget.usedAbsoluteLossUsd).toBe(20);
    expect(budget.remainingExpectedLossUsd).toBeCloseTo(23, 12);
    expect(budget.remainingAbsoluteLossUsd).toBe(55);
    expect(calculateMaximumAdditionalFatalLossUsd(budget, 0.2)).toBe(55);
    expect(calculateMaximumAdditionalFatalLossUsd(budget, 0.8)).toBeCloseTo(28.75, 12);
  });

  it("tightens monotonically and identifies the exceeded budget", () => {
    const base = calculateHybridClusterBudget({
      capitalUsd: 1_000,
      exposures: [{ fatalLossUsd: 60, pFatalUpper95: 0.1 }],
    });
    const moreRisk = calculateHybridClusterBudget({
      capitalUsd: 1_000,
      exposures: [{ fatalLossUsd: 80, pFatalUpper95: 0.4 }],
    });

    expect(base.withinBudget).toBe(true);
    expect(moreRisk.withinBudget).toBe(false);
    expect(moreRisk.limitingBudget).toBe("both");
    expect(moreRisk.remainingExpectedLossUsd).toBeLessThan(base.remainingExpectedLossUsd);
    expect(moreRisk.remainingAbsoluteLossUsd).toBeLessThan(base.remainingAbsoluteLossUsd);
  });

  it("rejects malformed exposure instead of silently undercounting it", () => {
    expect(() =>
      calculateHybridClusterBudget({
        capitalUsd: 1_000,
        exposures: [{ fatalLossUsd: Number.NaN, pFatalUpper95: 0.1 }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      calculateMaximumAdditionalFatalLossUsd({ remainingExpectedLossUsd: 10, remainingAbsoluteLossUsd: 20 }, 1.1),
    ).toThrow(RangeError);
  });
});
