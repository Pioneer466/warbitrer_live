import { createHash } from "node:crypto";

import { calculateFatalProbabilityCalibration } from "@/lib/mismatch-risk";
import type { MismatchCombination } from "@/lib/mismatch-risk";
import { MISMATCH_RISK_RUNTIME_MODEL_VERSION } from "@/lib/mismatch-risk-runtime";
import { MARKET_ASSETS } from "@/lib/market-catalog";
import type { MismatchRiskEstimate, PairCombination } from "@/lib/types";

export const MISMATCH_CALIBRATION_SCHEMA_VERSION = 1 as const;
export const MISMATCH_CALIBRATION_METHOD = "pava-jeffreys-cluster-conservative-v2" as const;
export const DEFAULT_MISMATCH_CALIBRATION_MINIMUM_PRE_BIN_COUNT = 100;
// At most seven asset observations share one 15-minute market regime. Treating
// them as one effective cluster keeps the upper bound conservative under full
// cross-asset dependence while retaining all labels for the monotone mean.
export const MISMATCH_CALIBRATION_DEPENDENCE_DESIGN_EFFECT = 7 as const;
export const MISMATCH_CALIBRATION_MINIMUM_ACTIVATION_WINDOW_MS = 14 * 24 * 60 * 60_000;
export const MISMATCH_CALIBRATION_MAXIMUM_ACTIVATION_AGE_MS = 7 * 24 * 60 * 60_000;
export const MISMATCH_CALIBRATION_MINIMUM_CURVE_LABELS = 500;
export const MISMATCH_CALIBRATION_MINIMUM_HOLDOUT_CURVE_LABELS = 100;
export const MISMATCH_CALIBRATION_MINIMUM_HOLDOUT_CURVE_FATALS = 5;

export const MISMATCH_CALIBRATION_HORIZON_BANDS = [
  "seconds_5_to_30",
  "seconds_over_30_to_60",
  "seconds_over_60_to_120",
  "seconds_over_120_to_180",
  "seconds_over_180_to_300",
  "seconds_over_300",
] as const;

export type MismatchCalibrationHorizonBand = (typeof MISMATCH_CALIBRATION_HORIZON_BANDS)[number];

const MISMATCH_COMBINATIONS = [
  "POLY_UP_KALSHI_NO",
  "POLY_DOWN_KALSHI_YES",
] as const satisfies readonly MismatchCombination[];
const ACTIVATION_HORIZONS_SECONDS = [600, 240, 150, 90, 45, 15] as const;
const JEFFREYS_PRIOR_ALPHA = 0.5 as const;
const JEFFREYS_PRIOR_BETA = 0.5 as const;
const UPPER_BOUND_CONFIDENCE = 0.95 as const;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;
const NUMBER_TOLERANCE = 1e-12;
const ACTIVATION_METRICS_KEYS = [
  "schemaVersion",
  "splitMethod",
  "trainFractionRequested",
  "splitSlotEndTs",
  "splitSlotEndIso",
  "queryProvenance",
  "observations",
  "validationArtifact",
  "validationArtifactSha256",
  "training",
  "test",
  "deploymentArtifactTraining",
  "deploymentResubstitution",
] as const;
const ACTIVATION_QUERY_PROVENANCE_KEYS = [
  "fromTs",
  "fromIso",
  "toTs",
  "toIso",
  "horizonsSeconds",
  "sampleToleranceSeconds",
  "baseModelVersion",
  "resolutionRequirement",
  "executionUsableRequired",
  "actualHorizonBandRequired",
  "uniqueSamplePerCombinationAcrossHorizons",
  "sampleSelection",
] as const;
const ACTIVATION_OBSERVATION_PROVENANCE_KEYS = [
  "labelCount",
  "uniqueOracleSampleCount",
  "assetSlotCount",
  "chronologicalSlotCount",
  "assets",
  "firstCapturedAt",
  "lastCapturedAt",
  "firstSlotEndTs",
  "lastSlotEndTs",
  "trainingLastSlotEndTs",
  "testFirstSlotEndTs",
  "maximumSampleLagMs",
  "trainingLabelCount",
  "testLabelCount",
  "trainingChronologicalSlotCount",
  "testChronologicalSlotCount",
] as const;
const ACTIVATION_EVALUATION_KEYS = [
  "count",
  "fatalCount",
  "fatalRate",
  "raw",
  "calibrated",
  "conservativeUpper95",
  "byCurve",
  "byAsset",
] as const;
const ACTIVATION_METRIC_GROUP_KEYS = ["count", "fatalCount", "raw", "calibrated", "conservativeUpper95"] as const;
const ACTIVATION_SCORE_KEYS = [
  "count",
  "fatalCount",
  "fatalRate",
  "meanPrediction",
  "brierScore",
  "logLoss",
  "auc",
] as const;

export type MismatchCalibrationLabel = {
  rawProbability: number;
  fatal: boolean;
  horizonBand: MismatchCalibrationHorizonBand;
  combination: MismatchCombination;
};

export type MismatchCalibrationBlock = {
  rawProbabilityMin: number;
  rawProbabilityMax: number;
  labelCount: number;
  fatalCount: number;
  sourcePreBinCount: number;
  posteriorAlpha: number;
  posteriorBeta: number;
  calibratedProbability: number;
  pFatalUpper95: number;
};

export type MismatchCalibrationCurve = {
  horizonBand: MismatchCalibrationHorizonBand;
  combination: MismatchCombination;
  labelCount: number;
  fatalCount: number;
  rawProbabilityMin: number;
  rawProbabilityMax: number;
  blocks: MismatchCalibrationBlock[];
};

export type MismatchCalibrationArtifactPayloadV1 = {
  schemaVersion: typeof MISMATCH_CALIBRATION_SCHEMA_VERSION;
  method: typeof MISMATCH_CALIBRATION_METHOD;
  baseModelVersion: string;
  priorAlpha: typeof JEFFREYS_PRIOR_ALPHA;
  priorBeta: typeof JEFFREYS_PRIOR_BETA;
  upperBoundConfidence: typeof UPPER_BOUND_CONFIDENCE;
  dependenceDesignEffect: typeof MISMATCH_CALIBRATION_DEPENDENCE_DESIGN_EFFECT;
  minimumPreBinCount: number;
  labelCount: number;
  curves: MismatchCalibrationCurve[];
};

export type MismatchCalibrationArtifactV1 = MismatchCalibrationArtifactPayloadV1 & {
  payloadSha256: string;
};

export type MismatchCalibrationArtifact = MismatchCalibrationArtifactV1;

export type BuildMismatchCalibrationArtifactInput = {
  baseModelVersion: string;
  labels: readonly MismatchCalibrationLabel[];
  minimumPreBinCount?: number;
};

export type MismatchCalibrationUnavailableReason =
  | "artifact_unavailable"
  | "artifact_invalid"
  | "artifact_checksum_mismatch"
  | "base_model_version_mismatch"
  | "invalid_raw_probability"
  | "unsupported_horizon_band"
  | "unsupported_combination"
  | "horizon_band_not_calibrated"
  | "combination_not_calibrated";

