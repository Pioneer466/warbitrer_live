import { Pool, types } from "pg";

import {
  DEFAULT_STRATEGY_CONFIGS,
  POLYMARKET_MIN_MARKET_BUY_AMOUNT_USD,
} from "@/lib/constants";
import {
  applySlippage,
  calculateKalshiFee,
  calculatePolymarketFee,
} from "@/lib/fees";
import { ACTIVE_MARKET_ASSETS, isMarketAsset, MARKET_ASSETS } from "@/lib/market-catalog";
import { normalizeSettings, normalizeSettingsMap } from "@/lib/settings-schema";
import { buildSignals } from "@/lib/signals";
import type {
  KalshiQuote,
  LiveOpportunity,
  MarketAsset,
  OpportunitySnapshot,
  PairCombination,
  PolymarketQuote,
  StrategyConfig,
  StrategyConfigMap,
  Venue,
  VenueBalance,
} from "@/lib/types";

types.setTypeParser(20, (value) => Number(value));

const ORDER_SIZE_TOLERANCE = 1e-6;
const BACKTEST_DEPTH_HAIRCUT = 0.8;
const MEDIUM_REALISM_DEPTH_HAIRCUT = 0.85;
const LOW_REALISM_DEPTH_HAIRCUT = 0.7;
const INCIDENT_PENALTY_USD = 1;
const NO_FILL_PENALTY_USD = 0.25;
const DRAWDOWN_PENALTY_MULTIPLIER = 0.25;
const MISMATCH_LOSS_PENALTY_MULTIPLIER = 0.5;

export const BACKTEST_EXPORT_TABLES = [
  "opportunity_snapshots",
  "order_intents",
  "venue_orders",
  "fills",
  "settlements",
  "market_fill_quality_events",
  "pnl_snapshots",
  "run_events",
  "strategy_configs",
  "circuit_breakers",
] as const;

export type BacktestVariantName =
  | "current_safe"
  | "mismatch_off_depth_safe"
  | "mismatch_soft"
  | "loose_thresholds"
  | "dynamic_primary_shadow"
  | "theoretical_bruteforce";

export type BacktestRealismGrade = "high" | "medium" | "low";
export type BacktestTradeStatus = "filled" | "skipped" | "no_fill" | "incident" | "unresolved";

export type BacktestOptions = {
  databaseUrl: string;
  from: number;
  to: number;
  assets: MarketAsset[];
};

export type BacktestVariant = {
  name: BacktestVariantName;
  deployable: boolean;
  settingsByAsset: StrategyConfigMap;
  allowDepthBypass: boolean;
};

export type BacktestTradeRow = {
  variant: BacktestVariantName;
  deployable: boolean;
  asset: MarketAsset;
  slotKey: string;
  capturedAt: number;
  capturedAtIso: string;
  combination: PairCombination | null;
  primaryVenue: Venue | null;
  status: BacktestTradeStatus;
  realismGrade: BacktestRealismGrade;
  grossCost: number | null;
  projectedNetProfitUsd: number | null;
  size: number;
  polyPrice: number | null;
  kalshiPrice: number | null;
  polyResolution: "UP" | "DOWN" | null;
  kalshiResolution: "YES" | "NO" | null;
  payoutUsd: number | null;
  costUsd: number | null;
  feeUsd: number | null;
  pnlUsd: number | null;
  roi: number | null;
  mismatch: boolean;
  mismatchLossUsd: number;
  noFill: boolean;
  incident: boolean;
  skipReason: string | null;
};

export type BacktestSummaryRow = {
  variant: BacktestVariantName;
  deployable: boolean;
  realismGrade: BacktestRealismGrade;
  simulatedSlots: number;
  trades: number;
  resolvedTrades: number;
  skipped: number;
  unresolved: number;
  noFills: number;
  incidents: number;
  mismatches: number;
  netPnlUsd: number;
  roi: number | null;
  totalCostUsd: number;
  maxDrawdownUsd: number;
  mismatchLossUsd: number;
  noFillRate: number;
  incidentRate: number;
  riskScoreUsd: number;
};

export type BacktestResult = {
  generatedAt: number;
  from: number;
  to: number;
  assets: MarketAsset[];
  summaries: BacktestSummaryRow[];
  trades: BacktestTradeRow[];
  reportMarkdown: string;
};

