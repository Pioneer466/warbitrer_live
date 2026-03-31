import { calculateWinningPayout, createIntentFromOpportunity, finalizeIntent } from "@/lib/settlement";
import type { LiveOpportunity } from "@/lib/types";

const opportunity: LiveOpportunity = {
  id: "opp-1",
  slotKey: "1774899000000",
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
    expect(intent.legs[0].requestedNotionalUsd + intent.legs[1].requestedNotionalUsd).toBe(50);
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
    intent.legs[0].feeUsd = 0.15;
    intent.legs[1].filledSize = 51;
    intent.legs[1].feeUsd = 0.72;

    const settled = finalizeIntent({
      intent,
      polyResolution: "UP",
      kalshiResolution: "YES",
      payoutUsd: 58.9,
      now: 1774899960000,
    });

    expect(settled.status).toBe("settled");
    expect(settled.realizedPnlUsd).not.toBeNull();
    expect(settled.polyResolution).toBe("UP");
  });
});
