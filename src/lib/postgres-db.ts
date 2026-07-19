import { Pool, PoolClient, types } from "pg";

import {
  assertDatabaseSchemaCompatible,
  getDatabaseMigrationStatus,
  runDatabaseMigrations,
  type DatabaseMigration,
  type PgQueryable,
} from "@/lib/db-migrations";
import { MARKET_ASSETS } from "@/lib/market-catalog";
import type { DatabaseMaintenanceConfig } from "@/lib/db-maintenance";
import { enrichPnlSnapshot } from "@/lib/pnl";
import { isRiskActivePosition } from "@/lib/positions";
import { normalizeSettings, normalizeSettingsMap } from "@/lib/settings-schema";
import { normalizeGlobalRiskConfig, type GlobalRiskConfig } from "@/lib/risk-settings";
import { SLOT_RESOLUTION_RETENTION_MS, type OracleSlotSample, type SlotResolutionRecord } from "@/lib/oracle-history";
import type {
  MarketAsset,
  DatabaseMaintenanceSummary,
  DatabaseMetrics,
  BridgeTransfer,
  CircuitBreaker,
  DashboardResponse,
  ExecutionCandidate,
  PortfolioDashboardResponse,
  HistoryPoint,
  LiveFill,
  LiveOpportunity,
  LiveOrder,
  MarketSlot,
  MarketFillQualityEvent,
  MarketFillQualityOutcome,
  NotificationDelivery,
  OrderAttempt,
  OrderIntent,
  OpportunitySnapshot,
  PairCombination,
  PnlSnapshot,
  FillQualitySummary,
  PositionSnapshot,
  ReadinessCheck,
  RunEvent,
  StablePnlChange,
  StrategyConfig,
  StrategyConfigMap,
  TradesResponse,
  Venue,
  VenueBalance,
  VenueCashAdjustmentObservation,
  WorkerLoopHealth,
  WorkerState,
} from "@/lib/types";

types.setTypeParser(20, (value) => Number(value));

type NotificationDeliveryRow = {
  id: number;
  asset: MarketAsset | null;
  channel: NotificationDelivery["channel"];
  kind: NotificationDelivery["kind"];
  dedupe_key: string;
  message: string;
  payload_json: NotificationDelivery["payload"];
  status: NotificationDelivery["status"];
  error: string | null;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
};

type OpportunitySnapshotRow = {
  id: number;
  asset: MarketAsset;
  slot_key: string;
  slot_start_ts: number;
  slot_end_ts: number;
  captured_at: number;
  polymarket_json: OpportunitySnapshot["polymarket"];
  kalshi_json: OpportunitySnapshot["kalshi"];
  opportunities_json: OpportunitySnapshot["opportunities"] | null;
};

type SlotResolutionRow = {
  asset: SlotResolutionRecord["asset"];
  slot_key: string;
  slot_start_ts: number;
  slot_end_ts: number;
  polymarket_slug: string;
  polymarket_market_ref: string | null;
  kalshi_market_ref: string | null;
  polymarket_resolution: SlotResolutionRecord["polymarketResolution"];
  kalshi_resolution: SlotResolutionRecord["kalshiResolution"];
  polymarket_settlement_value_usd: number | null;
  kalshi_settlement_value_usd: number | null;
  first_observed_at: number;
  updated_at: number;
  resolved_at: number | null;
  source: string;
  raw_json: Record<string, unknown> | null;
};

type OrderIntentRow = {
  id: string;
  asset: MarketAsset;
  shadow: boolean;
  slot_key: string;
  slot_start_ts: number;
  slot_end_ts: number;
  combination: OrderIntent["combination"];
  status: OrderIntent["status"];
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  primary_venue: OrderIntent["primaryVenue"];
  hedge_venue: OrderIntent["hedgeVenue"];
  gross_cost: number;
  target_notional_usd: number;
  entry_sizing_reason: string | null;
  max_slippage_bps: number;
  failure_reason: string | null;
  projected_net_profit_usd: number | null;
  mismatch_p_fatal: number | null;
  mismatch_p_fatal_upper: number | null;
  mismatch_model_version: string | null;
  fatal_mismatch_pnl_usd: number | null;
  conservative_expected_pnl_usd: number | null;
  fatal_loss_exposure_usd: number | null;
  mismatch_risk_audit_json: OrderIntent["mismatchRiskAudit"];
  shadow_execution_json: OrderIntent["shadowExecution"];
  realized_pnl_usd: number | null;
  roi: number | null;
  poly_resolution: OrderIntent["polyResolution"];
  kalshi_resolution: OrderIntent["kalshiResolution"];
  legs_json: OrderIntent["legs"];
};

type VenueOrderRow = {
  id: string;
  asset: MarketAsset;
  shadow: boolean;
  intent_id: string;
  venue: LiveOrder["venue"];
  venue_order_id: string;
  client_order_id: string | null;
  market_ref: string;
  token_id: string | null;
  side: LiveOrder["side"];
  outcome: LiveOrder["outcome"];
  order_type: string;
  requested_price: number | null;
  requested_size: number;
  filled_size: number;
  average_fill_price: number | null;
  fee_usd: number | null;
  status: LiveOrder["status"];
  created_at: number;
  updated_at: number;
  raw_json: Record<string, unknown> | null;
};

type OrderAttemptRow = {
  id: string;
  asset: MarketAsset;
  shadow: boolean;
  intent_id: string;
  leg_id: string;
  stage: string;
  venue: OrderAttempt["venue"];
  side: OrderAttempt["side"];
  order_type: string;
  client_order_id: string;
  venue_order_id: string | null;
  status: OrderAttempt["status"];
  truth_status: string | null;
  request_json: Record<string, unknown> | null;
  result_json: Record<string, unknown> | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

type FillRow = {
  id: string;
  asset: MarketAsset;
  shadow: boolean;
  intent_id: string;
  venue: LiveFill["venue"];
  venue_order_id: string;
  trade_id: string;
  market_ref: string;
  token_id: string | null;
  side: LiveFill["side"];
  outcome: LiveFill["outcome"];
  price: number;
  size: number;
  fee_usd: number;
  liquidity: LiveFill["liquidity"];
  filled_at: number;
  raw_json: Record<string, unknown> | null;
};

type PositionRow = {
  id: string;
  asset: MarketAsset;
  venue: PositionSnapshot["venue"];
  market_ref: string;
  outcome: PositionSnapshot["outcome"];
  size: number;
  average_price: number | null;
  current_price: number | null;
  current_value_usd: number;
  realized_pnl_usd: number;
  unrealized_pnl_usd: number;
  redeemable: boolean;
  mergeable: boolean;
  updated_at: number;
  raw_json: Record<string, unknown> | null;
};

type PnlSnapshotRow = {
  id: number;
  captured_at: number;
  equity_usd: number;
  cash_usd: number;
  positions_value_usd: number;
  realized_pnl_usd: number;
  unrealized_pnl_usd: number;
  fees_usd: number;
  venue_breakdown_json: PnlSnapshot["venueBreakdown"];
};

type StablePnlChangeRow = {
  intent_id: string;
  asset: MarketAsset;
  combination: PairCombination;
  changed_at: number;
  realized_pnl_usd: unknown;
  equity_usd: unknown;
  cash_usd: unknown;
  positions_value_usd: unknown;
  strategy_pnl_usd: unknown;
  account_delta_usd: unknown;
  baseline_equity_usd: unknown;
  peak_equity_usd: unknown;
  drawdown_usd: unknown;
  roi: unknown;
  target_notional_usd: unknown;
  stability_json: Record<string, unknown> | null;
};

type MarketFillQualityEventRow = {
  id: string;
  asset: MarketAsset;
  slot_key: string;
  intent_id: string | null;
  combination: PairCombination | null;
  primary_venue: Venue | null;
  hedge_venue: Venue | null;
  outcome: MarketFillQualityEvent["outcome"];
  stage: string;
  slippage_bps: unknown;
  payload_json: Record<string, unknown> | null;
  created_at: number;
};

type BridgeTransferRow = {
  id: string;
  venue: BridgeTransfer["venue"];
  status: BridgeTransfer["status"];
  created_at: number;
  updated_at: number;
  quote_id: string | null;
  source_chain: string | null;
  source_asset: string | null;
  target_asset: string;
  amount_in_usd: number | null;
  amount_out_usd: number | null;
  tx_hash: string | null;
  deposit_addresses_json: BridgeTransfer["depositAddresses"];
  raw_json: Record<string, unknown> | null;
};

let poolSingleton: Pool | null = null;
let schemaCompatibilityPromise: Promise<void> | null = null;
const LIVE_EXECUTION_LOCK_NAMESPACE = 4_298;
const LIVE_EXECUTION_LOCK_KEY = 2;

// SHA-256 of the immutable block delimited by migration-checksum markers below.
const LEGACY_SCHEMA_BASELINE_CHECKSUM = "b9059dd24e724ac105f13482bc09495738664645af3b0cc1ade80d66626c1b18";
const ORDER_TRUTH_REVISION_CHECKSUM = "406db20ffc6f352abead966d06d4811b6531771ef6665616fd3c334bb35e8310";

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  {
    version: 1,
    name: "legacy_schema_baseline",
    checksum: LEGACY_SCHEMA_BASELINE_CHECKSUM,
    up: applyLegacySchemaBaselineMigration,
  },
  {
    version: 2,
    name: "order_truth_revision",
    checksum: ORDER_TRUTH_REVISION_CHECKSUM,
    up: applyOrderTruthRevisionMigration,
  },
];

export async function getPgDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL est requis pour utiliser le système live");
  }

  if (!poolSingleton) {
    poolSingleton = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: resolvePgPoolMax(),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  if (!schemaCompatibilityPromise) {
    schemaCompatibilityPromise = assertDatabaseSchemaCompatible(poolSingleton, DATABASE_MIGRATIONS)
      .then(() => undefined)
      .catch((error) => {
        schemaCompatibilityPromise = null;
        throw error;
      });
  }

  await schemaCompatibilityPromise;
  return poolSingleton;
}

export function resolvePgPoolMax(raw = process.env.PG_POOL_MAX) {
  if (!raw) {
    return 3;
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`PG_POOL_MAX doit etre un entier, valeur recue: ${raw}`);
  }

  if (parsed < 2) {
    throw new Error("PG_POOL_MAX doit etre superieur ou egal a 2 pour eviter un deadlock des advisory locks");
  }

  return Math.min(50, parsed);
}

export async function migratePostgresDatabase(pool: Pool) {
  return runDatabaseMigrations(pool, DATABASE_MIGRATIONS);
}

export async function getPostgresMigrationStatus(pool: Pool) {
  return getDatabaseMigrationStatus(pool, DATABASE_MIGRATIONS);
}

/* migration-checksum:start:1 */
const MIGRATION_V1_MARKET_ASSETS = ["btc", "eth", "sol", "xrp", "doge", "bnb", "hype"] as const;

const MIGRATION_V1_DEFAULT_GLOBAL_RISK_CONFIG: GlobalRiskConfig = {
  clusterExpectedFatalLossShare: 0.05,
  clusterExpectedFatalLossCapUsd: 25,
  clusterAbsoluteFatalLossShare: 0.15,
  clusterAbsoluteFatalLossCapUsd: 75,
  balanceMaxAgeMs: 10_000,
  oracleMaxAgeMs: 2_500,
};

const MIGRATION_V1_DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  enableTrading: false,
  shadowMode: true,
  maxPairNotionalUsd: 50,
  maxLegCapitalShare: 0.7,
  maxSignalAgeMs: 1_000,
  grossEntryThreshold: 0.93,
  minProjectedNetProfitUsd: 0.25,
  minProjectedNetReturn: 0.02,
  minWorstCaseProfitUsd: 0.25,
  maxLegPrice: 0.49,
  reentryImprovement: 0.01,
  pollingIntervalMs: 1_000,
  minOrderSize: 5,
  maxSlippageBps: 30,
  primarySelectionMode: "shadow",
  minimumEntryDepthCoverageRatio: 0.5,
  adaptiveSlippageTightBps: 15,
  adaptiveSlippageDefaultBps: 30,
  adaptiveSlippageThinBps: 60,
  dailyLossCapEnabled: true,
  dailyLossHardCapUsd: 20,
  immediateOrderConfirmationTimeoutMs: 8_000,
  executionPriceBuffer: 0.01,
  kalshiDepthHeadroomContracts: 2,
  kalshiPrimaryDepthSafetyFactor: 0.7,
  kalshiPrimaryPriceTicksSlippage: 2,
  kalshiPrimaryProbeClipContracts: 5,
  kalshiPrimaryMaxClipContracts: 10,
  kalshiPrimaryMaxClips: 4,
  polymarketHedgeDepthSafetyFactor: 0.8,
  polymarketHedgeHeadroomShares: 1,
  polymarketHedgeBookMaxAgeMs: 500,
  primaryRetryAttempts: 2,
  primaryRetryDelayMs: 200,
  hedgeRetryAttempts: 3,
  hedgeRetryDelayMs: 350,
  hedgeRescueEnabled: true,
  hedgeRescueMaxAttempts: 3,
  hedgeRescueDelayMs: 150,
  hedgeRescueMaxLossUsd: 1,
  hedgeRescueMinAdvantageUsd: 0.05,
  hedgeRescueAllowPartial: true,
  forcedUnwindEnabled: true,
  forcedUnwindMaxAttempts: 3,
  forcedUnwindTickLadder: [1, 3, 6],
  forcedUnwindMaxLossUsd: 2,
  forcedUnwindHoldSecondsToSettlement: 45,
  entryCutoffSeconds: 180,
  maxOpenIntentsPerSlot: 1,
  maxVenueExposureUsd: 1_000,
  polyBridgeLowWaterUsdc: 250,
  mismatchGuardEnabled: true,
  mismatchGuardMinElapsedSeconds: 60,
  mismatchGuardMinMoveBps: 5,
  mismatchGuardPhase2StartSeconds: 480,
  mismatchGuardPhase2MinMoveBps: 10,
  mismatchGuardMaxVenueDisagreementPct: 0.12,
  mismatchRiskMode: "shadow",
};

