import fs from "node:fs";

import { Pool } from "pg";

const DEFAULT_ENV_PATH = process.env.WARBITRER_ENV_PATH || "/etc/warbitrer/warbitrer.env";
const ORDER_SIZE_TOLERANCE = 1e-6;

type Resolution = "UP" | "DOWN" | "YES" | "NO" | null;

type IntentLeg = {
  id: string;
  venue: "polymarket" | "kalshi";
  outcome: "UP" | "DOWN" | "YES" | "NO";
  marketRef: string;
  tokenId?: string;
  side: "BUY" | "SELL";
  requestedPrice: number | null;
  requestedSize: number;
  requestedNotionalUsd: number;
  filledPrice: number | null;
  filledSize: number;
  feeUsd: number;
  status: string;
  venueOrderId: string | null;
  payoutUsd: number | null;
  resolvedOutcome: Resolution;
};

type IntentRow = {
  id: string;
  slotKey: string;
  slotStartTs: number;
  slotEndTs: number;
  combination: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  primaryVenue: "polymarket" | "kalshi";
  hedgeVenue: "polymarket" | "kalshi";
  grossCost: number;
  targetNotionalUsd: number;
  failureReason: string | null;
  projectedNetProfitUsd: number | null;
  realizedPnlUsd: number | null;
  roi: number | null;
  polyResolution: Resolution;
  kalshiResolution: Resolution;
  legs: IntentLeg[];
};

type VenueOrderRow = {
  intentId: string;
  venue: "polymarket" | "kalshi";
  venueOrderId: string;
  clientOrderId: string | null;
  side: "BUY" | "SELL";
  outcome: "UP" | "DOWN" | "YES" | "NO";
  orderType: string;
  requestedPrice: number | null;
  requestedSize: number;
  filledSize: number;
  averageFillPrice: number | null;
  feeUsd: number | null;
  status: string;
  createdAt: number;
  updatedAt: number;
};

type FillRow = {
  intentId: string | null;
  venue: "polymarket" | "kalshi";
  venueOrderId: string;
  tradeId: string;
  side: "BUY" | "SELL";
  outcome: "UP" | "DOWN" | "YES" | "NO";
  price: number;
  size: number;
  feeUsd: number;
  liquidity: string | null;
  filledAt: number;
};

type SettlementRow = {
  intentId: string | null;
  venue: "polymarket" | "kalshi";
  marketRef: string;
  outcome: "UP" | "DOWN" | "YES" | "NO";
  resolvedOutcome: Resolution;
  payoutUsd: number;
  settledAt: number;
};

type RunEventRow = {
  id: number;
  level: string;
  eventType: string;
  message: string;
  payload: Record<string, unknown> | null;
  createdAt: number;
};

type CircuitBreakerRow = {
  key: string;
  active: boolean;
  reason: string | null;
  triggeredAt: number | null;
  payload: Record<string, unknown> | null;
};

type PnlSnapshotRow = {
  capturedAt: number;
  equityUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  feesUsd: number;
};

type CliOptions = {
  sinceMs: number;
  untilMs: number;
  limit: number;
  envPath: string;
  slotKey: string | null;
  includeHealthy: boolean;
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureDatabaseUrl(options.envPath);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const report = await collectReport(pool, options);
    printReport(report, options);
  } finally {
    await pool.end();
  }
}

