import crypto from "node:crypto";

import {
  KALSHI_DEMO_BASE,
  KALSHI_PROD_BASE,
  KALSHI_WS_DEMO_BASE,
  KALSHI_WS_DEMO_FALLBACK_BASE,
  KALSHI_WS_PROD_BASE,
  KALSHI_WS_PROD_FALLBACK_BASE,
} from "@/lib/constants";
import { hasKalshiCredentials, readEnv, readSecretValue } from "@/lib/env";
import { assertProductionVenueEnvironment } from "@/lib/execution-safety";
import { fetchJson } from "@/lib/fetch-json";
import { getMarketCatalogEntry, inferKalshiAsset } from "@/lib/market-catalog";
import type {
  ChartPriceSurface,
  ExecutionPriceSurface,
  KalshiQuote,
  LiveFill,
  LiveOrder,
  MarketSlot,
  OrderSide,
  OutcomeQuote,
  PositionSnapshot,
  VenueAdapter,
  VenueBalance,
  VenueOrderRequest,
  VenueOrderResult,
  VenueOrderStatus,
} from "@/lib/types";

export type KalshiMarketSummary = {
  ticker: string;
  event_ticker: string;
  title: string;
  updated_time?: string;
  floor_strike?: string | number;
  cap_strike?: string | number;
  strike_type?: string;
  expiration_value?: string | number | null;
  open_time: string;
  close_time: string;
  status: string;
  result?: "yes" | "no" | "";
  yes_bid_dollars: string;
  yes_ask_dollars: string;
  no_bid_dollars: string;
  no_ask_dollars: string;
  last_price_dollars?: string;
  yes_bid_size_fp: string;
  yes_ask_size_fp: string;
  no_bid_size_fp: string;
  no_ask_size_fp: string;
};

type KalshiMarketList = {
  markets: KalshiMarketSummary[];
  cursor?: string | null;
};

type KalshiSeriesResponse = {
  series: {
    ticker: string;
    fee_multiplier: number;
    fee_type: string;
    title: string;
  };
};

type KalshiMarketResponse = {
  market: KalshiMarketSummary;
};

export type FinalizedKalshiResolutionObservation = {
  resolution: "YES" | "NO";
  benchmarkValueUsd: number | null;
  benchmarkSource: "kalshi-expiration-value" | null;
};

export type KalshiOrderbook = {
  yes_dollars: Array<[string, string]>;
  no_dollars: Array<[string, string]>;
  seq?: number | string;
};

export type KalshiNumericOrderbookLevels = {
  yesBids: Array<[number, number]>;
  noBids: Array<[number, number]>;
};

type KalshiOrderbookResponse = {
  orderbook?: KalshiOrderbook;
  orderbook_fp?: KalshiOrderbook;
  yes_dollars?: Array<[string, string]>;
  no_dollars?: Array<[string, string]>;
  seq?: number | string;
};

export type KalshiTrade = {
  trade_id?: string;
  ticker?: string;
  market_ticker?: string;
  yes_price_dollars?: string;
  no_price_dollars?: string;
  price_dollars?: string;
  created_time?: string;
  ts?: number;
};

type KalshiTradesResponse = {
  trades: KalshiTrade[];
};

type KalshiBalanceResponse = {
  balance: number;
  portfolio_value: number;
  updated_ts: number;
};

type KalshiBalanceSummary = {
  availableBalanceUsd: number;
  portfolioValueUsd: number;
  totalBalanceUsd: number;
  notes: string[];
};

export type KalshiPosition = {
  ticker: string;
  position_fp: string;
  total_traded_dollars: string;
  market_exposure_dollars: string;
  realized_pnl_dollars: string;
  fees_paid_dollars: string;
  last_updated_ts: string;
};

type KalshiPositionsResponse = {
  market_positions: KalshiPosition[];
};

type KalshiOrderResponse = {
  order: {
    order_id: string;
    client_order_id?: string;
    ticker: string;
    side: "yes" | "no";
    action: "buy" | "sell";
    status: string;
    yes_price_dollars?: string;
    no_price_dollars?: string;
    fill_count_fp?: string;
    remaining_count_fp?: string;
    initial_count_fp?: string;
    taker_fees_dollars?: string;
    maker_fees_dollars?: string;
    created_time?: string;
    last_update_time?: string;
  };
};

const SLOT_TOLERANCE_MS = 60_000;
const KALSHI_SLOT_PREFETCH_MS = 15 * 60 * 1_000;
const KALSHI_CURRENT_MARKETS_LIMIT = 100;
const KALSHI_MARKETS_PAGE_LIMIT = 1_000;
const KALSHI_MARKETS_MAX_PAGES = 10;

export function getKalshiBaseUrl() {
  const env = readEnv();
  return env.KALSHI_ENV === "demo" ? KALSHI_DEMO_BASE : KALSHI_PROD_BASE;
}

export function getKalshiMarketDataBaseUrl() {
  const env = readEnv();
  if (!hasKalshiCredentials(env)) {
    return KALSHI_PROD_BASE;
  }

  return env.KALSHI_ENV === "demo" ? KALSHI_DEMO_BASE : KALSHI_PROD_BASE;
}

export function getKalshiWsUrl() {
  return getKalshiWsUrls()[0];
}

