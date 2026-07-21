import { DEFAULT_STRATEGY_CONFIG } from "@/lib/constants";
import {
  buildCompletedShadowAudit,
  buildScheduledShadowAudit,
  deriveShadowPairExecution,
  getShadowReentryCooldownRemainingMs,
  SHADOW_EXECUTION_MODEL_VERSION,
  SHADOW_MIN_COMPLETION_DELAY_MS,
  SHADOW_REENTRY_COOLDOWN_MS,
} from "@/lib/shadow-execution";
import type { OpportunitySnapshot, OrderIntent } from "@/lib/types";

describe("REST shadow execution", () => {
  it("records the immediate REST start without an artificial delay", () => {
    const intent = buildIntent();
    const restStartedAt = intent.createdAt + 7;
    const audit = buildScheduledShadowAudit(intent, restStartedAt);

    expect(audit).toMatchObject({
      modelVersion: SHADOW_EXECUTION_MODEL_VERSION,
      status: "scheduled",
      scheduledAt: intent.createdAt,
      completionNotBeforeAt: intent.createdAt + SHADOW_MIN_COMPLETION_DELAY_MS,
      restStartedAt,
      restCapturedAt: null,
      restFetchDurationMs: null,
      requestedPairSize: 10,
      filledPairSize: 0,
    });
  });

  it("fills from delayed multi-level depth and records actual fees and VWAP", () => {
    const intent = buildIntent();
    const decision = deriveShadowPairExecution({
      intent,
      snapshot: buildSnapshot({ polyAsks: [[0.4, 20]], kalshiYesBids: [[0.52, 20]] }),
      settings: { ...DEFAULT_STRATEGY_CONFIG },
    });

    expect(decision.status).toBe("filled");
    expect(decision.filledPairSize).toBe(10);
    expect(decision.realizedGrossCost).toBe(0.88);
    expect(decision.realizedTotalCostUsd).toBeGreaterThan(8.8);
    expect(decision.projectedNetProfitUsd).toBeGreaterThan(0.25);
    expect(decision.legs.every((leg) => leg.quote?.consumedLevels.length === 1)).toBe(true);

    const audit = buildCompletedShadowAudit(intent, decision, intent.createdAt + 15_250, {
      startedAt: intent.createdAt + 10,
      capturedAt: intent.createdAt + 1_200,
    });
    expect(audit).toMatchObject({
      status: "filled",
      latencyMs: 15_250,
      restFetchDurationMs: 1_190,
      completionNotBeforeAt: intent.createdAt + SHADOW_MIN_COMPLETION_DELAY_MS,
      requestedPairSize: 10,
      filledPairSize: 10,
      fillRatio: 1,
      realizedGrossCost: 0.88,
    });
  });

  it("enforces a sixty second cooldown after the previous shadow attempt completes", () => {
    const intent = {
      ...buildIntent(),
      updatedAt: 70_000,
      shadowExecution: null,
    };

    expect(getShadowReentryCooldownRemainingMs(intent, 90_000)).toBe(SHADOW_REENTRY_COOLDOWN_MS - 20_000);
    expect(getShadowReentryCooldownRemainingMs(intent, 130_000)).toBe(0);
    expect(getShadowReentryCooldownRemainingMs(null, 90_000)).toBe(0);
  });

  it("reduces the paired fill to common executable depth", () => {
    const decision = deriveShadowPairExecution({
      intent: buildIntent(),
      snapshot: buildSnapshot({ polyAsks: [[0.4, 10]], kalshiYesBids: [[0.52, 20]] }),
      settings: { ...DEFAULT_STRATEGY_CONFIG },
    });

    expect(decision.status).toBe("filled");
    expect(decision.filledPairSize).toBe(7);
    expect(decision.legs[0].executableSize).toBe(7);
    expect(decision.legs[1].executableSize).toBe(10);
  });

  it("records no fill when the delayed book moved beyond the original slippage limit", () => {
    const decision = deriveShadowPairExecution({
      intent: buildIntent(),
      snapshot: buildSnapshot({ polyAsks: [[0.41, 50]], kalshiYesBids: [[0.52, 50]] }),
      settings: { ...DEFAULT_STRATEGY_CONFIG },
    });

    expect(decision).toMatchObject({
      status: "no_fill",
      reasonCode: "price_moved_beyond_limit",
      filledPairSize: 0,
    });
  });

  it("does not fill from a delayed but degraded venue feed", () => {
    const snapshot = buildSnapshot({ polyAsks: [[0.4, 50]], kalshiYesBids: [[0.52, 50]] });
    snapshot.kalshi.feedHealth.feedStatus = "degraded";
    const decision = deriveShadowPairExecution({
      intent: buildIntent(),
      snapshot,
      settings: { ...DEFAULT_STRATEGY_CONFIG },
    });

    expect(decision).toMatchObject({
      status: "no_fill",
      reasonCode: "market_data_not_ready",
      filledPairSize: 0,
    });
  });

  it("rejects a delayed pair whose executable prices no longer meet strategy economics", () => {
    const intent = buildIntent({ polyPrice: 0.48, kalshiPrice: 0.48, grossCost: 0.96 });
    const decision = deriveShadowPairExecution({
      intent,
      snapshot: buildSnapshot({ polyAsks: [[0.48, 50]], kalshiYesBids: [[0.52, 50]] }),
      settings: { ...DEFAULT_STRATEGY_CONFIG },
    });

    expect(decision).toMatchObject({
      status: "no_fill",
      reasonCode: "economics_no_longer_eligible",
      filledPairSize: 0,
    });
  });
});

