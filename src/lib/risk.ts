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
  leg: Pick<
    OrderIntent["legs"][number],
    | "filledSize"
    | "filledPrice"
    | "filledAt"
    | "requestedNotionalUsd"
    | "feeUsd"
    | "worstFillCostUsd"
    | "recoveryReserveUsd"
  >,
) {
  const observedExposure =
    leg.filledSize > 0 && leg.filledPrice !== null
      ? leg.filledSize * leg.filledPrice + Math.max(0, leg.feeUsd)
      : leg.requestedNotionalUsd + Math.max(0, leg.feeUsd);
  const durableRiskReservation =
    readNonNegative(leg.worstFillCostUsd) + readNonNegative(leg.recoveryReserveUsd);

  return Math.max(observedExposure, durableRiskReservation);
}

export function calculateReservedVenueBalanceUsd(
  openIntents: OrderIntent[],
  balanceCapturedAtByVenue: Partial<Record<Venue, number>> = {},
): Record<Venue, number> {
  const reserved: Record<Venue, number> = {
    polymarket: 0,
    kalshi: 0,
  };

  for (const intent of openIntents) {
    for (const leg of intent.legs) {
      const recoveryReserveUsd =
        intent.status === "hedged" ? 0 : readNonNegative(leg.recoveryReserveUsd);
      if (leg.status === "pending" || leg.status === "submitted") {
        reserved[leg.venue] += Math.max(
          leg.requestedNotionalUsd + Math.max(0, leg.feeUsd),
          readNonNegative(leg.worstFillCostUsd),
        );
      } else if (
        leg.filledSize > 0 &&
        leg.filledPrice !== null &&
        (balanceCapturedAtByVenue[leg.venue] ?? Number.NEGATIVE_INFINITY) <=
          (leg.filledAt ?? intent.updatedAt)
      ) {
        reserved[leg.venue] +=
          leg.filledSize * leg.filledPrice + Math.max(0, leg.feeUsd);
      }
      reserved[leg.venue] += recoveryReserveUsd;
    }
  }

  return reserved;
}

export function applyVenueBalanceReservations(
  balances: VenueBalance[],
  openIntents: OrderIntent[],
): VenueBalance[] {
  const balanceCapturedAtByVenue = Object.fromEntries(
    balances.map((balance) => [balance.venue, balance.capturedAt]),
  ) as Partial<Record<Venue, number>>;
  const reserved = calculateReservedVenueBalanceUsd(
    openIntents,
    balanceCapturedAtByVenue,
  );

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

function readNonNegative(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
