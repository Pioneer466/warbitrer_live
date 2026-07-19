import type { Pool } from "pg";

import { DEFAULT_DATABASE_MAINTENANCE_CONFIG } from "@/lib/db-maintenance";
import {
  ORACLE_SAMPLE_RETENTION_MS,
  SLOT_RESOLUTION_RETENTION_MS,
  type OracleSlotSample,
  type SlotResolutionRecord,
} from "@/lib/oracle-history";
import {
  buildBootstrapStrategyConfigs,
  areFillsEconomicallyIdentical,
  assertOrderIntentIdentity,
  findOrderAttemptById,
  getGlobalRiskConfig,
  insertOrderIntent,
  insertOracleSlotSample,
  listOrderAttemptsForIntent,
  listPendingSlotResolutions,
  listRecentOrderIntents,
  mergeOrderAttemptEvidence,
  mergeVenueOrderEvidence,
  OrderIntentRevisionConflictError,
  PersistenceIdentityConflictError,
  runDatabaseMaintenance,
  updateGlobalRiskConfig,
  updateOrderIntent,
  upsertSlotResolution,
} from "@/lib/postgres-db";
import { DEFAULT_GLOBAL_RISK_CONFIG } from "@/lib/risk-settings";
import { normalizeSettings } from "@/lib/settings-schema";
import type { LiveFill, LiveOrder, OrderAttempt, OrderIntent } from "@/lib/types";

function createMockPool(rows: unknown[] = []) {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
  return {
    pool: { query } as unknown as Pool,
    query,
  };
}

describe("postgres bootstrap strategy configs", () => {
  it("clones ETH strategy parameters into shadow assets while forcing shadow mode", () => {
    const legacy = normalizeSettings({
      enableTrading: false,
      shadowMode: true,
      maxPairNotionalUsd: 50,
      maxSignalAgeMs: 1000,
      grossEntryThreshold: 0.93,
      maxLegPrice: 0.49,
      reentryImprovement: 0.01,
      pollingIntervalMs: 1000,
      minOrderSize: 5,
      maxSlippageBps: 30,
      immediateOrderConfirmationTimeoutMs: 8000,
      executionPriceBuffer: 0.01,
      hedgeRetryAttempts: 3,
      hedgeRetryDelayMs: 350,
      entryCutoffSeconds: 180,
      maxOpenIntentsPerSlot: 1,
      maxVenueExposureUsd: 1000,
      polyBridgeLowWaterUsdc: 250,
    });

    const configs = buildBootstrapStrategyConfigs(legacy, {
      enableTrading: false,
      shadowMode: false,
      maxPairNotionalUsd: 275,
      maxSignalAgeMs: 750,
      grossEntryThreshold: 0.88,
      maxLegPrice: 0.44,
      reentryImprovement: 0.02,
      pollingIntervalMs: 750,
      minOrderSize: 12,
      maxSlippageBps: 45,
      immediateOrderConfirmationTimeoutMs: 12000,
      executionPriceBuffer: 0.03,
      hedgeRetryAttempts: 4,
      hedgeRetryDelayMs: 600,
      entryCutoffSeconds: 120,
      maxOpenIntentsPerSlot: 2,
      maxVenueExposureUsd: 2500,
      polyBridgeLowWaterUsdc: 600,
    });

    expect(configs.eth.maxPairNotionalUsd).toBe(275);
    expect(configs.sol.maxPairNotionalUsd).toBe(275);
    expect(configs.xrp.maxPairNotionalUsd).toBe(275);
    expect(configs.doge.maxPairNotionalUsd).toBe(275);
    expect(configs.bnb.maxPairNotionalUsd).toBe(275);
    expect(configs.hype.maxPairNotionalUsd).toBe(275);
    expect(configs.eth.maxSignalAgeMs).toBe(750);
    expect(configs.sol.maxSignalAgeMs).toBe(750);
    expect(configs.sol.enableTrading).toBe(true);
    expect(configs.sol.shadowMode).toBe(true);
    expect(configs.xrp.enableTrading).toBe(true);
    expect(configs.xrp.shadowMode).toBe(true);
    expect(configs.doge.enableTrading).toBe(true);
    expect(configs.doge.shadowMode).toBe(true);
    expect(configs.bnb.enableTrading).toBe(true);
    expect(configs.bnb.shadowMode).toBe(true);
    expect(configs.hype.enableTrading).toBe(true);
    expect(configs.hype.shadowMode).toBe(true);
    expect(configs.btc.primarySelectionMode).toBe("shadow");
    expect(configs.btc.dailyLossCapEnabled).toBe(true);
    expect(configs.btc.dailyLossHardCapUsd).toBe(20);
    expect(configs.btc.minimumEntryDepthCoverageRatio).toBe(0.5);
  });
});

