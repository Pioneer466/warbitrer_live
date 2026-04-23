import {
  buildVenueOrderRequest,
  countRecentKalshiSoftHedgeNoFillEvents,
  countRecentKalshiSoftPrimaryNoFillEvents,
  deriveLiveRemainingLegSize,
  deriveBufferedRetryLeg,
  deriveRemainingExposureSize,
  derivePrimaryExitSize,
  hasKalshiHedgeRetryCapacity,
  isFeedHealthBreaker,
  isBreakerRelevantToSlot,
  isLatePrimaryFillRescueEligible,
  isPolymarketOrderbookUnavailableError,
  isRetryablePolymarketInventorySyncError,
  resolvePrimaryRetryPlan,
  shouldManageFeedHealthBreaker,
  shouldKeepHedgeFailureBreakerActive,
  summarizeIntentLegFills,
} from "@/lib/engine";
import type { CircuitBreaker, LiveFill, LiveOrder, OrderIntent, RunEvent } from "@/lib/types";

function buildIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  const base: OrderIntent = {
    id: "intent-1",
    asset: "btc",
    shadow: false,
    slotKey: "btc:slot-1",
    slotStartTs: 1,
    slotEndTs: 2,
    combination: "POLY_DOWN_KALSHI_YES",
    status: "failed",
    createdAt: 1,
    updatedAt: 2,
    resolvedAt: null,
    primaryVenue: "polymarket",
    hedgeVenue: "kalshi",
    grossCost: 0.9,
    targetNotionalUsd: 10,
    maxSlippageBps: 30,
    failureReason: "Primary order not observed before timeout or slot end",
    projectedNetProfitUsd: 1,
    realizedPnlUsd: null,
    roi: null,
    polyResolution: null,
    kalshiResolution: null,
    legs: [
      {
        id: "leg-primary",
        intentId: "intent-1",
        venue: "polymarket",
        outcome: "DOWN",
        marketRef: "poly-market",
        tokenId: "token-1",
        side: "BUY",
        requestedPrice: 0.45,
        requestedSize: 10,
        requestedNotionalUsd: 5,
        filledPrice: 0.45,
        filledSize: 10,
        feeUsd: 0.5,
        status: "filled",
        venueOrderId: "poly-order",
        payoutUsd: null,
        resolvedOutcome: null,
      },
      {
        id: "leg-hedge",
        intentId: "intent-1",
        venue: "kalshi",
        outcome: "YES",
        marketRef: "kalshi-market",
        side: "BUY",
        requestedPrice: 0.45,
        requestedSize: 10,
        requestedNotionalUsd: 5,
        filledPrice: null,
        filledSize: 0,
        feeUsd: 0,
        status: "failed",
        venueOrderId: null,
        payoutUsd: null,
        resolvedOutcome: null,
      },
    ],
  };

  return {
    ...base,
    ...overrides,
    asset: overrides.asset ?? base.asset,
  };
}

function buildOrder(overrides: Partial<LiveOrder> = {}): LiveOrder {
  const base: LiveOrder = {
    id: "order-1",
    asset: "btc",
    shadow: false,
    intentId: "intent-1",
    venue: "polymarket",
    venueOrderId: "sell-1",
    clientOrderId: "client-1",
    marketRef: "poly-market",
    tokenId: "token-1",
    side: "SELL",
    outcome: "DOWN",
    orderType: "FAK",
    requestedPrice: 0.44,
    requestedSize: 10,
    filledSize: 0,
    averageFillPrice: null,
    feeUsd: 0,
    status: "canceled",
    createdAt: 1,
    updatedAt: 2,
    raw: {},
  };

  return {
    ...base,
    ...overrides,
    asset: overrides.asset ?? base.asset,
  };
}

describe("late primary fill rescue eligibility", () => {
  it("allows rescue for primary-timeout failures without unwind activity", () => {
    expect(isLatePrimaryFillRescueEligible(buildIntent(), [])).toBe(true);
  });

  it("blocks rescue once hedge failure or unwind flow already started", () => {
    expect(
      isLatePrimaryFillRescueEligible(
        buildIntent({
          failureReason: "Hedge order failed",
        }),
        [],
      ),
    ).toBe(false);

    expect(
      isLatePrimaryFillRescueEligible(
        buildIntent({
          failureReason: "Primary unwind submission failed (boom); manual intervention required",
        }),
        [buildOrder()],
      ),
    ).toBe(false);
  });
});

