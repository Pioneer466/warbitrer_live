import { settleTrade } from "@/lib/settlement";
import type { PaperTrade } from "@/lib/types";

const trade: PaperTrade = {
  id: "trade-1",
  slotKey: "1774899000000",
  slotStartTs: 1774899000000,
  slotEndTs: 1774899900000,
  enteredAt: 1774899060000,
  resolvedAt: null,
  combination: "POLY_UP_KALSHI_NO",
  status: "open",
  grossPairCost: 0.91,
  thresholdMet: true,
  units: 100,
  budgetAllocated: 91,
  capitalDeployed: 91.63,
  feesTotal: 1.03,
  realizedPnl: null,
  roi: null,
  theoreticalSameResolutionProfit: 6.8,
  polyResolution: null,
  kalshiResolution: null,
  legs: [
    {
      id: "leg-poly",
      tradeId: "trade-1",
      venue: "polymarket",
      outcome: "UP",
      marketRef: "poly",
      price: 0.42,
      units: 100,
      grossCost: 42,
      feeUsd: 0.78,
      feeShares: 1.56,
      netShares: 98.44,
      payout: null,
      resolvedOutcome: null,
      status: "open",
    },
    {
      id: "leg-kalshi",
      tradeId: "trade-1",
      venue: "kalshi",
      outcome: "NO",
      marketRef: "kalshi",
      price: 0.49,
      units: 100,
      grossCost: 49,
      feeUsd: 0.63,
      feeShares: 0,
      netShares: 100,
      payout: null,
      resolvedOutcome: null,
      status: "open",
    },
  ],
};

describe("settlement", () => {
  it("resolves the paper trade leg by leg and computes net pnl", () => {
    const settled = settleTrade({
      trade,
      polyResolution: "UP",
      kalshiResolution: "YES",
      resolvedAt: 1774899960000,
    });

    expect(settled.status).toBe("resolved");
    expect(settled.legs[0].status).toBe("won");
    expect(settled.legs[1].status).toBe("lost");
    expect(settled.legs[0].payout).toBeCloseTo(98.44, 4);
    expect(settled.realizedPnl).toBeCloseTo(6.81, 4);
    expect(settled.roi).toBeCloseTo(0.0743, 4);
  });

  it("can lose money when the two venues disagree", () => {
    const settled = settleTrade({
      trade,
      polyResolution: "DOWN",
      kalshiResolution: "YES",
      resolvedAt: 1774899960000,
    });

    expect(settled.realizedPnl).toBeCloseTo(-91.63, 4);
  });
});
