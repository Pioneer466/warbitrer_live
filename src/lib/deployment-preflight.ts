import { createHash } from "node:crypto";

import { getDatabaseMigrationStatus, type PgQueryable } from "@/lib/db-migrations";
import { isTruthyEnv } from "@/lib/env";
import {
  DATABASE_MIGRATIONS,
  getLiveAccountingBacklog,
  hashMismatchCalibrationActivationRequest,
  type MismatchCalibrationActivationRequest,
} from "@/lib/postgres-db";
import {
  evaluateMismatchCalibrationActivationEligibility,
  verifyMismatchCalibrationArtifact,
} from "@/lib/mismatch-calibration";
import type { AccountingBacklogSummary } from "@/lib/types";

const MINIMUM_PREFLIGHT_SCHEMA_VERSION = 1;
const ACCOUNTING_SCHEMA_VERSION = 7;
const ACCOUNTING_EVIDENCE_SCHEMA_VERSION = 8;
const MISMATCH_CALIBRATION_SCHEMA_VERSION = 10;
// V10 adds diagnostic/calibration evidence and binds its active revision into entry admission;
// the live exposure truth queries below are unchanged.
export const DEPLOYMENT_PREFLIGHT_REVIEWED_SCHEMA_VERSION = 10;

export const DEPLOYMENT_PREFLIGHT_REQUIRED_COLUMNS = {
  order_intents: ["id", "asset", "shadow", "status", "legs_json"],
  order_attempts: [
    "id",
    "asset",
    "intent_id",
    "shadow",
    "venue",
    "client_order_id",
    "venue_order_id",
    "side",
    "order_type",
    "status",
    "truth_status",
    "request_json",
    "result_json",
  ],
  venue_orders: [
    "id",
    "asset",
    "intent_id",
    "shadow",
    "venue",
    "venue_order_id",
    "client_order_id",
    "market_ref",
    "token_id",
    "side",
    "outcome",
    "order_type",
    "requested_price",
    "status",
    "requested_size",
    "filled_size",
    "average_fill_price",
    "fee_usd",
  ],
  fills: ["id", "asset", "intent_id", "shadow", "price", "size", "fee_usd"],
  positions: ["id", "venue", "size", "current_value_usd", "redeemable", "mergeable"],
} as const;

const ENTRY_ADMISSION_REQUIRED_COLUMNS = {
  entry_reservations: ["scope_key", "mode", "owner_intent_id"],
} as const;

const ACCOUNTING_REQUIRED_COLUMNS = {
  accounting_heads: ["intent_id", "state", "current_version", "current_proof_sha256", "revision"],
  accounting_legs: ["intent_id", "leg_id", "identity_sha256"],
  accounting_fill_facts: ["fill_id", "intent_id", "leg_id", "finality", "fact_sha256"],
  accounting_settlement_facts: ["settlement_id", "intent_id", "leg_id", "finality", "fact_sha256"],
  accounting_versions: ["intent_id", "version", "proof_sha256", "realized_pnl_units"],
  accounting_version_fill_facts: ["intent_id", "version", "fill_id"],
  accounting_version_settlement_facts: ["intent_id", "version", "settlement_id"],
  accounting_realized_pnl_ledger: ["intent_id", "accounting_version", "effective_at", "realized_pnl_delta_units"],
  accounting_quarantines: ["intent_id", "reason", "request_id"],
  accounting_no_exposure_closures: ["intent_id", "request_id", "proof_sha256"],
  accounting_stability_observations: ["intent_id", "accounting_version", "request_id"],
  accounting_mutation_requests: ["request_id", "intent_id", "operation", "request_sha256"],
} as const;

const ACCOUNTING_EVIDENCE_REQUIRED_COLUMNS = {
  accounting_fill_finality_observations: [
    "fill_id",
    "request_id",
    "previous_finality",
    "observed_finality",
    "observed_fee_units",
    "observation_sha256",
  ],
} as const;

const MISMATCH_CALIBRATION_REQUIRED_COLUMNS = {
  entry_admissions: ["mismatch_calibration_artifact_id", "mismatch_calibration_revision"],
  entry_execution_probes: [
    "probe_key",
    "asset",
    "slot_key",
    "slot_start_ts",
    "slot_end_ts",
    "combination",
    "probe_kind",
    "target_seconds_remaining",
    "signal_captured_at",
    "rest_started_at",
    "rest_captured_at",
    "decision",
    "first_rejection_stage",
    "first_rejection_code",
    "strategy_revision",
    "global_risk_revision",
    "signal_json",
    "rest_json",
    "risk_json",
    "variants_json",
    "evidence_sha256",
    "recorded_at",
  ],
  mismatch_calibration_artifacts: [
    "id",
    "schema_version",
    "base_model_version",
    "training_started_at",
    "training_ended_at",
    "artifact_json",
    "metrics_json",
    "artifact_sha256",
    "created_at",
  ],
  mismatch_calibration_activation: ["id", "artifact_id", "revision", "updated_at"],
  mismatch_calibration_activation_events: [
    "id",
    "request_id",
    "request_sha256",
    "request_json",
    "previous_artifact_id",
    "artifact_id",
    "previous_revision",
    "revision",
    "actor",
    "reason",
    "occurred_at",
    "recorded_at",
  ],
} as const;

const MISMATCH_CALIBRATION_REQUIRED_TRIGGERS = [
  {
    name: "entry_execution_probes_immutable",
    relation: "entry_execution_probes",
    procedure: "reject_entry_execution_probe_update",
    triggerType: 50,
    deferrable: false,
    initiallyDeferred: false,
    constraintTrigger: false,
  },
  {
    name: "mismatch_calibration_activation_event_chain",
    relation: "mismatch_calibration_activation_events",
    procedure: "validate_mismatch_calibration_activation_event",
    triggerType: 7,
    deferrable: false,
    initiallyDeferred: false,
    constraintTrigger: false,
  },
  {
    name: "mismatch_calibration_activation_update_guard",
    relation: "mismatch_calibration_activation",
    procedure: "require_mismatch_calibration_activation_event",
    triggerType: 19,
    deferrable: false,
    initiallyDeferred: false,
    constraintTrigger: false,
  },
  {
    name: "mismatch_calibration_activation_event_state_guard",
    relation: "mismatch_calibration_activation_events",
    procedure: "require_mismatch_calibration_activation_state",
    triggerType: 5,
    deferrable: true,
    initiallyDeferred: true,
    constraintTrigger: true,
  },
  {
    name: "mismatch_calibration_activation_singleton_guard",
    relation: "mismatch_calibration_activation",
    procedure: "reject_mismatch_calibration_fact_mutation",
    triggerType: 42,
    deferrable: false,
    initiallyDeferred: false,
    constraintTrigger: false,
  },
  {
    name: "mismatch_calibration_artifacts_append_only",
    relation: "mismatch_calibration_artifacts",
    procedure: "reject_mismatch_calibration_fact_mutation",
    triggerType: 58,
    deferrable: false,
    initiallyDeferred: false,
    constraintTrigger: false,
  },
  {
    name: "mismatch_calibration_activation_events_append_only",
    relation: "mismatch_calibration_activation_events",
    procedure: "reject_mismatch_calibration_fact_mutation",
    triggerType: 58,
    deferrable: false,
    initiallyDeferred: false,
    constraintTrigger: false,
  },
] as const;

type V10ColumnExpectation = {
  dataType: "bigint" | "integer" | "jsonb" | "text" | "uuid";
  nullable: boolean;
  defaultKind?: "sequence";
};

