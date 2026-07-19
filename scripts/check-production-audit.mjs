import { spawnSync } from "node:child_process";

const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
});

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  process.stderr.write(result.stderr || result.stdout || "npm audit returned invalid JSON\n");
  process.exit(1);
}

const vulnerabilities = Object.entries(report.vulnerabilities ?? {});
const critical = vulnerabilities.filter(([, finding]) => finding.severity === "critical");
const high = vulnerabilities.filter(([, finding]) => finding.severity === "high");

if (critical.length > 0 || high.length > 0) {
  process.stderr.write(
    `Blocking production vulnerabilities: ${[...critical, ...high]
      .map(([name, finding]) => `${name}:${finding.severity}`)
      .join(", ")}\n`,
  );
  process.exit(1);
}

const counts = report.metadata?.vulnerabilities ?? {};
process.stdout.write(
  `Production audit checked: ${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low\n`,
);