describe("primary exit sizing", () => {
  it("caps the unwind size to the smallest observable polymarket inventory", () => {
    expect(
      derivePrimaryExitSize({
        filledSize: 20.04,
        positionSize: 20.04,
        sellableSize: 19.264187,
      }),
    ).toBe(19.264187);
  });

  it("falls back to the confirmed fill size when no fresher inventory snapshot exists", () => {
    expect(
      derivePrimaryExitSize({
        filledSize: 20.04,
        positionSize: null,
        sellableSize: null,
      }),
    ).toBe(20.04);
  });
});

describe("remaining exposure sizing", () => {
  it("derives the net primary exposure after unwind fills", () => {
    expect(deriveRemainingExposureSize(22.68, 21.67)).toBe(1.01);
    expect(deriveRemainingExposureSize(20.04, 20.04)).toBe(0);
  });
});

describe("hedge retry repricing", () => {
  it("can reprice the hedge leg from live venue liquidity without revalidating the whole pair", () => {
    const hedgeLeg = buildIntent({
      primaryVenue: "polymarket",
      hedgeVenue: "kalshi",
    }).legs[1];

    expect(
      deriveBufferedRetryLeg(
        hedgeLeg,
        {
          price: 0.42,
          depth: 25,
          minOrderSize: 1,
        },
        {
          executionPriceBuffer: 0.01,
          maxLegPrice: 0.49,
          maxSlippageBps: 30,
          minOrderSize: 5,
        },
      ),
    ).toMatchObject({
      id: hedgeLeg.id,
      venue: "kalshi",
      requestedPrice: 0.42,
    });
  });

  it("adds one Kalshi order-price rung per hedge retry attempt", () => {
    const hedgeLeg = buildIntent({
      primaryVenue: "polymarket",
      hedgeVenue: "kalshi",
    }).legs[1];

    expect(
      deriveBufferedRetryLeg(
        hedgeLeg,
        {
          price: 0.42,
          depth: 25,
          minOrderSize: 1,
        },
        {
          executionPriceBuffer: 0.03,
          maxLegPrice: 0.49,
          maxSlippageBps: 0,
          minOrderSize: 5,
        },
        3,
      ),
    ).toMatchObject({
      id: hedgeLeg.id,
      venue: "kalshi",
      requestedPrice: 0.44,
    });
  });

  it("refuses a Kalshi retry rung once the effective order price would exceed the allowed cap", () => {
    const hedgeLeg = buildIntent({
      primaryVenue: "polymarket",
      hedgeVenue: "kalshi",
    }).legs[1];

    expect(
      deriveBufferedRetryLeg(
        hedgeLeg,
        {
          price: 0.49,
          depth: 25,
          minOrderSize: 1,
        },
        {
          executionPriceBuffer: 0.01,
          maxLegPrice: 0.49,
          maxSlippageBps: 30,
          minOrderSize: 5,
        },
        2,
      ),
    ).toBeNull();
  });

  it("reprices a polymarket retry in shares while keeping the usd budget fixed", () => {
    const primaryLeg = {
      ...buildIntent().legs[0],
      requestedPrice: 0.45,
      requestedSize: 22.22,
      requestedNotionalUsd: 10,
    };

    expect(
      deriveBufferedRetryLeg(
        primaryLeg,
        {
          price: 0.47,
          depth: 25,
          minOrderSize: 5,
        },
        {
          executionPriceBuffer: 0.01,
          maxLegPrice: 0.49,
          maxSlippageBps: 30,
          minOrderSize: 5,
        },
      ),
    ).toMatchObject({
      id: primaryLeg.id,
      venue: "polymarket",
      requestedPrice: 0.47,
      requestedSize: 21.27,
      requestedNotionalUsd: 10,
    });
  });

  it("adds one Polymarket tick per retry attempt when repricing a polymarket leg", () => {
    const primaryLeg = {
      ...buildIntent().legs[0],
      requestedPrice: 0.45,
      requestedSize: 22.22,
      requestedNotionalUsd: 10,
    };

    expect(
      deriveBufferedRetryLeg(
        primaryLeg,
        {
          price: 0.47,
          depth: 25,
          minOrderSize: 5,
          tickSize: 0.001,
        },
        {
          executionPriceBuffer: 0.01,
          maxLegPrice: 0.49,
          maxSlippageBps: 30,
          minOrderSize: 5,
        },
        3,
      ),
    ).toMatchObject({
      id: primaryLeg.id,
      venue: "polymarket",
      requestedPrice: 0.472,
      requestedNotionalUsd: 10,
    });
  });
});

