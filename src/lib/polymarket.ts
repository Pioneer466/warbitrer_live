import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import {
  AssetType,
  SignatureType,
  type ApiKeyCreds,
  type BalanceAllowanceParams,
  type BalanceAllowanceResponse,
  type OpenOrder,
  type Trade,
} from "@polymarket/clob-client";
import { Wallet } from "ethers";

import { DEFAULT_POLY_CHAIN_ID, POLY_CLOB_BASE, POLY_DATA_BASE, POLY_GAMMA_BASE } from "@/lib/constants";
import { hasPolymarketCredentials, readEnv, readSecretValue } from "@/lib/env";
import { fetchJson } from "@/lib/fetch-json";
import { getMarketCatalogEntry, inferPolymarketAsset } from "@/lib/market-catalog";
import type {
  ChartPriceSurface,
  ExecutionPriceSurface,
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
type PositionValueEntry = {
  user?: string;
  value?: number | string | null;
  total?: number | string | null;
};
type PositionValueResponse = PositionValueEntry | PositionValueEntry[] | null;
type PolymarketCollateralLike = {
  allowance?: string | number | null;
  allowances?: Record<string, string | number | null> | null;
};

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

const POLY_BALANCE_ALLOWANCE_REFRESH_INTERVAL_MS = 30_000;
const POLY_EFFECTIVE_UNLIMITED_ALLOWANCE_RAW = 10n ** 24n;
const POLY_CLIENT_TIMEOUT_MS = 15_000;
let lastPolymarketBalanceAllowanceRefreshAt = 0;

export async function fetchPolymarketQuote(slot: MarketSlot): Promise<PolymarketQuote> {
  const marketConfig = getMarketCatalogEntry(slot.asset);
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
      asset: slot.asset,
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
    feedHealth: createVenueFeedHealth({
      asset: slot.asset,
      venue: "polymarket",
      feedStatus: "ready",
      source: "rest-bootstrap",
      lastMessageAt: Date.now(),
      stalenessMs: 0,
      details: ["Quote bootstrap via REST"],
      subscriptions: [],
    }),
    lastMessageAt: Date.now(),
    stalenessMs: 0,
    source: "rest-bootstrap",
    outcomes: {
      up: upQuote,
      down: downQuote,
    },
    resolution: extractPolymarketResolution(market.outcomePrices),
    tokenIds: {
      up: upTokenId,
      down: downTokenId,
    },
    chainlinkLivePriceUsd: null,
    chainlinkLivePriceCapturedAt: null,
    observedSlotOpenPriceUsd: null,
    observedSlotOpenCapturedAt: null,
    feeRateBps: 0,
    negRisk: false,
  };
}

