import { getActiveMismatchCalibration } from "@/lib/postgres-db";
import { buildEligibleMismatchCalibrationFixture } from "./mismatch-calibration-fixtures";

describe("mismatch calibration runtime reads", () => {
  it("accepts the initial inactive revision-zero state", async () => {
    const pool = poolReturning({
      active_artifact_id: null,
      activation_revision: 0,
      activation_updated_at: 1_800_000_000_000,
    });

    await expect(getActiveMismatchCalibration(pool)).resolves.toEqual({
      artifact: null,
      revision: 0,
      updatedAt: 1_800_000_000_000,
    });
  });

  it("revalidates an active artifact and rejects corrupted eligibility evidence", async () => {
    const fixture = buildEligibleMismatchCalibrationFixture();
    const validRow = artifactRow(fixture);

    await expect(getActiveMismatchCalibration(poolReturning(validRow))).resolves.toMatchObject({
      artifact: { id: "runtime-read-fixture", artifactSha256: fixture.artifact.payloadSha256 },
      revision: 1,
      updatedAt: fixture.activationAt,
    });

    const corruptedMetrics = structuredClone(fixture.metrics) as Record<string, unknown>;
    corruptedMetrics.validationArtifactSha256 = "0".repeat(64);
    await expect(
      getActiveMismatchCalibration(poolReturning({ ...validRow, metrics_json: corruptedMetrics })),
    ).rejects.toThrow(/not activation-eligible: .*validation_artifact_incompatible/);

    await expect(getActiveMismatchCalibration(poolReturning({ ...validRow, activation_revision: 0 }))).rejects.toThrow(
      "Active mismatch calibration artifact cannot have revision zero",
    );
  });
});

function artifactRow(fixture: ReturnType<typeof buildEligibleMismatchCalibrationFixture>) {
  return {
    id: "runtime-read-fixture",
    schema_version: fixture.schemaVersion,
    base_model_version: fixture.baseModelVersion,
    training_started_at: fixture.trainingStartedAt,
    training_ended_at: fixture.trainingEndedAt,
    artifact_json: fixture.artifact,
    metrics_json: fixture.metrics,
    artifact_sha256: fixture.artifact.payloadSha256,
    created_at: fixture.createdAt,
    active_artifact_id: "runtime-read-fixture",
    activation_revision: 1,
    activation_updated_at: fixture.activationAt,
  };
}

function poolReturning(row: Record<string, unknown>) {
  return {
    query: vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 }),
  } as never;
}