describe("kalshi hedge safety guards", () => {
  it("requires the final Kalshi retry rung to remain inside the allowed cap", () => {
    const hedgeLeg = buildIntent({
      primaryVenue: "polymarket",
      hedgeVenue: "kalshi",
    }).legs[1];

    expect(
      hasKalshiHedgeRetryCapacity(
        hedgeLeg,
        {
          price: 0.42,
          depth: 25,
          minOrderSize: 1,
        },
        {
          executionPriceBuffer: 0.03,
          maxLegPrice: 0.49,
          maxSlippageBps: 0,
          minOrderSize: 5,
        },
        3,
      ),
    ).toBe(true);

    expect(
      hasKalshiHedgeRetryCapacity(
        hedgeLeg,
        {
          price: 0.49,
          depth: 25,
          minOrderSize: 1,
        },
        {
          executionPriceBuffer: 0.01,
          maxLegPrice: 0.49,
          maxSlippageBps: 30,
          minOrderSize: 5,
        },
        2,
      ),
    ).toBe(false);
  });
});

describe("venue order request sizing", () => {
  it("uses the polymarket leg usd budget as the buy amount", () => {
    const polymarketLeg = {
      ...buildIntent().legs[0],
      requestedPrice: 0.42,
      requestedSize: 20,
      requestedNotionalUsd: 10,
    };

    const request = buildVenueOrderRequest(polymarketLeg, 30, "FOK", false);

    expect(request.price).toBeCloseTo(0.42126, 5);
    expect(request.size).toBe(20);
    expect(request.maxCostUsd).toBe(10);
  });

  it("keeps kalshi max cost slippage-adjusted", () => {
    const kalshiLeg = {
      ...buildIntent().legs[1],
      requestedPrice: 0.42,
      requestedSize: 20,
      requestedNotionalUsd: 10,
    };

    const request = buildVenueOrderRequest(kalshiLeg, 30, "FOK", false);

    expect(request.price).toBe(0.43);
    expect(request.maxCostUsd).toBeCloseTo(10.03, 4);
  });
});

describe("retryable polymarket unwind errors", () => {
  it("treats inventory sync errors as retryable", () => {
    expect(
      isRetryablePolymarketInventorySyncError(
        new Error(
          "not enough balance / allowance: the balance is not enough -> balance: 19264187, order amount: 20040000",
        ),
      ),
    ).toBe(true);

    expect(isRetryablePolymarketInventorySyncError(new Error("Unable to unwind intent x: no exitable size"))).toBe(
      true,
    );
    expect(isRetryablePolymarketInventorySyncError(new Error("authentication failed"))).toBe(false);
  });
});

describe("hedge failure breakers", () => {
  it("ignores slot breakers from old slots when evaluating the current slot", () => {
    expect(isBreakerRelevantToSlot({ key: "global" }, "btc", "btc:slot-2")).toBe(true);
    expect(isBreakerRelevantToSlot({ key: "asset:btc" }, "btc", "btc:slot-2")).toBe(true);
    expect(isBreakerRelevantToSlot({ key: "slot:btc:slot-2" }, "btc", "btc:slot-2")).toBe(true);
    expect(isBreakerRelevantToSlot({ key: "slot:btc:slot-1" }, "btc", "btc:slot-2")).toBe(false);
  });

  it("keeps a slot hedge breaker active for the rest of the current slot", () => {
    const breaker: Pick<CircuitBreaker, "active" | "key" | "payload" | "reason"> = {
      key: "slot:btc:slot-1",
      active: true,
      reason: "hedge_failure",
      payload: {
        lockSlot: true,
      },
    };

    expect(shouldKeepHedgeFailureBreakerActive(breaker, 100, new Set(["btc:slot-1"]), new Set())).toBe(true);
    expect(shouldKeepHedgeFailureBreakerActive(breaker, 100, new Set(["btc:slot-2"]), new Set())).toBe(false);
  });

  it("keeps a global hedge breaker active through its cooldown", () => {
    const breaker: Pick<CircuitBreaker, "active" | "key" | "payload" | "reason"> = {
      key: "global",
      active: true,
      reason: "hedge_failure",
      payload: {
        cooldownUntil: 200,
      },
    };

    expect(shouldKeepHedgeFailureBreakerActive(breaker, 150, new Set(["btc:slot-1"]), new Set())).toBe(true);
    expect(shouldKeepHedgeFailureBreakerActive(breaker, 250, new Set(["btc:slot-1"]), new Set())).toBe(false);
  });

  it("keeps a manual-clear global hedge breaker active until an operator clears it", () => {
    const breaker: Pick<CircuitBreaker, "active" | "key" | "payload" | "reason"> = {
      key: "global",
      active: true,
      reason: "hedge_failure",
      payload: {
        requiresManualClear: true,
      },
    };

    expect(shouldKeepHedgeFailureBreakerActive(breaker, 1_000, new Set(["btc:slot-1"]), new Set())).toBe(true);
  });
});

