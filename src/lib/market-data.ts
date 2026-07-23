import crypto from "node:crypto";
import WebSocket from "ws";

import { POLY_MARKET_WS_BASE, POLY_RTDS_WS_BASE, POLY_USER_WS_BASE } from "@/lib/constants";
import { hasKalshiCredentials, hasPolymarketCredentials, readEnv, readSecretValue } from "@/lib/env";
import { getMarketCatalogEntry, MARKET_ASSETS } from "@/lib/market-catalog";
import { normalizePolymarketTradeStatus } from "@/lib/polymarket-trade-status";
import {
  deriveKalshiOutcomeQuotes,
  deriveKalshiOutcomeQuotesFromMarketWithSource,
  extractKalshiLastTradePrices,
  fetchKalshiMarket,
  fetchKalshiMarketsForSlot,
  fetchKalshiOrderbook,
  fetchKalshiSeries,
  fetchKalshiTrades,
  getKalshiWsUrls,
  normalizeKalshiMarketPriceRanges,
  normalizeKalshiNumericOrderbookLevels,
  resolveKalshiMarketForSlot,
  type KalshiMarketSummary,
  type KalshiOrderbook,
  type KalshiTrade,
} from "@/lib/kalshi";
import {
  buildCanonicalPolymarketMarketRef,
  buildPolymarketOutcomeQuoteFromBook,
  createUnavailablePolymarketQuote,
  derivePolymarketFeeMetadata,
  derivePolymarketOutcomeTokens,
  extractPolymarketResolution,
  fetchPolymarketBook,
  fetchPolymarketClobMarketInfo,
  fetchPolymarketMarket,
  type PolymarketClobMarketInfo,
} from "@/lib/polymarket";
import type {
  FeedSource,
  KalshiCfBenchmarkIndexId,
  KalshiCfBenchmarkState,
  KalshiCfBenchmarkWindow,
  KalshiQuote,
  LiveMarketState,
  MarketAsset,
  MarketSlot,
  OrderSide,
  PolymarketQuote,
  ReadRecentOrderFillsRequest,
  ReadinessStatus,
  RealtimeOrderFill,
  Resolution,
  VenueFeedHealth,
  VenueSubscriptionState,
  WaitForOrderFillRequest,
} from "@/lib/types";

const FEED_READY_MS = 4_000;
const FEED_BLOCKED_MS = 10_000;
const FEED_HEALTHY_REVALIDATE_MS = 60_000;
const POLYMARKET_REST_FALLBACK_RESYNC_MS = 4_000;
const KALSHI_REST_FALLBACK_RESYNC_MS = 4_000;
const KALSHI_MISSING_STRIKE_RESYNC_MS = 4_000;
const POLYMARKET_WS_HEARTBEAT_MS = 3_000;
const POLYMARKET_RTDS_HEARTBEAT_MS = 5_000;
export const POLYMARKET_CHAINLINK_SILENCE_TIMEOUT_MS = 15_000;
const KALSHI_WS_HEARTBEAT_MS = 5_000;
const KALSHI_WS_HEARTBEAT_TIMEOUT_MS = 20_000;
const KALSHI_WS_BOOTSTRAP_TIMEOUT_MS = 5_000;
const KALSHI_REST_BACKOFF_INITIAL_MS = 10_000;
const KALSHI_REST_BACKOFF_MAX_MS = 60_000;
// Capture the best slot-open proxy during the first 30s, then wait longer before entry
// so the mismatch guard evaluates against a settled reference instead of the boundary tick.
const SLOT_OPEN_CAPTURE_WINDOW_MS = 30_000;
const WS_RECONNECT_BASE_MS = 1_000;
const WS_RECONNECT_MAX_MS = 10_000;
const KALSHI_CF_BENCHMARK_CHANNEL = "cfbenchmarks_value";
const KALSHI_FILL_CHANNEL = "fill";
const KALSHI_WS_CHANNELS = ["ticker", "orderbook_delta", "trade", KALSHI_CF_BENCHMARK_CHANNEL, KALSHI_FILL_CHANNEL];
const PRIVATE_FILL_BUFFER_LIMIT = 512;
const PRIVATE_FILL_WAITER_LIMIT = 256;
const PRIVATE_FILL_MAX_WAIT_MS = 30_000;
const PRIVATE_FILL_RETENTION_MS = 5 * 60_000;

export const KALSHI_CF_BENCHMARK_INDEX_BY_ASSET: Record<MarketAsset, KalshiCfBenchmarkIndexId> = {
  btc: "BRTI",
  eth: "ETHUSD_RTI",
  sol: "SOLUSD_RTI",
  xrp: "XRPUSD_RTI",
  doge: "DOGEUSD_RTI",
  bnb: "BNBUSD_RTI",
  hype: "HYPEUSD_RTI",
};

type LevelMap = Map<string, number>;

type WsLevel = [string, string] | { price: string; size: string };

type WsPayload = Record<string, unknown> & {
  seq?: string | number;
  payload?: WsPayload;
  msg?: WsPayload;
  message?: WsPayload;
  data?: WsPayload;
  price_changes?: WsPayload[];
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
  orderbook_fp?: WsPayload;
  orderbook?: WsPayload;
  yes_dollars_fp?: WsLevel[];
  yes_dollars?: WsLevel[];
  yes?: WsLevel[];
  orderbook_yes?: WsLevel[];
  yes_book?: WsLevel[];
  no_dollars_fp?: WsLevel[];
  no_dollars?: WsLevel[];
  no?: WsLevel[];
  orderbook_no?: WsLevel[];
  no_book?: WsLevel[];
};

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

export function computeFeedStatus(
  lastMessageAt: number | null,
  dataReady: boolean,
  now: number,
): {
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

export function chooseFeedSource(
  lastWsMessageAt: number | null,
  lastRestSyncAt: number | null,
  now: number,
): FeedSource {
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

export function applyLevelDelta(levels: LevelMap, price: unknown, size: unknown) {
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

function parseCfTimestamp(value: unknown) {
  const numeric = parseNumeric(value);
  if (numeric !== null) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
  }
  return parseTimestamp(value);
}

function parseKalshiCfBenchmarkWindow(value: unknown): KalshiCfBenchmarkWindow | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const window = value as Record<string, unknown>;
  const valueUsd = parseNumeric(window.value);
  const windowSize = parseNumeric(window.window_size);
  const windowStartTsMs = parseCfTimestamp(window.window_start_ts_ms);
  const windowEndTsExclusive = parseCfTimestamp(window.window_end_ts_exclusive);
  if (
    valueUsd === null ||
    windowSize === null ||
    !Number.isInteger(windowSize) ||
    windowSize < 0 ||
    windowStartTsMs === null ||
    windowEndTsExclusive === null
  ) {
    return null;
  }

  return {
    valueUsd,
    windowSize,
    windowStartTsMs,
    windowEndTsExclusive,
  };
}

export function parseKalshiCfBenchmarksValue(value: unknown, capturedAt: number): KalshiCfBenchmarkState | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const message = value as Record<string, unknown>;
  const rawData =
    typeof message.data === "string"
      ? safeJsonParse(message.data)
      : message.data && typeof message.data === "object"
        ? message.data
        : null;
  if (!rawData || typeof rawData !== "object") {
    return null;
  }

  const rawFrame = rawData as Record<string, unknown>;
  const indexId = String(message.index_id ?? rawFrame.id ?? "") as KalshiCfBenchmarkIndexId;
  if (!Object.values(KALSHI_CF_BENCHMARK_INDEX_BY_ASSET).includes(indexId)) {
    return null;
  }

  const liveValueUsd = parseNumeric(rawFrame.value);
  const sourceTimestampMs = parseCfTimestamp(rawFrame.time);
  const receivedAtMs = parseCfTimestamp(message.received_at);
  const trailing60s = parseKalshiCfBenchmarkWindow(message.avg_60s_data);
  if (liveValueUsd === null || sourceTimestampMs === null || receivedAtMs === null || !trailing60s) {
    return null;
  }

  const finalMinuteValue = message.last_60s_windowed_average_15min;
  const finalMinuteAverage15m =
    finalMinuteValue === undefined || finalMinuteValue === null ? null : parseKalshiCfBenchmarkWindow(finalMinuteValue);
  if (finalMinuteValue !== undefined && finalMinuteValue !== null && !finalMinuteAverage15m) {
    return null;
  }

  return {
    indexId,
    liveValueUsd,
    sourceTimestampMs,
    receivedAtMs,
    capturedAt,
    trailing60s,
    finalMinuteAverage15m,
  };
}

function asNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function parseFillTimestamp(value: unknown) {
  const numeric = parseNumeric(value);
  if (numeric !== null) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
  }
  return parseTimestamp(value);
}

function parseOrderSide(value: unknown): OrderSide | null {
  const normalized = String(value ?? "").toUpperCase();
  return normalized === "BUY" || normalized === "SELL" ? normalized : null;
}

function parseResolution(value: unknown): Resolution | null {
  const normalized = String(value ?? "").toUpperCase();
  return normalized === "UP" || normalized === "DOWN" || normalized === "YES" || normalized === "NO"
    ? normalized
    : null;
}

function parseKalshiFillPrice(message: Record<string, unknown>, outcome: Resolution | null) {
  const yesPrice = parseNumeric(message.yes_price_dollars);
  const noPrice = parseNumeric(message.no_price_dollars);
  const genericPrice = parseNumeric(message.price_dollars ?? message.price);
  const legacyYesPrice = parseNumeric(message.yes_price);
  const legacyNoPrice = parseNumeric(message.no_price);

  if (outcome === "NO") {
    if (noPrice !== null) {
      return noPrice;
    }
    if (yesPrice !== null) {
      return round4(1 - yesPrice);
    }
    if (legacyNoPrice !== null) {
      return legacyNoPrice / 100;
    }
    if (legacyYesPrice !== null) {
      return round4(1 - legacyYesPrice / 100);
    }
  } else {
    if (yesPrice !== null) {
      return yesPrice;
    }
    if (noPrice !== null) {
      return round4(1 - noPrice);
    }
    if (legacyYesPrice !== null) {
      return legacyYesPrice / 100;
    }
    if (legacyNoPrice !== null) {
      return round4(1 - legacyNoPrice / 100);
    }
  }

  return genericPrice;
}

export function parseKalshiPrivateFill(value: unknown, capturedAt: number): RealtimeOrderFill | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const envelope = value as Record<string, unknown>;
  const type = String(envelope.type ?? envelope.event_type ?? "").toLowerCase();
  if (type && type !== KALSHI_FILL_CHANNEL) {
    return null;
  }
  const nested = envelope.msg ?? envelope.message ?? envelope.data ?? envelope;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    return null;
  }

  const message = nested as Record<string, unknown>;
  const venueOrderId = asNonEmptyString(message.order_id ?? message.orderId);
  const tradeId = asNonEmptyString(message.trade_id ?? message.tradeId ?? message.fill_id);
  const size = parseNumeric(message.count_fp ?? message.count ?? message.size);
  const outcome = parseResolution(message.side ?? message.purchased_side ?? message.outcome_side);
  const price = parseKalshiFillPrice(message, outcome);
  const filledAt =
    parseFillTimestamp(message.ts_ms) ??
    parseFillTimestamp(message.ts) ??
    parseFillTimestamp(message.created_time) ??
    capturedAt;
  if (!venueOrderId || !tradeId || size === null || size <= 0 || price === null || price < 0 || price > 1) {
    return null;
  }

  return {
    venue: "kalshi",
    venueOrderId,
    clientOrderId: asNonEmptyString(message.client_order_id ?? message.clientOrderId),
    tradeId,
    marketRef: asNonEmptyString(message.market_ticker ?? message.ticker),
    tokenId: null,
    side: parseOrderSide(message.action),
    outcome,
    price,
    size,
    liquidity: typeof message.is_taker === "boolean" ? (message.is_taker ? "TAKER" : "MAKER") : null,
    status: asNonEmptyString(message.status),
    filledAt,
    capturedAt,
    raw: message,
  };
}

function parsePolymarketTradeEvent(event: Record<string, unknown>, capturedAt: number) {
  const eventType = String(event.event_type ?? event.type ?? "").toLowerCase();
  if (eventType !== "trade") {
    return [];
  }

  const rawStatus = String(event.status ?? "").trim();
  const status = normalizePolymarketTradeStatus(rawStatus);
  if (status === null || status === "FAILED") {
    return [];
  }

  const tradeId = asNonEmptyString(event.id ?? event.trade_id);
  if (!tradeId) {
    return [];
  }
  const filledAt =
    parseFillTimestamp(event.matchtime ?? event.match_time) ??
    parseFillTimestamp(event.last_update) ??
    parseFillTimestamp(event.timestamp) ??
    capturedAt;
  const marketRef = asNonEmptyString(event.market ?? event.condition_id);
  const traderSide = String(event.trader_side ?? "").toUpperCase();
  const authenticatedOwnerIds = new Set(
    [event.owner, event.trade_owner].map(normalizeIdentifier).filter((ownerId): ownerId is string => ownerId !== null),
  );
  const fills: RealtimeOrderFill[] = [];

  const pushFill = (input: {
    orderId: unknown;
    clientOrderId?: unknown;
    size: unknown;
    price: unknown;
    side: unknown;
    outcome: unknown;
    tokenId: unknown;
    liquidity: "TAKER" | "MAKER";
    raw: Record<string, unknown>;
  }) => {
    const venueOrderId = asNonEmptyString(input.orderId);
    const size = parseNumeric(input.size);
    const price = parseNumeric(input.price);
    if (!venueOrderId || size === null || size <= 0 || price === null || price < 0 || price > 1) {
      return;
    }
    fills.push({
      venue: "polymarket",
      venueOrderId,
      clientOrderId: asNonEmptyString(input.clientOrderId),
      tradeId,
      marketRef,
      tokenId: asNonEmptyString(input.tokenId),
      side: parseOrderSide(input.side),
      outcome: parseResolution(input.outcome),
      price,
      size,
      liquidity: input.liquidity,
      status: status || null,
      filledAt,
      capturedAt,
      raw: input.raw,
    });
  };

  if (traderSide !== "MAKER") {
    pushFill({
      orderId: event.taker_order_id,
      clientOrderId: event.client_order_id,
      size: event.size,
      price: event.price,
      side: event.side,
      outcome: event.outcome,
      tokenId: event.asset_id,
      liquidity: "TAKER",
      raw: event,
    });
  }

  if (traderSide !== "TAKER") {
    const makerOrders = Array.isArray(event.maker_orders) ? event.maker_orders : [];
    for (const makerValue of makerOrders) {
      if (!makerValue || typeof makerValue !== "object" || Array.isArray(makerValue)) {
        continue;
      }
      const makerOrder = makerValue as Record<string, unknown>;
      const makerOwnerId = normalizeIdentifier(makerOrder.owner);
      if (authenticatedOwnerIds.size > 0 && (!makerOwnerId || !authenticatedOwnerIds.has(makerOwnerId))) {
        continue;
      }
      pushFill({
        orderId: makerOrder.order_id,
        clientOrderId: makerOrder.client_order_id,
        size: makerOrder.matched_amount ?? makerOrder.size,
        price: makerOrder.price ?? event.price,
        side: makerOrder.side,
        outcome: makerOrder.outcome ?? event.outcome,
        tokenId: makerOrder.asset_id ?? event.asset_id,
        liquidity: "MAKER",
        raw: { ...event, matched_maker_order: makerOrder },
      });
    }
  }

  return fills;
}

