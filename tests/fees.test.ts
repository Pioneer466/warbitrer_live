import {
  applyKalshiPrimaryDepthSafetyFactor,
  applySlippage,
  calculateBinaryPositionPayout,
  calculateKalshiFee,
  calculatePolymarketFee,
  deriveAlignedPairSize,
  deriveKalshiPrimaryClipPlan,
  derivePolymarketTargetShares,
  deriveTargetShares,
  deriveVenueExecutableSize,
  getKalshiPrimaryMultiClipCapacity,
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

  it("estimates polymarket buy shares at cent precision", () => {
    expect(derivePolymarketTargetShares(10, 0.42)).toBeCloseTo(23.8, 2);
  });

  it("clips Kalshi executable size by a fixed headroom before using displayed depth", () => {
    expect(
      deriveVenueExecutableSize({
        venue: "kalshi",
        targetNotionalUsd: 10,
        price: 0.5,
        displayedDepth: 20,
        minOrderSize: 1,
        fallbackMinOrderSize: 1,
        kalshiDepthHeadroomContracts: 2,
      }),
    ).toBe(18);
  });

  it("discounts Kalshi primary depth before sizing into the displayed book", () => {
    expect(applyKalshiPrimaryDepthSafetyFactor(25, 0.7)).toBe(17.5);
    expect(applyKalshiPrimaryDepthSafetyFactor(null, 0.7)).toBeNull();
  });

  it("aligns pair sizing to the smallest executable leg instead of forcing the full budget on both sides", () => {
    expect(
      deriveAlignedPairSize({
        targetLegNotionalUsd: 10,
        polymarket: {
          price: 0.4,
          depth: 100,
          minOrderSize: 0.01,
          fallbackMinOrderSize: 5,
        },
        kalshi: {
          price: 0.5,
          depth: 20,
          minOrderSize: 1,
          fallbackMinOrderSize: 1,
        },
        kalshiDepthHeadroomContracts: 2,
      }),
    ).toMatchObject({
      commonSize: 18,
      polySize: 18,
      kalshiSize: 18,
      polyMaxSize: 25,
      kalshiMaxSize: 18,
    });
  });

  it("builds a fee-aware Kalshi clip plan with the fewest balanced clips under the size cap", () => {
    expect(deriveKalshiPrimaryClipPlan(22, 10, 4)).toEqual([8, 7, 7]);
    expect(deriveKalshiPrimaryClipPlan(40, 10, 4)).toEqual([10, 10, 10, 10]);
  });

  it("can lead Kalshi primary execution with a smaller probe clip", () => {
    expect(deriveKalshiPrimaryClipPlan(22, 10, 4, 5)).toEqual([5, 9, 8]);
    expect(deriveKalshiPrimaryClipPlan(10, 10, 4, 5)).toEqual([5, 5]);
    expect(deriveKalshiPrimaryClipPlan(40, 10, 4, 5)).toEqual([10, 10, 10, 10]);
  });

  it("caps total Kalshi primary size by the configured clip capacity", () => {
    expect(getKalshiPrimaryMultiClipCapacity(10, 4)).toBe(40);
    expect(deriveKalshiPrimaryClipPlan(55, 10, 4)).toEqual([10, 10, 10, 10]);
  });

  it("applies slippage in basis points for buys", () => {
    expect(applySlippage(0.5, 30, "BUY")).toBeCloseTo(0.5015, 6);
  });

  it("applies slippage in basis points for sells", () => {
    expect(applySlippage(0.5, 30, "SELL")).toBeCloseTo(0.498504, 6);
  });

  it("returns payout only on the winning side", () => {
    expect(calculateBinaryPositionPayout(98.4, true)).toBe(98.4);
    expect(calculateBinaryPositionPayout(98.4, false)).toBe(0);
  });
});
