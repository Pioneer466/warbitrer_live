import WebSocket from "ws";

import {
  POLY_MARKET_WS_BASE,
  POLY_USER_WS_BASE,
} from "@/lib/constants";
import { hasKalshiCredentials, hasPolymarketCredentials, readEnv, readSecretValue } from "@/lib/env";
import { getMarketCatalogEntry } from "@/lib/market-catalog";
import {
  deriveKalshiOutcomeQuotes,
  deriveKalshiOutcomeQuotesFromMarket,
  deriveKalshiOutcomeQuotesFromMarketWithSource,
  extractKalshiLastTradePrices,
  fetchKalshiMarket,
  fetchKalshiMarkets,
  fetchKalshiOrderbook,
  fetchKalshiSeries,
  fetchKalshiTrades,
  getKalshiWsUrl,
  resolveKalshiMarketForSlot,
  type KalshiMarketSummary,
  type KalshiOrderbook,
  type KalshiTrade,
} from "@/lib/kalshi";
import {
  buildPolymarketOutcomeQuoteFromBook,
  createUnavailablePolymarketQuote,
  derivePolymarketOutcomeTokens,
  extractPolymarketResolution,
  fetchPolymarketBook,
  fetchPolymarketMarket,
} from "@/lib/polymarket";
import type {
  FeedSource,
  KalshiQuote,
  LiveMarketState,
  MarketAsset,
  MarketSlot,
  PolymarketQuote,
  ReadinessStatus,
  SubscriptionStatus,
  VenueFeedHealth,
  VenueSubscriptionState,
} from "@/lib/types";

const FEED_READY_MS = 4_000;
const FEED_BLOCKED_MS = 10_000;
const POLYMARKET_RESYNC_MS = 2_000;
const KALSHI_RESYNC_MS = 1_000;
const POLYMARKET_WS_HEARTBEAT_MS = 3_000;
const WS_RECONNECT_BASE_MS = 1_000;
const WS_RECONNECT_MAX_MS = 10_000;

type LevelMap = Map<string, number>;

type PolymarketBookState = {
  tokenId: string;
  bids: LevelMap;
  asks: LevelMap;
  tickSize: number | null;
  minOrderSize: number | null;
  bestBidPrice: number | null;
  bestBidSize: number | null;
  bestAskPrice: number | null;
  bestAskSize: number | null;
  lastTradePrice: number | null;
  lastUpdatedAt: number | null;
};

type PolymarketMarketRecord = NonNullable<Awaited<ReturnType<typeof fetchPolymarketMarket>>>;

type KalshiBookState = {
  yes: LevelMap;
  no: LevelMap;
  seq: number | null;
  lastUpdatedAt: number | null;
};

function emptySubscriptions(channels: string[], source: FeedSource): VenueSubscriptionState[] {
  return channels.map((channel) => ({
    channel,
    status: "idle",
    source,
    lastMessageAt: null,
    details: null,
  }));
}

export function computeFeedStatus(lastMessageAt: number | null, dataReady: boolean, now: number): {
  status: ReadinessStatus;
  stalenessMs: number | null;
} {
  if (!dataReady || lastMessageAt === null) {
    return {
      status: "blocked",
      stalenessMs: null,
    };
  }

  const stalenessMs = Math.max(0, now - lastMessageAt);
  if (stalenessMs <= FEED_READY_MS) {
    return { status: "ready", stalenessMs };
  }
  if (stalenessMs <= FEED_BLOCKED_MS) {
    return { status: "degraded", stalenessMs };
  }
  return { status: "blocked", stalenessMs };
}

export function chooseFeedSource(lastWsMessageAt: number | null, lastRestSyncAt: number | null, now: number): FeedSource {
  const wsFresh = lastWsMessageAt !== null && now - lastWsMessageAt <= FEED_BLOCKED_MS;
  const restFresh = lastRestSyncAt !== null && now - lastRestSyncAt <= FEED_BLOCKED_MS;

  if (wsFresh) {
    return "ws";
  }
  if (restFresh && lastWsMessageAt !== null) {
    return "rest-fallback";
  }
  if (restFresh) {
    return "rest-bootstrap";
  }
  return "unavailable";
}

function buildFeedHealth(input: {
  asset: MarketSlot["asset"];
  venue: "kalshi" | "polymarket";
  now: number;
  lastMessageAt: number | null;
  lastWsMessageAt: number | null;
  lastRestSyncAt: number | null;
  dataReady: boolean;
  details: string[];
  subscriptions: VenueSubscriptionState[];
}): VenueFeedHealth {
  const { status, stalenessMs } = computeFeedStatus(input.lastMessageAt, input.dataReady, input.now);
  return {
    asset: input.asset,
    venue: input.venue,
    feedStatus: status,
    source: chooseFeedSource(input.lastWsMessageAt, input.lastRestSyncAt, input.now),
    lastMessageAt: input.lastMessageAt,
    stalenessMs,
    details: input.details,
    subscriptions: input.subscriptions,
  };
}

function serializeLevelMap(levels: LevelMap, direction: "asc" | "desc") {
  return [...levels.entries()]
    .map(([price, size]) => [price, String(size)] as [string, string])
    .filter(([, size]) => Number(size) > 0)
    .sort((left, right) => {
      const delta = Number(left[0]) - Number(right[0]);
      return direction === "asc" ? delta : -delta;
    });
}

function replaceLevelMap(levels: LevelMap, next: Array<[string, string]>) {
  levels.clear();
  for (const [price, size] of next) {
    const parsedSize = Number(size);
    if (Number.isFinite(parsedSize) && parsedSize > 0) {
      levels.set(String(price), parsedSize);
    }
  }
}

export function applyLevelDelta(levels: LevelMap, price: string | number, size: string | number) {
  const normalizedPrice = String(price);
  const parsedSize = Number(size);
  if (!Number.isFinite(parsedSize) || parsedSize <= 0) {
    levels.delete(normalizedPrice);
    return;
  }

  levels.set(normalizedPrice, parsedSize);
}