const MISMATCH_CALIBRATION_REQUIRED_COLUMN_DEFINITIONS = {
  entry_admissions: {
    mismatch_calibration_artifact_id: { dataType: "text", nullable: true },
    mismatch_calibration_revision: { dataType: "bigint", nullable: false },
  },
  entry_execution_probes: {
    probe_key: { dataType: "text", nullable: false },
    asset: { dataType: "text", nullable: false },
    slot_key: { dataType: "text", nullable: false },
    slot_start_ts: { dataType: "bigint", nullable: false },
    slot_end_ts: { dataType: "bigint", nullable: false },
    combination: { dataType: "text", nullable: false },
    probe_kind: { dataType: "text", nullable: false },
    target_seconds_remaining: { dataType: "integer", nullable: true },
    signal_captured_at: { dataType: "bigint", nullable: false },
    rest_started_at: { dataType: "bigint", nullable: false },
    rest_captured_at: { dataType: "bigint", nullable: false },
    decision: { dataType: "text", nullable: false },
    first_rejection_stage: { dataType: "text", nullable: true },
    first_rejection_code: { dataType: "text", nullable: true },
    strategy_revision: { dataType: "bigint", nullable: false },
    global_risk_revision: { dataType: "bigint", nullable: false },
    signal_json: { dataType: "jsonb", nullable: false },
    rest_json: { dataType: "jsonb", nullable: false },
    risk_json: { dataType: "jsonb", nullable: false },
    variants_json: { dataType: "jsonb", nullable: false },
    evidence_sha256: { dataType: "text", nullable: false },
    recorded_at: { dataType: "bigint", nullable: false },
  },
  mismatch_calibration_artifacts: {
    id: { dataType: "text", nullable: false },
    schema_version: { dataType: "integer", nullable: false },
    base_model_version: { dataType: "text", nullable: false },
    training_started_at: { dataType: "bigint", nullable: false },
    training_ended_at: { dataType: "bigint", nullable: false },
    artifact_json: { dataType: "jsonb", nullable: false },
    metrics_json: { dataType: "jsonb", nullable: false },
    artifact_sha256: { dataType: "text", nullable: false },
    created_at: { dataType: "bigint", nullable: false },
  },
  mismatch_calibration_activation: {
    id: { dataType: "integer", nullable: false },
    artifact_id: { dataType: "text", nullable: true },
    revision: { dataType: "bigint", nullable: false },
    updated_at: { dataType: "bigint", nullable: false },
  },
  mismatch_calibration_activation_events: {
    id: { dataType: "bigint", nullable: false, defaultKind: "sequence" },
    request_id: { dataType: "uuid", nullable: false },
    request_sha256: { dataType: "text", nullable: false },
    request_json: { dataType: "jsonb", nullable: false },
    previous_artifact_id: { dataType: "text", nullable: true },
    artifact_id: { dataType: "text", nullable: true },
    previous_revision: { dataType: "bigint", nullable: false },
    revision: { dataType: "bigint", nullable: false },
    actor: { dataType: "text", nullable: false },
    reason: { dataType: "text", nullable: false },
    occurred_at: { dataType: "bigint", nullable: false },
    recorded_at: { dataType: "bigint", nullable: false },
  },
} as const satisfies Record<string, Record<string, V10ColumnExpectation>>;

type V10KeyConstraintExpectation = {
  kind: "p" | "u";
  name: string;
  table: string;
  columns: readonly string[];
};

type V10ForeignKeyConstraintExpectation = {
  kind: "f";
  name: string;
  table: string;
  columns: readonly string[];
  referencedTable: string;
  referencedColumns: readonly string[];
  updateAction: "a";
  deleteAction: "r";
  matchType: "s";
};

const MISMATCH_CALIBRATION_REQUIRED_KEY_CONSTRAINTS = [
  { kind: "p", name: "entry_execution_probes_pkey", table: "entry_execution_probes", columns: ["probe_key"] },
  {
    kind: "p",
    name: "mismatch_calibration_artifacts_pkey",
    table: "mismatch_calibration_artifacts",
    columns: ["id"],
  },
  {
    kind: "u",
    name: "mismatch_calibration_artifacts_artifact_sha256_key",
    table: "mismatch_calibration_artifacts",
    columns: ["artifact_sha256"],
  },
  {
    kind: "p",
    name: "mismatch_calibration_activation_pkey",
    table: "mismatch_calibration_activation",
    columns: ["id"],
  },
  {
    kind: "f",
    name: "mismatch_calibration_activation_artifact_id_fkey",
    table: "mismatch_calibration_activation",
    columns: ["artifact_id"],
    referencedTable: "mismatch_calibration_artifacts",
    referencedColumns: ["id"],
    updateAction: "a",
    deleteAction: "r",
    matchType: "s",
  },
  {
    kind: "p",
    name: "mismatch_calibration_activation_events_pkey",
    table: "mismatch_calibration_activation_events",
    columns: ["id"],
  },
  {
    kind: "u",
    name: "mismatch_calibration_activation_events_request_id_key",
    table: "mismatch_calibration_activation_events",
    columns: ["request_id"],
  },
  {
    kind: "u",
    name: "mismatch_calibration_activation_events_revision_key",
    table: "mismatch_calibration_activation_events",
    columns: ["revision"],
  },
  {
    kind: "f",
    // PostgreSQL shortens the relation portion of this inline-generated name to fit 63 bytes.
    name: "mismatch_calibration_activation_event_previous_artifact_id_fkey",
    table: "mismatch_calibration_activation_events",
    columns: ["previous_artifact_id"],
    referencedTable: "mismatch_calibration_artifacts",
    referencedColumns: ["id"],
    updateAction: "a",
    deleteAction: "r",
    matchType: "s",
  },
  {
    kind: "f",
    name: "mismatch_calibration_activation_events_artifact_id_fkey",
    table: "mismatch_calibration_activation_events",
    columns: ["artifact_id"],
    referencedTable: "mismatch_calibration_artifacts",
    referencedColumns: ["id"],
    updateAction: "a",
    deleteAction: "r",
    matchType: "s",
  },
  {
    kind: "f",
    name: "entry_admissions_mismatch_calibration_artifact_id_fkey",
    table: "entry_admissions",
    columns: ["mismatch_calibration_artifact_id"],
    referencedTable: "mismatch_calibration_artifacts",
    referencedColumns: ["id"],
    updateAction: "a",
    deleteAction: "r",
    matchType: "s",
  },
] as const satisfies readonly (V10KeyConstraintExpectation | V10ForeignKeyConstraintExpectation)[];

const MISMATCH_CALIBRATION_REQUIRED_CHECK_EXPRESSIONS = {
  entry_admissions: [
    "mismatch_calibration_revision >= 0",
    "mismatch_calibration_artifact_id IS NULL OR mismatch_calibration_revision > 0",
  ],
  entry_execution_probes: [
    "length(btrim(probe_key)) > 0",
    "asset = ANY (ARRAY['btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'hype'])",
    "length(btrim(slot_key)) > 0",
    "slot_start_ts >= 0",
    "slot_end_ts > slot_start_ts",
    "combination = ANY (ARRAY['POLY_UP_KALSHI_NO', 'POLY_DOWN_KALSHI_YES'])",
    "probe_kind = ANY (ARRAY['candidate_preflight', 'late_probe'])",
    "target_seconds_remaining IS NULL OR target_seconds_remaining = ANY (ARRAY[55, 45, 35, 25, 15, 5])",
    "signal_captured_at >= 0",
    "rest_started_at >= signal_captured_at",
    "rest_captured_at >= rest_started_at",
    "length(btrim(decision)) > 0",
    "first_rejection_stage IS NULL OR first_rejection_stage = ANY (ARRAY['signal', 'base', 'rest', 'risk', 'admission', 'primary', 'hedge', 'settled'])",
    "strategy_revision >= 0",
    "global_risk_revision >= 0",
    "jsonb_typeof(signal_json) = 'object'",
    "jsonb_typeof(rest_json) = 'object'",
    "jsonb_typeof(risk_json) = 'object'",
    "jsonb_typeof(variants_json) = 'array'",
    "evidence_sha256 ~ '^[0-9a-f]{64}$'",
    "recorded_at >= rest_captured_at",
    "(probe_kind = 'late_probe' AND target_seconds_remaining IS NOT NULL) OR (probe_kind = 'candidate_preflight' AND target_seconds_remaining IS NULL)",
  ],
  mismatch_calibration_artifacts: [
    "length(btrim(id)) > 0",
    "schema_version > 0",
    "length(btrim(base_model_version)) > 0",
    "training_started_at >= 0",
    "training_ended_at >= training_started_at",
    "jsonb_typeof(artifact_json) = 'object'",
    "jsonb_typeof(metrics_json) = 'object'",
    "artifact_sha256 ~ '^[0-9a-f]{64}$'",
    "created_at >= training_ended_at",
  ],
  mismatch_calibration_activation: ["id = 1", "revision >= 0", "updated_at >= 0"],
  mismatch_calibration_activation_events: [
    "request_sha256 ~ '^[0-9a-f]{64}$'",
    "jsonb_typeof(request_json) = 'object'",
    "previous_revision >= 0",
    "revision = previous_revision + 1",
    "length(btrim(actor)) > 0",
    "length(btrim(reason)) > 0",
    "occurred_at >= 0",
    "recorded_at >= occurred_at",
  ],
} as const;

