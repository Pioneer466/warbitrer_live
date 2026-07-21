import { Pool } from "pg";

import { assertDeploymentLiveGateDisabled } from "@/lib/deployment-preflight";
import { repairLegacyV8Preconditions } from "@/lib/legacy-v8-repair";

async function main() {
  assertDeploymentLiveGateDisabled();
  const options = parseOptions(process.argv.slice(2));
  const pool = new Pool({
    connectionString: requireDatabaseUrl(),
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  try {
    const summary = await repairLegacyV8Preconditions(pool, options);
    console.log(summary.applied ? "Legacy V8 precondition repair committed." : "Legacy V8 repair dry-run rolled back.");
    console.log(`Fill asset rows: ${summary.fillAssetRows}`);
    console.log(`Venue order rows: ${summary.venueOrderRows}`);
    console.log(`Durable audit rows: ${summary.auditRows}`);
  } finally {
    await pool.end();
  }
}

function parseOptions(args: readonly string[]) {
  const apply = args.includes("--apply");
  if (args.includes("--dry-run") && apply) {
    throw new Error("Choose either --dry-run or --apply");
  }
  return {
    apply,
    expected: {
      fillAssetRows: readExpectedCount(args, "--expect-fill-assets"),
      venueOrderRows: readExpectedCount(args, "--expect-venue-orders"),
    },
  };
}

function readExpectedCount(args: readonly string[], flag: string) {
  const index = args.indexOf(flag);
  const raw = index >= 0 ? args[index + 1] : undefined;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} requires a non-negative integer`);
  }
  return parsed;
}

function requireDatabaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error("DATABASE_URL is required for the legacy V8 repair");
  }
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
