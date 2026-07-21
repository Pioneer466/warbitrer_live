import { getDatabaseMigrationStatus, type PgQueryable } from "@/lib/db-migrations";
import { isTruthyEnv } from "@/lib/env";
import { DATABASE_MIGRATIONS, getLiveAccountingBacklog } from "@/lib/postgres-db";
import type { AccountingBacklogSummary } from "@/lib/types";

const MINIMUM_PREFLIGHT_SCHEMA_VERSION = 1;
const ACCOUNTING_SCHEMA_VERSION = 7;
const ACCOUNTING_EVIDENCE_SCHEMA_VERSION = 8;
export const DEPLOYMENT_PREFLIGHT_REVIEWED_SCHEMA_VERSION = 8;

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

type PreflightEnvironment = Partial<Record<"LIVE_EXECUTION_ALLOWED", string | undefined>>;

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

  if (isTruthyEnv(environment.LIVE_EXECUTION_ALLOWED)) {
    issues.push({
      code: "live_execution_gate_enabled",
      message: "LIVE_EXECUTION_ALLOWED must be disabled before deployment",
    });
  }
  if (snapshot.liveIntents.total > 0) {
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
  if (snapshot.accountingBacklog && snapshot.accountingBacklog.total > 0) {
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
  return { LIVE_EXECUTION_ALLOWED: process.env.LIVE_EXECUTION_ALLOWED };
}
