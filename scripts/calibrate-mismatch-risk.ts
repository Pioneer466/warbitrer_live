#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import path from "node:path";

import { Pool } from "pg";

import {
  applyMismatchCalibration,
  buildMismatchCalibrationArtifact,
  DEFAULT_MISMATCH_CALIBRATION_MINIMUM_PRE_BIN_COUNT,
  evaluateMismatchCalibrationActivationEligibility,
  resolveMismatchCalibrationHorizonBand,
  type MismatchCalibrationArtifact,
  type MismatchCalibrationHorizonBand,
  type MismatchCalibrationLabel,
} from "@/lib/mismatch-calibration";
import type { MismatchCombination } from "@/lib/mismatch-risk";
import { MISMATCH_RISK_RUNTIME_MODEL_VERSION } from "@/lib/mismatch-risk-runtime";
import { ORACLE_SAMPLE_RETENTION_MS } from "@/lib/oracle-history";
import { insertMismatchCalibrationArtifact, type MismatchCalibrationArtifactRecord } from "@/lib/postgres-db";

export const CALIBRATION_HORIZONS_SECONDS = [600, 240, 150, 90, 45, 15] as const;
export const DEFAULT_CALIBRATION_TRAIN_FRACTION = 0.8;
export const DEFAULT_CALIBRATION_SAMPLE_TOLERANCE_SECONDS = 20;
export const CALIBRATION_QUERY_STATEMENT_TIMEOUT_MS = 300_000;

const COMBINATIONS = ["POLY_UP_KALSHI_NO", "POLY_DOWN_KALSHI_YES"] as const satisfies readonly MismatchCombination[];
const LOG_LOSS_EPSILON = 1e-15;

export type CalibrationCliOptions = {
  persist: boolean;
  help: boolean;
  fromMs: number;
  toMs: number;
  trainFraction: number;
  minimumPreBinCount: number;
  sampleToleranceSeconds: number;
  baseModelVersion: string;
};

export type CalibrationObservation = {
  sampleId: number;
  asset: string;
  slotKey: string;
  slotStartTs: number;
  slotEndTs: number;
  horizonSeconds: (typeof CALIBRATION_HORIZONS_SECONDS)[number];
  horizonBand: MismatchCalibrationHorizonBand;
  capturedAt: number;
  actualSecondsRemaining: number;
  sampleLagMs: number;
  modelVersion: string;
  executionUsable: true;
  combination: MismatchCombination;
  rawProbability: number;
  fatal: boolean;
};

type CalibrationQueryRow = {
  sample_id: unknown;
  asset: unknown;
  slot_key: unknown;
  slot_start_ts: unknown;
  slot_end_ts: unknown;
  horizon_seconds: unknown;
  captured_at: unknown;
  actual_remaining_ms: unknown;
  sample_lag_ms: unknown;
  model_version: unknown;
  execution_usable: unknown;
  combination: unknown;
  raw_probability: unknown;
  fatal: unknown;
};

type ProbabilityObservation = {
  prediction: number;
  fatal: boolean;
};

type CalibrationEvaluation = {
  count: number;
  fatalCount: number;
  fatalRate: number;
  raw: ReturnType<typeof calculateBinaryMetrics>;
  calibrated: ReturnType<typeof calculateBinaryMetrics>;
  conservativeUpper95: ReturnType<typeof calculateBinaryMetrics>;
  byCurve: Record<
    string,
    {
      count: number;
      fatalCount: number;
      raw: ReturnType<typeof calculateBinaryMetrics>;
      calibrated: ReturnType<typeof calculateBinaryMetrics>;
      conservativeUpper95: ReturnType<typeof calculateBinaryMetrics>;
    }
  >;
  byAsset: Record<
    string,
    {
      count: number;
      fatalCount: number;
      raw: ReturnType<typeof calculateBinaryMetrics>;
      calibrated: ReturnType<typeof calculateBinaryMetrics>;
      conservativeUpper95: ReturnType<typeof calculateBinaryMetrics>;
    }
  >;
};

