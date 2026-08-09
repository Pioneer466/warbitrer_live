import {
  applyActiveMismatchCalibrationToEstimate,
  applyMismatchCalibration,
  buildMismatchCalibrationArtifact,
  evaluateMismatchCalibrationActivationEligibility,
  prepareMismatchCalibrationEvaluator,
  resolveMismatchCalibrationHorizonBand,
  verifyMismatchCalibrationArtifact,
  type MismatchCalibrationHorizonBand,
  type MismatchCalibrationLabel,
} from "@/lib/mismatch-calibration";
import type { MismatchCombination } from "@/lib/mismatch-risk";
import { MISMATCH_RISK_RUNTIME_MODEL_VERSION } from "@/lib/mismatch-risk-runtime";
import type { MismatchRiskEstimate } from "@/lib/types";
import { buildEligibleMismatchCalibrationFixture } from "./mismatch-calibration-fixtures";

const BASE_MODEL_VERSION = "structural-test-v1";
const BAND: MismatchCalibrationHorizonBand = "seconds_over_30_to_60";
const COMBINATION: MismatchCombination = "POLY_UP_KALSHI_NO";

function labelsForBins(
  bins: ReadonlyArray<{ rawProbability: number; outcomes: readonly boolean[] }>,
  overrides: Partial<Pick<MismatchCalibrationLabel, "horizonBand" | "combination">> = {},
): MismatchCalibrationLabel[] {
  return bins.flatMap((bin) =>
    bin.outcomes.map((fatal) => ({
      rawProbability: bin.rawProbability,
      fatal,
      horizonBand: overrides.horizonBand ?? BAND,
      combination: overrides.combination ?? COMBINATION,
    })),
  );
}

function build(labels: readonly MismatchCalibrationLabel[], minimumPreBinCount = 2) {
  return buildMismatchCalibrationArtifact({
    baseModelVersion: BASE_MODEL_VERSION,
    labels,
    minimumPreBinCount,
  });
}

