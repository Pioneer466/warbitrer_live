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