export async function runMismatchCalibrationCli(argv: readonly string[], nowMs = Date.now()) {
  const options = parseCalibrationCliArgs(argv, nowMs);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required; load the protected runtime environment before calibration");
  }

  const pool = new Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  try {
    const rows = await queryCalibrationRowsReadOnly(pool, options);
    const observations = normalizeCalibrationRows(rows, options.baseModelVersion);
    if (observations.length === 0) {
      throw new Error("No valid dual-official mismatch observations matched the requested window and base model");
    }

    const split = chronologicalCalibrationSplit(observations, options.trainFraction);
    const validationArtifact = buildMismatchCalibrationArtifact({
      baseModelVersion: options.baseModelVersion,
      minimumPreBinCount: options.minimumPreBinCount,
      labels: split.training.map(toCalibrationLabel),
    });
    const artifact = buildMismatchCalibrationArtifact({
      baseModelVersion: options.baseModelVersion,
      minimumPreBinCount: options.minimumPreBinCount,
      labels: observations.map(toCalibrationLabel),
    });
    const evidenceMetadata = buildCalibrationEvidenceMetadata(options, observations, split);
    const metrics = {
      schemaVersion: 1,
      splitMethod: "chronological-slot-end-v1",
      trainFractionRequested: options.trainFraction,
      splitSlotEndTs: split.splitSlotEndTs,
      splitSlotEndIso: new Date(split.splitSlotEndTs).toISOString(),
      ...evidenceMetadata,
      validationArtifact,
      validationArtifactSha256: validationArtifact.payloadSha256,
      training: evaluateCalibration(split.training, validationArtifact),
      test: evaluateCalibration(split.test, validationArtifact),
      deploymentArtifactTraining: "full-window-after-holdout-evaluation",
      deploymentResubstitution: evaluateCalibration(observations, artifact),
    };

    const artifactRecord = buildCalibrationArtifactPersistenceRecord({ artifact, metrics, observations });
    const artifactId = artifactRecord.id;
    const activationEligibility = evaluateMismatchCalibrationActivationEligibility({
      artifact: artifactRecord.artifact,
      schemaVersion: artifactRecord.schemaVersion,
      baseModelVersion: artifactRecord.baseModelVersion,
      trainingStartedAt: artifactRecord.trainingStartedAt,
      trainingEndedAt: artifactRecord.trainingEndedAt,
      createdAt: artifactRecord.createdAt,
      metrics: artifactRecord.metrics,
      activationAt: nowMs,
    });
    let persistence:
      | { requested: false; persisted: false }
      | { requested: true; persisted: true; id: string; artifactSha256: string } = {
      requested: false,
      persisted: false,
    };

    if (options.persist) {
      const persisted = await insertMismatchCalibrationArtifact(pool, artifactRecord);
      persistence = {
        requested: true,
        persisted: true,
        id: persisted.id,
        artifactSha256: persisted.artifactSha256 ?? artifact.payloadSha256,
      };
    }

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      mode: options.persist ? "persist-artifact-only" : "read-only-dry-run",
      activation: "never-performed-by-this-command",
      query: evidenceMetadata.queryProvenance,
      observations: evidenceMetadata.observations,
      artifact: {
        id: artifactId,
        schemaVersion: artifact.schemaVersion,
        method: artifact.method,
        payloadSha256: artifact.payloadSha256,
        labelCount: artifact.labelCount,
        curveCount: artifact.curves.length,
        minimumPreBinCount: artifact.minimumPreBinCount,
      },
      activationEligibility,
      metrics,
      persistence,
    };

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

export function buildCalibrationArtifactPersistenceRecord(input: {
  artifact: MismatchCalibrationArtifact;
  metrics: Record<string, unknown>;
  observations: readonly Pick<CalibrationObservation, "capturedAt">[];
}): MismatchCalibrationArtifactRecord {
  if (input.observations.length === 0) {
    throw new RangeError("observations must not be empty");
  }
  const capturedAtRange = summarizeSafeIntegerRange(
    input.observations,
    (observation) => observation.capturedAt,
    "observation capturedAt values",
  );
  const trainingStartedAt = capturedAtRange.minimum;
  const trainingEndedAt = capturedAtRange.maximum;
  return {
    id: `mismatch-calibration:${input.artifact.payloadSha256}`,
    schemaVersion: input.artifact.schemaVersion,
    baseModelVersion: input.artifact.baseModelVersion,
    trainingStartedAt,
    trainingEndedAt,
    artifact: input.artifact as unknown as Record<string, unknown>,
    metrics: input.metrics,
    createdAt: trainingEndedAt,
  };
}

