import type { OrderSide, Venue } from "@/lib/types";

type KalshiFeeInput = {
  contracts: number;
  price: number;
  feeMultiplier?: number;
  maker?: boolean;
};

type PolymarketFeeInput = {
  shares: number;
  price: number;
  feeRateBps?: number;
};

export type ExecutableBookLevel = {
  price: number;
  size: number;
};

export type ConsumedBookLevel = ExecutableBookLevel & {
  notionalUsd: number;
  feeUsd: number;
  costUsd: number;
};

type MultiLevelBookInput = {
  levels: ExecutableBookLevel[];
  size: number;
  maxPrice?: number | null;
  depthSafetyFactor?: number;
  depthHeadroom?: number;
};

export type MultiLevelBuyLegInput =
  | (MultiLevelBookInput & {
      venue: "polymarket";
      feeRateBps?: number;
      feeRate?: number;
      feeExponent?: number;
    })
  | (MultiLevelBookInput & {
      venue: "kalshi";
      feeMultiplier?: number;
      maker?: boolean;
    });

export type MultiLevelLegQuote = {
  venue: Venue;
  size: number;
  displayedDepth: number;
  executableDepth: number;
  notionalUsd: number;
  feeUsd: number;
  costUsd: number;
  worstFillNotionalUsd: number;
  worstFillFeeUsd: number;
  worstFillCostUsd: number;
  vwapPrice: number | null;
  limitPrice: number | null;
  consumedLevels: ConsumedBookLevel[];
};

export type MultiLevelPairedQuoteLimitingReason =
  | "invalid_input"
  | "minimum_size"
  | "polymarket_depth"
  | "kalshi_depth"
  | "pair_size_cap"
  | "pair_budget"
  | "max_leg_capital"
  | "polymarket_balance"
  | "kalshi_balance"
  | "polymarket_cost"
  | "kalshi_cost"
  | "absolute_fatal_loss"
  | "probability_weighted_fatal_loss"
  | "fatal_probability"
  | "projected_profit"
  | "projected_return"
  | "conservative_profit"
  | "conservative_return";

type MultiLevelPairedBookInput = Omit<MultiLevelBookInput, "size" | "depthHeadroom"> & {
  balanceUsd?: number | null;
  maxCostUsd?: number | null;
};

export type MultiLevelPairedQuoteInput = {
  targetPairBudgetUsd: number;
  maxLegCapitalShare?: number;
  pairSizeCap?: number | null;
  minPairSize?: number;
  minProjectedNetProfitUsd?: number;
  minProjectedNetReturn?: number;
  minConservativeNetProfitUsd?: number;
  minConservativeNetReturn?: number;
  fatalMismatchProbabilityUpper?: number;
  maxFatalProbabilityShareOfBreakEven?: number;
  maxProbabilityWeightedFatalLossUsd?: number | null;
  maxAbsoluteFatalLossUsd?: number | null;
  polymarket: MultiLevelPairedBookInput & {
    feeRateBps?: number;
    feeRate?: number;
    feeExponent?: number;
  };
  kalshi: MultiLevelPairedBookInput & {
    feeMultiplier?: number;
    maker?: boolean;
    depthHeadroomContracts?: number;
  };
};

export type MultiLevelPairedQuote = {
  commonSize: number;
  maxExecutableSize: number;
  polymarket: MultiLevelLegQuote;
  kalshi: MultiLevelLegQuote;
  totalCostUsd: number;
  worstFillCostUsd: number;
  projectedNetProfitUsd: number;
  projectedNetReturn: number | null;
  conservativeNetProfitUsd: number;
  conservativeNetReturn: number | null;
  breakEvenFatalProbability: number;
  fatalMismatchProbabilityUpper: number;
  probabilityWeightedFatalLossUsd: number;
  absoluteFatalLossUsd: number;
  limitingReason: MultiLevelPairedQuoteLimitingReason | null;
};

type PreparedBook = {
  displayedDepth: number;
  executableDepth: number;
  levels: ExecutableBookLevel[];
};

export const POLYMARKET_SHARE_ESTIMATE_STEP = 0.01;
const ORDER_SIZE_TOLERANCE = 1e-6;

export function roundUpToCent(value: number) {
  return Math.ceil((value - Number.EPSILON) * 100) / 100;
}

export function roundPolymarketFee(value: number) {
  return Math.round((value + Number.EPSILON) * 100_000) / 100_000;
}

export function roundToStep(value: number, step: number) {
  if (step <= 0) {
    return value;
  }

  return Math.floor(value / step) * step;
}

export function calculateKalshiFee({
  contracts,
  price,
  feeMultiplier = 1,
  maker = false,
}: KalshiFeeInput) {
  const coefficient = (maker ? 0.0175 : 0.07) * feeMultiplier;
  return roundUpToCent(coefficient * contracts * price * (1 - price));
}

export function calculatePolymarketFee({
  shares,
  price,
  feeRateBps = 0,
}: PolymarketFeeInput) {
  return roundPolymarketFee(shares * price * (feeRateBps / 10_000));
}

export function calculatePolymarketLevelFee(input: PolymarketFeeInput & {
  feeRate?: number;
  feeExponent?: number;
}) {
  const feeRate = input.feeRate;
  if (
    feeRate !== undefined &&
    Number.isFinite(feeRate) &&
    feeRate > 0 &&
    input.price > 0 &&
    input.price < 1
  ) {
    const feeExponent = Number.isFinite(input.feeExponent)
      ? Math.max(0, input.feeExponent ?? 0)
      : 0;
    const feePerShare = feeRate * Math.pow(input.price * (1 - input.price), feeExponent);
    const effectiveFeeRateBps = (feePerShare / input.price) * 10_000;
    return calculatePolymarketFee({
      shares: input.shares,
      price: input.price,
      feeRateBps: effectiveFeeRateBps,
    });
  }

  return calculatePolymarketFee({
    ...input,
    feeRateBps:
      input.feeRateBps !== undefined && Number.isFinite(input.feeRateBps)
        ? Math.max(0, input.feeRateBps)
        : 0,
  });
}

