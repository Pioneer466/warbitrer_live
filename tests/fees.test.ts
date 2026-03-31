import {
  applySlippage,
  calculateBinaryPositionPayout,
  calculateKalshiFee,
  calculatePolymarketFee,
  deriveTargetShares,
} from "@/lib/fees";

describe("live fee and sizing helpers", () => {
  it("matches Kalshi public example at 50 cents for 100 contracts", () => {
    expect(calculateKalshiFee({ contracts: 100, price: 0.5 })).toBe(1.75);
  });

  it("computes Polymarket taker fees from basis points", () => {
    expect(calculatePolymarketFee({ shares: 100, price: 0.42, feeRateBps: 10 })).toBe(0.05);
  });

  it("rounds target shares down to the requested step", () => {
    expect(deriveTargetShares(25, 0.42, 0.01)).toBeCloseTo(59.52, 2);
  });

  it("applies slippage in basis points", () => {
    expect(applySlippage(0.5, 30)).toBeCloseTo(0.5015, 6);
  });

  it("returns payout only on the winning side", () => {
    expect(calculateBinaryPositionPayout(98.4, true)).toBe(98.4);
    expect(calculateBinaryPositionPayout(98.4, false)).toBe(0);
  });
});
