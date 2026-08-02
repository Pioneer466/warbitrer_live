import { readFileSync } from "node:fs";

import type { QueryResult, QueryResultRow } from "pg";

import type { PgQueryable } from "@/lib/db-migrations";
import {
  DATABASE_MIGRATIONS,
  hashMismatchCalibrationActivationRequest,
  type MismatchCalibrationActivationRequest,
} from "@/lib/postgres-db";
import {
  assertDeploymentLiveGateDisabled,
  assertDeploymentPreflight,
  collectDeploymentPreflightSnapshot,
  DEPLOYMENT_PREFLIGHT_REQUIRED_COLUMNS,
  DEPLOYMENT_PREFLIGHT_REVIEWED_SCHEMA_VERSION,
  DeploymentPreflightBlockedError,
  evaluateDeploymentPreflight,
  type DeploymentPreflightSnapshot,
} from "@/lib/deployment-preflight";
import { buildEligibleMismatchCalibrationFixture } from "./mismatch-calibration-fixtures";

const POSTGRES_DB_SOURCE = readFileSync(new URL("../src/lib/postgres-db.ts", import.meta.url), "utf8");
const V10_PROBE_INDEX_NAMES = [
  "entry_execution_probes_asset_slot_idx",
  "entry_execution_probes_asset_captured_idx",
  "entry_execution_probes_captured_idx",
  "entry_execution_probes_funnel_idx",
] as const;
const V10_PROCEDURE_NAMES = [
  "reject_entry_execution_probe_update",
  "reject_mismatch_calibration_fact_mutation",
  "validate_mismatch_calibration_activation_event",
  "require_mismatch_calibration_activation_event",
  "require_mismatch_calibration_activation_state",
] as const;

