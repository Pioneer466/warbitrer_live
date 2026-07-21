import type { Pool, PoolClient } from "pg";

export type LegacyV8RepairExpectation = {
  fillAssetRows: number;
  venueOrderRows: number;
};

export type LegacyV8RepairSummary = {
  applied: boolean;
  fillAssetRows: number;
  venueOrderRows: number;
  auditRows: number;
};

export async function repairLegacyV8Preconditions(
  pool: Pool,
  input: { apply: boolean; expected: LegacyV8RepairExpectation; repairedAt?: number },
): Promise<LegacyV8RepairSummary> {
  assertExpectedCount(input.expected.fillAssetRows, "expected fill-asset repair rows");
  assertExpectedCount(input.expected.venueOrderRows, "expected venue-order repair rows");

  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('warbitrer:legacy-v8-precondition-repair'))");
    await assertUninitializedMigrationHistory(client);
    await createAuditTable(client);

    const fillAssetRows = await repairFillAssets(client, input.repairedAt ?? Date.now());
    const venueOrderRows = await repairVenueOrders(client, input.repairedAt ?? Date.now());
    assertExactCount(fillAssetRows, input.expected.fillAssetRows, "fill-asset repair rows");
    assertExactCount(venueOrderRows, input.expected.venueOrderRows, "venue-order repair rows");
    await assertV8Preconditions(client);

    const auditResult = await client.query<{ total: number }>(
      "SELECT count(*)::integer AS total FROM legacy_v8_precondition_repairs",
    );
    const auditRows = Number(auditResult.rows[0]?.total ?? 0);
    if (!Number.isSafeInteger(auditRows) || auditRows < fillAssetRows + venueOrderRows) {
      throw new Error("Legacy V8 repair audit is incomplete");
    }

    if (input.apply) {
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }
    return { applied: input.apply, fillAssetRows, venueOrderRows, auditRows };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function assertUninitializedMigrationHistory(client: PoolClient) {
  const result = await client.query<{ migration_history: string | null }>(
    "SELECT to_regclass('schema_migrations')::text AS migration_history",
  );
  if (result.rows[0]?.migration_history !== null) {
    throw new Error("Legacy V8 repair requires an uninitialized V0 migration history");
  }
}

