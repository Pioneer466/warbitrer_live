import fs from "node:fs";

import { readCircuitBreakers, writeCircuitBreaker } from "@/lib/storage";

const DEFAULT_ENV_PATH = process.env.WARBITRER_ENV_PATH || "/etc/warbitrer/warbitrer.env";

async function main() {
  ensureDatabaseUrl();

  const breakers = await readCircuitBreakers();
  const activeHedgeFailureBreakers = breakers.filter(
    (breaker) => breaker.active && breaker.reason === "hedge_failure" && (breaker.key === "global" || breaker.key.startsWith("slot:")),
  );

  if (activeHedgeFailureBreakers.length === 0) {
    console.log("No active hedge_failure breakers found.");
    return;
  }

  for (const breaker of activeHedgeFailureBreakers) {
    await writeCircuitBreaker({
      key: breaker.key,
      active: false,
      reason: null,
      triggeredAt: null,
      payload: null,
    });
  }

  console.log(
    `Cleared ${activeHedgeFailureBreakers.length} hedge_failure breaker(s): ${activeHedgeFailureBreakers.map((breaker) => breaker.key).join(", ")}`,
  );
}

function ensureDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return;
  }

  const env = loadEnvFile(DEFAULT_ENV_PATH);
  if (!env.DATABASE_URL) {
    throw new Error(`DATABASE_URL manquant dans ${DEFAULT_ENV_PATH}`);
  }

  process.env.DATABASE_URL = env.DATABASE_URL;
}

function loadEnvFile(path: string) {
  if (!fs.existsSync(path)) {
    throw new Error(`Env file introuvable: ${path}`);
  }

  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
  const env: Record<string, string> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  return env;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