export function parseCalibrationCliArgs(argv: readonly string[], nowMs = Date.now()): CalibrationCliOptions {
  const values = new Map<string, string>();
  let persist = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--persist") {
      persist = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${argument}`);
    }

    const equalsIndex = argument.indexOf("=");
    const key = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? null : argument.slice(equalsIndex + 1);
    if (!VALUE_FLAGS.has(key)) {
      throw new Error(`Unknown option: ${key}`);
    }
    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${key} requires a value`);
    }
    if (values.has(key)) {
      throw new Error(`${key} may only be provided once`);
    }
    values.set(key, value);
    if (inlineValue === null) {
      index += 1;
    }
  }

  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new RangeError("nowMs must be a positive safe integer");
  }

  const fromMs = values.has("--from")
    ? parseTimestamp(values.get("--from")!, "--from")
    : nowMs - ORACLE_SAMPLE_RETENTION_MS;
  const toMs = values.has("--to") ? parseTimestamp(values.get("--to")!, "--to") : nowMs;
  if (fromMs >= toMs) {
    throw new RangeError("--from must be earlier than --to");
  }

  const trainFraction = values.has("--train-fraction")
    ? parseFiniteNumber(values.get("--train-fraction")!, "--train-fraction")
    : DEFAULT_CALIBRATION_TRAIN_FRACTION;
  if (trainFraction <= 0 || trainFraction >= 1) {
    throw new RangeError("--train-fraction must be greater than zero and less than one");
  }

  const minimumPreBinCount = values.has("--minimum-pre-bin-count")
    ? parsePositiveInteger(values.get("--minimum-pre-bin-count")!, "--minimum-pre-bin-count")
    : DEFAULT_MISMATCH_CALIBRATION_MINIMUM_PRE_BIN_COUNT;
  const sampleToleranceSeconds = values.has("--sample-tolerance-seconds")
    ? parsePositiveInteger(values.get("--sample-tolerance-seconds")!, "--sample-tolerance-seconds")
    : DEFAULT_CALIBRATION_SAMPLE_TOLERANCE_SECONDS;
  if (sampleToleranceSeconds > 60) {
    throw new RangeError("--sample-tolerance-seconds cannot exceed 60");
  }

  const baseModelVersion = values.get("--base-model-version") ?? MISMATCH_RISK_RUNTIME_MODEL_VERSION;
  if (baseModelVersion.trim() !== baseModelVersion || baseModelVersion.length === 0) {
    throw new RangeError("--base-model-version must be a non-empty canonical string");
  }

  return {
    persist,
    help,
    fromMs,
    toMs,
    trainFraction,
    minimumPreBinCount,
    sampleToleranceSeconds,
    baseModelVersion,
  };
}

