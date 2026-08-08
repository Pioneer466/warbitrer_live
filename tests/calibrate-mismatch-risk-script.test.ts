import { readFileSync } from "node:fs";

import {
  buildCalibrationArtifactPersistenceRecord,
  buildCalibrationEvidenceMetadata,
  CALIBRATION_QUERY_STATEMENT_TIMEOUT_MS,
  calculateBinaryMetrics,
  chronologicalCalibrationSplit,
  normalizeCalibrationRows,
  parseCalibrationCliArgs,
  summarizeCalibrationObservations,
  type CalibrationObservation,
} from "../scripts/calibrate-mismatch-risk";
import { buildMismatchCalibrationArtifact } from "@/lib/mismatch-calibration";

const BASE_MODEL = "structural-ewma-gaussian-v1-uncalibrated";

describe("mismatch calibration CLI policy", () => {
  it("keeps the production query bounded while allowing the retained dataset to complete", () => {
    expect(CALIBRATION_QUERY_STATEMENT_TIMEOUT_MS).toBe(300_000);
  });

  it("remains read-only unless --persist is explicit", () => {
    const dryRun = parseCalibrationCliArgs([], 2_000_000_000_000);
    const persisted = parseCalibrationCliArgs(
      ["--persist", "--from", "2026-07-01T00:00:00Z", "--to=2026-07-31T00:00:00Z", "--sample-tolerance-seconds", "15"],
      2_000_000_000_000,
    );

    expect(dryRun.persist).toBe(false);
    expect(persisted).toMatchObject({
      persist: true,
      fromMs: Date.parse("2026-07-01T00:00:00Z"),
      toMs: Date.parse("2026-07-31T00:00:00Z"),
      sampleToleranceSeconds: 15,
    });
    expect(() => parseCalibrationCliArgs(["--persist=true"], 2_000_000_000_000)).toThrow("Unknown option");
  });

  it("normalizes bigint query fields and rejects cross-model contamination", () => {
    const rows = [
      {
        sample_id: "123",
        asset: "btc",
        slot_key: "btc:1000",
        slot_start_ts: "1000",
        slot_end_ts: "901000",
        horizon_seconds: 45,
        captured_at: "856100",
        actual_remaining_ms: "44900",
        sample_lag_ms: "100",
        model_version: BASE_MODEL,
        execution_usable: true,
        combination: "POLY_UP_KALSHI_NO",
        raw_probability: 0.12,
        fatal: true,
      },
    ];

    expect(normalizeCalibrationRows(rows, BASE_MODEL)).toEqual([
      {
        sampleId: 123,
        asset: "btc",
        slotKey: "btc:1000",
        slotStartTs: 1000,
        slotEndTs: 901000,
        horizonSeconds: 45,
        horizonBand: "seconds_over_30_to_60",
        capturedAt: 856100,
        actualSecondsRemaining: 44.9,
        sampleLagMs: 100,
        modelVersion: BASE_MODEL,
        executionUsable: true,
        combination: "POLY_UP_KALSHI_NO",
        rawProbability: 0.12,
        fatal: true,
      },
    ]);
    expect(() => normalizeCalibrationRows(rows, "another-model")).toThrow("does not match");
  });

  it("rejects non-executable samples, horizon-band crossings, and cross-horizon sample reuse", () => {
    const row = calibrationRow();

    expect(() => normalizeCalibrationRows([{ ...row, execution_usable: false }], BASE_MODEL)).toThrow(
      "execution_usable must be true",
    );
    expect(() =>
      normalizeCalibrationRows(
        [
          {
            ...row,
            captured_at: 876000,
            actual_remaining_ms: 25000,
            sample_lag_ms: 20000,
          },
        ],
        BASE_MODEL,
      ),
    ).toThrow("crosses calibration horizon band");
    expect(() =>
      normalizeCalibrationRows(
        [
          row,
          {
            ...row,
            horizon_seconds: 15,
            captured_at: 886000,
            actual_remaining_ms: 15000,
            sample_lag_ms: 0,
          },
        ],
        BASE_MODEL,
      ),
    ).toThrow("is reused across calibration horizons 45s and 15s");
  });

  it("pins executable, band-safe, deterministic SQL sample selection", () => {
    const source = readFileSync(new URL("../scripts/calibrate-mismatch-risk.ts", import.meta.url), "utf8");

    expect(source).toContain("-> 'executionUsable' = 'true'::jsonb");
    expect(source).toContain("WHEN 15 THEN resolution.slot_end_ts - oracle.captured_at >= 5000");
    expect(source).toContain("oracle.captured_at DESC,\n            oracle.id DESC");
  });

  it("splits by slot time so all assets and curves from one slot stay together", () => {
    const observations = [
      observation("btc", 100, "POLY_UP_KALSHI_NO"),
      observation("eth", 100, "POLY_DOWN_KALSHI_YES"),
      observation("btc", 200, "POLY_UP_KALSHI_NO"),
      observation("eth", 200, "POLY_DOWN_KALSHI_YES"),
      observation("btc", 300, "POLY_UP_KALSHI_NO"),
      observation("eth", 300, "POLY_DOWN_KALSHI_YES"),
    ];

    const split = chronologicalCalibrationSplit(observations, 2 / 3);

    expect(split.splitSlotEndTs).toBe(200);
    expect(new Set(split.training.map((row) => row.slotEndTs))).toEqual(new Set([100, 200]));
    expect(new Set(split.test.map((row) => row.slotEndTs))).toEqual(new Set([300]));
  });

  it("reports deterministic discrimination and probability scores", () => {
    const metrics = calculateBinaryMetrics([
      { prediction: 0.1, fatal: false },
      { prediction: 0.2, fatal: false },
      { prediction: 0.8, fatal: true },
      { prediction: 0.9, fatal: true },
    ]);

    expect(metrics.auc).toBe(1);
    expect(metrics.meanPrediction).toBeCloseTo(0.5, 12);
    expect(metrics.brierScore).toBeCloseTo(0.025, 12);
    expect(metrics.fatalRate).toBe(0.5);
  });

  it("embeds query provenance and observation summary in persisted metrics metadata", () => {
    const observations = [
      observation("btc", 100, "POLY_UP_KALSHI_NO"),
      observation("eth", 100, "POLY_DOWN_KALSHI_YES"),
      observation("btc", 200, "POLY_UP_KALSHI_NO"),
      observation("eth", 200, "POLY_DOWN_KALSHI_YES"),
    ];
    const options = parseCalibrationCliArgs(
      ["--from", "0", "--to", "1000", "--sample-tolerance-seconds", "12"],
      2_000_000_000_000,
    );
    const split = chronologicalCalibrationSplit(observations, 0.5);

    expect(buildCalibrationEvidenceMetadata(options, observations, split)).toMatchObject({
      queryProvenance: {
        fromTs: 0,
        toTs: 1000,
        sampleToleranceSeconds: 12,
        baseModelVersion: BASE_MODEL,
        executionUsableRequired: true,
        actualHorizonBandRequired: true,
        uniqueSamplePerCombinationAcrossHorizons: true,
        sampleSelection: "nearest-lag-captured-at-desc-id-desc-v1",
      },
      observations: {
        labelCount: 4,
        uniqueOracleSampleCount: 4,
        assetSlotCount: 4,
        chronologicalSlotCount: 2,
        trainingLabelCount: 2,
        testLabelCount: 2,
      },
    });
  });

  it("builds an immutable persistence record deterministically across identical reruns", () => {
    const artifact = buildMismatchCalibrationArtifact({
      baseModelVersion: BASE_MODEL,
      minimumPreBinCount: 1,
      labels: [
        {
          rawProbability: 0.1,
          fatal: false,
          horizonBand: "seconds_over_30_to_60",
          combination: "POLY_UP_KALSHI_NO",
        },
      ],
    });
    const observations = [observation("btc", 100, "POLY_UP_KALSHI_NO"), observation("btc", 200, "POLY_UP_KALSHI_NO")];
    const metrics = { schemaVersion: 1, proof: "same-input" };

    const first = buildCalibrationArtifactPersistenceRecord({ artifact, metrics, observations });
    const replay = buildCalibrationArtifactPersistenceRecord({
      artifact,
      metrics: structuredClone(metrics),
      observations: structuredClone(observations),
    });

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      id: `mismatch-calibration:${artifact.payloadSha256}`,
      trainingStartedAt: 55,
      trainingEndedAt: 155,
      createdAt: 155,
    });
  });

  it("summarizes production-scale observation arrays without spreading them onto the call stack", () => {
    const artifact = buildMismatchCalibrationArtifact({
      baseModelVersion: BASE_MODEL,
      minimumPreBinCount: 1,
      labels: [
        {
          rawProbability: 0.1,
          fatal: false,
          horizonBand: "seconds_over_30_to_60",
          combination: "POLY_UP_KALSHI_NO",
        },
      ],
    });
    const observations = Array.from({ length: 150_000 }, (_, index) => ({
      ...observation("btc", index < 120_000 ? 100 : 200, "POLY_UP_KALSHI_NO"),
      sampleId: index + 1,
    }));
    const split = chronologicalCalibrationSplit(observations, 0.8);

    expect(summarizeCalibrationObservations(observations, split)).toMatchObject({
      labelCount: 150_000,
      firstCapturedAt: 55,
      lastCapturedAt: 155,
      trainingLabelCount: 120_000,
      testLabelCount: 30_000,
    });
    expect(buildCalibrationArtifactPersistenceRecord({ artifact, metrics: {}, observations })).toMatchObject({
      trainingStartedAt: 55,
      trainingEndedAt: 155,
    });
  });
});