export type ApplyMismatchCalibrationInput = {
  artifact: unknown;
  baseModelVersion: string;
  horizonBand: MismatchCalibrationHorizonBand;
  combination: MismatchCombination;
  rawProbability: number;
};

export type PreparedMismatchCalibrationInput = Pick<ApplyMismatchCalibrationInput, "artifact" | "baseModelVersion">;

export type PreparedMismatchCalibrationEvaluationInput = Pick<
  ApplyMismatchCalibrationInput,
  "horizonBand" | "combination" | "rawProbability"
>;

export type ApplyMismatchCalibrationResult =
  | {
      available: true;
      reason: null;
      calibratedProbability: number;
      pFatalUpper95: number;
      labelCount: number;
      fatalCount: number;
      artifactSha256: string;
      block: MismatchCalibrationBlock;
    }
  | {
      available: false;
      reason: MismatchCalibrationUnavailableReason;
    };

export type PreparedMismatchCalibrationEvaluator =
  | {
      available: true;
      evaluate: (input: PreparedMismatchCalibrationEvaluationInput) => ApplyMismatchCalibrationResult;
    }
  | {
      available: false;
      reason: MismatchCalibrationUnavailableReason;
    };

export type ActiveMismatchCalibrationInput = {
  artifact: {
    id: string;
    baseModelVersion: string;
    artifact: unknown;
  } | null;
  revision: number;
};

export type MismatchCalibrationActivationEligibilityInput = {
  artifact: unknown;
  schemaVersion: number;
  baseModelVersion: string;
  trainingStartedAt: number;
  trainingEndedAt: number;
  createdAt: number;
  metrics: unknown;
  activationAt: number;
};

export type MismatchCalibrationActivationEligibility = {
  eligible: boolean;
  reasons: string[];
};

type MutableCalibrationBlock = {
  rawProbabilityMin: number;
  rawProbabilityMax: number;
  labelCount: number;
  fatalCount: number;
  sourcePreBinCount: number;
};

export function resolveMismatchCalibrationHorizonBand(secondsRemaining: number): MismatchCalibrationHorizonBand | null {
  if (!Number.isFinite(secondsRemaining) || secondsRemaining < 5) {
    return null;
  }
  if (secondsRemaining <= 30) {
    return "seconds_5_to_30";
  }
  if (secondsRemaining <= 60) {
    return "seconds_over_30_to_60";
  }
  if (secondsRemaining <= 120) {
    return "seconds_over_60_to_120";
  }
  if (secondsRemaining <= 180) {
    return "seconds_over_120_to_180";
  }
  if (secondsRemaining <= 300) {
    return "seconds_over_180_to_300";
  }
  return "seconds_over_300";
}

export function buildMismatchCalibrationArtifact(
  input: BuildMismatchCalibrationArtifactInput,
): MismatchCalibrationArtifactV1 {
  assertNonEmptyCanonicalString(input.baseModelVersion, "baseModelVersion");
  const minimumPreBinCount = input.minimumPreBinCount ?? DEFAULT_MISMATCH_CALIBRATION_MINIMUM_PRE_BIN_COUNT;
  assertPositiveInteger(minimumPreBinCount, "minimumPreBinCount");
  if (!Array.isArray(input.labels) || input.labels.length === 0) {
    throw new RangeError("labels must contain at least one calibration label");
  }

  const labels = input.labels.map((label, index) => validateAndCopyLabel(label, index));
  const curves: MismatchCalibrationCurve[] = [];

  for (const horizonBand of MISMATCH_CALIBRATION_HORIZON_BANDS) {
    for (const combination of MISMATCH_COMBINATIONS) {
      const group = labels
        .filter((label) => label.horizonBand === horizonBand && label.combination === combination)
        .sort(compareLabels);
      if (group.length === 0) {
        continue;
      }
      if (group.length < minimumPreBinCount) {
        throw new RangeError(
          `calibration group ${horizonBand}/${combination} contains ${group.length} labels; minimum is ${minimumPreBinCount}`,
        );
      }
      curves.push(buildCurve(horizonBand, combination, group, minimumPreBinCount));
    }
  }

  const payload: MismatchCalibrationArtifactPayloadV1 = {
    schemaVersion: MISMATCH_CALIBRATION_SCHEMA_VERSION,
    method: MISMATCH_CALIBRATION_METHOD,
    baseModelVersion: input.baseModelVersion,
    priorAlpha: JEFFREYS_PRIOR_ALPHA,
    priorBeta: JEFFREYS_PRIOR_BETA,
    upperBoundConfidence: UPPER_BOUND_CONFIDENCE,
    dependenceDesignEffect: MISMATCH_CALIBRATION_DEPENDENCE_DESIGN_EFFECT,
    minimumPreBinCount,
    labelCount: labels.length,
    curves,
  };

  return {
    ...payload,
    payloadSha256: calculateMismatchCalibrationArtifactChecksum(payload),
  };
}

export function calculateMismatchCalibrationArtifactChecksum(payload: MismatchCalibrationArtifactPayloadV1): string {
  return createHash("sha256").update(canonicalizeJson(payload), "utf8").digest("hex");
}

export function verifyMismatchCalibrationArtifact(
  value: unknown,
):
  | { valid: true; artifact: MismatchCalibrationArtifactV1 }
  | { valid: false; reason: "artifact_invalid" | "artifact_checksum_mismatch" } {
  if (!isValidArtifactStructure(value)) {
    return { valid: false, reason: "artifact_invalid" };
  }

  const payload = artifactPayload(value);
  if (calculateMismatchCalibrationArtifactChecksum(payload) !== value.payloadSha256) {
    return { valid: false, reason: "artifact_checksum_mismatch" };
  }
  return { valid: true, artifact: value };
}

export function applyMismatchCalibration(input: ApplyMismatchCalibrationInput): ApplyMismatchCalibrationResult {
  const verified = verifyMismatchCalibrationForBaseModel(input);
  if (!verified.available) {
    return verified;
  }
  return evaluateVerifiedMismatchCalibration(verified.artifact, input);
}

export function prepareMismatchCalibrationEvaluator(
  input: PreparedMismatchCalibrationInput,
): PreparedMismatchCalibrationEvaluator {
  const verified = verifyMismatchCalibrationForBaseModel(input);
  if (!verified.available) {
    return verified;
  }
  // Own the verified evaluation payload so later caller mutation cannot bypass
  // the one-time checksum verification performed for this batch.
  const artifact = {
    ...verified.artifact,
    curves: verified.artifact.curves.map((curve) => ({
      ...curve,
      blocks: curve.blocks.map((block) => ({ ...block })),
    })),
  };
  return {
    available: true,
    evaluate: (evaluationInput) => evaluateVerifiedMismatchCalibration(artifact, evaluationInput),
  };
}

function verifyMismatchCalibrationForBaseModel(
  input: PreparedMismatchCalibrationInput,
):
  | { available: true; artifact: MismatchCalibrationArtifactV1 }
  | Extract<ApplyMismatchCalibrationResult, { available: false }> {
  if (input.artifact === null || input.artifact === undefined) {
    return unavailable("artifact_unavailable");
  }

  const verification = verifyMismatchCalibrationArtifact(input.artifact);
  if (!verification.valid) {
    return unavailable(verification.reason);
  }
  const artifact = verification.artifact;

  if (input.baseModelVersion !== artifact.baseModelVersion) {
    return unavailable("base_model_version_mismatch");
  }

  return { available: true, artifact };
}

