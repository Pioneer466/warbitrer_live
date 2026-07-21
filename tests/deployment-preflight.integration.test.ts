import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import { runDatabaseMigrations } from "@/lib/db-migrations";
import { repairLegacyV8Preconditions } from "@/lib/legacy-v8-repair";
import {
  assertDeploymentPreflight,
  collectDeploymentPreflightSnapshot,
  evaluateDeploymentPreflight,
} from "@/lib/deployment-preflight";
import { DATABASE_MIGRATIONS } from "@/lib/postgres-db";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres("Postgres deployment preflight", () => {
  it("repairs only the audited legacy V8 projection anomalies before the first migration", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 6));
      const now = Date.now() - 2 * 24 * 60 * 60_000;
      await pool.query(
        `
          INSERT INTO order_intents (
            id, asset, shadow, slot_key, slot_start_ts, slot_end_ts, combination, status,
            created_at, updated_at, resolved_at, primary_venue, hedge_venue, gross_cost,
            target_notional_usd, max_slippage_bps, legs_json
          ) VALUES (
            'legacy-repair-intent', 'eth', false, 'eth:legacy-repair', $1, $2,
            'POLY_UP_KALSHI_NO', 'failed', $1, $2, $2, 'polymarket', 'kalshi',
            2.04, 5, 100,
            '[{"id":"legacy-poly-leg","filledSize":5.1},{"id":"legacy-kalshi-leg","filledSize":0}]'::jsonb
          )
        `,
        [now - 60_000, now],
      );
      await pool.query(
        `
          INSERT INTO venue_orders (
            id, asset, shadow, intent_id, venue, venue_order_id, client_order_id,
            market_ref, token_id, side, outcome, order_type, requested_price,
            requested_size, filled_size, average_fill_price, fee_usd, status,
            created_at, updated_at, raw_json
          ) VALUES (
            'legacy-repair-order', 'eth', false, 'legacy-repair-intent', 'polymarket',
            'legacy-repair-venue-order', 'legacy-repair-client', 'poly-market', 'poly-token',
            'BUY', 'UP', 'FOK', 0.4, 5, 5.1, 0.4, 0, 'pending', $1, $1, '{}'::jsonb
          )
        `,
        [now],
      );
      await pool.query(
        `
          INSERT INTO fills (
            id, asset, shadow, intent_id, venue, venue_order_id, trade_id, market_ref,
            token_id, side, outcome, price, size, fee_usd, liquidity, filled_at, raw_json
          ) VALUES (
            'legacy-repair-fill', 'btc', false, 'legacy-repair-intent', 'polymarket',
            'legacy-repair-venue-order', 'legacy-repair-trade', 'poly-market', 'poly-token',
            'BUY', 'UP', 0.4, 5.10004, 0, 'TAKER', $1, '{}'::jsonb
          )
        `,
        [now],
      );
      await pool.query("DROP TABLE schema_migrations");

      await expect(
        repairLegacyV8Preconditions(pool, {
          apply: false,
          expected: { fillAssetRows: 1, venueOrderRows: 1 },
        }),
      ).resolves.toMatchObject({ applied: false, fillAssetRows: 1, venueOrderRows: 1, auditRows: 2 });
      await expect(pool.query("SELECT count(*) FROM legacy_v8_precondition_repairs")).rejects.toThrow();

      await expect(
        repairLegacyV8Preconditions(pool, {
          apply: true,
          expected: { fillAssetRows: 1, venueOrderRows: 1 },
        }),
      ).resolves.toMatchObject({ applied: true, fillAssetRows: 1, venueOrderRows: 1, auditRows: 2 });

      await expect(pool.query("SELECT asset FROM fills WHERE id = 'legacy-repair-fill'")).resolves.toMatchObject({
        rows: [{ asset: "eth" }],
      });
      await expect(
        pool.query("SELECT status, requested_size FROM venue_orders WHERE id = 'legacy-repair-order'"),
      ).resolves.toMatchObject({ rows: [{ status: "filled", requested_size: 5.1 }] });
      await expect(pool.query("UPDATE legacy_v8_precondition_repairs SET reason = 'tampered'")).rejects.toThrow(
        /append-only/,
      );

      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS);
      const snapshot = await collectDeploymentPreflightSnapshot(pool);
      expect(snapshot.liveIntents.total).toBe(1);
      expect(snapshot.historicalLegacyExposure.total).toBe(1);
      expect(snapshot.accountingBacklog).toMatchObject({ total: 1, legacyPending: 1 });
      expect(
        evaluateDeploymentPreflight(snapshot, {
          LIVE_EXECUTION_ALLOWED: "false",
          ALLOW_HISTORICAL_LEGACY_ACCOUNTING_DEPLOY: "true",
        }),
      ).toEqual([]);
    });
  }, 60_000);

  it("checks a complete legacy schema before migration history is initialized", async () => {
    await withIsolatedSchema(async (pool) => {
      const baselineMigration = DATABASE_MIGRATIONS[0];
      if (!baselineMigration) {
        throw new Error("Expected the baseline database migration");
      }
      await baselineMigration.up(pool);

      const snapshot = await collectDeploymentPreflightSnapshot(pool);

      expect(snapshot).toMatchObject({
        schemaVersion: 0,
        liveIntents: { total: 0 },
        unresolvedAttempts: { total: 0 },
        openOrders: { total: 0 },
        livePositions: { total: 0 },
        liveReservation: null,
        accountingBacklog: null,
      });
      expect(() => assertDeploymentPreflight(snapshot, { LIVE_EXECUTION_ALLOWED: "false" })).not.toThrow();
    });
  }, 30_000);

  it("executes every latest-schema check against PostgreSQL", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS);

      const snapshot = await collectDeploymentPreflightSnapshot(pool);

      expect(snapshot).toMatchObject({
        schemaVersion: DATABASE_MIGRATIONS.at(-1)?.version,
        liveIntents: { total: 0 },
        unresolvedAttempts: { total: 0 },
        openOrders: { total: 0 },
        livePositions: { total: 0 },
        liveReservation: { rowCount: 1, canonicalRowCount: 1, ownedCount: 0 },
        accountingBacklog: { total: 0 },
      });
      expect(() => assertDeploymentPreflight(snapshot, { LIVE_EXECUTION_ALLOWED: "false" })).not.toThrow();
    });
  }, 30_000);

  it("executes the accounting preflight before the V7 to V8 migration", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 7));

      const snapshot = await collectDeploymentPreflightSnapshot(pool);

      expect(snapshot).toMatchObject({
        schemaVersion: 7,
        accountingBacklog: { total: 0 },
      });
      expect(() => assertDeploymentPreflight(snapshot, { LIVE_EXECUTION_ALLOWED: "false" })).not.toThrow();
    });
  }, 30_000);

  it("blocks legacy rollout on inconsistent order truth, fill mode, and active position", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 6));
      const now = Date.now();
      await insertTerminalLiveIntent(pool, now);
      await insertInconsistentConfirmedAttempt(pool, now);
      await insertMismatchedFill(pool, now);
      await insertActivePosition(pool, now);

      const snapshot = await collectDeploymentPreflightSnapshot(pool);

      expect(snapshot).toMatchObject({
        schemaVersion: 6,
        liveIntents: { total: 1, sampleIds: ["preflight-intent"] },
        unresolvedAttempts: { total: 1, sampleIds: ["preflight-attempt"] },
        openOrders: { total: 0 },
        livePositions: { total: 1, sampleIds: ["preflight-position"] },
        accountingBacklog: null,
      });
      expect(
        evaluateDeploymentPreflight(snapshot, { LIVE_EXECUTION_ALLOWED: "false" }).map(({ code }) => code),
      ).toEqual(["live_intents_or_exposure", "unresolved_live_attempts", "live_positions"]);
    });
  }, 30_000);

  it("blocks failed/not_submitted attempts that retain contradictory venue result evidence", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 6));
      const now = Date.now();
      await insertTerminalLiveIntent(pool, now);
      await insertContradictoryNotSubmittedAttempt(pool, now);

      const snapshot = await collectDeploymentPreflightSnapshot(pool);

      expect(snapshot.unresolvedAttempts).toEqual({
        total: 1,
        sampleIds: ["preflight-contradictory-attempt"],
      });
      expect(evaluateDeploymentPreflight(snapshot, { LIVE_EXECUTION_ALLOWED: "false" })).toEqual([
        expect.objectContaining({ code: "unresolved_live_attempts" }),
      ]);
    });
  }, 30_000);

  it.each([null, "not_submitted", "submission_unknown"])(
    "blocks confirmed attempts carrying unresolved truth status %j",
    async (truthStatus) => {
      await withIsolatedSchema(async (pool) => {
        await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 6));
        const now = Date.now();
        await insertTerminalLiveIntent(pool, now);
        await insertConfirmedAttemptWithTruthStatus(pool, now, truthStatus);

        const snapshot = await collectDeploymentPreflightSnapshot(pool);

        expect(snapshot.unresolvedAttempts).toEqual({
          total: 1,
          sampleIds: ["preflight-confirmed-attempt"],
        });
        expect(evaluateDeploymentPreflight(snapshot, { LIVE_EXECUTION_ALLOWED: "false" })).toEqual([
          expect.objectContaining({ code: "unresolved_live_attempts" }),
        ]);
      });
    },
    30_000,
  );

  it("blocks confirmed execution proof whose fill exceeds durable order evidence", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 6));
      const now = Date.now();
      await insertTerminalLiveIntent(pool, now);
      await insertConfirmedAttemptWithTruthStatus(pool, now, "filled", {
        resultStatus: "filled",
        resultFilledSize: 1,
      });

      const snapshot = await collectDeploymentPreflightSnapshot(pool);

      expect(snapshot.unresolvedAttempts).toEqual({
        total: 1,
        sampleIds: ["preflight-confirmed-attempt"],
      });
    });
  }, 30_000);

  it("accepts confirmed attempt truth that matches its durable terminal order", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 6));
      const now = Date.now();
      await insertTerminalLiveIntent(pool, now);
      await insertConfirmedAttemptWithTruthStatus(pool, now, "canceled");

      const snapshot = await collectDeploymentPreflightSnapshot(pool);

      expect(snapshot.unresolvedAttempts).toEqual({ total: 0, sampleIds: [] });
    });
  }, 30_000);

  it("allows durable order status to progress after a confirmed pending snapshot", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 6));
      const now = Date.now();
      await insertTerminalLiveIntent(pool, now);
      await insertConfirmedAttemptWithTruthStatus(pool, now, "pending", {
        orderStatus: "pending",
        resultStatus: "pending",
      });

      expect((await collectDeploymentPreflightSnapshot(pool)).unresolvedAttempts.total).toBe(0);

      await pool.query(
        `
          UPDATE venue_orders
          SET status = 'filled', filled_size = 1, average_fill_price = 0.45, updated_at = $1
          WHERE id = 'preflight-confirmed-order'
        `,
        [now + 1],
      );

      expect((await collectDeploymentPreflightSnapshot(pool)).unresolvedAttempts.total).toBe(0);
    });
  }, 30_000);

  it("blocks impossible legacy fill and venue-order evidence", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 6));
      const now = Date.now();
      await insertTerminalLiveIntent(pool, now);
      await insertImpossibleExecutionEvidence(pool, now);

      const snapshot = await collectDeploymentPreflightSnapshot(pool);

      expect(snapshot.liveIntents).toEqual({ total: 1, sampleIds: ["preflight-intent"] });
      expect(snapshot.openOrders).toEqual({ total: 1, sampleIds: ["preflight-impossible-order"] });
      expect(evaluateDeploymentPreflight(snapshot, { LIVE_EXECUTION_ALLOWED: "false" })).toEqual([
        expect.objectContaining({ code: "live_intents_or_exposure" }),
        expect.objectContaining({ code: "open_live_orders" }),
      ]);
    });
  }, 30_000);

  it("blocks invalid legacy venue-order price and fee evidence", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 6));
      const now = Date.now();
      await insertTerminalLiveIntent(pool, now);
      await insertInvalidVenuePricingEvidence(pool, now);

      const snapshot = await collectDeploymentPreflightSnapshot(pool);

      expect(snapshot.openOrders).toEqual({
        total: 2,
        sampleIds: ["preflight-invalid-fee-order", "preflight-invalid-price-order"],
      });
    });
  }, 30_000);

  it("blocks orphaned live fills", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 6));
      const now = Date.now();
      await pool.query(
        `
          INSERT INTO fills (
            id, asset, shadow, intent_id, venue, venue_order_id, trade_id, market_ref,
            token_id, side, outcome, price, size, fee_usd, liquidity, filled_at, raw_json
          ) VALUES (
            'preflight-orphan-fill', 'btc', false, NULL, 'polymarket', 'orphan-order',
            'orphan-trade', 'poly-market', 'poly-token', 'BUY', 'UP', 0.45, 1, 0,
            'TAKER', $1, '{}'::jsonb
          )
        `,
        [now],
      );

      const snapshot = await collectDeploymentPreflightSnapshot(pool);

      expect(snapshot.liveIntents).toEqual({
        total: 1,
        sampleIds: ["orphan-fill:preflight-orphan-fill"],
      });
      expect(evaluateDeploymentPreflight(snapshot, { LIVE_EXECUTION_ALLOWED: "false" })).toEqual([
        expect.objectContaining({ code: "live_intents_or_exposure" }),
      ]);
    });
  }, 30_000);

  it("blocks cross-asset execution evidence on a terminal intent", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 6));
      const now = Date.now();
      await insertSettledLiveIntent(pool, now);
      await insertCrossAssetExecutionEvidence(pool, now);

      const snapshot = await collectDeploymentPreflightSnapshot(pool);

      expect(snapshot.liveIntents).toEqual({ total: 1, sampleIds: ["preflight-settled-intent"] });
      expect(snapshot.unresolvedAttempts).toEqual({ total: 1, sampleIds: ["preflight-cross-asset-attempt"] });
      expect(snapshot.openOrders).toEqual({ total: 1, sampleIds: ["preflight-cross-asset-order"] });
    });
  }, 30_000);
});

