import {
  applyKalshiPrimaryDepthSafetyFactor,
  deriveBalancedPayoutPairSize,
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
  mismatchGuardAction: LiveOpportunity["mismatchGuardAction"];
  mismatchSizeMultiplier: number;
  referencePayoutCount: number | null;
  deadZoneDistanceBps: number | null;
  deadZoneWidthBps: number | null;
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

type MismatchGuardBaseMetrics = Omit<
  MismatchGuardMetrics,
  | "mismatchGuardAction"
  | "mismatchSizeMultiplier"
  | "referencePayoutCount"
  | "deadZoneDistanceBps"
  | "deadZoneWidthBps"
  | "mismatchRisk"
  | "mismatchGuardReason"
> & {
  activeMinMoveBps: number;
  mismatchPhase: MismatchGuardPhase;
  tooEarly: boolean;
  disagreementHigh: boolean;
  disagreementMedium: boolean;
  missingReferenceSignal: boolean;
  hasAnyMismatchSignal: boolean;
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
  const mismatchGuardBase = computeMismatchGuardBase(polymarket, kalshi, settings, secondsElapsed);

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
      mismatchGuard: computeMismatchGuard(mismatchGuardBase, "POLY_UP_KALSHI_NO", settings),
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
      mismatchGuard: computeMismatchGuard(mismatchGuardBase, "POLY_DOWN_KALSHI_YES", settings),
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
  const targetPairBudgetUsd = settings.maxPairNotionalUsd * mismatchGuard.mismatchSizeMultiplier;
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
  const safetyAdjustedKalshiDepth = applyKalshiPrimaryDepthSafetyFactor(
    sizingKalshiDepth,
    settings.kalshiPrimaryDepthSafetyFactor,
  );
  const effectiveKalshiDepth = getVenueExecutableDepth(
    "kalshi",
    safetyAdjustedKalshiDepth,
    settings.kalshiDepthHeadroomContracts,
  );
  const grossCost = polyPrice !== null && kalshiPrice !== null ? round4(polyPrice + kalshiPrice) : null;
  const balancedSizing = deriveBalancedPayoutPairSize({
    targetPairBudgetUsd,
    maxLegCapitalShare: settings.maxLegCapitalShare,
    pairSizeCap: getKalshiPrimaryMultiClipCapacity(
      settings.kalshiPrimaryMaxClipContracts,
      settings.kalshiPrimaryMaxClips,
    ),
    polymarket: {
      price: polyPrice,
      depth: polyDepth,
      minOrderSize: polyMinOrderSize,
      fallbackMinOrderSize: settings.minOrderSize,
      feeRateBps: polyFeeRateBps,
    },
    kalshi: {
      price: kalshiPrice,
      depth: safetyAdjustedKalshiDepth,
      minOrderSize: kalshiMinOrderSize,
      fallbackMinOrderSize: 1,
      feeMultiplier: kalshi.feeMultiplier,
    },
    kalshiDepthHeadroomContracts: settings.kalshiDepthHeadroomContracts,
  });
  const polyUnits = balancedSizing.polySize;
  const kalshiUnits = balancedSizing.kalshiSize;
  const polyTargetNotionalUsd = balancedSizing.polyNotionalUsd;
  const kalshiTargetNotionalUsd = balancedSizing.kalshiNotionalUsd;
  const estimatedFees = balancedSizing.polyFeeUsd + balancedSizing.kalshiFeeUsd;

  if (grossCost !== null && grossCost > settings.grossEntryThreshold) {
    reasons.push("Seuil brut non atteint");
  }
  if (balancedSizing.polyMaxSize <= 0 && polyDepth !== null) {
    reasons.push("Liquidité Polymarket insuffisante");
  }
  if (balancedSizing.kalshiMaxSize <= 0 && (effectiveKalshiDepth !== null || cumulativeKalshiDepth !== null)) {
    reasons.push(
      settings.kalshiDepthHeadroomContracts > 0
        ? `Liquidité Kalshi insuffisante après headroom (${settings.kalshiDepthHeadroomContracts} contrats)`
        : "Liquidité Kalshi insuffisante",
    );
  }
  if (
    polyPrice !== null &&
    kalshiPrice !== null &&
    polyDepth !== null &&
    kalshiDepth !== null &&
    balancedSizing.polyMaxSize > 0 &&
    balancedSizing.kalshiMaxSize > 0 &&
    balancedSizing.commonSize <= 0
  ) {
    reasons.push("Budget/profit insuffisant frais inclus");
  }

  const polyBalance = balances.find((balance) => balance.venue === "polymarket");
  const kalshiBalance = balances.find((balance) => balance.venue === "kalshi");
  if (!polyBalance || polyBalance.availableBalanceUsd + ORDER_SIZE_TOLERANCE < balancedSizing.polyCostUsd) {
    reasons.push("Solde Polymarket insuffisant");
  }
  if (!kalshiBalance || kalshiBalance.availableBalanceUsd + ORDER_SIZE_TOLERANCE < balancedSizing.kalshiCostUsd) {
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

  const projectedNetProfitUsd = grossCost === null ? null : balancedSizing.projectedNetProfitUsd;
  const projectedNetReturn = grossCost === null ? null : balancedSizing.projectedNetReturn;

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
    mismatchGuardAction: mismatchGuard.mismatchGuardAction,
    mismatchSizeMultiplier: mismatchGuard.mismatchSizeMultiplier,
    referencePayoutCount: mismatchGuard.referencePayoutCount,
    deadZoneDistanceBps: mismatchGuard.deadZoneDistanceBps,
    deadZoneWidthBps: mismatchGuard.deadZoneWidthBps,
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
        feeEstimateUsd: balancedSizing.polyFeeUsd,
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
        feeEstimateUsd: balancedSizing.kalshiFeeUsd,
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

function computeMismatchGuardBase(
  polymarket: PolymarketQuote,
  kalshi: KalshiQuote,
  settings: StrategyConfig,
  secondsElapsed: number | null,
): MismatchGuardBaseMetrics {
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
  const disagreementHigh =
    venueDisagreementPct !== null && venueDisagreementPct > mismatchGuardMaxVenueDisagreementPct;
  const disagreementMedium =
    venueDisagreementPct !== null &&
    venueDisagreementPct > mismatchGuardMaxVenueDisagreementPct * 0.6;
  const missingReferenceSignal =
    chainlinkLivePriceUsd === null ||
    observedSlotOpenPriceUsd === null ||
    kalshiTargetPriceUsd === null;
  const hasAnyMismatchSignal =
    secondsElapsed !== null ||
    venueDisagreementPct !== null ||
    chainlinkMoveBps !== null ||
    openDriftBps !== null ||
    missingReferenceSignal;

  return {
    venueDisagreementPct,
    secondsElapsedInSlot: secondsElapsed !== null ? round4(secondsElapsed) : null,
    chainlinkMoveBps,
    openDriftBps,
    chainlinkLivePriceUsd,
    observedSlotOpenPriceUsd,
    kalshiTargetPriceUsd,
    activeMinMoveBps,
    mismatchPhase,
    tooEarly,
    disagreementHigh,
    disagreementMedium,
    missingReferenceSignal,
    hasAnyMismatchSignal,
  };
}

function computeMismatchGuard(
  base: MismatchGuardBaseMetrics,
  combination: PairCombination,
  settings: StrategyConfig,
): MismatchGuardMetrics {
  const deadZone = computeDeadZoneMetrics({
    combination,
    livePrice: base.chainlinkLivePriceUsd,
    observedSlotOpenPrice: base.observedSlotOpenPriceUsd,
    kalshiTargetPrice: base.kalshiTargetPriceUsd,
  });
  const { mismatchGuardEnabled, mismatchGuardMaxVenueDisagreementPct } = settings;

  let action: LiveOpportunity["mismatchGuardAction"] = "allow";
  let sizeMultiplier = 1;
  let mismatchGuardReason: string | null = null;

  if (base.missingReferenceSignal) {
    action = "block";
    mismatchGuardReason = "Garde discordance: données de référence indisponibles";
  } else if (base.disagreementHigh && base.venueDisagreementPct !== null) {
    action = "block";
    mismatchGuardReason = `Garde discordance: désaccord venues élevé (${(base.venueDisagreementPct * 100).toFixed(1)}% > ${(mismatchGuardMaxVenueDisagreementPct * 100).toFixed(1)}%)`;
  } else if (deadZone.insideDeadZone) {
    action = "block";
    mismatchGuardReason = `Garde discordance: zone morte ${formatCombinationForReason(combination)} (${deadZone.referencePayoutCount} paiements proxy)`;
  } else {
    const multiplierCap = computeMismatchSizeMultiplierCap(base, deadZone.deadZoneDistanceBps);
    if (multiplierCap <= 0.25 + ORDER_SIZE_TOLERANCE) {
      action = "block";
      mismatchGuardReason = "Garde discordance: risque medium trop proche (taille x0.25 désactivée)";
    } else if (multiplierCap < 1) {
      action = "reduce_size";
      sizeMultiplier = multiplierCap;
    }
  }

  if (!mismatchGuardEnabled) {
    action = "allow";
    sizeMultiplier = 1;
    mismatchGuardReason = null;
  }

  const mismatchRisk: LiveOpportunity["mismatchRisk"] =
    action === "block"
      ? "high"
      : action === "reduce_size"
        ? "medium"
        : base.hasAnyMismatchSignal
          ? "low"
          : null;

  return {
    mismatchGuardAction: action,
    mismatchSizeMultiplier: sizeMultiplier,
    referencePayoutCount: deadZone.referencePayoutCount,
    deadZoneDistanceBps: deadZone.deadZoneDistanceBps,
    deadZoneWidthBps: deadZone.deadZoneWidthBps,
    mismatchRisk,
    venueDisagreementPct: base.venueDisagreementPct,
    secondsElapsedInSlot: base.secondsElapsedInSlot,
    chainlinkMoveBps: base.chainlinkMoveBps,
    openDriftBps: base.openDriftBps,
    chainlinkLivePriceUsd: base.chainlinkLivePriceUsd,
    observedSlotOpenPriceUsd: base.observedSlotOpenPriceUsd,
    kalshiTargetPriceUsd: base.kalshiTargetPriceUsd,
    mismatchGuardReason,
  };
}

function computeMismatchSizeMultiplierCap(
  base: MismatchGuardBaseMetrics,
  deadZoneDistanceBps: number | null,
) {
  let multiplierCap = 1;

  if (deadZoneDistanceBps !== null && base.activeMinMoveBps > 0) {
    if (deadZoneDistanceBps <= base.activeMinMoveBps) {
      multiplierCap = Math.min(multiplierCap, 0.25);
    } else if (deadZoneDistanceBps <= base.activeMinMoveBps * 2) {
      multiplierCap = Math.min(multiplierCap, 0.5);
    }
  }

  if (base.tooEarly) {
    multiplierCap = Math.min(multiplierCap, 0.25);
  }

  if (base.disagreementMedium) {
    multiplierCap = Math.min(multiplierCap, 0.5);
  }

  return multiplierCap;
}

function computeDeadZoneMetrics({
  combination,
  livePrice,
  observedSlotOpenPrice,
  kalshiTargetPrice,
}: {
  combination: PairCombination;
  livePrice: number | null;
  observedSlotOpenPrice: number | null;
  kalshiTargetPrice: number | null;
}) {
  if (livePrice === null || observedSlotOpenPrice === null || kalshiTargetPrice === null) {
    return {
      referencePayoutCount: null,
      deadZoneDistanceBps: null,
      deadZoneWidthBps: null,
      insideDeadZone: false,
    };
  }

  const referencePayoutCount = countReferencePayouts(
    combination,
    livePrice,
    observedSlotOpenPrice,
    kalshiTargetPrice,
  );
  const deadZoneBounds = getDeadZoneBounds(combination, observedSlotOpenPrice, kalshiTargetPrice);
  if (!deadZoneBounds) {
    return {
      referencePayoutCount,
      deadZoneDistanceBps: null,
      deadZoneWidthBps: 0,
      insideDeadZone: false,
    };
  }

  const insideDeadZone =
    combination === "POLY_UP_KALSHI_NO"
      ? livePrice > deadZoneBounds.lower && livePrice <= deadZoneBounds.upper
      : livePrice >= deadZoneBounds.lower && livePrice < deadZoneBounds.upper;
  const deadZoneDistanceBps = insideDeadZone
    ? 0
    : livePrice < deadZoneBounds.lower
      ? computeMoveBps(deadZoneBounds.lower, livePrice)
      : computeMoveBps(deadZoneBounds.upper, livePrice);

  return {
    referencePayoutCount,
    deadZoneDistanceBps,
    deadZoneWidthBps: computeMoveBps(deadZoneBounds.lower, deadZoneBounds.upper),
    insideDeadZone,
  };
}

function countReferencePayouts(
  combination: PairCombination,
  livePrice: number,
  observedSlotOpenPrice: number,
  kalshiTargetPrice: number,
) {
  const polymarketWins =
    combination === "POLY_UP_KALSHI_NO"
      ? livePrice > observedSlotOpenPrice
      : livePrice < observedSlotOpenPrice;
  const kalshiWins =
    combination === "POLY_UP_KALSHI_NO"
      ? livePrice <= kalshiTargetPrice
      : livePrice > kalshiTargetPrice;

  return Number(polymarketWins) + Number(kalshiWins);
}

function getDeadZoneBounds(
  combination: PairCombination,
  observedSlotOpenPrice: number,
  kalshiTargetPrice: number,
) {
  if (combination === "POLY_UP_KALSHI_NO" && kalshiTargetPrice < observedSlotOpenPrice) {
    return {
      lower: kalshiTargetPrice,
      upper: observedSlotOpenPrice,
    };
  }

  if (combination === "POLY_DOWN_KALSHI_YES" && observedSlotOpenPrice < kalshiTargetPrice) {
    return {
      lower: observedSlotOpenPrice,
      upper: kalshiTargetPrice,
    };
  }

  return null;
}

function formatCombinationForReason(combination: PairCombination) {
  return combination === "POLY_UP_KALSHI_NO" ? "Poly Up + Kalshi No" : "Poly Down + Kalshi Yes";
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