function evaluateVerifiedMismatchCalibration(
  artifact: MismatchCalibrationArtifactV1,
  input: PreparedMismatchCalibrationEvaluationInput,
): ApplyMismatchCalibrationResult {
  if (!isProbability(input.rawProbability)) {
    return unavailable("invalid_raw_probability");
  }
  if (!isHorizonBand(input.horizonBand)) {
    return unavailable("unsupported_horizon_band");
  }
  if (!isCombination(input.combination)) {
    return unavailable("unsupported_combination");
  }
  const horizonCurves = artifact.curves.filter((curve) => curve.horizonBand === input.horizonBand);
  if (horizonCurves.length === 0) {
    return unavailable("horizon_band_not_calibrated");
  }
  const curve = horizonCurves.find((candidate) => candidate.combination === input.combination);
  if (!curve) {
    return unavailable("combination_not_calibrated");
  }

  const block =
    curve.blocks.find((candidate) => input.rawProbability <= candidate.rawProbabilityMax) ??
    curve.blocks[curve.blocks.length - 1];

  return {
    available: true,
    reason: null,
    calibratedProbability: block.calibratedProbability,
    pFatalUpper95: block.pFatalUpper95,
    labelCount: block.labelCount,
    fatalCount: block.fatalCount,
    artifactSha256: artifact.payloadSha256,
    block: { ...block },
  };
}

export function applyActiveMismatchCalibrationToEstimate(input: {
  estimate: MismatchRiskEstimate;
  activation: ActiveMismatchCalibrationInput;
  combination: PairCombination;
  secondsRemaining: number;
}): MismatchRiskEstimate {
  const { estimate, activation } = input;
  const rawMetadata = {
    rawModelVersion: estimate.rawModelVersion ?? estimate.modelVersion,
    rawPFatal: estimate.pFatal,
    rawPFatalUpper95: estimate.pFatalUpper95,
    calibrationArtifactId: activation.artifact?.id ?? null,
    calibrationRevision: activation.revision,
  };
  if (
    !estimate.available ||
    estimate.pFatal === null ||
    estimate.pFatalUpper95 === null ||
    estimate.pAligned === null ||
    estimate.pDouble === null
  ) {
    return {
      ...estimate,
      ...rawMetadata,
      calibrationArtifactSha256: null,
      calibrationLabelCount: null,
      calibrationReason: activation.artifact ? "raw_estimate_unavailable" : "artifact_unavailable",
    };
  }

  const artifactRecord = activation.artifact;
  if (!artifactRecord) {
    return {
      ...estimate,
      ...rawMetadata,
      calibrationArtifactSha256: null,
      calibrationLabelCount: null,
      calibrationReason: "artifact_unavailable",
    };
  }

  const horizonBand = resolveMismatchCalibrationHorizonBand(input.secondsRemaining);
  if (!horizonBand || artifactRecord.baseModelVersion !== estimate.modelVersion) {
    const calibrationReason = !horizonBand ? "unsupported_horizon_band" : "base_model_version_mismatch";
    return {
      ...estimate,
      ...rawMetadata,
      executionUsable: false,
      executionReason: `mismatch_calibration_${calibrationReason}`,
      calibrationArtifactSha256: null,
      calibrationLabelCount: null,
      calibrationReason,
    };
  }

  const calibrated = applyMismatchCalibration({
    artifact: artifactRecord.artifact,
    baseModelVersion: estimate.modelVersion,
    horizonBand,
    combination: input.combination,
    rawProbability: estimate.pFatal,
  });
  if (!calibrated.available) {
    return {
      ...estimate,
      ...rawMetadata,
      executionUsable: false,
      executionReason: `mismatch_calibration_${calibrated.reason}`,
      calibrationArtifactSha256: null,
      calibrationLabelCount: null,
      calibrationReason: calibrated.reason,
    };
  }

  const nonFatalProbability = estimate.pAligned + estimate.pDouble;
  const calibratedNonFatalProbability = 1 - calibrated.calibratedProbability;
  const calibratedDoubleProbability =
    nonFatalProbability > 0 ? calibratedNonFatalProbability * (estimate.pDouble / nonFatalProbability) : 0;
  const calibratedAlignedProbability = Math.max(0, 1 - calibrated.calibratedProbability - calibratedDoubleProbability);
  const baseVersion = estimate.modelVersion.replace(/-uncalibrated$/i, "");
  return {
    ...estimate,
    ...rawMetadata,
    modelVersion: `${baseVersion}-${MISMATCH_CALIBRATION_METHOD}-calibrated-${calibrated.artifactSha256.slice(0, 12)}`,
    pFatal: calibrated.calibratedProbability,
    pFatalUpper95: Math.max(calibrated.calibratedProbability, calibrated.pFatalUpper95),
    pAligned: calibratedAlignedProbability,
    pDouble: calibratedDoubleProbability,
    calibrationArtifactSha256: calibrated.artifactSha256,
    calibrationLabelCount: calibrated.labelCount,
    calibrationReason: null,
  };
}

