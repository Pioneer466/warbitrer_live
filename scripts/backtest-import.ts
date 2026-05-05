import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { parseArgs } from "node:util";

function main() {
  const { values } = parseArgs({
    options: {
      dump: { type: "string" },
      database: { type: "string", default: "warbitrer_backtest" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || !values.dump) {
    console.log([
      "Usage: npm run backtest:import -- --dump ./backtest-data/warbitrer.dump [--database warbitrer_backtest]",
      "",
      "Drops and recreates the local backtest database, then restores the table-filtered dump.",
    ].join("\n"));
    return;
  }

  const dumpPath = values.dump;
  const database = values.database ?? "warbitrer_backtest";
  if (!fs.existsSync(dumpPath)) {
    throw new Error(`Dump not found: ${dumpPath}`);
  }

  run("dropdb", ["--if-exists", database]);
  run("createdb", [database]);
  run("pg_restore", [
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-acl",
    "--dbname",
    database,
    dumpPath,
  ]);

  console.log(`Imported ${dumpPath} into local database ${database}.`);
}

function run(command: string, args: string[]) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  execFileSync(command, args, {
    stdio: "inherit",
  });
}

main();