describe("deployment preflight", () => {
  it("requires an explicit preflight review whenever the schema advances", () => {
    expect(latestSchemaVersion()).toBe(DEPLOYMENT_PREFLIGHT_REVIEWED_SCHEMA_VERSION);
  });

  it.each(["1", "true", "TRUE", " yes ", "on"])("rejects truthy LIVE_EXECUTION_ALLOWED=%j", (value) => {
    expect(() => assertDeploymentLiveGateDisabled({ LIVE_EXECUTION_ALLOWED: value })).toThrow(
      DeploymentPreflightBlockedError,
    );
  });

  it.each([undefined, "", "0", "false", "off", "invalid"])("accepts non-truthy LIVE_EXECUTION_ALLOWED=%j", (value) => {
    expect(() => assertDeploymentLiveGateDisabled({ LIVE_EXECUTION_ALLOWED: value })).not.toThrow();
  });

  it("reports every unsafe durable state, including an accounting backlog", () => {
    const snapshot = buildSnapshot({
      liveIntents: { total: 2, sampleIds: ["hedged-intent"] },
      unresolvedAttempts: { total: 1, sampleIds: ["attempt-1"] },
      openOrders: { total: 1, sampleIds: ["order-1"] },
      livePositions: { total: 1, sampleIds: ["position-1"] },
      liveReservation: {
        rowCount: 2,
        canonicalRowCount: 1,
        ownedCount: 1,
        ownerIntentIds: ["reserved-intent"],
      },
      accountingBacklog: {
        total: 1,
        missingHeads: 0,
        legacyPending: 0,
        quarantined: 1,
        terminalOpen: 0,
        historicalLegacyPending: 5,
        oldestIntentId: "accounting-intent",
      },
    });

    expect(evaluateDeploymentPreflight(snapshot, { LIVE_EXECUTION_ALLOWED: "true" }).map(({ code }) => code)).toEqual([
      "live_execution_gate_enabled",
      "live_intents_or_exposure",
      "unresolved_live_attempts",
      "open_live_orders",
      "live_positions",
      "invalid_live_reservation",
      "owned_live_reservation",
      "accounting_backlog",
    ]);
    expect(() => assertDeploymentPreflight(snapshot, { LIVE_EXECUTION_ALLOWED: "false" })).toThrow(/hedged-intent/);
  });

  it("accepts a clean legacy V1 snapshot without requiring admission or accounting tables", async () => {
    const db = buildQueryable({ schemaVersion: 1 });
    const snapshot = await collectDeploymentPreflightSnapshot(db);

    expect(snapshot).toEqual(buildSnapshot({ schemaVersion: 1, liveReservation: null, accountingBacklog: null }));
    expect(() => assertDeploymentPreflight(snapshot, { LIVE_EXECUTION_ALLOWED: "false" })).not.toThrow();
    expect(db.queryMock).not.toHaveBeenCalledWith(expect.stringContaining("deployment_preflight:entry_reservation"));
    expect(db.queryMock).not.toHaveBeenCalledWith(expect.stringContaining("classified AS"));
  });

  it("accepts a complete legacy V0 snapshot before migration history is initialized", async () => {
    const db = buildQueryable({ schemaVersion: 0, initialized: false });
    const snapshot = await collectDeploymentPreflightSnapshot(db);

    expect(snapshot).toEqual(buildSnapshot({ schemaVersion: 0, liveReservation: null, accountingBacklog: null }));
    expect(() => assertDeploymentPreflight(snapshot, { LIVE_EXECUTION_ALLOWED: "false" })).not.toThrow();
    expect(db.queryMock).not.toHaveBeenCalledWith(expect.stringContaining("deployment_preflight:entry_reservation"));
    expect(db.queryMock).not.toHaveBeenCalledWith(expect.stringContaining("classified AS"));
  });

  it("accepts a clean V4 snapshot without requiring V7 accounting tables", async () => {
    const db = buildQueryable({ schemaVersion: 4 });
    const snapshot = await collectDeploymentPreflightSnapshot(db);

    expect(snapshot).toEqual(buildSnapshot({ schemaVersion: 4, accountingBacklog: null }));
    expect(() => assertDeploymentPreflight(snapshot, { LIVE_EXECUTION_ALLOWED: "false" })).not.toThrow();
    expect(db.queryMock).not.toHaveBeenCalledWith(expect.stringContaining("classified AS"));
  });

  it("reads and rejects the canonical accounting backlog on the latest schema", async () => {
    const db = buildQueryable({ schemaVersion: latestSchemaVersion(), accountingBacklogTotal: 1 });
    const snapshot = await collectDeploymentPreflightSnapshot(db);

    expect(snapshot.accountingBacklog).toMatchObject({ total: 1, quarantined: 1 });
    expect(evaluateDeploymentPreflight(snapshot, { LIVE_EXECUTION_ALLOWED: "false" })).toEqual([
      expect.objectContaining({ code: "accounting_backlog" }),
    ]);
  });

  it("allows only exact historical legacy exposure under the explicit shadow-only override", () => {
    const snapshot = buildSnapshot({
      liveIntents: { total: 2, sampleIds: ["historical-1", "historical-2"] },
      historicalLegacyExposure: { total: 2, sampleIds: ["historical-1", "historical-2"] },
      accountingBacklog: {
        total: 2,
        missingHeads: 0,
        legacyPending: 2,
        quarantined: 0,
        terminalOpen: 0,
        historicalLegacyPending: 10,
        oldestIntentId: "historical-1",
      },
    });

    expect(evaluateDeploymentPreflight(snapshot, { LIVE_EXECUTION_ALLOWED: "false" }).map(({ code }) => code)).toEqual([
      "live_intents_or_exposure",
      "accounting_backlog",
    ]);
    expect(
      evaluateDeploymentPreflight(snapshot, {
        LIVE_EXECUTION_ALLOWED: "false",
        ALLOW_HISTORICAL_LEGACY_ACCOUNTING_DEPLOY: "true",
      }),
    ).toEqual([]);
  });

  it("does not let the historical-debt override hide unrelated or quarantined state", () => {
    const snapshot = buildSnapshot({
      liveIntents: { total: 2, sampleIds: ["historical", "unrelated"] },
      historicalLegacyExposure: { total: 1, sampleIds: ["historical"] },
      accountingBacklog: {
        total: 1,
        missingHeads: 0,
        legacyPending: 0,
        quarantined: 1,
        terminalOpen: 0,
        historicalLegacyPending: 0,
        oldestIntentId: "quarantined",
      },
    });

    expect(
      evaluateDeploymentPreflight(snapshot, {
        LIVE_EXECUTION_ALLOWED: "false",
        ALLOW_HISTORICAL_LEGACY_ACCOUNTING_DEPLOY: "true",
      }).map(({ code }) => code),
    ).toEqual(["live_intents_or_exposure", "accounting_backlog"]);
  });

  it("fails closed when required schema columns are missing", async () => {
    const db = buildQueryable({ schemaVersion: 4, omitColumn: "order_attempts.truth_status" });

    await expect(collectDeploymentPreflightSnapshot(db)).rejects.toThrow(/order_attempts\.truth_status/);
  });

  it("fails closed when V10 mismatch calibration evidence is incomplete", async () => {
    const db = buildQueryable({
      schemaVersion: latestSchemaVersion(),
      omitColumn: "mismatch_calibration_activation.artifact_id",
    });

    await expect(collectDeploymentPreflightSnapshot(db)).rejects.toThrow(
      /mismatch_calibration_activation\.artifact_id/,
    );
  });

  it("casts PostgreSQL catalog names to text arrays for node-postgres", async () => {
    const db = buildQueryable({ schemaVersion: latestSchemaVersion() });

    await collectDeploymentPreflightSnapshot(db);

    const sqlCalls = db.queryMock.mock.calls.map(([sql]) => String(sql));
    const constraintsSql = sqlCalls.find((sql) =>
      sql.includes("deployment_preflight:mismatch_calibration_constraints"),
    );
    const indexesSql = sqlCalls.find((sql) => sql.includes("deployment_preflight:mismatch_calibration_probe_indexes"));
    expect(constraintsSql?.match(/array_agg\(attribute\.attname::text/g)).toHaveLength(2);
    expect(indexesSql).toContain("SELECT attribute.attname::text");
  });

  it("fails closed when a V10 immutability trigger or activation singleton is missing", async () => {
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          omitV10Trigger: "mismatch_calibration_activation_update_guard",
        }),
      ),
    ).rejects.toThrow(/mismatch_calibration_activation_update_guard/);
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({ schemaVersion: latestSchemaVersion(), missingCalibrationActivation: true }),
      ),
    ).rejects.toThrow(/exactly one mismatch calibration activation row/);
  });

  it("fails closed when a V10 trigger is misplaced or replica-only", async () => {
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          misplaceV10Trigger: "mismatch_calibration_activation_update_guard",
        }),
      ),
    ).rejects.toThrow(/mismatch_calibration_activation_update_guard/);
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          replicaOnlyV10Trigger: "mismatch_calibration_activation_event_chain",
        }),
      ),
    ).rejects.toThrow(/mismatch_calibration_activation_event_chain/);
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          incompatibleV10Trigger: "mismatch_calibration_activation_event_state_guard",
        }),
      ),
    ).rejects.toThrow(/mismatch_calibration_activation_event_state_guard/);
  });

  it("fails closed when a V10 trigger has a WHEN clause or trigger arguments", async () => {
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          conditionalV10Trigger: "mismatch_calibration_activation_event_chain",
        }),
      ),
    ).rejects.toThrow(/mismatch_calibration_activation_event_chain/);
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          argumentV10Trigger: "mismatch_calibration_activation_update_guard",
        }),
      ),
    ).rejects.toThrow(/mismatch_calibration_activation_update_guard/);
  });

  it("fails closed when a critical V10 column definition is incompatible", async () => {
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          incompatibleV10Column: "entry_execution_probes.probe_key",
        }),
      ),
    ).rejects.toThrow(/entry_execution_probes\.probe_key/);
  });

  it("fails closed when a required V10 key, foreign key, or check constraint is missing", async () => {
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          omitV10Constraint: "entry_execution_probes_pkey",
        }),
      ),
    ).rejects.toThrow(/entry_execution_probes_pkey/);
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          omitV10Constraint: "mismatch_calibration_activation_events_artifact_id_fkey",
        }),
      ),
    ).rejects.toThrow(/mismatch_calibration_activation_events_artifact_id_fkey/);
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          omitV10CheckExpression: "revision = previous_revision + 1",
        }),
      ),
    ).rejects.toThrow(/revision = previous_revision \+ 1/);
  });

  it.each(V10_PROBE_INDEX_NAMES)("fails closed when required V10 probe index %s is missing", async (indexName) => {
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          omitV10ProbeIndex: indexName,
        }),
      ),
    ).rejects.toThrow(indexName);
  });

  it("fails closed when a required V10 probe index definition is incompatible", async () => {
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          incompatibleV10ProbeIndex: "entry_execution_probes_funnel_idx",
        }),
      ),
    ).rejects.toThrow(/entry_execution_probes_funnel_idx/);
  });

  it.each(V10_PROCEDURE_NAMES)("fails closed when V10 procedure %s has a corrupt body", async (procedureName) => {
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          corruptV10Procedure: procedureName,
        }),
      ),
    ).rejects.toThrow(procedureName);
  });

  it("fails closed when V10 procedure execution metadata is incompatible", async () => {
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          incompatibleV10Procedure: "require_mismatch_calibration_activation_state",
        }),
      ),
    ).rejects.toThrow(/require_mismatch_calibration_activation_state/);
  });

  it("fails closed on partial V10 admission columns before V10", async () => {
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({ schemaVersion: 9, extraV10AdmissionColumn: "mismatch_calibration_revision" }),
      ),
    ).rejects.toThrow(/mismatch calibration evidence before migration V10/);
  });

  it("fails closed when the activation singleton disagrees with its event chain", async () => {
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          calibrationActivationRow: { artifact_id: "unexpected-active-artifact" },
        }),
      ),
    ).rejects.toThrow(/activation\/event chain mismatch/);
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          calibrationActivationRow: {
            revision: 2,
            updated_at: 20,
          },
        }),
      ),
    ).rejects.toThrow(/activation\/event chain length mismatch/);
  });

  it("accepts only a checksum-valid and activation-eligible active calibration artifact", async () => {
    const activeCalibration = buildActiveCalibrationState();

    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          calibrationActivationRow: activeCalibration.activation,
          calibrationEvents: activeCalibration.events,
        }),
      ),
    ).resolves.toMatchObject({ schemaVersion: latestSchemaVersion() });
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          calibrationActivationRow: { ...activeCalibration.activation, artifact_sha256: "0".repeat(64) },
          calibrationEvents: activeCalibration.events,
        }),
      ),
    ).rejects.toThrow(/invalid active mismatch calibration artifact/);
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          calibrationActivationRow: { ...activeCalibration.activation, metrics_json: { schemaVersion: 1 } },
          calibrationEvents: activeCalibration.events,
        }),
      ),
    ).rejects.toThrow(/activation-ineligible mismatch calibration artifact/);
  });

  it("fails closed on corrupt V10 activation event links, timestamps, or request hashes", async () => {
    const deactivated = buildDeactivatedCalibrationState();

    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          calibrationActivationRow: deactivated.activation,
          calibrationEvents: deactivated.events.map((event, index) =>
            index === 1 ? { ...event, revision: 3 } : event,
          ),
        }),
      ),
    ).rejects.toThrow(/invalid mismatch calibration activation event at revision 2/);
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          calibrationActivationRow: deactivated.activation,
          calibrationEvents: deactivated.events.map((event, index) =>
            index === 1 ? { ...event, previous_artifact_id: "wrong-artifact" } : event,
          ),
        }),
      ),
    ).rejects.toThrow(/invalid mismatch calibration activation event at revision 2/);
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          calibrationActivationRow: deactivated.activation,
          calibrationEvents: deactivated.events.map((event, index) =>
            index === 1 ? { ...event, recorded_at: deactivated.events[0]!.recorded_at } : event,
          ),
        }),
      ),
    ).rejects.toThrow(/invalid mismatch calibration activation event at revision 2/);
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          calibrationActivationRow: deactivated.activation,
          calibrationEvents: deactivated.events.map((event, index) =>
            index === 0 ? { ...event, request_sha256: "0".repeat(64) } : event,
          ),
        }),
      ),
    ).rejects.toThrow(/invalid mismatch calibration activation event at revision 1/);
    await expect(
      collectDeploymentPreflightSnapshot(
        buildQueryable({
          schemaVersion: latestSchemaVersion(),
          calibrationActivationRow: deactivated.activation,
          calibrationEvents: deactivated.events.map((event, index) =>
            index === 1 ? { ...event, request_json: { ...event.request_json, reason: "tampered request" } } : event,
          ),
        }),
      ),
    ).rejects.toThrow(/invalid mismatch calibration activation event at revision 2/);
  });

  it("fails closed on unsupported and non-contiguous migration histories", async () => {
    await expect(collectDeploymentPreflightSnapshot(buildQueryable({ schemaVersion: 0 }))).rejects.toThrow(
      /requires a complete schema V1-V\d+/,
    );
    await expect(
      collectDeploymentPreflightSnapshot(buildQueryable({ schemaVersion: 6, omitMigrationVersion: 3 })),
    ).rejects.toThrow(/migration history/);
  });
});