describe("feed breaker management", () => {
  it("recognizes feed-health slot breakers from their payload shape", () => {
    expect(
      isFeedHealthBreaker({
        reason: "venue_error",
        payload: {
          feeds: [
            {
              venue: "kalshi",
            },
          ],
        },
      }),
    ).toBe(true);

    expect(
      isFeedHealthBreaker({
        reason: "hedge_failure",
        payload: {
          lockSlot: true,
        },
      }),
    ).toBe(false);
  });

  it("does not let feed sync overwrite an active execution slot lock", () => {
    expect(
      shouldManageFeedHealthBreaker({
        active: true,
        reason: "hedge_failure",
        payload: {
          lockSlot: true,
          stage: "primary_no_fill_slot_lock",
        },
      }),
    ).toBe(false);

    expect(
      shouldManageFeedHealthBreaker({
        active: true,
        reason: "venue_error",
        payload: {
          feeds: [],
        },
      }),
    ).toBe(true);
  });
});

describe("primary retry plan", () => {
  it("uses the configured multi-attempt retry plan for Kalshi soft no-fills", () => {
    expect(
      resolvePrimaryRetryPlan(
        "kalshi",
        {
          raw: {
            softNoFill: true,
          },
        },
        {
          primaryRetryAttempts: 2,
          primaryRetryDelayMs: 200,
        },
      ),
    ).toEqual({
      attempts: 2,
      retryDelayMs: 200,
    });
  });

  it("keeps a single immediate retry for non-soft or non-Kalshi failures", () => {
    expect(
      resolvePrimaryRetryPlan(
        "kalshi",
        {
          raw: {},
        },
        {
          primaryRetryAttempts: 4,
          primaryRetryDelayMs: 500,
        },
      ),
    ).toEqual({
      attempts: 1,
      retryDelayMs: 0,
    });

    expect(
      resolvePrimaryRetryPlan(
        "polymarket",
        {
          raw: {
            softNoFill: true,
          },
        },
        {
          primaryRetryAttempts: 4,
          primaryRetryDelayMs: 500,
        },
      ),
    ).toEqual({
      attempts: 1,
      retryDelayMs: 0,
    });
  });
});

