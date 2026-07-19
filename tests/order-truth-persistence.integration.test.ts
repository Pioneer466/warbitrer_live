import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import {
  DATABASE_MIGRATIONS,
  ImmutableFillConflictError,
  migratePostgresDatabase,
  upsertFill,
  upsertOrderAttempt,
  upsertVenueOrder,
} from "@/lib/postgres-db";
import { runDatabaseMigrations } from "@/lib/db-migrations";
import type { LiveFill, LiveOrder, OrderAttempt } from "@/lib/types";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres("Postgres order-truth persistence", () => {
  it("adds revisions and replaces the legacy fill identity only after a clean preflight", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);

      const columns = await pool.query<{ table_name: string; column_name: string; column_default: string }>(`
        SELECT table_name, column_name, column_default
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN ('order_intents', 'venue_orders', 'order_attempts')
          AND column_name = 'revision'
        ORDER BY table_name
      `);
      const index = await pool.query<{ indexdef: string }>(`
        SELECT indexdef
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = 'fills_exchange_order_trade_idx'
      `);
      const oldIndex = await pool.query<{ index_name: string | null }>(
        "SELECT to_regclass('fills_exchange_trade_idx') AS index_name",
      );

      expect(columns.rows).toHaveLength(3);
      expect(columns.rows.every((row) => row.column_default === "0")).toBe(true);
      expect(index.rows[0]?.indexdef).toContain("(venue, venue_order_id, trade_id)");
      expect(oldIndex.rows[0]?.index_name).toBeNull();
    });
  }, 30_000);

  it("rolls the second migration back when legacy rows contain a duplicate logical fill", async () => {
    await withIsolatedSchema(async (pool) => {
      await runDatabaseMigrations(pool, DATABASE_MIGRATIONS.slice(0, 1));
      await insertIntent(pool, "intent-preflight");
      await pool.query("DROP INDEX fills_exchange_trade_idx");
      await insertRawFill(pool, buildFill({ id: "fill-a", intentId: "intent-preflight" }));
      await insertRawFill(pool, buildFill({ id: "fill-b", intentId: "intent-preflight" }));

      await expect(runDatabaseMigrations(pool, DATABASE_MIGRATIONS)).rejects.toThrow(
        /Migration 2 refused: duplicate fill identity/,
      );

      const revisionColumns = await pool.query<{ total: string }>(`
        SELECT count(*) AS total
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND column_name = 'revision'
      `);
      const applied = await pool.query<{ versions: number[] }>(
        "SELECT array_agg(version ORDER BY version) AS versions FROM schema_migrations",
      );
      expect(Number(revisionColumns.rows[0]?.total)).toBe(0);
      expect(applied.rows[0]?.versions).toEqual([1]);
    });
  }, 30_000);

  it("keeps order and attempt proof monotonic while incrementing revisions", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await insertIntent(pool);

      await upsertVenueOrder(pool, buildOrder());
      await upsertVenueOrder(
        pool,
        buildOrder({
          filledSize: 5,
          averageFillPrice: 0.46,
          feeUsd: 0.05,
          status: "partially_filled",
          updatedAt: 300,
          raw: { observation: "progressed" },
        }),
      );
      await upsertVenueOrder(
        pool,
        buildOrder({
          filledSize: 1,
          averageFillPrice: 0.41,
          feeUsd: 0.01,
          status: "live",
          updatedAt: 100,
          raw: { observation: "stale-writer" },
        }),
      );
      await upsertVenueOrder(pool, buildOrder({ filledSize: 5, status: "canceled", updatedAt: 400 }));
      await upsertVenueOrder(pool, buildOrder({ filledSize: 5, status: "live", updatedAt: 500 }));

      const order = await pool.query<{
        filled_size: number;
        average_fill_price: number;
        fee_usd: number;
        status: string;
        raw_json: Record<string, unknown>;
        revision: number;
      }>("SELECT filled_size, average_fill_price, fee_usd, status, raw_json, revision FROM venue_orders");
      expect(order.rows[0]).toMatchObject({
        filled_size: 5,
        average_fill_price: 0.46,
        fee_usd: 0.05,
        status: "canceled",
        revision: 4,
      });
      expect(order.rows[0]?.raw_json).not.toEqual({ observation: "stale-writer" });

      await upsertOrderAttempt(
        pool,
        buildAttempt({
          status: "confirmed",
          truthStatus: "filled",
          result: { filledSize: 5 },
          updatedAt: 300,
        }),
      );
      await upsertOrderAttempt(
        pool,
        buildAttempt({
          status: "failed",
          truthStatus: "not_submitted",
          result: null,
          error: "stale failure",
          updatedAt: 100,
        }),
      );

      const attempt = await pool.query<{
        status: string;
        truth_status: string;
        result_json: Record<string, unknown>;
        error: string | null;
        revision: number;
      }>("SELECT status, truth_status, result_json, error, revision FROM order_attempts");
      expect(attempt.rows[0]).toEqual({
        status: "confirmed",
        truth_status: "filled",
        result_json: { filledSize: 5 },
        error: null,
        revision: 1,
      });

      await upsertOrderAttempt(
        pool,
        buildAttempt({
          id: "attempt-retry",
          clientOrderId: "client-order-retry",
          status: "failed",
          truthStatus: "not_submitted",
          error: "definitive zero fill",
          updatedAt: 200,
        }),
      );
      await upsertOrderAttempt(
        pool,
        buildAttempt({
          id: "attempt-retry",
          clientOrderId: "client-order-retry",
          status: "truth_pending",
          truthStatus: "submission_unknown",
          error: "retry timeout",
          updatedAt: 400,
        }),
      );
      const retry = await pool.query<{
        status: string;
        truth_status: string;
        error: string;
        revision: number;
      }>("SELECT status, truth_status, error, revision FROM order_attempts WHERE id = 'attempt-retry'");
      expect(retry.rows[0]).toEqual({
        status: "truth_pending",
        truth_status: "submission_unknown",
        error: "retry timeout",
        revision: 1,
      });
    });
  }, 30_000);

  it("makes fill replay idempotent, rejects mutations, and permits one maker trade across two orders", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      await insertIntent(pool);
      const original = buildFill();

      await upsertFill(pool, original);
      await upsertFill(pool, { ...original, raw: { replay: true } });
      await upsertFill(pool, { ...original, id: "fill-logical-replay", raw: { replay: "alternate-id" } });
      await expect(upsertFill(pool, { ...original, feeUsd: 0.5 })).rejects.toBeInstanceOf(ImmutableFillConflictError);
      await expect(
        upsertFill(pool, { ...original, id: "fill-logical-conflict", price: original.price + 0.01 }),
      ).rejects.toBeInstanceOf(ImmutableFillConflictError);

      await upsertFill(
        pool,
        buildFill({
          id: "fill-maker-second-order",
          venueOrderId: "venue-order-2",
          raw: { maker: "second-order" },
        }),
      );

      const fills = await pool.query<{
        id: string;
        venue_order_id: string;
        trade_id: string;
        raw_json: Record<string, unknown>;
      }>("SELECT id, venue_order_id, trade_id, raw_json FROM fills ORDER BY id");
      expect(fills.rows).toHaveLength(2);
      expect(fills.rows.map((row) => row.venue_order_id).sort()).toEqual(["venue-order-1", "venue-order-2"]);
      expect(fills.rows.every((row) => row.trade_id === "maker-trade-1")).toBe(true);
      expect(fills.rows.find((row) => row.id === original.id)?.raw_json).toEqual({ source: "fixture" });
    });
  }, 30_000);
});

