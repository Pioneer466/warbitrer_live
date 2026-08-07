#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { resolveMismatchCalibrationHorizonBand } from "@/lib/mismatch-calibration";
import { ORACLE_SAMPLE_RETENTION_MS } from "@/lib/oracle-history";

type CandidateAnalysisOptions = {
  fromMs: number;
  toMs: number;
  help: boolean;
};

export type ResolvedCandidateVariantRow = {
  probeKind: "candidate_preflight" | "late_probe";
  asset: string;
  combination: "POLY_UP_KALSHI_NO" | "POLY_DOWN_KALSHI_YES";
  targetSecondsRemaining: number | null;
  capturedSecondsRemaining: number;
  maxLegPriceCap: number;
  safetyFraction: number;
  pairSize: number;
  totalCostUsd: number;
  payoutCount: 0 | 1 | 2;
  fatal: boolean;
  pnlUsd: number;
};

type CandidateQueryRow = {
  probe_kind: unknown;
  asset: unknown;
  combination: unknown;
  target_seconds_remaining: unknown;
  captured_seconds_remaining: unknown;
  max_leg_price_cap: unknown;
  safety_fraction: unknown;
  pair_size: unknown;
  total_cost_usd: unknown;
  payout_count: unknown;
  fatal: unknown;
  pnl_usd: unknown;
};

type FunnelQueryRow = {
  probe_kind: unknown;
  stage: unknown;
  code: unknown;
  probe_count: unknown;
  asset_slot_count: unknown;
};

export async function runMismatchCandidateAnalysisCli(argv: readonly string[], nowMs = Date.now()) {
  const options = parseCandidateAnalysisArgs(argv, nowMs);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required; load the protected runtime environment before analysis");
  }

  const pool = new Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '120s'");
    const [candidateResult, funnelResult, coverageResult] = await Promise.all([
      client.query<CandidateQueryRow>(CANDIDATE_VARIANT_QUERY, [options.fromMs, options.toMs]),
      client.query<FunnelQueryRow>(FUNNEL_QUERY, [options.fromMs, options.toMs]),
      client.query<{
        probe_count: unknown;
        asset_slot_count: unknown;
        resolved_probe_count: unknown;
        first_captured_at: unknown;
        last_captured_at: unknown;
      }>(COVERAGE_QUERY, [options.fromMs, options.toMs]),
    ]);
    await client.query("COMMIT");
    transactionOpen = false;

    const candidates = normalizeCandidateRows(candidateResult.rows);
    const coverage = coverageResult.rows[0];
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      mode: "read-only",
      semantics:
        "earliest counterfactual-eligible REST variant per asset/slot/combination/probe horizon and policy; official dual-venue resolution",
      query: {
        fromTs: options.fromMs,
        fromIso: new Date(options.fromMs).toISOString(),
        toTs: options.toMs,
        toIso: new Date(options.toMs).toISOString(),
      },
      coverage: coverage
        ? {
            probeCount: asNonNegativeInteger(coverage.probe_count, "coverage.probe_count"),
            assetSlotCount: asNonNegativeInteger(coverage.asset_slot_count, "coverage.asset_slot_count"),
            resolvedProbeCount: asNonNegativeInteger(coverage.resolved_probe_count, "coverage.resolved_probe_count"),
            firstCapturedAt: asNullableNonNegativeInteger(coverage.first_captured_at, "coverage.first_captured_at"),
            lastCapturedAt: asNullableNonNegativeInteger(coverage.last_captured_at, "coverage.last_captured_at"),
          }
        : null,
      funnel: funnelResult.rows.map((row, index) => ({
        probeKind: asProbeKind(row.probe_kind, `funnel[${index}].probe_kind`),
        stage: asString(row.stage, `funnel[${index}].stage`),
        code: asString(row.code, `funnel[${index}].code`),
        probeCount: asNonNegativeInteger(row.probe_count, `funnel[${index}].probe_count`),
        assetSlotCount: asNonNegativeInteger(row.asset_slot_count, `funnel[${index}].asset_slot_count`),
      })),
      eligibleResolvedCohorts: summarizeResolvedCandidateVariants(candidates),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export function parseCandidateAnalysisArgs(argv: readonly string[], nowMs = Date.now()): CandidateAnalysisOptions {
  let help = false;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    const equalsAt = argument.indexOf("=");
    const key = equalsAt === -1 ? argument : argument.slice(0, equalsAt);
    if (key !== "--from" && key !== "--to") {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = equalsAt === -1 ? argv[index + 1] : argument.slice(equalsAt + 1);
    if (!value || value.startsWith("--")) {
      throw new Error(`${key} requires a value`);
    }
    if (values.has(key)) {
      throw new Error(`${key} may only be provided once`);
    }
    values.set(key, value);
    if (equalsAt === -1) {
      index += 1;
    }
  }
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new RangeError("nowMs must be a positive safe integer");
  }
  const fromMs = values.has("--from")
    ? parseTimestamp(values.get("--from")!, "--from")
    : nowMs - ORACLE_SAMPLE_RETENTION_MS;
  const toMs = values.has("--to") ? parseTimestamp(values.get("--to")!, "--to") : nowMs;
  if (fromMs >= toMs) {
    throw new RangeError("--from must be earlier than --to");
  }
  return { fromMs, toMs, help };
}