async function insertTerminalLiveIntent(pool: Pool, now: number) {
  await pool.query(
    `
      INSERT INTO order_intents (
        id, asset, shadow, slot_key, slot_start_ts, slot_end_ts, combination, status,
        created_at, updated_at, resolved_at, primary_venue, hedge_venue, gross_cost,
        target_notional_usd, max_slippage_bps, legs_json
      ) VALUES (
        'preflight-intent', 'btc', false, 'btc:preflight', $1, $2, 'POLY_UP_KALSHI_NO', 'failed',
        $1, $2, $2, 'polymarket', 'kalshi', 0, 10, 100, '[]'::jsonb
      )
    `,
    [now - 1_000, now],
  );
}

async function insertSettledLiveIntent(pool: Pool, now: number) {
  await pool.query(
    `
      INSERT INTO order_intents (
        id, asset, shadow, slot_key, slot_start_ts, slot_end_ts, combination, status,
        created_at, updated_at, resolved_at, primary_venue, hedge_venue, gross_cost,
        target_notional_usd, max_slippage_bps, legs_json
      ) VALUES (
        'preflight-settled-intent', 'btc', false, 'btc:preflight-settled', $1, $2,
        'POLY_UP_KALSHI_NO', 'settled', $1, $2, $2, 'polymarket', 'kalshi',
        0, 10, 100, '[]'::jsonb
      )
    `,
    [now - 1_000, now],
  );
}

