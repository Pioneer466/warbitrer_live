import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import type { MismatchCalibrationArtifactV1 } from "@/lib/mismatch-calibration";
import {
  activateMismatchCalibrationArtifact,
  ConfigurationRevisionConflictError,
  getActiveMismatchCalibration,
  insertEntryExecutionProbe,
  insertMismatchCalibrationArtifact,
  migratePostgresDatabase,
  type EntryExecutionProbeRecord,
  type MismatchCalibrationActivationRequest,
  type MismatchCalibrationArtifactRecord,
} from "@/lib/postgres-db";
import { buildEligibleMismatchCalibrationFixture } from "./mismatch-calibration-fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres("Postgres mismatch calibration persistence", () => {
  it("installs the V10 probe and calibration evidence schema", async () => {
    await withIsolatedSchema(async (pool) => {
      const status = await migratePostgresDatabase(pool);
      const migration = await pool.query<{ version: number; name: string }>(
        "SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1",
      );
      const relations = await pool.query<{
        probes: string | null;
        artifacts: string | null;
        activation: string | null;
        events: string | null;
      }>(`
        SELECT
          to_regclass('entry_execution_probes')::text AS probes,
          to_regclass('mismatch_calibration_artifacts')::text AS artifacts,
          to_regclass('mismatch_calibration_activation')::text AS activation,
          to_regclass('mismatch_calibration_activation_events')::text AS events
      `);
      const activation = await getActiveMismatchCalibration(pool);

      expect(status).toMatchObject({ ready: true, currentVersion: 10, requiredVersion: 10 });
      expect(migration.rows).toEqual([{ version: 10, name: "mismatch_calibration_evidence" }]);
      expect(relations.rows).toEqual([
        {
          probes: "entry_execution_probes",
          artifacts: "mismatch_calibration_artifacts",
          activation: "mismatch_calibration_activation",
          events: "mismatch_calibration_activation_events",
        },
      ]);
      expect(activation).toMatchObject({ artifact: null, revision: 0 });
      expect(activation.updatedAt).toBeGreaterThan(0);
    });
  }, 30_000);

  it("makes probe replay idempotent and rejects conflicting immutable evidence", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const probe = buildProbe();

      const inserted = await insertEntryExecutionProbe(pool, probe);
      const replayed = await insertEntryExecutionProbe(pool, probe);

      expect(inserted).toEqual(replayed);
      expect(inserted.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
      await expect(
        insertEntryExecutionProbe(pool, {
          ...probe,
          decision: "accepted_after_conflicting_replay",
        }),
      ).rejects.toThrow(`Entry execution probe ${probe.probeKey} conflicts with immutable evidence`);

      const stored = await pool.query<{ total: number; decision: string; evidence_sha256: string }>(
        `
          SELECT count(*) OVER ()::integer AS total, decision, evidence_sha256
          FROM entry_execution_probes
          WHERE probe_key = $1
        `,
        [probe.probeKey],
      );
      expect(stored.rows).toEqual([
        {
          total: 1,
          decision: probe.decision,
          evidence_sha256: inserted.evidenceSha256,
        },
      ]);
    });
  }, 30_000);

  it("persists a valid artifact idempotently and rejects divergent replay metadata", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const artifact = buildArtifactRecord();

      const inserted = await insertMismatchCalibrationArtifact(pool, artifact);
      const replayed = await insertMismatchCalibrationArtifact(pool, artifact);

      expect(inserted).toEqual(replayed);
      expect(inserted.artifactSha256).toBe(artifact.artifact.payloadSha256);
      await expect(
        insertMismatchCalibrationArtifact(pool, {
          ...artifact,
          metrics: { ...artifact.metrics, brierScore: 0.999 },
        }),
      ).rejects.toThrow(`Mismatch calibration artifact ${artifact.id} conflicts with immutable evidence`);

      const stored = await pool.query<{ total: number; metrics_json: Record<string, unknown> }>(
        `
          SELECT count(*) OVER ()::integer AS total, metrics_json
          FROM mismatch_calibration_artifacts
          WHERE id = $1
        `,
        [artifact.id],
      );
      expect(stored.rows).toEqual([{ total: 1, metrics_json: artifact.metrics }]);
    });
  }, 30_000);

  it("activates with CAS and replays only an exact full request hash", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const artifact = buildArtifactRecord();
      await insertMismatchCalibrationArtifact(pool, artifact);
      const request: MismatchCalibrationActivationRequest = {
        artifactId: artifact.id,
        expectedRevision: 0,
        requestId: randomUUID(),
        actor: "mismatch-calibration-integration",
        reason: "activate tested artifact",
        occurredAt: Date.now(),
      };

      const activated = await activateMismatchCalibrationArtifact(pool, request);
      const replayed = await activateMismatchCalibrationArtifact(pool, request);

      expect(activated).toMatchObject({
        artifact: { id: artifact.id, artifactSha256: artifact.artifact.payloadSha256 },
        revision: 1,
      });
      expect(replayed).toEqual(activated);
      for (const conflictingReplay of [
        { ...request, artifactId: null },
        { ...request, expectedRevision: 99 },
        { ...request, actor: `${request.actor}-changed` },
        { ...request, reason: `${request.reason}-changed` },
        { ...request, occurredAt: request.occurredAt + 1 },
      ] satisfies MismatchCalibrationActivationRequest[]) {
        await expect(activateMismatchCalibrationArtifact(pool, conflictingReplay)).rejects.toThrow(
          `Mismatch calibration activation request ${request.requestId} was reused`,
        );
      }

      await expect(
        activateMismatchCalibrationArtifact(pool, {
          ...request,
          requestId: randomUUID(),
          expectedRevision: 0,
        }),
      ).rejects.toBeInstanceOf(ConfigurationRevisionConflictError);
      await expect(getActiveMismatchCalibration(pool)).resolves.toEqual(activated);

      const events = await pool.query<{
        total: number;
        request_sha256: string;
        request_json: MismatchCalibrationActivationRequest;
      }>(
        `
          SELECT count(*) OVER ()::integer AS total, request_sha256, request_json
          FROM mismatch_calibration_activation_events
        `,
      );
      expect(events.rows).toEqual([
        { total: 1, request_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), request_json: request },
      ]);
    });
  }, 30_000);

  it("snapshots an activation request before asynchronous persistence", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const request: MismatchCalibrationActivationRequest = {
        artifactId: null,
        expectedRevision: 0,
        requestId: randomUUID(),
        actor: "immutable-request-integration",
        reason: "prove activation request snapshotting",
        occurredAt: Date.now(),
      };
      const expectedRequest = { ...request };
      const pending = activateMismatchCalibrationArtifact(pool, request);
      request.artifactId = "mutated-after-call";
      request.expectedRevision = 99;
      request.actor = "mutated-after-call";
      request.reason = "mutated-after-call";
      request.occurredAt += 1;

      await expect(pending).resolves.toMatchObject({ artifact: null, revision: 1 });
      const stored = await pool.query<{ request_json: MismatchCalibrationActivationRequest }>(
        "SELECT request_json FROM mismatch_calibration_activation_events WHERE request_id = $1::uuid",
        [expectedRequest.requestId],
      );
      expect(stored.rows).toEqual([{ request_json: expectedRequest }]);
    });
  }, 30_000);

  it("advances activation time monotonically when the stored clock is ahead of PostgreSQL", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const initial = await getActiveMismatchCalibration(pool);
      const futureRecordedAt = Math.max(Date.now(), initial.updatedAt) + 60_000;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `
            INSERT INTO mismatch_calibration_activation_events (
              request_id, request_sha256, request_json, previous_artifact_id, artifact_id, previous_revision,
              revision, actor, reason, occurred_at, recorded_at
            ) VALUES ($1::uuid, $2, $3::jsonb, NULL, NULL, 0, 1, $4, $5, $6, $6)
          `,
          [
            randomUUID(),
            "b".repeat(64),
            JSON.stringify({ source: "future-clock-integration" }),
            "future-clock-integration",
            "establish a monotone timestamp fixture",
            futureRecordedAt,
          ],
        );
        await client.query("UPDATE mismatch_calibration_activation SET revision = 1, updated_at = $1 WHERE id = 1", [
          futureRecordedAt,
        ]);
        await client.query("COMMIT");
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }

      const activated = await activateMismatchCalibrationArtifact(pool, {
        artifactId: null,
        expectedRevision: 1,
        requestId: randomUUID(),
        actor: "monotone-clock-integration",
        reason: "activation must remain monotone",
        occurredAt: Date.now(),
      });

      expect(activated).toMatchObject({ artifact: null, revision: 2, updatedAt: futureRecordedAt + 1 });
      await expect(getActiveMismatchCalibration(pool)).resolves.toEqual(activated);
    });
  }, 30_000);

  it("rejects activation of an artifact built for another runtime model", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const artifact = buildArtifactRecord("structural-legacy-model-v0-uncalibrated");
      await insertMismatchCalibrationArtifact(pool, artifact);

      await expect(
        activateMismatchCalibrationArtifact(pool, {
          artifactId: artifact.id,
          expectedRevision: 0,
          requestId: randomUUID(),
          actor: "wrong-runtime-integration",
          reason: "must fail closed",
          occurredAt: Date.now(),
        }),
      ).rejects.toThrow(/runtime_base_model_version_mismatch/);
      await expect(getActiveMismatchCalibration(pool)).resolves.toMatchObject({ artifact: null, revision: 0 });
      await expect(
        pool.query("SELECT count(*)::integer AS total FROM mismatch_calibration_activation_events"),
      ).resolves.toMatchObject({
        rows: [{ total: 0 }],
      });
    });
  }, 30_000);

  it("rejects direct activation mutation, orphan activation events, and probe truncation", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const artifact = buildArtifactRecord();
      const probe = buildProbe();
      await insertMismatchCalibrationArtifact(pool, artifact);
      await insertEntryExecutionProbe(pool, probe);

      await expect(
        pool.query(`
          UPDATE mismatch_calibration_activation
          SET artifact_id = '${artifact.id}', revision = revision + 1, updated_at = updated_at + 1
          WHERE id = 1
        `),
      ).rejects.toThrow(/mismatch calibration activation update lacks matching event/);
      await expect(pool.query("TRUNCATE entry_execution_probes")).rejects.toThrow(
        /entry execution probes are immutable/,
      );
      await expect(
        pool.query(
          `
            INSERT INTO mismatch_calibration_activation_events (
              request_id, request_sha256, request_json, previous_artifact_id, artifact_id, previous_revision,
              revision, actor, reason, occurred_at, recorded_at
            )
            SELECT
              $1::uuid, $2, $3::jsonb, activation.artifact_id, $4, activation.revision,
              activation.revision + 1, $5, $6, activation.updated_at, activation.updated_at
            FROM mismatch_calibration_activation AS activation
            WHERE activation.id = 1
          `,
          [
            randomUUID(),
            "c".repeat(64),
            JSON.stringify({ source: "equal-clock-direct-sql-integration" }),
            artifact.id,
            "equal-clock-direct-sql-integration",
            "equal activation timestamp must be rejected",
          ],
        ),
      ).rejects.toThrow(/mismatch calibration activation event does not extend current state/);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = await client.query<{ artifact_id: string | null; revision: number; updated_at: number }>(
          "SELECT artifact_id, revision, updated_at FROM mismatch_calibration_activation WHERE id = 1",
        );
        const state = current.rows[0];
        if (!state) {
          throw new Error("Missing mismatch calibration activation fixture state");
        }
        await client.query(
          `
            INSERT INTO mismatch_calibration_activation_events (
              request_id, request_sha256, request_json, previous_artifact_id, artifact_id, previous_revision,
              revision, actor, reason, occurred_at, recorded_at
            ) VALUES ($1::uuid, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11)
          `,
          [
            randomUUID(),
            "a".repeat(64),
            JSON.stringify({ source: "direct-sql-integration" }),
            state.artifact_id,
            artifact.id,
            state.revision,
            Number(state.revision) + 1,
            "direct-sql-integration",
            "orphan event must not commit",
            state.updated_at,
            Number(state.updated_at) + 1,
          ],
        );
        await expect(
          client.query("SET CONSTRAINTS mismatch_calibration_activation_event_state_guard IMMEDIATE"),
        ).rejects.toThrow(/mismatch calibration activation event is not reflected in current state/);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }

      const state = await pool.query<{ artifact_id: string | null; revision: number }>(
        "SELECT artifact_id, revision FROM mismatch_calibration_activation WHERE id = 1",
      );
      const counts = await pool.query<{ probes: number; events: number }>(`
        SELECT
          (SELECT count(*)::integer FROM entry_execution_probes) AS probes,
          (SELECT count(*)::integer FROM mismatch_calibration_activation_events) AS events
      `);
      expect(state.rows).toEqual([{ artifact_id: null, revision: 0 }]);
      expect(counts.rows).toEqual([{ probes: 1, events: 0 }]);
    });
  }, 30_000);
});