type SnapshotRow = {
  id: number;
  asset: MarketAsset;
  slot_key: string;
  slot_start_ts: number;
  slot_end_ts: number;
  captured_at: number;
  polymarket_json: unknown;
  kalshi_json: unknown;
};

type ResolutionRecord = {
  polyResolution: "UP" | "DOWN" | null;
  kalshiResolution: "YES" | "NO" | null;
};

export function parseBacktestAssets(value: string | null | undefined): MarketAsset[] {
  if (!value || value === "active") {
    return ACTIVE_MARKET_ASSETS;
  }
  if (value === "all") {
    return MARKET_ASSETS;
  }
  const assets = value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const invalid = assets.filter((asset) => !isMarketAsset(asset));
  if (invalid.length > 0) {
    throw new Error(`Invalid asset(s): ${invalid.join(", ")}`);
  }
  return assets as MarketAsset[];
}

export function buildBacktestVariants(baseSettings: StrategyConfigMap): BacktestVariant[] {
  return [
    {
      name: "current_safe",
      deployable: true,
      settingsByAsset: normalizeSettingsMap(baseSettings),
      allowDepthBypass: false,
    },
    {
      name: "mismatch_off_depth_safe",
      deployable: true,
      settingsByAsset: mapSettings(baseSettings, (settings) => ({
        ...settings,
        mismatchGuardEnabled: false,
      })),
      allowDepthBypass: false,
    },
    {
      name: "mismatch_soft",
      deployable: true,
      settingsByAsset: mapSettings(baseSettings, (settings) => ({
        ...settings,
        mismatchGuardEnabled: true,
        mismatchGuardMinElapsedSeconds: Math.max(0, Math.min(settings.mismatchGuardMinElapsedSeconds, 30)),
        mismatchGuardMinMoveBps: Math.max(0, Math.min(settings.mismatchGuardMinMoveBps, 2)),
        mismatchGuardPhase2MinMoveBps: Math.max(0, Math.min(settings.mismatchGuardPhase2MinMoveBps, 5)),
        mismatchGuardMaxVenueDisagreementPct: Math.max(settings.mismatchGuardMaxVenueDisagreementPct, 0.18),
      })),
      allowDepthBypass: false,
    },
    {
      name: "loose_thresholds",
      deployable: true,
      settingsByAsset: mapSettings(baseSettings, (settings) => ({
        ...settings,
        grossEntryThreshold: Math.max(settings.grossEntryThreshold, 0.97),
        minProjectedNetProfitUsd: Math.min(settings.minProjectedNetProfitUsd, 0.05),
        minProjectedNetReturn: Math.min(settings.minProjectedNetReturn, 0.005),
        minWorstCaseProfitUsd: Math.min(settings.minWorstCaseProfitUsd, 0.05),
      })),
      allowDepthBypass: false,
    },
    {
      name: "dynamic_primary_shadow",
      deployable: true,
      settingsByAsset: mapSettings(baseSettings, (settings) => ({
        ...settings,
        primarySelectionMode: "dynamic",
      })),
      allowDepthBypass: false,
    },
    {
      name: "theoretical_bruteforce",
      deployable: false,
      settingsByAsset: mapSettings(baseSettings, (settings) => ({
        ...settings,
        grossEntryThreshold: 0.99,
        minProjectedNetProfitUsd: 0,
        minProjectedNetReturn: 0,
        minWorstCaseProfitUsd: 0,
        maxLegPrice: 0.99,
        minimumEntryDepthCoverageRatio: 0.01,
        mismatchGuardEnabled: false,
        primarySelectionMode: "dynamic",
      })),
      allowDepthBypass: true,
    },
  ];
}

export async function runBacktestStrategies(options: BacktestOptions): Promise<BacktestResult> {
  const pool = new Pool({
    connectionString: options.databaseUrl,
    max: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
  });

  try {
    const [snapshots, settings, resolutions] = await Promise.all([
      readSnapshots(pool, options),
      readSettingsFromDb(pool),
      readResolutionMap(pool, options),
    ]);
    const variants = buildBacktestVariants(settings);
    const trades = variants.flatMap((variant) => simulateVariant(variant, snapshots, resolutions));
    const summaries = variants
      .map((variant) => summarizeVariant(variant, trades.filter((trade) => trade.variant === variant.name)))
      .sort((left, right) => right.riskScoreUsd - left.riskScoreUsd);

    return {
      generatedAt: Date.now(),
      from: options.from,
      to: options.to,
      assets: options.assets,
      summaries,
      trades,
      reportMarkdown: buildBacktestMarkdownReport(options, summaries, trades),
    };
  } finally {
    await pool.end();
  }
}