async function collectReport(pool: Pool, options: CliOptions) {
  const [windowStartPnl, windowEndPnl, circuitBreakers, intents, runEvents] = await Promise.all([
    queryPnlSnapshot(pool, options.sinceMs, "asc"),
    queryPnlSnapshot(pool, options.untilMs, "desc"),
    queryCircuitBreakers(pool, options.sinceMs, options.untilMs),
    queryIntents(pool, options),
    queryRunEvents(pool, options.sinceMs, options.untilMs),
  ]);

  const intentIds = intents.map((intent) => intent.id);
  const [orders, fills, settlements] = await Promise.all([
    queryVenueOrders(pool, intentIds),
    queryFills(pool, intentIds),
    querySettlements(pool, intentIds),
  ]);

  const relevantEvents = runEvents.filter((event) => {
    const payloadIntentId = typeof event.payload?.intentId === "string" ? event.payload.intentId : null;
    const payloadSlotKey = typeof event.payload?.slotKey === "string" ? event.payload.slotKey : null;
    return (
      (payloadIntentId !== null && intentIds.includes(payloadIntentId)) ||
      (options.slotKey !== null && payloadSlotKey === options.slotKey)
    );
  });

  const analyses = intents.map((intent) =>
    analyzeIntent({
      intent,
      orders: orders.filter((order) => order.intentId === intent.id),
      fills: fills.filter((fill) => fill.intentId === intent.id),
      settlements: settlements.filter((settlement) => settlement.intentId === intent.id),
      events: relevantEvents.filter(
        (event) =>
          event.payload?.intentId === intent.id ||
          (typeof event.payload?.slotKey === "string" && event.payload.slotKey === intent.slotKey),
      ),
    }),
  );

  const suspicious = analyses.filter((analysis) => options.includeHealthy || analysis.flags.length > 0);

  return {
    windowStartPnl,
    windowEndPnl,
    circuitBreakers,
    intents,
    suspicious,
  };
}

function analyzeIntent(params: {
  intent: IntentRow;
  orders: VenueOrderRow[];
  fills: FillRow[];
  settlements: SettlementRow[];
  events: RunEventRow[];
}) {
  const { intent, orders, fills, settlements, events } = params;
  const polyLeg = intent.legs.find((leg) => leg.venue === "polymarket") ?? null;
  const kalshiLeg = intent.legs.find((leg) => leg.venue === "kalshi") ?? null;
  const flags: string[] = [];

  if (polyLeg && polyLeg.filledSize > ORDER_SIZE_TOLERANCE && (!kalshiLeg || kalshiLeg.filledSize <= ORDER_SIZE_TOLERANCE)) {
    flags.push("Polymarket exposé sans hedge Kalshi rempli");
  }

  if (intent.failureReason?.toLowerCase().includes("hedge")) {
    flags.push(`Failure reason hedge: ${intent.failureReason}`);
  }

  if (events.some((event) => event.eventType === "intent.failed.late_primary_fill")) {
    flags.push("Late primary fill détecté");
  }

  if (events.some((event) => event.eventType.includes("order.hedge") && event.level !== "info")) {
    flags.push("Erreurs ou warnings sur le hedge");
  }

  if (intent.status === "unwind_required") {
    flags.push("Intent resté en unwind_required");
  }

  if (isResolutionDivergent(intent.polyResolution, intent.kalshiResolution)) {
    flags.push(`Résolution divergente: poly=${intent.polyResolution} vs kalshi=${intent.kalshiResolution}`);
  }

  if (intent.realizedPnlUsd !== null && intent.realizedPnlUsd < -0.01) {
    flags.push(`Perte réalisée ${formatUsd(intent.realizedPnlUsd)}`);
  }

  const sortedEvents = [...events].sort((left, right) => left.createdAt - right.createdAt);
  const sortedOrders = [...orders].sort((left, right) => left.createdAt - right.createdAt);
  const sortedFills = [...fills].sort((left, right) => left.filledAt - right.filledAt);
  const sortedSettlements = [...settlements].sort((left, right) => left.settledAt - right.settledAt);

  return {
    intent,
    flags,
    orders: sortedOrders,
    fills: sortedFills,
    settlements: sortedSettlements,
    events: sortedEvents,
  };
}

