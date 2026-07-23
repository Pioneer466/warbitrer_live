import { Side, type Trade } from "@polymarket/clob-client-v2";

import {
  buildCanonicalPolymarketMarketRef,
  buildPolymarketClobOrderPlan,
  derivePolymarketConfirmationRequestTimeoutMs,
  derivePolymarketDepth,
  derivePolymarketEffectiveFeeRateBps,
  derivePolymarketFeeMetadata,
  extractPolymarketCollateralAllowanceInfo,
  extractPolymarketCollateralAllowanceUsd,
  extractPolymarketPositionValueUsd,
  fetchPolymarketMarket,
  fetchPolymarketResolution,
  fetchFinalizedPolymarketResolution,
  fetchFinalizedPolymarketResolutionObservation,
  extractPolymarketResolution,
  extractPolymarketTradesForOrder,
  getPolymarketTradeOrderMappingIssue,
  getPolymarketSoftNoFillMessage,
  isConfirmedPolymarketTrade,
  isPolymarketBuilderCodeActive,
  isPendingPolymarketTrade,
  mapPolymarketOrder,
  mapPolymarketTradeToFill,
  microUsdcToUsd,
  resolvePolymarketOrderTruth,
  shouldAcceptPolymarketTerminalZeroFill,
  shouldTreatPolymarketTerminalOrderAsPending,
  summarizePolymarketTradeLifecycle,
  summarizePolymarketTrades,
} from "@/lib/polymarket";
import { vi } from "vitest";
import type { MarketSlot } from "@/lib/types";

