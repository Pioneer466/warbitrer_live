import {
  calculateWinningPayout,
  createIntentFromOpportunity,
  finalizeIntent,
  finalizeUnwoundIntent,
  markIntentStatus,
  summarizeVenueFills,
} from "@/lib/settlement";
import type { LiveOpportunity } from "@/lib/types";

const opportunity: LiveOpportunity = {
  id: "opp-1",
  asset: "btc",
  slotKey: "btc:1774899000000",
  capturedAt: 1774899060000,
  combination: "POLY_UP_KALSHI_NO",
  label: "Poly Up + Kalshi No",
  grossCost: 0.91,
  threshold: 0.93,
  thresholdMet: true,
  eligible: true,
  primaryVenue: "kalshi",
  improvementFromLastEntry: null,
  estimatedFeesUsd: 0.8,
  projectedNetProfitUsd: 4.2,
  projectedNetReturn: 0.08,
  reasons: [],
  mismatchRisk: "low",
  venueDisagreementPct: 0.07,
  secondsElapsedInSlot: 60,
  chainlinkMoveBps: 9,
  openDriftBps: 1,
  chainlinkLivePriceUsd: 100100,
  observedSlotOpenPriceUsd: 100000,
  kalshiTargetPriceUsd: 100010,
  legs: [
    {
      venue: "polymarket",
      outcome: "UP",
      marketRef: "poly-market",
      tokenId: "poly-up",
      price: 0.42,
      depth: 300,
      targetNotionalUsd: 25,
      size: 59.52,
      tickSize: 0.001,
      minOrderSize: 0.01,
      feeEstimateUsd: 0.1,
    },
    {
      venue: "kalshi",
      outcome: "NO",
      marketRef: "KXBTC15M-1",
      price: 0.49,
      depth: 200,
      targetNotionalUsd: 25,
      size: 51,
      tickSize: 0.001,
      minOrderSize: 1,
      feeEstimateUsd: 0.7,
    },
  ],
};

