import { createHash } from "node:crypto";

import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

const MIGRATION_LOCK_NAMESPACE = 4_298;
const MIGRATION_LOCK_KEY = 1;
const SCHEMA_MIGRATIONS_TABLE = "schema_migrations";

export interface PgQueryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export interface DatabaseMigration {
  version: number;
  name: string;
  checksum: string;
  up: (db: PgQueryable) => Promise<void>;
}

export interface AppliedDatabaseMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: number;
}

export interface DatabaseMigrationStatus {
  ready: boolean;
  initialized: boolean;
  currentVersion: number;
  requiredVersion: number;
  applied: AppliedDatabaseMigration[];
  pending: Array<Pick<DatabaseMigration, "version" | "name" | "checksum">>;
  problems: string[];
}

export class DatabaseSchemaCompatibilityError extends Error {
  constructor(readonly status: DatabaseMigrationStatus) {
    const details = status.problems.length > 0 ? status.problems.join("; ") : "schema migration required";
    super(`Postgres schema incompatible: ${details}. Run npm run db:migrate before starting Warbitrer.`);
    this.name = "DatabaseSchemaCompatibilityError";
  }
}

export function checksumMigrationPayload(payload: string) {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export async function getDatabaseMigrationStatus(
  db: PgQueryable,
  migrations: readonly DatabaseMigration[],
): Promise<DatabaseMigrationStatus> {
  validateMigrationRegistry(migrations);

  const tableResult = await db.query<{ table_name: string | null }>("SELECT to_regclass($1) AS table_name", [
    SCHEMA_MIGRATIONS_TABLE,
  ]);
  const initialized = tableResult.rows[0]?.table_name !== null && tableResult.rows[0]?.table_name !== undefined;
  const applied = initialized ? await readAppliedMigrations(db) : [];
  return buildMigrationStatus(migrations, applied, initialized);
}

export async function assertDatabaseSchemaCompatible(db: PgQueryable, migrations: readonly DatabaseMigration[]) {
  const status = await getDatabaseMigrationStatus(db, migrations);
  if (!status.ready) {
    throw new DatabaseSchemaCompatibilityError(status);
  }
  return status;
}

export async function runDatabaseMigrations(
  pool: Pick<Pool, "connect">,
  migrations: readonly DatabaseMigration[],
): Promise<DatabaseMigrationStatus> {
  validateMigrationRegistry(migrations);
  const client = await pool.connect();

  try {
    await acquireMigrationLock(client);
    await client.query("BEGIN");

    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY CHECK (version > 0),
          name TEXT NOT NULL,
          checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
          applied_at BIGINT NOT NULL
        )
      `);

      const applied = await readAppliedMigrations(client);
      const before = buildMigrationStatus(migrations, applied, true);
      const blockingProblems = before.problems.filter((problem) => !problem.startsWith("pending migration "));
      if (blockingProblems.length > 0) {
        throw new DatabaseSchemaCompatibilityError({ ...before, problems: blockingProblems });
      }

      const appliedVersions = new Set(applied.map((migration) => migration.version));
      for (const migration of migrations) {
        if (appliedVersions.has(migration.version)) {
          continue;
        }

        await migration.up(client);
        await client.query(
          `
            INSERT INTO schema_migrations (version, name, checksum, applied_at)
            VALUES ($1, $2, $3, $4)
          `,
          [migration.version, migration.name, migration.checksum, Date.now()],
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    }

    return await getDatabaseMigrationStatus(client, migrations);
  } finally {
    await releaseMigrationLock(client);
    client.release();
  }
}

export function buildMigrationStatus(
  migrations: readonly DatabaseMigration[],
  applied: readonly AppliedDatabaseMigration[],
  initialized = true,
): DatabaseMigrationStatus {
  validateMigrationRegistry(migrations);
  const expectedByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const appliedByVersion = new Map(applied.map((migration) => [migration.version, migration]));
  const problems: string[] = [];

  if (!initialized) {
    problems.push("schema_migrations table is missing");
  }

  for (const migration of applied) {
    const expected = expectedByVersion.get(migration.version);
    if (!expected) {
      problems.push(`database has unknown migration ${migration.version}:${migration.name}`);
      continue;
    }
    if (migration.name !== expected.name) {
      problems.push(`migration ${migration.version} name mismatch (database=${migration.name}, code=${expected.name})`);
    }
    if (migration.checksum !== expected.checksum) {
      problems.push(`migration ${migration.version}:${expected.name} checksum mismatch`);
    }
  }

  const appliedVersions = new Set(applied.map((migration) => migration.version));
  for (const migration of migrations) {
    if (!appliedVersions.has(migration.version)) {
      const laterApplied = applied.find((candidate) => candidate.version > migration.version);
      if (laterApplied) {
        problems.push(
          `migration history gap: ${migration.version}:${migration.name} is missing before applied migration ${laterApplied.version}:${laterApplied.name}`,
        );
      }
    }
  }

  const pending = migrations
    .filter((migration) => !appliedByVersion.has(migration.version))
    .map(({ version, name, checksum }) => ({ version, name, checksum }));
  for (const migration of pending) {
    problems.push(`pending migration ${migration.version}:${migration.name}`);
  }

  const currentVersion = applied.reduce((maximum, migration) => Math.max(maximum, migration.version), 0);
  const requiredVersion = migrations.at(-1)?.version ?? 0;

  return {
    ready: initialized && problems.length === 0,
    initialized,
    currentVersion,
    requiredVersion,
    applied: [...applied],
    pending,
    problems,
  };
}

function validateMigrationRegistry(migrations: readonly DatabaseMigration[]) {
  let previousVersion = 0;
  const names = new Set<string>();

  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= previousVersion) {
      throw new Error("Database migrations must have strictly increasing positive integer versions");
    }
    if (!migration.name || names.has(migration.name)) {
      throw new Error(`Database migration name must be non-empty and unique: ${migration.name || "<empty>"}`);
    }
    if (!/^[0-9a-f]{64}$/.test(migration.checksum)) {
      throw new Error(`Database migration ${migration.version}:${migration.name} has an invalid SHA-256 checksum`);
    }
    previousVersion = migration.version;
    names.add(migration.name);
  }
}

async function readAppliedMigrations(db: PgQueryable): Promise<AppliedDatabaseMigration[]> {
  const result = await db.query<{
    version: number;
    name: string;
    checksum: string;
    applied_at: number;
  }>(
    `
      SELECT version, name, checksum, applied_at
      FROM schema_migrations
      ORDER BY version ASC
    `,
  );
  return result.rows.map((row) => ({
    version: Number(row.version),
    name: row.name,
    checksum: row.checksum,
    appliedAt: Number(row.applied_at),
  }));
}

async function acquireMigrationLock(client: PoolClient) {
  await client.query("SELECT pg_advisory_lock($1, $2)", [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY]);
}

async function releaseMigrationLock(client: PoolClient) {
  try {
    await client.query("SELECT pg_advisory_unlock($1, $2)", [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY]);
  } catch {
    // The connection will be discarded by pg if it is no longer usable.
  }
}

async function rollbackQuietly(client: PoolClient) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the migration error; pg will discard a broken connection.
  }
}