export function getKalshiWsUrls() {
  const env = readEnv();
  return env.KALSHI_ENV === "demo"
    ? [KALSHI_WS_DEMO_BASE, KALSHI_WS_DEMO_FALLBACK_BASE]
    : [KALSHI_WS_PROD_BASE, KALSHI_WS_PROD_FALLBACK_BASE];
}

export async function fetchKalshiQuote(slot: MarketSlot): Promise<KalshiQuote> {
  const marketConfig = getMarketCatalogEntry(slot.asset);
  const [list, series] = await Promise.all([
    fetchKalshiMarketsForSlot(slot),
    fetchKalshiSeries(slot.asset),
  ]);

  const market = resolveKalshiMarketForSlot(list.markets, slot);
  if (!market) {
    return createUnavailableKalshiQuote(
      slot,
      series.series,
      "Marché Kalshi du créneau courant indisponible",
    );
  }

  const freshMarketResponse = await fetchJson<KalshiMarketResponse>(
    `${getKalshiMarketDataBaseUrl()}/markets/${market.ticker}`,
  ).catch(() => null);
  const freshMarket = freshMarketResponse?.market ?? market;
  const derived = deriveKalshiOutcomeQuotesFromMarket(freshMarket);
  const lastTradeYesPrice = parseMarketPrice(freshMarket.last_price_dollars);

  return {
    ref: {
      asset: slot.asset,
      venue: "kalshi",
      id: freshMarket.ticker,
      slotKey: buildSlotKeyFromIso(slot.asset, freshMarket.open_time),
      ticker: freshMarket.ticker,
      eventTicker: freshMarket.event_ticker,
      title: freshMarket.title,
      url: `https://kalshi.com/markets/${marketConfig.kalshiEventPath}/${freshMarket.event_ticker.toLowerCase()}`,
      startTime: freshMarket.open_time,
      endTime: freshMarket.close_time,
    },
    status: freshMarket.status,
    slotAligned: true,
    availabilityReason: null,
    feedHealth: createVenueFeedHealth({
      asset: slot.asset,
      venue: "kalshi",
      feedStatus: "ready",
      source: "rest-bootstrap",
      lastMessageAt: Date.now(),
      stalenessMs: 0,
      details: ["Quote bootstrap via REST market summary"],
      subscriptions: [],
    }),
    lastMessageAt: Date.now(),
    stalenessMs: 0,
    source: "rest-bootstrap",
    outcomes: derived,
    targetPriceUsd: parseNumeric(freshMarket.floor_strike),
    feeMultiplier: series.series.fee_multiplier,
    feeType: series.series.fee_type,
    lastTradeYesPrice,
    lastTradeNoPrice: lastTradeYesPrice === null ? null : round4(1 - lastTradeYesPrice),
    resolution: null,
  };
}

export function resolveKalshiMarketForSlot(
  markets: KalshiMarketSummary[],
  slot: MarketSlot,
) {
  return (
    [...markets]
      .filter(
        (candidate) =>
          withinTolerance(Date.parse(candidate.open_time), slot.startTs) &&
          withinTolerance(Date.parse(candidate.close_time), slot.endTs),
      )
      .sort((left, right) => {
        const statusDelta = getStatusRank(left.status) - getStatusRank(right.status);
        if (statusDelta !== 0) {
          return statusDelta;
        }

        return Date.parse(left.open_time) - Date.parse(right.open_time);
      })[0] ?? null
  );
}

export async function fetchKalshiResolution(ticker: string) {
  const response = await fetchJson<KalshiMarketResponse>(`${getKalshiMarketDataBaseUrl()}/markets/${ticker}`);
  const status = response.market.status?.toLowerCase?.() ?? "";
  const terminalStatuses = new Set(["determined", "settled", "finalized"]);
  if (!terminalStatuses.has(status) || !response.market.result) {
    return null;
  }

  return response.market.result === "yes" ? ("YES" as const) : ("NO" as const);
}

export async function fetchFinalizedKalshiResolution(ticker: string) {
  const response = await fetchJson<KalshiMarketResponse>(`${getKalshiMarketDataBaseUrl()}/markets/${ticker}`);
  const status = response.market.status?.toLowerCase?.() ?? "";
  if (status !== "finalized" || !response.market.result) {
    return null;
  }

  const result = response.market.result.toLowerCase();
  if (result === "yes") {
    return "YES" as const;
  }
  if (result === "no") {
    return "NO" as const;
  }
  return null;
}

export async function fetchFinalizedKalshiResolutionObservation(
  ticker: string,
): Promise<FinalizedKalshiResolutionObservation | null> {
  const response = await fetchJson<KalshiMarketResponse>(
    `${getKalshiMarketDataBaseUrl()}/markets/${ticker}`,
  );
  const market = response.market;
  const status = market.status?.toLowerCase?.() ?? "";
  const result = market.result?.toLowerCase?.() ?? "";
  if (status !== "finalized" || (result !== "yes" && result !== "no")) {
    return null;
  }
  const resolution = result === "yes" ? "YES" : "NO";
  const expirationValue = readPositiveFiniteMarketNumber(market.expiration_value);
  const floorStrike = readPositiveFiniteMarketNumber(market.floor_strike);
  const capStrike = readPositiveFiniteMarketNumber(market.cap_strike);
  const strikeType = market.strike_type?.toLowerCase?.() ?? "";
  const impliedResolution = deriveKalshiStrikeResolution({
    expirationValue,
    floorStrike,
    capStrike,
    strikeType,
  });
  const benchmarkValueUsd = impliedResolution === resolution ? expirationValue : null;

  return {
    resolution,
    benchmarkValueUsd,
    benchmarkSource:
      benchmarkValueUsd === null ? null : "kalshi-expiration-value",
  };
}

