import fs from "node:fs";

import { getPgDb } from "@/lib/postgres-db";
import { readPositions, readVenueBalances } from "@/lib/storage";

const DEFAULT_ENV_PATH = process.env.WARBITRER_ENV_PATH || "/etc/warbitrer/warbitrer.env";

type IntentRow = {
  id: string;
  asset: string;
  slot_key: string;
  combination: string;
  status: string;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  primary_venue: string;
  hedge_venue: string;
  gross_cost: number;
  target_notional_usd: number;
  projected_net_profit_usd: number | null;
  realized_pnl_usd: number | null;
  roi: number | null;
  failure_reason: string | null;
  legs_json: any[];
};

async function main() {
  loadRuntimeEnv();

  const from = parseTimestampFlag("--from");
  const to = parseTimestampFlag("--to");
  if (from === null || to === null || to <= from) {
    throw new Error('Usage: npm run slot:audit -- --from "2026-05-01T00:00:00+02:00" --to "2026-05-01T00:15:00+02:00"');
  }

  const json = process.argv.includes("--json");
  const pool = await getPgDb();
  const intentResult = await pool.query<IntentRow>(
    `
      SELECT *
      FROM order_intents
      WHERE created_at BETWEEN $1 AND $2
         OR updated_at BETWEEN $1 AND $2
         OR resolved_at BETWEEN $1 AND $2
      ORDER BY created_at ASC
    `,
    [from, to],
  );
  const intentIds = intentResult.rows.map((intent) => intent.id);
  const [orders, fills, settlements, events, pnlSnapshots, positions, balances] = await Promise.all([
    queryByWindowOrIntent(pool, "venue_orders", "created_at", "updated_at", intentIds, from, to),
    queryByWindowOrIntent(pool, "fills", "filled_at", null, intentIds, from, to),
    queryByWindowOrIntent(pool, "settlements", "settled_at", null, intentIds, from, to),
    pool.query(
      `
        SELECT *
        FROM run_events
        WHERE created_at BETWEEN $1 AND $2
        ORDER BY created_at ASC, id ASC
      `,
      [from, to],
    ).then((result) => result.rows),
    pool.query(
      `
        SELECT *
        FROM pnl_snapshots
        WHERE captured_at BETWEEN $1 AND $2
        ORDER BY captured_at ASC, id ASC
      `,
      [from, to],
    ).then((result) => result.rows),
    readPositions(),
    readVenueBalances(),
  ]);

  const intentLines = intentResult.rows.map((intent) => summarizeIntent(intent));
  const pnlDelta = summarizePnlDelta(pnlSnapshots);
  const feeTotalUsd = sumNumbers(fills, "fee_usd");
  const settlementPayoutUsd = sumNumbers(settlements, "payout_usd");
  const explainedPnlUsd = sumNumbers(intentResult.rows, "realized_pnl_usd");

  const report = {
    from,
    to,
    fromIso: new Date(from).toISOString(),
    toIso: new Date(to).toISOString(),
    summary: {
      intents: intentResult.rows.length,
      orders: orders.length,
      fills: fills.length,
      settlements: settlements.length,
      feesUsd: round4(feeTotalUsd),
      settlementPayoutUsd: round4(settlementPayoutUsd),
      realizedPnlUsd: round4(explainedPnlUsd),
      pnlDelta,
    },
    intentLines,
    intents: intentResult.rows,
    orders,
    fills,
    settlements,
    pnlSnapshots,
    currentPositions: positions.filter((position) => position.size > 0 || position.redeemable || position.mergeable),
    currentVenueBalances: balances,
    runEvents: events,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printHumanReport(report);
}

async function queryByWindowOrIntent(
  pool: Awaited<ReturnType<typeof getPgDb>>,
  table: string,
  firstTimestampColumn: string,
  secondTimestampColumn: string | null,
  intentIds: string[],
  from: number,
  to: number,
) {
  const intentCondition = intentIds.length > 0 ? "OR intent_id = ANY($3)" : "";
  const secondWindow = secondTimestampColumn === null ? "" : `OR ${secondTimestampColumn} BETWEEN $1 AND $2`;
  const params = intentIds.length > 0 ? [from, to, intentIds] : [from, to];
  const result = await pool.query(
    `
      SELECT *
      FROM ${table}
      WHERE ${firstTimestampColumn} BETWEEN $1 AND $2
        ${secondWindow}
        ${intentCondition}
      ORDER BY ${firstTimestampColumn} ASC
    `,
    params,
  );
  return result.rows;
}

function summarizeIntent(intent: IntentRow) {
  const legs = intent.legs_json.map((leg) => ({
    venue: leg.venue,
    outcome: leg.outcome,
    requestedSize: leg.requestedSize,
    filledSize: leg.filledSize,
    filledPrice: leg.filledPrice,
    feeUsd: leg.feeUsd,
    capitalUsd: round4((Number(leg.filledSize) || 0) * (Number(leg.filledPrice) || 0) + (Number(leg.feeUsd) || 0)),
  }));

  return {
    id: intent.id,
    asset: intent.asset,
    slotKey: intent.slot_key,
    status: intent.status,
    combination: intent.combination,
    createdAtIso: new Date(intent.created_at).toISOString(),
    primaryVenue: intent.primary_venue,
    hedgeVenue: intent.hedge_venue,
    targetNotionalUsd: intent.target_notional_usd,
    projectedNetProfitUsd: intent.projected_net_profit_usd,
    realizedPnlUsd: intent.realized_pnl_usd,
    roi: intent.roi,
    failureReason: intent.failure_reason,
    legs,
    filledCapitalUsd: round4(legs.reduce((sum, leg) => sum + leg.capitalUsd, 0)),
  };
}

function summarizePnlDelta(rows: any[]) {
  if (rows.length < 2) {
    return null;
  }
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  return {
    fromIso: new Date(first.captured_at).toISOString(),
    toIso: new Date(last.captured_at).toISOString(),
    equityUsd: round4(Number(last.equity_usd) - Number(first.equity_usd)),
    cashUsd: round4(Number(last.cash_usd) - Number(first.cash_usd)),
    positionsValueUsd: round4(Number(last.positions_value_usd) - Number(first.positions_value_usd)),
    realizedPnlUsd: round4(Number(last.realized_pnl_usd) - Number(first.realized_pnl_usd)),
    unrealizedPnlUsd: round4(Number(last.unrealized_pnl_usd) - Number(first.unrealized_pnl_usd)),
    feesUsd: round4(Number(last.fees_usd) - Number(first.fees_usd)),
  };
}

function printHumanReport(report: any) {
  console.log(`Audit créneau ${report.fromIso} -> ${report.toIso}`);
  console.log(
    `Intents ${report.summary.intents} · orders ${report.summary.orders} · fills ${report.summary.fills} · settlements ${report.summary.settlements}`,
  );
  console.log(
    `Fees $${report.summary.feesUsd.toFixed(2)} · payouts $${report.summary.settlementPayoutUsd.toFixed(2)} · P&L intents ${formatSignedUsd(report.summary.realizedPnlUsd)}`,
  );
  if (report.summary.pnlDelta) {
    console.log(
      `Delta equity ${formatSignedUsd(report.summary.pnlDelta.equityUsd)} · cash ${formatSignedUsd(report.summary.pnlDelta.cashUsd)} · positions ${formatSignedUsd(report.summary.pnlDelta.positionsValueUsd)}`,
    );
  }
  for (const line of report.intentLines) {
    console.log(
      `- ${line.asset.toUpperCase()} ${line.combination} ${line.status} · capital $${line.filledCapitalUsd.toFixed(2)} · P&L ${formatSignedUsd(line.realizedPnlUsd)}`,
    );
    if (line.failureReason) {
      console.log(`  raison: ${line.failureReason}`);
    }
    for (const leg of line.legs) {
      console.log(
        `  ${leg.venue} ${leg.outcome}: filled ${formatNumber(leg.filledSize)} @ ${formatNumber(leg.filledPrice)} · fee $${formatNumber(leg.feeUsd)} · capital $${leg.capitalUsd.toFixed(2)}`,
      );
    }
  }
  console.log("Utilise --json pour les lignes DB complètes, positions redeemable/mergeable et events.");
}

function parseTimestampFlag(flag: string) {
  const value = readCliFlag(flag);
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readCliFlag(flag: string) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }

  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function sumNumbers(rows: any[], key: string) {
  return rows.reduce((sum, row) => {
    const value = Number(row[key]);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

function formatSignedUsd(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }
  const sign = value >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(4) : "--";
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function loadRuntimeEnv() {
  if (!fs.existsSync(DEFAULT_ENV_PATH)) {
    return;
  }

  for (const [key, value] of Object.entries(loadEnvFile(DEFAULT_ENV_PATH))) {
    process.env[key] = process.env[key] ?? value;
  }
}

function loadEnvFile(path: string) {
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