async function queryPnlSnapshot(pool: Pool, ts: number, direction: "asc" | "desc") {
  const comparator = direction === "asc" ? ">=" : "<=";
  const order = direction === "asc" ? "ASC" : "DESC";
  const result = await pool.query(
    `
      SELECT captured_at, equity_usd, realized_pnl_usd, unrealized_pnl_usd, fees_usd
      FROM pnl_snapshots
      WHERE captured_at ${comparator} $1
      ORDER BY captured_at ${order}
      LIMIT 1
    `,
    [ts],
  );

  if (!result.rows[0]) {
    return null;
  }

  return mapPnlSnapshotRow(result.rows[0]);
}

async function queryCircuitBreakers(pool: Pool, sinceMs: number, untilMs: number) {
  const result = await pool.query(
    `
      SELECT *
      FROM circuit_breakers
      WHERE active = true
         OR (triggered_at IS NOT NULL AND triggered_at BETWEEN $1 AND $2)
      ORDER BY triggered_at DESC NULLS LAST, key ASC
    `,
    [sinceMs, untilMs],
  );

  return result.rows.map((row) => ({
    key: row.key,
    active: row.active,
    reason: row.reason,
    triggeredAt: row.triggered_at,
    payload: row.payload_json,
  })) satisfies CircuitBreakerRow[];
}

async function queryIntents(pool: Pool, options: CliOptions) {
  const result = options.slotKey
    ? await pool.query(
        `
          SELECT *
          FROM order_intents
          WHERE slot_key = $1
          ORDER BY created_at DESC
          LIMIT $2
        `,
        [options.slotKey, options.limit],
      )
    : await pool.query(
        `
          SELECT *
          FROM order_intents
          WHERE created_at BETWEEN $1 AND $2
             OR updated_at BETWEEN $1 AND $2
             OR (resolved_at IS NOT NULL AND resolved_at BETWEEN $1 AND $2)
          ORDER BY created_at DESC
          LIMIT $3
        `,
        [options.sinceMs, options.untilMs, options.limit],
      );

  return result.rows.map(mapIntentRow);
}

async function queryVenueOrders(pool: Pool, intentIds: string[]) {
  if (intentIds.length === 0) {
    return [] satisfies VenueOrderRow[];
  }

  const result = await pool.query(
    `
      SELECT *
      FROM venue_orders
      WHERE intent_id = ANY($1::text[])
      ORDER BY created_at ASC, updated_at ASC
    `,
    [intentIds],
  );

  return result.rows.map((row) => ({
    intentId: row.intent_id,
    venue: row.venue,
    venueOrderId: row.venue_order_id,
    clientOrderId: row.client_order_id,
    side: row.side,
    outcome: row.outcome,
    orderType: row.order_type,
    requestedPrice: row.requested_price,
    requestedSize: row.requested_size,
    filledSize: row.filled_size,
    averageFillPrice: row.average_fill_price,
    feeUsd: row.fee_usd,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })) satisfies VenueOrderRow[];
}

async function queryFills(pool: Pool, intentIds: string[]) {
  if (intentIds.length === 0) {
    return [] satisfies FillRow[];
  }

  const result = await pool.query(
    `
      SELECT *
      FROM fills
      WHERE intent_id = ANY($1::text[])
      ORDER BY filled_at ASC, trade_id ASC
    `,
    [intentIds],
  );

  return result.rows.map((row) => ({
    intentId: row.intent_id,
    venue: row.venue,
    venueOrderId: row.venue_order_id,
    tradeId: row.trade_id,
    side: row.side,
    outcome: row.outcome,
    price: row.price,
    size: row.size,
    feeUsd: row.fee_usd,
    liquidity: row.liquidity,
    filledAt: row.filled_at,
  })) satisfies FillRow[];
}

async function querySettlements(pool: Pool, intentIds: string[]) {
  if (intentIds.length === 0) {
    return [] satisfies SettlementRow[];
  }

  const result = await pool.query(
    `
      SELECT *
      FROM settlements
      WHERE intent_id = ANY($1::text[])
      ORDER BY settled_at ASC
    `,
    [intentIds],
  );

  return result.rows.map((row) => ({
    intentId: row.intent_id,
    venue: row.venue,
    marketRef: row.market_ref,
    outcome: row.outcome,
    resolvedOutcome: row.resolved_outcome,
    payoutUsd: row.payout_usd,
    settledAt: row.settled_at,
  })) satisfies SettlementRow[];
}