function deriveKalshiStrikeResolution(input: {
  expirationValue: number | null;
  floorStrike: number | null;
  capStrike: number | null;
  strikeType: string;
}): "YES" | "NO" | null {
  if (input.expirationValue === null) {
    return null;
  }
  if (input.strikeType === "greater" && input.floorStrike !== null) {
    return input.expirationValue > input.floorStrike ? "YES" : "NO";
  }
  if (input.strikeType === "greater_or_equal" && input.floorStrike !== null) {
    return input.expirationValue >= input.floorStrike ? "YES" : "NO";
  }
  if (input.strikeType === "less" && input.capStrike !== null) {
    return input.expirationValue < input.capStrike ? "YES" : "NO";
  }
  if (input.strikeType === "less_or_equal" && input.capStrike !== null) {
    return input.expirationValue <= input.capStrike ? "YES" : "NO";
  }
  return null;
}

function readPositiveFiniteMarketNumber(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export async function fetchKalshiSeries(asset: MarketSlot["asset"]) {
  const marketConfig = getMarketCatalogEntry(asset);
  return fetchJson<KalshiSeriesResponse>(
    `${getKalshiMarketDataBaseUrl()}/series/${marketConfig.kalshiSeriesTicker}`,
  );
}

export async function fetchKalshiMarketsForSlot(slot: MarketSlot) {
  const targeted = await fetchKalshiMarketsForSlotWindow(slot);
  if (resolveKalshiMarketForSlot(targeted.markets, slot)) {
    return targeted;
  }

  return fetchKalshiMarkets(slot.asset);
}

export async function fetchKalshiMarkets(asset: MarketSlot["asset"]) {
  const marketConfig = getMarketCatalogEntry(asset);
  const markets: KalshiMarketSummary[] = [];
  const seenTickers = new Set<string>();
  let cursor: string | null | undefined = null;

  for (let page = 0; page < KALSHI_MARKETS_MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      series_ticker: marketConfig.kalshiSeriesTicker,
      limit: String(KALSHI_MARKETS_PAGE_LIMIT),
    });

    if (cursor) {
      params.set("cursor", cursor);
    }

    const response = await fetchJson<KalshiMarketList>(`${getKalshiMarketDataBaseUrl()}/markets?${params.toString()}`);
    for (const market of response.markets ?? []) {
      if (seenTickers.has(market.ticker)) {
        continue;
      }
      seenTickers.add(market.ticker);
      markets.push(market);
    }

    cursor = response.cursor;
    if (!cursor || response.markets.length === 0) {
      break;
    }
  }

  return { markets };
}

async function fetchKalshiMarketsForSlotWindow(slot: MarketSlot) {
  const marketConfig = getMarketCatalogEntry(slot.asset);
  const params = new URLSearchParams({
    series_ticker: marketConfig.kalshiSeriesTicker,
    min_close_ts: String(Math.floor((slot.endTs - SLOT_TOLERANCE_MS) / 1_000)),
    max_close_ts: String(Math.ceil((slot.endTs + KALSHI_SLOT_PREFETCH_MS + SLOT_TOLERANCE_MS) / 1_000)),
    limit: String(KALSHI_CURRENT_MARKETS_LIMIT),
  });

  const response = await fetchJson<KalshiMarketList>(`${getKalshiMarketDataBaseUrl()}/markets?${params.toString()}`);
  return { markets: response.markets ?? [] };
}

export async function fetchKalshiMarket(ticker: string) {
  return fetchJson<KalshiMarketResponse>(`${getKalshiMarketDataBaseUrl()}/markets/${ticker}`);
}

export async function fetchKalshiTrades(ticker: string) {
  const params = new URLSearchParams({
    ticker,
    limit: "20",
  });

  return kalshiMarketDataFetch<KalshiTradesResponse>(`/markets/trades?${params.toString()}`);
}

export async function fetchKalshiOrderbook(ticker: string) {
  const response = await kalshiMarketDataFetch<KalshiOrderbookResponse>(`/markets/${ticker}/orderbook`);
  return normalizeKalshiOrderbookResponse(response);
}

export function deriveKalshiOutcomeQuotesFromMarket(market: KalshiMarketSummary) {
  return deriveKalshiOutcomeQuotesFromMarketWithSource(market, "rest-bootstrap");
}

