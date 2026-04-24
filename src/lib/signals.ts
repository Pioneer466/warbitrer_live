import {
  calculateKalshiFee,
  calculatePolymarketFee,
  deriveAlignedPairSize,
  deriveVenueTargetSize,
  getKalshiPrimaryMultiClipCapacity,
  getVenueExecutableDepth,
} from "@/lib/fees";
import {
  computeKalshiBuyDepthWithinPriceRange,
  KALSHI_ORDER_PRICE_STEP_USD,
  normalizeKalshiOrderPrice,
} from "@/lib/kalshi";
import type {
  KalshiQuote,
  LiveOpportunity,
  OutcomeQuote,
  PairCombination,
  PolymarketQuote,
  StrategyConfig,
  Venue,
  VenueBalance,
} from "@/lib/types";

type SignalContext = {
  slotKey: string;
  now: number;
  slotStartTs?: number;
  polymarket: PolymarketQuote;
  kalshi: KalshiQuote;
  settings: StrategyConfig;
  balances: VenueBalance[];
  lastEntryCosts: Partial<Record<PairCombination, number>>;
  secondsRemaining?: number;
};

type MismatchGuardMetrics = {
  mismatchRisk: LiveOpportunity["mismatchRisk"];
  venueDisagreementPct: number | null;
  secondsElapsedInSlot: number | null;
  chainlinkMoveBps: number | null;
  openDriftBps: number | null;
  chainlinkLivePriceUsd: number | null;
  observedSlotOpenPriceUsd: number | null;
  kalshiTargetPriceUsd: number | null;
  mismatchGuardReason: string | null;
};

type MismatchGuardPhase = "standard" | "late";

const ORDER_SIZE_TOLERANCE = 1e-6;