function parseNumeric(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseTimestamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1_000;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toSubscriptionState(
  previous: VenueSubscriptionState,
  patch: Partial<VenueSubscriptionState>,
): VenueSubscriptionState {
  return {
    ...previous,
    ...patch,
  };
}

function nextReconnectDelay(attempt: number) {
  return Math.min(WS_RECONNECT_MAX_MS, WS_RECONNECT_BASE_MS * 2 ** attempt);
}

class PolymarketRealtimeFeed {
  private slotKey: string | null = null;
  private market: PolymarketMarketRecord | null = null;
  private tokenIds: { up: string; down: string } | null = null;
  private books = new Map<string, PolymarketBookState>();
  private ws: WebSocket | null = null;
  private userWs: WebSocket | null = null;
  private wsHeartbeat: ReturnType<typeof setInterval> | null = null;
  private userWsHeartbeat: ReturnType<typeof setInterval> | null = null;
  private bootstrapPromise: Promise<void> | null = null;
  private resyncPromise: Promise<void> | null = null;
  private lastRestSyncAt: number | null = null;
  private lastWsMessageAt: number | null = null;
  private lastUserMessageAt: number | null = null;
  private lastError: string | null = null;
  private reconnectAttempt = 0;
  private userReconnectAttempt = 0;
  private subscriptions = emptySubscriptions(["market", "user"], "rest-bootstrap");

  async ensureSlot(slot: MarketSlot, now = Date.now()) {
    if (this.slotKey !== slot.key) {
      await this.reset();
      this.slotKey = slot.key;
    }

    if (!this.market || !this.tokenIds) {
      await this.bootstrap(slot, now);
    } else if (this.lastRestSyncAt === null || now - this.lastRestSyncAt >= POLYMARKET_RESYNC_MS) {
      void this.resync(slot, now);
    }

    this.ensureWs(now);
  }

  buildState(slot: MarketSlot, now = Date.now()): LiveMarketState<PolymarketQuote> {
    if (!this.market || !this.tokenIds) {
      return {
        venue: "polymarket",
        slotKey: slot.key,
        marketRef: null,
        quote: createUnavailablePolymarketQuote(
          slot,
          this.lastError ?? "Feed Polymarket indisponible pour le créneau courant",
        ),
        lastBootstrapAt: this.lastRestSyncAt,
        lastSyncAt: this.lastRestSyncAt,
      };
    }

    const upBook = this.books.get(this.tokenIds.up);
    const downBook = this.books.get(this.tokenIds.down);
    const lastMessageAt = [this.lastWsMessageAt, this.lastRestSyncAt].filter(Boolean).sort((a, b) => b! - a!)[0] ?? null;
    const feedHealth = buildFeedHealth({
      asset: slot.asset,
      venue: "polymarket",
      now,
      lastMessageAt,
      lastWsMessageAt: this.lastWsMessageAt,
      lastRestSyncAt: this.lastRestSyncAt,
      dataReady: Boolean(upBook && downBook),
      details: [
        this.lastError ?? "Feed Polymarket actif",
        this.lastUserMessageAt ? "user channel connecte" : "user channel en fallback REST",
      ],
      subscriptions: this.subscriptions,
    });

    const upOutcome =
      upBook
        ? buildPolymarketOutcomeQuoteFromBook(
            "UP",
            serializePolymarketBook(upBook),
            feedHealth.source,
            upBook.lastUpdatedAt,
            upBook.lastTradePrice,
          )
        : createUnavailablePolymarketQuote(slot, "Orderbook Polymarket indisponible").outcomes.up;
    const downOutcome =
      downBook
        ? buildPolymarketOutcomeQuoteFromBook(
            "DOWN",
            serializePolymarketBook(downBook),
            feedHealth.source,
            downBook.lastUpdatedAt,
            downBook.lastTradePrice,
          )
        : createUnavailablePolymarketQuote(slot, "Orderbook Polymarket indisponible").outcomes.down;

    const quote: PolymarketQuote = {
      ref: {
        asset: slot.asset,
        venue: "polymarket",
        id: this.market.id,
        slotKey: slot.key,
        slug: this.market.slug,
        conditionId: this.market.conditionId ?? this.market.id,
        title: this.market.question,
        url: `https://polymarket.com/event/${this.market.slug}`,
        startTime: this.market.startDate,
        endTime: this.market.endDate,
      },
      conditionId: this.market.conditionId ?? this.market.id,
      status: this.market.closed ? "closed" : "open",
      slotAligned: true,
      availabilityReason: null,
      feedHealth,
      lastMessageAt,
      stalenessMs: feedHealth.stalenessMs,
      source: feedHealth.source,
      outcomes: {
        up: upOutcome,
        down: downOutcome,
      },
      resolution: extractPolymarketResolution(this.market.outcomePrices),
      tokenIds: this.tokenIds,
      feeRateBps: 0,
      negRisk: false,
    };

    return {
      venue: "polymarket",
      slotKey: slot.key,
      marketRef: quote.ref.conditionId ?? quote.ref.id,
      quote,
      lastBootstrapAt: this.lastRestSyncAt,
      lastSyncAt: lastMessageAt,
    };
  }

  private async bootstrap(slot: MarketSlot, now: number) {
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = (async () => {
        const market = await fetchPolymarketMarket(slot.polymarketSlug);
        if (!market) {
          throw new Error(`Polymarket market ${slot.polymarketSlug} introuvable`);
        }

        const tokenIds = derivePolymarketOutcomeTokens(market);
        const [upBook, downBook] = await Promise.all([
          fetchPolymarketBook(tokenIds.up),
          fetchPolymarketBook(tokenIds.down),
        ]);

        this.market = market;
        this.tokenIds = tokenIds;
        this.books.set(tokenIds.up, createPolymarketBookState(tokenIds.up, upBook, now));
        this.books.set(tokenIds.down, createPolymarketBookState(tokenIds.down, downBook, now));
        this.lastRestSyncAt = now;
        this.lastError = null;
      })()
        .catch((error) => {
          this.lastError = error instanceof Error ? error.message : "Bootstrap Polymarket impossible";
          throw error;
        })
        .finally(() => {
          this.bootstrapPromise = null;
        });
    }

    return this.bootstrapPromise;
  }

  private async resync(slot: MarketSlot, now: number) {
    if (!this.market || !this.tokenIds || this.resyncPromise) {
      return this.resyncPromise;
    }

    this.resyncPromise = (async () => {
      try {
        const [upBook, downBook] = await Promise.all([
          fetchPolymarketBook(this.tokenIds!.up),
          fetchPolymarketBook(this.tokenIds!.down),
        ]);
        this.books.set(this.tokenIds!.up, createPolymarketBookState(this.tokenIds!.up, upBook, now));
        this.books.set(this.tokenIds!.down, createPolymarketBookState(this.tokenIds!.down, downBook, now));
        const freshMarket = await fetchPolymarketMarket(slot.polymarketSlug).catch(() => null);
        if (freshMarket) {
          this.market = freshMarket;
        }
        this.lastRestSyncAt = now;
        this.lastError = null;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : "Resync Polymarket impossible";
      }
    })().finally(() => {
      this.resyncPromise = null;
    });

    return this.resyncPromise;
  }

  private ensureWs(now: number) {
    if (!this.tokenIds || this.ws) {
      return;
    }

    this.connectMarketWs(now);
    if (hasPolymarketCredentials()) {
      this.connectUserWs(now);
    }
  }

  private connectMarketWs(now: number) {
    this.subscriptions[0] = toSubscriptionState(this.subscriptions[0], {
      status: "connecting",
      source: "ws",
      details: "connexion au market channel",
    });

    const ws = new WebSocket(POLY_MARKET_WS_BASE);
    this.ws = ws;

    ws.on("open", () => {
      if (!this.tokenIds) {
        return;
      }

      this.reconnectAttempt = 0;
      this.startMarketHeartbeat(ws);
      this.subscriptions[0] = toSubscriptionState(this.subscriptions[0], {
        status: "subscribed",
        source: "ws",
        details: "market channel actif",
      });
      ws.send(
        JSON.stringify({
          type: "market",
          assets_ids: [this.tokenIds.up, this.tokenIds.down],
          custom_feature_enabled: true,
        }),
      );
    });

    ws.on("message", (buffer: Buffer) => {
      const raw = buffer.toString();
      const nowTs = Date.now();
      if (raw === "PONG") {
        this.lastWsMessageAt = nowTs;
        this.subscriptions[0] = toSubscriptionState(this.subscriptions[0], {
          status: "subscribed",
          source: "ws",
          lastMessageAt: nowTs,
          details: "market channel actif",
        });
        return;
      }

      const payload = safeJsonParse(raw);
      if (!payload) {
        return;
      }

      const events = Array.isArray(payload) ? payload : [payload];
      for (const event of events) {
        this.applyMarketEvent(event, nowTs);
      }

      this.lastWsMessageAt = nowTs;
      this.subscriptions[0] = toSubscriptionState(this.subscriptions[0], {
        status: "subscribed",
        source: "ws",
        lastMessageAt: nowTs,
        details: "market channel actif",
      });
    });

    ws.on("error", (error: unknown) => {
      this.stopMarketHeartbeat();
      this.lastError = error instanceof Error ? error.message : "Polymarket market WS error";
      this.subscriptions[0] = toSubscriptionState(this.subscriptions[0], {
        status: "error",
        source: "ws",
        details: this.lastError,
      });
    });

    ws.on("close", () => {
      this.stopMarketHeartbeat();
      this.ws = null;
      this.subscriptions[0] = toSubscriptionState(this.subscriptions[0], {
        status: "closed",
        source: "ws",
        details: "market channel ferme, retry programme",
      });
      const delay = nextReconnectDelay(this.reconnectAttempt++);
      setTimeout(() => {
        if (this.slotKey) {
          this.connectMarketWs(Date.now());
        }
      }, delay);
    });
  }

  private connectUserWs(_now: number) {
    if (this.userWs) {
      return;
    }

    this.subscriptions[1] = toSubscriptionState(this.subscriptions[1], {
      status: "connecting",
      source: "ws",
      details: "connexion au user channel",
    });

    const env = readEnv();
    const ws = new WebSocket(POLY_USER_WS_BASE);
    this.userWs = ws;

    ws.on("open", () => {
      this.userReconnectAttempt = 0;
      this.startUserHeartbeat(ws);
      this.subscriptions[1] = toSubscriptionState(this.subscriptions[1], {
        status: "subscribed",
        source: "ws",
        details: "user channel actif",
      });
      ws.send(
        JSON.stringify({
          type: "user",
          markets: this.market ? [this.market.conditionId ?? this.market.id] : [],
          auth: {
            apiKey: env.POLY_API_KEY,
            secret: env.POLY_API_SECRET,
            passphrase: env.POLY_API_PASSPHRASE,
          },
        }),
      );
    });

    ws.on("message", (buffer: Buffer) => {
      const nowTs = Date.now();
      if (buffer.toString() === "PONG") {
        this.lastUserMessageAt = nowTs;
        this.subscriptions[1] = toSubscriptionState(this.subscriptions[1], {
          status: "subscribed",
          source: "ws",
          lastMessageAt: nowTs,
          details: "user channel actif",
        });
        return;
      }

      this.lastUserMessageAt = nowTs;
      this.subscriptions[1] = toSubscriptionState(this.subscriptions[1], {
        status: "subscribed",
        source: "ws",
        lastMessageAt: nowTs,
        details: "user channel actif",
      });
    });

    ws.on("error", (error: unknown) => {
      this.stopUserHeartbeat();
      const details = error instanceof Error ? error.message : "Polymarket user WS error";
      this.subscriptions[1] = toSubscriptionState(this.subscriptions[1], {
        status: "error",
        source: "ws",
        details,
      });
    });

    ws.on("close", () => {
      this.stopUserHeartbeat();
      this.userWs = null;
      this.subscriptions[1] = toSubscriptionState(this.subscriptions[1], {
        status: "closed",
        source: "ws",
        details: "user channel ferme, reconcile REST conserve",
      });
      const delay = nextReconnectDelay(this.userReconnectAttempt++);
      setTimeout(() => {
        if (this.slotKey && hasPolymarketCredentials()) {
          this.connectUserWs(Date.now());
        }
      }, delay);
    });
  }

  private startMarketHeartbeat(ws: WebSocket) {
    this.stopMarketHeartbeat();
    this.wsHeartbeat = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      ws.send("PING");
    }, POLYMARKET_WS_HEARTBEAT_MS);
  }

  private stopMarketHeartbeat() {
    if (this.wsHeartbeat) {
      clearInterval(this.wsHeartbeat);
      this.wsHeartbeat = null;
    }
  }

  private startUserHeartbeat(ws: WebSocket) {
    this.stopUserHeartbeat();
    this.userWsHeartbeat = setInterval(() => {
      if (this.userWs !== ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      ws.send("PING");
    }, POLYMARKET_WS_HEARTBEAT_MS);
  }

  private stopUserHeartbeat() {
    if (this.userWsHeartbeat) {
      clearInterval(this.userWsHeartbeat);
      this.userWsHeartbeat = null;
    }
  }

  private applyMarketEvent(event: any, now: number) {
    const eventType = String(event.event_type ?? event.type ?? "");

    if (eventType === "book") {
      const tokenId = String(event.asset_id ?? event.assetId ?? "");
      const bookState = this.books.get(tokenId);
      if (!bookState) {
        return;
      }

      replaceLevelMap(bookState.bids, normalizePolymarketLevels(event.bids));
      replaceLevelMap(bookState.asks, normalizePolymarketLevels(event.asks));
      bookState.tickSize = parseNumeric(event.tick_size) ?? bookState.tickSize;
      bookState.minOrderSize = parseNumeric(event.min_order_size) ?? bookState.minOrderSize;
      syncPolymarketTopOfBook(bookState);
      bookState.lastUpdatedAt = parseTimestamp(event.timestamp) ?? now;
      return;
    }

    if (eventType === "price_change") {
      const changes = Array.isArray(event.price_changes) ? event.price_changes : [event];

      for (const change of changes) {
        const tokenId = String(change.asset_id ?? change.assetId ?? event.asset_id ?? event.assetId ?? "");
        const bookState = this.books.get(tokenId);
        if (!bookState) {
          continue;
        }

        const side = String(change.side ?? event.side ?? "").toLowerCase();
        const price = change.price ?? change.level ?? change.changed_price ?? event.price ?? event.level ?? event.changed_price;
        const size = change.size ?? change.remaining_size ?? change.new_size ?? change.quantity ?? event.size ?? 0;
        if (side === "buy" || side === "bid") {
          applyLevelDelta(bookState.bids, price, size);
        } else if (side === "sell" || side === "ask") {
          applyLevelDelta(bookState.asks, price, size);
        }

        const bestBid = parseNumeric(change.best_bid ?? event.best_bid ?? event.bid);
        const bestAsk = parseNumeric(change.best_ask ?? event.best_ask ?? event.ask);
        if (bestBid !== null) {
          bookState.bestBidPrice = bestBid;
          bookState.bestBidSize = parseNumeric(change.bid_size ?? event.bid_size ?? size) ?? bookState.bestBidSize;
        }
        if (bestAsk !== null) {
          bookState.bestAskPrice = bestAsk;
          bookState.bestAskSize = parseNumeric(change.ask_size ?? event.ask_size ?? size) ?? bookState.bestAskSize;
        }
        if (bestBid === null || bestAsk === null) {
          syncPolymarketTopOfBook(bookState);
        }
        bookState.lastUpdatedAt = parseTimestamp(change.timestamp ?? event.timestamp) ?? now;
      }

      return;
    }

    if (eventType === "best_bid_ask") {
      const tokenId = String(event.asset_id ?? event.assetId ?? "");
      const bookState = this.books.get(tokenId);
      if (!bookState) {
        return;
      }

      const bid = parseNumeric(event.best_bid ?? event.bid);
      const ask = parseNumeric(event.best_ask ?? event.ask);
      if (bid !== null) {
        bookState.bestBidPrice = bid;
        bookState.bestBidSize =
          parseNumeric(event.bid_size ?? event.size) ?? bookState.bestBidSize ?? highestKnownSize(bookState.bids);
      }
      if (ask !== null) {
        bookState.bestAskPrice = ask;
        bookState.bestAskSize =
          parseNumeric(event.ask_size ?? event.size) ?? bookState.bestAskSize ?? highestKnownSize(bookState.asks);
      }
      bookState.lastUpdatedAt = parseTimestamp(event.timestamp) ?? now;
      return;
    }

    if (eventType === "last_trade_price") {
      const tokenId = String(event.asset_id ?? event.assetId ?? "");
      const bookState = this.books.get(tokenId);
      if (!bookState) {
        return;
      }

      bookState.lastTradePrice = parseNumeric(event.price);
      bookState.lastUpdatedAt = parseTimestamp(event.timestamp) ?? now;
    }
  }

  private async reset() {
    this.ws?.close();
    this.userWs?.close();
    this.stopMarketHeartbeat();
    this.stopUserHeartbeat();
    this.ws = null;
    this.userWs = null;
    this.market = null;
    this.tokenIds = null;
    this.books.clear();
    this.lastRestSyncAt = null;
    this.lastWsMessageAt = null;
    this.lastUserMessageAt = null;
    this.lastError = null;
    this.reconnectAttempt = 0;
    this.userReconnectAttempt = 0;
    this.subscriptions = emptySubscriptions(["market", "user"], "rest-bootstrap");
  }
}