export function deriveKalshiOutcomeQuotesFromMarketWithSource(
  market: KalshiMarketSummary,
  source: ChartPriceSurface["source"] = "rest-bootstrap",
  lastUpdatedAtOverride?: number | null,
) {
  const yesBid = parseMarketPrice(market.yes_bid_dollars);
  const yesAsk = parseMarketPrice(market.yes_ask_dollars);
  const noBid = parseMarketPrice(market.no_bid_dollars);
  const noAsk = parseMarketPrice(market.no_ask_dollars);
  const updatedAt =
    lastUpdatedAtOverride ??
    (market.updated_time ? Date.parse(market.updated_time) || Date.now() : Date.now());

  const yesOutcome = createOutcomeQuote({
    outcome: "YES",
    buyPrice: yesAsk,
    sellPrice: yesBid,
    midPrice: yesAsk !== null && yesBid !== null ? round4((yesAsk + yesBid) / 2) : null,
    bestBid: yesBid,
    bestAsk: yesAsk,
    depth: parseMarketSize(market.yes_ask_size_fp),
    tickSize: 0.001,
    minOrderSize: 1,
    feeRateBps: null,
    source,
    lastUpdatedAt: updatedAt,
  });

  const noOutcome = createOutcomeQuote({
    outcome: "NO",
    buyPrice: noAsk,
    sellPrice: noBid,
    midPrice: noAsk !== null && noBid !== null ? round4((noAsk + noBid) / 2) : null,
    bestBid: noBid,
    bestAsk: noAsk,
    depth: parseMarketSize(market.no_ask_size_fp),
    tickSize: 0.001,
    minOrderSize: 1,
    feeRateBps: null,
    source,
    lastUpdatedAt: updatedAt,
  });

  return {
    yes: yesOutcome,
    no: noOutcome,
  };
}

export function deriveKalshiOutcomeQuotes(
  orderbook: {
    yes_dollars: Array<[string, string]>;
    no_dollars: Array<[string, string]>;
  },
  source: ChartPriceSurface["source"] = "rest-fallback",
  lastUpdatedAt: number | null = null,
) {
  const yesBidLevel = getBestLevel(orderbook.yes_dollars);
  const noBidLevel = getBestLevel(orderbook.no_dollars);

  const yesBid = yesBidLevel?.price ?? null;
  const noBid = noBidLevel?.price ?? null;
  const yesAsk = noBid === null ? null : round4(1 - noBid);
  const noAsk = yesBid === null ? null : round4(1 - yesBid);

  return {
    yes: createOutcomeQuote({
      outcome: "YES" as const,
      buyPrice: yesAsk,
      sellPrice: yesBid,
      midPrice: yesAsk !== null && yesBid !== null ? round4((yesAsk + yesBid) / 2) : null,
      bestBid: yesBid,
      bestAsk: yesAsk,
      depth: noBidLevel?.size ?? null,
      tickSize: 0.001,
      minOrderSize: 1,
      feeRateBps: null,
      source,
      lastUpdatedAt,
    }),
    no: createOutcomeQuote({
      outcome: "NO" as const,
      buyPrice: noAsk,
      sellPrice: noBid,
      midPrice: noAsk !== null && noBid !== null ? round4((noAsk + noBid) / 2) : null,
      bestBid: noBid,
      bestAsk: noAsk,
      depth: yesBidLevel?.size ?? null,
      tickSize: 0.001,
      minOrderSize: 1,
      feeRateBps: null,
      source,
      lastUpdatedAt,
    }),
  };
}

export function normalizeKalshiNumericOrderbookLevels(orderbook: {
  yes_dollars: Array<[string, string]>;
  no_dollars: Array<[string, string]>;
}): KalshiNumericOrderbookLevels {
  return {
    yesBids: normalizeKalshiLevelPairs(orderbook.yes_dollars),
    noBids: normalizeKalshiLevelPairs(orderbook.no_dollars),
  };
}

export function computeKalshiBuyDepthWithinPriceRange(
  levels: KalshiNumericOrderbookLevels | null | undefined,
  outcome: "YES" | "NO",
  maxBuyPrice: number | null,
) {
  if (!levels || maxBuyPrice === null || maxBuyPrice <= 0) {
    return null;
  }

  const executableDepth = deriveKalshiBuyPriceLevels(levels, outcome).reduce((sum, [price, size]) => {
    if (price > maxBuyPrice + 1e-9) {
      return sum;
    }
    return sum + size;
  }, 0);

  return round4(executableDepth);
}

export function deriveKalshiBuyPriceLevels(
  levels: KalshiNumericOrderbookLevels | null | undefined,
  outcome: "YES" | "NO",
) {
  if (!levels) {
    return [];
  }

  const sourceLevels = outcome === "YES" ? levels.noBids : levels.yesBids;
  return sourceLevels
    .map(([price, size]) => [round4(1 - price), size] as [number, number])
    .sort((left, right) => left[0] - right[0]);
}

export function mapKalshiPosition(position: KalshiPosition, now = Date.now()): PositionSnapshot {
  const signedSize = Number(position.position_fp);
  const size = Math.abs(signedSize);
  const totalTradedUsd = Number(position.total_traded_dollars);
  const currentValueUsd = Number(position.market_exposure_dollars);
  const asset = inferKalshiAsset(position.ticker);

  return {
    id: `kalshi:${position.ticker}`,
    asset,
    venue: "kalshi",
    marketRef: position.ticker,
    outcome: signedSize >= 0 ? "YES" : "NO",
    size,
    averagePrice: size > 0 ? round4(totalTradedUsd / size) : null,
    currentPrice: size > 0 ? round4(currentValueUsd / size) : null,
    currentValueUsd,
    realizedPnlUsd: Number(position.realized_pnl_dollars),
    unrealizedPnlUsd: round4(currentValueUsd - totalTradedUsd),
    redeemable: false,
    mergeable: false,
    updatedAt: Date.parse(position.last_updated_ts) || now,
    raw: position as unknown as Record<string, unknown>,
  };
}

