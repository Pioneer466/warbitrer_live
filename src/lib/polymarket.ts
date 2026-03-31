import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { AssetType, SignatureType, type ApiKeyCreds, type OpenOrder, type Trade } from "@polymarket/clob-client";
import { Wallet } from "ethers";

import { DEFAULT_POLY_CHAIN_ID, POLY_CLOB_BASE, POLY_DATA_BASE, POLY_GAMMA_BASE } from "@/lib/constants";
import { hasPolymarketCredentials, readEnv, readSecretValue } from "@/lib/env";
import { fetchJson } from "@/lib/fetch-json";
import type {
  LiveOrder,
  MarketSlot,
  OutcomeQuote,
  PolymarketQuote,
  PositionSnapshot,
  VenueAdapter,
  VenueBalance,
  VenueOrderRequest,
  VenueOrderResult,
  VenueOrderStatus,
} from "@/lib/types";

type GammaMarketResponse = Array<{
  id: string;
  conditionId?: string;
  question: string;
  slug: string;
  endDate: string;
  startDate: string;
  outcomes: string;
  clobTokenIds: string;
  feeType: string | null;
  active: boolean;
  closed: boolean;
  bestBid?: number;
  bestAsk?: number;
  enableOrderBook: boolean;
  outcomePrices: string;
}>;

type CLOBBook = {
  market?: string;
  asset_id?: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  min_order_size?: string;
  tick_size?: string;
  neg_risk?: boolean;
};

type PriceResponse = { price: string };
type MidpointResponse = { mid: string };
type PositionValueResponse = { value: number } | { total: number };

type DataPosition = {
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  currentValue: number;
  cashPnl: number;
  realizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  outcome: string;
};

export async function fetchPolymarketQuote(slot: MarketSlot): Promise<PolymarketQuote> {
  const market = await fetchPolymarketMarket(slot.polymarketSlug);
  if (!market) {
    throw new Error(`Polymarket market ${slot.polymarketSlug} introuvable`);
  }

  const outcomes = JSON.parse(market.outcomes) as Array<"Up" | "Down">;
  const tokenIds = JSON.parse(market.clobTokenIds) as [string, string];

  const upTokenId = tokenIds[outcomes.indexOf("Up")];
  const downTokenId = tokenIds[outcomes.indexOf("Down")];

  const [upQuote, downQuote] = await Promise.all([
    fetchOutcomeQuote(upTokenId, "UP"),
    fetchOutcomeQuote(downTokenId, "DOWN"),
  ]);

  return {
    ref: {
      venue: "polymarket",
      id: market.id,
      slotKey: slot.key,
      slug: market.slug,
      conditionId: market.conditionId ?? market.id,
      title: market.question,
      url: `https://polymarket.com/event/${market.slug}`,
      startTime: market.startDate,
      endTime: market.endDate,
    },
    conditionId: market.conditionId ?? market.id,
    status: market.closed ? "closed" : "open",
    slotAligned: true,
    availabilityReason: null,
    outcomes: {
      up: upQuote,
      down: downQuote,
    },
    resolution: extractPolymarketResolution(market.outcomePrices),
    tokenIds: {
      up: upTokenId,
      down: downTokenId,
    },
    feeRateBps: 0,
    negRisk: false,
  };
}

export async function fetchPolymarketResolution(slug: string) {
  const market = await fetchPolymarketMarket(slug);
  if (!market || !market.closed) {
    return null;
  }

  return extractPolymarketResolution(market.outcomePrices);
}

export function extractPolymarketResolution(outcomePricesRaw: string) {
  const [up, down] = JSON.parse(outcomePricesRaw) as [string, string];
  const upPrice = Number(up);
  const downPrice = Number(down);

  if (upPrice >= 0.999) {
    return "UP" as const;
  }
  if (downPrice >= 0.999) {
    return "DOWN" as const;
  }

  return null;
}

export function derivePolymarketDepth(book: CLOBBook, executionPrice: number) {
  const levels = book.asks
    .map((level) => ({
      price: Number(level.price),
      size: Number(level.size),
    }))
    .sort((left, right) => Math.abs(left.price - executionPrice) - Math.abs(right.price - executionPrice));

  return levels[0]?.size ?? null;
}

