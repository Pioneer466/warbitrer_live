import { FIXED_TRADE_NOTIONAL_USD } from "@/lib/constants";
import { calculateKalshiFee, calculatePolymarketFee, polymarketNetSharesBought } from "@/lib/fees";
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
    signal.legs.some((leg) => leg.price === null || leg.depth === null || leg.units <= 0)
  ) {
    throw new Error("Impossible de créer un trade paper sans deux jambes exécutables sur le même créneau");
  }

  const tradeId = crypto.randomUUID();
  const [polyLegSignal, kalshiLegSignal] = signal.legs;
  const polyPrice = polyLegSignal.price as number;
  const kalshiPrice = kalshiLegSignal.price as number;
  const polyUnits = polyLegSignal.units;
  const kalshiUnits = kalshiLegSignal.units;
  const polyFeeUsd = round4(
    calculatePolymarketFee({
      shares: polyUnits,
      price: polyPrice,
      feeRate: polymarket.feeRate,
      exponent: polymarket.feeExponent,
    }),
  );
  const kalshiFeeUsd = round4(
    calculateKalshiFee({
      contracts: kalshiUnits,
      price: kalshiPrice,
      feeMultiplier: kalshi.feeMultiplier,
    }),
  );
  const polyNetShares = polymarketNetSharesBought(polyUnits, polyPrice, polyFeeUsd);

  const polyLeg: PaperTradeLeg = {
    id: crypto.randomUUID(),
    tradeId,
    venue: "polymarket",
    outcome: polyLegSignal.outcome,
    marketRef: polyLegSignal.marketRef,
    price: polyPrice,
    units: polyUnits,
    grossCost: round4(polyLegSignal.stakeUsd),
    feeUsd: polyFeeUsd,
    feeShares: round4(polyPrice ? polyFeeUsd / polyPrice : 0),
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
    price: kalshiPrice,
    units: kalshiUnits,
    grossCost: round4(kalshiLegSignal.stakeUsd),
    feeUsd: kalshiFeeUsd,
    feeShares: 0,
    netShares: round4(kalshiUnits),
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
    units: 1,
    budgetAllocated: FIXED_TRADE_NOTIONAL_USD,
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

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
