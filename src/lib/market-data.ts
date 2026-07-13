import WebSocket from "ws";

import {
  POLY_MARKET_WS_BASE,
  POLY_RTDS_WS_BASE,
  POLY_USER_WS_BASE,
} from "@/lib/constants";
import { hasKalshiCredentials, hasPolymarketCredentials, readEnv, readSecretValue } from "@/lib/env";
import { getMarketCatalogEntry, MARKET_ASSETS } from "@/lib/market-catalog";
import {
  deriveKalshiOutcomeQuotes,
  deriveKalshiOutcomeQuotesFromMarket,
  deriveKalshiOutcomeQuotesFromMarketWithSource,
  extractKalshiLastTradePrices,
  fetchKalshiMarket,
  fetchKalshiMarketsForSlot,
  fetchKalshiOrderbook,
  fetchKalshiSeries,
  fetchKalshiTrades,
  getKalshiWsUrl,
  normalizeKalshiNumericOrderbookLevels,
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
  fetchPolymarketClobMarketInfo,
  fetchPolymarketMarket,
  type PolymarketClobMarketInfo,
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
const FEED_HEALTHY_REVALIDATE_MS = 60_000;
const POLYMARKET_REST_FALLBACK_RESYNC_MS = 4_000;
const KALSHI_REST_FALLBACK_RESYNC_MS = 4_000;
const POLYMARKET_WS_HEARTBEAT_MS = 3_000;
const POLYMARKET_RTDS_HEARTBEAT_MS = 5_000;
const KALSHI_REST_BACKOFF_INITIAL_MS = 10_000;
const KALSHI_REST_BACKOFF_MAX_MS = 60_000;
// Capture the best slot-open proxy during the first 30s, then wait longer before entry
// so the mismatch guard evaluates against a settled reference instead of the boundary tick.
const SLOT_OPEN_CAPTURE_WINDOW_MS = 30_000;
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

export function shouldRestResync(
  lastRestSyncAt: number | null,
  lastWsMessageAt: number | null,
  now: number,
  fallbackIntervalMs: number,
  healthyIntervalMs = FEED_HEALTHY_REVALIDATE_MS,
) {
  if (lastRestSyncAt === null) {
    return true;
  }

  const wsHealthy = lastWsMessageAt !== null && now - lastWsMessageAt <= FEED_READY_MS;
  const targetIntervalMs = wsHealthy ? healthyIntervalMs : fallbackIntervalMs;
  return now - lastRestSyncAt >= targetIntervalMs;
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

function hasKalshiCredentialsSafe() {
  try {
    return hasKalshiCredentials();
  } catch {
    return false;
  }
}

class PolymarketRealtimeFeed {
  private slotKey: string | null = null;
  private slotStartTs: number | null = null;
  private market: PolymarketMarketRecord | null = null;
  private clobMarketInfo: PolymarketClobMarketInfo | null = null;
  private tokenIds: { up: string; down: string } | null = null;
  private books = new Map<string, PolymarketBookState>();
  private ws: WebSocket | null = null;
  private userWs: WebSocket | null = null;
  private priceWs: WebSocket | null = null;
  private wsHeartbeat: ReturnType<typeof setInterval> | null = null;
  private userWsHeartbeat: ReturnType<typeof setInterval> | null = null;
  private priceWsHeartbeat: ReturnType<typeof setInterval> | null = null;
  private priceReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private bootstrapPromise: Promise<void> | null = null;
  private resyncPromise: Promise<void> | null = null;
  private lastRestSyncAt: number | null = null;
  private lastWsMessageAt: number | null = null;
  private lastUserMessageAt: number | null = null;
  private lastPriceMessageAt: number | null = null;
  private lastError: string | null = null;
  private lastChainlinkError: string | null = null;
  private chainlinkLivePriceUsd: number | null = null;
  private chainlinkLivePriceCapturedAt: number | null = null;
  private observedSlotOpenPriceUsd: number | null = null;
  private observedSlotOpenCapturedAt: number | null = null;
  private reconnectAttempt = 0;
  private priceReconnectAttempt = 0;
  private userReconnectAttempt = 0;
  private subscriptions = emptySubscriptions(["market", "user", "chainlink_price"], "rest-bootstrap");

  async ensureSlot(slot: MarketSlot, now = Date.now()) {
    if (this.slotKey !== slot.key) {
      await this.reset();
      this.slotKey = slot.key;
    }
    this.slotStartTs = slot.startTs;

    if (!this.market || !this.tokenIds) {
      await this.bootstrap(slot, now);
    } else if (
      shouldRestResync(
        this.lastRestSyncAt,
        this.lastWsMessageAt,
        now,
        POLYMARKET_REST_FALLBACK_RESYNC_MS,
      )
    ) {
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
        this.chainlinkLivePriceUsd === null
          ? this.lastChainlinkError ?? "flux Chainlink live indisponible"
          : `Chainlink live ${this.chainlinkLivePriceUsd.toFixed(4)} USD`,
      ],
      subscriptions: this.subscriptions,
    });

    const upBookSnapshot = upBook ? serializePolymarketBook(upBook) : null;
    const downBookSnapshot = downBook ? serializePolymarketBook(downBook) : null;
    const upOutcome =
      upBook
        ? buildPolymarketOutcomeQuoteFromBook(
            "UP",
            upBookSnapshot!,
            feedHealth.source,
            upBook.lastUpdatedAt,
            upBook.lastTradePrice,
            this.clobMarketInfo,
          )
        : createUnavailablePolymarketQuote(slot, "Orderbook Polymarket indisponible").outcomes.up;
    const downOutcome =
      downBook
        ? buildPolymarketOutcomeQuoteFromBook(
            "DOWN",
            downBookSnapshot!,
            feedHealth.source,
            downBook.lastUpdatedAt,
            downBook.lastTradePrice,
            this.clobMarketInfo,
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
      orderbookLevels: buildPolymarketOrderbookLevels(upBookSnapshot, downBookSnapshot),
      chainlinkLivePriceUsd: this.chainlinkLivePriceUsd,
      chainlinkLivePriceCapturedAt: this.chainlinkLivePriceCapturedAt,
      observedSlotOpenPriceUsd: this.observedSlotOpenPriceUsd,
      observedSlotOpenCapturedAt: this.observedSlotOpenCapturedAt,
      feeRateBps: Math.max(upOutcome.feeRateBps ?? 0, downOutcome.feeRateBps ?? 0),
      negRisk: Boolean(this.clobMarketInfo?.nr ?? false),
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
        const conditionId = market.conditionId ?? market.id;
        const [clobMarketInfo, upBook, downBook] = await Promise.all([
          fetchPolymarketClobMarketInfo(conditionId).catch(() => null),
          fetchPolymarketBook(tokenIds.up),
          fetchPolymarketBook(tokenIds.down),
        ]);

        this.market = market;
        this.clobMarketInfo = clobMarketInfo;
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
    const market = this.market;
    const tokenIds = this.tokenIds;

    this.resyncPromise = (async () => {
      try {
        const conditionId = market.conditionId ?? market.id;
        const [clobMarketInfo, upBook, downBook] = await Promise.all([
          fetchPolymarketClobMarketInfo(conditionId).catch(() => this.clobMarketInfo),
          fetchPolymarketBook(tokenIds.up),
          fetchPolymarketBook(tokenIds.down),
        ]);
        this.clobMarketInfo = clobMarketInfo;
        this.books.set(tokenIds.up, createPolymarketBookState(tokenIds.up, upBook, now));
        this.books.set(tokenIds.down, createPolymarketBookState(tokenIds.down, downBook, now));
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
    if (!this.tokenIds) {
      return;
    }

    if (!this.ws) {
      this.connectMarketWs(now);
    }
    if (!this.priceWs) {
      this.connectPriceWs();
    }
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

  private connectPriceWs() {
    const chainlinkSymbol = getMarketCatalogEntry(this.marketAsset()).polymarketChainlinkSymbol;
    this.subscriptions[2] = toSubscriptionState(this.subscriptions[2], {
      status: "connecting",
      source: "ws",
      details: `connexion flux Chainlink ${chainlinkSymbol}`,
    });

    const ws = new WebSocket(POLY_RTDS_WS_BASE);
    this.priceWs = ws;

    ws.on("open", () => {
      this.clearPriceReconnectTimer();
      this.priceReconnectAttempt = 0;
      this.startPriceHeartbeat(ws);
      this.subscriptions[2] = toSubscriptionState(this.subscriptions[2], {
        status: "subscribed",
        source: "ws",
        details: `flux Chainlink ${chainlinkSymbol} actif`,
      });
      ws.send(
        JSON.stringify({
          action: "subscribe",
          subscriptions: [
            {
              topic: "crypto_prices_chainlink",
              type: "*",
              filters: JSON.stringify({ symbol: chainlinkSymbol }),
            },
          ],
        }),
      );
    });

    ws.on("message", (buffer: Buffer) => {
      const raw = buffer.toString();
      const nowTs = Date.now();
      if (raw === "PONG") {
        this.lastPriceMessageAt = nowTs;
        this.subscriptions[2] = toSubscriptionState(this.subscriptions[2], {
          status: "subscribed",
          source: "ws",
          lastMessageAt: nowTs,
          details: `flux Chainlink ${chainlinkSymbol} actif`,
        });
        return;
      }

      const payload = safeJsonParse(raw);
      if (!payload) {
        return;
      }

      const events = Array.isArray(payload) ? payload : [payload];
      for (const event of events) {
        this.applyPriceEvent(event, nowTs);
      }
    });

    ws.on("error", (error: unknown) => {
      this.stopPriceHeartbeat();
      this.lastChainlinkError = error instanceof Error ? error.message : "Polymarket RTDS Chainlink error";
      this.subscriptions[2] = toSubscriptionState(this.subscriptions[2], {
        status: "error",
        source: "ws",
        details: this.lastChainlinkError,
      });
      if (this.priceWs === ws) {
        this.priceWs = null;
      }
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {
        // Ignore teardown failures while scheduling the reconnect.
      }
      this.schedulePriceReconnect();
    });

    ws.on("close", () => {
      this.stopPriceHeartbeat();
      if (this.priceWs === ws) {
        this.priceWs = null;
      }
      this.subscriptions[2] = toSubscriptionState(this.subscriptions[2], {
        status: "closed",
        source: this.lastPriceMessageAt === null ? "unavailable" : "ws",
        details: "flux Chainlink ferme, retry programme",
      });
      this.schedulePriceReconnect();
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

  private startPriceHeartbeat(ws: WebSocket) {
    this.stopPriceHeartbeat();
    this.priceWsHeartbeat = setInterval(() => {
      if (this.priceWs !== ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      ws.send("PING");
    }, POLYMARKET_RTDS_HEARTBEAT_MS);
  }

  private stopPriceHeartbeat() {
    if (this.priceWsHeartbeat) {
      clearInterval(this.priceWsHeartbeat);
      this.priceWsHeartbeat = null;
    }
  }

  private clearPriceReconnectTimer() {
    if (this.priceReconnectTimer) {
      clearTimeout(this.priceReconnectTimer);
      this.priceReconnectTimer = null;
    }
  }

  private schedulePriceReconnect() {
    if (this.priceReconnectTimer || !this.slotKey) {
      return;
    }

    const delay = nextReconnectDelay(this.priceReconnectAttempt++);
    this.priceReconnectTimer = setTimeout(() => {
      this.priceReconnectTimer = null;
      if (this.slotKey && !this.priceWs) {
        this.connectPriceWs();
      }
    }, delay);
  }

  private applyPriceEvent(event: any, now: number) {
    const payload = event?.payload ?? event;
    const symbol = String(payload?.symbol ?? "").toLowerCase();
    const expectedSymbol = getMarketCatalogEntry(this.marketAsset()).polymarketChainlinkSymbol.toLowerCase();
    if (symbol !== expectedSymbol) {
      return;
    }

    const price = parseNumeric(payload?.value);
    if (price === null) {
      return;
    }

    const priceTs = parseTimestamp(payload?.timestamp) ?? now;
    this.chainlinkLivePriceUsd = price;
    this.chainlinkLivePriceCapturedAt = priceTs;
    this.lastPriceMessageAt = now;
    this.lastChainlinkError = null;
    this.captureObservedSlotOpenPrice(price, priceTs);
    this.subscriptions[2] = toSubscriptionState(this.subscriptions[2], {
      status: "subscribed",
      source: "ws",
      lastMessageAt: now,
      details: `Chainlink ${symbol} ${price.toFixed(4)}`,
    });
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

  private captureObservedSlotOpenPrice(price: number, priceTs: number) {
    if (this.slotStartTs === null) {
      return;
    }

    if (priceTs < this.slotStartTs || priceTs > this.slotStartTs + SLOT_OPEN_CAPTURE_WINDOW_MS) {
      return;
    }

    if (this.observedSlotOpenCapturedAt !== null) {
      const existingDistance = Math.abs(this.observedSlotOpenCapturedAt - this.slotStartTs);
      const nextDistance = Math.abs(priceTs - this.slotStartTs);
      if (nextDistance > existingDistance) {
        return;
      }
      if (nextDistance === existingDistance && priceTs >= this.observedSlotOpenCapturedAt) {
        return;
      }
    }

    this.observedSlotOpenPriceUsd = price;
    this.observedSlotOpenCapturedAt = priceTs;
  }

  private marketAsset(): MarketAsset {
    if (!this.slotKey) {
      return "btc";
    }

    return this.slotKey.split(":")[0] as MarketAsset;
  }

  private async reset() {
    this.ws?.close();
    this.userWs?.close();
    this.priceWs?.close();
    this.stopMarketHeartbeat();
    this.stopUserHeartbeat();
    this.stopPriceHeartbeat();
    this.clearPriceReconnectTimer();
    this.ws = null;
    this.userWs = null;
    this.priceWs = null;
    this.slotStartTs = null;
    this.market = null;
    this.clobMarketInfo = null;
    this.tokenIds = null;
    this.books.clear();
    this.lastRestSyncAt = null;
    this.lastWsMessageAt = null;
    this.lastUserMessageAt = null;
    this.lastPriceMessageAt = null;
    this.lastError = null;
    this.lastChainlinkError = null;
    this.chainlinkLivePriceUsd = null;
    this.chainlinkLivePriceCapturedAt = null;
    this.observedSlotOpenPriceUsd = null;
    this.observedSlotOpenCapturedAt = null;
    this.reconnectAttempt = 0;
    this.priceReconnectAttempt = 0;
    this.userReconnectAttempt = 0;
    this.subscriptions = emptySubscriptions(["market", "user", "chainlink_price"], "rest-bootstrap");
  }
}

class KalshiRealtimeFeed {
  private slotKey: string | null = null;
  private seriesCache: { series: Awaited<ReturnType<typeof fetchKalshiSeries>>["series"]; capturedAt: number } | null =
    null;
  private marketsCache: { markets: KalshiMarketSummary[]; capturedAt: number } | null = null;
  private series: Awaited<ReturnType<typeof fetchKalshiSeries>>["series"] | null = null;
  private market: KalshiMarketSummary | null = null;
  private orderbook: KalshiBookState | null = null;
  private orderbookInSync = true;
  private trades: KalshiTrade[] = [];
  private ws: WebSocket | null = null;
  private bootstrapPromise: Promise<void> | null = null;
  private resyncPromise: Promise<void> | null = null;
  private lastRestSyncAt: number | null = null;
  private lastWsMessageAt: number | null = null;
  private lastError: string | null = null;
  private bootstrapBackoffUntil: number | null = null;
  private bootstrapBackoffMs = KALSHI_REST_BACKOFF_INITIAL_MS;
  private resyncBackoffUntil: number | null = null;
  private resyncBackoffMs = KALSHI_REST_BACKOFF_INITIAL_MS;
  private reconnectAttempt = 0;
  private subscriptions = emptySubscriptions(["ticker", "orderbook_delta", "trade"], "rest-bootstrap");
  private nextSubscriptionId = 1;

  async ensureSlot(slot: MarketSlot, now = Date.now()) {
    if (this.slotKey !== slot.key) {
      await this.reset();
      this.slotKey = slot.key;
    }

    if (!this.market) {
      if (this.isRestBackoffActive("bootstrap", now)) {
        return;
      }
      await this.bootstrap(slot, now);
    } else if (
      shouldRestResync(
        this.lastRestSyncAt,
        this.lastWsMessageAt,
        now,
        KALSHI_REST_FALLBACK_RESYNC_MS,
      ) &&
      !this.isRestBackoffActive("resync", now)
    ) {
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
      dataReady: Boolean(this.market && this.series && this.orderbookInSync),
      details: this.describeFeedDetails(now),
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
      this.resolveTickerQuoteSource(now),
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
    const orderbookLevels = this.orderbook
      ? normalizeKalshiNumericOrderbookLevels({
          yes_dollars: serializeLevelMap(this.orderbook.yes, "desc"),
          no_dollars: serializeLevelMap(this.orderbook.no, "desc"),
        })
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
      targetPriceUsd: parseNumeric(this.market.floor_strike),
      feeMultiplier: this.series.fee_multiplier,
      feeType: this.series.fee_type,
      lastTradeYesPrice: tradePrices.yes,
      lastTradeNoPrice: tradePrices.no,
      orderbookLevels,
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
          this.readSeriesForBootstrap(slot.asset, now),
          this.readMarketsForBootstrap(slot, now),
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
        this.orderbookInSync = true;
        this.trades = tradesResponse.trades ?? [];
        this.lastRestSyncAt = now;
        this.lastError = null;
        this.resetRestBackoff("bootstrap");
        this.resetRestBackoff("resync");
      })()
        .catch((error) => {
          this.markRestFailure("bootstrap", error, now);
          throw error;
        })
        .finally(() => {
          this.bootstrapPromise = null;
        });
    }

    return this.bootstrapPromise;
  }

  private async resync(now: number) {
    if (!this.market || this.resyncPromise || this.isRestBackoffActive("resync", now)) {
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
        this.orderbookInSync = true;
        this.trades = tradesResponse.trades ?? this.trades;
        this.lastRestSyncAt = now;
        this.lastError = null;
        this.resetRestBackoff("resync");
      } catch (error) {
        this.markRestFailure("resync", error, now);
      }
    })().finally(() => {
      this.resyncPromise = null;
    });

    return this.resyncPromise;
  }

  private async readSeriesForBootstrap(asset: MarketAsset, now: number) {
    if (this.seriesCache) {
      return { series: this.seriesCache.series };
    }

    const response = await fetchKalshiSeries(asset);
    this.seriesCache = {
      series: response.series,
      capturedAt: now,
    };
    return response;
  }

  private async readMarketsForBootstrap(slot: MarketSlot, now: number) {
    if (this.marketsCache && resolveKalshiMarketForSlot(this.marketsCache.markets, slot)) {
      return { markets: this.marketsCache.markets };
    }

    const response = await fetchKalshiMarketsForSlot(slot);
    this.marketsCache = {
      markets: response.markets,
      capturedAt: now,
    };
    return response;
  }

  private isRestBackoffActive(kind: "bootstrap" | "resync", now: number) {
    const backoffUntil = kind === "bootstrap" ? this.bootstrapBackoffUntil : this.resyncBackoffUntil;
    if (backoffUntil === null || now >= backoffUntil) {
      return false;
    }

    const retryInMs = Math.max(0, backoffUntil - now);
    this.lastError = `Kalshi REST ${kind} throttled after previous failure; retry in ${retryInMs}ms`;
    return true;
  }

  private markRestFailure(kind: "bootstrap" | "resync", error: unknown, now: number) {
    const message = error instanceof Error ? error.message : `${kind} Kalshi impossible`;
    const backoffMs = kind === "bootstrap" ? this.bootstrapBackoffMs : this.resyncBackoffMs;
    this.lastError = `${message}; retrying Kalshi REST ${kind} after ${backoffMs}ms`;

    if (kind === "bootstrap") {
      this.bootstrapBackoffUntil = now + backoffMs;
      this.bootstrapBackoffMs = Math.min(KALSHI_REST_BACKOFF_MAX_MS, this.bootstrapBackoffMs * 2);
      return;
    }

    this.resyncBackoffUntil = now + backoffMs;
    this.resyncBackoffMs = Math.min(KALSHI_REST_BACKOFF_MAX_MS, this.resyncBackoffMs * 2);
  }

  private resetRestBackoff(kind: "bootstrap" | "resync") {
    if (kind === "bootstrap") {
      this.bootstrapBackoffUntil = null;
      this.bootstrapBackoffMs = KALSHI_REST_BACKOFF_INITIAL_MS;
      return;
    }

    this.resyncBackoffUntil = null;
    this.resyncBackoffMs = KALSHI_REST_BACKOFF_INITIAL_MS;
  }

  private ensureWs() {
    const hasCredentials = hasKalshiCredentialsSafe();
    if (!this.market || this.ws || !hasCredentials) {
      if (!hasCredentials) {
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
      return false;
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
      return false;
    }

    if (type === "ticker") {
      if (this.market) {
        const yesBidMessage = message.yes_bid_dollars ?? message.yes_bid;
        const yesAskMessage = message.yes_ask_dollars ?? message.yes_ask;
        const noBidMessage = message.no_bid_dollars ?? message.no_bid;
        const noAskMessage = message.no_ask_dollars ?? message.no_ask;
        const hasFreshYesSide = yesBidMessage !== undefined || yesAskMessage !== undefined;
        const hasFreshNoSide = noBidMessage !== undefined || noAskMessage !== undefined;
        const yesBid = String(
          hasFreshNoSide && !hasFreshYesSide
            ? deriveComplementPrice(noAskMessage ?? this.market.no_ask_dollars) ?? this.market.yes_bid_dollars
            : yesBidMessage ?? this.market.yes_bid_dollars,
        );
        const yesAsk = String(
          hasFreshNoSide && !hasFreshYesSide
            ? deriveComplementPrice(noBidMessage ?? this.market.no_bid_dollars) ?? this.market.yes_ask_dollars
            : yesAskMessage ?? this.market.yes_ask_dollars,
        );
        const derivedNoBid = deriveComplementPrice(yesAsk);
        const derivedNoAsk = deriveComplementPrice(yesBid);
        const noBid = String(hasFreshYesSide ? derivedNoBid ?? this.market.no_bid_dollars : noBidMessage ?? this.market.no_bid_dollars);
        const noAsk = String(hasFreshYesSide ? derivedNoAsk ?? this.market.no_ask_dollars : noAskMessage ?? this.market.no_ask_dollars);
        const updatedTime =
          parseTimestamp(message.updated_time ?? message.created_time ?? message.ts ?? message.timestamp) ?? now;
        this.market = {
          ...this.market,
          yes_bid_dollars: yesBid,
          yes_ask_dollars: yesAsk,
          no_bid_dollars: noBid,
          no_ask_dollars: noAsk,
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
      this.lastWsMessageAt = now;
      this.lastError = null;
      return true;
    }

    if (type === "orderbook_snapshot") {
      const orderbook = normalizeKalshiWsOrderbook(message);
      if (orderbook) {
        this.orderbook = createKalshiBookState(orderbook, now);
        this.orderbookInSync = true;
      }
      this.subscriptions[1] = toSubscriptionState(this.subscriptions[1], {
        status: "subscribed",
        source: "ws",
        lastMessageAt: now,
        details: "orderbook snapshot live",
      });
      if (orderbook) {
        this.lastWsMessageAt = now;
      }
      this.lastError = null;
      return orderbook !== null;
    }

    if (type === "orderbook_delta") {
      this.applyKalshiDelta(message, now);
      this.subscriptions[1] = toSubscriptionState(this.subscriptions[1], {
        status: "subscribed",
        source: "ws",
        lastMessageAt: now,
        details: "orderbook delta live",
      });
      this.lastWsMessageAt = now;
      return true;
    }

    if (type === "trade") {
      this.trades = [message as KalshiTrade, ...this.trades].slice(0, 20);
      this.subscriptions[2] = toSubscriptionState(this.subscriptions[2], {
        status: "subscribed",
        source: "ws",
        lastMessageAt: now,
        details: "trade live",
      });
      this.lastWsMessageAt = now;
      this.lastError = null;
      return true;
    }

    return false;
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
      this.orderbookInSync = false;
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
    this.orderbookInSync = true;
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
    this.orderbookInSync = true;
    this.trades = [];
    this.lastRestSyncAt = null;
    this.lastWsMessageAt = null;
    this.lastError = null;
    this.reconnectAttempt = 0;
    this.nextSubscriptionId = 1;
    this.subscriptions = emptySubscriptions(["ticker", "orderbook_delta", "trade"], "rest-bootstrap");
  }

  private isLiveOrderbook(now: number) {
    if (!this.orderbook || !this.orderbookInSync) {
      return false;
    }

    const subscription = this.subscriptions[1];
    if (subscription.status !== "subscribed" || subscription.lastMessageAt === null) {
      return false;
    }

    return now - subscription.lastMessageAt <= FEED_BLOCKED_MS;
  }

  private hasFreshOrderbook(now: number) {
    if (!this.orderbook || !this.orderbookInSync || this.orderbook.lastUpdatedAt === null) {
      return false;
    }

    if (this.isLiveOrderbook(now)) {
      return true;
    }

    return now - this.orderbook.lastUpdatedAt <= FEED_BLOCKED_MS;
  }

  private resolveTickerQuoteSource(now: number) {
    const tickerLastMessageAt = this.subscriptions[0]?.lastMessageAt ?? null;
    return chooseFeedSource(tickerLastMessageAt, this.lastRestSyncAt, now);
  }

  private describeFeedDetails(now: number) {
    const details: string[] = [];
    if (this.lastError) {
      details.push(this.lastError);
    } else if (!this.market) {
      details.push("Kalshi REST bootstrap en attente du ticker courant");
    } else if (!hasKalshiCredentialsSafe()) {
      details.push("Kalshi WS inactif sans credentials; REST fallback uniquement");
    } else if (this.ws && this.lastWsMessageAt === null) {
      details.push("Kalshi WS connecte, en attente du premier payload de donnees");
    } else if (this.lastWsMessageAt === null) {
      details.push("Kalshi WS pas encore actif; REST bootstrap utilise");
    } else if (!this.orderbookInSync) {
      details.push("Resync orderbook Kalshi en cours");
    } else {
      const stalenessMs = Math.max(0, now - this.lastWsMessageAt);
      details.push(stalenessMs <= FEED_BLOCKED_MS ? "Kalshi WS actif" : "Kalshi WS stale; REST fallback conserve");
    }

    for (const subscription of this.subscriptions) {
      const age =
        subscription.lastMessageAt === null ? "no-data" : `${Math.max(0, now - subscription.lastMessageAt)}ms`;
      details.push(`${subscription.channel}: ${subscription.status} · ${subscription.source} · ${age} · ${subscription.details ?? "--"}`);
    }

    return details;
  }
}

export class MarketDataSupervisor {
  private feeds: Record<
    MarketAsset,
    {
      polymarket: PolymarketRealtimeFeed;
      kalshi: KalshiRealtimeFeed;
    }
  > = Object.fromEntries(
    MARKET_ASSETS.map((asset) => [
      asset,
      {
        polymarket: new PolymarketRealtimeFeed(),
        kalshi: new KalshiRealtimeFeed(),
      },
    ]),
  ) as Record<MarketAsset, { polymarket: PolymarketRealtimeFeed; kalshi: KalshiRealtimeFeed }>;

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

function buildPolymarketOrderbookLevels(
  upBook: ReturnType<typeof serializePolymarketBook> | null,
  downBook: ReturnType<typeof serializePolymarketBook> | null,
): PolymarketQuote["orderbookLevels"] {
  if (!upBook || !downBook) {
    return null;
  }

  return {
    upBids: toNumericBookLevels(upBook.bids),
    upAsks: toNumericBookLevels(upBook.asks),
    downBids: toNumericBookLevels(downBook.bids),
    downAsks: toNumericBookLevels(downBook.asks),
  };
}

function toNumericBookLevels(levels: Array<{ price: string; size: string }>) {
  return levels
    .slice(0, 10)
    .map((level) => [Number(level.price), Number(level.size)] as [number, number])
    .filter(([price, size]) => Number.isFinite(price) && Number.isFinite(size) && size > 0);
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
    targetPriceUsd: null,
    feeMultiplier: series?.fee_multiplier ?? 0,
    feeType: series?.fee_type ?? "unknown",
    lastTradeYesPrice: null,
    lastTradeNoPrice: null,
    orderbookLevels: null,
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
