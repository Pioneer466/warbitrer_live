import * as polymarketLib from "@/lib/polymarket";
import { MARKET_ASSETS, MARKET_CATALOG } from "@/lib/market-catalog";
import { deriveKalshiOutcomeQuotes, extractKalshiLastTradePrices } from "@/lib/kalshi";
import {
  applyLevelDelta,
  chooseFeedSource,
  computeFeedStatus,
  isChainlinkPriceStreamSilent,
  KALSHI_CF_BENCHMARK_INDEX_BY_ASSET,
  MarketDataSupervisor,
  parseKalshiCfBenchmarksValue,
  parseKalshiPrivateFill,
  parsePolymarketUserFills,
  shouldRestResync,
} from "@/lib/market-data";
import type {
  KalshiQuote,
  LiveMarketState,
  MarketAsset,
  MarketSlot,
  PolymarketQuote,
  VenueSubscriptionState,
} from "@/lib/types";
import { afterEach, vi } from "vitest";

type PolymarketBookTestState = {
  tokenId: string;
  bids: Map<string, number>;
  asks: Map<string, number>;
  tickSize: number | null;
  minOrderSize: number | null;
  bestBidPrice: number | null;
  bestBidSize: number | null;
  bestAskPrice: number | null;
  bestAskSize: number | null;
  lastTradePrice: number | null;
  lastUpdatedAt: number | null;
};

type KalshiBookTestState = {
  yes: Map<string, number>;
  no: Map<string, number>;
  seq: number | null;
  lastUpdatedAt: number | null;
};

type FeedTestDouble = {
  ensureSlot: (slot: MarketSlot, now?: number) => unknown;
  buildState: (slot: MarketSlot, now?: number) => unknown;
};

type PolymarketFeedTestHarness = {
  slotKey: string | null;
  slotStartTs: number | null;
  market: Record<string, unknown> & { slug: string };
  tokenIds: { up: string; down: string } | null;
  books: Map<string, PolymarketBookTestState>;
  ws: unknown;
  userWs: unknown;
  priceWs: unknown;
  wsHeartbeat: ReturnType<typeof setInterval> | null;
  userWsHeartbeat: ReturnType<typeof setInterval> | null;
  priceWsHeartbeat: ReturnType<typeof setInterval> | null;
  marketReconnectTimer: ReturnType<typeof setTimeout> | null;
  userReconnectTimer: ReturnType<typeof setTimeout> | null;
  priceReconnectTimer: ReturnType<typeof setTimeout> | null;
  resyncPromise: Promise<void> | null;
  lastRestSyncAt: number | null;
  lastWsMessageAt: number | null;
  lastError: string | null;
  subscriptions: VenueSubscriptionState[];
  ensureSlot: (slot: MarketSlot, now?: number) => Promise<void>;
  ensureWs: (now?: number) => void;
  connectMarketWs: (now: number) => void;
  handleMarketWsClose: (ws: unknown) => void;
  scheduleMarketReconnect: () => void;
  applyUserEvent: (event: unknown, now: number) => void;
  applyMarketEvent: (event: unknown, now: number) => void;
  applyPriceEvent: (event: unknown, now: number) => void;
  onPrivateFeedReset: (venue: "polymarket" | "kalshi", marketRef: string | null) => void;
  buildState: (slot: MarketSlot, now?: number) => LiveMarketState<PolymarketQuote>;
  shutdown: () => Promise<void>;
};

type KalshiFeedTestHarness = {
  asset: MarketAsset | null;
  slotKey: string | null;
  series: Record<string, unknown>;
  market: Record<string, unknown> & { ticker: string };
  orderbook: KalshiBookTestState | null;
  orderbookInSync: boolean;
  trades: unknown[];
  ws: unknown;
  wsHeartbeat: ReturnType<typeof setInterval> | null;
  wsBootstrapTimer: ReturnType<typeof setTimeout> | null;
  wsReconnectTimer: ReturnType<typeof setTimeout> | null;
  wsOrderbookReady: boolean;
  lastRestSyncAt: number | null;
  lastWsMessageAt: number | null;
  lastError: string | null;
  subscriptions: VenueSubscriptionState[];
  subscriptionCommands: Map<number, string>;
  ensureSlot: (slot: MarketSlot, now?: number) => Promise<void>;
  ensureWs: () => void;
  resync: (now: number) => Promise<void> | null;
  subscribe: (ws: unknown, channel: string, marketTicker: string, cfBenchmarkIndexId?: string) => void;
  applyWsPayload: (payload: unknown, now: number) => boolean;
  buildState: (slot: MarketSlot, now?: number) => LiveMarketState<KalshiQuote>;
  shutdown: () => Promise<void>;
};

