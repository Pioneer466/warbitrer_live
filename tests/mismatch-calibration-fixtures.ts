import { MARKET_ASSETS } from "@/lib/market-catalog";
import {
  buildMismatchCalibrationArtifact,
  MISMATCH_CALIBRATION_HORIZON_BANDS,
  type MismatchCalibrationArtifactV1,
} from "@/lib/mismatch-calibration";
import { MISMATCH_RISK_RUNTIME_MODEL_VERSION } from "@/lib/mismatch-risk-runtime";

const COMBINATIONS = ["POLY_UP_KALSHI_NO", "POLY_DOWN_KALSHI_YES"] as const;
const DAY_MS = 24 * 60 * 60_000;

export function buildEligibleMismatchCalibrationFixture(
  options: {
    baseModelVersion?: string;
    trainingStartedAt?: number;
    trainingEndedAt?: number;
  } = {},
) {
  const baseModelVersion = options.baseModelVersion ?? MISMATCH_RISK_RUNTIME_MODEL_VERSION;
  const buildLabels = (nonFatalCount: number, fatalCount: number) =>
    MISMATCH_CALIBRATION_HORIZON_BANDS.flatMap((horizonBand) =>
      COMBINATIONS.flatMap((combination) => [
        ...Array.from({ length: nonFatalCount }, () => ({
          rawProbability: 0.05,
          fatal: false,
          horizonBand,
          combination,
        })),
        ...Array.from({ length: fatalCount }, () => ({
          rawProbability: 0.8,
          fatal: true,
          horizonBand,
          combination,
        })),
      ]),
    );
  const validationArtifact = buildMismatchCalibrationArtifact({
    baseModelVersion,
    minimumPreBinCount: 100,
    labels: buildLabels(240, 60),
  });
  const artifact = buildMismatchCalibrationArtifact({
    baseModelVersion,
    minimumPreBinCount: 100,
    labels: buildLabels(400, 100),
  });
  const trainingStartedAt = options.trainingStartedAt ?? 1_800_000_000_000;
  const trainingEndedAt = options.trainingEndedAt ?? trainingStartedAt + 20 * DAY_MS;
  const firstSlotEndTs = trainingStartedAt + 10 * 60_000;
  const splitSlotEndTs = trainingStartedAt + 15 * DAY_MS;
  const testFirstSlotEndTs = splitSlotEndTs + 15 * 60_000;
  const lastSlotEndTs = trainingEndedAt + 15_000;
  const assets = [...MARKET_ASSETS].sort();
  const curveKeys = MISMATCH_CALIBRATION_HORIZON_BANDS.flatMap((horizonBand) =>
    COMBINATIONS.map((combination) => `${horizonBand}/${combination}`),
  );

  const training = buildEvaluation({
    count: 3_600,
    fatalCount: 720,
    curveKeys,
    curveCount: 300,
    curveFatalCount: 60,
    assets,
    assetCounts: [515, 515, 515, 515, 515, 515, 510],
    assetFatalCounts: [103, 103, 103, 103, 103, 103, 102],
  });
  const test = buildEvaluation({
    count: 2_400,
    fatalCount: 480,
    curveKeys,
    curveCount: 200,
    curveFatalCount: 40,
    assets,
    assetCounts: [343, 343, 343, 343, 343, 343, 342],
    assetFatalCounts: [69, 69, 69, 69, 69, 69, 66],
  });
  const deploymentResubstitution = buildEvaluation({
    count: 6_000,
    fatalCount: 1_200,
    curveKeys,
    curveCount: 500,
    curveFatalCount: 100,
    assets,
    assetCounts: [858, 858, 858, 858, 858, 858, 852],
    assetFatalCounts: [172, 172, 172, 172, 172, 172, 168],
  });

  return {
    artifact,
    schemaVersion: artifact.schemaVersion,
    baseModelVersion: artifact.baseModelVersion,
    trainingStartedAt,
    trainingEndedAt,
    createdAt: trainingEndedAt + 1,
    activationAt: trainingEndedAt + DAY_MS,
    metrics: {
      schemaVersion: 1,
      splitMethod: "chronological-slot-end-v1",
      trainFractionRequested: 0.8,
      splitSlotEndTs,
      splitSlotEndIso: new Date(splitSlotEndTs).toISOString(),
      queryProvenance: {
        fromTs: firstSlotEndTs - 1,
        fromIso: new Date(firstSlotEndTs - 1).toISOString(),
        toTs: lastSlotEndTs,
        toIso: new Date(lastSlotEndTs).toISOString(),
        horizonsSeconds: [600, 240, 150, 90, 45, 15],
        sampleToleranceSeconds: 20,
        baseModelVersion: artifact.baseModelVersion,
        resolutionRequirement: "dual-finalized official-venue-resolution",
        executionUsableRequired: true,
        actualHorizonBandRequired: true,
        uniqueSamplePerCombinationAcrossHorizons: true,
        sampleSelection: "nearest-lag-captured-at-desc-id-desc-v1",
      },
      observations: {
        labelCount: artifact.labelCount,
        uniqueOracleSampleCount: 3_000,
        assetSlotCount: 1_500,
        chronologicalSlotCount: 1_250,
        assets,
        firstCapturedAt: trainingStartedAt,
        lastCapturedAt: trainingEndedAt,
        firstSlotEndTs,
        lastSlotEndTs,
        trainingLastSlotEndTs: splitSlotEndTs,
        testFirstSlotEndTs,
        maximumSampleLagMs: 20_000,
        trainingLabelCount: training.count,
        testLabelCount: test.count,
        trainingChronologicalSlotCount: 1_000,
        testChronologicalSlotCount: 250,
      },
      validationArtifact,
      validationArtifactSha256: validationArtifact.payloadSha256,
      training,
      test,
      deploymentArtifactTraining: "full-window-after-holdout-evaluation",
      deploymentResubstitution,
    },
  };
}

function buildEvaluation(input: {
  count: number;
  fatalCount: number;
  curveKeys: readonly string[];
  curveCount: number;
  curveFatalCount: number;
  assets: readonly string[];
  assetCounts: readonly number[];
  assetFatalCounts: readonly number[];
}) {
  return {
    ...buildMetricGroup(input.count, input.fatalCount),
    fatalRate: input.fatalCount / input.count,
    byCurve: Object.fromEntries(
      input.curveKeys.map((key) => [key, buildMetricGroup(input.curveCount, input.curveFatalCount)]),
    ),
    byAsset: Object.fromEntries(
      input.assets.map((asset, index) => [
        asset,
        buildMetricGroup(input.assetCounts[index] ?? 0, input.assetFatalCounts[index] ?? 0),
      ]),
    ),
  };
}

function buildMetricGroup(count: number, fatalCount: number) {
  return {
    count,
    fatalCount,
    raw: buildScores(count, fatalCount, { brierScore: 0.08, logLoss: 0.3 }),
    calibrated: buildScores(count, fatalCount, { brierScore: 0.07, logLoss: 0.28 }),
    conservativeUpper95: buildScores(count, fatalCount, { brierScore: 0.1, logLoss: 0.35 }),
  };
}

function buildScores(count: number, fatalCount: number, scores: { brierScore: number; logLoss: number }) {
  const fatalRate = fatalCount / count;
  return {
    count,
    fatalCount,
    fatalRate,
    meanPrediction: fatalRate,
    brierScore: scores.brierScore,
    logLoss: scores.logLoss,
    auc: 0.8,
  };
}

export type EligibleMismatchCalibrationFixture = ReturnType<typeof buildEligibleMismatchCalibrationFixture> & {
  artifact: MismatchCalibrationArtifactV1;
};
