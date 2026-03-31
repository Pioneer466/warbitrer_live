import crypto from "node:crypto";

import {
  KALSHI_DEMO_BASE,
  KALSHI_PROD_BASE,
  KALSHI_WS_DEMO_BASE,
  KALSHI_WS_PROD_BASE,
} from "@/lib/constants";
import { hasKalshiCredentials, readEnv, readSecretValue } from "@/lib/env";
import { fetchJson } from "@/lib/fetch-json";
import type {
  KalshiQuote,
  LiveOrder,
  MarketSlot,
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
  open_time: string;
  close_time: string;
  status: string;
  result?: "yes" | "no" | "";
  yes_bid_dollars: string;
  yes_ask_dollars: string;
  no_bid_dollars: string;
  no_ask_dollars: string;
  yes_bid_size_fp: string;
  yes_ask_size_fp: string;
  no_bid_size_fp: string;
  no_ask_size_fp: string;
};

type KalshiMarketList = {
  markets: KalshiMarketSummary[];
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

type KalshiBalanceResponse = {
  balance: number;
  portfolio_value: number;
  updated_ts: number;
};

type KalshiPositionsResponse = {
  market_positions: Array<{
    ticker: string;
    position_fp: string;
    market_exposure_dollars: string;
    realized_pnl_dollars: string;
    fees_paid_dollars: string;
    last_updated_ts: string;
  }>;
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

const SLOT_TOLERANCE_MS = 1_000;

export function getKalshiBaseUrl() {
  const env = readEnv();
  return env.KALSHI_ENV === "demo" ? KALSHI_DEMO_BASE : KALSHI_PROD_BASE;
}

export function getKalshiWsUrl() {
  const env = readEnv();
  return env.KALSHI_ENV === "demo" ? KALSHI_WS_DEMO_BASE : KALSHI_WS_PROD_BASE;
}

export async function fetchKalshiQuote(slot: MarketSlot): Promise<KalshiQuote> {
  const [list, series] = await Promise.all([
    fetchJson<KalshiMarketList>(`${getKalshiBaseUrl()}/markets?series_ticker=KXBTC15M&status=open`),
    fetchJson<KalshiSeriesResponse>(`${getKalshiBaseUrl()}/series/KXBTC15M`),
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
    `${getKalshiBaseUrl()}/markets/${market.ticker}`,
  ).catch(() => null);
  const freshMarket = freshMarketResponse?.market ?? market;
  const derived = deriveKalshiOutcomeQuotesFromMarket(freshMarket);

  return {
    ref: {
      venue: "kalshi",
      id: freshMarket.ticker,
      slotKey: buildSlotKeyFromIso(freshMarket.open_time),
      ticker: freshMarket.ticker,
      eventTicker: freshMarket.event_ticker,
      title: freshMarket.title,
      url: `https://kalshi.com/markets/kxbtc15m/bitcoin-price-up-down/${freshMarket.event_ticker.toLowerCase()}`,
      startTime: freshMarket.open_time,
      endTime: freshMarket.close_time,
    },
    status: freshMarket.status,
    slotAligned: true,
    availabilityReason: null,
    outcomes: derived,
    feeMultiplier: series.series.fee_multiplier,
    feeType: series.series.fee_type,
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
  const response = await fetchJson<KalshiMarketResponse>(`${getKalshiBaseUrl()}/markets/${ticker}`);
  if (response.market.status !== "finalized" || !response.market.result) {
    return null;
  }

  return response.market.result === "yes" ? ("YES" as const) : ("NO" as const);
}

export function deriveKalshiOutcomeQuotesFromMarket(market: KalshiMarketSummary) {
  const yesBid = parseMarketPrice(market.yes_bid_dollars);
  const yesAsk = parseMarketPrice(market.yes_ask_dollars);
  const noBid = parseMarketPrice(market.no_bid_dollars);
  const noAsk = parseMarketPrice(market.no_ask_dollars);

  const yesOutcome: OutcomeQuote = {
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
  };

  const noOutcome: OutcomeQuote = {
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
  };

  return {
    yes: yesOutcome,
    no: noOutcome,
  };
}

export function deriveKalshiOutcomeQuotes(orderbook: {
  yes_dollars: Array<[string, string]>;
  no_dollars: Array<[string, string]>;
}) {
  const yesBidLevel = getBestLevel(orderbook.yes_dollars);
  const noBidLevel = getBestLevel(orderbook.no_dollars);

  const yesBid = yesBidLevel?.price ?? null;
  const noBid = noBidLevel?.price ?? null;
  const yesAsk = noBid === null ? null : round4(1 - noBid);
  const noAsk = yesBid === null ? null : round4(1 - yesBid);

  return {
    yes: {
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
    },
    no: {
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
    },
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

      return {
        venue: "kalshi",
        capturedAt: response.updated_ts,
        status: "ready",
        currency: "USD",
        availableBalanceUsd: centsToUsd(response.balance),
        totalBalanceUsd: centsToUsd(response.portfolio_value),
        portfolioValueUsd: centsToUsd(response.portfolio_value),
        allowanceUsd: null,
        notes: [],
        raw: response as unknown as Record<string, unknown>,
      };
    },
    async getPositions(now = Date.now()) {
      if (!hasKalshiCredentials()) {
        return [];
      }

      const response = await kalshiFetch<KalshiPositionsResponse>("/portfolio/positions");
      return response.market_positions.map((position) => ({
        id: `kalshi:${position.ticker}`,
        venue: "kalshi",
        marketRef: position.ticker,
        outcome: Number(position.position_fp) >= 0 ? "YES" : "NO",
        size: Math.abs(Number(position.position_fp)),
        averagePrice: null,
        currentPrice: null,
        currentValueUsd: Number(position.market_exposure_dollars),
        realizedPnlUsd: Number(position.realized_pnl_dollars),
        unrealizedPnlUsd: 0,
        redeemable: false,
        mergeable: false,
        updatedAt: Date.parse(position.last_updated_ts) || now,
        raw: position as unknown as Record<string, unknown>,
      }));
    },
    async placeOrder(order) {
      const response = await createKalshiOrder(order);
      return mapKalshiOrderResult(response.order);
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
      yes_price_dollars: string;
      count_fp: string;
      created_time?: string;
      ts?: number;
    }>;
  }>("/portfolio/fills");

  return response.fills;
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
  const privateKey = readSecretValue({
    inline: env.KALSHI_PRIVATE_KEY_PEM,
    path: env.KALSHI_PRIVATE_KEY_PATH,
    label: "KALSHI_PRIVATE_KEY",
  });
  const signature = signKalshiRequest(privateKey, timestamp, method, path);
  const response = await fetch(`${getKalshiBaseUrl()}${path}`, {
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

function createUnavailableKalshiQuote(
  slot: MarketSlot,
  series: KalshiSeriesResponse["series"],
  availabilityReason: string,
): KalshiQuote {
  return {
    ref: {
      venue: "kalshi",
      id: `KXBTC15M-${slot.key}`,
      slotKey: slot.key,
      ticker: undefined,
      title: series.title,
      url: "https://kalshi.com/markets/kxbtc15m/bitcoin-price-up-down",
      startTime: slot.startIso,
      endTime: slot.endIso,
    },
    status: "pending",
    slotAligned: false,
    availabilityReason,
    outcomes: {
      yes: emptyOutcome("YES"),
      no: emptyOutcome("NO"),
    },
    feeMultiplier: series.fee_multiplier,
    feeType: series.fee_type,
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
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMarketSize(value: string | undefined) {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function buildSlotKeyFromIso(value: string) {
  return String(Date.parse(value));
}

function emptyOutcome(outcome: "YES" | "NO"): OutcomeQuote {
  return {
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
  };
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

function formatPrice(value: number | null) {
  if (value === null) {
    return undefined;
  }
  return value.toFixed(4);
}

function formatCount(value: number) {
  return value.toFixed(2);
}

function mapKalshiOrderStatus(status: string, filledSize: number, remainingSize: number): VenueOrderStatus {
  if (status === "canceled" || status === "cancelled") {
    return "canceled";
  }
  if (status === "rejected") {
    return "rejected";
  }
  if (status === "executed" || status === "filled" || (filledSize > 0 && remainingSize === 0)) {
    return "filled";
  }
  if (filledSize > 0 && remainingSize > 0) {
    return "partially_filled";
  }
  if (status === "expired") {
    return "expired";
  }
  return "live";
}

function mapKalshiOrderResult(order: KalshiOrderResponse["order"]): VenueOrderResult {
  const filledSize = Number(order.fill_count_fp ?? 0);
  const remainingSize = Number(order.remaining_count_fp ?? 0);
  const price = Number(order.yes_price_dollars ?? order.no_price_dollars ?? 0) || null;
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
  const filledSize = Number(order.fill_count_fp ?? 0);
  const requestedSize = Number(order.initial_count_fp ?? filledSize);
  const remainingSize = Number(order.remaining_count_fp ?? 0);
  const price = Number(order.yes_price_dollars ?? order.no_price_dollars ?? 0) || null;

  return {
    id: `kalshi:${order.order_id}`,
    shadow: false,
    intentId,
    venue: "kalshi",
    venueOrderId: order.order_id,
    clientOrderId: order.client_order_id ?? null,
    marketRef: order.ticker,
    side: order.action === "sell" ? "SELL" : "BUY",
    outcome: order.side === "yes" ? "YES" : "NO",
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