export function normalizeCalibrationRows(
  rows: readonly CalibrationQueryRow[],
  expectedBaseModelVersion: string,
): CalibrationObservation[] {
  const normalized = rows.map((row, index) => {
    const sampleId = asSafeInteger(row.sample_id, `rows[${index}].sample_id`);
    const slotStartTs = asSafeInteger(row.slot_start_ts, `rows[${index}].slot_start_ts`);
    const slotEndTs = asSafeInteger(row.slot_end_ts, `rows[${index}].slot_end_ts`);
    const capturedAt = asSafeInteger(row.captured_at, `rows[${index}].captured_at`);
    if (slotEndTs <= slotStartTs || capturedAt < slotStartTs || capturedAt >= slotEndTs) {
      throw new Error(`rows[${index}] must be captured inside a positive slot`);
    }
    const horizonSeconds = asSafeInteger(row.horizon_seconds, `rows[${index}].horizon_seconds`);
    if (!isCalibrationHorizon(horizonSeconds)) {
      throw new Error(`rows[${index}].horizon_seconds is unsupported`);
    }
    const requestedHorizonBand = resolveMismatchCalibrationHorizonBand(horizonSeconds);
    if (!requestedHorizonBand) {
      throw new Error(`rows[${index}].horizon_seconds has no calibration band`);
    }
    const actualRemainingMs = slotEndTs - capturedAt;
    const reportedRemainingMs = asSafeInteger(row.actual_remaining_ms, `rows[${index}].actual_remaining_ms`);
    if (reportedRemainingMs !== actualRemainingMs) {
      throw new Error(`rows[${index}].actual_remaining_ms contradicts slot_end_ts - captured_at`);
    }
    const actualSecondsRemaining = actualRemainingMs / 1_000;
    const horizonBand = resolveMismatchCalibrationHorizonBand(actualSecondsRemaining);
    if (!horizonBand || horizonBand !== requestedHorizonBand) {
      throw new Error(
        `rows[${index}] crosses calibration horizon band (${horizonSeconds}s target, ${actualSecondsRemaining}s actual)`,
      );
    }
    const sampleLagMs = asSafeInteger(row.sample_lag_ms, `rows[${index}].sample_lag_ms`);
    if (sampleLagMs !== Math.abs(actualRemainingMs - horizonSeconds * 1_000)) {
      throw new Error(`rows[${index}].sample_lag_ms contradicts the selected horizon`);
    }
    const combination = asCombination(row.combination, `rows[${index}].combination`);
    const rawProbability = asFiniteNumber(row.raw_probability, `rows[${index}].raw_probability`);
    if (rawProbability < 0 || rawProbability > 1) {
      throw new Error(`rows[${index}].raw_probability must be between zero and one`);
    }
    const modelVersion = asString(row.model_version, `rows[${index}].model_version`);
    if (modelVersion !== expectedBaseModelVersion) {
      throw new Error(`rows[${index}].model_version does not match the requested base model`);
    }
    if (row.execution_usable !== true) {
      throw new Error(`rows[${index}].execution_usable must be true`);
    }
    if (typeof row.fatal !== "boolean") {
      throw new Error(`rows[${index}].fatal must be boolean`);
    }

    return {
      sampleId,
      asset: asString(row.asset, `rows[${index}].asset`),
      slotKey: asString(row.slot_key, `rows[${index}].slot_key`),
      slotStartTs,
      slotEndTs,
      horizonSeconds,
      horizonBand,
      capturedAt,
      actualSecondsRemaining,
      sampleLagMs,
      modelVersion,
      executionUsable: true as const,
      combination,
      rawProbability,
      fatal: row.fatal,
    };
  });

  const sampleHorizons = new Map<string, number>();
  for (const observation of normalized) {
    const sampleKey = JSON.stringify([
      observation.asset,
      observation.slotKey,
      observation.combination,
      observation.sampleId,
    ]);
    const previousHorizon = sampleHorizons.get(sampleKey);
    if (previousHorizon !== undefined && previousHorizon !== observation.horizonSeconds) {
      throw new Error(
        `oracle sample ${observation.sampleId} is reused across calibration horizons ${previousHorizon}s and ${observation.horizonSeconds}s`,
      );
    }
    sampleHorizons.set(sampleKey, observation.horizonSeconds);
  }
  return normalized;
}

export function buildCalibrationEvidenceMetadata(
  options: CalibrationCliOptions,
  observations: readonly CalibrationObservation[],
  split: ReturnType<typeof chronologicalCalibrationSplit>,
) {
  return {
    queryProvenance: {
      fromTs: options.fromMs,
      fromIso: new Date(options.fromMs).toISOString(),
      toTs: options.toMs,
      toIso: new Date(options.toMs).toISOString(),
      horizonsSeconds: CALIBRATION_HORIZONS_SECONDS,
      sampleToleranceSeconds: options.sampleToleranceSeconds,
      baseModelVersion: options.baseModelVersion,
      resolutionRequirement: "dual-finalized official-venue-resolution",
      executionUsableRequired: true,
      actualHorizonBandRequired: true,
      uniqueSamplePerCombinationAcrossHorizons: true,
      sampleSelection: "nearest-lag-captured-at-desc-id-desc-v1",
    },
    observations: summarizeCalibrationObservations(observations, split),
  };
}

