import fs from "node:fs";

import { Pool } from "pg";

const DEFAULT_ENV_PATH = process.env.WARBITRER_ENV_PATH || "/etc/warbitrer/warbitrer.env";

type CliOptions = {
  sinceMs: number;
  untilMs: number;
  limit: number;
  envPath: string;
  levels: string[];
  eventTypeLike: string | null;
  intentId: string | null;
  slotKey: string | null;
  search: string | null;
  format: "text" | "json";
  ascending: boolean;
};

type RunEventRow = {
  id: number;
  level: string;
  eventType: string;
  message: string;
  payload: Record<string, unknown> | null;
  createdAt: number;
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureDatabaseUrl(options.envPath);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const events = await queryRunEvents(pool, options);
    if (options.format === "json") {
      console.log(JSON.stringify(events, null, 2));
      return;
    }

    renderText(events, options);
  } finally {
    await pool.end();
  }
}

async function queryRunEvents(pool: Pool, options: CliOptions) {
  const whereClauses: string[] = ["created_at BETWEEN $1 AND $2"];
  const params: Array<number | string | string[]> = [options.sinceMs, options.untilMs];

  if (options.levels.length > 0) {
    whereClauses.push(`level = ANY($${params.length + 1}::text[])`);
    params.push(options.levels);
  }

  if (options.eventTypeLike) {
    whereClauses.push(`event_type ILIKE $${params.length + 1}`);
    params.push(`%${options.eventTypeLike}%`);
  }

  if (options.intentId) {
    whereClauses.push(`payload_json->>'intentId' = $${params.length + 1}`);
    params.push(options.intentId);
  }

  if (options.slotKey) {
    whereClauses.push(`payload_json->>'slotKey' = $${params.length + 1}`);
    params.push(options.slotKey);
  }

  if (options.search) {
    whereClauses.push(
      `(message ILIKE $${params.length + 1} OR event_type ILIKE $${params.length + 1} OR COALESCE(payload_json::text, '') ILIKE $${params.length + 1})`,
    );
    params.push(`%${options.search}%`);
  }

  const order = options.ascending ? "ASC" : "DESC";
  params.push(options.limit);

  const result = await pool.query(
    `
      SELECT *
      FROM run_events
      WHERE ${whereClauses.join("\n        AND ")}
      ORDER BY created_at ${order}, id ${order}
      LIMIT $${params.length}
    `,
    params,
  );

  return result.rows.map(
    (row) =>
      ({
        id: row.id,
        level: row.level,
        eventType: row.event_type,
        message: row.message,
        payload: row.payload_json,
        createdAt: row.created_at,
      }) satisfies RunEventRow,
  );
}

function renderText(events: RunEventRow[], options: CliOptions) {
  console.log(`Fenetre: ${formatTs(options.sinceMs)} -> ${formatTs(options.untilMs)}`);
  console.log(`Evenements: ${events.length}`);
  if (options.levels.length > 0) {
    console.log(`Levels: ${options.levels.join(", ")}`);
  }
  if (options.eventTypeLike) {
    console.log(`Event type like: ${options.eventTypeLike}`);
  }
  if (options.intentId) {
    console.log(`Intent ID: ${options.intentId}`);
  }
  if (options.slotKey) {
    console.log(`Slot key: ${options.slotKey}`);
  }
  if (options.search) {
    console.log(`Search: ${options.search}`);
  }

  if (events.length === 0) {
    return;
  }

  for (const event of events) {
    console.log("");
    console.log(`[${formatTs(event.createdAt)}] ${event.level} ${event.eventType}`);
    console.log(event.message);
    if (event.payload && Object.keys(event.payload).length > 0) {
      console.log(JSON.stringify(event.payload, null, 2));
    }
  }
}

function ensureDatabaseUrl(envPath: string) {
  if (process.env.DATABASE_URL) {
    return;
  }

  const env = loadEnvFile(envPath);
  if (!env.DATABASE_URL) {
    throw new Error(`DATABASE_URL manquant dans ${envPath}`);
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  return env;
}

function parseArgs(args: string[]): CliOptions {
  let hours = 6;
  let sinceMs: number | null = null;
  let untilMs = Date.now();
  let limit = 200;
  let envPath = DEFAULT_ENV_PATH;
  const levels: string[] = [];
  let eventTypeLike: string | null = null;
  let intentId: string | null = null;
  let slotKey: string | null = null;
  let search: string | null = null;
  let format: "text" | "json" = "text";
  let ascending = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--hours") {
      hours = Number(nextArg(args, ++index, "--hours"));
      continue;
    }
    if (arg === "--since") {
      sinceMs = parseTimestamp(nextArg(args, ++index, "--since"));
      continue;
    }
    if (arg === "--until") {
      untilMs = parseTimestamp(nextArg(args, ++index, "--until"));
      continue;
    }
    if (arg === "--limit") {
      limit = Number(nextArg(args, ++index, "--limit"));
      continue;
    }
    if (arg === "--env") {
      envPath = nextArg(args, ++index, "--env");
      continue;
    }
    if (arg === "--level") {
      levels.push(...parseList(nextArg(args, ++index, "--level")));
      continue;
    }
    if (arg === "--event-type") {
      eventTypeLike = nextArg(args, ++index, "--event-type");
      continue;
    }
    if (arg === "--intent-id") {
      intentId = nextArg(args, ++index, "--intent-id");
      continue;
    }
    if (arg === "--slot-key") {
      slotKey = nextArg(args, ++index, "--slot-key");
      continue;
    }
    if (arg === "--search") {
      search = nextArg(args, ++index, "--search");
      continue;
    }
    if (arg === "--json") {
      format = "json";
      continue;
    }
    if (arg === "--desc") {
      ascending = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    }

    throw new Error(`Argument inconnu: ${arg}`);
  }

  const resolvedSinceMs = sinceMs ?? untilMs - hours * 60 * 60 * 1000;
  if (!Number.isFinite(resolvedSinceMs)) {
    throw new Error("`--since` ou `--hours` invalide");
  }
  if (!Number.isFinite(untilMs)) {
    throw new Error("`--until` invalide");
  }
  if (resolvedSinceMs > untilMs) {
    throw new Error("`--since` doit etre <= `--until`");
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("`--limit` doit etre > 0");
  }

  return {
    sinceMs: resolvedSinceMs,
    untilMs,
    limit,
    envPath,
    levels,
    eventTypeLike,
    intentId,
    slotKey,
    search,
    format,
    ascending,
  };
}

function parseList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function nextArg(args: string[], index: number, flag: string) {
  const value = args[index];
  if (!value) {
    throw new Error(`Valeur manquante pour ${flag}`);
  }
  return value;
}

function parseTimestamp(value: string) {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Timestamp invalide: ${value}`);
  }
  return parsed;
}

function formatTs(value: number) {
  try {
    return new Date(value).toISOString();
  } catch {
    return String(value);
  }
}

function printHelpAndExit(): never {
  console.log(
    "Usage: npm run logs:events -- [--hours 6] [--since ISO] [--until ISO] [--level warn,error] [--event-type hedge] [--intent-id ID] [--slot-key KEY] [--search text] [--limit 200] [--env /etc/warbitrer/warbitrer.env] [--json] [--desc]",
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