const MISMATCH_CALIBRATION_REQUIRED_PROBE_INDEXES = [
  {
    name: "entry_execution_probes_asset_slot_idx",
    columns: ["asset", "slot_key", "rest_captured_at"],
    descending: [false, false, true],
    nullsFirst: [false, false, true],
  },
  {
    name: "entry_execution_probes_asset_captured_idx",
    columns: ["asset", "rest_captured_at", "probe_key"],
    descending: [false, true, false],
    nullsFirst: [false, true, false],
  },
  {
    name: "entry_execution_probes_captured_idx",
    columns: ["rest_captured_at"],
    descending: [true],
    nullsFirst: [true],
  },
  {
    name: "entry_execution_probes_funnel_idx",
    columns: ["first_rejection_stage", "first_rejection_code", "rest_captured_at"],
    descending: [false, false, true],
    nullsFirst: [false, false, true],
  },
] as const;

const MISMATCH_CALIBRATION_REQUIRED_PROCEDURES = [
  {
    name: "reject_entry_execution_probe_update",
    body: `
      BEGIN
        RAISE EXCEPTION 'entry execution probes are immutable' USING ERRCODE = '55000';
      END;
    `,
  },
  {
    name: "reject_mismatch_calibration_fact_mutation",
    body: `
      BEGIN
        RAISE EXCEPTION 'mismatch calibration facts are append-only' USING ERRCODE = '55000';
      END;
    `,
  },
  {
    name: "validate_mismatch_calibration_activation_event",
    body: `
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
    `,
  },
  {
    name: "require_mismatch_calibration_activation_event",
    body: `
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
    `,
  },
  {
    name: "require_mismatch_calibration_activation_state",
    body: `
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
    `,
  },
] as const;

type PreflightEnvironment = Partial<
  Record<"LIVE_EXECUTION_ALLOWED" | "ALLOW_HISTORICAL_LEGACY_ACCOUNTING_DEPLOY", string | undefined>
>;

type BlockingRows = {
  total: number;
  sampleIds: string[];
};

type LiveReservationSnapshot = {
  rowCount: number;
  canonicalRowCount: number;
  ownedCount: number;
  ownerIntentIds: string[];
};

export type DeploymentPreflightSnapshot = {
  schemaVersion: number;
  liveIntents: BlockingRows;
  historicalLegacyExposure: BlockingRows;
  unresolvedAttempts: BlockingRows;
  openOrders: BlockingRows;
  livePositions: BlockingRows;
  liveReservation: LiveReservationSnapshot | null;
  accountingBacklog: AccountingBacklogSummary | null;
};

export type DeploymentPreflightIssue = {
  code:
    | "live_execution_gate_enabled"
    | "live_intents_or_exposure"
    | "unresolved_live_attempts"
    | "open_live_orders"
    | "live_positions"
    | "invalid_live_reservation"
    | "owned_live_reservation"
    | "accounting_backlog";
  message: string;
};

export class DeploymentPreflightBlockedError extends Error {
  constructor(readonly issues: readonly DeploymentPreflightIssue[]) {
    super(`Deployment preflight refused: ${issues.map((issue) => issue.message).join("; ")}`);
    this.name = "DeploymentPreflightBlockedError";
  }
}

export function assertDeploymentLiveGateDisabled(environment: PreflightEnvironment = readPreflightEnvironment()) {
  if (!isTruthyEnv(environment.LIVE_EXECUTION_ALLOWED)) {
    return;
  }

  throw new DeploymentPreflightBlockedError([
    {
      code: "live_execution_gate_enabled",
      message: "LIVE_EXECUTION_ALLOWED must be disabled before deployment",
    },
  ]);
}