describe("kalshi soft no-fill escalation", () => {
  it("counts only recent Kalshi soft hedge no-fills toward the global breaker threshold", () => {
    const events: Pick<RunEvent, "createdAt" | "eventType" | "payload">[] = [
      {
        createdAt: 1_000,
        eventType: "order.hedge.no_fill",
        payload: {
          venue: "kalshi",
          softNoFill: true,
          slotKey: "slot-1",
        },
      },
      {
        createdAt: 2_000,
        eventType: "order.hedge.no_fill",
        payload: {
          venue: "kalshi",
          softNoFill: true,
          slotKey: "slot-2",
        },
      },
      {
        createdAt: 2_500,
        eventType: "order.hedge.no_fill",
        payload: {
          venue: "polymarket",
          softNoFill: true,
        },
      },
      {
        createdAt: 100,
        eventType: "order.hedge.no_fill",
        payload: {
          venue: "kalshi",
          softNoFill: true,
        },
      },
    ];

    expect(countRecentKalshiSoftHedgeNoFillEvents(events, 2_500, 2_000)).toBe(2);
  });

  it("does not count recent Polymarket soft hedge no-fills toward the Kalshi threshold", () => {
    const events: Pick<RunEvent, "createdAt" | "eventType" | "payload">[] = [
      {
        createdAt: 1_000,
        eventType: "order.hedge.no_fill",
        payload: {
          venue: "polymarket",
          softNoFill: true,
          slotKey: "slot-1",
        },
      },
      {
        createdAt: 2_000,
        eventType: "order.hedge.no_fill",
        payload: {
          venue: "polymarket",
          softNoFill: true,
          slotKey: "slot-2",
        },
      },
    ];

    expect(countRecentKalshiSoftHedgeNoFillEvents(events, 2_500, 2_000)).toBe(0);
  });

  it("counts only recent Kalshi soft primary no-fills toward the primary slot lock telemetry", () => {
    const events: Pick<RunEvent, "createdAt" | "eventType" | "payload">[] = [
      {
        createdAt: 1_000,
        eventType: "order.primary.no_fill",
        payload: {
          venue: "kalshi",
          softNoFill: true,
          slotKey: "slot-1",
        },
      },
      {
        createdAt: 2_000,
        eventType: "order.primary.no_fill",
        payload: {
          venue: "kalshi",
          softNoFill: true,
          slotKey: "slot-2",
        },
      },
      {
        createdAt: 2_100,
        eventType: "order.primary.no_fill",
        payload: {
          venue: "polymarket",
          softNoFill: true,
          slotKey: "slot-3",
        },
      },
      {
        createdAt: 2_200,
        eventType: "order.primary.no_fill",
        payload: {
          venue: "kalshi",
          softNoFill: false,
          slotKey: "slot-4",
        },
      },
    ];

    expect(countRecentKalshiSoftPrimaryNoFillEvents(events, 2_500, 2_000)).toBe(2);
  });
});

describe("polymarket closed orderbook errors", () => {
  it("detects when a token orderbook has disappeared", () => {
    expect(
      isPolymarketOrderbookUnavailableError(
        new Error("the orderbook 110016697850489733765199292378131676749047131268297622626845863046634270666333 does not exist"),
      ),
    ).toBe(true);
    expect(isPolymarketOrderbookUnavailableError(new Error("market not found"))).toBe(false);
  });
});

describe("intent fill summaries", () => {
  it("separates entry fills from unwind fills on the same venue", () => {
    const leg = buildIntent().legs[0];
    const fills: LiveFill[] = [
      {
        id: "fill-buy",
        asset: "btc",
        shadow: false,
        intentId: "intent-1",
        venue: "polymarket",
        venueOrderId: "buy-1",
        tradeId: "trade-buy",
        marketRef: "poly-market",
        tokenId: "token-1",
        side: "BUY",
        outcome: "DOWN",
        price: 0.38,
        size: 22.68,
        feeUsd: 0.86,
        liquidity: "TAKER",
        filledAt: 1,
        raw: {},
      },
      {
        id: "fill-sell",
        asset: "btc",
        shadow: false,
        intentId: "intent-1",
        venue: "polymarket",
        venueOrderId: "sell-1",
        tradeId: "trade-sell",
        marketRef: "poly-market",
        tokenId: "token-1",
        side: "SELL",
        outcome: "DOWN",
        price: 0.4,
        size: 21.67,
        feeUsd: 0.87,
        liquidity: "TAKER",
        filledAt: 2,
        raw: {},
      },
    ];

    expect(summarizeIntentLegFills(fills, leg, "entry")?.filledSize).toBe(22.68);
    expect(summarizeIntentLegFills(fills, leg, "exit")?.filledSize).toBe(21.67);
  });
});

describe("live remaining leg size", () => {
  it("matches the live position back to the polymarket token when available", () => {
    const leg = buildIntent().legs[0];

    expect(
      deriveLiveRemainingLegSize(
        [
          {
            id: "polymarket:token-1",
            asset: "btc",
            venue: "polymarket",
            marketRef: "poly-market",
            outcome: "DOWN",
            size: 1.01,
            averagePrice: 0.38,
            currentPrice: 1,
            currentValueUsd: 1.01,
            realizedPnlUsd: 0,
            unrealizedPnlUsd: 0,
            redeemable: true,
            mergeable: false,
            updatedAt: 3,
            raw: {
              asset: "token-1",
            },
          },
        ],
        leg,
      ),
    ).toBe(1.01);
  });
});
