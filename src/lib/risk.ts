import type { OrderIntent, PositionSnapshot, Venue } from "@/lib/types";

export function calculateVenueExposureUsd(
  positions: PositionSnapshot[],
  openIntents: OrderIntent[],
): Record<Venue, number> {
  const exposure: Record<Venue, number> = {
    polymarket: 0,
    kalshi: 0,
  };

  for (const position of positions) {
    exposure[position.venue] += Math.max(position.currentValueUsd, 0);
  }

  for (const intent of openIntents) {
    for (const leg of intent.legs) {
      exposure[leg.venue] += calculateLegExposureUsd(leg);
    }
  }

  return exposure;
}

export function calculateLegExposureUsd(
  leg: Pick<OrderIntent["legs"][number], "filledSize" | "filledPrice" | "requestedNotionalUsd">,
) {
  if (leg.filledSize > 0 && leg.filledPrice !== null) {
    return leg.filledSize * leg.filledPrice;
  }

  return leg.requestedNotionalUsd;
}