function calculatePolymarketWorstFillFee(input: Omit<PolymarketFeeInput, "price"> & {
  limitPrice: number;
  feeRate?: number;
  feeExponent?: number;
}) {
  if (input.feeRate !== undefined && Number.isFinite(input.feeRate) && input.feeRate > 0) {
    const exponent = Number.isFinite(input.feeExponent) ? Math.max(0, input.feeExponent ?? 0) : 0;
    const feeMaximizingPrice = Math.min(0.5, Math.max(0, input.limitPrice));
    const maximumFeePerShare = input.feeRate * Math.pow(
      feeMaximizingPrice * (1 - feeMaximizingPrice),
      exponent,
    );
    return roundPolymarketFee(input.shares * maximumFeePerShare);
  }

  return calculatePolymarketFee({
    shares: input.shares,
    price: input.limitPrice,
    feeRateBps: input.feeRateBps,
  });
}

function calculateKalshiWorstFillFee(input: Omit<KalshiFeeInput, "price"> & { limitPrice: number }) {
  const feeMaximizingPrice = Math.min(0.5, Math.max(0, input.limitPrice));
  return calculateKalshiFee({
    ...input,
    price: feeMaximizingPrice,
  });
}

export function quoteMultiLevelBuyLeg(input: MultiLevelBuyLegInput): MultiLevelLegQuote | null {
  const prepared = prepareBook({
    levels: input.levels,
    maxPrice: input.maxPrice,
    depthSafetyFactor: input.depthSafetyFactor,
    depthHeadroom: input.depthHeadroom,
  });

  const calculateLevelFee = (size: number, price: number) =>
    input.venue === "polymarket"
      ? calculatePolymarketLevelFee({
          shares: size,
          price,
          feeRateBps: input.feeRateBps,
          feeRate: input.feeRate,
          feeExponent: input.feeExponent,
        })
      : calculateKalshiFee({
          contracts: size,
          price,
          feeMultiplier: normalizeFeeMultiplier(input.feeMultiplier),
          maker: input.maker,
        });
  const calculateWorstFillFee = (size: number, limitPrice: number) =>
    input.venue === "polymarket"
      ? calculatePolymarketWorstFillFee({
          shares: size,
          limitPrice,
          feeRateBps: input.feeRateBps,
          feeRate: input.feeRate,
          feeExponent: input.feeExponent,
        })
      : calculateKalshiWorstFillFee({
          contracts: size,
          limitPrice,
          feeMultiplier: normalizeFeeMultiplier(input.feeMultiplier),
          maker: input.maker,
        });
  const calculateExpectedOrderFee = input.venue === "kalshi"
    ? (levels: ConsumedBookLevel[]) => {
        const coefficient = (input.maker ? 0.0175 : 0.07) * normalizeFeeMultiplier(input.feeMultiplier);
        return roundUpToCent(
          levels.reduce(
            (sum, level) => sum + coefficient * level.size * level.price * (1 - level.price),
            0,
          ),
        );
      }
    : undefined;
  return quotePreparedBook(
    input.venue,
    prepared,
    input.size,
    calculateLevelFee,
    calculateWorstFillFee,
    calculateExpectedOrderFee,
  );
}