export function chronologicalCalibrationSplit(observations: readonly CalibrationObservation[], trainFraction: number) {
  if (observations.length === 0) {
    throw new RangeError("observations must not be empty");
  }
  if (!Number.isFinite(trainFraction) || trainFraction <= 0 || trainFraction >= 1) {
    throw new RangeError("trainFraction must be greater than zero and less than one");
  }

  const slotEnds = [...new Set(observations.map((observation) => observation.slotEndTs))].sort((a, b) => a - b);
  if (slotEnds.length < 2) {
    throw new RangeError("at least two distinct slot end timestamps are required for a chronological split");
  }
  const trainingSlotCount = Math.max(1, Math.min(slotEnds.length - 1, Math.floor(slotEnds.length * trainFraction)));
  const splitSlotEndTs = slotEnds[trainingSlotCount - 1];
  const training = observations.filter((observation) => observation.slotEndTs <= splitSlotEndTs);
  const test = observations.filter((observation) => observation.slotEndTs > splitSlotEndTs);
  if (training.length === 0 || test.length === 0) {
    throw new Error("chronological split produced an empty training or test set");
  }
  return { training, test, splitSlotEndTs, trainingSlotCount, testSlotCount: slotEnds.length - trainingSlotCount };
}

export function evaluateCalibration(
  observations: readonly CalibrationObservation[],
  artifact: MismatchCalibrationArtifact,
): CalibrationEvaluation {
  if (observations.length === 0) {
    throw new RangeError("evaluation observations must not be empty");
  }

  const evaluated = observations.map((observation) => {
    const calibrated = applyMismatchCalibration({
      artifact,
      baseModelVersion: observation.modelVersion,
      horizonBand: observation.horizonBand,
      combination: observation.combination,
      rawProbability: observation.rawProbability,
    });
    if (!calibrated.available) {
      throw new Error(
        `calibration unavailable for ${observation.horizonBand}/${observation.combination}: ${calibrated.reason}`,
      );
    }
    return {
      ...observation,
      calibratedProbability: calibrated.calibratedProbability,
      pFatalUpper95: calibrated.pFatalUpper95,
    };
  });

  const curveGroups = new Map<string, Array<(typeof evaluated)[number]>>();
  const assetGroups = new Map<string, Array<(typeof evaluated)[number]>>();
  for (const observation of evaluated) {
    appendGroup(curveGroups, `${observation.horizonBand}/${observation.combination}`, observation);
    appendGroup(assetGroups, observation.asset, observation);
  }
  const byCurve = Object.fromEntries(
    [...curveGroups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, group]) => [key, summarizeEvaluatedGroup(group)]),
  );
  const byAsset = Object.fromEntries(
    [...assetGroups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([asset, group]) => [asset, summarizeEvaluatedGroup(group)]),
  );

  const fatalCount = evaluated.filter((observation) => observation.fatal).length;
  return {
    count: evaluated.length,
    fatalCount,
    fatalRate: fatalCount / evaluated.length,
    raw: calculateBinaryMetrics(
      evaluated.map((observation) => ({ prediction: observation.rawProbability, fatal: observation.fatal })),
    ),
    calibrated: calculateBinaryMetrics(
      evaluated.map((observation) => ({ prediction: observation.calibratedProbability, fatal: observation.fatal })),
    ),
    conservativeUpper95: calculateBinaryMetrics(
      evaluated.map((observation) => ({ prediction: observation.pFatalUpper95, fatal: observation.fatal })),
    ),
    byCurve,
    byAsset,
  };
}

function summarizeEvaluatedGroup(
  group: ReadonlyArray<
    CalibrationObservation & {
      calibratedProbability: number;
      pFatalUpper95: number;
    }
  >,
) {
  return {
    count: group.length,
    fatalCount: group.filter((observation) => observation.fatal).length,
    raw: calculateBinaryMetrics(
      group.map((observation) => ({ prediction: observation.rawProbability, fatal: observation.fatal })),
    ),
    calibrated: calculateBinaryMetrics(
      group.map((observation) => ({ prediction: observation.calibratedProbability, fatal: observation.fatal })),
    ),
    conservativeUpper95: calculateBinaryMetrics(
      group.map((observation) => ({ prediction: observation.pFatalUpper95, fatal: observation.fatal })),
    ),
  };
}

