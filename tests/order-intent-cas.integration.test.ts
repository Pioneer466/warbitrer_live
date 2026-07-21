import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import {
  closeIntentWithoutExposureAtomically,
  findOrderIntent,
  insertOrderIntent,
  migratePostgresDatabase,
  OrderIntentRevisionConflictError,
  PersistenceIdentityConflictError,
  tryWithGlobalLiveExecutionLock,
  tryWithShadowExecutionLock,
  updateOrderIntent,
} from "@/lib/postgres-db";
import type { OrderIntent } from "@/lib/types";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

describePostgres("Postgres order-intent CAS", () => {
  it("serializes writers, preserves identity, and rejects unproved late recovery", async () => {
    await withIsolatedSchema(async (pool) => {
      await migratePostgresDatabase(pool);
      const inserted = await insertOrderIntent(pool, buildIntent());
      expect(inserted.revision).toBe(0);

      const concurrent = await Promise.allSettled([
        updateOrderIntent(pool, {
          ...inserted,
          status: "executing_primary",
          updatedAt: 200,
        }),
        updateOrderIntent(pool, {
          ...inserted,
          status: "manual_required",
          updatedAt: 201,
          failureReason: "concurrent test writer",
        }),
      ]);
      const winners = concurrent.filter(
        (result): result is PromiseFulfilledResult<OrderIntent> => result.status === "fulfilled",
      );
      const losers = concurrent.filter((result): result is PromiseRejectedResult => result.status === "rejected");

      expect(winners).toHaveLength(1);
      expect(winners[0]?.value.revision).toBe(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]?.reason).toBeInstanceOf(OrderIntentRevisionConflictError);
      expect(losers[0]?.reason).toMatchObject({ expectedRevision: 0, actualRevision: 1 });

      const terminalIntent: OrderIntent = {
        ...winners[0]!.value,
        status: "failed",
        updatedAt: 300,
        resolvedAt: 300,
        failureReason: "primary truth timed out",
      };
      await expect(updateOrderIntent(pool, terminalIntent)).rejects.toThrow(/requires accounting head no_exposure/);
      await closeIntentWithoutExposureAtomically(pool, {
        context: { actor: "order-intent-cas-test", requestId: randomUUID(), occurredAt: 300 },
        expectedHeadRevision: 0,
        expectedIntentRevision: winners[0]!.value.revision,
        terminalIntent,
        proof: { venueOrders: "none", attempts: "none", positions: "none" },
      });
      const failed = await findOrderIntent(pool, terminalIntent.id);
      if (!failed) {
        throw new Error("Accounting close did not persist its terminal intent");
      }
      const unprovedLateFill = {
        ...failed,
        updatedAt: 400,
        failureReason: "late primary fill detected without accounting evidence",
        legs: failed.legs.map((leg) =>
          leg.venue === failed.primaryVenue
            ? {
                ...leg,
                requestedPrice: 0.46,
                filledPrice: 0.46,
                filledSize: 5,
                status: "filled" as const,
              }
            : leg,
        ) as OrderIntent["legs"],
      };
      await expect(updateOrderIntent(pool, { ...unprovedLateFill, status: "primary_filled" })).rejects.toThrow(
        /no-exposure accounting head .* requires failed, skipped, or canceled parent intent/,
      );
      await expect(updateOrderIntent(pool, unprovedLateFill)).rejects.toThrow(
        /no-exposure accounting head .* contradicts its exact parent projection/,
      );

      const adjustedAfterPreflight = await updateOrderIntent(pool, {
        ...failed,
        maxSlippageBps: 45,
        updatedAt: 450,
      });
      expect(adjustedAfterPreflight).toMatchObject({ status: "failed", maxSlippageBps: 45, revision: 3 });

      await expect(updateOrderIntent(pool, { ...adjustedAfterPreflight, asset: "eth" })).rejects.toBeInstanceOf(
        PersistenceIdentityConflictError,
      );
      await expect(
        updateOrderIntent(pool, {
          ...adjustedAfterPreflight,
          legs: adjustedAfterPreflight.legs.map((leg, index) =>
            index === 0 ? { ...leg, marketRef: "different-market" } : leg,
          ) as OrderIntent["legs"],
        }),
      ).rejects.toBeInstanceOf(PersistenceIdentityConflictError);
      await expect(
        updateOrderIntent(pool, {
          ...adjustedAfterPreflight,
          primaryVenue: "polymarket",
          hedgeVenue: "polymarket",
        }),
      ).rejects.toBeInstanceOf(PersistenceIdentityConflictError);
      const malformed = withIntentId(buildIntent(), "intent-invalid-venues");
      malformed.legs = malformed.legs.map((leg) => ({ ...leg, venue: "polymarket" as const })) as OrderIntent["legs"];
      await expect(insertOrderIntent(pool, malformed)).rejects.toBeInstanceOf(PersistenceIdentityConflictError);
      await expect(insertOrderIntent(pool, buildIntent())).rejects.toMatchObject({ code: "23505" });

      const stored = await pool.query<{
        asset: string;
        status: string;
        revision: number;
        legs_json: OrderIntent["legs"];
        max_slippage_bps: number;
      }>("SELECT asset, status, revision, legs_json, max_slippage_bps FROM order_intents WHERE id = $1", [
        adjustedAfterPreflight.id,
      ]);
      expect(stored.rows[0]).toMatchObject({
        asset: "btc",
        status: "failed",
        revision: 3,
        max_slippage_bps: 45,
      });
      expect(stored.rows[0]?.legs_json[0]?.marketRef).not.toBe("different-market");
    });
  }, 30_000);

  it("isolates shadow locks by asset and slot without blocking the global live lock", async () => {
    if (!TEST_DATABASE_URL) {
      throw new Error("TEST_DATABASE_URL is required");
    }
    const poolA = new Pool({ connectionString: TEST_DATABASE_URL, max: 3 });
    const poolB = new Pool({ connectionString: TEST_DATABASE_URL, max: 3 });
    const uniqueSlot = `lock-${randomUUID()}`;
    let releaseShadow!: () => void;
    let shadowAcquired!: () => void;
    const shadowAcquiredPromise = new Promise<void>((resolve) => {
      shadowAcquired = resolve;
    });
    const shadowReleasePromise = new Promise<void>((resolve) => {
      releaseShadow = resolve;
    });

    const heldShadow = tryWithShadowExecutionLock(poolA, "btc", uniqueSlot, "holder", async () => {
      shadowAcquired();
      await shadowReleasePromise;
      return "released";
    });
    await shadowAcquiredPromise;

    try {
      await expect(
        tryWithShadowExecutionLock(poolB, "btc", uniqueSlot, "contender", async () => "unexpected"),
      ).resolves.toEqual({ acquired: false, value: null });
      await expect(
        tryWithShadowExecutionLock(poolB, "btc", `${uniqueSlot}:other`, "other-slot", async () => "other-slot"),
      ).resolves.toEqual({ acquired: true, value: "other-slot" });
      await expect(
        tryWithShadowExecutionLock(poolB, "eth", uniqueSlot, "other-asset", async () => "other-asset"),
      ).resolves.toEqual({ acquired: true, value: "other-asset" });
      await expect(tryWithGlobalLiveExecutionLock(poolB, "live-while-shadow", async () => "live")).resolves.toEqual({
        acquired: true,
        value: "live",
      });
    } finally {
      releaseShadow();
      await heldShadow;
      await Promise.all([poolA.end(), poolB.end()]);
    }
  }, 30_000);
});