export function isTrackedKalshiPosition(position: PositionSnapshot) {
  return (
    position.size > 0.0001 ||
    Math.abs(position.currentValueUsd) > 0.0001 ||
    Math.abs(position.unrealizedPnlUsd) > 0.0001
  );
}

export function extractKalshiLastTradePrices(
  trades: KalshiTrade[],
  fallbackLastPrice?: number | null,
) {
  const latestTrade = [...trades]
    .sort((left, right) => getTradeTimestamp(right) - getTradeTimestamp(left))[0];

  if (!latestTrade) {
    return {
      yes: fallbackLastPrice ?? null,
      no: fallbackLastPrice === null || fallbackLastPrice === undefined ? null : round4(1 - fallbackLastPrice),
      lastUpdatedAt: null,
    };
  }

  const yesPrice =
    parseMarketPrice(latestTrade.yes_price_dollars) ??
    (parseMarketPrice(latestTrade.price_dollars) ?? fallbackLastPrice ?? null);

  return {
    yes: yesPrice,
    no: yesPrice === null ? null : round4(1 - yesPrice),
    lastUpdatedAt: getTradeTimestamp(latestTrade),
  };
}

export function createKalshiAdapter(): VenueAdapter {
  return {
    venue: "kalshi",
    async getBalance() {
      if (!hasKalshiCredentials()) {
        return {
          venue: "kalshi",
          capturedAt: Date.now(),
          status: "blocked",
          currency: "USD",
          availableBalanceUsd: 0,
          totalBalanceUsd: 0,
          portfolioValueUsd: 0,
          allowanceUsd: null,
          notes: ["Credentials Kalshi manquants."],
          raw: {},
        };
      }

      const response = await kalshiFetch<KalshiBalanceResponse>("/portfolio/balance");
      return mapKalshiBalance(response, Date.now());
    },
    async getPositions(now = Date.now()) {
      if (!hasKalshiCredentials()) {
        return [];
      }

      const response = await kalshiFetch<KalshiPositionsResponse>("/portfolio/positions");
      return response.market_positions
        .map((position) => mapKalshiPosition(position, now))
        .filter(isTrackedKalshiPosition);
    },
    async placeOrder(order) {
      assertProductionVenueEnvironment();
      try {
        const response = await createKalshiOrder(order);
        return mapKalshiOrderResult(response.order);
      } catch (error) {
        const noFillMessage = getKalshiSoftNoFillMessage(error);
        if (noFillMessage) {
          return {
            venue: "kalshi",
            venueOrderId: `killed:${order.clientOrderId}`,
            status: "canceled",
            filledSize: 0,
            averageFillPrice: null,
            feeUsd: 0,
            raw: {
              softNoFill: true,
              error: noFillMessage,
              clientOrderId: order.clientOrderId,
              marketRef: order.marketRef,
              orderType: order.orderType,
            },
          };
        }

        throw error;
      }
    },
    async cancelOrder(orderId: string) {
      await kalshiFetch(`/portfolio/orders/${orderId}`, {
        method: "DELETE",
      });
    },
    async getOrder(orderId: string) {
      const response = await kalshiFetch<KalshiOrderResponse>(`/portfolio/orders/${orderId}`);
      return mapKalshiLiveOrder(response.order, "unknown");
    },
  };
}

export async function fetchKalshiOrders(status?: string) {
  if (!hasKalshiCredentials()) {
    return [];
  }

  const params = new URLSearchParams();
  if (status) {
    params.set("status", status);
  }

  const response = await kalshiFetch<{ orders: KalshiOrderResponse["order"][] }>(
    `/portfolio/orders${params.size > 0 ? `?${params.toString()}` : ""}`,
  );

  return response.orders;
}

export async function fetchKalshiFills() {
  if (!hasKalshiCredentials()) {
    return [];
  }

  const response = await kalshiFetch<{
    fills: Array<{
      trade_id: string;
      order_id: string;
      market_ticker: string;
      is_taker: boolean;
      side: "yes" | "no";
      action: "buy" | "sell";
      yes_price_dollars?: string;
      no_price_dollars?: string;
      count_fp: string;
      taker_fees_dollars?: string;
      maker_fees_dollars?: string;
      fees_paid_dollars?: string;
      created_time?: string;
      ts?: number;
    }>;
  }>("/portfolio/fills");

  return response.fills;
}

export function getKalshiFillPriceUsd(fill: {
  side: "yes" | "no";
  yes_price_dollars?: string;
  no_price_dollars?: string;
}) {
  const directPrice = fill.side === "yes" ? fill.yes_price_dollars : fill.no_price_dollars;
  if (directPrice !== undefined) {
    return Number(directPrice);
  }

  const complementSource = fill.side === "yes" ? fill.no_price_dollars : fill.yes_price_dollars;
  if (complementSource !== undefined) {
    return round4(1 - Number(complementSource));
  }

  return null;
}

export function getKalshiOrderPriceUsd(
  outcome: "YES" | "NO",
  prices: {
    yes_price_dollars?: string;
    no_price_dollars?: string;
  },
) {
  const directPrice = outcome === "YES" ? prices.yes_price_dollars : prices.no_price_dollars;
  if (directPrice !== undefined) {
    return Number(directPrice);
  }

  const complementSource = outcome === "YES" ? prices.no_price_dollars : prices.yes_price_dollars;
  if (complementSource !== undefined) {
    return round4(1 - Number(complementSource));
  }

  return null;
}

