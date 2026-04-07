import { isLatePrimaryFillRescueEligible } from "@/lib/engine";
import type { LiveOrder, OrderIntent } from "@/lib/types";

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