export function evaluateMismatchCalibrationActivationEligibility(
  input: MismatchCalibrationActivationEligibilityInput,
): MismatchCalibrationActivationEligibility {
  const reasons: string[] = [];
  const verification = verifyMismatchCalibrationArtifact(input.artifact);
  if (!verification.valid) {
    return { eligible: false, reasons: [verification.reason] };
  }
  const artifact = verification.artifact;
  if (input.schemaVersion !== artifact.schemaVersion || input.baseModelVersion !== artifact.baseModelVersion) {
    reasons.push("artifact_metadata_mismatch");
  }
  if (artifact.baseModelVersion !== MISMATCH_RISK_RUNTIME_MODEL_VERSION) {
    reasons.push("runtime_base_model_version_mismatch");
  }
  if (artifact.minimumPreBinCount < DEFAULT_MISMATCH_CALIBRATION_MINIMUM_PRE_BIN_COUNT) {
    reasons.push("minimum_pre_bin_count_below_policy");
  }

  const expectedCurveKeys = new Set(
    MISMATCH_CALIBRATION_HORIZON_BANDS.flatMap((band) =>
      MISMATCH_COMBINATIONS.map((combination) => `${band}/${combination}`),
    ),
  );
  const actualCurveKeys = new Set(artifact.curves.map((curve) => `${curve.horizonBand}/${curve.combination}`));
  if (
    actualCurveKeys.size !== expectedCurveKeys.size ||
    [...expectedCurveKeys].some((key) => !actualCurveKeys.has(key))
  ) {
    reasons.push("incomplete_curve_coverage");
  }
  if (artifact.curves.some((curve) => curve.labelCount < MISMATCH_CALIBRATION_MINIMUM_CURVE_LABELS)) {
    reasons.push("insufficient_curve_labels");
  }

  if (
    !isSafeNonNegativeInteger(input.trainingStartedAt) ||
    !isSafeNonNegativeInteger(input.trainingEndedAt) ||
    input.trainingEndedAt < input.trainingStartedAt ||
    input.trainingEndedAt - input.trainingStartedAt < MISMATCH_CALIBRATION_MINIMUM_ACTIVATION_WINDOW_MS
  ) {
    reasons.push("insufficient_training_window");
  }
  if (
    !isSafeNonNegativeInteger(input.createdAt) ||
    input.createdAt < input.trainingEndedAt ||
    !isSafeNonNegativeInteger(input.activationAt) ||
    input.activationAt < input.createdAt ||
    input.activationAt - input.trainingEndedAt > MISMATCH_CALIBRATION_MAXIMUM_ACTIVATION_AGE_MS
  ) {
    reasons.push("artifact_not_fresh_for_activation");
  }

  const metrics = input.metrics;
  if (!isRecord(metrics) || metrics.schemaVersion !== 1 || !hasExactKeys(metrics, ACTIVATION_METRICS_KEYS)) {
    reasons.push("metrics_invalid");
    return { eligible: false, reasons: uniqueSorted(reasons) };
  }
  const evidence = validateActivationProvenance(metrics, artifact, input, reasons);
  const expectedAssets = [...MARKET_ASSETS].sort();
  const trainingEvaluation = readActivationEvaluation(metrics.training, expectedCurveKeys, expectedAssets);
  const testEvaluation = validateActivationEvaluation(metrics.test, expectedCurveKeys, expectedAssets, reasons);
  const deploymentEvaluation = readActivationEvaluation(
    metrics.deploymentResubstitution,
    expectedCurveKeys,
    expectedAssets,
  );
  if (!trainingEvaluation || (evidence && trainingEvaluation.overall.count !== evidence.trainingLabelCount)) {
    reasons.push("training_metrics_inconsistent");
  }
  if (!testEvaluation || (evidence && testEvaluation.overall.count !== evidence.testLabelCount)) {
    reasons.push("holdout_metrics_inconsistent");
  }
  if (!deploymentEvaluation || deploymentEvaluation?.overall.count !== artifact.labelCount) {
    reasons.push("deployment_metrics_inconsistent");
  }
  if (
    evidence &&
    trainingEvaluation &&
    !validationArtifactTrainingMetricsAreConsistent(evidence.validationArtifact, trainingEvaluation)
  ) {
    reasons.push("validation_artifact_training_metrics_mismatch");
  }
  if (
    evidence &&
    trainingEvaluation &&
    testEvaluation &&
    deploymentEvaluation &&
    !activationEvaluationPartitionsAreConsistent(artifact, trainingEvaluation, testEvaluation, deploymentEvaluation)
  ) {
    reasons.push("activation_metrics_partition_inconsistent");
  }
  return { eligible: reasons.length === 0, reasons: uniqueSorted(reasons) };
}

function buildCurve(
  horizonBand: MismatchCalibrationHorizonBand,
  combination: MismatchCombination,
  labels: readonly MismatchCalibrationLabel[],
  minimumPreBinCount: number,
): MismatchCalibrationCurve {
  const preBins = buildPreBins(labels, minimumPreBinCount);
  const pooled: MutableCalibrationBlock[] = [];

  for (const preBin of preBins) {
    pooled.push(preBin);
    while (pooled.length >= 2) {
      const previous = pooled[pooled.length - 2];
      const current = pooled[pooled.length - 1];
      if (posteriorMean(previous) <= posteriorMean(current)) {
        break;
      }
      pooled.splice(pooled.length - 2, 2, mergeBlocks(previous, current));
    }
  }

  let monotoneUpper95 = 0;
  const blocks = pooled.map<MismatchCalibrationBlock>((block) => {
    const calibration = calculateFatalProbabilityCalibration({
      fatalCount: block.fatalCount,
      totalCount: block.labelCount,
      priorAlpha: JEFFREYS_PRIOR_ALPHA,
      priorBeta: JEFFREYS_PRIOR_BETA,
      confidence: UPPER_BOUND_CONFIDENCE,
    });
    monotoneUpper95 = Math.max(monotoneUpper95, calculateDependenceAdjustedUpper95(block));
    return {
      ...block,
      posteriorAlpha: calibration.posteriorAlpha,
      posteriorBeta: calibration.posteriorBeta,
      calibratedProbability: calibration.posteriorMean,
      pFatalUpper95: monotoneUpper95,
    };
  });

  return {
    horizonBand,
    combination,
    labelCount: labels.length,
    fatalCount: labels.reduce((sum, label) => sum + Number(label.fatal), 0),
    rawProbabilityMin: labels[0].rawProbability,
    rawProbabilityMax: labels[labels.length - 1].rawProbability,
    blocks,
  };
}

function buildPreBins(
  labels: readonly MismatchCalibrationLabel[],
  minimumPreBinCount: number,
): MutableCalibrationBlock[] {
  const atomicBins: MutableCalibrationBlock[] = [];
  for (const label of labels) {
    const last = atomicBins[atomicBins.length - 1];
    if (last?.rawProbabilityMin === label.rawProbability) {
      last.labelCount += 1;
      last.fatalCount += Number(label.fatal);
      continue;
    }
    atomicBins.push({
      rawProbabilityMin: label.rawProbability,
      rawProbabilityMax: label.rawProbability,
      labelCount: 1,
      fatalCount: Number(label.fatal),
      sourcePreBinCount: 0,
    });
  }

  const preBins: MutableCalibrationBlock[] = [];
  let pending: MutableCalibrationBlock | null = null;
  for (const atomicBin of atomicBins) {
    pending = pending ? mergeBlocks(pending, atomicBin) : { ...atomicBin };
    if (pending.labelCount >= minimumPreBinCount) {
      preBins.push({ ...pending, sourcePreBinCount: 1 });
      pending = null;
    }
  }

  if (pending) {
    const previous = preBins.pop();
    if (!previous) {
      throw new RangeError("calibration group cannot form a minimum-size pre-bin");
    }
    preBins.push({ ...mergeBlocks(previous, pending), sourcePreBinCount: previous.sourcePreBinCount });
  }
  return preBins;
}

function mergeBlocks(left: MutableCalibrationBlock, right: MutableCalibrationBlock): MutableCalibrationBlock {
  return {
    rawProbabilityMin: left.rawProbabilityMin,
    rawProbabilityMax: right.rawProbabilityMax,
    labelCount: left.labelCount + right.labelCount,
    fatalCount: left.fatalCount + right.fatalCount,
    sourcePreBinCount: left.sourcePreBinCount + right.sourcePreBinCount,
  };
}

function posteriorMean(block: Pick<MutableCalibrationBlock, "fatalCount" | "labelCount">) {
  return (block.fatalCount + JEFFREYS_PRIOR_ALPHA) / (block.labelCount + JEFFREYS_PRIOR_ALPHA + JEFFREYS_PRIOR_BETA);
}