export function deriveMultiLevelPairedQuote(input: MultiLevelPairedQuoteInput): MultiLevelPairedQuote {
  const fatalMismatchProbabilityUpper = input.fatalMismatchProbabilityUpper ?? 0;
  const maxFatalProbabilityShareOfBreakEven = input.maxFatalProbabilityShareOfBreakEven ?? 1;
  const maxLegCapitalShare = input.maxLegCapitalShare ?? 1;
  const criticalValues = [
    input.targetPairBudgetUsd,
    fatalMismatchProbabilityUpper,
    maxFatalProbabilityShareOfBreakEven,
    maxLegCapitalShare,
  ];
  const invalidInput =
    criticalValues.some((value) => !Number.isFinite(value)) ||
    input.targetPairBudgetUsd <= 0 ||
    fatalMismatchProbabilityUpper < 0 ||
    fatalMismatchProbabilityUpper > 1 ||
    maxFatalProbabilityShareOfBreakEven < 0 ||
    maxLegCapitalShare < 0 ||
    maxLegCapitalShare > 1 ||
    isInvalidOptionalFee(input.polymarket.feeRateBps) ||
    isInvalidOptionalFee(input.polymarket.feeRate) ||
    isInvalidOptionalFee(input.polymarket.feeExponent) ||
    isInvalidOptionalFee(input.kalshi.feeMultiplier);
  const polyBook = prepareBook({
    levels: input.polymarket.levels,
    maxPrice: input.polymarket.maxPrice,
    depthSafetyFactor: input.polymarket.depthSafetyFactor,
  });
  const kalshiBook = prepareBook({
    levels: input.kalshi.levels,
    maxPrice: input.kalshi.maxPrice,
    depthSafetyFactor: input.kalshi.depthSafetyFactor,
    depthHeadroom: input.kalshi.depthHeadroomContracts,
  });
  const depthLimitedSize = Math.max(
    0,
    Math.floor(Math.min(polyBook.executableDepth, kalshiBook.executableDepth) + ORDER_SIZE_TOLERANCE),
  );
  const pairSizeCap = normalizeOptionalLimit(input.pairSizeCap);
  const maxExecutableSize = Math.max(0, Math.floor(Math.min(depthLimitedSize, pairSizeCap)));
  const minPairSize =
    input.minPairSize !== undefined && Number.isFinite(input.minPairSize)
      ? Math.max(1, Math.ceil(input.minPairSize))
      : 1;
  const emptyResult = (
    limitingReason: MultiLevelPairedQuoteLimitingReason,
  ): MultiLevelPairedQuote => ({
    commonSize: 0,
    maxExecutableSize,
    polymarket: emptyMultiLevelLegQuote("polymarket", polyBook),
    kalshi: emptyMultiLevelLegQuote("kalshi", kalshiBook),
    totalCostUsd: 0,
    worstFillCostUsd: 0,
    projectedNetProfitUsd: 0,
    projectedNetReturn: null,
    conservativeNetProfitUsd: 0,
    conservativeNetReturn: null,
    breakEvenFatalProbability: 0,
    fatalMismatchProbabilityUpper: invalidInput ? 0 : fatalMismatchProbabilityUpper,
    probabilityWeightedFatalLossUsd: 0,
    absoluteFatalLossUsd: 0,
    limitingReason,
  });

  if (invalidInput) {
    return emptyResult("invalid_input");
  }
  if (maxExecutableSize < minPairSize) {
    if (depthLimitedSize >= minPairSize && pairSizeCap < minPairSize) {
      return emptyResult("pair_size_cap");
    }
    if (polyBook.executableDepth + ORDER_SIZE_TOLERANCE < minPairSize) {
      return emptyResult("polymarket_depth");
    }
    if (kalshiBook.executableDepth + ORDER_SIZE_TOLERANCE < minPairSize) {
      return emptyResult("kalshi_depth");
    }
    return emptyResult("minimum_size");
  }

  const maxLegCostUsd = input.targetPairBudgetUsd * maxLegCapitalShare;
  const polyBalanceUsd = normalizeOptionalLimit(input.polymarket.balanceUsd);
  const kalshiBalanceUsd = normalizeOptionalLimit(input.kalshi.balanceUsd);
  const polyMaxCostUsd = normalizeOptionalLimit(input.polymarket.maxCostUsd);
  const kalshiMaxCostUsd = normalizeOptionalLimit(input.kalshi.maxCostUsd);
  const maxAbsoluteFatalLossUsd = normalizeOptionalLimit(input.maxAbsoluteFatalLossUsd);
  const maxProbabilityWeightedFatalLossUsd = normalizeOptionalLimit(
    input.maxProbabilityWeightedFatalLossUsd,
  );
  const minProjectedNetProfitUsd = normalizeNonNegative(input.minProjectedNetProfitUsd);
  const minProjectedNetReturn = normalizeNonNegative(input.minProjectedNetReturn);
  const minConservativeNetProfitUsd = normalizeNonNegative(input.minConservativeNetProfitUsd);
  const minConservativeNetReturn = normalizeNonNegative(input.minConservativeNetReturn);
  const results = new Map<
    number,
    { quote: MultiLevelPairedQuote; reason: MultiLevelPairedQuoteLimitingReason | null }
  >();
  let best: MultiLevelPairedQuote | null = null;
  let bestConservativeNetProfitUsd = Number.NEGATIVE_INFINITY;

  for (let size = minPairSize; size <= maxExecutableSize; size += 1) {
    const polymarket = quotePreparedBook(
      "polymarket",
      polyBook,
      size,
      (levelSize, price) => calculatePolymarketLevelFee({
        shares: levelSize,
        price,
        feeRateBps: input.polymarket.feeRateBps,
        feeRate: input.polymarket.feeRate,
        feeExponent: input.polymarket.feeExponent,
      }),
      (requestedSize, limitPrice) => calculatePolymarketWorstFillFee({
        shares: requestedSize,
        limitPrice,
        feeRateBps: input.polymarket.feeRateBps,
        feeRate: input.polymarket.feeRate,
        feeExponent: input.polymarket.feeExponent,
      }),
    );
    const kalshi = quotePreparedBook(
      "kalshi",
      kalshiBook,
      size,
      (levelSize, price) => calculateKalshiFee({
        contracts: levelSize,
        price,
        feeMultiplier: normalizeFeeMultiplier(input.kalshi.feeMultiplier),
        maker: input.kalshi.maker,
      }),
      (requestedSize, limitPrice) => calculateKalshiWorstFillFee({
        contracts: requestedSize,
        limitPrice,
        feeMultiplier: normalizeFeeMultiplier(input.kalshi.feeMultiplier),
        maker: input.kalshi.maker,
      }),
    );
    if (!polymarket || !kalshi) {
      continue;
    }

    const totalCostUsd = polymarket.costUsd + kalshi.costUsd;
    const worstFillCostUsd = polymarket.worstFillCostUsd + kalshi.worstFillCostUsd;
    const projectedNetProfitUsd = size - totalCostUsd;
    const projectedNetReturn = totalCostUsd > 0 ? projectedNetProfitUsd / totalCostUsd : null;
    const conservativeNetProfitUsd = size * (1 - fatalMismatchProbabilityUpper) - worstFillCostUsd;
    const conservativeNetReturn = worstFillCostUsd > 0 ? conservativeNetProfitUsd / worstFillCostUsd : null;
    const breakEvenFatalProbability = Math.max(0, (size - worstFillCostUsd) / size);
    const probabilityWeightedFatalLossUsd = fatalMismatchProbabilityUpper * worstFillCostUsd;
    const quote: MultiLevelPairedQuote = {
      commonSize: size,
      maxExecutableSize,
      polymarket,
      kalshi,
      totalCostUsd: round4(totalCostUsd),
      worstFillCostUsd: round4(worstFillCostUsd),
      projectedNetProfitUsd: round4(projectedNetProfitUsd),
      projectedNetReturn: projectedNetReturn === null ? null : round4(projectedNetReturn),
      conservativeNetProfitUsd: round4(conservativeNetProfitUsd),
      conservativeNetReturn: conservativeNetReturn === null ? null : round4(conservativeNetReturn),
      breakEvenFatalProbability: round4(breakEvenFatalProbability),
      fatalMismatchProbabilityUpper,
      probabilityWeightedFatalLossUsd: round4(probabilityWeightedFatalLossUsd),
      absoluteFatalLossUsd: round4(worstFillCostUsd),
      limitingReason: null,
    };
    const reason = getMultiLevelCandidateRejectionReason({
      quote,
      raw: {
        totalCostUsd,
        worstFillCostUsd,
        projectedNetProfitUsd,
        projectedNetReturn,
        conservativeNetProfitUsd,
        conservativeNetReturn,
        breakEvenFatalProbability,
        probabilityWeightedFatalLossUsd,
      },
      limits: {
        targetPairBudgetUsd: input.targetPairBudgetUsd,
        maxLegCostUsd,
        polyBalanceUsd,
        kalshiBalanceUsd,
        polyMaxCostUsd,
        kalshiMaxCostUsd,
        maxAbsoluteFatalLossUsd,
        maxProbabilityWeightedFatalLossUsd,
        minProjectedNetProfitUsd,
        minProjectedNetReturn,
        minConservativeNetProfitUsd,
        minConservativeNetReturn,
        fatalMismatchProbabilityUpper,
        maxFatalProbabilityShareOfBreakEven,
      },
    });
    results.set(size, { quote, reason });
    if (
      reason === null &&
      conservativeNetProfitUsd > bestConservativeNetProfitUsd + ORDER_SIZE_TOLERANCE
    ) {
      best = quote;
      bestConservativeNetProfitUsd = conservativeNetProfitUsd;
    }
  }

  if (!best) {
    return emptyResult(results.get(minPairSize)?.reason ?? "conservative_profit");
  }

  const nextSizeResult = results.get(best.commonSize + 1);
  if (nextSizeResult) {
    best.limitingReason = nextSizeResult.reason ?? "conservative_profit";
  } else if (best.commonSize >= maxExecutableSize) {
    if (pairSizeCap <= depthLimitedSize) {
      best.limitingReason = "pair_size_cap";
    } else if (polyBook.executableDepth <= kalshiBook.executableDepth) {
      best.limitingReason = "polymarket_depth";
    } else {
      best.limitingReason = "kalshi_depth";
    }
  } else {
    best.limitingReason = "conservative_profit";
  }

  return best;
}