describe("mismatch calibration artifact construction", () => {
  it("pools decreasing adjacent rates and keeps posterior means and upper bounds monotone", () => {
    const artifact = build(
      labelsForBins([
        { rawProbability: 0.1, outcomes: [true, true] },
        { rawProbability: 0.2, outcomes: [false, false] },
        { rawProbability: 0.3, outcomes: [false, true] },
        { rawProbability: 0.4, outcomes: [true, true] },
      ]),
    );
    const blocks = artifact.curves[0].blocks;

    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks[0]).toMatchObject({
      rawProbabilityMin: 0.1,
      rawProbabilityMax: 0.2,
      labelCount: 4,
      fatalCount: 2,
      sourcePreBinCount: 2,
    });
    for (let index = 1; index < blocks.length; index += 1) {
      expect(blocks[index].calibratedProbability).toBeGreaterThanOrEqual(blocks[index - 1].calibratedProbability);
      expect(blocks[index].pFatalUpper95).toBeGreaterThanOrEqual(blocks[index - 1].pFatalUpper95);
    }
    for (const block of blocks) {
      expect(block.calibratedProbability).toBeGreaterThan(0);
      expect(block.calibratedProbability).toBeLessThan(1);
      expect(block.pFatalUpper95).toBeGreaterThanOrEqual(block.calibratedProbability);
      expect(block.pFatalUpper95).toBeLessThanOrEqual(1);
    }
  });

  it("is byte-deterministic across input ordering and protects a canonical payload", () => {
    const labels = labelsForBins([
      { rawProbability: 0.1, outcomes: [false, false] },
      { rawProbability: 0.3, outcomes: [true, false] },
      { rawProbability: 0.7, outcomes: [true, true] },
    ]);
    const first = build(labels);
    const second = build([...labels].reverse());

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyMismatchCalibrationArtifact(JSON.parse(JSON.stringify(first)))).toEqual({
      valid: true,
      artifact: first,
    });
  });

  it("uses Jeffreys posteriors so zero and all-fatal bins remain strictly bounded", () => {
    const artifact = build(
      labelsForBins([
        { rawProbability: 0.1, outcomes: [false, false, false, false] },
        { rawProbability: 0.9, outcomes: [true, true, true, true] },
      ]),
      4,
    );
    const [zeroFatal, allFatal] = artifact.curves[0].blocks;

    expect(zeroFatal).toMatchObject({ posteriorAlpha: 0.5, posteriorBeta: 4.5 });
    expect(zeroFatal.calibratedProbability).toBeCloseTo(0.1, 12);
    expect(zeroFatal.pFatalUpper95).toBeGreaterThan(zeroFatal.calibratedProbability);
    expect(allFatal).toMatchObject({ posteriorAlpha: 4.5, posteriorBeta: 0.5 });
    expect(allFatal.calibratedProbability).toBeCloseTo(0.9, 12);
    expect(allFatal.pFatalUpper95).toBeGreaterThan(allFatal.calibratedProbability);
    expect(allFatal.pFatalUpper95).toBeLessThan(1);
  });

  it("rejects invalid labels and groups that cannot meet the configured pre-bin minimum", () => {
    const valid = labelsForBins([{ rawProbability: 0.2, outcomes: [false, true] }]);

    expect(() => buildMismatchCalibrationArtifact({ baseModelVersion: "", labels: valid })).toThrow(RangeError);
    expect(() => build([], 2)).toThrow(RangeError);
    expect(() => build(valid, 3)).toThrow(/minimum is 3/);
    expect(() => build([{ ...valid[0], rawProbability: Number.NaN }, valid[1]])).toThrow(/rawProbability/);
    expect(() => build([{ ...valid[0], rawProbability: 1.01 }, valid[1]])).toThrow(/rawProbability/);
    expect(() => build([{ ...valid[0], fatal: 1 as never }, valid[1]])).toThrow(/fatal/);
    expect(() => build([{ ...valid[0], horizonBand: "unknown" as never }, valid[1]])).toThrow(/horizonBand/);
    expect(() => build([{ ...valid[0], combination: "unknown" as never }, valid[1]])).toThrow(/combination/);
  });

  it("requires complete, fresh, statistically acceptable holdout evidence before activation", () => {
    const fixture = buildActivationFixture();

    expect(evaluateMismatchCalibrationActivationEligibility(fixture)).toEqual({ eligible: true, reasons: [] });
    expect(
      evaluateMismatchCalibrationActivationEligibility({
        ...fixture,
        metrics: {
          ...(fixture.metrics as Record<string, unknown>),
          test: { count: 1 },
        },
      }),
    ).toMatchObject({ eligible: false, reasons: expect.arrayContaining(["holdout_overall_policy_failed"]) });
    expect(
      evaluateMismatchCalibrationActivationEligibility({
        ...fixture,
        activationAt: fixture.trainingEndedAt + 8 * 24 * 60 * 60_000,
      }),
    ).toMatchObject({ eligible: false, reasons: expect.arrayContaining(["artifact_not_fresh_for_activation"]) });
  });

  it("rejects artifacts for another runtime model and self-declared training dates", () => {
    const wrongRuntime = buildActivationFixture(BASE_MODEL_VERSION);
    expect(evaluateMismatchCalibrationActivationEligibility(wrongRuntime)).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["runtime_base_model_version_mismatch"]),
    });

    const fixture = buildActivationFixture();
    expect(
      evaluateMismatchCalibrationActivationEligibility({
        ...fixture,
        trainingStartedAt: fixture.trainingStartedAt - 1,
      }),
    ).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["observation_provenance_incompatible"]),
    });
    const metrics = structuredClone(fixture.metrics) as Record<string, unknown>;
    const observations = metrics.observations as Record<string, unknown>;
    delete observations.firstCapturedAt;
    expect(evaluateMismatchCalibrationActivationEligibility({ ...fixture, metrics })).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["observation_provenance_incompatible"]),
    });
  });

  it("rejects incomplete split evidence and contradictory holdout partitions", () => {
    const fixture = buildActivationFixture();
    const missingValidationArtifact = structuredClone(fixture.metrics) as Record<string, unknown>;
    delete missingValidationArtifact.validationArtifact;
    expect(
      evaluateMismatchCalibrationActivationEligibility({ ...fixture, metrics: missingValidationArtifact }),
    ).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["metrics_invalid"]),
    });

    const tamperedValidationArtifact = structuredClone(fixture.metrics) as Record<string, unknown>;
    (tamperedValidationArtifact.validationArtifact as Record<string, unknown>).baseModelVersion = "tampered-model";
    expect(
      evaluateMismatchCalibrationActivationEligibility({ ...fixture, metrics: tamperedValidationArtifact }),
    ).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["validation_artifact_invalid"]),
    });

    const mismatchedValidationHash = structuredClone(fixture.metrics) as Record<string, unknown>;
    mismatchedValidationHash.validationArtifactSha256 = "0".repeat(64);
    expect(
      evaluateMismatchCalibrationActivationEligibility({ ...fixture, metrics: mismatchedValidationHash }),
    ).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["validation_artifact_incompatible"]),
    });

    const invalidSplit = structuredClone(fixture.metrics) as Record<string, unknown>;
    invalidSplit.validationArtifactSha256 = "not-a-checksum";
    expect(evaluateMismatchCalibrationActivationEligibility({ ...fixture, metrics: invalidSplit })).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["split_provenance_incompatible"]),
    });

    const contradictoryAssetTotals = structuredClone(fixture.metrics) as Record<string, unknown>;
    const testEvaluation = contradictoryAssetTotals.test as Record<string, unknown>;
    const byAsset = testEvaluation.byAsset as Record<string, Record<string, unknown>>;
    byAsset.btc.count = Number(byAsset.btc.count) + 1;
    expect(
      evaluateMismatchCalibrationActivationEligibility({ ...fixture, metrics: contradictoryAssetTotals }),
    ).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["holdout_metrics_inconsistent"]),
    });

    for (const field of ["count", "fatalCount"] as const) {
      const contradictoryTrainingCounts = structuredClone(fixture.metrics) as Record<string, unknown>;
      shiftTrainingCurveMetric(contradictoryTrainingCounts, field);
      expect(
        evaluateMismatchCalibrationActivationEligibility({ ...fixture, metrics: contradictoryTrainingCounts }),
      ).toMatchObject({
        eligible: false,
        reasons: expect.arrayContaining(["validation_artifact_training_metrics_mismatch"]),
      });
    }

    const missingExactScoreKey = structuredClone(fixture.metrics) as Record<string, unknown>;
    const raw = (missingExactScoreKey.test as Record<string, unknown>).raw as Record<string, unknown>;
    delete raw.meanPrediction;
    expect(
      evaluateMismatchCalibrationActivationEligibility({ ...fixture, metrics: missingExactScoreKey }),
    ).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["holdout_metrics_inconsistent"]),
    });

    const inconsistentSplitBoundary = structuredClone(fixture.metrics) as Record<string, unknown>;
    const observations = inconsistentSplitBoundary.observations as Record<string, unknown>;
    observations.trainingLastSlotEndTs = Number(observations.trainingLastSlotEndTs) - 1;
    expect(
      evaluateMismatchCalibrationActivationEligibility({ ...fixture, metrics: inconsistentSplitBoundary }),
    ).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["observation_provenance_incompatible"]),
    });
  });
});