export function calculateBinaryMetrics(observations: readonly ProbabilityObservation[]) {
  if (observations.length === 0) {
    throw new RangeError("binary metric observations must not be empty");
  }
  const normalized = observations.map((observation, index) => {
    if (!Number.isFinite(observation.prediction) || observation.prediction < 0 || observation.prediction > 1) {
      throw new RangeError(`observations[${index}].prediction must be between zero and one`);
    }
    if (typeof observation.fatal !== "boolean") {
      throw new RangeError(`observations[${index}].fatal must be boolean`);
    }
    return observation;
  });
  const fatalCount = normalized.filter((observation) => observation.fatal).length;
  const meanPrediction = mean(normalized.map((observation) => observation.prediction));
  const brierScore = mean(normalized.map((observation) => (observation.prediction - Number(observation.fatal)) ** 2));
  const logLoss = -mean(
    normalized.map((observation) => {
      const prediction = Math.min(1 - LOG_LOSS_EPSILON, Math.max(LOG_LOSS_EPSILON, observation.prediction));
      return observation.fatal ? Math.log(prediction) : Math.log(1 - prediction);
    }),
  );

  return {
    count: normalized.length,
    fatalCount,
    fatalRate: fatalCount / normalized.length,
    meanPrediction,
    brierScore,
    logLoss,
    auc: calculateAuc(normalized),
  };
}

async function queryCalibrationRowsReadOnly(pool: Pool, options: CalibrationCliOptions) {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      String(CALIBRATION_QUERY_STATEMENT_TIMEOUT_MS),
    ]);
    const result = await client.query<CalibrationQueryRow>(
      `
        WITH requested_horizons(horizon_seconds) AS (
          SELECT unnest($3::integer[])
        ), requested_combinations(combination) AS (
          VALUES ('POLY_UP_KALSHI_NO'::text), ('POLY_DOWN_KALSHI_YES'::text)
        )
        SELECT
          sample.id AS sample_id,
          resolution.asset,
          resolution.slot_key,
          resolution.slot_start_ts,
          resolution.slot_end_ts,
          horizon.horizon_seconds,
          sample.captured_at,
          resolution.slot_end_ts - sample.captured_at AS actual_remaining_ms,
          abs(
            (resolution.slot_end_ts - sample.captured_at) -
            horizon.horizon_seconds::bigint * 1000
          ) AS sample_lag_ms,
          sample.model_version,
          sample.execution_usable,
          combination.combination,
          COALESCE(
            sample.risk_json -> combination.combination -> 'model' ->> 'rawPFatal',
            sample.risk_json -> combination.combination -> 'model' ->> 'pFatal'
          )::double precision AS raw_probability,
          CASE combination.combination
            WHEN 'POLY_UP_KALSHI_NO' THEN
              resolution.polymarket_resolution = 'DOWN' AND resolution.kalshi_resolution = 'YES'
            WHEN 'POLY_DOWN_KALSHI_YES' THEN
              resolution.polymarket_resolution = 'UP' AND resolution.kalshi_resolution = 'NO'
          END AS fatal
        FROM slot_resolutions AS resolution
        CROSS JOIN requested_horizons AS horizon
        CROSS JOIN requested_combinations AS combination
        CROSS JOIN LATERAL (
          SELECT
            oracle.id,
            oracle.captured_at,
            oracle.model_version,
            oracle.risk_json,
            oracle.risk_json -> combination.combination -> 'model' -> 'executionUsable' = 'true'::jsonb
              AS execution_usable
          FROM oracle_slot_samples AS oracle
          WHERE oracle.asset = resolution.asset
            AND oracle.slot_key = resolution.slot_key
            AND oracle.captured_at >= resolution.slot_start_ts
            AND oracle.captured_at < resolution.slot_end_ts
            AND oracle.model_version = $5
            AND COALESCE(
              jsonb_typeof(oracle.risk_json -> combination.combination -> 'model' -> 'rawPFatal'),
              jsonb_typeof(oracle.risk_json -> combination.combination -> 'model' -> 'pFatal')
            ) = 'number'
            AND oracle.risk_json -> combination.combination -> 'model' -> 'executionUsable' = 'true'::jsonb
            AND abs(
              (resolution.slot_end_ts - oracle.captured_at) -
              horizon.horizon_seconds::bigint * 1000
            ) <= $4::bigint
            AND CASE horizon.horizon_seconds
              WHEN 600 THEN resolution.slot_end_ts - oracle.captured_at > 300000
              WHEN 240 THEN resolution.slot_end_ts - oracle.captured_at > 180000
                AND resolution.slot_end_ts - oracle.captured_at <= 300000
              WHEN 150 THEN resolution.slot_end_ts - oracle.captured_at > 120000
                AND resolution.slot_end_ts - oracle.captured_at <= 180000
              WHEN 90 THEN resolution.slot_end_ts - oracle.captured_at > 60000
                AND resolution.slot_end_ts - oracle.captured_at <= 120000
              WHEN 45 THEN resolution.slot_end_ts - oracle.captured_at > 30000
                AND resolution.slot_end_ts - oracle.captured_at <= 60000
              WHEN 15 THEN resolution.slot_end_ts - oracle.captured_at >= 5000
                AND resolution.slot_end_ts - oracle.captured_at <= 30000
              ELSE false
            END
          ORDER BY
            abs(
              (resolution.slot_end_ts - oracle.captured_at) -
              horizon.horizon_seconds::bigint * 1000
            ) ASC,
            oracle.captured_at DESC,
            oracle.id DESC
          LIMIT 1
        ) AS sample
        WHERE resolution.slot_end_ts > $1
          AND resolution.slot_end_ts <= $2
          AND resolution.source = 'official-venue-resolution'
          AND resolution.resolved_at IS NOT NULL
          AND resolution.polymarket_resolution IN ('UP', 'DOWN')
          AND resolution.kalshi_resolution IN ('YES', 'NO')
        ORDER BY
          resolution.slot_end_ts ASC,
          resolution.asset ASC,
          horizon.horizon_seconds DESC,
          combination.combination ASC
      `,
      [
        options.fromMs,
        options.toMs,
        [...CALIBRATION_HORIZONS_SECONDS],
        options.sampleToleranceSeconds * 1000,
        options.baseModelVersion,
      ],
    );
    await client.query("COMMIT");
    transactionOpen = false;
    return result.rows;
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}