export function calculateBinaryPositionPayout(shares: number, won: boolean) {
  return won ? shares : 0;
}

export function deriveTargetShares(notionalUsd: number, price: number, minOrderSize: number) {
  if (price <= 0) {
    return 0;
  }

  return Math.max(0, roundToStep(notionalUsd / price, minOrderSize));
}

export function derivePolymarketTargetShares(notionalUsd: number, price: number) {
  return deriveTargetShares(notionalUsd, price, POLYMARKET_SHARE_ESTIMATE_STEP);
}

export function deriveVenueTargetSize(
  venue: Venue,
  notionalUsd: number,
  price: number,
  minOrderSize: number | null,
  fallbackMinOrderSize: number,
) {
  if (venue === "polymarket") {
    return derivePolymarketTargetShares(notionalUsd, price);
  }

  return deriveTargetShares(notionalUsd, price, minOrderSize ?? fallbackMinOrderSize);
}

export function normalizeVenueTargetSize(
  venue: Venue,
  size: number,
  minOrderSize: number | null,
  fallbackMinOrderSize: number,
) {
  if (!Number.isFinite(size) || size <= 0) {
    return 0;
  }

  const step =
    venue === "polymarket"
      ? POLYMARKET_SHARE_ESTIMATE_STEP
      : getVenueMinimumOrderSize(venue, minOrderSize, fallbackMinOrderSize);

  return roundToStep(size, step);
}

export function getVenueExecutableDepth(
  venue: Venue,
  displayedDepth: number | null,
  kalshiDepthHeadroomContracts = 0,
) {
  if (displayedDepth === null) {
    return null;
  }

  if (venue !== "kalshi") {
    return displayedDepth;
  }

  return Math.max(0, displayedDepth - Math.max(0, kalshiDepthHeadroomContracts));
}

export function applyKalshiPrimaryDepthSafetyFactor(
  displayedDepth: number | null,
  safetyFactor: number,
) {
  if (displayedDepth === null) {
    return null;
  }

  if (!Number.isFinite(displayedDepth) || displayedDepth <= 0) {
    return 0;
  }

  const normalizedSafetyFactor = Number.isFinite(safetyFactor)
    ? Math.min(1, Math.max(0, safetyFactor))
    : 1;

  return displayedDepth * normalizedSafetyFactor;
}

export function getKalshiPrimaryMultiClipCapacity(
  maxClipContracts: number,
  maxClips: number,
) {
  if (!Number.isFinite(maxClipContracts) || !Number.isFinite(maxClips)) {
    return null;
  }

  const normalizedMaxClipContracts = Math.max(1, Math.floor(maxClipContracts));
  const normalizedMaxClips = Math.max(1, Math.floor(maxClips));
  return normalizedMaxClipContracts * normalizedMaxClips;
}

export function deriveKalshiPrimaryClipPlan(
  requestedContracts: number,
  maxClipContracts: number,
  maxClips: number,
  probeClipContracts?: number | null,
) {
  const normalizedRequestedContracts = normalizeVenueTargetSize("kalshi", requestedContracts, 1, 1);
  if (normalizedRequestedContracts <= 0) {
    return [];
  }

  const normalizedMaxClipContracts = Math.max(1, Math.floor(maxClipContracts));
  const normalizedMaxClips = Math.max(1, Math.floor(maxClips));
  const totalCapacity = normalizedMaxClipContracts * normalizedMaxClips;
  const cappedRequestedContracts = Math.min(normalizedRequestedContracts, totalCapacity);

  if (probeClipContracts !== null && probeClipContracts !== undefined) {
    const normalizedProbeClipContracts = Math.max(1, Math.floor(probeClipContracts));
    const remainingClipCapacity = normalizedMaxClipContracts * Math.max(0, normalizedMaxClips - 1);
    const firstClipSize = Math.min(
      normalizedMaxClipContracts,
      cappedRequestedContracts,
      Math.max(normalizedProbeClipContracts, cappedRequestedContracts - remainingClipCapacity),
    );
    const remainingContracts = cappedRequestedContracts - firstClipSize;
    if (remainingContracts <= 0 || normalizedMaxClips === 1) {
      return [firstClipSize];
    }

    const remainingClipCount = Math.min(
      normalizedMaxClips - 1,
      Math.max(1, Math.ceil(remainingContracts / normalizedMaxClipContracts)),
    );
    const baseRemainingClipSize = Math.floor(remainingContracts / remainingClipCount);
    const remainingRemainder = remainingContracts - baseRemainingClipSize * remainingClipCount;

    return [
      firstClipSize,
      ...Array.from(
        { length: remainingClipCount },
        (_, index) => baseRemainingClipSize + (index < remainingRemainder ? 1 : 0),
      ),
    ].filter((clipSize) => clipSize > 0);
  }

  const clipCount = Math.min(
    normalizedMaxClips,
    Math.max(1, Math.ceil(cappedRequestedContracts / normalizedMaxClipContracts)),
  );
  const baseClipSize = Math.floor(cappedRequestedContracts / clipCount);
  const remainder = cappedRequestedContracts - baseClipSize * clipCount;

  return Array.from({ length: clipCount }, (_, index) => baseClipSize + (index < remainder ? 1 : 0)).filter(
    (clipSize) => clipSize > 0,
  );
}