describe("VPS deployment ordering", () => {
  const source = readFileSync(new URL("../deploy/vps/deploy.sh", import.meta.url), "utf8");

  it("runs preflight before stop, after stop, and after migration before restart", () => {
    const preflights = indexesOf(source, "run_db_script scripts/deploy-preflight.ts");
    const stops = indexesOf(source, 'sudo systemctl stop "${SERVICE_UNITS[@]}"');
    const stop = stops.at(-1)!;
    const backup = source.indexOf("systemctl start --wait warbitrer-postgres-backup.service");
    const migration = source.indexOf("run_db_script scripts/db-migrate.ts");
    const serviceInstall = source.indexOf("sudo install -o root -g root -m 0644");

    expect(preflights).toHaveLength(3);
    expect(stops).toHaveLength(2);
    expect(preflights[0]!).toBeLessThan(stop);
    expect(stop).toBeLessThan(preflights[1]!);
    expect(preflights[1]).toBeLessThan(backup);
    expect(migration).toBeLessThan(preflights[2]!);
    expect(preflights[2]).toBeLessThan(serviceInstall);
  });

  it("locks deployment, checks every service, and verifies process liveness", () => {
    expect(source).toContain("flock --nonblock 9");
    expect(source).toContain("warbitrer-asset@bnb.service");
    expect(source).toContain("warbitrer-asset@hype.service");
    expect(source).toContain('systemctl is-active --quiet "$LEGACY_UNIT"');
    expect(source).toContain('systemctl is-enabled --quiet "$LEGACY_UNIT"');
    expect(source).toContain("run_as_app npm run format:check");
    expect(source).toContain('for unit in "${SERVICE_UNITS[@]}"; do');
    expect(source).not.toContain('systemctl --quiet is-active "${SERVICE_UNITS[@]}"');
    expect(source).toContain("trap stop_partially_started_services EXIT");
    expect(source).toContain('sudo systemctl stop "${SERVICE_UNITS[@]}" || true');
    expect(source).toContain("--property=NRestarts");
    expect(source).toContain("for validation_round in 1 2 3 4; do");
    expect(source).toContain("trap - EXIT");
    expect(source.indexOf("trap - EXIT")).toBeGreaterThan(
      source.indexOf("sudo systemctl status warbitrer-postgres-backup.timer --no-pager"),
    );
    expect(source).toContain("http://127.0.0.1:3000/api/liveness");
    expect(source.indexOf("sudo install -o root -g root -m 0644")).toBeGreaterThan(
      source.indexOf("run_db_script scripts/db-status.ts"),
    );
    expect(source.indexOf("sudo systemctl daemon-reload")).toBeGreaterThan(
      source.indexOf("sudo install -o root -g root -m 0644"),
    );
  });
});

