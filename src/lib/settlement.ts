import type {
  LiveFill,
  LiveOpportunity,
  OrderIntent,
  OrderIntentLeg,
  Resolution,
  Venue,
} from "@/lib/types";

export function createIntentFromOpportunity({
  opportunity,
  slotStartTs,
  slotEndTs,
  now,
  maxSlippageBps,
  shadow,
}: {
  opportunity: LiveOpportunity;
  slotStartTs: number;
  slotEndTs: number;
  now: number;
  maxSlippageBps: number;
  shadow: boolean;
}): OrderIntent {
  if (!opportunity.primaryVenue || !opportunity.eligible || opportunity.grossCost === null) {
    throw new Error("Impossible de créer une intention live sans opportunité exécutable");
  }

  const [firstLeg, secondLeg] = opportunity.legs;
  const primaryLeg = firstLeg.venue === opportunity.primaryVenue ? firstLeg : secondLeg;
  const hedgeLeg = firstLeg.venue === opportunity.primaryVenue ? secondLeg : firstLeg;
  const intentId = crypto.randomUUID();

  return {
    id: intentId,
    shadow,
    slotKey: opportunity.slotKey,
    slotStartTs,
    slotEndTs,
    combination: opportunity.combination,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    primaryVenue: primaryLeg.venue,
    hedgeVenue: hedgeLeg.venue,
    grossCost: opportunity.grossCost,
    targetNotionalUsd: primaryLeg.targetNotionalUsd + hedgeLeg.targetNotionalUsd,
    maxSlippageBps,
    failureReason: null,
    projectedNetProfitUsd: opportunity.projectedNetProfitUsd,
    realizedPnlUsd: null,
    roi: null,
    polyResolution: null,
    kalshiResolution: null,
    legs: [
      buildIntentLeg(intentId, firstLeg.venue, firstLeg.outcome, firstLeg.marketRef, firstLeg.tokenId, firstLeg.price, firstLeg.size, firstLeg.targetNotionalUsd),
      buildIntentLeg(intentId, secondLeg.venue, secondLeg.outcome, secondLeg.marketRef, secondLeg.tokenId, secondLeg.price, secondLeg.size, secondLeg.targetNotionalUsd),
    ],
  };
}

export function markIntentStatus(intent: OrderIntent, status: OrderIntent["status"], now: number, failureReason?: string | null): OrderIntent {
  return {
    ...intent,
    status,
    updatedAt: now,
    failureReason: failureReason ?? intent.failureReason,
  };
}

export function applyLegExecution(params: {
  intent: OrderIntent;
  venue: Venue;
  venueOrderId: string;
  filledSize: number;
  averageFillPrice: number | null;
  feeUsd: number;
  status: OrderIntentLeg["status"];
  now: number;
}): OrderIntent {
  const legs = params.intent.legs.map((leg) =>
    leg.venue === params.venue
      ? {
          ...leg,
          venueOrderId: params.venueOrderId,
          filledSize: params.filledSize,
          filledPrice: params.averageFillPrice ?? leg.filledPrice,
          feeUsd: params.feeUsd,
          status: params.status,
        }
      : leg,
  ) as OrderIntent["legs"];

  return {
    ...params.intent,
    legs,
    updatedAt: params.now,
  };
}

export function finalizeIntent({
  intent,
  polyResolution,
  kalshiResolution,
  payoutUsd,
  now,
}: {
  intent: OrderIntent;
  polyResolution: "UP" | "DOWN" | null;
  kalshiResolution: "YES" | "NO" | null;
  payoutUsd: number;
  now: number;
}): OrderIntent {
  const totalNotional = intent.legs.reduce((sum, leg) => sum + calculateLegSpentUsd(leg), 0);
  const realizedPnlUsd = round4(payoutUsd - totalNotional);

  return {
    ...intent,
    status: "settled",
    updatedAt: now,
    resolvedAt: now,
    polyResolution,
    kalshiResolution,
    realizedPnlUsd,
    roi: totalNotional > 0 ? round4(realizedPnlUsd / totalNotional) : null,
  };
}

export function calculateWinningPayout(
  legs: OrderIntent["legs"],
  polyResolution: "UP" | "DOWN",
  kalshiResolution: "YES" | "NO",
) {
  return legs.reduce((sum, leg) => {
    const resolvedOutcome: Resolution = leg.venue === "polymarket" ? polyResolution : kalshiResolution;
    const won = leg.outcome === resolvedOutcome;
    return sum + (won ? leg.filledSize : 0);
  }, 0);
}

export function summarizeVenueFills(
  fills: Array<Pick<LiveFill, "venueOrderId" | "size" | "price" | "feeUsd" | "filledAt">>,
) {
  const sorted = [...fills].sort((left, right) => left.filledAt - right.filledAt);
  const filledSize = round4(sorted.reduce((sum, fill) => sum + fill.size, 0));
  const grossCostUsd = sorted.reduce((sum, fill) => sum + fill.size * fill.price, 0);
  const feeUsd = round4(sorted.reduce((sum, fill) => sum + fill.feeUsd, 0));

  return {
    filledSize,
    averageFillPrice: filledSize > 0 ? round4(grossCostUsd / filledSize) : null,
    feeUsd,
    venueOrderId: sorted.at(-1)?.venueOrderId ?? null,
  };
}

export function calculateLegSpentUsd(leg: Pick<OrderIntentLeg, "filledSize" | "filledPrice" | "requestedNotionalUsd" | "feeUsd">) {
  const tradedNotional = leg.filledSize > 0 && leg.filledPrice !== null ? leg.filledSize * leg.filledPrice : leg.requestedNotionalUsd;
  return round4(tradedNotional + leg.feeUsd);
}

function buildIntentLeg(
  intentId: string,
  venue: Venue,
  outcome: Resolution,
  marketRef: string,
  tokenId: string | undefined,
  price: number | null,
  size: number,
  requestedNotionalUsd: number,
): OrderIntentLeg {
  return {
    id: crypto.randomUUID(),
    intentId,
    venue,
    outcome,
    marketRef,
    tokenId,
    side: "BUY",
    requestedPrice: price,
    requestedSize: size,
    requestedNotionalUsd,
    filledPrice: null,
    filledSize: 0,
    feeUsd: 0,
    status: "pending",
    venueOrderId: null,
    payoutUsd: null,
    resolvedOutcome: null,
  };
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