export function createPolymarketAdapter(): VenueAdapter {
  return {
    venue: "polymarket",
    async getBalance() {
      if (!hasPolymarketCredentials()) {
        return {
          venue: "polymarket",
          capturedAt: Date.now(),
          status: "blocked",
          currency: "USDC",
          availableBalanceUsd: 0,
          totalBalanceUsd: 0,
          portfolioValueUsd: 0,
          allowanceUsd: 0,
          notes: ["Credentials Polymarket manquants ou wallet incomplet."],
          raw: {},
        };
      }

      const client = createClobClient();
      const env = readEnv();
      const [collateral, value] = await Promise.all([
        client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
        fetchJson<PositionValueResponse>(
          `${POLY_DATA_BASE}/value?user=${encodeURIComponent(env.POLY_FUNDER_ADDRESS!)}`,
        ).catch(() => ({ value: 0 })),
      ]);

      const available = Number(collateral.balance);
      const allowance = Number(collateral.allowance);
      const positionsValue = "value" in value ? value.value : value.total;
      const notes: string[] = [];
      const status =
        allowance + 1e-9 < available
          ? (notes.push("Allowance CLOB insuffisante pour le solde USDC disponible."), "degraded")
          : "ready";

      return {
        venue: "polymarket",
        capturedAt: Date.now(),
        status,
        currency: "USDC",
        availableBalanceUsd: available,
        totalBalanceUsd: available + positionsValue,
        portfolioValueUsd: available + positionsValue,
        allowanceUsd: allowance,
        notes,
        raw: {
          collateral,
          value,
        },
      };
    },
    async getPositions(now = Date.now()) {
      if (!hasPolymarketCredentials()) {
        return [];
      }

      const env = readEnv();
      const positions = await fetchJson<DataPosition[]>(
        `${POLY_DATA_BASE}/positions?user=${encodeURIComponent(env.POLY_FUNDER_ADDRESS!)}&sizeThreshold=0`,
      );

      return positions.map((position) => ({
        id: `polymarket:${position.asset}`,
        venue: "polymarket",
        marketRef: position.conditionId,
        outcome: normalizePolymarketOutcome(position.outcome),
        size: Number(position.size),
        averagePrice: Number(position.avgPrice),
        currentPrice: Number(position.curPrice),
        currentValueUsd: Number(position.currentValue),
        realizedPnlUsd: Number(position.realizedPnl),
        unrealizedPnlUsd: Number(position.cashPnl) - Number(position.realizedPnl),
        redeemable: position.redeemable,
        mergeable: position.mergeable,
        updatedAt: now,
        raw: position as unknown as Record<string, unknown>,
      }));
    },
    async placeOrder(order) {
      const client = createClobClient();
      const response = await client.createAndPostMarketOrder(
        {
          tokenID: order.tokenId!,
          amount: order.side === "BUY" ? order.maxCostUsd : order.size,
          side: order.side === "BUY" ? Side.BUY : Side.SELL,
          price: order.price ?? undefined,
          orderType: order.orderType === "FAK" ? OrderType.FAK : OrderType.FOK,
        },
        undefined,
        order.orderType === "FAK" ? OrderType.FAK : OrderType.FOK,
      );

      return {
        venue: "polymarket",
        venueOrderId: response.orderID,
        status: response.success
          ? response.status === "filled"
            ? "filled"
            : "live"
          : "rejected",
        filledSize: 0,
        averageFillPrice: null,
        feeUsd: 0,
        raw: response as unknown as Record<string, unknown>,
      };
    },
    async cancelOrder(orderId: string) {
      const client = createClobClient();
      await client.cancelOrder({ orderID: orderId });
    },
    async getOrder(orderId: string) {
      const client = createClobClient();
      const order = await client.getOrder(orderId);
      return mapPolymarketOrder(order, "unknown");
    },
  };
}

export async function fetchPolymarketOpenOrders() {
  if (!hasPolymarketCredentials()) {
    return [];
  }

  const client = createClobClient();
  return client.getOpenOrders();
}

export async function fetchPolymarketTrades(after?: string) {
  if (!hasPolymarketCredentials()) {
    return [];
  }

  const client = createClobClient();
  return client.getTrades(after ? { after } : undefined);
}

async function fetchOutcomeQuote(tokenId: string, outcome: "UP" | "DOWN"): Promise<OutcomeQuote> {
  const [buy, sell, midpoint, book] = await Promise.all([
    fetchJson<PriceResponse>(`${POLY_CLOB_BASE}/price?token_id=${tokenId}&side=buy`),
    fetchJson<PriceResponse>(`${POLY_CLOB_BASE}/price?token_id=${tokenId}&side=sell`),
    fetchJson<MidpointResponse>(`${POLY_CLOB_BASE}/midpoint?token_id=${tokenId}`),
    fetchJson<CLOBBook>(`${POLY_CLOB_BASE}/book?token_id=${tokenId}`),
  ]);

  const buyPrice = Number(buy.price);
  const sellPrice = Number(sell.price);
  const tickSize = book.tick_size ? Number(book.tick_size) : 0.001;
  const minOrderSize = book.min_order_size ? Number(book.min_order_size) : 1;

  return {
    outcome,
    buyPrice,
    sellPrice,
    midPrice: Number(midpoint.mid),
    bestBid: sellPrice,
    bestAsk: buyPrice,
    depth: derivePolymarketDepth(book, buyPrice),
    tickSize,
    minOrderSize,
    feeRateBps: 0,
  };
}