async function insertCrossAssetExecutionEvidence(pool: Pool, now: number) {
  await pool.query(
    `
      INSERT INTO venue_orders (
        id, asset, shadow, intent_id, venue, venue_order_id, client_order_id,
        market_ref, token_id, side, outcome, order_type, requested_price,
        requested_size, filled_size, average_fill_price, fee_usd, status,
        created_at, updated_at, raw_json
      ) VALUES (
        'preflight-cross-asset-order', 'doge', false, 'preflight-settled-intent', 'polymarket',
        'preflight-cross-asset-venue-order', 'preflight-cross-asset-client', 'poly-market',
        'poly-token', 'BUY', 'UP', 'FOK', 0.45, 1, 0, NULL, 0, 'canceled',
        $1, $1, '{}'::jsonb
      )
    `,
    [now],
  );
  await pool.query(
    `
      INSERT INTO order_attempts (
        id, asset, shadow, intent_id, leg_id, stage, venue, side, order_type,
        client_order_id, venue_order_id, status, truth_status, request_json,
        result_json, created_at, updated_at
      ) VALUES (
        'preflight-cross-asset-attempt', 'doge', false, 'preflight-settled-intent',
        'poly-leg', 'primary', 'polymarket', 'BUY', 'FOK', 'preflight-cross-asset-client',
        'preflight-cross-asset-venue-order', 'confirmed', 'confirmed',
        '{"marketRef":"poly-market","tokenId":"poly-token","outcome":"UP"}'::jsonb,
        '{"venueOrderId":"preflight-cross-asset-venue-order","status":"canceled","filledSize":0}'::jsonb,
        $1, $1
      )
    `,
    [now],
  );
  await pool.query(
    `
      INSERT INTO fills (
        id, asset, shadow, intent_id, venue, venue_order_id, trade_id, market_ref,
        token_id, side, outcome, price, size, fee_usd, liquidity, filled_at, raw_json
      ) VALUES (
        'preflight-cross-asset-fill', 'doge', false, 'preflight-settled-intent', 'polymarket',
        'preflight-cross-asset-venue-order', 'preflight-cross-asset-trade', 'poly-market',
        'poly-token', 'BUY', 'UP', 0.45, 1, 0, 'TAKER', $1, '{}'::jsonb
      )
    `,
    [now],
  );
}