export function normalizeCandidateRows(rows: readonly CandidateQueryRow[]): ResolvedCandidateVariantRow[] {
  return rows.map((row, index) => {
    const payoutCount = asNonNegativeInteger(row.payout_count, `rows[${index}].payout_count`);
    if (payoutCount > 2) {
      throw new RangeError(`rows[${index}].payout_count must be at most two`);
    }
    if (typeof row.fatal !== "boolean" || row.fatal !== (payoutCount === 0)) {
      throw new RangeError(`rows[${index}].fatal must match a zero payout count`);
    }
    const pairSize = asFiniteNonNegativeNumber(row.pair_size, `rows[${index}].pair_size`);
    const totalCostUsd = asFiniteNonNegativeNumber(row.total_cost_usd, `rows[${index}].total_cost_usd`);
    const pnlUsd = asFiniteNumber(row.pnl_usd, `rows[${index}].pnl_usd`);
    if (Math.abs(pnlUsd - (payoutCount * pairSize - totalCostUsd)) > 1e-6) {
      throw new RangeError(`rows[${index}].pnl_usd contradicts payout and cost`);
    }
    return {
      probeKind: asProbeKind(row.probe_kind, `rows[${index}].probe_kind`),
      asset: asString(row.asset, `rows[${index}].asset`),
      combination: asCombination(row.combination, `rows[${index}].combination`),
      targetSecondsRemaining: asNullableNonNegativeInteger(
        row.target_seconds_remaining,
        `rows[${index}].target_seconds_remaining`,
      ),
      capturedSecondsRemaining: asFiniteNonNegativeNumber(
        row.captured_seconds_remaining,
        `rows[${index}].captured_seconds_remaining`,
      ),
      maxLegPriceCap: asProbability(row.max_leg_price_cap, `rows[${index}].max_leg_price_cap`),
      safetyFraction: asProbability(row.safety_fraction, `rows[${index}].safety_fraction`),
      pairSize,
      totalCostUsd,
      payoutCount: payoutCount as 0 | 1 | 2,
      fatal: row.fatal,
      pnlUsd,
    };
  });
}

export function summarizeResolvedCandidateVariants(rows: readonly ResolvedCandidateVariantRow[]) {
  return {
    overall: summarizeGroup(rows),
    byAsset: groupAndSummarize(rows, (row) => row.asset),
    byHorizon: groupAndSummarize(rows, horizonKey),
    byCombination: groupAndSummarize(rows, (row) => row.combination),
    byPolicy: groupAndSummarize(rows, policyKey),
    byPolicyAndHorizon: groupAndSummarize(rows, (row) => `${policyKey(row)}/${horizonKey(row)}`),
  };
}