describe("postgres order-truth evidence merging", () => {
  it("keeps increasing fill evidence when an older writer arrives later", () => {
    const initial = buildLiveOrder({
      filledSize: 2,
      averageFillPrice: 0.44,
      feeUsd: 0.02,
      status: "partially_filled",
      updatedAt: 200,
      raw: { observation: "initial" },
    });
    const progressed = mergeVenueOrderEvidence(
      initial,
      buildLiveOrder({
        filledSize: 5,
        averageFillPrice: 0.46,
        feeUsd: 0.05,
        status: "partially_filled",
        updatedAt: 300,
        raw: { observation: "progressed" },
      }),
    );
    const afterStaleWriter = mergeVenueOrderEvidence(
      progressed,
      buildLiveOrder({
        filledSize: 1,
        averageFillPrice: 0.41,
        feeUsd: 0.01,
        status: "live",
        updatedAt: 100,
        raw: { observation: "stale" },
      }),
    );

    expect(afterStaleWriter).toMatchObject({
      filledSize: 5,
      averageFillPrice: 0.46,
      feeUsd: 0.05,
      status: "partially_filled",
      updatedAt: 300,
      raw: { observation: "progressed" },
    });
  });

  it("never reopens a terminal venue order", () => {
    const terminal = buildLiveOrder({ status: "canceled", updatedAt: 200, raw: { terminal: true } });
    const reopened = mergeVenueOrderEvidence(
      terminal,
      buildLiveOrder({ status: "live", updatedAt: 300, raw: { terminal: false } }),
    );

    expect(reopened.status).toBe("canceled");
    expect(reopened.raw).toEqual({ terminal: true });
  });

  it("does not oscillate terminal no-fill statuses and validates immutable order identity", () => {
    const canceled = buildLiveOrder({ status: "canceled", updatedAt: 200, raw: { status: "canceled" } });
    const merged = mergeVenueOrderEvidence(
      canceled,
      buildLiveOrder({ status: "rejected", updatedAt: 300, raw: { status: "rejected" } }),
    );

    expect(merged.status).toBe("canceled");
    expect(merged.raw).toEqual({ status: "canceled" });
    expect(() => mergeVenueOrderEvidence(canceled, buildLiveOrder({ venueOrderId: "different-order" }))).toThrow(
      PersistenceIdentityConflictError,
    );
  });

  it("does not replace a confirmed attempt with a stale failure", () => {
    const confirmed = buildOrderAttempt({
      status: "confirmed",
      truthStatus: "filled",
      result: { filledSize: 5 },
      updatedAt: 300,
    });
    const merged = mergeOrderAttemptEvidence(
      confirmed,
      buildOrderAttempt({
        status: "failed",
        truthStatus: "not_submitted",
        result: null,
        error: "stale failure",
        updatedAt: 100,
      }),
    );

    expect(merged).toMatchObject({
      status: "confirmed",
      truthStatus: "filled",
      result: { filledSize: 5 },
      error: null,
      updatedAt: 300,
    });
  });

  it("allows a newer retry to replace failed/not_submitted with truth_pending", () => {
    const failed = buildOrderAttempt({
      status: "failed",
      truthStatus: "not_submitted",
      error: "definitive zero fill",
      updatedAt: 200,
    });
    const retried = mergeOrderAttemptEvidence(
      failed,
      buildOrderAttempt({
        status: "truth_pending",
        truthStatus: "submission_unknown",
        error: "timeout",
        updatedAt: 300,
      }),
    );

    expect(retried).toMatchObject({
      status: "truth_pending",
      truthStatus: "submission_unknown",
      error: "timeout",
      updatedAt: 300,
    });
  });

  it("does not let a stale failure replace truth_pending", () => {
    const truthPending = buildOrderAttempt({
      status: "truth_pending",
      truthStatus: "submission_unknown",
      error: "timeout",
      updatedAt: 300,
    });
    const merged = mergeOrderAttemptEvidence(
      truthPending,
      buildOrderAttempt({
        status: "failed",
        truthStatus: "not_submitted",
        error: "stale failure",
        updatedAt: 200,
      }),
    );

    expect(merged).toMatchObject({
      status: "truth_pending",
      truthStatus: "submission_unknown",
      error: "timeout",
      updatedAt: 300,
    });
  });

  it("rejects an attempt identity change before merging evidence", () => {
    expect(() => mergeOrderAttemptEvidence(buildOrderAttempt(), buildOrderAttempt({ stage: "hedge" }))).toThrow(
      PersistenceIdentityConflictError,
    );
  });

  it("treats raw-only fill differences as idempotent but rejects economic differences", () => {
    const fill = buildLiveFill();

    expect(areFillsEconomicallyIdentical(fill, { ...fill, id: "alternate-id", raw: { replay: true } })).toBe(true);
    expect(areFillsEconomicallyIdentical(fill, { ...fill, feeUsd: fill.feeUsd + 0.01 })).toBe(false);
  });
});