function buildSnapshot(overrides: Partial<DeploymentPreflightSnapshot> = {}): DeploymentPreflightSnapshot {
  return {
    schemaVersion: latestSchemaVersion(),
    liveIntents: { total: 0, sampleIds: [] },
    historicalLegacyExposure: { total: 0, sampleIds: [] },
    unresolvedAttempts: { total: 0, sampleIds: [] },
    openOrders: { total: 0, sampleIds: [] },
    livePositions: { total: 0, sampleIds: [] },
    liveReservation: {
      rowCount: 1,
      canonicalRowCount: 1,
      ownedCount: 0,
      ownerIntentIds: [],
    },
    accountingBacklog: {
      total: 0,
      missingHeads: 0,
      legacyPending: 0,
      quarantined: 0,
      terminalOpen: 0,
      historicalLegacyPending: 0,
      oldestIntentId: null,
    },
    ...overrides,
  };
}

type CalibrationEventFixture = {
  request_id: string;
  request_sha256: string;
  request_json: MismatchCalibrationActivationRequest;
  previous_artifact_id: string | null;
  artifact_id: string | null;
  previous_revision: number;
  revision: number;
  actor: string;
  reason: string;
  occurred_at: number;
  recorded_at: number;
};

function buildActiveCalibrationState() {
  const fixture = buildEligibleMismatchCalibrationFixture();
  const artifactId = "calibration-artifact-preflight-v1";
  const request: MismatchCalibrationActivationRequest = {
    artifactId,
    expectedRevision: 0,
    requestId: "00000000-0000-4000-8000-000000000001",
    actor: "deployment-preflight-test",
    reason: "activate fixture",
    occurredAt: fixture.activationAt,
  };

  return {
    activation: {
      artifact_id: artifactId,
      revision: 1,
      updated_at: fixture.activationAt,
      schema_version: fixture.artifact.schemaVersion,
      base_model_version: fixture.artifact.baseModelVersion,
      training_started_at: fixture.trainingStartedAt,
      training_ended_at: fixture.trainingEndedAt,
      artifact_json: fixture.artifact,
      metrics_json: fixture.metrics,
      artifact_sha256: fixture.artifact.payloadSha256,
      created_at: fixture.createdAt,
    },
    events: [
      {
        request_id: request.requestId,
        request_sha256: hashMismatchCalibrationActivationRequest(request),
        request_json: request,
        previous_artifact_id: null,
        artifact_id: artifactId,
        previous_revision: 0,
        revision: 1,
        actor: request.actor,
        reason: request.reason,
        occurred_at: request.occurredAt,
        recorded_at: fixture.activationAt,
      },
    ],
  };
}

function buildDeactivatedCalibrationState() {
  const active = buildActiveCalibrationState();
  const recordedAt = active.activation.updated_at + 1;
  const request: MismatchCalibrationActivationRequest = {
    artifactId: null,
    expectedRevision: 1,
    requestId: "00000000-0000-4000-8000-000000000002",
    actor: "deployment-preflight-test",
    reason: "deactivate fixture",
    occurredAt: recordedAt,
  };
  const event: CalibrationEventFixture = {
    request_id: request.requestId,
    request_sha256: hashMismatchCalibrationActivationRequest(request),
    request_json: request,
    previous_artifact_id: active.activation.artifact_id,
    artifact_id: null,
    previous_revision: 1,
    revision: 2,
    actor: request.actor,
    reason: request.reason,
    occurred_at: request.occurredAt,
    recorded_at: recordedAt,
  };

  return {
    activation: {
      artifact_id: null,
      revision: 2,
      updated_at: recordedAt,
    },
    events: [...active.events, event],
  };
}