describe("mismatch calibration runtime application", () => {
  const upLabels = labelsForBins([
    { rawProbability: 0.1, outcomes: [false, false] },
    { rawProbability: 0.8, outcomes: [true, true] },
  ]);
  const downLabels = labelsForBins(
    [
      { rawProbability: 0.1, outcomes: [true, true] },
      { rawProbability: 0.8, outcomes: [true, true] },
    ],
    { combination: "POLY_DOWN_KALSHI_YES" },
  );
  const lateLabels = labelsForBins(
    [
      { rawProbability: 0.1, outcomes: [false, false, false, false] },
      { rawProbability: 0.8, outcomes: [false, false] },
    ],
    { horizonBand: "seconds_5_to_30" },
  );
  const artifact = build([...upLabels, ...downLabels, ...lateLabels]);
  const rawEstimate: MismatchRiskEstimate = {
    available: true,
    executionUsable: true,
    executionReason: null,
    modelVersion: BASE_MODEL_VERSION,
    reason: null,
    pFatal: 0.1,
    pFatalUpper95: 0.2,
    pAligned: 0.7,
    pDouble: 0.2,
    expectedPnlUsd: null,
    conservativePnlUsd: null,
    fatalPnlUsd: null,
    breakEvenFatalProbability: null,
    maximumAllowedFatalProbability: null,
    chainlinkAgeMs: 10,
    cfAgeMs: 10,
    observationCount: 100,
  };

  it("selects only the requested horizon and combination curve", () => {
    const up = applyMismatchCalibration({
      artifact,
      baseModelVersion: BASE_MODEL_VERSION,
      horizonBand: BAND,
      combination: "POLY_UP_KALSHI_NO",
      rawProbability: 0.1,
    });
    const down = applyMismatchCalibration({
      artifact,
      baseModelVersion: BASE_MODEL_VERSION,
      horizonBand: BAND,
      combination: "POLY_DOWN_KALSHI_YES",
      rawProbability: 0.1,
    });
    const late = applyMismatchCalibration({
      artifact,
      baseModelVersion: BASE_MODEL_VERSION,
      horizonBand: "seconds_5_to_30",
      combination: "POLY_UP_KALSHI_NO",
      rawProbability: 0.1,
    });

    expect(up.available).toBe(true);
    expect(down.available).toBe(true);
    expect(late.available).toBe(true);
    if (!up.available || !down.available || !late.available) {
      throw new Error("expected calibration results");
    }
    expect(up.calibratedProbability).toBeCloseTo(1 / 6, 12);
    expect(down.calibratedProbability).toBeCloseTo(5 / 6, 12);
    expect(late.calibratedProbability).toBeCloseTo(1 / 10, 12);
    expect(up.artifactSha256).toBe(artifact.payloadSha256);
  });

  it("verifies a batch evaluator once and isolates it from later input mutation", () => {
    const mutableArtifact = structuredClone(artifact);
    const prepared = prepareMismatchCalibrationEvaluator({
      artifact: mutableArtifact,
      baseModelVersion: BASE_MODEL_VERSION,
    });
    expect(prepared.available).toBe(true);
    if (!prepared.available) {
      throw new Error("expected a prepared calibration evaluator");
    }
    const input = {
      horizonBand: BAND,
      combination: COMBINATION,
      rawProbability: 0.1,
    } as const;
    const beforeMutation = prepared.evaluate(input);

    for (const curve of mutableArtifact.curves) {
      for (const block of curve.blocks) {
        block.calibratedProbability = 0.999;
      }
    }

    expect(prepared.evaluate(input)).toEqual(beforeMutation);
    expect(
      applyMismatchCalibration({
        artifact: mutableArtifact,
        baseModelVersion: BASE_MODEL_VERSION,
        ...input,
      }),
    ).toEqual({ available: false, reason: "artifact_invalid" });
  });

  it("fails closed for missing, altered, or incompatible artifacts and inputs", () => {
    const common = {
      artifact,
      baseModelVersion: BASE_MODEL_VERSION,
      horizonBand: BAND,
      combination: COMBINATION,
      rawProbability: 0.2,
    };

    expect(applyMismatchCalibration({ ...common, artifact: null })).toEqual({
      available: false,
      reason: "artifact_unavailable",
    });
    expect(applyMismatchCalibration({ ...common, artifact: {} })).toEqual({
      available: false,
      reason: "artifact_invalid",
    });
    expect(applyMismatchCalibration({ ...common, artifact: { ...artifact, baseModelVersion: "tampered" } })).toEqual({
      available: false,
      reason: "artifact_checksum_mismatch",
    });
    expect(applyMismatchCalibration({ ...common, baseModelVersion: "another-model" })).toEqual({
      available: false,
      reason: "base_model_version_mismatch",
    });
    expect(applyMismatchCalibration({ ...common, rawProbability: Number.NaN })).toEqual({
      available: false,
      reason: "invalid_raw_probability",
    });
    expect(applyMismatchCalibration({ ...common, horizonBand: "unknown" as never })).toEqual({
      available: false,
      reason: "unsupported_horizon_band",
    });
    expect(applyMismatchCalibration({ ...common, combination: "unknown" as never })).toEqual({
      available: false,
      reason: "unsupported_combination",
    });
  });

  it("fails closed when an otherwise valid artifact lacks the requested curve", () => {
    const partial = build(upLabels);

    expect(
      applyMismatchCalibration({
        artifact: partial,
        baseModelVersion: BASE_MODEL_VERSION,
        horizonBand: "seconds_over_300",
        combination: COMBINATION,
        rawProbability: 0.2,
      }),
    ).toEqual({ available: false, reason: "horizon_band_not_calibrated" });
    expect(
      applyMismatchCalibration({
        artifact: partial,
        baseModelVersion: BASE_MODEL_VERSION,
        horizonBand: BAND,
        combination: "POLY_DOWN_KALSHI_YES",
        rawProbability: 0.2,
      }),
    ).toEqual({ available: false, reason: "combination_not_calibrated" });
  });

  it("applies an active artifact to the estimate and preserves a normalized non-fatal split", () => {
    const calibrated = applyActiveMismatchCalibrationToEstimate({
      estimate: rawEstimate,
      activation: {
        artifact: { id: "artifact-1", baseModelVersion: BASE_MODEL_VERSION, artifact },
        revision: 3,
      },
      combination: COMBINATION,
      secondsRemaining: 45,
    });

    expect(calibrated.modelVersion).toContain("pava-jeffreys-cluster-conservative-v2-calibrated");
    expect(calibrated.modelVersion).not.toContain("uncalibrated");
    expect(calibrated.rawPFatal).toBe(0.1);
    expect(calibrated.rawPFatalUpper95).toBe(0.2);
    expect(calibrated.pFatal).toBeCloseTo(1 / 6, 12);
    expect((calibrated.pFatal ?? 0) + (calibrated.pAligned ?? 0) + (calibrated.pDouble ?? 0)).toBeCloseTo(1, 12);
    expect(calibrated.calibrationArtifactId).toBe("artifact-1");
    expect(calibrated.calibrationRevision).toBe(3);
    expect(calibrated.calibrationArtifactSha256).toBe(artifact.payloadSha256);
    expect(calibrated.calibrationReason).toBeNull();
  });

  it("retains diagnostics but makes an incompatible active artifact execution-unusable", () => {
    const rejected = applyActiveMismatchCalibrationToEstimate({
      estimate: rawEstimate,
      activation: {
        artifact: { id: "artifact-2", baseModelVersion: "another-model", artifact },
        revision: 4,
      },
      combination: COMBINATION,
      secondsRemaining: 45,
    });

    expect(rejected.available).toBe(true);
    expect(rejected.executionUsable).toBe(false);
    expect(rejected.executionReason).toBe("mismatch_calibration_base_model_version_mismatch");
    expect(rejected.calibrationReason).toBe("base_model_version_mismatch");
    expect(rejected.modelVersion).toBe(BASE_MODEL_VERSION);
  });
});

