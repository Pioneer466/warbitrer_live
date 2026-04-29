import {
  buildVenueOrderRequest,
  countRecentKalshiSoftHedgeNoFillEvents,
  countRecentKalshiSoftPrimaryNoFillEvents,
  deriveFastKalshiPrimaryClipIntent,
  deriveKalshiPrimaryFallbackClipPlan,
  deriveLiveRemainingLegSize,
  deriveBufferedRetryLeg,
  deriveSettledVenueResolutions,
  deriveRemainingExposureSize,
  derivePrimaryExitSize,
  evaluateStablePnlChangeReadiness,
  getOpportunitySnapshotAgeMs,
  hasKalshiHedgeRetryCapacity,
  isFeedHealthBreaker,
  isBreakerRelevantToSlot,
  isOpportunitySnapshotFresh,
  isLatePrimaryFillRescueEligible,
  isPolymarketOrderbookUnavailableError,
  isRetryablePolymarketInventorySyncError,
  resolvePrimaryRetryPlan,
  resolveKalshiPrimaryMultiClipRetryPlan,
  shouldManageFeedHealthBreaker,
  shouldKeepPolymarketLegForResolution,
  shouldKeepSlotExecutionBreakerActive,
  shouldTreatPrimaryExecutionAsFilled,
  shouldTreatPrimaryOrderAsFilled,
  shouldTreatPrimaryUnwindOrderAsComplete,
  shouldDeferPolymarketUnwindToSettlement,
  shouldUseFastKalshiPrimaryPreparation,
  selectWinningExecutionCandidate,
  sumPolymarketAskDepthWithinLimit,
  summarizeIntentLegOrders,
  summarizeIntentLegFills,
} from "@/lib/engine";
import type { CircuitBreaker, ExecutionCandidate, LiveFill, LiveOrder, OrderIntent, PositionSnapshot, RunEvent, VenueBalance } from "@/lib/types";

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

function buildVenueBalance(overrides: Partial<VenueBalance> = {}): VenueBalance {
  const base: VenueBalance = {
    venue: "polymarket",
    capturedAt: 1,
    status: "ready",
    currency: "USDC",
    availableBalanceUsd: 100,
    totalBalanceUsd: 100,
    portfolioValueUsd: 100,
    allowanceUsd: 100,
    notes: [],
    raw: {},
  };

  return {
    ...base,
    ...overrides,
  };
}

function buildPosition(overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
  const base: PositionSnapshot = {
    id: "position-1",
    asset: "btc",
    venue: "polymarket",
    marketRef: "poly-market",
    outcome: "DOWN",
    size: 10,
    averagePrice: 0.45,
    currentPrice: 0.5,
    currentValueUsd: 5,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0.5,
    redeemable: false,
    mergeable: false,
    updatedAt: 1,
    raw: {},
  };

  return {
    ...base,
    ...overrides,
  };
}