export function simulateVariant(
  variant: BacktestVariant,
  snapshots: OpportunitySnapshot[],
  resolutions: Map<string, ResolutionRecord>,
): BacktestTradeRow[] {
  const tradedSlots = new Set<string>();
  const rows: BacktestTradeRow[] = [];

  for (const snapshot of snapshots) {
    const key = `${variant.name}:${snapshot.asset}:${snapshot.slotKey}`;
    if (tradedSlots.has(key)) {
      continue;
    }

    const settings = variant.settingsByAsset[snapshot.asset];
    const opportunities = buildSignals({
      slotKey: snapshot.slotKey,
      now: snapshot.capturedAt,
      slotStartTs: snapshot.slotStartTs,
      polymarket: snapshot.polymarket,
      kalshi: snapshot.kalshi,
      settings,
      balances: buildUnlimitedBalances(snapshot.capturedAt),
      lastEntryCosts: {},
      secondsRemaining: Math.max(0, Math.floor((snapshot.slotEndTs - snapshot.capturedAt) / 1000)),
    });
    const selected = selectBacktestOpportunity(opportunities);
    if (!selected) {
      continue;
    }

    tradedSlots.add(key);
    rows.push(simulateOpportunity(variant, settings, snapshot, selected, resolutions.get(snapshot.slotKey) ?? null));
  }

  return rows;
}

export function simulateOpportunity(
  variant: Pick<BacktestVariant, "name" | "deployable" | "allowDepthBypass">,
  settings: StrategyConfig,
  snapshot: OpportunitySnapshot,
  opportunity: LiveOpportunity,
  resolution: ResolutionRecord | null,
): BacktestTradeRow {
  const realismGrade = getSnapshotRealismGrade(snapshot);
  const baseRow = buildBaseTradeRow(variant, snapshot, opportunity, realismGrade, resolution);
  if (!opportunity.eligible) {
    return {
      ...baseRow,
      status: "skipped",
      skipReason: opportunity.reasons.join(" · ") || "not eligible",
    };
  }
  if (!opportunity.primaryVenue) {
    return {
      ...baseRow,
      status: "skipped",
      skipReason: "no primary venue selected",
    };
  }

  const polyLeg = opportunity.legs.find((leg) => leg.venue === "polymarket");
  const kalshiLeg = opportunity.legs.find((leg) => leg.venue === "kalshi");
  if (!polyLeg || !kalshiLeg || polyLeg.price === null || kalshiLeg.price === null) {
    return {
      ...baseRow,
      status: "skipped",
      skipReason: "missing executable leg price",
    };
  }

  const pairedSize = Math.min(polyLeg.size, kalshiLeg.size);
  if (pairedSize <= ORDER_SIZE_TOLERANCE) {
    return {
      ...baseRow,
      status: "skipped",
      skipReason: "zero paired size",
    };
  }
  if (pairedSize * polyLeg.price + ORDER_SIZE_TOLERANCE < POLYMARKET_MIN_MARKET_BUY_AMOUNT_USD) {
    return {
      ...baseRow,
      status: "skipped",
      skipReason: "polymarket minimum buy notional not met",
    };
  }

  const depthCheck = checkDepth(opportunity, pairedSize, settings, realismGrade, variant.allowDepthBypass);
  if (!depthCheck.ok) {
    return {
      ...baseRow,
      status: "no_fill",
      noFill: true,
      skipReason: depthCheck.reason,
    };
  }
  if (!resolution?.polyResolution || !resolution.kalshiResolution) {
    return {
      ...baseRow,
      status: "unresolved",
      size: pairedSize,
      skipReason: "venue resolution unavailable in local dump",
    };
  }

  const slippageBps = computeBacktestSlippageBps(opportunity, pairedSize, settings, realismGrade);
  const polyExecutionPrice = round4(applySlippage(polyLeg.price, slippageBps, "BUY"));
  const kalshiExecutionPrice = round4(applySlippage(kalshiLeg.price, slippageBps, "BUY"));
  const polyFeeUsd = calculatePolymarketFee({
    shares: pairedSize,
    price: polyExecutionPrice,
    feeRateBps: snapshot.polymarket.feeRateBps,
  });
  const kalshiFeeUsd = calculateKalshiFee({
    contracts: pairedSize,
    price: kalshiExecutionPrice,
    feeMultiplier: snapshot.kalshi.feeMultiplier,
    maker: false,
  });
  const polyWon = polyLeg.outcome === resolution.polyResolution;
  const kalshiWon = kalshiLeg.outcome === resolution.kalshiResolution;
  const payoutUsd = round4((polyWon ? pairedSize : 0) + (kalshiWon ? pairedSize : 0));
  const feeUsd = round4(polyFeeUsd + kalshiFeeUsd);
  const costUsd = round4(pairedSize * polyExecutionPrice + pairedSize * kalshiExecutionPrice + feeUsd);
  const pnlUsd = round4(payoutUsd - costUsd);
  const mismatch = isVenueResolutionMismatch(resolution);
  const normalPayoutUsd = pairedSize;
  const mismatchLossUsd = mismatch ? Math.max(0, round4(normalPayoutUsd - payoutUsd)) : 0;

  return {
    ...baseRow,
    status: "filled",
    size: round4(pairedSize),
    polyPrice: polyExecutionPrice,
    kalshiPrice: kalshiExecutionPrice,
    payoutUsd,
    costUsd,
    feeUsd,
    pnlUsd,
    roi: costUsd > ORDER_SIZE_TOLERANCE ? round4(pnlUsd / costUsd) : null,
    mismatch,
    mismatchLossUsd,
  };
}