class KalshiRealtimeFeed {
  private slotKey: string | null = null;
  private series: Awaited<ReturnType<typeof fetchKalshiSeries>>["series"] | null = null;
  private market: KalshiMarketSummary | null = null;
  private orderbook: KalshiBookState | null = null;
  private trades: KalshiTrade[] = [];
  private ws: WebSocket | null = null;
  private bootstrapPromise: Promise<void> | null = null;
  private resyncPromise: Promise<void> | null = null;
  private lastRestSyncAt: number | null = null;
  private lastWsMessageAt: number | null = null;
  private lastError: string | null = null;
  private reconnectAttempt = 0;
  private subscriptions = emptySubscriptions(["ticker", "orderbook_delta", "trade"], "rest-bootstrap");
  private nextSubscriptionId = 1;

  async ensureSlot(slot: MarketSlot, now = Date.now()) {
    if (this.slotKey !== slot.key) {
      await this.reset();
      this.slotKey = slot.key;
    }

    if (!this.market) {
      await this.bootstrap(slot, now);
    } else if (this.lastRestSyncAt === null || now - this.lastRestSyncAt >= KALSHI_RESYNC_MS) {
      void this.resync(now);
    }

    this.ensureWs();
  }

  buildState(slot: MarketSlot, now = Date.now()): LiveMarketState<KalshiQuote> {
    const lastMessageAt = [this.lastWsMessageAt, this.lastRestSyncAt].filter(Boolean).sort((a, b) => b! - a!)[0] ?? null;
    const feedHealth = buildFeedHealth({
      asset: slot.asset,
      venue: "kalshi",
      now,
      lastMessageAt,
      lastWsMessageAt: this.lastWsMessageAt,
      lastRestSyncAt: this.lastRestSyncAt,
      dataReady: Boolean(this.market && (this.orderbook || this.market)),
      details: [this.lastError ?? "Feed Kalshi actif"],
      subscriptions: this.subscriptions,
    });

    if (!this.market || !this.series) {
      return {
        venue: "kalshi",
        slotKey: slot.key,
        marketRef: null,
        quote: createBlockedKalshiQuote(slot, this.series, this.lastError ?? "Feed Kalshi indisponible"),
        lastBootstrapAt: this.lastRestSyncAt,
        lastSyncAt: this.lastRestSyncAt,
      };
    }

    const marketQuotes = deriveKalshiOutcomeQuotesFromMarketWithSource(
      this.market,
      this.subscriptions[0]?.lastMessageAt !== null ? "ws" : "rest-bootstrap",
      parseTimestamp(this.market.updated_time) ?? lastMessageAt,
    );
    const orderbookQuotes = this.orderbook
      ? deriveKalshiOutcomeQuotes(
          {
            yes_dollars: serializeLevelMap(this.orderbook.yes, "desc"),
            no_dollars: serializeLevelMap(this.orderbook.no, "desc"),
          },
          this.isLiveOrderbook(now) ? "ws" : "rest-fallback",
          this.orderbook.lastUpdatedAt,
        )
      : null;
    const activeQuotes = this.hasFreshOrderbook(now) ? orderbookQuotes ?? marketQuotes : marketQuotes;
    const tradePrices = extractKalshiLastTradePrices(
      this.trades,
      parseNumeric(this.market.last_price_dollars) ?? null,
    );

    const quote: KalshiQuote = {
      ref: {
        asset: slot.asset,
        venue: "kalshi",
        id: this.market.ticker,
        slotKey: slot.key,
        ticker: this.market.ticker,
        eventTicker: this.market.event_ticker,
        title: this.market.title,
        url: `https://kalshi.com/markets/${getMarketCatalogEntry(slot.asset).kalshiEventPath}/${this.market.event_ticker.toLowerCase()}`,
        startTime: this.market.open_time,
        endTime: this.market.close_time,
      },
      status: this.market.status,
      slotAligned: true,
      availabilityReason: null,
      feedHealth,
      lastMessageAt,
      stalenessMs: feedHealth.stalenessMs,
      source: feedHealth.source,
      outcomes: activeQuotes,
      feeMultiplier: this.series.fee_multiplier,
      feeType: this.series.fee_type,
      lastTradeYesPrice: tradePrices.yes,
      lastTradeNoPrice: tradePrices.no,
      resolution: null,
    };

    return {
      venue: "kalshi",
      slotKey: slot.key,
      marketRef: quote.ref.id,
      quote,
      lastBootstrapAt: this.lastRestSyncAt,
      lastSyncAt: lastMessageAt,
    };
  }