export function createUnavailablePolymarketQuote(slot: MarketSlot, availabilityReason: string): PolymarketQuote {
  const marketConfig = getMarketCatalogEntry(slot.asset);
  const feedHealth = createVenueFeedHealth({
    asset: slot.asset,
    venue: "polymarket",
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
      venue: "polymarket",
      id: slot.polymarketSlug,
      conditionId: slot.polymarketSlug,
      slug: slot.polymarketSlug,
      title: marketConfig.title,
      url: `https://polymarket.com/event/${slot.polymarketSlug}`,
      startTime: slot.startIso,
      endTime: slot.endIso,
      slotKey: slot.key,
    },
    conditionId: slot.polymarketSlug,
    status: "open",
    slotAligned: false,
    availabilityReason,
    feedHealth,
    lastMessageAt: null,
    stalenessMs: null,
    source: "unavailable",
    outcomes: {
      up: emptyOutcomeQuote("UP", "unavailable", null),
      down: emptyOutcomeQuote("DOWN", "unavailable", null),
    },
    resolution: null,
    tokenIds: {
      up: "",
      down: "",
    },
    chainlinkLivePriceUsd: null,
    chainlinkLivePriceCapturedAt: null,
    observedSlotOpenPriceUsd: null,
    observedSlotOpenCapturedAt: null,
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
      const [{ collateral, refreshError }, value] = await Promise.all([
        getFreshPolymarketCollateralBalance(client),
        fetchJson<PositionValueResponse>(
          `${POLY_DATA_BASE}/value?user=${encodeURIComponent(env.POLY_FUNDER_ADDRESS!)}`,
        ).catch(() => null),
      ]);

      const available = microUsdcToUsd(collateral.balance);
      const allowanceInfo = extractPolymarketCollateralAllowanceInfo(collateral, env.POLY_SIGNATURE_TYPE);
      const allowance = allowanceInfo.unlimited ? available : allowanceInfo.allowanceUsd;
      const notes: string[] = [];
      if (refreshError) {
        notes.push(`Balance cache refresh Polymarket échoué: ${refreshError}`);
      }
      if (allowanceInfo.unlimited) {
        notes.push("Allowance CLOB illimitée détectée.");
      }

      let positionsValueSource = "value";
      let positionsValue = extractPolymarketPositionValueUsd(value);
      if (positionsValue === null) {
        positionsValue = await fetchPolymarketPositionValueFallback(env.POLY_FUNDER_ADDRESS!).catch((error) => {
          notes.push(`Fallback positions Polymarket échoué: ${toErrorMessage(error)}`);
          return 0;
        });
        positionsValueSource = "positions";
      }

      const requiresAllowanceCheck =
        env.POLY_SIGNATURE_TYPE === "EOA" || env.POLY_SIGNATURE_TYPE === "POLY_GNOSIS_SAFE";
      const status =
        requiresAllowanceCheck && available > 0 && !allowanceInfo.unlimited && allowance === null
          ? (notes.push("Allowance CLOB introuvable pour ce wallet Polymarket."), "degraded")
          : requiresAllowanceCheck && !allowanceInfo.unlimited && allowance !== null && allowance + 1e-9 < available
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
          allowanceUnlimited: allowanceInfo.unlimited,
          value,
          positionsValueSource,
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

      return positions
        .filter(isStrategyScopedPolymarketPosition)
        .filter(isLiveRelevantPolymarketPosition)
        .map((position) => ({
          id: `polymarket:${position.asset}`,
          asset: inferPolymarketAsset(position.title),
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
      try {
        const response = await withPolymarketClientTimeout("createAndPostMarketOrder", () =>
          client.createAndPostMarketOrder(
            {
              tokenID: order.tokenId!,
              amount: order.side === "BUY" ? order.maxCostUsd : order.size,
              side: order.side === "BUY" ? Side.BUY : Side.SELL,
              price: order.price ?? undefined,
              orderType: order.orderType === "FAK" ? OrderType.FAK : OrderType.FOK,
            },
            undefined,
            order.orderType === "FAK" ? OrderType.FAK : OrderType.FOK,
          ),
        );

        return {
          venue: "polymarket",
          venueOrderId: response.orderID,
          status: response.success
            ? typeof response.status === "string" && response.status.toLowerCase() === "matched"
              ? "pending"
              : "live"
            : "rejected",
          filledSize: 0,
          averageFillPrice: null,
          feeUsd: 0,
          raw: response as unknown as Record<string, unknown>,
        };
      } catch (error) {
        const noFillMessage = getPolymarketSoftNoFillMessage(error);
        if (noFillMessage) {
          return {
            venue: "polymarket",
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
      const client = createClobClient();
      await withPolymarketClientTimeout("cancelOrder", () => client.cancelOrder({ orderID: orderId }));
    },
    async getOrder(orderId: string) {
      const client = createClobClient();
      const order = await withPolymarketClientTimeout("getOrder", () => client.getOrder(orderId));
      return mapPolymarketOrder(order, "unknown");
    },
  };
}

export async function fetchPolymarketOpenOrders() {
  if (!hasPolymarketCredentials()) {
    return [];
  }

  const client = createClobClient();
  return withPolymarketClientTimeout("getOpenOrders", () => client.getOpenOrders());
}

export async function fetchPolymarketTrades(after?: string) {
  if (!hasPolymarketCredentials()) {
    return [];
  }

  const client = createClobClient();
  return withPolymarketClientTimeout("getTrades", () => client.getTrades(after ? { after } : undefined));
}

export async function confirmPolymarketOrderExecution(params: {
  orderId: string;
  expectedSize?: number;
  orderType?: string | null;
  timeoutMs?: number;
}): Promise<{ result: VenueOrderResult; order: OpenOrder | null; trades: Trade[] }> {
  const deadline = Date.now() + (params.timeoutMs ?? 3_000);
  let latestOrder: OpenOrder | null = null;
  let latestTrades: Trade[] = [];

  while (Date.now() <= deadline) {
    const [order, trades] = await Promise.all([
      safeGetPolymarketOrder(params.orderId),
      fetchPolymarketTrades().catch(() => []),
    ]);
    latestOrder = order;
    latestTrades = extractPolymarketTradesForOrder(trades, params.orderId);

    const tradeLifecycle = summarizePolymarketTradeLifecycle(latestTrades);
    const confirmedTrades = summarizePolymarketTrades(tradeLifecycle.confirmedTrades);
    if (confirmedTrades.filledSize > 0) {
      const effectiveOrderType = order?.order_type ?? params.orderType ?? null;
      const authoritativeExpectedSize =
        effectiveOrderType === "FOK"
          ? confirmedTrades.filledSize
          : order
            ? Number(order.original_size)
            : params.expectedSize ?? confirmedTrades.filledSize;
      return {
        result: {
          venue: "polymarket" as const,
          venueOrderId: params.orderId,
          status:
            confirmedTrades.filledSize + 1e-6 >= authoritativeExpectedSize ? "filled" : "partially_filled",
          filledSize: confirmedTrades.filledSize,
          averageFillPrice: confirmedTrades.averageFillPrice,
          feeUsd: confirmedTrades.feeUsd,
          raw: {
            order,
            trades: latestTrades,
            tradeLifecycle,
          },
        },
        order,
        trades: latestTrades,
      };
    }

    if (order) {
      const mappedOrder = mapPolymarketOrder(order, "unknown");
      if (mappedOrder.status === "canceled" || mappedOrder.status === "expired" || mappedOrder.status === "rejected") {
        const tradeLifecycle = summarizePolymarketTradeLifecycle(latestTrades);
        const confirmedTrades = summarizePolymarketTrades(tradeLifecycle.confirmedTrades);
        return {
          result: {
            venue: "polymarket" as const,
            venueOrderId: params.orderId,
            status: mappedOrder.status,
            filledSize: confirmedTrades.filledSize,
            averageFillPrice: confirmedTrades.averageFillPrice,
            feeUsd: confirmedTrades.feeUsd,
            raw: {
              order,
              trades: latestTrades,
              tradeLifecycle,
            },
          },
          order,
          trades: latestTrades,
        };
      }
    }

    await sleep(200);
  }

  const tradeLifecycle = summarizePolymarketTradeLifecycle(latestTrades);
  const confirmedTrades = summarizePolymarketTrades(tradeLifecycle.confirmedTrades);
  const fallbackOrder = latestOrder ? mapPolymarketOrder(latestOrder, "unknown") : null;
  return {
    result: {
      venue: "polymarket" as const,
      venueOrderId: params.orderId,
      status: confirmedTrades.filledSize > 0 ? "filled" : tradeLifecycle.pendingTrades.length > 0 ? "pending" : fallbackOrder?.status ?? "live",
      filledSize: confirmedTrades.filledSize,
      averageFillPrice: confirmedTrades.averageFillPrice,
      feeUsd: confirmedTrades.feeUsd,
      raw: {
        order: latestOrder,
        trades: latestTrades,
        tradeLifecycle,
      },
    },
    order: latestOrder,
    trades: latestTrades,
  };
}

export function getPolymarketSoftNoFillMessage(error: unknown) {
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

  return createOutcomeQuote({
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
    source: "rest-bootstrap",
    lastUpdatedAt: Date.now(),
  });
}

export async function fetchPolymarketBook(tokenId: string) {
  return fetchJson<CLOBBook>(`${POLY_CLOB_BASE}/book?token_id=${tokenId}`);
}

export async function fetchPolymarketMarket(slug: string) {
  const markets = await fetchJson<GammaMarketResponse>(`${POLY_GAMMA_BASE}/markets?slug=${slug}`);
  return markets[0] ?? null;
}

export function derivePolymarketOutcomeTokens(market: NonNullable<Awaited<ReturnType<typeof fetchPolymarketMarket>>>) {
  const outcomes = JSON.parse(market.outcomes) as Array<"Up" | "Down">;
  const tokenIds = JSON.parse(market.clobTokenIds) as [string, string];

  return {
    up: tokenIds[outcomes.indexOf("Up")],
    down: tokenIds[outcomes.indexOf("Down")],
  };
}

export function buildPolymarketOutcomeQuoteFromBook(
  outcome: "UP" | "DOWN",
  book: Pick<CLOBBook, "bids" | "asks" | "tick_size" | "min_order_size">,
  source: OutcomeQuote["chart"]["source"],
  lastUpdatedAt: number | null,
  fallbackMidpoint?: number | null,
): OutcomeQuote {
  const bestBid = getBestBookLevel(book.bids, "desc");
  const bestAsk = getBestBookLevel(book.asks, "asc");
  const buyPrice = bestAsk?.price ?? null;
  const sellPrice = bestBid?.price ?? null;
  const midPrice =
    buyPrice !== null && sellPrice !== null
      ? round4((buyPrice + sellPrice) / 2)
      : fallbackMidpoint ?? null;

  return createOutcomeQuote({
    outcome,
    buyPrice,
    sellPrice,
    midPrice,
    bestBid: sellPrice,
    bestAsk: buyPrice,
    depth: bestAsk?.size ?? null,
    tickSize: book.tick_size ? Number(book.tick_size) : 0.001,
    minOrderSize: book.min_order_size ? Number(book.min_order_size) : 1,
    feeRateBps: 0,
    source,
    lastUpdatedAt,
  });
}

export function createOutcomeQuote(input: {
  outcome: "UP" | "DOWN";
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

export function emptyOutcomeQuote(
  outcome: "UP" | "DOWN",
  source: ChartPriceSurface["source"],
  lastUpdatedAt: number | null,
) {
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
    feeRateBps: 0,
    source,
    lastUpdatedAt,
  });
}

function getBestBookLevel(levels: Array<{ price: string; size: string }>, direction: "asc" | "desc") {
  if (levels.length === 0) {
    return null;
  }

  const sorted = levels
    .map((level) => ({
      price: Number(level.price),
      size: Number(level.size),
    }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size))
    .sort((left, right) => (direction === "asc" ? left.price - right.price : right.price - left.price));

  return sorted[0] ?? null;
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function createVenueFeedHealth(
  feed: PolymarketQuote["feedHealth"],
): PolymarketQuote["feedHealth"] {
  return feed;
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

  const privateKey = readSecretValue({
    inline: env.POLY_PRIVATE_KEY,
    path: env.POLY_PRIVATE_KEY_PATH,
    label: "POLY_PRIVATE_KEY",
  });

  let signer: Wallet;
  try {
    signer = new Wallet(privateKey);
  } catch {
    throw new Error(
      "POLY_PRIVATE_KEY invalide. Attendu: une cle privee EOA hexadecimale 0x... sur une seule ligne. Avec POLY_PROXY, la cle est celle du signer EOA et POLY_FUNDER_ADDRESS est l'adresse du proxy/funder.",
    );
  }
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

async function getFreshPolymarketCollateralBalance(client: ClobClient): Promise<{
  collateral: BalanceAllowanceResponse;
  refreshError: string | null;
}> {
  const params = { asset_type: AssetType.COLLATERAL } as const;
  let refreshError: string | null = null;

  if (shouldRefreshPolymarketBalanceAllowanceCache()) {
    refreshError = await refreshPolymarketBalanceAllowanceCache(client, params);
  }

  let collateral = await withPolymarketClientTimeout("getBalanceAllowance", () => client.getBalanceAllowance(params));
  if (microUsdcToUsd(collateral.balance) <= 0 && !refreshError) {
    const forcedRefreshError = await refreshPolymarketBalanceAllowanceCache(client, params);
    refreshError = forcedRefreshError;
    collateral = await withPolymarketClientTimeout("getBalanceAllowance", () => client.getBalanceAllowance(params));
  }

  return {
    collateral,
    refreshError,
  };
}

function shouldRefreshPolymarketBalanceAllowanceCache(now = Date.now()) {
  return now - lastPolymarketBalanceAllowanceRefreshAt >= POLY_BALANCE_ALLOWANCE_REFRESH_INTERVAL_MS;
}

async function refreshPolymarketBalanceAllowanceCache(
  client: ClobClient,
  params: BalanceAllowanceParams,
) {
  lastPolymarketBalanceAllowanceRefreshAt = Date.now();

  try {
    await withPolymarketClientTimeout("updateBalanceAllowance", () => client.updateBalanceAllowance(params));
    return null;
  } catch (error) {
    return toErrorMessage(error);
  }
}

function withPolymarketClientTimeout<T>(
  operation: string,
  fn: () => Promise<T>,
  timeoutMs = POLY_CLIENT_TIMEOUT_MS,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Polymarket ${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([fn(), timeoutPromise]).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }) as Promise<T>;
}

export function microUsdcToUsd(value: string | number) {
  return Number(value) / 1_000_000;
}

export function extractPolymarketCollateralAllowanceInfo(
  collateral: PolymarketCollateralLike,
  signatureType?: string,
) {
  const directAllowanceRaw = getRawAllowanceCandidate(collateral.allowance ?? null);
  if (directAllowanceRaw !== null) {
    return normalizePolymarketAllowanceCandidate(directAllowanceRaw);
  }

  if (!collateral.allowances || typeof collateral.allowances !== "object") {
    return { allowanceUsd: null, unlimited: false };
  }

  const allowanceValues = Object.values(collateral.allowances)
    .map((value) => getRawAllowanceCandidate(value))
    .filter((value): value is bigint => value !== null);

  if (allowanceValues.length === 0) {
    return { allowanceUsd: null, unlimited: false };
  }

  const effectiveAllowance =
    signatureType === "EOA" || signatureType === "POLY_GNOSIS_SAFE"
      ? allowanceValues.reduce((currentMin, value) => (value < currentMin ? value : currentMin))
      : allowanceValues.reduce((currentMax, value) => (value > currentMax ? value : currentMax));

  return normalizePolymarketAllowanceCandidate(effectiveAllowance);
}

export function extractPolymarketCollateralAllowanceUsd(
  collateral: PolymarketCollateralLike,
  signatureType?: string,
) {
  return extractPolymarketCollateralAllowanceInfo(collateral, signatureType).allowanceUsd;
}

export async function getPolymarketConditionalSellableBalance(tokenId: string) {
  const client = createClobClient();
  const env = readEnv();
  const params: BalanceAllowanceParams = {
    asset_type: AssetType.CONDITIONAL,
    token_id: tokenId,
  };
  const refreshError = await refreshPolymarketBalanceAllowanceCache(client, params);
  const conditional = await withPolymarketClientTimeout("getBalanceAllowance", () => client.getBalanceAllowance(params));
  const balance = microUsdcToUsd(conditional.balance);
  const allowanceInfo = extractPolymarketCollateralAllowanceInfo(conditional, env.POLY_SIGNATURE_TYPE);
  const allowance = allowanceInfo.unlimited ? balance : allowanceInfo.allowanceUsd;

  return {
    balance,
    allowance,
    sellable: allowance === null ? balance : Math.min(balance, allowance),
    refreshError,
    raw: conditional,
  };
}

export function extractPolymarketPositionValueUsd(payload: PositionValueResponse) {
  if (Array.isArray(payload)) {
    const values = payload
      .map((entry) => getNumericCandidate(entry.value ?? entry.total ?? null))
      .filter((value): value is number => value !== null);

    if (values.length === 0) {
      return null;
    }

    return values.reduce((sum, value) => sum + value, 0);
  }

  if (!payload) {
    return null;
  }

  return getNumericCandidate(payload.value ?? payload.total ?? null);
}

async function fetchPolymarketPositionValueFallback(user: string) {
  const positions = await fetchJson<DataPosition[]>(
    `${POLY_DATA_BASE}/positions?user=${encodeURIComponent(user)}&sizeThreshold=0`,
  );

  return positions.reduce((sum, position) => sum + (getNumericCandidate(position.currentValue) ?? 0), 0);
}

function getNumericCandidate(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function getRawAllowanceCandidate(value: unknown) {
  if (typeof value === "bigint") {
    return value >= 0n ? value : null;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      return null;
    }

    if (!Number.isSafeInteger(value)) {
      return BigInt(Math.trunc(value));
    }

    return BigInt(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || !/^\d+$/.test(trimmed)) {
      return null;
    }

    return BigInt(trimmed);
  }

  return null;
}

function normalizePolymarketAllowanceCandidate(rawAllowance: bigint) {
  if (rawAllowance >= POLY_EFFECTIVE_UNLIMITED_ALLOWANCE_RAW) {
    return {
      allowanceUsd: null,
      unlimited: true,
    };
  }

  return {
    allowanceUsd: microUsdcToUsd(rawAllowance.toString()),
    unlimited: false,
  };
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function mapPolymarketOrderStatus(order: OpenOrder): VenueOrderStatus {
  const normalizedStatus = order.status.toLowerCase();
  if (normalizedStatus === "canceled" || normalizedStatus === "cancelled") {
    return "canceled";
  }
  if (normalizedStatus === "expired") {
    return "expired";
  }
  if (normalizedStatus === "matched") {
    return "pending";
  }
  if (normalizedStatus === "filled") {
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
  const createdAt = parsePolymarketTimestamp(order.created_at) ?? Date.now();
  return {
    id: `polymarket:${order.id}`,
    asset: inferPolymarketAsset(order.market),
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
    createdAt,
    updatedAt: createdAt,
    raw: order as unknown as Record<string, unknown>,
  };
}

export function mapPolymarketTradeToFill(trade: Trade, intentId: string, venueOrderId?: string) {
  const side: "BUY" | "SELL" = trade.side === Side.BUY ? "BUY" : "SELL";
  const filledAt =
    parsePolymarketTimestamp(trade.match_time) ??
    parsePolymarketTimestamp(trade.last_update) ??
    Date.now();
  return {
    id: `polymarket-fill:${trade.id}`,
    asset: inferPolymarketAsset(trade.market),
    shadow: false,
    intentId,
    venue: "polymarket" as const,
    venueOrderId: venueOrderId ?? trade.taker_order_id,
    tradeId: trade.id,
    marketRef: trade.market,
    tokenId: trade.asset_id,
    side,
    outcome: normalizePolymarketOutcome(trade.outcome),
    price: Number(trade.price),
    size: Number(trade.size),
    feeUsd: Number(trade.price) * Number(trade.size) * (Number(trade.fee_rate_bps) / 10_000),
    liquidity: trade.trader_side,
    filledAt,
    raw: trade as unknown as Record<string, unknown>,
  };
}

export function summarizePolymarketTrades(trades: Trade[]) {
  const filtered = trades.filter((trade) => trade.status !== "FAILED");
  const filledSize = round4(filtered.reduce((sum, trade) => sum + Number(trade.size), 0));
  const grossCostUsd = filtered.reduce((sum, trade) => sum + Number(trade.size) * Number(trade.price), 0);
  const feeUsd = round4(
    filtered.reduce(
      (sum, trade) => sum + Number(trade.price) * Number(trade.size) * (Number(trade.fee_rate_bps) / 10_000),
      0,
    ),
  );

  return {
    filledSize,
    averageFillPrice: filledSize > 0 ? round4(grossCostUsd / filledSize) : null,
    feeUsd,
  };
}

export function isConfirmedPolymarketTrade(trade: Trade) {
  return trade.status === "CONFIRMED";
}

export function isPendingPolymarketTrade(trade: Trade) {
  return trade.status === "MATCHED" || trade.status === "MINED" || trade.status === "RETRYING";
}

export function isFailedPolymarketTrade(trade: Trade) {
  return trade.status === "FAILED";
}

export function summarizePolymarketTradeLifecycle(trades: Trade[]) {
  return {
    confirmedTrades: trades.filter(isConfirmedPolymarketTrade),
    pendingTrades: trades.filter(isPendingPolymarketTrade),
    failedTrades: trades.filter(isFailedPolymarketTrade),
  };
}

export function extractPolymarketTradesForOrder(trades: Trade[], orderId: string) {
  return trades.filter(
    (trade) =>
      trade.taker_order_id === orderId ||
      trade.maker_orders.some((makerOrder) => makerOrder.order_id === orderId),
  );
}

async function safeGetPolymarketOrder(orderId: string) {
  try {
    const client = createClobClient();
    return await client.getOrder(orderId);
  } catch {
    return null;
  }
}

function isStrategyScopedPolymarketPosition(position: DataPosition) {
  if (position.redeemable || position.mergeable) {
    return true;
  }

  const title = position.title.toLowerCase();
  const mentionsTrackedAsset =
    title.includes("bitcoin") ||
    title.includes("btc") ||
    title.includes("ethereum") ||
    title.includes("ether") ||
    title.includes("eth");
  const mentions15m =
    title.includes("15m") ||
    title.includes("15 minute") ||
    title.includes("15-minute") ||
    title.includes("fifteen minute");

  return mentionsTrackedAsset && mentions15m;
}

function isLiveRelevantPolymarketPosition(position: DataPosition) {
  const size = Number(position.size);
  const currentValueUsd = Number(position.currentValue);
  return size > 0 || currentValueUsd > 0 || position.redeemable || position.mergeable;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePolymarketTimestamp(value: unknown) {
  if (typeof value === "number") {
    return normalizePolymarketEpoch(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      return normalizePolymarketEpoch(Number(trimmed));
    }

    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizePolymarketEpoch(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
}