describe("postgres mismatch-risk persistence", () => {
  it("normalizes partial global risk payloads read from Postgres", async () => {
    const { pool } = createMockPool([{ payload: { oracleMaxAgeMs: 4_000 }, revision: 3, updated_at: 123 }]);

    await expect(getGlobalRiskConfig(pool)).resolves.toEqual({
      config: {
        ...DEFAULT_GLOBAL_RISK_CONFIG,
        oracleMaxAgeMs: 4_000,
      },
      revision: 3,
      updatedAt: 123,
    });
  });

  it("validates and stores a normalized global risk payload with CAS and audit context", async () => {
    const payload = {
      ...DEFAULT_GLOBAL_RISK_CONFIG,
      clusterExpectedFatalLossCapUsd: 30,
      clusterAbsoluteFatalLossCapUsd: 90,
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ payload: DEFAULT_GLOBAL_RISK_CONFIG, revision: 0, updated_at: 123 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ payload, revision: 1, updated_at: 456 }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 0 });
    const release = vi.fn();
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as Pool;

    await expect(
      updateGlobalRiskConfig(
        pool,
        { config: payload, expectedRevision: 0 },
        { actor: "unit-test", requestId: "00000000-0000-4000-8000-000000000001" },
      ),
    ).resolves.toEqual({ config: payload, revision: 1, updatedAt: 456 });

    expect(query.mock.calls[1]).toEqual(["SELECT pg_advisory_xact_lock($1, $2)", [4_298, 2]]);
    const [, params] = query.mock.calls[3] as [string, unknown[]];
    expect(params).toHaveLength(3);
    expect(JSON.parse(params[0] as string)).toEqual(payload);
    expect(params[1]).toEqual(expect.any(Number));
    expect(params[2]).toBe(0);
    expect(String(query.mock.calls[4]?.[0])).toContain("INSERT INTO configuration_audit_events");
    const [runEventSql, runEventParams] = query.mock.calls[5] as [string, unknown[]];
    expect(runEventSql).toContain("risk.global_config.updated");
    expect(runEventSql).toContain("payload_json->>'requestId' = $3");
    expect(JSON.parse(runEventParams[0] as string)).toMatchObject({
      requestId: "00000000-0000-4000-8000-000000000001",
      actor: "unit-test",
      previousRevision: 0,
      nextRevision: 1,
      previous: DEFAULT_GLOBAL_RISK_CONFIG,
      updated: payload,
    });
    expect(runEventParams[2]).toBe("00000000-0000-4000-8000-000000000001");
    expect(release).toHaveBeenCalledOnce();
  });

  it("binds every oracle sample column in the expected order", async () => {
    const { pool, query } = createMockPool();
    const sample: OracleSlotSample = {
      asset: "btc",
      slotKey: "btc:123",
      slotStartTs: 123_000,
      slotEndTs: 1_023_000,
      capturedAt: 500_000,
      chainlinkStartPriceUsd: 100_000,
      chainlinkStartCapturedAt: 123_500,
      chainlinkLivePriceUsd: 100_100,
      chainlinkSourceTs: 499_500,
      cfIndexId: "BRTI",
      cfLivePriceUsd: 100_080,
      cfSourceTs: 499_000,
      cfTrailingAverageUsd: 100_050,
      cfTrailingWindowSize: 60,
      cfFinalMinuteAverageUsd: null,
      cfFinalMinuteWindowSize: null,
      kalshiTargetPriceUsd: 100_020,
      modelVersion: "mismatch-v1",
      riskByCombination: {
        POLY_UP_KALSHI_NO: { pFatal: 0.02 },
      },
      economicsByCombination: {
        POLY_UP_KALSHI_NO: { conservativeExpectedPnlUsd: 1.25 },
      },
    };

    await insertOracleSlotSample(pool, sample);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("$20::jsonb");
    expect(params).toHaveLength(20);
    expect(params.slice(0, 5)).toEqual(["btc", "btc:123", 123_000, 1_023_000, 500_000]);
    expect(params[6]).toBe(123_500);
    expect(JSON.parse(params[18] as string)).toEqual(sample.riskByCombination);
    expect(JSON.parse(params[19] as string)).toEqual(sample.economicsByCombination);
  });

  it("keeps official slot resolution truth monotonic during upsert", async () => {
    const { pool, query } = createMockPool();
    const resolution: SlotResolutionRecord = {
      asset: "eth",
      slotKey: "eth:456",
      slotStartTs: 456_000,
      slotEndTs: 1_356_000,
      polymarketSlug: "eth-updown-15m-456",
      polymarketMarketRef: "poly-market",
      kalshiMarketRef: "kalshi-market",
      polymarketResolution: "UP",
      kalshiResolution: "YES",
      polymarketSettlementValueUsd: null,
      kalshiSettlementValueUsd: null,
      firstObservedAt: 456_100,
      updatedAt: 1_400_000,
      resolvedAt: 1_400_000,
      source: "official-venue-resolution",
      raw: { fatalMismatch: false },
    };

    await upsertSlotResolution(pool, resolution);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toHaveLength(16);
    expect(sql).toContain("GREATEST(EXCLUDED.updated_at, slot_resolutions.updated_at)");
    expect(sql).toContain("slot_resolutions.source = 'official-venue-resolution'");
    expect(sql).toContain("polymarket_slug = CASE");
    expect(sql).toContain("slot_resolutions.resolved_at IS NOT NULL");
    expect(sql).toContain("ELSE EXCLUDED.polymarket_slug");
    expect(sql).toContain("THEN EXCLUDED.polymarket_resolution");
    expect(sql).toContain("THEN EXCLUDED.kalshi_resolution");
    expect(JSON.parse(params[15] as string)).toEqual(resolution.raw);
  });

  it("maps pending resolutions and binds the shared retention window", async () => {
    const row = {
      asset: "sol",
      slot_key: "sol:789",
      slot_start_ts: 789_000,
      slot_end_ts: 1_689_000,
      polymarket_slug: "sol-updown-15m-789",
      polymarket_market_ref: "poly-ref",
      kalshi_market_ref: "kalshi-ref",
      polymarket_resolution: "DOWN",
      kalshi_resolution: null,
      polymarket_settlement_value_usd: 140.5,
      kalshi_settlement_value_usd: null,
      first_observed_at: 789_100,
      updated_at: 1_700_000,
      resolved_at: null,
      source: "market-data-observation",
      raw_json: { observed: true },
    };
    const { pool, query } = createMockPool([row]);

    const result = await listPendingSlotResolutions(pool, 2_000_000, 7);

    expect(query.mock.calls[0]?.[1]).toEqual([2_000_000, 7, SLOT_RESOLUTION_RETENTION_MS]);
    expect(query.mock.calls[0]?.[0]).toContain("ORDER BY updated_at ASC, slot_end_ts ASC");
    expect(result).toEqual([
      {
        asset: "sol",
        slotKey: "sol:789",
        slotStartTs: 789_000,
        slotEndTs: 1_689_000,
        polymarketSlug: "sol-updown-15m-789",
        polymarketMarketRef: "poly-ref",
        kalshiMarketRef: "kalshi-ref",
        polymarketResolution: "DOWN",
        kalshiResolution: null,
        polymarketSettlementValueUsd: 140.5,
        kalshiSettlementValueUsd: null,
        firstObservedAt: 789_100,
        updatedAt: 1_700_000,
        resolvedAt: null,
        source: "market-data-observation",
        raw: { observed: true },
      },
    ]);
  });

  it("inserts and maps all order-intent fields at revision zero", async () => {
    const intent = buildOrderIntent();
    const row = buildOrderIntentRow(intent);
    const { pool, query } = createMockPool([row]);

    await expect(insertOrderIntent(pool, intent)).resolves.toEqual(intent);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("$33::jsonb");
    expect(sql).toContain("RETURNING *");
    expect(sql).not.toContain("ON CONFLICT");
    expect(params).toHaveLength(33);
    expect(params.slice(25, 31)).toEqual([0.02, 0.04, "mismatch-v1", -9, 1.5, 12]);
    expect(JSON.parse(params[31] as string)).toEqual(intent.mismatchRiskAudit);
    expect(JSON.parse(params[32] as string)).toEqual(intent.shadowExecution);

    query.mockResolvedValueOnce({
      rows: [row],
      rowCount: 1,
    });

    const [mapped] = await listRecentOrderIntents(pool, 1);
    expect(mapped).toMatchObject({
      mismatchPFatal: 0.02,
      mismatchPFatalUpper: 0.04,
      mismatchModelVersion: "mismatch-v1",
      fatalMismatchPnlUsd: -9,
      conservativeExpectedPnlUsd: 1.5,
      fatalLossExposureUsd: 12,
      mismatchRiskAudit: intent.mismatchRiskAudit,
      shadowExecution: intent.shadowExecution,
      legs: [
        expect.objectContaining({
          worstFillCostUsd: 4.7,
          recoveryReserveUsd: 1.2,
          filledAt: 123_200,
        }),
        expect.objectContaining({
          worstFillCostUsd: 4.7,
          recoveryReserveUsd: 1.2,
          filledAt: 123_200,
        }),
      ],
    });

    query.mockResolvedValueOnce({
      rows: [{ ...row, mismatch_risk_audit_json: null, shadow_execution_json: null }],
      rowCount: 1,
    });

    const [historical] = await listRecentOrderIntents(pool, 1);
    expect(historical.mismatchRiskAudit).toBeNull();
  });

  it("updates an order intent only at the expected revision and returns the canonical row", async () => {
    const intent = buildOrderIntent();
    const existing = { ...intent, revision: 4 };
    const updated = {
      ...existing,
      status: "executing_primary" as const,
      updatedAt: 200,
      maxSlippageBps: 45,
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [buildOrderIntentRow(existing)], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [buildOrderIntentRow({ ...updated, revision: 5 })], rowCount: 1 });
    const pool = { query } as unknown as Pool;

    await expect(updateOrderIntent(pool, updated)).resolves.toMatchObject({
      status: "executing_primary",
      revision: 5,
    });

    const [sql, params] = query.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("WHERE id = $1 AND revision = $2");
    expect(sql).toContain("revision = revision + 1");
    expect(sql).not.toContain("asset =");
    expect(sql).toContain("max_slippage_bps = $8");
    expect(params.slice(0, 4)).toEqual([intent.id, 4, "executing_primary", 200]);
    expect(params[7]).toBe(45);
  });

  it("reports the canonical revision when a CAS update loses a race", async () => {
    const intent = { ...buildOrderIntent(), revision: 4 };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [buildOrderIntentRow(intent)], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ revision: 5 }], rowCount: 1 });
    const pool = { query } as unknown as Pool;

    await expect(updateOrderIntent(pool, intent)).rejects.toMatchObject({
      name: "OrderIntentRevisionConflictError",
      intentId: intent.id,
      expectedRevision: 4,
      actualRevision: 5,
    } satisfies Partial<OrderIntentRevisionConflictError>);
  });

  it("rejects immutable parent and leg identity changes", () => {
    const intent = buildOrderIntent();

    expect(() => assertOrderIntentIdentity(intent, { ...intent, asset: "eth" })).toThrow(
      PersistenceIdentityConflictError,
    );
    expect(() =>
      assertOrderIntentIdentity(intent, {
        ...intent,
        legs: intent.legs.map((leg, index) =>
          index === 0 ? { ...leg, marketRef: "different-market" } : leg,
        ) as OrderIntent["legs"],
      }),
    ).toThrow(PersistenceIdentityConflictError);
    expect(() => assertOrderIntentIdentity(intent, { ...intent, maxSlippageBps: 45 })).not.toThrow();
    expect(() =>
      assertOrderIntentIdentity(intent, {
        ...intent,
        primaryVenue: "polymarket",
        hedgeVenue: "polymarket",
      }),
    ).toThrow(PersistenceIdentityConflictError);
    expect(() =>
      assertOrderIntentIdentity(intent, {
        ...intent,
        legs: intent.legs.map((leg) => ({ ...leg, venue: "polymarket" as const })) as OrderIntent["legs"],
      }),
    ).toThrow(PersistenceIdentityConflictError);
  });

  it("rejects an insert without exactly one leg per execution venue", async () => {
    const intent = buildOrderIntent();
    const { pool, query } = createMockPool();
    const invalid = {
      ...intent,
      legs: intent.legs.map((leg) => ({ ...leg, venue: "polymarket" as const })) as OrderIntent["legs"],
    };

    await expect(insertOrderIntent(pool, invalid)).rejects.toBeInstanceOf(PersistenceIdentityConflictError);
    expect(query).not.toHaveBeenCalled();
  });

  it("looks up and maps a single order attempt directly", async () => {
    const row = {
      id: "attempt-1",
      asset: "btc",
      shadow: false,
      intent_id: "intent-1",
      leg_id: "leg-1",
      stage: "primary",
      venue: "kalshi",
      side: "BUY",
      order_type: "market",
      client_order_id: "client-1",
      venue_order_id: "venue-1",
      status: "confirmed",
      truth_status: "confirmed",
      request_json: { count: 2 },
      result_json: { filled: true },
      error: null,
      created_at: 1_000,
      updated_at: 1_100,
    };
    const { pool, query } = createMockPool([row]);

    await expect(findOrderAttemptById(pool, "attempt-1")).resolves.toMatchObject({
      id: "attempt-1",
      intentId: "intent-1",
      venueOrderId: "venue-1",
      request: { count: 2 },
      result: { filled: true },
    });
    expect(query).toHaveBeenCalledWith("SELECT * FROM order_attempts WHERE id = $1 LIMIT 1", ["attempt-1"]);
  });

  it("loads every attempt for an intent without a recency limit", async () => {
    const row = {
      id: "attempt-1",
      asset: "btc",
      shadow: false,
      intent_id: "intent-1",
      leg_id: "leg-1",
      stage: "primary",
      venue: "polymarket",
      side: "BUY",
      order_type: "FOK",
      client_order_id: "client-1",
      venue_order_id: null,
      status: "truth_pending",
      truth_status: "submission_unknown",
      request_json: {},
      result_json: null,
      error: "connection reset",
      created_at: 1_000,
      updated_at: 1_100,
    };
    const { pool, query } = createMockPool([row]);

    await expect(listOrderAttemptsForIntent(pool, "intent-1")).resolves.toMatchObject([
      {
        id: "attempt-1",
        status: "truth_pending",
        truthStatus: "submission_unknown",
      },
    ]);
    expect(query).toHaveBeenCalledWith(
      "SELECT * FROM order_attempts WHERE intent_id = $1 ORDER BY created_at ASC, id ASC",
      ["intent-1"],
    );
  });

  it("applies the oracle and resolution retention windows during maintenance", async () => {
    const { pool, query } = createMockPool();
    query.mockResolvedValue({ rows: [], rowCount: 1 });
    const now = 20_000_000_000;

    const summary = await runDatabaseMaintenance(pool, DEFAULT_DATABASE_MAINTENANCE_CONFIG, now);

    expect(summary.deleted.oracleSamples).toBe(1);
    expect(summary.deleted.slotResolutions).toBe(1);
    const oracleDelete = query.mock.calls.find(([sql]) => String(sql).includes("DELETE FROM oracle_slot_samples"));
    const resolutionDelete = query.mock.calls.find(([sql]) => String(sql).includes("DELETE FROM slot_resolutions"));
    expect(oracleDelete?.[1]).toEqual([now - ORACLE_SAMPLE_RETENTION_MS]);
    expect(resolutionDelete?.[1]).toEqual([now - SLOT_RESOLUTION_RETENTION_MS]);
  });
});