export async function collectDeploymentPreflightSnapshot(db: PgQueryable): Promise<DeploymentPreflightSnapshot> {
  const migrationStatus = await getDatabaseMigrationStatus(db, DATABASE_MIGRATIONS);
  assertSupportedMigrationState(migrationStatus);
  await assertExpectedSchemaShape(db, migrationStatus.currentVersion);

  const liveIntents = await readBlockingRows(
    db,
    `
      /* deployment_preflight:live_intents */
      WITH unsafe_intents AS (
        SELECT DISTINCT intent.id
        FROM order_intents AS intent
        WHERE EXISTS (
            SELECT 1
            FROM fills AS fill
            WHERE fill.intent_id = intent.id
              AND (
                fill.asset IS DISTINCT FROM intent.asset
                OR fill.shadow IS DISTINCT FROM intent.shadow
              )
          )
          OR EXISTS (
            SELECT 1
            FROM fills AS fill
            WHERE fill.intent_id = intent.id
              AND (fill.shadow = false OR intent.shadow = false)
              AND (
                fill.price::text IN ('NaN', 'Infinity', '-Infinity')
                OR fill.price <= 0
                OR fill.price > 1
                OR fill.size::text IN ('NaN', 'Infinity', '-Infinity')
                OR fill.size <= 0
                OR fill.fee_usd::text IN ('NaN', 'Infinity', '-Infinity')
                OR fill.fee_usd < 0
              )
          )
          OR (
            intent.shadow = false
            AND (
              intent.status NOT IN ('settled', 'unwound', 'failed', 'skipped', 'canceled')
              OR (
                intent.status NOT IN ('settled', 'unwound')
                AND (
                  EXISTS (
                    SELECT 1
                    FROM fills AS fill
                    WHERE fill.intent_id = intent.id
                      AND fill.size > 0
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM venue_orders AS venue_order
                    WHERE venue_order.intent_id = intent.id
                      AND venue_order.filled_size > 0
                  )
                  OR COALESCE(
                    jsonb_path_exists(intent.legs_json, '$[*] ? (@.filledSize > 0)'),
                    false
                  )
                )
              )
            )
          )
        UNION
        SELECT 'orphan-fill:' || fill.id
        FROM fills AS fill
        LEFT JOIN order_intents AS intent ON intent.id = fill.intent_id
        WHERE fill.shadow = false
          AND intent.id IS NULL
      )
      SELECT
        count(*)::integer AS total,
        COALESCE((array_agg(id ORDER BY id))[1:5], ARRAY[]::text[]) AS sample_ids
      FROM unsafe_intents
    `,
    "live intents or exposure",
  );

  const accountingHeadJoin =
    migrationStatus.currentVersion >= ACCOUNTING_SCHEMA_VERSION
      ? "JOIN accounting_heads AS accounting_head ON accounting_head.intent_id = intent.id"
      : "";
  const accountingHeadPredicate =
    migrationStatus.currentVersion >= ACCOUNTING_SCHEMA_VERSION ? "AND accounting_head.state = 'legacy_pending'" : "";
  const historicalLegacyExposure = await readBlockingRows(
    db,
    `
      /* deployment_preflight:historical_legacy_exposure */
      WITH accounting_clock AS (
        SELECT floor(extract(epoch FROM (
          date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        )) * 1000)::bigint AS utc_day_start
      ), historical_debt AS (
        SELECT intent.id
        FROM order_intents AS intent
        ${accountingHeadJoin}
        CROSS JOIN accounting_clock
        WHERE intent.shadow = false
          AND intent.status IN ('failed', 'skipped', 'canceled')
          AND intent.slot_end_ts < accounting_clock.utc_day_start
          ${accountingHeadPredicate}
          AND (
            EXISTS (SELECT 1 FROM fills AS fill WHERE fill.intent_id = intent.id AND fill.size > 0)
            OR EXISTS (
              SELECT 1 FROM venue_orders AS venue_order
              WHERE venue_order.intent_id = intent.id AND venue_order.filled_size > 0
            )
            OR COALESCE(jsonb_path_exists(intent.legs_json, '$[*] ? (@.filledSize > 0)'), false)
          )
          AND NOT EXISTS (
            SELECT 1
            FROM fills AS fill
            WHERE fill.intent_id = intent.id
              AND (
                fill.asset IS DISTINCT FROM intent.asset
                OR fill.shadow IS DISTINCT FROM intent.shadow
                OR fill.price::text IN ('NaN', 'Infinity', '-Infinity')
                OR fill.price <= 0
                OR fill.price > 1
                OR fill.size::text IN ('NaN', 'Infinity', '-Infinity')
                OR fill.size <= 0
                OR fill.fee_usd::text IN ('NaN', 'Infinity', '-Infinity')
                OR fill.fee_usd < 0
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM venue_orders AS venue_order
            WHERE venue_order.intent_id = intent.id
              AND (
                venue_order.asset IS DISTINCT FROM intent.asset
                OR venue_order.shadow IS DISTINCT FROM intent.shadow
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM order_attempts AS attempt
            WHERE attempt.intent_id = intent.id
              AND (
                attempt.asset IS DISTINCT FROM intent.asset
                OR attempt.shadow IS DISTINCT FROM intent.shadow
              )
          )
      )
      SELECT
        count(*)::integer AS total,
        COALESCE((array_agg(id ORDER BY id))[1:5], ARRAY[]::text[]) AS sample_ids
      FROM historical_debt
    `,
    "historical legacy exposure",
  );

  const unresolvedAttempts = await readBlockingRows(
    db,
    `
      /* deployment_preflight:order_attempts */
      WITH unsafe_attempts AS (
        SELECT attempt.id
        FROM order_attempts AS attempt
        JOIN order_intents AS intent ON intent.id = attempt.intent_id
        WHERE attempt.asset IS DISTINCT FROM intent.asset
          OR attempt.shadow IS DISTINCT FROM intent.shadow
          OR (
            (attempt.shadow = false OR intent.shadow = false)
            AND (
              attempt.status IN ('planned', 'submitting', 'submitted', 'truth_pending')
              OR attempt.status = 'confirmed' AND (
                attempt.truth_status IS NULL
                OR lower(btrim(attempt.truth_status)) NOT IN (
                  'pending', 'live', 'filled', 'partially_filled',
                  'canceled', 'expired', 'rejected', 'terminal_zero_fill'
                )
                OR
                attempt.venue_order_id IS NULL
                OR attempt.result_json IS NULL
                OR jsonb_typeof(attempt.result_json) <> 'object'
                OR attempt.result_json ->> 'venue' IS DISTINCT FROM attempt.venue
                OR attempt.result_json ->> 'venueOrderId' IS DISTINCT FROM attempt.venue_order_id
                OR attempt.result_json ->> 'status' IS NULL
                OR lower(btrim(attempt.result_json ->> 'status')) NOT IN (
                  'pending', 'live', 'filled', 'partially_filled',
                  'canceled', 'expired', 'rejected'
                )
                OR (
                  lower(btrim(attempt.truth_status)) <> 'terminal_zero_fill'
                  AND lower(btrim(attempt.truth_status)) IS DISTINCT FROM
                    lower(btrim(attempt.result_json ->> 'status'))
                )
                OR NOT CASE
                  WHEN jsonb_typeof(attempt.result_json -> 'filledSize') = 'number' THEN
                    (attempt.result_json ->> 'filledSize')::numeric >= 0
                    AND (
                      lower(btrim(attempt.truth_status)) <> 'terminal_zero_fill'
                      OR (
                        lower(btrim(attempt.result_json ->> 'status')) IN ('canceled', 'expired', 'rejected')
                        AND (attempt.result_json ->> 'filledSize')::numeric <= 0.000001
                      )
                    )
                    AND (
                      lower(btrim(attempt.truth_status)) NOT IN ('filled', 'partially_filled')
                      OR (attempt.result_json ->> 'filledSize')::numeric > 0.000001
                    )
                  ELSE false
                END
                OR NOT EXISTS (
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
                        THEN venue_order.filled_size + 0.000001 >=
                          (attempt.result_json ->> 'filledSize')::numeric
                      ELSE false
                    END
                )
              )
              OR attempt.status = 'failed' AND (
                attempt.truth_status IS DISTINCT FROM 'not_submitted'
                OR attempt.venue_order_id IS NOT NULL
                OR attempt.result_json IS NOT NULL
                OR EXISTS (
                  SELECT 1
                  FROM venue_orders AS venue_order
                  WHERE venue_order.intent_id = attempt.intent_id
                    AND venue_order.venue = attempt.venue
                    AND venue_order.client_order_id IS NOT DISTINCT FROM attempt.client_order_id
                )
              )
              OR attempt.status NOT IN (
                'planned', 'submitting', 'submitted', 'truth_pending', 'confirmed', 'failed'
              )
            )
          )
      )
      SELECT
        count(*)::integer AS total,
        COALESCE((array_agg(id ORDER BY id))[1:5], ARRAY[]::text[]) AS sample_ids
      FROM unsafe_attempts
    `,
    "unresolved live order attempts",
  );

  const openOrders = await readBlockingRows(
    db,
    `
      /* deployment_preflight:venue_orders */
      WITH unsafe_orders AS (
        SELECT venue_order.id
        FROM venue_orders AS venue_order
        JOIN order_intents AS intent ON intent.id = venue_order.intent_id
        WHERE venue_order.asset IS DISTINCT FROM intent.asset
          OR venue_order.shadow IS DISTINCT FROM intent.shadow
          OR (
            (venue_order.shadow = false OR intent.shadow = false)
            AND (
              venue_order.status NOT IN ('filled', 'canceled', 'rejected', 'expired')
              OR venue_order.requested_price IS NOT NULL AND (
                venue_order.requested_price::text IN ('NaN', 'Infinity', '-Infinity')
                OR venue_order.requested_price <= 0
                OR venue_order.requested_price > 1
              )
              OR venue_order.requested_size::text IN ('NaN', 'Infinity', '-Infinity')
              OR venue_order.requested_size <= 0
              OR venue_order.filled_size::text IN ('NaN', 'Infinity', '-Infinity')
              OR venue_order.filled_size < 0
              OR venue_order.filled_size > venue_order.requested_size + 0.000001
              OR venue_order.status = 'filled' AND venue_order.filled_size <= 0
              OR venue_order.filled_size > 0 AND (
                venue_order.average_fill_price IS NULL
                OR venue_order.average_fill_price::text IN ('NaN', 'Infinity', '-Infinity')
                OR venue_order.average_fill_price <= 0
                OR venue_order.average_fill_price > 1
              )
              OR venue_order.fee_usd IS NOT NULL AND (
                venue_order.fee_usd::text IN ('NaN', 'Infinity', '-Infinity')
                OR venue_order.fee_usd < 0
              )
            )
          )
      )
      SELECT
        count(*)::integer AS total,
        COALESCE((array_agg(id ORDER BY id))[1:5], ARRAY[]::text[]) AS sample_ids
      FROM unsafe_orders
    `,
    "open live venue orders",
  );

  const livePositions = await readBlockingRows(
    db,
    `
      /* deployment_preflight:positions */
      WITH unsafe_positions AS (
        SELECT position.id
        FROM positions AS position
        WHERE position.size::text IN ('NaN', 'Infinity', '-Infinity')
          OR position.current_value_usd::text IN ('NaN', 'Infinity', '-Infinity')
          OR CASE
            WHEN position.venue = 'polymarket' AND (position.redeemable OR position.mergeable)
              THEN abs(position.current_value_usd) > 0.05
            ELSE abs(position.current_value_usd) > 0.05 OR abs(position.size) > 0.05
          END
      )
      SELECT
        count(*)::integer AS total,
        COALESCE((array_agg(id ORDER BY id))[1:5], ARRAY[]::text[]) AS sample_ids
      FROM unsafe_positions
    `,
    "live positions",
  );

  const liveReservation = migrationStatus.currentVersion >= 4 ? await readLiveReservationSnapshot(db) : null;

  const accountingBacklog =
    migrationStatus.currentVersion >= ACCOUNTING_SCHEMA_VERSION ? await getLiveAccountingBacklog(db) : null;

  return {
    schemaVersion: migrationStatus.currentVersion,
    liveIntents,
    historicalLegacyExposure,
    unresolvedAttempts,
    openOrders,
    livePositions,
    liveReservation,
    accountingBacklog,
  };
}

