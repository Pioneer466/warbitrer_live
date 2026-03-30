type KalshiFeeInput = {
  contracts: number;
  price: number;
  feeMultiplier?: number;
  maker?: boolean;
};

type PolymarketFeeInput = {
  shares: number;
  price: number;
  feeRate?: number;
  exponent?: number;
};

export function roundUpToCent(value: number) {
  return Math.ceil((value - Number.EPSILON) * 100) / 100;
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
  feeRate = 0.25,
  exponent = 2,
}: PolymarketFeeInput) {
  const curve = Math.pow(price * (1 - price), exponent);
  return shares * price * feeRate * curve;
}

export function polymarketFeeShares(feeUsd: number, price: number) {
  if (price <= 0) {
    return 0;
  }

  return feeUsd / price;
}

export function polymarketNetSharesBought(shares: number, price: number, feeUsd: number) {
  return Math.max(0, shares - polymarketFeeShares(feeUsd, price));
}
