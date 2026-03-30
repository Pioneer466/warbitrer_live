import {
  calculateKalshiFee,
  calculatePolymarketFee,
  polymarketFeeShares,
  polymarketNetSharesBought,
} from "@/lib/fees";

describe("fee models", () => {
  it("matches Kalshi public example at 50 cents for 100 contracts", () => {
    expect(calculateKalshiFee({ contracts: 100, price: 0.5 })).toBe(1.75);
  });

  it("matches Polymarket crypto fee curve at 50 cents for 100 shares", () => {
    expect(calculatePolymarketFee({ shares: 100, price: 0.5 })).toBeCloseTo(0.78125, 6);
  });

  it("converts Polymarket buy fees into deducted shares", () => {
    const feeUsd = calculatePolymarketFee({ shares: 100, price: 0.5 });
    expect(polymarketFeeShares(feeUsd, 0.5)).toBeCloseTo(1.5625, 6);
    expect(polymarketNetSharesBought(100, 0.5, feeUsd)).toBeCloseTo(98.4375, 6);
  });
});