function buildQueryable(options: {
  schemaVersion: number;
  initialized?: boolean;
  omitMigrationVersion?: number;
  omitColumn?: string;
  omitV10Trigger?: string;
  misplaceV10Trigger?: string;
  replicaOnlyV10Trigger?: string;
  incompatibleV10Trigger?: string;
  conditionalV10Trigger?: string;
  argumentV10Trigger?: string;
  incompatibleV10Column?: string;
  omitV10Constraint?: string;
  omitV10CheckExpression?: string;
  omitV10ProbeIndex?: string;
  incompatibleV10ProbeIndex?: string;
  corruptV10Procedure?: string;
  incompatibleV10Procedure?: string;
  extraV10AdmissionColumn?: "mismatch_calibration_artifact_id" | "mismatch_calibration_revision";
  missingCalibrationActivation?: boolean;
  calibrationEvents?: Array<Partial<CalibrationEventFixture>>;
  calibrationActivationRow?: Partial<{
    artifact_id: string | null;
    revision: number;
    updated_at: number;
    schema_version: number | null;
    base_model_version: string | null;
    training_started_at: number | null;
    training_ended_at: number | null;
    artifact_json: Record<string, unknown> | null;
    metrics_json: Record<string, unknown> | null;
    artifact_sha256: string | null;
    created_at: number | null;
  }>;
  accountingBacklogTotal?: number;
}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("to_regclass")) {
      return result([{ table_name: options.initialized === false ? null : "schema_migrations" }]);
    }
    if (sql.includes("FROM schema_migrations")) {
      return result(
        DATABASE_MIGRATIONS.filter(
          (migration) =>
            migration.version <= options.schemaVersion && migration.version !== options.omitMigrationVersion,
        ).map((migration) => ({
          version: migration.version,
          name: migration.name,
          checksum: migration.checksum,
          applied_at: 1,
        })),
      );
    }
    if (sql.includes("deployment_preflight:schema_shape")) {
      const required = {
        ...DEPLOYMENT_PREFLIGHT_REQUIRED_COLUMNS,
        ...(options.schemaVersion >= 4 ? { entry_reservations: ["scope_key", "mode", "owner_intent_id"] } : {}),
        ...(options.schemaVersion >= 7
          ? {
              accounting_heads: ["intent_id", "state", "current_version", "current_proof_sha256", "revision"],
              accounting_legs: ["intent_id", "leg_id", "identity_sha256"],
              accounting_fill_facts: ["fill_id", "intent_id", "leg_id", "finality", "fact_sha256"],
              accounting_settlement_facts: ["settlement_id", "intent_id", "leg_id", "finality", "fact_sha256"],
              accounting_versions: ["intent_id", "version", "proof_sha256", "realized_pnl_units"],
              accounting_version_fill_facts: ["intent_id", "version", "fill_id"],
              accounting_version_settlement_facts: ["intent_id", "version", "settlement_id"],
              accounting_realized_pnl_ledger: [
                "intent_id",
                "accounting_version",
                "effective_at",
                "realized_pnl_delta_units",
              ],
              accounting_quarantines: ["intent_id", "reason", "request_id"],
              accounting_no_exposure_closures: ["intent_id", "request_id", "proof_sha256"],
              accounting_stability_observations: ["intent_id", "accounting_version", "request_id"],
              accounting_mutation_requests: ["request_id", "intent_id", "operation", "request_sha256"],
            }
          : {}),
        ...(options.schemaVersion >= 8
          ? {
              accounting_fill_finality_observations: [
                "fill_id",
                "request_id",
                "previous_finality",
                "observed_finality",
                "observed_fee_units",
                "observation_sha256",
              ],
            }
          : {}),
        ...(options.schemaVersion >= 10
          ? {
              entry_admissions: ["mismatch_calibration_artifact_id", "mismatch_calibration_revision"],
              entry_execution_probes: [
                "probe_key",
                "asset",
                "slot_key",
                "slot_start_ts",
                "slot_end_ts",
                "combination",
                "probe_kind",
                "target_seconds_remaining",
                "signal_captured_at",
                "rest_started_at",
                "rest_captured_at",
                "decision",
                "first_rejection_stage",
                "first_rejection_code",
                "strategy_revision",
                "global_risk_revision",
                "signal_json",
                "rest_json",
                "risk_json",
                "variants_json",
                "evidence_sha256",
                "recorded_at",
              ],
              mismatch_calibration_artifacts: [
                "id",
                "schema_version",
                "base_model_version",
                "training_started_at",
                "training_ended_at",
                "artifact_json",
                "metrics_json",
                "artifact_sha256",
                "created_at",
              ],
              mismatch_calibration_activation: ["id", "artifact_id", "revision", "updated_at"],
              mismatch_calibration_activation_events: [
                "id",
                "request_id",
                "request_sha256",
                "request_json",
                "previous_artifact_id",
                "artifact_id",
                "previous_revision",
                "revision",
                "actor",
                "reason",
                "occurred_at",
                "recorded_at",
              ],
            }
          : {}),
      };
      const rows = Object.entries(required).flatMap(([tableName, columnNames]) =>
        columnNames
          .filter((columnName) => `${tableName}.${columnName}` !== options.omitColumn)
          .map((columnName) => ({ table_name: tableName, column_name: columnName })),
      );
      if (options.extraV10AdmissionColumn) {
        rows.push({ table_name: "entry_admissions", column_name: options.extraV10AdmissionColumn });
      }
      return result(rows);
    }
    if (sql.includes("deployment_preflight:mismatch_calibration_columns")) {
      return result(
        buildV10ColumnCatalogRows().map((row) =>
          `${row.table_name}.${row.column_name}` === options.incompatibleV10Column
            ? { ...row, data_type: row.data_type === "text" ? "integer" : "text" }
            : row,
        ),
      );
    }
    if (sql.includes("deployment_preflight:mismatch_calibration_constraints")) {
      return result(
        buildV10ConstraintCatalogRows().filter(
          (row) =>
            row.constraint_name !== options.omitV10Constraint &&
            row.check_expression !== options.omitV10CheckExpression,
        ),
      );
    }
    if (sql.includes("deployment_preflight:mismatch_calibration_probe_indexes")) {
      return result(
        buildV10ProbeIndexCatalogRows()
          .filter((row) => row.index_name !== options.omitV10ProbeIndex)
          .map((row) =>
            row.index_name === options.incompatibleV10ProbeIndex ? { ...row, access_method: "hash" } : row,
          ),
      );
    }
    if (sql.includes("deployment_preflight:mismatch_calibration_procedures")) {
      return result(
        buildV10ProcedureCatalogRows().map((row) => ({
          ...row,
          body: row.procedure_name === options.corruptV10Procedure ? "BEGIN RAISE EXCEPTION 'corrupt'; END;" : row.body,
          language_name: row.procedure_name === options.incompatibleV10Procedure ? "sql" : row.language_name,
        })),
      );
    }
    if (sql.includes("deployment_preflight:mismatch_calibration_triggers")) {
      return result(
        [
          {
            trigger_name: "entry_execution_probes_immutable",
            relation_name: "entry_execution_probes",
            procedure_name: "reject_entry_execution_probe_update",
            trigger_type: 50,
            deferrable: false,
            initially_deferred: false,
            constraint_trigger: false,
          },
          {
            trigger_name: "mismatch_calibration_activation_event_chain",
            relation_name: "mismatch_calibration_activation_events",
            procedure_name: "validate_mismatch_calibration_activation_event",
            trigger_type: 7,
            deferrable: false,
            initially_deferred: false,
            constraint_trigger: false,
          },
          {
            trigger_name: "mismatch_calibration_activation_update_guard",
            relation_name: "mismatch_calibration_activation",
            procedure_name: "require_mismatch_calibration_activation_event",
            trigger_type: 19,
            deferrable: false,
            initially_deferred: false,
            constraint_trigger: false,
          },
          {
            trigger_name: "mismatch_calibration_activation_event_state_guard",
            relation_name: "mismatch_calibration_activation_events",
            procedure_name: "require_mismatch_calibration_activation_state",
            trigger_type: 5,
            deferrable: true,
            initially_deferred: true,
            constraint_trigger: true,
          },
          {
            trigger_name: "mismatch_calibration_activation_singleton_guard",
            relation_name: "mismatch_calibration_activation",
            procedure_name: "reject_mismatch_calibration_fact_mutation",
            trigger_type: 42,
            deferrable: false,
            initially_deferred: false,
            constraint_trigger: false,
          },
          {
            trigger_name: "mismatch_calibration_artifacts_append_only",
            relation_name: "mismatch_calibration_artifacts",
            procedure_name: "reject_mismatch_calibration_fact_mutation",
            trigger_type: 58,
            deferrable: false,
            initially_deferred: false,
            constraint_trigger: false,
          },
          {
            trigger_name: "mismatch_calibration_activation_events_append_only",
            relation_name: "mismatch_calibration_activation_events",
            procedure_name: "reject_mismatch_calibration_fact_mutation",
            trigger_type: 58,
            deferrable: false,
            initially_deferred: false,
            constraint_trigger: false,
          },
        ]
          .filter((trigger) => trigger.trigger_name !== options.omitV10Trigger)
          .map((trigger) => ({
            ...trigger,
            relation_name:
              trigger.trigger_name === options.misplaceV10Trigger ? "wrong_relation" : trigger.relation_name,
            procedure_in_current_schema: true,
            trigger_type: trigger.trigger_name === options.incompatibleV10Trigger ? 0 : trigger.trigger_type,
            has_when_clause: trigger.trigger_name === options.conditionalV10Trigger,
            argument_count: trigger.trigger_name === options.argumentV10Trigger ? 1 : 0,
            enabled: trigger.trigger_name === options.replicaOnlyV10Trigger ? "R" : "O",
          })),
      );
    }
    if (sql.includes("deployment_preflight:mismatch_calibration_state")) {
      return result(
        options.missingCalibrationActivation
          ? []
          : [
              {
                id: 1,
                artifact_id: null,
                revision: 0,
                updated_at: 1,
                schema_version: null,
                base_model_version: null,
                training_started_at: null,
                training_ended_at: null,
                artifact_json: null,
                metrics_json: null,
                artifact_sha256: null,
                created_at: null,
                ...options.calibrationActivationRow,
              },
            ],
      );
    }
    if (sql.includes("deployment_preflight:mismatch_calibration_events")) {
      return result(options.calibrationEvents ?? []);
    }
    if (
      sql.includes("deployment_preflight:live_intents") ||
      sql.includes("deployment_preflight:historical_legacy_exposure") ||
      sql.includes("deployment_preflight:order_attempts") ||
      sql.includes("deployment_preflight:venue_orders") ||
      sql.includes("deployment_preflight:positions")
    ) {
      return result([{ total: 0, sample_ids: [] }]);
    }
    if (sql.includes("deployment_preflight:entry_reservation")) {
      return result([
        {
          row_count: 1,
          canonical_row_count: 1,
          owned_count: 0,
          owner_intent_ids: [],
        },
      ]);
    }
    if (sql.includes("WITH accounting_clock")) {
      return result([
        {
          total: options.accountingBacklogTotal ?? 0,
          missing_heads: 0,
          legacy_pending: 0,
          quarantined: options.accountingBacklogTotal ?? 0,
          terminal_open: 0,
          historical_legacy_pending: 0,
          oldest_intent_id: options.accountingBacklogTotal ? "accounting-intent" : null,
        },
      ]);
    }
    throw new Error(`Unexpected test query: ${sql}`);
  });

  return { query: query as unknown as PgQueryable["query"], queryMock: query };
}