export function parsePolymarketUserFills(value: unknown, capturedAt: number): RealtimeOrderFill[] {
  if (Array.isArray(value)) {
    return value.flatMap((event) => parsePolymarketUserFills(event, capturedAt));
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  const event = value as Record<string, unknown>;
  const direct = parsePolymarketTradeEvent(event, capturedAt);
  const eventType = String(event.event_type ?? event.type ?? "").toLowerCase();
  if (direct.length > 0 || eventType === "trade" || eventType === "order") {
    return direct;
  }
  const nested = event.msg ?? event.message ?? event.data ?? event.payload;
  return nested === value ? [] : parsePolymarketUserFills(nested, capturedAt);
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

type PrivateFillListener = (fill: RealtimeOrderFill) => void;
type PrivateFeedResetListener = (venue: RealtimeOrderFill["venue"], marketRef: string | null) => void;

type PrivateFillWaiter = {
  id: number;
  request: WaitForOrderFillRequest;
  resolve: (fill: RealtimeOrderFill | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

class RealtimeOrderFillTracker {
  private recentFills: RealtimeOrderFill[] = [];
  private seenFillKeys = new Map<string, number>();
  private waiters = new Map<number, PrivateFillWaiter>();
  private nextWaiterId = 1;

  ingest(fill: RealtimeOrderFill) {
    this.prune(fill.capturedAt);
    const key = this.fillKey(fill);
    if (this.seenFillKeys.has(key)) {
      return false;
    }

    this.seenFillKeys.set(key, fill.capturedAt);
    this.recentFills.unshift(fill);
    while (this.recentFills.length > PRIVATE_FILL_BUFFER_LIMIT) {
      const removed = this.recentFills.pop();
      if (removed) {
        this.seenFillKeys.delete(this.fillKey(removed));
      }
    }

    for (const waiter of [...this.waiters.values()]) {
      if (this.matches(fill, waiter.request)) {
        this.settleWaiter(waiter, fill);
      }
    }
    return true;
  }

  read(request: ReadRecentOrderFillsRequest = {}) {
    this.prune(Date.now());
    const limit = Math.max(1, Math.min(PRIVATE_FILL_BUFFER_LIMIT, Math.floor(request.limit ?? 50)));
    return this.recentFills.filter((fill) => this.matches(fill, request)).slice(0, limit);
  }

  wait(request: WaitForOrderFillRequest) {
    this.prune(Date.now());
    const existing = this.recentFills.find((fill) => this.matches(fill, request));
    if (existing) {
      return Promise.resolve(existing);
    }

    const timeoutMs = Number.isFinite(request.timeoutMs)
      ? Math.max(0, Math.min(PRIVATE_FILL_MAX_WAIT_MS, Math.floor(request.timeoutMs)))
      : 0;
    if (timeoutMs === 0) {
      return Promise.resolve(null);
    }

    if (this.waiters.size >= PRIVATE_FILL_WAITER_LIMIT) {
      const oldest = this.waiters.values().next().value as PrivateFillWaiter | undefined;
      if (oldest) {
        this.settleWaiter(oldest, null);
      }
    }

    return new Promise<RealtimeOrderFill | null>((resolve) => {
      const id = this.nextWaiterId++;
      const timer = setTimeout(() => {
        const waiter = this.waiters.get(id);
        if (waiter) {
          this.settleWaiter(waiter, null);
        }
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(id, {
        id,
        request: { ...request, timeoutMs },
        resolve,
        timer,
      });
    });
  }

  clearWaiters(venue: RealtimeOrderFill["venue"], marketRef: string | null) {
    for (const waiter of [...this.waiters.values()]) {
      if (waiter.request.venue !== venue) {
        continue;
      }
      const requestedMarket = normalizeIdentifier(waiter.request.marketRef);
      const disconnectedMarket = normalizeIdentifier(marketRef);
      if (!requestedMarket || !disconnectedMarket || requestedMarket === disconnectedMarket) {
        this.settleWaiter(waiter, null);
      }
    }
  }

  clearAllWaiters() {
    for (const waiter of [...this.waiters.values()]) {
      this.settleWaiter(waiter, null);
    }
  }

  private settleWaiter(waiter: PrivateFillWaiter, fill: RealtimeOrderFill | null) {
    if (!this.waiters.delete(waiter.id)) {
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(fill);
  }

  private matches(fill: RealtimeOrderFill, request: ReadRecentOrderFillsRequest | WaitForOrderFillRequest) {
    if (request.venue && fill.venue !== request.venue) {
      return false;
    }
    if (request.afterCapturedAt !== undefined && fill.capturedAt <= request.afterCapturedAt) {
      return false;
    }
    const requestedMarket = normalizeIdentifier(request.marketRef);
    if (requestedMarket && normalizeIdentifier(fill.marketRef) !== requestedMarket) {
      return false;
    }

    const requestedOrder = normalizeIdentifier(request.venueOrderId);
    const requestedClientOrder = normalizeIdentifier(request.clientOrderId);
    if (!requestedOrder && !requestedClientOrder) {
      return true;
    }
    return (
      (requestedOrder !== null && normalizeIdentifier(fill.venueOrderId) === requestedOrder) ||
      (requestedClientOrder !== null && normalizeIdentifier(fill.clientOrderId) === requestedClientOrder)
    );
  }

  private prune(now: number) {
    const cutoff = now - PRIVATE_FILL_RETENTION_MS;
    this.recentFills = this.recentFills.filter((fill) => {
      if (fill.capturedAt >= cutoff) {
        return true;
      }
      this.seenFillKeys.delete(this.fillKey(fill));
      return false;
    });
  }

  private fillKey(fill: RealtimeOrderFill) {
    return `${fill.venue}:${normalizeIdentifier(fill.venueOrderId)}:${normalizeIdentifier(fill.tradeId)}`;
  }
}

function normalizeIdentifier(value: unknown) {
  const identifier = asNonEmptyString(value);
  return identifier ? identifier.toLowerCase() : null;
}

function hasKalshiCredentialsSafe() {
  try {
    return hasKalshiCredentials();
  } catch {
    return false;
  }
}

class PolymarketRealtimeFeed {
  constructor(
    private readonly onPrivateFill: PrivateFillListener = () => {},
    private readonly onPrivateFeedReset: PrivateFeedResetListener = () => {},
  ) {}

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
  private marketReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private userReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private priceReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private bootstrapPromise: Promise<void> | null = null;
  private resyncPromise: Promise<void> | null = null;
  private lastRestSyncAt: number | null = null;
  private lastWsMessageAt: number | null = null;
  private lastUserMessageAt: number | null = null;
  private lastPriceMessageAt: number | null = null;
  private priceWsConnectedAt: number | null = null;
  private lastError: string | null = null;
  private lastChainlinkError: string | null = null;
  private chainlinkLivePriceUsd: number | null = null;
  private chainlinkLivePriceCapturedAt: number | null = null;
  private observedSlotOpenPriceUsd: number | null = null;
  private observedSlotOpenCapturedAt: number | null = null;
  private reconnectAttempt = 0;
  private priceReconnectAttempt = 0;
  private userReconnectAttempt = 0;
  private stopped = false;
  private subscriptions = emptySubscriptions(["market", "user", "chainlink_price"], "rest-bootstrap");

  async ensureSlot(slot: MarketSlot, now = Date.now()) {
    if (this.stopped) {
      return;
    }
    if (this.slotKey !== slot.key) {
      await this.reset();
      this.slotKey = slot.key;
    }
    this.slotStartTs = slot.startTs;

    if (!this.market || !this.tokenIds) {
      await this.bootstrap(slot, now);
    } else if (shouldRestResync(this.lastRestSyncAt, this.lastWsMessageAt, now, POLYMARKET_REST_FALLBACK_RESYNC_MS)) {
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
    const lastMessageAt =
      [this.lastWsMessageAt, this.lastRestSyncAt].filter(Boolean).sort((a, b) => b! - a!)[0] ?? null;
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
        this.lastChainlinkError ??
          (this.chainlinkLivePriceUsd === null
            ? "flux Chainlink live indisponible"
            : `Chainlink live ${this.chainlinkLivePriceUsd.toFixed(4)} USD`),
      ],
      subscriptions: this.subscriptions,
    });

    const upBookSnapshot = upBook ? serializePolymarketBook(upBook) : null;
    const downBookSnapshot = downBook ? serializePolymarketBook(downBook) : null;
    const upOutcome = upBook
      ? buildPolymarketOutcomeQuoteFromBook(
          "UP",
          upBookSnapshot!,
          feedHealth.source,
          upBook.lastUpdatedAt,
          upBook.lastTradePrice,
          this.clobMarketInfo,
        )
      : createUnavailablePolymarketQuote(slot, "Orderbook Polymarket indisponible").outcomes.up;
    const downOutcome = downBook
      ? buildPolymarketOutcomeQuoteFromBook(
          "DOWN",
          downBookSnapshot!,
          feedHealth.source,
          downBook.lastUpdatedAt,
          downBook.lastTradePrice,
          this.clobMarketInfo,
        )
      : createUnavailablePolymarketQuote(slot, "Orderbook Polymarket indisponible").outcomes.down;

    const feeMetadata = derivePolymarketFeeMetadata(this.clobMarketInfo);
    const quote: PolymarketQuote = {
      ref: buildCanonicalPolymarketMarketRef(slot, this.market),
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
      feeRate: parseNumeric(this.clobMarketInfo?.fd?.r) ?? null,
      feeExponent: parseNumeric(this.clobMarketInfo?.fd?.e) ?? 0,
      ...feeMetadata,
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
        buildCanonicalPolymarketMarketRef(slot, market);

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
          buildCanonicalPolymarketMarketRef(slot, freshMarket);
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
    if (this.stopped || !this.tokenIds) {
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

  private connectMarketWs(_now: number) {
    if (this.ws || !this.tokenIds) {
      return;
    }

    const tokenIds = this.tokenIds;
    this.subscriptions[0] = toSubscriptionState(this.subscriptions[0], {
      status: "connecting",
      source: "ws",
      details: "connexion au market channel",
    });

    const ws = new WebSocket(POLY_MARKET_WS_BASE);
    this.ws = ws;

    ws.on("open", () => {
      if (this.ws !== ws || this.tokenIds !== tokenIds) {
        ws.close();
        return;
      }

      this.clearMarketReconnectTimer();
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
          assets_ids: [tokenIds.up, tokenIds.down],
          custom_feature_enabled: true,
        }),
      );
    });

    ws.on("message", (buffer: Buffer) => {
      if (this.ws !== ws) {
        return;
      }
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
      if (this.ws !== ws) {
        return;
      }
      this.stopMarketHeartbeat();
      this.lastError = error instanceof Error ? error.message : "Polymarket market WS error";
      this.subscriptions[0] = toSubscriptionState(this.subscriptions[0], {
        status: "error",
        source: "ws",
        details: this.lastError,
      });
    });

    ws.on("close", () => {
      this.handleMarketWsClose(ws);
    });
  }

  private handleMarketWsClose(ws: WebSocket) {
    if (this.ws !== ws) {
      return;
    }

    this.stopMarketHeartbeat();
    this.ws = null;
    this.subscriptions[0] = toSubscriptionState(this.subscriptions[0], {
      status: "closed",
      source: "ws",
      details: "market channel ferme, retry programme",
    });
    this.scheduleMarketReconnect();
  }

  private clearMarketReconnectTimer() {
    if (this.marketReconnectTimer) {
      clearTimeout(this.marketReconnectTimer);
      this.marketReconnectTimer = null;
    }
  }

  private scheduleMarketReconnect() {
    if (this.marketReconnectTimer || !this.slotKey) {
      return;
    }

    const delay = nextReconnectDelay(this.reconnectAttempt++);
    this.marketReconnectTimer = setTimeout(() => {
      this.marketReconnectTimer = null;
      if (this.slotKey && !this.ws) {
        this.connectMarketWs(Date.now());
      }
    }, delay);
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
      this.priceWsConnectedAt = Date.now();
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
        this.subscriptions[2] = toSubscriptionState(this.subscriptions[2], {
          status: "subscribed",
          source: "ws",
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
      this.priceWsConnectedAt = null;
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
      this.priceWsConnectedAt = null;
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
      const raw = buffer.toString();
      if (raw === "PONG") {
        this.lastUserMessageAt = nowTs;
        this.subscriptions[1] = toSubscriptionState(this.subscriptions[1], {
          status: "subscribed",
          source: "ws",
          lastMessageAt: nowTs,
          details: "user channel actif",
        });
        return;
      }

      const payload = safeJsonParse(raw);
      if (payload) {
        this.applyUserEvent(payload, nowTs);
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
      if (this.userWs !== ws) {
        return;
      }
      this.stopUserHeartbeat();
      this.onPrivateFeedReset("polymarket", this.market?.conditionId ?? this.market?.id ?? null);
      const details = error instanceof Error ? error.message : "Polymarket user WS error";
      this.subscriptions[1] = toSubscriptionState(this.subscriptions[1], {
        status: "error",
        source: "ws",
        details,
      });
    });

    ws.on("close", () => {
      if (this.userWs !== ws) {
        return;
      }
      this.stopUserHeartbeat();
      this.userWs = null;
      this.onPrivateFeedReset("polymarket", this.market?.conditionId ?? this.market?.id ?? null);
      this.subscriptions[1] = toSubscriptionState(this.subscriptions[1], {
        status: "closed",
        source: "ws",
        details: "user channel ferme, reconcile REST conserve",
      });
      const delay = nextReconnectDelay(this.userReconnectAttempt++);
      this.userReconnectTimer = setTimeout(() => {
        this.userReconnectTimer = null;
        if (!this.stopped && this.slotKey && hasPolymarketCredentials()) {
          this.connectUserWs(Date.now());
        }
      }, delay);
    });
  }

  private applyUserEvent(value: unknown, now: number) {
    for (const fill of parsePolymarketUserFills(value, now)) {
      this.onPrivateFill(fill);
    }
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
      const now = Date.now();
      if (isChainlinkPriceStreamSilent(this.lastPriceMessageAt, this.priceWsConnectedAt, now)) {
        const referenceAt = latestTimestamp(this.lastPriceMessageAt, this.priceWsConnectedAt) ?? now;
        this.lastChainlinkError = `Chainlink RTDS sans nouveau prix depuis ${now - referenceAt}ms`;
        this.subscriptions[2] = toSubscriptionState(this.subscriptions[2], {
          status: "error",
          source: "ws",
          details: this.lastChainlinkError,
        });
        console.warn("[poly-chainlink-ws] price-stream-stalled", {
          asset: this.marketAsset(),
          symbol: getMarketCatalogEntry(this.marketAsset()).polymarketChainlinkSymbol,
          silenceMs: now - referenceAt,
        });
        this.priceWs = null;
        this.priceWsConnectedAt = null;
        const terminable = ws as WebSocket & { terminate?: () => void };
        if (typeof terminable.terminate === "function") {
          terminable.terminate();
        } else {
          ws.close(1011, "Chainlink RTDS price stream stalled");
        }
        this.schedulePriceReconnect();
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

  private applyPriceEvent(event: WsPayload, now: number) {
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

  private applyMarketEvent(event: WsPayload, now: number) {
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
        const price =
          change.price ?? change.level ?? change.changed_price ?? event.price ?? event.level ?? event.changed_price;
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
    const marketWs = this.ws;
    const userWs = this.userWs;
    const userMarketRef = this.market?.conditionId ?? this.market?.id ?? null;
    this.ws = null;
    this.userWs = null;
    if (userWs) {
      this.onPrivateFeedReset("polymarket", userMarketRef);
    }
    this.clearMarketReconnectTimer();
    if (this.userReconnectTimer) {
      clearTimeout(this.userReconnectTimer);
      this.userReconnectTimer = null;
    }
    marketWs?.close();
    userWs?.close();
    this.priceWs?.close();
    this.stopMarketHeartbeat();
    this.stopUserHeartbeat();
    this.stopPriceHeartbeat();
    this.clearPriceReconnectTimer();
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
    this.priceWsConnectedAt = null;
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

  async shutdown() {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.slotKey = null;
    const pending = [this.bootstrapPromise, this.resyncPromise].filter(
      (promise): promise is Promise<void> => promise !== null,
    );
    await this.reset();
    await Promise.allSettled(pending);
  }
}

export function isChainlinkPriceStreamSilent(
  lastPriceAt: number | null,
  connectedAt: number | null,
  now: number,
  timeoutMs = POLYMARKET_CHAINLINK_SILENCE_TIMEOUT_MS,
) {
  const referenceAt = latestTimestamp(lastPriceAt, connectedAt);
  return (
    referenceAt !== null &&
    Number.isFinite(referenceAt) &&
    Number.isFinite(now) &&
    Number.isFinite(timeoutMs) &&
    timeoutMs >= 0 &&
    now - referenceAt > timeoutMs
  );
}

function latestTimestamp(...values: Array<number | null>) {
  const timestamps = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

class KalshiRealtimeFeed {
  constructor(
    private readonly onPrivateFill: PrivateFillListener = () => {},
    private readonly onPrivateFeedReset: PrivateFeedResetListener = () => {},
  ) {}

  private asset: MarketAsset | null = null;
  private slotKey: string | null = null;
  private seriesCache: { series: Awaited<ReturnType<typeof fetchKalshiSeries>>["series"]; capturedAt: number } | null =
    null;
  private marketsCache: { markets: KalshiMarketSummary[]; capturedAt: number } | null = null;
  private series: Awaited<ReturnType<typeof fetchKalshiSeries>>["series"] | null = null;
  private market: KalshiMarketSummary | null = null;
  private orderbook: KalshiBookState | null = null;
  private orderbookInSync = true;
  private trades: KalshiTrade[] = [];
  private cfBenchmarks: KalshiCfBenchmarkState | null = null;
  private ws: WebSocket | null = null;
  private wsHeartbeat: ReturnType<typeof setInterval> | null = null;
  private wsBootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsOrderbookReady = false;
  private wsEndpointIndex = 0;
  private wsEndpointUrl: string | null = null;
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
  private stopped = false;
  private subscriptions = emptySubscriptions(KALSHI_WS_CHANNELS, "rest-bootstrap");
  private subscriptionCommands = new Map<number, string>();
  private nextSubscriptionId = 1;

  async ensureSlot(slot: MarketSlot, now = Date.now()) {
    if (this.stopped) {
      return;
    }
    if (this.slotKey !== slot.key) {
      await this.reset();
      this.asset = slot.asset;
      this.slotKey = slot.key;
    }

    if (!this.market) {
      if (this.isRestBackoffActive("bootstrap", now)) {
        return;
      }
      await this.bootstrap(slot, now);
    } else {
      const strikeMissing = parseNumeric(this.market.floor_strike) === null;
      const resyncIntervalMs = strikeMissing ? KALSHI_MISSING_STRIKE_RESYNC_MS : KALSHI_REST_FALLBACK_RESYNC_MS;
      const healthyIntervalMs = strikeMissing ? KALSHI_MISSING_STRIKE_RESYNC_MS : FEED_HEALTHY_REVALIDATE_MS;
      if (
        shouldRestResync(this.lastRestSyncAt, this.lastWsMessageAt, now, resyncIntervalMs, healthyIntervalMs) &&
        !this.isRestBackoffActive("resync", now)
      ) {
        void this.resync(now);
      }
    }

    this.ensureWs();
  }

  buildState(slot: MarketSlot, now = Date.now()): LiveMarketState<KalshiQuote> {
    const lastMessageAt =
      [this.lastWsMessageAt, this.lastRestSyncAt].filter(Boolean).sort((a, b) => b! - a!)[0] ?? null;
    const priceRanges = normalizeKalshiMarketPriceRanges(this.market?.price_ranges);
    const feedHealth = buildFeedHealth({
      asset: slot.asset,
      venue: "kalshi",
      now,
      lastMessageAt,
      lastWsMessageAt: this.lastWsMessageAt,
      lastRestSyncAt: this.lastRestSyncAt,
      dataReady: Boolean(this.market && this.series && this.orderbookInSync && priceRanges),
      details: [
        ...this.describeFeedDetails(now),
        ...(this.market && !priceRanges ? ["Kalshi price_ranges manquant ou invalide"] : []),
      ],
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
          priceRanges,
        )
      : null;
    const orderbookLevels = this.orderbook
      ? normalizeKalshiNumericOrderbookLevels({
          yes_dollars: serializeLevelMap(this.orderbook.yes, "desc"),
          no_dollars: serializeLevelMap(this.orderbook.no, "desc"),
        })
      : null;
    const activeQuotes = this.hasFreshOrderbook(now) ? (orderbookQuotes ?? marketQuotes) : marketQuotes;
    const tradePrices = extractKalshiLastTradePrices(this.trades, parseNumeric(this.market.last_price_dollars) ?? null);

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
      availabilityReason: priceRanges ? null : "Kalshi price_ranges manquant ou invalide",
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
      priceLevelStructure: this.market.price_level_structure ?? null,
      priceRanges,
      cfBenchmarks: this.cfBenchmarks,
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
    if (this.stopped) {
      return;
    }
    const hasCredentials = hasKalshiCredentialsSafe();
    if (!this.market || this.ws || this.wsReconnectTimer || !hasCredentials) {
      if (!hasCredentials) {
        const source = this.restFallbackSource();
        this.subscriptions[0] = toSubscriptionState(this.subscriptions[0], {
          status: "idle",
          source,
          details: "ticker websocket non actif sans credentials Kalshi",
        });
        this.subscriptions[1] = toSubscriptionState(this.subscriptions[1], {
          status: "idle",
          source,
          details: "orderbook via REST fallback",
        });
        this.subscriptions[2] = toSubscriptionState(this.subscriptions[2], {
          status: "idle",
          source,
          details: "trade tape via REST fallback",
        });
        this.subscriptions[3] = toSubscriptionState(this.subscriptions[3], {
          status: "idle",
          source: "unavailable",
          details: "reference CF inactive without Kalshi credentials",
        });
        this.subscriptions[4] = toSubscriptionState(this.subscriptions[4], {
          status: "idle",
          source: "unavailable",
          details: "private fills inactive without Kalshi credentials",
        });
      }
      return;
    }

    const endpoints = getKalshiWsUrls();
    const endpoint = endpoints[this.wsEndpointIndex % endpoints.length];
    const marketTicker = this.market.ticker;
    const cfBenchmarkIndexId = this.asset ? KALSHI_CF_BENCHMARK_INDEX_BY_ASSET[this.asset] : undefined;
    let headers: ReturnType<typeof buildKalshiWsHeaders>;
    try {
      headers = buildKalshiWsHeaders();
    } catch (error) {
      const details = error instanceof Error ? error.message : "Kalshi WS credentials unreadable";
      const failure = `Kalshi WS handshake preparation failed: ${details}`;
      this.markWsFailure(failure);
      console.warn("[kalshi-ws] handshake-preparation-failed", {
        endpoint,
        marketTicker,
        slotKey: this.slotKey,
        details,
      });
      const delay = nextReconnectDelay(this.reconnectAttempt++);
      this.wsReconnectTimer = setTimeout(() => {
        this.wsReconnectTimer = null;
        if (!this.stopped && this.slotKey) {
          this.ensureWs();
        }
      }, delay);
      return;
    }

    const ws = new WebSocket(endpoint, { headers });
    this.ws = ws;
    this.wsEndpointUrl = endpoint;
    this.wsOrderbookReady = false;
    let endpointRotated = false;
    let sessionReady = false;
    const rotateEndpoint = () => {
      if (endpointRotated || endpoints.length < 2) {
        return;
      }
      endpointRotated = true;
      this.wsEndpointIndex = (this.wsEndpointIndex + 1) % endpoints.length;
    };

    for (let index = 0; index < this.subscriptions.length; index += 1) {
      if (this.subscriptions[index].channel === KALSHI_CF_BENCHMARK_CHANNEL && !cfBenchmarkIndexId) {
        this.subscriptions[index] = toSubscriptionState(this.subscriptions[index], {
          status: "idle",
          source: "unavailable",
          details: "no CF Benchmarks index mapped for this asset",
        });
        continue;
      }
      this.subscriptions[index] = toSubscriptionState(this.subscriptions[index], {
        status: "connecting",
        source: "ws",
        details: "connexion websocket Kalshi",
      });
    }

    ws.on("open", () => {
      if (this.ws !== ws || !this.market || this.market.ticker !== marketTicker) {
        ws.close();
        return;
      }

      console.info("[kalshi-ws] open", {
        endpoint,
        marketTicker,
        slotKey: this.slotKey,
      });
      this.subscribe(ws, "ticker", marketTicker);
      this.subscribe(ws, "trade", marketTicker);
      this.subscribe(ws, "orderbook_delta", marketTicker);
      if (cfBenchmarkIndexId) {
        this.subscribe(ws, KALSHI_CF_BENCHMARK_CHANNEL, marketTicker, cfBenchmarkIndexId);
      }
      this.subscribe(ws, KALSHI_FILL_CHANNEL, marketTicker);

      this.clearWsSessionTimers();
      this.wsHeartbeat = setInterval(() => {
        if (this.ws === ws && ws.readyState === WebSocket.OPEN) {
          const now = Date.now();
          if (
            sessionReady &&
            this.lastWsMessageAt !== null &&
            now - this.lastWsMessageAt > KALSHI_WS_HEARTBEAT_TIMEOUT_MS
          ) {
            rotateEndpoint();
            this.failWsSession(ws, `Kalshi WS heartbeat timeout after ${now - this.lastWsMessageAt}ms`);
            return;
          }
          ws.ping("warbitrer");
        }
      }, KALSHI_WS_HEARTBEAT_MS);
      this.wsBootstrapTimer = setTimeout(() => {
        if (this.ws !== ws || sessionReady) {
          return;
        }
        rotateEndpoint();
        this.failWsSession(
          ws,
          `Kalshi WS bootstrap timeout after ${KALSHI_WS_BOOTSTRAP_TIMEOUT_MS}ms without orderbook snapshot`,
        );
      }, KALSHI_WS_BOOTSTRAP_TIMEOUT_MS);
    });

    ws.on("message", (buffer: Buffer) => {
      if (this.ws !== ws) {
        return;
      }
      const payload = safeJsonParse(buffer.toString());
      if (!payload) {
        return;
      }

      const nowTs = Date.now();
      if (String(payload.type ?? "") === "error" && !this.optionalSubscriptionChannel(payload)) {
        rotateEndpoint();
      }
      const accepted = this.applyWsPayload(payload, nowTs);
      if (accepted && this.wsOrderbookReady) {
        sessionReady = true;
        this.reconnectAttempt = 0;
        if (this.wsBootstrapTimer) {
          clearTimeout(this.wsBootstrapTimer);
          this.wsBootstrapTimer = null;
        }
      }
    });

    ws.on("error", (error: unknown) => {
      if (this.ws !== ws) {
        return;
      }
      rotateEndpoint();
      const details = error instanceof Error ? error.message : "Kalshi WS transport error";
      console.warn("[kalshi-ws] error", {
        endpoint,
        marketTicker,
        slotKey: this.slotKey,
        details,
      });
      this.failWsSession(ws, `Kalshi WS transport error: ${details}`);
    });

    ws.on("ping", () => {
      if (this.ws === ws && this.wsOrderbookReady) {
        this.lastWsMessageAt = Date.now();
      }
    });

    ws.on("pong", () => {
      if (this.ws === ws && this.wsOrderbookReady) {
        this.lastWsMessageAt = Date.now();
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      if (this.ws !== ws) {
        return;
      }
      if (!sessionReady) {
        rotateEndpoint();
      }
      this.clearWsSessionTimers();
      this.ws = null;
      this.wsEndpointUrl = null;
      this.wsOrderbookReady = false;
      this.cfBenchmarks = null;
      this.onPrivateFeedReset("kalshi", marketTicker);
      if (this.lastWsMessageAt !== null) {
        this.lastWsMessageAt = Math.min(this.lastWsMessageAt, Date.now() - FEED_BLOCKED_MS - 1);
      }
      this.nextSubscriptionId = 1;
      this.subscriptionCommands.clear();
      const source = this.restFallbackSource();
      const closeReason = reason.toString() || "no reason";
      for (let index = 0; index < this.subscriptions.length; index += 1) {
        const subscriptionSource = this.isOptionalSubscriptionChannel(this.subscriptions[index].channel)
          ? "unavailable"
          : source;
        this.subscriptions[index] = toSubscriptionState(this.subscriptions[index], {
          status: "closed",
          source: subscriptionSource,
          details:
            this.lastRestSyncAt === null
              ? `connexion fermee (${code}: ${closeReason})`
              : `connexion fermee (${code}: ${closeReason}), REST fallback conserve`,
        });
      }
      console.warn("[kalshi-ws] close", {
        endpoint,
        marketTicker,
        slotKey: this.slotKey,
        code,
        reason: closeReason,
        hadOrderbookSnapshot: sessionReady,
      });
      const delay = nextReconnectDelay(this.reconnectAttempt++);
      this.wsReconnectTimer = setTimeout(() => {
        this.wsReconnectTimer = null;
        if (!this.stopped && this.slotKey) {
          this.ensureWs();
        }
      }, delay);
    });
  }

  private applyWsPayload(payload: WsPayload, now: number) {
    const type = String(payload.type ?? payload.event_type ?? payload.cmd ?? "");
    const message = payload.msg ?? payload.message ?? payload.data ?? payload;

    if (type === "error") {
      const code = message?.code ?? "unknown";
      const details = typeof message?.msg === "string" ? message.msg : JSON.stringify(message);
      const command = payload.id === undefined ? "unknown" : String(payload.id);
      const failure = `Kalshi WS protocol error ${code} on command ${command}: ${details}`;
      const optionalChannel = this.optionalSubscriptionChannel(payload);
      if (optionalChannel) {
        this.markOptionalSubscriptionFailure(payload, optionalChannel, failure);
        return false;
      }
      if (this.ws) {
        this.failWsSession(this.ws, failure);
      } else {
        this.markWsFailure(failure);
      }
      return false;
    }

    if (type === "subscribed") {
      const commandId = parseNumeric(payload.id);
      const channel = String(
        message.channel ?? (commandId === null ? "" : (this.subscriptionCommands.get(commandId) ?? "")),
      );
      if (commandId !== null) {
        this.subscriptionCommands.delete(commandId);
      }
      const index = this.subscriptions.findIndex((subscription) => subscription.channel === channel);
      if (index >= 0) {
        this.subscriptions[index] = toSubscriptionState(this.subscriptions[index], {
          status: "subscribed",
          source: "ws",
          lastMessageAt: now,
          details: `sid ${message.sid ?? "?"}`,
        });
      }
      console.info("[kalshi-ws] subscribed", {
        endpoint: this.wsEndpointUrl,
        marketTicker: this.market?.ticker ?? null,
        slotKey: this.slotKey,
        commandId: payload.id ?? null,
        channel,
        sid: message.sid ?? null,
      });
      return false;
    }

    if (type === KALSHI_CF_BENCHMARK_CHANNEL) {
      const parsed = parseKalshiCfBenchmarksValue(message, now);
      const expectedIndexId = this.asset ? KALSHI_CF_BENCHMARK_INDEX_BY_ASSET[this.asset] : undefined;
      if (!parsed || parsed.indexId !== expectedIndexId) {
        const index = this.subscriptions.findIndex(
          (subscription) => subscription.channel === KALSHI_CF_BENCHMARK_CHANNEL,
        );
        if (index >= 0) {
          this.subscriptions[index] = toSubscriptionState(this.subscriptions[index], {
            status: "subscribed",
            source: "ws",
            details: parsed ? `ignored unexpected index ${parsed.indexId}` : "malformed CF Benchmarks value ignored",
          });
        }
        return false;
      }

      this.cfBenchmarks = parsed;
      const index = this.subscriptions.findIndex(
        (subscription) => subscription.channel === KALSHI_CF_BENCHMARK_CHANNEL,
      );
      if (index >= 0) {
        this.subscriptions[index] = toSubscriptionState(this.subscriptions[index], {
          status: "subscribed",
          source: "ws",
          lastMessageAt: now,
          details: `${parsed.indexId} reference live`,
        });
      }
      return true;
    }

    if (type === KALSHI_FILL_CHANNEL) {
      const parsed = parseKalshiPrivateFill(payload, now);
      const currentMarketTicker = this.market?.ticker ?? null;
      const index = this.subscriptions.findIndex((subscription) => subscription.channel === KALSHI_FILL_CHANNEL);
      if (!parsed || (parsed.marketRef && currentMarketTicker && parsed.marketRef !== currentMarketTicker)) {
        if (index >= 0) {
          this.subscriptions[index] = toSubscriptionState(this.subscriptions[index], {
            status: "subscribed",
            source: "ws",
            details: parsed ? `ignored fill for ${parsed.marketRef}` : "malformed private fill ignored",
          });
        }
        return false;
      }

      this.onPrivateFill(parsed);
      if (index >= 0) {
        this.subscriptions[index] = toSubscriptionState(this.subscriptions[index], {
          status: "subscribed",
          source: "ws",
          lastMessageAt: now,
          details: "private fills live",
        });
      }
      return false;
    }

    if (!this.isCurrentKalshiMarketMessage(message)) {
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
            ? (deriveComplementPrice(noAskMessage ?? this.market.no_ask_dollars) ?? this.market.yes_bid_dollars)
            : (yesBidMessage ?? this.market.yes_bid_dollars),
        );
        const yesAsk = String(
          hasFreshNoSide && !hasFreshYesSide
            ? (deriveComplementPrice(noBidMessage ?? this.market.no_bid_dollars) ?? this.market.yes_ask_dollars)
            : (yesAskMessage ?? this.market.yes_ask_dollars),
        );
        const derivedNoBid = deriveComplementPrice(yesAsk);
        const derivedNoAsk = deriveComplementPrice(yesBid);
        const noBid = String(
          hasFreshYesSide ? (derivedNoBid ?? this.market.no_bid_dollars) : (noBidMessage ?? this.market.no_bid_dollars),
        );
        const noAsk = String(
          hasFreshYesSide ? (derivedNoAsk ?? this.market.no_ask_dollars) : (noAskMessage ?? this.market.no_ask_dollars),
        );
        const updatedTime =
          parseTimestamp(message.updated_time ?? message.created_time ?? message.ts ?? message.timestamp) ?? now;
        this.market = {
          ...this.market,
          yes_bid_dollars: yesBid,
          yes_ask_dollars: yesAsk,
          no_bid_dollars: noBid,
          no_ask_dollars: noAsk,
          last_price_dollars: String(
            message.last_price_dollars ??
              message.last_price ??
              message.price_dollars ??
              this.market.last_price_dollars ??
              "",
          ),
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
      if (this.wsOrderbookReady) {
        this.lastWsMessageAt = now;
      }
      return true;
    }

    if (type === "orderbook_snapshot") {
      const orderbook = normalizeKalshiWsOrderbook({
        ...message,
        seq: payload.seq ?? message.seq,
      });
      if (!orderbook) {
        if (this.ws) {
          this.failWsSession(this.ws, "Kalshi WS orderbook snapshot malformed");
        }
        return false;
      }
      this.orderbook = createKalshiBookState(orderbook, now);
      this.orderbookInSync = true;
      this.wsOrderbookReady = true;
      this.subscriptions[1] = toSubscriptionState(this.subscriptions[1], {
        status: "subscribed",
        source: "ws",
        lastMessageAt: now,
        details: "orderbook snapshot live",
      });
      this.lastWsMessageAt = now;
      this.lastError = null;
      console.info("[kalshi-ws] orderbook-ready", {
        endpoint: this.wsEndpointUrl,
        marketTicker: this.market?.ticker ?? null,
        slotKey: this.slotKey,
        seq: this.orderbook.seq,
      });
      return true;
    }

    if (type === "orderbook_delta") {
      const applied = this.applyKalshiDelta(
        {
          ...message,
          seq: payload.seq ?? message.seq,
        },
        now,
      );
      if (!applied) {
        return false;
      }
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
      if (this.wsOrderbookReady) {
        this.lastWsMessageAt = now;
      }
      return true;
    }

    return false;
  }

  private applyKalshiDelta(message: WsPayload, now: number) {
    if (!this.orderbook || !this.wsOrderbookReady) {
      this.orderbookInSync = false;
      this.lastError = "Kalshi WS delta received before orderbook snapshot";
      if (this.ws) {
        this.failWsSession(this.ws, this.lastError);
      }
      void this.resync(now);
      return false;
    }

    const nextSeq = parseNumeric(message.seq);
    if (nextSeq !== null && this.orderbook.seq !== null && nextSeq !== this.orderbook.seq + 1) {
      this.lastError = `Gap sequence Kalshi detecte: attendu ${this.orderbook.seq + 1}, recu ${nextSeq}`;
      this.orderbookInSync = false;
      if (this.ws) {
        this.failWsSession(this.ws, this.lastError);
      }
      void this.resync(now);
      return false;
    }

    const side = String(message.side ?? message.book_side ?? "").toLowerCase();
    const price = message.price_dollars ?? message.price ?? message.level;
    const delta = parseNumeric(
      message.delta_fp ?? message.delta ?? message.size ?? message.count ?? message.quantity ?? message.remaining,
    );
    if ((side !== "yes" && side !== "no") || parseNumeric(price) === null || delta === null) {
      this.orderbookInSync = false;
      this.lastError = "Kalshi WS orderbook delta malformed";
      if (this.ws) {
        this.failWsSession(this.ws, this.lastError);
      }
      void this.resync(now);
      return false;
    }
    if (side === "yes") {
      applyKalshiDeltaLevel(this.orderbook.yes, price, delta);
    } else if (side === "no") {
      applyKalshiDeltaLevel(this.orderbook.no, price, delta);
    }

    this.orderbook.seq = nextSeq ?? this.orderbook.seq;
    this.orderbook.lastUpdatedAt = now;
    this.orderbookInSync = true;
    return true;
  }

  private subscribe(
    ws: WebSocket,
    channel: string,
    marketTicker: string,
    cfBenchmarkIndexId?: KalshiCfBenchmarkIndexId,
  ) {
    const params =
      channel === KALSHI_CF_BENCHMARK_CHANNEL
        ? {
            channels: [channel],
            index_ids: cfBenchmarkIndexId ? [cfBenchmarkIndexId] : [],
          }
        : channel === "ticker"
          ? {
              channels: [channel],
              market_ticker: marketTicker,
            }
          : {
              channels: [channel],
              market_tickers: [marketTicker],
            };

    const commandId = this.nextSubscriptionId++;
    this.subscriptionCommands.set(commandId, channel);
    ws.send(
      JSON.stringify({
        id: commandId,
        cmd: "subscribe",
        params,
      }),
    );
    console.info("[kalshi-ws] subscribe-sent", {
      endpoint: this.wsEndpointUrl,
      marketTicker,
      slotKey: this.slotKey,
      commandId,
      channel,
      indexId: cfBenchmarkIndexId ?? null,
    });
  }

  private isOptionalSubscriptionChannel(channel: string) {
    return channel === KALSHI_CF_BENCHMARK_CHANNEL || channel === KALSHI_FILL_CHANNEL;
  }

  private optionalSubscriptionChannel(payload: WsPayload) {
    const message = payload?.msg ?? payload?.message ?? payload?.data ?? payload;
    const commandId = parseNumeric(payload?.id);
    const channel = String(
      message?.channel ?? (commandId === null ? "" : (this.subscriptionCommands.get(commandId) ?? "")),
    );
    return this.isOptionalSubscriptionChannel(channel) ? channel : null;
  }

  private markOptionalSubscriptionFailure(payload: WsPayload, channel: string, details: string) {
    const commandId = parseNumeric(payload?.id);
    if (commandId !== null) {
      this.subscriptionCommands.delete(commandId);
    }
    if (channel === KALSHI_CF_BENCHMARK_CHANNEL) {
      this.cfBenchmarks = null;
    } else if (channel === KALSHI_FILL_CHANNEL) {
      this.onPrivateFeedReset("kalshi", this.market?.ticker ?? null);
    }
    const index = this.subscriptions.findIndex((subscription) => subscription.channel === channel);
    if (index >= 0) {
      this.subscriptions[index] = toSubscriptionState(this.subscriptions[index], {
        status: "error",
        source: "unavailable",
        details,
      });
    }
    console.warn("[kalshi-ws] optional-subscription-failed", {
      endpoint: this.wsEndpointUrl,
      marketTicker: this.market?.ticker ?? null,
      slotKey: this.slotKey,
      commandId: payload?.id ?? null,
      channel,
      details,
    });
  }

  private isCurrentKalshiMarketMessage(message: WsPayload) {
    const marketTicker = message?.market_ticker;
    return !marketTicker || !this.market || marketTicker === this.market.ticker;
  }

  private restFallbackSource(): FeedSource {
    if (this.lastRestSyncAt === null) {
      return "unavailable";
    }
    return this.lastWsMessageAt === null ? "rest-bootstrap" : "rest-fallback";
  }

  private markWsFailure(details: string) {
    this.lastError = details;
    this.cfBenchmarks = null;
    const source = this.restFallbackSource();
    for (let index = 0; index < this.subscriptions.length; index += 1) {
      const subscriptionSource = this.isOptionalSubscriptionChannel(this.subscriptions[index].channel)
        ? "unavailable"
        : source;
      this.subscriptions[index] = toSubscriptionState(this.subscriptions[index], {
        status: "error",
        source: subscriptionSource,
        details,
      });
    }
  }

  private failWsSession(ws: WebSocket, details: string) {
    if (this.ws !== ws) {
      return;
    }
    this.markWsFailure(details);
    this.onPrivateFeedReset("kalshi", this.market?.ticker ?? null);
    console.warn("[kalshi-ws] session-failed", {
      endpoint: this.wsEndpointUrl,
      marketTicker: this.market?.ticker ?? null,
      slotKey: this.slotKey,
      details,
    });
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1011, "Kalshi WS session failed");
    }
  }

  private clearWsSessionTimers() {
    if (this.wsHeartbeat) {
      clearInterval(this.wsHeartbeat);
      this.wsHeartbeat = null;
    }
    if (this.wsBootstrapTimer) {
      clearTimeout(this.wsBootstrapTimer);
      this.wsBootstrapTimer = null;
    }
  }

  private async reset() {
    this.clearWsSessionTimers();
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    const ws = this.ws;
    const marketTicker = this.market?.ticker ?? null;
    this.ws = null;
    this.wsEndpointUrl = null;
    this.wsOrderbookReady = false;
    if (ws) {
      this.onPrivateFeedReset("kalshi", marketTicker);
    }
    ws?.close();
    this.asset = null;
    this.series = null;
    this.market = null;
    this.orderbook = null;
    this.orderbookInSync = true;
    this.trades = [];
    this.cfBenchmarks = null;
    this.lastRestSyncAt = null;
    this.lastWsMessageAt = null;
    this.lastError = null;
    this.reconnectAttempt = 0;
    this.wsEndpointIndex = 0;
    this.nextSubscriptionId = 1;
    this.subscriptionCommands.clear();
    this.subscriptions = emptySubscriptions(KALSHI_WS_CHANNELS, "rest-bootstrap");
  }

  async shutdown() {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.slotKey = null;
    const pending = [this.bootstrapPromise, this.resyncPromise].filter(
      (promise): promise is Promise<void> => promise !== null,
    );
    await this.reset();
    await Promise.allSettled(pending);
  }

  private isLiveOrderbook(now: number) {
    if (
      !this.orderbook ||
      !this.orderbookInSync ||
      !this.wsOrderbookReady ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      this.lastWsMessageAt === null
    ) {
      return false;
    }
    return now - this.lastWsMessageAt <= FEED_BLOCKED_MS;
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
    } else if (this.ws && !this.wsOrderbookReady) {
      details.push("Kalshi WS connecte, en attente du snapshot orderbook");
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
      details.push(
        `${subscription.channel}: ${subscription.status} · ${subscription.source} · ${age} · ${subscription.details ?? "--"}`,
      );
    }

    return details;
  }
}

export class MarketDataSupervisor {
  private fillTracker = new RealtimeOrderFillTracker();
  private feeds: Record<
    MarketAsset,
    {
      polymarket: PolymarketRealtimeFeed;
      kalshi: KalshiRealtimeFeed;
    }
  >;
  private shutdownPromise: Promise<void> | null = null;

  constructor() {
    const recordFill: PrivateFillListener = (fill) => {
      this.fillTracker.ingest(fill);
    };
    const resetPrivateFeed: PrivateFeedResetListener = (venue, marketRef) => {
      this.fillTracker.clearWaiters(venue, marketRef);
    };
    this.feeds = Object.fromEntries(
      MARKET_ASSETS.map((asset) => [
        asset,
        {
          polymarket: new PolymarketRealtimeFeed(recordFill, resetPrivateFeed),
          kalshi: new KalshiRealtimeFeed(recordFill, resetPrivateFeed),
        },
      ]),
    ) as Record<MarketAsset, { polymarket: PolymarketRealtimeFeed; kalshi: KalshiRealtimeFeed }>;
  }

  waitForOrderFill(request: WaitForOrderFillRequest) {
    return this.fillTracker.wait(request);
  }

  readRecentOrderFills(request: ReadRecentOrderFillsRequest = {}) {
    return this.fillTracker.read(request);
  }

  async ensureSlot(slot: MarketSlot, now = Date.now()) {
    const feeds = this.feeds[slot.asset];
    await Promise.allSettled([feeds.polymarket.ensureSlot(slot, now), feeds.kalshi.ensureSlot(slot, now)]);
  }

  async readSlotState(slot: MarketSlot, now = Date.now()) {
    await this.ensureSlot(slot, now);
    const feeds = this.feeds[slot.asset];
    const polymarket = feeds.polymarket.buildState(slot, now);
    const kalshi = feeds.kalshi.buildState(slot, now);
    return { polymarket, kalshi };
  }

  shutdown() {
    if (!this.shutdownPromise) {
      this.fillTracker.clearAllWaiters();
      this.shutdownPromise = Promise.allSettled(
        Object.values(this.feeds).flatMap((feeds) => [feeds.polymarket.shutdown(), feeds.kalshi.shutdown()]),
      ).then((results) => {
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason);
        if (failures.length > 0) {
          throw new AggregateError(failures, "Market-data shutdown failed");
        }
      });
    }
    return this.shutdownPromise;
  }
}

let singleton: MarketDataSupervisor | null = null;

export function getMarketDataSupervisor() {
  if (!singleton) {
    singleton = new MarketDataSupervisor();
  }

  return singleton;
}

export async function shutdownMarketDataSupervisor() {
  const supervisor = singleton;
  await supervisor?.shutdown();
  if (singleton === supervisor) {
    singleton = null;
  }
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
    bids.unshift([String(round4(state.bestBidPrice)), String(state.bestBidSize ?? highestKnownSize(state.bids))]);
  }

  if (state.bestAskPrice !== null) {
    asks.unshift([String(round4(state.bestAskPrice)), String(state.bestAskSize ?? highestKnownSize(state.asks))]);
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

function normalizeKalshiWsOrderbook(message: WsPayload): KalshiOrderbook | null {
  const candidates = [message.orderbook_fp, message.orderbook, message];

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
      candidate.no_dollars_fp ?? candidate.no_dollars ?? candidate.no ?? candidate.orderbook_no ?? candidate.no_book;

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
      Array.isArray(level)
        ? ([String(level[0]), String(level[1])] as [string, string])
        : ([String(level.price), String(level.size)] as [string, string]),
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
    subscriptions: emptySubscriptions(KALSHI_WS_CHANNELS, "unavailable"),
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
    priceLevelStructure: null,
    priceRanges: null,
    cfBenchmarks: null,
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

function applyKalshiDeltaLevel(levels: LevelMap, price: unknown, deltaFp: number) {
  const normalizedPrice = String(price);
  const current = levels.get(normalizedPrice) ?? 0;
  const next = round4(current + deltaFp);

  if (!Number.isFinite(next) || next <= 0) {
    levels.delete(normalizedPrice);
    return;
  }

  levels.set(normalizedPrice, next);
}

function deriveComplementPrice(value: unknown) {
  const numeric = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return round4(1 - numeric);
}