function toCalibrationLabel(observation: CalibrationObservation): MismatchCalibrationLabel {
  return {
    rawProbability: observation.rawProbability,
    fatal: observation.fatal,
    horizonBand: observation.horizonBand,
    combination: observation.combination,
  };
}

export function summarizeCalibrationObservations(
  observations: readonly CalibrationObservation[],
  split: ReturnType<typeof chronologicalCalibrationSplit>,
) {
  const uniqueAssets = [...new Set(observations.map((observation) => observation.asset))].sort();
  const uniqueSlots = new Set(observations.map((observation) => `${observation.asset}:${observation.slotKey}`));
  const uniqueSlotEnds = new Set(observations.map((observation) => observation.slotEndTs));
  const uniqueOracleSamples = new Set(observations.map((observation) => observation.sampleId));
  const capturedAtRange = summarizeSafeIntegerRange(
    observations,
    (observation) => observation.capturedAt,
    "capturedAt",
  );
  const slotEndRange = summarizeSafeIntegerRange(observations, (observation) => observation.slotEndTs, "slotEndTs");
  const trainingSlotEndRange = summarizeSafeIntegerRange(
    split.training,
    (observation) => observation.slotEndTs,
    "training slotEndTs",
  );
  const testSlotEndRange = summarizeSafeIntegerRange(
    split.test,
    (observation) => observation.slotEndTs,
    "test slotEndTs",
  );
  const sampleLagRange = summarizeSafeIntegerRange(
    observations,
    (observation) => observation.sampleLagMs,
    "sampleLagMs",
  );
  return {
    labelCount: observations.length,
    uniqueOracleSampleCount: uniqueOracleSamples.size,
    assetSlotCount: uniqueSlots.size,
    chronologicalSlotCount: uniqueSlotEnds.size,
    assets: uniqueAssets,
    firstCapturedAt: capturedAtRange.minimum,
    lastCapturedAt: capturedAtRange.maximum,
    firstSlotEndTs: slotEndRange.minimum,
    lastSlotEndTs: slotEndRange.maximum,
    trainingLastSlotEndTs: trainingSlotEndRange.maximum,
    testFirstSlotEndTs: testSlotEndRange.minimum,
    maximumSampleLagMs: sampleLagRange.maximum,
    trainingLabelCount: split.training.length,
    testLabelCount: split.test.length,
    trainingChronologicalSlotCount: split.trainingSlotCount,
    testChronologicalSlotCount: split.testSlotCount,
  };
}

