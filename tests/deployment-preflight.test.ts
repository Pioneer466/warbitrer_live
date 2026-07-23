import { readFileSync } from "node:fs";

import type { QueryResult, QueryResultRow } from "pg";

import type { PgQueryable } from "@/lib/db-migrations";
import { DATABASE_MIGRATIONS } from "@/lib/postgres-db";
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

function buildQueryable(options: {
  schemaVersion: number;
  initialized?: boolean;
  omitMigrationVersion?: number;
  omitColumn?: string;
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
      };
      return result(
        Object.entries(required).flatMap(([tableName, columnNames]) =>
          columnNames
            .filter((columnName) => `${tableName}.${columnName}` !== options.omitColumn)
            .map((columnName) => ({ table_name: tableName, column_name: columnName })),
        ),
      );
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
