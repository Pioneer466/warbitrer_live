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