export function evaluateDeploymentPreflight(
  snapshot: DeploymentPreflightSnapshot,
  environment: PreflightEnvironment = readPreflightEnvironment(),
) {
  const issues: DeploymentPreflightIssue[] = [];
  const liveExecutionEnabled = isTruthyEnv(environment.LIVE_EXECUTION_ALLOWED);
  const historicalDebtOverride =
    !liveExecutionEnabled && isTruthyEnv(environment.ALLOW_HISTORICAL_LEGACY_ACCOUNTING_DEPLOY);
  const liveIntentsAreOnlyHistoricalDebt =
    historicalDebtOverride &&
    snapshot.liveIntents.total > 0 &&
    snapshot.liveIntents.total === snapshot.historicalLegacyExposure.total;

  if (liveExecutionEnabled) {
    issues.push({
      code: "live_execution_gate_enabled",
      message: "LIVE_EXECUTION_ALLOWED must be disabled before deployment",
    });
  }
  if (snapshot.liveIntents.total > 0 && !liveIntentsAreOnlyHistoricalDebt) {
    issues.push({
      code: "live_intents_or_exposure",
      message: describeRows("live intent(s) remain non-closed or exposed", snapshot.liveIntents),
    });
  }
  if (snapshot.unresolvedAttempts.total > 0) {
    issues.push({
      code: "unresolved_live_attempts",
      message: describeRows("live order attempt(s) have unresolved or inconsistent truth", snapshot.unresolvedAttempts),
    });
  }
  if (snapshot.openOrders.total > 0) {
    issues.push({
      code: "open_live_orders",
      message: describeRows("live venue order(s) remain open or inconsistent", snapshot.openOrders),
    });
  }
  if (snapshot.livePositions.total > 0) {
    issues.push({
      code: "live_positions",
      message: describeRows("live position(s) remain economically active", snapshot.livePositions),
    });
  }
  if (
    snapshot.liveReservation &&
    (snapshot.liveReservation.rowCount !== 1 || snapshot.liveReservation.canonicalRowCount !== 1)
  ) {
    issues.push({
      code: "invalid_live_reservation",
      message: `live reservation shape is invalid (${snapshot.liveReservation.rowCount} live row(s), ${snapshot.liveReservation.canonicalRowCount} canonical)`,
    });
  }
  if (snapshot.liveReservation && snapshot.liveReservation.ownedCount > 0) {
    issues.push({
      code: "owned_live_reservation",
      message: describeIds(
        `${snapshot.liveReservation.ownedCount} live entry reservation(s) remain owned`,
        snapshot.liveReservation.ownerIntentIds,
      ),
    });
  }
  const accountingBacklogIsOnlyHistoricalDebt =
    historicalDebtOverride &&
    snapshot.accountingBacklog !== null &&
    snapshot.accountingBacklog.total > 0 &&
    snapshot.accountingBacklog.total === snapshot.historicalLegacyExposure.total &&
    snapshot.accountingBacklog.legacyPending === snapshot.accountingBacklog.total &&
    snapshot.accountingBacklog.missingHeads === 0 &&
    snapshot.accountingBacklog.quarantined === 0 &&
    snapshot.accountingBacklog.terminalOpen === 0;
  if (snapshot.accountingBacklog && snapshot.accountingBacklog.total > 0 && !accountingBacklogIsOnlyHistoricalDebt) {
    issues.push({
      code: "accounting_backlog",
      message: describeIds(
        `${snapshot.accountingBacklog.total} blocking live accounting defect(s) remain (missing-head=${snapshot.accountingBacklog.missingHeads}, legacy=${snapshot.accountingBacklog.legacyPending}, quarantined=${snapshot.accountingBacklog.quarantined}, terminal-open=${snapshot.accountingBacklog.terminalOpen})`,
        snapshot.accountingBacklog.oldestIntentId ? [snapshot.accountingBacklog.oldestIntentId] : [],
      ),
    });
  }

  return issues;
}

export function assertDeploymentPreflight(
  snapshot: DeploymentPreflightSnapshot,
  environment: PreflightEnvironment = readPreflightEnvironment(),
) {
  const issues = evaluateDeploymentPreflight(snapshot, environment);
  if (issues.length > 0) {
    throw new DeploymentPreflightBlockedError(issues);
  }
}

function assertSupportedMigrationState(status: Awaited<ReturnType<typeof getDatabaseMigrationStatus>>) {
  const applicationSchemaVersion = DATABASE_MIGRATIONS.at(-1)?.version ?? 0;
  if (applicationSchemaVersion !== DEPLOYMENT_PREFLIGHT_REVIEWED_SCHEMA_VERSION) {
    throw new Error(
      `Deployment preflight is reviewed through V${DEPLOYMENT_PREFLIGHT_REVIEWED_SCHEMA_VERSION}, but the application defines V${applicationSchemaVersion}; review and bump the preflight explicitly`,
    );
  }
  const uninitializedLegacySchema =
    !status.initialized &&
    status.currentVersion === 0 &&
    status.applied.length === 0 &&
    status.pending.length === applicationSchemaVersion &&
    status.problems.every(
      (problem) => problem === "schema_migrations table is missing" || problem.startsWith("pending migration "),
    );
  if (uninitializedLegacySchema) {
    return;
  }
  const blockingProblems = status.problems.filter((problem) => !problem.startsWith("pending migration "));
  if (blockingProblems.length > 0) {
    throw new Error(`Deployment preflight found an incompatible migration history: ${blockingProblems.join("; ")}`);
  }
  if (
    !status.initialized ||
    status.currentVersion < MINIMUM_PREFLIGHT_SCHEMA_VERSION ||
    status.currentVersion > DEPLOYMENT_PREFLIGHT_REVIEWED_SCHEMA_VERSION
  ) {
    throw new Error(
      `Deployment preflight requires a complete schema V${MINIMUM_PREFLIGHT_SCHEMA_VERSION}-V${DEPLOYMENT_PREFLIGHT_REVIEWED_SCHEMA_VERSION}; found V${status.currentVersion}`,
    );
  }

  const expectedVersions = Array.from({ length: status.currentVersion }, (_, index) => index + 1);
  const appliedVersions = status.applied.map((migration) => migration.version);
  if (
    appliedVersions.length !== expectedVersions.length ||
    expectedVersions.some((version, index) => appliedVersions[index] !== version)
  ) {
    throw new Error(`Deployment preflight requires a contiguous migration history through V${status.currentVersion}`);
  }
}

async function assertExpectedSchemaShape(db: PgQueryable, schemaVersion: number) {
  const tableNames = [
    ...Object.keys(DEPLOYMENT_PREFLIGHT_REQUIRED_COLUMNS),
    ...Object.keys(ENTRY_ADMISSION_REQUIRED_COLUMNS),
    ...Object.keys(ACCOUNTING_REQUIRED_COLUMNS),
    ...Object.keys(ACCOUNTING_EVIDENCE_REQUIRED_COLUMNS),
    ...Object.keys(MISMATCH_CALIBRATION_REQUIRED_COLUMNS),
  ];
  const result = await db.query<{ table_name: string; column_name: string }>(
    `
      /* deployment_preflight:schema_shape */
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])
      ORDER BY table_name ASC, column_name ASC
    `,
    [tableNames],
  );
  const columnsByTable = new Map<string, Set<string>>();
  for (const row of result.rows) {
    const columns = columnsByTable.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    columnsByTable.set(row.table_name, columns);
  }

  assertRequiredColumns(columnsByTable, DEPLOYMENT_PREFLIGHT_REQUIRED_COLUMNS);
  const entryAdmissionTableExists = columnsByTable.has("entry_reservations");
  if (schemaVersion >= 4) {
    assertRequiredColumns(columnsByTable, ENTRY_ADMISSION_REQUIRED_COLUMNS);
  } else if (entryAdmissionTableExists) {
    throw new Error("Deployment preflight found entry_reservations before migration V4; refusing a partial schema");
  }
  const accountingTableExists = columnsByTable.has("accounting_heads");
  if (schemaVersion >= ACCOUNTING_SCHEMA_VERSION) {
    assertRequiredColumns(columnsByTable, ACCOUNTING_REQUIRED_COLUMNS);
  } else if (accountingTableExists) {
    throw new Error(
      `Deployment preflight found accounting_heads before migration V${ACCOUNTING_SCHEMA_VERSION}; refusing a partial schema`,
    );
  }
  const accountingEvidenceTableExists = columnsByTable.has("accounting_fill_finality_observations");
  if (schemaVersion >= ACCOUNTING_EVIDENCE_SCHEMA_VERSION) {
    assertRequiredColumns(columnsByTable, ACCOUNTING_EVIDENCE_REQUIRED_COLUMNS);
  } else if (accountingEvidenceTableExists) {
    throw new Error(
      `Deployment preflight found accounting_fill_finality_observations before migration V${ACCOUNTING_EVIDENCE_SCHEMA_VERSION}; refusing a partial schema`,
    );
  }
  const mismatchCalibrationAdmissionColumnExists = [
    "mismatch_calibration_artifact_id",
    "mismatch_calibration_revision",
  ].some((columnName) => columnsByTable.get("entry_admissions")?.has(columnName) === true);
  const mismatchCalibrationTableExists =
    [
      "entry_execution_probes",
      "mismatch_calibration_artifacts",
      "mismatch_calibration_activation",
      "mismatch_calibration_activation_events",
    ].some((tableName) => columnsByTable.has(tableName)) || mismatchCalibrationAdmissionColumnExists;
  if (schemaVersion >= MISMATCH_CALIBRATION_SCHEMA_VERSION) {
    assertRequiredColumns(columnsByTable, MISMATCH_CALIBRATION_REQUIRED_COLUMNS);
    await assertMismatchCalibrationSchemaState(db);
  } else if (mismatchCalibrationTableExists) {
    throw new Error(
      `Deployment preflight found mismatch calibration evidence before migration V${MISMATCH_CALIBRATION_SCHEMA_VERSION}; refusing a partial schema`,
    );
  }
}