function appendGroup<T>(groups: Map<string, T[]>, key: string, value: T) {
  const group = groups.get(key);
  if (group) {
    group.push(value);
  } else {
    groups.set(key, [value]);
  }
}

function summarizeSafeIntegerRange<T>(values: readonly T[], select: (value: T) => number, field: string) {
  if (values.length === 0) {
    throw new RangeError(`${field} must not be empty`);
  }
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const selected = select(value);
    if (!Number.isSafeInteger(selected) || selected < 0) {
      throw new RangeError(`${field} must be non-negative safe integers`);
    }
    minimum = Math.min(minimum, selected);
    maximum = Math.max(maximum, selected);
  }
  return { minimum, maximum };
}

function calculateAuc(observations: readonly ProbabilityObservation[]): number | null {
  const positives = observations.filter((observation) => observation.fatal).length;
  const negatives = observations.length - positives;
  if (positives === 0 || negatives === 0) {
    return null;
  }

  const sorted = [...observations].sort((left, right) => left.prediction - right.prediction);
  let positiveRankSum = 0;
  let index = 0;
  while (index < sorted.length) {
    let end = index + 1;
    while (end < sorted.length && sorted[end].prediction === sorted[index].prediction) {
      end += 1;
    }
    const averageRank = (index + 1 + end) / 2;
    for (let tiedIndex = index; tiedIndex < end; tiedIndex += 1) {
      if (sorted[tiedIndex].fatal) {
        positiveRankSum += averageRank;
      }
    }
    index = end;
  }
  return (positiveRankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

function mean(values: readonly number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function parseTimestamp(value: string, flag: string) {
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric) && value.trim() !== "" ? numeric : Date.parse(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new RangeError(`${flag} must be an ISO-8601 timestamp or non-negative epoch milliseconds`);
  }
  return timestamp;
}

function parseFiniteNumber(value: string, flag: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new RangeError(`${flag} must be a finite number`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, flag: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${flag} must be a positive integer`);
  }
  return parsed;
}

function asSafeInteger(value: unknown, field: string) {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return parsed;
}

function asFiniteNumber(value: unknown, field: string) {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be finite`);
  }
  return parsed;
}

function asString(value: unknown, field: string) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty canonical string`);
  }
  return value;
}

function asCombination(value: unknown, field: string): MismatchCombination {
  if (typeof value !== "string" || !(COMBINATIONS as readonly string[]).includes(value)) {
    throw new Error(`${field} is unsupported`);
  }
  return value as MismatchCombination;
}

function isCalibrationHorizon(value: number): value is CalibrationObservation["horizonSeconds"] {
  return (CALIBRATION_HORIZONS_SECONDS as readonly number[]).includes(value);
}

function usage() {
  return `Usage: node --import tsx scripts/calibrate-mismatch-risk.ts [options]\n\nDefault behavior is read-only. It selects dual-finalized official outcomes, builds a chronological holdout calibration artifact, and prints JSON metrics. It never activates an artifact.\n\nOptions:\n  --from <ISO|epoch-ms>                 Window lower bound (default: retained 45-day window)\n  --to <ISO|epoch-ms>                   Window upper bound (default: now)\n  --train-fraction <0..1>               Chronological training fraction (default: 0.8)\n  --minimum-pre-bin-count <integer>     Minimum PAVA pre-bin size (default: 100)\n  --sample-tolerance-seconds <integer>  Maximum horizon sampling lag (default: 20, max: 60)\n  --base-model-version <version>        Exact raw model version to select\n  --persist                             Persist the immutable artifact; does not activate it\n  --help                                Show this help\n`;
}

const VALUE_FLAGS = new Set([
  "--from",
  "--to",
  "--train-fraction",
  "--minimum-pre-bin-count",
  "--sample-tolerance-seconds",
  "--base-model-version",
]);

function isDirectExecution() {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && path.resolve(entrypoint) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  runMismatchCalibrationCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
