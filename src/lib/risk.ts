import type { OrderIntent, PositionSnapshot, Venue, VenueBalance } from "@/lib/types";

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

export function calculateReservedVenueBalanceUsd(openIntents: OrderIntent[]): Record<Venue, number> {
  const reserved: Record<Venue, number> = {
    polymarket: 0,
    kalshi: 0,
  };

  for (const intent of openIntents) {
    for (const leg of intent.legs) {
      if (leg.status !== "pending" && leg.status !== "submitted") {
        continue;
      }

      reserved[leg.venue] += leg.requestedNotionalUsd;
    }
  }

  return reserved;
}

export function applyVenueBalanceReservations(
  balances: VenueBalance[],
  openIntents: OrderIntent[],
): VenueBalance[] {
  const reserved = calculateReservedVenueBalanceUsd(openIntents);

  return balances.map((balance) => {
    const reservedUsd = reserved[balance.venue];
    if (reservedUsd <= 0) {
      return balance;
    }

    return {
      ...balance,
      availableBalanceUsd: Math.max(0, round4(balance.availableBalanceUsd - reservedUsd)),
      notes: [...balance.notes, `Reserved for in-flight intents: ${reservedUsd.toFixed(2)} USD`],
    };
  });
}

export function countSlotExecutionBlockers(openIntents: OrderIntent[], slotKey: string) {
  return openIntents.filter((intent) => intent.slotKey === slotKey && intent.status !== "hedged").length;
}

export function hasUnresolvedExposureBlocker(openIntents: OrderIntent[]) {
  return openIntents.some((intent) => intent.status !== "hedged");
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
