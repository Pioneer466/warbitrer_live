import { fetchFinalizedKalshiResolution } from "@/lib/kalshi";
import { getMarketCatalogEntry } from "@/lib/market-catalog";
import { fetchFinalizedPolymarketResolution } from "@/lib/polymarket";
import type { MarketAsset, OrderIntentLeg } from "@/lib/types";

type SettlementIntentReference = {
  asset: MarketAsset;
  slotStartTs: number;
  legs: ReadonlyArray<Pick<OrderIntentLeg, "venue" | "marketRef">>;
};

export type SettledVenueResolutions = {
  polyResolution: "UP" | "DOWN";
  kalshiResolution: "YES" | "NO";
};

export function deriveSettledVenueResolutions({
  polymarketResolution,
  kalshiResolution,
}: {
  polymarketResolution: "UP" | "DOWN" | null;
  kalshiResolution: "YES" | "NO" | null;
}): SettledVenueResolutions | null {
  if (!polymarketResolution || !kalshiResolution) {
    return null;
  }

  return {
    polyResolution: polymarketResolution,
    kalshiResolution,
  };
}

export async function fetchVenueSettlementResolutions(
  intent: SettlementIntentReference,
): Promise<SettledVenueResolutions | null> {
  const polymarketLeg = intent.legs.find((leg) => leg.venue === "polymarket");
  const kalshiLeg = intent.legs.find((leg) => leg.venue === "kalshi");
  if (!polymarketLeg?.marketRef || !kalshiLeg?.marketRef) {
    return null;
  }

  const slotSlug = `${getMarketCatalogEntry(intent.asset).polymarketSlugPrefix}-${Math.floor(intent.slotStartTs / 1_000)}`;
  const [polymarketResolution, kalshiResolution] = await Promise.all([
    fetchFinalizedPolymarketResolution(slotSlug, polymarketLeg.marketRef).catch(() => null),
    fetchFinalizedKalshiResolution(kalshiLeg.marketRef).catch(() => null),
  ]);

  return deriveSettledVenueResolutions({
    polymarketResolution,
    kalshiResolution,
  });
}