export function deriveVenueExecutableSize(input: {
  venue: Venue;
  targetNotionalUsd?: number | null;
  sizeCap?: number | null;
  price: number | null;
  displayedDepth: number | null;
  minOrderSize: number | null;
  fallbackMinOrderSize: number;
  kalshiDepthHeadroomContracts?: number;
}) {
  if (input.price === null || input.price <= 0) {
    return 0;
  }

  const budgetLimitedSize =
    input.targetNotionalUsd === null || input.targetNotionalUsd === undefined
      ? Number.POSITIVE_INFINITY
      : deriveVenueTargetSize(
          input.venue,
          input.targetNotionalUsd,
          input.price,
          input.minOrderSize,
          input.fallbackMinOrderSize,
        );
  const cappedSize =
    input.sizeCap === null || input.sizeCap === undefined ? Number.POSITIVE_INFINITY : input.sizeCap;
  const executableDepth = getVenueExecutableDepth(
    input.venue,
    input.displayedDepth,
    input.kalshiDepthHeadroomContracts ?? 0,
  );
  const rawExecutableSize = Math.min(
    budgetLimitedSize,
    cappedSize,
    executableDepth ?? Number.POSITIVE_INFINITY,
  );
  const normalized = normalizeVenueTargetSize(
    input.venue,
    rawExecutableSize,
    input.minOrderSize,
    input.fallbackMinOrderSize,
  );
  const minimumSize = getVenueMinimumOrderSize(
    input.venue,
    input.minOrderSize,
    input.fallbackMinOrderSize,
  );

  return normalized + Number.EPSILON >= minimumSize ? normalized : 0;
}

export function deriveAlignedPairSize(input: {
  targetLegNotionalUsd: number;
  pairSizeCap?: number | null;
  polymarket: {
    price: number | null;
    depth: number | null;
    minOrderSize: number | null;
    fallbackMinOrderSize: number;
  };
  kalshi: {
    price: number | null;
    depth: number | null;
    minOrderSize: number | null;
    fallbackMinOrderSize: number;
  };
  kalshiDepthHeadroomContracts?: number;
}) {
  const polyMaxSize = deriveVenueExecutableSize({
    venue: "polymarket",
    targetNotionalUsd: input.targetLegNotionalUsd,
    sizeCap: input.pairSizeCap,
    price: input.polymarket.price,
    displayedDepth: input.polymarket.depth,
    minOrderSize: input.polymarket.minOrderSize,
    fallbackMinOrderSize: input.polymarket.fallbackMinOrderSize,
  });
  const kalshiMaxSize = deriveVenueExecutableSize({
    venue: "kalshi",
    targetNotionalUsd: input.targetLegNotionalUsd,
    sizeCap: input.pairSizeCap,
    price: input.kalshi.price,
    displayedDepth: input.kalshi.depth,
    minOrderSize: input.kalshi.minOrderSize,
    fallbackMinOrderSize: input.kalshi.fallbackMinOrderSize,
    kalshiDepthHeadroomContracts: input.kalshiDepthHeadroomContracts,
  });

  const commonRawSize = Math.min(polyMaxSize, kalshiMaxSize);
  const polySize = normalizeVenueTargetSize(
    "polymarket",
    commonRawSize,
    input.polymarket.minOrderSize,
    input.polymarket.fallbackMinOrderSize,
  );
  const kalshiSize = normalizeVenueTargetSize(
    "kalshi",
    commonRawSize,
    input.kalshi.minOrderSize,
    input.kalshi.fallbackMinOrderSize,
  );
  const commonSize = Math.min(polySize, kalshiSize);

  return {
    commonSize,
    polyMaxSize,
    kalshiMaxSize,
    polySize: normalizeVenueTargetSize(
      "polymarket",
      commonSize,
      input.polymarket.minOrderSize,
      input.polymarket.fallbackMinOrderSize,
    ),
    kalshiSize: normalizeVenueTargetSize(
      "kalshi",
      commonSize,
      input.kalshi.minOrderSize,
      input.kalshi.fallbackMinOrderSize,
    ),
    kalshiExecutableDepth: getVenueExecutableDepth(
      "kalshi",
      input.kalshi.depth,
      input.kalshiDepthHeadroomContracts ?? 0,
    ),
  };
}

export type BalancedPayoutPairSize = {
  commonSize: number;
  polyMaxSize: number;
  kalshiMaxSize: number;
  polySize: number;
  kalshiSize: number;
  polyNotionalUsd: number;
  kalshiNotionalUsd: number;
  polyFeeUsd: number;
  kalshiFeeUsd: number;
  polyCostUsd: number;
  kalshiCostUsd: number;
  totalCostUsd: number;
  projectedNetProfitUsd: number;
  projectedNetReturn: number | null;
  maxLegCostUsd: number;
  kalshiExecutableDepth: number | null;
};