async function assertMismatchCalibrationColumnDefinitions(db: PgQueryable) {
  const tableNames = Object.keys(MISMATCH_CALIBRATION_REQUIRED_COLUMN_DEFINITIONS);
  const result = await db.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    not_null: boolean;
    default_expression: string | null;
    relation_kind: string;
  }>(
    `
      /* deployment_preflight:mismatch_calibration_columns */
      SELECT relation.relname AS table_name, attribute.attname AS column_name,
        format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
        attribute.attnotnull AS not_null,
        pg_get_expr(column_default.adbin, column_default.adrelid) AS default_expression,
        relation.relkind AS relation_kind
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      LEFT JOIN pg_attrdef AS column_default ON column_default.adrelid = relation.oid
        AND column_default.adnum = attribute.attnum
      WHERE namespace.nspname = current_schema()
        AND relation.relname = ANY($1::text[])
      ORDER BY relation.relname ASC, attribute.attnum ASC
    `,
    [tableNames],
  );
  const invalid: string[] = [];
  for (const [tableName, columns] of Object.entries(MISMATCH_CALIBRATION_REQUIRED_COLUMN_DEFINITIONS)) {
    for (const [columnName, expectation] of Object.entries(columns) as Array<[string, V10ColumnExpectation]>) {
      const matches = result.rows.filter((row) => row.table_name === tableName && row.column_name === columnName);
      const row = matches[0];
      const hasExpectedDefault =
        expectation.defaultKind === "sequence"
          ? typeof row?.default_expression === "string" && /^nextval\(/i.test(row.default_expression.trim())
          : row?.default_expression === null;
      if (
        matches.length !== 1 ||
        !row ||
        row.relation_kind !== "r" ||
        row.data_type !== expectation.dataType ||
        row.not_null !== !expectation.nullable ||
        !hasExpectedDefault
      ) {
        invalid.push(`${tableName}.${columnName}`);
      }
    }
  }
  if (invalid.length > 0) {
    throw new Error(`Deployment preflight found incompatible V10 column definition(s): ${invalid.join(", ")}`);
  }
}

type V10ConstraintCatalogRow = {
  constraint_name: string;
  table_name: string;
  constraint_type: string;
  validated: boolean;
  deferrable: boolean;
  initially_deferred: boolean;
  no_inherit: boolean;
  column_names: string[];
  referenced_table_name: string | null;
  referenced_column_names: string[];
  update_action: string;
  delete_action: string;
  match_type: string;
  check_expression: string | null;
};

async function assertMismatchCalibrationConstraints(db: PgQueryable) {
  const tableNames = Object.keys(MISMATCH_CALIBRATION_REQUIRED_COLUMN_DEFINITIONS);
  const result = await db.query<V10ConstraintCatalogRow>(
    `
      /* deployment_preflight:mismatch_calibration_constraints */
      SELECT constraint_record.conname AS constraint_name, relation.relname AS table_name,
        constraint_record.contype AS constraint_type, constraint_record.convalidated AS validated,
        constraint_record.condeferrable AS deferrable,
        constraint_record.condeferred AS initially_deferred,
        constraint_record.connoinherit AS no_inherit,
        COALESCE((
          SELECT array_agg(attribute.attname::text ORDER BY constrained_key.ordinality)
          FROM unnest(constraint_record.conkey) WITH ORDINALITY AS constrained_key(attnum, ordinality)
          JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
            AND attribute.attnum = constrained_key.attnum
        ), ARRAY[]::text[]) AS column_names,
        referenced_relation.relname AS referenced_table_name,
        COALESCE((
          SELECT array_agg(attribute.attname::text ORDER BY referenced_key.ordinality)
          FROM unnest(constraint_record.confkey) WITH ORDINALITY AS referenced_key(attnum, ordinality)
          JOIN pg_attribute AS attribute ON attribute.attrelid = referenced_relation.oid
            AND attribute.attnum = referenced_key.attnum
        ), ARRAY[]::text[]) AS referenced_column_names,
        constraint_record.confupdtype AS update_action,
        constraint_record.confdeltype AS delete_action,
        constraint_record.confmatchtype AS match_type,
        CASE WHEN constraint_record.contype = 'c'
          THEN pg_get_expr(constraint_record.conbin, constraint_record.conrelid, true)
          ELSE NULL
        END AS check_expression
      FROM pg_constraint AS constraint_record
      JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      LEFT JOIN pg_class AS referenced_relation ON referenced_relation.oid = constraint_record.confrelid
      WHERE namespace.nspname = current_schema()
        AND relation.relname = ANY($1::text[])
      ORDER BY relation.relname ASC, constraint_record.conname ASC
    `,
    [tableNames],
  );
  const invalid: string[] = [];
  for (const expected of MISMATCH_CALIBRATION_REQUIRED_KEY_CONSTRAINTS) {
    const matches = result.rows.filter((row) => row.constraint_name === expected.name);
    const row = matches[0];
    const commonMatches =
      matches.length === 1 &&
      row?.table_name === expected.table &&
      row.constraint_type === expected.kind &&
      row.validated === true &&
      row.deferrable === false &&
      row.initially_deferred === false &&
      arraysEqual(row.column_names, expected.columns);
    const foreignKeyMatches =
      expected.kind !== "f" ||
      (row?.referenced_table_name === expected.referencedTable &&
        arraysEqual(row.referenced_column_names, expected.referencedColumns) &&
        row.update_action === expected.updateAction &&
        row.delete_action === expected.deleteAction &&
        row.match_type === expected.matchType);
    if (!commonMatches || !foreignKeyMatches) {
      invalid.push(expected.name);
    }
  }

  const validChecks = result.rows.filter(
    (row) =>
      row.constraint_type === "c" &&
      row.validated === true &&
      row.deferrable === false &&
      row.initially_deferred === false &&
      row.no_inherit === false &&
      typeof row.check_expression === "string",
  );
  for (const [tableName, expectedExpressions] of Object.entries(MISMATCH_CALIBRATION_REQUIRED_CHECK_EXPRESSIONS)) {
    for (const expectedExpression of expectedExpressions) {
      const normalizedExpected = normalizePostgresExpression(expectedExpression);
      const matches = validChecks.filter(
        (row) =>
          row.table_name === tableName &&
          normalizePostgresExpression(row.check_expression ?? "") === normalizedExpected,
      );
      if (matches.length !== 1) {
        invalid.push(`${tableName}.CHECK(${expectedExpression})`);
      }
    }
  }
  if (invalid.length > 0) {
    throw new Error(`Deployment preflight found missing or incompatible V10 constraint(s): ${invalid.join(", ")}`);
  }
}

async function assertMismatchCalibrationProbeIndexes(db: PgQueryable) {
  const result = await db.query<{
    index_name: string;
    table_name: string;
    access_method: string;
    unique_index: boolean;
    valid: boolean;
    ready: boolean;
    live: boolean;
    has_predicate: boolean;
    has_expressions: boolean;
    column_names: string[];
    descending: boolean[];
    nulls_first: boolean[];
  }>(
    `
      /* deployment_preflight:mismatch_calibration_probe_indexes */
      SELECT index_relation.relname AS index_name, table_relation.relname AS table_name,
        access_method.amname AS access_method, index_record.indisunique AS unique_index,
        index_record.indisvalid AS valid, index_record.indisready AS ready,
        index_record.indislive AS live, index_record.indpred IS NOT NULL AS has_predicate,
        index_record.indexprs IS NOT NULL AS has_expressions,
        ARRAY(
          SELECT attribute.attname::text
          FROM unnest(index_record.indkey::smallint[]) WITH ORDINALITY AS index_key(attnum, ordinality)
          JOIN pg_attribute AS attribute ON attribute.attrelid = table_relation.oid
            AND attribute.attnum = index_key.attnum
          WHERE index_key.ordinality <= index_record.indnkeyatts
          ORDER BY index_key.ordinality
        ) AS column_names,
        ARRAY(
          SELECT (index_record.indoption[index_position - 1] & 1) <> 0
          FROM generate_series(1, index_record.indnkeyatts) AS index_option(index_position)
          ORDER BY index_position
        ) AS descending,
        ARRAY(
          SELECT (index_record.indoption[index_position - 1] & 2) <> 0
          FROM generate_series(1, index_record.indnkeyatts) AS index_option(index_position)
          ORDER BY index_position
        ) AS nulls_first
      FROM pg_index AS index_record
      JOIN pg_class AS index_relation ON index_relation.oid = index_record.indexrelid
      JOIN pg_class AS table_relation ON table_relation.oid = index_record.indrelid
      JOIN pg_namespace AS namespace ON namespace.oid = table_relation.relnamespace
      JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
      WHERE namespace.nspname = current_schema()
        AND index_relation.relname = ANY($1::text[])
      ORDER BY index_relation.relname ASC
    `,
    [[...MISMATCH_CALIBRATION_REQUIRED_PROBE_INDEXES.map((index) => index.name)]],
  );
  const invalid = MISMATCH_CALIBRATION_REQUIRED_PROBE_INDEXES.filter((expected) => {
    const matches = result.rows.filter((row) => row.index_name === expected.name);
    const row = matches[0];
    return (
      matches.length !== 1 ||
      row?.table_name !== "entry_execution_probes" ||
      row.access_method !== "btree" ||
      row.unique_index !== false ||
      row.valid !== true ||
      row.ready !== true ||
      row.live !== true ||
      row.has_predicate !== false ||
      row.has_expressions !== false ||
      !arraysEqual(row.column_names, expected.columns) ||
      !arraysEqual(row.descending, expected.descending) ||
      !arraysEqual(row.nulls_first, expected.nullsFirst)
    );
  });
  if (invalid.length > 0) {
    throw new Error(
      `Deployment preflight found missing or incompatible V10 probe index(es): ${invalid.map((index) => index.name).join(", ")}`,
    );
  }
}