function buildExecutionCandidate(overrides: Partial<ExecutionCandidate> = {}): ExecutionCandidate {
  return {
    asset: "btc",
    slotKey: "btc:slot-1",
    scanSequence: 1,
    capturedAt: 1_000,
    expiresAt: 2_000,
    combination: "POLY_DOWN_KALSHI_YES",
    projectedNetProfitUsd: 0.2,
    grossCost: 0.91,
    signalAgeMs: 0,
    updatedAt: 1_000,
    ...overrides,
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

describe("opportunity snapshot freshness", () => {
  it("accepts snapshots inside maxSignalAgeMs and rejects stale ones", () => {
    expect(isOpportunitySnapshotFresh({ capturedAt: 1_000 }, 1_999, 1_000)).toBe(true);
    expect(isOpportunitySnapshotFresh({ capturedAt: 1_000 }, 2_001, 1_000)).toBe(false);
  });

  it("clamps negative ages when clocks are equalized by fresh process time", () => {
    expect(getOpportunitySnapshotAgeMs({ capturedAt: 2_000 }, 1_900)).toBe(0);
  });
});

describe("execution candidate arbitration", () => {
  it("selects the highest projected net profit among fresh candidates", () => {
    const winner = selectWinningExecutionCandidate(
      [
        buildExecutionCandidate({ asset: "btc", projectedNetProfitUsd: 0.18, capturedAt: 1_000 }),
        buildExecutionCandidate({ asset: "eth", projectedNetProfitUsd: 0.32, capturedAt: 950 }),
      ],
      1_010,
    );

    expect(winner?.asset).toBe("eth");
  });

  it("uses freshness and asset order as deterministic tie breakers", () => {
    expect(
      selectWinningExecutionCandidate(
        [
          buildExecutionCandidate({ asset: "eth", projectedNetProfitUsd: 0.2, capturedAt: 900 }),
          buildExecutionCandidate({ asset: "btc", projectedNetProfitUsd: 0.2, capturedAt: 950 }),
        ],
        1_000,
      )?.asset,
    ).toBe("btc");

    expect(
      selectWinningExecutionCandidate(
        [
          buildExecutionCandidate({ asset: "eth", projectedNetProfitUsd: 0.2, capturedAt: 950 }),
          buildExecutionCandidate({ asset: "btc", projectedNetProfitUsd: 0.2, capturedAt: 950 }),
        ],
        1_000,
      )?.asset,
    ).toBe("btc");
  });

  it("ignores expired candidates before any order path can run", () => {
    const winner = selectWinningExecutionCandidate(
      [
        buildExecutionCandidate({ asset: "btc", projectedNetProfitUsd: 1, expiresAt: 999 }),
        buildExecutionCandidate({ asset: "eth", projectedNetProfitUsd: 0.1, expiresAt: 1_500 }),
      ],
      1_000,
    );

    expect(winner?.asset).toBe("eth");
  });
});

describe("settlement venue resolutions", () => {
  it("requires actual venue outcomes instead of falling back to an external reference", () => {
    expect(
      deriveSettledVenueResolutions({
        polymarketResolution: "DOWN",
        kalshiResolution: "YES",
      }),
    ).toEqual({
      polyResolution: "DOWN",
      kalshiResolution: "YES",
    });

    expect(
      deriveSettledVenueResolutions({
        polymarketResolution: "DOWN",
        kalshiResolution: null,
      }),
    ).toBeNull();
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

describe("post-slot polymarket handling", () => {
  it("keeps an in-the-money polymarket leg for resolution instead of forcing a market exit", () => {
    expect(
      shouldKeepPolymarketLegForResolution(
        {
          venue: "polymarket",
          outcome: "DOWN",
          filledSize: 10,
          payoutUsd: null,
        },
        "DOWN",
      ),
    ).toBe(true);

    expect(
      shouldKeepPolymarketLegForResolution(
        {
          venue: "polymarket",
          outcome: "DOWN",
          filledSize: 10,
          payoutUsd: null,
        },
        "UP",
      ),
    ).toBe(false);
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
          kalshiDepthHeadroomContracts: 2,
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
          kalshiDepthHeadroomContracts: 2,
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
          kalshiDepthHeadroomContracts: 2,
        },
        2,
      ),
    ).toBeNull();
  });

  it("allows a retry above the legacy leg-price cap when it stays inside the original price buffer", () => {
    const hedgeLeg = {
      ...buildIntent({
        primaryVenue: "polymarket",
        hedgeVenue: "kalshi",
      }).legs[1],
      requestedPrice: 0.58,
      requestedNotionalUsd: 11.6,
    };

    expect(
      deriveBufferedRetryLeg(
        hedgeLeg,
        {
          price: 0.585,
          depth: 25,
          minOrderSize: 1,
        },
        {
          executionPriceBuffer: 0.01,
          maxLegPrice: 0.49,
          maxSlippageBps: 0,
          minOrderSize: 5,
          kalshiDepthHeadroomContracts: 2,
        },
      ),
    ).toMatchObject({
      requestedPrice: 0.585,
      requestedNotionalUsd: 5.85,
    });
  });

  it("refuses a Kalshi retry when displayed depth only matches the order size without headroom", () => {
    const hedgeLeg = {
      ...buildIntent({
        primaryVenue: "polymarket",
        hedgeVenue: "kalshi",
      }).legs[1],
      requestedPrice: 0.48,
      requestedSize: 20,
      requestedNotionalUsd: 10,
    };

    expect(
      deriveBufferedRetryLeg(
        hedgeLeg,
        {
          price: 0.48,
          depth: 20,
          minOrderSize: 1,
        },
        {
          executionPriceBuffer: 0.01,
          maxLegPrice: 0.49,
          maxSlippageBps: 0,
          minOrderSize: 5,
          kalshiDepthHeadroomContracts: 2,
        },
      ),
    ).toBeNull();
  });

  it("reprices a polymarket hedge retry while preserving the size to cover", () => {
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
          price: 0.46,
          depth: 25,
          minOrderSize: 5,
        },
        {
          executionPriceBuffer: 0.01,
          maxLegPrice: 0.49,
          maxSlippageBps: 30,
          minOrderSize: 5,
          kalshiDepthHeadroomContracts: 2,
        },
      ),
    ).toMatchObject({
      id: primaryLeg.id,
      venue: "polymarket",
      requestedPrice: 0.46,
      requestedSize: 22.22,
      requestedNotionalUsd: 10.2212,
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
          price: 0.458,
          depth: 25,
          minOrderSize: 5,
          tickSize: 0.001,
        },
        {
          executionPriceBuffer: 0.01,
          maxLegPrice: 0.49,
          maxSlippageBps: 30,
          minOrderSize: 5,
          kalshiDepthHeadroomContracts: 2,
        },
        3,
      ),
    ).toMatchObject({
      id: primaryLeg.id,
      venue: "polymarket",
      requestedPrice: 0.46,
      requestedSize: 22.22,
      requestedNotionalUsd: 10.2212,
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
          kalshiDepthHeadroomContracts: 2,
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
          kalshiDepthHeadroomContracts: 2,
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

  it("keeps kalshi max cost aligned to the derived order limit", () => {
    const kalshiLeg = {
      ...buildIntent().legs[1],
      requestedPrice: 0.42,
      requestedSize: 20,
      requestedNotionalUsd: 10,
    };

    const request = buildVenueOrderRequest(kalshiLeg, 30, "FOK", false);

    expect(request.price).toBe(0.43);
    expect(request.maxCostUsd).toBeCloseTo(8.6, 4);
  });

  it("can widen a Kalshi primary buy by whole ticks instead of only by basis points", () => {
    const kalshiLeg = {
      ...buildIntent().legs[1],
      requestedPrice: 0.48,
      requestedSize: 20,
      requestedNotionalUsd: 9.6,
    };

    const request = buildVenueOrderRequest(kalshiLeg, 30, "IOC", false, {
      kalshiPriceTicksSlippage: 2,
    });

    expect(request.price).toBe(0.5);
    expect(request.maxCostUsd).toBe(10);
  });
});

describe("Kalshi primary IOC handling", () => {
  it("uses fast first-entry preparation only for fresh Kalshi-primary signals", () => {
    expect(
      shouldUseFastKalshiPrimaryPreparation(
        {
          primaryVenue: "kalshi",
        },
        1_000,
        1_000,
      ),
    ).toBe(true);

    expect(
      shouldUseFastKalshiPrimaryPreparation(
        {
          primaryVenue: "kalshi",
        },
        999,
        1_000,
      ),
    ).toBe(false);

    expect(
      shouldUseFastKalshiPrimaryPreparation(
        {
          primaryVenue: "polymarket",
        },
        1_000,
        1_000,
      ),
    ).toBe(false);
  });

  it("builds descending fallback clips around 20, 10, then 5 contracts", () => {
    expect(deriveKalshiPrimaryFallbackClipPlan(22)).toEqual([20, 10, 5]);
    expect(deriveKalshiPrimaryFallbackClipPlan(16)).toEqual([16, 10, 5]);
    expect(deriveKalshiPrimaryFallbackClipPlan(7)).toEqual([7, 5]);
  });

  it("caps a fast Kalshi primary clip without repricing the signal", () => {
    const intent = buildIntent({
      primaryVenue: "kalshi",
      hedgeVenue: "polymarket",
      grossCost: 0.91,
      legs: [
        {
          ...buildIntent().legs[0],
          id: "leg-hedge",
          venue: "polymarket",
          requestedPrice: 0.46,
          requestedSize: 22,
          requestedNotionalUsd: 10.12,
        },
        {
          ...buildIntent().legs[1],
          id: "leg-primary",
          venue: "kalshi",
          requestedPrice: 0.45,
          requestedSize: 22,
          requestedNotionalUsd: 9.9,
        },
      ],
    });

    const clipped = deriveFastKalshiPrimaryClipIntent(intent, "leg-primary", 10, 123);

    expect(clipped?.grossCost).toBe(0.91);
    expect(clipped?.updatedAt).toBe(123);
    expect(clipped?.legs.find((leg) => leg.id === "leg-primary")).toMatchObject({
      requestedPrice: 0.45,
      requestedSize: 10,
      requestedNotionalUsd: 4.5,
    });
    expect(clipped?.legs.find((leg) => leg.id === "leg-hedge")).toMatchObject({
      requestedPrice: 0.46,
      requestedSize: 22,
    });
  });

  it("treats a partial Kalshi primary order as hedgable when contracts actually filled", () => {
    expect(
      shouldTreatPrimaryOrderAsFilled(
        { primaryVenue: "kalshi" },
        {
          filledSize: 3,
          status: "partially_filled",
        },
      ),
    ).toBe(true);

    expect(
      shouldTreatPrimaryExecutionAsFilled(
        { primaryVenue: "kalshi" },
        {
          venue: "kalshi",
          venueOrderId: "kal-1",
          filledSize: 3,
          averageFillPrice: 0.48,
          feeUsd: 0.01,
          status: "partially_filled",
          raw: {},
        },
        {
          filledSize: 3,
          status: "partially_filled",
        },
      ),
    ).toBe(true);
  });

  it("does not treat a partial Polymarket primary order as filled", () => {
    expect(
      shouldTreatPrimaryOrderAsFilled(
        { primaryVenue: "polymarket" },
        {
          filledSize: 3,
          status: "partially_filled",
        },
      ),
    ).toBe(false);
  });
});

describe("forced unwind request pricing", () => {
  it("can override the request price when building a reduce-only Kalshi sell", () => {
    const intent = buildIntent({
      primaryVenue: "kalshi",
      legs: [
        {
          ...buildIntent().legs[1],
          venue: "kalshi",
          side: "SELL",
          requestedPrice: 0.52,
          requestedSize: 7,
          requestedNotionalUsd: 3.64,
        },
        buildIntent().legs[0],
      ],
    });

    const request = buildVenueOrderRequest(intent.legs[0], 30, "IOC", true, {
      overridePrice: 0.47,
    });

    expect(request.price).toBe(0.47);
    expect(request.reduceOnly).toBe(true);
    expect(request.side).toBe("SELL");
  });
});

describe("primary unwind completion", () => {
  it("trusts a venue-filled unwind order even when the local requested size is higher", () => {
    expect(
      shouldTreatPrimaryUnwindOrderAsComplete({
        status: "filled",
        filledSize: 8.999,
        requestedSize: 9,
      }),
    ).toBe(true);
  });

  it("does not treat no-fill terminal unwind orders as complete", () => {
    expect(
      shouldTreatPrimaryUnwindOrderAsComplete({
        status: "canceled",
        filledSize: 0,
        requestedSize: 9,
      }),
    ).toBe(false);
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

describe("slot execution breakers", () => {
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

    expect(shouldKeepSlotExecutionBreakerActive(breaker, 100, new Set(["btc:slot-1"]), new Set())).toBe(true);
    expect(shouldKeepSlotExecutionBreakerActive(breaker, 100, new Set(["btc:slot-2"]), new Set())).toBe(false);
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

    expect(shouldKeepSlotExecutionBreakerActive(breaker, 150, new Set(["btc:slot-1"]), new Set())).toBe(true);
    expect(shouldKeepSlotExecutionBreakerActive(breaker, 250, new Set(["btc:slot-1"]), new Set())).toBe(false);
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

    expect(shouldKeepSlotExecutionBreakerActive(breaker, 1_000, new Set(["btc:slot-1"]), new Set())).toBe(true);
  });

  it("keeps a primary no-fill slot breaker active only for the current slot", () => {
    const breaker: Pick<CircuitBreaker, "active" | "key" | "payload" | "reason"> = {
      key: "slot:eth:slot-1",
      active: true,
      reason: "primary_no_fill",
      payload: {
        lockSlot: true,
        stage: "primary_no_fill_slot_lock",
      },
    };

    expect(shouldKeepSlotExecutionBreakerActive(breaker, 100, new Set(["eth:slot-1"]), new Set())).toBe(true);
    expect(shouldKeepSlotExecutionBreakerActive(breaker, 100, new Set(["eth:slot-2"]), new Set())).toBe(false);
  });

  it("lets preflight skip slot breakers expire after their short cooldown", () => {
    const breaker: Pick<CircuitBreaker, "active" | "key" | "payload" | "reason"> = {
      key: "slot:eth:slot-1",
      active: true,
      reason: "primary_no_fill",
      payload: {
        stage: "preflight_skipped",
        cooldownUntil: 200,
      },
    };

    expect(shouldKeepSlotExecutionBreakerActive(breaker, 150, new Set(["eth:slot-1"]), new Set())).toBe(true);
    expect(shouldKeepSlotExecutionBreakerActive(breaker, 250, new Set(["eth:slot-1"]), new Set())).toBe(false);
  });
});

describe("Polymarket hedge preflight helpers", () => {
  it("sums only ask depth executable within the hedge limit price", () => {
    expect(
      sumPolymarketAskDepthWithinLimit(
        [
          { price: "0.12", size: "3" },
          { price: "0.13", size: "4" },
          { price: "0.14", size: "100" },
        ],
        0.13,
      ),
    ).toBe(7);
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
        reason: "primary_no_fill",
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

  it("moves Kalshi multi-clip fallback directly to the next clip after a soft no-fill", () => {
    expect(
      resolveKalshiPrimaryMultiClipRetryPlan("kalshi", {
        raw: {
          softNoFill: true,
        },
      }),
    ).toEqual({
      attempts: 0,
      retryDelayMs: 0,
    });

    expect(
      resolveKalshiPrimaryMultiClipRetryPlan("kalshi", {
        raw: {},
      }),
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
  it("aggregates multiple primary entry orders for the same leg", () => {
    const kalshiLeg = buildIntent({
      primaryVenue: "kalshi",
      hedgeVenue: "polymarket",
      legs: [
        {
          id: "leg-hedge",
          intentId: "intent-1",
          venue: "polymarket",
          outcome: "DOWN",
          marketRef: "poly-market",
          tokenId: "token-1",
          side: "BUY",
          requestedPrice: 0.45,
          requestedSize: 22,
          requestedNotionalUsd: 9.9,
          filledPrice: null,
          filledSize: 0,
          feeUsd: 0,
          status: "pending",
          venueOrderId: null,
          payoutUsd: null,
          resolvedOutcome: null,
        },
        {
          id: "leg-primary",
          intentId: "intent-1",
          venue: "kalshi",
          outcome: "YES",
          marketRef: "kalshi-market",
          side: "BUY",
          requestedPrice: 0.45,
          requestedSize: 22,
          requestedNotionalUsd: 9.9,
          filledPrice: null,
          filledSize: 0,
          feeUsd: 0,
          status: "pending",
          venueOrderId: null,
          payoutUsd: null,
          resolvedOutcome: null,
        },
      ],
    }).legs[1];

    const summary = summarizeIntentLegOrders(
      [
        buildOrder({
          venue: "kalshi",
          side: "BUY",
          outcome: "YES",
          marketRef: "kalshi-market",
          venueOrderId: "kalshi-clip-2",
          filledSize: 7,
          averageFillPrice: 0.46,
          feeUsd: 0.13,
          status: "filled",
          updatedAt: 2,
        }),
        buildOrder({
          venue: "kalshi",
          side: "BUY",
          outcome: "YES",
          marketRef: "kalshi-market",
          venueOrderId: "kalshi-clip-1",
          filledSize: 8,
          averageFillPrice: 0.45,
          feeUsd: 0.14,
          status: "filled",
          updatedAt: 1,
        }),
      ],
      kalshiLeg,
      "entry",
    );

    expect(summary).toEqual({
      filledSize: 15,
      averageFillPrice: 0.4547,
      feeUsd: 0.27,
      venueOrderId: "kalshi-clip-2",
    });
  });

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

describe("polymarket post-slot unwind handling", () => {
  it("defers Polymarket primary unwind to settlement/redeem after the resolution grace window", () => {
    expect(
      shouldDeferPolymarketUnwindToSettlement(
        {
          primaryVenue: "polymarket",
          slotEndTs: 1_000,
        },
        6_000,
      ),
    ).toBe(true);

    expect(
      shouldDeferPolymarketUnwindToSettlement(
        {
          primaryVenue: "polymarket",
          slotEndTs: 1_000,
        },
        5_999,
      ),
    ).toBe(false);

    expect(
      shouldDeferPolymarketUnwindToSettlement(
        {
          primaryVenue: "kalshi",
          slotEndTs: 1_000,
        },
        6_000,
      ),
    ).toBe(false);
  });
});

describe("stable pnl readiness", () => {
  it("waits for settled venues and cash-equivalent balances before recording", () => {
    const intent = buildIntent({
      status: "settled",
      realizedPnlUsd: 0.4,
      roi: 0.087,
      polyResolution: "UP",
      kalshiResolution: "YES",
    });
    const balances = [
      buildVenueBalance({
        venue: "polymarket",
        availableBalanceUsd: 100,
        totalBalanceUsd: 100,
        portfolioValueUsd: 100,
      }),
      buildVenueBalance({
        venue: "kalshi",
        currency: "USD",
        allowanceUsd: null,
        availableBalanceUsd: 50,
        totalBalanceUsd: 50,
        portfolioValueUsd: 50,
      }),
    ];

    expect(evaluateStablePnlChangeReadiness(intent, balances, []).ready).toBe(true);
  });

  it("blocks while Polymarket portfolio value has not returned to available cash", () => {
    const intent = buildIntent({
      status: "settled",
      realizedPnlUsd: 0.4,
      polyResolution: "UP",
      kalshiResolution: "YES",
    });
    const balances = [
      buildVenueBalance({
        venue: "polymarket",
        availableBalanceUsd: 100,
        totalBalanceUsd: 100.25,
        portfolioValueUsd: 100.25,
      }),
      buildVenueBalance({
        venue: "kalshi",
        currency: "USD",
        allowanceUsd: null,
        availableBalanceUsd: 50,
        totalBalanceUsd: 50,
        portfolioValueUsd: 50,
      }),
    ];

    expect(evaluateStablePnlChangeReadiness(intent, balances, []).ready).toBe(false);
  });

  it("blocks while the Kalshi market still has active exposure", () => {
    const intent = buildIntent({
      status: "settled",
      realizedPnlUsd: 0.4,
      polyResolution: "UP",
      kalshiResolution: "YES",
    });
    const balances = [
      buildVenueBalance({ venue: "polymarket" }),
      buildVenueBalance({
        venue: "kalshi",
        currency: "USD",
        allowanceUsd: null,
        availableBalanceUsd: 50,
        totalBalanceUsd: 50,
        portfolioValueUsd: 50,
      }),
    ];

    expect(
      evaluateStablePnlChangeReadiness(intent, balances, [
        buildPosition({
          venue: "kalshi",
          marketRef: "kalshi-market",
          outcome: "YES",
          currentValueUsd: 10,
        }),
      ]).ready,
    ).toBe(false);
  });
});
