import { deriveKalshiOutcomeQuotes, extractKalshiLastTradePrices } from "@/lib/kalshi";
import { applyLevelDelta, computeFeedStatus, MarketDataSupervisor } from "@/lib/market-data";
import type { MarketSlot } from "@/lib/types";
import { vi } from "vitest";

describe("market data helpers", () => {
  it("marks feeds ready, degraded, then blocked as staleness grows", () => {
    expect(computeFeedStatus(1_000, true, 2_000)).toEqual({
      status: "ready",
      stalenessMs: 1_000,
    });
    expect(computeFeedStatus(1_000, true, 4_500)).toEqual({
      status: "degraded",
      stalenessMs: 3_500,
    });
    expect(computeFeedStatus(1_000, true, 8_000)).toEqual({
      status: "blocked",
      stalenessMs: 7_000,
    });
  });

  it("applies top-of-book level deltas and removes empty levels", () => {
    const levels = new Map<string, number>([
      ["0.34", 10],
      ["0.35", 20],
    ]);

    applyLevelDelta(levels, "0.35", 18);
    applyLevelDelta(levels, "0.36", 12);
    applyLevelDelta(levels, "0.34", 0);

    const quotes = deriveKalshiOutcomeQuotes({
      yes_dollars: [...levels.entries()].map(([price, size]) => [price, String(size)] as [string, string]),
      no_dollars: [
        ["0.61", "15"],
        ["0.62", "8"],
      ],
    });

    expect(quotes.yes.sellPrice).toBe(0.36);
    expect(quotes.no.buyPrice).toBe(0.64);
  });

  it("extracts the freshest Kalshi trade price for audit purposes", () => {
    const tradePrices = extractKalshiLastTradePrices([
      {
        yes_price_dollars: "0.33",
        created_time: "2026-04-01T10:00:00.000Z",
      },
      {
        yes_price_dollars: "0.35",
        created_time: "2026-04-01T10:00:01.000Z",
      },
    ]);

    expect(tradePrices.yes).toBe(0.35);
    expect(tradePrices.no).toBe(0.65);
  });

  it("keeps producing slot state when one venue bootstrap fails", async () => {
    const slot: MarketSlot = {
      key: "1770000000000",
      startTs: 1770000000000,
      endTs: 1770000900000,
      startIso: "2026-02-02T10:00:00.000Z",
      endIso: "2026-02-02T10:15:00.000Z",
      label: "Feb 2, 5:00 AM - Feb 2, 5:15 AM",
      polymarketSlug: "btc-updown-15m-1770000000",
      secondsRemaining: 120,
    };

    const supervisor = new MarketDataSupervisor() as any;
    const polymarketState = { venue: "polymarket", quote: { ref: { id: "poly" } } };
    const kalshiState = { venue: "kalshi", quote: { ref: { id: "kalshi" } } };
    const polyEnsureSlot = vi.fn().mockResolvedValue(undefined);
    const kalshiEnsureSlot = vi.fn().mockRejectedValue(new Error("kalshi bootstrap failed"));

    supervisor.polymarket = {
      ensureSlot: polyEnsureSlot,
      buildState: vi.fn().mockReturnValue(polymarketState),
    };
    supervisor.kalshi = {
      ensureSlot: kalshiEnsureSlot,
      buildState: vi.fn().mockReturnValue(kalshiState),
    };

    await expect(supervisor.readSlotState(slot, 1770000005000)).resolves.toEqual({
      polymarket: polymarketState,
      kalshi: kalshiState,
    });
    expect(polyEnsureSlot).toHaveBeenCalledWith(slot, 1770000005000);
    expect(kalshiEnsureSlot).toHaveBeenCalledWith(slot, 1770000005000);
    expect(supervisor.polymarket.buildState).toHaveBeenCalledWith(slot, 1770000005000);
    expect(supervisor.kalshi.buildState).toHaveBeenCalledWith(slot, 1770000005000);
  });

  it("uses nested Polymarket price_change payloads to keep the top of book aligned", () => {
    const slot: MarketSlot = {
      key: "1770000000000",
      startTs: 1770000000000,
      endTs: 1770000900000,
      startIso: "2026-02-02T10:00:00.000Z",
      endIso: "2026-02-02T10:15:00.000Z",
      label: "Feb 2, 5:00 AM - Feb 2, 5:15 AM",
      polymarketSlug: "btc-updown-15m-1770000000",
      secondsRemaining: 120,
    };

    const supervisor = new MarketDataSupervisor() as any;
    const feed = supervisor.polymarket as any;

    feed.market = {
      id: "market-1",
      question: "BTC up/down 15m",
      slug: slot.polymarketSlug,
      startDate: slot.startIso,
      endDate: slot.endIso,
      conditionId: "condition-1",
      closed: false,
      outcomePrices: '["0.5","0.5"]',
    };
    feed.tokenIds = {
      up: "asset-up",
      down: "asset-down",
    };
    feed.books.set("asset-up", {
      tokenId: "asset-up",
      bids: new Map([["0.49", 100]]),
      asks: new Map([["0.90", 50], ["0.53", 80]]),
      tickSize: 0.001,
      minOrderSize: 1,
      bestBidPrice: 0.49,
      bestBidSize: 100,
      bestAskPrice: 0.9,
      bestAskSize: 50,
      lastTradePrice: null,
      lastUpdatedAt: 1770000004000,
    });
    feed.books.set("asset-down", {
      tokenId: "asset-down",
      bids: new Map([["0.46", 100]]),
      asks: new Map([["0.47", 120]]),
      tickSize: 0.001,
      minOrderSize: 1,
      bestBidPrice: 0.46,
      bestBidSize: 100,
      bestAskPrice: 0.47,
      bestAskSize: 120,
      lastTradePrice: null,
      lastUpdatedAt: 1770000004000,
    });

    feed.applyMarketEvent(
      {
        event_type: "price_change",
        price_changes: [
          {
            asset_id: "asset-up",
            side: "SELL",
            price: "0.53",
            size: "80",
            best_bid: "0.52",
            best_ask: "0.53",
            timestamp: "2026-02-02T10:00:05.000Z",
          },
        ],
      },
      1770000005000,
    );

    const state = feed.buildState(slot, 1770000005000);

    expect(state.quote.outcomes.up.buyPrice).toBe(0.53);
    expect(state.quote.outcomes.up.sellPrice).toBe(0.52);
    expect(state.quote.outcomes.up.chart.price).toBe(0.53);
  });
});
