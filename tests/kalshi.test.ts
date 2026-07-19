import { generateKeyPairSync } from "node:crypto";

import {
  buildKalshiV2OrderPayload,
  deriveKalshiBalanceSummary,
  buildKalshiSigningPath,
  createKalshiAdapter,
  deriveKalshiOutcomeQuotes,
  deriveKalshiOutcomeQuotesFromMarket,
  fetchKalshiFills,
  fetchKalshiResolution,
  fetchFinalizedKalshiResolution,
  fetchFinalizedKalshiResolutionObservation,
  fetchKalshiMarkets,
  fetchKalshiMarketsForSlot,
  fetchKalshiOrders,
  getKalshiFillFeeUsd,
  getKalshiFillPriceUsd,
  getKalshiWsUrls,
  mapKalshiFillToLiveFill,
  getKalshiOrderPriceUsd,
  getKalshiSoftNoFillMessage,
  isTrackedKalshiPosition,
  mapKalshiBalance,
  mapKalshiPosition,
  mapKalshiOrderStatus,
  mapKalshiV2OrderResult,
  normalizeKalshiOrderPrice,
  resolveKalshiMarketForSlot,
} from "@/lib/kalshi";
import type { MarketSlot, VenueOrderRequest } from "@/lib/types";
import { vi } from "vitest";

const TEST_KALSHI_PRIVATE_KEY_PEM = generateKeyPairSync("rsa", {
  modulusLength: 2_048,
  privateKeyEncoding: {
    type: "pkcs8",
    format: "pem",
  },
  publicKeyEncoding: {
    type: "spki",
    format: "pem",
  },
}).privateKey;

function enableAuthenticatedKalshiRequests() {
  process.env.KALSHI_API_KEY_ID = "test-api-key";
  process.env.KALSHI_PRIVATE_KEY_PEM = TEST_KALSHI_PRIVATE_KEY_PEM;
  delete process.env.KALSHI_PRIVATE_KEY_PATH;
}

function createKalshiPositionFixture(ticker: string) {
  return {
    ticker,
    position_fp: "1.00",
    total_traded_dollars: "0.4000",
    market_exposure_dollars: "0.5000",
    realized_pnl_dollars: "0.0000",
    fees_paid_dollars: "0.0100",
    last_updated_ts: "2026-07-19T10:00:00.000Z",
  };
}

function createKalshiOrderFixture(orderId: string) {
  return {
    order_id: orderId,
    client_order_id: `client-${orderId}`,
    ticker: "KXBTC15M-TEST",
    side: "yes" as const,
    action: "buy" as const,
    status: "executed",
    yes_price_dollars: "0.4000",
    fill_count_fp: "1.00",
    remaining_count_fp: "0.00",
    initial_count_fp: "1.00",
  };
}

function createKalshiFillFixture(tradeId: string) {
  return {
    trade_id: tradeId,
    order_id: `order-${tradeId}`,
    market_ticker: "KXBTC15M-TEST",
    is_taker: true,
    side: "yes" as const,
    action: "buy" as const,
    yes_price_dollars: "0.4000",
    count_fp: "1.00",
  };
}

function createVenueOrderRequest(overrides: Partial<VenueOrderRequest> = {}): VenueOrderRequest {
  return {
    marketRef: "KXBTC15M-TEST",
    outcome: "YES",
    side: "BUY",
    size: 10,
    price: 0.45,
    maxCostUsd: 4.5,
    orderType: "FOK",
    reduceOnly: false,
    clientOrderId: "client-v2-test",
    ...overrides,
  };
}

