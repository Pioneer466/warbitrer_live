import * as polymarketLib from "@/lib/polymarket";
import { deriveKalshiOutcomeQuotes, extractKalshiLastTradePrices } from "@/lib/kalshi";
import {
  applyLevelDelta,
  chooseFeedSource,
  computeFeedStatus,
  MarketDataSupervisor,
  shouldRestResync,
} from "@/lib/market-data";
import type { MarketAsset, MarketSlot } from "@/lib/types";
import { afterEach, vi } from "vitest";

function buildSlot(asset: MarketAsset = "btc"): MarketSlot {
  return {
    asset,
    key: `${asset}:1770000000000`,
    startTs: 1770000000000,
    endTs: 1770000900000,
    startIso: "2026-02-02T10:00:00.000Z",
    endIso: "2026-02-02T10:15:00.000Z",
    label: "Feb 2, 5:00 AM - Feb 2, 5:15 AM",
    polymarketSlug: `${asset}-updown-15m-1770000000`,
    secondsRemaining: 120,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("market data helpers", () => {
  it("marks feeds ready, degraded, then blocked as staleness grows", () => {
    expect(computeFeedStatus(1_000, true, 2_000)).toEqual({
      status: "ready",
      stalenessMs: 1_000,
    });
    expect(computeFeedStatus(1_000, true, 6_000)).toEqual({
      status: "degraded",
      stalenessMs: 5_000,
    });
    expect(computeFeedStatus(1_000, true, 12_500)).toEqual({
      status: "blocked",
      stalenessMs: 11_500,
    });
  });

  it("distinguishes websocket freshness from REST fallback freshness", () => {
    expect(chooseFeedSource(5_000, 4_000, 6_000)).toBe("ws");
    expect(chooseFeedSource(1_000, 11_000, 12_000)).toBe("rest-fallback");
    expect(chooseFeedSource(null, 11_000, 12_000)).toBe("rest-bootstrap");
  });

  it("only revalidates REST aggressively when websocket freshness is missing", () => {
    expect(shouldRestResync(11_000, 68_000, 70_000, 4_000, 60_000)).toBe(false);
    expect(shouldRestResync(10_000, 68_000, 70_000, 4_000, 60_000)).toBe(true);
    expect(shouldRestResync(10_000, 5_000, 15_000, 4_000, 60_000)).toBe(true);
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
    const slot = buildSlot();

    const supervisor = new MarketDataSupervisor() as any;
    const polymarketState = { venue: "polymarket", quote: { ref: { id: "poly" } } };
    const kalshiState = { venue: "kalshi", quote: { ref: { id: "kalshi" } } };
    const polyEnsureSlot = vi.fn().mockResolvedValue(undefined);
    const kalshiEnsureSlot = vi.fn().mockRejectedValue(new Error("kalshi bootstrap failed"));

    supervisor.feeds.btc.polymarket = {
      ensureSlot: polyEnsureSlot,
      buildState: vi.fn().mockReturnValue(polymarketState),
    };
    supervisor.feeds.btc.kalshi = {
      ensureSlot: kalshiEnsureSlot,
      buildState: vi.fn().mockReturnValue(kalshiState),
    };

    await expect(supervisor.readSlotState(slot, 1770000005000)).resolves.toEqual({
      polymarket: polymarketState,
      kalshi: kalshiState,
    });
    expect(polyEnsureSlot).toHaveBeenCalledWith(slot, 1770000005000);
    expect(kalshiEnsureSlot).toHaveBeenCalledWith(slot, 1770000005000);
    expect(supervisor.feeds.btc.polymarket.buildState).toHaveBeenCalledWith(slot, 1770000005000);
    expect(supervisor.feeds.btc.kalshi.buildState).toHaveBeenCalledWith(slot, 1770000005000);
  });

  it("keeps separate feed instances per asset across all four markets", async () => {
    const supervisor = new MarketDataSupervisor() as any;
    const btcSlot = buildSlot("btc");
    const ethSlot = buildSlot("eth");
    const solSlot = buildSlot("sol");
    const xrpSlot = buildSlot("xrp");

    supervisor.feeds.btc.polymarket = {
      ensureSlot: vi.fn().mockResolvedValue(undefined),
      buildState: vi.fn().mockReturnValue({ venue: "polymarket", quote: { ref: { id: "btc-poly" } } }),
    };
    supervisor.feeds.btc.kalshi = {
      ensureSlot: vi.fn().mockResolvedValue(undefined),
      buildState: vi.fn().mockReturnValue({ venue: "kalshi", quote: { ref: { id: "btc-kalshi" } } }),
    };
    supervisor.feeds.eth.polymarket = {
      ensureSlot: vi.fn().mockResolvedValue(undefined),
      buildState: vi.fn().mockReturnValue({ venue: "polymarket", quote: { ref: { id: "eth-poly" } } }),
    };
    supervisor.feeds.eth.kalshi = {
      ensureSlot: vi.fn().mockResolvedValue(undefined),
      buildState: vi.fn().mockReturnValue({ venue: "kalshi", quote: { ref: { id: "eth-kalshi" } } }),
    };
    supervisor.feeds.sol.polymarket = {
      ensureSlot: vi.fn().mockResolvedValue(undefined),
      buildState: vi.fn().mockReturnValue({ venue: "polymarket", quote: { ref: { id: "sol-poly" } } }),
    };
    supervisor.feeds.sol.kalshi = {
      ensureSlot: vi.fn().mockResolvedValue(undefined),
      buildState: vi.fn().mockReturnValue({ venue: "kalshi", quote: { ref: { id: "sol-kalshi" } } }),
    };
    supervisor.feeds.xrp.polymarket = {
      ensureSlot: vi.fn().mockResolvedValue(undefined),
      buildState: vi.fn().mockReturnValue({ venue: "polymarket", quote: { ref: { id: "xrp-poly" } } }),
    };
    supervisor.feeds.xrp.kalshi = {
      ensureSlot: vi.fn().mockResolvedValue(undefined),
      buildState: vi.fn().mockReturnValue({ venue: "kalshi", quote: { ref: { id: "xrp-kalshi" } } }),
    };

    await supervisor.readSlotState(btcSlot, 1770000005000);
    await supervisor.readSlotState(ethSlot, 1770000005001);
    await supervisor.readSlotState(solSlot, 1770000005002);
    await supervisor.readSlotState(xrpSlot, 1770000005003);

    expect(supervisor.feeds.btc.polymarket.ensureSlot).toHaveBeenCalledWith(btcSlot, 1770000005000);
    expect(supervisor.feeds.eth.polymarket.ensureSlot).toHaveBeenCalledWith(ethSlot, 1770000005001);
    expect(supervisor.feeds.sol.polymarket.ensureSlot).toHaveBeenCalledWith(solSlot, 1770000005002);
    expect(supervisor.feeds.xrp.polymarket.ensureSlot).toHaveBeenCalledWith(xrpSlot, 1770000005003);
    expect(supervisor.feeds.btc.polymarket).not.toBe(supervisor.feeds.eth.polymarket);
    expect(supervisor.feeds.sol.polymarket).not.toBe(supervisor.feeds.xrp.polymarket);
  });

  it("uses nested Polymarket price_change payloads to keep the top of book aligned", () => {
    const slot = buildSlot();

    const supervisor = new MarketDataSupervisor() as any;
    const feed = supervisor.feeds.btc.polymarket as any;

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

  it("keeps the existing Polymarket state when background resync fails", async () => {
    const slot = buildSlot();

    vi.spyOn(polymarketLib, "fetchPolymarketBook").mockRejectedValue(new Error("HTTP 502 on Polymarket book"));

    const supervisor = new MarketDataSupervisor() as any;
    const feed = supervisor.feeds.btc.polymarket as any;

    feed.slotKey = slot.key;
    feed.market = {
      id: "market-1",
      question: "BTC up/down 15m",
      slug: slot.polymarketSlug,
      startDate: slot.startIso,
      endDate: slot.endIso,
      conditionId: "condition-1",
      closed: false,
      outcomePrices: '["0.5","0.5"]',
      outcomes: '["Up","Down"]',
      clobTokenIds: '["asset-up","asset-down"]',
    };
    feed.tokenIds = {
      up: "asset-up",
      down: "asset-down",
    };
    feed.books.set("asset-up", {
      tokenId: "asset-up",
      bids: new Map([["0.49", 100]]),
      asks: new Map([["0.51", 80]]),
      tickSize: 0.001,
      minOrderSize: 1,
      bestBidPrice: 0.49,
      bestBidSize: 100,
      bestAskPrice: 0.51,
      bestAskSize: 80,
      lastTradePrice: null,
      lastUpdatedAt: 1770000004000,
    });
    feed.books.set("asset-down", {
      tokenId: "asset-down",
      bids: new Map([["0.48", 100]]),
      asks: new Map([["0.52", 80]]),
      tickSize: 0.001,
      minOrderSize: 1,
      bestBidPrice: 0.48,
      bestBidSize: 100,
      bestAskPrice: 0.52,
      bestAskSize: 80,
      lastTradePrice: null,
      lastUpdatedAt: 1770000004000,
    });
    feed.lastRestSyncAt = 0;
    feed.ensureWs = vi.fn();

    await expect(feed.ensureSlot(slot, 5_000)).resolves.toBeUndefined();
    const pendingResync = feed.resyncPromise;
    await pendingResync;

    expect(feed.market.slug).toBe(slot.polymarketSlug);
    expect(feed.books.get("asset-up")?.bestAskPrice).toBe(0.51);
    expect(feed.lastError).toContain("HTTP 502 on Polymarket book");
  });
});