const V10_COLUMN_CATALOG_DEFINITIONS = [
  ["entry_admissions", "mismatch_calibration_artifact_id", "text", false, null],
  ["entry_admissions", "mismatch_calibration_revision", "bigint", true, null],
  ["entry_execution_probes", "probe_key", "text", true, null],
  ["entry_execution_probes", "asset", "text", true, null],
  ["entry_execution_probes", "slot_key", "text", true, null],
  ["entry_execution_probes", "slot_start_ts", "bigint", true, null],
  ["entry_execution_probes", "slot_end_ts", "bigint", true, null],
  ["entry_execution_probes", "combination", "text", true, null],
  ["entry_execution_probes", "probe_kind", "text", true, null],
  ["entry_execution_probes", "target_seconds_remaining", "integer", false, null],
  ["entry_execution_probes", "signal_captured_at", "bigint", true, null],
  ["entry_execution_probes", "rest_started_at", "bigint", true, null],
  ["entry_execution_probes", "rest_captured_at", "bigint", true, null],
  ["entry_execution_probes", "decision", "text", true, null],
  ["entry_execution_probes", "first_rejection_stage", "text", false, null],
  ["entry_execution_probes", "first_rejection_code", "text", false, null],
  ["entry_execution_probes", "strategy_revision", "bigint", true, null],
  ["entry_execution_probes", "global_risk_revision", "bigint", true, null],
  ["entry_execution_probes", "signal_json", "jsonb", true, null],
  ["entry_execution_probes", "rest_json", "jsonb", true, null],
  ["entry_execution_probes", "risk_json", "jsonb", true, null],
  ["entry_execution_probes", "variants_json", "jsonb", true, null],
  ["entry_execution_probes", "evidence_sha256", "text", true, null],
  ["entry_execution_probes", "recorded_at", "bigint", true, null],
  ["mismatch_calibration_artifacts", "id", "text", true, null],
  ["mismatch_calibration_artifacts", "schema_version", "integer", true, null],
  ["mismatch_calibration_artifacts", "base_model_version", "text", true, null],
  ["mismatch_calibration_artifacts", "training_started_at", "bigint", true, null],
  ["mismatch_calibration_artifacts", "training_ended_at", "bigint", true, null],
  ["mismatch_calibration_artifacts", "artifact_json", "jsonb", true, null],
  ["mismatch_calibration_artifacts", "metrics_json", "jsonb", true, null],
  ["mismatch_calibration_artifacts", "artifact_sha256", "text", true, null],
  ["mismatch_calibration_artifacts", "created_at", "bigint", true, null],
  ["mismatch_calibration_activation", "id", "integer", true, null],
  ["mismatch_calibration_activation", "artifact_id", "text", false, null],
  ["mismatch_calibration_activation", "revision", "bigint", true, null],
  ["mismatch_calibration_activation", "updated_at", "bigint", true, null],
  [
    "mismatch_calibration_activation_events",
    "id",
    "bigint",
    true,
    "nextval('mismatch_calibration_activation_events_id_seq'::regclass)",
  ],
  ["mismatch_calibration_activation_events", "request_id", "uuid", true, null],
  ["mismatch_calibration_activation_events", "request_sha256", "text", true, null],
  ["mismatch_calibration_activation_events", "request_json", "jsonb", true, null],
  ["mismatch_calibration_activation_events", "previous_artifact_id", "text", false, null],
  ["mismatch_calibration_activation_events", "artifact_id", "text", false, null],
  ["mismatch_calibration_activation_events", "previous_revision", "bigint", true, null],
  ["mismatch_calibration_activation_events", "revision", "bigint", true, null],
  ["mismatch_calibration_activation_events", "actor", "text", true, null],
  ["mismatch_calibration_activation_events", "reason", "text", true, null],
  ["mismatch_calibration_activation_events", "occurred_at", "bigint", true, null],
  ["mismatch_calibration_activation_events", "recorded_at", "bigint", true, null],
] as const;