  private async bootstrap(slot: MarketSlot, now: number) {
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = (async () => {
        const [seriesResponse, marketsResponse] = await Promise.all([
          fetchKalshiSeries(slot.asset),
          fetchKalshiMarkets(slot.asset),
        ]);
        const market = resolveKalshiMarketForSlot(marketsResponse.markets, slot);
        if (!market) {
          throw new Error("Marché Kalshi du créneau courant indisponible");
        }

        const [freshMarketResponse, orderbook, tradesResponse] = await Promise.all([
          fetchKalshiMarket(market.ticker).catch(() => ({ market })),
          fetchKalshiOrderbook(market.ticker).catch(() => null),
          fetchKalshiTrades(market.ticker).catch(() => ({ trades: [] })),
        ]);

        this.series = seriesResponse.series;
        this.market = freshMarketResponse.market;
        this.orderbook = orderbook ? createKalshiBookState(orderbook, now) : null;
        this.trades = tradesResponse.trades ?? [];
        this.lastRestSyncAt = now;
        this.lastError = null;
      })()
        .catch((error) => {
          this.lastError = error instanceof Error ? error.message : "Bootstrap Kalshi impossible";
          throw error;
        })
        .finally(() => {
          this.bootstrapPromise = null;
        });
    }

    return this.bootstrapPromise;
  }

  private async resync(now: number) {
    if (!this.market || this.resyncPromise) {
      return this.resyncPromise;
    }

    this.resyncPromise = (async () => {
      try {
        const [freshMarketResponse, orderbook, tradesResponse] = await Promise.all([
          fetchKalshiMarket(this.market!.ticker).catch(() => null),
          fetchKalshiOrderbook(this.market!.ticker).catch(() => null),
          fetchKalshiTrades(this.market!.ticker).catch(() => ({ trades: [] })),
        ]);

        if (freshMarketResponse?.market) {
          this.market = freshMarketResponse.market;
        }
        if (orderbook) {
          this.orderbook = createKalshiBookState(orderbook, now);
        }
        this.trades = tradesResponse.trades ?? this.trades;
        this.lastRestSyncAt = now;
        this.lastError = null;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : "Resync Kalshi impossible";
      }
    })().finally(() => {
      this.resyncPromise = null;
    });

    return this.resyncPromise;
  }

  private ensureWs() {
    if (!this.market || this.ws || !hasKalshiCredentials()) {
      if (!hasKalshiCredentials()) {
        this.subscriptions[0] = toSubscriptionState(this.subscriptions[0], {
          status: "idle",
          source: "rest-fallback",
          details: "ticker websocket non actif sans credentials Kalshi",
        });
        this.subscriptions[1] = toSubscriptionState(this.subscriptions[1], {
          status: "idle",
          source: "rest-fallback",
          details: "orderbook via REST fallback",
        });
        this.subscriptions[2] = toSubscriptionState(this.subscriptions[2], {
          status: "idle",
          source: "rest-fallback",
          details: "trade tape via REST fallback",
        });
      }
      return;
    }

    const ws = new WebSocket(getKalshiWsUrl(), {
      headers: buildKalshiWsHeaders(),
    });
    this.ws = ws;
    for (let index = 0; index < this.subscriptions.length; index += 1) {
      this.subscriptions[index] = toSubscriptionState(this.subscriptions[index], {
        status: "connecting",
        source: "ws",
        details: "connexion websocket Kalshi",
      });
    }

    ws.on("open", () => {
      if (!this.market) {
        return;
      }

      this.reconnectAttempt = 0;
      this.subscribe(ws, "ticker", this.market.ticker);
      this.subscribe(ws, "trade", this.market.ticker);
      this.subscribe(ws, "orderbook_delta", this.market.ticker);
    });

    ws.on("message", (buffer: Buffer) => {
      const payload = safeJsonParse(buffer.toString());
      if (!payload) {
        return;
      }

      const nowTs = Date.now();
      this.applyWsPayload(payload, nowTs);
      this.lastWsMessageAt = nowTs;
    });

    ws.on("error", (error: unknown) => {
      this.lastError = error instanceof Error ? error.message : "Kalshi WS error";
      for (let index = 0; index < this.subscriptions.length; index += 1) {
        this.subscriptions[index] = toSubscriptionState(this.subscriptions[index], {
          status: "error",
          source: this.lastRestSyncAt === null ? "unavailable" : "rest-fallback",
          details: this.lastError,
        });
      }
    });

    ws.on("close", () => {
      this.ws = null;
      this.nextSubscriptionId = 1;
      for (let index = 0; index < this.subscriptions.length; index += 1) {
        this.subscriptions[index] = toSubscriptionState(this.subscriptions[index], {
          status: "closed",
          source: this.lastRestSyncAt === null ? "unavailable" : "rest-fallback",
          details:
            this.lastRestSyncAt === null
              ? "connexion fermee"
              : "connexion fermee, REST fallback conserve",
        });
      }
      const delay = nextReconnectDelay(this.reconnectAttempt++);
      setTimeout(() => {
        if (this.slotKey) {
          this.ensureWs();
        }
      }, delay);
    });
  }

  private applyWsPayload(payload: any, now: number) {
    const type = String(payload.type ?? payload.event_type ?? payload.cmd ?? "");
    const message = payload.msg ?? payload.message ?? payload.data ?? payload;

    if (type === "error") {
      const details = typeof message?.msg === "string" ? message.msg : JSON.stringify(message);
      this.lastError = `Kalshi WS error: ${details}`;
      return;
    }

    if (type === "subscribed") {
      const channel = String(message.channel ?? "");
      const index = this.subscriptions.findIndex((subscription) => subscription.channel === channel);
      if (index >= 0) {
        this.subscriptions[index] = toSubscriptionState(this.subscriptions[index], {
          status: "subscribed",
          source: "ws",
          lastMessageAt: now,
          details: `sid ${message.sid ?? "?"}`,
        });
      }
      return;
    }

    if (type === "ticker") {
      if (this.market) {
        const yesBid = String(message.yes_bid_dollars ?? message.yes_bid ?? this.market.yes_bid_dollars);
        const yesAsk = String(message.yes_ask_dollars ?? message.yes_ask ?? this.market.yes_ask_dollars);
        const derivedNoBid = deriveComplementPrice(yesAsk);
        const derivedNoAsk = deriveComplementPrice(yesBid);
        const updatedTime =
          parseTimestamp(message.updated_time ?? message.created_time ?? message.ts ?? message.timestamp) ?? now;
        this.market = {
          ...this.market,
          yes_bid_dollars: yesBid,
          yes_ask_dollars: yesAsk,
          no_bid_dollars: String(message.no_bid_dollars ?? message.no_bid ?? derivedNoBid ?? this.market.no_bid_dollars),
          no_ask_dollars: String(message.no_ask_dollars ?? message.no_ask ?? derivedNoAsk ?? this.market.no_ask_dollars),
          last_price_dollars: String(message.last_price_dollars ?? message.last_price ?? message.price_dollars ?? this.market.last_price_dollars ?? ""),
          yes_bid_size_fp: String(message.yes_bid_size_fp ?? this.market.yes_bid_size_fp),
          yes_ask_size_fp: String(message.yes_ask_size_fp ?? this.market.yes_ask_size_fp),
          no_bid_size_fp: String(message.no_bid_size_fp ?? message.yes_ask_size_fp ?? this.market.no_bid_size_fp),
          no_ask_size_fp: String(message.no_ask_size_fp ?? message.yes_bid_size_fp ?? this.market.no_ask_size_fp),
          updated_time: new Date(updatedTime).toISOString(),
        };
      }
      this.subscriptions[0] = toSubscriptionState(this.subscriptions[0], {
        status: "subscribed",
        source: "ws",
        lastMessageAt: now,
        details: "ticker live",
      });
      return;
    }

    if (type === "orderbook_snapshot") {
      const orderbook = normalizeKalshiWsOrderbook(message);
      if (orderbook) {
        this.orderbook = createKalshiBookState(orderbook, now);
      }
      this.subscriptions[1] = toSubscriptionState(this.subscriptions[1], {
        status: "subscribed",
        source: "ws",
        lastMessageAt: now,
        details: "orderbook snapshot live",
      });
      return;
    }

    if (type === "orderbook_delta") {
      this.applyKalshiDelta(message, now);
      this.subscriptions[1] = toSubscriptionState(this.subscriptions[1], {
        status: "subscribed",
        source: "ws",
        lastMessageAt: now,
        details: "orderbook delta live",
      });
      return;
    }

    if (type === "trade") {
      this.trades = [message as KalshiTrade, ...this.trades].slice(0, 20);
      this.subscriptions[2] = toSubscriptionState(this.subscriptions[2], {
        status: "subscribed",
        source: "ws",
        lastMessageAt: now,
        details: "trade live",
      });
    }
  }

  private applyKalshiDelta(message: any, now: number) {
    if (!this.orderbook) {
      const snapshot = normalizeKalshiWsOrderbook(message);
      if (snapshot) {
        this.orderbook = createKalshiBookState(snapshot, now);
      }
      return;
    }

    const nextSeq = parseNumeric(message.seq);
    if (nextSeq !== null && this.orderbook.seq !== null && nextSeq !== this.orderbook.seq + 1) {
      this.lastError = `Gap sequence Kalshi detecte: attendu ${this.orderbook.seq + 1}, recu ${nextSeq}`;
      void this.resync(now);
      return;
    }

    const side = String(message.side ?? message.book_side ?? "").toLowerCase();
    const price = message.price_dollars ?? message.price ?? message.level;
    const delta = parseNumeric(message.delta_fp ?? message.delta ?? message.size ?? message.count ?? message.quantity ?? message.remaining ?? 0) ?? 0;
    if (side === "yes") {
      applyKalshiDeltaLevel(this.orderbook.yes, price, delta);
    } else if (side === "no") {
      applyKalshiDeltaLevel(this.orderbook.no, price, delta);
    }

    this.orderbook.seq = nextSeq ?? this.orderbook.seq;
    this.orderbook.lastUpdatedAt = now;
  }

  private subscribe(ws: WebSocket, channel: string, marketTicker: string) {
    const params =
      channel === "ticker"
        ? {
            channels: [channel],
            market_ticker: marketTicker,
          }
        : {
            channels: [channel],
            market_tickers: [marketTicker],
          };

    ws.send(
      JSON.stringify({
        id: this.nextSubscriptionId++,
        cmd: "subscribe",
        params,
      }),
    );
  }

  private async reset() {
    this.ws?.close();
    this.ws = null;
    this.series = null;
    this.market = null;
    this.orderbook = null;
    this.trades = [];
    this.lastRestSyncAt = null;
    this.lastWsMessageAt = null;
    this.lastError = null;
    this.reconnectAttempt = 0;
    this.nextSubscriptionId = 1;
    this.subscriptions = emptySubscriptions(["ticker", "orderbook_delta", "trade"], "rest-bootstrap");
  }

  private isLiveOrderbook(now: number) {
    if (!this.orderbook) {
      return false;
    }

    const subscription = this.subscriptions[1];
    if (subscription.status !== "subscribed" || subscription.lastMessageAt === null) {
      return false;
    }

    return now - subscription.lastMessageAt <= FEED_BLOCKED_MS;
  }

  private hasFreshOrderbook(now: number) {
    if (!this.orderbook || this.orderbook.lastUpdatedAt === null) {
      return false;
    }

    if (this.isLiveOrderbook(now)) {
      return true;
    }

    return now - this.orderbook.lastUpdatedAt <= FEED_BLOCKED_MS;
  }
}