function buildOrder(overrides: Partial<LiveOrder> = {}): LiveOrder {
  return {
    id: "order-1",
    asset: "btc",
    shadow: false,
    intentId: "intent-1",
    venue: "polymarket",
    venueOrderId: "venue-order-1",
    clientOrderId: "client-order-1",
    marketRef: "market-1",
    tokenId: "token-1",
    side: "BUY",
    outcome: "UP",
    orderType: "FOK",
    requestedPrice: 0.5,
    requestedSize: 10,
    filledSize: 0,
    averageFillPrice: null,
    feeUsd: null,
    status: "pending",
    createdAt: 100,
    updatedAt: 200,
    raw: { observation: "initial" },
    ...overrides,
  };
}

function buildAttempt(overrides: Partial<OrderAttempt> = {}): OrderAttempt {
  return {
    id: "attempt-1",
    asset: "btc",
    shadow: false,
    intentId: "intent-1",
    legId: "leg-1",
    stage: "primary",
    venue: "polymarket",
    side: "BUY",
    orderType: "FOK",
    clientOrderId: "client-order-1",
    venueOrderId: "venue-order-1",
    status: "planned",
    truthStatus: null,
    request: { size: 10 },
    result: null,
    error: null,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function buildFill(overrides: Partial<LiveFill> = {}): LiveFill {
  return {
    id: "fill-1",
    asset: "btc",
    shadow: false,
    intentId: "intent-1",
    venue: "polymarket",
    venueOrderId: "venue-order-1",
    tradeId: "maker-trade-1",
    marketRef: "market-1",
    tokenId: "token-1",
    side: "BUY",
    outcome: "UP",
    price: 0.45,
    size: 5,
    feeUsd: 0.02,
    liquidity: "MAKER",
    filledAt: 200,
    raw: { source: "fixture" },
    ...overrides,
  };
}

async function insertIntent(pool: Pool, intentId = "intent-1") {
  await pool.query(
    `
      INSERT INTO order_intents (
        id, asset, shadow, slot_key, slot_start_ts, slot_end_ts, combination, status,
        created_at, updated_at, resolved_at, primary_venue, hedge_venue, gross_cost,
        target_notional_usd, max_slippage_bps, legs_json
      )
      VALUES (
        $1, 'btc', false, 'btc:slot', 100, 1000, 'POLY_UP_KALSHI_NO', 'pending',
        100, 100, NULL, 'polymarket', 'kalshi', 0.9, 10, 30, '[]'::jsonb
      )
    `,
    [intentId],
  );
}

async function insertRawFill(pool: Pool, fill: LiveFill) {
  await pool.query(
    `
      INSERT INTO fills (
        id, asset, shadow, intent_id, venue, venue_order_id, trade_id, market_ref, token_id,
        side, outcome, price, size, fee_usd, liquidity, filled_at, raw_json
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17::jsonb
      )
    `,
    [
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
    ],
  );
}

async function withIsolatedSchema(run: (pool: Pool) => Promise<void>) {
  if (!TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  const schema = `warbitrer_order_truth_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    max: 3,
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