function calibrationRow() {
  return {
    sample_id: 123,
    asset: "btc",
    slot_key: "btc:1000",
    slot_start_ts: 1000,
    slot_end_ts: 901000,
    horizon_seconds: 45,
    captured_at: 856000,
    actual_remaining_ms: 45000,
    sample_lag_ms: 0,
    model_version: BASE_MODEL,
    execution_usable: true,
    combination: "POLY_UP_KALSHI_NO",
    raw_probability: 0.12,
    fatal: true,
  };
}

function observation(
  asset: string,
  slotEndTs: number,
  combination: CalibrationObservation["combination"],
): CalibrationObservation {
  return {
    sampleId: slotEndTs * 10 + (asset === "btc" ? 1 : 2) + (combination === "POLY_UP_KALSHI_NO" ? 0 : 4),
    asset,
    slotKey: `${asset}:${slotEndTs}`,
    slotStartTs: slotEndTs - 90,
    slotEndTs,
    horizonSeconds: 45,
    horizonBand: "seconds_over_30_to_60",
    capturedAt: slotEndTs - 45,
    actualSecondsRemaining: 45,
    sampleLagMs: 0,
    modelVersion: BASE_MODEL,
    executionUsable: true,
    combination,
    rawProbability: 0.1,
    fatal: false,
  };
}