export class MarketDataSupervisor {
  private feeds: Record<
    MarketAsset,
    {
      polymarket: PolymarketRealtimeFeed;
      kalshi: KalshiRealtimeFeed;
    }
  > = {
    btc: {
      polymarket: new PolymarketRealtimeFeed(),
      kalshi: new KalshiRealtimeFeed(),
    },
    eth: {
      polymarket: new PolymarketRealtimeFeed(),
      kalshi: new KalshiRealtimeFeed(),
    },
  };

  async ensureSlot(slot: MarketSlot, now = Date.now()) {
    const feeds = this.feeds[slot.asset];
    await Promise.allSettled([
      feeds.polymarket.ensureSlot(slot, now),
      feeds.kalshi.ensureSlot(slot, now),
    ]);
  }

  async readSlotState(slot: MarketSlot, now = Date.now()) {
    await this.ensureSlot(slot, now);
    const feeds = this.feeds[slot.asset];
    const polymarket = feeds.polymarket.buildState(slot, now);
    const kalshi = feeds.kalshi.buildState(slot, now);
    return { polymarket, kalshi };
  }
}

let singleton: MarketDataSupervisor | null = null;

export function getMarketDataSupervisor() {
  if (!singleton) {
    singleton = new MarketDataSupervisor();
  }

  return singleton;
}

