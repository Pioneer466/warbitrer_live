import { FIXED_LEG_NOTIONAL_USD } from "@/lib/constants";
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
  const marketAlignmentReason = getMarketAlignmentReason(polymarket, kalshi);

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
      marketAlignmentReason,
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
      marketAlignmentReason,
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
  marketAlignmentReason,
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
  marketAlignmentReason: string | null;
}): PairSignal {
  const missingReason =
    marketAlignmentReason ?? getMissingReason(polyPrice, kalshiPrice, polyDepth, kalshiDepth);
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
          stakeUsd: FIXED_LEG_NOTIONAL_USD,
          units: 0,
        },
        {
          venue: "kalshi",
          outcome: kalshiOutcome,
          price: kalshiPrice,
          depth: kalshiDepth,
          marketRef: kalshi.ref.id,
          stakeUsd: FIXED_LEG_NOTIONAL_USD,
          units: 0,
        },
      ],
    };
  }

  const safePolyPrice = polyPrice as number;
  const safeKalshiPrice = kalshiPrice as number;
  const safePolyDepth = polyDepth as number;
  const safeKalshiDepth = kalshiDepth as number;
  const grossCost = safePolyPrice + safeKalshiPrice;
  const polyUnits = round6(FIXED_LEG_NOTIONAL_USD / safePolyPrice);
  const kalshiUnits = round6(FIXED_LEG_NOTIONAL_USD / safeKalshiPrice);
  const hasDepth = safePolyDepth >= polyUnits && safeKalshiDepth >= kalshiUnits;
  const thresholdMet = grossCost <= settings.grossEntryThreshold;
  const estimatedFees =
    calculatePolymarketFee({
      shares: polyUnits,
      price: safePolyPrice,
      feeRate: polymarket.feeRate,
      exponent: polymarket.feeExponent,
    }) +
    calculateKalshiFee({
      contracts: kalshiUnits,
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
  } else if (!hasDepth) {
    reason = "Liquidité insuffisante pour exécuter 50$ de chaque côté";
  } else if (!meetsImprovement) {
    reason = "Pas d'amélioration suffisante";
  }

  return {
    combination,
    label,
    grossCost: round4(grossCost),
    threshold: settings.grossEntryThreshold,
    thresholdMet,
    eligible: thresholdMet && hasDepth && meetsImprovement,
    units: thresholdMet && hasDepth ? 1 : 0,
    maxAffordableUnits: 1,
    maxDepthUnits: hasDepth ? 1 : 0,
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
        stakeUsd: FIXED_LEG_NOTIONAL_USD,
        units: polyUnits,
      },
      {
        venue: "kalshi",
        outcome: kalshiOutcome,
        price: safeKalshiPrice,
        depth: safeKalshiDepth,
        marketRef: kalshi.ref.id,
        stakeUsd: FIXED_LEG_NOTIONAL_USD,
        units: kalshiUnits,
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

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function round6(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
