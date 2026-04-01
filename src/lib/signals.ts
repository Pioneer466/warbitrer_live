import { calculateKalshiFee, calculatePolymarketFee, deriveTargetShares } from "@/lib/fees";
import type {
  KalshiQuote,
  LiveOpportunity,
  PairCombination,
  PolymarketQuote,
  StrategyConfig,
  Venue,
  VenueBalance,
} from "@/lib/types";

type SignalContext = {
  slotKey: string;
  now: number;
  polymarket: PolymarketQuote;
  kalshi: KalshiQuote;
  settings: StrategyConfig;
  balances: VenueBalance[];
  lastEntryCosts: Partial<Record<PairCombination, number>>;
  secondsRemaining?: number;
};

export function buildSignals({
  slotKey,
  now,
  polymarket,
  kalshi,
  settings,
  balances,
  lastEntryCosts,
  secondsRemaining,
}: SignalContext): LiveOpportunity[] {
  const marketAlignmentReason =
    getLateEntryReason(secondsRemaining, settings.entryCutoffSeconds) ??
    getMarketAlignmentReason(polymarket, kalshi);

  return [
    buildSignal({
      slotKey,
      now,
      combination: "POLY_UP_KALSHI_NO",
      label: "Poly Up + Kalshi No",
      polyPrice: polymarket.outcomes.up.buyPrice,
      polyDepth: polymarket.outcomes.up.depth,
      polyOutcome: "UP",
      polyMinOrderSize: polymarket.outcomes.up.minOrderSize,
      polyFeeRateBps: polymarket.outcomes.up.feeRateBps ?? polymarket.feeRateBps,
      polyTokenId: polymarket.tokenIds.up,
      kalshiPrice: kalshi.outcomes.no.buyPrice,
      kalshiDepth: kalshi.outcomes.no.depth,
      kalshiOutcome: "NO",
      kalshiMinOrderSize: kalshi.outcomes.no.minOrderSize,
      polymarket,
      kalshi,
      settings,
      balances,
      lastEntryCosts,
      marketAlignmentReason,
    }),
    buildSignal({
      slotKey,
      now,
      combination: "POLY_DOWN_KALSHI_YES",
      label: "Poly Down + Kalshi Yes",
      polyPrice: polymarket.outcomes.down.buyPrice,
      polyDepth: polymarket.outcomes.down.depth,
      polyOutcome: "DOWN",
      polyMinOrderSize: polymarket.outcomes.down.minOrderSize,
      polyFeeRateBps: polymarket.outcomes.down.feeRateBps ?? polymarket.feeRateBps,
      polyTokenId: polymarket.tokenIds.down,
      kalshiPrice: kalshi.outcomes.yes.buyPrice,
      kalshiDepth: kalshi.outcomes.yes.depth,
      kalshiOutcome: "YES",
      kalshiMinOrderSize: kalshi.outcomes.yes.minOrderSize,
      polymarket,
      kalshi,
      settings,
      balances,
      lastEntryCosts,
      marketAlignmentReason,
    }),
  ];
}