function createPolymarketBookState(
  tokenId: string,
  book: Awaited<ReturnType<typeof fetchPolymarketBook>>,
  now: number,
): PolymarketBookState {
  const state: PolymarketBookState = {
    tokenId,
    bids: new Map(),
    asks: new Map(),
    tickSize: parseNumeric(book.tick_size),
    minOrderSize: parseNumeric(book.min_order_size),
    bestBidPrice: null,
    bestBidSize: null,
    bestAskPrice: null,
    bestAskSize: null,
    lastTradePrice: null,
    lastUpdatedAt: now,
  };

  replaceLevelMap(state.bids, normalizePolymarketLevels(book.bids));
  replaceLevelMap(state.asks, normalizePolymarketLevels(book.asks));
  syncPolymarketTopOfBook(state);
  return state;
}

function normalizePolymarketLevels(levels: Array<{ price: string; size: string }> = []) {
  return levels
    .map((level) => [String(level.price), String(level.size)] as [string, string])
    .filter((level) => parseNumeric(level[0]) !== null && parseNumeric(level[1]) !== null);
}

function serializePolymarketBook(state: PolymarketBookState) {
  const bids = serializeLevelMap(state.bids, "desc")
    .filter(([price]) => state.bestBidPrice === null || Number(price) <= state.bestBidPrice + 1e-9)
    .filter(([price]) => state.bestBidPrice === null || Math.abs(Number(price) - state.bestBidPrice) > 1e-9);
  const asks = serializeLevelMap(state.asks, "asc")
    .filter(([price]) => state.bestAskPrice === null || Number(price) >= state.bestAskPrice - 1e-9)
    .filter(([price]) => state.bestAskPrice === null || Math.abs(Number(price) - state.bestAskPrice) > 1e-9);

  if (state.bestBidPrice !== null) {
    bids.unshift([
      String(round4(state.bestBidPrice)),
      String(state.bestBidSize ?? highestKnownSize(state.bids)),
    ]);
  }

  if (state.bestAskPrice !== null) {
    asks.unshift([
      String(round4(state.bestAskPrice)),
      String(state.bestAskSize ?? highestKnownSize(state.asks)),
    ]);
  }

  return {
    bids: bids.map(([price, size]) => ({ price, size })),
    asks: asks.map(([price, size]) => ({ price, size })),
    tick_size: state.tickSize === null ? undefined : String(state.tickSize),
    min_order_size: state.minOrderSize === null ? undefined : String(state.minOrderSize),
  };
}