describe("live intent settlement", () => {
  it("builds an executable intent from an eligible opportunity", () => {
    const intent = createIntentFromOpportunity({
      opportunity,
      slotStartTs: 1774899000000,
      slotEndTs: 1774899900000,
      now: 1774899060000,
      maxSlippageBps: 30,
      shadow: false,
    });

    expect(intent.primaryVenue).toBe("kalshi");
    expect(intent.hedgeVenue).toBe("polymarket");
    expect(intent.legs[0].requestedNotionalUsd + intent.legs[1].requestedNotionalUsd).toBeCloseTo(
      opportunity.legs[0].targetNotionalUsd + opportunity.legs[1].targetNotionalUsd,
      4,
    );
  });

  it("does not trust a stale snapshot primary venue when rebuilding a live intent", () => {
    const intent = createIntentFromOpportunity({
      opportunity: {
        ...opportunity,
        primaryVenue: "polymarket",
      },
      slotStartTs: 1774899000000,
      slotEndTs: 1774899900000,
      now: 1774899060000,
      maxSlippageBps: 30,
      shadow: false,
    });

    expect(intent.primaryVenue).toBe("kalshi");
    expect(intent.hedgeVenue).toBe("polymarket");
  });

  it("computes payout from the winning leg only", () => {
    const intent = createIntentFromOpportunity({
      opportunity,
      slotStartTs: 1774899000000,
      slotEndTs: 1774899900000,
      now: 1774899060000,
      maxSlippageBps: 30,
      shadow: false,
    });
    intent.legs[0].filledSize = 58.9;
    intent.legs[1].filledSize = 51;

    expect(calculateWinningPayout(intent.legs, "UP", "YES")).toBeCloseTo(58.9, 4);
  });

  it("uses realized leg payout when a leg was sold before venue settlement", () => {
    const intent = createIntentFromOpportunity({
      opportunity,
      slotStartTs: 1774899000000,
      slotEndTs: 1774899900000,
      now: 1774899060000,
      maxSlippageBps: 30,
      shadow: false,
    });
    intent.legs[0].filledSize = 58.9;
    intent.legs[0].payoutUsd = 57.42;
    intent.legs[1].filledSize = 51;

    expect(calculateWinningPayout(intent.legs, "UP", "YES")).toBeCloseTo(57.42, 4);
  });

  it("finalizes the intent into a settled record with pnl", () => {
    const intent = createIntentFromOpportunity({
      opportunity,
      slotStartTs: 1774899000000,
      slotEndTs: 1774899900000,
      now: 1774899060000,
      maxSlippageBps: 30,
      shadow: false,
    });
    intent.legs[0].filledSize = 58.9;
    intent.legs[0].filledPrice = 0.423;
    intent.legs[0].feeUsd = 0.15;
    intent.legs[1].filledSize = 51;
    intent.legs[1].filledPrice = 0.487;
    intent.legs[1].feeUsd = 0.72;

    const settled = finalizeIntent({
      intent,
      polyResolution: "UP",
      kalshiResolution: "YES",
      payoutUsd: 58.9,
      now: 1774899960000,
    });

    expect(settled.status).toBe("settled");
    expect(settled.realizedPnlUsd).toBeCloseTo(8.2783, 4);
    expect(settled.realizedPnlUsd).not.toBeNull();
    expect(settled.polyResolution).toBe("UP");
  });

  it("clears a stale failure reason when an intent recovers", () => {
    const intent = createIntentFromOpportunity({
      opportunity,
      slotStartTs: 1774899000000,
      slotEndTs: 1774899900000,
      now: 1774899060000,
      maxSlippageBps: 30,
      shadow: false,
    });

    const recovered = markIntentStatus(
      {
        ...intent,
        status: "primary_filled",
        failureReason: "Late primary fill detected; resuming hedge",
      },
      "hedged",
      1774899960000,
      null,
    );

    expect(recovered.status).toBe("hedged");
    expect(recovered.failureReason).toBeNull();
  });

  it("finalizes an unwound intent with realized pnl from payout", () => {
    const intent = createIntentFromOpportunity({
      opportunity,
      slotStartTs: 1774899000000,
      slotEndTs: 1774899900000,
      now: 1774899060000,
      maxSlippageBps: 30,
      shadow: false,
    });
    intent.legs[0].filledSize = 58.9;
    intent.legs[0].filledPrice = 0.423;
    intent.legs[0].feeUsd = 0.15;
    intent.legs[0].payoutUsd = 24.4;
    intent.legs[0].status = "unwound";
    intent.legs[1].filledSize = 0;
    intent.legs[1].filledPrice = null;
    intent.legs[1].feeUsd = 0;

    const unwound = finalizeUnwoundIntent({
      intent: {
        ...intent,
        status: "unwind_required",
      },
      now: 1774899960000,
      failureReason: "Hedge failed, primary unwound",
    });

    expect(unwound.status).toBe("unwound");
    expect(unwound.realizedPnlUsd).toBeCloseTo(-0.6647, 4);
    expect(unwound.roi).toBeCloseTo(-0.0265, 4);
    expect(unwound.failureReason).toBe("Hedge failed, primary unwound");
  });

  it("aggregates fills idempotently with a weighted average price", () => {
    const summary = summarizeVenueFills([
      {
        venueOrderId: "order-1",
        size: 10,
        price: 0.4,
        feeUsd: 0.04,
        filledAt: 10,
      },
      {
        venueOrderId: "order-1",
        size: 5,
        price: 0.5,
        feeUsd: 0.03,
        filledAt: 11,
      },
    ]);

    expect(summary.filledSize).toBe(15);
    expect(summary.averageFillPrice).toBeCloseTo(0.4333, 4);
    expect(summary.feeUsd).toBe(0.07);
    expect(summary.venueOrderId).toBe("order-1");
  });
});