describe("Kalshi quote derivation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DATABASE_URL: "postgres://warbitrer:secret@127.0.0.1:5432/warbitrer_live",
      KALSHI_ENV: "prod",
    };
  });

  it("canonicalizes raw fill semantics back to the submitted order semantics", () => {
    const order = {
      intentId: "intent-1",
      venueOrderId: "kalshi-order-1",
      marketRef: "KXBTC15M-1",
      side: "BUY" as const,
      outcome: "YES" as const,
    };

    const fill = mapKalshiFillToLiveFill(
      {
        trade_id: "trade-1",
        order_id: "kalshi-order-1",
        market_ticker: "KXBTC15M-1",
        is_taker: true,
        side: "no",
        action: "sell",
        yes_price_dollars: "0.41",
        no_price_dollars: "0.59",
        count_fp: "23",
        taker_fees_dollars: "0",
        created_time: "2026-04-10T10:05:00.000Z",
      },
      order,
      3,
    );

    expect(fill.side).toBe("BUY");
    expect(fill.outcome).toBe("YES");
    expect(fill.price).toBe(0.41);
    expect(fill.size).toBe(23);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("prefers the dedicated Kalshi websocket host and keeps the supported shared host as fallback", () => {
    expect(getKalshiWsUrls()).toEqual([
      "wss://external-api-ws.kalshi.com/trade-api/ws/v2",
      "wss://api.elections.kalshi.com/trade-api/ws/v2",
    ]);

    process.env.KALSHI_ENV = "demo";
    expect(getKalshiWsUrls()).toEqual([
      "wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2",
      "wss://demo-api.kalshi.co/trade-api/ws/v2",
    ]);
  });

  it("builds yes/no asks from the reciprocal bid-only orderbook", () => {
    const quotes = deriveKalshiOutcomeQuotes({
      yes_dollars: [
        ["0.10", "12"],
        ["0.67", "114"],
        ["0.76", "1719.12"],
      ],
      no_dollars: [
        ["0.14", "12"],
        ["0.22", "5"],
        ["0.33", "100"],
      ],
    });

    expect(quotes.yes.sellPrice).toBe(0.76);
    expect(quotes.yes.buyPrice).toBe(0.67);
    expect(quotes.no.sellPrice).toBe(0.33);
    expect(quotes.no.buyPrice).toBe(0.24);
    expect(quotes.yes.depth).toBe(100);
    expect(quotes.no.depth).toBe(1719.12);
  });

  it("selects the Kalshi market that matches the requested 15 minute slot", () => {
    const slot: MarketSlot = {
      asset: "btc",
      key: "btc:1774900800000",
      startTs: 1774900800000,
      endTs: 1774901700000,
      startIso: "2026-03-30T20:00:00.000Z",
      endIso: "2026-03-30T20:15:00.000Z",
      label: "Mar 30, 4:00 PM - Mar 30, 4:15 PM",
      polymarketSlug: "btc-updown-15m-1774900800",
      secondsRemaining: 600,
    };

    const market = resolveKalshiMarketForSlot(
      [
        {
          ticker: "KXBTC15M-OLD",
          event_ticker: "KXBTC15M-OLD",
          title: "Old slot",
          open_time: "2026-03-30T19:45:00.000Z",
          close_time: "2026-03-30T20:00:00.000Z",
          status: "active",
          yes_bid_dollars: "0.40",
          yes_ask_dollars: "0.41",
          no_bid_dollars: "0.58",
          no_ask_dollars: "0.59",
          yes_bid_size_fp: "10",
          yes_ask_size_fp: "10",
          no_bid_size_fp: "10",
          no_ask_size_fp: "10",
        },
        {
          ticker: "KXBTC15M-CURRENT",
          event_ticker: "KXBTC15M-CURRENT",
          title: "Current slot",
          open_time: "2026-03-30T20:00:00.000Z",
          close_time: "2026-03-30T20:15:00.000Z",
          status: "open",
          yes_bid_dollars: "0.40",
          yes_ask_dollars: "0.41",
          no_bid_dollars: "0.58",
          no_ask_dollars: "0.59",
          yes_bid_size_fp: "10",
          yes_ask_size_fp: "10",
          no_bid_size_fp: "10",
          no_ask_size_fp: "10",
        },
      ],
      slot,
    );

    expect(market?.ticker).toBe("KXBTC15M-CURRENT");
  });

  it("uses official yes/no ask fields from the market summary when available", () => {
    const quotes = deriveKalshiOutcomeQuotesFromMarket({
      ticker: "KXBTC15M-CURRENT",
      event_ticker: "KXBTC15M-CURRENT",
      title: "Current slot",
      open_time: "2026-03-30T20:00:00.000Z",
      close_time: "2026-03-30T20:15:00.000Z",
      status: "open",
      yes_bid_dollars: "0.1450",
      yes_ask_dollars: "0.1600",
      no_bid_dollars: "0.8400",
      no_ask_dollars: "0.8550",
      yes_bid_size_fp: "156.00",
      yes_ask_size_fp: "156.00",
      no_bid_size_fp: "29.00",
      no_ask_size_fp: "29.00",
    });

    expect(quotes.yes.buyPrice).toBe(0.16);
    expect(quotes.yes.sellPrice).toBe(0.145);
    expect(quotes.yes.depth).toBe(156);
    expect(quotes.no.buyPrice).toBe(0.855);
    expect(quotes.no.sellPrice).toBe(0.84);
    expect(quotes.no.depth).toBe(29);
  });

  it("maps Kalshi NO fills using the direct or complementary fill price", () => {
    expect(
      getKalshiFillPriceUsd({
        side: "no",
        no_price_dollars: "0.65",
      }),
    ).toBe(0.65);

    expect(
      getKalshiFillPriceUsd({
        side: "no",
        yes_price_dollars: "0.35",
      }),
    ).toBe(0.65);

    expect(
      getKalshiFillFeeUsd({
        taker_fees_dollars: "0.27",
      }),
    ).toBe(0.27);

    expect(
      getKalshiFillFeeUsd({
        taker_fees_dollars: "0.11",
        fees_paid_dollars: "0.20",
      }),
    ).toBe(0.2);

    expect(
      getKalshiFillFeeUsd({
        fee_cost: "0.31",
        fees_paid_dollars: "0.20",
      }),
    ).toBe(0.31);
  });

  it("paginates Kalshi markets so the current slot is not lost after the first page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          markets: [
            {
              ticker: "KXBTC15M-PAGE-1",
              event_ticker: "KXBTC15M-PAGE-1",
              title: "Older slot",
              open_time: "2026-03-30T19:45:00.000Z",
              close_time: "2026-03-30T20:00:00.000Z",
              status: "finalized",
              yes_bid_dollars: "0.40",
              yes_ask_dollars: "0.41",
              no_bid_dollars: "0.58",
              no_ask_dollars: "0.59",
              yes_bid_size_fp: "10",
              yes_ask_size_fp: "10",
              no_bid_size_fp: "10",
              no_ask_size_fp: "10",
            },
          ],
          cursor: "next-page",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          markets: [
            {
              ticker: "KXBTC15M-PAGE-2",
              event_ticker: "KXBTC15M-PAGE-2",
              title: "Current slot",
              open_time: "2026-03-30T20:00:00.000Z",
              close_time: "2026-03-30T20:15:00.000Z",
              status: "active",
              yes_bid_dollars: "0.40",
              yes_ask_dollars: "0.41",
              no_bid_dollars: "0.58",
              no_ask_dollars: "0.59",
              yes_bid_size_fp: "10",
              yes_ask_size_fp: "10",
              no_bid_size_fp: "10",
              no_ask_size_fp: "10",
            },
          ],
          cursor: null,
        }),
      });

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const response = await fetchKalshiMarkets("btc");

    expect(response.markets.map((market) => market.ticker)).toEqual(["KXBTC15M-PAGE-1", "KXBTC15M-PAGE-2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("cursor=next-page");
  });

  it("paginates all Kalshi portfolio positions", async () => {
    enableAuthenticatedKalshiRequests();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          market_positions: [createKalshiPositionFixture("KXBTC15M-PAGE-1")],
          cursor: "positions-next",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          market_positions: [createKalshiPositionFixture("KXETH15M-PAGE-2")],
          cursor: "",
        }),
      });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const positions = await createKalshiAdapter().getPositions(1_784_454_400_000);

    expect(positions.map((position) => position.marketRef)).toEqual(["KXBTC15M-PAGE-1", "KXETH15M-PAGE-2"]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/portfolio/positions?limit=1000");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("cursor=positions-next");
  });

  it("paginates all Kalshi orders while preserving the status filter", async () => {
    enableAuthenticatedKalshiRequests();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          orders: [createKalshiOrderFixture("order-page-1")],
          cursor: "orders-next",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          orders: [createKalshiOrderFixture("order-page-2")],
          cursor: null,
        }),
      });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const orders = await fetchKalshiOrders("executed");

    expect(orders.map((order) => order.order_id)).toEqual(["order-page-1", "order-page-2"]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("status=executed");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("limit=1000");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("status=executed");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("cursor=orders-next");
  });

  it("paginates all Kalshi fills", async () => {
    enableAuthenticatedKalshiRequests();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          fills: [createKalshiFillFixture("trade-page-1")],
          cursor: "fills-next",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          fills: [createKalshiFillFixture("trade-page-2")],
          cursor: undefined,
        }),
      });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const fills = await fetchKalshiFills();

    expect(fills.map((fill) => fill.trade_id)).toEqual(["trade-page-1", "trade-page-2"]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/portfolio/fills?limit=1000");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("cursor=fills-next");
  });

  it("fails instead of returning partial Kalshi data when a cursor repeats", async () => {
    enableAuthenticatedKalshiRequests();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        orders: [createKalshiOrderFixture("order-loop")],
        cursor: "repeated-cursor",
      }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(fetchKalshiOrders()).rejects.toThrow(
      "Kalshi pagination returned a repeated cursor for /portfolio/orders",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds Kalshi pagination when unique cursors never terminate", async () => {
    enableAuthenticatedKalshiRequests();
    let page = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      page += 1;
      return {
        ok: true,
        json: async () => ({
          fills: [createKalshiFillFixture(`trade-${page}`)],
          cursor: `cursor-${page}`,
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(fetchKalshiFills()).rejects.toThrow("Kalshi pagination exceeded 100 pages for /portfolio/fills");
    expect(fetchMock).toHaveBeenCalledTimes(100);
  });

  it("queries the current Kalshi slot with close timestamp filters before broad pagination", async () => {
    const slot: MarketSlot = {
      asset: "btc",
      key: "btc:1774900800000",
      startTs: 1774900800000,
      endTs: 1774901700000,
      startIso: "2026-03-30T20:00:00.000Z",
      endIso: "2026-03-30T20:15:00.000Z",
      label: "Mar 30, 4:00 PM - Mar 30, 4:15 PM",
      polymarketSlug: "btc-updown-15m-1774900800",
      secondsRemaining: 600,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        markets: [
          {
            ticker: "KXBTC15M-CURRENT",
            event_ticker: "KXBTC15M-CURRENT",
            title: "Current slot",
            open_time: "2026-03-30T20:00:00.000Z",
            close_time: "2026-03-30T20:15:00.000Z",
            status: "active",
            yes_bid_dollars: "0.40",
            yes_ask_dollars: "0.41",
            no_bid_dollars: "0.58",
            no_ask_dollars: "0.59",
            yes_bid_size_fp: "10",
            yes_ask_size_fp: "10",
            no_bid_size_fp: "10",
            no_ask_size_fp: "10",
          },
        ],
        cursor: "ignored-for-targeted-query",
      }),
    });

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const response = await fetchKalshiMarketsForSlot(slot);
    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);

    expect(response.markets.map((market) => market.ticker)).toEqual(["KXBTC15M-CURRENT"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestUrl).toContain("series_ticker=KXBTC15M");
    expect(requestUrl).toContain("min_close_ts=1774901640");
    expect(requestUrl).toContain("max_close_ts=1774902660");
    expect(requestUrl).toContain("limit=100");
    expect(requestUrl).not.toContain("cursor=");
  });

  it("queries the ETH series when fetching ETH Kalshi markets", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        markets: [],
        cursor: null,
      }),
    });

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await fetchKalshiMarkets("eth");

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("series_ticker=KXETH15M");
  });

  it("queries the SOL series when fetching SOL Kalshi markets", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        markets: [],
        cursor: null,
      }),
    });

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await fetchKalshiMarkets("sol");

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("series_ticker=KXSOL15M");
  });

  it("queries the XRP series when fetching XRP Kalshi markets", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        markets: [],
        cursor: null,
      }),
    });

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await fetchKalshiMarkets("xrp");

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("series_ticker=KXXRP15M");
  });

  it("queries DOGE, BNB and HYPE Kalshi series", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        markets: [],
        cursor: null,
      }),
    });

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await fetchKalshiMarkets("doge");
    await fetchKalshiMarkets("bnb");
    await fetchKalshiMarkets("hype");

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("series_ticker=KXDOGE15M");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("series_ticker=KXBNB15M");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("series_ticker=KXHYPE15M");
  });

  it("accepts determined and settled Kalshi markets as resolved", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          market: {
            ticker: "KXETH15M-DETERMINED",
            status: "determined",
            result: "yes",
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          market: {
            ticker: "KXETH15M-SETTLED",
            status: "settled",
            result: "no",
          },
        }),
      });

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(fetchKalshiResolution("KXETH15M-DETERMINED")).resolves.toBe("YES");
    await expect(fetchKalshiResolution("KXETH15M-SETTLED")).resolves.toBe("NO");
  });

  it("requires finalized Kalshi truth for mismatch calibration labels", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          market: {
            ticker: "KXETH15M-DETERMINED",
            status: "determined",
            result: "yes",
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          market: {
            ticker: "KXETH15M-FINALIZED",
            status: "finalized",
            result: "no",
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          market: {
            ticker: "KXETH15M-UNKNOWN",
            status: "finalized",
            result: "voided",
          },
        }),
      });

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(fetchFinalizedKalshiResolution("KXETH15M-DETERMINED")).resolves.toBeNull();
    await expect(fetchFinalizedKalshiResolution("KXETH15M-FINALIZED")).resolves.toBe("NO");
    await expect(fetchFinalizedKalshiResolution("KXETH15M-UNKNOWN")).resolves.toBeNull();
  });

  it("captures a coherent finalized Kalshi expiration benchmark", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          market: {
            ticker: "KXBTC15M-FINALIZED",
            status: "finalized",
            result: "yes",
            strike_type: "greater",
            floor_strike: "64665.91",
            expiration_value: "64669.86",
          },
        }),
      }) as unknown as typeof fetch,
    );

    await expect(fetchFinalizedKalshiResolutionObservation("KXBTC15M-FINALIZED")).resolves.toEqual({
      resolution: "YES",
      benchmarkValueUsd: 64669.86,
      benchmarkSource: "kalshi-expiration-value",
    });
  });

  it("uses the strict greater rule at equality and drops inconsistent values", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          market: {
            ticker: "KXBTC15M-EQUAL",
            status: "finalized",
            result: "no",
            strike_type: "greater",
            floor_strike: 100,
            expiration_value: 100,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          market: {
            ticker: "KXBTC15M-INCONSISTENT",
            status: "finalized",
            result: "no",
            strike_type: "greater",
            floor_strike: 100,
            expiration_value: 101,
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(fetchFinalizedKalshiResolutionObservation("KXBTC15M-EQUAL")).resolves.toMatchObject({
      resolution: "NO",
      benchmarkValueUsd: 100,
    });
    await expect(fetchFinalizedKalshiResolutionObservation("KXBTC15M-INCONSISTENT")).resolves.toEqual({
      resolution: "NO",
      benchmarkValueUsd: null,
      benchmarkSource: null,
    });
  });

  it("keeps the outcome when Kalshi expiration metadata is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          market: {
            ticker: "KXBTC15M-MALFORMED",
            status: "finalized",
            result: "yes",
            strike_type: "greater",
            floor_strike: 100,
            expiration_value: "not-a-number",
          },
        }),
      }) as unknown as typeof fetch,
    );

    await expect(fetchFinalizedKalshiResolutionObservation("KXBTC15M-MALFORMED")).resolves.toEqual({
      resolution: "YES",
      benchmarkValueUsd: null,
      benchmarkSource: null,
    });
  });

  it("signs Kalshi authenticated requests with the full trade-api path", () => {
    expect(buildKalshiSigningPath("https://external-api.kalshi.com/trade-api/v2", "/portfolio/balance")).toBe(
      "/trade-api/v2/portfolio/balance",
    );

    expect(buildKalshiSigningPath("https://demo-api.kalshi.co/trade-api/v2", "/portfolio/orders")).toBe(
      "/trade-api/v2/portfolio/orders",
    );
  });

  it("falls back to cash when Kalshi reports a portfolio_value below available balance", () => {
    expect(
      deriveKalshiBalanceSummary({
        balance: 5200,
        portfolio_value: 0,
        updated_ts: 0,
      }),
    ).toEqual({
      availableBalanceUsd: 52,
      portfolioValueUsd: 52,
      totalBalanceUsd: 52,
      notes: ["Kalshi portfolio_value inferieur au cash disponible; fallback sur le solde cash."],
    });
  });

  it("timestamps Kalshi balances at local observation time and preserves the source timestamp", () => {
    const capturedAt = 1_784_220_000_123;

    expect(
      mapKalshiBalance(
        {
          balance: 5200,
          portfolio_value: 6100,
          updated_ts: 1_784_219_999,
        },
        capturedAt,
      ),
    ).toEqual(
      expect.objectContaining({
        capturedAt,
        availableBalanceUsd: 52,
        totalBalanceUsd: 61,
        raw: expect.objectContaining({
          updated_ts: 1_784_219_999,
          sourceUpdatedAtMs: 1_784_219_999_000,
        }),
      }),
    );
  });

  it("maps Kalshi positions with mark-to-market pricing and unrealized pnl", () => {
    const position = mapKalshiPosition({
      ticker: "KXBTC15M-26APR070530-30",
      position_fp: "-20.51",
      total_traded_dollars: "9.6397",
      market_exposure_dollars: "11.2805",
      realized_pnl_dollars: "1.25",
      fees_paid_dollars: "0.3603",
      last_updated_ts: "2026-04-07T09:19:39.671191Z",
    });

    expect(position.outcome).toBe("NO");
    expect(position.size).toBeCloseTo(20.51, 4);
    expect(position.averagePrice).toBeCloseTo(0.47, 4);
    expect(position.currentPrice).toBeCloseTo(0.55, 4);
    expect(position.currentValueUsd).toBeCloseTo(11.2805, 4);
    expect(position.realizedPnlUsd).toBeCloseTo(1.25, 4);
    expect(position.unrealizedPnlUsd).toBeCloseTo(1.6408, 4);
  });

  it("ignores empty Kalshi placeholder positions", () => {
    const position = mapKalshiPosition({
      ticker: "KXBTC15M-26APR070530-30",
      position_fp: "0",
      total_traded_dollars: "0",
      market_exposure_dollars: "0",
      realized_pnl_dollars: "0",
      fees_paid_dollars: "0",
      last_updated_ts: "2026-04-07T09:19:39.671191Z",
    });

    expect(isTrackedKalshiPosition(position)).toBe(false);
  });

  it("treats canceled Kalshi orders with residual fills as partially filled", () => {
    expect(mapKalshiOrderStatus("canceled", 2, 3)).toBe("partially_filled");
    expect(mapKalshiOrderStatus("executed", 5, 0)).toBe("filled");
  });

  it("classifies Kalshi FOK kill responses as soft no-fill errors", () => {
    expect(
      getKalshiSoftNoFillMessage(
        new Error("Kalshi HTTP 400: order couldn't be fully filled. FOK orders are fully filled or killed."),
      ),
    ).toContain("FOK orders are fully filled or killed");

    expect(getKalshiSoftNoFillMessage(new Error("Kalshi HTTP 401: authentication_error"))).toBeNull();
    expect(
      getKalshiSoftNoFillMessage(new Error("Kalshi HTTP 500: internal error while handling a fill_or_kill order")),
    ).toBeNull();
    expect(
      getKalshiSoftNoFillMessage(new Error("Kalshi HTTP 422: time_in_force must be fill_or_kill for this request")),
    ).toBeNull();
  });

  it("maps Kalshi order prices on the correct YES/NO side", () => {
    expect(
      getKalshiOrderPriceUsd("NO", {
        yes_price_dollars: "0.60",
      }),
    ).toBeCloseTo(0.4, 4);

    expect(
      getKalshiOrderPriceUsd("YES", {
        no_price_dollars: "0.60",
      }),
    ).toBeCloseTo(0.4, 4);
  });

  it("rounds Kalshi order prices onto the order grid before submission", () => {
    expect(normalizeKalshiOrderPrice(0.45135, "BUY")).toBe(0.46);
    expect(normalizeKalshiOrderPrice(0.45135, "SELL")).toBe(0.45);
    expect(normalizeKalshiOrderPrice(0.45, "BUY")).toBe(0.45);
  });
});