async function fetchPolymarketMarket(slug: string) {
  const markets = await fetchJson<GammaMarketResponse>(`${POLY_GAMMA_BASE}/markets?slug=${slug}`);
  return markets[0] ?? null;
}

function createClobClient() {
  const env = readEnv();
  if (
    (!env.POLY_PRIVATE_KEY && !env.POLY_PRIVATE_KEY_PATH) ||
    !env.POLY_API_KEY ||
    !env.POLY_API_SECRET ||
    !env.POLY_API_PASSPHRASE ||
    !env.POLY_FUNDER_ADDRESS ||
    !env.POLY_SIGNATURE_TYPE
  ) {
    throw new Error("Polymarket credentials missing");
  }

  const signer = new Wallet(
    readSecretValue({
      inline: env.POLY_PRIVATE_KEY,
      path: env.POLY_PRIVATE_KEY_PATH,
      label: "POLY_PRIVATE_KEY",
    }),
  );
  const creds: ApiKeyCreds = {
    key: env.POLY_API_KEY,
    secret: env.POLY_API_SECRET,
    passphrase: env.POLY_API_PASSPHRASE,
  };

  return new ClobClient(
    POLY_CLOB_BASE,
    DEFAULT_POLY_CHAIN_ID,
    signer,
    creds,
    mapSignatureType(env.POLY_SIGNATURE_TYPE),
    env.POLY_FUNDER_ADDRESS,
    undefined,
    true,
    undefined,
    undefined,
    true,
    undefined,
    true,
  );
}

function mapSignatureType(value: string) {
  switch (value) {
    case "EOA":
      return SignatureType.EOA;
    case "POLY_PROXY":
      return SignatureType.POLY_PROXY;
    case "POLY_GNOSIS_SAFE":
      return SignatureType.POLY_GNOSIS_SAFE;
    default:
      throw new Error(`Unsupported Polymarket signature type: ${value}`);
  }
}

function normalizePolymarketOutcome(outcome: string) {
  const upper = outcome.toUpperCase();
  if (upper === "UP") {
    return "UP" as const;
  }
  if (upper === "DOWN") {
    return "DOWN" as const;
  }

  throw new Error(`Unexpected Polymarket outcome ${outcome}`);
}

function mapPolymarketOrderStatus(order: OpenOrder): VenueOrderStatus {
  if (order.status === "canceled") {
    return "canceled";
  }
  if (order.status === "matched" || order.status === "filled") {
    return "filled";
  }
  const matched = Number(order.size_matched);
  const original = Number(order.original_size);
  if (matched > 0 && matched < original) {
    return "partially_filled";
  }
  return "live";
}

export function mapPolymarketOrder(order: OpenOrder, intentId: string): LiveOrder {
  return {
    id: `polymarket:${order.id}`,
    shadow: false,
    intentId,
    venue: "polymarket",
    venueOrderId: order.id,
    clientOrderId: null,
    marketRef: order.market,
    tokenId: order.asset_id,
    side: order.side === "BUY" ? "BUY" : "SELL",
    outcome: normalizePolymarketOutcome(order.outcome),
    orderType: order.order_type,
    requestedPrice: Number(order.price),
    requestedSize: Number(order.original_size),
    filledSize: Number(order.size_matched),
    averageFillPrice: Number(order.price),
    feeUsd: null,
    status: mapPolymarketOrderStatus(order),
    createdAt: order.created_at,
    updatedAt: order.created_at,
    raw: order as unknown as Record<string, unknown>,
  };
}

export function mapPolymarketTradeToFill(trade: Trade, intentId: string) {
  const side: "BUY" | "SELL" = trade.side === Side.BUY ? "BUY" : "SELL";
  return {
    id: `polymarket-fill:${trade.id}`,
    shadow: false,
    intentId,
    venue: "polymarket" as const,
    venueOrderId: trade.taker_order_id,
    tradeId: trade.id,
    marketRef: trade.market,
    tokenId: trade.asset_id,
    side,
    outcome: normalizePolymarketOutcome(trade.outcome),
    price: Number(trade.price),
    size: Number(trade.size),
    feeUsd: Number(trade.price) * Number(trade.size) * (Number(trade.fee_rate_bps) / 10_000),
    liquidity: trade.trader_side,
    filledAt: Date.parse(trade.match_time),
    raw: trade as unknown as Record<string, unknown>,
  };
}
