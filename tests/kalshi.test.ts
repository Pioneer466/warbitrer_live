import { deriveKalshiOutcomeQuotes, deriveKalshiOutcomeQuotesFromMarket, resolveKalshiMarketForSlot } from "@/lib/kalshi";
import type { MarketSlot } from "@/lib/types";

describe("Kalshi quote derivation", () => {
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
      key: "1774900800000",
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
});