async function insertInconsistentConfirmedAttempt(pool: Pool, now: number) {
  await pool.query(
    `
      INSERT INTO order_attempts (
        id, asset, shadow, intent_id, leg_id, stage, venue, side, order_type,
        client_order_id, venue_order_id, status, truth_status, request_json,
        result_json, created_at, updated_at
      ) VALUES (
        'preflight-attempt', 'btc', false, 'preflight-intent', 'poly-leg', 'primary',
        'polymarket', 'BUY', 'FOK', 'preflight-client', NULL, 'confirmed', 'confirmed',
        '{"marketRef":"poly-market","tokenId":"poly-token","outcome":"UP"}'::jsonb,
        NULL, $1, $1
      )
    `,
    [now],
  );
}

async function insertContradictoryNotSubmittedAttempt(pool: Pool, now: number) {
  await pool.query(
    `
      INSERT INTO order_attempts (
        id, asset, shadow, intent_id, leg_id, stage, venue, side, order_type,
        client_order_id, venue_order_id, status, truth_status, request_json,
        result_json, error, created_at, updated_at
      ) VALUES (
        'preflight-contradictory-attempt', 'btc', false, 'preflight-intent', 'poly-leg', 'primary',
        'polymarket', 'BUY', 'FOK', 'preflight-client', NULL, 'failed', 'not_submitted',
        '{"marketRef":"poly-market","tokenId":"poly-token","outcome":"UP"}'::jsonb,
        '{"venueOrderId":"venue-order","status":"filled","filledSize":1}'::jsonb,
        'contradictory venue response', $1, $1
      )
    `,
    [now],
  );
}

