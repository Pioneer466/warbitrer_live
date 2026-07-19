import { Pool } from "pg";

import { migratePostgresDatabase, resolvePgPoolMax } from "@/lib/postgres-db";

async function main() {
  const connectionString = requireDatabaseUrl();
  const pool = new Pool({
    connectionString,
    max: resolvePgPoolMax(),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  try {
    const status = await migratePostgresDatabase(pool);
    console.log(
      `Postgres schema ready at version ${status.currentVersion}/${status.requiredVersion} (${status.applied.length} migration(s)).`,
    );
  } finally {
    await pool.end();
  }
}

function requireDatabaseUrl() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL est requis; chargez le fichier d'environnement avant db:migrate");
  }
  return connectionString;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