async function assertMismatchCalibrationProcedures(db: PgQueryable) {
  const result = await db.query<{
    procedure_name: string;
    language_name: string;
    result_type: string;
    identity_arguments: string;
    security_definer: boolean;
    volatility: string;
    strict: boolean;
    leakproof: boolean;
    parallel_safety: string;
    body: string;
  }>(
    `
      /* deployment_preflight:mismatch_calibration_procedures */
      SELECT procedure_record.proname AS procedure_name, language.lanname AS language_name,
        pg_get_function_result(procedure_record.oid) AS result_type,
        pg_get_function_identity_arguments(procedure_record.oid) AS identity_arguments,
        procedure_record.prosecdef AS security_definer,
        procedure_record.provolatile AS volatility,
        procedure_record.proisstrict AS strict,
        procedure_record.proleakproof AS leakproof,
        procedure_record.proparallel AS parallel_safety,
        procedure_record.prosrc AS body
      FROM pg_proc AS procedure_record
      JOIN pg_namespace AS namespace ON namespace.oid = procedure_record.pronamespace
      JOIN pg_language AS language ON language.oid = procedure_record.prolang
      WHERE namespace.nspname = current_schema()
        AND procedure_record.proname = ANY($1::text[])
      ORDER BY procedure_record.proname ASC, procedure_record.oid ASC
    `,
    [[...MISMATCH_CALIBRATION_REQUIRED_PROCEDURES.map((procedure) => procedure.name)]],
  );
  const invalid = MISMATCH_CALIBRATION_REQUIRED_PROCEDURES.filter((expected) => {
    const matches = result.rows.filter((row) => row.procedure_name === expected.name);
    const row = matches[0];
    return (
      matches.length !== 1 ||
      row?.language_name !== "plpgsql" ||
      row.result_type !== "trigger" ||
      row.identity_arguments !== "" ||
      row.security_definer !== false ||
      row.volatility !== "v" ||
      row.strict !== false ||
      row.leakproof !== false ||
      row.parallel_safety !== "u" ||
      hashNormalizedProcedureBody(row.body) !== hashNormalizedProcedureBody(expected.body)
    );
  });
  if (invalid.length > 0) {
    throw new Error(
      `Deployment preflight found missing or incompatible V10 procedure(s): ${invalid.map((procedure) => procedure.name).join(", ")}`,
    );
  }
}

async function assertMismatchCalibrationActivationEventChain(
  db: PgQueryable,
  activation: { artifactId: string | null; revision: number; updatedAt: number },
) {
  const result = await db.query<{
    request_id: string;
    request_sha256: string;
    request_json: Record<string, unknown>;
    previous_artifact_id: string | null;
    artifact_id: string | null;
    previous_revision: number;
    revision: number;
    actor: string;
    reason: string;
    occurred_at: number;
    recorded_at: number;
  }>(`
    /* deployment_preflight:mismatch_calibration_events */
    SELECT request_id::text, request_sha256, request_json, previous_artifact_id, artifact_id,
      previous_revision, revision, actor, reason, occurred_at, recorded_at
    FROM mismatch_calibration_activation_events
    ORDER BY revision ASC, id ASC
  `);
  if (result.rows.length !== activation.revision) {
    throw new Error("Deployment preflight found a mismatch calibration activation/event chain length mismatch");
  }

  let previousArtifactId: string | null = null;
  let previousRecordedAt: number | null = null;
  for (const [index, row] of result.rows.entries()) {
    const expectedRevision = index + 1;
    const revision = Number(row.revision);
    const previousRevision = Number(row.previous_revision);
    const recordedAt = Number(row.recorded_at);
    const occurredAt = Number(row.occurred_at);
    const request = readMismatchCalibrationActivationRequest(row.request_json);
    const requestHash = request ? hashMismatchCalibrationActivationRequest(request) : null;
    const requestMatchesEvent =
      request !== null &&
      request.requestId === row.request_id &&
      request.artifactId === row.artifact_id &&
      request.expectedRevision === previousRevision &&
      request.actor === row.actor &&
      request.reason === row.reason &&
      Math.min(recordedAt, request.occurredAt) === occurredAt;
    if (
      !Number.isSafeInteger(revision) ||
      revision !== expectedRevision ||
      !Number.isSafeInteger(previousRevision) ||
      previousRevision !== expectedRevision - 1 ||
      row.previous_artifact_id !== previousArtifactId ||
      !Number.isSafeInteger(recordedAt) ||
      recordedAt < 0 ||
      (previousRecordedAt !== null && recordedAt <= previousRecordedAt) ||
      !Number.isSafeInteger(occurredAt) ||
      occurredAt < 0 ||
      occurredAt > recordedAt ||
      !/^[0-9a-f]{64}$/.test(row.request_sha256) ||
      requestHash !== row.request_sha256 ||
      !requestMatchesEvent
    ) {
      throw new Error(
        `Deployment preflight found an invalid mismatch calibration activation event at revision ${expectedRevision}`,
      );
    }
    previousArtifactId = row.artifact_id;
    previousRecordedAt = recordedAt;
  }

  const finalStateMatches =
    activation.revision === 0
      ? activation.artifactId === null
      : previousArtifactId === activation.artifactId && previousRecordedAt === activation.updatedAt;
  if (!finalStateMatches) {
    throw new Error("Deployment preflight found a mismatch calibration activation/event chain mismatch");
  }
}

function normalizePostgresExpression(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/::(?:text|jsonb|bigint|integer|uuid)\b/g, "")
    .replace(/\s+/g, "")
    .replace(/[()]/g, "");
}

function hashNormalizedProcedureBody(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function arraysEqual<T>(actual: readonly T[], expected: readonly T[]) {
  return actual.length === expected.length && expected.every((value, index) => actual[index] === value);
}

function readMismatchCalibrationActivationRequest(value: unknown): MismatchCalibrationActivationRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = ["actor", "artifactId", "expectedRevision", "occurredAt", "reason", "requestId"];
  if (!arraysEqual(Object.keys(record).sort(), expectedKeys)) {
    return null;
  }
  if (
    !(record.artifactId === null || isCanonicalNonEmptyString(record.artifactId)) ||
    !Number.isSafeInteger(record.expectedRevision) ||
    Number(record.expectedRevision) < 0 ||
    typeof record.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.requestId) ||
    !isCanonicalNonEmptyString(record.actor) ||
    !isCanonicalNonEmptyString(record.reason) ||
    !Number.isSafeInteger(record.occurredAt) ||
    Number(record.occurredAt) < 0
  ) {
    return null;
  }
  return {
    artifactId: record.artifactId,
    expectedRevision: Number(record.expectedRevision),
    requestId: record.requestId,
    actor: record.actor,
    reason: record.reason,
    occurredAt: Number(record.occurredAt),
  };
}

function isCanonicalNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