function calculateDependenceAdjustedUpper95(block: Pick<MutableCalibrationBlock, "fatalCount" | "labelCount">) {
  const independent = calculateFatalProbabilityCalibration({
    fatalCount: block.fatalCount,
    totalCount: block.labelCount,
    priorAlpha: JEFFREYS_PRIOR_ALPHA,
    priorBeta: JEFFREYS_PRIOR_BETA,
    confidence: UPPER_BOUND_CONFIDENCE,
  });
  const effectiveTotalCount = Math.max(1, Math.floor(block.labelCount / MISMATCH_CALIBRATION_DEPENDENCE_DESIGN_EFFECT));
  const effectiveFatalCount = Math.min(
    effectiveTotalCount,
    Math.ceil((block.fatalCount / block.labelCount) * effectiveTotalCount),
  );
  const clustered = calculateFatalProbabilityCalibration({
    fatalCount: effectiveFatalCount,
    totalCount: effectiveTotalCount,
    priorAlpha: JEFFREYS_PRIOR_ALPHA,
    priorBeta: JEFFREYS_PRIOR_BETA,
    confidence: UPPER_BOUND_CONFIDENCE,
  });
  return Math.max(independent.pFatalUpper95, clustered.pFatalUpper95);
}

function validateAndCopyLabel(label: MismatchCalibrationLabel, index: number): MismatchCalibrationLabel {
  if (!isRecord(label)) {
    throw new RangeError(`labels[${index}] must be an object`);
  }
  if (!isProbability(label.rawProbability)) {
    throw new RangeError(`labels[${index}].rawProbability must be between zero and one`);
  }
  if (typeof label.fatal !== "boolean") {
    throw new RangeError(`labels[${index}].fatal must be a boolean`);
  }
  if (!isHorizonBand(label.horizonBand)) {
    throw new RangeError(`labels[${index}].horizonBand is unsupported`);
  }
  if (!isCombination(label.combination)) {
    throw new RangeError(`labels[${index}].combination is unsupported`);
  }
  return {
    rawProbability: label.rawProbability,
    fatal: label.fatal,
    horizonBand: label.horizonBand,
    combination: label.combination,
  };
}

function compareLabels(left: MismatchCalibrationLabel, right: MismatchCalibrationLabel) {
  return left.rawProbability - right.rawProbability || Number(left.fatal) - Number(right.fatal);
}

function isValidArtifactStructure(value: unknown): value is MismatchCalibrationArtifactV1 {
  if (!isRecord(value) || !hasExactKeys(value, [...PAYLOAD_KEYS, "payloadSha256"])) {
    return false;
  }
  if (
    value.schemaVersion !== MISMATCH_CALIBRATION_SCHEMA_VERSION ||
    value.method !== MISMATCH_CALIBRATION_METHOD ||
    !isCanonicalString(value.baseModelVersion) ||
    value.priorAlpha !== JEFFREYS_PRIOR_ALPHA ||
    value.priorBeta !== JEFFREYS_PRIOR_BETA ||
    value.upperBoundConfidence !== UPPER_BOUND_CONFIDENCE ||
    value.dependenceDesignEffect !== MISMATCH_CALIBRATION_DEPENDENCE_DESIGN_EFFECT ||
    !isPositiveInteger(value.minimumPreBinCount) ||
    !isPositiveInteger(value.labelCount) ||
    !Array.isArray(value.curves) ||
    value.curves.length === 0 ||
    typeof value.payloadSha256 !== "string" ||
    !CHECKSUM_PATTERN.test(value.payloadSha256)
  ) {
    return false;
  }

  let totalLabelCount = 0;
  let previousCurveOrder = -1;
  const seenGroups = new Set<string>();
  for (const curve of value.curves) {
    if (!isValidCurve(curve, value.minimumPreBinCount)) {
      return false;
    }
    const curveOrder = groupOrder(curve.horizonBand, curve.combination);
    const groupKey = `${curve.horizonBand}/${curve.combination}`;
    if (curveOrder <= previousCurveOrder || seenGroups.has(groupKey)) {
      return false;
    }
    seenGroups.add(groupKey);
    previousCurveOrder = curveOrder;
    totalLabelCount += curve.labelCount;
  }
  return totalLabelCount === value.labelCount;
}

function isValidCurve(value: unknown, minimumPreBinCount: number): value is MismatchCalibrationCurve {
  if (!isRecord(value) || !hasExactKeys(value, CURVE_KEYS)) {
    return false;
  }
  if (
    !isHorizonBand(value.horizonBand) ||
    !isCombination(value.combination) ||
    !isPositiveInteger(value.labelCount) ||
    !isNonNegativeInteger(value.fatalCount) ||
    value.fatalCount > value.labelCount ||
    !isProbability(value.rawProbabilityMin) ||
    !isProbability(value.rawProbabilityMax) ||
    value.rawProbabilityMin > value.rawProbabilityMax ||
    !Array.isArray(value.blocks) ||
    value.blocks.length === 0
  ) {
    return false;
  }

  let labelCount = 0;
  let fatalCount = 0;
  let previousRawMaximum = -1;
  let previousMean = -1;
  let previousUpper95 = -1;
  let expectedMonotoneUpper95 = 0;
  for (const block of value.blocks) {
    if (!isValidBlock(block, minimumPreBinCount)) {
      return false;
    }
    expectedMonotoneUpper95 = Math.max(expectedMonotoneUpper95, calculateDependenceAdjustedUpper95(block));
    if (
      block.rawProbabilityMin <= previousRawMaximum ||
      block.calibratedProbability + NUMBER_TOLERANCE < previousMean ||
      block.pFatalUpper95 + NUMBER_TOLERANCE < previousUpper95 ||
      !approximatelyEqual(block.pFatalUpper95, expectedMonotoneUpper95)
    ) {
      return false;
    }
    previousRawMaximum = block.rawProbabilityMax;
    previousMean = block.calibratedProbability;
    previousUpper95 = block.pFatalUpper95;
    labelCount += block.labelCount;
    fatalCount += block.fatalCount;
  }

  return (
    labelCount === value.labelCount &&
    fatalCount === value.fatalCount &&
    value.rawProbabilityMin === value.blocks[0].rawProbabilityMin &&
    value.rawProbabilityMax === value.blocks[value.blocks.length - 1].rawProbabilityMax
  );
}

function isValidBlock(value: unknown, minimumPreBinCount: number): value is MismatchCalibrationBlock {
  if (!isRecord(value) || !hasExactKeys(value, BLOCK_KEYS)) {
    return false;
  }
  if (
    !isProbability(value.rawProbabilityMin) ||
    !isProbability(value.rawProbabilityMax) ||
    value.rawProbabilityMin > value.rawProbabilityMax ||
    !isPositiveInteger(value.labelCount) ||
    value.labelCount < minimumPreBinCount ||
    !isNonNegativeInteger(value.fatalCount) ||
    value.fatalCount > value.labelCount ||
    !isPositiveInteger(value.sourcePreBinCount) ||
    value.sourcePreBinCount > value.labelCount ||
    !isFiniteNumber(value.posteriorAlpha) ||
    !isFiniteNumber(value.posteriorBeta) ||
    !isProbability(value.calibratedProbability) ||
    !isProbability(value.pFatalUpper95) ||
    value.pFatalUpper95 + NUMBER_TOLERANCE < value.calibratedProbability
  ) {
    return false;
  }

  const expectedAlpha = value.fatalCount + JEFFREYS_PRIOR_ALPHA;
  const expectedBeta = value.labelCount - value.fatalCount + JEFFREYS_PRIOR_BETA;
  const expectedMean = expectedAlpha / (expectedAlpha + expectedBeta);
  return (
    approximatelyEqual(value.posteriorAlpha, expectedAlpha) &&
    approximatelyEqual(value.posteriorBeta, expectedBeta) &&
    approximatelyEqual(value.calibratedProbability, expectedMean)
  );
}