export function deriveBalancedPayoutPairSize(input: {
  targetPairBudgetUsd: number;
  maxLegCapitalShare: number;
  pairSizeCap?: number | null;
  polymarket: {
    price: number | null;
    depth: number | null;
    minOrderSize: number | null;
    fallbackMinOrderSize: number;
    feeRateBps?: number;
  };
  kalshi: {
    price: number | null;
    depth: number | null;
    minOrderSize: number | null;
    fallbackMinOrderSize: number;
    feeMultiplier?: number;
  };
  kalshiDepthHeadroomContracts?: number;
}): BalancedPayoutPairSize {
  const targetPairBudgetUsd = Number.isFinite(input.targetPairBudgetUsd)
    ? Math.max(0, input.targetPairBudgetUsd)
    : 0;
  const normalizedMaxLegCapitalShare = Number.isFinite(input.maxLegCapitalShare)
    ? Math.min(1, Math.max(0, input.maxLegCapitalShare))
    : 1;
  const maxLegCostUsd = targetPairBudgetUsd * normalizedMaxLegCapitalShare;
  const empty = (overrides: Partial<BalancedPayoutPairSize> = {}): BalancedPayoutPairSize => ({
    commonSize: 0,
    polyMaxSize: 0,
    kalshiMaxSize: 0,
    polySize: 0,
    kalshiSize: 0,
    polyNotionalUsd: 0,
    kalshiNotionalUsd: 0,
    polyFeeUsd: 0,
    kalshiFeeUsd: 0,
    polyCostUsd: 0,
    kalshiCostUsd: 0,
    totalCostUsd: 0,
    projectedNetProfitUsd: 0,
    projectedNetReturn: null,
    maxLegCostUsd: round4(maxLegCostUsd),
    kalshiExecutableDepth: null,
    ...overrides,
  });

  if (
    targetPairBudgetUsd <= 0 ||
    input.polymarket.price === null ||
    input.kalshi.price === null ||
    input.polymarket.price <= 0 ||
    input.kalshi.price <= 0
  ) {
    return empty();
  }

  const pairSizeCap =
    input.pairSizeCap === null || input.pairSizeCap === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, input.pairSizeCap);
  const polyMaxSize = deriveVenueExecutableSize({
    venue: "polymarket",
    targetNotionalUsd: null,
    sizeCap: pairSizeCap,
    price: input.polymarket.price,
    displayedDepth: input.polymarket.depth,
    minOrderSize: input.polymarket.minOrderSize,
    fallbackMinOrderSize: input.polymarket.fallbackMinOrderSize,
  });
  const kalshiMaxSize = deriveVenueExecutableSize({
    venue: "kalshi",
    targetNotionalUsd: null,
    sizeCap: pairSizeCap,
    price: input.kalshi.price,
    displayedDepth: input.kalshi.depth,
    minOrderSize: input.kalshi.minOrderSize,
    fallbackMinOrderSize: input.kalshi.fallbackMinOrderSize,
    kalshiDepthHeadroomContracts: input.kalshiDepthHeadroomContracts,
  });
  const kalshiExecutableDepth = getVenueExecutableDepth(
    "kalshi",
    input.kalshi.depth,
    input.kalshiDepthHeadroomContracts ?? 0,
  );
  const commonMaxSize = Math.min(polyMaxSize, kalshiMaxSize);
  if (commonMaxSize <= 0) {
    return empty({
      polyMaxSize,
      kalshiMaxSize,
      kalshiExecutableDepth,
    });
  }

  const polyMinimumSize = getVenueMinimumOrderSize(
    "polymarket",
    input.polymarket.minOrderSize,
    input.polymarket.fallbackMinOrderSize,
  );
  const kalshiMinimumSize = getVenueMinimumOrderSize(
    "kalshi",
    input.kalshi.minOrderSize,
    input.kalshi.fallbackMinOrderSize,
  );
  const buildSizedResult = (size: number): BalancedPayoutPairSize => {
    const polySize = normalizeVenueTargetSize(
      "polymarket",
      size,
      input.polymarket.minOrderSize,
      input.polymarket.fallbackMinOrderSize,
    );
    const kalshiSize = normalizeVenueTargetSize(
      "kalshi",
      size,
      input.kalshi.minOrderSize,
      input.kalshi.fallbackMinOrderSize,
    );
    const commonSize = Math.min(polySize, kalshiSize);
    const polyNotionalUsd = commonSize * input.polymarket.price!;
    const kalshiNotionalUsd = commonSize * input.kalshi.price!;
    const polyFeeUsd = calculatePolymarketFee({
      shares: commonSize,
      price: input.polymarket.price!,
      feeRateBps: input.polymarket.feeRateBps ?? 0,
    });
    const kalshiFeeUsd = calculateKalshiFee({
      contracts: commonSize,
      price: input.kalshi.price!,
      feeMultiplier: input.kalshi.feeMultiplier ?? 1,
    });
    const polyCostUsd = polyNotionalUsd + polyFeeUsd;
    const kalshiCostUsd = kalshiNotionalUsd + kalshiFeeUsd;
    const totalCostUsd = polyCostUsd + kalshiCostUsd;
    const projectedNetProfitUsd = commonSize - totalCostUsd;

    return {
      commonSize,
      polyMaxSize,
      kalshiMaxSize,
      polySize: commonSize,
      kalshiSize: commonSize,
      polyNotionalUsd: round4(polyNotionalUsd),
      kalshiNotionalUsd: round4(kalshiNotionalUsd),
      polyFeeUsd: round4(polyFeeUsd),
      kalshiFeeUsd: round4(kalshiFeeUsd),
      polyCostUsd: round4(polyCostUsd),
      kalshiCostUsd: round4(kalshiCostUsd),
      totalCostUsd: round4(totalCostUsd),
      projectedNetProfitUsd: round4(projectedNetProfitUsd),
      projectedNetReturn: totalCostUsd > 0 ? round4(projectedNetProfitUsd / totalCostUsd) : null,
      maxLegCostUsd: round4(maxLegCostUsd),
      kalshiExecutableDepth,
    };
  };

  for (let candidate = Math.floor(commonMaxSize + ORDER_SIZE_TOLERANCE); candidate > 0; candidate -= 1) {
    const normalizedPolySize = normalizeVenueTargetSize(
      "polymarket",
      candidate,
      input.polymarket.minOrderSize,
      input.polymarket.fallbackMinOrderSize,
    );
    const normalizedKalshiSize = normalizeVenueTargetSize(
      "kalshi",
      candidate,
      input.kalshi.minOrderSize,
      input.kalshi.fallbackMinOrderSize,
    );
    const commonSize = Math.min(normalizedPolySize, normalizedKalshiSize);
    if (
      commonSize + ORDER_SIZE_TOLERANCE < polyMinimumSize ||
      commonSize + ORDER_SIZE_TOLERANCE < kalshiMinimumSize
    ) {
      continue;
    }

    const sized = buildSizedResult(commonSize);
    if (
      sized.totalCostUsd <= targetPairBudgetUsd + ORDER_SIZE_TOLERANCE &&
      sized.polyCostUsd <= maxLegCostUsd + ORDER_SIZE_TOLERANCE &&
      sized.kalshiCostUsd <= maxLegCostUsd + ORDER_SIZE_TOLERANCE &&
      sized.projectedNetProfitUsd > ORDER_SIZE_TOLERANCE
    ) {
      return sized;
    }
  }

  return empty({
    polyMaxSize,
    kalshiMaxSize,
    maxLegCostUsd: round4(maxLegCostUsd),
    kalshiExecutableDepth,
  });
}