async function insertConfirmedAttemptWithTruthStatus(
  pool: Pool,
  now: number,
  truthStatus: string | null,
  options: {
    orderStatus?: string;
    orderFilledSize?: number;
    resultStatus?: string;
    resultFilledSize?: number;
  } = {},
) {
  const orderFilledSize = options.orderFilledSize ?? 0;
  const orderAverageFillPrice = orderFilledSize > 0 ? 0.45 : null;
  await pool.query(
    `
      INSERT INTO venue_orders (
        id, asset, shadow, intent_id, venue, venue_order_id, client_order_id,
        market_ref, token_id, side, outcome, order_type, requested_price,
        requested_size, filled_size, average_fill_price, fee_usd, status,
        created_at, updated_at, raw_json
      ) VALUES (
        'preflight-confirmed-order', 'btc', false, 'preflight-intent', 'polymarket',
        'preflight-confirmed-venue-order', 'preflight-confirmed-client', 'poly-market',
        'poly-token', 'BUY', 'UP', 'FOK', 0.45, 1, $2, $3, 0, $4,
        $1, $1, '{}'::jsonb
      )
    `,
    [now, orderFilledSize, orderAverageFillPrice, options.orderStatus ?? "canceled"],
  );
  await pool.query(
    `
      INSERT INTO order_attempts (
        id, asset, shadow, intent_id, leg_id, stage, venue, side, order_type,
        client_order_id, venue_order_id, status, truth_status, request_json,
        result_json, error, created_at, updated_at
      ) VALUES (
        'preflight-confirmed-attempt', 'btc', false, 'preflight-intent', 'poly-leg', 'primary',
        'polymarket', 'BUY', 'FOK', 'preflight-confirmed-client',
        'preflight-confirmed-venue-order', 'confirmed', $2,
        '{"marketRef":"poly-market","tokenId":"poly-token","outcome":"UP"}'::jsonb,
        jsonb_build_object(
          'venue', 'polymarket',
          'venueOrderId', 'preflight-confirmed-venue-order',
          'status', $3::text,
          'filledSize', $4::double precision
        ),
        NULL, $1, $1
      )
    `,
    [now, truthStatus, options.resultStatus ?? "canceled", options.resultFilledSize ?? 0],
  );
}