function buildActivationFixture(baseModelVersion = MISMATCH_RISK_RUNTIME_MODEL_VERSION) {
  return buildEligibleMismatchCalibrationFixture({ baseModelVersion });
}

function shiftTrainingCurveMetric(metrics: Record<string, unknown>, field: "count" | "fatalCount") {
  const training = metrics.training as Record<string, unknown>;
  const groups = Object.values(training.byCurve as Record<string, Record<string, unknown>>);
  const first = groups[0];
  const second = groups[1];
  if (!first || !second) {
    throw new Error("Expected at least two training curve groups");
  }
  for (const [group, delta] of [
    [first, 1],
    [second, -1],
  ] as const) {
    group[field] = Number(group[field]) + delta;
    for (const scoreKey of ["raw", "calibrated", "conservativeUpper95"] as const) {
      const score = group[scoreKey] as Record<string, unknown>;
      score[field] = group[field];
      score.fatalRate = Number(score.fatalCount) / Number(score.count);
    }
  }
}

describe("mismatch calibration horizon bands", () => {
  it("maps exact boundaries without admitting the unmeasured final five seconds", () => {
    expect(resolveMismatchCalibrationHorizonBand(4.999)).toBeNull();
    expect(resolveMismatchCalibrationHorizonBand(5)).toBe("seconds_5_to_30");
    expect(resolveMismatchCalibrationHorizonBand(30)).toBe("seconds_5_to_30");
    expect(resolveMismatchCalibrationHorizonBand(30.001)).toBe("seconds_over_30_to_60");
    expect(resolveMismatchCalibrationHorizonBand(60)).toBe("seconds_over_30_to_60");
    expect(resolveMismatchCalibrationHorizonBand(120)).toBe("seconds_over_60_to_120");
    expect(resolveMismatchCalibrationHorizonBand(180)).toBe("seconds_over_120_to_180");
    expect(resolveMismatchCalibrationHorizonBand(300)).toBe("seconds_over_180_to_300");
    expect(resolveMismatchCalibrationHorizonBand(301)).toBe("seconds_over_300");
    expect(resolveMismatchCalibrationHorizonBand(Number.NaN)).toBeNull();
  });
});
