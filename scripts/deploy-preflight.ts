import { Pool, type PoolClient } from "pg";

import {
  assertDeploymentLiveGateDisabled,
  assertDeploymentPreflight,
  collectDeploymentPreflightSnapshot,
} from "@/lib/deployment-preflight";

async function main() {
  assertDeploymentLiveGateDisabled();
  const pool = new Pool({
    connectionString: requireDatabaseUrl(),
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  let client: PoolClient | null = null;

  try {
    client = await pool.connect();
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshot = await collectDeploymentPreflightSnapshot(client);
    assertDeploymentPreflight(snapshot);
    await client.query("COMMIT");

    console.log(`Deployment preflight passed on schema V${snapshot.schemaVersion}.`);
    console.log("LIVE_EXECUTION_ALLOWED: disabled");
    console.log("Live intents or exposure: 0");
    console.log("Unresolved live order attempts: 0");
    console.log("Open live venue orders: 0");
    console.log("Economically active live positions: 0");
    console.log(
      snapshot.liveReservation
        ? "Owned live entry reservations: 0"
        : "Owned live entry reservations: not present before schema V4",
    );
    console.log(
      snapshot.accountingBacklog
        ? `Blocking live accounting defects: ${snapshot.accountingBacklog.total} (missing-head=${snapshot.accountingBacklog.missingHeads}, legacy=${snapshot.accountingBacklog.legacyPending}, quarantined=${snapshot.accountingBacklog.quarantined}, terminal-open=${snapshot.accountingBacklog.terminalOpen})`
        : "Blocking live accounting heads: not present before schema V7",
    );
  } catch (error) {
    if (client) {
      await rollbackQuietly(client);
    }
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

function requireDatabaseUrl() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for the deployment preflight");
  }
  return connectionString;
}

async function rollbackQuietly(client: PoolClient) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the preflight error; pg will discard an unusable connection.
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