export function getKalshiFillFeeUsd(fill: {
  taker_fees_dollars?: string;
  maker_fees_dollars?: string;
  fees_paid_dollars?: string;
}) {
  return Number(fill.fees_paid_dollars ?? fill.taker_fees_dollars ?? fill.maker_fees_dollars ?? 0);
}

export function mapKalshiFillToLiveFill(
  fill: {
    trade_id: string;
    order_id: string;
    market_ticker: string;
    is_taker: boolean;
    side: "yes" | "no";
    action: "buy" | "sell";
    yes_price_dollars?: string;
    no_price_dollars?: string;
    count_fp: string;
    taker_fees_dollars?: string;
    maker_fees_dollars?: string;
    fees_paid_dollars?: string;
    created_time?: string;
  },
  order: Pick<LiveOrder, "intentId" | "venueOrderId" | "marketRef" | "side"> & { outcome: "YES" | "NO" },
  now = Date.now(),
): LiveFill {
  const asset = inferKalshiAsset(order.marketRef);
  return {
    id: `kalshi-fill:${fill.trade_id}`,
    asset,
    shadow: false,
    intentId: order.intentId,
    venue: "kalshi",
    venueOrderId: order.venueOrderId,
    tradeId: fill.trade_id,
    marketRef: order.marketRef,
    side: order.side,
    outcome: order.outcome,
    price:
      getKalshiOrderPriceUsd(order.outcome, {
        yes_price_dollars: fill.yes_price_dollars,
        no_price_dollars: fill.no_price_dollars,
      }) ??
      getKalshiFillPriceUsd(fill) ??
      0,
    size: Number(fill.count_fp),
    feeUsd: getKalshiFillFeeUsd(fill),
    liquidity: fill.is_taker ? "TAKER" : "MAKER",
    filledAt: fill.created_time ? Date.parse(fill.created_time) : now,
    raw: fill as unknown as Record<string, unknown>,
  };
}