function buildLiveOrder(overrides: Partial<LiveOrder> = {}): LiveOrder {
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
    updatedAt: 100,
    raw: {},
    ...overrides,
  };
}

function buildOrderAttempt(overrides: Partial<OrderAttempt> = {}): OrderAttempt {
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

function buildLiveFill(overrides: Partial<LiveFill> = {}): LiveFill {
  return {
    id: "fill-1",
    asset: "btc",
    shadow: false,
    intentId: "intent-1",
    venue: "polymarket",
    venueOrderId: "venue-order-1",
    tradeId: "trade-1",
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

function buildOrderIntent(): OrderIntent {
  const baseLeg = {
    intentId: "intent-1",
    side: "BUY" as const,
    requestedPrice: 0.45,
    requestedSize: 10,
    requestedNotionalUsd: 4.5,
    worstFillCostUsd: 4.7,
    recoveryReserveUsd: 1.2,
    filledPrice: null,
    filledSize: 0,
    filledAt: 123_200,
    feeUsd: 0,
    status: "pending" as const,
    venueOrderId: null,
    payoutUsd: null,
    resolvedOutcome: null,
  };

  return {
    id: "intent-1",
    revision: 0,
    asset: "btc",
    shadow: false,
    slotKey: "btc:123",
    slotStartTs: 123_000,
    slotEndTs: 1_023_000,
    combination: "POLY_UP_KALSHI_NO",
    status: "pending",
    createdAt: 123_100,
    updatedAt: 123_100,
    resolvedAt: null,
    primaryVenue: "polymarket",
    hedgeVenue: "kalshi",
    grossCost: 0.9,
    targetNotionalUsd: 10,
    entrySizingReason: "depth-cap",
    maxSlippageBps: 30,
    failureReason: null,
    projectedNetProfitUsd: 1.7,
    mismatchPFatal: 0.02,
    mismatchPFatalUpper: 0.04,
    mismatchModelVersion: "mismatch-v1",
    fatalMismatchPnlUsd: -9,
    conservativeExpectedPnlUsd: 1.5,
    fatalLossExposureUsd: 12,
    mismatchRiskAudit: {
      evaluatedAt: 123_100,
      policyMode: "block_only",
      decision: "would_allow",
      source: "execution",
      baseEligible: true,
      baseReasons: [],
      blockingReasonCodes: [],
      blockingReasons: [],
      diagnosticReasonCodes: [],
      economicsBasis: "executable",
      pairSize: 10,
      totalCostUsd: 9,
      breakEvenFatalProbability: 0.1,
      maximumAllowedFatalProbability: 0.05,
      pFatal: 0.02,
      pFatalUpper95: 0.04,
      conservativePnlUsd: 1.5,
      fatalPnlUsd: -9,
      estimateAvailable: true,
      executionUsable: true,
      executionReason: null,
      modelVersion: "mismatch-v1",
      enforceReady: true,
      enforceReasons: [],
      legacyGuardAction: "allow",
      legacySizeMultiplier: 1,
    },
    shadowExecution: {
      modelVersion: "rest-orderbook-v2",
      status: "scheduled",
      scheduledAt: 123_100,
      completionNotBeforeAt: 138_100,
      restStartedAt: 123_100,
      restCapturedAt: null,
      restFetchDurationMs: null,
      restErrors: [],
      evaluatedAt: null,
      latencyMs: null,
      nextEligibleAt: null,
      requestedPairSize: 10,
      filledPairSize: 0,
      fillRatio: 0,
      signalGrossCost: 0.9,
      realizedGrossCost: null,
      realizedTotalCostUsd: null,
      projectedNetProfitUsd: null,
      reasonCode: null,
      reason: null,
      legs: [],
    },
    realizedPnlUsd: null,
    roi: null,
    polyResolution: null,
    kalshiResolution: null,
    legs: [
      {
        ...baseLeg,
        id: "leg-poly",
        venue: "polymarket",
        outcome: "UP",
        marketRef: "poly-market",
        tokenId: "token-up",
      },
      {
        ...baseLeg,
        id: "leg-kalshi",
        venue: "kalshi",
        outcome: "NO",
        marketRef: "kalshi-market",
      },
    ],
  };
}

function buildOrderIntentRow(intent: OrderIntent) {
  return {
    id: intent.id,
    revision: intent.revision,
    asset: intent.asset,
    shadow: intent.shadow,
    slot_key: intent.slotKey,
    slot_start_ts: intent.slotStartTs,
    slot_end_ts: intent.slotEndTs,
    combination: intent.combination,
    status: intent.status,
    created_at: intent.createdAt,
    updated_at: intent.updatedAt,
    resolved_at: intent.resolvedAt,
    primary_venue: intent.primaryVenue,
    hedge_venue: intent.hedgeVenue,
    gross_cost: intent.grossCost,
    target_notional_usd: intent.targetNotionalUsd,
    entry_sizing_reason: intent.entrySizingReason ?? null,
    max_slippage_bps: intent.maxSlippageBps,
    failure_reason: intent.failureReason,
    projected_net_profit_usd: intent.projectedNetProfitUsd,
    mismatch_p_fatal: intent.mismatchPFatal ?? null,
    mismatch_p_fatal_upper: intent.mismatchPFatalUpper ?? null,
    mismatch_model_version: intent.mismatchModelVersion ?? null,
    fatal_mismatch_pnl_usd: intent.fatalMismatchPnlUsd ?? null,
    conservative_expected_pnl_usd: intent.conservativeExpectedPnlUsd ?? null,
    fatal_loss_exposure_usd: intent.fatalLossExposureUsd ?? null,
    mismatch_risk_audit_json: intent.mismatchRiskAudit ?? null,
    shadow_execution_json: intent.shadowExecution ?? null,
    realized_pnl_usd: intent.realizedPnlUsd,
    roi: intent.roi,
    poly_resolution: intent.polyResolution,
    kalshi_resolution: intent.kalshiResolution,
    legs_json: intent.legs,
  };
}