function buildV10ColumnCatalogRows() {
  return V10_COLUMN_CATALOG_DEFINITIONS.map(([tableName, columnName, dataType, notNull, defaultExpression]) => ({
    table_name: tableName,
    column_name: columnName,
    data_type: dataType,
    not_null: notNull,
    default_expression: defaultExpression,
    relation_kind: "r",
  }));
}

type V10ConstraintCatalogFixture = {
  constraint_name: string;
  table_name: string;
  constraint_type: "c" | "f" | "p" | "u";
  validated: boolean;
  deferrable: boolean;
  initially_deferred: boolean;
  no_inherit: boolean;
  column_names: string[];
  referenced_table_name: string | null;
  referenced_column_names: string[];
  update_action: string;
  delete_action: string;
  match_type: string;
  check_expression: string | null;
};

const V10_KEY_CONSTRAINT_FIXTURES = [
  ["entry_execution_probes_pkey", "entry_execution_probes", "p", ["probe_key"]],
  ["mismatch_calibration_artifacts_pkey", "mismatch_calibration_artifacts", "p", ["id"]],
  ["mismatch_calibration_artifacts_artifact_sha256_key", "mismatch_calibration_artifacts", "u", ["artifact_sha256"]],
  ["mismatch_calibration_activation_pkey", "mismatch_calibration_activation", "p", ["id"]],
  ["mismatch_calibration_activation_events_pkey", "mismatch_calibration_activation_events", "p", ["id"]],
  [
    "mismatch_calibration_activation_events_request_id_key",
    "mismatch_calibration_activation_events",
    "u",
    ["request_id"],
  ],
  ["mismatch_calibration_activation_events_revision_key", "mismatch_calibration_activation_events", "u", ["revision"]],
] as const;

const V10_FOREIGN_KEY_CONSTRAINT_FIXTURES = [
  ["mismatch_calibration_activation_artifact_id_fkey", "mismatch_calibration_activation", ["artifact_id"]],
  [
    "mismatch_calibration_activation_event_previous_artifact_id_fkey",
    "mismatch_calibration_activation_events",
    ["previous_artifact_id"],
  ],
  [
    "mismatch_calibration_activation_events_artifact_id_fkey",
    "mismatch_calibration_activation_events",
    ["artifact_id"],
  ],
  ["entry_admissions_mismatch_calibration_artifact_id_fkey", "entry_admissions", ["mismatch_calibration_artifact_id"]],
] as const;

