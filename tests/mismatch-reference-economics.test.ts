import { describe, expect, it } from "vitest";

import { deriveMismatchEstimateEconomics } from "@/lib/mismatch-reference-economics";
import type { KalshiQuote, LiveOpportunity, PolymarketQuote } from "@/lib/types";

describe("mismatch reference economics", () => {
  it("uses executable candidate economics when a paired size exists", () => {
    const opportunity = buildOpportunity({
      pairSize: 10,
      polymarketNotionalUsd: 4,
      kalshiNotionalUsd: 5,
      polymarketFeeUsd: 0.05,
      kalshiFeeUsd: 0.1,
    });

    expect(
      deriveMismatchEstimateEconomics({
        opportunity,
        polymarket: polymarketQuote(),
        kalshi: kalshiQuote(),
        settings: { minOrderSize: 1 },
      }),
    ).toEqual({
      basis: "executable",
      pairSize: 10,
      totalCostUsd: 9.15,
    });
  });

  it("produces fee-aware minimum-size economics without executable depth", () => {
    const opportunity = buildOpportunity({ pairSize: 0 });
    const economics = deriveMismatchEstimateEconomics({
      opportunity,
      polymarket: polymarketQuote(),
      kalshi: kalshiQuote(),
      settings: { minOrderSize: 1 },
    });

    expect(economics.basis).toBe("reference");
    expect(economics.pairSize).toBe(5);
    expect(economics.totalCostUsd).toBeGreaterThan(4.5);
    expect(economics.totalCostUsd).toBeLessThan(5);
  });

  it("keeps economics unavailable when one leg has no price", () => {
    const opportunity = buildOpportunity({ pairSize: 0 });
    opportunity.legs[0].price = null;

    expect(
      deriveMismatchEstimateEconomics({
        opportunity,
        polymarket: polymarketQuote(),
        kalshi: kalshiQuote(),
        settings: { minOrderSize: 1 },
      }),
    ).toEqual({ basis: "unavailable", pairSize: null, totalCostUsd: null });
  });

  it("keeps a quoted price of one available to expose non-economic pairs", () => {
    const opportunity = buildOpportunity({ pairSize: 0 });
    opportunity.legs[0].price = 1;

    const economics = deriveMismatchEstimateEconomics({
      opportunity,
      polymarket: polymarketQuote(),
      kalshi: kalshiQuote(),
      settings: { minOrderSize: 1 },
    });

    expect(economics.basis).toBe("reference");
    expect(economics.pairSize).toBe(5);
    expect(economics.totalCostUsd).toBeGreaterThan(5);
  });
});

function buildOpportunity(input: {
  pairSize: number;
  polymarketNotionalUsd?: number;
  kalshiNotionalUsd?: number;
  polymarketFeeUsd?: number;
  kalshiFeeUsd?: number;
}): LiveOpportunity {
  return {
    legs: [
      {
        venue: "polymarket",
        outcome: "UP",
        price: 0.4,
        size: input.pairSize,
        minOrderSize: 5,
        targetNotionalUsd: input.polymarketNotionalUsd ?? 0,
        feeEstimateUsd: input.polymarketFeeUsd ?? 0,
      },
      {
        venue: "kalshi",
        outcome: "NO",
        price: 0.5,
        size: input.pairSize,
        minOrderSize: 1,
        targetNotionalUsd: input.kalshiNotionalUsd ?? 0,
        feeEstimateUsd: input.kalshiFeeUsd ?? 0,
      },
    ],
  } as LiveOpportunity;
}

function polymarketQuote(): PolymarketQuote {
  return {
    feeRateBps: 0,
    feeRate: 0.0156,
    feeExponent: 2,
    outcomes: {
      up: { feeRateBps: 0 },
      down: { feeRateBps: 0 },
    },
  } as PolymarketQuote;
}

function kalshiQuote(): KalshiQuote {
  return { feeMultiplier: 1 } as KalshiQuote;
}