const PAYLOAD_KEYS = [
  "schemaVersion",
  "method",
  "baseModelVersion",
  "priorAlpha",
  "priorBeta",
  "upperBoundConfidence",
  "dependenceDesignEffect",
  "minimumPreBinCount",
  "labelCount",
  "curves",
] as const;

const CURVE_KEYS = [
  "horizonBand",
  "combination",
  "labelCount",
  "fatalCount",
  "rawProbabilityMin",
  "rawProbabilityMax",
  "blocks",
] as const;

const BLOCK_KEYS = [
  "rawProbabilityMin",
  "rawProbabilityMax",
  "labelCount",
  "fatalCount",
  "sourcePreBinCount",
  "posteriorAlpha",
  "posteriorBeta",
  "calibratedProbability",
  "pFatalUpper95",
] as const;

function artifactPayload(artifact: MismatchCalibrationArtifactV1): MismatchCalibrationArtifactPayloadV1 {
  return {
    schemaVersion: artifact.schemaVersion,
    method: artifact.method,
    baseModelVersion: artifact.baseModelVersion,
    priorAlpha: artifact.priorAlpha,
    priorBeta: artifact.priorBeta,
    upperBoundConfidence: artifact.upperBoundConfidence,
    dependenceDesignEffect: artifact.dependenceDesignEffect,
    minimumPreBinCount: artifact.minimumPreBinCount,
    labelCount: artifact.labelCount,
    curves: artifact.curves,
  };
}

type ActivationEvidenceSummary = {
  trainingLabelCount: number;
  testLabelCount: number;
  validationArtifact: MismatchCalibrationArtifactV1 | null;
};

type ActivationScores = {
  brierScore: number;
  logLoss: number;
  auc: number | null;
};

type ActivationMetricGroup = {
  count: number;
  fatalCount: number;
  raw: ActivationScores;
  calibrated: ActivationScores;
  conservativeUpper95: ActivationScores;
};

type ActivationEvaluation = {
  overall: ActivationMetricGroup;
  byCurve: Map<string, ActivationMetricGroup>;
  byAsset: Map<string, ActivationMetricGroup>;
};

function validateActivationProvenance(
  metrics: Record<string, unknown>,
  artifact: MismatchCalibrationArtifactV1,
  metadata: Pick<MismatchCalibrationActivationEligibilityInput, "trainingStartedAt" | "trainingEndedAt">,
  reasons: string[],
): ActivationEvidenceSummary | null {
  const validationArtifactVerification = verifyMismatchCalibrationArtifact(metrics.validationArtifact);
  const verifiedValidationArtifact = validationArtifactVerification.valid
    ? validationArtifactVerification.artifact
    : null;
  const validationArtifactCompatible =
    verifiedValidationArtifact !== null &&
    verifiedValidationArtifact.payloadSha256 === metrics.validationArtifactSha256 &&
    verifiedValidationArtifact.schemaVersion === artifact.schemaVersion &&
    verifiedValidationArtifact.method === artifact.method &&
    verifiedValidationArtifact.baseModelVersion === artifact.baseModelVersion &&
    verifiedValidationArtifact.minimumPreBinCount === artifact.minimumPreBinCount;
  if (!validationArtifactVerification.valid) {
    reasons.push("validation_artifact_invalid");
  } else if (!validationArtifactCompatible) {
    reasons.push("validation_artifact_incompatible");
  }

  const trainFractionRequested = metrics.trainFractionRequested;
  const splitSlotEndTs = metrics.splitSlotEndTs;
  const splitMetadataCompatible =
    metrics.splitMethod === "chronological-slot-end-v1" &&
    isProbability(trainFractionRequested) &&
    trainFractionRequested > 0 &&
    trainFractionRequested < 1 &&
    isSafeNonNegativeInteger(splitSlotEndTs) &&
    isExactIsoTimestamp(metrics.splitSlotEndIso, splitSlotEndTs) &&
    typeof metrics.validationArtifactSha256 === "string" &&
    CHECKSUM_PATTERN.test(metrics.validationArtifactSha256) &&
    metrics.deploymentArtifactTraining === "full-window-after-holdout-evaluation";
  if (!splitMetadataCompatible) {
    reasons.push("split_provenance_incompatible");
  }

  const query = metrics.queryProvenance;
  let queryFromTs: number | null = null;
  let queryToTs: number | null = null;
  let sampleToleranceSeconds: number | null = null;
  if (!isRecord(query)) {
    reasons.push("query_provenance_missing");
  } else {
    const queryHorizons = query.horizonsSeconds;
    const queryCompatible =
      hasExactKeys(query, ACTIVATION_QUERY_PROVENANCE_KEYS) &&
      query.baseModelVersion === artifact.baseModelVersion &&
      query.resolutionRequirement === "dual-finalized official-venue-resolution" &&
      query.executionUsableRequired === true &&
      query.actualHorizonBandRequired === true &&
      query.uniqueSamplePerCombinationAcrossHorizons === true &&
      query.sampleSelection === "nearest-lag-captured-at-desc-id-desc-v1" &&
      isSafeNonNegativeInteger(query.fromTs) &&
      isSafeNonNegativeInteger(query.toTs) &&
      query.fromTs < query.toTs &&
      isExactIsoTimestamp(query.fromIso, query.fromTs) &&
      isExactIsoTimestamp(query.toIso, query.toTs) &&
      Array.isArray(queryHorizons) &&
      queryHorizons.length === ACTIVATION_HORIZONS_SECONDS.length &&
      ACTIVATION_HORIZONS_SECONDS.every((value, index) => queryHorizons[index] === value) &&
      isSafePositiveInteger(query.sampleToleranceSeconds) &&
      query.sampleToleranceSeconds <= 20;
    if (!queryCompatible) {
      reasons.push("query_provenance_incompatible");
    } else {
      queryFromTs = query.fromTs as number;
      queryToTs = query.toTs as number;
      sampleToleranceSeconds = query.sampleToleranceSeconds as number;
    }
  }

  const observations = metrics.observations;
  if (!isRecord(observations)) {
    reasons.push("observation_provenance_missing");
    return null;
  }
  const expectedAssets = [...MARKET_ASSETS].sort();
  const assets = Array.isArray(observations.assets)
    ? observations.assets.filter((asset): asset is string => typeof asset === "string").sort()
    : [];
  if (
    !hasExactKeys(observations, ACTIVATION_OBSERVATION_PROVENANCE_KEYS) ||
    assets.length !== expectedAssets.length ||
    expectedAssets.some((asset, index) => assets[index] !== asset) ||
    !isSafePositiveInteger(observations.labelCount) ||
    !isSafePositiveInteger(observations.uniqueOracleSampleCount) ||
    !isSafePositiveInteger(observations.assetSlotCount) ||
    !isSafePositiveInteger(observations.chronologicalSlotCount) ||
    !isSafePositiveInteger(observations.trainingLabelCount) ||
    !isSafePositiveInteger(observations.testLabelCount) ||
    !isSafePositiveInteger(observations.trainingChronologicalSlotCount) ||
    !isSafePositiveInteger(observations.testChronologicalSlotCount) ||
    !isSafeNonNegativeInteger(observations.firstCapturedAt) ||
    !isSafeNonNegativeInteger(observations.lastCapturedAt) ||
    !isSafeNonNegativeInteger(observations.firstSlotEndTs) ||
    !isSafeNonNegativeInteger(observations.lastSlotEndTs) ||
    !isSafeNonNegativeInteger(observations.trainingLastSlotEndTs) ||
    !isSafeNonNegativeInteger(observations.testFirstSlotEndTs) ||
    !isSafeNonNegativeInteger(observations.maximumSampleLagMs)
  ) {
    reasons.push("observation_provenance_incompatible");
    return null;
  }

  const expectedTrainingSlotCount =
    splitMetadataCompatible && isProbability(trainFractionRequested)
      ? Math.max(
          1,
          Math.min(
            observations.chronologicalSlotCount - 1,
            Math.floor(observations.chronologicalSlotCount * trainFractionRequested),
          ),
        )
      : null;
  if (
    observations.labelCount !== artifact.labelCount ||
    observations.uniqueOracleSampleCount > observations.labelCount ||
    observations.assetSlotCount > observations.uniqueOracleSampleCount ||
    observations.chronologicalSlotCount > observations.assetSlotCount ||
    observations.trainingLabelCount + observations.testLabelCount !== observations.labelCount ||
    observations.trainingChronologicalSlotCount + observations.testChronologicalSlotCount !==
      observations.chronologicalSlotCount ||
    (expectedTrainingSlotCount !== null && observations.trainingChronologicalSlotCount !== expectedTrainingSlotCount) ||
    observations.firstCapturedAt !== metadata.trainingStartedAt ||
    observations.lastCapturedAt !== metadata.trainingEndedAt ||
    observations.firstCapturedAt > observations.lastCapturedAt ||
    observations.firstSlotEndTs > observations.trainingLastSlotEndTs ||
    observations.trainingLastSlotEndTs !== splitSlotEndTs ||
    observations.trainingLastSlotEndTs >= observations.testFirstSlotEndTs ||
    observations.testFirstSlotEndTs > observations.lastSlotEndTs ||
    (queryFromTs !== null && observations.firstSlotEndTs <= queryFromTs) ||
    (queryToTs !== null && observations.lastSlotEndTs > queryToTs) ||
    (sampleToleranceSeconds !== null && observations.maximumSampleLagMs > sampleToleranceSeconds * 1_000)
  ) {
    reasons.push("observation_provenance_incompatible");
  }
  return {
    trainingLabelCount: observations.trainingLabelCount,
    testLabelCount: observations.testLabelCount,
    validationArtifact: validationArtifactCompatible ? verifiedValidationArtifact : null,
  };
}