export function summarizeVariant(variant: BacktestVariant, trades: BacktestTradeRow[]): BacktestSummaryRow {
  const resolved = trades.filter((trade) => trade.status === "filled" && trade.pnlUsd !== null);
  const netPnlUsd = round4(resolved.reduce((sum, trade) => sum + (trade.pnlUsd ?? 0), 0));
  const totalCostUsd = round4(resolved.reduce((sum, trade) => sum + (trade.costUsd ?? 0), 0));
  const maxDrawdownUsd = computeMaxDrawdown(resolved);
  const noFills = trades.filter((trade) => trade.noFill).length;
  const incidents = trades.filter((trade) => trade.incident).length;
  const mismatchLossUsd = round4(trades.reduce((sum, trade) => sum + trade.mismatchLossUsd, 0));
  const riskScoreUsd = round4(
    netPnlUsd -
      Math.abs(maxDrawdownUsd) * DRAWDOWN_PENALTY_MULTIPLIER -
      incidents * INCIDENT_PENALTY_USD -
      noFills * NO_FILL_PENALTY_USD -
      mismatchLossUsd * MISMATCH_LOSS_PENALTY_MULTIPLIER,
  );

  return {
    variant: variant.name,
    deployable: variant.deployable,
    realismGrade: summarizeRealismGrade(trades),
    simulatedSlots: new Set(trades.map((trade) => `${trade.asset}:${trade.slotKey}`)).size,
    trades: trades.length,
    resolvedTrades: resolved.length,
    skipped: trades.filter((trade) => trade.status === "skipped").length,
    unresolved: trades.filter((trade) => trade.status === "unresolved").length,
    noFills,
    incidents,
    mismatches: trades.filter((trade) => trade.mismatch).length,
    netPnlUsd,
    roi: totalCostUsd > ORDER_SIZE_TOLERANCE ? round4(netPnlUsd / totalCostUsd) : null,
    totalCostUsd,
    maxDrawdownUsd,
    mismatchLossUsd,
    noFillRate: trades.length > 0 ? round4(noFills / trades.length) : 0,
    incidentRate: trades.length > 0 ? round4(incidents / trades.length) : 0,
    riskScoreUsd,
  };
}

export function backtestSummariesToCsv(rows: BacktestSummaryRow[]) {
  return toCsv(rows, [
    "variant",
    "deployable",
    "realismGrade",
    "simulatedSlots",
    "trades",
    "resolvedTrades",
    "skipped",
    "unresolved",
    "noFills",
    "incidents",
    "mismatches",
    "netPnlUsd",
    "roi",
    "totalCostUsd",
    "maxDrawdownUsd",
    "mismatchLossUsd",
    "noFillRate",
    "incidentRate",
    "riskScoreUsd",
  ]);
}