async function applyLegacySchemaBaselineMigration(pool: PgQueryable) {
  const now = Date.now();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS strategy_config (
      id INTEGER PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS global_risk_config (
      id INTEGER PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worker_state (
      id INTEGER PRIMARY KEY,
      phase TEXT NOT NULL,
      current_slot_key TEXT,
      last_scan_at BIGINT,
      last_execute_at BIGINT,
      last_reconcile_at BIGINT,
      last_error TEXT,
      readiness_status TEXT NOT NULL,
      readiness_json JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS opportunity_snapshots (
      id BIGSERIAL PRIMARY KEY,
      slot_key TEXT NOT NULL,
      slot_start_ts BIGINT NOT NULL,
      slot_end_ts BIGINT NOT NULL,
      captured_at BIGINT NOT NULL,
      polymarket_json JSONB NOT NULL,
      kalshi_json JSONB NOT NULL,
      opportunities_json JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS opportunity_snapshots_slot_idx
      ON opportunity_snapshots(slot_key, captured_at DESC);
    CREATE INDEX IF NOT EXISTS opportunity_snapshots_captured_idx
      ON opportunity_snapshots(captured_at DESC);

    CREATE TABLE IF NOT EXISTS oracle_slot_samples (
      id BIGSERIAL PRIMARY KEY,
      asset TEXT NOT NULL,
      slot_key TEXT NOT NULL,
      slot_start_ts BIGINT NOT NULL,
      slot_end_ts BIGINT NOT NULL,
      captured_at BIGINT NOT NULL,
      chainlink_start_price_usd DOUBLE PRECISION,
      chainlink_start_captured_at BIGINT,
      chainlink_live_price_usd DOUBLE PRECISION,
      chainlink_source_ts BIGINT,
      cf_index_id TEXT,
      cf_live_price_usd DOUBLE PRECISION,
      cf_source_ts BIGINT,
      cf_trailing_average_usd DOUBLE PRECISION,
      cf_trailing_window_size INTEGER,
      cf_final_minute_average_usd DOUBLE PRECISION,
      cf_final_minute_window_size INTEGER,
      kalshi_target_price_usd DOUBLE PRECISION,
      model_version TEXT,
      risk_json JSONB NOT NULL,
      economics_json JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS oracle_slot_samples_asset_slot_idx
      ON oracle_slot_samples(asset, slot_key, captured_at DESC);
    CREATE INDEX IF NOT EXISTS oracle_slot_samples_captured_brin_idx
      ON oracle_slot_samples USING BRIN(captured_at)
      WITH (pages_per_range = 32);

    CREATE TABLE IF NOT EXISTS slot_resolutions (
      asset TEXT NOT NULL,
      slot_key TEXT NOT NULL,
      slot_start_ts BIGINT NOT NULL,
      slot_end_ts BIGINT NOT NULL,
      polymarket_slug TEXT NOT NULL,
      polymarket_market_ref TEXT,
      kalshi_market_ref TEXT,
      polymarket_resolution TEXT,
      kalshi_resolution TEXT,
      polymarket_settlement_value_usd DOUBLE PRECISION,
      kalshi_settlement_value_usd DOUBLE PRECISION,
      first_observed_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      resolved_at BIGINT,
      source TEXT NOT NULL,
      raw_json JSONB NOT NULL,
      PRIMARY KEY (asset, slot_key)
    );
    CREATE INDEX IF NOT EXISTS slot_resolutions_unresolved_retry_idx
      ON slot_resolutions(updated_at ASC, slot_end_ts ASC)
      WHERE resolved_at IS NULL;
    CREATE INDEX IF NOT EXISTS slot_resolutions_resolved_idx
      ON slot_resolutions(resolved_at DESC)
      WHERE resolved_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS venue_balances (
      venue TEXT PRIMARY KEY,
      captured_at BIGINT NOT NULL,
      status TEXT NOT NULL,
      currency TEXT NOT NULL,
      available_balance_usd DOUBLE PRECISION NOT NULL,
      total_balance_usd DOUBLE PRECISION NOT NULL,
      portfolio_value_usd DOUBLE PRECISION NOT NULL,
      allowance_usd DOUBLE PRECISION,
      notes_json JSONB NOT NULL,
      raw_json JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_intents (
      id TEXT PRIMARY KEY,
      shadow BOOLEAN NOT NULL DEFAULT false,
      slot_key TEXT NOT NULL,
      slot_start_ts BIGINT NOT NULL,
      slot_end_ts BIGINT NOT NULL,
      combination TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      resolved_at BIGINT,
      primary_venue TEXT NOT NULL,
      hedge_venue TEXT NOT NULL,
      gross_cost DOUBLE PRECISION NOT NULL,
      target_notional_usd DOUBLE PRECISION NOT NULL,
      entry_sizing_reason TEXT,
      max_slippage_bps INTEGER NOT NULL,
      failure_reason TEXT,
      projected_net_profit_usd DOUBLE PRECISION,
      realized_pnl_usd DOUBLE PRECISION,
      roi DOUBLE PRECISION,
      poly_resolution TEXT,
      kalshi_resolution TEXT,
      legs_json JSONB NOT NULL,
      mismatch_risk_audit_json JSONB,
      shadow_execution_json JSONB
    );
    CREATE INDEX IF NOT EXISTS order_intents_slot_idx ON order_intents(slot_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS order_intents_created_idx ON order_intents(created_at DESC);
    CREATE INDEX IF NOT EXISTS order_intents_resolved_idx ON order_intents(resolved_at DESC)
      WHERE resolved_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS venue_orders (
      id TEXT PRIMARY KEY,
      shadow BOOLEAN NOT NULL DEFAULT false,
      intent_id TEXT NOT NULL REFERENCES order_intents(id) ON DELETE CASCADE,
      venue TEXT NOT NULL,
      venue_order_id TEXT NOT NULL,
      client_order_id TEXT,
      market_ref TEXT NOT NULL,
      token_id TEXT,
      side TEXT NOT NULL,
      outcome TEXT NOT NULL,
      order_type TEXT NOT NULL,
      requested_price DOUBLE PRECISION,
      requested_size DOUBLE PRECISION NOT NULL,
      filled_size DOUBLE PRECISION NOT NULL,
      average_fill_price DOUBLE PRECISION,
      fee_usd DOUBLE PRECISION,
      status TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      raw_json JSONB NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS venue_orders_exchange_idx
      ON venue_orders(venue, venue_order_id);
    CREATE INDEX IF NOT EXISTS venue_orders_updated_idx
      ON venue_orders(updated_at DESC);

    CREATE TABLE IF NOT EXISTS order_attempts (
      id TEXT PRIMARY KEY,
      asset TEXT NOT NULL,
      shadow BOOLEAN NOT NULL DEFAULT false,
      intent_id TEXT NOT NULL REFERENCES order_intents(id) ON DELETE CASCADE,
      leg_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      venue TEXT NOT NULL,
      side TEXT NOT NULL,
      order_type TEXT NOT NULL,
      client_order_id TEXT NOT NULL,
      venue_order_id TEXT,
      status TEXT NOT NULL,
      truth_status TEXT,
      request_json JSONB NOT NULL,
      result_json JSONB,
      error TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS order_attempts_client_idx
      ON order_attempts(venue, client_order_id);
    CREATE INDEX IF NOT EXISTS order_attempts_intent_idx
      ON order_attempts(intent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS order_attempts_asset_updated_idx
      ON order_attempts(asset, updated_at DESC);

    CREATE TABLE IF NOT EXISTS fills (
      id TEXT PRIMARY KEY,
      shadow BOOLEAN NOT NULL DEFAULT false,
      intent_id TEXT REFERENCES order_intents(id) ON DELETE SET NULL,
      venue TEXT NOT NULL,
      venue_order_id TEXT NOT NULL,
      trade_id TEXT NOT NULL,
      market_ref TEXT NOT NULL,
      token_id TEXT,
      side TEXT NOT NULL,
      outcome TEXT NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      size DOUBLE PRECISION NOT NULL,
      fee_usd DOUBLE PRECISION NOT NULL,
      liquidity TEXT,
      filled_at BIGINT NOT NULL,
      raw_json JSONB NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS fills_exchange_trade_idx ON fills(venue, trade_id);
    CREATE INDEX IF NOT EXISTS fills_intent_idx ON fills(intent_id, filled_at DESC);
    CREATE INDEX IF NOT EXISTS fills_filled_idx ON fills(filled_at DESC);

    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      venue TEXT NOT NULL,
      market_ref TEXT NOT NULL,
      outcome TEXT NOT NULL,
      size DOUBLE PRECISION NOT NULL,
      average_price DOUBLE PRECISION,
      current_price DOUBLE PRECISION,
      current_value_usd DOUBLE PRECISION NOT NULL,
      realized_pnl_usd DOUBLE PRECISION NOT NULL,
      unrealized_pnl_usd DOUBLE PRECISION NOT NULL,
      redeemable BOOLEAN NOT NULL,
      mergeable BOOLEAN NOT NULL,
      updated_at BIGINT NOT NULL,
      raw_json JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS positions_venue_idx ON positions(venue, updated_at DESC);

    CREATE TABLE IF NOT EXISTS settlements (
      id TEXT PRIMARY KEY,
      intent_id TEXT REFERENCES order_intents(id) ON DELETE SET NULL,
      venue TEXT NOT NULL,
      market_ref TEXT NOT NULL,
      outcome TEXT NOT NULL,
      resolved_outcome TEXT,
      payout_usd DOUBLE PRECISION NOT NULL,
      settled_at BIGINT NOT NULL,
      raw_json JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS settlements_settled_idx ON settlements(settled_at DESC);

    CREATE TABLE IF NOT EXISTS pnl_snapshots (
      id BIGSERIAL PRIMARY KEY,
      captured_at BIGINT NOT NULL,
      equity_usd DOUBLE PRECISION NOT NULL,
      cash_usd DOUBLE PRECISION NOT NULL,
      positions_value_usd DOUBLE PRECISION NOT NULL,
      realized_pnl_usd DOUBLE PRECISION NOT NULL,
      unrealized_pnl_usd DOUBLE PRECISION NOT NULL,
      fees_usd DOUBLE PRECISION NOT NULL,
      venue_breakdown_json JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pnl_snapshots_captured_idx ON pnl_snapshots(captured_at DESC);
    CREATE INDEX IF NOT EXISTS pnl_snapshots_valid_latest_idx
      ON pnl_snapshots(captured_at DESC, id DESC)
      WHERE equity_usd::text NOT IN ('NaN', 'Infinity', '-Infinity') AND equity_usd > 0;
    CREATE INDEX IF NOT EXISTS pnl_snapshots_valid_first_idx
      ON pnl_snapshots(captured_at ASC, id ASC)
      WHERE equity_usd::text NOT IN ('NaN', 'Infinity', '-Infinity') AND equity_usd > 0;
    CREATE INDEX IF NOT EXISTS pnl_snapshots_valid_peak_idx
      ON pnl_snapshots(equity_usd DESC)
      WHERE equity_usd::text NOT IN ('NaN', 'Infinity', '-Infinity') AND equity_usd > 0;

    CREATE TABLE IF NOT EXISTS stable_pnl_changes (
      intent_id TEXT PRIMARY KEY REFERENCES order_intents(id) ON DELETE CASCADE,
      asset TEXT NOT NULL,
      combination TEXT NOT NULL,
      changed_at BIGINT NOT NULL,
      settled_at BIGINT,
      realized_pnl_usd DOUBLE PRECISION NOT NULL,
      roi DOUBLE PRECISION,
      target_notional_usd DOUBLE PRECISION NOT NULL,
      equity_usd DOUBLE PRECISION NOT NULL,
      cash_usd DOUBLE PRECISION NOT NULL,
      positions_value_usd DOUBLE PRECISION NOT NULL,
      strategy_pnl_usd DOUBLE PRECISION NOT NULL,
      account_delta_usd DOUBLE PRECISION NOT NULL,
      baseline_equity_usd DOUBLE PRECISION,
      peak_equity_usd DOUBLE PRECISION,
      drawdown_usd DOUBLE PRECISION NOT NULL,
      venue_breakdown_json JSONB NOT NULL,
      stability_json JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS stable_pnl_changes_changed_idx
      ON stable_pnl_changes(changed_at DESC);
    CREATE INDEX IF NOT EXISTS stable_pnl_changes_asset_changed_idx
      ON stable_pnl_changes(asset, changed_at DESC);

    CREATE TABLE IF NOT EXISTS market_fill_quality_events (
      id TEXT PRIMARY KEY,
      asset TEXT NOT NULL,
      slot_key TEXT NOT NULL,
      intent_id TEXT REFERENCES order_intents(id) ON DELETE SET NULL,
      combination TEXT,
      primary_venue TEXT,
      hedge_venue TEXT,
      outcome TEXT NOT NULL,
      stage TEXT NOT NULL,
      slippage_bps DOUBLE PRECISION,
      payload_json JSONB NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS market_fill_quality_events_created_idx
      ON market_fill_quality_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS market_fill_quality_events_asset_created_idx
      ON market_fill_quality_events(asset, created_at DESC);
    CREATE INDEX IF NOT EXISTS market_fill_quality_events_slot_created_idx
      ON market_fill_quality_events(slot_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS market_fill_quality_events_degraded_idx
      ON market_fill_quality_events(asset, slot_key, created_at DESC)
      WHERE outcome IN ('partial_fill', 'no_fill', 'rescue', 'unwind', 'manual_required');

    CREATE TABLE IF NOT EXISTS bridge_transfers (
      id TEXT PRIMARY KEY,
      venue TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      quote_id TEXT,
      source_chain TEXT,
      source_asset TEXT,
      target_asset TEXT NOT NULL,
      amount_in_usd DOUBLE PRECISION,
      amount_out_usd DOUBLE PRECISION,
      tx_hash TEXT,
      deposit_addresses_json JSONB,
      raw_json JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bridge_transfers_updated_idx ON bridge_transfers(updated_at DESC);

    CREATE TABLE IF NOT EXISTS run_events (
      id BIGSERIAL PRIMARY KEY,
      asset TEXT,
      level TEXT NOT NULL,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json JSONB,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS run_events_created_idx ON run_events(created_at DESC);

    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id BIGSERIAL PRIMARY KEY,
      asset TEXT,
      channel TEXT NOT NULL,
      kind TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      message TEXT NOT NULL,
      payload_json JSONB,
      status TEXT NOT NULL,
      error TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      sent_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS notification_deliveries_status_created_idx
      ON notification_deliveries(status, created_at ASC);

    CREATE TABLE IF NOT EXISTS circuit_breakers (
      key TEXT PRIMARY KEY,
      active BOOLEAN NOT NULL,
      reason TEXT,
      triggered_at BIGINT,
      payload_json JSONB
    );

    CREATE TABLE IF NOT EXISTS strategy_configs (
      asset TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worker_states (
      asset TEXT PRIMARY KEY,
      phase TEXT NOT NULL,
      current_slot_key TEXT,
      last_scan_at BIGINT,
      last_execute_at BIGINT,
      last_reconcile_at BIGINT,
      last_error TEXT,
      readiness_status TEXT NOT NULL,
      readiness_json JSONB NOT NULL,
      loop_health_json JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS execution_candidates (
      asset TEXT PRIMARY KEY,
      slot_key TEXT NOT NULL,
      scan_sequence BIGINT NOT NULL,
      captured_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      combination TEXT NOT NULL,
      projected_net_profit_usd DOUBLE PRECISION NOT NULL,
      gross_cost DOUBLE PRECISION NOT NULL,
      signal_age_ms BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS execution_candidates_expires_idx
      ON execution_candidates(expires_at DESC, projected_net_profit_usd DESC);
  `);

  await pool.query(`
    ALTER TABLE oracle_slot_samples
    ADD COLUMN IF NOT EXISTS chainlink_start_captured_at BIGINT
  `);

  await pool.query(`
    ALTER TABLE worker_states
    ADD COLUMN IF NOT EXISTS loop_health_json JSONB NOT NULL DEFAULT '{}'::jsonb
  `);

  await pool.query(
    `
      INSERT INTO global_risk_config (id, payload, updated_at)
      VALUES (1, $1::jsonb, $2)
      ON CONFLICT (id) DO NOTHING
    `,
    [JSON.stringify(MIGRATION_V1_DEFAULT_GLOBAL_RISK_CONFIG), now],
  );

  await pool.query(
    `
      INSERT INTO strategy_config (id, payload, updated_at)
      VALUES (1, $1::jsonb, $2)
      ON CONFLICT (id) DO NOTHING
    `,
    [JSON.stringify(MIGRATION_V1_DEFAULT_STRATEGY_CONFIG), now],
  );

  await pool.query(
    `
      INSERT INTO worker_state (
        id, phase, current_slot_key, last_scan_at, last_execute_at, last_reconcile_at,
        last_error, readiness_status, readiness_json
      )
      VALUES (1, 'idle', NULL, NULL, NULL, NULL, NULL, 'blocked', '[]'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `,
  );

  await pool.query(
    `
      INSERT INTO circuit_breakers (key, active, reason, triggered_at, payload_json)
      VALUES ('global', false, NULL, NULL, NULL)
      ON CONFLICT (key) DO NOTHING
    `,
  );

  await pool.query(`
    ALTER TABLE opportunity_snapshots
    ADD COLUMN IF NOT EXISTS asset TEXT
  `);
  await pool.query(`
    UPDATE opportunity_snapshots
    SET asset = 'btc'
    WHERE asset IS NULL
  `);
  await pool.query(`
    ALTER TABLE opportunity_snapshots
    ALTER COLUMN asset SET NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS opportunity_snapshots_asset_slot_idx
    ON opportunity_snapshots(asset, slot_key, captured_at DESC)
  `);

  await pool.query(`
    ALTER TABLE order_intents
    ADD COLUMN IF NOT EXISTS asset TEXT
  `);
  await pool.query(`
    UPDATE order_intents
    SET asset = 'btc'
    WHERE asset IS NULL
  `);
  await pool.query(`
    ALTER TABLE order_intents
    ALTER COLUMN asset SET NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS order_intents_asset_slot_idx
    ON order_intents(asset, slot_key, created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS order_intents_open_asset_updated_idx
    ON order_intents(asset, updated_at DESC)
    WHERE status NOT IN ('settled', 'failed', 'skipped', 'canceled', 'unwound')
  `);

  await pool.query(`
    ALTER TABLE venue_orders
    ADD COLUMN IF NOT EXISTS asset TEXT
  `);
  await pool.query(`
    UPDATE venue_orders
    SET asset = 'btc'
    WHERE asset IS NULL
  `);
  await pool.query(`
    ALTER TABLE venue_orders
    ALTER COLUMN asset SET NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS venue_orders_asset_updated_idx
    ON venue_orders(asset, updated_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS venue_orders_open_asset_updated_idx
    ON venue_orders(asset, updated_at DESC)
    WHERE status IN ('pending', 'live', 'partially_filled')
  `);

  await pool.query(`
    ALTER TABLE fills
    ADD COLUMN IF NOT EXISTS asset TEXT
  `);
  await pool.query(`
    UPDATE fills
    SET asset = 'btc'
    WHERE asset IS NULL
  `);
  await pool.query(`
    ALTER TABLE fills
    ALTER COLUMN asset SET NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS fills_asset_filled_idx
    ON fills(asset, filled_at DESC)
  `);

  await pool.query(`
    ALTER TABLE positions
    ADD COLUMN IF NOT EXISTS asset TEXT
  `);
  await pool.query(`
    UPDATE positions
    SET asset = 'btc'
    WHERE asset IS NULL
  `);
  await pool.query(`
    ALTER TABLE positions
    ALTER COLUMN asset SET NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS positions_venue_asset_idx
    ON positions(venue, asset, updated_at DESC)
  `);

  await pool.query(`
    ALTER TABLE settlements
    ADD COLUMN IF NOT EXISTS asset TEXT
  `);
  await pool.query(`
    UPDATE settlements
    SET asset = 'btc'
    WHERE asset IS NULL
  `);
  await pool.query(`
    ALTER TABLE settlements
    ALTER COLUMN asset SET NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS settlements_asset_settled_idx
    ON settlements(asset, settled_at DESC)
  `);

  await pool.query(`
    ALTER TABLE run_events
    ADD COLUMN IF NOT EXISTS asset TEXT
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS run_events_asset_created_idx
    ON run_events(asset, created_at DESC)
  `);

  await pool.query(`
    ALTER TABLE order_intents
    ADD COLUMN IF NOT EXISTS shadow BOOLEAN NOT NULL DEFAULT false
  `);

  await pool.query(`
    ALTER TABLE order_intents
    ADD COLUMN IF NOT EXISTS entry_sizing_reason TEXT
  `);

  await pool.query(`
    ALTER TABLE order_intents
      ADD COLUMN IF NOT EXISTS mismatch_p_fatal DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS mismatch_p_fatal_upper DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS mismatch_model_version TEXT,
      ADD COLUMN IF NOT EXISTS fatal_mismatch_pnl_usd DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS conservative_expected_pnl_usd DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS fatal_loss_exposure_usd DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS mismatch_risk_audit_json JSONB,
      ADD COLUMN IF NOT EXISTS shadow_execution_json JSONB
  `);

  await pool.query(`
    ALTER TABLE venue_orders
    ADD COLUMN IF NOT EXISTS shadow BOOLEAN NOT NULL DEFAULT false
  `);

  await pool.query(`
    ALTER TABLE fills
    ADD COLUMN IF NOT EXISTS shadow BOOLEAN NOT NULL DEFAULT false
  `);

  const legacyStrategyConfig = await pool.query<{ payload: Partial<StrategyConfig> }>(
    "SELECT payload FROM strategy_config WHERE id = 1 LIMIT 1",
  );
  const legacyStrategyPayload = {
    ...MIGRATION_V1_DEFAULT_STRATEGY_CONFIG,
    ...(legacyStrategyConfig.rows[0]?.payload ?? {}),
  };
  const seededEthStrategyConfig = await pool.query<{ payload: Partial<StrategyConfig> }>(
    "SELECT payload FROM strategy_configs WHERE asset = 'eth' LIMIT 1",
  );
  const nextStrategyConfigs = buildMigrationV1StrategyConfigs(
    legacyStrategyPayload,
    seededEthStrategyConfig.rows[0]?.payload,
  );

  for (const asset of MIGRATION_V1_MARKET_ASSETS) {
    await pool.query(
      `
        INSERT INTO strategy_configs (asset, payload, updated_at)
        VALUES ($1, $2::jsonb, $3)
        ON CONFLICT (asset) DO NOTHING
      `,
      [asset, JSON.stringify(nextStrategyConfigs[asset]), now],
    );
  }

  await pool.query(
    `
      UPDATE strategy_configs
      SET
        payload = jsonb_set(payload, '{mismatchGuardEnabled}', 'true'::jsonb, true),
        updated_at = $1
      WHERE NOT (payload ? 'mismatchGuardEnabled')
    `,
    [now],
  );

  await pool.query(
    `
      UPDATE strategy_configs
      SET
        payload = jsonb_set(payload, '{kalshiPrimaryDepthSafetyFactor}', $2::jsonb, true),
        updated_at = $1
      WHERE NOT (payload ? 'kalshiPrimaryDepthSafetyFactor')
    `,
    [now, JSON.stringify(MIGRATION_V1_DEFAULT_STRATEGY_CONFIG.kalshiPrimaryDepthSafetyFactor)],
  );

  await pool.query(
    `
      UPDATE strategy_configs
      SET
        payload = jsonb_set(payload, '{kalshiPrimaryProbeClipContracts}', $2::jsonb, true),
        updated_at = $1
      WHERE NOT (payload ? 'kalshiPrimaryProbeClipContracts')
    `,
    [now, JSON.stringify(MIGRATION_V1_DEFAULT_STRATEGY_CONFIG.kalshiPrimaryProbeClipContracts)],
  );

  await pool.query(
    `
      UPDATE strategy_configs
      SET
        payload = jsonb_set(payload, '{maxLegCapitalShare}', $2::jsonb, true),
        updated_at = $1
      WHERE NOT (payload ? 'maxLegCapitalShare')
    `,
    [now, JSON.stringify(MIGRATION_V1_DEFAULT_STRATEGY_CONFIG.maxLegCapitalShare)],
  );

  await pool.query(
    `
      UPDATE strategy_configs
      SET
        payload = jsonb_set(payload, '{maxSignalAgeMs}', $2::jsonb, true),
        updated_at = $1
      WHERE NOT (payload ? 'maxSignalAgeMs')
    `,
    [now, JSON.stringify(MIGRATION_V1_DEFAULT_STRATEGY_CONFIG.maxSignalAgeMs)],
  );

  for (const key of [
    "forcedUnwindEnabled",
    "forcedUnwindMaxAttempts",
    "forcedUnwindTickLadder",
    "forcedUnwindMaxLossUsd",
    "forcedUnwindHoldSecondsToSettlement",
    "polymarketHedgeDepthSafetyFactor",
    "polymarketHedgeHeadroomShares",
    "polymarketHedgeBookMaxAgeMs",
    "hedgeRescueEnabled",
    "hedgeRescueMaxAttempts",
    "hedgeRescueDelayMs",
    "hedgeRescueMaxLossUsd",
    "hedgeRescueMinAdvantageUsd",
    "hedgeRescueAllowPartial",
    "primarySelectionMode",
    "minimumEntryDepthCoverageRatio",
    "adaptiveSlippageTightBps",
    "adaptiveSlippageDefaultBps",
    "adaptiveSlippageThinBps",
    "dailyLossCapEnabled",
    "dailyLossHardCapUsd",
    "mismatchRiskMode",
  ] as const) {
    await pool.query(
      `
        UPDATE strategy_configs
        SET
          payload = jsonb_set(payload, $2::text[], $3::jsonb, true),
          updated_at = $1
        WHERE NOT (payload ? $4)
      `,
      [now, [key], JSON.stringify(MIGRATION_V1_DEFAULT_STRATEGY_CONFIG[key]), key],
    );
  }

  const legacyWorkerState = await pool.query<{
    phase: WorkerState["phase"];
    current_slot_key: string | null;
    last_scan_at: number | null;
    last_execute_at: number | null;
    last_reconcile_at: number | null;
    last_error: string | null;
    readiness_status: WorkerState["readinessStatus"];
    readiness_json: WorkerState["readiness"];
  }>(
    `
      SELECT phase, current_slot_key, last_scan_at, last_execute_at, last_reconcile_at,
        last_error, readiness_status, readiness_json
      FROM worker_state
      WHERE id = 1
      LIMIT 1
    `,
  );

  for (const asset of MIGRATION_V1_MARKET_ASSETS) {
    const fallbackState =
      asset === "btc" && legacyWorkerState.rows[0]
        ? legacyWorkerState.rows[0]
        : {
            phase: "idle" as const,
            current_slot_key: null,
            last_scan_at: null,
            last_execute_at: null,
            last_reconcile_at: null,
            last_error: null,
            readiness_status: "blocked" as const,
            readiness_json: [],
          };

    await pool.query(
      `
        INSERT INTO worker_states (
          asset, phase, current_slot_key, last_scan_at, last_execute_at, last_reconcile_at,
          last_error, readiness_status, readiness_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        ON CONFLICT (asset) DO NOTHING
      `,
      [
        asset,
        fallbackState.phase,
        fallbackState.current_slot_key,
        fallbackState.last_scan_at,
        fallbackState.last_execute_at,
        fallbackState.last_reconcile_at,
        fallbackState.last_error,
        fallbackState.readiness_status,
        JSON.stringify(fallbackState.readiness_json ?? []),
      ],
    );
  }

  for (const asset of MIGRATION_V1_MARKET_ASSETS) {
    await pool.query(
      `
        INSERT INTO circuit_breakers (key, active, reason, triggered_at, payload_json)
        VALUES ($1, false, NULL, NULL, NULL)
        ON CONFLICT (key) DO NOTHING
      `,
      [`asset:${asset}`],
    );
  }
}

function buildMigrationV1StrategyConfigs(
  legacyStrategyPayload: StrategyConfig,
  existingEthStrategyPayload?: Partial<StrategyConfig> | null,
): StrategyConfigMap {
  const ethStrategyPayload: StrategyConfig = existingEthStrategyPayload
    ? { ...MIGRATION_V1_DEFAULT_STRATEGY_CONFIG, ...existingEthStrategyPayload }
    : {
        ...legacyStrategyPayload,
        enableTrading: false,
        shadowMode: true,
      };

  return {
    btc: legacyStrategyPayload,
    eth: ethStrategyPayload,
    sol: { ...ethStrategyPayload, enableTrading: true, shadowMode: true },
    xrp: { ...ethStrategyPayload, enableTrading: true, shadowMode: true },
    doge: { ...ethStrategyPayload, enableTrading: true, shadowMode: true },
    bnb: { ...ethStrategyPayload, enableTrading: true, shadowMode: true },
    hype: { ...ethStrategyPayload, enableTrading: true, shadowMode: true },
  };
}
/* migration-checksum:end:1 */

/* migration-checksum:start:2 */
async function applyOrderTruthRevisionMigration(db: PgQueryable) {
  const duplicateFill = await db.query<{
    venue: string;
    venue_order_id: string;
    trade_id: string;
    duplicate_count: number;
  }>(`
    SELECT venue, venue_order_id, trade_id, count(*)::integer AS duplicate_count
    FROM fills
    GROUP BY venue, venue_order_id, trade_id
    HAVING count(*) > 1
    LIMIT 1
  `);

  if (duplicateFill.rows[0]) {
    const conflict = duplicateFill.rows[0];
    throw new Error(
      `Migration 2 refused: duplicate fill identity for ${conflict.venue}/${conflict.venue_order_id}/${conflict.trade_id} (${conflict.duplicate_count} rows)`,
    );
  }

  await db.query(`
    ALTER TABLE order_intents
    ADD COLUMN revision BIGINT NOT NULL DEFAULT 0
  `);
  await db.query(`
    ALTER TABLE venue_orders
    ADD COLUMN revision BIGINT NOT NULL DEFAULT 0
  `);
  await db.query(`
    ALTER TABLE order_attempts
    ADD COLUMN revision BIGINT NOT NULL DEFAULT 0
  `);
  await db.query(`DROP INDEX IF EXISTS fills_exchange_trade_idx`);
  await db.query(`
    CREATE UNIQUE INDEX fills_exchange_order_trade_idx
    ON fills(venue, venue_order_id, trade_id)
  `);
}
/* migration-checksum:end:2 */

export function buildBootstrapStrategyConfigs(
  legacyStrategyPayload: StrategyConfig,
  existingEthStrategyPayload?: Partial<StrategyConfig> | null,
): StrategyConfigMap {
  const ethStrategyPayload = normalizeSettings(
    existingEthStrategyPayload ?? {
      ...legacyStrategyPayload,
      enableTrading: false,
      shadowMode: true,
    },
  );

  return normalizeSettingsMap({
    btc: legacyStrategyPayload,
    eth: ethStrategyPayload,
    sol: {
      ...ethStrategyPayload,
      enableTrading: true,
      shadowMode: true,
    },
    xrp: {
      ...ethStrategyPayload,
      enableTrading: true,
      shadowMode: true,
    },
    doge: {
      ...ethStrategyPayload,
      enableTrading: true,
      shadowMode: true,
    },
    bnb: {
      ...ethStrategyPayload,
      enableTrading: true,
      shadowMode: true,
    },
    hype: {
      ...ethStrategyPayload,
      enableTrading: true,
      shadowMode: true,
    },
  });
}

export async function getStrategyConfig(pool: Pool, asset: MarketAsset): Promise<StrategyConfig> {
  const result = await pool.query("SELECT payload FROM strategy_configs WHERE asset = $1 LIMIT 1", [asset]);
  return normalizeSettings(result.rows[0]?.payload as Partial<StrategyConfig>);
}

export async function listStrategyConfigs(pool: Pool): Promise<StrategyConfigMap> {
  const result = await pool.query<{ asset: MarketAsset; payload: Partial<StrategyConfig> }>(
    "SELECT asset, payload FROM strategy_configs ORDER BY asset ASC",
  );

  const map = result.rows.reduce<Partial<StrategyConfigMap>>((accumulator, row) => {
    accumulator[row.asset] = normalizeSettings(row.payload);
    return accumulator;
  }, {});

  return normalizeSettingsMap(map);
}

export async function updateStrategyConfig(pool: Pool, asset: MarketAsset, payload: StrategyConfig) {
  await pool.query(
    `
      INSERT INTO strategy_configs (asset, payload, updated_at)
      VALUES ($1, $2::jsonb, $3)
      ON CONFLICT (asset) DO UPDATE SET
        payload = EXCLUDED.payload,
        updated_at = EXCLUDED.updated_at
    `,
    [asset, JSON.stringify(payload), Date.now()],
  );
  return payload;
}

export async function getGlobalRiskConfig(pool: Pool): Promise<GlobalRiskConfig> {
  const result = await pool.query("SELECT payload FROM global_risk_config WHERE id = 1 LIMIT 1");
  return normalizeGlobalRiskConfig(result.rows[0]?.payload as Partial<GlobalRiskConfig> | undefined);
}

export async function updateGlobalRiskConfig(pool: Pool, payload: GlobalRiskConfig) {
  const normalized = normalizeGlobalRiskConfig(payload);
  await pool.query(
    `
      INSERT INTO global_risk_config (id, payload, updated_at)
      VALUES (1, $1::jsonb, $2)
      ON CONFLICT (id) DO UPDATE SET
        payload = EXCLUDED.payload,
        updated_at = EXCLUDED.updated_at
    `,
    [JSON.stringify(normalized), Date.now()],
  );
  return normalized;
}

export async function getWorkerState(pool: Pool, asset: MarketAsset): Promise<WorkerState> {
  const result = await pool.query(
    `
      SELECT phase, current_slot_key, last_scan_at, last_execute_at, last_reconcile_at,
        last_error, readiness_status, readiness_json, loop_health_json
      FROM worker_states
      WHERE asset = $1
    `,
    [asset],
  );
  const row = result.rows[0];
  return {
    asset,
    phase: row.phase,
    currentSlotKey: row.current_slot_key,
    lastScanAt: row.last_scan_at,
    lastExecuteAt: row.last_execute_at,
    lastReconcileAt: row.last_reconcile_at,
    lastError: row.last_error,
    readinessStatus: row.readiness_status,
    readiness: (row.readiness_json ?? []) as WorkerState["readiness"],
    loopHealth: normalizeWorkerLoopHealth(row.loop_health_json),
  };
}

export async function listWorkerStates(pool: Pool): Promise<Record<MarketAsset, WorkerState>> {
  const result = await pool.query<{
    asset: MarketAsset;
    phase: WorkerState["phase"];
    current_slot_key: string | null;
    last_scan_at: number | null;
    last_execute_at: number | null;
    last_reconcile_at: number | null;
    last_error: string | null;
    readiness_status: WorkerState["readinessStatus"];
    readiness_json: WorkerState["readiness"];
    loop_health_json: WorkerState["loopHealth"];
  }>(
    `
      SELECT asset, phase, current_slot_key, last_scan_at, last_execute_at, last_reconcile_at,
        last_error, readiness_status, readiness_json, loop_health_json
      FROM worker_states
      ORDER BY asset ASC
    `,
  );

  const states = result.rows.reduce<Partial<Record<MarketAsset, WorkerState>>>((accumulator, row) => {
    accumulator[row.asset] = {
      asset: row.asset,
      phase: row.phase,
      currentSlotKey: row.current_slot_key,
      lastScanAt: row.last_scan_at,
      lastExecuteAt: row.last_execute_at,
      lastReconcileAt: row.last_reconcile_at,
      lastError: row.last_error,
      readinessStatus: row.readiness_status,
      readiness: row.readiness_json ?? [],
      loopHealth: normalizeWorkerLoopHealth(row.loop_health_json),
    };
    return accumulator;
  }, {});

  return Object.fromEntries(
    MARKET_ASSETS.map((asset) => [
      asset,
      states[asset] ?? {
        asset,
        phase: "idle",
        currentSlotKey: null,
        lastScanAt: null,
        lastExecuteAt: null,
        lastReconcileAt: null,
        lastError: null,
        readinessStatus: "blocked",
        readiness: [],
        loopHealth: normalizeWorkerLoopHealth(null),
      },
    ]),
  ) as Record<MarketAsset, WorkerState>;
}

export async function updateWorkerState(pool: Pool, asset: MarketAsset, state: Partial<WorkerState>) {
  await pool.query(
    `
      UPDATE worker_states
      SET
        phase = COALESCE($1, phase),
        current_slot_key = COALESCE($2, current_slot_key),
        last_scan_at = COALESCE($3, last_scan_at),
        last_execute_at = COALESCE($4, last_execute_at),
        last_reconcile_at = COALESCE($5, last_reconcile_at),
        last_error = $6,
        readiness_status = COALESCE($7, readiness_status),
        readiness_json = COALESCE($8::jsonb, readiness_json),
        loop_health_json = COALESCE($9::jsonb, loop_health_json)
      WHERE asset = $10
    `,
    [
      state.phase ?? null,
      state.currentSlotKey ?? null,
      state.lastScanAt ?? null,
      state.lastExecuteAt ?? null,
      state.lastReconcileAt ?? null,
      state.lastError ?? null,
      state.readinessStatus ?? null,
      state.readiness ? JSON.stringify(state.readiness) : null,
      state.loopHealth ? JSON.stringify(state.loopHealth) : null,
      asset,
    ],
  );
}

function normalizeWorkerLoopHealth(value: unknown): WorkerLoopHealth {
  const input = value && typeof value === "object" ? (value as Partial<WorkerLoopHealth>) : {};
  return {
    lastScanDurationMs: normalizeNullableNumber(input.lastScanDurationMs),
    lastExecutionDurationMs: normalizeNullableNumber(input.lastExecutionDurationMs),
    lastReconcileDurationMs: normalizeNullableNumber(input.lastReconcileDurationMs),
    lastScanAgeMs: normalizeNullableNumber(input.lastScanAgeMs),
    lastCandidateScore: normalizeNullableNumber(input.lastCandidateScore),
    lockBusyCount: normalizeCounter(input.lockBusyCount),
    staleSignalCount: normalizeCounter(input.staleSignalCount),
    updatedAt: normalizeNullableNumber(input.updatedAt),
  };
}

function normalizeNullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeCounter(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export async function insertOpportunitySnapshot(
  pool: Pool,
  snapshot: {
    asset: MarketAsset;
    slotKey: string;
    slotStartTs: number;
    slotEndTs: number;
    capturedAt: number;
    polymarket: unknown;
    kalshi: unknown;
    opportunities: LiveOpportunity[];
  },
) {
  await pool.query(
    `
      INSERT INTO opportunity_snapshots (
        asset, slot_key, slot_start_ts, slot_end_ts, captured_at, polymarket_json, kalshi_json, opportunities_json
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)
    `,
    [
      snapshot.asset,
      snapshot.slotKey,
      snapshot.slotStartTs,
      snapshot.slotEndTs,
      snapshot.capturedAt,
      JSON.stringify(snapshot.polymarket),
      JSON.stringify(snapshot.kalshi),
      JSON.stringify(snapshot.opportunities),
    ],
  );
}

export async function insertOracleSlotSample(pool: Pool, sample: OracleSlotSample) {
  await pool.query(
    `
      INSERT INTO oracle_slot_samples (
        asset, slot_key, slot_start_ts, slot_end_ts, captured_at,
        chainlink_start_price_usd, chainlink_start_captured_at,
        chainlink_live_price_usd, chainlink_source_ts,
        cf_index_id, cf_live_price_usd, cf_source_ts,
        cf_trailing_average_usd, cf_trailing_window_size,
        cf_final_minute_average_usd, cf_final_minute_window_size,
        kalshi_target_price_usd, model_version, risk_json, economics_json
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11, $12,
        $13, $14,
        $15, $16,
        $17, $18, $19::jsonb, $20::jsonb
      )
    `,
    [
      sample.asset,
      sample.slotKey,
      sample.slotStartTs,
      sample.slotEndTs,
      sample.capturedAt,
      sample.chainlinkStartPriceUsd,
      sample.chainlinkStartCapturedAt,
      sample.chainlinkLivePriceUsd,
      sample.chainlinkSourceTs,
      sample.cfIndexId,
      sample.cfLivePriceUsd,
      sample.cfSourceTs,
      sample.cfTrailingAverageUsd,
      sample.cfTrailingWindowSize,
      sample.cfFinalMinuteAverageUsd,
      sample.cfFinalMinuteWindowSize,
      sample.kalshiTargetPriceUsd,
      sample.modelVersion,
      JSON.stringify(sample.riskByCombination),
      JSON.stringify(sample.economicsByCombination),
    ],
  );
}

export async function upsertSlotResolution(pool: Pool, resolution: SlotResolutionRecord) {
  await pool.query(
    `
      INSERT INTO slot_resolutions (
        asset, slot_key, slot_start_ts, slot_end_ts, polymarket_slug,
        polymarket_market_ref, kalshi_market_ref, polymarket_resolution, kalshi_resolution,
        polymarket_settlement_value_usd, kalshi_settlement_value_usd,
        first_observed_at, updated_at, resolved_at, source, raw_json
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11,
        $12, $13, $14, $15, $16::jsonb
      )
      ON CONFLICT (asset, slot_key) DO UPDATE SET
        polymarket_slug = CASE
          WHEN slot_resolutions.source = 'official-venue-resolution'
            AND slot_resolutions.resolved_at IS NOT NULL
            AND EXCLUDED.source <> 'official-venue-resolution'
            THEN slot_resolutions.polymarket_slug
          ELSE EXCLUDED.polymarket_slug
        END,
        polymarket_market_ref = COALESCE(EXCLUDED.polymarket_market_ref, slot_resolutions.polymarket_market_ref),
        kalshi_market_ref = COALESCE(EXCLUDED.kalshi_market_ref, slot_resolutions.kalshi_market_ref),
        polymarket_resolution = CASE
          WHEN slot_resolutions.source = 'official-venue-resolution'
            AND EXCLUDED.source <> 'official-venue-resolution'
            THEN slot_resolutions.polymarket_resolution
          WHEN slot_resolutions.source <> 'official-venue-resolution'
            AND EXCLUDED.source = 'official-venue-resolution'
            THEN EXCLUDED.polymarket_resolution
          ELSE COALESCE(EXCLUDED.polymarket_resolution, slot_resolutions.polymarket_resolution)
        END,
        kalshi_resolution = CASE
          WHEN slot_resolutions.source = 'official-venue-resolution'
            AND EXCLUDED.source <> 'official-venue-resolution'
            THEN slot_resolutions.kalshi_resolution
          WHEN slot_resolutions.source <> 'official-venue-resolution'
            AND EXCLUDED.source = 'official-venue-resolution'
            THEN EXCLUDED.kalshi_resolution
          ELSE COALESCE(EXCLUDED.kalshi_resolution, slot_resolutions.kalshi_resolution)
        END,
        polymarket_settlement_value_usd = CASE
          WHEN slot_resolutions.source = 'official-venue-resolution'
            AND slot_resolutions.polymarket_settlement_value_usd IS NOT NULL
            THEN slot_resolutions.polymarket_settlement_value_usd
          ELSE COALESCE(
            EXCLUDED.polymarket_settlement_value_usd,
            slot_resolutions.polymarket_settlement_value_usd
          )
        END,
        kalshi_settlement_value_usd = CASE
          WHEN slot_resolutions.source = 'official-venue-resolution'
            AND slot_resolutions.kalshi_settlement_value_usd IS NOT NULL
            THEN slot_resolutions.kalshi_settlement_value_usd
          ELSE COALESCE(
            EXCLUDED.kalshi_settlement_value_usd,
            slot_resolutions.kalshi_settlement_value_usd
          )
        END,
        updated_at = GREATEST(EXCLUDED.updated_at, slot_resolutions.updated_at),
        resolved_at = CASE
          WHEN slot_resolutions.source = 'official-venue-resolution'
            AND EXCLUDED.source <> 'official-venue-resolution'
            THEN slot_resolutions.resolved_at
          ELSE COALESCE(EXCLUDED.resolved_at, slot_resolutions.resolved_at)
        END,
        source = CASE
          WHEN slot_resolutions.source = 'official-venue-resolution'
            AND EXCLUDED.source <> 'official-venue-resolution'
            THEN slot_resolutions.source
          ELSE EXCLUDED.source
        END,
        raw_json = slot_resolutions.raw_json || EXCLUDED.raw_json
    `,
    [
      resolution.asset,
      resolution.slotKey,
      resolution.slotStartTs,
      resolution.slotEndTs,
      resolution.polymarketSlug,
      resolution.polymarketMarketRef,
      resolution.kalshiMarketRef,
      resolution.polymarketResolution,
      resolution.kalshiResolution,
      resolution.polymarketSettlementValueUsd,
      resolution.kalshiSettlementValueUsd,
      resolution.firstObservedAt,
      resolution.updatedAt,
      resolution.resolvedAt,
      resolution.source,
      JSON.stringify(resolution.raw),
    ],
  );
}

export async function listPendingSlotResolutions(pool: Pool, now: number, limit = 50): Promise<SlotResolutionRecord[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM slot_resolutions
      WHERE resolved_at IS NULL
        AND slot_end_ts <= $1
        AND slot_end_ts >= $1 - $3
      ORDER BY updated_at ASC, slot_end_ts ASC
      LIMIT $2
    `,
    [now, limit, SLOT_RESOLUTION_RETENTION_MS],
  );
  return result.rows.map(mapSlotResolutionRow);
}

export async function getLatestOpportunitySnapshot(pool: Pool, asset: MarketAsset, slotKey?: string) {
  const result = await pool.query(
    `
      SELECT *
      FROM opportunity_snapshots
      ${slotKey ? "WHERE asset = $1 AND slot_key = $2" : "WHERE asset = $1"}
      ORDER BY captured_at DESC
      LIMIT 1
    `,
    slotKey ? [asset, slotKey] : [asset],
  );

  return result.rows[0] ? mapOpportunitySnapshotRow(result.rows[0]) : null;
}

export async function getOpportunitySnapshotsForSlot(pool: Pool, asset: MarketAsset, slotKey: string) {
  const result = await pool.query(
    `
      SELECT *
      FROM opportunity_snapshots
      WHERE asset = $1 AND slot_key = $2
      ORDER BY captured_at ASC
    `,
    [asset, slotKey],
  );

  return result.rows.map(mapOpportunitySnapshotRow);
}

export async function upsertVenueBalance(pool: Pool, balance: VenueBalance) {
  await pool.query(
    `
      INSERT INTO venue_balances (
        venue, captured_at, status, currency, available_balance_usd, total_balance_usd,
        portfolio_value_usd, allowance_usd, notes_json, raw_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
      ON CONFLICT (venue) DO UPDATE SET
        captured_at = EXCLUDED.captured_at,
        status = EXCLUDED.status,
        currency = EXCLUDED.currency,
        available_balance_usd = EXCLUDED.available_balance_usd,
        total_balance_usd = EXCLUDED.total_balance_usd,
        portfolio_value_usd = EXCLUDED.portfolio_value_usd,
        allowance_usd = EXCLUDED.allowance_usd,
        notes_json = EXCLUDED.notes_json,
        raw_json = EXCLUDED.raw_json
    `,
    [
      balance.venue,
      balance.capturedAt,
      balance.status,
      balance.currency,
      balance.availableBalanceUsd,
      balance.totalBalanceUsd,
      balance.portfolioValueUsd,
      balance.allowanceUsd,
      JSON.stringify(balance.notes),
      JSON.stringify(balance.raw),
    ],
  );
}

export async function listVenueBalances(pool: Pool): Promise<VenueBalance[]> {
  const result = await pool.query("SELECT * FROM venue_balances ORDER BY venue ASC");
  return result.rows.map((row) => ({
    venue: row.venue,
    capturedAt: row.captured_at,
    status: row.status,
    currency: row.currency,
    availableBalanceUsd: row.available_balance_usd,
    totalBalanceUsd: row.total_balance_usd,
    portfolioValueUsd: row.portfolio_value_usd,
    allowanceUsd: row.allowance_usd,
    notes: row.notes_json ?? [],
    raw: row.raw_json ?? {},
  }));
}

export async function getLastEntryCosts(pool: Pool, asset: MarketAsset, slotKey: string) {
  const result = await pool.query<{
    combination: PairCombination;
    gross_cost: number;
  }>(
    `
      SELECT combination, gross_cost
      FROM order_intents
      WHERE asset = $1 AND slot_key = $2
      ORDER BY created_at DESC
    `,
    [asset, slotKey],
  );

  return result.rows.reduce<Partial<Record<PairCombination, number>>>((accumulator, row) => {
    if (accumulator[row.combination] === undefined) {
      accumulator[row.combination] = row.gross_cost;
    }
    return accumulator;
  }, {});
}

export async function upsertOrderIntent(pool: Pool, intent: OrderIntent) {
  await pool.query(
    `
      INSERT INTO order_intents (
        id, asset, shadow, slot_key, slot_start_ts, slot_end_ts, combination, status, created_at, updated_at,
        resolved_at, primary_venue, hedge_venue, gross_cost, target_notional_usd, max_slippage_bps,
        entry_sizing_reason, failure_reason, projected_net_profit_usd, realized_pnl_usd, roi, poly_resolution,
        kalshi_resolution, legs_json, mismatch_p_fatal, mismatch_p_fatal_upper, mismatch_model_version,
        fatal_mismatch_pnl_usd, conservative_expected_pnl_usd, fatal_loss_exposure_usd,
        mismatch_risk_audit_json, shadow_execution_json
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21, $22,
        $23, $24::jsonb, $25, $26, $27,
        $28, $29, $30, $31::jsonb, $32::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        asset = EXCLUDED.asset,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at,
        resolved_at = EXCLUDED.resolved_at,
        gross_cost = EXCLUDED.gross_cost,
        target_notional_usd = EXCLUDED.target_notional_usd,
        max_slippage_bps = EXCLUDED.max_slippage_bps,
        entry_sizing_reason = EXCLUDED.entry_sizing_reason,
        failure_reason = EXCLUDED.failure_reason,
        projected_net_profit_usd = EXCLUDED.projected_net_profit_usd,
        realized_pnl_usd = EXCLUDED.realized_pnl_usd,
        roi = EXCLUDED.roi,
        poly_resolution = EXCLUDED.poly_resolution,
        kalshi_resolution = EXCLUDED.kalshi_resolution,
        legs_json = EXCLUDED.legs_json,
        mismatch_p_fatal = EXCLUDED.mismatch_p_fatal,
        mismatch_p_fatal_upper = EXCLUDED.mismatch_p_fatal_upper,
        mismatch_model_version = EXCLUDED.mismatch_model_version,
        fatal_mismatch_pnl_usd = EXCLUDED.fatal_mismatch_pnl_usd,
        conservative_expected_pnl_usd = EXCLUDED.conservative_expected_pnl_usd,
        fatal_loss_exposure_usd = EXCLUDED.fatal_loss_exposure_usd,
        mismatch_risk_audit_json = EXCLUDED.mismatch_risk_audit_json,
        shadow_execution_json = EXCLUDED.shadow_execution_json
    `,
    [
      intent.id,
      intent.asset,
      intent.shadow,
      intent.slotKey,
      intent.slotStartTs,
      intent.slotEndTs,
      intent.combination,
      intent.status,
      intent.createdAt,
      intent.updatedAt,
      intent.resolvedAt,
      intent.primaryVenue,
      intent.hedgeVenue,
      intent.grossCost,
      intent.targetNotionalUsd,
      intent.maxSlippageBps,
      intent.entrySizingReason ?? null,
      intent.failureReason,
      intent.projectedNetProfitUsd,
      intent.realizedPnlUsd,
      intent.roi,
      intent.polyResolution,
      intent.kalshiResolution,
      JSON.stringify(intent.legs),
      intent.mismatchPFatal ?? null,
      intent.mismatchPFatalUpper ?? null,
      intent.mismatchModelVersion ?? null,
      intent.fatalMismatchPnlUsd ?? null,
      intent.conservativeExpectedPnlUsd ?? null,
      intent.fatalLossExposureUsd ?? null,
      intent.mismatchRiskAudit === null || intent.mismatchRiskAudit === undefined
        ? null
        : JSON.stringify(intent.mismatchRiskAudit),
      intent.shadowExecution === null || intent.shadowExecution === undefined
        ? null
        : JSON.stringify(intent.shadowExecution),
    ],
  );
}

export async function listOpenOrderIntents(pool: Pool, asset?: MarketAsset): Promise<OrderIntent[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM order_intents
      WHERE status NOT IN ('settled', 'failed', 'skipped', 'canceled', 'unwound')
        ${asset ? "AND asset = $1" : ""}
      ORDER BY updated_at DESC
    `,
    asset ? [asset] : [],
  );
  return result.rows.map(mapOrderIntentRow);
}

export async function listRecentOrderIntents(pool: Pool, limit = 50, asset?: MarketAsset): Promise<OrderIntent[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM order_intents
      ${asset ? "WHERE asset = $2" : ""}
      ORDER BY created_at DESC
      LIMIT $1
    `,
    asset ? [limit, asset] : [limit],
  );
  return result.rows.map(mapOrderIntentRow);
}

export async function listRecentSettledOrderIntents(
  pool: Pool,
  limit = 200,
  asset?: MarketAsset,
): Promise<OrderIntent[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM order_intents
      WHERE status = 'settled'
        ${asset ? "AND asset = $2" : ""}
      ORDER BY resolved_at DESC NULLS LAST, updated_at DESC
      LIMIT $1
    `,
    asset ? [limit, asset] : [limit],
  );
  return result.rows.map(mapOrderIntentRow);
}

export async function findOrderIntent(pool: Pool, intentId: string) {
  const result = await pool.query("SELECT * FROM order_intents WHERE id = $1 LIMIT 1", [intentId]);
  return result.rows[0] ? mapOrderIntentRow(result.rows[0]) : null;
}

export async function getLiveRealizedPnlUsd(pool: Pool) {
  const result = await pool.query<{ realized_pnl_usd: number }>(
    `
      SELECT COALESCE(SUM(realized_pnl_usd), 0) AS realized_pnl_usd
      FROM order_intents
      WHERE shadow = false
        AND realized_pnl_usd IS NOT NULL
    `,
  );
  return Number(result.rows[0]?.realized_pnl_usd ?? 0);
}

const TERMINAL_VENUE_ORDER_STATUSES = new Set<LiveOrder["status"]>(["filled", "canceled", "rejected", "expired"]);
const NON_FILLED_TERMINAL_VENUE_ORDER_STATUSES = new Set<LiveOrder["status"]>(["canceled", "rejected", "expired"]);

export class PersistenceIdentityConflictError extends Error {
  constructor(entity: "venue_order" | "order_attempt", id: string, fields: string[]) {
    super(`Immutable ${entity} identity conflict for ${id}: ${fields.join(", ")}`);
    this.name = "PersistenceIdentityConflictError";
  }
}

function venueOrderParams(order: LiveOrder) {
  return [
    order.id,
    order.asset,
    order.shadow,
    order.intentId,
    order.venue,
    order.venueOrderId,
    order.clientOrderId,
    order.marketRef,
    order.tokenId ?? null,
    order.side,
    order.outcome,
    order.orderType,
    order.requestedPrice,
    order.requestedSize,
    order.filledSize,
    order.averageFillPrice,
    order.feeUsd,
    order.status,
    order.createdAt,
    order.updatedAt,
    JSON.stringify(order.raw),
  ];
}

function orderAttemptParams(attempt: OrderAttempt) {
  return [
    attempt.id,
    attempt.asset,
    attempt.shadow,
    attempt.intentId,
    attempt.legId,
    attempt.stage,
    attempt.venue,
    attempt.side,
    attempt.orderType,
    attempt.clientOrderId,
    attempt.venueOrderId,
    attempt.status,
    attempt.truthStatus,
    JSON.stringify(attempt.request),
    attempt.result === null ? null : JSON.stringify(attempt.result),
    attempt.error,
    attempt.createdAt,
    attempt.updatedAt,
  ];
}

function orderAttemptNonTerminalRank(status: OrderAttempt["status"]) {
  switch (status) {
    case "planned":
      return 0;
    case "submitted":
      return 1;
    case "truth_pending":
      return 2;
    case "confirmed":
    case "failed":
      return 3;
  }
}

export function mergeVenueOrderEvidence(existing: LiveOrder, incoming: LiveOrder): LiveOrder {
  assertVenueOrderIdentity(existing, incoming);
  const existingTerminal = TERMINAL_VENUE_ORDER_STATUSES.has(existing.status);
  const incomingTerminal = TERMINAL_VENUE_ORDER_STATUSES.has(incoming.status);
  const incomingHasMoreFill = incoming.filledSize > existing.filledSize;
  const fillIsEqual = incoming.filledSize === existing.filledSize;
  const incomingProvesFilled = incoming.status === "filled" && incoming.filledSize > 0 && existing.status !== "filled";
  const incomingIsAtLeastAsComplete =
    incomingHasMoreFill ||
    incomingProvesFilled ||
    (fillIsEqual && !existingTerminal && incomingTerminal) ||
    (fillIsEqual && !existingTerminal && !incomingTerminal && incoming.updatedAt >= existing.updatedAt) ||
    (fillIsEqual && existing.status === incoming.status && incoming.updatedAt >= existing.updatedAt);

  let status = existing.status;
  if (incoming.status === "filled" && incoming.filledSize > 0) {
    status = "filled";
  } else if (existing.status === "filled") {
    status = "filled";
  } else if (NON_FILLED_TERMINAL_VENUE_ORDER_STATUSES.has(existing.status)) {
    status = existing.status;
  } else if (existingTerminal && !incomingTerminal) {
    status = existing.status;
  } else if (incomingHasMoreFill || (fillIsEqual && incoming.updatedAt >= existing.updatedAt)) {
    status = incoming.status;
  }

  return {
    ...existing,
    clientOrderId: existing.clientOrderId ?? incoming.clientOrderId,
    filledSize: Math.max(existing.filledSize, incoming.filledSize),
    averageFillPrice: incomingIsAtLeastAsComplete
      ? (incoming.averageFillPrice ?? existing.averageFillPrice)
      : existing.averageFillPrice,
    feeUsd: incomingIsAtLeastAsComplete ? (incoming.feeUsd ?? existing.feeUsd) : existing.feeUsd,
    status,
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
    raw: incomingIsAtLeastAsComplete ? incoming.raw : existing.raw,
  };
}

export function mergeOrderAttemptEvidence(existing: OrderAttempt, incoming: OrderAttempt): OrderAttempt {
  assertOrderAttemptIdentity(existing, incoming);
  const existingNonTerminalRank = orderAttemptNonTerminalRank(existing.status);
  const incomingNonTerminalRank = orderAttemptNonTerminalRank(incoming.status);

  let acceptIncomingEvidence = false;
  let status = existing.status;
  if (incoming.status === "confirmed") {
    acceptIncomingEvidence = true;
    status = "confirmed";
  } else if (existing.status === "confirmed") {
    status = "confirmed";
  } else if (
    existing.status === "failed" &&
    (incoming.status === "submitted" || incoming.status === "truth_pending") &&
    incoming.updatedAt > existing.updatedAt
  ) {
    acceptIncomingEvidence = true;
    status = incoming.status;
  } else if (existing.status === "failed") {
    status = "failed";
  } else if (incoming.status === "failed") {
    acceptIncomingEvidence = incoming.updatedAt >= existing.updatedAt;
    status = acceptIncomingEvidence ? incoming.status : existing.status;
  } else if (incomingNonTerminalRank >= existingNonTerminalRank && incoming.updatedAt >= existing.updatedAt) {
    acceptIncomingEvidence = true;
    status = incoming.status;
  }

  return {
    ...existing,
    venueOrderId: incoming.venueOrderId ?? existing.venueOrderId,
    status,
    truthStatus: acceptIncomingEvidence ? (incoming.truthStatus ?? existing.truthStatus) : existing.truthStatus,
    result: acceptIncomingEvidence ? (incoming.result ?? existing.result) : existing.result,
    error: acceptIncomingEvidence ? incoming.error : existing.error,
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
  };
}

function assertVenueOrderIdentity(existing: LiveOrder, incoming: LiveOrder) {
  const conflicts = collectIdentityConflicts([
    ["id", existing.id, incoming.id],
    ["asset", existing.asset, incoming.asset],
    ["shadow", existing.shadow, incoming.shadow],
    ["intentId", existing.intentId, incoming.intentId],
    ["venue", existing.venue, incoming.venue],
    ["venueOrderId", existing.venueOrderId, incoming.venueOrderId],
    ["marketRef", existing.marketRef, incoming.marketRef],
    ["tokenId", existing.tokenId ?? null, incoming.tokenId ?? null],
    ["side", existing.side, incoming.side],
    ["outcome", existing.outcome, incoming.outcome],
    ["orderType", existing.orderType, incoming.orderType],
    ["requestedPrice", existing.requestedPrice, incoming.requestedPrice],
    ["requestedSize", existing.requestedSize, incoming.requestedSize],
  ]);
  if (
    existing.clientOrderId !== null &&
    incoming.clientOrderId !== null &&
    existing.clientOrderId !== incoming.clientOrderId
  ) {
    conflicts.push("clientOrderId");
  }
  if (conflicts.length > 0) {
    throw new PersistenceIdentityConflictError("venue_order", existing.id, conflicts);
  }
}

function assertOrderAttemptIdentity(existing: OrderAttempt, incoming: OrderAttempt) {
  const conflicts = collectIdentityConflicts([
    ["id", existing.id, incoming.id],
    ["asset", existing.asset, incoming.asset],
    ["shadow", existing.shadow, incoming.shadow],
    ["intentId", existing.intentId, incoming.intentId],
    ["legId", existing.legId, incoming.legId],
    ["stage", existing.stage, incoming.stage],
    ["venue", existing.venue, incoming.venue],
    ["side", existing.side, incoming.side],
    ["orderType", existing.orderType, incoming.orderType],
    ["clientOrderId", existing.clientOrderId, incoming.clientOrderId],
  ]);
  if (
    existing.venueOrderId !== null &&
    incoming.venueOrderId !== null &&
    existing.venueOrderId !== incoming.venueOrderId
  ) {
    conflicts.push("venueOrderId");
  }
  if (conflicts.length > 0) {
    throw new PersistenceIdentityConflictError("order_attempt", existing.id, conflicts);
  }
}

function collectIdentityConflicts(fields: Array<[string, unknown, unknown]>) {
  return fields.filter(([, existing, incoming]) => existing !== incoming).map(([field]) => field);
}

export async function upsertVenueOrder(pool: Pool, order: LiveOrder) {
  await withRowLockTransaction(pool, async (client) => {
    const inserted = await client.query(
      `
        INSERT INTO venue_orders (
          id, asset, shadow, intent_id, venue, venue_order_id, client_order_id, market_ref, token_id, side, outcome,
          order_type, requested_price, requested_size, filled_size, average_fill_price, fee_usd,
          status, created_at, updated_at, raw_json
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16, $17,
          $18, $19, $20, $21::jsonb
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `,
      venueOrderParams(order),
    );
    if (inserted.rowCount === 1) {
      return;
    }

    const locked = await client.query("SELECT * FROM venue_orders WHERE id = $1 FOR UPDATE", [order.id]);
    if (!locked.rows[0]) {
      throw new Error(`Venue order ${order.id} conflicted without a row that can be reconciled`);
    }

    const merged = mergeVenueOrderEvidence(mapVenueOrderRow(locked.rows[0]), order);
    await client.query(
      `
        UPDATE venue_orders
        SET client_order_id = $2,
            filled_size = $3,
            average_fill_price = $4,
            fee_usd = $5,
            status = $6,
            updated_at = $7,
            raw_json = $8::jsonb,
            revision = revision + 1
        WHERE id = $1
      `,
      [
        merged.id,
        merged.clientOrderId,
        merged.filledSize,
        merged.averageFillPrice,
        merged.feeUsd,
        merged.status,
        merged.updatedAt,
        JSON.stringify(merged.raw),
      ],
    );
  });
}

export async function upsertOrderAttempt(pool: Pool, attempt: OrderAttempt) {
  await withRowLockTransaction(pool, async (client) => {
    const inserted = await client.query(
      `
        INSERT INTO order_attempts (
          id, asset, shadow, intent_id, leg_id, stage, venue, side, order_type, client_order_id,
          venue_order_id, status, truth_status, request_json, result_json, error, created_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14::jsonb, $15::jsonb, $16, $17, $18
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `,
      orderAttemptParams(attempt),
    );
    if (inserted.rowCount === 1) {
      return;
    }

    const locked = await client.query("SELECT * FROM order_attempts WHERE id = $1 FOR UPDATE", [attempt.id]);
    if (!locked.rows[0]) {
      throw new Error(`Order attempt ${attempt.id} conflicted without a row that can be reconciled`);
    }

    const merged = mergeOrderAttemptEvidence(mapOrderAttemptRow(locked.rows[0]), attempt);
    await client.query(
      `
        UPDATE order_attempts
        SET venue_order_id = $2,
            status = $3,
            truth_status = $4,
            result_json = $5::jsonb,
            error = $6,
            updated_at = $7,
            revision = revision + 1
        WHERE id = $1
      `,
      [
        merged.id,
        merged.venueOrderId,
        merged.status,
        merged.truthStatus,
        merged.result === null ? null : JSON.stringify(merged.result),
        merged.error,
        merged.updatedAt,
      ],
    );
  });
}

export async function listRecentOrderAttempts(pool: Pool, limit = 100, asset?: MarketAsset): Promise<OrderAttempt[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM order_attempts
      ${asset ? "WHERE asset = $2" : ""}
      ORDER BY updated_at DESC
      LIMIT $1
    `,
    asset ? [limit, asset] : [limit],
  );
  return result.rows.map(mapOrderAttemptRow);
}

export async function findOrderAttemptById(pool: Pool, attemptId: string): Promise<OrderAttempt | null> {
  const result = await pool.query("SELECT * FROM order_attempts WHERE id = $1 LIMIT 1", [attemptId]);
  return result.rows[0] ? mapOrderAttemptRow(result.rows[0]) : null;
}

export async function listOrderAttemptsForIntent(pool: Pool, intentId: string): Promise<OrderAttempt[]> {
  const result = await pool.query("SELECT * FROM order_attempts WHERE intent_id = $1 ORDER BY created_at ASC, id ASC", [
    intentId,
  ]);
  return result.rows.map(mapOrderAttemptRow);
}

export async function listRecentVenueOrders(pool: Pool, limit = 50, asset?: MarketAsset): Promise<LiveOrder[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM venue_orders
      ${asset ? "WHERE asset = $2" : ""}
      ORDER BY updated_at DESC
      LIMIT $1
    `,
    asset ? [limit, asset] : [limit],
  );
  return result.rows.map(mapVenueOrderRow);
}

export async function listVenueOrdersForIntentIds(pool: Pool, intentIds: string[], limit = 500): Promise<LiveOrder[]> {
  if (intentIds.length === 0) {
    return [];
  }

  const result = await pool.query(
    `
      SELECT *
      FROM venue_orders
      WHERE intent_id = ANY($1::text[])
      ORDER BY created_at DESC, updated_at DESC
      LIMIT $2
    `,
    [intentIds, limit],
  );
  return result.rows.map(mapVenueOrderRow);
}

export async function listOpenVenueOrders(pool: Pool, asset?: MarketAsset) {
  const result = await pool.query(
    `
      SELECT *
      FROM venue_orders
      WHERE status IN ('pending', 'live', 'partially_filled')
        ${asset ? "AND asset = $1" : ""}
      ORDER BY updated_at DESC
    `,
    asset ? [asset] : [],
  );
  return result.rows.map(mapVenueOrderRow);
}

export async function findVenueOrderByExchangeId(pool: Pool, venue: string, venueOrderId: string) {
  const result = await pool.query(
    `
      SELECT *
      FROM venue_orders
      WHERE venue = $1 AND venue_order_id = $2
      LIMIT 1
    `,
    [venue, venueOrderId],
  );
  return result.rows[0] ? mapVenueOrderRow(result.rows[0]) : null;
}

export class ImmutableFillConflictError extends Error {
  constructor(fill: LiveFill, conflict: "id" | "logical_key" | "multiple_rows") {
    const identity =
      conflict === "id"
        ? `id ${fill.id}`
        : conflict === "logical_key"
          ? `logical key ${fill.venue}/${fill.venueOrderId}/${fill.tradeId}`
          : `id and logical key for ${fill.id}`;
    super(`Immutable fill conflict on ${identity}`);
    this.name = "ImmutableFillConflictError";
  }
}

function fillParams(fill: LiveFill) {
  return [
    fill.id,
    fill.asset,
    fill.shadow,
    fill.intentId,
    fill.venue,
    fill.venueOrderId,
    fill.tradeId,
    fill.marketRef,
    fill.tokenId ?? null,
    fill.side,
    fill.outcome,
    fill.price,
    fill.size,
    fill.feeUsd,
    fill.liquidity,
    fill.filledAt,
    JSON.stringify(fill.raw),
  ];
}

export function areFillsEconomicallyIdentical(existing: LiveFill, incoming: LiveFill) {
  return (
    existing.asset === incoming.asset &&
    existing.shadow === incoming.shadow &&
    existing.intentId === incoming.intentId &&
    existing.venue === incoming.venue &&
    existing.venueOrderId === incoming.venueOrderId &&
    existing.tradeId === incoming.tradeId &&
    existing.marketRef === incoming.marketRef &&
    (existing.tokenId ?? null) === (incoming.tokenId ?? null) &&
    existing.side === incoming.side &&
    existing.outcome === incoming.outcome &&
    existing.price === incoming.price &&
    existing.size === incoming.size &&
    existing.feeUsd === incoming.feeUsd &&
    existing.liquidity === incoming.liquidity &&
    existing.filledAt === incoming.filledAt
  );
}

export async function upsertFill(pool: Pool, fill: LiveFill) {
  await withRowLockTransaction(pool, async (client) => {
    const inserted = await client.query(
      `
        INSERT INTO fills (
          id, asset, shadow, intent_id, venue, venue_order_id, trade_id, market_ref, token_id, side,
          outcome, price, size, fee_usd, liquidity, filled_at, raw_json
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17::jsonb
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `,
      fillParams(fill),
    );
    if (inserted.rowCount === 1) {
      return;
    }

    const conflicts = await client.query(
      `
        SELECT *
        FROM fills
        WHERE id = $1
           OR (venue = $2 AND venue_order_id = $3 AND trade_id = $4)
        FOR UPDATE
      `,
      [fill.id, fill.venue, fill.venueOrderId, fill.tradeId],
    );
    if (conflicts.rows.length !== 1) {
      throw new ImmutableFillConflictError(fill, "multiple_rows");
    }

    const existing = mapFillRow(conflicts.rows[0]);
    if (areFillsEconomicallyIdentical(existing, fill)) {
      return;
    }

    throw new ImmutableFillConflictError(fill, existing.id === fill.id ? "id" : "logical_key");
  });
}

async function withRowLockTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original persistence error; pg discards broken connections.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function listRecentFills(pool: Pool, limit = 100, asset?: MarketAsset): Promise<LiveFill[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM fills
      ${asset ? "WHERE asset = $2" : ""}
      ORDER BY filled_at DESC
      LIMIT $1
    `,
    asset ? [limit, asset] : [limit],
  );
  return result.rows.map(mapFillRow);
}

export async function listFillsForIntentIds(pool: Pool, intentIds: string[], limit = 1000): Promise<LiveFill[]> {
  if (intentIds.length === 0) {
    return [];
  }

  const result = await pool.query(
    `
      SELECT *
      FROM fills
      WHERE intent_id = ANY($1::text[])
      ORDER BY filled_at DESC, trade_id DESC
      LIMIT $2
    `,
    [intentIds, limit],
  );
  return result.rows.map(mapFillRow);
}

export async function getLiveFeesUsd(pool: Pool) {
  const result = await pool.query<{ fees_usd: number }>(
    `
      SELECT COALESCE(SUM(fee_usd), 0) AS fees_usd
      FROM fills
      WHERE shadow = false
    `,
  );
  return Number(result.rows[0]?.fees_usd ?? 0);
}

export async function listFillsForIntentVenue(pool: Pool, intentId: string, venue: Venue): Promise<LiveFill[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM fills
      WHERE intent_id = $1 AND venue = $2
      ORDER BY filled_at ASC, trade_id ASC
    `,
    [intentId, venue],
  );
  return result.rows.map(mapFillRow);
}

export async function replaceVenuePositions(
  pool: Pool,
  venue: "polymarket" | "kalshi",
  asset: MarketAsset,
  positions: PositionSnapshot[],
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM positions WHERE venue = $1 AND asset = $2", [venue, asset]);
    for (const position of positions) {
      await client.query(
        `
          INSERT INTO positions (
            id, asset, venue, market_ref, outcome, size, average_price, current_price, current_value_usd,
            realized_pnl_usd, unrealized_pnl_usd, redeemable, mergeable, updated_at, raw_json
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9,
            $10, $11, $12, $13, $14, $15::jsonb
          )
        `,
        [
          position.id,
          position.asset,
          position.venue,
          position.marketRef,
          position.outcome,
          position.size,
          position.averagePrice,
          position.currentPrice,
          position.currentValueUsd,
          position.realizedPnlUsd,
          position.unrealizedPnlUsd,
          position.redeemable,
          position.mergeable,
          position.updatedAt,
          JSON.stringify(position.raw),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listPositions(pool: Pool, asset?: MarketAsset): Promise<PositionSnapshot[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM positions
      ${asset ? "WHERE asset = $1" : ""}
      ORDER BY venue ASC, current_value_usd DESC
    `,
    asset ? [asset] : [],
  );
  return result.rows.map(mapPositionRow);
}

export async function upsertSettlement(
  pool: Pool,
  settlement: {
    id: string;
    asset: MarketAsset;
    intentId: string;
    venue: string;
    marketRef: string;
    outcome: string;
    resolvedOutcome: string | null;
    payoutUsd: number;
    settledAt: number;
    raw: Record<string, unknown>;
  },
) {
  await pool.query(
    `
      INSERT INTO settlements (
        id, asset, intent_id, venue, market_ref, outcome, resolved_outcome, payout_usd, settled_at, raw_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        asset = EXCLUDED.asset,
        resolved_outcome = EXCLUDED.resolved_outcome,
        payout_usd = EXCLUDED.payout_usd,
        settled_at = EXCLUDED.settled_at,
        raw_json = EXCLUDED.raw_json
    `,
    [
      settlement.id,
      settlement.asset,
      settlement.intentId,
      settlement.venue,
      settlement.marketRef,
      settlement.outcome,
      settlement.resolvedOutcome,
      settlement.payoutUsd,
      settlement.settledAt,
      JSON.stringify(settlement.raw),
    ],
  );
}

export async function insertPnlSnapshot(pool: Pool, snapshot: PnlSnapshot) {
  await pool.query(
    `
      INSERT INTO pnl_snapshots (
        captured_at, equity_usd, cash_usd, positions_value_usd,
        realized_pnl_usd, unrealized_pnl_usd, fees_usd, venue_breakdown_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    `,
    [
      snapshot.capturedAt,
      snapshot.equityUsd,
      snapshot.cashUsd,
      snapshot.positionsValueUsd,
      snapshot.realizedPnlUsd,
      snapshot.unrealizedPnlUsd,
      snapshot.feesUsd,
      JSON.stringify(snapshot.venueBreakdown),
    ],
  );
}

export async function getLatestPnlSnapshot(pool: Pool): Promise<PnlSnapshot | null> {
  const result = await pool.query(
    `
      SELECT *
      FROM pnl_snapshots
      ORDER BY captured_at DESC
      LIMIT 1
    `,
  );
  return result.rows[0] ? mapPnlSnapshotRow(result.rows[0]) : null;
}

export async function getPolymarketCashAdjustmentObservation(
  pool: Pool,
  intentId: string,
): Promise<VenueCashAdjustmentObservation | null> {
  const result = await pool.query(
    `
      WITH poly_orders AS (
        SELECT
          intent_id,
          venue,
          MIN(created_at) AS first_order_created_at,
          MAX(created_at) AS last_order_created_at,
          COUNT(*)::int AS order_count,
          SUM(
            COALESCE(
              NULLIF(raw_json->>'makingAmount', '')::double precision,
              average_fill_price * filled_size,
              requested_price * filled_size,
              0
            )
          ) AS theoretical_cash_debit_usd
        FROM venue_orders
        WHERE intent_id = $1
          AND venue = 'polymarket'
          AND side = 'BUY'
          AND filled_size > 0
        GROUP BY intent_id, venue
      ),
      before_snap AS (
        SELECT
          p.captured_at,
          (venue_json->>'availableBalanceUsd')::double precision AS cash_usd
        FROM pnl_snapshots p
        CROSS JOIN LATERAL jsonb_array_elements(p.venue_breakdown_json) venue_json
        WHERE venue_json->>'venue' = 'polymarket'
          AND p.captured_at < (SELECT first_order_created_at FROM poly_orders)
        ORDER BY p.captured_at DESC, p.id DESC
        LIMIT 1
      ),
      after_snap AS (
        SELECT
          p.captured_at,
          (venue_json->>'availableBalanceUsd')::double precision AS cash_usd
        FROM pnl_snapshots p
        CROSS JOIN LATERAL jsonb_array_elements(p.venue_breakdown_json) venue_json
        CROSS JOIN before_snap b
        CROSS JOIN poly_orders o
        WHERE venue_json->>'venue' = 'polymarket'
          AND p.captured_at > o.last_order_created_at
          AND b.cash_usd - (venue_json->>'availableBalanceUsd')::double precision >= o.theoretical_cash_debit_usd * 0.5
        ORDER BY p.captured_at ASC, p.id ASC
        LIMIT 1
      )
      SELECT
        o.intent_id,
        o.venue,
        o.order_count,
        o.first_order_created_at,
        o.last_order_created_at,
        b.captured_at AS before_captured_at,
        a.captured_at AS after_captured_at,
        b.cash_usd AS cash_before_usd,
        a.cash_usd AS cash_after_usd,
        (b.cash_usd - a.cash_usd) AS observed_cash_debit_usd,
        o.theoretical_cash_debit_usd,
        (b.cash_usd - a.cash_usd - o.theoretical_cash_debit_usd) AS adjustment_usd
      FROM poly_orders o
      CROSS JOIN before_snap b
      CROSS JOIN after_snap a
      LIMIT 1
    `,
    [intentId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    intentId: row.intent_id,
    venue: row.venue,
    orderCount: Number(row.order_count),
    firstOrderCreatedAt: Number(row.first_order_created_at),
    lastOrderCreatedAt: Number(row.last_order_created_at),
    beforeCapturedAt: Number(row.before_captured_at),
    afterCapturedAt: Number(row.after_captured_at),
    cashBeforeUsd: Number(row.cash_before_usd),
    cashAfterUsd: Number(row.cash_after_usd),
    observedCashDebitUsd: round4(Number(row.observed_cash_debit_usd)),
    theoreticalCashDebitUsd: round4(Number(row.theoretical_cash_debit_usd)),
    adjustmentUsd: round4(Number(row.adjustment_usd)),
  };
}

export async function insertStablePnlChange(
  pool: Pool,
  intent: OrderIntent,
  changedAt: number,
  stability: Record<string, unknown>,
) {
  if (intent.realizedPnlUsd === null) {
    return false;
  }

  const result = await pool.query(
    `
      WITH latest AS (
        SELECT *
        FROM pnl_snapshots
        WHERE equity_usd::text NOT IN ('NaN', 'Infinity', '-Infinity')
          AND equity_usd > 0
        ORDER BY captured_at DESC, id DESC
        LIMIT 1
      ),
      baseline AS (
        SELECT equity_usd
        FROM pnl_snapshots
        WHERE equity_usd::text NOT IN ('NaN', 'Infinity', '-Infinity')
          AND equity_usd > 0
        ORDER BY captured_at ASC, id ASC
        LIMIT 1
      ),
      peak AS (
        SELECT equity_usd
        FROM pnl_snapshots
        WHERE equity_usd::text NOT IN ('NaN', 'Infinity', '-Infinity')
          AND equity_usd > 0
        ORDER BY equity_usd DESC, captured_at DESC, id DESC
        LIMIT 1
      )
      INSERT INTO stable_pnl_changes (
        intent_id, asset, combination, changed_at, settled_at, realized_pnl_usd, roi,
        target_notional_usd, equity_usd, cash_usd, positions_value_usd, strategy_pnl_usd,
        account_delta_usd, baseline_equity_usd, peak_equity_usd, drawdown_usd,
        venue_breakdown_json, stability_json
      )
      SELECT
        $1, $2, $3, $4, $5, $6, $7,
        $8, latest.equity_usd, latest.cash_usd, latest.positions_value_usd,
        latest.realized_pnl_usd + latest.unrealized_pnl_usd,
        latest.equity_usd - COALESCE(baseline.equity_usd, latest.equity_usd),
        COALESCE(baseline.equity_usd, latest.equity_usd),
        COALESCE(peak.equity_usd, latest.equity_usd),
        latest.equity_usd - COALESCE(peak.equity_usd, latest.equity_usd),
        latest.venue_breakdown_json,
        $9::jsonb
      FROM latest
      CROSS JOIN baseline
      CROSS JOIN peak
      ON CONFLICT (intent_id) DO UPDATE SET
        settled_at = EXCLUDED.settled_at,
        realized_pnl_usd = EXCLUDED.realized_pnl_usd,
        roi = EXCLUDED.roi,
        target_notional_usd = EXCLUDED.target_notional_usd,
        stability_json = EXCLUDED.stability_json
      WHERE stable_pnl_changes.settled_at IS DISTINCT FROM EXCLUDED.settled_at
        OR stable_pnl_changes.realized_pnl_usd IS DISTINCT FROM EXCLUDED.realized_pnl_usd
        OR stable_pnl_changes.roi IS DISTINCT FROM EXCLUDED.roi
        OR stable_pnl_changes.target_notional_usd IS DISTINCT FROM EXCLUDED.target_notional_usd
      RETURNING intent_id
    `,
    [
      intent.id,
      intent.asset,
      intent.combination,
      changedAt,
      intent.resolvedAt,
      intent.realizedPnlUsd,
      intent.roi,
      intent.targetNotionalUsd,
      JSON.stringify(stability),
    ],
  );

  return (result.rowCount ?? 0) > 0;
}

export async function updateStablePnlChangeFromIntent(pool: Pool, intent: OrderIntent) {
  if (intent.realizedPnlUsd === null) {
    return false;
  }

  const result = await pool.query(
    `
      UPDATE stable_pnl_changes
      SET
        settled_at = $2,
        realized_pnl_usd = $3,
        roi = $4,
        target_notional_usd = $5
      WHERE intent_id = $1
        AND (
          settled_at IS DISTINCT FROM $2
          OR realized_pnl_usd IS DISTINCT FROM $3
          OR roi IS DISTINCT FROM $4
          OR target_notional_usd IS DISTINCT FROM $5
        )
    `,
    [intent.id, intent.resolvedAt, intent.realizedPnlUsd, intent.roi, intent.targetNotionalUsd],
  );

  return (result.rowCount ?? 0) > 0;
}

export async function listStablePnlChanges(pool: Pool, limit = 5, asset?: MarketAsset): Promise<StablePnlChange[]> {
  const result = await pool.query(
    `
      SELECT
        *
      FROM stable_pnl_changes
      ${asset ? "WHERE asset = $2" : ""}
      ORDER BY changed_at DESC, intent_id DESC
      LIMIT $1
    `,
    asset ? [limit, asset] : [limit],
  );

  return result.rows.map(mapStablePnlChangeRow);
}

export async function sumStableRealizedPnlSince(pool: Pool, since: number, until: number) {
  const result = await pool.query<{ total: number | null }>(
    `
      SELECT COALESCE(SUM(realized_pnl_usd), 0) AS total
      FROM stable_pnl_changes
      WHERE changed_at >= $1
        AND changed_at < $2
    `,
    [since, until],
  );
  return Number(result.rows[0]?.total ?? 0);
}

export async function insertMarketFillQualityEvent(pool: Pool, event: MarketFillQualityEvent) {
  await pool.query(
    `
      INSERT INTO market_fill_quality_events (
        id, asset, slot_key, intent_id, combination, primary_venue, hedge_venue,
        outcome, stage, slippage_bps, payload_json, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
      ON CONFLICT (id) DO NOTHING
    `,
    [
      event.id,
      event.asset,
      event.slotKey,
      event.intentId,
      event.combination,
      event.primaryVenue,
      event.hedgeVenue,
      event.outcome,
      event.stage,
      event.slippageBps,
      JSON.stringify(event.payload),
      event.createdAt,
    ],
  );
}

export async function listRecentMarketFillQualityEvents(
  pool: Pool,
  since: number,
  asset?: MarketAsset,
): Promise<MarketFillQualityEvent[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM market_fill_quality_events
      WHERE created_at >= $1
        ${asset ? "AND asset = $2" : ""}
      ORDER BY created_at DESC
    `,
    asset ? [since, asset] : [since],
  );
  return result.rows.map(mapMarketFillQualityEventRow);
}

export async function listDegradedMarketFillQualityCounts(
  pool: Pool,
  since: number,
  asset?: MarketAsset,
): Promise<Array<{ asset: MarketAsset; slotKey: string; degradedCount: number; lastEventAt: number }>> {
  const result = await pool.query(
    `
      SELECT asset, slot_key, COUNT(*)::int AS degraded_count, MAX(created_at) AS last_event_at
      FROM market_fill_quality_events
      WHERE created_at >= $1
        AND outcome IN ('partial_fill', 'no_fill', 'rescue', 'unwind', 'manual_required')
        ${asset ? "AND asset = $2" : ""}
      GROUP BY asset, slot_key
      ORDER BY degraded_count DESC, last_event_at DESC
    `,
    asset ? [since, asset] : [since],
  );
  return result.rows.map((row) => ({
    asset: row.asset,
    slotKey: row.slot_key,
    degradedCount: Number(row.degraded_count),
    lastEventAt: Number(row.last_event_at),
  }));
}

async function getFirstTrackedEquityUsd(pool: Pool) {
  const result = await pool.query<{ equity_usd: number }>(
    `
      SELECT equity_usd
      FROM pnl_snapshots
      WHERE equity_usd::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND equity_usd > 0
      ORDER BY captured_at ASC, id ASC
      LIMIT 1
    `,
  );
  return result.rows[0] ? Number(result.rows[0].equity_usd) : null;
}

async function getPeakTrackedEquityUsd(pool: Pool) {
  const result = await pool.query<{ equity_usd: number }>(
    `
      SELECT equity_usd
      FROM pnl_snapshots
      WHERE equity_usd::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND equity_usd > 0
      ORDER BY equity_usd DESC, captured_at DESC, id DESC
      LIMIT 1
    `,
  );
  return result.rows[0]?.equity_usd !== null && result.rows[0]?.equity_usd !== undefined
    ? Number(result.rows[0].equity_usd)
    : null;
}

export async function upsertBridgeTransfer(pool: Pool, transfer: BridgeTransfer) {
  await pool.query(
    `
      INSERT INTO bridge_transfers (
        id, venue, status, created_at, updated_at, quote_id, source_chain, source_asset, target_asset,
        amount_in_usd, amount_out_usd, tx_hash, deposit_addresses_json, raw_json
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13::jsonb, $14::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at,
        quote_id = EXCLUDED.quote_id,
        tx_hash = EXCLUDED.tx_hash,
        amount_in_usd = EXCLUDED.amount_in_usd,
        amount_out_usd = EXCLUDED.amount_out_usd,
        deposit_addresses_json = EXCLUDED.deposit_addresses_json,
        raw_json = EXCLUDED.raw_json
    `,
    [
      transfer.id,
      transfer.venue,
      transfer.status,
      transfer.createdAt,
      transfer.updatedAt,
      transfer.quoteId,
      transfer.sourceChain,
      transfer.sourceAsset,
      transfer.targetAsset,
      transfer.amountInUsd,
      transfer.amountOutUsd,
      transfer.txHash,
      JSON.stringify(transfer.depositAddresses),
      JSON.stringify(transfer.raw),
    ],
  );
}

export async function getDatabaseMetrics(pool: Pool): Promise<DatabaseMetrics> {
  const [sizeResult, tablesResult] = await Promise.all([
    pool.query<{ size_bytes: number }>("SELECT pg_database_size(current_database()) AS size_bytes"),
    pool.query<{ table_name: string; total_bytes: number }>(`
      SELECT
        c.relname AS table_name,
        pg_total_relation_size(c.oid) AS total_bytes
      FROM pg_class c
      INNER JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
      ORDER BY total_bytes DESC, table_name ASC
      LIMIT 8
    `),
  ]);

  return {
    capturedAt: Date.now(),
    storageMode: "postgres",
    databaseSizeBytes: sizeResult.rows[0]?.size_bytes ?? 0,
    largestTables: tablesResult.rows.map((row) => ({
      tableName: row.table_name,
      totalBytes: row.total_bytes,
    })),
  };
}

export async function runDatabaseMaintenance(
  pool: Pool,
  config: DatabaseMaintenanceConfig,
  now = Date.now(),
): Promise<DatabaseMaintenanceSummary> {
  const startedAt = Date.now();
  const deleted: DatabaseMaintenanceSummary["deleted"] = {
    snapshots: 0,
    oracleSamples: 0,
    slotResolutions: 0,
    pnlSnapshots: 0,
    runEvents: 0,
    fills: 0,
    venueOrders: 0,
    closedIntents: 0,
    settlements: 0,
    bridgeTransfers: 0,
  };

  deleted.fills = await deleteBefore(
    pool,
    config.retention.fillsMs,
    now,
    `
    DELETE FROM fills
    WHERE filled_at < $1
  `,
  );

  deleted.venueOrders = await deleteBefore(
    pool,
    config.retention.venueOrdersMs,
    now,
    `
    DELETE FROM venue_orders
    WHERE status IN ('filled', 'canceled', 'rejected', 'expired')
      AND updated_at < $1
  `,
  );

  deleted.closedIntents = await deleteBefore(
    pool,
    config.retention.closedIntentsMs,
    now,
    `
    DELETE FROM order_intents
    WHERE status IN ('settled', 'failed', 'skipped', 'canceled', 'unwound')
      AND COALESCE(resolved_at, updated_at, created_at) < $1
  `,
  );

  deleted.settlements = await deleteBefore(
    pool,
    config.retention.settlementsMs,
    now,
    `
    DELETE FROM settlements
    WHERE settled_at < $1
  `,
  );

  deleted.bridgeTransfers = await deleteBefore(
    pool,
    config.retention.bridgeTransfersMs,
    now,
    `
    DELETE FROM bridge_transfers
    WHERE updated_at < $1
  `,
  );

  deleted.runEvents = await deleteBefore(
    pool,
    config.retention.runEventsMs,
    now,
    `
    DELETE FROM run_events
    WHERE created_at < $1
  `,
  );

  deleted.pnlSnapshots = await deleteBefore(
    pool,
    config.retention.pnlSnapshotsMs,
    now,
    `
    DELETE FROM pnl_snapshots
    WHERE captured_at < $1
  `,
  );

  deleted.snapshots = await deleteBefore(
    pool,
    config.retention.snapshotsMs,
    now,
    `
    DELETE FROM opportunity_snapshots
    WHERE captured_at < $1
  `,
  );

  deleted.oracleSamples = await deleteBefore(
    pool,
    config.retention.oracleSamplesMs,
    now,
    `
    DELETE FROM oracle_slot_samples
    WHERE captured_at < $1
  `,
  );

  deleted.slotResolutions = await deleteBefore(
    pool,
    config.retention.slotResolutionsMs,
    now,
    `
    DELETE FROM slot_resolutions
    WHERE slot_end_ts < $1
  `,
  );

  return {
    startedAt,
    finishedAt: Date.now(),
    deleted,
  };
}

export async function listRecentBridgeTransfers(pool: Pool, limit = 10): Promise<BridgeTransfer[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM bridge_transfers
      ORDER BY updated_at DESC
      LIMIT $1
    `,
    [limit],
  );
  return result.rows.map(mapBridgeTransferRow);
}

export async function insertRunEvent(pool: Pool, event: RunEvent) {
  await pool.query(
    `
      INSERT INTO run_events (asset, level, event_type, message, payload_json, created_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    `,
    [event.asset ?? null, event.level, event.eventType, event.message, JSON.stringify(event.payload), event.createdAt],
  );
}

export async function listRecentRunEvents(pool: Pool, limit = 20, asset?: MarketAsset | null): Promise<RunEvent[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM run_events
      ${asset === undefined ? "" : asset === null ? "WHERE asset IS NULL" : "WHERE asset = $2 OR asset IS NULL"}
      ORDER BY created_at DESC
      LIMIT $1
    `,
    asset === undefined ? [limit] : [limit, asset],
  );
  return result.rows.map((row) => ({
    id: row.id,
    asset: row.asset,
    level: row.level,
    eventType: row.event_type,
    message: row.message,
    payload: row.payload_json,
    createdAt: row.created_at,
  }));
}

function mapNotificationDeliveryRow(row: NotificationDeliveryRow): NotificationDelivery {
  return {
    id: row.id,
    asset: row.asset,
    channel: row.channel,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    message: row.message,
    payload: row.payload_json,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
  };
}

export async function enqueueNotificationDelivery(
  pool: Pool,
  delivery: Omit<NotificationDelivery, "id" | "status" | "updatedAt" | "sentAt" | "error">,
) {
  const result = await pool.query(
    `
      INSERT INTO notification_deliveries (
        asset, channel, kind, dedupe_key, message, payload_json, status, error, created_at, updated_at, sent_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending', NULL, $7, $7, NULL)
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING *
    `,
    [
      delivery.asset ?? null,
      delivery.channel,
      delivery.kind,
      delivery.dedupeKey,
      delivery.message,
      JSON.stringify(delivery.payload),
      delivery.createdAt,
    ],
  );

  return result.rows[0] ? mapNotificationDeliveryRow(result.rows[0]) : null;
}

export async function listPendingNotificationDeliveries(pool: Pool, limit = 10): Promise<NotificationDelivery[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM notification_deliveries
      WHERE status IN ('pending', 'failed')
      ORDER BY created_at ASC, id ASC
      LIMIT $1
    `,
    [limit],
  );
  return result.rows.map(mapNotificationDeliveryRow);
}

export async function markNotificationDeliverySent(pool: Pool, id: number, sentAt: number) {
  await pool.query(
    `
      UPDATE notification_deliveries
      SET status = 'sent',
          error = NULL,
          sent_at = $2,
          updated_at = $2
      WHERE id = $1
    `,
    [id, sentAt],
  );
}

export async function markNotificationDeliveryFailed(pool: Pool, id: number, error: string, updatedAt: number) {
  await pool.query(
    `
      UPDATE notification_deliveries
      SET status = 'failed',
          error = $2,
          updated_at = $3
      WHERE id = $1
    `,
    [id, error, updatedAt],
  );
}

export async function upsertCircuitBreaker(pool: Pool, breaker: CircuitBreaker) {
  await pool.query(
    `
      INSERT INTO circuit_breakers (key, active, reason, triggered_at, payload_json)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (key) DO UPDATE SET
        active = EXCLUDED.active,
        reason = EXCLUDED.reason,
        triggered_at = EXCLUDED.triggered_at,
        payload_json = EXCLUDED.payload_json
    `,
    [breaker.key, breaker.active, breaker.reason, breaker.triggeredAt, JSON.stringify(breaker.payload)],
  );
}

export async function listCircuitBreakers(pool: Pool): Promise<CircuitBreaker[]> {
  const result = await pool.query("SELECT * FROM circuit_breakers ORDER BY key ASC");
  return result.rows.map((row) => ({
    key: row.key,
    active: row.active,
    reason: row.reason,
    triggeredAt: row.triggered_at,
    payload: row.payload_json,
  }));
}

export async function upsertExecutionCandidate(pool: Pool, candidate: ExecutionCandidate) {
  await pool.query(
    `
      INSERT INTO execution_candidates (
        asset, slot_key, scan_sequence, captured_at, expires_at, combination,
        projected_net_profit_usd, gross_cost, signal_age_ms, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (asset) DO UPDATE SET
        slot_key = EXCLUDED.slot_key,
        scan_sequence = EXCLUDED.scan_sequence,
        captured_at = EXCLUDED.captured_at,
        expires_at = EXCLUDED.expires_at,
        combination = EXCLUDED.combination,
        projected_net_profit_usd = EXCLUDED.projected_net_profit_usd,
        gross_cost = EXCLUDED.gross_cost,
        signal_age_ms = EXCLUDED.signal_age_ms,
        updated_at = EXCLUDED.updated_at
    `,
    [
      candidate.asset,
      candidate.slotKey,
      candidate.scanSequence,
      candidate.capturedAt,
      candidate.expiresAt,
      candidate.combination,
      candidate.projectedNetProfitUsd,
      candidate.grossCost,
      candidate.signalAgeMs,
      candidate.updatedAt,
    ],
  );
}

export async function listExecutionCandidates(pool: Pool, now = Date.now()): Promise<ExecutionCandidate[]> {
  const result = await pool.query<{
    asset: MarketAsset;
    slot_key: string;
    scan_sequence: number;
    captured_at: number;
    expires_at: number;
    combination: ExecutionCandidate["combination"];
    projected_net_profit_usd: number;
    gross_cost: number;
    signal_age_ms: number;
    updated_at: number;
  }>(
    `
      SELECT asset, slot_key, scan_sequence, captured_at, expires_at, combination,
        projected_net_profit_usd, gross_cost, signal_age_ms, updated_at
      FROM execution_candidates
      WHERE expires_at >= $1
      ORDER BY projected_net_profit_usd DESC, captured_at DESC
    `,
    [now],
  );

  return result.rows.map((row) => ({
    asset: row.asset,
    slotKey: row.slot_key,
    scanSequence: row.scan_sequence,
    capturedAt: row.captured_at,
    expiresAt: row.expires_at,
    combination: row.combination,
    projectedNetProfitUsd: Number(row.projected_net_profit_usd),
    grossCost: Number(row.gross_cost),
    signalAgeMs: row.signal_age_ms,
    updatedAt: row.updated_at,
  }));
}

export async function tryWithGlobalLiveExecutionLock<T>(
  pool: Pool,
  owner: string,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false; value: null }> {
  const client = await pool.connect();
  let acquired = false;
  try {
    const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS locked", [
      LIVE_EXECUTION_LOCK_NAMESPACE,
      LIVE_EXECUTION_LOCK_KEY,
    ]);
    acquired = Boolean(result.rows[0]?.locked);
    if (!acquired) {
      return { acquired: false, value: null };
    }

    void owner;
    return { acquired: true, value: await fn() };
  } finally {
    if (acquired) {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [LIVE_EXECUTION_LOCK_NAMESPACE, LIVE_EXECUTION_LOCK_KEY]);
    }
    client.release();
  }
}

const CIRCUIT_BREAKER_READINESS_KEYS = new Set([
  "circuit-breaker",
  "circuit-breaker-cooldown",
  "circuit-breaker-degraded",
]);

function reconcileCircuitBreakerReadiness(
  workerState: WorkerState,
  relevantBreakers: CircuitBreaker[],
  now: number,
): WorkerState {
  const nonBreakerReadiness = workerState.readiness.filter((check) => !CIRCUIT_BREAKER_READINESS_KEYS.has(check.key));
  const readiness = [
    ...nonBreakerReadiness,
    ...buildCircuitBreakerReadinessChecks(
      relevantBreakers.filter((breaker) => breaker.active),
      now,
    ),
  ];

  return {
    ...workerState,
    readiness,
    readinessStatus: deriveReadinessStatus(readiness),
  };
}

function buildCircuitBreakerReadinessChecks(activeBreakers: CircuitBreaker[], now: number): ReadinessCheck[] {
  const blockingBreakers = activeBreakers.filter(
    (breaker) => getCircuitBreakerReadinessStatus(breaker, now) === "blocked",
  );
  const cooldownBreakers = activeBreakers.filter(
    (breaker) => getCircuitBreakerReadinessStatus(breaker, now) === "cooldown",
  );
  const degradedBreakers = activeBreakers.filter(
    (breaker) => getCircuitBreakerReadinessStatus(breaker, now) === "degraded",
  );
  const checks: ReadinessCheck[] = [];

  if (blockingBreakers.length > 0) {
    checks.push({
      key: "circuit-breaker",
      label: "Circuit breaker",
      status: "blocked",
      details: blockingBreakers.map((breaker) => `${breaker.key}:${breaker.reason}`).join(" | "),
      checkedAt: now,
    });
  }
  if (cooldownBreakers.length > 0) {
    checks.push({
      key: "circuit-breaker-cooldown",
      label: "Circuit breaker cooldown",
      status: "cooldown",
      details: cooldownBreakers.map((breaker) => describeCircuitBreakerForReadiness(breaker, now)).join(" | "),
      checkedAt: now,
    });
  }
  if (degradedBreakers.length > 0) {
    checks.push({
      key: "circuit-breaker-degraded",
      label: "Circuit breaker degraded",
      status: "degraded",
      details: degradedBreakers.map((breaker) => `${breaker.key}:${breaker.reason}`).join(" | "),
      checkedAt: now,
    });
  }

  return checks;
}

function deriveReadinessStatus(readiness: ReadinessCheck[]): WorkerState["readinessStatus"] {
  if (readiness.some((check) => check.status === "blocked")) {
    return "blocked";
  }
  if (readiness.some((check) => check.status === "cooldown")) {
    return "cooldown";
  }
  if (readiness.some((check) => check.status === "degraded")) {
    return "degraded";
  }
  return "ready";
}

function getCircuitBreakerReadinessStatus(
  breaker: Pick<CircuitBreaker, "active" | "key" | "payload" | "reason">,
  now: number,
): WorkerState["readinessStatus"] {
  if (!breaker.active) {
    return "ready";
  }

  const cooldownUntil = getPayloadNumber(breaker.payload, "cooldownUntil");
  if (isSlotExecutionBreakerReason(breaker.reason)) {
    if (getPayloadBoolean(breaker.payload, "requiresManualClear")) {
      return "blocked";
    }
    if (cooldownUntil !== null && now < cooldownUntil) {
      return "cooldown";
    }
    if (breaker.key === "global") {
      return "blocked";
    }
    return "degraded";
  }

  if (cooldownUntil !== null && now < cooldownUntil) {
    return "cooldown";
  }

  return "blocked";
}

function isSlotExecutionBreakerReason(reason: CircuitBreaker["reason"]): reason is "hedge_failure" | "primary_no_fill" {
  return reason === "hedge_failure" || reason === "primary_no_fill";
}

function describeCircuitBreakerForReadiness(breaker: Pick<CircuitBreaker, "key" | "payload" | "reason">, now: number) {
  const cooldownUntil = getPayloadNumber(breaker.payload, "cooldownUntil");
  const remainingMs = cooldownUntil === null ? null : Math.max(0, cooldownUntil - now);
  return remainingMs === null
    ? `${breaker.key}:${breaker.reason}`
    : `${breaker.key}:${breaker.reason}:retry_in=${remainingMs}ms`;
}

function getPayloadBoolean(payload: Record<string, unknown> | null, key: string) {
  return payload?.[key] === true;
}

function getPayloadNumber(payload: Record<string, unknown> | null, key: string) {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function buildFillQualitySummary(
  pool: Pool,
  now: number,
  breakers: CircuitBreaker[],
): Promise<FillQualitySummary> {
  const since = now - 24 * 60 * 60 * 1000;
  const events = await listRecentMarketFillQualityEvents(pool, since);
  const blacklisted = breakers
    .filter((breaker) => breaker.active && breaker.reason === "market_degraded")
    .map((breaker) => {
      const scope = parseBreakerScope(breaker.key);
      return {
        key: breaker.key,
        asset: scope.asset,
        slotKey: scope.slotKey,
        until: getPayloadNumber(breaker.payload, "cooldownUntil"),
        reason: breaker.reason,
      };
    });

  return {
    last24h: summarizeFillQualityEvents(events),
    perAsset: MARKET_ASSETS.map((asset) => ({
      asset,
      bucket: summarizeFillQualityEvents(events.filter((event) => event.asset === asset)),
    })),
    blacklisted,
  };
}

function parseBreakerScope(key: CircuitBreaker["key"]) {
  if (key === "global") {
    return { asset: null, slotKey: null };
  }
  if (key.startsWith("asset:")) {
    return { asset: key.slice("asset:".length) as MarketAsset, slotKey: null };
  }
  if (key.startsWith("slot:")) {
    const rest = key.slice("slot:".length);
    const [asset] = rest.split(":");
    return { asset: asset as MarketAsset, slotKey: rest };
  }
  return { asset: null, slotKey: null };
}

function summarizeFillQualityEvents(events: MarketFillQualityEvent[]) {
  const attempts = events.length;
  const count = (outcome: MarketFillQualityOutcome) => events.filter((event) => event.outcome === outcome).length;
  const fullFills = count("full_fill");
  const partialFills = count("partial_fill");
  const noFills = count("no_fill");
  const rescues = count("rescue");
  const unwinds = count("unwind");
  const manualRequired = count("manual_required");
  const slippageSamples = events
    .map((event) => event.slippageBps)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  return {
    attempts,
    fullFills,
    partialFills,
    noFills,
    rescues,
    unwinds,
    manualRequired,
    fullRate: attempts > 0 ? fullFills / attempts : 0,
    partialRate: attempts > 0 ? partialFills / attempts : 0,
    noFillRate: attempts > 0 ? noFills / attempts : 0,
    rescueRate: attempts > 0 ? rescues / attempts : 0,
    avgSlippageBps:
      slippageSamples.length > 0
        ? slippageSamples.reduce((sum, value) => sum + value, 0) / slippageSamples.length
        : null,
  };
}

export async function buildDashboardResponse(pool: Pool, slot: MarketSlot): Promise<DashboardResponse> {
  const now = Date.now();
  const latestSnapshot = await getLatestOpportunitySnapshot(pool, slot.asset, slot.key);
  const allBreakers = await listCircuitBreakers(pool);
  const assetBreakerKey = `asset:${slot.asset}`;
  const slotBreakerKey = `slot:${slot.key}`;
  const relevantBreakers = allBreakers.filter(
    (breaker) =>
      breaker.key === "global" ||
      breaker.key === assetBreakerKey ||
      breaker.key === slotBreakerKey ||
      getBreakerAsset(breaker.key) === slot.asset,
  );
  const pnl = await getLatestPnlSnapshot(pool);
  const [baselineEquityUsd, peakEquityUsd] = pnl
    ? await Promise.all([getFirstTrackedEquityUsd(pool), getPeakTrackedEquityUsd(pool)])
    : [null, null];
  const workerState = await getWorkerState(pool, slot.asset);
  return {
    fetchedAt: Date.now(),
    slot,
    config: await getStrategyConfig(pool, slot.asset),
    workerState: reconcileCircuitBreakerReadiness(workerState, relevantBreakers, Date.now()),
    latestSnapshot,
    feedHealth: latestSnapshot ? [latestSnapshot.polymarket.feedHealth, latestSnapshot.kalshi.feedHealth] : [],
    opportunities: latestSnapshot?.opportunities ?? [],
    venueBalances: await listVenueBalances(pool),
    openIntents: await listOpenOrderIntents(pool, slot.asset),
    recentOrders: await listRecentVenueOrders(pool, 20, slot.asset),
    recentFills: await listRecentFills(pool, 20, slot.asset),
    positions: await listPositions(pool, slot.asset),
    pnl: pnl ? enrichPnlSnapshot(pnl, baselineEquityUsd, peakEquityUsd) : null,
    stablePnlChanges: await listStablePnlChanges(pool, 5, slot.asset),
    fillQuality: await buildFillQualitySummary(pool, now, allBreakers),
    bridgeTransfers: await listRecentBridgeTransfers(pool, 5),
    circuitBreakers: relevantBreakers,
    runEvents: await listRecentRunEvents(pool, 10, slot.asset),
  };
}

export async function buildPortfolioDashboardResponse(
  pool: Pool,
  slots: MarketSlot[],
): Promise<PortfolioDashboardResponse> {
  const pnl = await getLatestPnlSnapshot(pool);
  const [baselineEquityUsd, peakEquityUsd] = pnl
    ? await Promise.all([getFirstTrackedEquityUsd(pool), getPeakTrackedEquityUsd(pool)])
    : [null, null];
  const [configs, workerStates, breakers, venueBalances, positions, openIntents] = await Promise.all([
    listStrategyConfigs(pool),
    listWorkerStates(pool),
    listCircuitBreakers(pool),
    listVenueBalances(pool),
    listPositions(pool),
    listOpenOrderIntents(pool),
  ]);
  const snapshots = await Promise.all(slots.map((slot) => getLatestOpportunitySnapshot(pool, slot.asset, slot.key)));
  const now = Date.now();
  const fillQuality = await buildFillQualitySummary(pool, now, breakers);

  return {
    fetchedAt: now,
    assets: slots.map((slot, index) => {
      const latestSnapshot = snapshots[index];
      const assetBreakerKey = `asset:${slot.asset}`;
      const slotBreakerKey = `slot:${slot.key}`;
      const relevantBreakers = breakers.filter(
        (breaker) =>
          breaker.key === "global" ||
          breaker.key === assetBreakerKey ||
          breaker.key === slotBreakerKey ||
          getBreakerAsset(breaker.key) === slot.asset,
      );
      return {
        asset: slot.asset,
        slot,
        config: configs[slot.asset],
        workerState: reconcileCircuitBreakerReadiness(workerStates[slot.asset], relevantBreakers, now),
        latestSnapshot,
        bestOpportunity:
          latestSnapshot?.opportunities
            ?.filter((opportunity: LiveOpportunity) => opportunity.grossCost !== null)
            .sort(
              (left: LiveOpportunity, right: LiveOpportunity) =>
                (left.grossCost ?? Number.POSITIVE_INFINITY) - (right.grossCost ?? Number.POSITIVE_INFINITY),
            )[0] ?? null,
        feedHealth: latestSnapshot ? [latestSnapshot.polymarket.feedHealth, latestSnapshot.kalshi.feedHealth] : [],
        activeBreakers: relevantBreakers.filter((breaker) => breaker.active),
      };
    }),
    openPositionsCount: positions.filter(isRiskActivePosition).length,
    venueBalances,
    pnl: pnl ? enrichPnlSnapshot(pnl, baselineEquityUsd, peakEquityUsd) : null,
    stablePnlChanges: await listStablePnlChanges(pool, 25),
    fillQuality,
    activeBreakers: breakers.filter((breaker) => breaker.active),
    manualRequiredIntents: openIntents.filter(
      (intent) => intent.status === "manual_required" || intent.status === "unwind_required",
    ),
  };
}

export async function buildTradesResponse(pool: Pool, asset: MarketAsset | "all" = "all"): Promise<TradesResponse> {
  const intents = await listRecentOrderIntents(pool, 100, asset === "all" ? undefined : asset);
  const intentIds = intents.map((intent) => intent.id);

  return {
    fetchedAt: Date.now(),
    asset,
    intents,
    orders: await listVenueOrdersForIntentIds(pool, intentIds),
    fills: await listFillsForIntentIds(pool, intentIds),
  };
}

export async function buildHistoryPoints(pool: Pool, slot: MarketSlot): Promise<HistoryPoint[]> {
  const snapshots = await getOpportunitySnapshotsForSlot(pool, slot.asset, slot.key);

  return snapshots.map((snapshot) => {
    const first = snapshot.opportunities[0];
    const second = snapshot.opportunities[1];

    return {
      ts: snapshot.capturedAt,
      polyUpBuy: snapshot.polymarket.outcomes.up.chart.price,
      polyDownBuy: snapshot.polymarket.outcomes.down.chart.price,
      kalshiYesLast: snapshot.kalshi.outcomes.yes.chart.price,
      kalshiNoLast: snapshot.kalshi.outcomes.no.chart.price,
      grossCostUpNo: first?.combination === "POLY_UP_KALSHI_NO" ? first.grossCost : (second?.grossCost ?? null),
      grossCostDownYes: first?.combination === "POLY_DOWN_KALSHI_YES" ? first.grossCost : (second?.grossCost ?? null),
    };
  });
}

function mapOpportunitySnapshotRow(row: OpportunitySnapshotRow): OpportunitySnapshot {
  return {
    id: row.id,
    asset: row.asset,
    slotKey: row.slot_key,
    slotStartTs: row.slot_start_ts,
    slotEndTs: row.slot_end_ts,
    capturedAt: row.captured_at,
    polymarket: row.polymarket_json,
    kalshi: row.kalshi_json,
    opportunities: row.opportunities_json ?? [],
  };
}

function mapSlotResolutionRow(row: SlotResolutionRow): SlotResolutionRecord {
  return {
    asset: row.asset,
    slotKey: row.slot_key,
    slotStartTs: row.slot_start_ts,
    slotEndTs: row.slot_end_ts,
    polymarketSlug: row.polymarket_slug,
    polymarketMarketRef: row.polymarket_market_ref,
    kalshiMarketRef: row.kalshi_market_ref,
    polymarketResolution: row.polymarket_resolution,
    kalshiResolution: row.kalshi_resolution,
    polymarketSettlementValueUsd: row.polymarket_settlement_value_usd,
    kalshiSettlementValueUsd: row.kalshi_settlement_value_usd,
    firstObservedAt: row.first_observed_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    source: row.source,
    raw: row.raw_json ?? {},
  };
}

function mapOrderIntentRow(row: OrderIntentRow): OrderIntent {
  return {
    id: row.id,
    asset: row.asset,
    shadow: row.shadow,
    slotKey: row.slot_key,
    slotStartTs: row.slot_start_ts,
    slotEndTs: row.slot_end_ts,
    combination: row.combination,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    primaryVenue: row.primary_venue,
    hedgeVenue: row.hedge_venue,
    grossCost: row.gross_cost,
    targetNotionalUsd: row.target_notional_usd,
    entrySizingReason: row.entry_sizing_reason ?? null,
    maxSlippageBps: row.max_slippage_bps,
    failureReason: row.failure_reason,
    projectedNetProfitUsd: row.projected_net_profit_usd,
    mismatchPFatal: row.mismatch_p_fatal ?? null,
    mismatchPFatalUpper: row.mismatch_p_fatal_upper ?? null,
    mismatchModelVersion: row.mismatch_model_version ?? null,
    fatalMismatchPnlUsd: row.fatal_mismatch_pnl_usd ?? null,
    conservativeExpectedPnlUsd: row.conservative_expected_pnl_usd ?? null,
    fatalLossExposureUsd: row.fatal_loss_exposure_usd ?? null,
    mismatchRiskAudit: row.mismatch_risk_audit_json ?? null,
    shadowExecution: row.shadow_execution_json ?? null,
    realizedPnlUsd: row.realized_pnl_usd,
    roi: row.roi,
    polyResolution: row.poly_resolution,
    kalshiResolution: row.kalshi_resolution,
    legs: row.legs_json,
  };
}

function mapVenueOrderRow(row: VenueOrderRow): LiveOrder {
  return {
    id: row.id,
    asset: row.asset,
    shadow: row.shadow,
    intentId: row.intent_id,
    venue: row.venue,
    venueOrderId: row.venue_order_id,
    clientOrderId: row.client_order_id,
    marketRef: row.market_ref,
    tokenId: row.token_id ?? undefined,
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
    raw: row.raw_json ?? {},
  };
}

function mapOrderAttemptRow(row: OrderAttemptRow): OrderAttempt {
  return {
    id: row.id,
    asset: row.asset,
    shadow: row.shadow,
    intentId: row.intent_id,
    legId: row.leg_id,
    stage: row.stage,
    venue: row.venue,
    side: row.side,
    orderType: row.order_type,
    clientOrderId: row.client_order_id,
    venueOrderId: row.venue_order_id,
    status: row.status,
    truthStatus: row.truth_status,
    request: row.request_json ?? {},
    result: row.result_json ?? null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFillRow(row: FillRow): LiveFill {
  return {
    id: row.id,
    asset: row.asset,
    shadow: row.shadow,
    intentId: row.intent_id,
    venue: row.venue,
    venueOrderId: row.venue_order_id,
    tradeId: row.trade_id,
    marketRef: row.market_ref,
    tokenId: row.token_id ?? undefined,
    side: row.side,
    outcome: row.outcome,
    price: row.price,
    size: row.size,
    feeUsd: row.fee_usd,
    liquidity: row.liquidity,
    filledAt: row.filled_at,
    raw: row.raw_json ?? {},
  };
}

function mapPositionRow(row: PositionRow): PositionSnapshot {
  return {
    id: row.id,
    asset: row.asset,
    venue: row.venue,
    marketRef: row.market_ref,
    outcome: row.outcome,
    size: row.size,
    averagePrice: row.average_price,
    currentPrice: row.current_price,
    currentValueUsd: row.current_value_usd,
    realizedPnlUsd: row.realized_pnl_usd,
    unrealizedPnlUsd: row.unrealized_pnl_usd,
    redeemable: row.redeemable,
    mergeable: row.mergeable,
    updatedAt: row.updated_at,
    raw: row.raw_json ?? {},
  };
}

function mapPnlSnapshotRow(row: PnlSnapshotRow): PnlSnapshot {
  return enrichPnlSnapshot({
    id: row.id,
    capturedAt: row.captured_at,
    equityUsd: row.equity_usd,
    cashUsd: row.cash_usd,
    positionsValueUsd: row.positions_value_usd,
    realizedPnlUsd: row.realized_pnl_usd,
    unrealizedPnlUsd: row.unrealized_pnl_usd,
    feesUsd: row.fees_usd,
    venueBreakdown: row.venue_breakdown_json,
  });
}

function mapStablePnlChangeRow(row: StablePnlChangeRow): StablePnlChange {
  return {
    intentId: row.intent_id,
    asset: row.asset,
    combination: row.combination,
    changedAt: row.changed_at,
    realizedPnlUsd: Number(row.realized_pnl_usd),
    equityUsd: Number(row.equity_usd),
    cashUsd: Number(row.cash_usd),
    positionsValueUsd: Number(row.positions_value_usd),
    strategyPnlUsd: Number(row.strategy_pnl_usd),
    accountDeltaUsd: Number(row.account_delta_usd),
    baselineEquityUsd:
      row.baseline_equity_usd === null || row.baseline_equity_usd === undefined
        ? null
        : Number(row.baseline_equity_usd),
    peakEquityUsd:
      row.peak_equity_usd === null || row.peak_equity_usd === undefined ? null : Number(row.peak_equity_usd),
    drawdownUsd: Number(row.drawdown_usd),
    roi: row.roi === null || row.roi === undefined ? null : Number(row.roi),
    targetNotionalUsd: Number(row.target_notional_usd),
    stability: row.stability_json ?? {},
  };
}

function mapMarketFillQualityEventRow(row: MarketFillQualityEventRow): MarketFillQualityEvent {
  return {
    id: row.id,
    asset: row.asset,
    slotKey: row.slot_key,
    intentId: row.intent_id,
    combination: row.combination,
    primaryVenue: row.primary_venue,
    hedgeVenue: row.hedge_venue,
    outcome: row.outcome,
    stage: row.stage,
    slippageBps: row.slippage_bps === null || row.slippage_bps === undefined ? null : Number(row.slippage_bps),
    payload: row.payload_json ?? {},
    createdAt: row.created_at,
  };
}

function getBreakerAsset(key: CircuitBreaker["key"]): MarketAsset | null {
  if (key.startsWith("asset:")) {
    const asset = key.slice("asset:".length);
    return MARKET_ASSETS.includes(asset as MarketAsset) ? (asset as MarketAsset) : null;
  }

  if (key.startsWith("slot:")) {
    const asset = key.slice("slot:".length).split(":")[0];
    return MARKET_ASSETS.includes(asset as MarketAsset) ? (asset as MarketAsset) : null;
  }

  return null;
}

function mapBridgeTransferRow(row: BridgeTransferRow): BridgeTransfer {
  return {
    id: row.id,
    venue: row.venue,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    quoteId: row.quote_id,
    sourceChain: row.source_chain,
    sourceAsset: row.source_asset,
    targetAsset: row.target_asset,
    amountInUsd: row.amount_in_usd,
    amountOutUsd: row.amount_out_usd,
    txHash: row.tx_hash,
    depositAddresses: row.deposit_addresses_json,
    raw: row.raw_json ?? {},
  };
}

async function deleteBefore(pool: Pool, retentionMs: number | null, now: number, sql: string) {
  if (retentionMs === null) {
    return 0;
  }

  const cutoff = now - retentionMs;
  const result = await pool.query(sql, [cutoff]);
  return result.rowCount ?? 0;
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
