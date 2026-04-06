import { Side } from "@polymarket/clob-client";

import {
  derivePolymarketDepth,
  extractPolymarketPositionValueUsd,
  extractPolymarketResolution,
  extractPolymarketTradesForOrder,
  microUsdcToUsd,
  summarizePolymarketTrades,
} from "@/lib/polymarket";

describe("Polymarket helpers", () => {
  it("detects resolution from terminal outcome prices", () => {
    expect(extractPolymarketResolution('["1","0"]')).toBe("UP");
    expect(extractPolymarketResolution('["0","1"]')).toBe("DOWN");
    expect(extractPolymarketResolution('["0.61","0.39"]')).toBeNull();
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
});