export function backtestTradesToCsv(rows: BacktestTradeRow[]) {
  return toCsv(rows, [
    "variant",
    "deployable",
    "asset",
    "slotKey",
    "capturedAtIso",
    "combination",
    "primaryVenue",
    "status",
    "realismGrade",
    "grossCost",
    "projectedNetProfitUsd",
    "size",
    "polyPrice",
    "kalshiPrice",
    "polyResolution",
    "kalshiResolution",
    "payoutUsd",
    "costUsd",
    "feeUsd",
    "pnlUsd",
    "roi",
    "mismatch",
    "mismatchLossUsd",
    "noFill",
    "incident",
    "skipReason",
  ]);
}

export function buildBacktestExportCommand(options: {
  database?: string;
  output?: string;
  tables?: readonly string[];
}) {
  const database = options.database ?? "warbitrer_live";
  const output = options.output ?? "/tmp/warbitrer-backtest.dump";
  const tableArgs = (options.tables ?? BACKTEST_EXPORT_TABLES)
    .map((table) => `-t ${shellQuote(`public.${table}`)}`)
    .join(" ");
  const dump = `nice -n 10 ionice -c2 -n7 pg_dump -Fc --no-owner --no-acl -d ${shellQuote(database)} ${tableArgs} -f ${shellQuote(output)}`;

  return [
    "# Run on the VPS, preferably outside the most active trading window:",
    `sudo -u postgres bash -lc ${shellQuote(dump)}`,
    "",
    "# Then copy the dump to your local machine, for example:",
    `scp root@TON_VPS:${output} ./backtest-data/warbitrer.dump`,
  ].join("\n");
}

async function readSnapshots(pool: Pool, options: BacktestOptions): Promise<OpportunitySnapshot[]> {
  const result = await pool.query<SnapshotRow>(
    `
      SELECT id, asset, slot_key, slot_start_ts, slot_end_ts, captured_at, polymarket_json, kalshi_json
      FROM opportunity_snapshots
      WHERE captured_at BETWEEN $1 AND $2
        AND asset = ANY($3::text[])
      ORDER BY captured_at ASC, id ASC
    `,
    [options.from, options.to, options.assets],
  );

  return result.rows.map((row) => ({
    id: row.id,
    asset: row.asset,
    slotKey: row.slot_key,
    slotStartTs: row.slot_start_ts,
    slotEndTs: row.slot_end_ts,
    capturedAt: row.captured_at,
    polymarket: row.polymarket_json as PolymarketQuote,
    kalshi: row.kalshi_json as KalshiQuote,
    opportunities: [],
  }));
}

async function readSettingsFromDb(pool: Pool): Promise<StrategyConfigMap> {
  const result = await pool.query<{ asset: MarketAsset; payload: unknown }>(
    "SELECT asset, payload FROM strategy_configs",
  ).catch(() => ({ rows: [] as Array<{ asset: MarketAsset; payload: unknown }> }));
  const partial: Partial<StrategyConfigMap> = {};
  for (const row of result.rows) {
    if (isMarketAsset(row.asset)) {
      partial[row.asset] = normalizeSettings(row.payload as Partial<StrategyConfig>);
    }
  }
  return normalizeSettingsMap({
    ...DEFAULT_STRATEGY_CONFIGS,
    ...partial,
  });
}

async function readResolutionMap(pool: Pool, options: BacktestOptions) {
  const result = await pool.query<{
    asset: MarketAsset;
    slot_key: string;
    poly_resolution: "UP" | "DOWN" | null;
    kalshi_resolution: "YES" | "NO" | null;
  }>(
    `
      SELECT DISTINCT ON (asset, slot_key)
        asset, slot_key, poly_resolution, kalshi_resolution
      FROM order_intents
      WHERE slot_start_ts BETWEEN $1 AND $2
        AND asset = ANY($3::text[])
        AND poly_resolution IS NOT NULL
        AND kalshi_resolution IS NOT NULL
      ORDER BY asset, slot_key, resolved_at DESC NULLS LAST, updated_at DESC
    `,
    [options.from - 15 * 60_000, options.to, options.assets],
  );
  return new Map(
    result.rows.map((row) => [
      row.slot_key,
      {
        polyResolution: row.poly_resolution,
        kalshiResolution: row.kalshi_resolution,
      },
    ]),
  );
}

function mapSettings(
  base: StrategyConfigMap,
  mapper: (settings: StrategyConfig, asset: MarketAsset) => Partial<StrategyConfig>,
): StrategyConfigMap {
  return normalizeSettingsMap(
    Object.fromEntries(
      MARKET_ASSETS.map((asset) => [
        asset,
        {
          ...base[asset],
          ...mapper(base[asset], asset),
        },
      ]),
    ) as Partial<StrategyConfigMap>,
  );
}

