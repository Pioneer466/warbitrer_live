import type { LiveFill, LiveOpportunity, OrderIntent, OrderIntentLeg, Resolution, Venue } from "@/lib/types";

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
  const executionPrimaryVenue = deriveExecutionPrimaryVenue(opportunity);
  if (!executionPrimaryVenue || !opportunity.eligible || opportunity.grossCost === null) {
    throw new Error("Impossible de créer une intention live sans opportunité exécutable");
  }

  const [firstLeg, secondLeg] = opportunity.legs;
  const primaryLeg = firstLeg.venue === executionPrimaryVenue ? firstLeg : secondLeg;
  const hedgeLeg = firstLeg.venue === executionPrimaryVenue ? secondLeg : firstLeg;
  const intentId = crypto.randomUUID();

  return {
    id: intentId,
    revision: 0,
    asset: opportunity.asset,
    shadow,
    slotKey: opportunity.slotKey,
    slotStartTs,
    slotEndTs,
    combination: opportunity.combination,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    primaryVenue: executionPrimaryVenue,
    hedgeVenue: hedgeLeg.venue,
    grossCost: opportunity.grossCost,
    targetNotionalUsd: primaryLeg.targetNotionalUsd + hedgeLeg.targetNotionalUsd,
    entrySizingReason: deriveEntrySizingReason(opportunity),
    maxSlippageBps,
    failureReason: null,
    projectedNetProfitUsd: opportunity.projectedNetProfitUsd,
    mismatchPFatal: opportunity.mismatchRiskEstimate?.pFatal ?? null,
    mismatchPFatalUpper: opportunity.mismatchRiskEstimate?.pFatalUpper95 ?? null,
    mismatchModelVersion: opportunity.mismatchRiskEstimate?.modelVersion ?? null,
    mismatchRiskAudit: opportunity.mismatchRiskAudit ?? null,
    fatalMismatchPnlUsd: opportunity.fatalMismatchPnlUsd ?? null,
    conservativeExpectedPnlUsd: opportunity.conservativeExpectedPnlUsd ?? null,
    fatalLossExposureUsd:
      opportunity.fatalMismatchPnlUsd == null ? null : Math.max(0, -opportunity.fatalMismatchPnlUsd),
    realizedPnlUsd: null,
    roi: null,
    polyResolution: null,
    kalshiResolution: null,
    legs: [
      buildIntentLeg(
        intentId,
        firstLeg.venue,
        firstLeg.outcome,
        firstLeg.marketRef,
        firstLeg.tokenId,
        firstLeg.price,
        firstLeg.size,
        firstLeg.targetNotionalUsd,
      ),
      buildIntentLeg(
        intentId,
        secondLeg.venue,
        secondLeg.outcome,
        secondLeg.marketRef,
        secondLeg.tokenId,
        secondLeg.price,
        secondLeg.size,
        secondLeg.targetNotionalUsd,
      ),
    ],
  };
}

function deriveEntrySizingReason(opportunity: LiveOpportunity) {
  if (opportunity.mismatchGuardAction !== "reduce_size") {
    return null;
  }

  return `Notionnel réduit par safeguard mismatch (${opportunity.mismatchRisk ?? "risk n/a"}): taille x${opportunity.mismatchSizeMultiplier}`;
}

function deriveExecutionPrimaryVenue(opportunity: Pick<LiveOpportunity, "legs" | "primaryVenue">): Venue | null {
  if (opportunity.primaryVenue) {
    return opportunity.primaryVenue;
  }

  const venues = new Set(opportunity.legs.map((leg) => leg.venue));
  if (venues.has("kalshi") && venues.has("polymarket")) {
    return "kalshi";
  }

  return opportunity.primaryVenue ?? opportunity.legs[0]?.venue ?? null;
}

export function markIntentStatus(
  intent: OrderIntent,
  status: OrderIntent["status"],
  now: number,
  failureReason?: string | null,
): OrderIntent {
  return {
    ...intent,
    status,
    updatedAt: now,
    failureReason: failureReason === undefined ? intent.failureReason : failureReason,
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
    failureReason: null,
    polyResolution,
    kalshiResolution,
    legs: intent.legs.map((leg) => ({
      ...leg,
      resolvedOutcome: leg.venue === "polymarket" ? polyResolution : kalshiResolution,
    })) as OrderIntent["legs"],
    realizedPnlUsd,
    roi: totalNotional > 0 ? round4(realizedPnlUsd / totalNotional) : null,
  };
}

export function finalizeUnwoundIntent({
  intent,
  now,
  failureReason,
}: {
  intent: OrderIntent;
  now: number;
  failureReason: string | null;
}): OrderIntent {
  const totalNotional = intent.legs.reduce((sum, leg) => {
    if (leg.filledSize <= 0 && leg.filledPrice === null) {
      return sum;
    }

    return sum + calculateLegSpentUsd(leg);
  }, 0);
  const payoutUsd = intent.legs.reduce((sum, leg) => sum + (leg.payoutUsd ?? 0), 0);
  const realizedPnlUsd = round4(payoutUsd - totalNotional);

  return {
    ...intent,
    status: "unwound",
    updatedAt: now,
    resolvedAt: intent.resolvedAt ?? now,
    failureReason,
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
    if (leg.payoutUsd !== null) {
      return sum + leg.payoutUsd;
    }

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
    lastFilledAt: sorted.at(-1)?.filledAt ?? null,
  };
}

export function calculateLegSpentUsd(
  leg: Pick<OrderIntentLeg, "filledSize" | "filledPrice" | "requestedNotionalUsd" | "feeUsd" | "cashAdjustmentUsd">,
) {
  const tradedNotional =
    leg.filledSize > 0 && leg.filledPrice !== null ? leg.filledSize * leg.filledPrice : leg.requestedNotionalUsd;
  return round4(tradedNotional + leg.feeUsd + (leg.cashAdjustmentUsd ?? 0));
}

export function deriveHedgedPairEconomics(legs: OrderIntent["legs"]): {
  guaranteedPayoutUsd: number;
  totalSpentUsd: number;
  netWorstCaseUsd: number;
  polymarketFilledSize: number;
  kalshiFilledSize: number;
  imbalanceSize: number;
} {
  const polymarketLeg = legs.find((leg) => leg.venue === "polymarket");
  const kalshiLeg = legs.find((leg) => leg.venue === "kalshi");
  const polymarketFilledSize = polymarketLeg?.filledSize ?? 0;
  const kalshiFilledSize = kalshiLeg?.filledSize ?? 0;
  const guaranteedPayoutUsd = Math.min(polymarketFilledSize, kalshiFilledSize);
  const totalSpentUsd = legs.reduce((sum, leg) => sum + calculateLegSpentUsd(leg), 0);

  return {
    guaranteedPayoutUsd: round4(guaranteedPayoutUsd),
    totalSpentUsd: round4(totalSpentUsd),
    netWorstCaseUsd: round4(guaranteedPayoutUsd - totalSpentUsd),
    polymarketFilledSize: round4(polymarketFilledSize),
    kalshiFilledSize: round4(kalshiFilledSize),
    imbalanceSize: round4(Math.abs(polymarketFilledSize - kalshiFilledSize)),
  };
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
    cashAdjustmentUsd: 0,
    status: "pending",
    venueOrderId: null,
    payoutUsd: null,
    resolvedOutcome: null,
  };
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