async function createAuditTable(client: PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS legacy_v8_precondition_repairs (
      id BIGSERIAL PRIMARY KEY,
      repair_key TEXT NOT NULL UNIQUE,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('fill', 'venue_order')),
      entity_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      before_json JSONB NOT NULL CHECK (jsonb_typeof(before_json) = 'object'),
      after_json JSONB NOT NULL CHECK (jsonb_typeof(after_json) = 'object'),
      repaired_at BIGINT NOT NULL CHECK (repaired_at >= 0)
    );

    CREATE OR REPLACE FUNCTION reject_legacy_v8_repair_audit_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION 'legacy V8 precondition repair audit is append-only' USING ERRCODE = '55000';
    END;
    $function$;

    DROP TRIGGER IF EXISTS legacy_v8_precondition_repairs_append_only
      ON legacy_v8_precondition_repairs;
    CREATE TRIGGER legacy_v8_precondition_repairs_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON legacy_v8_precondition_repairs
    FOR EACH STATEMENT EXECUTE FUNCTION reject_legacy_v8_repair_audit_mutation()
  `);
}

async function repairFillAssets(client: PoolClient, repairedAt: number) {
  const audit = await client.query(
    `
      WITH eligible AS (
        SELECT fill.id, intent.asset, to_jsonb(fill) AS before_json
        FROM fills AS fill
        JOIN order_intents AS intent ON intent.id = fill.intent_id
        WHERE fill.asset = 'btc'
          AND intent.asset IN ('eth', 'sol', 'xrp', 'doge')
          AND fill.asset IS DISTINCT FROM intent.asset
          AND fill.shadow IS NOT DISTINCT FROM intent.shadow
          AND EXISTS (
            SELECT 1
            FROM venue_orders AS venue_order
            WHERE venue_order.intent_id = fill.intent_id
              AND venue_order.venue = fill.venue
              AND venue_order.venue_order_id = fill.venue_order_id
              AND venue_order.asset = intent.asset
              AND venue_order.shadow = intent.shadow
          )
      )
      INSERT INTO legacy_v8_precondition_repairs (
        repair_key, entity_type, entity_id, reason, before_json, after_json, repaired_at
      )
      SELECT
        'fill-asset:' || id,
        'fill',
        id,
        'legacy default asset contradicted exact parent and venue-order identity',
        before_json,
        before_json || jsonb_build_object('asset', asset),
        $1
      FROM eligible
      ORDER BY id
      RETURNING entity_id
    `,
    [repairedAt],
  );

  const updated = await client.query(`
    WITH eligible AS (
      SELECT fill.id, intent.asset
      FROM fills AS fill
      JOIN order_intents AS intent ON intent.id = fill.intent_id
      WHERE fill.asset = 'btc'
        AND intent.asset IN ('eth', 'sol', 'xrp', 'doge')
        AND fill.asset IS DISTINCT FROM intent.asset
        AND fill.shadow IS NOT DISTINCT FROM intent.shadow
        AND EXISTS (
          SELECT 1
          FROM venue_orders AS venue_order
          WHERE venue_order.intent_id = fill.intent_id
            AND venue_order.venue = fill.venue
            AND venue_order.venue_order_id = fill.venue_order_id
            AND venue_order.asset = intent.asset
            AND venue_order.shadow = intent.shadow
        )
    )
    UPDATE fills AS fill
    SET asset = eligible.asset
    FROM eligible
    WHERE fill.id = eligible.id
  `);
  if (updated.rowCount !== audit.rowCount) {
    throw new Error("Legacy fill-asset repair did not match its immutable audit rows");
  }
  return updated.rowCount ?? 0;
}

async function repairVenueOrders(client: PoolClient, repairedAt: number) {
  const eligibleSql = `
    SELECT
      venue_order.id,
      to_jsonb(venue_order) AS before_json,
      CASE WHEN venue_order.status = 'pending' THEN 'filled' ELSE venue_order.status END AS repaired_status,
      GREATEST(venue_order.requested_size, venue_order.filled_size) AS repaired_requested_size
    FROM venue_orders AS venue_order
    JOIN order_intents AS intent ON intent.id = venue_order.intent_id
    JOIN LATERAL (
      SELECT count(fill.id) AS fill_count, COALESCE(sum(fill.size), 0) AS exact_fill_size
      FROM fills AS fill
      WHERE fill.intent_id = venue_order.intent_id
        AND fill.venue = venue_order.venue
        AND fill.venue_order_id = venue_order.venue_order_id
    ) AS durable_fill ON true
    WHERE venue_order.shadow = false
      AND intent.shadow = false
      AND intent.status IN ('settled', 'unwound', 'failed')
      AND venue_order.venue = 'polymarket'
      AND venue_order.order_type IN ('FOK', 'FAK')
      AND venue_order.status IN ('pending', 'filled')
      AND venue_order.filled_size > 0
      AND durable_fill.fill_count > 0
      AND abs(durable_fill.exact_fill_size - venue_order.filled_size) <= 0.0001
      AND (
        venue_order.status = 'pending'
        OR venue_order.filled_size > venue_order.requested_size + 0.000001
      )
  `;
  const audit = await client.query(
    `
      WITH eligible AS (${eligibleSql})
      INSERT INTO legacy_v8_precondition_repairs (
        repair_key, entity_type, entity_id, reason, before_json, after_json, repaired_at
      )
      SELECT
        'venue-order:' || id,
        'venue_order',
        id,
        'terminal IOC venue fill contradicted stale status or rounded requested size',
        before_json,
        before_json || jsonb_build_object(
          'status', repaired_status,
          'requested_size', repaired_requested_size
        ),
        $1
      FROM eligible
      ORDER BY id
      RETURNING entity_id
    `,
    [repairedAt],
  );
  const updated = await client.query(`
    WITH eligible AS (${eligibleSql})
    UPDATE venue_orders AS venue_order
    SET status = eligible.repaired_status,
        requested_size = eligible.repaired_requested_size
    FROM eligible
    WHERE venue_order.id = eligible.id
  `);
  if (updated.rowCount !== audit.rowCount) {
    throw new Error("Legacy venue-order repair did not match its immutable audit rows");
  }
  return updated.rowCount ?? 0;
}

async function assertV8Preconditions(client: PoolClient) {
  const result = await client.query<{
    invalid_orders: number;
    invalid_fill_economics: number;
    invalid_positions: number;
    identity_mismatches: number;
    invalid_attempt_statuses: number;
  }>(`
    SELECT
      (SELECT count(*) FROM venue_orders AS venue_order WHERE
        venue_order.status NOT IN ('pending', 'live', 'partially_filled', 'filled', 'canceled', 'rejected', 'expired')
        OR venue_order.requested_size::text IN ('NaN', 'Infinity', '-Infinity')
        OR venue_order.requested_size <= 0
        OR venue_order.requested_price IS NOT NULL AND (
          venue_order.requested_price::text IN ('NaN', 'Infinity', '-Infinity')
          OR venue_order.requested_price <= 0 OR venue_order.requested_price > 1
        )
        OR venue_order.filled_size::text IN ('NaN', 'Infinity', '-Infinity')
        OR venue_order.filled_size < 0
        OR venue_order.filled_size > venue_order.requested_size + 0.000001
        OR venue_order.status = 'filled' AND venue_order.filled_size <= 0
        OR venue_order.status = 'partially_filled' AND (
          venue_order.filled_size <= 0 OR venue_order.filled_size >= venue_order.requested_size
        )
        OR venue_order.filled_size > 0 AND (
          venue_order.average_fill_price IS NULL
          OR venue_order.average_fill_price::text IN ('NaN', 'Infinity', '-Infinity')
          OR venue_order.average_fill_price <= 0 OR venue_order.average_fill_price > 1
        )
        OR venue_order.fee_usd IS NOT NULL AND (
          venue_order.fee_usd::text IN ('NaN', 'Infinity', '-Infinity') OR venue_order.fee_usd < 0
        )
      )::integer AS invalid_orders,
      (SELECT count(*) FROM fills AS fill WHERE fill.shadow = false AND (
        fill.price::text IN ('NaN', 'Infinity', '-Infinity') OR fill.price <= 0 OR fill.price > 1
        OR fill.size::text IN ('NaN', 'Infinity', '-Infinity') OR fill.size <= 0
        OR fill.fee_usd::text IN ('NaN', 'Infinity', '-Infinity') OR fill.fee_usd < 0
      ))::integer AS invalid_fill_economics,
      (SELECT count(*) FROM positions AS position WHERE
        position.size::text IN ('NaN', 'Infinity', '-Infinity')
        OR position.current_value_usd::text IN ('NaN', 'Infinity', '-Infinity')
      )::integer AS invalid_positions,
      (
        (SELECT count(*) FROM fills AS fill JOIN order_intents AS intent ON intent.id = fill.intent_id
          WHERE fill.asset IS DISTINCT FROM intent.asset OR fill.shadow IS DISTINCT FROM intent.shadow)
        + (SELECT count(*) FROM venue_orders AS venue_order
          JOIN order_intents AS intent ON intent.id = venue_order.intent_id
          WHERE venue_order.asset IS DISTINCT FROM intent.asset
            OR venue_order.shadow IS DISTINCT FROM intent.shadow)
        + (SELECT count(*) FROM order_attempts AS attempt
          JOIN order_intents AS intent ON intent.id = attempt.intent_id
          WHERE attempt.asset IS DISTINCT FROM intent.asset OR attempt.shadow IS DISTINCT FROM intent.shadow)
      )::integer AS identity_mismatches,
      (SELECT count(*) FROM order_attempts AS attempt WHERE attempt.status NOT IN (
        'planned', 'submitting', 'submitted', 'truth_pending', 'confirmed', 'failed'
      ))::integer AS invalid_attempt_statuses
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error("Legacy V8 repair could not verify migration preconditions");
  }
  const violations = Object.entries(row).filter(([, count]) => Number(count) !== 0);
  if (violations.length > 0) {
    throw new Error(
      `Legacy V8 repair left unsupported precondition violations: ${violations
        .map(([name, count]) => `${name}=${count}`)
        .join(", ")}`,
    );
  }
}

function assertExpectedCount(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function assertExactCount(actual: number, expected: number, label: string) {
  if (actual !== expected) {
    throw new Error(`Legacy V8 repair expected ${expected} ${label}, found ${actual}`);
  }
}