function selectBacktestOpportunity(opportunities: LiveOpportunity[]) {
  const eligible = opportunities.filter((opportunity) => opportunity.eligible);
  if (eligible.length === 0) {
    return null;
  }
  return [...eligible].sort((left, right) => {
    const profitDelta = (right.projectedNetProfitUsd ?? 0) - (left.projectedNetProfitUsd ?? 0);
    if (Math.abs(profitDelta) > ORDER_SIZE_TOLERANCE) {
      return profitDelta;
    }
    return (left.grossCost ?? Number.POSITIVE_INFINITY) - (right.grossCost ?? Number.POSITIVE_INFINITY);
  })[0] ?? null;
}

function buildBaseTradeRow(
  variant: Pick<BacktestVariant, "name" | "deployable">,
  snapshot: OpportunitySnapshot,
  opportunity: LiveOpportunity,
  realismGrade: BacktestRealismGrade,
  resolution: ResolutionRecord | null,
): BacktestTradeRow {
  const polyLeg = opportunity.legs.find((leg) => leg.venue === "polymarket");
  const kalshiLeg = opportunity.legs.find((leg) => leg.venue === "kalshi");
  return {
    variant: variant.name,
    deployable: variant.deployable,
    asset: snapshot.asset,
    slotKey: snapshot.slotKey,
    capturedAt: snapshot.capturedAt,
    capturedAtIso: new Date(snapshot.capturedAt).toISOString(),
    combination: opportunity.combination,
    primaryVenue: opportunity.primaryVenue,
    status: "skipped",
    realismGrade,
    grossCost: opportunity.grossCost,
    projectedNetProfitUsd: opportunity.projectedNetProfitUsd,
    size: 0,
    polyPrice: polyLeg?.price ?? null,
    kalshiPrice: kalshiLeg?.price ?? null,
    polyResolution: resolution?.polyResolution ?? null,
    kalshiResolution: resolution?.kalshiResolution ?? null,
    payoutUsd: null,
    costUsd: null,
    feeUsd: null,
    pnlUsd: null,
    roi: null,
    mismatch: resolution ? isVenueResolutionMismatch(resolution) : false,
    mismatchLossUsd: 0,
    noFill: false,
    incident: false,
    skipReason: null,
  };
}

function checkDepth(
  opportunity: LiveOpportunity,
  size: number,
  settings: StrategyConfig,
  realismGrade: BacktestRealismGrade,
  allowDepthBypass: boolean,
) {
  if (allowDepthBypass) {
    return { ok: true, reason: null };
  }

  const haircut = getDepthHaircut(realismGrade);
  for (const leg of opportunity.legs) {
    const adjustedDepth = (leg.depth ?? 0) * haircut;
    const coverage = size > ORDER_SIZE_TOLERANCE ? adjustedDepth / size : 0;
    if (coverage + ORDER_SIZE_TOLERANCE < settings.minimumEntryDepthCoverageRatio) {
      return {
        ok: false,
        reason: `${leg.venue} depth coverage ${round4(coverage)} below ${settings.minimumEntryDepthCoverageRatio}`,
      };
    }
    if (adjustedDepth + ORDER_SIZE_TOLERANCE < size) {
      return {
        ok: false,
        reason: `${leg.venue} exact-size depth insufficient after conservative haircut`,
      };
    }
  }

  return { ok: true, reason: null };
}

function computeBacktestSlippageBps(
  opportunity: LiveOpportunity,
  size: number,
  settings: StrategyConfig,
  realismGrade: BacktestRealismGrade,
) {
  const haircut = getDepthHaircut(realismGrade);
  const minCoverage = Math.min(
    ...opportunity.legs.map((leg) => ((leg.depth ?? 0) * haircut) / Math.max(size, ORDER_SIZE_TOLERANCE)),
  );
  if (minCoverage >= 2) {
    return settings.adaptiveSlippageTightBps;
  }
  if (minCoverage >= 1) {
    return settings.adaptiveSlippageDefaultBps;
  }
  return settings.adaptiveSlippageThinBps;
}