async function insertImpossibleExecutionEvidence(pool: Pool, now: number) {
  await pool.query(
    `
      INSERT INTO venue_orders (
        id, asset, shadow, intent_id, venue, venue_order_id, client_order_id,
        market_ref, token_id, side, outcome, order_type, requested_price,
        requested_size, filled_size, average_fill_price, fee_usd, status,
        created_at, updated_at, raw_json
      ) VALUES (
        'preflight-impossible-order', 'btc', false, 'preflight-intent', 'polymarket',
        'preflight-impossible-venue-order', 'preflight-impossible-client', 'poly-market',
        'poly-token', 'BUY', 'UP', 'FOK', 0.45, 1, 0, NULL, 0, 'filled',
        $1, $1, '{}'::jsonb
      )
    `,
    [now],
  );
  await pool.query(
    `
      INSERT INTO fills (
        id, asset, shadow, intent_id, venue, venue_order_id, trade_id, market_ref,
        token_id, side, outcome, price, size, fee_usd, liquidity, filled_at, raw_json
      ) VALUES (
        'preflight-impossible-fill', 'btc', false, 'preflight-intent', 'polymarket',
        'preflight-impossible-venue-order', 'preflight-impossible-trade', 'poly-market',
        'poly-token', 'BUY', 'UP', 0.45, 0, 0, 'TAKER', $1, '{}'::jsonb
      )
    `,
    [now],
  );
}

async function insertInvalidVenuePricingEvidence(pool: Pool, now: number) {
  await pool.query(
    `
      INSERT INTO venue_orders (
        id, asset, shadow, intent_id, venue, venue_order_id, client_order_id,
        market_ref, token_id, side, outcome, order_type, requested_price,
        requested_size, filled_size, average_fill_price, fee_usd, status,
        created_at, updated_at, raw_json
      ) VALUES
        (
          'preflight-invalid-price-order', 'btc', false, 'preflight-intent', 'polymarket',
          'preflight-invalid-price-venue-order', 'preflight-invalid-price-client', 'poly-market',
          'poly-token', 'BUY', 'UP', 'FOK', 'NaN'::double precision, 1, 0, NULL, 0,
          'canceled', $1, $1, '{}'::jsonb
        ),
        (
          'preflight-invalid-fee-order', 'btc', false, 'preflight-intent', 'polymarket',
          'preflight-invalid-fee-venue-order', 'preflight-invalid-fee-client', 'poly-market',
          'poly-token', 'BUY', 'UP', 'FOK', 0.45, 1, 0, NULL, 'NaN'::double precision,
          'canceled', $1, $1, '{}'::jsonb
        )
    `,
    [now],
  );
}

async function insertMismatchedFill(pool: Pool, now: number) {
  await pool.query(
    `
      INSERT INTO fills (
        id, asset, shadow, intent_id, venue, venue_order_id, trade_id, market_ref,
        token_id, side, outcome, price, size, fee_usd, liquidity, filled_at, raw_json
      ) VALUES (
        'preflight-fill', 'btc', true, 'preflight-intent', 'polymarket', 'preflight-order',
        'preflight-trade', 'poly-market', 'poly-token', 'BUY', 'UP', 0.45, 1, 0,
        'TAKER', $1, '{}'::jsonb
      )
    `,
    [now],
  );
}

async function insertActivePosition(pool: Pool, now: number) {
  await pool.query(
    `
      INSERT INTO positions (
        id, asset, venue, market_ref, outcome, size, average_price, current_price,
        current_value_usd, realized_pnl_usd, unrealized_pnl_usd, redeemable,
        mergeable, updated_at, raw_json
      ) VALUES (
        'preflight-position', 'btc', 'kalshi', 'kalshi-market', 'NO', 0.06, 0.5, 0.5,
        0.03, 0, 0, false, false, $1, '{}'::jsonb
      )
    `,
    [now],
  );
}

async function withIsolatedSchema(run: (pool: Pool) => Promise<void>) {
  if (!TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  const schema = `warbitrer_deployment_preflight_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    max: 4,
    options: `-c search_path=${schema}`,
  });

  try {
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
