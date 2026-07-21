import { parseArgs } from "node:util";

import { buildBacktestExportCommand } from "@/lib/backtest";

function main() {
  const { values } = parseArgs({
    options: {
      database: { type: "string", default: "warbitrer_live" },
      output: { type: "string", default: "/tmp/warbitrer-backtest.dump" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(
      [
        "Usage: npm run backtest:export-command -- [--database warbitrer_live] [--output /tmp/warbitrer-backtest.dump]",
        "",
        "Prints the low-priority pg_dump command to run on the VPS.",
      ].join("\n"),
    );
    return;
  }

  console.log(
    buildBacktestExportCommand({
      database: values.database,
      output: values.output,
    }),
  );
}

main();