function buildIntent(
  overrides: {
    polyPrice?: number;
    kalshiPrice?: number;
    grossCost?: number;
  } = {},
): OrderIntent {
  const polyPrice = overrides.polyPrice ?? 0.4;
  const kalshiPrice = overrides.kalshiPrice ?? 0.48;
  return {
    id: "shadow-intent",
    revision: 0,
    asset: "btc",
    shadow: true,
    slotKey: "btc:slot-1",
    slotStartTs: 1_000,
    slotEndTs: 901_000,
    combination: "POLY_UP_KALSHI_NO",
    status: "pending",
    createdAt: 10_000,
    updatedAt: 10_000,
    resolvedAt: null,
    primaryVenue: "kalshi",
    hedgeVenue: "polymarket",
    grossCost: overrides.grossCost ?? polyPrice + kalshiPrice,
    targetNotionalUsd: 10 * (polyPrice + kalshiPrice),
    maxSlippageBps: 30,
    failureReason: null,
    projectedNetProfitUsd: 1,
    realizedPnlUsd: null,
    roi: null,
    polyResolution: null,
    kalshiResolution: null,
    legs: [
      {
        id: "poly-leg",
        intentId: "shadow-intent",
        venue: "polymarket",
        outcome: "UP",
        marketRef: "poly-market",
        tokenId: "poly-token",
        side: "BUY",
        requestedPrice: polyPrice,
        requestedSize: 10,
        requestedNotionalUsd: 10 * polyPrice,
        filledPrice: null,
        filledSize: 0,
        feeUsd: 0,
        status: "pending",
        venueOrderId: null,
        payoutUsd: null,
        resolvedOutcome: null,
      },
      {
        id: "kalshi-leg",
        intentId: "shadow-intent",
        venue: "kalshi",
        outcome: "NO",
        marketRef: "kalshi-market",
        side: "BUY",
        requestedPrice: kalshiPrice,
        requestedSize: 10,
        requestedNotionalUsd: 10 * kalshiPrice,
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

function buildSnapshot(input: {
  polyAsks: Array<[number, number]>;
  kalshiYesBids: Array<[number, number]>;
}): OpportunitySnapshot {
  return {
    asset: "btc",
    slotKey: "btc:slot-1",
    slotStartTs: 1_000,
    slotEndTs: 901_000,
    capturedAt: 25_000,
    polymarket: {
      slotAligned: true,
      feedHealth: { feedStatus: "ready" },
      feeRateBps: 0,
      feeRate: 0,
      feeExponent: 0,
      outcomes: {
        up: { minOrderSize: 5 },
        down: { minOrderSize: 5 },
      },
      orderbookLevels: {
        upBids: [],
        upAsks: input.polyAsks,
        downBids: [],
        downAsks: [],
      },
    },
    kalshi: {
      slotAligned: true,
      feedHealth: { feedStatus: "ready" },
      feeMultiplier: 1,
      priceLevelStructure: "linear_cent",
      priceRanges: [{ start: "0.0000", end: "1.0000", step: "0.0100" }],
      outcomes: {
        yes: { minOrderSize: 1 },
        no: { minOrderSize: 1 },
      },
      orderbookLevels: {
        yesBids: input.kalshiYesBids,
        noBids: [],
      },
    },
    opportunities: [],
  } as unknown as OpportunitySnapshot;
}
