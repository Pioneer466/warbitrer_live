import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import {
  checksumMigrationPayload,
  DatabaseSchemaCompatibilityError,
  getDatabaseMigrationStatus,
  runDatabaseMigrations,
  type DatabaseMigration,
} from "@/lib/db-migrations";
import { DATABASE_MIGRATIONS, getPostgresMigrationStatus, migratePostgresDatabase } from "@/lib/postgres-db";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres("Postgres migrations", () => {
  it("migrates a fresh database and reruns without replacing persisted data", async () => {
    await withIsolatedSchema(async (pool) => {
      const first = await migratePostgresDatabase(pool);
      expect(first).toMatchObject({
        ready: true,
        currentVersion: DATABASE_MIGRATIONS.at(-1)?.version,
        requiredVersion: DATABASE_MIGRATIONS.at(-1)?.version,
      });

      const customPayload = { marker: "preserve-me" };
      await pool.query(
        `
          INSERT INTO run_events (asset, level, event_type, message, payload_json, created_at)
          VALUES ('btc', 'info', 'migration_test', 'preserve', $1::jsonb, 1)
        `,
        [JSON.stringify(customPayload)],
      );

      const second = await migratePostgresDatabase(pool);
      const event = await pool.query<{ payload_json: Record<string, string> }>(
        "SELECT payload_json FROM run_events WHERE event_type = 'migration_test'",
      );
      const strategyCount = await pool.query<{ total: string }>("SELECT count(*) AS total FROM strategy_configs");

      expect(second.ready).toBe(true);
      expect(event.rows[0]?.payload_json).toEqual(customPayload);
      expect(Number(strategyCount.rows[0]?.total)).toBe(7);
    });
  }, 30_000);

  it("upgrades a legacy database without overwriting its strategy row", async () => {
    await withIsolatedSchema(async (pool) => {
      const legacyPayload = {
        enableTrading: false,
        shadowMode: true,
        maxPairNotionalUsd: 17,
      };
      await pool.query(`
        CREATE TABLE strategy_config (
          id INTEGER PRIMARY KEY,
          payload JSONB NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `);
      await pool.query("INSERT INTO strategy_config (id, payload, updated_at) VALUES (1, $1::jsonb, 123)", [
        JSON.stringify(legacyPayload),
      ]);

      await migratePostgresDatabase(pool);

      const legacy = await pool.query<{ payload: Record<string, unknown>; updated_at: string }>(
        "SELECT payload, updated_at FROM strategy_config WHERE id = 1",
      );
      const btc = await pool.query<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM strategy_configs WHERE asset = 'btc'",
      );
      expect(legacy.rows[0]).toEqual({ payload: legacyPayload, updated_at: 123 });
      expect(btc.rows[0]?.payload).toMatchObject({
        enableTrading: false,
        shadowMode: true,
        maxPairNotionalUsd: 17,
      });
    });
  }, 30_000);

  it("upgrades an existing V9 entry admission to the V10 calibration binding", async () => {
    await withIsolatedSchema(async (pool) => {
      const v9Migrations = DATABASE_MIGRATIONS.filter((migration) => migration.version <= 9);
      const v9Status = await runDatabaseMigrations(pool, v9Migrations);
      const v9History = await pool.query<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version");

      expect(v9Status).toMatchObject({ ready: true, currentVersion: 9, requiredVersion: 9 });
      expect(v9History.rows.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

      await pool.query(`
        INSERT INTO order_intents (
          id, asset, shadow, slot_key, slot_start_ts, slot_end_ts, combination, status,
          created_at, updated_at, primary_venue, hedge_venue, gross_cost,
          target_notional_usd, max_slippage_bps, legs_json
        ) VALUES (
          'v9-existing-admission-intent', 'btc', true, 'btc:v9-existing-admission',
          1, 901000, 'POLY_UP_KALSHI_NO', 'pending', 1, 1,
          'polymarket', 'kalshi', 0.9, 9, 30, '[]'::jsonb
        )
      `);
      await pool.query(`
        INSERT INTO entry_admissions (
          id, intent_id, mode, asset, slot_key, combination, gross_cost,
          strategy_revision, global_risk_revision, policy_evaluated_at,
          evidence_json, authorized_at
        ) VALUES (
          'v9-existing-admission', 'v9-existing-admission-intent', 'shadow', 'btc',
          'btc:v9-existing-admission', 'POLY_UP_KALSHI_NO', 0.9,
          0, 0, 1, '{"source":"v9-integration"}'::jsonb, 1
        )
      `);

      const v10Status = await migratePostgresDatabase(pool);
      const migratedAdmission = await pool.query<{
        id: string;
        mismatch_calibration_artifact_id: string | null;
        mismatch_calibration_revision: number;
      }>(`
        SELECT
          id,
          mismatch_calibration_artifact_id,
          mismatch_calibration_revision::integer AS mismatch_calibration_revision
        FROM entry_admissions
        WHERE id = 'v9-existing-admission'
      `);
      const latestMigration = await pool.query<{ version: number; name: string }>(
        "SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1",
      );

      expect(v10Status).toMatchObject({ ready: true, currentVersion: 10, requiredVersion: 10 });
      expect(migratedAdmission.rows).toEqual([
        {
          id: "v9-existing-admission",
          mismatch_calibration_artifact_id: null,
          mismatch_calibration_revision: 0,
        },
      ]);
      expect(latestMigration.rows).toEqual([{ version: 10, name: "mismatch_calibration_evidence" }]);
    });
  }, 30_000);

  it("serializes concurrent runners and applies each migration once", async () => {
    await withIsolatedSchema(async (pool, schema) => {
      const secondPool = createScopedPool(schema);
      const migration = buildProbeMigration("concurrent", async (db) => {
        await db.query("SELECT pg_sleep(0.05)");
        await db.query("CREATE TABLE concurrency_probe (id INTEGER PRIMARY KEY)");
        await db.query("INSERT INTO concurrency_probe (id) VALUES (1)");
      });

      try {
        const [first, second] = await Promise.all([
          runDatabaseMigrations(pool, [migration]),
          runDatabaseMigrations(secondPool, [migration]),
        ]);
        const count = await pool.query<{ total: string }>("SELECT count(*) AS total FROM concurrency_probe");

        expect(first.ready).toBe(true);
        expect(second.ready).toBe(true);
        expect(Number(count.rows[0]?.total)).toBe(1);
      } finally {
        await secondPool.end();
      }
    });
  }, 30_000);

  it("rolls back metadata and schema changes when a migration fails", async () => {
    await withIsolatedSchema(async (pool) => {
      const migration = buildProbeMigration("rollback", async (db) => {
        await db.query("CREATE TABLE rollback_probe (id INTEGER PRIMARY KEY)");
        throw new Error("intentional migration failure");
      });

      await expect(runDatabaseMigrations(pool, [migration])).rejects.toThrow("intentional migration failure");

      const relations = await pool.query<{ migrations: string | null; probe: string | null }>(
        "SELECT to_regclass('schema_migrations') AS migrations, to_regclass('rollback_probe') AS probe",
      );
      expect(relations.rows[0]).toEqual({ migrations: null, probe: null });
    });
  }, 30_000);

  it("refuses a checksum change without altering recorded history", async () => {
    await withIsolatedSchema(async (pool) => {
      const original = buildProbeMigration("checksum-original", async (db) => {
        await db.query("CREATE TABLE checksum_probe (id INTEGER PRIMARY KEY)");
      });
      await runDatabaseMigrations(pool, [original]);

      const changed: DatabaseMigration = {
        ...original,
        checksum: checksumMigrationPayload("checksum-changed"),
      };
      await expect(runDatabaseMigrations(pool, [changed])).rejects.toBeInstanceOf(DatabaseSchemaCompatibilityError);

      const recorded = await pool.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE version = 1",
      );
      expect(recorded.rows[0]?.checksum).toBe(original.checksum);
      await expect(getDatabaseMigrationStatus(pool, [original])).resolves.toMatchObject({ ready: true });
    });
  }, 30_000);

  it("reports the production registry through the read-only status path", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await expect(getPostgresMigrationStatus(pool)).resolves.toMatchObject({
        ready: true,
        pending: [],
        problems: [],
      });
    });
  }, 30_000);
});

function buildProbeMigration(name: string, up: DatabaseMigration["up"]): DatabaseMigration {
  return {
    version: 1,
    name,
    checksum: checksumMigrationPayload(name),
    up,
  };
}

async function withIsolatedSchema(run: (pool: Pool, schema: string) => Promise<void>) {
  if (!TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  const schema = `warbitrer_migration_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = createScopedPool(schema);

  try {
    await run(pool, schema);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

function createScopedPool(schema: string) {
  return new Pool({
    connectionString: TEST_DATABASE_URL,
    max: 3,
    options: `-c search_path=${schema}`,
  });
}
