import { Side } from "@polymarket/clob-client-v2";

import {
  buildPolymarketClobOrderPlan,
  derivePolymarketDepth,
  derivePolymarketEffectiveFeeRateBps,
  extractPolymarketCollateralAllowanceInfo,
  extractPolymarketCollateralAllowanceUsd,
  extractPolymarketPositionValueUsd,
  fetchPolymarketMarket,
  fetchPolymarketResolution,
  extractPolymarketResolution,
  extractPolymarketTradesForOrder,
  getPolymarketSoftNoFillMessage,
  isConfirmedPolymarketTrade,
  isPendingPolymarketTrade,
  mapPolymarketOrder,
  mapPolymarketTradeToFill,
  microUsdcToUsd,
  resolvePolymarketOrderTruth,
  shouldTreatPolymarketTerminalOrderAsPending,
  summarizePolymarketTradeLifecycle,
  summarizePolymarketTrades,
} from "@/lib/polymarket";
import { vi } from "vitest";

describe("Polymarket helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("builds BUY orders as USDC amount market orders", () => {
    const plan = buildPolymarketClobOrderPlan({
      marketRef: "market-1",
      tokenId: "token-1",
      outcome: "DOWN",
      side: "BUY",
      size: 10,
      price: 0.71,
      maxCostUsd: 7.1,
      orderType: "FOK",
      reduceOnly: false,
      clientOrderId: "client-1",
    });

    expect(plan.kind).toBe("market-buy");
    expect(plan.orderType).toBe("FOK");
    expect(plan.order).toMatchObject({
      tokenID: "token-1",
      side: Side.BUY,
      amount: 7.1,
      price: 0.71,
      orderType: "FOK",
    });
    expect("size" in plan.order).toBe(false);
  });

  it("keeps SELL orders share-sized for Polymarket market sells", () => {
    const plan = buildPolymarketClobOrderPlan({
      marketRef: "market-1",
      tokenId: "token-1",
      outcome: "DOWN",
      side: "SELL",
      size: 10,
      price: 0.68,
      maxCostUsd: 0,
      orderType: "FAK",
      reduceOnly: true,
      clientOrderId: "client-2",
    });

    expect(plan.kind).toBe("market-sell");
    expect(plan.orderType).toBe("FAK");
    expect(plan.order).toMatchObject({
      tokenID: "token-1",
      side: Side.SELL,
      amount: 10,
      price: 0.68,
    });
    expect("size" in plan.order).toBe(false);
  });

  it("detects resolution from terminal outcome prices", () => {
    expect(extractPolymarketResolution('["1","0"]')).toBe("UP");
    expect(extractPolymarketResolution('["0","1"]')).toBe("DOWN");
    expect(extractPolymarketResolution('["0.61","0.39"]')).toBeNull();
  });

  it("falls back to Gamma events for historical recurring markets missing from /markets", async () => {
    const historicalEventResponse = [
      {
        id: "409301",
        slug: "eth-updown-15m-1777022100",
        markets: [
          {
            id: "2058859",
            conditionId: "0x95f328bdcb938c4028ad72e6aeb94bbe5d27718b6907b2c88aa66d7d14669b85",
            question: "Ethereum Up or Down - April 24, 5:15AM-5:30AM ET",
            slug: "eth-updown-15m-1777022100",
            endDate: "2026-04-24T09:30:00Z",
            startDate: "2026-04-23T09:23:19.988613Z",
            outcomes: '["Up","Down"]',
            clobTokenIds:
              '["50568372059988782577905600550368228208982764013889510480059438629092033192000","109025557218839786829770351242082471908150399808536036632532627608105781407868"]',
            feeType: "crypto_fees_v2",
            active: true,
            closed: true,
            enableOrderBook: true,
            outcomePrices: '["0","1"]',
          },
        ],
      },
    ];

    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/markets?slug=eth-updown-15m-1777022100")) {
        return {
          ok: true,
          json: async () => [],
        };
      }
      if (url.includes("/events?slug=eth-updown-15m-1777022100")) {
        return {
          ok: true,
          json: async () => historicalEventResponse,
        };
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock as any);

    await expect(
      fetchPolymarketResolution(
        "eth-updown-15m-1777022100",
        "0x95f328bdcb938c4028ad72e6aeb94bbe5d27718b6907b2c88aa66d7d14669b85",
      ),
    ).resolves.toBe("DOWN");

    await expect(
      fetchPolymarketMarket(
        "eth-updown-15m-1777022100",
        "0x95f328bdcb938c4028ad72e6aeb94bbe5d27718b6907b2c88aa66d7d14669b85",
      ),
    ).resolves.toMatchObject({
      slug: "eth-updown-15m-1777022100",
      conditionId: "0x95f328bdcb938c4028ad72e6aeb94bbe5d27718b6907b2c88aa66d7d14669b85",
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/markets?slug=eth-updown-15m-1777022100");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/events?slug=eth-updown-15m-1777022100");
  });

  it("classifies Polymarket FOK kill responses as soft no-fill errors", () => {
    expect(
      getPolymarketSoftNoFillMessage(
        new Error("order couldn't be fully filled. FOK orders are fully filled or killed."),
      ),
    ).toContain("FOK orders are fully filled or killed");
    expect(
      getPolymarketSoftNoFillMessage({
        success: false,
        errorMsg: "FOK_ORDER_NOT_FILLED_ERROR",
      }),
    ).toBe("FOK_ORDER_NOT_FILLED_ERROR");

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

  it("maps CLOB V2 fee details to an effective notional bps estimate", () => {
    expect(derivePolymarketEffectiveFeeRateBps({ fd: { r: 0.02, e: 1, to: true } }, 0.4)).toBe(120);
    expect(derivePolymarketEffectiveFeeRateBps(null, 0.4)).toBe(0);
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
    expect(mapped.filledSize).toBe(62.675);
    expect(mapped.requestedSize).toBe(62.675);
    expect(mapped.createdAt).toBe(1775513261000);
    expect(mapped.updatedAt).toBe(1775513261000);
  });

  it("treats matched size as effective exposure even before trades are confirmed", () => {
    const truth = resolvePolymarketOrderTruth({
      orderId: "order-1",
      order: {
        id: "order-1",
        status: "MATCHED",
        market: "market-1",
        asset_id: "asset-1",
        side: "BUY",
        original_size: "10",
        size_matched: "10",
        price: "0.71",
        outcome: "Down",
        order_type: "FOK",
        maker_address: "0xabc",
        owner: "owner",
        expiration: "0",
        associate_trades: [],
        created_at: 1775513261,
      } as any,
      trades: [],
      expectedSize: 10,
      expectedSizeIsExact: true,
      orderType: "FOK",
    });

    expect(truth.effectiveFilledSize).toBe(10);
    expect(truth.confirmedFilledSize).toBe(0);
    expect(truth.hasPendingExposure).toBe(true);
    expect(truth.terminalZeroFill).toBe(false);
    expect(truth.status).toBe("pending");
  });

  it("uses pending Polymarket trades as effective exposure", () => {
    const truth = resolvePolymarketOrderTruth({
      orderId: "order-1",
      order: null,
      trades: [
        {
          id: "trade-1",
          taker_order_id: "order-1",
          market: "market-1",
          asset_id: "asset-1",
          side: Side.BUY,
          size: "10",
          fee_rate_bps: "0",
          price: "0.71",
          status: "MATCHED",
          match_time: new Date(11).toISOString(),
          last_update: new Date(11).toISOString(),
          outcome: "DOWN",
          bucket_index: 0,
          owner: "owner",
          maker_address: "maker",
          maker_orders: [],
          transaction_hash: "0x2",
          trader_side: "TAKER" as const,
        },
      ] as any,
      expectedSize: 10,
      expectedSizeIsExact: true,
      orderType: "FOK",
    });

    expect(truth.effectiveFilledSize).toBe(10);
    expect(truth.pendingFilledSize).toBe(10);
    expect(truth.status).toBe("pending");
    expect(truth.terminalZeroFill).toBe(false);
  });

  it("marks canceled Polymarket orders as retryable only when effective exposure is zero", () => {
    const truth = resolvePolymarketOrderTruth({
      orderId: "order-1",
      order: {
        id: "order-1",
        status: "CANCELED",
        market: "market-1",
        asset_id: "asset-1",
        side: "BUY",
        original_size: "10",
        size_matched: "0",
        price: "0.71",
        outcome: "Down",
        order_type: "FOK",
        maker_address: "0xabc",
        owner: "owner",
        expiration: "0",
        associate_trades: [],
        created_at: 1775513261,
      } as any,
      trades: [],
      expectedSize: 10,
      expectedSizeIsExact: true,
      orderType: "FOK",
    });

    expect(truth.effectiveFilledSize).toBe(0);
    expect(truth.terminalZeroFill).toBe(true);
    expect(truth.status).toBe("canceled");
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