function getSnapshotRealismGrade(snapshot: OpportunitySnapshot): BacktestRealismGrade {
  const hasKalshiDepth = Boolean(snapshot.kalshi.orderbookLevels);
  const polyWithLevels = snapshot.polymarket as PolymarketQuote & {
    orderbookLevels?: unknown;
  };
  if (hasKalshiDepth && polyWithLevels.orderbookLevels) {
    return "high";
  }
  if (hasKalshiDepth) {
    return "medium";
  }
  return "low";
}

function getDepthHaircut(realismGrade: BacktestRealismGrade) {
  if (realismGrade === "high") {
    return BACKTEST_DEPTH_HAIRCUT;
  }
  if (realismGrade === "medium") {
    return BACKTEST_DEPTH_HAIRCUT * MEDIUM_REALISM_DEPTH_HAIRCUT;
  }
  return BACKTEST_DEPTH_HAIRCUT * LOW_REALISM_DEPTH_HAIRCUT;
}

function isVenueResolutionMismatch(resolution: ResolutionRecord) {
  return (
    (resolution.polyResolution === "UP" && resolution.kalshiResolution !== "YES") ||
    (resolution.polyResolution === "DOWN" && resolution.kalshiResolution !== "NO")
  );
}

function summarizeRealismGrade(trades: BacktestTradeRow[]): BacktestRealismGrade {
  if (trades.some((trade) => trade.realismGrade === "low")) {
    return "low";
  }
  if (trades.some((trade) => trade.realismGrade === "medium")) {
    return "medium";
  }
  return "high";
}

function computeMaxDrawdown(trades: BacktestTradeRow[]) {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of trades.sort((left, right) => left.capturedAt - right.capturedAt)) {
    equity = round4(equity + (trade.pnlUsd ?? 0));
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, round4(equity - peak));
  }
  return maxDrawdown;
}

function buildUnlimitedBalances(now: number): VenueBalance[] {
  return [
    buildUnlimitedBalance("polymarket", now),
    buildUnlimitedBalance("kalshi", now),
  ];
}

function buildUnlimitedBalance(venue: Venue, now: number): VenueBalance {
  return {
    venue,
    capturedAt: now,
    status: "ready",
    currency: venue === "kalshi" ? "USD" : "pUSD",
    availableBalanceUsd: 1_000_000,
    totalBalanceUsd: 1_000_000,
    portfolioValueUsd: 1_000_000,
    allowanceUsd: venue === "polymarket" ? 1_000_000 : null,
    notes: [],
    raw: { backtest: true },
  };
}

function buildBacktestMarkdownReport(
  options: Pick<BacktestOptions, "from" | "to" | "assets">,
  summaries: BacktestSummaryRow[],
  trades: BacktestTradeRow[],
) {
  const best = summaries[0] ?? null;
  const lines = [
    "# Warbitrer Backtest Report",
    "",
    `Window: ${new Date(options.from).toISOString()} -> ${new Date(options.to).toISOString()}`,
    `Assets: ${options.assets.join(", ")}`,
    `Trades simulated: ${trades.length}`,
    "",
    "## Ranking",
    "",
    "| Variant | Deployable | Risk score | Net P&L | Trades | No-fill | Incidents | Mismatch loss | Realism |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...summaries.map((summary) =>
      `| ${summary.variant} | ${summary.deployable ? "yes" : "no"} | ${formatUsd(summary.riskScoreUsd)} | ${formatUsd(summary.netPnlUsd)} | ${summary.resolvedTrades}/${summary.trades} | ${(summary.noFillRate * 100).toFixed(1)}% | ${(summary.incidentRate * 100).toFixed(1)}% | ${formatUsd(summary.mismatchLossUsd)} | ${summary.realismGrade} |`,
    ),
    "",
    "## Conclusion",
    "",
    best
      ? `Best risk-adjusted variant: **${best.variant}** with risk score ${formatUsd(best.riskScoreUsd)} and net P&L ${formatUsd(best.netPnlUsd)}.`
      : "No variant produced simulated trades.",
    "",
    "## Realism Notes",
    "",
    "- Current historical data is medium realism when Kalshi depth exists but Polymarket only has top depth.",
    "- `theoretical_bruteforce` is non-deployable and only bounds optimistic upside.",
    "- Unresolved slots are excluded from net P&L and shown separately in CSV outputs.",
  ];
  return `${lines.join("\n")}\n`;
}

function toCsv<T extends Record<string, unknown>>(rows: T[], columns: Array<keyof T>) {
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n") + "\n";
}

function csvCell(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  if (!/[",\n]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function formatUsd(value: number) {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