function summarizeGroup(rows: readonly ResolvedCandidateVariantRow[]) {
  const fatalCount = rows.reduce((sum, row) => sum + Number(row.fatal), 0);
  const positivePnlCount = rows.reduce((sum, row) => sum + Number(row.pnlUsd > 0), 0);
  const totalPnlUsd = rows.reduce((sum, row) => sum + row.pnlUsd, 0);
  return {
    count: rows.length,
    fatalCount,
    fatalRate: rows.length > 0 ? fatalCount / rows.length : null,
    positivePnlCount,
    positivePnlRate: rows.length > 0 ? positivePnlCount / rows.length : null,
    totalPnlUsd,
    meanPnlUsd: rows.length > 0 ? totalPnlUsd / rows.length : null,
    meanTotalCostUsd: rows.length > 0 ? rows.reduce((sum, row) => sum + row.totalCostUsd, 0) / rows.length : null,
  };
}

function groupAndSummarize(
  rows: readonly ResolvedCandidateVariantRow[],
  keyOf: (row: ResolvedCandidateVariantRow) => string,
) {
  const groups = new Map<string, ResolvedCandidateVariantRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group) {
      group.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, group]) => [key, summarizeGroup(group)]),
  );
}

function horizonKey(row: ResolvedCandidateVariantRow) {
  const band = resolveMismatchCalibrationHorizonBand(row.capturedSecondsRemaining);
  return row.targetSecondsRemaining === null
    ? `candidate/${band ?? "unsupported"}`
    : `late-t${row.targetSecondsRemaining}/${band ?? "unsupported"}`;
}

function policyKey(row: ResolvedCandidateVariantRow) {
  return `max-leg-${row.maxLegPriceCap.toFixed(2)}/safety-${row.safetyFraction.toFixed(2)}`;
}

function parseTimestamp(value: string, flag: string) {
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) && value.trim() !== "" ? numeric : Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${flag} must be an ISO-8601 timestamp or non-negative epoch milliseconds`);
  }
  return parsed;
}

function asProbeKind(value: unknown, field: string): ResolvedCandidateVariantRow["probeKind"] {
  if (value !== "candidate_preflight" && value !== "late_probe") {
    throw new RangeError(`${field} is unsupported`);
  }
  return value;
}

function asCombination(value: unknown, field: string): ResolvedCandidateVariantRow["combination"] {
  if (value !== "POLY_UP_KALSHI_NO" && value !== "POLY_DOWN_KALSHI_YES") {
    throw new RangeError(`${field} is unsupported`);
  }
  return value;
}

function asString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new RangeError(`${field} must be a non-empty string`);
  }
  return value;
}

function asFiniteNumber(value: unknown, field: string) {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new RangeError(`${field} must be finite`);
  }
  return parsed;
}

function asFiniteNonNegativeNumber(value: unknown, field: string) {
  const parsed = asFiniteNumber(value, field);
  if (parsed < 0) {
    throw new RangeError(`${field} must be non-negative`);
  }
  return parsed;
}

function asProbability(value: unknown, field: string) {
  const parsed = asFiniteNonNegativeNumber(value, field);
  if (parsed > 1) {
    throw new RangeError(`${field} must be at most one`);
  }
  return parsed;
}

function asNonNegativeInteger(value: unknown, field: string) {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return parsed;
}

function asNullableNonNegativeInteger(value: unknown, field: string) {
  return value === null || value === undefined ? null : asNonNegativeInteger(value, field);
}

const COVERAGE_QUERY = `
  SELECT
    count(*)::integer AS probe_count,
    count(DISTINCT (asset, slot_key))::integer AS asset_slot_count,
    count(*) FILTER (WHERE resolution.slot_key IS NOT NULL)::integer AS resolved_probe_count,
    min(probe.rest_captured_at) AS first_captured_at,
    max(probe.rest_captured_at) AS last_captured_at
  FROM entry_execution_probes AS probe
  LEFT JOIN slot_resolutions AS resolution
    ON resolution.asset = probe.asset
   AND resolution.slot_key = probe.slot_key
   AND resolution.source = 'official-venue-resolution'
   AND resolution.resolved_at IS NOT NULL
   AND resolution.polymarket_resolution IN ('UP', 'DOWN')
   AND resolution.kalshi_resolution IN ('YES', 'NO')
  WHERE probe.rest_captured_at >= $1
    AND probe.rest_captured_at < $2