function validateActivationEvaluation(
  value: unknown,
  expectedCurveKeys: ReadonlySet<string>,
  expectedAssets: readonly string[],
  reasons: string[],
) {
  const evaluation = readActivationEvaluation(value, expectedCurveKeys, expectedAssets);
  if (!evaluation) {
    reasons.push(
      "holdout_metrics_inconsistent",
      "holdout_overall_policy_failed",
      "holdout_curve_metrics_incomplete",
      "holdout_asset_metrics_incomplete",
    );
    return null;
  }
  const overall = evaluation.overall;
  if (
    overall.count < MISMATCH_CALIBRATION_MINIMUM_HOLDOUT_CURVE_LABELS * expectedCurveKeys.size ||
    overall.fatalCount < MISMATCH_CALIBRATION_MINIMUM_HOLDOUT_CURVE_FATALS * expectedCurveKeys.size ||
    overall.count - overall.fatalCount < MISMATCH_CALIBRATION_MINIMUM_HOLDOUT_CURVE_FATALS * expectedCurveKeys.size ||
    overall.raw.auc === null ||
    overall.raw.auc < 0.6 ||
    scoreRegressed(overall.raw.brierScore, overall.calibrated.brierScore, 1.05) ||
    scoreRegressed(overall.raw.logLoss, overall.calibrated.logLoss, 1.05)
  ) {
    reasons.push("holdout_overall_policy_failed");
  }

  for (const key of expectedCurveKeys) {
    const group = evaluation.byCurve.get(key);
    if (
      !group ||
      group.count < MISMATCH_CALIBRATION_MINIMUM_HOLDOUT_CURVE_LABELS ||
      group.fatalCount < MISMATCH_CALIBRATION_MINIMUM_HOLDOUT_CURVE_FATALS ||
      group.count - group.fatalCount < MISMATCH_CALIBRATION_MINIMUM_HOLDOUT_CURVE_FATALS ||
      group.raw.auc === null ||
      group.raw.auc < 0.55 ||
      scoreRegressed(group.raw.brierScore, group.calibrated.brierScore, 1.15) ||
      scoreRegressed(group.raw.logLoss, group.calibrated.logLoss, 1.15)
    ) {
      reasons.push(`holdout_curve_policy_failed:${key}`);
    }
  }

  for (const asset of expectedAssets) {
    const group = evaluation.byAsset.get(asset);
    if (
      !group ||
      group.count < MISMATCH_CALIBRATION_MINIMUM_HOLDOUT_CURVE_LABELS ||
      group.fatalCount < MISMATCH_CALIBRATION_MINIMUM_HOLDOUT_CURVE_FATALS ||
      group.count - group.fatalCount < MISMATCH_CALIBRATION_MINIMUM_HOLDOUT_CURVE_FATALS ||
      group.raw.auc === null ||
      group.raw.auc < 0.55 ||
      scoreRegressed(group.raw.brierScore, group.calibrated.brierScore, 1.15) ||
      scoreRegressed(group.raw.logLoss, group.calibrated.logLoss, 1.15)
    ) {
      reasons.push(`holdout_asset_policy_failed:${asset}`);
    }
  }
  return evaluation;
}

function readActivationEvaluation(
  value: unknown,
  expectedCurveKeys: ReadonlySet<string>,
  expectedAssets: readonly string[],
): ActivationEvaluation | null {
  if (!isRecord(value) || !hasExactKeys(value, ACTIVATION_EVALUATION_KEYS) || !isProbability(value.fatalRate)) {
    return null;
  }
  const overall = readActivationMetricGroup(value, ACTIVATION_EVALUATION_KEYS);
  if (!overall || !approximatelyEqual(value.fatalRate, overall.fatalCount / overall.count)) {
    return null;
  }
  const byCurveValue = value.byCurve;
  const byAssetValue = value.byAsset;
  if (
    !isRecord(byCurveValue) ||
    !hasExactKeys(byCurveValue, [...expectedCurveKeys]) ||
    !isRecord(byAssetValue) ||
    !hasExactKeys(byAssetValue, expectedAssets)
  ) {
    return null;
  }

  const byCurve = new Map<string, ActivationMetricGroup>();
  const byAsset = new Map<string, ActivationMetricGroup>();
  for (const key of expectedCurveKeys) {
    const group = readActivationMetricGroup(byCurveValue[key], ACTIVATION_METRIC_GROUP_KEYS);
    if (!group) {
      return null;
    }
    byCurve.set(key, group);
  }
  for (const asset of expectedAssets) {
    const group = readActivationMetricGroup(byAssetValue[asset], ACTIVATION_METRIC_GROUP_KEYS);
    if (!group) {
      return null;
    }
    byAsset.set(asset, group);
  }
  const curveTotals = sumActivationMetricGroups(byCurve.values());
  const assetTotals = sumActivationMetricGroups(byAsset.values());
  if (
    curveTotals.count !== overall.count ||
    curveTotals.fatalCount !== overall.fatalCount ||
    assetTotals.count !== overall.count ||
    assetTotals.fatalCount !== overall.fatalCount
  ) {
    return null;
  }
  return { overall, byCurve, byAsset };
}