async function assertMismatchCalibrationSchemaState(db: PgQueryable) {
  await assertMismatchCalibrationColumnDefinitions(db);
  await assertMismatchCalibrationConstraints(db);
  await assertMismatchCalibrationProbeIndexes(db);
  await assertMismatchCalibrationProcedures(db);

  const triggerResult = await db.query<{
    trigger_name: string;
    relation_name: string;
    procedure_name: string;
    procedure_in_current_schema: boolean;
    enabled: string;
    trigger_type: number;
    deferrable: boolean;
    initially_deferred: boolean;
    constraint_trigger: boolean;
    has_when_clause: boolean;
    argument_count: number;
  }>(
    `
    /* deployment_preflight:mismatch_calibration_triggers */
    SELECT trigger.tgname AS trigger_name, relation.relname AS relation_name,
      procedure.proname AS procedure_name,
      procedure_namespace.nspname = current_schema() AS procedure_in_current_schema,
      trigger.tgenabled AS enabled, trigger.tgtype::integer AS trigger_type,
      trigger.tgdeferrable AS deferrable, trigger.tginitdeferred AS initially_deferred,
      trigger.tgconstraint <> 0 AS constraint_trigger,
      trigger.tgqual IS NOT NULL AS has_when_clause,
      trigger.tgnargs::integer AS argument_count
    FROM pg_trigger AS trigger
    JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_proc AS procedure ON procedure.oid = trigger.tgfoid
    JOIN pg_namespace AS procedure_namespace ON procedure_namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = current_schema()
      AND trigger.tgname = ANY($1::text[])
      AND NOT trigger.tgisinternal
    ORDER BY trigger.tgname ASC
  `,
    [[...MISMATCH_CALIBRATION_REQUIRED_TRIGGERS.map((trigger) => trigger.name)]],
  );
  const invalidTriggers = MISMATCH_CALIBRATION_REQUIRED_TRIGGERS.filter((expected) => {
    const matches = triggerResult.rows.filter((row) => row.trigger_name === expected.name);
    return (
      matches.length !== 1 ||
      matches[0].relation_name !== expected.relation ||
      matches[0].procedure_name !== expected.procedure ||
      matches[0].procedure_in_current_schema !== true ||
      Number(matches[0].trigger_type) !== expected.triggerType ||
      matches[0].deferrable !== expected.deferrable ||
      matches[0].initially_deferred !== expected.initiallyDeferred ||
      matches[0].constraint_trigger !== expected.constraintTrigger ||
      matches[0].has_when_clause !== false ||
      Number(matches[0].argument_count) !== 0 ||
      (matches[0].enabled !== "O" && matches[0].enabled !== "A")
    );
  });
  if (invalidTriggers.length > 0) {
    throw new Error(
      `Deployment preflight found missing, misplaced, disabled, or incompatible V10 trigger(s): ${invalidTriggers.map((trigger) => trigger.name).join(", ")}`,
    );
  }

  const activationResult = await db.query<{
    id: number;
    artifact_id: string | null;
    revision: number;
    updated_at: number;
    schema_version: number | null;
    base_model_version: string | null;
    training_started_at: number | null;
    training_ended_at: number | null;
    artifact_json: Record<string, unknown> | null;
    metrics_json: Record<string, unknown> | null;
    artifact_sha256: string | null;
    created_at: number | null;
  }>(`
    /* deployment_preflight:mismatch_calibration_state */
    SELECT activation.id, activation.artifact_id, activation.revision, activation.updated_at,
      artifact.schema_version, artifact.base_model_version, artifact.training_started_at,
      artifact.training_ended_at, artifact.artifact_json, artifact.metrics_json,
      artifact.artifact_sha256, artifact.created_at
    FROM mismatch_calibration_activation AS activation
    LEFT JOIN mismatch_calibration_artifacts AS artifact ON artifact.id = activation.artifact_id
  `);
  const row = activationResult.rows[0];
  if (activationResult.rows.length !== 1 || !row || Number(row.id) !== 1) {
    throw new Error("Deployment preflight requires exactly one mismatch calibration activation row with id=1");
  }
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Deployment preflight found an invalid mismatch calibration activation revision");
  }
  const updatedAt = Number(row.updated_at);
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new Error("Deployment preflight found an invalid mismatch calibration activation timestamp");
  }
  await assertMismatchCalibrationActivationEventChain(db, {
    artifactId: row.artifact_id,
    revision,
    updatedAt,
  });
  if (row.artifact_id === null) {
    return;
  }
  if (
    row.artifact_json === null ||
    row.schema_version === null ||
    row.base_model_version === null ||
    row.training_started_at === null ||
    row.training_ended_at === null ||
    row.metrics_json === null ||
    row.artifact_sha256 === null ||
    row.created_at === null
  ) {
    throw new Error("Deployment preflight found a missing active mismatch calibration artifact");
  }
  const verification = verifyMismatchCalibrationArtifact(row.artifact_json);
  if (!verification.valid || verification.artifact.payloadSha256 !== row.artifact_sha256) {
    throw new Error("Deployment preflight found an invalid active mismatch calibration artifact");
  }
  const eligibility = evaluateMismatchCalibrationActivationEligibility({
    artifact: row.artifact_json,
    schemaVersion: Number(row.schema_version),
    baseModelVersion: row.base_model_version,
    trainingStartedAt: Number(row.training_started_at),
    trainingEndedAt: Number(row.training_ended_at),
    createdAt: Number(row.created_at),
    metrics: row.metrics_json,
    activationAt: updatedAt,
  });
  if (!eligibility.eligible) {
    throw new Error(
      `Deployment preflight found an activation-ineligible mismatch calibration artifact: ${eligibility.reasons.join(", ")}`,
    );
  }
}

async function readLiveReservationSnapshot(db: PgQueryable): Promise<LiveReservationSnapshot> {
  const result = await db.query<{
    row_count: number;
    canonical_row_count: number;
    owned_count: number;
    owner_intent_ids: string[];
  }>(`
    /* deployment_preflight:entry_reservation */
    SELECT
      count(*)::integer AS row_count,
      count(*) FILTER (
        WHERE scope_key = 'live:global' AND mode = 'live'
      )::integer AS canonical_row_count,
      count(*) FILTER (WHERE owner_intent_id IS NOT NULL)::integer AS owned_count,
      COALESCE(
        (array_agg(owner_intent_id ORDER BY owner_intent_id)
          FILTER (WHERE owner_intent_id IS NOT NULL))[1:5],
        ARRAY[]::text[]
      ) AS owner_intent_ids
    FROM entry_reservations
    WHERE mode = 'live' OR scope_key = 'live:global'
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error("Deployment preflight could not read the live entry reservation");
  }
  return {
    rowCount: parseCount(row.row_count, "live reservation rows"),
    canonicalRowCount: parseCount(row.canonical_row_count, "canonical live reservation rows"),
    ownedCount: parseCount(row.owned_count, "owned live reservations"),
    ownerIntentIds: parseSampleIds(row.owner_intent_ids, "live reservation owner ids"),
  };
}

function assertRequiredColumns(
  actual: ReadonlyMap<string, ReadonlySet<string>>,
  required: Readonly<Record<string, readonly string[]>>,
) {
  const missing: string[] = [];
  for (const [tableName, columnNames] of Object.entries(required)) {
    const actualColumns = actual.get(tableName);
    for (const columnName of columnNames) {
      if (!actualColumns?.has(columnName)) {
        missing.push(`${tableName}.${columnName}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`Deployment preflight schema introspection is missing: ${missing.join(", ")}`);
  }
}

async function readBlockingRows(db: PgQueryable, sql: string, label: string): Promise<BlockingRows> {
  const result = await db.query<{ total: number; sample_ids: string[] }>(sql);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Deployment preflight could not count ${label}`);
  }
  return {
    total: parseCount(row.total, label),
    sampleIds: parseSampleIds(row.sample_ids, `${label} sample ids`),
  };
}

function parseCount(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Deployment preflight received an invalid ${label} count`);
  }
  return parsed;
}

function parseSampleIds(value: unknown, label: string) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`Deployment preflight received invalid ${label}`);
  }
  return value;
}

function describeRows(label: string, rows: BlockingRows) {
  return describeIds(`${rows.total} ${label}`, rows.sampleIds);
}

function describeIds(label: string, ids: readonly string[]) {
  return ids.length > 0 ? `${label} (sample: ${ids.join(", ")})` : label;
}

function readPreflightEnvironment(): PreflightEnvironment {
  return {
    LIVE_EXECUTION_ALLOWED: process.env.LIVE_EXECUTION_ALLOWED,
    ALLOW_HISTORICAL_LEGACY_ACCOUNTING_DEPLOY: process.env.ALLOW_HISTORICAL_LEGACY_ACCOUNTING_DEPLOY,
  };
}
