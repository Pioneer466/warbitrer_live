import { Side } from "@polymarket/clob-client";

import {
  derivePolymarketDepth,
  extractPolymarketCollateralAllowanceInfo,
  extractPolymarketCollateralAllowanceUsd,
  extractPolymarketPositionValueUsd,
  extractPolymarketResolution,
  extractPolymarketTradesForOrder,
  getPolymarketSoftNoFillMessage,
  isConfirmedPolymarketTrade,
  isPendingPolymarketTrade,
  mapPolymarketOrder,
  mapPolymarketTradeToFill,
  microUsdcToUsd,
  shouldTreatPolymarketTerminalOrderAsPending,
  summarizePolymarketTradeLifecycle,
  summarizePolymarketTrades,
} from "@/lib/polymarket";

describe("Polymarket helpers", () => {
  it("detects resolution from terminal outcome prices", () => {
    expect(extractPolymarketResolution('["1","0"]')).toBe("UP");
    expect(extractPolymarketResolution('["0","1"]')).toBe("DOWN");
    expect(extractPolymarketResolution('["0.61","0.39"]')).toBeNull();
  });

  it("classifies Polymarket FOK kill responses as soft no-fill errors", () => {
    expect(
      getPolymarketSoftNoFillMessage(
        new Error("order couldn't be fully filled. FOK orders are fully filled or killed."),
      ),
    ).toContain("FOK orders are fully filled or killed");

    expect(getPolymarketSoftNoFillMessage(new Error("authentication error"))).toBeNull();
  });

  it("uses the ask side depth closest to the targeted buy execution", () => {
    const depth = derivePolymarketDepth(
      {
        bids: [
          { price: "0.70", size: "126.24" },
          { price: "0.72", size: "193.85" },
        ],
        asks: [
          { price: "0.80", size: "774.5" },
          { price: "0.81", size: "219.32" },
        ],
      },
      0.72,
    );

    expect(depth).toBe(774.5);
  });

  it("converts polymarket collateral balances from micro-USDC to USD", () => {
    expect(microUsdcToUsd("9993384")).toBe(9.993384);
    expect(microUsdcToUsd(1000000)).toBe(1);
  });

  it("extracts a direct collateral allowance when the legacy field is present", () => {
    expect(extractPolymarketCollateralAllowanceUsd({ allowance: "2500000" }, "EOA")).toBe(2.5);
  });

  it("extracts the most relevant collateral allowance from allowance maps", () => {
    expect(
      extractPolymarketCollateralAllowanceUsd(
        {
          allowances: {
            main: "5000000",
            negRisk: "3000000",
          },
        },
        "EOA",
      ),
    ).toBe(3);

    expect(
      extractPolymarketCollateralAllowanceUsd(
        {
          allowances: {
            main: "5000000",
            negRisk: "3000000",
          },
        },
        "POLY_PROXY",
      ),
    ).toBe(5);
  });

  it("marks effectively unlimited allowances without surfacing a nonsense usd amount", () => {
    expect(
      extractPolymarketCollateralAllowanceInfo(
        {
          allowance:
            "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        },
        "EOA",
      ),
    ).toEqual({
      allowanceUsd: null,
      unlimited: true,
    });
  });

  it("parses polymarket position value responses across documented shapes", () => {
    expect(extractPolymarketPositionValueUsd([{ user: "0xabc", value: 5 }])).toBe(5);
    expect(extractPolymarketPositionValueUsd({ total: 12.5 })).toBe(12.5);
    expect(extractPolymarketPositionValueUsd([{ user: "0xabc", total: "3.75" }])).toBe(3.75);
    expect(extractPolymarketPositionValueUsd([])).toBeNull();
    expect(extractPolymarketPositionValueUsd(null)).toBeNull();
  });

  it("aggregates matched trades for a specific order", () => {
    const trades = [
      {
        id: "trade-1",
        taker_order_id: "order-1",
        market: "market-1",
        asset_id: "asset-1",
        side: Side.BUY,
        size: "10",
        fee_rate_bps: "100",
        price: "0.4",
        status: "MATCHED",
        match_time: new Date(10).toISOString(),
        last_update: new Date(10).toISOString(),
        outcome: "UP",
        bucket_index: 0,
        owner: "owner",
        maker_address: "maker",
        maker_orders: [],
        transaction_hash: "0x1",
        trader_side: "TAKER" as const,
      },
      {
        id: "trade-2",
        taker_order_id: "order-2",
        market: "market-1",
        asset_id: "asset-1",
        side: Side.BUY,
        size: "5",
        fee_rate_bps: "50",
        price: "0.5",
        status: "MATCHED",
        match_time: new Date(11).toISOString(),
        last_update: new Date(11).toISOString(),
        outcome: "UP",
        bucket_index: 0,
        owner: "owner",
        maker_address: "maker",
        maker_orders: [{ order_id: "order-1", owner: "maker", maker_address: "maker", matched_amount: "5", price: "0.5", fee_rate_bps: "50", asset_id: "asset-1", outcome: "UP", side: Side.SELL }],
        transaction_hash: "0x2",
        trader_side: "MAKER" as const,
      },
    ];

    const matching = extractPolymarketTradesForOrder(trades, "order-1");
    const summary = summarizePolymarketTrades(matching);

    expect(matching).toHaveLength(2);
    expect(summary.filledSize).toBe(15);
    expect(summary.averageFillPrice).toBeCloseTo(0.4333, 4);
    expect(summary.feeUsd).toBeCloseTo(0.0525, 4);
  });

  it("separates confirmed polymarket trades from pending settlement trades", () => {
    const trades = [
      {
        id: "trade-confirmed",
        taker_order_id: "order-1",
        market: "market-1",
        asset_id: "asset-1",
        side: Side.BUY,
        size: "10",
        fee_rate_bps: "100",
        price: "0.4",
        status: "CONFIRMED",
        match_time: new Date(10).toISOString(),
        last_update: new Date(10).toISOString(),
        outcome: "UP",
        bucket_index: 0,
        owner: "owner",
        maker_address: "maker",
        maker_orders: [],
        transaction_hash: "0x1",
        trader_side: "TAKER" as const,
      },
      {
        id: "trade-matched",
        taker_order_id: "order-1",
        market: "market-1",
        asset_id: "asset-1",
        side: Side.BUY,
        size: "5",
        fee_rate_bps: "100",
        price: "0.41",
        status: "MATCHED",
        match_time: new Date(11).toISOString(),
        last_update: new Date(11).toISOString(),
        outcome: "UP",
        bucket_index: 0,
        owner: "owner",
        maker_address: "maker",
        maker_orders: [],
        transaction_hash: "0x2",
        trader_side: "TAKER" as const,
      },
    ];

    expect(isConfirmedPolymarketTrade(trades[0]!)).toBe(true);
    expect(isPendingPolymarketTrade(trades[1]!)).toBe(true);

    const lifecycle = summarizePolymarketTradeLifecycle(trades as any);
    expect(lifecycle.confirmedTrades).toHaveLength(1);
    expect(lifecycle.pendingTrades).toHaveLength(1);
    expect(summarizePolymarketTrades(lifecycle.confirmedTrades).filledSize).toBe(10);
  });

  it("maps MATCHED polymarket orders to pending until confirmed settlement", () => {
    const mapped = mapPolymarketOrder(
      {
        id: "order-1",
        status: "MATCHED",
        market: "market-1",
        asset_id: "asset-1",
        side: "BUY",
        original_size: "62.675",
        size_matched: "62.675",
        price: "0.4",
        outcome: "Down",
        order_type: "FOK",
        maker_address: "0xabc",
        owner: "owner",
        expiration: "0",
        associate_trades: ["trade-1"],
        created_at: 1775513261,
      } as any,
      "intent-1",
    );

    expect(mapped.status).toBe("pending");
    expect(mapped.requestedSize).toBe(62.675);
    expect(mapped.createdAt).toBe(1775513261000);
    expect(mapped.updatedAt).toBe(1775513261000);
  });

  it("treats terminal orders with only pending trades as still pending", () => {
    expect(shouldTreatPolymarketTerminalOrderAsPending(1, 0)).toBe(true);
    expect(shouldTreatPolymarketTerminalOrderAsPending(0, 0)).toBe(false);
    expect(shouldTreatPolymarketTerminalOrderAsPending(2, 5)).toBe(false);
  });

  it("maps numeric polymarket trade timestamps to millisecond fill times", () => {
    const fill = mapPolymarketTradeToFill(
      {
        id: "trade-1",
        taker_order_id: "order-1",
        market: "market-1",
        asset_id: "asset-1",
        side: Side.BUY,
        size: "10",
        fee_rate_bps: "100",
        price: "0.4",
        status: "CONFIRMED",
        match_time: "1775513261",
        last_update: "1775513261",
        outcome: "DOWN",
        bucket_index: 0,
        owner: "owner",
        maker_address: "maker",
        maker_orders: [],
        transaction_hash: "0x1",
        trader_side: "TAKER" as const,
      } as any,
      "intent-1",
      "order-1",
    );

    expect(fill.filledAt).toBe(1775513261000);
  });
});
