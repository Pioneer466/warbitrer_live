import {
  deriveLiveRemainingLegSize,
  deriveRemainingExposureSize,
  derivePrimaryExitSize,
  isLatePrimaryFillRescueEligible,
  isPolymarketOrderbookUnavailableError,
  isRetryablePolymarketInventorySyncError,
  summarizeIntentLegFills,
} from "@/lib/engine";
import type { LiveFill, LiveOrder, OrderIntent } from "@/lib/types";

function buildIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    id: "intent-1",
    shadow: false,
    slotKey: "slot-1",
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
    ...overrides,
  };
}

function buildOrder(overrides: Partial<LiveOrder> = {}): LiveOrder {
  return {
    id: "order-1",
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