export function buildSignals({
  slotKey,
  now,
  slotStartTs,
  polymarket,
  kalshi,
  settings,
  balances,
  lastEntryCosts,
  secondsRemaining,
}: SignalContext): LiveOpportunity[] {
  const marketAlignmentReason =
    getTerminalMarketReason(polymarket, kalshi) ??
    getLateEntryReason(secondsRemaining, settings.entryCutoffSeconds) ??
    getMarketAlignmentReason(polymarket, kalshi);

  // Seconds elapsed since slot start — used by mismatch guard time filter.
  // Prefer exact slotStartTs; fall back to 900s slot duration minus secondsRemaining.
  const secondsElapsed: number | null =
    slotStartTs != null
      ? Math.max(0, (now - slotStartTs) / 1000)
      : secondsRemaining != null
        ? Math.max(0, 900 - secondsRemaining)
        : null;
  const mismatchGuard = computeMismatchGuard(polymarket, kalshi, settings, secondsElapsed);

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
      mismatchGuard,
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
      mismatchGuard,
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
  mismatchGuard,
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
  mismatchGuard: MismatchGuardMetrics;
}): LiveOpportunity {
  const targetLegBudgetUsd = settings.maxPairNotionalUsd / 2;
  const reasons: string[] = [];
  const effectiveKalshiDepth = getVenueExecutableDepth(
    "kalshi",
    kalshiDepth,
    settings.kalshiDepthHeadroomContracts,
  );

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
  const kalshiMaxBuyPrice =
    kalshiPrice === null
      ? null
      : normalizeKalshiOrderPrice(
          kalshiPrice + settings.kalshiPrimaryPriceTicksSlippage * KALSHI_ORDER_PRICE_STEP_USD,
          "BUY",
        );
  const cumulativeKalshiDepth =
    kalshiPrice === null
      ? null
      : computeKalshiBuyDepthWithinPriceRange(kalshi.orderbookLevels, kalshiOutcome, kalshiMaxBuyPrice);
  const sizingKalshiDepth = cumulativeKalshiDepth ?? kalshiDepth;
  const grossCost = polyPrice !== null && kalshiPrice !== null ? round4(polyPrice + kalshiPrice) : null;
  const alignedSizing = deriveAlignedPairSize({
    targetLegNotionalUsd: targetLegBudgetUsd,
    pairSizeCap: getKalshiPrimaryMultiClipCapacity(
      settings.kalshiPrimaryMaxClipContracts,
      settings.kalshiPrimaryMaxClips,
    ),
    polymarket: {
      price: polyPrice,
      depth: polyDepth,
      minOrderSize: polyMinOrderSize,
      fallbackMinOrderSize: settings.minOrderSize,
    },
    kalshi: {
      price: kalshiPrice,
      depth: sizingKalshiDepth,
      minOrderSize: kalshiMinOrderSize,
      fallbackMinOrderSize: 1,
    },
    kalshiDepthHeadroomContracts: settings.kalshiDepthHeadroomContracts,
  });
  const polyBudgetUnits =
    polyPrice === null
      ? 0
      : deriveVenueTargetSize("polymarket", targetLegBudgetUsd, polyPrice, polyMinOrderSize, settings.minOrderSize);
  const polyUnits = alignedSizing.polySize;
  const kalshiUnits = alignedSizing.kalshiSize;
  const polyTargetNotionalUsd = polyPrice === null ? 0 : round4(polyUnits * polyPrice);
  const kalshiTargetNotionalUsd = kalshiPrice === null ? 0 : round4(kalshiUnits * kalshiPrice);
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
  if (polyBudgetUnits > 0 && alignedSizing.polyMaxSize <= 0) {
    reasons.push("Taille minimum Polymarket non atteinte");
  }
  if (alignedSizing.polyMaxSize <= 0 && polyDepth !== null) {
    reasons.push("Liquidité Polymarket insuffisante");
  }
  if (alignedSizing.kalshiMaxSize <= 0 && (effectiveKalshiDepth !== null || cumulativeKalshiDepth !== null)) {
    reasons.push(
      settings.kalshiDepthHeadroomContracts > 0
        ? `Liquidité Kalshi insuffisante après headroom (${settings.kalshiDepthHeadroomContracts} contrats)`
        : "Liquidité Kalshi insuffisante",
    );
  }

  const polyBalance = balances.find((balance) => balance.venue === "polymarket");
  const kalshiBalance = balances.find((balance) => balance.venue === "kalshi");
  if (!polyBalance || polyBalance.availableBalanceUsd + ORDER_SIZE_TOLERANCE < polyTargetNotionalUsd) {
    reasons.push("Solde Polymarket insuffisant");
  }
  if (!kalshiBalance || kalshiBalance.availableBalanceUsd + ORDER_SIZE_TOLERANCE < kalshiTargetNotionalUsd) {
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

  const { mismatchRisk, venueDisagreementPct, mismatchGuardReason } = mismatchGuard;
  if (mismatchGuardReason) {
    reasons.push(mismatchGuardReason);
  }

  const minimumWinningPayout = Math.min(polyUnits, kalshiUnits);
  const capitalDeployed = round4(polyTargetNotionalUsd + kalshiTargetNotionalUsd + estimatedFees);
  const projectedNetProfitUsd =
    grossCost === null ? null : round4(minimumWinningPayout - capitalDeployed);
  const projectedNetReturn =
    projectedNetProfitUsd === null || capitalDeployed <= 0
      ? null
      : round4(projectedNetProfitUsd / capitalDeployed);

  const primaryVenue = polyDepth === null || kalshiDepth === null ? null : choosePrimaryVenue();

  return {
    asset: polymarket.ref.asset,
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
    mismatchRisk,
    venueDisagreementPct,
    secondsElapsedInSlot: mismatchGuard.secondsElapsedInSlot,
    chainlinkMoveBps: mismatchGuard.chainlinkMoveBps,
    openDriftBps: mismatchGuard.openDriftBps,
    chainlinkLivePriceUsd: mismatchGuard.chainlinkLivePriceUsd,
    observedSlotOpenPriceUsd: mismatchGuard.observedSlotOpenPriceUsd,
    kalshiTargetPriceUsd: mismatchGuard.kalshiTargetPriceUsd,
    legs: [
      {
        venue: "polymarket",
        outcome: polyOutcome,
        marketRef: polymarket.ref.conditionId ?? polymarket.ref.id,
        tokenId: polyTokenId,
        price: polyPrice,
        depth: polyDepth,
        targetNotionalUsd: polyTargetNotionalUsd,
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
        depth: sizingKalshiDepth,
        targetNotionalUsd: kalshiTargetNotionalUsd,
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

function choosePrimaryVenue(): Venue {
  return "kalshi";
}

function outcomeMidPrice(outcome: OutcomeQuote): number | null {
  if (outcome.midPrice !== null) return outcome.midPrice;
  if (outcome.bestBid !== null && outcome.bestAsk !== null) {
    return (outcome.bestBid + outcome.bestAsk) / 2;
  }
  return null;
}

function computeMismatchGuard(
  polymarket: PolymarketQuote,
  kalshi: KalshiQuote,
  settings: StrategyConfig,
  secondsElapsed: number | null,
): MismatchGuardMetrics {
  const polyUpMid = outcomeMidPrice(polymarket.outcomes.up);
  const kalshiYesMid = outcomeMidPrice(kalshi.outcomes.yes);
  const venueDisagreementPct =
    polyUpMid !== null && kalshiYesMid !== null ? round4(Math.abs(polyUpMid - kalshiYesMid)) : null;

  const chainlinkLivePriceUsd = polymarket.chainlinkLivePriceUsd;
  const observedSlotOpenPriceUsd = polymarket.observedSlotOpenPriceUsd;
  const kalshiTargetPriceUsd = kalshi.targetPriceUsd;
  const chainlinkMoveBps = computeMoveBps(observedSlotOpenPriceUsd, chainlinkLivePriceUsd);
  const openDriftBps = computeMoveBps(kalshiTargetPriceUsd, observedSlotOpenPriceUsd);

  const {
    mismatchGuardEnabled,
    mismatchGuardMinElapsedSeconds,
    mismatchGuardMinMoveBps,
    mismatchGuardPhase2StartSeconds,
    mismatchGuardPhase2MinMoveBps,
    mismatchGuardMaxVenueDisagreementPct,
  } = settings;
  const mismatchPhase: MismatchGuardPhase =
    secondsElapsed !== null && secondsElapsed >= mismatchGuardPhase2StartSeconds
      ? "late"
      : "standard";
  const activeMinMoveBps =
    mismatchPhase === "late" ? mismatchGuardPhase2MinMoveBps : mismatchGuardMinMoveBps;

  const tooEarly = secondsElapsed !== null && secondsElapsed < mismatchGuardMinElapsedSeconds;
  const moveTooSmall = chainlinkMoveBps !== null && chainlinkMoveBps < activeMinMoveBps;
  const openDriftDominant =
    openDriftBps !== null && chainlinkMoveBps !== null && chainlinkMoveBps <= openDriftBps;
  const disagreementHigh =
    venueDisagreementPct !== null && venueDisagreementPct > mismatchGuardMaxVenueDisagreementPct;
  const disagreementMedium =
    venueDisagreementPct !== null &&
    venueDisagreementPct > mismatchGuardMaxVenueDisagreementPct * 0.6;
  const missingReferenceSignal =
    chainlinkLivePriceUsd === null ||
    observedSlotOpenPriceUsd === null ||
    kalshiTargetPriceUsd === null;

  let mismatchRisk: LiveOpportunity["mismatchRisk"] = null;
  if (missingReferenceSignal) {
    mismatchRisk = "high";
  } else if (
    secondsElapsed !== null ||
    venueDisagreementPct !== null ||
    chainlinkMoveBps !== null ||
    openDriftBps !== null
  ) {
    if (tooEarly || moveTooSmall || openDriftDominant || disagreementHigh) {
      mismatchRisk = "high";
    } else if (
      disagreementMedium ||
      (chainlinkMoveBps !== null && chainlinkMoveBps < activeMinMoveBps * 2) ||
      (openDriftBps !== null && openDriftBps >= activeMinMoveBps * 0.5)
    ) {
      mismatchRisk = "medium";
    } else {
      mismatchRisk = "low";
    }
  }

  let mismatchGuardReason: string | null = null;
  if (mismatchGuardEnabled) {
    if (missingReferenceSignal) {
      mismatchGuardReason = "Garde discordance: données de référence indisponibles";
    } else if (tooEarly && secondsElapsed !== null) {
      mismatchGuardReason = `Garde discordance: créneau trop récent (${Math.round(secondsElapsed)}s < ${mismatchGuardMinElapsedSeconds}s)`;
    } else if (moveTooSmall && chainlinkMoveBps !== null) {
      const phaseLabel = mismatchPhase === "late" ? " en fenêtre tardive" : "";
      mismatchGuardReason = `Garde discordance: mouvement Chainlink trop faible${phaseLabel} (${chainlinkMoveBps.toFixed(2)} bps < ${activeMinMoveBps.toFixed(2)} bps)`;
    } else if (openDriftDominant && openDriftBps !== null && chainlinkMoveBps !== null) {
      mismatchGuardReason = `Garde discordance: écart d'ouverture dominant (${openDriftBps.toFixed(2)} bps >= ${chainlinkMoveBps.toFixed(2)} bps)`;
    } else if (disagreementHigh && venueDisagreementPct !== null) {
      mismatchGuardReason = `Garde discordance: désaccord venues élevé (${(venueDisagreementPct * 100).toFixed(1)}% > ${(mismatchGuardMaxVenueDisagreementPct * 100).toFixed(1)}%)`;
    }
  }

  return {
    mismatchRisk,
    venueDisagreementPct,
    secondsElapsedInSlot: secondsElapsed !== null ? round4(secondsElapsed) : null,
    chainlinkMoveBps,
    openDriftBps,
    chainlinkLivePriceUsd,
    observedSlotOpenPriceUsd,
    kalshiTargetPriceUsd,
    mismatchGuardReason,
  };
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

function getTerminalMarketReason(polymarket: PolymarketQuote, kalshi: KalshiQuote) {
  if (polymarket.resolution !== null) {
    return "Marché Polymarket déjà résolu";
  }

  if (kalshi.resolution !== null) {
    return "Marché Kalshi déjà résolu";
  }

  if (polymarket.status === "closed") {
    return "Marché Polymarket déjà fermé";
  }

  if (kalshi.status !== "active" && kalshi.status !== "open") {
    return `Marché Kalshi non tradable (${kalshi.status})`;
  }

  return null;
}

function getLateEntryReason(secondsRemaining: number | undefined, entryCutoffSeconds: number) {
  if (secondsRemaining !== undefined && secondsRemaining <= entryCutoffSeconds) {
    return `Entrée bloquée sur les ${entryCutoffSeconds} dernières secondes`;
  }

  return null;
}

function computeMoveBps(referencePrice: number | null, currentPrice: number | null) {
  if (referencePrice === null || currentPrice === null || referencePrice <= 0) {
    return null;
  }

  return round4((Math.abs(currentPrice - referencePrice) / referencePrice) * 10_000);
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
