import * as polymarketLib from "@/lib/polymarket";
import { MARKET_ASSETS, MARKET_CATALOG } from "@/lib/market-catalog";
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

function primeKalshiFeed(feed: any, slot: MarketSlot, now: number) {
  feed.slotKey = slot.key;
  feed.series = {
    ticker: MARKET_CATALOG[slot.asset].kalshiSeriesTicker,
    fee_multiplier: 1,
    fee_type: "quadratic",
    title: `${slot.asset.toUpperCase()} 15m`,
  };
  feed.market = {
    ticker: `${MARKET_CATALOG[slot.asset].kalshiSeriesTicker}-CURRENT`,
    event_ticker: `${MARKET_CATALOG[slot.asset].kalshiSeriesTicker}-CURRENT`,
    title: "Current slot",
    floor_strike: "101234.56",
    open_time: slot.startIso,
    close_time: slot.endIso,
    status: "active",
    yes_bid_dollars: "0.40",
    yes_ask_dollars: "0.41",
    no_bid_dollars: "0.58",
    no_ask_dollars: "0.59",
    last_price_dollars: "0.40",
    yes_bid_size_fp: "10",
    yes_ask_size_fp: "10",
    no_bid_size_fp: "10",
    no_ask_size_fp: "10",
  };
  feed.orderbook = {
    yes: new Map([["0.40", 10]]),
    no: new Map([["0.58", 10]]),
    seq: 1,
    lastUpdatedAt: now,
  };
  feed.orderbookInSync = true;
  feed.lastRestSyncAt = now;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  MARKET_CATALOG.btc.polymarketChainlinkSymbol = "btc/usd";
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

  it("backs off Kalshi REST bootstrap retries after a rate limit", async () => {
    const slot = buildSlot();
    vi.stubEnv("DATABASE_URL", "postgres://warbitrer:secret@127.0.0.1:5432/warbitrer_live");
    vi.stubEnv("KALSHI_ENV", "prod");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => '{"error":{"code":"too_many_requests","message":"too many requests"}}',
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const supervisor = new MarketDataSupervisor() as any;
    const feed = supervisor.feeds.btc.kalshi as any;
    feed.ensureWs = vi.fn();

    await expect(feed.ensureSlot(slot, 1_000)).rejects.toThrow(/HTTP 429/);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(feed.ensureSlot(slot, 1_250)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(feed.lastError).toContain("retry in 9750ms");

    await expect(feed.ensureSlot(slot, 11_001)).rejects.toThrow(/HTTP 429/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("marks Kalshi source as websocket after ticker or orderbook data payloads", () => {
    const slot = buildSlot();
    const supervisor = new MarketDataSupervisor() as any;
    const tickerFeed = supervisor.feeds.btc.kalshi as any;
    primeKalshiFeed(tickerFeed, slot, slot.startTs + 1_000);

    tickerFeed.applyWsPayload(
      {
        type: "ticker",
        msg: {
          yes_bid_dollars: "0.42",
          yes_ask_dollars: "0.43",
          yes_bid_size_fp: "11",
          yes_ask_size_fp: "12",
        },
      },
      slot.startTs + 2_000,
    );

    expect(tickerFeed.buildState(slot, slot.startTs + 2_500).quote.feedHealth.source).toBe("ws");

    const snapshotFeed = new MarketDataSupervisor() as any;
    const orderbookFeed = snapshotFeed.feeds.btc.kalshi as any;
    primeKalshiFeed(orderbookFeed, slot, slot.startTs + 1_000);
    orderbookFeed.applyWsPayload(
      {
        type: "orderbook_snapshot",
        msg: {
          yes_dollars: [["0.44", "15"]],
          no_dollars: [["0.55", "16"]],
          seq: 12,
        },
      },
      slot.startTs + 2_000,
    );

    expect(orderbookFeed.buildState(slot, slot.startTs + 2_500).quote.feedHealth.source).toBe("ws");
  });

  it("falls Kalshi source back to REST and then blocks after websocket and REST go stale", () => {
    const slot = buildSlot();
    const supervisor = new MarketDataSupervisor() as any;
    const feed = supervisor.feeds.btc.kalshi as any;
    primeKalshiFeed(feed, slot, slot.startTs + 11_000);
    feed.lastWsMessageAt = slot.startTs + 1_000;
    feed.subscriptions[0].lastMessageAt = slot.startTs + 1_000;
    feed.subscriptions[0].status = "subscribed";
    feed.subscriptions[0].source = "ws";

    const fallbackState = feed.buildState(slot, slot.startTs + 12_000);
    expect(fallbackState.quote.feedHealth.source).toBe("rest-fallback");
    expect(fallbackState.quote.feedHealth.feedStatus).toBe("ready");

    const blockedState = feed.buildState(slot, slot.startTs + 22_500);
    expect(blockedState.quote.feedHealth.source).toBe("unavailable");
    expect(blockedState.quote.feedHealth.feedStatus).toBe("blocked");
  });

  it("keeps separate feed instances per asset across all markets", async () => {
    const supervisor = new MarketDataSupervisor() as any;
    const slots = MARKET_ASSETS.map((asset) => buildSlot(asset));

    for (const asset of MARKET_ASSETS) {
      supervisor.feeds[asset].polymarket = {
        ensureSlot: vi.fn().mockResolvedValue(undefined),
        buildState: vi.fn().mockReturnValue({ venue: "polymarket", quote: { ref: { id: `${asset}-poly` } } }),
      };
      supervisor.feeds[asset].kalshi = {
        ensureSlot: vi.fn().mockResolvedValue(undefined),
        buildState: vi.fn().mockReturnValue({ venue: "kalshi", quote: { ref: { id: `${asset}-kalshi` } } }),
      };
    }

    for (const [index, slot] of slots.entries()) {
      await supervisor.readSlotState(slot, 1770000005000 + index);
    }

    for (const [index, slot] of slots.entries()) {
      expect(supervisor.feeds[slot.asset].polymarket.ensureSlot).toHaveBeenCalledWith(
        slot,
        1770000005000 + index,
      );
    }
    expect(supervisor.feeds.btc.polymarket).not.toBe(supervisor.feeds.eth.polymarket);
    expect(supervisor.feeds.sol.polymarket).not.toBe(supervisor.feeds.xrp.polymarket);
    expect(supervisor.feeds.doge.polymarket).not.toBe(supervisor.feeds.bnb.polymarket);
    expect(supervisor.feeds.bnb.polymarket).not.toBe(supervisor.feeds.hype.polymarket);
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

  it("exposes Chainlink RTDS prices in the Polymarket quote and captures the slot open snapshot", () => {
    const slot = buildSlot();

    const supervisor = new MarketDataSupervisor() as any;
    const feed = supervisor.feeds.btc.polymarket as any;

    feed.slotKey = slot.key;
    feed.slotStartTs = slot.startTs;
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
      lastUpdatedAt: slot.startTs + 5_000,
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
      lastUpdatedAt: slot.startTs + 5_000,
    });

    feed.applyPriceEvent(
      {
        payload: {
          symbol: "btc/usd",
          value: "100123.45",
          timestamp: "2026-02-02T02:40:10.000Z",
        },
      },
      slot.startTs + 10_000,
    );

    const state = feed.buildState(slot, slot.startTs + 10_000);

    expect(state.quote.chainlinkLivePriceUsd).toBe(100123.45);
    expect(state.quote.chainlinkLivePriceCapturedAt).toBe(Date.parse("2026-02-02T02:40:10.000Z"));
    expect(state.quote.observedSlotOpenPriceUsd).toBe(100123.45);
    expect(state.quote.observedSlotOpenCapturedAt).toBe(Date.parse("2026-02-02T02:40:10.000Z"));
  });

  it("only captures the observed slot open price inside the configured open window", () => {
    const slot = buildSlot();

    const supervisor = new MarketDataSupervisor() as any;
    const feed = supervisor.feeds.btc.polymarket as any;

    feed.slotKey = slot.key;
    feed.slotStartTs = slot.startTs;
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
      lastUpdatedAt: slot.startTs + 31_000,
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
      lastUpdatedAt: slot.startTs + 31_000,
    });

    feed.applyPriceEvent(
      {
        payload: {
          symbol: "btc/usd",
          value: "100200",
          timestamp: "2026-02-02T02:40:31.000Z",
        },
      },
      slot.startTs + 31_000,
    );

    const state = feed.buildState(slot, slot.startTs + 31_000);

    expect(state.quote.chainlinkLivePriceUsd).toBe(100200);
    expect(state.quote.observedSlotOpenPriceUsd).toBeNull();
    expect(state.quote.observedSlotOpenCapturedAt).toBeNull();
  });

  it("keeps the captured slot open price closest to the slot boundary", () => {
    const slot = buildSlot();

    const supervisor = new MarketDataSupervisor() as any;
    const feed = supervisor.feeds.btc.polymarket as any;

    feed.slotKey = slot.key;
    feed.slotStartTs = slot.startTs;
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
      lastUpdatedAt: slot.startTs + 12_000,
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
      lastUpdatedAt: slot.startTs + 12_000,
    });

    feed.applyPriceEvent(
      {
        payload: {
          symbol: "btc/usd",
          value: "100150",
          timestamp: "2026-02-02T02:40:12.000Z",
        },
      },
      slot.startTs + 12_000,
    );
    feed.applyPriceEvent(
      {
        payload: {
          symbol: "btc/usd",
          value: "100090",
          timestamp: "2026-02-02T02:40:04.000Z",
        },
      },
      slot.startTs + 12_500,
    );

    const state = feed.buildState(slot, slot.startTs + 12_500);

    expect(state.quote.observedSlotOpenPriceUsd).toBe(100090);
    expect(state.quote.observedSlotOpenCapturedAt).toBe(Date.parse("2026-02-02T02:40:04.000Z"));
  });

  it("matches Chainlink symbols case-insensitively against the market catalog", () => {
    const slot = buildSlot();

    MARKET_CATALOG.btc.polymarketChainlinkSymbol = "BTC/USD";

    const supervisor = new MarketDataSupervisor() as any;
    const feed = supervisor.feeds.btc.polymarket as any;

    feed.slotKey = slot.key;
    feed.slotStartTs = slot.startTs;
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
      lastUpdatedAt: slot.startTs + 10_000,
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
      lastUpdatedAt: slot.startTs + 10_000,
    });

    feed.applyPriceEvent(
      {
        payload: {
          symbol: "btc/usd",
          value: "100123.45",
          timestamp: "2026-02-02T02:40:10.000Z",
        },
      },
      slot.startTs + 10_000,
    );

    const state = feed.buildState(slot, slot.startTs + 10_000);

    expect(state.quote.chainlinkLivePriceUsd).toBe(100123.45);
  });

  it("parses the Kalshi floor strike into targetPriceUsd in slot state", () => {
    const slot = buildSlot();

    const supervisor = new MarketDataSupervisor() as any;
    const feed = supervisor.feeds.btc.kalshi as any;

    feed.slotKey = slot.key;
    feed.series = {
      ticker: "KXBTC15M",
      fee_multiplier: 1,
      fee_type: "quadratic",
      title: "BTC 15m",
    };
    feed.market = {
      ticker: "KXBTC15M-CURRENT",
      event_ticker: "KXBTC15M-CURRENT",
      title: "Current slot",
      floor_strike: "101234.56",
      open_time: slot.startIso,
      close_time: slot.endIso,
      status: "active",
      yes_bid_dollars: "0.40",
      yes_ask_dollars: "0.41",
      no_bid_dollars: "0.58",
      no_ask_dollars: "0.59",
      yes_bid_size_fp: "10",
      yes_ask_size_fp: "10",
      no_bid_size_fp: "10",
      no_ask_size_fp: "10",
    };
    feed.orderbook = {
      yes: new Map([["0.40", 10]]),
      no: new Map([["0.58", 10]]),
      seq: 1,
      lastUpdatedAt: slot.startTs + 5_000,
    };
    feed.trades = [];
    feed.lastRestSyncAt = slot.startTs + 5_000;

    const state = feed.buildState(slot, slot.startTs + 5_000);

    expect(state.quote.targetPriceUsd).toBe(101234.56);
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

  it("blocks Kalshi feed readiness during an orderbook seq-gap resync", () => {
    const slot = buildSlot();

    const supervisor = new MarketDataSupervisor() as any;
    const feed = supervisor.feeds.btc.kalshi as any;

    feed.slotKey = slot.key;
    feed.series = {
      ticker: "KXBTC15M",
      fee_multiplier: 1,
      fee_type: "quadratic",
      title: "BTC 15m",
    };
    feed.market = {
      ticker: "KXBTC15M-CURRENT",
      event_ticker: "KXBTC15M-CURRENT",
      title: "Current slot",
      floor_strike: "101234.56",
      open_time: slot.startIso,
      close_time: slot.endIso,
      status: "active",
      yes_bid_dollars: "0.40",
      yes_ask_dollars: "0.41",
      no_bid_dollars: "0.58",
      no_ask_dollars: "0.59",
      yes_bid_size_fp: "10",
      yes_ask_size_fp: "10",
      no_bid_size_fp: "10",
      no_ask_size_fp: "10",
    };
    feed.orderbook = {
      yes: new Map([["0.40", 10]]),
      no: new Map([["0.58", 10]]),
      seq: 1,
      lastUpdatedAt: slot.startTs + 5_000,
    };
    feed.lastRestSyncAt = slot.startTs + 5_000;
    feed.resync = vi.fn(() => new Promise(() => {}));

    feed.applyKalshiDelta(
      {
        seq: 3,
        side: "yes",
        price_dollars: "0.40",
        delta_fp: "1",
      },
      slot.startTs + 6_000,
    );

    const state = feed.buildState(slot, slot.startTs + 6_000);

    expect(state.quote.feedHealth.feedStatus).toBe("blocked");
    expect(state.quote.feedHealth.details[0]).toContain("Gap sequence Kalshi");
  });

  it("keeps Kalshi ticker YES and NO prices coherent when the websocket payload mixes stale fields", () => {
    const slot = buildSlot();

    const supervisor = new MarketDataSupervisor() as any;
    const feed = supervisor.feeds.btc.kalshi as any;

    feed.slotKey = slot.key;
    feed.series = {
      ticker: "KXBTC15M",
      fee_multiplier: 1,
      fee_type: "quadratic",
      title: "BTC 15m",
    };
    feed.market = {
      ticker: "KXBTC15M-CURRENT",
      event_ticker: "KXBTC15M-CURRENT",
      title: "Current slot",
      floor_strike: "101234.56",
      open_time: slot.startIso,
      close_time: slot.endIso,
      status: "active",
      yes_bid_dollars: "0.50",
      yes_ask_dollars: "0.51",
      no_bid_dollars: "0.48",
      no_ask_dollars: "0.49",
      yes_bid_size_fp: "10",
      yes_ask_size_fp: "10",
      no_bid_size_fp: "10",
      no_ask_size_fp: "10",
    };
    feed.orderbook = null;
    feed.lastRestSyncAt = slot.startTs + 5_000;

    feed.applyWsPayload(
      {
        type: "ticker",
        msg: {
          yes_bid_dollars: "0.52",
          yes_ask_dollars: "0.53",
          no_ask_dollars: "0.15",
        },
      },
      slot.startTs + 6_000,
    );

    const state = feed.buildState(slot, slot.startTs + 6_000);

    expect(state.quote.outcomes.yes.buyPrice).toBe(0.53);
    expect(state.quote.outcomes.no.buyPrice).toBe(0.48);
    expect(state.quote.outcomes.no.sellPrice).toBe(0.47);
  });
});