function readActivationMetricGroup(value: unknown, exactKeys: readonly string[]): ActivationMetricGroup | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, exactKeys) ||
    !isSafePositiveInteger(value.count) ||
    !isSafeNonNegativeInteger(value.fatalCount) ||
    value.fatalCount > value.count
  ) {
    return null;
  }
  const raw = readActivationScores(value.raw, value.count, value.fatalCount);
  const calibrated = readActivationScores(value.calibrated, value.count, value.fatalCount);
  const conservativeUpper95 = readActivationScores(value.conservativeUpper95, value.count, value.fatalCount);
  if (!raw || !calibrated || !conservativeUpper95) {
    return null;
  }
  return { count: value.count, fatalCount: value.fatalCount, raw, calibrated, conservativeUpper95 };
}

function readActivationScores(
  value: unknown,
  expectedCount: number,
  expectedFatalCount: number,
): ActivationScores | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ACTIVATION_SCORE_KEYS) ||
    value.count !== expectedCount ||
    value.fatalCount !== expectedFatalCount ||
    !isProbability(value.fatalRate) ||
    !approximatelyEqual(value.fatalRate, expectedFatalCount / expectedCount) ||
    !isProbability(value.meanPrediction) ||
    !isProbability(value.brierScore) ||
    !isFiniteNumber(value.logLoss) ||
    value.logLoss < 0 ||
    !(value.auc === null || isProbability(value.auc))
  ) {
    return null;
  }
  return { brierScore: value.brierScore, logLoss: value.logLoss, auc: value.auc as number | null };
}

function activationEvaluationPartitionsAreConsistent(
  artifact: MismatchCalibrationArtifactV1,
  training: ActivationEvaluation,
  test: ActivationEvaluation,
  deployment: ActivationEvaluation,
) {
  const artifactFatalCount = artifact.curves.reduce((sum, curve) => sum + curve.fatalCount, 0);
  if (
    training.overall.count + test.overall.count !== deployment.overall.count ||
    training.overall.fatalCount + test.overall.fatalCount !== deployment.overall.fatalCount ||
    deployment.overall.count !== artifact.labelCount ||
    deployment.overall.fatalCount !== artifactFatalCount
  ) {
    return false;
  }
  for (const curve of artifact.curves) {
    const key = `${curve.horizonBand}/${curve.combination}`;
    const trainingGroup = training.byCurve.get(key);
    const testGroup = test.byCurve.get(key);
    const deploymentGroup = deployment.byCurve.get(key);
    if (
      !trainingGroup ||
      !testGroup ||
      !deploymentGroup ||
      trainingGroup.count + testGroup.count !== deploymentGroup.count ||
      trainingGroup.fatalCount + testGroup.fatalCount !== deploymentGroup.fatalCount ||
      deploymentGroup.count !== curve.labelCount ||
      deploymentGroup.fatalCount !== curve.fatalCount
    ) {
      return false;
    }
  }
  for (const asset of MARKET_ASSETS) {
    const trainingGroup = training.byAsset.get(asset);
    const testGroup = test.byAsset.get(asset);
    const deploymentGroup = deployment.byAsset.get(asset);
    if (
      !trainingGroup ||
      !testGroup ||
      !deploymentGroup ||
      trainingGroup.count + testGroup.count !== deploymentGroup.count ||
      trainingGroup.fatalCount + testGroup.fatalCount !== deploymentGroup.fatalCount
    ) {
      return false;
    }
  }
  return true;
}

function validationArtifactTrainingMetricsAreConsistent(
  validationArtifact: MismatchCalibrationArtifactV1 | null,
  training: ActivationEvaluation,
) {
  if (!validationArtifact) {
    return false;
  }
  const validationFatalCount = validationArtifact.curves.reduce((sum, curve) => sum + curve.fatalCount, 0);
  if (
    validationArtifact.labelCount !== training.overall.count ||
    validationFatalCount !== training.overall.fatalCount ||
    validationArtifact.curves.length !== training.byCurve.size
  ) {
    return false;
  }
  for (const curve of validationArtifact.curves) {
    const trainingGroup = training.byCurve.get(`${curve.horizonBand}/${curve.combination}`);
    if (!trainingGroup || trainingGroup.count !== curve.labelCount || trainingGroup.fatalCount !== curve.fatalCount) {
      return false;
    }
  }
  return true;
}

function sumActivationMetricGroups(groups: Iterable<ActivationMetricGroup>) {
  let count = 0;
  let fatalCount = 0;
  for (const group of groups) {
    count += group.count;
    fatalCount += group.fatalCount;
  }
  return { count, fatalCount };
}

function scoreRegressed(raw: number, calibrated: number, maximumRatio: number) {
  return calibrated > Math.max(1e-12, raw) * maximumRatio + 1e-12;
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RangeError("canonical JSON cannot contain a non-finite number");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`)
      .join(",")}}`;
  }
  throw new RangeError("canonical JSON contains an unsupported value");
}

function unavailable(
  reason: MismatchCalibrationUnavailableReason,
): Extract<ApplyMismatchCalibrationResult, { available: false }> {
  return { available: false, reason };
}

function groupOrder(horizonBand: MismatchCalibrationHorizonBand, combination: MismatchCombination) {
  return (
    MISMATCH_CALIBRATION_HORIZON_BANDS.indexOf(horizonBand) * MISMATCH_COMBINATIONS.length +
    MISMATCH_COMBINATIONS.indexOf(combination)
  );
}

function isHorizonBand(value: unknown): value is MismatchCalibrationHorizonBand {
  return typeof value === "string" && (MISMATCH_CALIBRATION_HORIZON_BANDS as readonly string[]).includes(value);
}

function isCombination(value: unknown): value is MismatchCombination {
  return typeof value === "string" && (MISMATCH_COMBINATIONS as readonly string[]).includes(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isExactIsoTimestamp(value: unknown, timestamp: number) {
  if (typeof value !== "string") {
    return false;
  }
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) && value === date.toISOString();
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function assertPositiveInteger(value: number, field: string) {
  if (!isPositiveInteger(value)) {
    throw new RangeError(`${field} must be a positive integer`);
  }
}

function assertNonEmptyCanonicalString(value: string, field: string) {
  if (!isCanonicalString(value)) {
    throw new RangeError(`${field} must be a non-empty string without surrounding whitespace`);
  }
}

function isCanonicalString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function approximatelyEqual(left: number, right: number) {
  return Math.abs(left - right) <= NUMBER_TOLERANCE;
}
