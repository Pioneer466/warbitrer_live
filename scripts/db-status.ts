import { Pool } from "pg";

import { getPostgresMigrationStatus, resolvePgPoolMax } from "@/lib/postgres-db";

async function main() {
  const connectionString = requireDatabaseUrl();
  const pool = new Pool({
    connectionString,
    max: resolvePgPoolMax(),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  try {
    const status = await getPostgresMigrationStatus(pool);
    console.log(`Postgres schema: ${status.ready ? "ready" : "not ready"}`);
    console.log(`Version: ${status.currentVersion}/${status.requiredVersion}`);

    for (const migration of status.applied) {
      console.log(`applied ${migration.version} ${migration.name} ${migration.checksum}`);
    }
    for (const migration of status.pending) {
      console.log(`pending ${migration.version} ${migration.name} ${migration.checksum}`);
    }
    for (const problem of status.problems) {
      console.error(`problem: ${problem}`);
    }

    if (!status.ready) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

function requireDatabaseUrl() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL est requis; chargez le fichier d'environnement avant db:status");
  }
  return connectionString;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
