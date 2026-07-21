import { readFileSync } from "node:fs";

import type { Pool, PoolClient, QueryResult } from "pg";

import {
  assertDatabaseSchemaCompatible,
  buildMigrationStatus,
  checksumMigrationPayload,
  DatabaseSchemaCompatibilityError,
  getDatabaseMigrationStatus,
  runDatabaseMigrations,
  type AppliedDatabaseMigration,
  type DatabaseMigration,
} from "@/lib/db-migrations";
import { DATABASE_MIGRATIONS, resolvePgPoolMax } from "@/lib/postgres-db";

const checksum = checksumMigrationPayload("migration-1");

function migration(overrides: Partial<DatabaseMigration> = {}): DatabaseMigration {
  return {
    version: 1,
    name: "baseline",
    checksum,
    up: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function queryResult<T extends Record<string, unknown>>(rows: T[]): QueryResult<T> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

describe("database migration status", () => {
  it("binds the frozen baseline checksum to its exact source payload", () => {
    const source = readFileSync(new URL("../src/lib/postgres-db.ts", import.meta.url), "utf8");
    expect(migrationSourceChecksum(source, 1)).toBe(DATABASE_MIGRATIONS[0]?.checksum);
  });

  it("binds the order-truth migration checksum to its exact source payload", () => {
    const source = readFileSync(new URL("../src/lib/postgres-db.ts", import.meta.url), "utf8");
    expect(migrationSourceChecksum(source, 2)).toBe(DATABASE_MIGRATIONS[1]?.checksum);
  });

  it("binds the configuration revision migration checksum to its exact source payload", () => {
    const source = readFileSync(new URL("../src/lib/postgres-db.ts", import.meta.url), "utf8");
    expect(migrationSourceChecksum(source, 3)).toBe(DATABASE_MIGRATIONS[2]?.checksum);
  });

  it("binds the entry admission migration checksum to its exact source payload", () => {
    const source = readFileSync(new URL("../src/lib/postgres-db.ts", import.meta.url), "utf8");
    expect(migrationSourceChecksum(source, 4)).toBe(DATABASE_MIGRATIONS[3]?.checksum);
  });

  it("binds the circuit-breaker incident migration checksum to its exact source payload", () => {
    const source = readFileSync(new URL("../src/lib/postgres-db.ts", import.meta.url), "utf8");
    const migration = DATABASE_MIGRATIONS.find((candidate) => candidate.version === 5);
    expect(migrationSourceChecksum(source, 5)).toBe(migration?.checksum);
  });

  it("binds the order-attempt submission deadline checksum to its exact source payload", () => {
    const source = readFileSync(new URL("../src/lib/postgres-db.ts", import.meta.url), "utf8");
    const migration = DATABASE_MIGRATIONS.find((candidate) => candidate.version === 6);
    expect(migrationSourceChecksum(source, 6)).toBe(migration?.checksum);
  });

  it("binds the accounting ledger checksum to its exact source payload", () => {
    const source = readFileSync(new URL("../src/lib/postgres-db.ts", import.meta.url), "utf8");
    const migration = DATABASE_MIGRATIONS.find((candidate) => candidate.version === 7);
    expect(migrationSourceChecksum(source, 7)).toBe(migration?.checksum);
  });

  it("binds the accounting evidence hardening checksum to its exact source payload", () => {
    const source = readFileSync(new URL("../src/lib/postgres-db.ts", import.meta.url), "utf8");
    const migration = DATABASE_MIGRATIONS.find((candidate) => candidate.version === 8);
    expect(migrationSourceChecksum(source, 8)).toBe(migration?.checksum);
  });

  it("reports an uninitialized database as pending and incompatible", async () => {
    const db = {
      query: vi.fn().mockResolvedValue(queryResult([{ table_name: null }])),
    };

    const status = await getDatabaseMigrationStatus(db, [migration()]);

    expect(status).toMatchObject({
      ready: false,
      initialized: false,
      currentVersion: 0,
      requiredVersion: 1,
      pending: [{ version: 1, name: "baseline", checksum }],
    });
    expect(status.problems).toContain("schema_migrations table is missing");
  });

  it("rejects changed checksums and unknown newer migrations", async () => {
    const applied: AppliedDatabaseMigration[] = [
      { version: 1, name: "baseline", checksum: "0".repeat(64), appliedAt: 1 },
      { version: 2, name: "future", checksum: "1".repeat(64), appliedAt: 2 },
    ];

    const status = buildMigrationStatus([migration()], applied);

    expect(status.ready).toBe(false);
    expect(status.problems).toEqual([
      "migration 1:baseline checksum mismatch",
      "database has unknown migration 2:future",
    ]);
  });

  it("rejects a non-contiguous applied history", () => {
    const second = migration({
      version: 2,
      name: "second",
      checksum: checksumMigrationPayload("migration-2"),
    });
    const status = buildMigrationStatus(
      [migration(), second],
      [{ version: 2, name: second.name, checksum: second.checksum, appliedAt: 2 }],
    );

    expect(status.ready).toBe(false);
    expect(status.problems).toContain("migration history gap: 1:baseline is missing before applied migration 2:second");
  });

  it("accepts only the exact known migration history", async () => {
    const applied = [{ version: 1, name: "baseline", checksum, applied_at: 123 }];
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce(queryResult([{ table_name: "schema_migrations" }]))
        .mockResolvedValueOnce(queryResult(applied)),
    };

    await expect(assertDatabaseSchemaCompatible(db, [migration()])).resolves.toMatchObject({
      ready: true,
      currentVersion: 1,
      requiredVersion: 1,
    });
    expect(db.query.mock.calls.every(([sql]) => !/\b(?:CREATE|ALTER|DROP|TRUNCATE)\b/i.test(String(sql)))).toBe(true);
  });

  it("throws an actionable error when runtime compatibility is not proven", async () => {
    const db = {
      query: vi.fn().mockResolvedValue(queryResult([{ table_name: null }])),
    };

    await expect(assertDatabaseSchemaCompatible(db, [migration()])).rejects.toThrow(/Run npm run db:migrate/);
  });
});

function migrationSourceChecksum(source: string, version: number) {
  const start = source.indexOf(`/* migration-checksum:start:${version} */`);
  const endMarker = `/* migration-checksum:end:${version} */`;
  const endMarkerStart = source.indexOf(endMarker);
  const end = source.indexOf("\n", endMarkerStart) + 1;

  expect(start).toBeGreaterThanOrEqual(0);
  expect(endMarkerStart).toBeGreaterThan(start);
  expect(end).toBeGreaterThan(endMarkerStart);
  return checksumMigrationPayload(source.slice(start, end));
}

describe("database migration runner", () => {
  it("uses one locked PoolClient for metadata and migration queries", async () => {
    const applied: Array<{ version: number; name: string; checksum: string; applied_at: number }> = [];
    const query = vi.fn(async (sqlValue: string, values?: unknown[]) => {
      const sql = String(sqlValue);
      if (sql.includes("SELECT version, name, checksum, applied_at")) {
        return queryResult(applied);
      }
      if (sql.includes("INSERT INTO schema_migrations")) {
        applied.push({
          version: Number(values?.[0]),
          name: String(values?.[1]),
          checksum: String(values?.[2]),
          applied_at: Number(values?.[3]),
        });
        return queryResult([]);
      }
      if (sql.includes("to_regclass")) {
        return queryResult([{ table_name: "schema_migrations" }]);
      }
      return queryResult([]);
    });
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const poolQuery = vi.fn();
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: poolQuery,
    } as unknown as Pool;
    const up = vi.fn(async (db) => {
      expect(db).toBe(client);
      await db.query("SELECT 'migration query'");
    });

    const status = await runDatabaseMigrations(pool, [migration({ up })]);

    expect(status.ready).toBe(true);
    expect(up).toHaveBeenCalledTimes(1);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    const statements = query.mock.calls.map(([sql]) => String(sql).trim());
    expect(statements[0]).toBe("SELECT pg_advisory_lock($1, $2)");
    expect(statements).toContain("BEGIN");
    expect(statements).toContain("SELECT 'migration query'");
    expect(statements).toContain("COMMIT");
    expect(statements.at(-1)).toBe("SELECT pg_advisory_unlock($1, $2)");
  });

  it("rolls back, unlocks, and releases when a migration fails", async () => {
    const query = vi.fn(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes("SELECT version, name, checksum, applied_at")) {
        return queryResult([]);
      }
      return queryResult([]);
    });
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    const expected = new Error("migration failed");

    await expect(runDatabaseMigrations(pool, [migration({ up: vi.fn().mockRejectedValue(expected) })])).rejects.toBe(
      expected,
    );

    const statements = query.mock.calls.map(([sql]) => String(sql).trim());
    expect(statements).toContain("ROLLBACK");
    expect(statements.at(-1)).toBe("SELECT pg_advisory_unlock($1, $2)");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("refuses to run when the recorded checksum changed", async () => {
    const applied = [{ version: 1, name: "baseline", checksum: "f".repeat(64), applied_at: 123 }];
    const query = vi.fn(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes("SELECT version, name, checksum, applied_at")) {
        return queryResult(applied);
      }
      return queryResult([]);
    });
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;

    await expect(runDatabaseMigrations(pool, [migration()])).rejects.toBeInstanceOf(DatabaseSchemaCompatibilityError);
    expect(query.mock.calls.map(([sql]) => String(sql).trim())).toContain("ROLLBACK");
  });
});

describe("Postgres pool sizing", () => {
  it("keeps a minimum of two connections available for advisory-lock callbacks", () => {
    expect(resolvePgPoolMax(undefined)).toBe(3);
    expect(resolvePgPoolMax("2")).toBe(2);
    expect(resolvePgPoolMax("8")).toBe(8);
    expect(resolvePgPoolMax("99")).toBe(50);
  });

  it.each(["0", "1", "1.9"])("rejects unsafe PG_POOL_MAX=%s", (value) => {
    expect(() => resolvePgPoolMax(value)).toThrow(/PG_POOL_MAX/);
  });

  it.each(["not-a-number", "Infinity", "3.5"])("rejects invalid PG_POOL_MAX=%s", (value) => {
    expect(() => resolvePgPoolMax(value)).toThrow(/entier/);
  });
});