const V10_CHECK_CONSTRAINT_FIXTURES = {
  entry_admissions: [
    "mismatch_calibration_revision >= 0",
    "mismatch_calibration_artifact_id IS NULL OR mismatch_calibration_revision > 0",
  ],
  entry_execution_probes: [
    "length(btrim(probe_key)) > 0",
    "asset = ANY (ARRAY['btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'hype'])",
    "length(btrim(slot_key)) > 0",
    "slot_start_ts >= 0",
    "slot_end_ts > slot_start_ts",
    "combination = ANY (ARRAY['POLY_UP_KALSHI_NO', 'POLY_DOWN_KALSHI_YES'])",
    "probe_kind = ANY (ARRAY['candidate_preflight', 'late_probe'])",
    "target_seconds_remaining IS NULL OR target_seconds_remaining = ANY (ARRAY[55, 45, 35, 25, 15, 5])",
    "signal_captured_at >= 0",
    "rest_started_at >= signal_captured_at",
    "rest_captured_at >= rest_started_at",
    "length(btrim(decision)) > 0",
    "first_rejection_stage IS NULL OR first_rejection_stage = ANY (ARRAY['signal', 'base', 'rest', 'risk', 'admission', 'primary', 'hedge', 'settled'])",
    "strategy_revision >= 0",
    "global_risk_revision >= 0",
    "jsonb_typeof(signal_json) = 'object'",
    "jsonb_typeof(rest_json) = 'object'",
    "jsonb_typeof(risk_json) = 'object'",
    "jsonb_typeof(variants_json) = 'array'",
    "evidence_sha256 ~ '^[0-9a-f]{64}$'",
    "recorded_at >= rest_captured_at",
    "(probe_kind = 'late_probe' AND target_seconds_remaining IS NOT NULL) OR (probe_kind = 'candidate_preflight' AND target_seconds_remaining IS NULL)",
  ],
  mismatch_calibration_artifacts: [
    "length(btrim(id)) > 0",
    "schema_version > 0",
    "length(btrim(base_model_version)) > 0",
    "training_started_at >= 0",
    "training_ended_at >= training_started_at",
    "jsonb_typeof(artifact_json) = 'object'",
    "jsonb_typeof(metrics_json) = 'object'",
    "artifact_sha256 ~ '^[0-9a-f]{64}$'",
    "created_at >= training_ended_at",
  ],
  mismatch_calibration_activation: ["id = 1", "revision >= 0", "updated_at >= 0"],
  mismatch_calibration_activation_events: [
    "request_sha256 ~ '^[0-9a-f]{64}$'",
    "jsonb_typeof(request_json) = 'object'",
    "previous_revision >= 0",
    "revision = previous_revision + 1",
    "length(btrim(actor)) > 0",
    "length(btrim(reason)) > 0",
    "occurred_at >= 0",
    "recorded_at >= occurred_at",
  ],
} as const;

function buildV10ConstraintCatalogRows(): V10ConstraintCatalogFixture[] {
  const common = {
    validated: true,
    deferrable: false,
    initially_deferred: false,
    no_inherit: false,
    referenced_table_name: null,
    referenced_column_names: [] as string[],
    update_action: " ",
    delete_action: " ",
    match_type: " ",
    check_expression: null,
  };
  const keys: V10ConstraintCatalogFixture[] = V10_KEY_CONSTRAINT_FIXTURES.map(
    ([constraintName, tableName, constraintType, columnNames]) => ({
      ...common,
      constraint_name: constraintName,
      table_name: tableName,
      constraint_type: constraintType,
      column_names: [...columnNames],
    }),
  );
  const foreignKeys: V10ConstraintCatalogFixture[] = V10_FOREIGN_KEY_CONSTRAINT_FIXTURES.map(
    ([constraintName, tableName, columnNames]) => ({
      ...common,
      constraint_name: constraintName,
      table_name: tableName,
      constraint_type: "f",
      column_names: [...columnNames],
      referenced_table_name: "mismatch_calibration_artifacts",
      referenced_column_names: ["id"],
      update_action: "a",
      delete_action: "r",
      match_type: "s",
    }),
  );
  const checks: V10ConstraintCatalogFixture[] = Object.entries(V10_CHECK_CONSTRAINT_FIXTURES).flatMap(
    ([tableName, expressions]) =>
      expressions.map((expression, index) => ({
        ...common,
        constraint_name: `${tableName}_check_${index}`,
        table_name: tableName,
        constraint_type: "c",
        column_names: [],
        check_expression: expression,
      })),
  );
  return [...keys, ...foreignKeys, ...checks];
}

function buildV10ProbeIndexCatalogRows() {
  return [
    {
      index_name: "entry_execution_probes_asset_slot_idx",
      column_names: ["asset", "slot_key", "rest_captured_at"],
      descending: [false, false, true],
      nulls_first: [false, false, true],
    },
    {
      index_name: "entry_execution_probes_asset_captured_idx",
      column_names: ["asset", "rest_captured_at", "probe_key"],
      descending: [false, true, false],
      nulls_first: [false, true, false],
    },
    {
      index_name: "entry_execution_probes_captured_idx",
      column_names: ["rest_captured_at"],
      descending: [true],
      nulls_first: [true],
    },
    {
      index_name: "entry_execution_probes_funnel_idx",
      column_names: ["first_rejection_stage", "first_rejection_code", "rest_captured_at"],
      descending: [false, false, true],
      nulls_first: [false, false, true],
    },
  ].map((index) => ({
    ...index,
    table_name: "entry_execution_probes",
    access_method: "btree",
    unique_index: false,
    valid: true,
    ready: true,
    live: true,
    has_predicate: false,
    has_expressions: false,
  }));
}

function buildV10ProcedureCatalogRows() {
  return V10_PROCEDURE_NAMES.map((procedureName) => ({
    procedure_name: procedureName,
    language_name: "plpgsql",
    result_type: "trigger",
    identity_arguments: "",
    security_definer: false,
    volatility: "v",
    strict: false,
    leakproof: false,
    parallel_safety: "u",
    body: readMigrationProcedureBody(procedureName),
  }));
}

function readMigrationProcedureBody(procedureName: string) {
  const functionStart = POSTGRES_DB_SOURCE.indexOf(`CREATE FUNCTION ${procedureName}()`);
  const bodyMarker = "AS $migration$";
  const bodyStart = POSTGRES_DB_SOURCE.indexOf(bodyMarker, functionStart) + bodyMarker.length;
  const bodyEnd = POSTGRES_DB_SOURCE.indexOf("$migration$;", bodyStart);
  if (functionStart < 0 || bodyStart < bodyMarker.length || bodyEnd < 0) {
    throw new Error(`Could not find migration body for ${procedureName}`);
  }
  return POSTGRES_DB_SOURCE.slice(bodyStart, bodyEnd);
}

function result<R extends QueryResultRow>(rows: R[]) {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as QueryResult<R>;
}

function latestSchemaVersion() {
  return DATABASE_MIGRATIONS.at(-1)?.version ?? 0;
}

function indexesOf(value: string, search: string) {
  const indexes: number[] = [];
  let offset = 0;
  while ((offset = value.indexOf(search, offset)) !== -1) {
    indexes.push(offset);
    offset += search.length;
  }
  return indexes;
}