describe("Kalshi V2 order mutations", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DATABASE_URL: "postgres://warbitrer:secret@127.0.0.1:5432/warbitrer_live",
      KALSHI_ENV: "prod",
    };
    enableAuthenticatedKalshiRequests();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it.each([
    ["BUY YES", { outcome: "YES" as const, side: "BUY" as const, price: 0.45 }, "bid", "0.4500"],
    ["SELL NO", { outcome: "NO" as const, side: "SELL" as const, price: 0.55 }, "bid", "0.4500"],
    ["BUY NO", { outcome: "NO" as const, side: "BUY" as const, price: 0.55 }, "ask", "0.4500"],
    ["SELL YES", { outcome: "YES" as const, side: "SELL" as const, price: 0.45 }, "ask", "0.4500"],
  ])("maps %s onto the canonical YES book", (_label, overrides, expectedSide, expectedPrice) => {
    const payload = buildKalshiV2OrderPayload(
      createVenueOrderRequest({
        ...overrides,
        maxCostUsd: overrides.side === "BUY" ? overrides.price * 10 : 0,
      }),
    );

    expect(payload).toEqual({
      ticker: "KXBTC15M-TEST",
      client_order_id: "client-v2-test",
      side: expectedSide,
      count: "10.00",
      price: expectedPrice,
      time_in_force: "fill_or_kill",
      self_trade_prevention_type: "taker_at_cross",
      post_only: false,
      cancel_order_on_pause: true,
      reduce_only: false,
      subaccount: 0,
      exchange_index: 0,
    });
  });

  it("rejects a request whose final limit exceeds the local max-cost guard", () => {
    expect(() => buildKalshiV2OrderPayload(createVenueOrderRequest({ maxCostUsd: 4.49 }))).toThrow(
      "supérieur au plafond",
    );
  });

  it("maps the flat V2 response, NO complement price, and per-contract fee", () => {
    const order = createVenueOrderRequest({ outcome: "NO", price: 0.55, maxCostUsd: 5.5, orderType: "IOC" });

    expect(
      mapKalshiV2OrderResult(
        {
          order_id: "order-v2",
          client_order_id: order.clientOrderId,
          fill_count: "4.00",
          remaining_count: "6.00",
          average_fill_price: "0.4500",
          average_fee_paid: "0.0025",
          ts_ms: 1_785_000_000_000,
        },
        order,
      ),
    ).toMatchObject({
      venueOrderId: "order-v2",
      status: "partially_filled",
      filledSize: 4,
      averageFillPrice: 0.55,
      feeUsd: 0.01,
    });
  });

  it("rejects an impossible partial FOK response", () => {
    const order = createVenueOrderRequest();
    expect(() =>
      mapKalshiV2OrderResult(
        {
          order_id: "order-v2",
          fill_count: "4.00",
          remaining_count: "6.00",
          ts_ms: 1_785_000_000_000,
        },
        order,
      ),
    ).toThrow("FOK partielle impossible");
  });

  it("uses V2 create and cancel endpoints while retaining the GET endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          order_id: "order/v2",
          client_order_id: "client-v2-test",
          fill_count: "10.00",
          remaining_count: "0.00",
          average_fill_price: "0.4500",
          average_fee_paid: "0.0010",
          ts_ms: 1_785_000_000_000,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ order_id: "order/v2", reduced_by: "0.00", ts_ms: 1_785_000_000_001 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ order: createKalshiOrderFixture("order-v2") }),
      });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const adapter = createKalshiAdapter();
    const result = await adapter.placeOrder(createVenueOrderRequest());
    await adapter.cancelOrder("order/v2");
    await adapter.getOrder("order-v2");

    expect(result).toMatchObject({ status: "filled", feeUsd: 0.01 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/portfolio/events/orders");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty("action");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/portfolio/events/orders/order%2Fv2");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/portfolio/orders/order-v2");
  });
});
