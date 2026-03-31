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

export function applySlippage(price: number, maxSlippageBps: number) {
  return price * (1 + maxSlippageBps / 10_000);
}
