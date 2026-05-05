import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  backtestSummariesToCsv,
  backtestTradesToCsv,
  parseBacktestAssets,
  runBacktestStrategies,
} from "@/lib/backtest";

async function main() {
  const { values } = parseArgs({
    options: {
      "database-url": { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      assets: { type: "string", default: "all" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || !values.from || !values.to) {
    console.log([
      "Usage: npm run backtest:strategies -- --from 2026-05-01T00:00:00Z --to 2026-05-04T00:00:00Z [--assets all] [--database-url postgres://127.0.0.1/warbitrer_backtest] [--out reports/backtests/run-1]",
      "",
      "Runs local-only strategy simulations against an imported backtest database.",
    ].join("\n"));
    return;
  }

  const from = parseTimestamp(values.from, "--from");
  const to = parseTimestamp(values.to, "--to");
  if (to <= from) {
    throw new Error("--to must be after --from");
  }

  const outputDir = values.out ?? path.join("reports", "backtests", timestampForPath(Date.now()));
  const databaseUrl =
    values["database-url"] ??
    process.env.BACKTEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgres://127.0.0.1/warbitrer_backtest";

  const result = await runBacktestStrategies({
    databaseUrl,
    from,
    to,
    assets: parseBacktestAssets(values.assets),
  });

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "summary.csv"), backtestSummariesToCsv(result.summaries));
  fs.writeFileSync(path.join(outputDir, "trades.csv"), backtestTradesToCsv(result.trades));
  fs.writeFileSync(path.join(outputDir, "report.md"), result.reportMarkdown);
  fs.writeFileSync(
    path.join(outputDir, "manifest.json"),
    `${JSON.stringify({
      generatedAt: result.generatedAt,
      generatedAtIso: new Date(result.generatedAt).toISOString(),
      from: result.from,
      fromIso: new Date(result.from).toISOString(),
      to: result.to,
      toIso: new Date(result.to).toISOString(),
      assets: result.assets,
      databaseUrl: redactDatabaseUrl(databaseUrl),
      outputs: ["summary.csv", "trades.csv", "report.md"],
    }, null, 2)}\n`,
  );

  console.log(`Backtest written to ${outputDir}`);
  for (const summary of result.summaries.slice(0, 6)) {
    console.log(
      `${summary.variant}: score=${summary.riskScoreUsd.toFixed(2)} pnl=${summary.netPnlUsd.toFixed(2)} trades=${summary.resolvedTrades}/${summary.trades} realism=${summary.realismGrade}`,
    );
  }
}

function parseTimestamp(value: string, flag: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${flag}: ${value}`);
  }
  return parsed;
}

function timestampForPath(now: number) {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

function redactDatabaseUrl(databaseUrl: string) {
  try {
    const url = new URL(databaseUrl);
    if (url.password) {
      url.password = "redacted";
    }
    return url.toString();
  } catch {
    return databaseUrl;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
