import {
  applyKalshiPrimaryDepthSafetyFactor,
  applySlippage,
  calculateBinaryPositionPayout,
  calculateKalshiFee,
  calculatePolymarketLevelFee,
  calculatePolymarketFee,
  deriveAlignedPairSize,
  deriveBalancedPayoutPairSize,
  deriveKalshiPrimaryClipPlan,
  deriveMultiLevelPairedQuote,
  derivePolymarketTargetShares,
  deriveTargetShares,
  deriveVenueExecutableSize,
  getKalshiPrimaryMultiClipCapacity,
  quoteMultiLevelBuyLeg,
} from "@/lib/fees";

describe("live fee and sizing helpers", () => {
  it("matches Kalshi public example at 50 cents for 100 contracts", () => {
    expect(calculateKalshiFee({ contracts: 100, price: 0.5 })).toBe(1.75);
  });

  it("computes Polymarket taker fees from basis points", () => {
    expect(calculatePolymarketFee({ shares: 100, price: 0.42, feeRateBps: 10 })).toBe(0.042);
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

  it("sizes a balanced payout pair under a total budget with asymmetric leg capital", () => {
    const sizing = deriveBalancedPayoutPairSize({
      targetPairBudgetUsd: 20,
      maxLegCapitalShare: 0.7,
      polymarket: {
        price: 0.35,
        depth: 100,
        minOrderSize: 0.01,
        fallbackMinOrderSize: 5,
        feeRateBps: 10,
      },
      kalshi: {
        price: 0.58,
        depth: 100,
        minOrderSize: 1,
        fallbackMinOrderSize: 1,
        feeMultiplier: 1,
      },
    });

    expect(sizing.commonSize).toBe(21);
    expect(sizing.kalshiNotionalUsd).toBeGreaterThan(sizing.polyNotionalUsd);
    expect(sizing.totalCostUsd).toBeLessThanOrEqual(20);
    expect(sizing.polyCostUsd).toBeLessThanOrEqual(14);
    expect(sizing.kalshiCostUsd).toBeLessThanOrEqual(14);
    expect(sizing.projectedNetProfitUsd).toBeGreaterThan(0);
  });

  it("rejects balanced payout sizing when the minimum executable leg would exceed its capital share", () => {
    const sizing = deriveBalancedPayoutPairSize({
      targetPairBudgetUsd: 20,
      maxLegCapitalShare: 0.7,
      polymarket: {
        price: 0.1,
        depth: 100,
        minOrderSize: 0.01,
        fallbackMinOrderSize: 5,
      },
      kalshi: {
        price: 0.8,
        depth: 100,
        minOrderSize: 20,
        fallbackMinOrderSize: 1,
        feeMultiplier: 1,
      },
    });

    expect(sizing.commonSize).toBe(0);
    expect(sizing.kalshiMaxSize).toBeGreaterThan(0);
  });

  it("reduces balanced payout sizing when fees would push the total cost over budget", () => {
    const sizing = deriveBalancedPayoutPairSize({
      targetPairBudgetUsd: 20,
      maxLegCapitalShare: 1,
      polymarket: {
        price: 0.45,
        depth: 100,
        minOrderSize: 0.01,
        fallbackMinOrderSize: 5,
      },
      kalshi: {
        price: 0.45,
        depth: 100,
        minOrderSize: 1,
        fallbackMinOrderSize: 1,
        feeMultiplier: 1,
      },
    });

    expect(sizing.commonSize).toBe(21);
    expect(sizing.totalCostUsd).toBeLessThanOrEqual(20);
  });

  it("quotes multiple price levels with nonlinear Polymarket fees rounded per level", () => {
    const quote = quoteMultiLevelBuyLeg({
      venue: "polymarket",
      size: 10,
      levels: [
        { price: 0.32, size: 5 },
        { price: 0.3, size: 5 },
      ],
      feeRate: 0.02,
      feeExponent: 1,
    });

    expect(
      calculatePolymarketLevelFee({ shares: 5, price: 0.3, feeRate: 0.02, feeExponent: 1 }),
    ).toBe(0.021);
    expect(quote).toMatchObject({
      size: 10,
      notionalUsd: 3.1,
      feeUsd: 0.04276,
      costUsd: 3.14276,
      vwapPrice: 0.31,
      limitPrice: 0.32,
    });
    expect(quote?.consumedLevels.map((level) => level.feeUsd)).toEqual([0.021, 0.02176]);
  });

  it("applies book safety and headroom before quoting a multi-level leg", () => {
    const quote = quoteMultiLevelBuyLeg({
      venue: "kalshi",
      size: 6,
      levels: [
        { price: 0.4, size: 5 },
        { price: 0.41, size: 5 },
      ],
      depthSafetyFactor: 0.8,
      depthHeadroom: 2,
    });

    expect(quote).toMatchObject({
      displayedDepth: 10,
      executableDepth: 6,
      vwapPrice: 0.4033,
      limitPrice: 0.41,
    });
    expect(
      quoteMultiLevelBuyLeg({
        venue: "kalshi",
        size: 7,
        levels: [{ price: 0.4, size: 10 }],
        depthSafetyFactor: 0.8,
        depthHeadroom: 2,
      }),
    ).toBeNull();
  });

  it("aggregates Kalshi fee rounding across all fills of one order", () => {
    const quote = quoteMultiLevelBuyLeg({
      venue: "kalshi",
      size: 3,
      levels: [
        { price: 0.05, size: 1 },
        { price: 0.051, size: 1 },
        { price: 0.052, size: 1 },
      ],
    });

    expect(quote?.feeUsd).toBe(0.02);
    expect(quote?.consumedLevels.reduce((sum, level) => sum + level.feeUsd, 0)).toBeCloseTo(0.02, 5);
  });

  it("never reports a worst-fill cost below the rounded multi-level cost", () => {
    const quote = quoteMultiLevelBuyLeg({
      venue: "polymarket",
      size: 2,
      levels: [
        { price: 0.499, size: 1 },
        { price: 0.5, size: 1 },
      ],
      feeRate: 0.001,
      feeExponent: 1,
    });

    expect(quote).not.toBeNull();
    expect(quote!.worstFillFeeUsd).toBeGreaterThanOrEqual(quote!.feeUsd);
    expect(quote!.worstFillCostUsd).toBeGreaterThanOrEqual(quote!.costUsd);
  });

  it("builds an exact paired VWAP and fee quote across both books", () => {
    const quote = deriveMultiLevelPairedQuote({
      targetPairBudgetUsd: 20,
      polymarket: {
        levels: [
          { price: 0.3, size: 5 },
          { price: 0.32, size: 5 },
        ],
        feeRate: 0.02,
        feeExponent: 1,
      },
      kalshi: {
        levels: [
          { price: 0.55, size: 4 },
          { price: 0.56, size: 6 },
        ],
      },
    });

    expect(quote).toMatchObject({
      commonSize: 10,
      totalCostUsd: 8.8828,
      worstFillCostUsd: 9.0235,
      absoluteFatalLossUsd: 9.0235,
      projectedNetProfitUsd: 1.1172,
      conservativeNetProfitUsd: 0.9765,
      limitingReason: "polymarket_depth",
    });
    expect(quote.polymarket).toMatchObject({
      vwapPrice: 0.31,
      limitPrice: 0.32,
      feeUsd: 0.04276,
      worstFillCostUsd: 3.24352,
    });
    expect(quote.kalshi).toMatchObject({
      vwapPrice: 0.556,
      limitPrice: 0.56,
      feeUsd: 0.18,
      worstFillCostUsd: 5.78,
    });
  });

  it("returns no paired size when one book cannot cover the minimum contract", () => {
    const quote = deriveMultiLevelPairedQuote({
      targetPairBudgetUsd: 10,
      polymarket: { levels: [{ price: 0.3, size: 0.5 }] },
      kalshi: { levels: [{ price: 0.5, size: 10 }] },
    });

    expect(quote.commonSize).toBe(0);
    expect(quote.limitingReason).toBe("polymarket_depth");
  });

  it("sizes against pair budget, venue balance, and maximum leg capital", () => {
    const base = {
      polymarket: { levels: [{ price: 0.3, size: 20 }] },
      kalshi: { levels: [{ price: 0.5, size: 20 }] },
    };

    expect(deriveMultiLevelPairedQuote({ targetPairBudgetUsd: 5, ...base }).commonSize).toBe(6);
    expect(
      deriveMultiLevelPairedQuote({
        targetPairBudgetUsd: 20,
        polymarket: { ...base.polymarket, balanceUsd: 1 },
        kalshi: base.kalshi,
      }),
    ).toMatchObject({ commonSize: 3, limitingReason: "polymarket_balance" });
    expect(
      deriveMultiLevelPairedQuote({
        targetPairBudgetUsd: 5,
        maxLegCapitalShare: 0.5,
        ...base,
      }),
    ).toMatchObject({ commonSize: 4, limitingReason: "max_leg_capital" });
  });

  it("enforces probability-weighted and absolute fatal mismatch budgets", () => {
    const base = {
      targetPairBudgetUsd: 20,
      fatalMismatchProbabilityUpper: 0.1,
      polymarket: { levels: [{ price: 0.3, size: 20 }] },
      kalshi: { levels: [{ price: 0.5, size: 20 }] },
    };

    expect(
      deriveMultiLevelPairedQuote({
        ...base,
        maxProbabilityWeightedFatalLossUsd: 0.2,
      }),
    ).toMatchObject({
      commonSize: 2,
      probabilityWeightedFatalLossUsd: 0.164,
      limitingReason: "probability_weighted_fatal_loss",
    });
    expect(
      deriveMultiLevelPairedQuote({
        ...base,
        maxAbsoluteFatalLossUsd: 1.7,
      }),
    ).toMatchObject({
      commonSize: 2,
      absoluteFatalLossUsd: 1.64,
      limitingReason: "absolute_fatal_loss",
    });
  });

  it("can require fatal probability to stay below a fraction of break-even", () => {
    const quote = deriveMultiLevelPairedQuote({
      targetPairBudgetUsd: 20,
      fatalMismatchProbabilityUpper: 0.1,
      maxFatalProbabilityShareOfBreakEven: 0.5,
      polymarket: { levels: [{ price: 0.3, size: 10 }] },
      kalshi: { levels: [{ price: 0.5, size: 10 }] },
    });

    expect(quote).toMatchObject({ commonSize: 0, limitingReason: "fatal_probability" });
  });

  it("chooses a smaller size when deeper levels reduce conservative dollar profit", () => {
    const quote = deriveMultiLevelPairedQuote({
      targetPairBudgetUsd: 20,
      polymarket: {
        levels: [
          { price: 0.2, size: 2 },
          { price: 0.75, size: 3 },
        ],
      },
      kalshi: { levels: [{ price: 0.4, size: 5 }] },
    });

    expect(quote).toMatchObject({
      commonSize: 2,
      maxExecutableSize: 5,
      conservativeNetProfitUsd: 0.76,
      limitingReason: "conservative_profit",
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
