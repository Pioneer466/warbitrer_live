import { polymarketNetSharesBought } from "@/lib/fees";
import type {
  PairSignal,
  PaperTrade,
  PaperTradeLeg,
  PolymarketQuote,
  KalshiQuote,
  Resolution,
} from "@/lib/types";

export function createTradeFromSignal({
  signal,
  polymarket,
  kalshi,
  enteredAt,
  slotKey,
  slotStartTs,
  slotEndTs,
}: {
  signal: PairSignal;
  polymarket: PolymarketQuote;
  kalshi: KalshiQuote;
  enteredAt: number;
  slotKey: string;
  slotStartTs: number;
  slotEndTs: number;
}): PaperTrade {
  if (
    !signal.eligible ||
    signal.grossCost === null ||
    signal.legs.some((leg) => leg.price === null || leg.depth === null)
  ) {
    throw new Error("Impossible de créer un trade paper sans deux jambes exécutables sur le même créneau");
  }

  const tradeId = crypto.randomUUID();
  const [polyLegSignal, kalshiLegSignal] = signal.legs;
  const polyFeeUsd = signal.estimatedFees > 0 && polyLegSignal.price !== null
    ? polymarketFeeUsd(signal, polyLegSignal.price, polymarket.feeRate, polymarket.feeExponent)
    : 0;
  const kalshiFeeUsd = signal.estimatedFees - polyFeeUsd;
  const polyNetShares = polymarketNetSharesBought(signal.units, polyLegSignal.price ?? 0, polyFeeUsd);

  const polyLeg: PaperTradeLeg = {
    id: crypto.randomUUID(),
    tradeId,
    venue: "polymarket",
    outcome: polyLegSignal.outcome,
    marketRef: polyLegSignal.marketRef,
    price: polyLegSignal.price ?? 0,
    units: signal.units,
    grossCost: round4((polyLegSignal.price ?? 0) * signal.units),
    feeUsd: round4(polyFeeUsd),
    feeShares: round4(polyLegSignal.price ? polyFeeUsd / polyLegSignal.price : 0),
    netShares: round4(polyNetShares),
    payout: null,
    resolvedOutcome: null,
    status: "open",
  };

  const kalshiLeg: PaperTradeLeg = {
    id: crypto.randomUUID(),
    tradeId,
    venue: "kalshi",
    outcome: kalshiLegSignal.outcome,
    marketRef: kalshiLegSignal.marketRef,
    price: kalshiLegSignal.price ?? 0,
    units: signal.units,
    grossCost: round4((kalshiLegSignal.price ?? 0) * signal.units),
    feeUsd: round4(kalshiFeeUsd),
    feeShares: 0,
    netShares: signal.units,
    payout: null,
    resolvedOutcome: null,
    status: "open",
  };

  const capitalDeployed = round4(polyLeg.grossCost + kalshiLeg.grossCost + kalshiLeg.feeUsd);
  const theoreticalSameResolutionProfit = round4(Math.min(polyLeg.netShares, kalshiLeg.netShares) - capitalDeployed);

  return {
    id: tradeId,
    slotKey,
    slotStartTs,
    slotEndTs,
    enteredAt,
    resolvedAt: null,
    combination: signal.combination,
    status: "open",
    grossPairCost: signal.grossCost ?? 0,
    thresholdMet: signal.thresholdMet,
    units: signal.units,
    budgetAllocated: round4((signal.grossCost ?? 0) * signal.units),
    capitalDeployed,
    feesTotal: round4(polyLeg.feeUsd + kalshiLeg.feeUsd),
    realizedPnl: null,
    roi: null,
    theoreticalSameResolutionProfit,
    polyResolution: null,
    kalshiResolution: null,
    legs: [polyLeg, kalshiLeg],
  };
}

export function settleTrade({
  trade,
  polyResolution,
  kalshiResolution,
  resolvedAt,
}: {
  trade: PaperTrade;
  polyResolution: "UP" | "DOWN";
  kalshiResolution: "YES" | "NO";
  resolvedAt: number;
}): PaperTrade {
  const settledLegs = trade.legs.map((leg) => settleLeg(leg, polyResolution, kalshiResolution));
  const payout = settledLegs.reduce((sum, leg) => sum + (leg.payout ?? 0), 0);
  const realizedPnl = round4(payout - trade.capitalDeployed);
  const roi = trade.capitalDeployed > 0 ? round4(realizedPnl / trade.capitalDeployed) : 0;

  return {
    ...trade,
    status: "resolved",
    resolvedAt,
    polyResolution,
    kalshiResolution,
    realizedPnl,
    roi,
    legs: settledLegs,
  };
}

function settleLeg(
  leg: PaperTradeLeg,
  polyResolution: "UP" | "DOWN",
  kalshiResolution: "YES" | "NO",
): PaperTradeLeg {
  const winningResolution = leg.venue === "polymarket" ? polyResolution : kalshiResolution;
  const won = leg.outcome === winningResolution;
  const payout = won ? leg.netShares : 0;

  return {
    ...leg,
    payout: round4(payout),
    resolvedOutcome: winningResolution as Resolution,
    status: won ? "won" : "lost",
  };
}

function polymarketFeeUsd(
  signal: PairSignal,
  price: number,
  feeRate: number,
  feeExponent: number,
) {
  const polyEstimateShare = signal.legs[0].venue === "polymarket" ? signal.legs[0] : signal.legs[1];
  if (polyEstimateShare.price === null) {
    return 0;
  }

  const quantity = signal.units;
  return round4(quantity * price * feeRate * Math.pow(price * (1 - price), feeExponent));
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