async function queryRunEvents(pool: Pool, sinceMs: number, untilMs: number) {
  const result = await pool.query(
    `
      SELECT *
      FROM run_events
      WHERE created_at BETWEEN $1 AND $2
      ORDER BY created_at ASC, id ASC
    `,
    [sinceMs, untilMs],
  );

  return result.rows.map((row) => ({
    id: row.id,
    level: row.level,
    eventType: row.event_type,
    message: row.message,
    payload: row.payload_json,
    createdAt: row.created_at,
  })) satisfies RunEventRow[];
}

function printReport(
  report: {
    windowStartPnl: PnlSnapshotRow | null;
    windowEndPnl: PnlSnapshotRow | null;
    circuitBreakers: CircuitBreakerRow[];
    intents: IntentRow[];
    suspicious: Array<ReturnType<typeof analyzeIntent>>;
  },
  options: CliOptions,
) {
  console.log(`Fenêtre: ${formatTs(options.sinceMs)} -> ${formatTs(options.untilMs)}`);
  if (options.slotKey) {
    console.log(`Filtre slot: ${options.slotKey}`);
  }
  console.log(`Intents analysés: ${report.intents.length}`);
  console.log(`Intents suspects: ${report.suspicious.filter((item) => item.flags.length > 0).length}`);

  console.log("");
  console.log("P&L");
  if (report.windowStartPnl && report.windowEndPnl) {
    console.log(
      `- equity ${formatUsd(report.windowStartPnl.equityUsd)} -> ${formatUsd(report.windowEndPnl.equityUsd)} (${formatUsd(report.windowEndPnl.equityUsd - report.windowStartPnl.equityUsd)})`,
    );
    console.log(
      `- realized ${formatUsd(report.windowStartPnl.realizedPnlUsd)} -> ${formatUsd(report.windowEndPnl.realizedPnlUsd)} (${formatUsd(report.windowEndPnl.realizedPnlUsd - report.windowStartPnl.realizedPnlUsd)})`,
    );
    console.log(
      `- unrealized ${formatUsd(report.windowStartPnl.unrealizedPnlUsd)} -> ${formatUsd(report.windowEndPnl.unrealizedPnlUsd)} (${formatUsd(report.windowEndPnl.unrealizedPnlUsd - report.windowStartPnl.unrealizedPnlUsd)})`,
    );
    console.log(
      `- fees ${formatUsd(report.windowStartPnl.feesUsd)} -> ${formatUsd(report.windowEndPnl.feesUsd)} (${formatUsd(report.windowEndPnl.feesUsd - report.windowStartPnl.feesUsd)})`,
    );
  } else {
    console.log("- snapshots P&L insuffisants sur la fenêtre");
  }

  console.log("");
  console.log("Circuit Breakers");
  if (report.circuitBreakers.length === 0) {
    console.log("- aucun breaker actif ou déclenché sur la fenêtre");
  } else {
    for (const breaker of report.circuitBreakers) {
      console.log(
        `- ${breaker.key} · active=${breaker.active} · reason=${breaker.reason ?? "--"} · triggered=${breaker.triggeredAt ? formatTs(breaker.triggeredAt) : "--"}`,
      );
    }
  }

  console.log("");
  console.log("Intents");
  if (report.suspicious.length === 0) {
    console.log("- aucun intent sur la fenêtre");
    return;
  }

  for (const item of report.suspicious) {
    const { intent, flags, orders, fills, settlements, events } = item;
    console.log("");
    console.log(`=== ${intent.id} · ${intent.combination} · ${intent.status} ===`);
    console.log(
      `slot ${intent.slotKey} · created ${formatTs(intent.createdAt)} · updated ${formatTs(intent.updatedAt)} · resolved ${intent.resolvedAt ? formatTs(intent.resolvedAt) : "--"}`,
    );
    console.log(
      `primary ${intent.primaryVenue} -> hedge ${intent.hedgeVenue} · gross ${formatNum(intent.grossCost, 4)} · target ${formatUsd(intent.targetNotionalUsd)} · pnl ${intent.realizedPnlUsd === null ? "--" : formatUsd(intent.realizedPnlUsd)}`,
    );
    if (intent.failureReason) {
      console.log(`failure_reason: ${intent.failureReason}`);
    }
    if (flags.length > 0) {
      console.log(`flags: ${flags.join(" | ")}`);
    } else {
      console.log("flags: aucune");
    }
    console.log(
      `resolutions: poly=${intent.polyResolution ?? "--"} · kalshi=${intent.kalshiResolution ?? "--"}`,
    );

    console.log("legs:");
    for (const leg of intent.legs) {
      console.log(
        `- ${leg.venue} ${leg.outcome} ${leg.side} · target ${formatUsd(leg.requestedNotionalUsd)} · req ${formatNum(leg.requestedSize, 4)} @ ${formatNullableNum(leg.requestedPrice, 4)} · filled ${formatNum(leg.filledSize, 4)} @ ${formatNullableNum(leg.filledPrice, 4)} · status ${leg.status}`,
      );
    }

    console.log("orders:");
    if (orders.length === 0) {
      console.log("- none");
    } else {
      for (const order of orders) {
        console.log(
          `- ${formatTs(order.createdAt)} · ${order.venue} ${order.side} ${order.orderType} · status ${order.status} · req ${formatNum(order.requestedSize, 4)} @ ${formatNullableNum(order.requestedPrice, 4)} · filled ${formatNum(order.filledSize, 4)} @ ${formatNullableNum(order.averageFillPrice, 4)} · order ${order.venueOrderId}`,
        );
      }
    }

    console.log("fills:");
    if (fills.length === 0) {
      console.log("- none");
    } else {
      for (const fill of fills) {
        console.log(
          `- ${formatTs(fill.filledAt)} · ${fill.venue} ${fill.side} ${fill.outcome} · ${formatNum(fill.size, 4)} @ ${formatNum(fill.price, 4)} · fee ${formatUsd(fill.feeUsd)} · trade ${fill.tradeId}`,
        );
      }
    }

    console.log("events:");
    if (events.length === 0) {
      console.log("- none");
    } else {
      for (const event of events) {
        console.log(`- ${formatTs(event.createdAt)} · ${event.level} · ${event.eventType} · ${event.message}`);
      }
    }

    console.log("settlements:");
    if (settlements.length === 0) {
      console.log("- none");
    } else {
      for (const settlement of settlements) {
        console.log(
          `- ${formatTs(settlement.settledAt)} · ${settlement.venue} ${settlement.outcome} -> ${settlement.resolvedOutcome ?? "--"} · payout ${formatUsd(settlement.payoutUsd)}`,
        );
      }
    }
  }
}

function mapIntentRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    slotKey: String(row.slot_key),
    slotStartTs: Number(row.slot_start_ts),
    slotEndTs: Number(row.slot_end_ts),
    combination: String(row.combination),
    status: String(row.status),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    primaryVenue: row.primary_venue as "polymarket" | "kalshi",
    hedgeVenue: row.hedge_venue as "polymarket" | "kalshi",
    grossCost: Number(row.gross_cost),
    targetNotionalUsd: Number(row.target_notional_usd),
    failureReason: row.failure_reason === null ? null : String(row.failure_reason),
    projectedNetProfitUsd:
      row.projected_net_profit_usd === null ? null : Number(row.projected_net_profit_usd),
    realizedPnlUsd: row.realized_pnl_usd === null ? null : Number(row.realized_pnl_usd),
    roi: row.roi === null ? null : Number(row.roi),
    polyResolution: (row.poly_resolution as Resolution) ?? null,
    kalshiResolution: (row.kalshi_resolution as Resolution) ?? null,
    legs: mapLegs(row.legs_json),
  } satisfies IntentRow;
}

function mapLegs(value: unknown) {
  if (!Array.isArray(value)) {
    return [] satisfies IntentLeg[];
  }

  return value.map((leg) => {
    const candidate = leg as Record<string, unknown>;
    return {
      id: String(candidate.id),
      venue: candidate.venue as "polymarket" | "kalshi",
      outcome: candidate.outcome as "UP" | "DOWN" | "YES" | "NO",
      marketRef: String(candidate.marketRef),
      tokenId: typeof candidate.tokenId === "string" ? candidate.tokenId : undefined,
      side: candidate.side as "BUY" | "SELL",
      requestedPrice: toNullableNumber(candidate.requestedPrice),
      requestedSize: Number(candidate.requestedSize),
      requestedNotionalUsd: Number(candidate.requestedNotionalUsd),
      filledPrice: toNullableNumber(candidate.filledPrice),
      filledSize: Number(candidate.filledSize),
      feeUsd: Number(candidate.feeUsd),
      status: String(candidate.status),
      venueOrderId: typeof candidate.venueOrderId === "string" ? candidate.venueOrderId : null,
      payoutUsd: toNullableNumber(candidate.payoutUsd),
      resolvedOutcome: (candidate.resolvedOutcome as Resolution) ?? null,
    } satisfies IntentLeg;
  });
}