async function createKalshiOrder(order: VenueOrderRequest) {
  const payload: Record<string, unknown> = {
    ticker: order.marketRef,
    client_order_id: order.clientOrderId,
    action: order.side === "BUY" ? "buy" : "sell",
    count_fp: formatCount(order.size),
    type: "limit",
    time_in_force: order.orderType === "FOK" ? "fill_or_kill" : "immediate_or_cancel",
  };

  if (order.outcome === "YES") {
    payload.side = "yes";
    payload.yes_price_dollars = formatPrice(order.price);
  } else if (order.outcome === "NO") {
    payload.side = "no";
    payload.no_price_dollars = formatPrice(order.price);
  } else {
    throw new Error(`Outcome Kalshi invalide: ${order.outcome}`);
  }

  if (order.side === "BUY") {
    payload.buy_max_cost = Math.ceil(order.maxCostUsd * 100);
  } else {
    payload.reduce_only = Boolean(order.reduceOnly);
  }

  return kalshiFetch<KalshiOrderResponse>("/portfolio/orders", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function kalshiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const env = readEnv();
  if (!env.KALSHI_API_KEY_ID || (!env.KALSHI_PRIVATE_KEY_PEM && !env.KALSHI_PRIVATE_KEY_PATH)) {
    throw new Error("Kalshi credentials missing");
  }

  const method = init?.method?.toUpperCase() ?? "GET";
  const timestamp = Date.now().toString();
  const baseUrl = getKalshiBaseUrl();
  const privateKey = readSecretValue({
    inline: env.KALSHI_PRIVATE_KEY_PEM,
    path: env.KALSHI_PRIVATE_KEY_PATH,
    label: "KALSHI_PRIVATE_KEY",
  });
  const signature = signKalshiRequest(privateKey, timestamp, method, buildKalshiSigningPath(baseUrl, path));
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "KALSHI-ACCESS-KEY": env.KALSHI_API_KEY_ID,
      "KALSHI-ACCESS-SIGNATURE": signature,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
    signal: init?.signal ?? AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Kalshi HTTP ${response.status}: ${body.slice(0, 240)}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function signKalshiRequest(privateKeyPem: string, timestamp: string, method: string, path: string) {
  const message = `${timestamp}${method}${path.split("?")[0]}`;
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

export function buildKalshiSigningPath(baseUrl: string, path: string) {
  return new URL(`${baseUrl}${path}`).pathname;
}

export function deriveKalshiBalanceSummary(response: KalshiBalanceResponse): KalshiBalanceSummary {
  const availableBalanceUsd = centsToUsd(response.balance);
  const reportedPortfolioValueUsd = centsToUsd(response.portfolio_value);

  if (reportedPortfolioValueUsd + 1e-9 < availableBalanceUsd) {
    return {
      availableBalanceUsd,
      portfolioValueUsd: availableBalanceUsd,
      totalBalanceUsd: availableBalanceUsd,
      notes: ["Kalshi portfolio_value inferieur au cash disponible; fallback sur le solde cash."],
    };
  }

  return {
    availableBalanceUsd,
    portfolioValueUsd: reportedPortfolioValueUsd,
    totalBalanceUsd: reportedPortfolioValueUsd,
    notes: [],
  };
}

export function mapKalshiBalance(
  response: KalshiBalanceResponse,
  capturedAt = Date.now(),
): VenueBalance {
  const summary = deriveKalshiBalanceSummary(response);

  return {
    venue: "kalshi",
    capturedAt,
    status: "ready",
    currency: "USD",
    availableBalanceUsd: summary.availableBalanceUsd,
    totalBalanceUsd: summary.totalBalanceUsd,
    portfolioValueUsd: summary.portfolioValueUsd,
    allowanceUsd: null,
    notes: summary.notes,
    raw: {
      ...response,
      sourceUpdatedAtMs: normalizeKalshiTimestampMs(response.updated_ts),
    },
  };
}

function normalizeKalshiTimestampMs(timestamp: number) {
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    return null;
  }

  return Math.round(timestamp < 1_000_000_000_000 ? timestamp * 1_000 : timestamp);
}

function createUnavailableKalshiQuote(
  slot: MarketSlot,
  series: KalshiSeriesResponse["series"],
  availabilityReason: string,
): KalshiQuote {
  const marketConfig = getMarketCatalogEntry(slot.asset);
  const feedHealth = createVenueFeedHealth({
    asset: slot.asset,
    venue: "kalshi",
    feedStatus: "blocked",
    source: "unavailable",
    lastMessageAt: null,
    stalenessMs: null,
    details: [availabilityReason],
    subscriptions: [],
  });

  return {
    ref: {
      asset: slot.asset,
      venue: "kalshi",
      id: `${marketConfig.kalshiSeriesTicker}-${slot.key}`,
      slotKey: slot.key,
      ticker: undefined,
      title: series.title,
      url: `https://kalshi.com/markets/${marketConfig.kalshiEventPath}`,
      startTime: slot.startIso,
      endTime: slot.endIso,
    },
    status: "pending",
    slotAligned: false,
    availabilityReason,
    feedHealth,
    lastMessageAt: null,
    stalenessMs: null,
    source: "unavailable",
    outcomes: {
      yes: emptyOutcome("YES", "unavailable", null),
      no: emptyOutcome("NO", "unavailable", null),
    },
    targetPriceUsd: null,
    feeMultiplier: series.fee_multiplier,
    feeType: series.fee_type,
    lastTradeYesPrice: null,
    lastTradeNoPrice: null,
    resolution: null,
  };
}

function getBestLevel(levels: Array<[string, string]>) {
  if (levels.length === 0) {
    return null;
  }

  return levels
    .map(([levelPrice, levelSize]) => ({
      price: Number(levelPrice),
      size: Number(levelSize),
    }))
    .sort((left, right) => right.price - left.price)[0];
}

function parseMarketPrice(value: string | undefined) {
  return parseNumeric(value);
}

function parseMarketSize(value: string | undefined) {
  return parseNumeric(value);
}

function parseNumeric(value: string | number | undefined) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function createOutcomeQuote(input: {
  outcome: "YES" | "NO";
  buyPrice: number | null;
  sellPrice: number | null;
  midPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  depth: number | null;
  tickSize: number | null;
  minOrderSize: number | null;
  feeRateBps: number | null;
  source: ChartPriceSurface["source"];
  lastUpdatedAt: number | null;
}): OutcomeQuote {
  const execution: ExecutionPriceSurface = {
    buyPrice: input.buyPrice,
    sellPrice: input.sellPrice,
    midPrice: input.midPrice,
    bestBid: input.bestBid,
    bestAsk: input.bestAsk,
    depth: input.depth,
    tickSize: input.tickSize,
    minOrderSize: input.minOrderSize,
    feeRateBps: input.feeRateBps,
  };

  const chart: ChartPriceSurface = {
    label: "best_ask_live",
    price: input.buyPrice,
    source: input.source,
    lastUpdatedAt: input.lastUpdatedAt,
  };

  return {
    outcome: input.outcome,
    buyPrice: input.buyPrice,
    sellPrice: input.sellPrice,
    midPrice: input.midPrice,
    bestBid: input.bestBid,
    bestAsk: input.bestAsk,
    depth: input.depth,
    tickSize: input.tickSize,
    minOrderSize: input.minOrderSize,
    feeRateBps: input.feeRateBps,
    execution,
    chart,
  };
}

function getTradeTimestamp(trade: KalshiTrade) {
  if (typeof trade.ts === "number" && Number.isFinite(trade.ts)) {
    return trade.ts > 10_000_000_000 ? trade.ts : trade.ts * 1000;
  }

  return trade.created_time ? Date.parse(trade.created_time) || 0 : 0;
}

function normalizeKalshiOrderbookResponse(response: KalshiOrderbookResponse): KalshiOrderbook {
  if (response.orderbook_fp) {
    return response.orderbook_fp;
  }

  if (response.orderbook) {
    return response.orderbook;
  }

  return {
    yes_dollars: response.yes_dollars ?? [],
    no_dollars: response.no_dollars ?? [],
    seq: response.seq,
  };
}

async function kalshiMarketDataFetch<T>(path: string) {
  try {
    if (hasKalshiCredentials()) {
      return await kalshiFetch<T>(path);
    }
  } catch {}

  return fetchJson<T>(`${getKalshiMarketDataBaseUrl()}${path}`);
}

function createVenueFeedHealth(feed: KalshiQuote["feedHealth"]): KalshiQuote["feedHealth"] {
  return feed;
}

function buildSlotKeyFromIso(asset: MarketSlot["asset"], value: string) {
  return `${asset}:${Date.parse(value)}`;
}

function emptyOutcome(
  outcome: "YES" | "NO",
  source: ChartPriceSurface["source"],
  lastUpdatedAt: number | null,
): OutcomeQuote {
  return createOutcomeQuote({
    outcome,
    buyPrice: null,
    sellPrice: null,
    midPrice: null,
    bestBid: null,
    bestAsk: null,
    depth: null,
    tickSize: 0.001,
    minOrderSize: 1,
    feeRateBps: null,
    source,
    lastUpdatedAt,
  });
}

function withinTolerance(left: number, right: number) {
  return Math.abs(left - right) <= SLOT_TOLERANCE_MS;
}

function getStatusRank(status: string) {
  return status === "active" ? 0 : status === "open" ? 1 : 2;
}

function centsToUsd(cents: number) {
  return cents / 100;
}

export const KALSHI_ORDER_PRICE_STEP_USD = 0.01;

export function normalizeKalshiOrderPrice(value: number | null, side: OrderSide = "BUY") {
  if (value === null) {
    return null;
  }

  const scaled = value / KALSHI_ORDER_PRICE_STEP_USD;
  const rounded = side === "SELL" ? Math.floor(scaled + 1e-9) : Math.ceil(scaled - 1e-9);
  return round4(rounded * KALSHI_ORDER_PRICE_STEP_USD);
}

function normalizeKalshiLevelPairs(levels: Array<[string, string]>) {
  return levels
    .map(([price, size]) => [Number(price), Number(size)] as [number, number])
    .filter(([price, size]) => Number.isFinite(price) && Number.isFinite(size) && size > 0)
    .sort((left, right) => right[0] - left[0]);
}

function formatPrice(value: number | null) {
  if (value === null) {
    return undefined;
  }
  return value.toFixed(4);
}

function formatCount(value: number) {
  return value.toFixed(2);
}

export function mapKalshiOrderStatus(status: string, filledSize: number, remainingSize: number): VenueOrderStatus {
  if (filledSize > 0 && remainingSize > 0) {
    return "partially_filled";
  }
  if (status === "executed" || status === "filled" || (filledSize > 0 && remainingSize === 0)) {
    return "filled";
  }
  if (status === "canceled" || status === "cancelled") {
    return "canceled";
  }
  if (status === "rejected") {
    return "rejected";
  }
  if (status === "expired") {
    return "expired";
  }
  return "live";
}

export function getKalshiSoftNoFillMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (
    normalized.includes("order couldn't be fully filled") ||
    normalized.includes("order could not be fully filled") ||
    normalized.includes("fok orders are fully filled or killed") ||
    normalized.includes("fill_or_kill")
  ) {
    return message;
  }

  return null;
}

function mapKalshiOrderResult(order: KalshiOrderResponse["order"]): VenueOrderResult {
  const filledSize = Number(order.fill_count_fp ?? 0);
  const remainingSize = Number(order.remaining_count_fp ?? 0);
  const price =
    getKalshiOrderPriceUsd(order.side === "yes" ? "YES" : "NO", {
      yes_price_dollars: order.yes_price_dollars,
      no_price_dollars: order.no_price_dollars,
    }) ?? null;
  const feeUsd = Number(order.taker_fees_dollars ?? order.maker_fees_dollars ?? 0);

  return {
    venue: "kalshi",
    venueOrderId: order.order_id,
    status: mapKalshiOrderStatus(order.status, filledSize, remainingSize),
    filledSize,
    averageFillPrice: price,
    feeUsd,
    raw: order as unknown as Record<string, unknown>,
  };
}

function mapKalshiLiveOrder(order: KalshiOrderResponse["order"], intentId: string): LiveOrder {
  const asset = inferKalshiAsset(order.ticker);
  const filledSize = Number(order.fill_count_fp ?? 0);
  const requestedSize = Number(order.initial_count_fp ?? filledSize);
  const remainingSize = Number(order.remaining_count_fp ?? 0);
  const outcome = order.side === "yes" ? "YES" : "NO";
  const price =
    getKalshiOrderPriceUsd(outcome, {
      yes_price_dollars: order.yes_price_dollars,
      no_price_dollars: order.no_price_dollars,
    }) ?? null;

  return {
    id: `kalshi:${order.order_id}`,
    asset,
    shadow: false,
    intentId,
    venue: "kalshi",
    venueOrderId: order.order_id,
    clientOrderId: order.client_order_id ?? null,
    marketRef: order.ticker,
    side: order.action === "sell" ? "SELL" : "BUY",
    outcome,
    orderType: "LIMIT",
    requestedPrice: price,
    requestedSize,
    filledSize,
    averageFillPrice: price,
    feeUsd: Number(order.taker_fees_dollars ?? order.maker_fees_dollars ?? 0),
    status: mapKalshiOrderStatus(order.status, filledSize, remainingSize),
    createdAt: order.created_time ? Date.parse(order.created_time) : Date.now(),
    updatedAt: order.last_update_time ? Date.parse(order.last_update_time) : Date.now(),
    raw: order as unknown as Record<string, unknown>,
  };
}
