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

export const POLYMARKET_SHARE_ESTIMATE_STEP = 0.01;
const ORDER_SIZE_TOLERANCE = 1e-6;

export function roundUpToCent(value: number) {
  return Math.ceil((value - Number.EPSILON) * 100) / 100;
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
  return roundUpToCent(shares * price * (feeRateBps / 10_000));
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