function buildProbe(): EntryExecutionProbeRecord {
  const slotStartTs = 1_800_000_000_000;
  const slotEndTs = slotStartTs + 15 * 60_000;
  const signalCapturedAt = slotEndTs - 55_000;
  const restStartedAt = signalCapturedAt + 7;
  const restCapturedAt = restStartedAt + 11;
  return {
    probeKey: "btc:1800000000000:late:55:POLY_UP_KALSHI_NO",
    asset: "btc",
    slotKey: "btc:1800000000000",
    slotStartTs,
    slotEndTs,
    combination: "POLY_UP_KALSHI_NO",
    probeKind: "late_probe",
    targetSecondsRemaining: 55,
    signalCapturedAt,
    restStartedAt,
    restCapturedAt,
    decision: "rejected",
    firstRejectionStage: "rest",
    firstRejectionCode: "price_cap_exceeded",
    strategyRevision: 3,
    globalRiskRevision: 4,
    signal: { grossCost: 0.92, source: "integration-fixture" },
    rest: { polymarket: { source: "rest" }, kalshi: { source: "rest" } },
    risk: { pFatalUpper95: 0.08 },
    variants: [{ maxLegPrice: 0.49, executable: false }],
    recordedAt: restCapturedAt + 5,
  };
}

function buildArtifactRecord(
  baseModelVersion = "structural-ewma-gaussian-v1-uncalibrated",
): MismatchCalibrationArtifactRecord & {
  artifact: MismatchCalibrationArtifactV1;
} {
  const now = Date.now();
  const fixture = buildEligibleMismatchCalibrationFixture({
    baseModelVersion,
    trainingStartedAt: now - 21 * 24 * 60 * 60_000,
    trainingEndedAt: now - 24 * 60 * 60_000,
  });
  return {
    id: "calibration-artifact-integration-v1",
    schemaVersion: fixture.schemaVersion,
    baseModelVersion: fixture.baseModelVersion,
    trainingStartedAt: fixture.trainingStartedAt,
    trainingEndedAt: fixture.trainingEndedAt,
    artifact: fixture.artifact,
    metrics: fixture.metrics,
    createdAt: fixture.createdAt,
  };
}

async function withIsolatedSchema(run: (pool: Pool) => Promise<void>) {
  if (!TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  const schema = `warbitrer_mismatch_calibration_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    max: 4,
    options: `-c search_path=${schema}`,
  });

  try {
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