`;

const FUNNEL_QUERY = `
  SELECT
    probe_kind,
    COALESCE(first_rejection_stage, 'passed') AS stage,
    COALESCE(first_rejection_code, 'eligible') AS code,
    count(*)::integer AS probe_count,
    count(DISTINCT (asset, slot_key))::integer AS asset_slot_count
  FROM entry_execution_probes
  WHERE rest_captured_at >= $1
    AND rest_captured_at < $2
  GROUP BY probe_kind, stage, code
  ORDER BY probe_kind, probe_count DESC, stage, code
`;

const CANDIDATE_VARIANT_QUERY = `
  WITH expanded AS (
    SELECT
      probe.probe_key,
      probe.probe_kind,
      probe.asset,
      probe.slot_key,
      probe.combination,
      probe.target_seconds_remaining,
      probe.rest_captured_at,
      greatest(0, (probe.slot_end_ts - probe.rest_captured_at)::double precision / 1000) AS captured_seconds_remaining,
      (variant.value ->> 'maxLegPriceCap')::double precision AS max_leg_price_cap,
      (variant.value ->> 'safetyFraction')::double precision AS safety_fraction,
      (variant.value -> 'preflight' -> 'quote' ->> 'commonSize')::double precision AS pair_size,
      (variant.value -> 'preflight' -> 'quote' ->> 'worstFillCostUsd')::double precision AS total_cost_usd,
      CASE probe.combination
        WHEN 'POLY_UP_KALSHI_NO' THEN
          (resolution.polymarket_resolution = 'UP')::integer + (resolution.kalshi_resolution = 'NO')::integer
        WHEN 'POLY_DOWN_KALSHI_YES' THEN
          (resolution.polymarket_resolution = 'DOWN')::integer + (resolution.kalshi_resolution = 'YES')::integer
      END AS payout_count
    FROM entry_execution_probes AS probe
    JOIN slot_resolutions AS resolution
      ON resolution.asset = probe.asset
     AND resolution.slot_key = probe.slot_key
     AND resolution.source = 'official-venue-resolution'
     AND resolution.resolved_at IS NOT NULL
     AND resolution.polymarket_resolution IN ('UP', 'DOWN')
     AND resolution.kalshi_resolution IN ('YES', 'NO')
    CROSS JOIN LATERAL jsonb_array_elements(probe.variants_json) AS variant(value)
    WHERE probe.rest_captured_at >= $1
      AND probe.rest_captured_at < $2
      AND variant.value -> 'eligible' = 'true'::jsonb
      AND jsonb_typeof(variant.value -> 'maxLegPriceCap') = 'number'
      AND jsonb_typeof(variant.value -> 'safetyFraction') = 'number'
      AND jsonb_typeof(variant.value -> 'preflight' -> 'quote' -> 'commonSize') = 'number'
      AND jsonb_typeof(variant.value -> 'preflight' -> 'quote' -> 'worstFillCostUsd') = 'number'
  ), ranked AS (
    SELECT
      expanded.*,
      row_number() OVER (
        PARTITION BY
          probe_kind, asset, slot_key, combination, target_seconds_remaining,
          max_leg_price_cap, safety_fraction
        ORDER BY rest_captured_at ASC, probe_key ASC
      ) AS cohort_rank
    FROM expanded
  )
  SELECT
    probe_kind,
    asset,
    combination,
    target_seconds_remaining,
    captured_seconds_remaining,
    max_leg_price_cap,
    safety_fraction,
    pair_size,
    total_cost_usd,
    payout_count,
    payout_count = 0 AS fatal,
    payout_count * pair_size - total_cost_usd AS pnl_usd
  FROM ranked
  WHERE cohort_rank = 1
  ORDER BY rest_captured_at ASC, probe_key ASC, max_leg_price_cap ASC, safety_fraction ASC
`;

function usage() {
  return `Usage: node --import tsx scripts/analyze-mismatch-candidates.ts [options]\n\nRead-only analysis of immutable REST entry probes joined to official dual-venue resolutions. Counterfactual variants are deduplicated to the earliest eligible observation per asset/slot/combination/horizon/policy.\n\nOptions:\n  --from <ISO|epoch-ms>  Window lower bound (default: retained 45-day window)\n  --to <ISO|epoch-ms>    Window upper bound (default: now)\n  --help                 Show this help\n`;
}

function isDirectExecution() {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && path.resolve(entrypoint) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  runMismatchCandidateAnalysisCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
