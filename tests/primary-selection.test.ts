import { choosePrimaryVenueForOpportunity } from "@/lib/primary-selection";
import type { LiveOpportunity } from "@/lib/types";

function opportunity(polyDepth: number, kalshiDepth: number): Pick<LiveOpportunity, "legs"> {
  return {
    legs: [
      {
        venue: "polymarket",
        outcome: "UP",
        marketRef: "poly",
        tokenId: "poly-up",
        price: 0.42,
        depth: polyDepth,
        targetNotionalUsd: 20,
        size: 10,
        tickSize: 0.001,
        minOrderSize: 0.01,
        feeEstimateUsd: 0,
      },
      {
        venue: "kalshi",
        outcome: "NO",
        marketRef: "kalshi",
        price: 0.48,
        depth: kalshiDepth,
        targetNotionalUsd: 20,
        size: 10,
        tickSize: 0.01,
        minOrderSize: 1,
        feeEstimateUsd: 0,
      },
    ],
  };
}

describe("primary venue selection", () => {
  it("keeps Kalshi live in shadow mode while logging a Polymarket recommendation", () => {
    const result = choosePrimaryVenueForOpportunity(opportunity(40, 4), "shadow");

    expect(result.primaryVenue).toBe("kalshi");
    expect(result.audit?.recommendedPrimaryVenue).toBe("polymarket");
    expect(result.audit?.livePrimaryVenue).toBe("kalshi");
  });

  it("chooses Polymarket dynamically when Kalshi coverage is materially worse", () => {
    const result = choosePrimaryVenueForOpportunity(opportunity(40, 4), "dynamic");

    expect(result.primaryVenue).toBe("polymarket");
  });

  it("prefers Kalshi when scores are close", () => {
    const result = choosePrimaryVenueForOpportunity(opportunity(10, 9.5), "dynamic");

    expect(result.primaryVenue).toBe("kalshi");
  });
});