function buildSignal({
  slotKey,
  now,
  combination,
  label,
  polyPrice,
  polyDepth,
  polyOutcome,
  polyMinOrderSize,
  polyFeeRateBps,
  polyTokenId,
  kalshiPrice,
  kalshiDepth,
  kalshiOutcome,
  kalshiMinOrderSize,
  polymarket,
  kalshi,
  settings,
  balances,
  lastEntryCosts,
  marketAlignmentReason,
}: {
  slotKey: string;
  now: number;
  combination: PairCombination;
  label: string;
  polyPrice: number | null;
  polyDepth: number | null;
  polyOutcome: "UP" | "DOWN";
  polyMinOrderSize: number | null;
  polyFeeRateBps: number;
  polyTokenId: string;
  kalshiPrice: number | null;
  kalshiDepth: number | null;
  kalshiOutcome: "YES" | "NO";
  kalshiMinOrderSize: number | null;
  polymarket: PolymarketQuote;
  kalshi: KalshiQuote;
  settings: StrategyConfig;
  balances: VenueBalance[];
  lastEntryCosts: Partial<Record<PairCombination, number>>;
  marketAlignmentReason: string | null;
}): LiveOpportunity {
  const targetLegNotionalUsd = settings.maxPairNotionalUsd / 2;
  const reasons: string[] = [];

  if (marketAlignmentReason) {
    reasons.push(marketAlignmentReason);
  }

  if (polyPrice === null || kalshiPrice === null) {
    reasons.push("Prix incomplets");
  }

  if (polyDepth === null || kalshiDepth === null) {
    reasons.push("Profondeur indisponible");
  }

  const safePolyPrice = polyPrice ?? 0;
  const safeKalshiPrice = kalshiPrice ?? 0;
  const grossCost = polyPrice !== null && kalshiPrice !== null ? round4(polyPrice + kalshiPrice) : null;
  const polyUnits =
    polyPrice === null
      ? 0
      : deriveTargetShares(targetLegNotionalUsd, polyPrice, polyMinOrderSize ?? settings.minOrderSize);
  const kalshiUnits =
    kalshiPrice === null
      ? 0
      : deriveTargetShares(targetLegNotionalUsd, kalshiPrice, kalshiMinOrderSize ?? 1);
  const estimatedFees =
    calculatePolymarketFee({
      shares: polyUnits,
      price: safePolyPrice,
      feeRateBps: polyFeeRateBps,
    }) +
    calculateKalshiFee({
      contracts: kalshiUnits,
      price: safeKalshiPrice,
      feeMultiplier: kalshi.feeMultiplier,
    });

  if (grossCost !== null && grossCost > settings.grossEntryThreshold) {
    reasons.push("Seuil brut non atteint");
  }
  if (safePolyPrice > settings.maxLegPrice || safeKalshiPrice > settings.maxLegPrice) {
    reasons.push(`Une jambe dépasse ${settings.maxLegPrice.toFixed(2)}`);
  }
  if (polyDepth !== null && polyUnits > polyDepth) {
    reasons.push("Liquidité Polymarket insuffisante");
  }
  if (kalshiDepth !== null && kalshiUnits > kalshiDepth) {
    reasons.push("Liquidité Kalshi insuffisante");
  }

  const polyBalance = balances.find((balance) => balance.venue === "polymarket");
  const kalshiBalance = balances.find((balance) => balance.venue === "kalshi");
  if (!polyBalance || polyBalance.availableBalanceUsd < targetLegNotionalUsd) {
    reasons.push("Solde Polymarket insuffisant");
  }
  if (!kalshiBalance || kalshiBalance.availableBalanceUsd < targetLegNotionalUsd) {
    reasons.push("Solde Kalshi insuffisant");
  }
  if (polyBalance?.status === "blocked" || kalshiBalance?.status === "blocked") {
    reasons.push("Une venue n’est pas prête pour le live");
  }
  if (polymarket.feedHealth.feedStatus !== "ready") {
    reasons.push("Feed Polymarket stale");
  }
  if (kalshi.feedHealth.feedStatus !== "ready") {
    reasons.push("Feed Kalshi stale");
  }

  const previousCost = lastEntryCosts[combination];
  const improvementFromLastEntry =
    grossCost === null || previousCost === undefined ? null : round4(previousCost - grossCost);
  if (
    grossCost !== null &&
    previousCost !== undefined &&
    grossCost > previousCost - settings.reentryImprovement
  ) {
    reasons.push("Pas d'amélioration suffisante");
  }

  const minimumWinningPayout = Math.min(polyUnits, kalshiUnits);
  const capitalDeployed = settings.maxPairNotionalUsd + estimatedFees;
  const projectedNetProfitUsd =
    grossCost === null ? null : round4(minimumWinningPayout - capitalDeployed);
  const projectedNetReturn =
    projectedNetProfitUsd === null || capitalDeployed <= 0
      ? null
      : round4(projectedNetProfitUsd / capitalDeployed);

  const primaryVenue =
    polyDepth === null || kalshiDepth === null
      ? null
      : choosePrimaryVenue(polyDepth * safePolyPrice, kalshiDepth * safeKalshiPrice);

  return {
    id: `${combination}-${slotKey}-${now}`,
    slotKey,
    capturedAt: now,
    combination,
    label,
    grossCost,
    threshold: settings.grossEntryThreshold,
    thresholdMet: grossCost !== null ? grossCost <= settings.grossEntryThreshold : false,
    eligible: reasons.length === 0,
    primaryVenue,
    improvementFromLastEntry,
    estimatedFeesUsd: round4(estimatedFees),
    projectedNetProfitUsd,
    projectedNetReturn,
    reasons,
    legs: [
      {
        venue: "polymarket",
        outcome: polyOutcome,
        marketRef: polymarket.ref.conditionId ?? polymarket.ref.id,
        tokenId: polyTokenId,
        price: polyPrice,
        depth: polyDepth,
        targetNotionalUsd: targetLegNotionalUsd,
        size: polyUnits,
        tickSize: polymarket.outcomes[polyOutcome === "UP" ? "up" : "down"].tickSize,
        minOrderSize: polyMinOrderSize,
        feeEstimateUsd: round4(
          calculatePolymarketFee({
            shares: polyUnits,
            price: safePolyPrice,
            feeRateBps: polyFeeRateBps,
          }),
        ),
      },
      {
        venue: "kalshi",
        outcome: kalshiOutcome,
        marketRef: kalshi.ref.id,
        price: kalshiPrice,
        depth: kalshiDepth,
        targetNotionalUsd: targetLegNotionalUsd,
        size: kalshiUnits,
        tickSize: kalshi.outcomes[kalshiOutcome === "YES" ? "yes" : "no"].tickSize,
        minOrderSize: kalshiMinOrderSize,
        feeEstimateUsd: round4(
          calculateKalshiFee({
            contracts: kalshiUnits,
            price: safeKalshiPrice,
            feeMultiplier: kalshi.feeMultiplier,
          }),
        ),
      },
    ],
  };
}

function choosePrimaryVenue(polyDepthUsd: number, kalshiDepthUsd: number): Venue {
  return polyDepthUsd <= kalshiDepthUsd ? "polymarket" : "kalshi";
}

function getMarketAlignmentReason(polymarket: PolymarketQuote, kalshi: KalshiQuote) {
  if (!polymarket.slotAligned) {
    return polymarket.availabilityReason ?? "Marché Polymarket du créneau courant indisponible";
  }

  if (!kalshi.slotAligned) {
    return kalshi.availabilityReason ?? "Marché Kalshi du créneau courant indisponible";
  }

  if (
    polymarket.ref.slotKey &&
    kalshi.ref.slotKey &&
    polymarket.ref.slotKey !== kalshi.ref.slotKey
  ) {
    return "Marchés non alignés sur le même créneau";
  }

  return null;
}

function getLateEntryReason(secondsRemaining: number | undefined, entryCutoffSeconds: number) {
  if (secondsRemaining !== undefined && secondsRemaining <= entryCutoffSeconds) {
    return `Entrée bloquée sur les ${entryCutoffSeconds} dernières secondes`;
  }

  return null;
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