describe("Polymarket helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("bounds confirmation REST calls by the remaining confirmation deadline", () => {
    expect(derivePolymarketConfirmationRequestTimeoutMs(1_500, 1_000, 15_000)).toBe(500);
    expect(derivePolymarketConfirmationRequestTimeoutMs(30_000, 1_000, 15_000)).toBe(15_000);
    expect(derivePolymarketConfirmationRequestTimeoutMs(999, 1_000, 15_000)).toBe(0);
  });

  it("builds BUY hedge orders as exact share limit orders by default", () => {
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

    expect(plan.kind).toBe("limit-buy");
    expect(plan.orderType).toBe("FOK");
    expect(plan.order).toMatchObject({
      tokenID: "token-1",
      side: Side.BUY,
      price: 0.71,
      size: 10,
    });
    expect("amount" in plan.order).toBe(false);
  });

  it("distinguishes an active builder code from the no-builder wire representations", () => {
    expect(isPolymarketBuilderCodeActive(undefined)).toBe(false);
    expect(isPolymarketBuilderCodeActive("")).toBe(false);
    expect(isPolymarketBuilderCodeActive(`0x${"0".repeat(64)}`)).toBe(false);
    expect(isPolymarketBuilderCodeActive(`0x${"1".repeat(64)}`)).toBe(true);
  });

  it("keeps legacy Polymarket BUY amount mode explicit", () => {
    const plan = buildPolymarketClobOrderPlan({
      marketRef: "market-1",
      tokenId: "token-1",
      outcome: "DOWN",
      side: "BUY",
      size: 10,
      price: 0.71,
      maxCostUsd: 7.1,
      orderType: "FOK",
      buyMode: "amount",
      reduceOnly: false,
      clientOrderId: "client-1",
    });

    expect(plan.kind).toBe("market-buy");
    expect(plan.order).toMatchObject({
      tokenID: "token-1",
      side: Side.BUY,
      amount: 7.1,
      price: 0.71,
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

  it("uses canonical slot times when Gamma startDate is the listing creation time", () => {
    const slot: MarketSlot = {
      asset: "bnb",
      key: "bnb:1784816100000",
      startTs: 1784816100000,
      endTs: 1784817000000,
      startIso: "2026-07-23T14:15:00.000Z",
      endIso: "2026-07-23T14:30:00.000Z",
      label: "Jul 23, 10:15 AM - Jul 23, 10:30 AM",
      polymarketSlug: "bnb-updown-15m-1784816100",
      secondsRemaining: 600,
    };
    const market = {
      id: "3029431",
      conditionId: "condition-bnb",
      question: "BNB Up or Down",
      slug: slot.polymarketSlug,
      startDate: "2026-07-22T14:23:02.516274Z",
      endDate: "2026-07-23T14:30:00Z",
    };

    expect(buildCanonicalPolymarketMarketRef(slot, market)).toMatchObject({
      slotKey: slot.key,
      slug: slot.polymarketSlug,
      conditionId: "condition-bnb",
      startTime: slot.startIso,
      endTime: slot.endIso,
    });
    expect(() =>
      buildCanonicalPolymarketMarketRef(slot, {
        ...market,
        endDate: "2026-07-23T14:45:00Z",
      }),
    ).toThrow("end time does not match");
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
            umaResolutionStatus: "resolved",
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

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(
      fetchPolymarketResolution(
        "eth-updown-15m-1777022100",
        "0x95f328bdcb938c4028ad72e6aeb94bbe5d27718b6907b2c88aa66d7d14669b85",
      ),
    ).resolves.toBe("DOWN");

    await expect(
      fetchFinalizedPolymarketResolution(
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

  it("rejects a closed Polymarket outcome until UMA reports it resolved", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: "market-1",
          conditionId: "condition-1",
          question: "BTC Up or Down",
          slug: "btc-updown-15m-1",
          endDate: "2026-01-01T00:15:00Z",
          startDate: "2026-01-01T00:00:00Z",
          outcomes: '["Up","Down"]',
          clobTokenIds: '["up","down"]',
          feeType: "crypto_fees_v2",
          active: false,
          closed: true,
          enableOrderBook: true,
          outcomePrices: '["1","0"]',
          umaResolutionStatus: "proposed",
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(fetchPolymarketResolution("btc-updown-15m-1", "condition-1")).resolves.toBeNull();
    await expect(fetchFinalizedPolymarketResolution("btc-updown-15m-1", "condition-1")).resolves.toBeNull();
  });

  it("does not fall back to a matching slug when the requested condition is absent", async () => {
    const wrongConditionMarket = {
      id: "market-other",
      conditionId: "condition-other",
      question: "BTC Up or Down",
      slug: "btc-updown-15m-1",
      endDate: "2026-01-01T00:15:00Z",
      startDate: "2026-01-01T00:00:00Z",
      outcomes: '["Up","Down"]',
      clobTokenIds: '["up","down"]',
      feeType: "crypto_fees_v2",
      active: false,
      closed: true,
      enableOrderBook: true,
      outcomePrices: '["1","0"]',
      umaResolutionStatus: "resolved",
    };
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        String(input).includes("/events?")
          ? [{ id: "event-1", slug: "btc-updown-15m-1", markets: [wrongConditionMarket] }]
          : [wrongConditionMarket],
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(fetchPolymarketMarket("btc-updown-15m-1", "condition-missing")).resolves.toBeNull();
    await expect(fetchPolymarketResolution("btc-updown-15m-1", "condition-missing")).resolves.toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/events?slug=btc-updown-15m-1"))).toBe(true);
  });

  it("keeps coherent Gamma terminal metadata as optional calibration telemetry", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      return {
        ok: true,
        json: async () =>
          url.includes("/events?")
            ? [
                {
                  id: "event-1",
                  slug: "btc-updown-15m-1",
                  eventMetadata: {
                    finalPrice: "99",
                    priceToBeat: "100",
                  },
                  markets: [
                    {
                      id: "market-1",
                      conditionId: "condition-1",
                      slug: "btc-updown-15m-1",
                    },
                  ],
                },
              ]
            : [
                {
                  id: "market-1",
                  conditionId: "condition-1",
                  slug: "btc-updown-15m-1",
                  closed: true,
                  outcomePrices: '["0","1"]',
                  umaResolutionStatus: "resolved",
                },
              ],
      };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(fetchFinalizedPolymarketResolutionObservation("btc-updown-15m-1", "condition-1")).resolves.toEqual({
      resolution: "DOWN",
      benchmarkValueUsd: 99,
      benchmarkSource: "polymarket-gamma-event-final-price",
    });
  });

  it("never lets absent or inconsistent Gamma metadata invalidate the outcome label", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        String(input).includes("/events?")
          ? [
              {
                id: "event-1",
                slug: "btc-updown-15m-1",
                eventMetadata: { finalPrice: 101, priceToBeat: 100 },
                markets: [
                  {
                    id: "market-1",
                    conditionId: "condition-1",
                    slug: "btc-updown-15m-1",
                  },
                ],
              },
            ]
          : [
              {
                id: "market-1",
                conditionId: "condition-1",
                slug: "btc-updown-15m-1",
                closed: true,
                outcomePrices: '["0","1"]',
                umaResolutionStatus: "resolved",
              },
            ],
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(fetchFinalizedPolymarketResolutionObservation("btc-updown-15m-1", "condition-1")).resolves.toEqual({
      resolution: "DOWN",
      benchmarkValueUsd: null,
      benchmarkSource: null,
    });
  });

  it("treats equality to Polymarket priceToBeat as UP metadata", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        String(input).includes("/events?")
          ? [
              {
                id: "event-1",
                slug: "btc-updown-15m-1",
                eventMetadata: { finalPrice: 100, priceToBeat: 100 },
                markets: [
                  {
                    id: "market-1",
                    conditionId: "condition-1",
                    slug: "btc-updown-15m-1",
                  },
                ],
              },
            ]
          : [
              {
                id: "market-1",
                conditionId: "condition-1",
                slug: "btc-updown-15m-1",
                closed: true,
                outcomePrices: '["1","0"]',
                umaResolutionStatus: "resolved",
              },
            ],
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(
      fetchFinalizedPolymarketResolutionObservation("btc-updown-15m-1", "condition-1"),
    ).resolves.toMatchObject({ resolution: "UP", benchmarkValueUsd: 100 });
  });

  it("keeps the outcome when Gamma event metadata is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => ({
        ok: true,
        json: async () =>
          String(input).includes("/events?")
            ? [
                {
                  id: "event-1",
                  slug: "btc-updown-15m-1",
                  markets: [{ id: "market-1", conditionId: "condition-1", slug: "btc-updown-15m-1" }],
                },
              ]
            : [
                {
                  id: "market-1",
                  conditionId: "condition-1",
                  slug: "btc-updown-15m-1",
                  closed: true,
                  outcomePrices: '["1","0"]',
                  umaResolutionStatus: "resolved",
                },
              ],
      })) as unknown as typeof fetch,
    );

    await expect(fetchFinalizedPolymarketResolutionObservation("btc-updown-15m-1", "condition-1")).resolves.toEqual({
      resolution: "UP",
      benchmarkValueUsd: null,
      benchmarkSource: null,
    });
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

  it("distinguishes exact CLOB fee metadata from unknown and explicit fee-free markets", () => {
    expect(derivePolymarketFeeMetadata({ fd: { r: 0.02, e: 1, to: true } })).toEqual({
      feeMetadataPresent: true,
      feesEnabled: true,
    });
    expect(derivePolymarketFeeMetadata({ fd: { r: 0, e: 0, to: false } })).toEqual({
      feeMetadataPresent: true,
      feesEnabled: false,
    });
    expect(derivePolymarketFeeMetadata({ fd: {} })).toEqual({
      feeMetadataPresent: true,
      feesEnabled: null,
    });
    expect(derivePolymarketFeeMetadata(null)).toEqual({
      feeMetadataPresent: false,
      feesEnabled: null,
    });
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
          allowance: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
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
    const trades: Trade[] = [
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
        size: "20",
        fee_rate_bps: "100",
        price: "0.44",
        status: "MATCHED",
        match_time: new Date(11).toISOString(),
        last_update: new Date(11).toISOString(),
        outcome: "UP",
        bucket_index: 0,
        owner: "owner",
        maker_address: "maker",
        maker_orders: [
          {
            order_id: "order-1",
            owner: "maker",
            maker_address: "maker",
            matched_amount: "5",
            price: "0.5",
            fee_rate_bps: "50",
            asset_id: "asset-1",
            outcome: "UP",
            side: Side.SELL,
          },
        ],
        transaction_hash: "0x2",
        trader_side: "MAKER" as const,
      },
    ];

    const matching = extractPolymarketTradesForOrder(trades, "order-1");
    const summary = summarizePolymarketTrades(matching, "order-1");
    const truth = resolvePolymarketOrderTruth({
      orderId: "order-1",
      order: null,
      trades,
      expectedSize: 15,
      expectedSizeIsExact: true,
      orderType: "FOK",
    });
    const makerFill = mapPolymarketTradeToFill(trades[1]!, "intent-1", {
      asset: "eth",
      venueOrderId: "order-1",
    });

    expect(matching).toHaveLength(2);
    expect(summary.filledSize).toBe(15);
    expect(summary.averageFillPrice).toBeCloseTo(0.4333, 4);
    expect(summary.feeUsd).toBe(0);
    expect(truth).toMatchObject({
      effectiveFilledSize: 15,
      pendingFilledSize: 15,
      averageFillPrice: 0.4333,
      feeUsd: 0,
    });
    expect(makerFill).toMatchObject({
      id: "polymarket-fill:trade-2:order-1",
      asset: "eth",
      venueOrderId: "order-1",
      tokenId: "asset-1",
      side: "SELL",
      outcome: "UP",
      price: 0.5,
      size: 5,
      feeUsd: 0,
      liquidity: "MAKER",
    });
  });

  it.each(["eth", "sol", "xrp", "doge", "bnb", "hype"] as const)(
    "uses authoritative %s context for opaque Polymarket trade market ids",
    (asset) => {
      const fill = mapPolymarketTradeToFill(
        {
          id: `trade-${asset}`,
          taker_order_id: `order-${asset}`,
          market: "0xopaque-condition-id",
          asset_id: `token-${asset}`,
          side: Side.BUY,
          size: "2",
          fee_rate_bps: "0",
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
          trader_side: "TAKER",
        },
        `intent-${asset}`,
        {
          asset,
          venueOrderId: `order-${asset}`,
        },
      );

      expect(fill.asset).toBe(asset);
    },
  );

  it("skips a maker match instead of borrowing the taker side when maker side is absent", () => {
    const trade = {
      id: "trade-missing-maker-side",
      taker_order_id: "taker-order",
      market: "market-1",
      asset_id: "taker-asset",
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
      maker_orders: [
        {
          order_id: "maker-order",
          owner: "maker",
          maker_address: "maker",
          matched_amount: "5",
          price: "0.6",
          fee_rate_bps: "50",
          asset_id: "maker-asset",
          outcome: "DOWN",
        },
      ],
      transaction_hash: "0xmissing-side",
      trader_side: "MAKER" as const,
    };

    expect(getPolymarketTradeOrderMappingIssue(trade, "maker-order")).toBe("maker_side_missing");
    expect(summarizePolymarketTrades([trade], "maker-order")).toEqual({
      filledSize: 0,
      averageFillPrice: null,
      feeUsd: 0,
    });
    expect(() => mapPolymarketTradeToFill(trade, "intent-1", "maker-order")).toThrow("Polymarket maker side missing");
    expect(() =>
      resolvePolymarketOrderTruth({
        orderId: "maker-order",
        order: null,
        trades: [trade],
      }),
    ).toThrow("Polymarket maker side missing");
  });

  it("uses authoritative asset context when mapping an opaque Polymarket order", () => {
    const order = mapPolymarketOrder(
      {
        id: "order-sol",
        status: "LIVE",
        market: "0xopaque-condition-id",
        asset_id: "token-sol",
        side: "BUY",
        original_size: "2",
        size_matched: "0",
        price: "0.4",
        outcome: "Up",
        order_type: "FOK",
        maker_address: "0xabc",
        owner: "owner",
        expiration: "0",
        associate_trades: [],
        created_at: 1775513261,
      },
      "intent-sol",
      { asset: "sol" },
    );

    expect(order.asset).toBe("sol");
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

    const lifecycle = summarizePolymarketTradeLifecycle(trades);
    expect(lifecycle.confirmedTrades).toHaveLength(1);
    expect(lifecycle.pendingTrades).toHaveLength(1);
    expect(lifecycle.unknownTrades).toHaveLength(0);
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
      },
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
      },
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
      ],
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
      },
      trades: [],
      expectedSize: 10,
      expectedSizeIsExact: true,
      orderType: "FOK",
    });

    expect(truth.effectiveFilledSize).toBe(0);
    expect(truth.terminalZeroFill).toBe(true);
    expect(truth.status).toBe("canceled");
    expect(
      shouldAcceptPolymarketTerminalZeroFill(truth, {
        order: { ok: true, error: null },
        trades: { ok: true, error: null },
      }),
    ).toBe(true);
    expect(
      shouldAcceptPolymarketTerminalZeroFill(truth, {
        order: { ok: true, error: null },
        trades: { ok: false, error: "trades unavailable" },
      }),
    ).toBe(false);
  });

  it("treats terminal orders with only pending trades as still pending", () => {
    expect(shouldTreatPolymarketTerminalOrderAsPending(1, 0)).toBe(true);
    expect(shouldTreatPolymarketTerminalOrderAsPending(0, 0)).toBe(false);
    expect(shouldTreatPolymarketTerminalOrderAsPending(2, 5)).toBe(false);
  });

  it("accepts only documented short and prefixed Polymarket trade statuses", () => {
    const trade = {
      id: "trade-status",
      taker_order_id: "order-1",
      market: "market-1",
      asset_id: "asset-1",
      side: Side.BUY,
      size: "10",
      fee_rate_bps: "0",
      price: "0.4",
      status: "TRADE_STATUS_CONFIRMED",
      match_time: new Date(10).toISOString(),
      last_update: new Date(10).toISOString(),
      outcome: "UP",
      bucket_index: 0,
      owner: "owner",
      maker_address: "maker",
      maker_orders: [],
      transaction_hash: "0x1",
      trader_side: "TAKER" as const,
    };

    expect(isConfirmedPolymarketTrade(trade)).toBe(true);
    expect(isPendingPolymarketTrade({ ...trade, status: "TRADE_STATUS_MATCHED" })).toBe(true);
    expect(isConfirmedPolymarketTrade({ ...trade, status: "TRADE_STATUS_SETTLED" })).toBe(false);
    expect(isPendingPolymarketTrade({ ...trade, status: "TRADE_STATUS_SETTLED" })).toBe(false);
    expect(summarizePolymarketTrades([{ ...trade, status: "TRADE_STATUS_SETTLED" }], "order-1").filledSize).toBe(0);
    expect(summarizePolymarketTrades([{ ...trade, status: "TRADE_STATUS_FAILED" }], "order-1").filledSize).toBe(0);
  });

  it.each(["TRADE_STATUS_SETTLED", "FUTURE_UNKNOWN_STATUS"])(
    "keeps terminal zero-fill truth pending for an associated trade with unknown status %s",
    (status) => {
      const trade = {
        id: "trade-unknown",
        taker_order_id: "order-unknown",
        market: "market-1",
        asset_id: "asset-1",
        side: Side.BUY,
        size: "10",
        fee_rate_bps: "0",
        price: "0.4",
        status,
        match_time: new Date(10).toISOString(),
        last_update: new Date(10).toISOString(),
        outcome: "UP",
        bucket_index: 0,
        owner: "owner",
        maker_address: "maker",
        maker_orders: [],
        transaction_hash: "0x1",
        trader_side: "TAKER" as const,
      };
      const truth = resolvePolymarketOrderTruth({
        orderId: "order-unknown",
        order: {
          id: "order-unknown",
          status: "CANCELED",
          market: "market-1",
          asset_id: "asset-1",
          side: "BUY",
          original_size: "10",
          size_matched: "0",
          price: "0.4",
          outcome: "Up",
          order_type: "FOK",
          maker_address: "0xabc",
          owner: "owner",
          expiration: "0",
          associate_trades: ["trade-unknown"],
          created_at: 1775513261,
        },
        trades: [trade],
        expectedSize: 10,
        expectedSizeIsExact: true,
        orderType: "FOK",
      });

      expect(summarizePolymarketTradeLifecycle([trade]).unknownTrades).toEqual([trade]);
      expect(truth).toMatchObject({
        effectiveFilledSize: 0,
        hasPendingExposure: true,
        hasUnknownTradeTruth: true,
        terminalZeroFill: false,
        status: "pending",
      });
      expect(
        shouldAcceptPolymarketTerminalZeroFill(truth, {
          order: { ok: true, error: null },
          trades: { ok: true, error: null },
        }),
      ).toBe(false);
    },
  );

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
      },
      "intent-1",
      "order-1",
    );

    expect(fill.filledAt).toBe(1775513261000);
    expect(fill.asset).toBe("btc");
  });
});