function syncPolymarketTopOfBook(state: PolymarketBookState) {
  const bestBid = serializeLevelMap(state.bids, "desc")[0];
  const bestAsk = serializeLevelMap(state.asks, "asc")[0];

  state.bestBidPrice = bestBid ? Number(bestBid[0]) : null;
  state.bestBidSize = bestBid ? Number(bestBid[1]) : null;
  state.bestAskPrice = bestAsk ? Number(bestAsk[0]) : null;
  state.bestAskSize = bestAsk ? Number(bestAsk[1]) : null;
}

function highestKnownSize(levels: LevelMap) {
  const first = [...levels.values()].sort((left, right) => right - left)[0];
  return first ?? 0;
}

function createKalshiBookState(orderbook: KalshiOrderbook, now: number): KalshiBookState {
  const state: KalshiBookState = {
    yes: new Map(),
    no: new Map(),
    seq: parseNumeric(orderbook.seq),
    lastUpdatedAt: now,
  };

  replaceLevelMap(state.yes, orderbook.yes_dollars);
  replaceLevelMap(state.no, orderbook.no_dollars);
  return state;
}

function normalizeKalshiWsOrderbook(message: any): KalshiOrderbook | null {
  const candidates = [
    message.orderbook_fp,
    message.orderbook,
    message,
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const yes =
      candidate.yes_dollars_fp ??
      candidate.yes_dollars ??
      candidate.yes ??
      candidate.orderbook_yes ??
      candidate.yes_book;
    const no =
      candidate.no_dollars_fp ??
      candidate.no_dollars ??
      candidate.no ??
      candidate.orderbook_no ??
      candidate.no_book;

    if (Array.isArray(yes) && Array.isArray(no)) {
      return {
        yes_dollars: normalizeWsLevelPairs(yes),
        no_dollars: normalizeWsLevelPairs(no),
        seq: candidate.seq,
      };
    }
  }

  return null;
}

