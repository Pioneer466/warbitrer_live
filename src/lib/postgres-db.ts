import { createHash } from "node:crypto";

import { Pool, PoolClient, types } from "pg";

import {
  assertDatabaseSchemaCompatible,
  getDatabaseMigrationStatus,
  runDatabaseMigrations,
  type DatabaseMigration,
  type PgQueryable,
} from "@/lib/db-migrations";
import { MARKET_ASSETS } from "@/lib/market-catalog";
import {
  calculateAccountingLedger,
  calculateAccountingLedgerDelta,
  type AccountingFillEvidence,
  type AccountingLedgerInput,
  type AccountingLedgerProjection,
} from "@/lib/accounting-ledger";
import { createExecutionIncident } from "@/lib/circuit-breaker-incidents";
import type { DatabaseMaintenanceConfig } from "@/lib/db-maintenance";
import { enrichPnlSnapshot } from "@/lib/pnl";
import { isRiskActivePosition } from "@/lib/positions";
import { evaluateReentryPolicy, SHADOW_REENTRY_COOLDOWN_MS } from "@/lib/entry-admission-policy";
import {
  evaluateOperatorAcknowledge,
  evaluateOwnerAutoResolve,
  getCircuitBreakerScopeKey,
  isManualKillIncident,
  type CircuitBreakerExposure,
  type CircuitBreakerImpact,
  type CircuitBreakerIncident,
  type CircuitBreakerRecoveryProof,
  type CircuitBreakerResolutionPolicy,
  type CircuitBreakerScope,
} from "@/lib/circuit-breaker-policy";
import { normalizeSettings, normalizeSettingsMap } from "@/lib/settings-schema";
import { normalizeGlobalRiskConfig, type GlobalRiskConfig } from "@/lib/risk-settings";
import {
  evaluateMismatchCalibrationActivationEligibility,
  verifyMismatchCalibrationArtifact,
} from "@/lib/mismatch-calibration";
import { SLOT_RESOLUTION_RETENTION_MS, type OracleSlotSample, type SlotResolutionRecord } from "@/lib/oracle-history";
import type {
  MarketAsset,
  AccountingBacklogSummary,
  AccountingFillIngestionDecision,
  AccountingHead,
  AccountingHeadState,
  AccountingMutationContext,
  AccountingMutationOperation,
  AccountingMutationResult,
  AccountingQuarantineReason,
  DatabaseMaintenanceSummary,
  DatabaseMetrics,
  BridgeTransfer,
  AcknowledgeCircuitBreakerIncidentInput,
  CircuitBreaker,
  CircuitBreakerMutationContext,
  ConfigurationMutationContext,
  ConfigurationRevisionConflict,
  DashboardResponse,
  ExecutionCandidate,
  EntryAdmission,
  EntryAdmissionDecision,
  EntryAdmissionMode,
  EntryReservation,
  PortfolioDashboardResponse,
  HistoryPoint,
  LiveFill,
  LiveEntryAdmissionInput,
  LiveOrderAttemptClaimInput,
  LiveOrderAttemptDispatchDecision,
  LiveOrderAttemptDispatchInput,
  LiveOrderAttemptSubmissionDecision,
  LiveOrderAttemptSubmissionInput,
  LiveOpportunity,
  LiveOrder,
  MarketSlot,
  MarketFillQualityEvent,
  MarketFillQualityOutcome,
  NotificationDelivery,
  ObserveCircuitBreakerIncidentInput,
  OrderAttempt,
  OrderIntent,
  OpportunitySnapshot,
  PairCombination,
  PnlSnapshot,
  FillQualitySummary,
  PositionSnapshot,
  ReadinessCheck,
  Resolution,
  RecordCircuitBreakerExposureRecoveryInput,
  ResolveOwnedCircuitBreakerIncidentInput,
  RunEvent,
  ShadowEntryAdmissionInput,
  StablePnlChange,
  StrategyConfig,
  StrategyConfigMap,
  StrategyConfigMapUpdate,
  StrategyConfigUpdate,
  TradesResponse,
  Venue,
  VenueBalance,
  VenueCashAdjustmentObservation,
  WorkerLoopHealth,
  WorkerState,
  VersionedConfiguration,
  VersionedStrategyConfig,
  VersionedStrategyConfigMap,
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
  revision: number;
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
  request_sha256: string | null;
  submission_deadline_at: number | null;
  result_json: Record<string, unknown> | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  revision: number;
};

type EntryReservationRow = {
  scope_key: string;
  mode: EntryAdmissionMode;
  asset: MarketAsset | null;
  owner_intent_id: string | null;
  reserved_at: number | null;
  revision: number;
};

type EntryAdmissionRow = {
  id: string;
  admission_sequence: number;
  intent_id: string;
  attempt_id: string | null;
  mode: EntryAdmissionMode;
  asset: MarketAsset;
  slot_key: string;
  combination: PairCombination;
  gross_cost: number;
  request_sha256: string | null;
  strategy_revision: number;
  global_risk_revision: number;
  mismatch_calibration_artifact_id: string | null;
  mismatch_calibration_revision: number;
  policy_evaluated_at: number;
  cutoff_at: number | null;
  latest_submission_start_at: number | null;
  evidence_json: Record<string, unknown> | null;
  authorized_at: number;
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

type AccountingHeadRow = {
  intent_id: string;
  state: AccountingHeadState;
  current_version: number | null;
  current_proof_sha256: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
};

type AccountingFillFactRow = {
  fill_id: string;
  intent_id: string;
  leg_id: string;
  asset: MarketAsset;
  shadow: boolean;
  venue: Venue;
  venue_order_id: string;
  trade_id: string;
  market_ref: string;
  token_id: string | null;
  side: LiveFill["side"];
  outcome: LiveFill["outcome"];
  price_units: string;
  size_units: string;
  initial_fee_units: string;
  fee_units: string;
  initial_finality: AccountingFillEvidence["finality"];
  current_finality: AccountingFillEvidence["finality"];
  filled_at: number;
  fact_sha256: string;
  recorded_at: number;
};

type AccountingMutationRequestRow = {
  request_id: string;
  intent_id: string;
  operation: AccountingMutationOperation;
  request_sha256: string;
  expected_head_revision: number;
  result_json: Record<string, unknown>;
  recorded_at: number;
};

type AccountingVersionRow = {
  intent_id: string;
  version: number;
  previous_version: number | null;
  request_id: string;
  evidence_sha256: string;
  proof_sha256: string;
  captured_at: number;
  recorded_at: number;
  cost_basis_units: string;
  payout_units: string;
  fee_units: string;
  realized_pnl_units: string;
  roi_units: string | null;
  evidence_json: Record<string, unknown>;
  proof_json: Record<string, unknown>;
};

type AccountingQuarantineRow = {
  id: number;
  intent_id: string;
  reason: AccountingQuarantineReason;
  request_id: string;
  payload_sha256: string;
  payload_json: Record<string, unknown>;
  head_revision: number;
  occurred_at: number;
  recorded_at: number;
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

type StrategyConfigRow = {
  asset: MarketAsset;
  payload: Partial<StrategyConfig>;
  revision: number;
  updated_at: number;
};

type GlobalRiskConfigRow = {
  payload: Partial<GlobalRiskConfig>;
  revision: number;
  updated_at: number;
};

export type EntryExecutionProbeRecord = {
  probeKey: string;
  asset: MarketAsset;
  slotKey: string;
  slotStartTs: number;
  slotEndTs: number;
  combination: PairCombination;
  probeKind: "candidate_preflight" | "late_probe";
  targetSecondsRemaining: 55 | 45 | 35 | 25 | 15 | 5 | null;
  signalCapturedAt: number;
  restStartedAt: number;
  restCapturedAt: number;
  decision: string;
  firstRejectionStage: "signal" | "base" | "rest" | "risk" | "admission" | "primary" | "hedge" | "settled" | null;
  firstRejectionCode: string | null;
  strategyRevision: number;
  globalRiskRevision: number;
  signal: Record<string, unknown>;
  rest: Record<string, unknown>;
  risk: Record<string, unknown>;
  variants: Array<Record<string, unknown>>;
  evidenceSha256?: string;
  recordedAt: number;
};

export type MismatchCalibrationArtifactRecord = {
  id: string;
  schemaVersion: number;
  baseModelVersion: string;
  trainingStartedAt: number;
  trainingEndedAt: number;
  artifact: Record<string, unknown>;
  metrics: Record<string, unknown>;
  artifactSha256?: string;
  createdAt: number;
};

export type MismatchCalibrationActivation = {
  artifact: MismatchCalibrationArtifactRecord | null;
  revision: number;
  updatedAt: number;
};

export type MismatchCalibrationActivationRequest = {
  artifactId: string | null;
  expectedRevision: number;
  requestId: string;
  actor: string;
  reason: string;
  occurredAt: number;
};

type EntryExecutionProbeRow = {
  probe_key: string;
  asset: MarketAsset;
  slot_key: string;
  slot_start_ts: number;
  slot_end_ts: number;
  combination: PairCombination;
  probe_kind: EntryExecutionProbeRecord["probeKind"];
  target_seconds_remaining: EntryExecutionProbeRecord["targetSecondsRemaining"];
  signal_captured_at: number;
  rest_started_at: number;
  rest_captured_at: number;
  decision: string;
  first_rejection_stage: EntryExecutionProbeRecord["firstRejectionStage"];
  first_rejection_code: string | null;
  strategy_revision: number;
  global_risk_revision: number;
  signal_json: Record<string, unknown>;
  rest_json: Record<string, unknown>;
  risk_json: Record<string, unknown>;
  variants_json: Array<Record<string, unknown>>;
  evidence_sha256: string;
  recorded_at: number;
};

type MismatchCalibrationArtifactRow = {
  id: string;
  schema_version: number;
  base_model_version: string;
  training_started_at: number;
  training_ended_at: number;
  artifact_json: Record<string, unknown>;
  metrics_json: Record<string, unknown>;
  artifact_sha256: string;
  created_at: number;
};

type CircuitBreakerIncidentCurrentRow = {
  id: string;
  scope_key: string;
  scope_type: "global" | "asset" | "slot";
  asset: MarketAsset | null;
  slot_key: string | null;
  owner: string;
  incident_key: string;
  reason: string;
  impact: CircuitBreakerImpact;
  resolution_policy: CircuitBreakerResolutionPolicy;
  intent_id: string | null;
  triggered_at: number;
  initial_exposure_json: CircuitBreakerExposure;
  initial_payload_json: Record<string, unknown> | null;
  revision: number;
  event_type: CircuitBreakerIncidentEventType;
  status: "open" | "resolved";
  actor: string;
  request_id: string;
  request_sha256: string;
  occurred_at: number;
  recorded_at: number;
  last_observed_at: number;
  cooldown_until: number | null;
  acknowledged_at: number | null;
  resolved_at: number | null;
  exposure_json: CircuitBreakerExposure;
  payload_json: Record<string, unknown> | null;
};

type CircuitBreakerIncidentEventType = "observed" | "exposure_resolved" | "owner_resolved" | "operator_acknowledged";

type CircuitBreakerScopeRow = {
  scope_key: string;
  scope_type: "global" | "asset" | "slot";
  asset: MarketAsset | null;
  slot_key: string | null;
};

let poolSingleton: Pool | null = null;
let schemaCompatibilityPromise: Promise<void> | null = null;
let poolClosingPromise: Promise<void> | null = null;
let poolShutdownRequested = false;
const LIVE_EXECUTION_LOCK_NAMESPACE = 4_298;
const LIVE_EXECUTION_LOCK_KEY = 2;
const SHADOW_EXECUTION_LOCK_NAMESPACE = 4_299;
const ACCOUNTING_LOCK_NAMESPACE = 4_300;
const ACCOUNTING_LOCK_KEY = 1;

// SHA-256 of the immutable block delimited by migration-checksum markers below.
const LEGACY_SCHEMA_BASELINE_CHECKSUM = "b9059dd24e724ac105f13482bc09495738664645af3b0cc1ade80d66626c1b18";
const ORDER_TRUTH_REVISION_CHECKSUM = "406db20ffc6f352abead966d06d4811b6531771ef6665616fd3c334bb35e8310";
const CONFIGURATION_REVISION_AUDIT_CHECKSUM = "50852234994334108ce1a8ed4808e94fb34417fe94bebe270c732cefe6f76ca1";
const ENTRY_ADMISSION_CHECKSUM = "1bec472547588a9c8399784f26750ed98ef34c0b410e3472bf921da00439a4ab";
const CIRCUIT_BREAKER_INCIDENTS_CHECKSUM = "1b843990961a3a5ce81b9c6051ffaebbe181f9fc0f91283ef3c858712bbdcbbc";
const ORDER_ATTEMPT_SUBMISSION_DEADLINE_CHECKSUM = "fb9086c655b1efe98cb05d0a94c464e5119ad9b308c06a0fcc069e73bc8c4412";
const ACCOUNTING_LEDGER_CHECKSUM = "90f7ef7b35ef7efcb0f895527b752da480b6f7118f9dc91f71d0e68ae5bcf2ce";
const ACCOUNTING_EVIDENCE_HARDENING_CHECKSUM = "1c5e4723bacc609c33da378ac214aca26e2583f68055e4c9443ad3b6c5ea2432";
const INACTIVE_LEGACY_SLOT_BREAKER_REPAIR_CHECKSUM = "dd5f0940e2ad014b4c88878d5720c67cf8a80c6c88ce0eaef7886bb2407beac0";
const MISMATCH_CALIBRATION_EVIDENCE_CHECKSUM = "d165c2d5bf3cbd93ad4d684b90e03ea4cc77409f9d0f163ac0e98912650fa375";

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
  {
    version: 3,
    name: "configuration_revision_audit",
    checksum: CONFIGURATION_REVISION_AUDIT_CHECKSUM,
    up: applyConfigurationRevisionAuditMigration,
  },
  {
    version: 4,
    name: "entry_admission",
    checksum: ENTRY_ADMISSION_CHECKSUM,
    up: applyEntryAdmissionMigration,
  },
  {
    version: 5,
    name: "circuit_breaker_incidents",
    checksum: CIRCUIT_BREAKER_INCIDENTS_CHECKSUM,
    up: applyCircuitBreakerIncidentsMigration,
  },
  {
    version: 6,
    name: "order_attempt_submission_deadline",
    checksum: ORDER_ATTEMPT_SUBMISSION_DEADLINE_CHECKSUM,
    up: applyOrderAttemptSubmissionDeadlineMigration,
  },
  {
    version: 7,
    name: "accounting_ledger",
    checksum: ACCOUNTING_LEDGER_CHECKSUM,
    up: applyAccountingLedgerMigration,
  },
  {
    version: 8,
    name: "accounting_evidence_hardening",
    checksum: ACCOUNTING_EVIDENCE_HARDENING_CHECKSUM,
    up: applyAccountingEvidenceHardeningMigration,
  },
  {
    version: 9,
    name: "inactive_legacy_slot_breaker_repair",
    checksum: INACTIVE_LEGACY_SLOT_BREAKER_REPAIR_CHECKSUM,
    up: applyInactiveLegacySlotBreakerRepairMigration,
  },
  {
    version: 10,
    name: "mismatch_calibration_evidence",
    checksum: MISMATCH_CALIBRATION_EVIDENCE_CHECKSUM,
    up: applyMismatchCalibrationEvidenceMigration,
  },
];

export async function getPgDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL est requis pour utiliser le système live");
  }
  if (poolShutdownRequested) {
    throw new Error("Postgres is closed; no new storage work is accepted");
  }

  if (!poolSingleton) {
    poolSingleton = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: resolvePgPoolMax(),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  const pool = poolSingleton;

  if (!schemaCompatibilityPromise) {
    schemaCompatibilityPromise = assertDatabaseSchemaCompatible(pool, DATABASE_MIGRATIONS)
      .then(() => undefined)
      .catch((error) => {
        schemaCompatibilityPromise = null;
        throw error;
      });
  }

  await schemaCompatibilityPromise;
  if (poolShutdownRequested) {
    throw new Error("Postgres closed while storage initialization was in progress");
  }
  return pool;
}

export async function closePgDb() {
  if (poolClosingPromise) {
    return poolClosingPromise;
  }

  poolShutdownRequested = true;
  const pool = poolSingleton;
  poolSingleton = null;
  schemaCompatibilityPromise = null;
  if (!pool) {
    return;
  }

  const closing = pool.end();
  poolClosingPromise = closing;
  try {
    await closing;
  } finally {
    if (poolClosingPromise === closing) {
      poolClosingPromise = null;
    }
  }
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

/* migration-checksum:start:3 */
const MIGRATION_V3_MARKET_ASSETS = ["btc", "eth", "sol", "xrp", "doge", "bnb", "hype"] as const;

async function applyConfigurationRevisionAuditMigration(db: PgQueryable) {
  await db.query(`
    ALTER TABLE strategy_configs
    ADD COLUMN revision BIGINT NOT NULL DEFAULT 0;

    ALTER TABLE strategy_configs
    ADD CONSTRAINT strategy_configs_revision_nonnegative CHECK (revision >= 0);

    ALTER TABLE strategy_configs
    ADD CONSTRAINT strategy_configs_asset_known CHECK (
      asset IN ('btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'hype')
    );

    ALTER TABLE global_risk_config
    ADD COLUMN revision BIGINT NOT NULL DEFAULT 0;

    ALTER TABLE global_risk_config
    ADD CONSTRAINT global_risk_config_revision_nonnegative CHECK (revision >= 0);

    CREATE TABLE configuration_audit_events (
      id BIGSERIAL PRIMARY KEY,
      configuration_type TEXT NOT NULL CHECK (configuration_type IN ('strategy', 'global_risk')),
      configuration_key TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('update', 'bulk_update')),
      actor TEXT NOT NULL CHECK (length(btrim(actor)) > 0),
      request_id UUID NOT NULL,
      previous_revision BIGINT NOT NULL CHECK (previous_revision >= 0),
      next_revision BIGINT NOT NULL CHECK (next_revision = previous_revision + 1),
      previous_payload JSONB NOT NULL CHECK (jsonb_typeof(previous_payload) = 'object'),
      next_payload JSONB NOT NULL CHECK (jsonb_typeof(next_payload) = 'object'),
      created_at BIGINT NOT NULL,
      CHECK (
        (configuration_type = 'global_risk' AND configuration_key = 'global') OR
        (configuration_type = 'strategy' AND configuration_key IN ('btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'hype'))
      )
    );

    CREATE INDEX configuration_audit_events_key_created_idx
      ON configuration_audit_events(configuration_type, configuration_key, created_at DESC, id DESC);
    CREATE INDEX configuration_audit_events_request_idx
      ON configuration_audit_events(request_id, id ASC);
    CREATE UNIQUE INDEX configuration_audit_events_request_configuration_uidx
      ON configuration_audit_events(request_id, configuration_type, configuration_key);

    CREATE FUNCTION reject_configuration_audit_event_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    BEGIN
      RAISE EXCEPTION 'configuration_audit_events is append-only' USING ERRCODE = '55000';
    END;
    $migration$;

    CREATE TRIGGER configuration_audit_events_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON configuration_audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_configuration_audit_event_mutation();
  `);

  const strategyRows = await db.query<{ asset: string }>("SELECT asset FROM strategy_configs ORDER BY asset ASC");
  const actualAssets = strategyRows.rows.map((row) => row.asset);
  if (
    actualAssets.length !== MIGRATION_V3_MARKET_ASSETS.length ||
    actualAssets.some((asset, index) => asset !== [...MIGRATION_V3_MARKET_ASSETS].sort()[index])
  ) {
    throw new Error(
      `Migration 3 refused: strategy_configs must contain exactly ${MIGRATION_V3_MARKET_ASSETS.join(",")}`,
    );
  }

  const globalRiskRows = await db.query<{ id: number }>("SELECT id FROM global_risk_config ORDER BY id ASC");
  if (globalRiskRows.rows.length !== 1 || Number(globalRiskRows.rows[0]?.id) !== 1) {
    throw new Error("Migration 3 refused: global_risk_config must contain exactly id=1");
  }
}
/* migration-checksum:end:3 */

/* migration-checksum:start:4 */
const MIGRATION_V4_NON_RESERVING_INTENT_STATUSES = [
  "hedged",
  "unwound",
  "settled",
  "failed",
  "skipped",
  "canceled",
] as const;

async function applyEntryAdmissionMigration(db: PgQueryable) {
  const liveConflict = await db.query<{ intent_ids: string[]; conflict_count: number }>(
    `
      SELECT array_agg(id ORDER BY created_at ASC, id ASC) AS intent_ids,
        count(*)::integer AS conflict_count
      FROM order_intents
      WHERE shadow = false
        AND NOT (status = ANY($1::text[]))
      HAVING count(*) > 1
    `,
    [[...MIGRATION_V4_NON_RESERVING_INTENT_STATUSES]],
  );
  if (liveConflict.rows[0]) {
    throw new Error(
      `Migration 4 refused: multiple unresolved live intents (${liveConflict.rows[0].intent_ids.join(",")})`,
    );
  }

  const shadowConflict = await db.query<{ asset: string; intent_ids: string[]; conflict_count: number }>(
    `
      SELECT asset, array_agg(id ORDER BY created_at ASC, id ASC) AS intent_ids,
        count(*)::integer AS conflict_count
      FROM order_intents
      WHERE shadow = true
        AND NOT (status = ANY($1::text[]))
      GROUP BY asset
      HAVING count(*) > 1
      ORDER BY asset ASC
      LIMIT 1
    `,
    [[...MIGRATION_V4_NON_RESERVING_INTENT_STATUSES]],
  );
  if (shadowConflict.rows[0]) {
    const conflict = shadowConflict.rows[0];
    throw new Error(
      `Migration 4 refused: multiple unresolved shadow intents for ${conflict.asset} (${conflict.intent_ids.join(",")})`,
    );
  }

  await db.query(`
    ALTER TABLE order_attempts
    ADD COLUMN request_sha256 TEXT;

    ALTER TABLE order_attempts
    ADD CONSTRAINT order_attempts_request_sha256_valid CHECK (
      request_sha256 IS NULL OR request_sha256 ~ '^[0-9a-f]{64}$'
    );

    CREATE TABLE entry_reservations (
      scope_key TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK (mode IN ('live', 'shadow')),
      asset TEXT,
      owner_intent_id TEXT REFERENCES order_intents(id) ON DELETE SET NULL,
      reserved_at BIGINT CHECK (reserved_at IS NULL OR reserved_at >= 0),
      revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
      CHECK (
        (scope_key = 'live:global' AND mode = 'live' AND asset IS NULL) OR
        (mode = 'shadow' AND asset IN ('btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'hype')
          AND scope_key = 'shadow:' || asset)
      )
    );

    CREATE UNIQUE INDEX entry_reservations_owner_uidx
      ON entry_reservations(owner_intent_id)
      WHERE owner_intent_id IS NOT NULL;

    CREATE TABLE entry_admissions (
      id TEXT PRIMARY KEY,
      admission_sequence BIGSERIAL NOT NULL UNIQUE,
      intent_id TEXT NOT NULL UNIQUE REFERENCES order_intents(id) ON DELETE CASCADE,
      attempt_id TEXT UNIQUE REFERENCES order_attempts(id) ON DELETE RESTRICT,
      mode TEXT NOT NULL CHECK (mode IN ('live', 'shadow')),
      asset TEXT NOT NULL CHECK (asset IN ('btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'hype')),
      slot_key TEXT NOT NULL CHECK (length(btrim(slot_key)) > 0),
      combination TEXT NOT NULL CHECK (
        combination IN ('POLY_UP_KALSHI_NO', 'POLY_DOWN_KALSHI_YES')
      ),
      gross_cost DOUBLE PRECISION NOT NULL CHECK (
        gross_cost >= 0 AND gross_cost < 'Infinity'::double precision
      ),
      request_sha256 TEXT CHECK (
        request_sha256 IS NULL OR request_sha256 ~ '^[0-9a-f]{64}$'
      ),
      strategy_revision BIGINT NOT NULL CHECK (strategy_revision >= 0),
      global_risk_revision BIGINT NOT NULL CHECK (global_risk_revision >= 0),
      policy_evaluated_at BIGINT NOT NULL CHECK (policy_evaluated_at >= 0),
      cutoff_at BIGINT CHECK (cutoff_at IS NULL OR cutoff_at >= 0),
      latest_submission_start_at BIGINT CHECK (
        latest_submission_start_at IS NULL OR latest_submission_start_at >= 0
      ),
      evidence_json JSONB NOT NULL CHECK (jsonb_typeof(evidence_json) = 'object'),
      authorized_at BIGINT NOT NULL CHECK (authorized_at >= policy_evaluated_at),
      CHECK (
        (mode = 'live' AND attempt_id IS NOT NULL AND request_sha256 IS NOT NULL
          AND cutoff_at IS NOT NULL AND latest_submission_start_at IS NOT NULL
          AND authorized_at < latest_submission_start_at
          AND latest_submission_start_at <= cutoff_at) OR
        (mode = 'shadow' AND attempt_id IS NULL AND request_sha256 IS NULL
          AND cutoff_at IS NULL AND latest_submission_start_at IS NULL)
      )
    );

    CREATE INDEX entry_admissions_baseline_idx
      ON entry_admissions(
        mode, asset, slot_key, combination, authorized_at DESC, admission_sequence DESC
      );

    INSERT INTO entry_reservations (scope_key, mode, asset)
    VALUES ('live:global', 'live', NULL);

    INSERT INTO entry_reservations (scope_key, mode, asset)
    VALUES
      ('shadow:btc', 'shadow', 'btc'),
      ('shadow:eth', 'shadow', 'eth'),
      ('shadow:sol', 'shadow', 'sol'),
      ('shadow:xrp', 'shadow', 'xrp'),
      ('shadow:doge', 'shadow', 'doge'),
      ('shadow:bnb', 'shadow', 'bnb'),
      ('shadow:hype', 'shadow', 'hype');

    CREATE FUNCTION reject_order_attempt_request_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    BEGIN
      IF OLD.request_json IS DISTINCT FROM NEW.request_json
        OR OLD.request_sha256 IS DISTINCT FROM NEW.request_sha256 THEN
        RAISE EXCEPTION 'order attempt request proof is immutable' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $migration$;

    CREATE TRIGGER order_attempt_request_immutable
    BEFORE UPDATE ON order_attempts
    FOR EACH ROW EXECUTE FUNCTION reject_order_attempt_request_mutation();

    CREATE FUNCTION reject_entry_admission_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    BEGIN
      RAISE EXCEPTION 'entry admission proof is immutable' USING ERRCODE = '55000';
    END;
    $migration$;

    CREATE TRIGGER entry_admissions_immutable
    BEFORE UPDATE ON entry_admissions
    FOR EACH ROW EXECUTE FUNCTION reject_entry_admission_update();
  `);

  await db.query(
    `
      UPDATE entry_reservations
      SET owner_intent_id = candidate.id,
          reserved_at = candidate.created_at,
          revision = revision + 1
      FROM (
        SELECT id, created_at
        FROM order_intents
        WHERE shadow = false
          AND NOT (status = ANY($1::text[]))
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      ) candidate
      WHERE entry_reservations.scope_key = 'live:global'
    `,
    [[...MIGRATION_V4_NON_RESERVING_INTENT_STATUSES]],
  );

  await db.query(
    `
      UPDATE entry_reservations reservation
      SET owner_intent_id = candidate.id,
          reserved_at = candidate.created_at,
          revision = reservation.revision + 1
      FROM (
        SELECT DISTINCT ON (asset) asset, id, created_at
        FROM order_intents
        WHERE shadow = true
          AND NOT (status = ANY($1::text[]))
        ORDER BY asset ASC, created_at ASC, id ASC
      ) candidate
      WHERE reservation.scope_key = 'shadow:' || candidate.asset
    `,
    [[...MIGRATION_V4_NON_RESERVING_INTENT_STATUSES]],
  );
}
/* migration-checksum:end:4 */

/* migration-checksum:start:5 */
const MIGRATION_V5_MARKET_ASSETS = ["btc", "eth", "sol", "xrp", "doge", "bnb", "hype"] as const;
const MIGRATION_V5_LEGACY_REASONS = [
  "manual",
  "hedge_failure",
  "primary_no_fill",
  "readiness_failed",
  "venue_error",
  "risk_limit",
  "daily_loss_cap",
  "market_degraded",
  "rpc_unhealthy",
] as const;

type MigrationV5LegacyBreakerRow = {
  key: string;
  active: boolean;
  reason: string | null;
  triggered_at: number | null;
  payload_json: unknown;
};

async function applyCircuitBreakerIncidentsMigration(db: PgQueryable) {
  const legacyRows = await db.query<MigrationV5LegacyBreakerRow>(
    "SELECT key, active, reason, triggered_at, payload_json FROM circuit_breakers ORDER BY key ASC",
  );
  const migrationClock = await db.query<{ now_ms: number }>(
    "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms",
  );
  const now = Number(migrationClock.rows[0]?.now_ms);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("Migration 5 refused: PostgreSQL returned an invalid clock");
  }

  await db.query(`
    ALTER TABLE circuit_breakers RENAME TO circuit_breakers_legacy;

    CREATE TABLE circuit_breaker_scopes (
      scope_key TEXT PRIMARY KEY CHECK (length(btrim(scope_key)) > 0),
      scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'asset', 'slot')),
      asset TEXT CHECK (asset IS NULL OR asset IN ('btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'hype')),
      slot_key TEXT,
      created_at BIGINT NOT NULL CHECK (created_at >= 0),
      CHECK (
        (scope_type = 'global' AND scope_key = 'global' AND asset IS NULL AND slot_key IS NULL) OR
        (scope_type = 'asset' AND asset IS NOT NULL AND scope_key = 'asset:' || asset AND slot_key IS NULL) OR
        (scope_type = 'slot' AND asset IS NOT NULL AND slot_key IS NOT NULL
          AND length(btrim(slot_key)) > 0 AND slot_key LIKE asset || ':%'
          AND scope_key = 'slot:' || slot_key)
      )
    );

    CREATE TABLE circuit_breaker_incidents (
      id TEXT PRIMARY KEY CHECK (length(btrim(id)) > 0),
      occurrence_sequence BIGSERIAL NOT NULL UNIQUE,
      scope_key TEXT NOT NULL REFERENCES circuit_breaker_scopes(scope_key) ON DELETE RESTRICT,
      owner TEXT NOT NULL CHECK (length(btrim(owner)) > 0),
      incident_key TEXT NOT NULL CHECK (length(btrim(incident_key)) > 0),
      reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
      impact TEXT NOT NULL CHECK (impact IN ('blocked', 'cooldown', 'degraded')),
      resolution_policy TEXT NOT NULL CHECK (resolution_policy IN ('owner', 'operator')),
      intent_id TEXT,
      triggered_at BIGINT NOT NULL CHECK (triggered_at >= 0),
      initial_exposure_json JSONB NOT NULL CHECK (
        jsonb_typeof(initial_exposure_json) = 'object' AND
        CASE initial_exposure_json ->> 'state'
          WHEN 'none' THEN initial_exposure_json = '{"state":"none"}'::jsonb
          WHEN 'unresolved' THEN initial_exposure_json = '{"state":"unresolved"}'::jsonb
          WHEN 'resolved' THEN
            jsonb_typeof(initial_exposure_json -> 'confirmedBy') = 'string'
            AND length(btrim(initial_exposure_json ->> 'confirmedBy')) > 0
            AND jsonb_typeof(initial_exposure_json -> 'confirmedAt') = 'number'
            AND jsonb_typeof(initial_exposure_json -> 'evidenceId') = 'string'
            AND length(btrim(initial_exposure_json ->> 'evidenceId')) > 0
          ELSE false
        END
      ),
      initial_payload_json JSONB CHECK (
        initial_payload_json IS NULL OR jsonb_typeof(initial_payload_json) = 'object'
      )
    );

    CREATE INDEX circuit_breaker_incidents_identity_idx
      ON circuit_breaker_incidents(scope_key, owner, incident_key, occurrence_sequence DESC);

    CREATE TABLE circuit_breaker_incident_events (
      id BIGSERIAL PRIMARY KEY,
      incident_id TEXT NOT NULL REFERENCES circuit_breaker_incidents(id) ON DELETE RESTRICT,
      revision BIGINT NOT NULL CHECK (revision > 0),
      event_type TEXT NOT NULL CHECK (
        event_type IN ('observed', 'exposure_resolved', 'owner_resolved', 'operator_acknowledged')
      ),
      status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
      actor TEXT NOT NULL CHECK (length(btrim(actor)) > 0),
      request_id TEXT NOT NULL CHECK (length(btrim(request_id)) > 0),
      request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
      occurred_at BIGINT NOT NULL CHECK (occurred_at >= 0),
      recorded_at BIGINT NOT NULL CHECK (recorded_at >= 0),
      last_observed_at BIGINT NOT NULL CHECK (last_observed_at >= 0),
      cooldown_until BIGINT CHECK (cooldown_until IS NULL OR cooldown_until >= 0),
      acknowledged_at BIGINT CHECK (acknowledged_at IS NULL OR acknowledged_at >= 0),
      resolved_at BIGINT CHECK (resolved_at IS NULL OR resolved_at >= 0),
      exposure_json JSONB NOT NULL CHECK (
        jsonb_typeof(exposure_json) = 'object' AND
        CASE exposure_json ->> 'state'
          WHEN 'none' THEN exposure_json = '{"state":"none"}'::jsonb
          WHEN 'unresolved' THEN exposure_json = '{"state":"unresolved"}'::jsonb
          WHEN 'resolved' THEN
            jsonb_typeof(exposure_json -> 'confirmedBy') = 'string'
            AND length(btrim(exposure_json ->> 'confirmedBy')) > 0
            AND jsonb_typeof(exposure_json -> 'confirmedAt') = 'number'
            AND jsonb_typeof(exposure_json -> 'evidenceId') = 'string'
            AND length(btrim(exposure_json ->> 'evidenceId')) > 0
          ELSE false
        END
      ),
      payload_json JSONB CHECK (payload_json IS NULL OR jsonb_typeof(payload_json) = 'object'),
      UNIQUE (incident_id, revision),
      UNIQUE (request_id),
      CHECK (
        (status = 'open' AND resolved_at IS NULL AND acknowledged_at IS NULL
          AND event_type IN ('observed', 'exposure_resolved')) OR
        (status = 'resolved' AND resolved_at IS NOT NULL AND event_type = 'owner_resolved'
          AND acknowledged_at IS NULL) OR
        (status = 'resolved' AND resolved_at IS NOT NULL AND event_type = 'operator_acknowledged'
          AND acknowledged_at IS NOT NULL)
      )
    );

    CREATE INDEX circuit_breaker_incident_events_latest_idx
      ON circuit_breaker_incident_events(incident_id, revision DESC);

    CREATE FUNCTION reject_circuit_breaker_fact_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    BEGIN
      RAISE EXCEPTION 'circuit-breaker facts are append-only' USING ERRCODE = '55000';
    END;
    $migration$;

    CREATE TRIGGER circuit_breaker_scopes_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON circuit_breaker_scopes
    FOR EACH STATEMENT EXECUTE FUNCTION reject_circuit_breaker_fact_mutation();

    CREATE TRIGGER circuit_breaker_incidents_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON circuit_breaker_incidents
    FOR EACH STATEMENT EXECUTE FUNCTION reject_circuit_breaker_fact_mutation();

    CREATE TRIGGER circuit_breaker_incident_events_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON circuit_breaker_incident_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_circuit_breaker_fact_mutation();

    CREATE TRIGGER circuit_breakers_legacy_read_only
    BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON circuit_breakers_legacy
    FOR EACH STATEMENT EXECUTE FUNCTION reject_circuit_breaker_fact_mutation();

    CREATE FUNCTION enforce_circuit_breaker_event_revision()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    DECLARE
      parent_incident circuit_breaker_incidents%ROWTYPE;
      previous_event circuit_breaker_incident_events%ROWTYPE;
      duplicate_open_id TEXT;
      database_now BIGINT;
    BEGIN
      SELECT * INTO parent_incident
      FROM circuit_breaker_incidents
      WHERE id = NEW.incident_id
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'circuit-breaker incident % is missing', NEW.incident_id USING ERRCODE = '23503';
      END IF;

      PERFORM 1
      FROM circuit_breaker_scopes
      WHERE scope_key = parent_incident.scope_key
      FOR UPDATE;

      database_now := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
      IF NEW.recorded_at > database_now THEN
        RAISE EXCEPTION 'circuit-breaker recorded_at cannot be in the future' USING ERRCODE = '55000';
      END IF;
      IF NEW.exposure_json ->> 'state' = 'resolved' AND (
        NEW.exposure_json ->> 'confirmedBy' <> parent_incident.owner
        OR (NEW.exposure_json ->> 'confirmedAt')::numeric < parent_incident.triggered_at
        OR (NEW.exposure_json ->> 'confirmedAt')::numeric > database_now
        OR length(btrim(NEW.exposure_json ->> 'evidenceId')) = 0
      ) THEN
        RAISE EXCEPTION 'circuit-breaker exposure proof is invalid' USING ERRCODE = '55000';
      END IF;

      SELECT * INTO previous_event
      FROM circuit_breaker_incident_events
      WHERE incident_id = NEW.incident_id
      ORDER BY revision DESC
      LIMIT 1
      FOR UPDATE;

      IF NOT FOUND THEN
        IF NEW.revision <> 1 OR NEW.event_type <> 'observed' OR NEW.status <> 'open' THEN
          RAISE EXCEPTION 'first circuit-breaker event must be revision 1 observed/open' USING ERRCODE = '55000';
        END IF;
        IF NEW.last_observed_at < parent_incident.triggered_at
          OR NEW.exposure_json IS DISTINCT FROM parent_incident.initial_exposure_json
          OR NEW.payload_json IS DISTINCT FROM parent_incident.initial_payload_json THEN
          RAISE EXCEPTION 'first circuit-breaker event must match its immutable facts' USING ERRCODE = '55000';
        END IF;
        IF (parent_incident.impact = 'cooldown' AND NEW.cooldown_until IS NULL)
          OR (parent_incident.impact <> 'cooldown' AND NEW.cooldown_until IS NOT NULL) THEN
          RAISE EXCEPTION 'circuit-breaker cooldown does not match impact' USING ERRCODE = '55000';
        END IF;

        SELECT current.id INTO duplicate_open_id
        FROM circuit_breaker_incident_current current
        WHERE current.id <> NEW.incident_id
          AND current.scope_key = parent_incident.scope_key
          AND current.owner = parent_incident.owner
          AND current.incident_key = parent_incident.incident_key
          AND current.status = 'open'
        ORDER BY current.triggered_at ASC, current.id ASC
        LIMIT 1;
        IF duplicate_open_id IS NOT NULL THEN
          RAISE EXCEPTION 'open circuit-breaker identity already belongs to %', duplicate_open_id USING ERRCODE = '55000';
        END IF;
      ELSE
        IF previous_event.status = 'resolved' THEN
          RAISE EXCEPTION 'resolved circuit-breaker incidents cannot receive more events' USING ERRCODE = '55000';
        END IF;
        IF NEW.revision <> previous_event.revision + 1 THEN
          RAISE EXCEPTION 'circuit-breaker event revision gap' USING ERRCODE = '55000';
        END IF;
        IF NEW.last_observed_at < previous_event.last_observed_at THEN
          RAISE EXCEPTION 'circuit-breaker last_observed_at cannot move backwards' USING ERRCODE = '55000';
        END IF;
        IF NEW.event_type = 'observed' AND NEW.exposure_json IS DISTINCT FROM previous_event.exposure_json THEN
          RAISE EXCEPTION 'observation cannot mutate circuit-breaker exposure' USING ERRCODE = '55000';
        END IF;
        IF NEW.event_type = 'exposure_resolved' AND (
          parent_incident.owner <> NEW.actor
          OR previous_event.exposure_json ->> 'state' <> 'unresolved'
          OR NEW.exposure_json ->> 'state' <> 'resolved'
        ) THEN
          RAISE EXCEPTION 'exposure recovery must be recorded by the owner' USING ERRCODE = '55000';
        END IF;
        IF NEW.event_type = 'owner_resolved' AND (
          parent_incident.resolution_policy <> 'owner'
          OR parent_incident.owner <> NEW.actor
          OR (previous_event.exposure_json ->> 'state' = 'unresolved'
            AND NEW.exposure_json ->> 'state' <> 'resolved')
          OR (parent_incident.impact = 'cooldown'
            AND (previous_event.cooldown_until IS NULL OR database_now < previous_event.cooldown_until))
        ) THEN
          RAISE EXCEPTION 'owner resolution violates circuit-breaker policy' USING ERRCODE = '55000';
        END IF;
        IF NEW.event_type = 'operator_acknowledged' AND (
          parent_incident.resolution_policy <> 'operator'
          OR previous_event.exposure_json ->> 'state' = 'unresolved'
          OR NEW.exposure_json IS DISTINCT FROM previous_event.exposure_json
        ) THEN
          RAISE EXCEPTION 'operator acknowledgement requires resolved exposure' USING ERRCODE = '55000';
        END IF;
      END IF;

      RETURN NEW;
    END;
    $migration$;

    CREATE TRIGGER circuit_breaker_incident_event_revision_guard
    BEFORE INSERT ON circuit_breaker_incident_events
    FOR EACH ROW EXECUTE FUNCTION enforce_circuit_breaker_event_revision();

    CREATE VIEW circuit_breaker_incident_current AS
    SELECT
      incident.id,
      incident.scope_key,
      scope.scope_type,
      scope.asset,
      scope.slot_key,
      incident.owner,
      incident.incident_key,
      incident.reason,
      incident.impact,
      incident.resolution_policy,
      incident.intent_id,
      incident.triggered_at,
      incident.initial_exposure_json,
      incident.initial_payload_json,
      latest.revision,
      latest.event_type,
      latest.status,
      latest.actor,
      latest.request_id,
      latest.request_sha256,
      latest.occurred_at,
      latest.recorded_at,
      latest.last_observed_at,
      latest.cooldown_until,
      latest.acknowledged_at,
      latest.resolved_at,
      latest.exposure_json,
      latest.payload_json
    FROM circuit_breaker_incidents incident
    JOIN circuit_breaker_scopes scope ON scope.scope_key = incident.scope_key
    JOIN LATERAL (
      SELECT event.*
      FROM circuit_breaker_incident_events event
      WHERE event.incident_id = incident.id
      ORDER BY event.revision DESC
      LIMIT 1
    ) latest ON true;
  `);

  await db.query(
    `
      INSERT INTO circuit_breaker_scopes (scope_key, scope_type, asset, slot_key, created_at)
      VALUES ('global', 'global', NULL, NULL, $1)
    `,
    [now],
  );
  for (const asset of MIGRATION_V5_MARKET_ASSETS) {
    await db.query(
      `
        INSERT INTO circuit_breaker_scopes (scope_key, scope_type, asset, slot_key, created_at)
        VALUES ($1, 'asset', $2, NULL, $3)
      `,
      [`asset:${asset}`, asset, now],
    );
  }

  for (const row of legacyRows.rows) {
    const parsed = parseMigrationV5LegacyBreaker(row, now);
    if (parsed.scope !== null) {
      await insertMigrationV5Scope(db, parsed.scope, now);
    }
    if (parsed.incident !== null) {
      await insertMigrationV5Incident(db, parsed.incident, now);
    }
  }

  await db.query(`
    CREATE VIEW circuit_breakers AS
    WITH database_clock AS (
      SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
    ), effective AS (
      SELECT current.*,
        CASE current.impact
          WHEN 'blocked' THEN 3
          WHEN 'cooldown' THEN 2
          ELSE 1
        END AS impact_severity,
        (current.owner = 'operator' AND current.incident_key = 'manual-kill') AS manual_kill
      FROM circuit_breaker_incident_current current, database_clock
      WHERE current.status = 'open'
        AND (
          current.owner = 'operator' AND current.incident_key = 'manual-kill'
          OR current.exposure_json ->> 'state' = 'unresolved'
          OR current.impact IN ('blocked', 'degraded')
          OR current.impact = 'cooldown'
            AND (current.cooldown_until IS NULL OR database_clock.now_ms < current.cooldown_until)
        )
    ), ranked AS (
      SELECT effective.*,
        row_number() OVER (
          PARTITION BY effective.scope_key
          ORDER BY effective.manual_kill DESC, effective.impact_severity DESC,
            effective.triggered_at ASC, effective.id ASC
        ) AS dominance_rank
      FROM effective
    ), aggregate AS (
      SELECT
        ranked.scope_key,
        count(*)::integer AS incident_count,
        max(ranked.impact_severity)::integer AS worst_severity,
        min(ranked.triggered_at)::bigint AS triggered_at,
        max(ranked.cooldown_until)::bigint AS cooldown_until,
        bool_or(ranked.manual_kill) AS manual_kill_active,
        bool_or(ranked.resolution_policy = 'operator') AS requires_manual_clear,
        jsonb_agg(ranked.id ORDER BY ranked.id) AS incident_ids,
        jsonb_agg(ranked.incident_key ORDER BY ranked.incident_key, ranked.id) AS incident_keys,
        jsonb_agg(ranked.owner ORDER BY ranked.owner, ranked.id) AS owners,
        jsonb_agg(ranked.reason ORDER BY ranked.reason, ranked.id) AS reasons
      FROM ranked
      GROUP BY ranked.scope_key
    ), dominant AS (
      SELECT scope_key, id, reason
      FROM ranked
      WHERE dominance_rank = 1
    )
    SELECT
      scope.scope_key AS key,
      (aggregate.incident_count IS NOT NULL) AS active,
      dominant.reason,
      aggregate.triggered_at,
      CASE WHEN aggregate.incident_count IS NULL THEN NULL ELSE jsonb_build_object(
        'projectionVersion', 'multi-cause-ui-v1',
        'uiProjectionOnly', true,
        'worstImpact', CASE aggregate.worst_severity WHEN 3 THEN 'blocked' WHEN 2 THEN 'cooldown' ELSE 'degraded' END,
        'dominantIncidentId', dominant.id,
        'incidentIds', aggregate.incident_ids,
        'incidentKeys', aggregate.incident_keys,
        'owners', aggregate.owners,
        'reasons', aggregate.reasons,
        'manualKillActive', aggregate.manual_kill_active,
        'requiresManualClear', aggregate.requires_manual_clear,
        'cooldownUntil', aggregate.cooldown_until
      ) END AS payload_json
    FROM circuit_breaker_scopes scope
    LEFT JOIN aggregate ON aggregate.scope_key = scope.scope_key
    LEFT JOIN dominant ON dominant.scope_key = scope.scope_key
    WHERE scope.scope_type <> 'slot' OR aggregate.incident_count IS NOT NULL;
  `);
}

function parseMigrationV5LegacyBreaker(
  row: MigrationV5LegacyBreakerRow,
  now: number,
): {
  scope: CircuitBreakerScope | null;
  incident: MigrationV5IncidentSeed | null;
} {
  const issues: string[] = [];
  const scope = parseMigrationV5LegacyScope(row.key);
  if (scope === null) {
    issues.push("invalid_key");
  }
  if (typeof row.active !== "boolean") {
    issues.push("invalid_active");
  }
  if (!row.active && (row.reason !== null || row.triggered_at !== null || row.payload_json !== null)) {
    issues.push("inactive_row_contains_state");
  }
  if (row.active) {
    if (!MIGRATION_V5_LEGACY_REASONS.includes(row.reason as (typeof MIGRATION_V5_LEGACY_REASONS)[number])) {
      issues.push("invalid_reason");
    }
    if (!Number.isSafeInteger(Number(row.triggered_at)) || Number(row.triggered_at) < 0) {
      issues.push("invalid_triggered_at");
    }
    if (!isMigrationV5JsonObject(row.payload_json)) {
      issues.push("invalid_payload");
    }
  }

  if (issues.length > 0) {
    const digest = migrationV5Digest({ key: String(row.key), issues });
    return {
      scope,
      incident: {
        id: `cbi:v5:malformed:${digest}`,
        scope: { type: "global" },
        owner: "migration-v5",
        incidentKey: `malformed-legacy:${digest}`,
        reason: "readiness_failed",
        impact: "blocked",
        resolutionPolicy: "operator",
        intentId: null,
        triggeredAt: now,
        exposure: { state: "unresolved" },
        cooldownUntil: null,
        payload: { migrationVersion: 5, legacyKey: String(row.key), issues },
        requestId: `migration-v5:malformed:${digest}`,
      },
    };
  }

  if (!row.active || scope === null || row.reason === null || row.triggered_at === null) {
    return { scope, incident: null };
  }

  const payload = (row.payload_json ?? {}) as Record<string, unknown>;
  const legacyCooldown = payload.cooldownUntil;
  const cooldownUntil =
    typeof legacyCooldown === "number" && Number.isSafeInteger(legacyCooldown) && legacyCooldown > now
      ? legacyCooldown
      : null;
  const isManualKill = row.key === "global" && row.reason === "manual";
  const exposureUnresolved = row.reason === "hedge_failure" || payload.requiresManualClear === true;
  const digest = migrationV5Digest({ key: row.key, reason: row.reason, triggeredAt: Number(row.triggered_at) });
  return {
    scope,
    incident: {
      id: `cbi:v5:legacy:${digest}`,
      scope,
      owner: isManualKill ? "operator" : "legacy-backfill",
      incidentKey: isManualKill ? "manual-kill" : `legacy:${row.key}:${row.reason}`,
      reason: row.reason,
      impact: cooldownUntil === null ? "blocked" : "cooldown",
      resolutionPolicy: "operator",
      intentId: typeof payload.intentId === "string" && payload.intentId.trim() ? payload.intentId : null,
      triggeredAt: Number(row.triggered_at),
      exposure: exposureUnresolved ? { state: "unresolved" } : { state: "none" },
      cooldownUntil,
      payload: { ...payload, migrationVersion: 5, legacyKey: row.key },
      requestId: `migration-v5:legacy:${digest}`,
    },
  };
}

type MigrationV5IncidentSeed = {
  id: string;
  scope: CircuitBreakerScope;
  owner: string;
  incidentKey: string;
  reason: string;
  impact: "blocked" | "cooldown";
  resolutionPolicy: "operator";
  intentId: string | null;
  triggeredAt: number;
  exposure: { state: "none" } | { state: "unresolved" };
  cooldownUntil: number | null;
  payload: Record<string, unknown>;
  requestId: string;
};

function parseMigrationV5LegacyScope(key: string): CircuitBreakerScope | null {
  if (key === "global") {
    return { type: "global" };
  }
  if (key.startsWith("asset:")) {
    const asset = key.slice("asset:".length);
    return MIGRATION_V5_MARKET_ASSETS.includes(asset as (typeof MIGRATION_V5_MARKET_ASSETS)[number])
      ? { type: "asset", asset: asset as MarketAsset }
      : null;
  }
  if (key.startsWith("slot:")) {
    const slotKey = key.slice("slot:".length);
    const asset = slotKey.split(":", 1)[0] ?? "";
    return MIGRATION_V5_MARKET_ASSETS.includes(asset as (typeof MIGRATION_V5_MARKET_ASSETS)[number]) &&
      slotKey.startsWith(`${asset}:`) &&
      slotKey.length > asset.length + 1
      ? { type: "slot", asset: asset as MarketAsset, slotKey }
      : null;
  }
  return null;
}

async function insertMigrationV5Scope(db: PgQueryable, scope: CircuitBreakerScope, createdAt: number) {
  const values = migrationV5ScopeValues(scope, createdAt);
  await db.query(
    `
      INSERT INTO circuit_breaker_scopes (scope_key, scope_type, asset, slot_key, created_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (scope_key) DO NOTHING
    `,
    [...values],
  );
}

async function insertMigrationV5Incident(db: PgQueryable, seed: MigrationV5IncidentSeed, recordedAt: number) {
  await insertMigrationV5Scope(db, seed.scope, recordedAt);
  const scopeKey = migrationV5ScopeValues(seed.scope, recordedAt)[0];
  await db.query(
    `
      INSERT INTO circuit_breaker_incidents (
        id, scope_key, owner, incident_key, reason, impact, resolution_policy,
        intent_id, triggered_at, initial_exposure_json, initial_payload_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
    `,
    [
      seed.id,
      scopeKey,
      seed.owner,
      seed.incidentKey,
      seed.reason,
      seed.impact,
      seed.resolutionPolicy,
      seed.intentId,
      seed.triggeredAt,
      JSON.stringify(seed.exposure),
      JSON.stringify(seed.payload),
    ],
  );
  const requestSha256 = migrationV5Digest({ operation: "observe", seed });
  await db.query(
    `
      INSERT INTO circuit_breaker_incident_events (
        incident_id, revision, event_type, status, actor, request_id, request_sha256,
        occurred_at, recorded_at, last_observed_at, cooldown_until,
        acknowledged_at, resolved_at, exposure_json, payload_json
      ) VALUES (
        $1, 1, 'observed', 'open', 'migration-v5', $2, $3,
        $4, $5, $4, $6, NULL, NULL, $7::jsonb, $8::jsonb
      )
    `,
    [
      seed.id,
      seed.requestId,
      requestSha256,
      seed.triggeredAt,
      recordedAt,
      seed.cooldownUntil,
      JSON.stringify(seed.exposure),
      JSON.stringify(seed.payload),
    ],
  );
}

function migrationV5ScopeValues(scope: CircuitBreakerScope, createdAt: number) {
  if (scope.type === "global") {
    return ["global", "global", null, null, createdAt] as const;
  }
  if (scope.type === "asset") {
    return [`asset:${scope.asset}`, "asset", scope.asset, null, createdAt] as const;
  }
  return [`slot:${scope.slotKey}`, "slot", scope.asset, scope.slotKey, createdAt] as const;
}

function isMigrationV5JsonObject(value: unknown): value is Record<string, unknown> | null {
  return value === null || (typeof value === "object" && !Array.isArray(value));
}

function migrationV5Digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
/* migration-checksum:end:5 */

/* migration-checksum:start:6 */
async function applyOrderAttemptSubmissionDeadlineMigration(db: PgQueryable) {
  await db.query(`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM order_intents AS intent
        JOIN order_attempts AS attempt ON attempt.intent_id = intent.id
        WHERE intent.status IN ('hedged', 'unwound', 'settled', 'failed', 'skipped', 'canceled')
          AND (
            attempt.status IN ('planned', 'submitting', 'submitted', 'truth_pending')
            OR attempt.status = 'failed' AND attempt.truth_status IS DISTINCT FROM 'not_submitted'
          )
      ) THEN
        RAISE EXCEPTION 'Migration 6 refused: terminal intents have unresolved order submission truth';
      END IF;
    END;
    $migration$;

    ALTER TABLE order_attempts
    ADD COLUMN submission_deadline_at BIGINT;

    ALTER TABLE order_attempts
    ADD CONSTRAINT order_attempts_submission_deadline_valid CHECK (
      submission_deadline_at IS NULL OR submission_deadline_at >= 0
    );

    CREATE FUNCTION reject_order_attempt_submission_deadline_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    BEGIN
      IF OLD.submission_deadline_at IS DISTINCT FROM NEW.submission_deadline_at THEN
        RAISE EXCEPTION 'order attempt submission deadline is immutable' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $migration$;

    CREATE TRIGGER order_attempt_submission_deadline_immutable
    BEFORE UPDATE ON order_attempts
    FOR EACH ROW EXECUTE FUNCTION reject_order_attempt_submission_deadline_mutation();

    CREATE FUNCTION guard_order_attempt_submission_parent_state()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    DECLARE
      parent_status TEXT;
    BEGIN
      IF NEW.status NOT IN ('planned', 'submitting') THEN
        RETURN NEW;
      END IF;
      IF TG_OP = 'UPDATE' AND NOT (OLD.status = 'planned' AND NEW.status = 'submitting') THEN
        RETURN NEW;
      END IF;

      SELECT status
      INTO parent_status
      FROM order_intents
      WHERE id = NEW.intent_id
      FOR UPDATE;

      IF parent_status IS NULL THEN
        RAISE EXCEPTION 'order attempt parent intent % does not exist', NEW.intent_id USING ERRCODE = '23503';
      END IF;
      IF parent_status IN ('hedged', 'unwound', 'settled', 'failed', 'skipped', 'canceled') THEN
        RAISE EXCEPTION 'cannot start order submission for terminal intent % (%)', NEW.intent_id, parent_status
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $migration$;

    CREATE TRIGGER order_attempt_submission_parent_state_guard
    BEFORE INSERT OR UPDATE ON order_attempts
    FOR EACH ROW EXECUTE FUNCTION guard_order_attempt_submission_parent_state();

    CREATE FUNCTION reject_terminal_intent_with_unresolved_submission()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    BEGIN
      IF NEW.status IS NOT DISTINCT FROM OLD.status
        OR NEW.status NOT IN ('hedged', 'unwound', 'settled', 'failed', 'skipped', 'canceled') THEN
        RETURN NEW;
      END IF;

      IF EXISTS (
        SELECT 1
        FROM order_attempts AS attempt
        WHERE attempt.intent_id = NEW.id
          AND (
            attempt.status IN ('planned', 'submitting', 'submitted', 'truth_pending')
            OR attempt.status = 'failed' AND attempt.truth_status IS DISTINCT FROM 'not_submitted'
          )
      ) THEN
        RAISE EXCEPTION 'cannot make intent % terminal while order submission truth is unresolved', NEW.id
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $migration$;

    CREATE TRIGGER order_intent_terminal_submission_truth_guard
    BEFORE UPDATE OF status ON order_intents
    FOR EACH ROW EXECUTE FUNCTION reject_terminal_intent_with_unresolved_submission();
  `);
}
/* migration-checksum:end:6 */

/* migration-checksum:start:7 */
async function applyAccountingLedgerMigration(db: PgQueryable) {
  await db.query(`
    CREATE TABLE accounting_heads (
      intent_id TEXT PRIMARY KEY REFERENCES order_intents(id) ON DELETE RESTRICT,
      state TEXT NOT NULL CHECK (state IN ('open', 'stable', 'quarantined', 'no_exposure', 'legacy_pending')),
      current_version BIGINT CHECK (current_version IS NULL OR current_version > 0),
      current_proof_sha256 TEXT CHECK (
        current_proof_sha256 IS NULL OR current_proof_sha256 ~ '^[0-9a-f]{64}$'
      ),
      revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
      created_at BIGINT NOT NULL CHECK (created_at >= 0),
      updated_at BIGINT NOT NULL CHECK (updated_at >= created_at),
      CHECK (
        (state = 'stable' AND current_version IS NOT NULL AND current_proof_sha256 IS NOT NULL) OR
        (state IN ('open', 'legacy_pending', 'no_exposure')
          AND current_version IS NULL AND current_proof_sha256 IS NULL) OR
        state = 'quarantined'
      )
    );

    CREATE INDEX accounting_heads_backlog_idx
      ON accounting_heads(state, intent_id)
      WHERE state IN ('legacy_pending', 'quarantined');

    CREATE TABLE accounting_legs (
      intent_id TEXT NOT NULL REFERENCES accounting_heads(intent_id) ON DELETE RESTRICT,
      leg_id TEXT NOT NULL CHECK (length(btrim(leg_id)) > 0),
      venue TEXT NOT NULL CHECK (venue IN ('polymarket', 'kalshi')),
      outcome TEXT NOT NULL CHECK (outcome IN ('UP', 'DOWN', 'YES', 'NO')),
      market_ref TEXT NOT NULL CHECK (length(btrim(market_ref)) > 0),
      token_id TEXT,
      identity_sha256 TEXT NOT NULL CHECK (identity_sha256 ~ '^[0-9a-f]{64}$'),
      created_at BIGINT NOT NULL CHECK (created_at >= 0),
      PRIMARY KEY (intent_id, leg_id),
      UNIQUE (intent_id, venue),
      CHECK (
        (venue = 'polymarket' AND outcome IN ('UP', 'DOWN') AND token_id IS NOT NULL
          AND length(btrim(token_id)) > 0) OR
        (venue = 'kalshi' AND outcome IN ('YES', 'NO') AND token_id IS NULL)
      )
    );

    CREATE TABLE accounting_fill_facts (
      fill_id TEXT PRIMARY KEY CHECK (length(btrim(fill_id)) > 0),
      intent_id TEXT NOT NULL,
      leg_id TEXT NOT NULL,
      asset TEXT NOT NULL CHECK (asset IN ('btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'hype')),
      shadow BOOLEAN NOT NULL,
      venue TEXT NOT NULL CHECK (venue IN ('polymarket', 'kalshi')),
      venue_order_id TEXT NOT NULL CHECK (length(btrim(venue_order_id)) > 0),
      trade_id TEXT NOT NULL CHECK (length(btrim(trade_id)) > 0),
      market_ref TEXT NOT NULL CHECK (length(btrim(market_ref)) > 0),
      token_id TEXT,
      side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
      outcome TEXT NOT NULL CHECK (outcome IN ('UP', 'DOWN', 'YES', 'NO')),
      price_units NUMERIC(30, 0) NOT NULL CHECK (price_units > 0 AND price_units <= 100000000),
      size_units NUMERIC(30, 0) NOT NULL CHECK (size_units > 0),
      fee_units NUMERIC(30, 0) NOT NULL CHECK (fee_units >= 0),
      finality TEXT NOT NULL CHECK (finality IN ('final', 'non_final', 'ambiguous')),
      filled_at BIGINT NOT NULL CHECK (filled_at >= 0),
      fact_sha256 TEXT NOT NULL CHECK (fact_sha256 ~ '^[0-9a-f]{64}$'),
      raw_json JSONB NOT NULL CHECK (jsonb_typeof(raw_json) = 'object'),
      recorded_at BIGINT NOT NULL CHECK (recorded_at >= 0),
      FOREIGN KEY (intent_id, leg_id) REFERENCES accounting_legs(intent_id, leg_id) ON DELETE RESTRICT,
      UNIQUE (venue, venue_order_id, trade_id)
    );

    CREATE INDEX accounting_fill_facts_intent_idx
      ON accounting_fill_facts(intent_id, filled_at, venue, venue_order_id, trade_id);

    CREATE TABLE accounting_settlement_facts (
      settlement_id TEXT PRIMARY KEY CHECK (length(btrim(settlement_id)) > 0),
      intent_id TEXT NOT NULL,
      leg_id TEXT NOT NULL,
      asset TEXT NOT NULL CHECK (asset IN ('btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'hype')),
      shadow BOOLEAN NOT NULL,
      venue TEXT NOT NULL CHECK (venue IN ('polymarket', 'kalshi')),
      market_ref TEXT NOT NULL CHECK (length(btrim(market_ref)) > 0),
      token_id TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('UP', 'DOWN', 'YES', 'NO')),
      resolved_outcome TEXT NOT NULL CHECK (resolved_outcome IN ('UP', 'DOWN', 'YES', 'NO')),
      settled_size_units NUMERIC(30, 0) NOT NULL CHECK (settled_size_units > 0),
      payout_units NUMERIC(30, 0) NOT NULL CHECK (payout_units >= 0),
      fee_units NUMERIC(30, 0) NOT NULL CHECK (fee_units >= 0),
      finality TEXT NOT NULL CHECK (finality IN ('final', 'non_final', 'ambiguous')),
      settled_at BIGINT NOT NULL CHECK (settled_at >= 0),
      fact_sha256 TEXT NOT NULL CHECK (fact_sha256 ~ '^[0-9a-f]{64}$'),
      raw_json JSONB NOT NULL CHECK (jsonb_typeof(raw_json) = 'object'),
      recorded_at BIGINT NOT NULL CHECK (recorded_at >= 0),
      FOREIGN KEY (intent_id, leg_id) REFERENCES accounting_legs(intent_id, leg_id) ON DELETE RESTRICT
    );

    CREATE INDEX accounting_settlement_facts_intent_idx
      ON accounting_settlement_facts(intent_id, settled_at, venue, settlement_id);

    CREATE TABLE accounting_versions (
      intent_id TEXT NOT NULL REFERENCES accounting_heads(intent_id) ON DELETE RESTRICT,
      version BIGINT NOT NULL CHECK (version > 0),
      previous_version BIGINT CHECK (previous_version IS NULL OR previous_version > 0),
      request_id UUID NOT NULL UNIQUE,
      evidence_sha256 TEXT NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
      proof_sha256 TEXT NOT NULL CHECK (proof_sha256 ~ '^[0-9a-f]{64}$'),
      captured_at BIGINT NOT NULL CHECK (captured_at >= 0),
      recorded_at BIGINT NOT NULL CHECK (recorded_at >= 0),
      cost_basis_units NUMERIC(30, 0) NOT NULL CHECK (cost_basis_units >= 0),
      payout_units NUMERIC(30, 0) NOT NULL CHECK (payout_units >= 0),
      fee_units NUMERIC(30, 0) NOT NULL CHECK (fee_units >= 0),
      realized_pnl_units NUMERIC(30, 0) NOT NULL,
      roi_units NUMERIC(30, 0),
      evidence_json JSONB NOT NULL CHECK (jsonb_typeof(evidence_json) = 'object'),
      proof_json JSONB NOT NULL CHECK (jsonb_typeof(proof_json) = 'object'),
      PRIMARY KEY (intent_id, version),
      FOREIGN KEY (intent_id, previous_version)
        REFERENCES accounting_versions(intent_id, version) ON DELETE RESTRICT,
      CHECK (
        (version = 1 AND previous_version IS NULL) OR
        (version > 1 AND previous_version = version - 1)
      )
    );

    ALTER TABLE accounting_heads
    ADD CONSTRAINT accounting_heads_current_version_fk
    FOREIGN KEY (intent_id, current_version)
    REFERENCES accounting_versions(intent_id, version)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

    CREATE TABLE accounting_version_fill_facts (
      intent_id TEXT NOT NULL,
      version BIGINT NOT NULL,
      fill_id TEXT NOT NULL REFERENCES accounting_fill_facts(fill_id) ON DELETE RESTRICT,
      PRIMARY KEY (intent_id, version, fill_id),
      FOREIGN KEY (intent_id, version)
        REFERENCES accounting_versions(intent_id, version) ON DELETE RESTRICT
    );

    CREATE TABLE accounting_version_settlement_facts (
      intent_id TEXT NOT NULL,
      version BIGINT NOT NULL,
      settlement_id TEXT NOT NULL REFERENCES accounting_settlement_facts(settlement_id) ON DELETE RESTRICT,
      PRIMARY KEY (intent_id, version, settlement_id),
      FOREIGN KEY (intent_id, version)
        REFERENCES accounting_versions(intent_id, version) ON DELETE RESTRICT
    );

    CREATE TABLE accounting_realized_pnl_ledger (
      id BIGSERIAL PRIMARY KEY,
      intent_id TEXT NOT NULL,
      accounting_version BIGINT NOT NULL,
      request_id UUID NOT NULL UNIQUE,
      asset TEXT NOT NULL CHECK (asset IN ('btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'hype')),
      shadow BOOLEAN NOT NULL,
      effective_at BIGINT NOT NULL CHECK (effective_at >= 0),
      recorded_at BIGINT NOT NULL CHECK (recorded_at >= 0),
      cost_basis_delta_units NUMERIC(30, 0) NOT NULL,
      payout_delta_units NUMERIC(30, 0) NOT NULL,
      fee_delta_units NUMERIC(30, 0) NOT NULL,
      realized_pnl_delta_units NUMERIC(30, 0) NOT NULL,
      resulting_realized_pnl_units NUMERIC(30, 0) NOT NULL,
      proof_sha256 TEXT NOT NULL CHECK (proof_sha256 ~ '^[0-9a-f]{64}$'),
      FOREIGN KEY (intent_id, accounting_version)
        REFERENCES accounting_versions(intent_id, version) ON DELETE RESTRICT,
      UNIQUE (intent_id, accounting_version)
    );

    CREATE INDEX accounting_realized_pnl_ledger_day_idx
      ON accounting_realized_pnl_ledger(effective_at, shadow, asset, id);

    CREATE VIEW accounting_daily_realized_pnl AS
    SELECT
      (to_timestamp(effective_at / 1000.0) AT TIME ZONE 'UTC')::date AS utc_day,
      shadow,
      sum(realized_pnl_delta_units)::numeric(30, 0) AS realized_pnl_units,
      count(*)::bigint AS ledger_entries
    FROM accounting_realized_pnl_ledger
    GROUP BY (to_timestamp(effective_at / 1000.0) AT TIME ZONE 'UTC')::date, shadow;

    CREATE TABLE accounting_quarantines (
      id BIGSERIAL PRIMARY KEY,
      intent_id TEXT NOT NULL REFERENCES accounting_heads(intent_id) ON DELETE RESTRICT,
      reason TEXT NOT NULL CHECK (
        reason IN ('late_terminal_fill', 'fill_identity_conflict', 'fill_economic_conflict', 'head_already_closed')
      ),
      request_id UUID NOT NULL UNIQUE,
      payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
      payload_json JSONB NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
      head_revision BIGINT NOT NULL CHECK (head_revision >= 0),
      occurred_at BIGINT NOT NULL CHECK (occurred_at >= 0),
      recorded_at BIGINT NOT NULL CHECK (recorded_at >= 0)
    );

    CREATE TABLE accounting_no_exposure_closures (
      intent_id TEXT PRIMARY KEY REFERENCES accounting_heads(intent_id) ON DELETE RESTRICT,
      request_id UUID NOT NULL UNIQUE,
      actor TEXT NOT NULL CHECK (length(btrim(actor)) > 0),
      proof_sha256 TEXT NOT NULL CHECK (proof_sha256 ~ '^[0-9a-f]{64}$'),
      proof_json JSONB NOT NULL CHECK (jsonb_typeof(proof_json) = 'object'),
      closed_at BIGINT NOT NULL CHECK (closed_at >= 0),
      recorded_at BIGINT NOT NULL CHECK (recorded_at >= 0)
    );

    CREATE TABLE accounting_stability_observations (
      id BIGSERIAL PRIMARY KEY,
      intent_id TEXT NOT NULL,
      accounting_version BIGINT NOT NULL,
      request_id UUID NOT NULL UNIQUE,
      observed_at BIGINT NOT NULL CHECK (observed_at >= 0),
      observation_sha256 TEXT NOT NULL CHECK (observation_sha256 ~ '^[0-9a-f]{64}$'),
      observation_json JSONB NOT NULL CHECK (jsonb_typeof(observation_json) = 'object'),
      FOREIGN KEY (intent_id, accounting_version)
        REFERENCES accounting_versions(intent_id, version) ON DELETE RESTRICT
    );

    CREATE TABLE accounting_mutation_requests (
      request_id UUID PRIMARY KEY,
      intent_id TEXT NOT NULL REFERENCES accounting_heads(intent_id) ON DELETE RESTRICT,
      operation TEXT NOT NULL CHECK (operation IN ('ingest_fill', 'close_no_exposure', 'finalize', 'reaccount')),
      request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
      expected_head_revision BIGINT NOT NULL CHECK (expected_head_revision >= 0),
      result_json JSONB NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
      recorded_at BIGINT NOT NULL CHECK (recorded_at >= 0)
    );

    CREATE FUNCTION reject_accounting_fact_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    BEGIN
      RAISE EXCEPTION 'accounting facts are append-only' USING ERRCODE = '55000';
    END;
    $migration$;

    CREATE TRIGGER accounting_legs_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON accounting_legs
    FOR EACH STATEMENT EXECUTE FUNCTION reject_accounting_fact_mutation();
    CREATE TRIGGER accounting_fill_facts_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON accounting_fill_facts
    FOR EACH STATEMENT EXECUTE FUNCTION reject_accounting_fact_mutation();
    CREATE TRIGGER accounting_settlement_facts_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON accounting_settlement_facts
    FOR EACH STATEMENT EXECUTE FUNCTION reject_accounting_fact_mutation();
    CREATE TRIGGER accounting_versions_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON accounting_versions
    FOR EACH STATEMENT EXECUTE FUNCTION reject_accounting_fact_mutation();
    CREATE TRIGGER accounting_version_fill_facts_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON accounting_version_fill_facts
    FOR EACH STATEMENT EXECUTE FUNCTION reject_accounting_fact_mutation();
    CREATE TRIGGER accounting_version_settlement_facts_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON accounting_version_settlement_facts
    FOR EACH STATEMENT EXECUTE FUNCTION reject_accounting_fact_mutation();
    CREATE TRIGGER accounting_realized_pnl_ledger_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON accounting_realized_pnl_ledger
    FOR EACH STATEMENT EXECUTE FUNCTION reject_accounting_fact_mutation();
    CREATE TRIGGER accounting_quarantines_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON accounting_quarantines
    FOR EACH STATEMENT EXECUTE FUNCTION reject_accounting_fact_mutation();
    CREATE TRIGGER accounting_no_exposure_closures_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON accounting_no_exposure_closures
    FOR EACH STATEMENT EXECUTE FUNCTION reject_accounting_fact_mutation();
    CREATE TRIGGER accounting_stability_observations_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON accounting_stability_observations
    FOR EACH STATEMENT EXECUTE FUNCTION reject_accounting_fact_mutation();
    CREATE TRIGGER accounting_mutation_requests_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON accounting_mutation_requests
    FOR EACH STATEMENT EXECUTE FUNCTION reject_accounting_fact_mutation();

    CREATE FUNCTION guard_accounting_head_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    BEGIN
      IF NEW.intent_id IS DISTINCT FROM OLD.intent_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.revision <> OLD.revision + 1
        OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'invalid accounting head compare-and-swap' USING ERRCODE = '55000';
      END IF;
      IF NOT (
        (OLD.state IN ('open', 'legacy_pending') AND NEW.state IN ('stable', 'no_exposure', 'quarantined')) OR
        (OLD.state = 'stable' AND NEW.state IN ('stable', 'quarantined')) OR
        (OLD.state = 'quarantined' AND NEW.state IN ('stable', 'no_exposure', 'quarantined')) OR
        (OLD.state = 'no_exposure' AND NEW.state = 'quarantined')
      ) THEN
        RAISE EXCEPTION 'invalid accounting head state transition % -> %', OLD.state, NEW.state
          USING ERRCODE = '55000';
      END IF;
      IF NEW.current_version IS NOT NULL AND OLD.current_version IS NOT NULL
        AND NEW.current_version < OLD.current_version THEN
        RAISE EXCEPTION 'accounting head version cannot move backwards' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $migration$;

    CREATE TRIGGER accounting_head_transition_guard
    BEFORE UPDATE ON accounting_heads
    FOR EACH ROW EXECUTE FUNCTION guard_accounting_head_transition();

    CREATE FUNCTION create_accounting_head_for_intent()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    BEGIN
      INSERT INTO accounting_heads (
        intent_id, state, current_version, current_proof_sha256, revision, created_at, updated_at
      ) VALUES (NEW.id, 'open', NULL, NULL, 0, NEW.created_at, NEW.created_at);
      RETURN NEW;
    END;
    $migration$;

    CREATE TRIGGER order_intent_accounting_head_insert
    AFTER INSERT ON order_intents
    FOR EACH ROW EXECUTE FUNCTION create_accounting_head_for_intent();

    CREATE FUNCTION require_terminal_intent_accounting_at_commit()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    DECLARE
      accounting_state TEXT;
      required_state TEXT;
      head_version BIGINT;
      head_proof_sha256 TEXT;
      version_proof_sha256 TEXT;
      version_realized_pnl_units NUMERIC(30, 0);
      version_roi_units NUMERIC(30, 0);
    BEGIN
      IF NEW.status IN ('settled', 'unwound') THEN
        required_state := 'stable';
      ELSIF NEW.status IN ('failed', 'skipped', 'canceled') THEN
        required_state := 'no_exposure';
      ELSE
        RETURN NULL;
      END IF;

      SELECT
        head.state,
        head.current_version,
        head.current_proof_sha256,
        version.proof_sha256,
        version.realized_pnl_units,
        version.roi_units
      INTO
        accounting_state,
        head_version,
        head_proof_sha256,
        version_proof_sha256,
        version_realized_pnl_units,
        version_roi_units
      FROM accounting_heads AS head
      LEFT JOIN accounting_versions AS version
        ON version.intent_id = head.intent_id
       AND version.version = head.current_version
      WHERE head.intent_id = NEW.id;

      IF accounting_state IS DISTINCT FROM required_state THEN
        RAISE EXCEPTION
          'terminal intent % (%) requires accounting head %, found %',
          NEW.id, NEW.status, required_state, COALESCE(accounting_state, 'missing')
          USING ERRCODE = '55000';
      END IF;
      IF NEW.resolved_at IS NULL THEN
        RAISE EXCEPTION 'terminal intent % (%) requires a resolution timestamp', NEW.id, NEW.status
          USING ERRCODE = '55000';
      END IF;

      IF required_state = 'stable' AND (
        head_version IS NULL
        OR head_proof_sha256 IS DISTINCT FROM version_proof_sha256
        OR NEW.realized_pnl_usd IS NULL
        OR round(NEW.realized_pnl_usd::numeric * 100000000) IS DISTINCT FROM version_realized_pnl_units
        OR (NEW.roi IS NULL) IS DISTINCT FROM (version_roi_units IS NULL)
        OR NEW.roi IS NOT NULL
          AND round(NEW.roi::numeric * 100000000) IS DISTINCT FROM version_roi_units
      ) THEN
        RAISE EXCEPTION 'terminal intent % projection does not match its exact accounting version', NEW.id
          USING ERRCODE = '55000';
      END IF;
      IF required_state = 'no_exposure'
        AND (NEW.realized_pnl_usd IS DISTINCT FROM 0::double precision OR NEW.roi IS NOT NULL) THEN
        RAISE EXCEPTION 'no-exposure intent % must project zero realized P&L and null ROI', NEW.id
          USING ERRCODE = '55000';
      END IF;
      RETURN NULL;
    END;
    $migration$;

    CREATE CONSTRAINT TRIGGER order_intent_terminal_accounting_guard
    AFTER INSERT OR UPDATE ON order_intents
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION require_terminal_intent_accounting_at_commit();
  `);

  await db.query(`
    INSERT INTO accounting_heads (
      intent_id, state, current_version, current_proof_sha256, revision, created_at, updated_at
    )
    SELECT id, 'legacy_pending', NULL, NULL, 0, created_at, GREATEST(created_at, updated_at)
    FROM order_intents
    ORDER BY created_at ASC, id ASC
  `);
}
/* migration-checksum:end:7 */

/* migration-checksum:start:8 */
async function applyAccountingEvidenceHardeningMigration(db: PgQueryable) {
  await db.query(`
    CREATE FUNCTION resolved_attempt_has_durable_venue_truth(attempt order_attempts)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    AS $function$
      SELECT attempt.status <> 'confirmed' OR COALESCE(
        attempt.venue_order_id IS NOT NULL
        AND attempt.truth_status IS NOT NULL
        AND lower(btrim(attempt.truth_status)) IN (
          'pending', 'live', 'filled', 'partially_filled',
          'canceled', 'expired', 'rejected', 'terminal_zero_fill'
        )
        AND jsonb_typeof(attempt.result_json) = 'object'
        AND jsonb_typeof(attempt.result_json -> 'venue') = 'string'
        AND attempt.result_json ->> 'venue' = attempt.venue
        AND jsonb_typeof(attempt.result_json -> 'venueOrderId') = 'string'
        AND attempt.result_json ->> 'venueOrderId' = attempt.venue_order_id
        AND CASE
          WHEN jsonb_typeof(attempt.result_json -> 'status') = 'string'
            AND jsonb_typeof(attempt.result_json -> 'filledSize') = 'number'
          THEN
            lower(btrim(attempt.result_json ->> 'status')) IN (
              'pending', 'live', 'filled', 'partially_filled', 'canceled', 'expired', 'rejected'
            )
            AND (attempt.result_json ->> 'filledSize')::numeric >= 0
            AND (
              lower(btrim(attempt.result_json ->> 'status')) NOT IN ('filled', 'partially_filled')
              OR (attempt.result_json ->> 'filledSize')::numeric > 0
            )
            AND (
              lower(btrim(attempt.truth_status)) = lower(btrim(attempt.result_json ->> 'status'))
              OR lower(btrim(attempt.truth_status)) = 'terminal_zero_fill'
                AND lower(btrim(attempt.result_json ->> 'status')) IN ('canceled', 'expired', 'rejected')
                AND (attempt.result_json ->> 'filledSize')::numeric <= 0.000001
            )
          ELSE false
        END
        AND EXISTS (
          SELECT 1
          FROM venue_orders AS venue_order
          WHERE venue_order.intent_id = attempt.intent_id
            AND venue_order.asset = attempt.asset
            AND venue_order.shadow = attempt.shadow
            AND venue_order.venue = attempt.venue
            AND venue_order.venue_order_id = attempt.venue_order_id
            AND venue_order.client_order_id IS NOT DISTINCT FROM attempt.client_order_id
            AND venue_order.side = attempt.side
            AND venue_order.order_type = attempt.order_type
            AND venue_order.market_ref IS NOT DISTINCT FROM attempt.request_json ->> 'marketRef'
            AND venue_order.token_id IS NOT DISTINCT FROM NULLIF(attempt.request_json ->> 'tokenId', '')
            AND venue_order.outcome IS NOT DISTINCT FROM attempt.request_json ->> 'outcome'
            AND CASE
              WHEN jsonb_typeof(attempt.result_json -> 'filledSize') = 'number'
              THEN venue_order.filled_size + 0.000001 >= (attempt.result_json ->> 'filledSize')::numeric
              ELSE false
            END
        ),
        false
      )
    $function$;

    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM order_intents AS intent
        LEFT JOIN accounting_heads AS head ON head.intent_id = intent.id
        WHERE head.intent_id IS NULL
      ) THEN
        RAISE EXCEPTION 'Migration 8 refused: order intents are missing mandatory accounting heads';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM order_intents AS intent
        JOIN accounting_heads AS head ON head.intent_id = intent.id
        WHERE (head.state = 'stable' AND intent.status NOT IN ('settled', 'unwound'))
          OR (head.state = 'no_exposure' AND intent.status NOT IN ('failed', 'skipped', 'canceled'))
      ) THEN
        RAISE EXCEPTION 'Migration 8 refused: accounting heads contradict parent intent lifecycle';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM venue_orders AS venue_order
        WHERE venue_order.status NOT IN (
            'pending', 'live', 'partially_filled', 'filled', 'canceled', 'rejected', 'expired'
          )
          OR venue_order.requested_size::text IN ('NaN', 'Infinity', '-Infinity')
          OR venue_order.requested_size <= 0
          OR venue_order.requested_price IS NOT NULL
            AND (
              venue_order.requested_price::text IN ('NaN', 'Infinity', '-Infinity')
              OR venue_order.requested_price <= 0
              OR venue_order.requested_price > 1
            )
          OR venue_order.filled_size::text IN ('NaN', 'Infinity', '-Infinity')
          OR venue_order.filled_size < 0
          OR venue_order.filled_size > venue_order.requested_size + 0.000001
          OR venue_order.status = 'filled' AND venue_order.filled_size <= 0
          OR venue_order.status = 'partially_filled'
            AND (venue_order.filled_size <= 0 OR venue_order.filled_size >= venue_order.requested_size)
          OR venue_order.filled_size > 0
            AND (
              venue_order.average_fill_price IS NULL
              OR venue_order.average_fill_price::text IN ('NaN', 'Infinity', '-Infinity')
              OR venue_order.average_fill_price <= 0
              OR venue_order.average_fill_price > 1
            )
          OR venue_order.fee_usd IS NOT NULL
            AND (
              venue_order.fee_usd::text IN ('NaN', 'Infinity', '-Infinity')
              OR venue_order.fee_usd < 0
            )
      ) THEN
        RAISE EXCEPTION 'Migration 8 refused: venue orders contain contradictory size, status, or price truth';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM order_attempts AS attempt
        WHERE attempt.status NOT IN (
          'planned', 'submitting', 'submitted', 'truth_pending', 'confirmed', 'failed'
        )
      ) THEN
        RAISE EXCEPTION 'Migration 8 refused: order attempts contain unknown lifecycle status';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM fills AS fill
        WHERE fill.shadow = false
          AND (
            fill.price::text IN ('NaN', 'Infinity', '-Infinity')
            OR fill.price <= 0
            OR fill.price > 1
            OR fill.size::text IN ('NaN', 'Infinity', '-Infinity')
            OR fill.size <= 0
            OR fill.fee_usd::text IN ('NaN', 'Infinity', '-Infinity')
            OR fill.fee_usd < 0
          )
      ) THEN
        RAISE EXCEPTION 'Migration 8 refused: live legacy fills contain invalid economic truth';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM positions AS position
        WHERE position.size::text IN ('NaN', 'Infinity', '-Infinity')
          OR position.current_value_usd::text IN ('NaN', 'Infinity', '-Infinity')
      ) THEN
        RAISE EXCEPTION 'Migration 8 refused: positions contain non-finite exposure truth';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM fills AS fill
        JOIN order_intents AS intent ON intent.id = fill.intent_id
        WHERE fill.asset IS DISTINCT FROM intent.asset
          OR fill.shadow IS DISTINCT FROM intent.shadow
      ) OR EXISTS (
        SELECT 1
        FROM venue_orders AS venue_order
        JOIN order_intents AS intent ON intent.id = venue_order.intent_id
        WHERE venue_order.asset IS DISTINCT FROM intent.asset
          OR venue_order.shadow IS DISTINCT FROM intent.shadow
      ) OR EXISTS (
        SELECT 1
        FROM order_attempts AS attempt
        JOIN order_intents AS intent ON intent.id = attempt.intent_id
        WHERE attempt.asset IS DISTINCT FROM intent.asset
          OR attempt.shadow IS DISTINCT FROM intent.shadow
      ) THEN
        RAISE EXCEPTION 'Migration 8 refused: order truth rows contradict parent intent identity';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM order_attempts AS attempt
        WHERE attempt.status = 'confirmed'
          AND NOT resolved_attempt_has_durable_venue_truth(attempt)
      ) THEN
        RAISE EXCEPTION 'Migration 8 refused: confirmed order attempts lack matching durable venue truth';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM order_attempts AS attempt
        WHERE attempt.status = 'failed'
          AND attempt.truth_status = 'not_submitted'
          AND (
            attempt.venue_order_id IS NOT NULL
            OR attempt.result_json IS NOT NULL
            OR EXISTS (
              SELECT 1
              FROM venue_orders AS venue_order
              WHERE venue_order.intent_id = attempt.intent_id
                AND venue_order.venue = attempt.venue
                AND (
                  venue_order.venue_order_id = attempt.venue_order_id
                  OR venue_order.client_order_id = attempt.client_order_id
                )
            )
          )
      ) THEN
        RAISE EXCEPTION 'Migration 8 refused: not-submitted order attempts have contradictory venue truth';
      END IF;
    END;
    $migration$;

    CREATE TABLE accounting_fill_finality_observations (
      id BIGSERIAL PRIMARY KEY,
      fill_id TEXT NOT NULL REFERENCES accounting_fill_facts(fill_id) ON DELETE RESTRICT,
      request_id UUID NOT NULL UNIQUE,
      previous_finality TEXT NOT NULL CHECK (previous_finality IN ('non_final', 'ambiguous')),
      observed_finality TEXT NOT NULL CHECK (observed_finality = 'final'),
      observed_fee_units NUMERIC(78, 0) NOT NULL CHECK (observed_fee_units >= 0),
      observation_sha256 TEXT NOT NULL CHECK (observation_sha256 ~ '^[0-9a-f]{64}$'),
      observation_json JSONB NOT NULL CHECK (jsonb_typeof(observation_json) = 'object'),
      observed_at BIGINT NOT NULL CHECK (observed_at >= 0),
      recorded_at BIGINT NOT NULL CHECK (recorded_at >= 0),
      UNIQUE (fill_id, observed_finality)
    );

    CREATE INDEX accounting_fill_finality_observations_fill_idx
      ON accounting_fill_finality_observations(fill_id, id DESC);

    ALTER TABLE stable_pnl_changes
    ADD COLUMN accounting_version BIGINT,
    ADD COLUMN accounting_proof_sha256 TEXT;

    ALTER TABLE stable_pnl_changes
    ADD CONSTRAINT stable_pnl_changes_accounting_projection_valid CHECK (
      (accounting_version IS NULL AND accounting_proof_sha256 IS NULL) OR
      (accounting_version > 0 AND accounting_proof_sha256 ~ '^[0-9a-f]{64}$')
    );

    ALTER TABLE stable_pnl_changes
    ADD CONSTRAINT stable_pnl_changes_accounting_version_fk
    FOREIGN KEY (intent_id, accounting_version)
    REFERENCES accounting_versions(intent_id, version)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

    ALTER TABLE venue_orders
    ADD CONSTRAINT venue_orders_status_valid CHECK (
      status IN ('pending', 'live', 'partially_filled', 'filled', 'canceled', 'rejected', 'expired')
    ),
    ADD CONSTRAINT venue_orders_requested_size_valid CHECK (
      requested_size::text NOT IN ('NaN', 'Infinity', '-Infinity')
      AND requested_size > 0
    ),
    ADD CONSTRAINT venue_orders_requested_price_valid CHECK (
      requested_price IS NULL
      OR (
        requested_price::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND requested_price > 0
        AND requested_price <= 1
      )
    ),
    ADD CONSTRAINT venue_orders_filled_size_valid CHECK (
      filled_size::text NOT IN ('NaN', 'Infinity', '-Infinity')
      AND filled_size >= 0
      AND filled_size <= requested_size + 0.000001
    ),
    ADD CONSTRAINT venue_orders_status_fill_coherent CHECK (
      (status <> 'filled' OR filled_size > 0)
      AND (
        status <> 'partially_filled'
        OR (filled_size > 0 AND filled_size < requested_size)
      )
    ),
    ADD CONSTRAINT venue_orders_average_fill_price_valid CHECK (
      filled_size <= 0
      OR (
        average_fill_price IS NOT NULL
        AND average_fill_price::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND average_fill_price > 0
        AND average_fill_price <= 1
      )
    ),
    ADD CONSTRAINT venue_orders_fee_valid CHECK (
      fee_usd IS NULL
      OR (
        fee_usd::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND fee_usd >= 0
      )
    );

    ALTER TABLE order_attempts
    ADD CONSTRAINT order_attempts_status_valid CHECK (
      status IN ('planned', 'submitting', 'submitted', 'truth_pending', 'confirmed', 'failed')
    );

    ALTER TABLE fills
    ADD CONSTRAINT fills_live_economics_valid CHECK (
      shadow = true
      OR (
        price::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND price > 0
        AND price <= 1
        AND size::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND size > 0
        AND fee_usd::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND fee_usd >= 0
      )
    );

    ALTER TABLE positions
    ADD CONSTRAINT positions_accounting_values_finite CHECK (
      size::text NOT IN ('NaN', 'Infinity', '-Infinity')
      AND current_value_usd::text NOT IN ('NaN', 'Infinity', '-Infinity')
    );

    CREATE TRIGGER accounting_fill_finality_observations_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON accounting_fill_finality_observations
    FOR EACH STATEMENT EXECUTE FUNCTION reject_accounting_fact_mutation();

    CREATE FUNCTION reject_accounting_head_delete()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    BEGIN
      RAISE EXCEPTION 'accounting heads cannot be deleted' USING ERRCODE = '55000';
    END;
    $migration$;

    CREATE TRIGGER accounting_heads_delete_guard
    BEFORE DELETE OR TRUNCATE ON accounting_heads
    FOR EACH STATEMENT EXECUTE FUNCTION reject_accounting_head_delete();

    CREATE FUNCTION stable_accounting_projection_matches_parent(target_intent_id TEXT)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    AS $function$
      SELECT COALESCE((
        SELECT head.state <> 'stable' OR (
          intent.status IN ('settled', 'unwound')
          AND version.proof_sha256 = head.current_proof_sha256
          AND version.proof_json -> 'intent' ->> 'status' = intent.status
          AND (version.proof_json -> 'intent' ->> 'resolvedAt')::numeric = intent.resolved_at
          AND (
            intent.status <> 'settled'
            OR (
              intent.poly_resolution IS NOT NULL
              AND intent.kalshi_resolution IS NOT NULL
              AND (
                SELECT count(DISTINCT settlement.value ->> 'venue')
                FROM jsonb_array_elements(version.proof_json -> 'settlements') AS settlement(value)
              ) = 2
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(version.proof_json -> 'settlements') AS settlement(value)
            WHERE CASE settlement.value ->> 'venue'
              WHEN 'polymarket' THEN settlement.value ->> 'resolvedOutcome' IS DISTINCT FROM intent.poly_resolution
              WHEN 'kalshi' THEN settlement.value ->> 'resolvedOutcome' IS DISTINCT FROM intent.kalshi_resolution
              ELSE true
            END
          )
          AND jsonb_array_length(intent.legs_json) = jsonb_array_length(version.proof_json -> 'legTotals')
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(intent.legs_json) AS leg(value)
            LEFT JOIN LATERAL (
              SELECT candidate.value
              FROM jsonb_array_elements(version.proof_json -> 'legTotals') AS candidate(value)
              WHERE candidate.value ->> 'legId' = leg.value ->> 'id'
            ) AS total ON true
            LEFT JOIN LATERAL (
              SELECT settlement.value
              FROM jsonb_array_elements(version.proof_json -> 'settlements') AS settlement(value)
              WHERE settlement.value ->> 'legId' = leg.value ->> 'id'
            ) AS settlement ON true
            WHERE total.value IS NULL
              OR round(COALESCE((leg.value ->> 'feeUsd')::numeric, 0) * 100000000)
                IS DISTINCT FROM round((total.value ->> 'feesUsd')::numeric * 100000000)
              OR round(COALESCE((leg.value ->> 'payoutUsd')::numeric, 0) * 100000000)
                IS DISTINCT FROM round((total.value ->> 'payoutUsd')::numeric * 100000000)
              OR settlement.value IS NOT NULL
                AND leg.value ->> 'resolvedOutcome' IS DISTINCT FROM settlement.value ->> 'resolvedOutcome'
          )
        )
        FROM accounting_heads AS head
        JOIN order_intents AS intent ON intent.id = head.intent_id
        LEFT JOIN accounting_versions AS version
          ON version.intent_id = head.intent_id
         AND version.version = head.current_version
        WHERE head.intent_id = target_intent_id
      ), false)
    $function$;

    CREATE FUNCTION no_exposure_accounting_projection_matches_parent(target_intent_id TEXT)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    AS $function$
      SELECT COALESCE((
        SELECT head.state <> 'no_exposure' OR (
          intent.status IN ('failed', 'skipped', 'canceled')
          AND intent.realized_pnl_usd IS NOT DISTINCT FROM 0::double precision
          AND intent.roi IS NULL
          AND jsonb_typeof(intent.legs_json) = 'array'
          AND jsonb_array_length(intent.legs_json) = 2
          AND EXISTS (
            SELECT 1
            FROM accounting_no_exposure_closures AS closure
            WHERE closure.intent_id = head.intent_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(intent.legs_json) AS leg(value)
            WHERE jsonb_typeof(leg.value) <> 'object'
              OR NOT CASE
                WHEN jsonb_typeof(leg.value -> 'status') = 'string'
                THEN leg.value ->> 'status' IN ('pending', 'failed')
                ELSE false
              END
              OR NOT CASE
                WHEN jsonb_typeof(leg.value -> 'filledSize') = 'number'
                THEN (leg.value ->> 'filledSize')::numeric = 0
                ELSE false
              END
              OR leg.value -> 'filledPrice' IS DISTINCT FROM 'null'::jsonb
              OR NOT CASE
                WHEN jsonb_typeof(leg.value -> 'feeUsd') = 'number'
                THEN (leg.value ->> 'feeUsd')::numeric = 0
                ELSE false
              END
              OR NOT CASE
                WHEN leg.value -> 'payoutUsd' = 'null'::jsonb
                THEN true
                WHEN jsonb_typeof(leg.value -> 'payoutUsd') = 'number'
                THEN (leg.value ->> 'payoutUsd')::numeric = 0
                ELSE false
              END
              OR NOT CASE
                WHEN NOT (leg.value ? 'cashAdjustmentUsd')
                  OR leg.value -> 'cashAdjustmentUsd' = 'null'::jsonb
                THEN true
                WHEN jsonb_typeof(leg.value -> 'cashAdjustmentUsd') = 'number'
                THEN (leg.value ->> 'cashAdjustmentUsd')::numeric = 0
                ELSE false
              END
          )
        )
        FROM accounting_heads AS head
        JOIN order_intents AS intent ON intent.id = head.intent_id
        WHERE head.intent_id = target_intent_id
      ), false)
    $function$;

    CREATE FUNCTION accounted_fill_projection_is_valid(target_fill_id TEXT)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    AS $function$
      SELECT COALESCE((
        SELECT head.state <> 'no_exposure'
          AND EXISTS (
            SELECT 1
            FROM accounting_fill_facts AS fact
            WHERE fact.fill_id = fill.id
              AND fact.intent_id = fill.intent_id
              AND fact.asset = fill.asset
              AND fact.shadow = fill.shadow
              AND fact.venue = fill.venue
              AND fact.venue_order_id = fill.venue_order_id
              AND fact.trade_id = fill.trade_id
              AND fact.market_ref = fill.market_ref
              AND fact.token_id IS NOT DISTINCT FROM fill.token_id
              AND fact.side = fill.side
              AND fact.outcome = fill.outcome
              AND fact.price_units = round(fill.price::numeric * 100000000)
              AND fact.size_units = round(fill.size::numeric * 100000000)
              AND fact.fee_units = round(fill.fee_usd::numeric * 100000000)
              AND fact.filled_at = fill.filled_at
          )
          AND (
            head.state <> 'stable'
            OR EXISTS (
              SELECT 1
              FROM accounting_version_fill_facts AS version_fill
              WHERE version_fill.intent_id = head.intent_id
                AND version_fill.version = head.current_version
                AND version_fill.fill_id = fill.id
            )
          )
        FROM fills AS fill
        JOIN accounting_heads AS head ON head.intent_id = fill.intent_id
        WHERE fill.id = target_fill_id
      ), false)
    $function$;

    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM order_intents AS intent
        WHERE NOT stable_accounting_projection_matches_parent(intent.id)
      ) THEN
        RAISE EXCEPTION 'Migration 8 refused: accounting heads contradict parent intent projection';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM order_intents AS intent
        WHERE NOT no_exposure_accounting_projection_matches_parent(intent.id)
      ) THEN
        RAISE EXCEPTION 'Migration 8 refused: no-exposure heads contradict parent intent projection';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM fills AS fill
        JOIN accounting_heads AS head ON head.intent_id = fill.intent_id
        WHERE head.state <> 'legacy_pending'
          AND NOT accounted_fill_projection_is_valid(fill.id)
      ) THEN
        RAISE EXCEPTION 'Migration 8 refused: non-legacy fills bypass durable accounting ingestion';
      END IF;
    END;
    $migration$;

    CREATE FUNCTION require_accounting_head_intent_status_concordance()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    DECLARE
      accounting_state TEXT;
      intent_status TEXT;
      target_intent_id TEXT;
    BEGIN
      IF TG_TABLE_NAME = 'order_intents' THEN
        target_intent_id := NEW.id;
      ELSE
        target_intent_id := NEW.intent_id;
      END IF;
      SELECT head.state, intent.status
      INTO accounting_state, intent_status
      FROM accounting_heads AS head
      JOIN order_intents AS intent ON intent.id = head.intent_id
      WHERE head.intent_id = target_intent_id;

      IF accounting_state = 'stable' AND intent_status NOT IN ('settled', 'unwound') THEN
        RAISE EXCEPTION 'stable accounting head % requires settled or unwound parent intent', target_intent_id
          USING ERRCODE = '55000';
      END IF;
      IF NOT stable_accounting_projection_matches_parent(target_intent_id) THEN
        RAISE EXCEPTION 'stable accounting head % contradicts its exact parent projection', target_intent_id
          USING ERRCODE = '55000';
      END IF;
      IF accounting_state = 'no_exposure' AND intent_status NOT IN ('failed', 'skipped', 'canceled') THEN
        RAISE EXCEPTION 'no-exposure accounting head % requires failed, skipped, or canceled parent intent',
          target_intent_id USING ERRCODE = '55000';
      END IF;
      IF NOT no_exposure_accounting_projection_matches_parent(target_intent_id) THEN
        RAISE EXCEPTION 'no-exposure accounting head % contradicts its exact parent projection',
          target_intent_id USING ERRCODE = '55000';
      END IF;
      RETURN NULL;
    END;
    $migration$;

    CREATE CONSTRAINT TRIGGER accounting_head_parent_status_guard
    AFTER INSERT OR UPDATE ON accounting_heads
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION require_accounting_head_intent_status_concordance();

    CREATE CONSTRAINT TRIGGER order_intent_accounting_head_status_guard
    AFTER INSERT OR UPDATE ON order_intents
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION require_accounting_head_intent_status_concordance();

    CREATE FUNCTION require_fill_accounting_ingestion()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    BEGIN
      IF NOT accounted_fill_projection_is_valid(NEW.id) THEN
        RAISE EXCEPTION 'fill % bypasses durable accounting ingestion or its current accounting version', NEW.id
          USING ERRCODE = '55000';
      END IF;
      RETURN NULL;
    END;
    $migration$;

    CREATE CONSTRAINT TRIGGER fills_truth_accounting_guard
    AFTER INSERT ON fills
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION require_fill_accounting_ingestion();

    CREATE FUNCTION reject_fill_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    BEGIN
      RAISE EXCEPTION 'fills are immutable; ingest corrected venue truth through accounting evidence'
        USING ERRCODE = '55000';
    END;
    $migration$;

    CREATE TRIGGER fills_immutable_update_guard
    BEFORE UPDATE OR TRUNCATE ON fills
    FOR EACH STATEMENT EXECUTE FUNCTION reject_fill_update();

    CREATE FUNCTION require_order_truth_parent_identity()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    BEGIN
      IF TG_TABLE_NAME = 'order_intents' THEN
        IF EXISTS (
          SELECT 1 FROM fills AS fill
          WHERE fill.intent_id = NEW.id
            AND (fill.asset IS DISTINCT FROM NEW.asset OR fill.shadow IS DISTINCT FROM NEW.shadow)
        ) OR EXISTS (
          SELECT 1 FROM venue_orders AS venue_order
          WHERE venue_order.intent_id = NEW.id
            AND (venue_order.asset IS DISTINCT FROM NEW.asset OR venue_order.shadow IS DISTINCT FROM NEW.shadow)
        ) OR EXISTS (
          SELECT 1 FROM order_attempts AS attempt
          WHERE attempt.intent_id = NEW.id
            AND (attempt.asset IS DISTINCT FROM NEW.asset OR attempt.shadow IS DISTINCT FROM NEW.shadow)
        ) THEN
          RAISE EXCEPTION 'intent % mutation contradicts durable child identity', NEW.id
            USING ERRCODE = '55000';
        END IF;
      ELSIF NOT EXISTS (
        SELECT 1
        FROM order_intents AS intent
        WHERE intent.id = NEW.intent_id
          AND intent.asset = NEW.asset
          AND intent.shadow = NEW.shadow
      ) THEN
        RAISE EXCEPTION '% % contradicts parent intent identity', TG_TABLE_NAME, NEW.id
          USING ERRCODE = '55000';
      END IF;
      RETURN NULL;
    END;
    $migration$;

    CREATE CONSTRAINT TRIGGER fills_parent_identity_guard
    AFTER INSERT OR UPDATE ON fills
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION require_order_truth_parent_identity();

    CREATE CONSTRAINT TRIGGER venue_orders_parent_identity_guard
    AFTER INSERT OR UPDATE ON venue_orders
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION require_order_truth_parent_identity();

    CREATE CONSTRAINT TRIGGER order_attempts_parent_identity_guard
    AFTER INSERT OR UPDATE ON order_attempts
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION require_order_truth_parent_identity();

    CREATE CONSTRAINT TRIGGER order_intents_child_identity_guard
    AFTER UPDATE OF asset, shadow ON order_intents
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION require_order_truth_parent_identity();

    CREATE FUNCTION require_resolved_attempt_venue_truth()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    BEGIN
      IF NEW.status = 'confirmed' AND NOT resolved_attempt_has_durable_venue_truth(NEW) THEN
        RAISE EXCEPTION 'confirmed order attempt % lacks matching durable venue truth', NEW.id
          USING ERRCODE = '55000';
      END IF;
      IF NEW.status = 'failed' AND NEW.truth_status = 'not_submitted' AND (
        NEW.venue_order_id IS NOT NULL
        OR NEW.result_json IS NOT NULL
        OR EXISTS (
          SELECT 1
          FROM venue_orders AS venue_order
          WHERE venue_order.intent_id = NEW.intent_id
            AND venue_order.venue = NEW.venue
            AND (
              venue_order.venue_order_id = NEW.venue_order_id
              OR venue_order.client_order_id = NEW.client_order_id
            )
        )
      ) THEN
        RAISE EXCEPTION 'not-submitted order attempt % has contradictory venue truth', NEW.id
          USING ERRCODE = '55000';
      END IF;
      RETURN NULL;
    END;
    $migration$;

    CREATE CONSTRAINT TRIGGER order_attempt_confirmed_venue_truth_guard
    AFTER INSERT OR UPDATE ON order_attempts
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION require_resolved_attempt_venue_truth();

    CREATE FUNCTION preserve_confirmed_attempt_venue_truth()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM order_attempts AS attempt
        WHERE attempt.status = 'confirmed'
          AND NOT resolved_attempt_has_durable_venue_truth(attempt)
      ) THEN
        RAISE EXCEPTION 'venue order mutation would orphan confirmed order-attempt truth'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM order_attempts AS attempt
        WHERE attempt.status = 'failed'
          AND attempt.truth_status = 'not_submitted'
          AND EXISTS (
            SELECT 1
            FROM venue_orders AS venue_order
            WHERE venue_order.intent_id = attempt.intent_id
              AND venue_order.venue = attempt.venue
              AND (
                venue_order.venue_order_id = attempt.venue_order_id
                OR venue_order.client_order_id = attempt.client_order_id
              )
          )
      ) THEN
        RAISE EXCEPTION 'venue order mutation contradicts not-submitted order-attempt truth'
          USING ERRCODE = '55000';
      END IF;
      RETURN NULL;
    END;
    $migration$;

    CREATE CONSTRAINT TRIGGER venue_order_confirmed_attempt_truth_guard
    AFTER INSERT OR UPDATE OR DELETE ON venue_orders
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION preserve_confirmed_attempt_venue_truth();
  `);
}
/* migration-checksum:end:8 */

/* migration-checksum:start:9 */
type MigrationV9InactiveLegacySlotIncidentRow = {
  id: string;
  incident_key: string;
  revision: number;
  triggered_at: number;
  legacy_key: string;
};

async function applyInactiveLegacySlotBreakerRepairMigration(db: PgQueryable) {
  const client = db as PoolClient;
  const clock = await client.query<{ now_ms: number }>(
    "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms",
  );
  const confirmedAt = Number(clock.rows[0]?.now_ms);
  if (!Number.isSafeInteger(confirmedAt) || confirmedAt < 0) {
    throw new Error("Migration 9 refused: PostgreSQL returned an invalid clock");
  }

  const eligible = await client.query<MigrationV9InactiveLegacySlotIncidentRow>(`
    SELECT
      current.id,
      current.incident_key,
      current.revision,
      current.triggered_at,
      current.payload_json ->> 'legacyKey' AS legacy_key
    FROM circuit_breaker_incident_current AS current
    JOIN circuit_breakers_legacy AS legacy
      ON legacy.key = current.payload_json ->> 'legacyKey'
    WHERE current.scope_key = 'global'
      AND current.owner = 'migration-v5'
      AND current.reason = 'readiness_failed'
      AND current.impact = 'blocked'
      AND current.resolution_policy = 'operator'
      AND current.intent_id IS NULL
      AND current.status = 'open'
      AND current.revision = 1
      AND current.initial_exposure_json = '{"state":"unresolved"}'::jsonb
      AND current.exposure_json = '{"state":"unresolved"}'::jsonb
      AND current.initial_payload_json = current.payload_json
      AND current.payload_json = jsonb_build_object(
        'migrationVersion', 5,
        'legacyKey', legacy.key,
        'issues', jsonb_build_array('invalid_key')
      )
      AND legacy.key ~ '^slot:[0-9]+$'
      AND legacy.active = false
      AND legacy.reason IS NULL
      AND legacy.triggered_at IS NULL
      AND (legacy.payload_json IS NULL OR legacy.payload_json = 'null'::jsonb)
    ORDER BY legacy.key ASC, current.id ASC
  `);

  for (const row of eligible.rows) {
    const sourceDigest = createHash("sha256")
      .update(
        JSON.stringify({
          schema: "warbitrer.inactive-legacy-slot-breaker-repair.v1",
          incidentId: row.id,
          legacyKey: row.legacy_key,
          active: false,
          reason: null,
          triggeredAt: null,
          payload: null,
        }),
        "utf8",
      )
      .digest("hex");
    const malformedDigest = createHash("sha256")
      .update(JSON.stringify({ key: row.legacy_key, issues: ["invalid_key"] }), "utf8")
      .digest("hex");
    if (
      row.id !== `cbi:v5:malformed:${malformedDigest}` ||
      row.incident_key !== `malformed-legacy:${malformedDigest}` ||
      row.revision !== 1 ||
      row.triggered_at > confirmedAt
    ) {
      throw new Error(`Migration 9 refused: legacy incident identity mismatch for ${row.legacy_key}`);
    }

    const proven = await recordCircuitBreakerExposureRecovery(client, {
      incidentId: row.id,
      expectedRevision: row.revision,
      owner: "migration-v5",
      recoveryProof: {
        owner: "migration-v5",
        confirmedAt,
        evidenceId: `migration-v9:inactive-legacy-slot:${sourceDigest}`,
      },
      actor: "migration-v5",
      requestId: `migration-v9:prove:${sourceDigest}`,
    });
    await acknowledgeCircuitBreakerIncident(client, {
      incidentId: row.id,
      expectedRevision: proven.revision,
      operatorId: "migration-v9",
      actor: "migration-v9",
      requestId: `migration-v9:ack:${sourceDigest}`,
    });
  }

  const remaining = await client.query<{ total: number }>(`
    SELECT count(*)::integer AS total
    FROM circuit_breaker_incident_current AS current
    JOIN circuit_breakers_legacy AS legacy
      ON legacy.key = current.payload_json ->> 'legacyKey'
    WHERE current.status = 'open'
      AND current.owner = 'migration-v5'
      AND current.payload_json -> 'issues' = '["invalid_key"]'::jsonb
      AND legacy.key ~ '^slot:[0-9]+$'
      AND legacy.active = false
      AND legacy.reason IS NULL
      AND legacy.triggered_at IS NULL
      AND (legacy.payload_json IS NULL OR legacy.payload_json = 'null'::jsonb)
  `);
  if (Number(remaining.rows[0]?.total ?? 0) !== 0) {
    throw new Error("Migration 9 refused: eligible inactive legacy slot breakers remain open");
  }
}
/* migration-checksum:end:9 */

/* migration-checksum:start:10 */
async function applyMismatchCalibrationEvidenceMigration(db: PgQueryable) {
  await db.query(`
    CREATE TABLE entry_execution_probes (
      probe_key TEXT PRIMARY KEY CHECK (length(btrim(probe_key)) > 0),
      asset TEXT NOT NULL CHECK (asset IN ('btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'hype')),
      slot_key TEXT NOT NULL CHECK (length(btrim(slot_key)) > 0),
      slot_start_ts BIGINT NOT NULL CHECK (slot_start_ts >= 0),
      slot_end_ts BIGINT NOT NULL CHECK (slot_end_ts > slot_start_ts),
      combination TEXT NOT NULL CHECK (
        combination IN ('POLY_UP_KALSHI_NO', 'POLY_DOWN_KALSHI_YES')
      ),
      probe_kind TEXT NOT NULL CHECK (probe_kind IN ('candidate_preflight', 'late_probe')),
      target_seconds_remaining INTEGER CHECK (
        target_seconds_remaining IS NULL OR target_seconds_remaining IN (55, 45, 35, 25, 15, 5)
      ),
      signal_captured_at BIGINT NOT NULL CHECK (signal_captured_at >= 0),
      rest_started_at BIGINT NOT NULL CHECK (rest_started_at >= signal_captured_at),
      rest_captured_at BIGINT NOT NULL CHECK (rest_captured_at >= rest_started_at),
      decision TEXT NOT NULL CHECK (length(btrim(decision)) > 0),
      first_rejection_stage TEXT CHECK (
        first_rejection_stage IS NULL OR first_rejection_stage IN (
          'signal', 'base', 'rest', 'risk', 'admission', 'primary', 'hedge', 'settled'
        )
      ),
      first_rejection_code TEXT,
      strategy_revision BIGINT NOT NULL CHECK (strategy_revision >= 0),
      global_risk_revision BIGINT NOT NULL CHECK (global_risk_revision >= 0),
      signal_json JSONB NOT NULL CHECK (jsonb_typeof(signal_json) = 'object'),
      rest_json JSONB NOT NULL CHECK (jsonb_typeof(rest_json) = 'object'),
      risk_json JSONB NOT NULL CHECK (jsonb_typeof(risk_json) = 'object'),
      variants_json JSONB NOT NULL CHECK (jsonb_typeof(variants_json) = 'array'),
      evidence_sha256 TEXT NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
      recorded_at BIGINT NOT NULL CHECK (recorded_at >= rest_captured_at),
      CHECK (
        (probe_kind = 'late_probe' AND target_seconds_remaining IS NOT NULL) OR
        (probe_kind = 'candidate_preflight' AND target_seconds_remaining IS NULL)
      )
    );

    CREATE INDEX entry_execution_probes_asset_slot_idx
      ON entry_execution_probes(asset, slot_key, rest_captured_at DESC);
    CREATE INDEX entry_execution_probes_asset_captured_idx
      ON entry_execution_probes(asset, rest_captured_at DESC, probe_key);
    CREATE INDEX entry_execution_probes_captured_idx
      ON entry_execution_probes(rest_captured_at DESC);
    CREATE INDEX entry_execution_probes_funnel_idx
      ON entry_execution_probes(first_rejection_stage, first_rejection_code, rest_captured_at DESC);

    CREATE FUNCTION reject_entry_execution_probe_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    BEGIN
      RAISE EXCEPTION 'entry execution probes are immutable' USING ERRCODE = '55000';
    END;
    $migration$;

    CREATE TRIGGER entry_execution_probes_immutable
    BEFORE UPDATE OR TRUNCATE ON entry_execution_probes
    FOR EACH STATEMENT EXECUTE FUNCTION reject_entry_execution_probe_update();

    CREATE TABLE mismatch_calibration_artifacts (
      id TEXT PRIMARY KEY CHECK (length(btrim(id)) > 0),
      schema_version INTEGER NOT NULL CHECK (schema_version > 0),
      base_model_version TEXT NOT NULL CHECK (length(btrim(base_model_version)) > 0),
      training_started_at BIGINT NOT NULL CHECK (training_started_at >= 0),
      training_ended_at BIGINT NOT NULL CHECK (training_ended_at >= training_started_at),
      artifact_json JSONB NOT NULL CHECK (jsonb_typeof(artifact_json) = 'object'),
      metrics_json JSONB NOT NULL CHECK (jsonb_typeof(metrics_json) = 'object'),
      artifact_sha256 TEXT NOT NULL UNIQUE CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
      created_at BIGINT NOT NULL CHECK (created_at >= training_ended_at)
    );

    CREATE TABLE mismatch_calibration_activation (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      artifact_id TEXT REFERENCES mismatch_calibration_artifacts(id) ON DELETE RESTRICT,
      revision BIGINT NOT NULL CHECK (revision >= 0),
      updated_at BIGINT NOT NULL CHECK (updated_at >= 0)
    );

    INSERT INTO mismatch_calibration_activation (id, artifact_id, revision, updated_at)
    VALUES (1, NULL, 0, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint);

    CREATE TABLE mismatch_calibration_activation_events (
      id BIGSERIAL PRIMARY KEY,
      request_id UUID NOT NULL UNIQUE,
      request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
      request_json JSONB NOT NULL CHECK (jsonb_typeof(request_json) = 'object'),
      previous_artifact_id TEXT REFERENCES mismatch_calibration_artifacts(id) ON DELETE RESTRICT,
      artifact_id TEXT REFERENCES mismatch_calibration_artifacts(id) ON DELETE RESTRICT,
      previous_revision BIGINT NOT NULL CHECK (previous_revision >= 0),
      revision BIGINT NOT NULL UNIQUE CHECK (revision = previous_revision + 1),
      actor TEXT NOT NULL CHECK (length(btrim(actor)) > 0),
      reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
      occurred_at BIGINT NOT NULL CHECK (occurred_at >= 0),
      recorded_at BIGINT NOT NULL CHECK (recorded_at >= occurred_at)
    );

    CREATE FUNCTION reject_mismatch_calibration_fact_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    BEGIN
      RAISE EXCEPTION 'mismatch calibration facts are append-only' USING ERRCODE = '55000';
    END;
    $migration$;

    CREATE FUNCTION validate_mismatch_calibration_activation_event()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    DECLARE
      current_activation mismatch_calibration_activation%ROWTYPE;
    BEGIN
      SELECT * INTO STRICT current_activation
      FROM mismatch_calibration_activation
      WHERE id = 1
      FOR UPDATE;
      IF NEW.previous_revision <> current_activation.revision
        OR NEW.previous_artifact_id IS DISTINCT FROM current_activation.artifact_id
        OR NEW.revision <> current_activation.revision + 1
        OR NEW.recorded_at <= current_activation.updated_at
      THEN
        RAISE EXCEPTION 'mismatch calibration activation event does not extend current state'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $migration$;

    CREATE FUNCTION require_mismatch_calibration_activation_event()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    BEGIN
      IF NEW.id <> OLD.id
        OR NEW.revision <> OLD.revision + 1
        OR NEW.updated_at <= OLD.updated_at
        OR NOT EXISTS (
          SELECT 1
          FROM mismatch_calibration_activation_events AS event
          WHERE event.previous_revision = OLD.revision
            AND event.revision = NEW.revision
            AND event.previous_artifact_id IS NOT DISTINCT FROM OLD.artifact_id
            AND event.artifact_id IS NOT DISTINCT FROM NEW.artifact_id
            AND event.recorded_at = NEW.updated_at
        )
      THEN
        RAISE EXCEPTION 'mismatch calibration activation update lacks matching event'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $migration$;

    CREATE FUNCTION require_mismatch_calibration_activation_state()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $migration$
    DECLARE
      current_activation mismatch_calibration_activation%ROWTYPE;
    BEGIN
      SELECT * INTO STRICT current_activation
      FROM mismatch_calibration_activation
      WHERE id = 1;
      IF current_activation.revision < NEW.revision
        OR (
          current_activation.revision = NEW.revision
          AND current_activation.artifact_id IS DISTINCT FROM NEW.artifact_id
        )
      THEN
        RAISE EXCEPTION 'mismatch calibration activation event is not reflected in current state'
          USING ERRCODE = '55000';
      END IF;
      RETURN NULL;
    END;
    $migration$;

    CREATE TRIGGER mismatch_calibration_activation_event_chain
    BEFORE INSERT ON mismatch_calibration_activation_events
    FOR EACH ROW EXECUTE FUNCTION validate_mismatch_calibration_activation_event();

    CREATE TRIGGER mismatch_calibration_activation_update_guard
    BEFORE UPDATE ON mismatch_calibration_activation
    FOR EACH ROW EXECUTE FUNCTION require_mismatch_calibration_activation_event();

    CREATE CONSTRAINT TRIGGER mismatch_calibration_activation_event_state_guard
    AFTER INSERT ON mismatch_calibration_activation_events
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION require_mismatch_calibration_activation_state();

    CREATE TRIGGER mismatch_calibration_activation_singleton_guard
    BEFORE DELETE OR TRUNCATE ON mismatch_calibration_activation
    FOR EACH STATEMENT EXECUTE FUNCTION reject_mismatch_calibration_fact_mutation();

    CREATE TRIGGER mismatch_calibration_artifacts_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON mismatch_calibration_artifacts
    FOR EACH STATEMENT EXECUTE FUNCTION reject_mismatch_calibration_fact_mutation();
    CREATE TRIGGER mismatch_calibration_activation_events_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON mismatch_calibration_activation_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_mismatch_calibration_fact_mutation();

    ALTER TABLE entry_admissions
      ADD COLUMN mismatch_calibration_artifact_id TEXT
        REFERENCES mismatch_calibration_artifacts(id) ON DELETE RESTRICT,
      ADD COLUMN mismatch_calibration_revision BIGINT NOT NULL DEFAULT 0
        CHECK (mismatch_calibration_revision >= 0),
      ADD CONSTRAINT entry_admissions_mismatch_calibration_state_valid CHECK (
        mismatch_calibration_artifact_id IS NULL OR mismatch_calibration_revision > 0
      );

    ALTER TABLE entry_admissions
      ALTER COLUMN mismatch_calibration_revision DROP DEFAULT;
  `);
}
/* migration-checksum:end:10 */

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

export class ConfigurationRevisionConflictError extends Error {
  constructor(public readonly conflicts: ConfigurationRevisionConflict[]) {
    super(
      conflicts
        .map(
          (conflict) =>
            `${conflict.configurationType}:${conflict.key} expected revision ${conflict.expectedRevision}, found ${conflict.actualRevision}`,
        )
        .join(" | "),
    );
    this.name = "ConfigurationRevisionConflictError";
  }
}

export async function getStrategyConfig(pool: Pool, asset: MarketAsset): Promise<VersionedStrategyConfig> {
  const result = await pool.query<StrategyConfigRow>(
    "SELECT asset, payload, revision, updated_at FROM strategy_configs WHERE asset = $1 LIMIT 1",
    [asset],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Missing strategy configuration for ${asset}`);
  }
  return mapStrategyConfigRow(row);
}

export async function listStrategyConfigs(pool: Pool): Promise<VersionedStrategyConfigMap> {
  const result = await pool.query<StrategyConfigRow>(
    "SELECT asset, payload, revision, updated_at FROM strategy_configs ORDER BY asset ASC",
  );
  return mapStrictStrategyConfigRows(result.rows);
}

export async function getExecutionConfiguration(
  pool: Pool,
  asset: MarketAsset,
): Promise<{
  strategy: VersionedStrategyConfig;
  globalRisk: VersionedConfiguration<GlobalRiskConfig>;
  mismatchCalibration: { artifactId: string | null; revision: number; updatedAt: number };
}> {
  const result = await pool.query<
    StrategyConfigRow & {
      global_payload: Partial<GlobalRiskConfig>;
      global_revision: number;
      global_updated_at: number;
      mismatch_calibration_artifact_id: string | null;
      mismatch_calibration_revision: number;
      mismatch_calibration_updated_at: number;
    }
  >(
    `
      SELECT
        strategy.asset,
        strategy.payload,
        strategy.revision,
        strategy.updated_at,
        global_risk.payload AS global_payload,
        global_risk.revision AS global_revision,
        global_risk.updated_at AS global_updated_at,
        mismatch_calibration.artifact_id AS mismatch_calibration_artifact_id,
        mismatch_calibration.revision AS mismatch_calibration_revision,
        mismatch_calibration.updated_at AS mismatch_calibration_updated_at
      FROM strategy_configs strategy
      CROSS JOIN global_risk_config global_risk
      CROSS JOIN mismatch_calibration_activation mismatch_calibration
      WHERE strategy.asset = $1
        AND global_risk.id = 1
        AND mismatch_calibration.id = 1
      LIMIT 1
    `,
    [asset],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Missing execution configuration for ${asset}`);
  }
  assertStoredConfigurationRevision("mismatch_calibration", "active", Number(row.mismatch_calibration_revision));
  assertStoredConfigurationTimestamp("mismatch_calibration", "active", Number(row.mismatch_calibration_updated_at));
  return {
    strategy: mapStrategyConfigRow(row),
    globalRisk: mapGlobalRiskConfigRow({
      payload: row.global_payload,
      revision: row.global_revision,
      updated_at: row.global_updated_at,
    }),
    mismatchCalibration: {
      artifactId: row.mismatch_calibration_artifact_id,
      revision: Number(row.mismatch_calibration_revision),
      updatedAt: Number(row.mismatch_calibration_updated_at),
    },
  };
}

export async function updateStrategyConfig(
  pool: Pool,
  asset: MarketAsset,
  update: StrategyConfigUpdate,
  context: ConfigurationMutationContext,
) {
  return withConfigurationTransaction(pool, async (client) => {
    assertConfigurationMutationContext(context);
    assertExpectedConfigurationRevision(update.expectedRevision, "strategy", asset);
    const current = await lockStrategyConfig(client, asset);
    assertExpectedConfigurationRevisions([
      buildConfigurationRevisionConflict("strategy", asset, update.expectedRevision, current.revision),
    ]);

    const nextConfig = normalizeSettings(update.config);
    if (configurationsEqual(current.config, nextConfig)) {
      return current;
    }

    const changedAt = Math.max(Date.now(), current.updatedAt + 1);
    const result = await client.query<StrategyConfigRow>(
      `
        UPDATE strategy_configs
        SET payload = $2::jsonb,
            revision = revision + 1,
            updated_at = $3
        WHERE asset = $1
          AND revision = $4
        RETURNING asset, payload, revision, updated_at
      `,
      [asset, JSON.stringify(nextConfig), changedAt, update.expectedRevision],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ConfigurationRevisionConflictError([
        buildConfigurationRevisionConflict("strategy", asset, update.expectedRevision, current.revision),
      ]);
    }
    const updated = mapStrategyConfigRow(row);
    await insertConfigurationAuditEvent(client, {
      configurationType: "strategy",
      configurationKey: asset,
      operation: "update",
      context,
      previousRevision: current.revision,
      nextRevision: updated.revision,
      previousPayload: current.config,
      nextPayload: updated.config,
      createdAt: changedAt,
    });
    return updated;
  });
}

export async function updateStrategyConfigs(
  pool: Pool,
  updates: StrategyConfigMapUpdate,
  context: ConfigurationMutationContext,
) {
  return withConfigurationTransaction(pool, async (client) => {
    assertConfigurationMutationContext(context);
    assertCompleteStrategyConfigUpdate(updates);
    for (const asset of MARKET_ASSETS) {
      assertExpectedConfigurationRevision(updates[asset].expectedRevision, "strategy", asset);
    }
    const result = await client.query<StrategyConfigRow>(
      `
        SELECT asset, payload, revision, updated_at
        FROM strategy_configs
        ORDER BY asset ASC
        FOR UPDATE
      `,
    );
    const current = mapStrictStrategyConfigRows(result.rows);
    const conflicts = MARKET_ASSETS.map((asset) =>
      buildConfigurationRevisionConflict("strategy", asset, updates[asset].expectedRevision, current[asset].revision),
    );
    assertExpectedConfigurationRevisions(conflicts);

    const changedAt = Math.max(Date.now(), ...MARKET_ASSETS.map((asset) => current[asset].updatedAt + 1));
    const next = { ...current } as VersionedStrategyConfigMap;
    for (const asset of MARKET_ASSETS) {
      const nextConfig = normalizeSettings(updates[asset].config);
      if (configurationsEqual(current[asset].config, nextConfig)) {
        continue;
      }

      const updatedResult = await client.query<StrategyConfigRow>(
        `
          UPDATE strategy_configs
          SET payload = $2::jsonb,
              revision = revision + 1,
              updated_at = $3
          WHERE asset = $1
            AND revision = $4
          RETURNING asset, payload, revision, updated_at
        `,
        [asset, JSON.stringify(nextConfig), changedAt, updates[asset].expectedRevision],
      );
      const updatedRow = updatedResult.rows[0];
      if (!updatedRow) {
        throw new ConfigurationRevisionConflictError([
          buildConfigurationRevisionConflict(
            "strategy",
            asset,
            updates[asset].expectedRevision,
            current[asset].revision,
          ),
        ]);
      }
      const updated = mapStrategyConfigRow(updatedRow);
      next[asset] = updated;
      await insertConfigurationAuditEvent(client, {
        configurationType: "strategy",
        configurationKey: asset,
        operation: "bulk_update",
        context,
        previousRevision: current[asset].revision,
        nextRevision: updated.revision,
        previousPayload: current[asset].config,
        nextPayload: updated.config,
        createdAt: changedAt,
      });
    }
    return next;
  });
}

export async function getGlobalRiskConfig(pool: Pool): Promise<VersionedConfiguration<GlobalRiskConfig>> {
  const result = await pool.query<GlobalRiskConfigRow>(
    "SELECT payload, revision, updated_at FROM global_risk_config WHERE id = 1 LIMIT 1",
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Missing global risk configuration");
  }
  return mapGlobalRiskConfigRow(row);
}

export async function updateGlobalRiskConfig(
  pool: Pool,
  update: { config: GlobalRiskConfig; expectedRevision: number },
  context: ConfigurationMutationContext,
) {
  return withConfigurationTransaction(pool, async (client) => {
    assertConfigurationMutationContext(context);
    assertExpectedConfigurationRevision(update.expectedRevision, "global_risk", "global");
    const current = await lockGlobalRiskConfig(client);
    assertExpectedConfigurationRevisions([
      buildConfigurationRevisionConflict("global_risk", "global", update.expectedRevision, current.revision),
    ]);

    const nextConfig = normalizeGlobalRiskConfig(update.config);
    if (configurationsEqual(current.config, nextConfig)) {
      return current;
    }

    const changedAt = Math.max(Date.now(), current.updatedAt + 1);
    const result = await client.query<GlobalRiskConfigRow>(
      `
        UPDATE global_risk_config
        SET payload = $1::jsonb,
            revision = revision + 1,
            updated_at = $2
        WHERE id = 1
          AND revision = $3
        RETURNING payload, revision, updated_at
      `,
      [JSON.stringify(nextConfig), changedAt, update.expectedRevision],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ConfigurationRevisionConflictError([
        buildConfigurationRevisionConflict("global_risk", "global", update.expectedRevision, current.revision),
      ]);
    }
    const updated = mapGlobalRiskConfigRow(row);
    await insertConfigurationAuditEvent(client, {
      configurationType: "global_risk",
      configurationKey: "global",
      operation: "update",
      context,
      previousRevision: current.revision,
      nextRevision: updated.revision,
      previousPayload: current.config,
      nextPayload: updated.config,
      createdAt: changedAt,
    });
    await insertGlobalRiskConfigurationRunEvent(client, {
      context,
      previous: current,
      updated,
      createdAt: changedAt,
    });
    return updated;
  });
}

function mapStrategyConfigRow(row: StrategyConfigRow): VersionedStrategyConfig {
  const revision = Number(row.revision);
  const updatedAt = Number(row.updated_at);
  assertStoredConfigurationRevision("strategy", row.asset, revision);
  assertStoredConfigurationTimestamp("strategy", row.asset, updatedAt);
  return {
    asset: row.asset,
    config: normalizeSettings(row.payload),
    revision,
    updatedAt,
  };
}

function mapGlobalRiskConfigRow(row: GlobalRiskConfigRow): VersionedConfiguration<GlobalRiskConfig> {
  const revision = Number(row.revision);
  const updatedAt = Number(row.updated_at);
  assertStoredConfigurationRevision("global_risk", "global", revision);
  assertStoredConfigurationTimestamp("global_risk", "global", updatedAt);
  return {
    config: normalizeGlobalRiskConfig(row.payload),
    revision,
    updatedAt,
  };
}

function mapStrictStrategyConfigRows(rows: StrategyConfigRow[]): VersionedStrategyConfigMap {
  const byAsset = new Map(rows.map((row) => [row.asset, row]));
  const unknownAssets = rows.map((row) => row.asset).filter((asset) => !MARKET_ASSETS.includes(asset));
  const missingAssets = MARKET_ASSETS.filter((asset) => !byAsset.has(asset));
  if (rows.length !== MARKET_ASSETS.length || unknownAssets.length > 0 || missingAssets.length > 0) {
    throw new Error(
      `Invalid strategy configuration set (missing=${missingAssets.join(",") || "none"}, unknown=${unknownAssets.join(",") || "none"})`,
    );
  }

  return Object.fromEntries(
    MARKET_ASSETS.map((asset) => {
      const row = byAsset.get(asset);
      if (!row) {
        throw new Error(`Missing strategy configuration for ${asset}`);
      }
      return [asset, mapStrategyConfigRow(row)];
    }),
  ) as VersionedStrategyConfigMap;
}

async function lockStrategyConfig(client: PoolClient, asset: MarketAsset) {
  const result = await client.query<StrategyConfigRow>(
    `
      SELECT asset, payload, revision, updated_at
      FROM strategy_configs
      WHERE asset = $1
      FOR UPDATE
    `,
    [asset],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Missing strategy configuration for ${asset}`);
  }
  return mapStrategyConfigRow(row);
}

async function lockGlobalRiskConfig(client: PoolClient) {
  const result = await client.query<GlobalRiskConfigRow>(
    `
      SELECT payload, revision, updated_at
      FROM global_risk_config
      WHERE id = 1
      FOR UPDATE
    `,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Missing global risk configuration");
  }
  return mapGlobalRiskConfigRow(row);
}

function buildConfigurationRevisionConflict(
  configurationType: ConfigurationRevisionConflict["configurationType"],
  key: string,
  expectedRevision: number,
  actualRevision: number,
): ConfigurationRevisionConflict {
  return { configurationType, key, expectedRevision, actualRevision };
}

function assertExpectedConfigurationRevisions(conflicts: ConfigurationRevisionConflict[]) {
  const mismatches = conflicts.filter((conflict) => conflict.expectedRevision !== conflict.actualRevision);
  if (mismatches.length > 0) {
    throw new ConfigurationRevisionConflictError(mismatches);
  }
}

function assertStoredConfigurationRevision(configurationType: string, key: string, revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(`Invalid stored ${configurationType} configuration revision for ${key}: ${revision}`);
  }
}

function assertStoredConfigurationTimestamp(configurationType: string, key: string, updatedAt: number) {
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new Error(`Invalid stored ${configurationType} configuration timestamp for ${key}: ${updatedAt}`);
  }
}

function assertExpectedConfigurationRevision(revision: number, configurationType: string, key: string) {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(`Invalid expected ${configurationType} configuration revision for ${key}: ${revision}`);
  }
}

function assertCompleteStrategyConfigUpdate(updates: StrategyConfigMapUpdate) {
  const keys = Object.keys(updates).sort();
  const expected = [...MARKET_ASSETS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`Bulk strategy update must contain exactly ${expected.join(",")}`);
  }
}

function assertConfigurationMutationContext(context: ConfigurationMutationContext) {
  if (!context.actor.trim() || !UUID_PATTERN.test(context.requestId)) {
    throw new Error("Configuration mutation actor and requestId are required");
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function configurationsEqual(left: object, right: object) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function insertConfigurationAuditEvent(
  client: PoolClient,
  input: {
    configurationType: ConfigurationRevisionConflict["configurationType"];
    configurationKey: string;
    operation: "update" | "bulk_update";
    context: ConfigurationMutationContext;
    previousRevision: number;
    nextRevision: number;
    previousPayload: object;
    nextPayload: object;
    createdAt: number;
  },
) {
  assertConfigurationMutationContext(input.context);
  await client.query(
    `
      INSERT INTO configuration_audit_events (
        configuration_type, configuration_key, operation, actor, request_id,
        previous_revision, next_revision, previous_payload, next_payload, created_at
      )
      VALUES ($1, $2, $3, $4, $5::uuid, $6, $7, $8::jsonb, $9::jsonb, $10)
    `,
    [
      input.configurationType,
      input.configurationKey,
      input.operation,
      input.context.actor,
      input.context.requestId,
      input.previousRevision,
      input.nextRevision,
      JSON.stringify(input.previousPayload),
      JSON.stringify(input.nextPayload),
      input.createdAt,
    ],
  );
}

async function insertGlobalRiskConfigurationRunEvent(
  client: PoolClient,
  input: {
    context: ConfigurationMutationContext;
    previous: VersionedConfiguration<GlobalRiskConfig>;
    updated: VersionedConfiguration<GlobalRiskConfig>;
    createdAt: number;
  },
) {
  const payload = {
    requestId: input.context.requestId,
    actor: input.context.actor,
    previousRevision: input.previous.revision,
    nextRevision: input.updated.revision,
    previous: input.previous.config,
    updated: input.updated.config,
  };
  await client.query(
    `
      INSERT INTO run_events (asset, level, event_type, message, payload_json, created_at)
      SELECT NULL, 'warn', 'risk.global_config.updated',
        'Global mismatch risk configuration updated', $1::jsonb, $2
      WHERE NOT EXISTS (
        SELECT 1
        FROM run_events
        WHERE event_type = 'risk.global_config.updated'
          AND payload_json->>'requestId' = $3
      )
    `,
    [JSON.stringify(payload), input.createdAt, input.context.requestId],
  );
}

async function withConfigurationTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
        LIVE_EXECUTION_LOCK_NAMESPACE,
        LIVE_EXECUTION_LOCK_KEY,
      ]);
      const value = await run(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
  }
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

export function hashEntryExecutionProbe(input: Omit<EntryExecutionProbeRecord, "evidenceSha256">) {
  return createHash("sha256").update(canonicalizeJson(input), "utf8").digest("hex");
}

export async function insertEntryExecutionProbe(pool: Pool, probe: EntryExecutionProbeRecord) {
  const { evidenceSha256: providedEvidenceSha256, ...evidence } = probe;
  const evidenceSha256 = hashEntryExecutionProbe(evidence);
  if (providedEvidenceSha256 !== undefined && providedEvidenceSha256 !== evidenceSha256) {
    throw new Error(`Entry execution probe ${probe.probeKey} evidence checksum mismatch`);
  }

  const values = [
    probe.probeKey,
    probe.asset,
    probe.slotKey,
    probe.slotStartTs,
    probe.slotEndTs,
    probe.combination,
    probe.probeKind,
    probe.targetSecondsRemaining,
    probe.signalCapturedAt,
    probe.restStartedAt,
    probe.restCapturedAt,
    probe.decision,
    probe.firstRejectionStage,
    probe.firstRejectionCode,
    probe.strategyRevision,
    probe.globalRiskRevision,
    JSON.stringify(probe.signal),
    JSON.stringify(probe.rest),
    JSON.stringify(probe.risk),
    JSON.stringify(probe.variants),
    evidenceSha256,
    probe.recordedAt,
  ];
  const inserted = await pool.query<EntryExecutionProbeRow>(
    `
      INSERT INTO entry_execution_probes (
        probe_key, asset, slot_key, slot_start_ts, slot_end_ts, combination, probe_kind,
        target_seconds_remaining, signal_captured_at, rest_started_at, rest_captured_at,
        decision, first_rejection_stage, first_rejection_code, strategy_revision, global_risk_revision,
        signal_json, rest_json, risk_json, variants_json, evidence_sha256, recorded_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13, $14, $15, $16,
        $17::jsonb, $18::jsonb, $19::jsonb, $20::jsonb, $21, $22
      )
      ON CONFLICT (probe_key) DO NOTHING
      RETURNING *
    `,
    values,
  );
  if (inserted.rows[0]) {
    return mapEntryExecutionProbeRow(inserted.rows[0]);
  }

  const existing = await pool.query<EntryExecutionProbeRow>(
    "SELECT * FROM entry_execution_probes WHERE probe_key = $1 LIMIT 1",
    [probe.probeKey],
  );
  const row = existing.rows[0];
  if (!row || row.evidence_sha256 !== evidenceSha256) {
    throw new Error(`Entry execution probe ${probe.probeKey} conflicts with immutable evidence`);
  }
  return mapEntryExecutionProbeRow(row);
}

export async function listEntryExecutionProbes(
  pool: Pool,
  input: { since: number; until: number; asset?: MarketAsset; limit?: number },
) {
  const limit = Math.max(1, Math.min(50_000, Math.floor(input.limit ?? 10_000)));
  const result = await pool.query<EntryExecutionProbeRow>(
    `
      SELECT *
      FROM entry_execution_probes
      WHERE rest_captured_at >= $1
        AND rest_captured_at < $2
        AND ($3::text IS NULL OR asset = $3)
      ORDER BY rest_captured_at ASC, probe_key ASC
      LIMIT $4
    `,
    [input.since, input.until, input.asset ?? null, limit],
  );
  return result.rows.map(mapEntryExecutionProbeRow);
}

export async function insertMismatchCalibrationArtifact(pool: Pool, artifact: MismatchCalibrationArtifactRecord) {
  const verification = verifyMismatchCalibrationArtifact(artifact.artifact);
  if (!verification.valid) {
    throw new Error(`Mismatch calibration artifact ${artifact.id} is invalid: ${verification.reason}`);
  }
  if (
    artifact.schemaVersion !== verification.artifact.schemaVersion ||
    artifact.baseModelVersion !== verification.artifact.baseModelVersion
  ) {
    throw new Error(`Mismatch calibration artifact ${artifact.id} metadata contradicts its payload`);
  }
  const calculatedSha256 = verification.artifact.payloadSha256;
  if (artifact.artifactSha256 !== undefined && artifact.artifactSha256 !== calculatedSha256) {
    throw new Error(`Mismatch calibration artifact ${artifact.id} checksum mismatch`);
  }
  const inserted = await pool.query<MismatchCalibrationArtifactRow>(
    `
      INSERT INTO mismatch_calibration_artifacts (
        id, schema_version, base_model_version, training_started_at, training_ended_at,
        artifact_json, metrics_json, artifact_sha256, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `,
    [
      artifact.id,
      artifact.schemaVersion,
      artifact.baseModelVersion,
      artifact.trainingStartedAt,
      artifact.trainingEndedAt,
      JSON.stringify(artifact.artifact),
      JSON.stringify(artifact.metrics),
      calculatedSha256,
      artifact.createdAt,
    ],
  );
  if (inserted.rows[0]) {
    return mapMismatchCalibrationArtifactRow(inserted.rows[0]);
  }
  const existing = await pool.query<MismatchCalibrationArtifactRow>(
    "SELECT * FROM mismatch_calibration_artifacts WHERE id = $1 LIMIT 1",
    [artifact.id],
  );
  const row = existing.rows[0];
  if (
    !row ||
    row.artifact_sha256 !== calculatedSha256 ||
    Number(row.schema_version) !== artifact.schemaVersion ||
    row.base_model_version !== artifact.baseModelVersion ||
    Number(row.training_started_at) !== artifact.trainingStartedAt ||
    Number(row.training_ended_at) !== artifact.trainingEndedAt ||
    canonicalizeJson(row.artifact_json) !== canonicalizeJson(artifact.artifact) ||
    canonicalizeJson(row.metrics_json) !== canonicalizeJson(artifact.metrics) ||
    Number(row.created_at) !== artifact.createdAt
  ) {
    throw new Error(`Mismatch calibration artifact ${artifact.id} conflicts with immutable evidence`);
  }
  return mapMismatchCalibrationArtifactRow(row);
}

export async function getActiveMismatchCalibration(pool: PgQueryable): Promise<MismatchCalibrationActivation> {
  const result = await pool.query<
    MismatchCalibrationArtifactRow & {
      active_artifact_id: string | null;
      activation_revision: number;
      activation_updated_at: number;
    }
  >(`
    SELECT
      artifact.*,
      activation.artifact_id AS active_artifact_id,
      activation.revision AS activation_revision,
      activation.updated_at AS activation_updated_at
    FROM mismatch_calibration_activation AS activation
    LEFT JOIN mismatch_calibration_artifacts AS artifact ON artifact.id = activation.artifact_id
    WHERE activation.id = 1
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error("Missing mismatch calibration activation state");
  }
  const revision = Number(row.activation_revision);
  const updatedAt = Number(row.activation_updated_at);
  assertStoredConfigurationRevision("mismatch_calibration", "active", revision);
  assertStoredConfigurationTimestamp("mismatch_calibration", "active", updatedAt);
  if (row.active_artifact_id === null) {
    return { artifact: null, revision, updatedAt };
  }
  if (revision === 0) {
    throw new Error("Active mismatch calibration artifact cannot have revision zero");
  }
  const artifact = mapMismatchCalibrationArtifactRow(row);
  const eligibility = evaluateMismatchCalibrationActivationEligibility({
    artifact: artifact.artifact,
    schemaVersion: artifact.schemaVersion,
    baseModelVersion: artifact.baseModelVersion,
    trainingStartedAt: artifact.trainingStartedAt,
    trainingEndedAt: artifact.trainingEndedAt,
    createdAt: artifact.createdAt,
    metrics: artifact.metrics,
    activationAt: updatedAt,
  });
  if (!eligibility.eligible) {
    throw new Error(
      `Active mismatch calibration artifact ${artifact.id} is not activation-eligible: ${eligibility.reasons.join(", ")}`,
    );
  }
  return {
    artifact,
    revision,
    updatedAt,
  };
}

export function hashMismatchCalibrationActivationRequest(input: MismatchCalibrationActivationRequest) {
  return createHash("sha256").update(canonicalizeJson(input), "utf8").digest("hex");
}

export async function activateMismatchCalibrationArtifact(
  pool: Pool,
  input: MismatchCalibrationActivationRequest,
): Promise<MismatchCalibrationActivation> {
  const request: MismatchCalibrationActivationRequest = {
    artifactId: input.artifactId,
    expectedRevision: input.expectedRevision,
    requestId: input.requestId,
    actor: input.actor,
    reason: input.reason,
    occurredAt: input.occurredAt,
  };
  assertValidMismatchCalibrationActivationRequest(request);
  const requestSha256 = hashMismatchCalibrationActivationRequest(request);
  return withConfigurationTransaction(pool, async (client) => {
    const replay = await client.query<{
      artifact_id: string | null;
      revision: number;
      recorded_at: number;
      request_sha256: string;
      request_json: Record<string, unknown>;
    }>(
      `SELECT artifact_id, revision, recorded_at, request_sha256, request_json
       FROM mismatch_calibration_activation_events
       WHERE request_id = $1::uuid
       LIMIT 1`,
      [request.requestId],
    );
    if (replay.rows[0]) {
      const storedRequestSha256 = createHash("sha256")
        .update(canonicalizeJson(replay.rows[0].request_json), "utf8")
        .digest("hex");
      if (replay.rows[0].request_sha256 !== requestSha256 || storedRequestSha256 !== requestSha256) {
        throw new Error(`Mismatch calibration activation request ${request.requestId} was reused`);
      }
      const replayArtifact =
        request.artifactId === null
          ? null
          : await client.query<MismatchCalibrationArtifactRow>(
              "SELECT * FROM mismatch_calibration_artifacts WHERE id = $1 LIMIT 1",
              [request.artifactId],
            );
      return {
        artifact:
          replayArtifact && replayArtifact.rows[0] ? mapMismatchCalibrationArtifactRow(replayArtifact.rows[0]) : null,
        revision: Number(replay.rows[0].revision),
        updatedAt: Number(replay.rows[0].recorded_at),
      };
    }

    const current = await client.query<{
      artifact_id: string | null;
      revision: number;
      updated_at: number;
    }>("SELECT artifact_id, revision, updated_at FROM mismatch_calibration_activation WHERE id = 1 FOR UPDATE");
    const row = current.rows[0];
    if (!row) {
      throw new Error("Missing mismatch calibration activation state");
    }
    if (Number(row.revision) !== request.expectedRevision) {
      throw new ConfigurationRevisionConflictError([
        buildConfigurationRevisionConflict(
          "mismatch_calibration",
          "active",
          request.expectedRevision,
          Number(row.revision),
        ),
      ]);
    }
    let requestedArtifactRow: MismatchCalibrationArtifactRow | null = null;
    if (request.artifactId !== null) {
      const artifact = await client.query<MismatchCalibrationArtifactRow>(
        "SELECT * FROM mismatch_calibration_artifacts WHERE id = $1 FOR SHARE",
        [request.artifactId],
      );
      requestedArtifactRow = artifact.rows[0] ?? null;
      if (!requestedArtifactRow) {
        throw new Error(`Mismatch calibration artifact ${request.artifactId} does not exist`);
      }
    }

    assertStoredConfigurationRevision("mismatch_calibration", "active", Number(row.revision));
    assertStoredConfigurationTimestamp("mismatch_calibration", "active", Number(row.updated_at));
    const databaseNow = await readDatabaseClockMs(client);
    const recordedAt = Math.max(databaseNow, Number(row.updated_at) + 1);
    assertStoredConfigurationTimestamp("mismatch_calibration", "active", recordedAt);
    const occurredAt = Math.min(recordedAt, request.occurredAt);
    if (requestedArtifactRow) {
      const eligibility = evaluateMismatchCalibrationActivationEligibility({
        artifact: requestedArtifactRow.artifact_json,
        schemaVersion: Number(requestedArtifactRow.schema_version),
        baseModelVersion: requestedArtifactRow.base_model_version,
        trainingStartedAt: Number(requestedArtifactRow.training_started_at),
        trainingEndedAt: Number(requestedArtifactRow.training_ended_at),
        createdAt: Number(requestedArtifactRow.created_at),
        metrics: requestedArtifactRow.metrics_json,
        activationAt: recordedAt,
      });
      if (!eligibility.eligible) {
        throw new Error(
          `Mismatch calibration artifact ${requestedArtifactRow.id} is not activation-eligible: ${eligibility.reasons.join(", ")}`,
        );
      }
    }
    const revision = Number(row.revision) + 1;
    await client.query(
      `
        INSERT INTO mismatch_calibration_activation_events (
          request_id, request_sha256, request_json, previous_artifact_id, artifact_id, previous_revision,
          revision, actor, reason, occurred_at, recorded_at
        ) VALUES ($1::uuid, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        request.requestId,
        requestSha256,
        JSON.stringify(request),
        row.artifact_id,
        request.artifactId,
        row.revision,
        revision,
        request.actor,
        request.reason,
        occurredAt,
        recordedAt,
      ],
    );
    await client.query(
      `UPDATE mismatch_calibration_activation SET artifact_id = $1, revision = $2, updated_at = $3 WHERE id = 1`,
      [request.artifactId, revision, recordedAt],
    );
    return {
      artifact: requestedArtifactRow ? mapMismatchCalibrationArtifactRow(requestedArtifactRow) : null,
      revision,
      updatedAt: recordedAt,
    };
  });
}

function assertValidMismatchCalibrationActivationRequest(input: MismatchCalibrationActivationRequest) {
  if (
    !(input.artifactId === null || isCanonicalNonEmptyString(input.artifactId)) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    !UUID_PATTERN.test(input.requestId) ||
    !isCanonicalNonEmptyString(input.actor) ||
    !isCanonicalNonEmptyString(input.reason) ||
    !Number.isSafeInteger(input.occurredAt) ||
    input.occurredAt < 0
  ) {
    throw new Error("Invalid mismatch calibration activation request");
  }
}

function isCanonicalNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
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

export async function getLastAuthorizedEntryCosts(
  pool: Pool,
  asset: MarketAsset,
  slotKey: string,
  mode: EntryAdmissionMode,
) {
  const result = await pool.query<{ combination: PairCombination; gross_cost: number }>(
    `
      SELECT DISTINCT ON (combination) combination, gross_cost
      FROM entry_admissions
      WHERE mode = $1
        AND asset = $2
        AND slot_key = $3
      ORDER BY combination, authorized_at DESC, admission_sequence DESC
    `,
    [mode, asset, slotKey],
  );

  return result.rows.reduce<Partial<Record<PairCombination, number>>>((costs, row) => {
    costs[row.combination] = Number(row.gross_cost);
    return costs;
  }, {});
}

export async function admitLiveEntryAtomically(
  pool: Pool,
  input: LiveEntryAdmissionInput,
): Promise<EntryAdmissionDecision> {
  return admitEntryAtomically(pool, "live", input);
}

export async function admitShadowEntryAtomically(
  pool: Pool,
  input: ShadowEntryAdmissionInput,
): Promise<EntryAdmissionDecision> {
  return admitEntryAtomically(pool, "shadow", input);
}

async function admitEntryAtomically(
  pool: Pool,
  mode: EntryAdmissionMode,
  input: LiveEntryAdmissionInput | ShadowEntryAdmissionInput,
): Promise<EntryAdmissionDecision> {
  assertValidEntryAdmissionInput(mode, input);
  const liveInput = mode === "live" ? (input as LiveEntryAdmissionInput) : null;

  return withRowLockTransaction(pool, async (client) => {
    if (mode === "live") {
      await acquireAccountingTransactionLock(client);
    }
    const reservation = await lockEntryReservation(client, mode, input.intent.asset);
    const existingAdmission = await lockEntryAdmissionForIntent(client, input.intent.id);
    if (existingAdmission) {
      return loadIdempotentEntryAdmission(client, mode, input, reservation, existingAdmission);
    }

    const existingIntent = await client.query<OrderIntentRow>("SELECT * FROM order_intents WHERE id = $1 FOR UPDATE", [
      input.intent.id,
    ]);
    if (existingIntent.rows[0]) {
      throw new EntryAdmissionConflictError(input.intent.id, ["intent_without_admission"]);
    }

    if (mode === "live") {
      const accountingBacklog = await getLiveAccountingBacklog(client);
      if (accountingBacklog.total > 0) {
        return rejectEntryAdmission(
          "circuit_breaker_active",
          `Live accounting backlog blocks entry: ${accountingBacklog.missingHeads} missing heads, ${accountingBacklog.legacyPending} legacy pending, ${accountingBacklog.quarantined} quarantined, ${accountingBacklog.terminalOpen} terminal without accounting`,
        );
      }
    }

    const configuration = await lockEntryAdmissionConfiguration(client, input.intent.asset);
    assertExpectedConfigurationRevisions([
      buildConfigurationRevisionConflict(
        "strategy",
        input.intent.asset,
        input.expectedStrategyRevision,
        configuration.strategy.revision,
      ),
      buildConfigurationRevisionConflict(
        "global_risk",
        "global",
        input.expectedGlobalRiskRevision,
        configuration.globalRisk.revision,
      ),
      buildConfigurationRevisionConflict(
        "mismatch_calibration",
        "active",
        input.expectedMismatchCalibrationRevision,
        configuration.mismatchCalibration.revision,
      ),
    ]);
    if (input.expectedMismatchCalibrationArtifactId !== configuration.mismatchCalibration.artifactId) {
      throw new EntryAdmissionConflictError(input.intent.id, ["mismatchCalibrationArtifactId"]);
    }

    if (!configuration.strategy.config.enableTrading) {
      return rejectEntryAdmission("trading_disabled", `Trading is disabled for ${input.intent.asset}`);
    }
    const configuredMode: EntryAdmissionMode = configuration.strategy.config.shadowMode ? "shadow" : "live";
    if (configuredMode !== mode) {
      return rejectEntryAdmission(
        "execution_mode_mismatch",
        `Strategy configuration is ${configuredMode}, not ${mode}`,
      );
    }

    const activeBreakers = await lockRelevantEntryBreakers(client, input.intent.asset, input.intent.slotKey);
    if (activeBreakers.length > 0) {
      return {
        admitted: false,
        code: "circuit_breaker_active",
        reason: `Active circuit breaker blocks entry: ${activeBreakers.map((breaker) => breaker.key).join(", ")}`,
        activeBreakerKeys: activeBreakers.map((breaker) => breaker.key),
      };
    }

    const blockingIntentId = await findReservationConflict(client, mode, input.intent.asset, reservation);
    if (blockingIntentId) {
      return {
        admitted: false,
        code: "reservation_conflict",
        reason: `${reservation.scope_key} is reserved by unresolved intent ${blockingIntentId}`,
        blockingIntentId,
      };
    }

    const databaseNow = await readDatabaseClockMs(client);
    const authorizedAt = Math.max(databaseNow, input.now);
    if (authorizedAt >= input.intent.slotEndTs) {
      return rejectEntryAdmission("slot_closed", "The canonical slot closed before entry could be admitted");
    }
    if (liveInput && authorizedAt >= liveInput.latestSubmissionStartAt) {
      return rejectEntryAdmission("submission_window_closed", "The latest safe submission start has already passed");
    }

    if (mode === "shadow") {
      const cooldown = await findShadowReentryCooldown(client, input.intent.asset);
      if (cooldown && databaseNow < cooldown.nextEligibleAt) {
        return {
          admitted: false,
          code: "shadow_cooldown_active",
          reason: `Shadow entry cooldown for ${input.intent.asset} remains active until ${cooldown.nextEligibleAt}`,
          blockingIntentId: cooldown.intentId,
          nextEligibleAt: cooldown.nextEligibleAt,
          retryAfterMs: cooldown.nextEligibleAt - databaseNow,
        };
      }
    }

    const previous = await findSameModeEntryBaseline(
      client,
      mode,
      input.intent.asset,
      input.intent.slotKey,
      input.intent.combination,
    );
    const reentry = evaluateReentryPolicy({
      mode,
      candidateGrossCost: input.intent.grossCost,
      reentryImprovement: configuration.strategy.config.reentryImprovement,
      previous: previous === null ? null : { mode, grossCost: previous },
    });
    if (!reentry.allowed) {
      return {
        admitted: false,
        code: "reentry_insufficient_improvement",
        reason: reentry.reason,
        previousGrossCost: previous ?? undefined,
        maximumAllowedCost: reentry.maximumAllowedCost,
      };
    }

    const insertedIntent = await insertOrderIntentWithQueryable(client, input.intent);
    const insertedAttempt = liveInput ? await insertPlannedOrderAttempt(client, liveInput.plannedAttempt) : null;
    const requestSha256 = insertedAttempt?.requestSha256 ?? null;
    const admissionResult = await client.query<EntryAdmissionRow>(
      `
        INSERT INTO entry_admissions (
          id, intent_id, attempt_id, mode, asset, slot_key, combination, gross_cost,
          request_sha256, strategy_revision, global_risk_revision,
          mismatch_calibration_artifact_id, mismatch_calibration_revision, policy_evaluated_at,
          cutoff_at, latest_submission_start_at, evidence_json, authorized_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18
        )
        RETURNING *
      `,
      [
        buildEntryAdmissionId(input.intent.id),
        input.intent.id,
        insertedAttempt?.id ?? null,
        mode,
        input.intent.asset,
        input.intent.slotKey,
        input.intent.combination,
        input.intent.grossCost,
        requestSha256,
        configuration.strategy.revision,
        configuration.globalRisk.revision,
        configuration.mismatchCalibration.artifactId,
        configuration.mismatchCalibration.revision,
        input.policyEvaluatedAt,
        liveInput?.cutoffAt ?? null,
        liveInput?.latestSubmissionStartAt ?? null,
        JSON.stringify(input.evidence),
        authorizedAt,
      ],
    );
    const admissionRow = admissionResult.rows[0];
    if (!admissionRow) {
      throw new Error(`Entry admission ${input.intent.id} was not returned after insert`);
    }

    const reservationResult = await client.query<EntryReservationRow>(
      `
        UPDATE entry_reservations
        SET owner_intent_id = $2,
            reserved_at = $3,
            revision = revision + 1
        WHERE scope_key = $1
        RETURNING *
      `,
      [reservation.scope_key, input.intent.id, authorizedAt],
    );
    const reservationRow = reservationResult.rows[0];
    if (!reservationRow) {
      throw new Error(`Entry reservation ${reservation.scope_key} disappeared during admission`);
    }

    return {
      admitted: true,
      fresh: true,
      reservation: mapEntryReservationRow(reservationRow),
      admission: mapEntryAdmissionRow(admissionRow),
      intent: insertedIntent,
      plannedAttempt: insertedAttempt,
    };
  });
}

async function readDatabaseClockMs(client: PoolClient) {
  const result = await client.query<{ now_ms: number }>(
    "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms",
  );
  const now = Number(result.rows[0]?.now_ms);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error(`PostgreSQL returned an invalid transaction clock: ${String(result.rows[0]?.now_ms)}`);
  }
  return now;
}

function rejectEntryAdmission(
  code: Extract<EntryAdmissionDecision, { admitted: false }>["code"],
  reason: string,
): EntryAdmissionDecision {
  return { admitted: false, code, reason };
}

async function lockEntryReservation(client: PoolClient, mode: EntryAdmissionMode, asset: MarketAsset) {
  const scopeKey = mode === "live" ? "live:global" : `shadow:${asset}`;
  const result = await client.query<EntryReservationRow>(
    "SELECT * FROM entry_reservations WHERE scope_key = $1 FOR UPDATE",
    [scopeKey],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Missing entry reservation ${scopeKey}`);
  }
  return row;
}

async function lockEntryAdmissionForIntent(client: PoolClient, intentId: string) {
  const result = await client.query<EntryAdmissionRow>(
    "SELECT * FROM entry_admissions WHERE intent_id = $1 FOR UPDATE",
    [intentId],
  );
  return result.rows[0] ?? null;
}

async function lockEntryAdmissionConfiguration(client: PoolClient, asset: MarketAsset) {
  const strategyResult = await client.query<StrategyConfigRow>(
    `
      SELECT asset, payload, revision, updated_at
      FROM strategy_configs
      WHERE asset = $1
      FOR SHARE
    `,
    [asset],
  );
  const strategyRow = strategyResult.rows[0];
  if (!strategyRow) {
    throw new Error(`Missing strategy configuration for ${asset}`);
  }

  const globalRiskResult = await client.query<GlobalRiskConfigRow>(
    `
      SELECT payload, revision, updated_at
      FROM global_risk_config
      WHERE id = 1
      FOR SHARE
    `,
  );
  const globalRiskRow = globalRiskResult.rows[0];
  if (!globalRiskRow) {
    throw new Error("Missing global risk configuration");
  }
  const mismatchCalibrationResult = await client.query<{
    artifact_id: string | null;
    revision: number;
    updated_at: number;
  }>(`
    SELECT artifact_id, revision, updated_at
    FROM mismatch_calibration_activation
    WHERE id = 1
    FOR SHARE
  `);
  const mismatchCalibrationRow = mismatchCalibrationResult.rows[0];
  if (!mismatchCalibrationRow) {
    throw new Error("Missing mismatch calibration activation state");
  }
  assertStoredConfigurationRevision("mismatch_calibration", "active", Number(mismatchCalibrationRow.revision));
  assertStoredConfigurationTimestamp("mismatch_calibration", "active", Number(mismatchCalibrationRow.updated_at));
  return {
    strategy: mapStrategyConfigRow(strategyRow),
    globalRisk: mapGlobalRiskConfigRow(globalRiskRow),
    mismatchCalibration: {
      artifactId: mismatchCalibrationRow.artifact_id,
      revision: Number(mismatchCalibrationRow.revision),
      updatedAt: Number(mismatchCalibrationRow.updated_at),
    },
  };
}

async function lockRelevantEntryBreakers(client: PoolClient, asset: MarketAsset, slotKey: string) {
  const scopes = circuitBreakerScopeHierarchy({ type: "slot", asset, slotKey });
  await ensureAndLockCircuitBreakerScopes(client, scopes, "share");
  const relevantKeys = scopes.map(getCircuitBreakerScopeKey);
  const result = await client.query<{
    key: CircuitBreaker["key"];
    reason: CircuitBreaker["reason"];
  }>(
    `
      SELECT scope_key AS key, reason
      FROM circuit_breaker_incident_current, LATERAL (
        SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
      ) database_clock
      WHERE scope_key = ANY($1::text[])
        AND status = 'open'
        AND (
          owner = 'operator' AND incident_key = 'manual-kill'
          OR exposure_json ->> 'state' = 'unresolved'
          OR impact = 'blocked'
          OR impact = 'cooldown'
            AND (cooldown_until IS NULL OR database_clock.now_ms < cooldown_until)
        )
      ORDER BY scope_key ASC, triggered_at ASC, id ASC
    `,
    [relevantKeys],
  );
  return result.rows;
}

async function findReservationConflict(
  client: PoolClient,
  mode: EntryAdmissionMode,
  asset: MarketAsset,
  reservation: EntryReservationRow,
) {
  if (reservation.owner_intent_id) {
    const owner = await client.query<{ id: string; status: OrderIntent["status"] }>(
      "SELECT id, status FROM order_intents WHERE id = $1 FOR SHARE",
      [reservation.owner_intent_id],
    );
    if (owner.rows[0] && isIntentReservationBlocking(owner.rows[0].status)) {
      return owner.rows[0].id;
    }
  }

  const result = await client.query<{ id: string }>(
    `
      SELECT id
      FROM order_intents
      WHERE shadow = $1
        AND ($1 = false OR asset = $2)
        AND NOT (status = ANY($3::text[]))
      ORDER BY created_at ASC, id ASC
      LIMIT 1
      FOR SHARE
    `,
    [mode === "shadow", asset, [...MIGRATION_V4_NON_RESERVING_INTENT_STATUSES]],
  );
  return result.rows[0]?.id ?? null;
}

function isIntentReservationBlocking(status: OrderIntent["status"]) {
  return !(MIGRATION_V4_NON_RESERVING_INTENT_STATUSES as readonly string[]).includes(status);
}

async function findSameModeEntryBaseline(
  client: PoolClient,
  mode: EntryAdmissionMode,
  asset: MarketAsset,
  slotKey: string,
  combination: PairCombination,
) {
  const result = await client.query<{ gross_cost: number }>(
    `
      WITH baselines AS (
        SELECT
          admission.gross_cost,
          admission.authorized_at AS baseline_at,
          admission.admission_sequence AS sequence,
          1 AS source_priority,
          admission.intent_id AS intent_id
        FROM entry_admissions AS admission
        WHERE admission.mode = $1
          AND admission.asset = $2
          AND admission.slot_key = $3
          AND admission.combination = $4

        UNION ALL

        SELECT
          intent.gross_cost,
          intent.created_at AS baseline_at,
          0::bigint AS sequence,
          0 AS source_priority,
          intent.id AS intent_id
        FROM order_intents AS intent
        WHERE intent.shadow = ($1 = 'shadow')
          AND intent.asset = $2
          AND intent.slot_key = $3
          AND intent.combination = $4
          AND NOT EXISTS (
            SELECT 1
            FROM entry_admissions AS admission
            WHERE admission.intent_id = intent.id
          )
      )
      SELECT gross_cost
      FROM baselines
      ORDER BY baseline_at DESC, source_priority DESC, sequence DESC, intent_id DESC
      LIMIT 1
    `,
    [mode, asset, slotKey, combination],
  );
  return result.rows[0] ? Number(result.rows[0].gross_cost) : null;
}

async function findShadowReentryCooldown(client: PoolClient, asset: MarketAsset) {
  const result = await client.query<{
    id: string;
    updated_at: number;
    shadow_execution_json: OrderIntent["shadowExecution"];
  }>(
    `
      SELECT id, updated_at, shadow_execution_json
      FROM order_intents
      WHERE shadow = true
        AND asset = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      FOR SHARE
    `,
    [asset],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const explicitNextEligibleAt = row.shadow_execution_json?.nextEligibleAt;
  const nextEligibleAt =
    explicitNextEligibleAt === null || explicitNextEligibleAt === undefined
      ? Number(row.updated_at) + SHADOW_REENTRY_COOLDOWN_MS
      : Number(explicitNextEligibleAt);
  if (!Number.isSafeInteger(nextEligibleAt) || nextEligibleAt < 0) {
    throw new Error(`Shadow intent ${row.id} has an invalid cooldown timestamp`);
  }
  return { intentId: row.id, nextEligibleAt };
}

async function insertPlannedOrderAttempt(client: PoolClient, attempt: OrderAttempt) {
  const requestSha256 = resolveOrderAttemptRequestHash(attempt);
  const conflict = await client.query<OrderAttemptRow>(
    `
      SELECT *
      FROM order_attempts
      WHERE id = $1 OR (venue = $2 AND client_order_id = $3)
      FOR UPDATE
    `,
    [attempt.id, attempt.venue, attempt.clientOrderId],
  );
  if (conflict.rows.length > 0) {
    throw new EntryAdmissionConflictError(attempt.intentId, ["planned_attempt_reused"]);
  }

  const result = await client.query<OrderAttemptRow>(
    `
      INSERT INTO order_attempts (
        id, asset, shadow, intent_id, leg_id, stage, venue, side, order_type, client_order_id,
        venue_order_id, status, truth_status, request_json, request_sha256, submission_deadline_at,
        result_json, error, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14::jsonb, $15, $16, $17::jsonb, $18, $19, $20
      )
      RETURNING *
    `,
    orderAttemptParams({ ...attempt, requestSha256 }),
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Planned order attempt ${attempt.id} was not returned after insert`);
  }
  return mapOrderAttemptRow(row);
}

async function loadIdempotentEntryAdmission(
  client: PoolClient,
  mode: EntryAdmissionMode,
  input: LiveEntryAdmissionInput | ShadowEntryAdmissionInput,
  reservation: EntryReservationRow,
  admission: EntryAdmissionRow,
): Promise<EntryAdmissionDecision> {
  const liveInput = mode === "live" ? (input as LiveEntryAdmissionInput) : null;
  const intentResult = await client.query<OrderIntentRow>("SELECT * FROM order_intents WHERE id = $1 FOR SHARE", [
    input.intent.id,
  ]);
  const intentRow = intentResult.rows[0];
  if (!intentRow) {
    throw new EntryAdmissionConflictError(input.intent.id, ["missing_intent"]);
  }
  const storedIntent = mapOrderIntentRow(intentRow);
  assertOrderIntentIdentity(storedIntent, input.intent);

  const conflicts = collectIdentityConflicts([
    ["mode", admission.mode, mode],
    ["asset", admission.asset, input.intent.asset],
    ["slotKey", admission.slot_key, input.intent.slotKey],
    ["combination", admission.combination, input.intent.combination],
    ["grossCost", Number(admission.gross_cost), input.intent.grossCost],
    ["strategyRevision", Number(admission.strategy_revision), input.expectedStrategyRevision],
    ["globalRiskRevision", Number(admission.global_risk_revision), input.expectedGlobalRiskRevision],
    [
      "mismatchCalibrationArtifactId",
      admission.mismatch_calibration_artifact_id,
      input.expectedMismatchCalibrationArtifactId,
    ],
    [
      "mismatchCalibrationRevision",
      Number(admission.mismatch_calibration_revision),
      input.expectedMismatchCalibrationRevision,
    ],
    ["policyEvaluatedAt", Number(admission.policy_evaluated_at), input.policyEvaluatedAt],
    ["evidence", canonicalizeJson(admission.evidence_json ?? {}), canonicalizeJson(input.evidence)],
  ]);

  let storedAttempt: OrderAttempt | null = null;
  if (liveInput) {
    conflicts.push(
      ...collectIdentityConflicts([
        ["cutoffAt", admission.cutoff_at, liveInput.cutoffAt],
        ["latestSubmissionStartAt", admission.latest_submission_start_at, liveInput.latestSubmissionStartAt],
      ]),
    );
    if (!admission.attempt_id) {
      conflicts.push("attemptId");
    } else {
      const attemptResult = await client.query<OrderAttemptRow>(
        "SELECT * FROM order_attempts WHERE id = $1 FOR SHARE",
        [admission.attempt_id],
      );
      const attemptRow = attemptResult.rows[0];
      if (!attemptRow) {
        conflicts.push("missingAttempt");
      } else {
        storedAttempt = mapOrderAttemptRow(attemptRow);
        assertOrderAttemptIdentity(storedAttempt, liveInput.plannedAttempt);
        conflicts.push(
          ...collectIdentityConflicts([
            ["requestSha256", admission.request_sha256, resolveOrderAttemptRequestHash(liveInput.plannedAttempt)],
          ]),
        );
      }
    }
  } else if (admission.attempt_id !== null || admission.request_sha256 !== null) {
    conflicts.push("shadowAttempt");
  }

  if (conflicts.length > 0) {
    throw new EntryAdmissionConflictError(input.intent.id, conflicts);
  }
  return {
    admitted: true,
    fresh: false,
    reservation: mapEntryReservationRow(reservation),
    admission: mapEntryAdmissionRow(admission),
    intent: storedIntent,
    plannedAttempt: storedAttempt,
  };
}

function assertValidEntryAdmissionInput(
  mode: EntryAdmissionMode,
  input: LiveEntryAdmissionInput | ShadowEntryAdmissionInput,
) {
  assertValidOrderIntentRevision(input.intent);
  assertValidOrderIntentIdentityShape(input.intent);
  assertExpectedConfigurationRevision(input.expectedStrategyRevision, "strategy", input.intent.asset);
  assertExpectedConfigurationRevision(input.expectedGlobalRiskRevision, "global_risk", "global");
  assertExpectedConfigurationRevision(input.expectedMismatchCalibrationRevision, "mismatch_calibration", "active");
  if (
    input.expectedMismatchCalibrationArtifactId !== null &&
    (typeof input.expectedMismatchCalibrationArtifactId !== "string" ||
      input.expectedMismatchCalibrationArtifactId.length === 0 ||
      input.expectedMismatchCalibrationArtifactId.trim() !== input.expectedMismatchCalibrationArtifactId ||
      input.expectedMismatchCalibrationRevision === 0)
  ) {
    throw new Error("Invalid expected mismatch calibration artifact identity");
  }
  if (input.intent.revision !== 0) {
    throw new Error(`New entry intent ${input.intent.id} must start at revision 0`);
  }
  if (input.intent.shadow !== (mode === "shadow")) {
    throw new EntryAdmissionConflictError(input.intent.id, ["intent.shadow"]);
  }
  const expectedStatus: OrderIntent["status"] = mode === "live" ? "executing_primary" : "pending";
  if (input.intent.status !== expectedStatus) {
    throw new Error(`New ${mode} entry intent ${input.intent.id} must start in ${expectedStatus}`);
  }
  for (const [field, value] of [
    ["now", input.now],
    ["policyEvaluatedAt", input.policyEvaluatedAt],
    ["createdAt", input.intent.createdAt],
    ["updatedAt", input.intent.updatedAt],
    ["slotStartTs", input.intent.slotStartTs],
    ["slotEndTs", input.intent.slotEndTs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid entry admission ${field}: ${value}`);
    }
  }
  if (!Number.isFinite(input.intent.grossCost) || input.intent.grossCost < 0) {
    throw new Error(`Invalid entry admission gross cost: ${input.intent.grossCost}`);
  }
  if (
    input.intent.slotEndTs <= input.intent.slotStartTs ||
    input.now < input.intent.slotStartTs ||
    input.now >= input.intent.slotEndTs
  ) {
    throw new Error("Entry admission must occur inside the canonical slot");
  }
  if (
    input.policyEvaluatedAt < input.intent.slotStartTs ||
    input.policyEvaluatedAt > input.now ||
    input.intent.createdAt > input.intent.updatedAt ||
    input.intent.updatedAt > input.now
  ) {
    throw new Error("Entry admission timestamps are inconsistent");
  }
  if (
    input.evidence === null ||
    Array.isArray(input.evidence) ||
    (Object.getPrototypeOf(input.evidence) !== Object.prototype && Object.getPrototypeOf(input.evidence) !== null)
  ) {
    throw new Error("Entry admission evidence must be a plain JSON object");
  }
  canonicalizeJson(input.evidence);

  if (mode === "live") {
    const liveInput = input as LiveEntryAdmissionInput;
    if (
      !Number.isSafeInteger(liveInput.cutoffAt) ||
      !Number.isSafeInteger(liveInput.latestSubmissionStartAt) ||
      liveInput.latestSubmissionStartAt < input.intent.slotStartTs ||
      liveInput.latestSubmissionStartAt > liveInput.cutoffAt ||
      liveInput.cutoffAt > input.intent.slotEndTs
    ) {
      throw new Error("Invalid live entry admission cutoff");
    }
    assertValidPlannedEntryAttempt(input.intent, liveInput.plannedAttempt);
    if (
      !Number.isSafeInteger(liveInput.plannedAttempt.createdAt) ||
      !Number.isSafeInteger(liveInput.plannedAttempt.updatedAt) ||
      liveInput.plannedAttempt.createdAt < input.intent.slotStartTs ||
      liveInput.plannedAttempt.createdAt > liveInput.plannedAttempt.updatedAt ||
      liveInput.plannedAttempt.updatedAt > input.now
    ) {
      throw new Error("Planned order attempt timestamps are inconsistent");
    }
  }
}

function assertValidPlannedEntryAttempt(intent: OrderIntent, attempt: OrderAttempt) {
  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  const conflicts: string[] = [];
  if (
    attempt.asset !== intent.asset ||
    attempt.shadow ||
    attempt.intentId !== intent.id ||
    attempt.legId !== primaryLeg?.id ||
    attempt.venue !== intent.primaryVenue ||
    attempt.side !== primaryLeg?.side
  ) {
    conflicts.push("plannedAttempt.identity");
  }
  if (
    attempt.stage !== "primary" ||
    attempt.status !== "planned" ||
    attempt.venueOrderId !== null ||
    attempt.truthStatus !== "admitted_not_claimed" ||
    attempt.result !== null ||
    attempt.error !== null
  ) {
    conflicts.push("plannedAttempt.state");
  }
  if (!attempt.id.trim() || !attempt.clientOrderId.trim() || !attempt.orderType.trim()) {
    conflicts.push("plannedAttempt.requiredFields");
  }
  resolveOrderAttemptRequestHash(attempt);
  if (conflicts.length > 0) {
    throw new EntryAdmissionConflictError(intent.id, conflicts);
  }
}

function buildEntryAdmissionId(intentId: string) {
  return `entry:${intentId}`;
}

export async function insertOrderIntent(pool: Pool, intent: OrderIntent): Promise<OrderIntent> {
  return insertOrderIntentWithQueryable(pool, intent);
}

async function insertOrderIntentWithQueryable(db: PgQueryable, intent: OrderIntent): Promise<OrderIntent> {
  if (intent.revision !== 0) {
    throw new Error(`New order intent ${intent.id} must start at revision 0`);
  }
  assertValidOrderIntentIdentityShape(intent);

  const result = await db.query<OrderIntentRow>(
    `
      INSERT INTO order_intents (
        id, revision, asset, shadow, slot_key, slot_start_ts, slot_end_ts, combination, status, created_at, updated_at,
        resolved_at, primary_venue, hedge_venue, gross_cost, target_notional_usd, max_slippage_bps,
        entry_sizing_reason, failure_reason, projected_net_profit_usd, realized_pnl_usd, roi, poly_resolution,
        kalshi_resolution, legs_json, mismatch_p_fatal, mismatch_p_fatal_upper, mismatch_model_version,
        fatal_mismatch_pnl_usd, conservative_expected_pnl_usd, fatal_loss_exposure_usd,
        mismatch_risk_audit_json, shadow_execution_json
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16, $17,
        $18, $19, $20, $21, $22, $23,
        $24, $25::jsonb, $26, $27, $28,
        $29, $30, $31, $32::jsonb, $33::jsonb
      )
      RETURNING *
    `,
    [
      intent.id,
      intent.revision,
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

  if (!result.rows[0]) {
    throw new Error(`Order intent ${intent.id} was not returned after insert`);
  }
  return mapOrderIntentRow(result.rows[0]);
}

export async function updateOrderIntent(pool: Pool, intent: OrderIntent): Promise<OrderIntent> {
  assertValidOrderIntentRevision(intent);
  const existingResult = await pool.query<OrderIntentRow>("SELECT * FROM order_intents WHERE id = $1 LIMIT 1", [
    intent.id,
  ]);
  const existingRow = existingResult.rows[0];
  if (!existingRow) {
    throw new OrderIntentRevisionConflictError(intent.id, intent.revision, null);
  }

  assertOrderIntentIdentity(mapOrderIntentRow(existingRow), intent);

  const result = await pool.query<OrderIntentRow>(
    `
      UPDATE order_intents
      SET status = $3,
          updated_at = $4,
          resolved_at = $5,
          gross_cost = $6,
          target_notional_usd = $7,
          max_slippage_bps = $8,
          entry_sizing_reason = $9,
          failure_reason = $10,
          projected_net_profit_usd = $11,
          realized_pnl_usd = $12,
          roi = $13,
          poly_resolution = $14,
          kalshi_resolution = $15,
          legs_json = $16::jsonb,
          mismatch_p_fatal = $17,
          mismatch_p_fatal_upper = $18,
          mismatch_model_version = $19,
          fatal_mismatch_pnl_usd = $20,
          conservative_expected_pnl_usd = $21,
          fatal_loss_exposure_usd = $22,
          mismatch_risk_audit_json = $23::jsonb,
          shadow_execution_json = $24::jsonb,
          revision = revision + 1
      WHERE id = $1 AND revision = $2
      RETURNING *
    `,
    [
      intent.id,
      intent.revision,
      intent.status,
      intent.updatedAt,
      intent.resolvedAt,
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
  if (result.rows[0]) {
    return mapOrderIntentRow(result.rows[0]);
  }

  const currentResult = await pool.query<Pick<OrderIntentRow, "revision">>(
    "SELECT revision FROM order_intents WHERE id = $1 LIMIT 1",
    [intent.id],
  );
  throw new OrderIntentRevisionConflictError(intent.id, intent.revision, currentResult.rows[0]?.revision ?? null);
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

const TERMINAL_VENUE_ORDER_STATUSES = new Set<LiveOrder["status"]>(["filled", "canceled", "rejected", "expired"]);
const NON_FILLED_TERMINAL_VENUE_ORDER_STATUSES = new Set<LiveOrder["status"]>(["canceled", "rejected", "expired"]);

export class PersistenceIdentityConflictError extends Error {
  constructor(entity: "order_intent" | "venue_order" | "order_attempt", id: string, fields: string[]) {
    super(`Immutable ${entity} identity conflict for ${id}: ${fields.join(", ")}`);
    this.name = "PersistenceIdentityConflictError";
  }
}

export class EntryAdmissionConflictError extends Error {
  constructor(
    public readonly intentId: string,
    public readonly fields: string[],
  ) {
    super(`Entry admission conflict for ${intentId}: ${fields.join(", ")}`);
    this.name = "EntryAdmissionConflictError";
  }
}

export type LiveOrderAttemptClaimErrorCode =
  | "attempt_not_found"
  | "attempt_intent_mismatch"
  | "attempt_not_live"
  | "admission_not_found"
  | "admission_attempt_mismatch"
  | "admission_not_live"
  | "request_mismatch"
  | "attempt_already_claimed"
  | "attempt_not_planned"
  | "strategy_revision_changed"
  | "global_risk_revision_changed"
  | "mismatch_calibration_revision_changed"
  | "trading_disabled"
  | "execution_mode_mismatch"
  | "circuit_breaker_active"
  | "accounting_backlog"
  | "submission_capability_expired"
  | "claim_conflict";

export class LiveOrderAttemptClaimError extends Error {
  constructor(
    public readonly code: LiveOrderAttemptClaimErrorCode,
    public readonly intentId: string,
    public readonly attemptId: string,
    public readonly actualStatus: OrderAttempt["status"] | null = null,
    public readonly reason: string | null = null,
  ) {
    super(
      (actualStatus === null
        ? `Live order attempt claim ${code} for ${intentId}/${attemptId}`
        : `Live order attempt claim ${code} for ${intentId}/${attemptId} (status ${actualStatus})`) +
        (reason === null ? "" : `: ${reason}`),
    );
    this.name = "LiveOrderAttemptClaimError";
  }
}

export type LiveOrderAttemptSubmissionErrorCode =
  | "invalid_planned_attempt"
  | "initial_attempt_requires_admission"
  | "request_proof_mismatch"
  | "submission_deadline_mismatch"
  | "submission_deadline_expired"
  | "claim_conflict";

export class LiveOrderAttemptSubmissionError extends Error {
  /** This invocation did not receive permission to call the venue; it says nothing about prior attempt truth. */
  public readonly claimAuthorization: "not_granted" | "indeterminate";

  constructor(
    public readonly code: LiveOrderAttemptSubmissionErrorCode,
    public readonly attemptId: string,
    public readonly actualStatus: OrderAttempt["status"] | null = null,
    public readonly reason: string | null = null,
  ) {
    super(
      (actualStatus === null
        ? `Live order submission ${code} for ${attemptId}`
        : `Live order submission ${code} for ${attemptId} (status ${actualStatus})`) +
        (reason === null ? "" : `: ${reason}`),
    );
    this.name = "LiveOrderAttemptSubmissionError";
    this.claimAuthorization = code === "claim_conflict" ? "indeterminate" : "not_granted";
  }
}

export class OrderIntentRevisionConflictError extends Error {
  constructor(
    public readonly intentId: string,
    public readonly expectedRevision: number,
    public readonly actualRevision: number | null,
  ) {
    super(
      actualRevision === null
        ? `Order intent ${intentId} no longer exists (expected revision ${expectedRevision})`
        : `Order intent ${intentId} revision conflict: expected ${expectedRevision}, found ${actualRevision}`,
    );
    this.name = "OrderIntentRevisionConflictError";
  }
}

function assertValidOrderIntentRevision(intent: OrderIntent) {
  if (!Number.isSafeInteger(intent.revision) || intent.revision < 0) {
    throw new Error(`Order intent ${intent.id} has invalid revision ${intent.revision}`);
  }
}

function assertValidOrderIntentIdentityShape(intent: OrderIntent) {
  const conflicts: string[] = [];
  if (intent.legs.length !== 2 || new Set(intent.legs.map((leg) => leg.id)).size !== 2) {
    conflicts.push("legs");
  }
  const legVenues = new Set(intent.legs.map((leg) => leg.venue));
  if (legVenues.size !== 2 || !legVenues.has("polymarket") || !legVenues.has("kalshi")) {
    conflicts.push("legs.venue");
  }
  if (
    intent.primaryVenue === intent.hedgeVenue ||
    !legVenues.has(intent.primaryVenue) ||
    !legVenues.has(intent.hedgeVenue)
  ) {
    conflicts.push("primaryVenue", "hedgeVenue");
  }
  for (const leg of intent.legs) {
    if (leg.intentId !== intent.id) {
      conflicts.push(`legs.${leg.id}.intentId`);
    }
  }
  if (conflicts.length > 0) {
    throw new PersistenceIdentityConflictError("order_intent", intent.id, conflicts);
  }
}

export function assertOrderIntentIdentity(existing: OrderIntent, incoming: OrderIntent) {
  assertValidOrderIntentIdentityShape(existing);
  assertValidOrderIntentIdentityShape(incoming);
  const conflicts = collectIdentityConflicts([
    ["id", existing.id, incoming.id],
    ["asset", existing.asset, incoming.asset],
    ["shadow", existing.shadow, incoming.shadow],
    ["slotKey", existing.slotKey, incoming.slotKey],
    ["slotStartTs", existing.slotStartTs, incoming.slotStartTs],
    ["slotEndTs", existing.slotEndTs, incoming.slotEndTs],
    ["combination", existing.combination, incoming.combination],
    ["createdAt", existing.createdAt, incoming.createdAt],
    ["primaryVenue", existing.primaryVenue, incoming.primaryVenue],
    ["hedgeVenue", existing.hedgeVenue, incoming.hedgeVenue],
  ]);

  const existingLegs = new Map(existing.legs.map((leg) => [leg.id, leg]));
  const incomingLegs = new Map(incoming.legs.map((leg) => [leg.id, leg]));
  if (existingLegs.size !== 2 || incomingLegs.size !== 2 || existingLegs.size !== incomingLegs.size) {
    conflicts.push("legs");
  } else {
    for (const [legId, existingLeg] of existingLegs) {
      const incomingLeg = incomingLegs.get(legId);
      if (!incomingLeg) {
        conflicts.push(`legs.${legId}`);
        continue;
      }
      conflicts.push(
        ...collectIdentityConflicts([
          [`legs.${legId}.id`, existingLeg.id, incomingLeg.id],
          [`legs.${legId}.intentId`, existingLeg.intentId, incomingLeg.intentId],
          [`legs.${legId}.venue`, existingLeg.venue, incomingLeg.venue],
          [`legs.${legId}.outcome`, existingLeg.outcome, incomingLeg.outcome],
          [`legs.${legId}.marketRef`, existingLeg.marketRef, incomingLeg.marketRef],
          [`legs.${legId}.tokenId`, existingLeg.tokenId ?? null, incomingLeg.tokenId ?? null],
          [`legs.${legId}.side`, existingLeg.side, incomingLeg.side],
        ]),
      );
    }
  }

  if (conflicts.length > 0) {
    throw new PersistenceIdentityConflictError("order_intent", existing.id, conflicts);
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

export function hashOrderAttemptRequest(request: Record<string, unknown>) {
  return createHash("sha256").update(canonicalizeJson(request), "utf8").digest("hex");
}

function canonicalizeJson(value: unknown, active = new Set<object>()): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Order request JSON numbers must be finite");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new Error(`Order request contains a non-JSON ${typeof value} value`);
  }
  if (active.has(value)) {
    throw new Error("Order request JSON must not contain cycles");
  }

  active.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalizeJson(item, active)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Order request JSON must contain only plain objects and arrays");
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(object[key], active)}`)
      .join(",")}}`;
  } finally {
    active.delete(value);
  }
}

function resolveOrderAttemptRequestHash(attempt: OrderAttempt) {
  const calculated = hashOrderAttemptRequest(attempt.request);
  if (attempt.requestSha256 !== undefined && attempt.requestSha256 !== null && attempt.requestSha256 !== calculated) {
    throw new PersistenceIdentityConflictError("order_attempt", attempt.id, ["requestSha256"]);
  }
  return calculated;
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
    resolveOrderAttemptRequestHash(attempt),
    attempt.submissionDeadlineAt ?? null,
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
    case "submitting":
      return 1;
    case "submitted":
      return 2;
    case "truth_pending":
      return 3;
    case "confirmed":
    case "failed":
      return 4;
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
    ["request", canonicalizeJson(existing.request), canonicalizeJson(incoming.request)],
    ["requestSha256", resolveOrderAttemptRequestHash(existing), resolveOrderAttemptRequestHash(incoming)],
  ]);
  if (
    incoming.submissionDeadlineAt !== undefined &&
    incoming.submissionDeadlineAt !== null &&
    (existing.submissionDeadlineAt ?? null) !== incoming.submissionDeadlineAt
  ) {
    conflicts.push("submissionDeadlineAt");
  }
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
    let locked = await client.query("SELECT * FROM venue_orders WHERE id = $1 FOR UPDATE", [order.id]);
    if (!locked.rows[0]) {
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
      locked = await client.query("SELECT * FROM venue_orders WHERE id = $1 FOR UPDATE", [order.id]);
    }
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
          venue_order_id, status, truth_status, request_json, request_sha256, submission_deadline_at,
          result_json, error, created_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14::jsonb, $15, $16, $17::jsonb, $18, $19, $20
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

export async function claimLiveOrderAttemptForSubmissionAtomically(
  pool: Pool,
  input: LiveOrderAttemptSubmissionInput,
): Promise<LiveOrderAttemptSubmissionDecision> {
  assertValidLiveOrderAttemptSubmissionInput(input);
  const requestSha256 = resolveOrderAttemptRequestHash(input.plannedAttempt);
  const plannedAttempt: OrderAttempt = {
    ...input.plannedAttempt,
    requestSha256,
    submissionDeadlineAt: input.submissionDeadlineAt,
  };

  return withRowLockTransaction(pool, async (client) => {
    await assertLiveOrderAttemptParentIdentity(client, plannedAttempt);
    const inserted = await client.query<OrderAttemptRow>(
      `
        INSERT INTO order_attempts (
          id, asset, shadow, intent_id, leg_id, stage, venue, side, order_type, client_order_id,
          venue_order_id, status, truth_status, request_json, request_sha256, submission_deadline_at,
          result_json, error, created_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14::jsonb, $15, $16, $17::jsonb, $18, $19, $20
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      `,
      orderAttemptParams(plannedAttempt),
    );
    const fresh = inserted.rowCount === 1;
    let storedRow = inserted.rows[0];
    if (!storedRow) {
      const existing = await client.query<OrderAttemptRow>(
        `
          SELECT *
          FROM order_attempts
          WHERE id = $1 OR (venue = $2 AND client_order_id = $3)
          FOR UPDATE
        `,
        [plannedAttempt.id, plannedAttempt.venue, plannedAttempt.clientOrderId],
      );
      if (existing.rows.length !== 1 || existing.rows[0]?.id !== plannedAttempt.id) {
        throw new PersistenceIdentityConflictError("order_attempt", plannedAttempt.id, ["id", "clientOrderId"]);
      }
      storedRow = existing.rows[0];
    }

    const storedAttempt = mapOrderAttemptRow(storedRow);
    assertReusableLiveOrderAttemptSubmissionProof(storedAttempt, plannedAttempt, input.submissionDeadlineAt);
    await assertAttemptIsOutsideInitialAdmission(client, storedAttempt);

    if (storedAttempt.venueOrderId !== null) {
      return {
        decision: "reusable",
        reason: "venue_order_recorded",
        attempt: storedAttempt,
      };
    }
    if (storedAttempt.status === "confirmed" && storedAttempt.result !== null) {
      return {
        decision: "reusable",
        reason: "confirmed_result_recorded",
        attempt: storedAttempt,
      };
    }
    if (
      storedAttempt.status === "failed" &&
      storedAttempt.truthStatus === "not_submitted" &&
      storedAttempt.error === "submission_deadline_expired"
    ) {
      return {
        decision: "rejected",
        reason: "submission_deadline_expired",
        attempt: storedAttempt,
      };
    }
    if (storedAttempt.status !== "planned") {
      return {
        decision: "ambiguous",
        reason: storedAttempt.status === "submitting" ? "submission_in_progress" : "submission_truth_unknown",
        attempt: storedAttempt,
      };
    }

    const claimed = await client.query<OrderAttemptRow>(
      `
        WITH claim_clock AS (
          SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
        )
        UPDATE order_attempts AS attempt
        SET status = 'submitting',
            truth_status = 'submission_in_progress',
            updated_at = GREATEST(attempt.updated_at, claim_clock.now_ms),
            revision = attempt.revision + 1
        FROM claim_clock
        WHERE attempt.id = $1
          AND attempt.status = 'planned'
          AND attempt.request_sha256 = $2
          AND attempt.request_json = $3::jsonb
          AND attempt.submission_deadline_at = $4
          AND claim_clock.now_ms < attempt.submission_deadline_at
        RETURNING attempt.*
      `,
      [plannedAttempt.id, requestSha256, JSON.stringify(plannedAttempt.request), input.submissionDeadlineAt],
    );
    const claimedRow = claimed.rows[0];
    if (claimedRow) {
      return {
        decision: "claimed",
        fresh,
        attempt: mapOrderAttemptRow(claimedRow),
      };
    }

    const rejected = await client.query<OrderAttemptRow>(
      `
        WITH rejection_clock AS (
          SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
        )
        UPDATE order_attempts AS attempt
        SET status = 'failed',
            truth_status = 'not_submitted',
            error = 'submission_deadline_expired',
            updated_at = GREATEST(attempt.updated_at, rejection_clock.now_ms),
            revision = attempt.revision + 1
        FROM rejection_clock
        WHERE attempt.id = $1
          AND attempt.status = 'planned'
          AND attempt.request_sha256 = $2
          AND attempt.request_json = $3::jsonb
          AND attempt.submission_deadline_at = $4
          AND rejection_clock.now_ms >= attempt.submission_deadline_at
        RETURNING attempt.*
      `,
      [plannedAttempt.id, requestSha256, JSON.stringify(plannedAttempt.request), input.submissionDeadlineAt],
    );
    const rejectedRow = rejected.rows[0];
    if (rejectedRow) {
      return {
        decision: "rejected",
        reason: "submission_deadline_expired",
        attempt: mapOrderAttemptRow(rejectedRow),
      };
    }

    const latest = await client.query<OrderAttemptRow>("SELECT * FROM order_attempts WHERE id = $1", [
      plannedAttempt.id,
    ]);
    const latestAttempt = latest.rows[0] ? mapOrderAttemptRow(latest.rows[0]) : storedAttempt;
    if (latestAttempt.status !== "planned") {
      return {
        decision: "ambiguous",
        reason: latestAttempt.status === "submitting" ? "submission_in_progress" : "submission_truth_unknown",
        attempt: latestAttempt,
      };
    }
    throw new LiveOrderAttemptSubmissionError(
      "claim_conflict",
      plannedAttempt.id,
      latestAttempt.status,
      "The durable planned attempt matched neither the claim nor deadline-rejection predicates",
    );
  });
}

export async function revalidateLiveOrderAttemptBeforeDispatchAtomically(
  pool: Pool,
  input: LiveOrderAttemptDispatchInput,
): Promise<LiveOrderAttemptDispatchDecision> {
  if (!input.intentId.trim() || !input.attemptId.trim()) {
    throw new LiveOrderAttemptSubmissionError(
      "invalid_planned_attempt",
      input.attemptId,
      null,
      "Final dispatch validation requires stable intent and attempt identifiers",
    );
  }
  if (!Number.isSafeInteger(input.submissionDeadlineAt) || input.submissionDeadlineAt < 0) {
    throw new LiveOrderAttemptSubmissionError(
      "submission_deadline_mismatch",
      input.attemptId,
      null,
      `Invalid final dispatch deadline ${input.submissionDeadlineAt}`,
    );
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new LiveOrderAttemptSubmissionError(
      "claim_conflict",
      input.attemptId,
      null,
      `Invalid final dispatch revision ${input.expectedRevision}`,
    );
  }

  const requestSha256 = hashOrderAttemptRequest(input.request);
  const requestJson = JSON.stringify(input.request);
  return withRowLockTransaction(pool, async (client) => {
    const locked = await client.query<
      OrderAttemptRow & {
        admission_intent_id: string | null;
        admission_mode: EntryAdmissionMode | null;
        admission_attempt_id: string | null;
        admission_request_sha256: string | null;
        admission_deadline_at: number | null;
        database_now: number;
      }
    >(
      `
        SELECT attempt.*,
               admission.intent_id AS admission_intent_id,
               admission.mode AS admission_mode,
               admission.attempt_id AS admission_attempt_id,
               admission.request_sha256 AS admission_request_sha256,
               admission.latest_submission_start_at AS admission_deadline_at,
               floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS database_now
        FROM order_attempts AS attempt
        LEFT JOIN entry_admissions AS admission ON admission.attempt_id = attempt.id
        WHERE attempt.id = $1
        FOR UPDATE OF attempt
      `,
      [input.attemptId],
    );
    const row = locked.rows[0];
    if (!row) {
      throw new LiveOrderAttemptSubmissionError(
        "claim_conflict",
        input.attemptId,
        null,
        "The claimed attempt disappeared before venue dispatch",
      );
    }

    const attempt = mapOrderAttemptRow(row);
    if (
      row.intent_id !== input.intentId ||
      row.shadow ||
      row.status !== "submitting" ||
      row.truth_status !== "submission_in_progress" ||
      Number(row.revision) !== input.expectedRevision
    ) {
      throw new LiveOrderAttemptSubmissionError(
        "claim_conflict",
        input.attemptId,
        row.status,
        `Final dispatch expected submitting revision ${input.expectedRevision}, found ${row.status} revision ${row.revision}`,
      );
    }
    if (
      row.request_sha256 !== requestSha256 ||
      canonicalizeJson(row.request_json ?? {}) !== canonicalizeJson(input.request)
    ) {
      throw new LiveOrderAttemptSubmissionError("request_proof_mismatch", input.attemptId, row.status);
    }

    const isAdmittedInitialAttempt = row.admission_attempt_id !== null;
    const durableDeadline = isAdmittedInitialAttempt ? row.admission_deadline_at : row.submission_deadline_at;
    if (
      durableDeadline === null ||
      Number(durableDeadline) !== input.submissionDeadlineAt ||
      (isAdmittedInitialAttempt &&
        (row.submission_deadline_at !== null ||
          row.admission_intent_id !== input.intentId ||
          row.admission_mode !== "live" ||
          row.admission_attempt_id !== input.attemptId ||
          row.admission_request_sha256 !== requestSha256)) ||
      (!isAdmittedInitialAttempt && row.submission_deadline_at !== input.submissionDeadlineAt)
    ) {
      throw new LiveOrderAttemptSubmissionError("submission_deadline_mismatch", input.attemptId, row.status);
    }

    if (Number(row.database_now) < input.submissionDeadlineAt) {
      return { decision: "ready", attempt };
    }

    const expired = await client.query<OrderAttemptRow>(
      `
        UPDATE order_attempts AS attempt
        SET status = 'failed',
            truth_status = 'not_submitted',
            error = 'submission_deadline_expired',
            updated_at = GREATEST(attempt.updated_at, $6),
            revision = attempt.revision + 1
        WHERE attempt.id = $1
          AND attempt.intent_id = $2
          AND attempt.shadow = false
          AND attempt.status = 'submitting'
          AND attempt.truth_status = 'submission_in_progress'
          AND attempt.request_sha256 = $3
          AND attempt.request_json = $4::jsonb
          AND attempt.revision = $5
          AND (
            (
              attempt.submission_deadline_at = $7
              AND NOT EXISTS (
                SELECT 1 FROM entry_admissions AS admission WHERE admission.attempt_id = attempt.id
              )
            ) OR (
              attempt.submission_deadline_at IS NULL
              AND EXISTS (
                SELECT 1
                FROM entry_admissions AS admission
                WHERE admission.intent_id = $2
                  AND admission.mode = 'live'
                  AND admission.attempt_id = attempt.id
                  AND admission.request_sha256 = $3
                  AND admission.latest_submission_start_at = $7
              )
            )
          )
        RETURNING attempt.*
      `,
      [
        input.attemptId,
        input.intentId,
        requestSha256,
        requestJson,
        input.expectedRevision,
        Number(row.database_now),
        input.submissionDeadlineAt,
      ],
    );
    const expiredRow = expired.rows[0];
    if (!expiredRow) {
      throw new LiveOrderAttemptSubmissionError(
        "claim_conflict",
        input.attemptId,
        row.status,
        "The final deadline transition lost its exact request/deadline/revision CAS",
      );
    }
    return {
      decision: "expired",
      reason: "submission_deadline_expired",
      attempt: mapOrderAttemptRow(expiredRow),
    };
  });
}

function assertValidLiveOrderAttemptSubmissionInput(input: LiveOrderAttemptSubmissionInput) {
  const attempt = input.plannedAttempt;
  if (!Number.isSafeInteger(input.submissionDeadlineAt) || input.submissionDeadlineAt < 0) {
    throw new LiveOrderAttemptSubmissionError(
      "invalid_planned_attempt",
      attempt.id,
      attempt.status,
      `Invalid submission deadline ${input.submissionDeadlineAt}`,
    );
  }
  if (attempt.stage === "primary") {
    throw new LiveOrderAttemptSubmissionError(
      "initial_attempt_requires_admission",
      attempt.id,
      attempt.status,
      "Initial primary attempts must use the entry-admission claim",
    );
  }
  if (
    attempt.shadow ||
    attempt.status !== "planned" ||
    attempt.venueOrderId !== null ||
    (attempt.truthStatus !== null && attempt.truthStatus !== "not_submitted") ||
    attempt.result !== null ||
    attempt.error !== null
  ) {
    throw new LiveOrderAttemptSubmissionError(
      "invalid_planned_attempt",
      attempt.id,
      attempt.status,
      "A generic live submission must start from a clean live planned attempt",
    );
  }
  if (
    !attempt.id.trim() ||
    !attempt.intentId.trim() ||
    !attempt.legId.trim() ||
    !attempt.stage.trim() ||
    !attempt.clientOrderId.trim() ||
    !attempt.orderType.trim() ||
    !Number.isSafeInteger(attempt.createdAt) ||
    !Number.isSafeInteger(attempt.updatedAt) ||
    attempt.createdAt < 0 ||
    attempt.updatedAt < attempt.createdAt
  ) {
    throw new LiveOrderAttemptSubmissionError(
      "invalid_planned_attempt",
      attempt.id,
      attempt.status,
      "A generic live submission requires stable identifiers and consistent timestamps",
    );
  }
  if (
    attempt.submissionDeadlineAt !== undefined &&
    attempt.submissionDeadlineAt !== null &&
    attempt.submissionDeadlineAt !== input.submissionDeadlineAt
  ) {
    throw new LiveOrderAttemptSubmissionError("submission_deadline_mismatch", attempt.id, attempt.status);
  }
}

async function assertLiveOrderAttemptParentIdentity(client: PoolClient, attempt: OrderAttempt) {
  const parent = await client.query<
    Pick<OrderIntentRow, "id" | "asset" | "shadow" | "status" | "primary_venue" | "hedge_venue" | "legs_json">
  >(
    `
      SELECT id, asset, shadow, status, primary_venue, hedge_venue, legs_json
      FROM order_intents
      WHERE id = $1
      FOR UPDATE
    `,
    [attempt.intentId],
  );
  const intent = parent.rows[0];
  const policy = resolveLiveOrderAttemptStagePolicy(attempt);
  const expectedVenue = policy.legRole === "primary" ? intent?.primary_venue : intent?.hedge_venue;
  const leg = intent?.legs_json.find(
    (candidate) => candidate.id === attempt.legId && candidate.venue === expectedVenue,
  );
  const request = attempt.request;
  const expectedTokenId = leg?.tokenId ?? null;
  const requestTokenId = request.tokenId === undefined ? null : request.tokenId;
  if (
    !intent ||
    intent.shadow ||
    intent.asset !== attempt.asset ||
    !policy.allowedStatuses.includes(intent.status) ||
    attempt.venue !== expectedVenue ||
    attempt.side !== policy.side ||
    !leg ||
    leg.intentId !== intent.id ||
    leg.venue !== attempt.venue ||
    request.marketRef !== leg.marketRef ||
    requestTokenId !== expectedTokenId ||
    request.outcome !== leg.outcome ||
    request.side !== policy.side ||
    request.reduceOnly !== policy.reduceOnly ||
    request.orderType !== attempt.orderType ||
    request.clientOrderId !== attempt.clientOrderId
  ) {
    throw new LiveOrderAttemptSubmissionError(
      "invalid_planned_attempt",
      attempt.id,
      attempt.status,
      `The ${attempt.stage} order attempt does not match its live parent status, leg, or canonical request identity`,
    );
  }
}

function resolveLiveOrderAttemptStagePolicy(attempt: Pick<OrderAttempt, "id" | "stage" | "status">): {
  legRole: "primary" | "hedge";
  allowedStatuses: readonly OrderIntent["status"][];
  side: OrderAttempt["side"];
  reduceOnly: boolean;
} {
  if (attempt.stage === "hedge") {
    return {
      legRole: "hedge",
      allowedStatuses: ["primary_filled"],
      side: "BUY",
      reduceOnly: false,
    };
  }
  if (/^hedge_retry:[1-9]\d*$/.test(attempt.stage)) {
    return {
      legRole: "hedge",
      allowedStatuses: ["hedging"],
      side: "BUY",
      reduceOnly: false,
    };
  }
  if (/^hedge_rescue:[1-9]\d*$/.test(attempt.stage)) {
    return {
      legRole: "hedge",
      allowedStatuses: ["rescue_hedge"],
      side: "BUY",
      reduceOnly: false,
    };
  }
  if (/^primary_unwind(?:_forced)?:[1-9]\d*$/.test(attempt.stage)) {
    return {
      legRole: "primary",
      allowedStatuses: ["unwind_required", "rescue_hedge"],
      side: "SELL",
      reduceOnly: true,
    };
  }
  throw new LiveOrderAttemptSubmissionError(
    "invalid_planned_attempt",
    attempt.id,
    attempt.status,
    `Unsupported live recovery order stage ${attempt.stage}`,
  );
}

function assertReusableLiveOrderAttemptSubmissionProof(
  existing: OrderAttempt,
  plannedAttempt: OrderAttempt,
  submissionDeadlineAt: number,
) {
  const requestSha256 = hashOrderAttemptRequest(plannedAttempt.request);
  if (
    existing.requestSha256 !== requestSha256 ||
    hashOrderAttemptRequest(existing.request) !== requestSha256 ||
    canonicalizeJson(existing.request) !== canonicalizeJson(plannedAttempt.request)
  ) {
    throw new LiveOrderAttemptSubmissionError("request_proof_mismatch", plannedAttempt.id, existing.status);
  }
  if (existing.submissionDeadlineAt !== submissionDeadlineAt) {
    throw new LiveOrderAttemptSubmissionError("submission_deadline_mismatch", plannedAttempt.id, existing.status);
  }
  assertOrderAttemptIdentity(existing, plannedAttempt);
}

async function assertAttemptIsOutsideInitialAdmission(client: PoolClient, attempt: OrderAttempt) {
  const linkedAdmission = await client.query<{ intent_id: string }>(
    "SELECT intent_id FROM entry_admissions WHERE attempt_id = $1 LIMIT 1",
    [attempt.id],
  );
  if (linkedAdmission.rows[0]) {
    throw new LiveOrderAttemptSubmissionError(
      "initial_attempt_requires_admission",
      attempt.id,
      attempt.status,
      `Attempt is linked to entry admission ${linkedAdmission.rows[0].intent_id}`,
    );
  }
}

export async function claimAdmittedLiveOrderAttemptAtomically(
  pool: Pool,
  input: LiveOrderAttemptClaimInput,
): Promise<OrderAttempt> {
  if (!input.intentId || !input.attemptId) {
    throw new Error("Live order attempt claim requires intentId and attemptId");
  }
  if (!Number.isSafeInteger(input.claimedAt) || input.claimedAt < 0) {
    throw new Error(`Invalid live order attempt claimedAt: ${input.claimedAt}`);
  }

  const requestSha256 = hashOrderAttemptRequest(input.request);
  const requestJson = JSON.stringify(input.request);
  return withRowLockTransaction(pool, async (client) => {
    await acquireAccountingTransactionLock(client);
    const { attempt, admission } = await lockLiveOrderAttemptClaimContext(client, input, requestSha256);
    const accountingBacklog = await getLiveAccountingBacklog(client);
    if (accountingBacklog.total > 0) {
      throw new LiveOrderAttemptClaimError(
        "accounting_backlog",
        input.intentId,
        input.attemptId,
        attempt.status,
        `Live accounting backlog has ${accountingBacklog.missingHeads} missing heads, ${accountingBacklog.legacyPending} legacy pending, ${accountingBacklog.quarantined} quarantined, and ${accountingBacklog.terminalOpen} terminal-without-accounting intent(s)`,
      );
    }
    await assertLiveOrderAttemptClaimAuthorization(client, input, attempt, admission);

    const claimed = await client.query<OrderAttemptRow>(
      `
        WITH claim_clock AS (
          SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
        )
        UPDATE order_attempts AS attempt
        SET status = 'submitting',
            truth_status = 'submission_in_progress',
            updated_at = GREATEST(attempt.updated_at, claim_clock.now_ms),
            revision = attempt.revision + 1
        FROM entry_admissions AS admission, claim_clock
        WHERE attempt.id = $1
          AND attempt.intent_id = $2
          AND attempt.shadow = false
          AND attempt.status = 'planned'
          AND attempt.truth_status = 'admitted_not_claimed'
          AND attempt.request_sha256 = $3
          AND attempt.request_json = $4::jsonb
          AND admission.mode = 'live'
          AND admission.intent_id = $2
          AND admission.attempt_id = attempt.id
          AND admission.request_sha256 = $3
          AND admission.request_sha256 = attempt.request_sha256
          AND claim_clock.now_ms < admission.latest_submission_start_at
        RETURNING attempt.*
      `,
      [input.attemptId, input.intentId, requestSha256, requestJson],
    );
    const claimedRow = claimed.rows[0];
    if (claimedRow) {
      return mapOrderAttemptRow(claimedRow);
    }

    await throwLiveOrderAttemptClaimFailure(client, input, requestSha256);
    throw new LiveOrderAttemptClaimError("claim_conflict", input.intentId, input.attemptId);
  });
}

async function lockLiveOrderAttemptClaimContext(
  client: PoolClient,
  input: LiveOrderAttemptClaimInput,
  requestSha256: string,
) {
  const attemptResult = await client.query<OrderAttemptRow>("SELECT * FROM order_attempts WHERE id = $1 FOR UPDATE", [
    input.attemptId,
  ]);
  const attempt = attemptResult.rows[0];
  if (!attempt) {
    throw new LiveOrderAttemptClaimError("attempt_not_found", input.intentId, input.attemptId);
  }
  if (attempt.intent_id !== input.intentId) {
    throw new LiveOrderAttemptClaimError("attempt_intent_mismatch", input.intentId, input.attemptId, attempt.status);
  }
  if (attempt.shadow) {
    throw new LiveOrderAttemptClaimError("attempt_not_live", input.intentId, input.attemptId, attempt.status);
  }

  const admissionResult = await client.query<EntryAdmissionRow>("SELECT * FROM entry_admissions WHERE intent_id = $1", [
    input.intentId,
  ]);
  const admission = admissionResult.rows[0];
  if (!admission) {
    throw new LiveOrderAttemptClaimError("admission_not_found", input.intentId, input.attemptId, attempt.status);
  }
  if (admission.mode !== "live") {
    throw new LiveOrderAttemptClaimError("admission_not_live", input.intentId, input.attemptId, attempt.status);
  }
  if (admission.attempt_id !== input.attemptId) {
    throw new LiveOrderAttemptClaimError("admission_attempt_mismatch", input.intentId, input.attemptId, attempt.status);
  }
  if (
    attempt.request_sha256 !== requestSha256 ||
    admission.request_sha256 !== requestSha256 ||
    canonicalizeJson(attempt.request_json ?? {}) !== canonicalizeJson(input.request)
  ) {
    throw new LiveOrderAttemptClaimError("request_mismatch", input.intentId, input.attemptId, attempt.status);
  }
  if (attempt.status === "submitting") {
    throw new LiveOrderAttemptClaimError("attempt_already_claimed", input.intentId, input.attemptId, attempt.status);
  }
  if (attempt.status !== "planned") {
    throw new LiveOrderAttemptClaimError("attempt_not_planned", input.intentId, input.attemptId, attempt.status);
  }

  return { attempt, admission };
}

async function assertLiveOrderAttemptClaimAuthorization(
  client: PoolClient,
  input: LiveOrderAttemptClaimInput,
  attempt: OrderAttemptRow,
  admission: EntryAdmissionRow,
) {
  const configuration = await lockEntryAdmissionConfiguration(client, admission.asset);
  if (configuration.strategy.revision !== Number(admission.strategy_revision)) {
    throw new LiveOrderAttemptClaimError(
      "strategy_revision_changed",
      input.intentId,
      input.attemptId,
      attempt.status,
      `expected revision ${admission.strategy_revision}, found ${configuration.strategy.revision}`,
    );
  }
  if (configuration.globalRisk.revision !== Number(admission.global_risk_revision)) {
    throw new LiveOrderAttemptClaimError(
      "global_risk_revision_changed",
      input.intentId,
      input.attemptId,
      attempt.status,
      `expected revision ${admission.global_risk_revision}, found ${configuration.globalRisk.revision}`,
    );
  }
  if (
    configuration.mismatchCalibration.revision !== Number(admission.mismatch_calibration_revision) ||
    configuration.mismatchCalibration.artifactId !== admission.mismatch_calibration_artifact_id
  ) {
    throw new LiveOrderAttemptClaimError(
      "mismatch_calibration_revision_changed",
      input.intentId,
      input.attemptId,
      attempt.status,
      `expected revision ${admission.mismatch_calibration_revision} and artifact ${admission.mismatch_calibration_artifact_id ?? "none"}, found revision ${configuration.mismatchCalibration.revision} and artifact ${configuration.mismatchCalibration.artifactId ?? "none"}`,
    );
  }
  if (!configuration.strategy.config.enableTrading) {
    throw new LiveOrderAttemptClaimError(
      "trading_disabled",
      input.intentId,
      input.attemptId,
      attempt.status,
      `Trading is disabled for ${admission.asset}`,
    );
  }
  if (configuration.strategy.config.shadowMode) {
    throw new LiveOrderAttemptClaimError(
      "execution_mode_mismatch",
      input.intentId,
      input.attemptId,
      attempt.status,
      `Strategy configuration for ${admission.asset} is shadow, not live`,
    );
  }

  const activeBreakers = await lockRelevantEntryBreakers(client, admission.asset, admission.slot_key);
  if (activeBreakers.length > 0) {
    throw new LiveOrderAttemptClaimError(
      "circuit_breaker_active",
      input.intentId,
      input.attemptId,
      attempt.status,
      `Active circuit breaker blocks claim: ${activeBreakers.map((breaker) => breaker.key).join(", ")}`,
    );
  }
}

async function throwLiveOrderAttemptClaimFailure(
  client: PoolClient,
  input: LiveOrderAttemptClaimInput,
  requestSha256: string,
): Promise<never> {
  const attemptResult = await client.query<OrderAttemptRow>("SELECT * FROM order_attempts WHERE id = $1", [
    input.attemptId,
  ]);
  const attempt = attemptResult.rows[0];
  if (!attempt) {
    throw new LiveOrderAttemptClaimError("attempt_not_found", input.intentId, input.attemptId);
  }
  if (attempt.intent_id !== input.intentId) {
    throw new LiveOrderAttemptClaimError("attempt_intent_mismatch", input.intentId, input.attemptId, attempt.status);
  }
  if (attempt.shadow) {
    throw new LiveOrderAttemptClaimError("attempt_not_live", input.intentId, input.attemptId, attempt.status);
  }

  const admissionResult = await client.query<EntryAdmissionRow & { database_now: number }>(
    `
      SELECT admission.*,
             floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS database_now
      FROM entry_admissions AS admission
      WHERE intent_id = $1
    `,
    [input.intentId],
  );
  const admission = admissionResult.rows[0];
  if (!admission) {
    throw new LiveOrderAttemptClaimError("admission_not_found", input.intentId, input.attemptId, attempt.status);
  }
  if (admission.mode !== "live") {
    throw new LiveOrderAttemptClaimError("admission_not_live", input.intentId, input.attemptId, attempt.status);
  }
  if (admission.attempt_id !== input.attemptId) {
    throw new LiveOrderAttemptClaimError("admission_attempt_mismatch", input.intentId, input.attemptId, attempt.status);
  }
  if (
    attempt.request_sha256 !== requestSha256 ||
    admission.request_sha256 !== requestSha256 ||
    canonicalizeJson(attempt.request_json ?? {}) !== canonicalizeJson(input.request)
  ) {
    throw new LiveOrderAttemptClaimError("request_mismatch", input.intentId, input.attemptId, attempt.status);
  }
  if (attempt.status === "submitting") {
    throw new LiveOrderAttemptClaimError("attempt_already_claimed", input.intentId, input.attemptId, attempt.status);
  }
  if (attempt.status !== "planned") {
    throw new LiveOrderAttemptClaimError("attempt_not_planned", input.intentId, input.attemptId, attempt.status);
  }
  if (admission.latest_submission_start_at !== null && admission.database_now >= admission.latest_submission_start_at) {
    throw new LiveOrderAttemptClaimError(
      "submission_capability_expired",
      input.intentId,
      input.attemptId,
      attempt.status,
    );
  }
  throw new LiveOrderAttemptClaimError("claim_conflict", input.intentId, input.attemptId, attempt.status);
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

/** Characterizes the pre-ledger V2 projection. Runtime callers must use ingestVenueFillAtomically. */
export async function upsertLegacyFillProjection(pool: Pool, fill: LiveFill) {
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

export type IngestVenueFillAccountingInput = {
  context: AccountingMutationContext;
  expectedHeadRevision: number;
  legId: string;
  finality: AccountingFillEvidence["finality"];
  fill: LiveFill;
};

export type CloseIntentWithoutExposureInput = {
  context: AccountingMutationContext;
  expectedHeadRevision: number;
  expectedIntentRevision: number;
  terminalIntent: OrderIntent;
  proof: Record<string, unknown>;
};

export type FinalizeIntentAccountingInput = {
  context: AccountingMutationContext;
  expectedHeadRevision: number;
  expectedIntentRevision: number;
  terminalIntent: OrderIntent;
  ledgerInput: AccountingLedgerInput;
  stability: Record<string, unknown>;
};

export type ReaccountIntentInput = FinalizeIntentAccountingInput;

export type AccountingPersistenceErrorCode =
  | "invalid_input"
  | "head_not_found"
  | "revision_conflict"
  | "request_conflict"
  | "state_conflict"
  | "identity_conflict"
  | "exposure_present"
  | "unresolved_submission";

export class AccountingPersistenceError extends Error {
  constructor(
    public readonly code: AccountingPersistenceErrorCode,
    message: string,
    public readonly intentId: string | null = null,
  ) {
    super(message);
    this.name = "AccountingPersistenceError";
  }
}

export async function acquireAccountingTransactionLock(db: PgQueryable) {
  await db.query("SELECT pg_advisory_xact_lock($1, $2)", [ACCOUNTING_LOCK_NAMESPACE, ACCOUNTING_LOCK_KEY]);
}

export async function getAccountingHead(pool: Pool, intentId: string): Promise<AccountingHead | null> {
  const result = await pool.query<AccountingHeadRow>("SELECT * FROM accounting_heads WHERE intent_id = $1", [intentId]);
  return result.rows[0] ? mapAccountingHeadRow(result.rows[0]) : null;
}

export async function listHistoricalTerminalLegacyPendingIntentIds(
  pool: PgQueryable,
  intentIds: readonly string[],
): Promise<string[]> {
  const uniqueIntentIds = [...new Set(intentIds.map((intentId) => intentId.trim()).filter(Boolean))];
  if (uniqueIntentIds.length === 0) {
    return [];
  }
  if (uniqueIntentIds.length > 1_000) {
    throw new AccountingPersistenceError(
      "invalid_input",
      `Historical accounting lookup is limited to 1000 intents, received ${uniqueIntentIds.length}`,
    );
  }

  const result = await pool.query<{ intent_id: string }>(
    `
      WITH accounting_clock AS (
        SELECT floor(extract(epoch FROM (
          date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        )) * 1000)::bigint AS utc_day_start
      )
      SELECT intent.id AS intent_id
      FROM order_intents AS intent
      JOIN accounting_heads AS head ON head.intent_id = intent.id
      CROSS JOIN accounting_clock
      WHERE intent.id = ANY($1::text[])
        AND intent.status IN ('settled', 'unwound', 'failed', 'skipped', 'canceled')
        AND COALESCE(intent.resolved_at, intent.slot_end_ts) < accounting_clock.utc_day_start
        AND head.state = 'legacy_pending'
      ORDER BY intent.id ASC
    `,
    [uniqueIntentIds],
  );
  return result.rows.map((row) => row.intent_id);
}

export async function listAccountingFillEvidenceForIntent(
  pool: PgQueryable,
  intentId: string,
): Promise<AccountingFillEvidence[]> {
  if (!intentId.trim()) {
    throw new AccountingPersistenceError("invalid_input", "Accounting fill evidence requires an intent id");
  }
  const rows = await loadAccountingFillFactRows(pool, "WHERE fact.intent_id = $1", [intentId]);
  return rows.map(mapAccountingFillFactRow);
}

export async function getLiveAccountingBacklog(pool: PgQueryable): Promise<AccountingBacklogSummary> {
  const result = await pool.query<{
    total: number;
    missing_heads: number;
    legacy_pending: number;
    quarantined: number;
    terminal_open: number;
    historical_legacy_pending: number;
    oldest_intent_id: string | null;
  }>(`
    WITH accounting_clock AS (
      SELECT floor(extract(epoch FROM (
        date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      )) * 1000)::bigint AS utc_day_start
    ), classified AS (
      SELECT
        intent.id AS intent_id,
        COALESCE(head.state, 'missing') AS state,
        intent.created_at,
        CASE
          WHEN head.intent_id IS NULL THEN true
          WHEN head.state = 'quarantined' THEN true
          WHEN head.state = 'open'
            AND intent.status IN ('unwound', 'settled', 'failed', 'skipped', 'canceled') THEN true
          WHEN head.state = 'legacy_pending' THEN
            intent.status NOT IN ('unwound', 'settled', 'failed', 'skipped', 'canceled')
            OR COALESCE(intent.resolved_at, intent.slot_end_ts) >= accounting_clock.utc_day_start
            OR EXISTS (
              SELECT 1 FROM fills AS mismatched_fill
              WHERE mismatched_fill.intent_id = intent.id
                AND (
                  mismatched_fill.asset IS DISTINCT FROM intent.asset
                  OR mismatched_fill.shadow IS DISTINCT FROM intent.shadow
                )
            )
            OR EXISTS (
              SELECT 1 FROM venue_orders AS mismatched_order
              WHERE mismatched_order.intent_id = intent.id
                AND (
                  mismatched_order.asset IS DISTINCT FROM intent.asset
                  OR mismatched_order.shadow IS DISTINCT FROM intent.shadow
                )
            )
            OR EXISTS (
              SELECT 1 FROM order_attempts AS mismatched_attempt
              WHERE mismatched_attempt.intent_id = intent.id
                AND (
                  mismatched_attempt.asset IS DISTINCT FROM intent.asset
                  OR mismatched_attempt.shadow IS DISTINCT FROM intent.shadow
                )
            )
            OR EXISTS (
              SELECT 1 FROM venue_orders AS pending_order
              WHERE pending_order.intent_id = intent.id
                AND pending_order.status IN ('pending', 'live', 'partially_filled')
            )
            OR EXISTS (
              SELECT 1 FROM order_attempts AS unresolved_attempt
              WHERE unresolved_attempt.intent_id = intent.id
                AND (
                  unresolved_attempt.status IN ('planned', 'submitting', 'submitted', 'truth_pending')
                  OR unresolved_attempt.status = 'failed'
                    AND unresolved_attempt.truth_status IS DISTINCT FROM 'not_submitted'
                  OR unresolved_attempt.status = 'failed'
                    AND unresolved_attempt.truth_status = 'not_submitted'
                    AND (
                      unresolved_attempt.venue_order_id IS NOT NULL
                      OR unresolved_attempt.result_json IS NOT NULL
                      OR EXISTS (
                        SELECT 1
                        FROM venue_orders AS linked_order
                        WHERE linked_order.intent_id = unresolved_attempt.intent_id
                          AND linked_order.venue = unresolved_attempt.venue
                          AND (
                            linked_order.venue_order_id = unresolved_attempt.venue_order_id
                            OR linked_order.client_order_id = unresolved_attempt.client_order_id
                          )
                      )
                    )
                  OR unresolved_attempt.status = 'confirmed'
                    AND NOT COALESCE(
                      unresolved_attempt.venue_order_id IS NOT NULL
                      AND unresolved_attempt.truth_status IS NOT NULL
                      AND lower(btrim(unresolved_attempt.truth_status)) IN (
                        'pending', 'live', 'filled', 'partially_filled',
                        'canceled', 'expired', 'rejected', 'terminal_zero_fill'
                      )
                      AND jsonb_typeof(unresolved_attempt.result_json) = 'object'
                      AND jsonb_typeof(unresolved_attempt.result_json -> 'venue') = 'string'
                      AND unresolved_attempt.result_json ->> 'venue' = unresolved_attempt.venue
                      AND jsonb_typeof(unresolved_attempt.result_json -> 'venueOrderId') = 'string'
                      AND unresolved_attempt.result_json ->> 'venueOrderId' = unresolved_attempt.venue_order_id
                      AND CASE
                        WHEN jsonb_typeof(unresolved_attempt.result_json -> 'status') = 'string'
                          AND jsonb_typeof(unresolved_attempt.result_json -> 'filledSize') = 'number'
                        THEN
                          lower(btrim(unresolved_attempt.result_json ->> 'status')) IN (
                            'pending', 'live', 'filled', 'partially_filled',
                            'canceled', 'expired', 'rejected'
                          )
                          AND (unresolved_attempt.result_json ->> 'filledSize')::numeric >= 0
                          AND (
                            lower(btrim(unresolved_attempt.result_json ->> 'status'))
                              NOT IN ('filled', 'partially_filled')
                            OR (unresolved_attempt.result_json ->> 'filledSize')::numeric > 0
                          )
                          AND (
                            lower(btrim(unresolved_attempt.truth_status)) =
                              lower(btrim(unresolved_attempt.result_json ->> 'status'))
                            OR lower(btrim(unresolved_attempt.truth_status)) = 'terminal_zero_fill'
                              AND lower(btrim(unresolved_attempt.result_json ->> 'status'))
                                IN ('canceled', 'expired', 'rejected')
                              AND (unresolved_attempt.result_json ->> 'filledSize')::numeric <= 0.000001
                          )
                        ELSE false
                      END
                      AND EXISTS (
                        SELECT 1
                        FROM venue_orders AS durable_order
                        WHERE durable_order.intent_id = unresolved_attempt.intent_id
                          AND durable_order.asset = unresolved_attempt.asset
                          AND durable_order.shadow = unresolved_attempt.shadow
                          AND durable_order.venue = unresolved_attempt.venue
                          AND durable_order.venue_order_id = unresolved_attempt.venue_order_id
                          AND durable_order.client_order_id IS NOT DISTINCT FROM
                            unresolved_attempt.client_order_id
                          AND durable_order.side = unresolved_attempt.side
                          AND durable_order.order_type = unresolved_attempt.order_type
                          AND durable_order.market_ref IS NOT DISTINCT FROM
                            unresolved_attempt.request_json ->> 'marketRef'
                          AND durable_order.token_id IS NOT DISTINCT FROM
                            NULLIF(unresolved_attempt.request_json ->> 'tokenId', '')
                          AND durable_order.outcome IS NOT DISTINCT FROM
                            unresolved_attempt.request_json ->> 'outcome'
                          AND CASE
                            WHEN jsonb_typeof(unresolved_attempt.result_json -> 'filledSize') = 'number'
                            THEN durable_order.filled_size + 0.000001 >=
                              (unresolved_attempt.result_json ->> 'filledSize')::numeric
                            ELSE false
                          END
                      ),
                      false
                    )
                )
            )
            OR intent.status IN ('failed', 'skipped', 'canceled') AND (
              EXISTS (SELECT 1 FROM fills AS legacy_fill WHERE legacy_fill.intent_id = intent.id)
              OR EXISTS (
                SELECT 1 FROM venue_orders AS filled_order
                WHERE filled_order.intent_id = intent.id
                  AND (
                    filled_order.filled_size > 0
                    OR filled_order.status = 'filled'
                    OR filled_order.requested_size::text IN ('NaN', 'Infinity', '-Infinity')
                    OR filled_order.requested_size <= 0
                    OR filled_order.filled_size::text IN ('NaN', 'Infinity', '-Infinity')
                    OR filled_order.filled_size < 0
                    OR filled_order.filled_size > filled_order.requested_size + 0.000001
                  )
              )
            )
          ELSE false
        END AS blocking
      FROM order_intents AS intent
      LEFT JOIN accounting_heads AS head ON head.intent_id = intent.id
      CROSS JOIN accounting_clock
      WHERE intent.shadow = false
        AND (
          head.intent_id IS NULL
          OR head.state IN ('legacy_pending', 'quarantined')
          OR head.state = 'open'
            AND intent.status IN ('unwound', 'settled', 'failed', 'skipped', 'canceled')
        )
    )
    SELECT
      count(*) FILTER (WHERE blocking)::integer AS total,
      count(*) FILTER (WHERE blocking AND state = 'missing')::integer AS missing_heads,
      count(*) FILTER (WHERE blocking AND state = 'legacy_pending')::integer AS legacy_pending,
      count(*) FILTER (WHERE blocking AND state = 'quarantined')::integer AS quarantined,
      count(*) FILTER (WHERE blocking AND state = 'open')::integer AS terminal_open,
      count(*) FILTER (WHERE NOT blocking AND state = 'legacy_pending')::integer AS historical_legacy_pending,
      (array_agg(intent_id ORDER BY created_at ASC, intent_id ASC) FILTER (WHERE blocking))[1]
        AS oldest_intent_id
    FROM classified
  `);
  const row = result.rows[0];
  return {
    total: Number(row?.total ?? 0),
    missingHeads: Number(row?.missing_heads ?? 0),
    legacyPending: Number(row?.legacy_pending ?? 0),
    quarantined: Number(row?.quarantined ?? 0),
    terminalOpen: Number(row?.terminal_open ?? 0),
    historicalLegacyPending: Number(row?.historical_legacy_pending ?? 0),
    oldestIntentId: row?.oldest_intent_id ?? null,
  };
}

export async function ingestVenueFillAtomically(
  pool: Pool,
  input: IngestVenueFillAccountingInput,
): Promise<AccountingFillIngestionDecision> {
  assertAccountingMutationContext(input.context);
  assertExpectedAccountingHeadRevision(input.expectedHeadRevision);
  if (!input.legId.trim() || !["final", "non_final", "ambiguous"].includes(input.finality)) {
    throw new AccountingPersistenceError("invalid_input", "Fill accounting requires a leg id and finality");
  }
  if (input.fill.intentId === "" || input.fill.id === "") {
    throw new AccountingPersistenceError("invalid_input", "Fill accounting requires stable fill and intent ids");
  }

  const requestPayload = {
    operation: "ingest_fill" as const,
    actor: input.context.actor,
    occurredAt: input.context.occurredAt,
    expectedHeadRevision: input.expectedHeadRevision,
    legId: input.legId,
    finality: input.finality,
    fill: canonicalAccountingFillForRequest(input.fill),
  };
  const requestSha256 = hashAccountingPayload(requestPayload);

  return withAccountingTransaction(pool, async (client) => {
    const replay = await loadAccountingRequestReplay<AccountingFillIngestionDecision>(
      client,
      input.context.requestId,
      "ingest_fill",
      input.fill.intentId,
      requestSha256,
    );
    if (replay) {
      return { ...replay, decision: "replayed" } as AccountingFillIngestionDecision;
    }

    const recordedAt = await readAccountingDatabaseClock(client, input.context);
    const { head, intent } = await lockAccountingParent(client, input.fill.intentId, input.expectedHeadRevision);
    const leg = await ensureAccountingLegs(client, intent, recordedAt, input.legId);
    assertAccountingFillParent(input.fill, input.legId, intent, leg);

    const fillConflict = await insertLegacyFillForAccounting(client, input);
    if (fillConflict) {
      return quarantineAccountingFill(client, input, head, intent, fillConflict, requestSha256, recordedAt);
    }

    const fact = buildAccountingFillFact(input, recordedAt);
    const factResult = await insertAccountingFillFact(client, fact, input.context);
    if (factResult.conflict) {
      return quarantineAccountingFill(client, input, head, intent, factResult.conflict, requestSha256, recordedAt);
    }

    if (head.state === "stable" || head.state === "no_exposure" || head.state === "quarantined") {
      return quarantineAccountingFill(
        client,
        input,
        head,
        intent,
        head.state === "no_exposure" ? "head_already_closed" : "late_terminal_fill",
        requestSha256,
        recordedAt,
      );
    }

    const result: AccountingFillIngestionDecision = {
      decision: "recorded",
      head: mapAccountingHeadRow(head),
      factSha256: factResult.factSha256,
    };
    await insertAccountingMutationRequest(
      client,
      input.context,
      "ingest_fill",
      input.fill.intentId,
      requestSha256,
      input.expectedHeadRevision,
      result,
      recordedAt,
    );
    return result;
  });
}

export async function closeIntentWithoutExposureAtomically(
  pool: Pool,
  input: CloseIntentWithoutExposureInput,
): Promise<AccountingMutationResult> {
  assertAccountingMutationContext(input.context);
  assertExpectedAccountingHeadRevision(input.expectedHeadRevision);
  assertExpectedOrderIntentRevision(input.expectedIntentRevision, input.terminalIntent);
  const intentId = input.terminalIntent.id;
  if (!intentId.trim() || !isPlainJsonObject(input.proof)) {
    throw new AccountingPersistenceError("invalid_input", "No-exposure closure requires an intent and proof");
  }
  if (!(["failed", "skipped", "canceled"] as readonly OrderIntent["status"][]).includes(input.terminalIntent.status)) {
    throw new AccountingPersistenceError(
      "invalid_input",
      `No-exposure closure requires failed, skipped, or canceled terminal state, received ${input.terminalIntent.status}`,
      intentId,
    );
  }
  assertNoExposureTerminalProjection(input.terminalIntent);
  const proofSha256 = hashAccountingPayload(input.proof);
  const requestSha256 = hashAccountingPayload({
    operation: "close_no_exposure",
    actor: input.context.actor,
    occurredAt: input.context.occurredAt,
    expectedHeadRevision: input.expectedHeadRevision,
    expectedIntentRevision: input.expectedIntentRevision,
    terminalIntentSha256: hashAccountingPayload(input.terminalIntent),
    intentId,
    proofSha256,
  });

  return withAccountingTransaction(pool, async (client) => {
    const replay = await loadAccountingRequestReplay<AccountingMutationResult>(
      client,
      input.context.requestId,
      "close_no_exposure",
      intentId,
      requestSha256,
    );
    if (replay) {
      return { ...replay, replayed: true };
    }
    const recordedAt = await readAccountingDatabaseClock(client, input.context);
    const { head, intent } = await lockAccountingParent(client, intentId, input.expectedHeadRevision);
    assertLockedIntentRevision(intent, input.expectedIntentRevision);
    assertOrderIntentIdentity(mapOrderIntentRow(intent), input.terminalIntent);
    assertAccountingTerminalTransition(intent.status, input.terminalIntent.status, "close_no_exposure", intentId);
    if (head.state !== "open" && head.state !== "legacy_pending" && head.state !== "quarantined") {
      throw new AccountingPersistenceError(
        "state_conflict",
        `Accounting head ${intentId} is ${head.state}, not closable without exposure`,
        intentId,
      );
    }
    await assertNoDurableAccountingExposure(client, intentId);

    await client.query(
      `
        INSERT INTO accounting_no_exposure_closures (
          intent_id, request_id, actor, proof_sha256, proof_json, closed_at, recorded_at
        ) VALUES ($1, $2::uuid, $3, $4, $5::jsonb, $6, $7)
      `,
      [
        intentId,
        input.context.requestId,
        input.context.actor,
        proofSha256,
        JSON.stringify(input.proof),
        input.context.occurredAt,
        recordedAt,
      ],
    );
    const updatedHead = await updateAccountingHead(client, head, "no_exposure", null, null, recordedAt);
    await updateTerminalOrderIntentForAccounting(client, intent, input.terminalIntent, 0, null, recordedAt);
    const result: AccountingMutationResult = {
      replayed: false,
      head: mapAccountingHeadRow(updatedHead),
      version: null,
      proofSha256,
    };
    await insertAccountingMutationRequest(
      client,
      input.context,
      "close_no_exposure",
      intentId,
      requestSha256,
      input.expectedHeadRevision,
      result,
      recordedAt,
    );
    return result;
  });
}

export async function finalizeIntentAccountingAtomically(
  pool: Pool,
  input: FinalizeIntentAccountingInput,
): Promise<AccountingMutationResult> {
  return persistIntentAccountingVersion(pool, "finalize", input);
}

export async function reaccountIntentAtomically(
  pool: Pool,
  input: ReaccountIntentInput,
): Promise<AccountingMutationResult> {
  return persistIntentAccountingVersion(pool, "reaccount", input);
}

export async function sumAccountingRealizedPnlForUtcDay(
  pool: Pool,
  dayStart: number,
  shadow = false,
): Promise<{ units: string; usd: number; entries: number }> {
  if (!Number.isSafeInteger(dayStart) || dayStart < 0 || dayStart % 86_400_000 !== 0) {
    throw new AccountingPersistenceError("invalid_input", "dayStart must be an exact UTC day boundary");
  }
  const result = await pool.query<{ units: string; entries: number }>(
    `
      SELECT
        COALESCE(sum(realized_pnl_delta_units), 0)::text AS units,
        count(*)::integer AS entries
      FROM accounting_realized_pnl_ledger
      WHERE shadow = $1 AND effective_at >= $2 AND effective_at < $3
    `,
    [shadow, dayStart, dayStart + 86_400_000],
  );
  const units = result.rows[0]?.units ?? "0";
  return { units, usd: accountingUnitsToNumber(units), entries: Number(result.rows[0]?.entries ?? 0) };
}

export type AllTimeAccountingLedgerAggregate = {
  realizedPnlUnits: string;
  feeUnits: string;
  realizedPnlUsd: number;
  feesUsd: number;
  entries: number;
};

export async function sumAllTimeAccountingLedger(
  pool: PgQueryable,
  shadow = false,
): Promise<AllTimeAccountingLedgerAggregate> {
  const result = await pool.query<{ realized_pnl_units: string; fee_units: string; entries: number }>(
    `
      SELECT
        COALESCE(sum(realized_pnl_delta_units), 0)::text AS realized_pnl_units,
        COALESCE(sum(fee_delta_units), 0)::text AS fee_units,
        count(*)::integer AS entries
      FROM accounting_realized_pnl_ledger
      WHERE shadow = $1
    `,
    [shadow],
  );
  const realizedPnlUnits = result.rows[0]?.realized_pnl_units ?? "0";
  const feeUnits = result.rows[0]?.fee_units ?? "0";
  return {
    realizedPnlUnits,
    feeUnits,
    realizedPnlUsd: accountingUnitsToNumber(realizedPnlUnits),
    feesUsd: accountingUnitsToNumber(feeUnits),
    entries: Number(result.rows[0]?.entries ?? 0),
  };
}

export type StableAccountingProjectionBacklogItem = {
  intent: OrderIntent;
  accountingVersion: number;
  proofSha256: string;
  proof: Record<string, unknown>;
  realizedPnlUsd: number;
  roi: number | null;
  stablePnlChange: StablePnlChange | null;
};

export async function listStableAccountingProjectionBacklog(
  pool: PgQueryable,
  limit = 100,
): Promise<StableAccountingProjectionBacklogItem[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new AccountingPersistenceError("invalid_input", "Accounting projection backlog limit must be 1..1000");
  }
  const result = await pool.query<{
    intent_row: OrderIntentRow;
    accounting_version: number;
    proof_sha256: string;
    proof_json: Record<string, unknown>;
    realized_pnl_units: string;
    roi_units: string | null;
    stable_row: StablePnlChangeRow | null;
  }>(
    `
      SELECT
        to_jsonb(intent) AS intent_row,
        head.current_version::integer AS accounting_version,
        version.proof_sha256,
        version.proof_json,
        version.realized_pnl_units::text,
        version.roi_units::text,
        CASE WHEN stable.intent_id IS NULL THEN NULL ELSE to_jsonb(stable) END AS stable_row
      FROM accounting_heads AS head
      JOIN order_intents AS intent ON intent.id = head.intent_id
      JOIN accounting_versions AS version
        ON version.intent_id = head.intent_id
       AND version.version = head.current_version
      LEFT JOIN stable_pnl_changes AS stable ON stable.intent_id = head.intent_id
      WHERE head.state = 'stable'
        AND intent.status = 'settled'
        AND intent.shadow = false
        AND (
          stable.intent_id IS NULL
          OR stable.accounting_version IS DISTINCT FROM head.current_version
          OR stable.accounting_proof_sha256 IS DISTINCT FROM head.current_proof_sha256
          OR round(stable.realized_pnl_usd::numeric * 100000000) IS DISTINCT FROM version.realized_pnl_units
          OR (stable.roi IS NULL) IS DISTINCT FROM (version.roi_units IS NULL)
          OR stable.roi IS NOT NULL
            AND round(stable.roi::numeric * 100000000) IS DISTINCT FROM version.roi_units
          OR stable.settled_at IS DISTINCT FROM intent.resolved_at
          OR round(stable.target_notional_usd::numeric * 100000000)
            IS DISTINCT FROM round(intent.target_notional_usd::numeric * 100000000)
        )
      ORDER BY head.updated_at ASC, head.intent_id ASC
      LIMIT $1
    `,
    [limit],
  );
  return result.rows.map((row) => ({
    intent: mapOrderIntentRow(row.intent_row),
    accountingVersion: Number(row.accounting_version),
    proofSha256: row.proof_sha256,
    proof: row.proof_json,
    realizedPnlUsd: accountingUnitsToNumber(row.realized_pnl_units),
    roi: row.roi_units === null ? null : accountingUnitsToNumber(row.roi_units),
    stablePnlChange: row.stable_row === null ? null : mapStablePnlChangeRow(row.stable_row),
  }));
}

async function persistIntentAccountingVersion(
  pool: Pool,
  operation: "finalize" | "reaccount",
  input: FinalizeIntentAccountingInput,
): Promise<AccountingMutationResult> {
  assertAccountingMutationContext(input.context);
  assertExpectedAccountingHeadRevision(input.expectedHeadRevision);
  assertExpectedOrderIntentRevision(input.expectedIntentRevision, input.terminalIntent);
  if (!isPlainJsonObject(input.stability)) {
    throw new AccountingPersistenceError("invalid_input", "Accounting stability evidence must be an object");
  }
  const projection = calculateAccountingLedger(input.ledgerInput);
  const intentId = projection.intentId;
  if (input.terminalIntent.id !== intentId) {
    throw new AccountingPersistenceError(
      "identity_conflict",
      `Terminal intent ${input.terminalIntent.id} does not match accounting intent ${intentId}`,
      intentId,
    );
  }
  assertAccountingProjectionIntent(projection, input.terminalIntent);
  const requestSha256 = hashAccountingPayload({
    operation,
    actor: input.context.actor,
    occurredAt: input.context.occurredAt,
    expectedHeadRevision: input.expectedHeadRevision,
    expectedIntentRevision: input.expectedIntentRevision,
    terminalIntentSha256: hashAccountingPayload(input.terminalIntent),
    evidenceSha256: projection.evidenceSha256,
    proofSha256: projection.proofSha256,
    stability: input.stability,
  });

  return withAccountingTransaction(pool, async (client) => {
    const replay = await loadAccountingRequestReplay<AccountingMutationResult>(
      client,
      input.context.requestId,
      operation,
      intentId,
      requestSha256,
    );
    if (replay) {
      return { ...replay, replayed: true };
    }
    const recordedAt = await readAccountingDatabaseClock(client, input.context);
    if (projection.capturedAt > recordedAt) {
      throw new AccountingPersistenceError("invalid_input", "Accounting evidence capture cannot be in the future");
    }
    const { head, intent } = await lockAccountingParent(client, intentId, input.expectedHeadRevision);
    assertLockedIntentRevision(intent, input.expectedIntentRevision);
    assertOrderIntentIdentity(mapOrderIntentRow(intent), input.terminalIntent);
    assertAccountingTerminalTransition(intent.status, input.terminalIntent.status, operation, intentId);

    if (operation === "finalize") {
      const recoverableLateFillQuarantine =
        head.state === "quarantined" &&
        head.current_version === null &&
        head.current_proof_sha256 === null &&
        !(await hasConflictingAccountingQuarantine(client, intentId));
      if (head.state !== "open" && head.state !== "legacy_pending" && !recoverableLateFillQuarantine) {
        throw new AccountingPersistenceError(
          "state_conflict",
          `Accounting head ${intentId} is ${head.state}, not finalizable`,
          intentId,
        );
      }
      if (head.current_version !== null || projection.version !== 1) {
        throw new AccountingPersistenceError("state_conflict", "Initial accounting must create version 1", intentId);
      }
    } else {
      if ((head.state !== "stable" && head.state !== "quarantined") || head.current_version === null) {
        throw new AccountingPersistenceError(
          "state_conflict",
          `Accounting head ${intentId} is ${head.state}, not reaccountable`,
          intentId,
        );
      }
      if (projection.version !== Number(head.current_version) + 1) {
        throw new AccountingPersistenceError(
          "state_conflict",
          `Reaccount version ${projection.version} does not follow ${head.current_version}`,
          intentId,
        );
      }
    }

    await ensureAccountingLegs(client, intent, recordedAt);
    await persistProjectionFacts(client, projection, recordedAt);
    await persistLegacyAccountingSettlements(client, projection);
    const previous =
      head.current_version === null
        ? null
        : await loadRequiredAccountingVersion(client, intentId, head.current_version);
    if (previous && previous.proof_sha256 !== head.current_proof_sha256) {
      throw new AccountingPersistenceError(
        "identity_conflict",
        "Accounting head proof does not match its version",
        intentId,
      );
    }
    const delta = previous
      ? calculateAccountingLedgerDelta(recalculateStoredAccountingProjection(previous), projection)
      : null;
    await insertAccountingVersion(client, projection, previous?.version ?? null, input.context.requestId, recordedAt);
    await insertAccountingVersionFactLinks(client, projection);

    const costBasisDelta = delta?.exact.costBasisUsd ?? projection.exact.costBasisUsd;
    const payoutDelta = delta?.exact.payoutUsd ?? projection.exact.payoutUsd;
    const feeDelta = delta?.exact.feesUsd ?? projection.exact.feesUsd;
    const pnlDelta = delta?.exact.realizedPnlUsd ?? projection.exact.realizedPnlUsd;
    await client.query(
      `
        INSERT INTO accounting_realized_pnl_ledger (
          intent_id, accounting_version, request_id, asset, shadow, effective_at, recorded_at,
          cost_basis_delta_units, payout_delta_units, fee_delta_units, realized_pnl_delta_units,
          resulting_realized_pnl_units, proof_sha256
        ) VALUES (
          $1, $2, $3::uuid, $4, $5, $6, $7,
          $8::numeric, $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13
        )
      `,
      [
        intentId,
        projection.version,
        input.context.requestId,
        projection.proof.intent.asset,
        projection.proof.intent.shadow,
        projection.proof.intent.resolvedAt,
        recordedAt,
        canonicalFixedToUnits(costBasisDelta),
        canonicalFixedToUnits(payoutDelta),
        canonicalFixedToUnits(feeDelta),
        canonicalFixedToUnits(pnlDelta),
        canonicalFixedToUnits(projection.exact.realizedPnlUsd),
        projection.proofSha256,
      ],
    );
    const observationSha256 = hashAccountingPayload(input.stability);
    await client.query(
      `
        INSERT INTO accounting_stability_observations (
          intent_id, accounting_version, request_id, observed_at, observation_sha256, observation_json
        ) VALUES ($1, $2, $3::uuid, $4, $5, $6::jsonb)
      `,
      [
        intentId,
        projection.version,
        input.context.requestId,
        input.context.occurredAt,
        observationSha256,
        JSON.stringify(input.stability),
      ],
    );

    const updatedHead = await updateAccountingHead(
      client,
      head,
      "stable",
      projection.version,
      projection.proofSha256,
      recordedAt,
    );
    const projectedTerminalIntent = projectTerminalIntentFromAccountingProjection(input.terminalIntent, projection);
    await updateTerminalOrderIntentForAccounting(
      client,
      intent,
      projectedTerminalIntent,
      projection.realizedPnlUsd,
      projection.roi,
      recordedAt,
    );
    const result: AccountingMutationResult = {
      replayed: false,
      head: mapAccountingHeadRow(updatedHead),
      version: projection.version,
      proofSha256: projection.proofSha256,
    };
    await insertAccountingMutationRequest(
      client,
      input.context,
      operation,
      intentId,
      requestSha256,
      input.expectedHeadRevision,
      result,
      recordedAt,
    );
    return result;
  });
}

async function hasConflictingAccountingQuarantine(client: PoolClient, intentId: string) {
  const result = await client.query<{ conflicting: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM accounting_quarantines
        WHERE intent_id = $1
          AND reason IN ('fill_identity_conflict', 'fill_economic_conflict')
      ) AS conflicting
    `,
    [intentId],
  );
  return result.rows[0]?.conflicting ?? true;
}

async function withAccountingTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withRowLockTransaction(pool, async (client) => {
    await acquireAccountingTransactionLock(client);
    return work(client);
  });
}

async function loadAccountingRequestReplay<T>(
  client: PoolClient,
  requestId: string,
  operation: AccountingMutationOperation,
  intentId: string,
  requestSha256: string,
): Promise<T | null> {
  const result = await client.query<AccountingMutationRequestRow>(
    "SELECT * FROM accounting_mutation_requests WHERE request_id = $1::uuid",
    [requestId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  if (row.operation !== operation || row.intent_id !== intentId || row.request_sha256 !== requestSha256) {
    throw new AccountingPersistenceError(
      "request_conflict",
      `Accounting request ${requestId} was already used for different immutable content`,
      intentId,
    );
  }
  return row.result_json as T;
}

async function insertAccountingMutationRequest(
  client: PoolClient,
  context: AccountingMutationContext,
  operation: AccountingMutationOperation,
  intentId: string,
  requestSha256: string,
  expectedHeadRevision: number,
  result: AccountingFillIngestionDecision | AccountingMutationResult,
  recordedAt: number,
) {
  await client.query(
    `
      INSERT INTO accounting_mutation_requests (
        request_id, intent_id, operation, request_sha256, expected_head_revision, result_json, recorded_at
      ) VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7)
    `,
    [context.requestId, intentId, operation, requestSha256, expectedHeadRevision, JSON.stringify(result), recordedAt],
  );
}

async function readAccountingDatabaseClock(client: PoolClient, context: AccountingMutationContext) {
  const recordedAt = await readDatabaseClockMs(client);
  if (context.occurredAt > recordedAt) {
    throw new AccountingPersistenceError("invalid_input", "Accounting occurredAt cannot be in the future");
  }
  return recordedAt;
}

async function lockAccountingParent(client: PoolClient, intentId: string, expectedRevision: number) {
  const headResult = await client.query<AccountingHeadRow>(
    "SELECT * FROM accounting_heads WHERE intent_id = $1 FOR UPDATE",
    [intentId],
  );
  const head = headResult.rows[0];
  if (!head) {
    throw new AccountingPersistenceError("head_not_found", `Missing accounting head for ${intentId}`, intentId);
  }
  if (Number(head.revision) !== expectedRevision) {
    throw new AccountingPersistenceError(
      "revision_conflict",
      `Accounting head ${intentId} expected revision ${expectedRevision}, found ${head.revision}`,
      intentId,
    );
  }
  const intentResult = await client.query<OrderIntentRow>("SELECT * FROM order_intents WHERE id = $1 FOR SHARE", [
    intentId,
  ]);
  const intent = intentResult.rows[0];
  if (!intent) {
    throw new AccountingPersistenceError("identity_conflict", `Missing intent ${intentId}`, intentId);
  }
  return { head, intent };
}

async function ensureAccountingLegs(
  client: PoolClient,
  intent: OrderIntentRow,
  recordedAt: number,
  requiredLegId?: string,
) {
  let requiredLeg: OrderIntent["legs"][number] | null = null;
  for (const leg of intent.legs_json) {
    const identity = {
      intentId: intent.id,
      legId: leg.id,
      venue: leg.venue,
      outcome: leg.outcome,
      marketRef: leg.marketRef,
      tokenId: leg.tokenId ?? null,
    };
    const identitySha256 = hashAccountingPayload(identity);
    await client.query(
      `
        INSERT INTO accounting_legs (
          intent_id, leg_id, venue, outcome, market_ref, token_id, identity_sha256, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT DO NOTHING
      `,
      [intent.id, leg.id, leg.venue, leg.outcome, leg.marketRef, leg.tokenId ?? null, identitySha256, recordedAt],
    );
    const stored = await client.query<{ identity_sha256: string }>(
      "SELECT identity_sha256 FROM accounting_legs WHERE intent_id = $1 AND leg_id = $2",
      [intent.id, leg.id],
    );
    if (stored.rows[0]?.identity_sha256 !== identitySha256) {
      throw new AccountingPersistenceError(
        "identity_conflict",
        `Accounting leg ${intent.id}/${leg.id} conflicts with immutable identity`,
        intent.id,
      );
    }
    if (leg.id === requiredLegId) {
      requiredLeg = leg;
    }
  }
  if (requiredLegId && !requiredLeg) {
    throw new AccountingPersistenceError(
      "identity_conflict",
      `Intent ${intent.id} has no leg ${requiredLegId}`,
      intent.id,
    );
  }
  return requiredLeg;
}

function assertAccountingFillParent(
  fill: LiveFill,
  legId: string,
  intent: OrderIntentRow,
  leg: OrderIntent["legs"][number] | null,
) {
  if (
    !leg ||
    fill.intentId !== intent.id ||
    fill.asset !== intent.asset ||
    fill.shadow !== intent.shadow ||
    fill.venue !== leg.venue ||
    fill.marketRef !== leg.marketRef ||
    (fill.tokenId ?? null) !== (leg.tokenId ?? null) ||
    fill.outcome !== leg.outcome ||
    leg.id !== legId
  ) {
    throw new AccountingPersistenceError(
      "identity_conflict",
      `Fill ${fill.id} does not match intent ${intent.id} leg ${legId}`,
      intent.id,
    );
  }
}

async function insertLegacyFillForAccounting(
  client: PoolClient,
  input: IngestVenueFillAccountingInput,
): Promise<AccountingQuarantineReason | null> {
  const { fill } = input;
  const inserted = await client.query(
    `
      INSERT INTO fills (
        id, asset, shadow, intent_id, venue, venue_order_id, trade_id, market_ref, token_id, side,
        outcome, price, size, fee_usd, liquidity, filled_at, raw_json
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17::jsonb
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `,
    fillParams(fill),
  );
  if (inserted.rowCount === 1) {
    return null;
  }
  const conflicts = await client.query<FillRow>(
    `
      SELECT * FROM fills
      WHERE id = $1 OR (venue = $2 AND venue_order_id = $3 AND trade_id = $4)
      FOR UPDATE
    `,
    [fill.id, fill.venue, fill.venueOrderId, fill.tradeId],
  );
  if (conflicts.rows.length !== 1) {
    return "fill_identity_conflict";
  }
  const existing = mapFillRow(conflicts.rows[0]);
  if (areFillsEconomicallyIdentical(existing, fill)) {
    return null;
  }
  if (!areFillsEconomicallyIdenticalExceptFee(existing, fill) || input.finality !== "final") {
    return "fill_economic_conflict";
  }

  const facts = await loadAccountingFillFactRows(
    client,
    "WHERE fact.fill_id = $1 OR (fact.venue = $2 AND fact.venue_order_id = $3 AND fact.trade_id = $4)",
    [fill.id, fill.venue, fill.venueOrderId, fill.tradeId],
    "FOR SHARE OF fact",
  );
  const fact = facts[0];
  if (!fact || facts.length !== 1 || fact.fill_id !== fill.id) {
    return "fill_economic_conflict";
  }
  const incomingIdentity = buildAccountingFillFactIdentity({
    fillId: fill.id,
    intentId: fill.intentId,
    legId: input.legId,
    asset: fill.asset,
    shadow: fill.shadow,
    venue: fill.venue,
    venueOrderId: fill.venueOrderId,
    tradeId: fill.tradeId,
    marketRef: fill.marketRef,
    tokenId: fill.tokenId ?? null,
    side: fill.side,
    outcome: fill.outcome,
    priceUnits: accountingNumberToUnits(fill.price, "fill price", false),
    sizeUnits: accountingNumberToUnits(fill.size, "fill size", false),
    feeUnits: accountingNumberToUnits(fill.feeUsd, "fill fee", true),
    finality: input.finality,
    filledAt: fill.filledAt,
  });
  const legacyFeeUnits = accountingNumberToUnits(existing.feeUsd, "legacy fill fee", true);
  const finalFeeAlreadyObserved = fact.current_finality === "final" && fact.fee_units === incomingIdentity.feeUnits;
  const finalFeeCanBeObserved = fact.current_finality !== "final" && fact.initial_fee_units === legacyFeeUnits;
  return accountingFillFactMatchesExceptFee(fact, incomingIdentity) &&
    (finalFeeAlreadyObserved || finalFeeCanBeObserved)
    ? null
    : "fill_economic_conflict";
}

function areFillsEconomicallyIdenticalExceptFee(existing: LiveFill, incoming: LiveFill) {
  return areFillsEconomicallyIdentical({ ...existing, feeUsd: incoming.feeUsd }, incoming);
}

function buildAccountingFillFact(input: IngestVenueFillAccountingInput, recordedAt: number) {
  const canonical = buildAccountingFillFactIdentity({
    fillId: input.fill.id,
    intentId: input.fill.intentId,
    legId: input.legId,
    asset: input.fill.asset,
    shadow: input.fill.shadow,
    venue: input.fill.venue,
    venueOrderId: input.fill.venueOrderId,
    tradeId: input.fill.tradeId,
    marketRef: input.fill.marketRef,
    tokenId: input.fill.tokenId ?? null,
    side: input.fill.side,
    outcome: input.fill.outcome,
    priceUnits: accountingNumberToUnits(input.fill.price, "fill price", false),
    sizeUnits: accountingNumberToUnits(input.fill.size, "fill size", false),
    feeUnits: accountingNumberToUnits(input.fill.feeUsd, "fill fee", true),
    finality: input.finality,
    filledAt: input.fill.filledAt,
  });
  return { ...canonical, factSha256: hashAccountingPayload(canonical), raw: input.fill.raw, recordedAt };
}

function buildAccountingFillFactIdentity(input: {
  fillId: string;
  intentId: string;
  legId: string;
  asset: MarketAsset;
  shadow: boolean;
  venue: Venue;
  venueOrderId: string;
  tradeId: string;
  marketRef: string;
  tokenId: string | null;
  side: LiveFill["side"];
  outcome: LiveFill["outcome"];
  priceUnits: string;
  sizeUnits: string;
  feeUnits: string;
  finality: AccountingFillEvidence["finality"];
  filledAt: number;
}) {
  return {
    schema: "warbitrer.accounting-fill-fact.v1",
    fillId: input.fillId,
    intentId: input.intentId,
    legId: input.legId,
    asset: input.asset,
    shadow: input.shadow,
    venue: input.venue,
    venueOrderId: input.venueOrderId,
    tradeId: input.tradeId,
    marketRef: input.marketRef,
    tokenId: input.tokenId,
    side: input.side,
    outcome: input.outcome,
    priceUnits: input.priceUnits,
    sizeUnits: input.sizeUnits,
    feeUnits: input.feeUnits,
    finality: input.finality,
    filledAt: input.filledAt,
  };
}

async function insertAccountingFillFact(
  client: PoolClient,
  fact: ReturnType<typeof buildAccountingFillFact>,
  context: AccountingMutationContext,
): Promise<{ conflict: AccountingQuarantineReason | null; factSha256: string }> {
  const inserted = await client.query(
    `
      INSERT INTO accounting_fill_facts (
        fill_id, intent_id, leg_id, asset, shadow, venue, venue_order_id, trade_id, market_ref,
        token_id, side, outcome, price_units, size_units, fee_units, finality, filled_at,
        fact_sha256, raw_json, recorded_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13::numeric, $14::numeric, $15::numeric, $16, $17,
        $18, $19::jsonb, $20
      )
      ON CONFLICT DO NOTHING
      RETURNING fill_id
    `,
    [
      fact.fillId,
      fact.intentId,
      fact.legId,
      fact.asset,
      fact.shadow,
      fact.venue,
      fact.venueOrderId,
      fact.tradeId,
      fact.marketRef,
      fact.tokenId,
      fact.side,
      fact.outcome,
      fact.priceUnits,
      fact.sizeUnits,
      fact.feeUnits,
      fact.finality,
      fact.filledAt,
      fact.factSha256,
      JSON.stringify(fact.raw),
      fact.recordedAt,
    ],
  );
  if (inserted.rowCount === 1) {
    return { conflict: null, factSha256: fact.factSha256 };
  }
  const conflict = await loadAccountingFillFactRows(
    client,
    "WHERE fact.fill_id = $1 OR (fact.venue = $2 AND fact.venue_order_id = $3 AND fact.trade_id = $4)",
    [fact.fillId, fact.venue, fact.venueOrderId, fact.tradeId],
    "FOR SHARE OF fact",
  );
  const stored = conflict[0];
  if (conflict.length !== 1 || !stored || stored.fill_id !== fact.fillId) {
    return { conflict: "fill_identity_conflict", factSha256: fact.factSha256 };
  }
  if (!accountingFillFactMatchesExceptFee(stored, fact)) {
    return { conflict: "fill_economic_conflict", factSha256: stored.fact_sha256 };
  }
  if (stored.current_finality === "final") {
    return stored.fee_units === fact.feeUnits && fact.finality === "final"
      ? { conflict: null, factSha256: stored.fact_sha256 }
      : { conflict: "fill_economic_conflict", factSha256: stored.fact_sha256 };
  }
  if (stored.current_finality === fact.finality && stored.fee_units === fact.feeUnits) {
    return { conflict: null, factSha256: stored.fact_sha256 };
  }
  if (fact.finality !== "final") {
    return { conflict: "fill_economic_conflict", factSha256: stored.fact_sha256 };
  }

  const observation = {
    schema: "warbitrer.accounting-fill-finality-observation.v1",
    fillId: stored.fill_id,
    factSha256: stored.fact_sha256,
    previousFinality: stored.current_finality,
    observedFinality: "final" as const,
    previousFeeUnits: stored.fee_units,
    observedFeeUnits: fact.feeUnits,
  };
  await client.query(
    `
      INSERT INTO accounting_fill_finality_observations (
        fill_id, request_id, previous_finality, observed_finality, observed_fee_units,
        observation_sha256, observation_json, observed_at, recorded_at
      ) VALUES ($1, $2::uuid, $3, 'final', $4::numeric, $5, $6::jsonb, $7, $8)
    `,
    [
      stored.fill_id,
      context.requestId,
      stored.current_finality,
      fact.feeUnits,
      hashAccountingPayload(observation),
      JSON.stringify(observation),
      context.occurredAt,
      fact.recordedAt,
    ],
  );
  return { conflict: null, factSha256: stored.fact_sha256 };
}

async function loadAccountingFillFactRows(
  db: PgQueryable,
  predicate: string,
  values: unknown[],
  lockClause = "",
): Promise<AccountingFillFactRow[]> {
  const result = await db.query<AccountingFillFactRow>(
    `
      SELECT
        fact.fill_id,
        fact.intent_id,
        fact.leg_id,
        fact.asset,
        fact.shadow,
        fact.venue,
        fact.venue_order_id,
        fact.trade_id,
        fact.market_ref,
        fact.token_id,
        fact.side,
        fact.outcome,
        fact.price_units::text,
        fact.size_units::text,
        fact.fee_units::text AS initial_fee_units,
        COALESCE(final_observation.observed_fee_units, fact.fee_units)::text AS fee_units,
        fact.finality AS initial_finality,
        CASE
          WHEN final_observation.fill_id IS NOT NULL THEN 'final'
          ELSE fact.finality
        END AS current_finality,
        fact.filled_at,
        fact.fact_sha256,
        fact.recorded_at
      FROM accounting_fill_facts AS fact
      LEFT JOIN LATERAL (
        SELECT observation.fill_id, observation.observed_fee_units
        FROM accounting_fill_finality_observations AS observation
        WHERE observation.fill_id = fact.fill_id
          AND observation.observed_finality = 'final'
        ORDER BY observation.id DESC
        LIMIT 1
      ) AS final_observation ON true
      ${predicate}
      ORDER BY fact.filled_at ASC, fact.venue ASC, fact.venue_order_id ASC, fact.trade_id ASC, fact.fill_id ASC
      ${lockClause}
    `,
    values,
  );
  return result.rows;
}

function accountingFillFactMatches(
  stored: AccountingFillFactRow,
  incoming: ReturnType<typeof buildAccountingFillFactIdentity>,
) {
  return accountingFillFactMatchesExceptFee(stored, incoming) && stored.fee_units === incoming.feeUnits;
}

function accountingFillFactMatchesExceptFee(
  stored: AccountingFillFactRow,
  incoming: ReturnType<typeof buildAccountingFillFactIdentity>,
) {
  return (
    stored.intent_id === incoming.intentId &&
    stored.leg_id === incoming.legId &&
    stored.asset === incoming.asset &&
    stored.shadow === incoming.shadow &&
    stored.venue === incoming.venue &&
    stored.venue_order_id === incoming.venueOrderId &&
    stored.trade_id === incoming.tradeId &&
    stored.market_ref === incoming.marketRef &&
    stored.token_id === incoming.tokenId &&
    stored.side === incoming.side &&
    stored.outcome === incoming.outcome &&
    stored.price_units === incoming.priceUnits &&
    stored.size_units === incoming.sizeUnits &&
    Number(stored.filled_at) === incoming.filledAt
  );
}

function mapAccountingFillFactRow(row: AccountingFillFactRow): AccountingFillEvidence {
  return {
    id: row.fill_id,
    intentId: row.intent_id,
    legId: row.leg_id,
    asset: row.asset,
    shadow: row.shadow,
    venue: row.venue,
    venueOrderId: row.venue_order_id,
    tradeId: row.trade_id,
    marketRef: row.market_ref,
    ...(row.token_id === null ? {} : { tokenId: row.token_id }),
    side: row.side,
    outcome: row.outcome,
    price: accountingUnitsToNumber(row.price_units),
    size: accountingUnitsToNumber(row.size_units),
    feeUsd: accountingUnitsToNumber(row.fee_units),
    finality: row.current_finality,
    filledAt: Number(row.filled_at),
  };
}

async function assertProjectionContainsEveryFinalAccountingFill(
  client: PoolClient,
  projection: AccountingLedgerProjection,
) {
  const stored = await loadAccountingFillFactRows(
    client,
    "WHERE fact.intent_id = $1",
    [projection.intentId],
    "FOR SHARE OF fact",
  );
  const nonFinal = stored.find((fill) => fill.current_finality !== "final");
  if (nonFinal) {
    throw new AccountingPersistenceError(
      "state_conflict",
      `Accounting fill ${nonFinal.fill_id} is ${nonFinal.current_finality}, not final`,
      projection.intentId,
    );
  }
  if (stored.length !== projection.proof.fills.length) {
    throw new AccountingPersistenceError(
      "identity_conflict",
      `Accounting projection for ${projection.intentId} has ${projection.proof.fills.length} fill(s), but durable evidence has ${stored.length}`,
      projection.intentId,
    );
  }

  const storedById = new Map(stored.map((fill) => [fill.fill_id, fill]));
  for (const fill of projection.proof.fills) {
    const expected = buildAccountingFillFactIdentity({
      fillId: fill.id,
      intentId: fill.intentId,
      legId: fill.legId,
      asset: fill.asset,
      shadow: fill.shadow,
      venue: fill.venue,
      venueOrderId: fill.venueOrderId,
      tradeId: fill.tradeId,
      marketRef: fill.marketRef,
      tokenId: fill.tokenId,
      side: fill.side,
      outcome: fill.outcome,
      priceUnits: canonicalFixedToUnits(fill.price),
      sizeUnits: canonicalFixedToUnits(fill.size),
      feeUnits: canonicalFixedToUnits(fill.feeUsd),
      finality: "final",
      filledAt: fill.filledAt,
    });
    const durable = storedById.get(fill.id);
    if (!durable || !accountingFillFactMatches(durable, expected)) {
      throw new AccountingPersistenceError(
        "identity_conflict",
        `Accounting fill ${fill.id} is missing or conflicts with durable evidence`,
        projection.intentId,
      );
    }
  }
}

async function quarantineAccountingFill(
  client: PoolClient,
  input: IngestVenueFillAccountingInput,
  head: AccountingHeadRow,
  intent: OrderIntentRow,
  reason: AccountingQuarantineReason,
  requestSha256: string,
  recordedAt: number,
): Promise<AccountingFillIngestionDecision> {
  const payload = {
    schema: "warbitrer.accounting-quarantine.v1",
    reason,
    legId: input.legId,
    finality: input.finality,
    fill: canonicalAccountingFillForRequest(input.fill),
  };
  const payloadSha256 = hashAccountingPayload(payload);
  const updatedHead = await updateAccountingHead(
    client,
    head,
    "quarantined",
    head.current_version,
    head.current_proof_sha256,
    recordedAt,
  );
  const quarantine = await client.query<AccountingQuarantineRow>(
    `
      INSERT INTO accounting_quarantines (
        intent_id, reason, request_id, payload_sha256, payload_json, head_revision, occurred_at, recorded_at
      ) VALUES ($1, $2, $3::uuid, $4, $5::jsonb, $6, $7, $8)
      RETURNING *
    `,
    [
      input.fill.intentId,
      reason,
      input.context.requestId,
      payloadSha256,
      JSON.stringify(payload),
      updatedHead.revision,
      input.context.occurredAt,
      recordedAt,
    ],
  );
  const incident = createExecutionIncident({
    asset: intent.asset,
    slotKey: intent.slot_key,
    intentId: intent.id,
    stage: "accounting_quarantine",
    reason: "venue_error",
    venue: input.fill.venue,
    orderId: input.fill.venueOrderId,
    triggeredAt: input.context.occurredAt,
    disposition: "manual_intervention",
  });
  await observeCircuitBreakerIncident(client, {
    incident,
    actor: incident.owner,
    requestId: `accounting-quarantine:${input.context.requestId}`,
  });
  const row = quarantine.rows[0];
  if (!row) {
    throw new AccountingPersistenceError("identity_conflict", "Accounting quarantine insert returned no row");
  }
  const result: AccountingFillIngestionDecision = {
    decision: "quarantined",
    head: mapAccountingHeadRow(updatedHead),
    quarantineId: Number(row.id),
    reason,
  };
  await insertAccountingMutationRequest(
    client,
    input.context,
    "ingest_fill",
    input.fill.intentId,
    requestSha256,
    input.expectedHeadRevision,
    result,
    recordedAt,
  );
  return result;
}

async function assertNoDurableAccountingExposure(client: PoolClient, intentId: string) {
  const result = await client.query<{ fills: number; orders: number; attempts: number; positions: number }>(
    `
      SELECT
        (
          SELECT count(*)::integer FROM (
            SELECT id FROM fills WHERE intent_id = $1
            UNION ALL
            SELECT fill_id FROM accounting_fill_facts WHERE intent_id = $1 AND size_units > 0
          ) AS durable_fill
        ) AS fills,
        (SELECT count(*)::integer FROM venue_orders
          WHERE intent_id = $1 AND (
            filled_size > 0
            OR status NOT IN ('pending', 'live', 'partially_filled', 'filled', 'canceled', 'rejected', 'expired')
            OR status IN ('pending', 'live', 'partially_filled', 'filled')
            OR EXISTS (
              SELECT 1
              FROM order_intents AS parent
              WHERE parent.id = $1
                AND (
                  venue_orders.asset IS DISTINCT FROM parent.asset
                  OR venue_orders.shadow IS DISTINCT FROM parent.shadow
                )
            )
            OR requested_size::text IN ('NaN', 'Infinity', '-Infinity')
            OR requested_size <= 0
            OR requested_price IS NOT NULL AND (
              requested_price::text IN ('NaN', 'Infinity', '-Infinity')
              OR requested_price <= 0
              OR requested_price > 1
            )
            OR filled_size::text IN ('NaN', 'Infinity', '-Infinity')
            OR filled_size < 0
            OR filled_size > requested_size + 0.000001
            OR filled_size > 0 AND (
              average_fill_price IS NULL
              OR average_fill_price::text IN ('NaN', 'Infinity', '-Infinity')
              OR average_fill_price <= 0
              OR average_fill_price > 1
            )
            OR fee_usd IS NOT NULL AND (
              fee_usd::text IN ('NaN', 'Infinity', '-Infinity')
              OR fee_usd < 0
            )
          )) AS orders,
        (SELECT count(*)::integer FROM order_attempts
          WHERE intent_id = $1 AND (
            EXISTS (
              SELECT 1
              FROM order_intents AS parent
              WHERE parent.id = $1
                AND (
                  order_attempts.asset IS DISTINCT FROM parent.asset
                  OR order_attempts.shadow IS DISTINCT FROM parent.shadow
                )
            ) OR
            status NOT IN ('planned', 'submitting', 'submitted', 'truth_pending', 'confirmed', 'failed') OR
            status IN ('planned', 'submitting', 'submitted', 'truth_pending') OR
            status = 'failed' AND truth_status IS DISTINCT FROM 'not_submitted' OR
            status = 'failed' AND truth_status = 'not_submitted' AND (
              venue_order_id IS NOT NULL OR
              result_json IS NOT NULL OR
              EXISTS (
                SELECT 1
                FROM venue_orders AS linked_order
                WHERE linked_order.intent_id = order_attempts.intent_id
                  AND linked_order.venue = order_attempts.venue
                  AND (
                    linked_order.venue_order_id = order_attempts.venue_order_id
                    OR linked_order.client_order_id = order_attempts.client_order_id
                  )
              )
            ) OR
            status = 'confirmed' AND (
              venue_order_id IS NULL OR
              truth_status IS NULL OR
              lower(btrim(truth_status)) NOT IN (
                'pending', 'live', 'filled', 'partially_filled',
                'canceled', 'expired', 'rejected', 'terminal_zero_fill'
              ) OR
              result_json IS NULL OR
              jsonb_typeof(result_json) <> 'object' OR
              jsonb_typeof(result_json -> 'venue') <> 'string' OR
              result_json ->> 'venue' IS DISTINCT FROM venue OR
              jsonb_typeof(result_json -> 'venueOrderId') <> 'string' OR
              result_json ->> 'venueOrderId' IS DISTINCT FROM venue_order_id OR
              CASE
                WHEN jsonb_typeof(result_json -> 'status') = 'string'
                  AND jsonb_typeof(result_json -> 'filledSize') = 'number'
                THEN
                  lower(btrim(result_json ->> 'status')) NOT IN (
                    'pending', 'live', 'filled', 'partially_filled', 'canceled', 'expired', 'rejected'
                  ) OR
                  (result_json ->> 'filledSize')::numeric < 0
                  OR (
                    lower(btrim(result_json ->> 'status')) IN ('filled', 'partially_filled')
                    AND (result_json ->> 'filledSize')::numeric <= 0
                  )
                  OR NOT (
                    lower(btrim(truth_status)) = lower(btrim(result_json ->> 'status'))
                    OR lower(btrim(truth_status)) = 'terminal_zero_fill'
                      AND lower(btrim(result_json ->> 'status')) IN ('canceled', 'expired', 'rejected')
                      AND (result_json ->> 'filledSize')::numeric <= 0.000001
                  )
                ELSE true
              END OR
              NOT EXISTS (
                SELECT 1
                FROM venue_orders AS venue_order
                WHERE venue_order.intent_id = order_attempts.intent_id
                  AND venue_order.asset = order_attempts.asset
                  AND venue_order.shadow = order_attempts.shadow
                  AND venue_order.venue = order_attempts.venue
                  AND venue_order.venue_order_id = order_attempts.venue_order_id
                  AND venue_order.client_order_id IS NOT DISTINCT FROM order_attempts.client_order_id
                  AND venue_order.side = order_attempts.side
                  AND venue_order.order_type = order_attempts.order_type
                  AND venue_order.market_ref IS NOT DISTINCT FROM order_attempts.request_json ->> 'marketRef'
                  AND venue_order.token_id IS NOT DISTINCT FROM NULLIF(order_attempts.request_json ->> 'tokenId', '')
                  AND venue_order.outcome IS NOT DISTINCT FROM order_attempts.request_json ->> 'outcome'
                  AND CASE
                    WHEN jsonb_typeof(order_attempts.result_json -> 'filledSize') = 'number'
                    THEN venue_order.filled_size + 0.000001 >=
                      (order_attempts.result_json ->> 'filledSize')::numeric
                    ELSE false
                  END
              )
            )
          )) AS attempts,
        (SELECT count(*)::integer
          FROM positions AS position
          JOIN order_intents AS parent ON parent.id = $1
          WHERE position.size::text IN ('NaN', 'Infinity', '-Infinity')
            OR position.current_value_usd::text IN ('NaN', 'Infinity', '-Infinity')
            OR (
              (
                abs(position.current_value_usd) > 0.05
                OR (
                  NOT (position.venue = 'polymarket' AND (position.redeemable OR position.mergeable))
                  AND abs(position.size) > 0.05
                )
              )
              AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements(parent.legs_json) AS leg(value)
                WHERE leg.value ->> 'venue' = position.venue
                  AND leg.value ->> 'marketRef' = position.market_ref
                  AND leg.value ->> 'outcome' = position.outcome
              )
            )) AS positions
    `,
    [intentId],
  );
  const row = result.rows[0];
  if (Number(row?.attempts ?? 0) > 0) {
    throw new AccountingPersistenceError(
      "unresolved_submission",
      `Intent ${intentId} still has unresolved submission truth`,
      intentId,
    );
  }
  if (Number(row?.fills ?? 0) > 0 || Number(row?.orders ?? 0) > 0 || Number(row?.positions ?? 0) > 0) {
    throw new AccountingPersistenceError("exposure_present", `Intent ${intentId} still has durable exposure`, intentId);
  }
}

function assertNoExposureTerminalProjection(intent: OrderIntent) {
  const hasProjectedExposure = intent.legs.some(
    (leg) =>
      !["pending", "failed"].includes(leg.status) ||
      !Number.isFinite(leg.filledSize) ||
      leg.filledSize !== 0 ||
      leg.filledPrice !== null ||
      !Number.isFinite(leg.feeUsd) ||
      leg.feeUsd !== 0 ||
      (leg.payoutUsd !== null && (!Number.isFinite(leg.payoutUsd) || leg.payoutUsd !== 0)) ||
      (leg.cashAdjustmentUsd !== undefined && (!Number.isFinite(leg.cashAdjustmentUsd) || leg.cashAdjustmentUsd !== 0)),
  );
  const realizedPnlIsZeroOrUnprojected =
    intent.realizedPnlUsd === null || (Number.isFinite(intent.realizedPnlUsd) && intent.realizedPnlUsd === 0);
  if (hasProjectedExposure || !realizedPnlIsZeroOrUnprojected || intent.roi !== null) {
    throw new AccountingPersistenceError(
      "exposure_present",
      `No-exposure closure for intent ${intent.id} contains non-zero execution economics`,
      intent.id,
    );
  }
}

function assertAccountingProjectionIntent(projection: AccountingLedgerProjection, intent: OrderIntent) {
  const proof = projection.proof;
  if (
    proof.intent.id !== intent.id ||
    proof.intent.asset !== intent.asset ||
    proof.intent.shadow !== intent.shadow ||
    proof.intent.slotKey !== intent.slotKey ||
    proof.intent.slotStartTs !== intent.slotStartTs ||
    proof.intent.slotEndTs !== intent.slotEndTs ||
    proof.intent.combination !== intent.combination ||
    proof.intent.status !== intent.status ||
    proof.intent.primaryVenue !== intent.primaryVenue ||
    proof.intent.hedgeVenue !== intent.hedgeVenue ||
    proof.intent.resolvedAt !== intent.resolvedAt
  ) {
    throw new AccountingPersistenceError(
      "identity_conflict",
      `Accounting proof does not match immutable intent ${intent.id}`,
      intent.id,
    );
  }
  const parentLegs = [...intent.legs]
    .map((leg) => ({
      id: leg.id,
      intentId: leg.intentId,
      venue: leg.venue,
      outcome: leg.outcome,
      marketRef: leg.marketRef,
      tokenId: leg.tokenId ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const proofLegs = [...proof.legs].sort((left, right) => left.id.localeCompare(right.id));
  if (canonicalizeJson(parentLegs) !== canonicalizeJson(proofLegs)) {
    throw new AccountingPersistenceError(
      "identity_conflict",
      `Accounting proof legs do not match intent ${intent.id}`,
      intent.id,
    );
  }
}

function projectTerminalIntentFromAccountingProjection(
  intent: OrderIntent,
  projection: AccountingLedgerProjection,
): OrderIntent {
  const settlementsByLeg = new Map(projection.proof.settlements.map((settlement) => [settlement.legId, settlement]));
  for (const settlement of projection.proof.settlements) {
    const parentResolution = settlement.venue === "polymarket" ? intent.polyResolution : intent.kalshiResolution;
    if (parentResolution !== settlement.resolvedOutcome) {
      throw new AccountingPersistenceError(
        "identity_conflict",
        `Accounting settlement ${settlement.id} contradicts parent resolution for intent ${intent.id}`,
        intent.id,
      );
    }
    const parentLeg = intent.legs.find((leg) => leg.id === settlement.legId);
    if (!parentLeg || parentLeg.resolvedOutcome !== settlement.resolvedOutcome) {
      throw new AccountingPersistenceError(
        "identity_conflict",
        `Accounting settlement ${settlement.id} contradicts parent leg resolution for intent ${intent.id}`,
        intent.id,
      );
    }
  }

  const totalsByLeg = new Map(projection.legs.map((leg) => [leg.legId, leg]));
  return {
    ...intent,
    realizedPnlUsd: projection.realizedPnlUsd,
    roi: projection.roi,
    legs: intent.legs.map((leg) => {
      const totals = totalsByLeg.get(leg.id);
      if (!totals) {
        throw new AccountingPersistenceError(
          "identity_conflict",
          `Accounting projection is missing parent leg ${leg.id}`,
          intent.id,
        );
      }
      return {
        ...leg,
        feeUsd: totals.feesUsd,
        payoutUsd: totals.payoutUsd,
        resolvedOutcome: settlementsByLeg.get(leg.id)?.resolvedOutcome ?? leg.resolvedOutcome,
      };
    }) as OrderIntent["legs"],
  };
}

async function persistProjectionFacts(client: PoolClient, projection: AccountingLedgerProjection, recordedAt: number) {
  await assertProjectionContainsEveryFinalAccountingFill(client, projection);

  for (const settlement of projection.proof.settlements) {
    const factSha256 = hashAccountingPayload(settlement);
    const result = await client.query<{ settlement_id: string; fact_sha256: string }>(
      `
        INSERT INTO accounting_settlement_facts (
          settlement_id, intent_id, leg_id, asset, shadow, venue, market_ref, token_id, outcome,
          resolved_outcome, settled_size_units, payout_units, fee_units, finality, settled_at,
          fact_sha256, raw_json, recorded_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11::numeric, $12::numeric, $13::numeric, 'final', $14,
          $15, $16::jsonb, $17
        )
        ON CONFLICT DO NOTHING
        RETURNING settlement_id, fact_sha256
      `,
      [
        settlement.id,
        settlement.intentId,
        settlement.legId,
        settlement.asset,
        settlement.shadow,
        settlement.venue,
        settlement.marketRef,
        settlement.tokenId,
        settlement.outcome,
        settlement.resolvedOutcome,
        canonicalFixedToUnits(settlement.settledSize),
        canonicalFixedToUnits(settlement.payoutUsd),
        canonicalFixedToUnits(settlement.feeUsd),
        settlement.settledAt,
        factSha256,
        JSON.stringify({ accountingProof: settlement }),
        recordedAt,
      ],
    );
    if (result.rowCount !== 1) {
      const stored = await client.query<{ settlement_id: string; fact_sha256: string }>(
        "SELECT settlement_id, fact_sha256 FROM accounting_settlement_facts WHERE settlement_id = $1",
        [settlement.id],
      );
      if (stored.rows.length !== 1 || stored.rows[0]?.fact_sha256 !== factSha256) {
        throw new AccountingPersistenceError(
          "identity_conflict",
          `Accounting settlement fact ${settlement.id} conflicts with immutable evidence`,
          projection.intentId,
        );
      }
    }
  }
}

async function persistLegacyAccountingSettlements(client: PoolClient, projection: AccountingLedgerProjection) {
  for (const settlement of projection.proof.settlements) {
    const raw = { accountingProof: settlement };
    const inserted = await client.query(
      `
        INSERT INTO settlements (
          id, asset, intent_id, venue, market_ref, outcome, resolved_outcome, payout_usd, settled_at, raw_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
        ON CONFLICT DO NOTHING
        RETURNING id
      `,
      [
        settlement.id,
        settlement.asset,
        settlement.intentId,
        settlement.venue,
        settlement.marketRef,
        settlement.outcome,
        settlement.resolvedOutcome,
        Number(settlement.payoutUsd),
        settlement.settledAt,
        JSON.stringify(raw),
      ],
    );
    if (inserted.rowCount === 1) {
      continue;
    }
    const stored = await client.query<{
      asset: MarketAsset | null;
      intent_id: string | null;
      venue: Venue;
      market_ref: string;
      outcome: Resolution;
      resolved_outcome: Resolution | null;
      payout_usd: number;
      settled_at: number;
    }>(
      `
        SELECT asset, intent_id, venue, market_ref, outcome, resolved_outcome, payout_usd, settled_at
        FROM settlements
        WHERE id = $1
        FOR SHARE
      `,
      [settlement.id],
    );
    const row = stored.rows[0];
    if (
      !row ||
      row.asset !== settlement.asset ||
      row.intent_id !== settlement.intentId ||
      row.venue !== settlement.venue ||
      row.market_ref !== settlement.marketRef ||
      row.outcome !== settlement.outcome ||
      row.resolved_outcome !== settlement.resolvedOutcome ||
      accountingNumberToUnits(Number(row.payout_usd), "legacy settlement payout", true) !==
        canonicalFixedToUnits(settlement.payoutUsd) ||
      Number(row.settled_at) !== settlement.settledAt
    ) {
      throw new AccountingPersistenceError(
        "identity_conflict",
        `Legacy settlement ${settlement.id} conflicts with immutable accounting evidence`,
        projection.intentId,
      );
    }
  }
}

async function insertAccountingVersion(
  client: PoolClient,
  projection: AccountingLedgerProjection,
  previousVersion: number | null,
  requestId: string,
  recordedAt: number,
) {
  await client.query(
    `
      INSERT INTO accounting_versions (
        intent_id, version, previous_version, request_id, evidence_sha256, proof_sha256,
        captured_at, recorded_at, cost_basis_units, payout_units, fee_units,
        realized_pnl_units, roi_units, evidence_json, proof_json
      ) VALUES (
        $1, $2, $3, $4::uuid, $5, $6,
        $7, $8, $9::numeric, $10::numeric, $11::numeric,
        $12::numeric, $13::numeric, $14::jsonb, $15::jsonb
      )
    `,
    [
      projection.intentId,
      projection.version,
      previousVersion,
      requestId,
      projection.evidenceSha256,
      projection.proofSha256,
      projection.capturedAt,
      recordedAt,
      canonicalFixedToUnits(projection.exact.costBasisUsd),
      canonicalFixedToUnits(projection.exact.payoutUsd),
      canonicalFixedToUnits(projection.exact.feesUsd),
      canonicalFixedToUnits(projection.exact.realizedPnlUsd),
      projection.exact.roi === null ? null : canonicalFixedToUnits(projection.exact.roi),
      projection.evidenceJson,
      projection.proofJson,
    ],
  );
}

async function insertAccountingVersionFactLinks(client: PoolClient, projection: AccountingLedgerProjection) {
  for (const fill of projection.proof.fills) {
    await client.query(
      `
        INSERT INTO accounting_version_fill_facts (intent_id, version, fill_id)
        VALUES ($1, $2, $3)
      `,
      [projection.intentId, projection.version, fill.id],
    );
  }
  for (const settlement of projection.proof.settlements) {
    await client.query(
      `
        INSERT INTO accounting_version_settlement_facts (intent_id, version, settlement_id)
        VALUES ($1, $2, $3)
      `,
      [projection.intentId, projection.version, settlement.id],
    );
  }
}

async function loadRequiredAccountingVersion(client: PoolClient, intentId: string, version: number) {
  const result = await client.query<AccountingVersionRow>(
    "SELECT * FROM accounting_versions WHERE intent_id = $1 AND version = $2 FOR SHARE",
    [intentId, version],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AccountingPersistenceError(
      "identity_conflict",
      `Missing accounting version ${intentId}/${version}`,
      intentId,
    );
  }
  return row;
}

function recalculateStoredAccountingProjection(row: AccountingVersionRow) {
  const proof = row.proof_json as unknown as AccountingLedgerProjection["proof"];
  const input: AccountingLedgerInput = {
    version: proof.version,
    capturedAt: proof.capturedAt,
    evidenceCompleteness: "complete",
    intent: proof.intent,
    legs: proof.legs.map((leg) => ({
      ...leg,
      tokenId: leg.tokenId ?? undefined,
    })) as unknown as AccountingLedgerInput["legs"],
    fills: proof.fills.map((fill) => ({
      id: fill.id,
      legId: fill.legId,
      asset: fill.asset,
      shadow: fill.shadow,
      intentId: fill.intentId,
      venue: fill.venue,
      venueOrderId: fill.venueOrderId,
      tradeId: fill.tradeId,
      marketRef: fill.marketRef,
      tokenId: fill.tokenId ?? undefined,
      side: fill.side,
      outcome: fill.outcome,
      price: Number(fill.price),
      size: Number(fill.size),
      feeUsd: Number(fill.feeUsd),
      filledAt: fill.filledAt,
      finality: "final",
    })),
    settlements: proof.settlements.map((settlement) => ({
      id: settlement.id,
      legId: settlement.legId,
      asset: settlement.asset,
      shadow: settlement.shadow,
      intentId: settlement.intentId,
      venue: settlement.venue,
      marketRef: settlement.marketRef,
      tokenId: settlement.tokenId ?? undefined,
      outcome: settlement.outcome,
      resolvedOutcome: settlement.resolvedOutcome,
      settledSize: Number(settlement.settledSize),
      payoutUsd: Number(settlement.payoutUsd),
      feeUsd: Number(settlement.feeUsd),
      settledAt: settlement.settledAt,
      finality: "final",
    })),
  };
  const projection = calculateAccountingLedger(input);
  if (projection.proofSha256 !== row.proof_sha256 || projection.evidenceSha256 !== row.evidence_sha256) {
    throw new AccountingPersistenceError(
      "identity_conflict",
      `Stored accounting proof ${row.intent_id}/${row.version} failed deterministic verification`,
      row.intent_id,
    );
  }
  return projection;
}

async function updateAccountingHead(
  client: PoolClient,
  head: AccountingHeadRow,
  state: AccountingHeadState,
  currentVersion: number | null,
  currentProofSha256: string | null,
  updatedAt: number,
) {
  const result = await client.query<AccountingHeadRow>(
    `
      UPDATE accounting_heads
      SET state = $3,
          current_version = $4,
          current_proof_sha256 = $5,
          revision = revision + 1,
          updated_at = GREATEST(updated_at, $6)
      WHERE intent_id = $1 AND revision = $2
      RETURNING *
    `,
    [head.intent_id, head.revision, state, currentVersion, currentProofSha256, updatedAt],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AccountingPersistenceError(
      "revision_conflict",
      `Accounting head ${head.intent_id} changed during mutation`,
      head.intent_id,
    );
  }
  return row;
}

async function updateTerminalOrderIntentForAccounting(
  client: PoolClient,
  locked: OrderIntentRow,
  terminalIntent: OrderIntent,
  realizedPnlUsd: number,
  roi: number | null,
  recordedAt: number,
) {
  if (
    terminalIntent.resolvedAt === null ||
    terminalIntent.resolvedAt > terminalIntent.updatedAt ||
    terminalIntent.updatedAt < Number(locked.updated_at) ||
    terminalIntent.updatedAt > recordedAt
  ) {
    throw new AccountingPersistenceError(
      "invalid_input",
      `Terminal accounting intent ${terminalIntent.id} has inconsistent resolution timestamps`,
      terminalIntent.id,
    );
  }
  const result = await client.query<OrderIntentRow>(
    `
      UPDATE order_intents
      SET status = $3,
          updated_at = GREATEST(updated_at, $4, $25),
          resolved_at = $5,
          gross_cost = $6,
          target_notional_usd = $7,
          max_slippage_bps = $8,
          entry_sizing_reason = $9,
          failure_reason = $10,
          projected_net_profit_usd = $11,
          realized_pnl_usd = $12,
          roi = $13,
          poly_resolution = $14,
          kalshi_resolution = $15,
          legs_json = $16::jsonb,
          mismatch_p_fatal = $17,
          mismatch_p_fatal_upper = $18,
          mismatch_model_version = $19,
          fatal_mismatch_pnl_usd = $20,
          conservative_expected_pnl_usd = $21,
          fatal_loss_exposure_usd = $22,
          mismatch_risk_audit_json = $23::jsonb,
          shadow_execution_json = $24::jsonb,
          revision = revision + 1
      WHERE id = $1 AND revision = $2
      RETURNING *
    `,
    [
      terminalIntent.id,
      terminalIntent.revision,
      terminalIntent.status,
      terminalIntent.updatedAt,
      terminalIntent.resolvedAt,
      terminalIntent.grossCost,
      terminalIntent.targetNotionalUsd,
      terminalIntent.maxSlippageBps,
      terminalIntent.entrySizingReason ?? null,
      terminalIntent.failureReason,
      terminalIntent.projectedNetProfitUsd,
      realizedPnlUsd,
      roi,
      terminalIntent.polyResolution,
      terminalIntent.kalshiResolution,
      JSON.stringify(terminalIntent.legs),
      terminalIntent.mismatchPFatal ?? null,
      terminalIntent.mismatchPFatalUpper ?? null,
      terminalIntent.mismatchModelVersion ?? null,
      terminalIntent.fatalMismatchPnlUsd ?? null,
      terminalIntent.conservativeExpectedPnlUsd ?? null,
      terminalIntent.fatalLossExposureUsd ?? null,
      terminalIntent.mismatchRiskAudit === null || terminalIntent.mismatchRiskAudit === undefined
        ? null
        : JSON.stringify(terminalIntent.mismatchRiskAudit),
      terminalIntent.shadowExecution === null || terminalIntent.shadowExecution === undefined
        ? null
        : JSON.stringify(terminalIntent.shadowExecution),
      recordedAt,
    ],
  );
  if (!result.rows[0]) {
    throw new AccountingPersistenceError(
      "revision_conflict",
      `Intent ${terminalIntent.id} changed during accounting finalization`,
      terminalIntent.id,
    );
  }
  return result.rows[0];
}

function mapAccountingHeadRow(row: AccountingHeadRow): AccountingHead {
  return {
    intentId: row.intent_id,
    state: row.state,
    currentVersion: row.current_version === null ? null : Number(row.current_version),
    currentProofSha256: row.current_proof_sha256,
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function assertAccountingMutationContext(context: AccountingMutationContext) {
  if (
    !context.actor.trim() ||
    !UUID_PATTERN.test(context.requestId) ||
    !Number.isSafeInteger(context.occurredAt) ||
    context.occurredAt < 0
  ) {
    throw new AccountingPersistenceError(
      "invalid_input",
      "Accounting mutation requires a non-empty actor, UUID requestId, and safe occurredAt",
    );
  }
}

function assertExpectedOrderIntentRevision(expectedRevision: number, terminalIntent: OrderIntent) {
  assertValidOrderIntentRevision(terminalIntent);
  assertValidOrderIntentIdentityShape(terminalIntent);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || terminalIntent.revision !== expectedRevision) {
    throw new AccountingPersistenceError(
      "invalid_input",
      `Terminal intent ${terminalIntent.id} must carry expected revision ${expectedRevision}`,
      terminalIntent.id,
    );
  }
}

function assertLockedIntentRevision(intent: OrderIntentRow, expectedRevision: number) {
  if (Number(intent.revision) !== expectedRevision) {
    throw new AccountingPersistenceError(
      "revision_conflict",
      `Intent ${intent.id} expected revision ${expectedRevision}, found ${intent.revision}`,
      intent.id,
    );
  }
}

function assertAccountingTerminalTransition(
  currentStatus: OrderIntent["status"],
  terminalStatus: OrderIntent["status"],
  operation: AccountingMutationOperation,
  intentId: string,
) {
  const closedStatuses = new Set<OrderIntent["status"]>(["unwound", "settled", "failed", "skipped", "canceled"]);
  if (closedStatuses.has(currentStatus) && currentStatus !== terminalStatus) {
    throw new AccountingPersistenceError(
      "state_conflict",
      `Accounting ${operation} cannot rewrite terminal intent ${intentId} from ${currentStatus} to ${terminalStatus}`,
      intentId,
    );
  }
  if (operation === "reaccount" && currentStatus !== terminalStatus) {
    throw new AccountingPersistenceError(
      "state_conflict",
      `Accounting reaccount requires unchanged terminal status for ${intentId}`,
      intentId,
    );
  }
}

function assertExpectedAccountingHeadRevision(revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new AccountingPersistenceError("invalid_input", `Invalid expected accounting revision ${revision}`);
  }
}

function hashAccountingPayload(payload: unknown) {
  return createHash("sha256").update(canonicalizeJson(payload), "utf8").digest("hex");
}

function canonicalAccountingFillForRequest(fill: LiveFill) {
  return {
    id: fill.id,
    asset: fill.asset,
    shadow: fill.shadow,
    intentId: fill.intentId,
    venue: fill.venue,
    venueOrderId: fill.venueOrderId,
    tradeId: fill.tradeId,
    marketRef: fill.marketRef,
    tokenId: fill.tokenId ?? null,
    side: fill.side,
    outcome: fill.outcome,
    price: fill.price,
    size: fill.size,
    feeUsd: fill.feeUsd,
    liquidity: fill.liquidity,
    filledAt: fill.filledAt,
    raw: fill.raw,
  };
}

function accountingNumberToUnits(value: number, label: string, allowZero: boolean) {
  if (!Number.isFinite(value)) {
    throw new AccountingPersistenceError("invalid_input", `${label} must be finite`);
  }
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value.toString());
  if (!match) {
    throw new AccountingPersistenceError("invalid_input", `${label} is not a canonical decimal`);
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 400) {
    throw new AccountingPersistenceError("invalid_input", `${label} exponent is outside the exact domain`);
  }
  let digits = `${match[2]}${fraction}`.replace(/^0+(?=\d)/, "");
  let fractionalPlaces = fraction.length - exponent;
  if (fractionalPlaces > 8) {
    const keep = Math.max(0, digits.length - fractionalPlaces + 8);
    if (digits.slice(keep).replace(/0/g, "").length > 0) {
      throw new AccountingPersistenceError("invalid_input", `${label} has more than 8 decimal places`);
    }
    digits = digits.slice(0, keep) || "0";
    fractionalPlaces = 8;
  }
  const zeroes = 8 - fractionalPlaces;
  if (zeroes < 0) {
    throw new AccountingPersistenceError("invalid_input", `${label} cannot be represented at scale 1e8`);
  }
  const units = sign * BigInt(digits || "0") * 10n ** BigInt(zeroes);
  if (units < 0n || (!allowZero && units === 0n) || units > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AccountingPersistenceError("invalid_input", `${label} is outside the exact accounting domain`);
  }
  return units.toString();
}

function canonicalFixedToUnits(value: string) {
  const match = /^(-?)(\d+)\.(\d{8})$/.exec(value);
  if (!match) {
    throw new AccountingPersistenceError("identity_conflict", `Invalid canonical accounting amount ${value}`);
  }
  const units = BigInt(match[2]) * 100_000_000n + BigInt(match[3]);
  return (match[1] === "-" ? -units : units).toString();
}

function accountingUnitsToNumber(value: string) {
  const units = BigInt(value);
  if (units > BigInt(Number.MAX_SAFE_INTEGER) || units < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new AccountingPersistenceError("identity_conflict", "Accounting amount exceeds safe numeric projection");
  }
  return Number(units) / 100_000_000;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
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
      ),
      current_accounting AS (
        SELECT current_version, current_proof_sha256
        FROM accounting_heads
        WHERE intent_id = $1
          AND state = 'stable'
          AND current_version IS NOT NULL
          AND current_proof_sha256 IS NOT NULL
      )
      INSERT INTO stable_pnl_changes (
        intent_id, asset, combination, changed_at, settled_at, realized_pnl_usd, roi,
        target_notional_usd, equity_usd, cash_usd, positions_value_usd, strategy_pnl_usd,
        account_delta_usd, baseline_equity_usd, peak_equity_usd, drawdown_usd,
        venue_breakdown_json, stability_json, accounting_version, accounting_proof_sha256
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
        $9::jsonb,
        current_accounting.current_version,
        current_accounting.current_proof_sha256
      FROM latest
      CROSS JOIN baseline
      CROSS JOIN peak
      CROSS JOIN current_accounting
      ON CONFLICT (intent_id) DO UPDATE SET
        settled_at = EXCLUDED.settled_at,
        realized_pnl_usd = EXCLUDED.realized_pnl_usd,
        roi = EXCLUDED.roi,
        target_notional_usd = EXCLUDED.target_notional_usd,
        stability_json = EXCLUDED.stability_json,
        accounting_version = EXCLUDED.accounting_version,
        accounting_proof_sha256 = EXCLUDED.accounting_proof_sha256
      WHERE stable_pnl_changes.settled_at IS DISTINCT FROM EXCLUDED.settled_at
        OR stable_pnl_changes.realized_pnl_usd IS DISTINCT FROM EXCLUDED.realized_pnl_usd
        OR stable_pnl_changes.roi IS DISTINCT FROM EXCLUDED.roi
        OR stable_pnl_changes.target_notional_usd IS DISTINCT FROM EXCLUDED.target_notional_usd
        OR stable_pnl_changes.accounting_version IS DISTINCT FROM EXCLUDED.accounting_version
        OR stable_pnl_changes.accounting_proof_sha256 IS DISTINCT FROM EXCLUDED.accounting_proof_sha256
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
      UPDATE stable_pnl_changes AS stable
      SET
        settled_at = $2,
        realized_pnl_usd = $3,
        roi = $4,
        target_notional_usd = $5,
        accounting_version = head.current_version,
        accounting_proof_sha256 = head.current_proof_sha256
      FROM accounting_heads AS head
      WHERE stable.intent_id = $1
        AND head.intent_id = stable.intent_id
        AND head.state = 'stable'
        AND head.current_version IS NOT NULL
        AND head.current_proof_sha256 IS NOT NULL
        AND (
          stable.settled_at IS DISTINCT FROM $2
          OR stable.realized_pnl_usd IS DISTINCT FROM $3
          OR stable.roi IS DISTINCT FROM $4
          OR stable.target_notional_usd IS DISTINCT FROM $5
          OR stable.accounting_version IS DISTINCT FROM head.current_version
          OR stable.accounting_proof_sha256 IS DISTINCT FROM head.current_proof_sha256
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
    entryExecutionProbes: 0,
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
      AND EXISTS (
        SELECT 1 FROM accounting_fill_facts AS fact
        WHERE fact.fill_id = fills.id
      )
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
      AND NOT EXISTS (
        SELECT 1 FROM accounting_heads AS head
        WHERE head.intent_id = venue_orders.intent_id
      )
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
      AND NOT EXISTS (
        SELECT 1 FROM accounting_heads AS head
        WHERE head.intent_id = order_intents.id
      )
  `,
  );

  deleted.settlements = await deleteBefore(
    pool,
    config.retention.settlementsMs,
    now,
    `
    DELETE FROM settlements
    WHERE settled_at < $1
      AND EXISTS (
        SELECT 1 FROM accounting_settlement_facts AS fact
        WHERE fact.settlement_id = settlements.id
      )
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

  deleted.entryExecutionProbes = await deleteBefore(
    pool,
    config.retention.entryExecutionProbesMs,
    now,
    `
    DELETE FROM entry_execution_probes
    WHERE rest_captured_at < $1
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

export type CircuitBreakerIncidentPersistenceErrorCode =
  | "already_resolved"
  | "condition_not_recovered"
  | "cooldown_active"
  | "identity_conflict"
  | "incident_not_found"
  | "invalid_actor"
  | "invalid_incident"
  | "invalid_recovery_proof"
  | "legacy_clear_disabled"
  | "not_manual_kill"
  | "owner_mismatch"
  | "request_conflict"
  | "resolution_policy_mismatch"
  | "revision_conflict"
  | "unresolved_exposure";

export class CircuitBreakerIncidentPersistenceError extends Error {
  constructor(
    readonly code: CircuitBreakerIncidentPersistenceErrorCode,
    message: string,
    readonly incidentId: string | null = null,
  ) {
    super(message);
    this.name = "CircuitBreakerIncidentPersistenceError";
  }
}

type CircuitBreakerPersistenceTarget = Pool | PoolClient;

export async function observeCircuitBreakerIncident(
  target: CircuitBreakerPersistenceTarget,
  input: ObserveCircuitBreakerIncidentInput,
): Promise<CircuitBreakerIncident> {
  assertCircuitBreakerMutationContext(input);
  assertCircuitBreakerIncidentForPersistence(input.incident);
  const requestSha256 = hashCircuitBreakerMutationRequest({
    operation: "observe",
    actor: input.actor,
    incident: input.incident,
  });

  return withCircuitBreakerTransaction(target, async (client) => {
    const now = await readDatabaseClockMs(client);
    await ensureAndLockCircuitBreakerScopes(client, circuitBreakerScopeHierarchy(input.incident.scope), "update", now);
    await lockCircuitBreakerRequestId(client, input.requestId);
    const replay = await loadCircuitBreakerRequestReplay(client, input.requestId, requestSha256);
    if (replay) {
      return replay;
    }

    const scopeKey = getCircuitBreakerScopeKey(input.incident.scope);
    const openRows = await client.query<CircuitBreakerIncidentCurrentRow>(
      `
        SELECT *
        FROM circuit_breaker_incident_current
        WHERE scope_key = $1 AND owner = $2 AND incident_key = $3 AND status = 'open'
        ORDER BY triggered_at DESC, id DESC
        LIMIT 2
      `,
      [scopeKey, input.incident.owner, input.incident.incidentKey],
    );
    if (openRows.rows.length > 1) {
      throw new CircuitBreakerIncidentPersistenceError(
        "identity_conflict",
        `Multiple open incidents exist for ${scopeKey}/${input.incident.owner}/${input.incident.incidentKey}`,
      );
    }

    const openRow = openRows.rows[0];
    if (openRow) {
      assertCircuitBreakerObservationMatchesOpenIncident(openRow, input.incident);
      const lastObservedAt = Math.max(
        Number(openRow.last_observed_at),
        input.incident.timestamps.lastObservedAt,
        input.incident.timestamps.triggeredAt,
      );
      const cooldownUntil =
        input.incident.impact === "cooldown"
          ? Math.max(Number(openRow.cooldown_until ?? 0), Number(input.incident.timestamps.cooldownUntil))
          : null;
      await insertCircuitBreakerIncidentEvent(client, {
        incidentId: openRow.id,
        revision: Number(openRow.revision) + 1,
        eventType: "observed",
        status: "open",
        actor: input.actor,
        requestId: input.requestId,
        requestSha256,
        occurredAt: Math.max(input.incident.timestamps.updatedAt, lastObservedAt),
        recordedAt: now,
        lastObservedAt,
        cooldownUntil,
        acknowledgedAt: null,
        resolvedAt: null,
        exposure: openRow.exposure_json,
        payload: input.incident.payload,
      });
      return loadRequiredCircuitBreakerIncident(client, openRow.id);
    }

    const idConflict = await client.query<{ id: string }>(
      "SELECT id FROM circuit_breaker_incidents WHERE id = $1 LIMIT 1",
      [input.incident.id],
    );
    if (idConflict.rows[0]) {
      throw new CircuitBreakerIncidentPersistenceError(
        "identity_conflict",
        `Circuit-breaker incident id ${input.incident.id} cannot be reopened or reused`,
        input.incident.id,
      );
    }

    await client.query(
      `
        INSERT INTO circuit_breaker_incidents (
          id, scope_key, owner, incident_key, reason, impact, resolution_policy,
          intent_id, triggered_at, initial_exposure_json, initial_payload_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
      `,
      [
        input.incident.id,
        scopeKey,
        input.incident.owner,
        input.incident.incidentKey,
        input.incident.reason,
        input.incident.impact,
        input.incident.resolutionPolicy,
        input.incident.intentId,
        input.incident.timestamps.triggeredAt,
        JSON.stringify(input.incident.exposure),
        input.incident.payload === null ? null : JSON.stringify(input.incident.payload),
      ],
    );
    await insertCircuitBreakerIncidentEvent(client, {
      incidentId: input.incident.id,
      revision: 1,
      eventType: "observed",
      status: "open",
      actor: input.actor,
      requestId: input.requestId,
      requestSha256,
      occurredAt: input.incident.timestamps.updatedAt,
      recordedAt: now,
      lastObservedAt: input.incident.timestamps.lastObservedAt,
      cooldownUntil: input.incident.timestamps.cooldownUntil,
      acknowledgedAt: null,
      resolvedAt: null,
      exposure: input.incident.exposure,
      payload: input.incident.payload,
    });
    return loadRequiredCircuitBreakerIncident(client, input.incident.id);
  });
}

export async function recordCircuitBreakerExposureRecovery(
  target: CircuitBreakerPersistenceTarget,
  input: RecordCircuitBreakerExposureRecoveryInput,
): Promise<CircuitBreakerIncident> {
  assertCircuitBreakerMutationContext(input);
  assertCircuitBreakerExpectedRevision(input.expectedRevision);
  if (input.actor !== input.owner) {
    throw new CircuitBreakerIncidentPersistenceError("invalid_actor", "Exposure recovery actor must be the owner");
  }
  const requestSha256 = hashCircuitBreakerMutationRequest({
    operation: "exposure_resolved",
    actor: input.actor,
    incidentId: input.incidentId,
    expectedRevision: input.expectedRevision,
    owner: input.owner,
    recoveryProof: input.recoveryProof,
  });

  return mutateCircuitBreakerIncident(
    target,
    input.incidentId,
    input.requestId,
    requestSha256,
    async (client, row, now) => {
      const incident = mapCircuitBreakerIncidentCurrentRow(row);
      assertOpenCircuitBreakerRevision(incident, input.expectedRevision);
      if (input.owner !== incident.owner) {
        throw new CircuitBreakerIncidentPersistenceError(
          "owner_mismatch",
          "Only the incident owner may prove recovery",
          incident.id,
        );
      }
      if (incident.exposure.state !== "unresolved") {
        throw new CircuitBreakerIncidentPersistenceError(
          "invalid_recovery_proof",
          "Incident does not have unresolved exposure",
          incident.id,
        );
      }
      assertCircuitBreakerRecoveryProof(incident, input.recoveryProof, now);
      const exposure: CircuitBreakerExposure = {
        state: "resolved",
        confirmedBy: input.recoveryProof.owner,
        confirmedAt: input.recoveryProof.confirmedAt,
        evidenceId: input.recoveryProof.evidenceId,
      };
      await insertCircuitBreakerIncidentEvent(client, {
        incidentId: incident.id,
        revision: incident.revision + 1,
        eventType: "exposure_resolved",
        status: "open",
        actor: input.actor,
        requestId: input.requestId,
        requestSha256,
        occurredAt: now,
        recordedAt: now,
        lastObservedAt: incident.timestamps.lastObservedAt,
        cooldownUntil: incident.timestamps.cooldownUntil,
        acknowledgedAt: null,
        resolvedAt: null,
        exposure,
        payload: incident.payload,
      });
      return loadRequiredCircuitBreakerIncident(client, incident.id);
    },
  );
}

export async function resolveOwnedCircuitBreakerIncident(
  target: CircuitBreakerPersistenceTarget,
  input: ResolveOwnedCircuitBreakerIncidentInput,
): Promise<CircuitBreakerIncident> {
  assertCircuitBreakerMutationContext(input);
  assertCircuitBreakerExpectedRevision(input.expectedRevision);
  if (input.actor !== input.owner) {
    throw new CircuitBreakerIncidentPersistenceError("invalid_actor", "Resolution actor must be the incident owner");
  }
  const requestSha256 = hashCircuitBreakerMutationRequest({
    operation: "owner_resolved",
    actor: input.actor,
    incidentId: input.incidentId,
    expectedRevision: input.expectedRevision,
    owner: input.owner,
    conditionRecovered: input.conditionRecovered,
    exposureRecoveryProof: input.exposureRecoveryProof ?? null,
  });

  return mutateCircuitBreakerIncident(
    target,
    input.incidentId,
    input.requestId,
    requestSha256,
    async (client, row, now) => {
      const incident = mapCircuitBreakerIncidentCurrentRow(row);
      const decision = evaluateOwnerAutoResolve(incident, {
        owner: input.owner,
        expectedRevision: input.expectedRevision,
        now,
        conditionRecovered: input.conditionRecovered,
        exposureRecoveryProof: input.exposureRecoveryProof,
      });
      if (!decision.allowed) {
        throwCircuitBreakerPolicyDenial(decision.code, incident.id);
      }
      const exposure = resolveCircuitBreakerExposure(incident, input.exposureRecoveryProof ?? null, now);
      await insertCircuitBreakerIncidentEvent(client, {
        incidentId: incident.id,
        revision: incident.revision + 1,
        eventType: "owner_resolved",
        status: "resolved",
        actor: input.actor,
        requestId: input.requestId,
        requestSha256,
        occurredAt: now,
        recordedAt: now,
        lastObservedAt: incident.timestamps.lastObservedAt,
        cooldownUntil: incident.timestamps.cooldownUntil,
        acknowledgedAt: null,
        resolvedAt: now,
        exposure,
        payload: incident.payload,
      });
      return loadRequiredCircuitBreakerIncident(client, incident.id);
    },
  );
}

export async function acknowledgeCircuitBreakerIncident(
  target: CircuitBreakerPersistenceTarget,
  input: AcknowledgeCircuitBreakerIncidentInput,
): Promise<CircuitBreakerIncident> {
  return acknowledgeCircuitBreakerIncidentInternal(target, input, false);
}

export async function acknowledgeManualKillCircuitBreaker(
  target: CircuitBreakerPersistenceTarget,
  input: AcknowledgeCircuitBreakerIncidentInput,
): Promise<CircuitBreakerIncident> {
  return acknowledgeCircuitBreakerIncidentInternal(target, input, true);
}

async function acknowledgeCircuitBreakerIncidentInternal(
  target: CircuitBreakerPersistenceTarget,
  input: AcknowledgeCircuitBreakerIncidentInput,
  manualKillOnly: boolean,
) {
  assertCircuitBreakerMutationContext(input);
  assertCircuitBreakerExpectedRevision(input.expectedRevision);
  if (input.actor !== input.operatorId) {
    throw new CircuitBreakerIncidentPersistenceError("invalid_actor", "Acknowledgement actor must be the operator");
  }
  const requestSha256 = hashCircuitBreakerMutationRequest({
    operation: manualKillOnly ? "manual_kill_acknowledged" : "operator_acknowledged",
    actor: input.actor,
    incidentId: input.incidentId,
    expectedRevision: input.expectedRevision,
    operatorId: input.operatorId,
  });

  return mutateCircuitBreakerIncident(
    target,
    input.incidentId,
    input.requestId,
    requestSha256,
    async (client, row, now) => {
      const incident = mapCircuitBreakerIncidentCurrentRow(row);
      if (manualKillOnly && !isManualKillIncident(incident)) {
        throw new CircuitBreakerIncidentPersistenceError(
          "not_manual_kill",
          `Incident ${incident.id} is not the exact manual-kill identity`,
          incident.id,
        );
      }
      const decision = evaluateOperatorAcknowledge(incident, {
        operatorId: input.operatorId,
        expectedRevision: input.expectedRevision,
        now,
      });
      if (!decision.allowed) {
        throwCircuitBreakerPolicyDenial(decision.code, incident.id);
      }
      await insertCircuitBreakerIncidentEvent(client, {
        incidentId: incident.id,
        revision: incident.revision + 1,
        eventType: "operator_acknowledged",
        status: "resolved",
        actor: input.actor,
        requestId: input.requestId,
        requestSha256,
        occurredAt: now,
        recordedAt: now,
        lastObservedAt: incident.timestamps.lastObservedAt,
        cooldownUntil: incident.timestamps.cooldownUntil,
        acknowledgedAt: now,
        resolvedAt: now,
        exposure: incident.exposure,
        payload: incident.payload,
      });
      return loadRequiredCircuitBreakerIncident(client, incident.id);
    },
  );
}

export async function listCurrentCircuitBreakerIncidents(
  target: CircuitBreakerPersistenceTarget,
  options: { includeResolved?: boolean } = {},
): Promise<CircuitBreakerIncident[]> {
  const result = await target.query<CircuitBreakerIncidentCurrentRow>(
    `
      SELECT *
      FROM circuit_breaker_incident_current
      ${options.includeResolved ? "" : "WHERE status = 'open'"}
      ORDER BY scope_key ASC, triggered_at ASC, id ASC
    `,
  );
  return result.rows.map(mapCircuitBreakerIncidentCurrentRow);
}

// Compatibility bridge for legacy producers during the engine migration. It
// can only add an exact incident; broad legacy clears are deliberately refused.
export async function upsertCircuitBreaker(pool: Pool, breaker: CircuitBreaker) {
  if (!breaker.active) {
    throw new CircuitBreakerIncidentPersistenceError(
      "legacy_clear_disabled",
      `Legacy clear for ${breaker.key} is disabled; resolve or acknowledge an exact incident id`,
    );
  }
  if (breaker.reason === null || breaker.triggeredAt === null) {
    throw new CircuitBreakerIncidentPersistenceError(
      "invalid_incident",
      `Active legacy breaker ${breaker.key} requires reason and triggeredAt`,
    );
  }
  const scope = parseCircuitBreakerScopeKey(breaker.key);
  const payload = breaker.payload ?? {};
  const cooldownCandidate = payload.cooldownUntil;
  const cooldownUntil =
    typeof cooldownCandidate === "number" &&
    Number.isSafeInteger(cooldownCandidate) &&
    cooldownCandidate > breaker.triggeredAt
      ? cooldownCandidate
      : null;
  const manualKill = breaker.key === "global" && breaker.reason === "manual";
  const identity = {
    scopeKey: getCircuitBreakerScopeKey(scope),
    owner: manualKill ? "operator" : "legacy-runtime",
    incidentKey: manualKill ? "manual-kill" : `legacy:${breaker.reason}`,
    triggeredAt: breaker.triggeredAt,
  };
  const digest = hashCircuitBreakerMutationRequest(identity);
  const incident: CircuitBreakerIncident = {
    id: `cbi:legacy-runtime:${digest}`,
    scope,
    owner: identity.owner,
    incidentKey: identity.incidentKey,
    reason: breaker.reason,
    impact: cooldownUntil === null ? "blocked" : "cooldown",
    resolutionPolicy: "operator",
    intentId: typeof payload.intentId === "string" && payload.intentId.trim() ? payload.intentId : null,
    exposure:
      breaker.reason === "hedge_failure" || payload.requiresManualClear === true
        ? { state: "unresolved" }
        : { state: "none" },
    revision: 1,
    timestamps: {
      triggeredAt: breaker.triggeredAt,
      updatedAt: breaker.triggeredAt,
      lastObservedAt: breaker.triggeredAt,
      cooldownUntil,
      acknowledgedAt: null,
      resolvedAt: null,
    },
    payload,
  };
  return observeCircuitBreakerIncident(pool, {
    incident,
    actor: identity.owner,
    requestId: `legacy-runtime:${digest}`,
  });
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

async function mutateCircuitBreakerIncident(
  target: CircuitBreakerPersistenceTarget,
  incidentId: string,
  requestId: string,
  requestSha256: string,
  mutate: (client: PoolClient, row: CircuitBreakerIncidentCurrentRow, now: number) => Promise<CircuitBreakerIncident>,
) {
  if (!incidentId.trim()) {
    throw new CircuitBreakerIncidentPersistenceError("invalid_incident", "incidentId is required");
  }
  return withCircuitBreakerTransaction(target, async (client) => {
    const scopeResult = await client.query<CircuitBreakerScopeRow>(
      `
        SELECT scope.*
        FROM circuit_breaker_incidents incident
        JOIN circuit_breaker_scopes scope ON scope.scope_key = incident.scope_key
        WHERE incident.id = $1
      `,
      [incidentId],
    );
    const scopeRow = scopeResult.rows[0];
    if (!scopeRow) {
      throw new CircuitBreakerIncidentPersistenceError(
        "incident_not_found",
        `Circuit-breaker incident ${incidentId} was not found`,
        incidentId,
      );
    }
    const scope = mapCircuitBreakerScopeRow(scopeRow);
    const now = await readDatabaseClockMs(client);
    await ensureAndLockCircuitBreakerScopes(client, circuitBreakerScopeHierarchy(scope), "update", now);
    await lockCircuitBreakerRequestId(client, requestId);
    const replay = await loadCircuitBreakerRequestReplay(client, requestId, requestSha256);
    if (replay) {
      return replay;
    }
    const row = await loadRequiredCircuitBreakerIncidentRow(client, incidentId);
    return mutate(client, row, now);
  });
}

async function withCircuitBreakerTransaction<T>(
  target: CircuitBreakerPersistenceTarget,
  work: (client: PoolClient) => Promise<T>,
) {
  if (isCircuitBreakerPoolClient(target)) {
    await target.query("SAVEPOINT circuit_breaker_persistence_guard");
    try {
      const result = await work(target);
      await target.query("RELEASE SAVEPOINT circuit_breaker_persistence_guard");
      return result;
    } catch (error) {
      try {
        await target.query("ROLLBACK TO SAVEPOINT circuit_breaker_persistence_guard");
        await target.query("RELEASE SAVEPOINT circuit_breaker_persistence_guard");
      } catch {
        // Preserve the persistence error. The caller owns the outer transaction.
      }
      throw error;
    }
  }
  return withRowLockTransaction(target, work);
}

function isCircuitBreakerPoolClient(target: CircuitBreakerPersistenceTarget): target is PoolClient {
  return typeof (target as PoolClient).release === "function";
}

function circuitBreakerScopeHierarchy(scope: CircuitBreakerScope): CircuitBreakerScope[] {
  if (scope.type === "global") {
    return [{ type: "global" }];
  }
  if (scope.type === "asset") {
    return [{ type: "global" }, scope];
  }
  return [{ type: "global" }, { type: "asset", asset: scope.asset }, scope];
}

async function ensureAndLockCircuitBreakerScopes(
  client: PoolClient,
  scopes: readonly CircuitBreakerScope[],
  lockMode: "share" | "update",
  createdAt?: number,
) {
  const now = createdAt ?? (await readDatabaseClockMs(client));
  const uniqueScopes = [...new Map(scopes.map((scope) => [getCircuitBreakerScopeKey(scope), scope])).values()].sort(
    (left, right) => getCircuitBreakerScopeKey(left).localeCompare(getCircuitBreakerScopeKey(right)),
  );
  for (const scope of uniqueScopes) {
    const values = circuitBreakerScopeValues(scope, now);
    await client.query(
      `
        INSERT INTO circuit_breaker_scopes (scope_key, scope_type, asset, slot_key, created_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (scope_key) DO NOTHING
      `,
      [...values],
    );
  }
  const keys = uniqueScopes.map(getCircuitBreakerScopeKey);
  const locked = await client.query<{ scope_key: string }>(
    `
      SELECT scope_key
      FROM circuit_breaker_scopes
      WHERE scope_key = ANY($1::text[])
      ORDER BY scope_key ASC
      FOR ${lockMode === "share" ? "SHARE" : "UPDATE"}
    `,
    [keys],
  );
  if (locked.rows.length !== keys.length) {
    throw new Error(`Missing circuit-breaker coordination scope: expected ${keys.join(",")}`);
  }
}

function circuitBreakerScopeValues(scope: CircuitBreakerScope, createdAt: number) {
  if (scope.type === "global") {
    return ["global", "global", null, null, createdAt] as const;
  }
  if (scope.type === "asset") {
    return [`asset:${scope.asset}`, "asset", scope.asset, null, createdAt] as const;
  }
  return [`slot:${scope.slotKey}`, "slot", scope.asset, scope.slotKey, createdAt] as const;
}

async function lockCircuitBreakerRequestId(client: PoolClient, requestId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 620260720))", [requestId]);
}

async function loadCircuitBreakerRequestReplay(
  client: PoolClient,
  requestId: string,
  requestSha256: string,
): Promise<CircuitBreakerIncident | null> {
  const result = await client.query<{ incident_id: string; request_sha256: string }>(
    `
      SELECT incident_id, request_sha256
      FROM circuit_breaker_incident_events
      WHERE request_id = $1
      LIMIT 1
    `,
    [requestId],
  );
  const existing = result.rows[0];
  if (!existing) {
    return null;
  }
  if (existing.request_sha256 !== requestSha256) {
    throw new CircuitBreakerIncidentPersistenceError(
      "request_conflict",
      `Circuit-breaker requestId ${requestId} was already used for a different mutation`,
      existing.incident_id,
    );
  }
  return loadRequiredCircuitBreakerIncident(client, existing.incident_id);
}

async function loadRequiredCircuitBreakerIncidentRow(client: PoolClient, incidentId: string) {
  const result = await client.query<CircuitBreakerIncidentCurrentRow>(
    "SELECT * FROM circuit_breaker_incident_current WHERE id = $1 LIMIT 1",
    [incidentId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CircuitBreakerIncidentPersistenceError(
      "incident_not_found",
      `Circuit-breaker incident ${incidentId} has no current event`,
      incidentId,
    );
  }
  return row;
}

async function loadRequiredCircuitBreakerIncident(client: PoolClient, incidentId: string) {
  return mapCircuitBreakerIncidentCurrentRow(await loadRequiredCircuitBreakerIncidentRow(client, incidentId));
}

type InsertCircuitBreakerIncidentEventInput = {
  incidentId: string;
  revision: number;
  eventType: CircuitBreakerIncidentEventType;
  status: "open" | "resolved";
  actor: string;
  requestId: string;
  requestSha256: string;
  occurredAt: number;
  recordedAt: number;
  lastObservedAt: number;
  cooldownUntil: number | null;
  acknowledgedAt: number | null;
  resolvedAt: number | null;
  exposure: CircuitBreakerExposure;
  payload: Readonly<Record<string, unknown>> | null;
};

async function insertCircuitBreakerIncidentEvent(client: PoolClient, input: InsertCircuitBreakerIncidentEventInput) {
  await client.query(
    `
      INSERT INTO circuit_breaker_incident_events (
        incident_id, revision, event_type, status, actor, request_id, request_sha256,
        occurred_at, recorded_at, last_observed_at, cooldown_until,
        acknowledged_at, resolved_at, exposure_json, payload_json
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb
      )
    `,
    [
      input.incidentId,
      input.revision,
      input.eventType,
      input.status,
      input.actor,
      input.requestId,
      input.requestSha256,
      input.occurredAt,
      input.recordedAt,
      input.lastObservedAt,
      input.cooldownUntil,
      input.acknowledgedAt,
      input.resolvedAt,
      JSON.stringify(input.exposure),
      input.payload === null ? null : JSON.stringify(input.payload),
    ],
  );
}

function mapCircuitBreakerIncidentCurrentRow(row: CircuitBreakerIncidentCurrentRow): CircuitBreakerIncident {
  return {
    id: row.id,
    scope: mapCircuitBreakerScopeRow(row),
    owner: row.owner,
    incidentKey: row.incident_key,
    reason: row.reason,
    impact: row.impact,
    resolutionPolicy: row.resolution_policy,
    intentId: row.intent_id,
    exposure: row.exposure_json,
    revision: Number(row.revision),
    timestamps: {
      triggeredAt: Number(row.triggered_at),
      updatedAt: Number(row.recorded_at),
      lastObservedAt: Number(row.last_observed_at),
      cooldownUntil: row.cooldown_until === null ? null : Number(row.cooldown_until),
      acknowledgedAt: row.acknowledged_at === null ? null : Number(row.acknowledged_at),
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    },
    payload: row.payload_json,
  };
}

function mapCircuitBreakerScopeRow(row: CircuitBreakerScopeRow): CircuitBreakerScope {
  if (row.scope_type === "global") {
    return { type: "global" };
  }
  if (row.asset === null) {
    throw new Error(`Circuit-breaker scope ${row.scope_key} is missing its asset`);
  }
  if (row.scope_type === "asset") {
    return { type: "asset", asset: row.asset };
  }
  if (row.slot_key === null) {
    throw new Error(`Circuit-breaker scope ${row.scope_key} is missing its slot key`);
  }
  return { type: "slot", asset: row.asset, slotKey: row.slot_key };
}

function assertCircuitBreakerObservationMatchesOpenIncident(
  row: CircuitBreakerIncidentCurrentRow,
  incoming: CircuitBreakerIncident,
) {
  const conflicts = [
    row.scope_key !== getCircuitBreakerScopeKey(incoming.scope) ? "scope" : null,
    row.owner !== incoming.owner ? "owner" : null,
    row.incident_key !== incoming.incidentKey ? "incidentKey" : null,
    row.reason !== incoming.reason ? "reason" : null,
    row.impact !== incoming.impact ? "impact" : null,
    row.resolution_policy !== incoming.resolutionPolicy ? "resolutionPolicy" : null,
    row.intent_id !== incoming.intentId ? "intentId" : null,
    canonicalizeJson(row.initial_exposure_json) !== canonicalizeJson(incoming.exposure) ? "initialExposure" : null,
  ].filter((field): field is string => field !== null);
  if (conflicts.length > 0) {
    throw new CircuitBreakerIncidentPersistenceError(
      "identity_conflict",
      `Open circuit-breaker identity conflicts on ${conflicts.join(", ")}`,
      row.id,
    );
  }
}

function assertCircuitBreakerMutationContext(context: CircuitBreakerMutationContext) {
  if (
    !context.actor.trim() ||
    !context.requestId.trim() ||
    context.actor.length > 256 ||
    context.requestId.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(context.actor) ||
    /[\u0000-\u001f\u007f]/.test(context.requestId)
  ) {
    throw new CircuitBreakerIncidentPersistenceError("invalid_actor", "actor and requestId are required");
  }
}

function assertCircuitBreakerExpectedRevision(revision: number) {
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new CircuitBreakerIncidentPersistenceError("revision_conflict", `Invalid expected revision ${revision}`);
  }
}

function assertCircuitBreakerIncidentForPersistence(incident: CircuitBreakerIncident) {
  if (!incident.id.trim() || !incident.owner.trim() || !incident.incidentKey.trim() || !incident.reason.trim()) {
    throw new CircuitBreakerIncidentPersistenceError("invalid_incident", "Incident identity fields are required");
  }
  if (!MARKET_ASSETS.includes((incident.scope as { asset?: MarketAsset }).asset ?? "btc")) {
    throw new CircuitBreakerIncidentPersistenceError("invalid_incident", "Incident scope contains an invalid asset");
  }
  if (
    incident.scope.type === "slot" &&
    (!incident.scope.slotKey.startsWith(`${incident.scope.asset}:`) ||
      incident.scope.slotKey.length <= incident.scope.asset.length + 1)
  ) {
    throw new CircuitBreakerIncidentPersistenceError("invalid_incident", "Incident slot scope is not canonical");
  }
  if (incident.revision !== 1) {
    throw new CircuitBreakerIncidentPersistenceError("invalid_incident", "New observations must use revision 1");
  }
  const timestamps = incident.timestamps;
  for (const [field, value] of [
    ["triggeredAt", timestamps.triggeredAt],
    ["updatedAt", timestamps.updatedAt],
    ["lastObservedAt", timestamps.lastObservedAt],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new CircuitBreakerIncidentPersistenceError("invalid_incident", `Invalid incident ${field}`);
    }
  }
  if (timestamps.updatedAt < timestamps.triggeredAt || timestamps.lastObservedAt < timestamps.triggeredAt) {
    throw new CircuitBreakerIncidentPersistenceError("invalid_incident", "Incident timestamps move backwards");
  }
  if (timestamps.acknowledgedAt !== null || timestamps.resolvedAt !== null) {
    throw new CircuitBreakerIncidentPersistenceError("invalid_incident", "Observed incidents must start open");
  }
  if (
    (incident.impact === "cooldown" &&
      (timestamps.cooldownUntil === null ||
        !Number.isSafeInteger(timestamps.cooldownUntil) ||
        timestamps.cooldownUntil <= timestamps.triggeredAt)) ||
    (incident.impact !== "cooldown" && timestamps.cooldownUntil !== null)
  ) {
    throw new CircuitBreakerIncidentPersistenceError("invalid_incident", "Incident cooldown is inconsistent");
  }
  assertCircuitBreakerExposureShape(incident.exposure);
  canonicalizeJson(incident.payload);
  getCircuitBreakerScopeKey(incident.scope);
}

function assertCircuitBreakerExposureShape(exposure: CircuitBreakerExposure) {
  if (exposure.state === "none" || exposure.state === "unresolved") {
    return;
  }
  if (
    exposure.state !== "resolved" ||
    !exposure.confirmedBy.trim() ||
    !exposure.evidenceId.trim() ||
    !Number.isSafeInteger(exposure.confirmedAt) ||
    exposure.confirmedAt < 0
  ) {
    throw new CircuitBreakerIncidentPersistenceError("invalid_incident", "Invalid incident exposure state");
  }
}

function assertOpenCircuitBreakerRevision(incident: CircuitBreakerIncident, expectedRevision: number) {
  if (incident.timestamps.resolvedAt !== null) {
    throw new CircuitBreakerIncidentPersistenceError("already_resolved", "Incident is already resolved", incident.id);
  }
  if (incident.revision !== expectedRevision) {
    throw new CircuitBreakerIncidentPersistenceError(
      "revision_conflict",
      `Expected circuit-breaker revision ${expectedRevision}, found ${incident.revision}`,
      incident.id,
    );
  }
}

function assertCircuitBreakerRecoveryProof(
  incident: CircuitBreakerIncident,
  proof: ResolveOwnedCircuitBreakerIncidentInput["exposureRecoveryProof"],
  now: number,
): asserts proof is CircuitBreakerRecoveryProof {
  if (
    proof === null ||
    proof === undefined ||
    proof.owner !== incident.owner ||
    !proof.evidenceId.trim() ||
    !Number.isSafeInteger(proof.confirmedAt) ||
    proof.confirmedAt < incident.timestamps.triggeredAt ||
    proof.confirmedAt > now
  ) {
    throw new CircuitBreakerIncidentPersistenceError(
      "invalid_recovery_proof",
      "Exposure recovery proof is not valid for this incident",
      incident.id,
    );
  }
}

function resolveCircuitBreakerExposure(
  incident: CircuitBreakerIncident,
  proof: ResolveOwnedCircuitBreakerIncidentInput["exposureRecoveryProof"],
  now: number,
): CircuitBreakerExposure {
  if (incident.exposure.state !== "unresolved") {
    return incident.exposure;
  }
  assertCircuitBreakerRecoveryProof(incident, proof, now);
  return {
    state: "resolved",
    confirmedBy: proof.owner,
    confirmedAt: proof.confirmedAt,
    evidenceId: proof.evidenceId,
  };
}

function throwCircuitBreakerPolicyDenial(
  code: Exclude<CircuitBreakerIncidentPersistenceErrorCode, "incident_not_found">,
  incidentId: string,
): never {
  throw new CircuitBreakerIncidentPersistenceError(code, `Circuit-breaker mutation denied: ${code}`, incidentId);
}

function hashCircuitBreakerMutationRequest(value: unknown) {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}

function parseCircuitBreakerScopeKey(key: CircuitBreaker["key"]): CircuitBreakerScope {
  if (key === "global") {
    return { type: "global" };
  }
  if (key.startsWith("asset:")) {
    const asset = key.slice("asset:".length) as MarketAsset;
    if (MARKET_ASSETS.includes(asset)) {
      return { type: "asset", asset };
    }
  }
  if (key.startsWith("slot:")) {
    const slotKey = key.slice("slot:".length);
    const asset = slotKey.split(":", 1)[0] as MarketAsset;
    if (MARKET_ASSETS.includes(asset) && slotKey.startsWith(`${asset}:`) && slotKey.length > asset.length + 1) {
      return { type: "slot", asset, slotKey };
    }
  }
  throw new CircuitBreakerIncidentPersistenceError("invalid_incident", `Invalid circuit-breaker scope ${key}`);
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

export async function tryWithShadowExecutionLock<T>(
  pool: Pool,
  asset: MarketAsset,
  slotKey: string,
  owner: string,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false; value: null }> {
  const client = await pool.connect();
  const lockName = `${asset}:${slotKey}`;
  let acquired = false;
  try {
    const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked", [
      SHADOW_EXECUTION_LOCK_NAMESPACE,
      lockName,
    ]);
    acquired = Boolean(result.rows[0]?.locked);
    if (!acquired) {
      return { acquired: false, value: null };
    }

    void owner;
    return { acquired: true, value: await fn() };
  } finally {
    if (acquired) {
      await client.query("SELECT pg_advisory_unlock($1, hashtext($2))", [SHADOW_EXECUTION_LOCK_NAMESPACE, lockName]);
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
    config: (await getStrategyConfig(pool, slot.asset)).config,
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
        config: configs[slot.asset].config,
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

function mapEntryExecutionProbeRow(row: EntryExecutionProbeRow): EntryExecutionProbeRecord {
  return {
    probeKey: row.probe_key,
    asset: row.asset,
    slotKey: row.slot_key,
    slotStartTs: Number(row.slot_start_ts),
    slotEndTs: Number(row.slot_end_ts),
    combination: row.combination,
    probeKind: row.probe_kind,
    targetSecondsRemaining:
      row.target_seconds_remaining === null
        ? null
        : (Number(row.target_seconds_remaining) as 55 | 45 | 35 | 25 | 15 | 5),
    signalCapturedAt: Number(row.signal_captured_at),
    restStartedAt: Number(row.rest_started_at),
    restCapturedAt: Number(row.rest_captured_at),
    decision: row.decision,
    firstRejectionStage: row.first_rejection_stage,
    firstRejectionCode: row.first_rejection_code,
    strategyRevision: Number(row.strategy_revision),
    globalRiskRevision: Number(row.global_risk_revision),
    signal: row.signal_json ?? {},
    rest: row.rest_json ?? {},
    risk: row.risk_json ?? {},
    variants: row.variants_json ?? [],
    evidenceSha256: row.evidence_sha256,
    recordedAt: Number(row.recorded_at),
  };
}

function mapMismatchCalibrationArtifactRow(row: MismatchCalibrationArtifactRow): MismatchCalibrationArtifactRecord {
  return {
    id: row.id,
    schemaVersion: Number(row.schema_version),
    baseModelVersion: row.base_model_version,
    trainingStartedAt: Number(row.training_started_at),
    trainingEndedAt: Number(row.training_ended_at),
    artifact: row.artifact_json ?? {},
    metrics: row.metrics_json ?? {},
    artifactSha256: row.artifact_sha256,
    createdAt: Number(row.created_at),
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
    revision: row.revision,
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
    requestSha256: row.request_sha256 ?? null,
    submissionDeadlineAt:
      row.submission_deadline_at === null || row.submission_deadline_at === undefined
        ? null
        : Number(row.submission_deadline_at),
    revision: Number(row.revision),
    result: row.result_json ?? null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEntryReservationRow(row: EntryReservationRow): EntryReservation {
  return {
    scopeKey: row.scope_key,
    mode: row.mode,
    asset: row.asset,
    ownerIntentId: row.owner_intent_id,
    reservedAt: row.reserved_at,
    revision: Number(row.revision),
  };
}

function mapEntryAdmissionRow(row: EntryAdmissionRow): EntryAdmission {
  return {
    id: row.id,
    sequence: Number(row.admission_sequence),
    intentId: row.intent_id,
    attemptId: row.attempt_id,
    mode: row.mode,
    asset: row.asset,
    slotKey: row.slot_key,
    combination: row.combination,
    grossCost: Number(row.gross_cost),
    requestSha256: row.request_sha256,
    strategyRevision: Number(row.strategy_revision),
    globalRiskRevision: Number(row.global_risk_revision),
    mismatchCalibrationArtifactId: row.mismatch_calibration_artifact_id,
    mismatchCalibrationRevision: Number(row.mismatch_calibration_revision),
    policyEvaluatedAt: Number(row.policy_evaluated_at),
    cutoffAt: row.cutoff_at === null ? null : Number(row.cutoff_at),
    latestSubmissionStartAt: row.latest_submission_start_at === null ? null : Number(row.latest_submission_start_at),
    evidence: row.evidence_json ?? {},
    authorizedAt: Number(row.authorized_at),
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