function prepareBook(input: Omit<MultiLevelBookInput, "size">): PreparedBook {
  const levelsByPrice = new Map<number, number>();
  for (const level of input.levels) {
    if (
      !Number.isFinite(level.price) ||
      !Number.isFinite(level.size) ||
      level.price <= 0 ||
      level.price >= 1 ||
      level.size <= 0
    ) {
      continue;
    }
    levelsByPrice.set(level.price, (levelsByPrice.get(level.price) ?? 0) + level.size);
  }

  const normalizedLevels = [...levelsByPrice.entries()]
    .map(([price, size]) => ({ price, size }))
    .sort((left, right) => left.price - right.price);
  const displayedDepth = normalizedLevels.reduce((sum, level) => sum + level.size, 0);
  const maxPrice =
    input.maxPrice === null || input.maxPrice === undefined
      ? Number.POSITIVE_INFINITY
      : Number.isFinite(input.maxPrice)
        ? input.maxPrice
        : 0;
  const safetyFactor =
    input.depthSafetyFactor === undefined
      ? 1
      : Number.isFinite(input.depthSafetyFactor)
        ? Math.min(1, Math.max(0, input.depthSafetyFactor))
        : 0;
  const safetyAdjustedLevels = normalizedLevels
    .filter((level) => level.price <= maxPrice + ORDER_SIZE_TOLERANCE)
    .map((level) => ({ price: level.price, size: level.size * safetyFactor }))
    .filter((level) => level.size > ORDER_SIZE_TOLERANCE);
  const safetyAdjustedDepth = safetyAdjustedLevels.reduce((sum, level) => sum + level.size, 0);
  const depthHeadroom =
    input.depthHeadroom === undefined
      ? 0
      : Number.isFinite(input.depthHeadroom)
        ? Math.max(0, input.depthHeadroom)
        : safetyAdjustedDepth;
  let remainingExecutableDepth = Math.max(0, safetyAdjustedDepth - depthHeadroom);
  const executableLevels: ExecutableBookLevel[] = [];

  for (const level of safetyAdjustedLevels) {
    if (remainingExecutableDepth <= ORDER_SIZE_TOLERANCE) {
      break;
    }
    const size = Math.min(level.size, remainingExecutableDepth);
    executableLevels.push({ price: level.price, size });
    remainingExecutableDepth -= size;
  }

  return {
    displayedDepth,
    executableDepth: executableLevels.reduce((sum, level) => sum + level.size, 0),
    levels: executableLevels,
  };
}

function quotePreparedBook(
  venue: Venue,
  book: PreparedBook,
  requestedSize: number,
  calculateLevelFee: (size: number, price: number) => number,
  calculateWorstFillFee: (size: number, limitPrice: number) => number = calculateLevelFee,
  calculateExpectedOrderFee?: (levels: ConsumedBookLevel[]) => number,
): MultiLevelLegQuote | null {
  if (!Number.isFinite(requestedSize) || requestedSize <= 0) {
    return null;
  }
  if (requestedSize > book.executableDepth + ORDER_SIZE_TOLERANCE) {
    return null;
  }

  let remaining = requestedSize;
  let notionalUsd = 0;
  let feeUsd = 0;
  const consumedLevels: ConsumedBookLevel[] = [];
  for (const level of book.levels) {
    if (remaining <= ORDER_SIZE_TOLERANCE) {
      break;
    }
    const size = Math.min(level.size, remaining);
    const levelNotionalUsd = size * level.price;
    const levelFeeUsd = calculateLevelFee(size, level.price);
    consumedLevels.push({
      price: level.price,
      size: round4(size),
      notionalUsd: round4(levelNotionalUsd),
      feeUsd: round5(levelFeeUsd),
      costUsd: round5(levelNotionalUsd + levelFeeUsd),
    });
    notionalUsd += levelNotionalUsd;
    feeUsd += levelFeeUsd;
    remaining -= size;
  }

  if (remaining > ORDER_SIZE_TOLERANCE) {
    return null;
  }

  if (calculateExpectedOrderFee && consumedLevels.length > 0) {
    const expectedOrderFeeUsd = calculateExpectedOrderFee(consumedLevels);
    const perLevelFeeTotalUsd = consumedLevels.reduce((sum, level) => sum + level.feeUsd, 0);
    let allocatedFeeUsd = 0;
    for (let index = 0; index < consumedLevels.length; index += 1) {
      const level = consumedLevels[index];
      const allocated = index === consumedLevels.length - 1
        ? round5(expectedOrderFeeUsd - allocatedFeeUsd)
        : round5(
            perLevelFeeTotalUsd > 0
              ? expectedOrderFeeUsd * (level.feeUsd / perLevelFeeTotalUsd)
              : 0,
          );
      level.feeUsd = Math.max(0, allocated);
      level.costUsd = round5(level.notionalUsd + level.feeUsd);
      allocatedFeeUsd += level.feeUsd;
    }
    feeUsd = expectedOrderFeeUsd;
  }

  const limitPrice = consumedLevels.at(-1)?.price ?? null;
  if (limitPrice === null) {
    return null;
  }
  const worstFillNotionalUsd = Math.max(notionalUsd, requestedSize * limitPrice);
  const worstFillFeeUsd = Math.max(feeUsd, calculateWorstFillFee(requestedSize, limitPrice));
  const expectedCostUsd = notionalUsd + feeUsd;
  const worstFillCostUsd = Math.max(
    expectedCostUsd,
    worstFillNotionalUsd + worstFillFeeUsd,
  );

  return {
    venue,
    size: round4(requestedSize),
    displayedDepth: round4(book.displayedDepth),
    executableDepth: round4(book.executableDepth),
    notionalUsd: round4(notionalUsd),
    feeUsd: round5(feeUsd),
    costUsd: round5(expectedCostUsd),
    worstFillNotionalUsd: round4(worstFillNotionalUsd),
    worstFillFeeUsd: round5(worstFillFeeUsd),
    worstFillCostUsd: round5(worstFillCostUsd),
    vwapPrice: requestedSize > 0 ? round4(notionalUsd / requestedSize) : null,
    limitPrice,
    consumedLevels,
  };
}

