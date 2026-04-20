import {
  deriveKalshiBalanceSummary,
  buildKalshiSigningPath,
  deriveKalshiOutcomeQuotes,
  deriveKalshiOutcomeQuotesFromMarket,
  fetchKalshiMarkets,
  getKalshiFillFeeUsd,
  getKalshiFillPriceUsd,
  mapKalshiFillToLiveFill,
  getKalshiOrderPriceUsd,
  getKalshiSoftNoFillMessage,
  isTrackedKalshiPosition,
  mapKalshiPosition,
  mapKalshiOrderStatus,
  normalizeKalshiOrderPrice,
  resolveKalshiMarketForSlot,
} from "@/lib/kalshi";
import type { MarketSlot } from "@/lib/types";
import { vi } from "vitest";

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
  });

  it("paginates Kalshi markets so the current slot is not lost after the first page", async () => {
    const fetchMock = vi.fn()
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

    vi.stubGlobal("fetch", fetchMock as any);

    const response = await fetchKalshiMarkets("btc");

    expect(response.markets.map((market) => market.ticker)).toEqual([
      "KXBTC15M-PAGE-1",
      "KXBTC15M-PAGE-2",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("cursor=next-page");
  });

  it("queries the ETH series when fetching ETH Kalshi markets", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        markets: [],
        cursor: null,
      }),
    });

    vi.stubGlobal("fetch", fetchMock as any);

    await fetchKalshiMarkets("eth");

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("series_ticker=KXETH15M");
  });

  it("signs Kalshi authenticated requests with the full trade-api path", () => {
    expect(
      buildKalshiSigningPath(
        "https://api.elections.kalshi.com/trade-api/v2",
        "/portfolio/balance",
      ),
    ).toBe("/trade-api/v2/portfolio/balance");

    expect(
      buildKalshiSigningPath(
        "https://demo-api.kalshi.co/trade-api/v2",
        "/portfolio/orders",
      ),
    ).toBe("/trade-api/v2/portfolio/orders");
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
