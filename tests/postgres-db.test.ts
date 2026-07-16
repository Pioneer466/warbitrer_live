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
  findOrderAttemptById,
  getGlobalRiskConfig,
  insertOracleSlotSample,
  listPendingSlotResolutions,
  listRecentOrderIntents,
  runDatabaseMaintenance,
  updateGlobalRiskConfig,
  upsertOrderIntent,
  upsertSlotResolution,
} from "@/lib/postgres-db";
import { DEFAULT_GLOBAL_RISK_CONFIG } from "@/lib/risk-settings";
import { normalizeSettings } from "@/lib/settings-schema";
import type { OrderIntent } from "@/lib/types";

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

describe("postgres mismatch-risk persistence", () => {
  it("normalizes partial global risk payloads read from Postgres", async () => {
    const { pool } = createMockPool([{ payload: { oracleMaxAgeMs: 4_000 } }]);

    await expect(getGlobalRiskConfig(pool)).resolves.toEqual({
      ...DEFAULT_GLOBAL_RISK_CONFIG,
      oracleMaxAgeMs: 4_000,
    });
  });

  it("validates and stores a normalized global risk payload", async () => {
    const { pool, query } = createMockPool();
    const payload = {
      ...DEFAULT_GLOBAL_RISK_CONFIG,
      clusterExpectedFatalLossCapUsd: 30,
      clusterAbsoluteFatalLossCapUsd: 90,
    };

    await expect(updateGlobalRiskConfig(pool, payload)).resolves.toEqual(payload);

    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toHaveLength(2);
    expect(JSON.parse(params[0] as string)).toEqual(payload);
    expect(params[1]).toEqual(expect.any(Number));
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

  it("binds and maps all mismatch fields on order intents", async () => {
    const { pool, query } = createMockPool();
    const intent = buildOrderIntent();

    await upsertOrderIntent(pool, intent);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("$30");
    expect(sql).toContain("gross_cost = EXCLUDED.gross_cost");
    expect(sql).toContain("target_notional_usd = EXCLUDED.target_notional_usd");
    expect(sql).toContain("max_slippage_bps = EXCLUDED.max_slippage_bps");
    expect(params).toHaveLength(30);
    expect(params.slice(24)).toEqual([0.02, 0.04, "mismatch-v1", -9, 1.5, 12]);

    query.mockResolvedValueOnce({
      rows: [
        {
          id: intent.id,
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
          entry_sizing_reason: intent.entrySizingReason,
          max_slippage_bps: intent.maxSlippageBps,
          failure_reason: intent.failureReason,
          projected_net_profit_usd: intent.projectedNetProfitUsd,
          mismatch_p_fatal: intent.mismatchPFatal,
          mismatch_p_fatal_upper: intent.mismatchPFatalUpper,
          mismatch_model_version: intent.mismatchModelVersion,
          fatal_mismatch_pnl_usd: intent.fatalMismatchPnlUsd,
          conservative_expected_pnl_usd: intent.conservativeExpectedPnlUsd,
          fatal_loss_exposure_usd: intent.fatalLossExposureUsd,
          realized_pnl_usd: intent.realizedPnlUsd,
          roi: intent.roi,
          poly_resolution: intent.polyResolution,
          kalshi_resolution: intent.kalshiResolution,
          legs_json: intent.legs,
        },
      ],
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

  it("applies the oracle and resolution retention windows during maintenance", async () => {
    const { pool, query } = createMockPool();
    query.mockResolvedValue({ rows: [], rowCount: 1 });
    const now = 20_000_000_000;

    const summary = await runDatabaseMaintenance(pool, DEFAULT_DATABASE_MAINTENANCE_CONFIG, now);

    expect(summary.deleted.oracleSamples).toBe(1);
    expect(summary.deleted.slotResolutions).toBe(1);
    const oracleDelete = query.mock.calls.find(([sql]) =>
      String(sql).includes("DELETE FROM oracle_slot_samples"),
    );
    const resolutionDelete = query.mock.calls.find(([sql]) =>
      String(sql).includes("DELETE FROM slot_resolutions"),
    );
    expect(oracleDelete?.[1]).toEqual([now - ORACLE_SAMPLE_RETENTION_MS]);
    expect(resolutionDelete?.[1]).toEqual([now - SLOT_RESOLUTION_RETENTION_MS]);
  });
});

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