function mapPnlSnapshotRow(row: Record<string, unknown>) {
  return {
    capturedAt: Number(row.captured_at),
    equityUsd: Number(row.equity_usd),
    realizedPnlUsd: Number(row.realized_pnl_usd),
    unrealizedPnlUsd: Number(row.unrealized_pnl_usd),
    feesUsd: Number(row.fees_usd),
  } satisfies PnlSnapshotRow;
}

function isResolutionDivergent(poly: Resolution, kalshi: Resolution) {
  if (poly === null || kalshi === null) {
    return false;
  }

  return !((poly === "UP" && kalshi === "YES") || (poly === "DOWN" && kalshi === "NO"));
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

function parseArgs(args: string[]): CliOptions {
  let hours = 12;
  let sinceMs: number | null = null;
  let untilMs = Date.now();
  let limit = 50;
  let envPath = DEFAULT_ENV_PATH;
  let slotKey: string | null = null;
  let includeHealthy = false;

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
    if (arg === "--slot-key") {
      slotKey = nextArg(args, ++index, "--slot-key");
      continue;
    }
    if (arg === "--all") {
      includeHealthy = true;
      continue;
    }
    if (arg === "--help") {
      printHelpAndExit();
    }
    throw new Error(`Argument inconnu: ${arg}`);
  }

  const resolvedSinceMs = sinceMs ?? untilMs - hours * 60 * 60 * 1000;
  if (!Number.isFinite(resolvedSinceMs) || !Number.isFinite(untilMs) || resolvedSinceMs > untilMs) {
    throw new Error("Fenêtre temporelle invalide");
  }

  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("`--limit` doit être > 0");
  }

  return {
    sinceMs: resolvedSinceMs,
    untilMs,
    limit,
    envPath,
    slotKey,
    includeHealthy,
  };
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

function toNullableNumber(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatTs(value: number) {
  return new Date(value).toISOString();
}

function formatUsd(value: number) {
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}

function formatNum(value: number, digits = 2) {
  return value.toFixed(digits);
}

function formatNullableNum(value: number | null, digits = 2) {
  return value === null ? "--" : formatNum(value, digits);
}

function printHelpAndExit(): never {
  console.log("Usage: npm run incident:report -- [--hours 12] [--since ISO] [--until ISO] [--slot-key KEY] [--limit 50] [--env /etc/warbitrer/warbitrer.env] [--all]");
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