function emptyMultiLevelLegQuote(venue: Venue, book: PreparedBook): MultiLevelLegQuote {
  return {
    venue,
    size: 0,
    displayedDepth: round4(book.displayedDepth),
    executableDepth: round4(book.executableDepth),
    notionalUsd: 0,
    feeUsd: 0,
    costUsd: 0,
    worstFillNotionalUsd: 0,
    worstFillFeeUsd: 0,
    worstFillCostUsd: 0,
    vwapPrice: null,
    limitPrice: null,
    consumedLevels: [],
  };
}

function normalizeOptionalLimit(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizeNonNegative(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizeFeeMultiplier(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : 1;
}

function isInvalidOptionalFee(value: number | undefined) {
  return value !== undefined && (!Number.isFinite(value) || value < 0);
}

function getMultiLevelCandidateRejectionReason(input: {
  quote: MultiLevelPairedQuote;
  raw: {
    totalCostUsd: number;
    worstFillCostUsd: number;
    projectedNetProfitUsd: number;
    projectedNetReturn: number | null;
    conservativeNetProfitUsd: number;
    conservativeNetReturn: number | null;
    breakEvenFatalProbability: number;
    probabilityWeightedFatalLossUsd: number;
  };
  limits: {
    targetPairBudgetUsd: number;
    maxLegCostUsd: number;
    polyBalanceUsd: number;
    kalshiBalanceUsd: number;
    polyMaxCostUsd: number;
    kalshiMaxCostUsd: number;
    maxAbsoluteFatalLossUsd: number;
    maxProbabilityWeightedFatalLossUsd: number;
    minProjectedNetProfitUsd: number;
    minProjectedNetReturn: number;
    minConservativeNetProfitUsd: number;
    minConservativeNetReturn: number;
    fatalMismatchProbabilityUpper: number;
    maxFatalProbabilityShareOfBreakEven: number;
  };
}): MultiLevelPairedQuoteLimitingReason | null {
  const { quote, raw, limits } = input;
  if (raw.worstFillCostUsd > limits.targetPairBudgetUsd + ORDER_SIZE_TOLERANCE) {
    return "pair_budget";
  }
  if (
    quote.polymarket.worstFillCostUsd > limits.maxLegCostUsd + ORDER_SIZE_TOLERANCE ||
    quote.kalshi.worstFillCostUsd > limits.maxLegCostUsd + ORDER_SIZE_TOLERANCE
  ) {
    return "max_leg_capital";
  }
  if (quote.polymarket.worstFillCostUsd > limits.polyBalanceUsd + ORDER_SIZE_TOLERANCE) {
    return "polymarket_balance";
  }
  if (quote.kalshi.worstFillCostUsd > limits.kalshiBalanceUsd + ORDER_SIZE_TOLERANCE) {
    return "kalshi_balance";
  }
  if (quote.polymarket.worstFillCostUsd > limits.polyMaxCostUsd + ORDER_SIZE_TOLERANCE) {
    return "polymarket_cost";
  }
  if (quote.kalshi.worstFillCostUsd > limits.kalshiMaxCostUsd + ORDER_SIZE_TOLERANCE) {
    return "kalshi_cost";
  }
  if (raw.worstFillCostUsd > limits.maxAbsoluteFatalLossUsd + ORDER_SIZE_TOLERANCE) {
    return "absolute_fatal_loss";
  }
  if (
    raw.probabilityWeightedFatalLossUsd >
    limits.maxProbabilityWeightedFatalLossUsd + ORDER_SIZE_TOLERANCE
  ) {
    return "probability_weighted_fatal_loss";
  }
  if (failsPositiveMinimum(raw.projectedNetProfitUsd, limits.minProjectedNetProfitUsd)) {
    return "projected_profit";
  }
  if (
    raw.projectedNetReturn === null ||
    failsPositiveMinimum(raw.projectedNetReturn, limits.minProjectedNetReturn)
  ) {
    return "projected_return";
  }
  if (
    limits.fatalMismatchProbabilityUpper >
    limits.maxFatalProbabilityShareOfBreakEven * raw.breakEvenFatalProbability +
      ORDER_SIZE_TOLERANCE
  ) {
    return "fatal_probability";
  }
  if (failsPositiveMinimum(raw.conservativeNetProfitUsd, limits.minConservativeNetProfitUsd)) {
    return "conservative_profit";
  }
  if (
    raw.conservativeNetReturn === null ||
    failsPositiveMinimum(raw.conservativeNetReturn, limits.minConservativeNetReturn)
  ) {
    return "conservative_return";
  }
  return null;
}

function failsPositiveMinimum(value: number, minimum: number) {
  return minimum <= ORDER_SIZE_TOLERANCE
    ? value <= ORDER_SIZE_TOLERANCE
    : value + ORDER_SIZE_TOLERANCE < minimum;
}

export function getVenueMinimumOrderSize(
  venue: Venue,
  minOrderSize: number | null,
  fallbackMinOrderSize: number,
) {
  if (venue === "polymarket") {
    return minOrderSize ?? POLYMARKET_SHARE_ESTIMATE_STEP;
  }

  return minOrderSize ?? fallbackMinOrderSize;
}

export function applySlippage(price: number, maxSlippageBps: number, side: OrderSide = "BUY") {
  const multiplier = 1 + maxSlippageBps / 10_000;
  return side === "SELL" ? price / multiplier : price * multiplier;
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function round5(value: number) {
  return Math.round(value * 100_000) / 100_000;
}