function withIntentId(intent: OrderIntent, id: string): OrderIntent {
  return {
    ...intent,
    id,
    legs: intent.legs.map((leg) => ({ ...leg, intentId: id })) as OrderIntent["legs"],
  };
}

function buildIntent(): OrderIntent {
  const intentId = "intent-cas";
  return {
    id: intentId,
    revision: 0,
    asset: "btc",
    shadow: false,
    slotKey: "btc:cas-slot",
    slotStartTs: 100,
    slotEndTs: 1_000,
    combination: "POLY_UP_KALSHI_NO",
    status: "pending",
    createdAt: 100,
    updatedAt: 100,
    resolvedAt: null,
    primaryVenue: "polymarket",
    hedgeVenue: "kalshi",
    grossCost: 0.9,
    targetNotionalUsd: 9,
    entrySizingReason: null,
    maxSlippageBps: 30,
    failureReason: null,
    projectedNetProfitUsd: 1,
    mismatchPFatal: null,
    mismatchPFatalUpper: null,
    mismatchModelVersion: null,
    fatalMismatchPnlUsd: null,
    conservativeExpectedPnlUsd: null,
    fatalLossExposureUsd: null,
    mismatchRiskAudit: null,
    shadowExecution: null,
    realizedPnlUsd: null,
    roi: null,
    polyResolution: null,
    kalshiResolution: null,
    legs: [
      {
        id: "leg-poly",
        intentId,
        venue: "polymarket",
        outcome: "UP",
        marketRef: "poly-market",
        tokenId: "poly-token",
        side: "BUY",
        requestedPrice: 0.45,
        requestedSize: 10,
        requestedNotionalUsd: 4.5,
        filledPrice: null,
        filledSize: 0,
        feeUsd: 0,
        status: "pending",
        venueOrderId: null,
        payoutUsd: null,
        resolvedOutcome: null,
      },
      {
        id: "leg-kalshi",
        intentId,
        venue: "kalshi",
        outcome: "NO",
        marketRef: "kalshi-market",
        side: "BUY",
        requestedPrice: 0.45,
        requestedSize: 10,
        requestedNotionalUsd: 4.5,
        filledPrice: null,
        filledSize: 0,
        feeUsd: 0,
        status: "pending",
        venueOrderId: null,
        payoutUsd: null,
        resolvedOutcome: null,
      },
    ],
  };
}

async function withIsolatedSchema(run: (pool: Pool) => Promise<void>) {
  if (!TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  const schema = `warbitrer_intent_cas_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
