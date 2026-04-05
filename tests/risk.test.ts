import { calculateVenueExposureUsd } from "@/lib/risk";
import type { OrderIntent, PositionSnapshot } from "@/lib/types";

describe("venue exposure", () => {
  it("combines current positions and open intent exposure by venue", () => {
    const positions: PositionSnapshot[] = [
      {
        id: "poly-position",
        venue: "polymarket",
        marketRef: "poly-market",
        outcome: "UP",
        size: 10,
        averagePrice: 0.4,
        currentPrice: 0.45,
        currentValueUsd: 4.5,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0.5,
        redeemable: false,
        mergeable: false,
        updatedAt: 1,
        raw: {},
      },
      {
        id: "kalshi-position",
        venue: "kalshi",
        marketRef: "kalshi-market",
        outcome: "YES",
        size: 5,
        averagePrice: 0.5,
        currentPrice: 0.55,
        currentValueUsd: 2.75,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0.25,
        redeemable: false,
        mergeable: false,
        updatedAt: 1,
        raw: {},
      },
    ];

    const openIntents: OrderIntent[] = [
      {
        id: "intent-1",
        shadow: false,
        slotKey: "slot-1",
        slotStartTs: 1,
        slotEndTs: 2,
        combination: "POLY_UP_KALSHI_NO",
        status: "hedged",
        createdAt: 1,
        updatedAt: 1,
        resolvedAt: null,
        primaryVenue: "polymarket",
        hedgeVenue: "kalshi",
        grossCost: 0.9,
        targetNotionalUsd: 50,
        maxSlippageBps: 30,
        failureReason: null,
        projectedNetProfitUsd: 2,
        realizedPnlUsd: null,
        roi: null,
        polyResolution: null,
        kalshiResolution: null,
        legs: [
          {
            id: "leg-1",
            intentId: "intent-1",
            venue: "polymarket",
            outcome: "UP",
            marketRef: "poly-market",
            tokenId: "token-1",
            side: "BUY",
            requestedPrice: 0.4,
            requestedSize: 50,
            requestedNotionalUsd: 25,
            filledPrice: 0.41,
            filledSize: 50,
            feeUsd: 0.1,
            status: "hedged",
            venueOrderId: "poly-order-1",
            payoutUsd: null,
            resolvedOutcome: null,
          },
          {
            id: "leg-2",
            intentId: "intent-1",
            venue: "kalshi",
            outcome: "NO",
            marketRef: "kalshi-market",
            side: "BUY",
            requestedPrice: 0.5,
            requestedSize: 50,
            requestedNotionalUsd: 25,
            filledPrice: 0.49,
            filledSize: 50,
            feeUsd: 0.1,
            status: "hedged",
            venueOrderId: "kalshi-order-1",
            payoutUsd: null,
            resolvedOutcome: null,
          },
        ],
      },
    ];

    const exposure = calculateVenueExposureUsd(positions, openIntents);

    expect(exposure.polymarket).toBeCloseTo(20.5 + 4.5, 4);
    expect(exposure.kalshi).toBeCloseTo(24.5 + 2.75, 4);
  });
});
