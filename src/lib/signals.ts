import { calculateKalshiFee, calculatePolymarketFee } from "@/lib/fees";
import type {
  KalshiQuote,
  PairCombination,
  PairSignal,
  PaperSettings,
  PolymarketQuote,
} from "@/lib/types";

type SignalContext = {
  polymarket: PolymarketQuote;
  kalshi: KalshiQuote;
  settings: PaperSettings;
  lastEntryCosts: Partial<Record<PairCombination, number>>;
};

export function buildSignals({
  polymarket,
  kalshi,
  settings,
  lastEntryCosts,
}: SignalContext): PairSignal[] {
  return [
    buildSignal({
      combination: "POLY_UP_KALSHI_NO",
      label: "Poly Up + Kalshi No",
      polyPrice: polymarket.outcomes.up.buyPrice,
      polyDepth: polymarket.outcomes.up.depth,
      polyOutcome: "UP",
      kalshiPrice: kalshi.outcomes.no.buyPrice,
      kalshiDepth: kalshi.outcomes.no.depth,
      kalshiOutcome: "NO",
      polymarket,
      kalshi,
      settings,
      lastEntryCosts,
    }),
    buildSignal({
      combination: "POLY_DOWN_KALSHI_YES",
      label: "Poly Down + Kalshi Yes",
      polyPrice: polymarket.outcomes.down.buyPrice,
      polyDepth: polymarket.outcomes.down.depth,
      polyOutcome: "DOWN",
      kalshiPrice: kalshi.outcomes.yes.buyPrice,
      kalshiDepth: kalshi.outcomes.yes.depth,
      kalshiOutcome: "YES",
      polymarket,
      kalshi,
      settings,
      lastEntryCosts,
    }),
  ];
}

function buildSignal({
  combination,
  label,
  polyPrice,
  polyDepth,
  polyOutcome,
  kalshiPrice,
  kalshiDepth,
  kalshiOutcome,
  polymarket,
  kalshi,
  settings,
  lastEntryCosts,
}: {
  combination: PairCombination;
  label: string;
  polyPrice: number | null;
  polyDepth: number | null;
  polyOutcome: "UP" | "DOWN";
  kalshiPrice: number | null;
  kalshiDepth: number | null;
  kalshiOutcome: "YES" | "NO";
  polymarket: PolymarketQuote;
  kalshi: KalshiQuote;
  settings: PaperSettings;
  lastEntryCosts: Partial<Record<PairCombination, number>>;
}): PairSignal {
  const missingReason = getMissingReason(polyPrice, kalshiPrice, polyDepth, kalshiDepth);
  if (missingReason) {
    return {
      combination,
      label,
      grossCost: null,
      threshold: settings.grossEntryThreshold,
      thresholdMet: false,
      eligible: false,
      units: 0,
      maxAffordableUnits: 0,
      maxDepthUnits: 0,
      estimatedFees: 0,
      improvementFromLastEntry: null,
      reason: missingReason,
      legs: [
        {
          venue: "polymarket",
          outcome: polyOutcome,
          price: polyPrice,
          depth: polyDepth,
          marketRef: polymarket.ref.id,
        },
        {
          venue: "kalshi",
          outcome: kalshiOutcome,
          price: kalshiPrice,
          depth: kalshiDepth,
          marketRef: kalshi.ref.id,
        },
      ],
    };
  }

  const safePolyPrice = polyPrice as number;
  const safeKalshiPrice = kalshiPrice as number;
  const safePolyDepth = polyDepth as number;
  const safeKalshiDepth = kalshiDepth as number;
  const grossCost = safePolyPrice + safeKalshiPrice;
  const maxAffordableUnits = Math.floor(settings.budgetPerTrade / grossCost);
  const maxDepthUnits = Math.floor(Math.min(safePolyDepth, safeKalshiDepth));
  const units = Math.min(maxAffordableUnits, maxDepthUnits);
  const thresholdMet = grossCost <= settings.grossEntryThreshold;
  const estimatedFees =
    calculatePolymarketFee({
      shares: units,
      price: safePolyPrice,
      feeRate: polymarket.feeRate,
      exponent: polymarket.feeExponent,
    }) +
    calculateKalshiFee({
      contracts: units,
      price: safeKalshiPrice,
      feeMultiplier: kalshi.feeMultiplier,
    });

  const previousCost = lastEntryCosts[combination];
  const improvementFromLastEntry =
    previousCost === undefined ? null : round4(previousCost - grossCost);
  const meetsImprovement =
    previousCost === undefined || grossCost <= previousCost - settings.reentryImprovement;

  let reason: string | null = null;
  if (!thresholdMet) {
    reason = "Seuil brut non atteint";
  } else if (units < settings.minOrderSize) {
    reason = "Taille minimum non atteinte";
  } else if (!meetsImprovement) {
    reason = "Pas d'amélioration suffisante";
  }

  return {
    combination,
    label,
    grossCost: round4(grossCost),
    threshold: settings.grossEntryThreshold,
    thresholdMet,
    eligible: thresholdMet && units >= settings.minOrderSize && meetsImprovement,
    units,
    maxAffordableUnits,
    maxDepthUnits,
    estimatedFees: round4(estimatedFees),
    improvementFromLastEntry,
    reason,
    legs: [
      {
        venue: "polymarket",
        outcome: polyOutcome,
        price: safePolyPrice,
        depth: safePolyDepth,
        marketRef: polymarket.ref.id,
      },
      {
        venue: "kalshi",
        outcome: kalshiOutcome,
        price: safeKalshiPrice,
        depth: safeKalshiDepth,
        marketRef: kalshi.ref.id,
      },
    ],
  };
}

function getMissingReason(
  polyPrice: number | null,
  kalshiPrice: number | null,
  polyDepth: number | null,
  kalshiDepth: number | null,
) {
  if (polyPrice === null || kalshiPrice === null) {
    return "Prix incomplets";
  }

  if (polyDepth === null || kalshiDepth === null) {
    return "Profondeur indisponible";
  }

  return null;
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