function normalizeWsLevelPairs(levels: Array<[string, string] | { price: string; size: string }>) {
  return levels
    .map((level) =>
      Array.isArray(level) ? [String(level[0]), String(level[1])] as [string, string] : [String(level.price), String(level.size)] as [string, string],
    )
    .filter((level) => parseNumeric(level[0]) !== null && parseNumeric(level[1]) !== null);
}

function createBlockedKalshiQuote(
  slot: MarketSlot,
  series: Awaited<ReturnType<typeof fetchKalshiSeries>>["series"] | null,
  reason: string,
): KalshiQuote {
  const feedHealth = buildFeedHealth({
    asset: slot.asset,
    venue: "kalshi",
    now: Date.now(),
    lastMessageAt: null,
    lastWsMessageAt: null,
    lastRestSyncAt: null,
    dataReady: false,
    details: [reason],
    subscriptions: emptySubscriptions(["ticker", "orderbook_delta", "trade"], "unavailable"),
  });

  const outcomes = deriveKalshiOutcomeQuotes(
    {
      yes_dollars: [],
      no_dollars: [],
    },
    "unavailable",
    null,
  );

  return {
    ref: {
      asset: slot.asset,
      venue: "kalshi",
      id: `${getMarketCatalogEntry(slot.asset).kalshiSeriesTicker}-${slot.key}`,
      slotKey: slot.key,
      title: series?.title ?? getMarketCatalogEntry(slot.asset).title,
      url: `https://kalshi.com/markets/${getMarketCatalogEntry(slot.asset).kalshiEventPath}`,
      startTime: slot.startIso,
      endTime: slot.endIso,
    },
    status: "pending",
    slotAligned: false,
    availabilityReason: reason,
    feedHealth,
    lastMessageAt: null,
    stalenessMs: null,
    source: "unavailable",
    outcomes,
    feeMultiplier: series?.fee_multiplier ?? 0,
    feeType: series?.fee_type ?? "unknown",
    lastTradeYesPrice: null,
    lastTradeNoPrice: null,
    resolution: null,
  };
}

function buildKalshiWsHeaders() {
  const env = readEnv();
  const timestamp = Date.now().toString();
  const privateKey = readSecretValue({
    inline: env.KALSHI_PRIVATE_KEY_PEM,
    path: env.KALSHI_PRIVATE_KEY_PATH,
    label: "KALSHI_PRIVATE_KEY",
  });
  const signature = signKalshiWsRequest(privateKey, timestamp);
  return {
    "Content-Type": "application/json",
    "KALSHI-ACCESS-KEY": env.KALSHI_API_KEY_ID!,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
  };
}

function signKalshiWsRequest(privateKeyPem: string, timestamp: string) {
  const message = `${timestamp}GET/trade-api/ws/v2`;
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(message);
  signer.end();

  return signer
    .sign({
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString("base64");
}

function safeJsonParse(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function applyKalshiDeltaLevel(levels: LevelMap, price: string | number, deltaFp: number) {
  const normalizedPrice = String(price);
  const current = levels.get(normalizedPrice) ?? 0;
  const next = round4(current + deltaFp);

  if (!Number.isFinite(next) || next <= 0) {
    levels.delete(normalizedPrice);
    return;
  }

  levels.set(normalizedPrice, next);
}

function deriveComplementPrice(value: string | number | null) {
  const numeric = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return round4(1 - numeric);
}