type MarketDataSupervisorTestHarness = Pick<
  MarketDataSupervisor,
  "readRecentOrderFills" | "readSlotState" | "shutdown" | "waitForOrderFill"
> & {
  feeds: Record<
    MarketAsset,
    {
      polymarket: FeedTestDouble;
      kalshi: FeedTestDouble;
    }
  >;
  fillTracker: {
    waiters: Map<number, unknown>;
  };
};

function inspectSupervisor(supervisor = new MarketDataSupervisor()) {
  return supervisor as unknown as MarketDataSupervisorTestHarness;
}

function inspectPolymarketFeed(supervisor: MarketDataSupervisorTestHarness, asset: MarketAsset = "btc") {
  return supervisor.feeds[asset].polymarket as unknown as PolymarketFeedTestHarness;
}

function inspectKalshiFeed(supervisor: MarketDataSupervisorTestHarness, asset: MarketAsset = "btc") {
  return supervisor.feeds[asset].kalshi as unknown as KalshiFeedTestHarness;
}

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

function primeKalshiFeed(feed: KalshiFeedTestHarness, slot: MarketSlot, now: number) {
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
    price_level_structure: "linear_cent",
    price_ranges: [{ start: "0.0000", end: "1.0000", step: "0.0100" }],
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
  vi.useRealTimers();
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

  it("distinguishes Chainlink price silence from websocket heartbeat activity", () => {
    expect(isChainlinkPriceStreamSilent(null, 1_000, 15_000)).toBe(false);
    expect(isChainlinkPriceStreamSilent(null, 1_000, 16_001)).toBe(true);
    expect(isChainlinkPriceStreamSilent(14_000, 1_000, 20_000)).toBe(false);
    expect(isChainlinkPriceStreamSilent(2_000, 14_000, 20_000)).toBe(false);
  });

  it("ignores stale Polymarket market socket closes and deduplicates reconnect timers", async () => {
    vi.useFakeTimers();
    const supervisor = inspectSupervisor();
    const feed = inspectPolymarketFeed(supervisor);
    const staleSocket = {};
    const currentSocket = {};
    feed.slotKey = "btc:1770000000000";
    feed.ws = currentSocket;

    feed.handleMarketWsClose(staleSocket);

    expect(feed.ws).toBe(currentSocket);
    expect(feed.marketReconnectTimer).toBeNull();

    feed.handleMarketWsClose(currentSocket);
    feed.scheduleMarketReconnect();
    const connectMarketWs = vi.spyOn(feed, "connectMarketWs").mockImplementation(() => {});

    expect(feed.ws).toBeNull();
    expect(feed.marketReconnectTimer).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connectMarketWs).toHaveBeenCalledTimes(1);

    feed.ws = currentSocket;
    feed.scheduleMarketReconnect();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(connectMarketWs).toHaveBeenCalledTimes(1);
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

    const supervisor = inspectSupervisor();
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

    vi.stubGlobal("fetch", fetchMock);

    const supervisor = inspectSupervisor();
    const feed = inspectKalshiFeed(supervisor);
    feed.ensureWs = vi.fn();

    await expect(feed.ensureSlot(slot, 1_000)).rejects.toThrow(/HTTP 429/);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(feed.ensureSlot(slot, 1_250)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(feed.lastError).toContain("retry in 9750ms");

    await expect(feed.ensureSlot(slot, 11_001)).rejects.toThrow(/HTTP 429/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("requires a Kalshi orderbook snapshot before marking the quote source as websocket", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const slot = buildSlot();
    const supervisor = inspectSupervisor();
    const tickerFeed = inspectKalshiFeed(supervisor);
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

    expect(tickerFeed.buildState(slot, slot.startTs + 2_500).quote.feedHealth.source).toBe("rest-bootstrap");

    const snapshotFeed = inspectSupervisor();
    const orderbookFeed = inspectKalshiFeed(snapshotFeed);
    primeKalshiFeed(orderbookFeed, slot, slot.startTs + 1_000);
    orderbookFeed.applyWsPayload(
      {
        type: "orderbook_snapshot",
        seq: 12,
        msg: {
          market_ticker: "KXBTC15M-CURRENT",
          yes_dollars_fp: [["0.44", "15"]],
          no_dollars_fp: [["0.55", "16"]],
        },
      },
      slot.startTs + 2_000,
    );

    expect(orderbookFeed.buildState(slot, slot.startTs + 2_500).quote.feedHealth.source).toBe("ws");
    expect(orderbookFeed.orderbook?.seq).toBe(12);
  });

  it("closes a Kalshi websocket session after a protocol error instead of staying on REST bootstrap", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const slot = buildSlot();
    const supervisor = inspectSupervisor();
    const feed = inspectKalshiFeed(supervisor);
    primeKalshiFeed(feed, slot, slot.startTs + 1_000);
    const ws = {
      readyState: 1,
      close: vi.fn(),
    };
    feed.ws = ws;

    feed.applyWsPayload(
      {
        id: 3,
        type: "error",
        msg: {
          code: 16,
          msg: "Market not found",
        },
      },
      slot.startTs + 2_000,
    );

    expect(feed.lastError).toContain("protocol error 16 on command 3: Market not found");
    expect(feed.subscriptions.every((subscription) => subscription.status === "error")).toBe(true);
    expect(ws.close).toHaveBeenCalledWith(1011, "Kalshi WS session failed");
    expect(warn).toHaveBeenCalledWith(
      "[kalshi-ws] session-failed",
      expect.objectContaining({ details: expect.stringContaining("protocol error 16") }),
    );
  });

  it("maps every active crypto asset to its Kalshi CF Benchmarks index", () => {
    expect(KALSHI_CF_BENCHMARK_INDEX_BY_ASSET).toEqual({
      btc: "BRTI",
      eth: "ETHUSD_RTI",
      sol: "SOLUSD_RTI",
      xrp: "XRPUSD_RTI",
      doge: "DOGEUSD_RTI",
      bnb: "BNBUSD_RTI",
      hype: "HYPEUSD_RTI",
    });
  });

  it.each([
    ["bnb", "BNBUSD_RTI"],
    ["hype", "HYPEUSD_RTI"],
  ] as const)("subscribes %s to its dedicated CF Benchmarks index", (asset, indexId) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const slot = buildSlot(asset);
    const supervisor = inspectSupervisor();
    const feed = inspectKalshiFeed(supervisor, asset);
    primeKalshiFeed(feed, slot, slot.startTs + 1_000);
    feed.asset = asset;
    const ws = { send: vi.fn() };

    feed.subscribe(ws, "cfbenchmarks_value", feed.market.ticker, KALSHI_CF_BENCHMARK_INDEX_BY_ASSET[asset]);

    expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({
      id: 1,
      cmd: "subscribe",
      params: {
        channels: ["cfbenchmarks_value"],
        index_ids: [indexId],
      },
    });
  });

  it("subscribes to the mapped CF Benchmarks index without a market ticker", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const slot = buildSlot("eth");
    const supervisor = inspectSupervisor();
    const feed = inspectKalshiFeed(supervisor, "eth");
    primeKalshiFeed(feed, slot, slot.startTs + 1_000);
    feed.asset = "eth";
    const ws = { send: vi.fn() };

    feed.subscribe(ws, "cfbenchmarks_value", feed.market.ticker, "ETHUSD_RTI");

    expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({
      id: 1,
      cmd: "subscribe",
      params: {
        channels: ["cfbenchmarks_value"],
        index_ids: ["ETHUSD_RTI"],
      },
    });
    expect(feed.subscriptionCommands.get(1)).toBe("cfbenchmarks_value");
  });

  it("subscribes to authenticated Kalshi fills for the current market", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const slot = buildSlot();
    const supervisor = inspectSupervisor();
    const feed = inspectKalshiFeed(supervisor);
    primeKalshiFeed(feed, slot, slot.startTs + 1_000);
    const ws = { send: vi.fn() };

    feed.subscribe(ws, "fill", feed.market.ticker);

    expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({
      id: 1,
      cmd: "subscribe",
      params: {
        channels: ["fill"],
        market_tickers: ["KXBTC15M-CURRENT"],
      },
    });
    expect(feed.subscriptionCommands.get(1)).toBe("fill");
  });

  it("parses and exposes Kalshi CF live, trailing, and final-minute averages", () => {
    const now = 1_710_000_000_456;
    const message = {
      index_id: "BRTI",
      received_at: 1_710_000_000_123,
      data: JSON.stringify({
        type: "value",
        id: "BRTI",
        time: 1_710_000_000_100,
        value: "68000.12",
      }),
      avg_60s_data: {
        value: "67998.12000000",
        window_size: 59,
        window_start_ts_ms: 1_709_999_940_100,
        window_end_ts_exclusive: 1_710_000_000_100,
      },
      last_60s_windowed_average_15min: {
        value: "68000.23000000",
        window_size: 14,
        window_start_ts_ms: 1_709_999_980_000,
        window_end_ts_exclusive: 1_710_000_000_100,
      },
    };

    expect(parseKalshiCfBenchmarksValue(message, now)).toEqual({
      indexId: "BRTI",
      liveValueUsd: 68000.12,
      sourceTimestampMs: 1_710_000_000_100,
      receivedAtMs: 1_710_000_000_123,
      capturedAt: now,
      trailing60s: {
        valueUsd: 67998.12,
        windowSize: 59,
        windowStartTsMs: 1_709_999_940_100,
        windowEndTsExclusive: 1_710_000_000_100,
      },
      finalMinuteAverage15m: {
        valueUsd: 68000.23,
        windowSize: 14,
        windowStartTsMs: 1_709_999_980_000,
        windowEndTsExclusive: 1_710_000_000_100,
      },
    });

    const slot = buildSlot();
    const supervisor = inspectSupervisor();
    const feed = inspectKalshiFeed(supervisor);
    primeKalshiFeed(feed, slot, slot.startTs + 1_000);
    feed.asset = "btc";

    expect(feed.applyWsPayload({ type: "cfbenchmarks_value", msg: message }, now)).toBe(true);

    const state = feed.buildState(slot, now);
    expect(state.quote.cfBenchmarks?.indexId).toBe("BRTI");
    expect(state.quote.cfBenchmarks?.finalMinuteAverage15m?.windowSize).toBe(14);
    expect(feed.subscriptions[3]).toEqual(
      expect.objectContaining({
        channel: "cfbenchmarks_value",
        status: "subscribed",
        source: "ws",
        lastMessageAt: now,
      }),
    );
    expect(feed.lastWsMessageAt).toBeNull();
  });

  it("isolates a denied CF subscription without closing the Kalshi market-data session", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const slot = buildSlot();
    const supervisor = inspectSupervisor();
    const feed = inspectKalshiFeed(supervisor);
    primeKalshiFeed(feed, slot, slot.startTs + 1_000);
    const ws = {
      readyState: 1,
      close: vi.fn(),
    };
    feed.ws = ws;
    feed.subscriptionCommands.set(4, "cfbenchmarks_value");
    for (const subscription of feed.subscriptions.slice(0, 3)) {
      subscription.status = "subscribed";
      subscription.source = "ws";
    }

    feed.applyWsPayload(
      {
        id: 4,
        type: "error",
        msg: {
          code: 9,
          msg: "Not authorized for CF Benchmarks value feed",
        },
      },
      slot.startTs + 2_000,
    );

    expect(feed.lastError).toBeNull();
    expect(feed.subscriptions.slice(0, 3).every((subscription) => subscription.status === "subscribed")).toBe(true);
    expect(feed.subscriptions[3]).toEqual(
      expect.objectContaining({
        status: "error",
        source: "unavailable",
        details: expect.stringContaining("Not authorized"),
      }),
    );
    expect(ws.close).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[kalshi-ws] optional-subscription-failed",
      expect.objectContaining({ channel: "cfbenchmarks_value", commandId: 4 }),
    );

    feed.applyWsPayload(
      {
        type: "orderbook_snapshot",
        seq: 12,
        msg: {
          market_ticker: "KXBTC15M-CURRENT",
          yes_dollars_fp: [["0.44", "15"]],
          no_dollars_fp: [["0.55", "16"]],
        },
      },
      slot.startTs + 2_100,
    );
    expect(feed.buildState(slot, slot.startTs + 2_200).quote.feedHealth.source).toBe("ws");
  });

  it("parses Kalshi private fills with fixed-point size, price, and matching-engine timestamp", () => {
    const capturedAt = 1_771_234_568_000;

    expect(
      parseKalshiPrivateFill(
        {
          type: "fill",
          sid: 13,
          msg: {
            trade_id: "trade-kalshi-1",
            order_id: "order-kalshi-1",
            market_ticker: "KXBTC15M-CURRENT",
            is_taker: true,
            side: "no",
            yes_price_dollars: "0.4200",
            count_fp: "12.50",
            action: "buy",
            ts: 1_771_234_567,
          },
        },
        capturedAt,
      ),
    ).toEqual(
      expect.objectContaining({
        venue: "kalshi",
        venueOrderId: "order-kalshi-1",
        tradeId: "trade-kalshi-1",
        marketRef: "KXBTC15M-CURRENT",
        side: "BUY",
        outcome: "NO",
        price: 0.58,
        size: 12.5,
        liquidity: "TAKER",
        filledAt: 1_771_234_567_000,
        capturedAt,
      }),
    );
  });

  it("parses Polymarket taker and maker trade messages tolerantly", () => {
    const capturedAt = 1_771_234_568_000;
    const [takerFill] = parsePolymarketUserFills(
      {
        type: "user",
        data: {
          event_type: "trade",
          id: "trade-poly-taker",
          taker_order_id: "order-poly-taker",
          market: "condition-1",
          asset_id: "asset-up",
          side: "BUY",
          size: "10.25",
          price: "0.57",
          status: "MATCHED",
          outcome: "Up",
          trader_side: "TAKER",
          timestamp: "1771234567",
          maker_orders: [],
        },
      },
      capturedAt,
    );
    const [makerFill] = parsePolymarketUserFills(
      {
        event_type: "trade",
        id: "trade-poly-maker",
        taker_order_id: "counterparty-order",
        market: "condition-1",
        asset_id: "asset-down",
        side: "BUY",
        size: "8",
        price: "0.44",
        status: "TRADE_STATUS_CONFIRMED",
        outcome: "Down",
        trader_side: "MAKER",
        timestamp: 1_771_234_567,
        maker_orders: [
          {
            order_id: "order-poly-maker",
            matched_amount: "3.5",
            price: "0.56",
            asset_id: "asset-down",
            outcome: "Down",
            side: "SELL",
          },
        ],
      },
      capturedAt,
    );

    expect(takerFill).toEqual(
      expect.objectContaining({
        venue: "polymarket",
        venueOrderId: "order-poly-taker",
        tradeId: "trade-poly-taker",
        side: "BUY",
        outcome: "UP",
        price: 0.57,
        size: 10.25,
        liquidity: "TAKER",
        filledAt: 1_771_234_567_000,
      }),
    );
    expect(makerFill).toEqual(
      expect.objectContaining({
        venueOrderId: "order-poly-maker",
        side: "SELL",
        outcome: "DOWN",
        price: 0.56,
        size: 3.5,
        liquidity: "MAKER",
        status: "CONFIRMED",
      }),
    );
    expect(
      parsePolymarketUserFills(
        {
          event_type: "trade",
          id: "trade-poly-unknown",
          taker_order_id: "order-poly-unknown",
          market: "condition-1",
          asset_id: "asset-up",
          side: "BUY",
          size: "1",
          price: "0.5",
          status: "TRADE_STATUS_SETTLED",
          outcome: "Up",
          trader_side: "TAKER",
          timestamp: 1_771_234_567,
          maker_orders: [],
        },
        capturedAt,
      ),
    ).toEqual([]);
  });

  it("keeps only authenticated-owner maker fills when owner metadata is present", () => {
    const fills = parsePolymarketUserFills(
      {
        event_type: "trade",
        id: "trade-poly-multi-maker",
        owner: "owner-authenticated",
        trade_owner: "owner-authenticated",
        market: "condition-1",
        status: "MATCHED",
        trader_side: "MAKER",
        timestamp: 1_771_234_567,
        maker_orders: [
          {
            order_id: "order-owned",
            owner: "OWNER-AUTHENTICATED",
            matched_amount: "2.5",
            price: "0.53",
            asset_id: "asset-up",
            outcome: "Up",
            side: "SELL",
          },
          {
            order_id: "order-counterparty",
            owner: "owner-counterparty",
            matched_amount: "4",
            price: "0.53",
            asset_id: "asset-up",
            outcome: "Up",
            side: "SELL",
          },
          {
            order_id: "order-unattributed",
            matched_amount: "1",
            price: "0.53",
            asset_id: "asset-up",
            outcome: "Up",
            side: "SELL",
          },
        ],
      },
      1_771_234_568_000,
    );

    expect(fills).toHaveLength(1);
    expect(fills[0]).toEqual(
      expect.objectContaining({
        venueOrderId: "order-owned",
        size: 2.5,
        liquidity: "MAKER",
      }),
    );
  });

  it("wakes a Kalshi fill waiter immediately, deduplicates replays, and preserves orderbook freshness", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const now = Date.now();
    const slot = buildSlot();
    const supervisor = inspectSupervisor();
    const feed = inspectKalshiFeed(supervisor);
    primeKalshiFeed(feed, slot, now - 1_000);

    const waiting = supervisor.waitForOrderFill({
      venue: "kalshi",
      venueOrderId: "order-kalshi-live",
      marketRef: "KXBTC15M-CURRENT",
      afterCapturedAt: now - 1,
      timeoutMs: 5_000,
    });
    const event = {
      type: "fill",
      msg: {
        trade_id: "trade-kalshi-live",
        order_id: "order-kalshi-live",
        market_ticker: "KXBTC15M-CURRENT",
        side: "yes",
        action: "buy",
        yes_price_dollars: "0.4100",
        count_fp: "4.00",
        is_taker: true,
        ts_ms: now,
      },
    };

    expect(feed.applyWsPayload(event, now)).toBe(false);
    await expect(waiting).resolves.toEqual(expect.objectContaining({ venueOrderId: "order-kalshi-live", size: 4 }));
    feed.applyWsPayload(event, now + 1);

    expect(supervisor.readRecentOrderFills({ venue: "kalshi" })).toHaveLength(1);
    expect(feed.subscriptions[4]).toEqual(
      expect.objectContaining({ channel: "fill", status: "subscribed", lastMessageAt: now + 1 }),
    );
    expect(feed.lastWsMessageAt).toBeNull();

    feed.applyWsPayload(
      {
        type: "orderbook_snapshot",
        seq: 12,
        msg: {
          market_ticker: "KXBTC15M-CURRENT",
          yes_dollars_fp: [["0.44", "15"]],
          no_dollars_fp: [["0.55", "16"]],
        },
      },
      now + 2,
    );
    expect(feed.buildState(slot, now + 3).quote.feedHealth.source).toBe("ws");
  });

  it("wakes a Polymarket waiter from the authenticated user channel", async () => {
    const now = Date.now();
    const supervisor = inspectSupervisor();
    const feed = inspectPolymarketFeed(supervisor);
    const waiting = supervisor.waitForOrderFill({
      venue: "polymarket",
      venueOrderId: "order-poly-live",
      marketRef: "condition-1",
      timeoutMs: 5_000,
    });

    feed.applyUserEvent(
      {
        event_type: "trade",
        id: "trade-poly-live",
        taker_order_id: "order-poly-live",
        market: "condition-1",
        asset_id: "asset-up",
        side: "BUY",
        size: "6",
        price: "0.49",
        status: "MATCHED",
        outcome: "Up",
        trader_side: "TAKER",
        timestamp: now,
        maker_orders: [],
      },
      now,
    );

    await expect(waiting).resolves.toEqual(
      expect.objectContaining({
        venue: "polymarket",
        venueOrderId: "order-poly-live",
        status: "MATCHED",
        size: 6,
      }),
    );
  });

  it("bounds fill waits and clears them on timeout or private-feed reconnect", async () => {
    vi.useFakeTimers();
    const supervisor = inspectSupervisor();
    const timedOut = supervisor.waitForOrderFill({
      venue: "kalshi",
      venueOrderId: "missing-order",
      timeoutMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(supervisor.fillTracker.waiters.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(timedOut).resolves.toBeNull();
    expect(supervisor.fillTracker.waiters.size).toBe(0);

    const disconnected = supervisor.waitForOrderFill({
      venue: "polymarket",
      venueOrderId: "pending-order",
      marketRef: "condition-1",
      timeoutMs: 5_000,
    });
    inspectPolymarketFeed(supervisor).onPrivateFeedReset("polymarket", "condition-1");

    await expect(disconnected).resolves.toBeNull();
    expect(supervisor.fillTracker.waiters.size).toBe(0);
  });

  it("settles every private-fill waiter and shuts every feed down idempotently", async () => {
    const supervisor = inspectSupervisor();
    const pendingKalshi = supervisor.waitForOrderFill({
      venue: "kalshi",
      venueOrderId: "pending-kalshi-order",
      timeoutMs: 30_000,
    });
    const pendingPolymarket = supervisor.waitForOrderFill({
      venue: "polymarket",
      venueOrderId: "pending-polymarket-order",
      timeoutMs: 30_000,
    });
    const feedShutdowns = Object.values(supervisor.feeds).flatMap((feeds) => [
      vi.spyOn(feeds.polymarket as never, "shutdown").mockResolvedValue(undefined),
      vi.spyOn(feeds.kalshi as never, "shutdown").mockResolvedValue(undefined),
    ]);

    const firstShutdown = supervisor.shutdown();
    const secondShutdown = supervisor.shutdown();

    expect(secondShutdown).toBe(firstShutdown);
    await expect(Promise.all([pendingKalshi, pendingPolymarket])).resolves.toEqual([null, null]);
    await expect(firstShutdown).resolves.toBeUndefined();
    expect(supervisor.fillTracker.waiters.size).toBe(0);
    expect(feedShutdowns).toHaveLength(MARKET_ASSETS.length * 2);
    expect(feedShutdowns.every((shutdown) => shutdown.mock.calls.length === 1)).toBe(true);
  });

  it("closes live sockets and removes every feed timer", async () => {
    vi.useFakeTimers();
    const supervisor = inspectSupervisor();
    const polymarket = inspectPolymarketFeed(supervisor);
    const kalshi = inspectKalshiFeed(supervisor);
    const marketSocket = { close: vi.fn() };
    const userSocket = { close: vi.fn() };
    const priceSocket = { close: vi.fn() };
    const kalshiSocket = { close: vi.fn() };
    polymarket.slotKey = buildSlot().key;
    polymarket.ws = marketSocket;
    polymarket.userWs = userSocket;
    polymarket.priceWs = priceSocket;
    polymarket.wsHeartbeat = setInterval(() => {}, 10_000);
    polymarket.userWsHeartbeat = setInterval(() => {}, 10_000);
    polymarket.priceWsHeartbeat = setInterval(() => {}, 10_000);
    polymarket.marketReconnectTimer = setTimeout(() => {}, 10_000);
    polymarket.userReconnectTimer = setTimeout(() => {}, 10_000);
    polymarket.priceReconnectTimer = setTimeout(() => {}, 10_000);
    kalshi.slotKey = buildSlot().key;
    kalshi.ws = kalshiSocket;
    kalshi.wsHeartbeat = setInterval(() => {}, 10_000);
    kalshi.wsBootstrapTimer = setTimeout(() => {}, 10_000);
    kalshi.wsReconnectTimer = setTimeout(() => {}, 10_000);

    await supervisor.shutdown();

    expect(marketSocket.close).toHaveBeenCalledTimes(1);
    expect(userSocket.close).toHaveBeenCalledTimes(1);
    expect(priceSocket.close).toHaveBeenCalledTimes(1);
    expect(kalshiSocket.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates a denied Kalshi fill subscription from CF and orderbook channels", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const slot = buildSlot();
    const supervisor = inspectSupervisor();
    const feed = inspectKalshiFeed(supervisor);
    primeKalshiFeed(feed, slot, slot.startTs + 1_000);
    const ws = { readyState: 1, close: vi.fn() };
    feed.ws = ws;
    feed.subscriptionCommands.set(5, "fill");
    feed.subscriptions[3].status = "subscribed";
    feed.subscriptions[3].source = "ws";

    feed.applyWsPayload(
      {
        id: 5,
        type: "error",
        msg: { code: 9, msg: "Not authorized for private fills" },
      },
      slot.startTs + 2_000,
    );

    expect(feed.subscriptions[3]).toEqual(
      expect.objectContaining({ channel: "cfbenchmarks_value", status: "subscribed" }),
    );
    expect(feed.subscriptions[4]).toEqual(
      expect.objectContaining({ channel: "fill", status: "error", source: "unavailable" }),
    );
    expect(ws.close).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[kalshi-ws] optional-subscription-failed",
      expect.objectContaining({ channel: "fill", commandId: 5 }),
    );
  });

  it("falls Kalshi source back to REST and then blocks after websocket and REST go stale", () => {
    const slot = buildSlot();
    const supervisor = inspectSupervisor();
    const feed = inspectKalshiFeed(supervisor);
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
    const supervisor = inspectSupervisor();
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
      expect(supervisor.feeds[slot.asset].polymarket.ensureSlot).toHaveBeenCalledWith(slot, 1770000005000 + index);
    }
    expect(supervisor.feeds.btc.polymarket).not.toBe(supervisor.feeds.eth.polymarket);
    expect(supervisor.feeds.sol.polymarket).not.toBe(supervisor.feeds.xrp.polymarket);
    expect(supervisor.feeds.doge.polymarket).not.toBe(supervisor.feeds.bnb.polymarket);
    expect(supervisor.feeds.bnb.polymarket).not.toBe(supervisor.feeds.hype.polymarket);
  });

  it("uses nested Polymarket price_change payloads to keep the top of book aligned", () => {
    const slot = buildSlot();

    const supervisor = inspectSupervisor();
    const feed = inspectPolymarketFeed(supervisor);

    feed.market = {
      id: "market-1",
      question: "BTC up/down 15m",
      slug: slot.polymarketSlug,
      startDate: new Date(slot.startTs - 24 * 60 * 60_000).toISOString(),
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
      asks: new Map([
        ["0.90", 50],
        ["0.53", 80],
      ]),
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

    expect(state.quote.ref.startTime).toBe(slot.startIso);
    expect(state.quote.ref.endTime).toBe(slot.endIso);
    expect(state.quote.outcomes.up.buyPrice).toBe(0.53);
    expect(state.quote.outcomes.up.sellPrice).toBe(0.52);
    expect(state.quote.outcomes.up.chart.price).toBe(0.53);
  });

  it("exposes Chainlink RTDS prices in the Polymarket quote and captures the slot open snapshot", () => {
    const slot = buildSlot();

    const supervisor = inspectSupervisor();
    const feed = inspectPolymarketFeed(supervisor);

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

    const supervisor = inspectSupervisor();
    const feed = inspectPolymarketFeed(supervisor);

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

    const supervisor = inspectSupervisor();
    const feed = inspectPolymarketFeed(supervisor);

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

    const supervisor = inspectSupervisor();
    const feed = inspectPolymarketFeed(supervisor);

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

    const supervisor = inspectSupervisor();
    const feed = inspectKalshiFeed(supervisor);

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

    const supervisor = inspectSupervisor();
    const feed = inspectPolymarketFeed(supervisor);

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

    const supervisor = inspectSupervisor();
    const feed = inspectKalshiFeed(supervisor);

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
    feed.resync = vi.fn(() => new Promise<void>(() => {}));

    feed.wsOrderbookReady = true;
    feed.applyWsPayload(
      {
        type: "orderbook_delta",
        seq: 3,
        msg: {
          market_ticker: "KXBTC15M-CURRENT",
          side: "yes",
          price_dollars: "0.40",
          delta_fp: "1",
        },
      },
      slot.startTs + 6_000,
    );

    const state = feed.buildState(slot, slot.startTs + 6_000);

    expect(state.quote.feedHealth.feedStatus).toBe("blocked");
    expect(state.quote.feedHealth.details[0]).toContain("Gap sequence Kalshi");
  });

  it("keeps Kalshi ticker YES and NO prices coherent when the websocket payload mixes stale fields", () => {
    const slot = buildSlot();

    const supervisor = inspectSupervisor();
    const feed = inspectKalshiFeed(supervisor);

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
