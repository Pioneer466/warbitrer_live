import { ClobClient, OrderType, Side } from "@polymarket/clob-client-v2";
import {
  AssetType,
  SignatureTypeV2,
  type ApiKeyCreds,
  type BalanceAllowanceParams,
  type BalanceAllowanceResponse,
  type OpenOrder,
  type Trade,
} from "@polymarket/clob-client-v2";
import { Wallet } from "ethers";

import { DEFAULT_POLY_CHAIN_ID, POLY_CLOB_BASE, POLY_DATA_BASE, POLY_GAMMA_BASE } from "@/lib/constants";
import { hasPolymarketCredentials, readEnv, readSecretValue } from "@/lib/env";
import { fetchJson } from "@/lib/fetch-json";
import { getMarketCatalogEntry, inferPolymarketAsset } from "@/lib/market-catalog";
import { normalizePolymarketTradeStatus } from "@/lib/polymarket-trade-status";
import type {
  ChartPriceSurface,
  ExecutionPriceSurface,
  LiveFill,
  LiveOrder,
  MarketAsset,
  MarketSlot,
  OutcomeQuote,
  PolymarketQuote,
  VenueMarketRef,
  VenueAdapter,
  VenueOrderRequest,
  VenueOrderResult,
  VenueOrderStatus,
} from "@/lib/types";

// Orders are intentionally submitted without a builder configuration or builder code.
export const POLYMARKET_BUILDER_FEES_ENABLED = false;

export function isPolymarketBuilderCodeActive(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim();
  return normalized !== "" && !/^0x0{64}$/i.test(normalized);
}

type GammaMarket = {
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
  umaResolutionStatus?: string | null;
};

type GammaMarketResponse = GammaMarket[];
type GammaEventResponse = Array<{
  id: string;
  slug: string;
  markets?: GammaMarket[];
  eventMetadata?: {
    finalPrice?: string | number | null;
    priceToBeat?: string | number | null;
  } | null;
}>;

export type FinalizedPolymarketResolutionObservation = {
  resolution: "UP" | "DOWN";
  benchmarkValueUsd: number | null;
  benchmarkSource: "polymarket-gamma-event-final-price" | null;
};

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
export type PolymarketClobMarketInfo = {
  c?: string;
  mts?: number | string | null;
  nr?: boolean | null;
  fd?: {
    r?: number | string | null;
    e?: number | string | null;
    to?: boolean | null;
  } | null;
};

export function derivePolymarketFeeMetadata(clobMarketInfo: PolymarketClobMarketInfo | null | undefined) {
  const feeData = clobMarketInfo?.fd;
  if (!feeData || typeof feeData !== "object") {
    return { feeMetadataPresent: false, feesEnabled: null } as const;
  }
  const feeRate = getNumericCandidate(feeData.r ?? null);
  return {
    feeMetadataPresent: true,
    feesEnabled: feeRate === null || feeRate < 0 ? null : feeRate > 0,
  } as const;
}

export type PolymarketOrderTruth = {
  orderId: string;
  orderStatus: VenueOrderStatus | null;
  orderSizeMatched: number;
  confirmedFilledSize: number;
  pendingFilledSize: number;
  effectiveFilledSize: number;
  confirmedAverageFillPrice: number | null;
  averageFillPrice: number | null;
  confirmedFeeUsd: number;
  feeUsd: number;
  expectedSize: number | null;
  expectedSizeSatisfied: boolean;
  hasPendingExposure: boolean;
  hasUnknownTradeTruth: boolean;
  terminalZeroFill: boolean;
  status: VenueOrderStatus;
};

export type PolymarketConfirmationFetchStates = {
  order: { ok: boolean; error: string | null };
  trades: { ok: boolean; error: string | null };
};

export type PolymarketAssetMappingContext = {
  asset?: MarketAsset;
};

export type PolymarketTradeMappingContext = PolymarketAssetMappingContext & {
  venueOrderId?: string;
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
  const market = await fetchPolymarketMarket(slot.polymarketSlug);
  if (!market) {
    throw new Error(`Polymarket market ${slot.polymarketSlug} introuvable`);
  }
  const marketRef = buildCanonicalPolymarketMarketRef(slot, market);

  const outcomes = JSON.parse(market.outcomes) as Array<"Up" | "Down">;
  const tokenIds = JSON.parse(market.clobTokenIds) as [string, string];
  const conditionId = market.conditionId ?? market.id;

  const upTokenId = tokenIds[outcomes.indexOf("Up")];
  const downTokenId = tokenIds[outcomes.indexOf("Down")];

  const [clobMarketInfo, upQuote, downQuote] = await Promise.all([
    fetchPolymarketClobMarketInfo(conditionId).catch(() => null),
    fetchOutcomeQuote(upTokenId, "UP"),
    fetchOutcomeQuote(downTokenId, "DOWN"),
  ]);
  const upQuoteWithFee = applyPolymarketFeeToOutcomeQuote(upQuote, clobMarketInfo);
  const downQuoteWithFee = applyPolymarketFeeToOutcomeQuote(downQuote, clobMarketInfo);
  const feeMetadata = derivePolymarketFeeMetadata(clobMarketInfo);

  return {
    ref: marketRef,
    conditionId,
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
      up: upQuoteWithFee,
      down: downQuoteWithFee,
    },
    resolution: extractPolymarketResolution(market.outcomePrices),
    tokenIds: {
      up: upTokenId,
      down: downTokenId,
    },
    orderbookLevels: null,
    chainlinkLivePriceUsd: null,
    chainlinkLivePriceCapturedAt: null,
    observedSlotOpenPriceUsd: null,
    observedSlotOpenCapturedAt: null,
    feeRateBps: Math.max(upQuoteWithFee.feeRateBps ?? 0, downQuoteWithFee.feeRateBps ?? 0),
    feeRate: getNumericCandidate(clobMarketInfo?.fd?.r ?? null),
    feeExponent: getNumericCandidate(clobMarketInfo?.fd?.e ?? null) ?? 0,
    ...feeMetadata,
    negRisk: Boolean(clobMarketInfo?.nr ?? false),
  };
}

export function buildCanonicalPolymarketMarketRef(
  slot: MarketSlot,
  market: Pick<GammaMarket, "id" | "conditionId" | "question" | "slug" | "endDate">,
): VenueMarketRef {
  if (market.slug !== slot.polymarketSlug) {
    throw new Error(`Polymarket market slug ${market.slug} does not match slot ${slot.polymarketSlug}`);
  }
  if (Date.parse(market.endDate) !== Date.parse(slot.endIso)) {
    throw new Error(`Polymarket market ${market.slug} end time does not match slot ${slot.key}`);
  }

  const conditionId = market.conditionId ?? market.id;
  if (!conditionId.trim()) {
    throw new Error(`Polymarket market ${market.slug} has no condition identity`);
  }

  return {
    asset: slot.asset,
    venue: "polymarket",
    id: market.id,
    slotKey: slot.key,
    slug: market.slug,
    conditionId,
    title: market.question,
    url: `https://polymarket.com/event/${market.slug}`,
    // Gamma startDate is the listing creation timestamp for recurring crypto markets.
    startTime: slot.startIso,
    endTime: slot.endIso,
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
    orderbookLevels: null,
    chainlinkLivePriceUsd: null,
    chainlinkLivePriceCapturedAt: null,
    observedSlotOpenPriceUsd: null,
    observedSlotOpenCapturedAt: null,
    feeRateBps: 0,
    feeRate: null,
    feeExponent: null,
    feeMetadataPresent: false,
    feesEnabled: null,
    negRisk: false,
  };
}

export async function fetchPolymarketResolution(slug: string, conditionId?: string) {
  return fetchFinalizedPolymarketResolution(slug, conditionId);
}

export async function fetchFinalizedPolymarketResolution(slug: string, conditionId?: string) {
  const market = await fetchPolymarketMarket(slug, conditionId);
  if (!market || !market.closed || market.umaResolutionStatus?.toLowerCase() !== "resolved") {
    return null;
  }

  return extractPolymarketResolution(market.outcomePrices);
}

export async function fetchFinalizedPolymarketResolutionObservation(
  slug: string,
  conditionId?: string,
): Promise<FinalizedPolymarketResolutionObservation | null> {
  const market = await fetchPolymarketMarket(slug, conditionId);
  if (!market || !market.closed || market.umaResolutionStatus?.toLowerCase() !== "resolved") {
    return null;
  }
  const resolution = extractPolymarketResolution(market.outcomePrices);
  if (!resolution) {
    return null;
  }

  const events = await fetchJson<GammaEventResponse>(`${POLY_GAMMA_BASE}/events?slug=${slug}`).catch(() => []);
  const event = events.find(
    (candidate) =>
      candidate.slug === slug &&
      (candidate.markets ?? []).some(
        (candidateMarket) =>
          (conditionId && (candidateMarket.conditionId ?? candidateMarket.id) === conditionId) ||
          (!conditionId && candidateMarket.slug === slug),
      ),
  );
  const finalPrice = readPositiveFiniteNumber(event?.eventMetadata?.finalPrice);
  const priceToBeat = readPositiveFiniteNumber(event?.eventMetadata?.priceToBeat);
  const metadataResolution =
    finalPrice === null || priceToBeat === null ? null : finalPrice >= priceToBeat ? "UP" : "DOWN";
  const benchmarkValueUsd = metadataResolution === resolution ? finalPrice : null;

  return {
    resolution,
    benchmarkValueUsd,
    benchmarkSource: benchmarkValueUsd === null ? null : "polymarket-gamma-event-final-price",
  };
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
          currency: "pUSD",
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
            ? (notes.push("Allowance CLOB insuffisante pour le solde pUSD disponible."), "degraded")
            : "ready";

      return {
        venue: "polymarket",
        capturedAt: Date.now(),
        status,
        currency: "pUSD",
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
        const orderPlan = buildPolymarketClobOrderPlan(order);
        const response = await withPolymarketClientTimeout(
          orderPlan.kind === "limit-buy" ? "createAndPostOrder" : "createAndPostMarketOrder",
          async () => {
            if (orderPlan.kind === "limit-buy") {
              const signed = await client.createOrder(orderPlan.order);
              return client.postOrder(signed, orderPlan.orderType);
            }

            return client.createAndPostMarketOrder(orderPlan.order, undefined, orderPlan.orderType);
          },
        );
        const noFillMessage = getPolymarketSoftNoFillMessage(response);
        if (noFillMessage) {
          return buildPolymarketSoftNoFillResult(order, noFillMessage, response);
        }

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
          return buildPolymarketSoftNoFillResult(order, noFillMessage, error);
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

export function buildPolymarketClobOrderPlan(order: VenueOrderRequest) {
  const orderType: OrderType.FAK | OrderType.FOK = order.orderType === "FAK" ? OrderType.FAK : OrderType.FOK;
  if (!order.tokenId) {
    throw new Error("Polymarket order requires tokenId");
  }

  if (order.side === "BUY") {
    if (order.price === null || order.price === undefined) {
      throw new Error("Polymarket BUY market order requires a limit price");
    }

    if ((order.buyMode ?? "shares") === "shares") {
      return {
        kind: "limit-buy" as const,
        orderType,
        order: {
          tokenID: order.tokenId,
          side: Side.BUY,
          price: order.price,
          size: order.size,
        },
      };
    }

    return {
      kind: "market-buy" as const,
      orderType,
      order: {
        tokenID: order.tokenId,
        side: Side.BUY,
        amount: order.maxCostUsd,
        price: order.price,
        orderType,
      },
    };
  }

  return {
    kind: "market-sell" as const,
    orderType,
    order: {
      tokenID: order.tokenId,
      amount: order.size,
      side: Side.SELL,
      price: order.price ?? undefined,
      orderType,
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

export async function fetchPolymarketTrades(after?: string, timeoutMs = POLY_CLIENT_TIMEOUT_MS) {
  if (!hasPolymarketCredentials()) {
    return [];
  }

  const client = createClobClient();
  return withPolymarketClientTimeout("getTrades", () => client.getTrades(after ? { after } : undefined), timeoutMs);
}

export function derivePolymarketConfirmationRequestTimeoutMs(
  deadlineMs: number,
  nowMs = Date.now(),
  clientMaxTimeoutMs = POLY_CLIENT_TIMEOUT_MS,
) {
  if (
    !Number.isFinite(deadlineMs) ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(clientMaxTimeoutMs) ||
    clientMaxTimeoutMs <= 0
  ) {
    return 0;
  }

  return Math.max(0, Math.min(clientMaxTimeoutMs, deadlineMs - nowMs));
}

export async function confirmPolymarketOrderExecution(params: {
  orderId: string;
  expectedSize?: number;
  expectedSizeIsExact?: boolean;
  orderType?: string | null;
  timeoutMs?: number;
  pollWakeup?: Promise<unknown>;
}): Promise<{ result: VenueOrderResult; order: OpenOrder | null; trades: Trade[] }> {
  const deadline = Date.now() + (params.timeoutMs ?? 3_000);
  let latestOrder: OpenOrder | null = null;
  let latestTrades: Trade[] = [];
  let latestFetchStates: PolymarketConfirmationFetchStates = {
    order: { ok: false, error: "Order truth not fetched" },
    trades: { ok: false, error: "Trade truth not fetched" },
  };
  let pollWakeup =
    params.pollWakeup?.then(
      () => true,
      () => true,
    ) ?? null;

  while (Date.now() <= deadline) {
    const requestTimeoutMs = derivePolymarketConfirmationRequestTimeoutMs(deadline);
    if (requestTimeoutMs <= 0) {
      break;
    }
    const [orderFetch, tradesFetch] = await Promise.allSettled([
      getPolymarketOrderForConfirmation(params.orderId, requestTimeoutMs),
      fetchPolymarketTrades(undefined, requestTimeoutMs),
    ]);
    latestFetchStates = {
      order:
        orderFetch.status === "fulfilled"
          ? { ok: true, error: null }
          : { ok: false, error: stringifyPolymarketErrorLike(orderFetch.reason) },
      trades:
        tradesFetch.status === "fulfilled"
          ? { ok: true, error: null }
          : { ok: false, error: stringifyPolymarketErrorLike(tradesFetch.reason) },
    };
    if (orderFetch.status === "fulfilled") {
      latestOrder = orderFetch.value;
    }
    if (tradesFetch.status === "fulfilled") {
      latestTrades = extractPolymarketTradesForOrder(tradesFetch.value, params.orderId);
    }

    const truth = resolvePolymarketOrderTruth({
      orderId: params.orderId,
      order: latestOrder,
      trades: latestTrades,
      expectedSize: params.expectedSize,
      expectedSizeIsExact: params.expectedSizeIsExact,
      orderType: params.orderType,
    });
    if (truth.effectiveFilledSize > 0) {
      return {
        result: buildPolymarketOrderTruthResult(params.orderId, truth, latestOrder, latestTrades, latestFetchStates),
        order: latestOrder,
        trades: latestTrades,
      };
    }

    if (shouldAcceptPolymarketTerminalZeroFill(truth, latestFetchStates)) {
      return {
        result: buildPolymarketOrderTruthResult(params.orderId, truth, latestOrder, latestTrades, latestFetchStates),
        order: latestOrder,
        trades: latestTrades,
      };
    }

    if (pollWakeup) {
      const wokeForFill = await Promise.race([sleep(200).then(() => false), pollWakeup]);
      if (wokeForFill) {
        pollWakeup = null;
      }
    } else {
      await sleep(200);
    }
  }

  const truth = resolvePolymarketOrderTruth({
    orderId: params.orderId,
    order: latestOrder,
    trades: latestTrades,
    expectedSize: params.expectedSize,
    expectedSizeIsExact: params.expectedSizeIsExact,
    orderType: params.orderType,
  });
  const safeTruth =
    truth.terminalZeroFill && !shouldAcceptPolymarketTerminalZeroFill(truth, latestFetchStates)
      ? { ...truth, terminalZeroFill: false, status: "pending" as const }
      : truth;
  return {
    result: buildPolymarketOrderTruthResult(params.orderId, safeTruth, latestOrder, latestTrades, latestFetchStates),
    order: latestOrder,
    trades: latestTrades,
  };
}

export function shouldAcceptPolymarketTerminalZeroFill(
  truth: Pick<PolymarketOrderTruth, "terminalZeroFill">,
  fetchStates: PolymarketConfirmationFetchStates,
) {
  return truth.terminalZeroFill && fetchStates.order.ok && fetchStates.trades.ok;
}

export function resolvePolymarketOrderTruth(params: {
  orderId: string;
  order: OpenOrder | null;
  trades: Trade[];
  expectedSize?: number;
  expectedSizeIsExact?: boolean;
  orderType?: string | null;
}): PolymarketOrderTruth {
  const invalidMakerTrade = params.trades.find(
    (trade) => getPolymarketTradeOrderMappingIssue(trade, params.orderId) === "maker_side_missing",
  );
  if (invalidMakerTrade) {
    throw new Error(`Polymarket maker side missing for trade ${invalidMakerTrade.id} and order ${params.orderId}`);
  }

  const tradeLifecycle = summarizePolymarketTradeLifecycle(params.trades);
  const confirmedSummary = summarizePolymarketTrades(tradeLifecycle.confirmedTrades, params.orderId);
  const pendingSummary = summarizePolymarketTrades(tradeLifecycle.pendingTrades, params.orderId);
  const effectiveTradeSummary = summarizePolymarketTrades(
    [...tradeLifecycle.confirmedTrades, ...tradeLifecycle.pendingTrades],
    params.orderId,
  );
  const orderSizeMatched = getPolymarketOrderSizeMatched(params.order);
  const orderStatus = params.order ? mapPolymarketOrderStatus(params.order) : null;
  const effectiveFilledSize = roundToSixDecimals(
    Math.max(orderSizeMatched, effectiveTradeSummary.filledSize, confirmedSummary.filledSize),
  );
  const orderPrice = getPolymarketOrderPrice(params.order);
  const effectiveOrderType = params.order?.order_type ?? params.orderType ?? null;
  const orderOriginalSize = getPolymarketOrderOriginalSize(params.order);
  const expectedSize =
    params.expectedSizeIsExact === false && effectiveOrderType === "FOK" && effectiveFilledSize > 0
      ? effectiveFilledSize
      : (params.expectedSize ?? orderOriginalSize);
  const expectedSizeSatisfied = expectedSize !== null && effectiveFilledSize + 1e-6 >= expectedSize;
  const hasUnknownTradeTruth = tradeLifecycle.unknownTrades.length > 0;
  const hasPendingExposure =
    hasUnknownTradeTruth ||
    pendingSummary.filledSize > 0 ||
    (params.order !== null && isPolymarketPendingExposureOrderStatus(params.order.status) && effectiveFilledSize > 0);
  const terminalZeroFill =
    orderStatus !== null &&
    isPolymarketTerminalOrderStatus(orderStatus) &&
    effectiveFilledSize <= 1e-6 &&
    pendingSummary.filledSize <= 0 &&
    confirmedSummary.filledSize <= 0 &&
    !hasUnknownTradeTruth;
  const status = derivePolymarketTruthStatus({
    orderStatus,
    effectiveFilledSize,
    expectedSizeSatisfied,
    hasPendingExposure,
  });
  const averageFillPrice = effectiveTradeSummary.averageFillPrice ?? (effectiveFilledSize > 0 ? orderPrice : null);

  return {
    orderId: params.orderId,
    orderStatus,
    orderSizeMatched,
    confirmedFilledSize: confirmedSummary.filledSize,
    pendingFilledSize: pendingSummary.filledSize,
    effectiveFilledSize,
    confirmedAverageFillPrice: confirmedSummary.averageFillPrice,
    averageFillPrice,
    confirmedFeeUsd: confirmedSummary.feeUsd,
    feeUsd: effectiveTradeSummary.feeUsd,
    expectedSize,
    expectedSizeSatisfied,
    hasPendingExposure,
    hasUnknownTradeTruth,
    terminalZeroFill,
    status,
  };
}

function buildPolymarketOrderTruthResult(
  orderId: string,
  truth: PolymarketOrderTruth,
  order: OpenOrder | null,
  trades: Trade[],
  fetchStates?: PolymarketConfirmationFetchStates,
): VenueOrderResult {
  const tradeLifecycle = summarizePolymarketTradeLifecycle(trades);
  return {
    venue: "polymarket",
    venueOrderId: orderId,
    status: truth.status,
    filledSize: truth.effectiveFilledSize,
    averageFillPrice: truth.averageFillPrice,
    feeUsd: truth.feeUsd,
    raw: {
      order,
      trades,
      tradeLifecycle,
      orderTruth: truth,
      confirmationFetchStates: fetchStates,
    },
  };
}

export function getPolymarketSoftNoFillMessage(error: unknown) {
  const message = stringifyPolymarketErrorLike(error);
  const normalized = message.toLowerCase();

  if (
    normalized.includes("fok_order_not_filled_error") ||
    normalized.includes("order couldn't be fully filled") ||
    normalized.includes("order could not be fully filled") ||
    normalized.includes("fok orders are fully filled or killed") ||
    normalized.includes("fill_or_kill")
  ) {
    return message;
  }

  return null;
}

function buildPolymarketSoftNoFillResult(
  order: VenueOrderRequest,
  noFillMessage: string,
  rawResponse?: unknown,
): VenueOrderResult {
  const responseOrderId =
    rawResponse !== null &&
    typeof rawResponse === "object" &&
    "orderID" in rawResponse &&
    typeof rawResponse.orderID === "string"
      ? rawResponse.orderID
      : null;

  return {
    venue: "polymarket",
    venueOrderId: responseOrderId ?? `killed:${order.clientOrderId}`,
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
      response: rawResponse instanceof Error ? { message: rawResponse.message } : rawResponse,
    },
  };
}

function stringifyPolymarketErrorLike(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const candidates = [record.errorMsg, record.error, record.message].filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (candidates.length > 0) {
      return candidates.join(" ");
    }
  }

  return String(error);
}

export function shouldTreatPolymarketTerminalOrderAsPending(pendingTradeCount: number, confirmedFilledSize: number) {
  return pendingTradeCount > 0 && confirmedFilledSize <= 0;
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

export async function fetchPolymarketClobMarketInfo(conditionId: string) {
  return fetchJson<PolymarketClobMarketInfo>(`${POLY_CLOB_BASE}/clob-markets/${conditionId}`);
}

export async function fetchPolymarketMarket(slug: string, conditionId?: string) {
  const markets = await fetchJson<GammaMarketResponse>(`${POLY_GAMMA_BASE}/markets?slug=${slug}`);
  const directMatch = selectGammaMarket(markets, slug, conditionId);
  if (directMatch) {
    return directMatch;
  }

  // Historical recurring crypto markets are not always returned by /markets?slug once closed,
  // but the parent event still exposes the nested market entry via /events?slug.
  const events = await fetchJson<GammaEventResponse>(`${POLY_GAMMA_BASE}/events?slug=${slug}`);
  for (const event of events) {
    const eventMatch = selectGammaMarket(event.markets ?? [], slug, conditionId);
    if (eventMatch) {
      return eventMatch;
    }
  }

  return null;
}

function selectGammaMarket(markets: GammaMarket[], slug: string, conditionId?: string) {
  if (conditionId !== undefined) {
    return markets.find((market) => (market.conditionId ?? market.id) === conditionId) ?? null;
  }

  return markets.find((market) => market.slug === slug) ?? null;
}

function readPositiveFiniteNumber(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
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
  clobMarketInfo?: PolymarketClobMarketInfo | null,
): OutcomeQuote {
  const bestBid = getBestBookLevel(book.bids, "desc");
  const bestAsk = getBestBookLevel(book.asks, "asc");
  const buyPrice = bestAsk?.price ?? null;
  const sellPrice = bestBid?.price ?? null;
  const midPrice =
    buyPrice !== null && sellPrice !== null ? round4((buyPrice + sellPrice) / 2) : (fallbackMidpoint ?? null);

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
    feeRateBps: derivePolymarketEffectiveFeeRateBps(clobMarketInfo, buyPrice),
    source,
    lastUpdatedAt,
  });
}

export function derivePolymarketEffectiveFeeRateBps(
  clobMarketInfo: PolymarketClobMarketInfo | null | undefined,
  price: number | null,
) {
  const feeRate = getNumericCandidate(clobMarketInfo?.fd?.r ?? null);
  const feeExponent = getNumericCandidate(clobMarketInfo?.fd?.e ?? null) ?? 0;
  if (feeRate === null || feeRate <= 0 || price === null || price <= 0 || price >= 1) {
    return 0;
  }

  const feePerShare = feeRate * Math.pow(price * (1 - price), feeExponent);
  return round4((feePerShare / price) * 10_000);
}

function applyPolymarketFeeToOutcomeQuote(quote: OutcomeQuote, clobMarketInfo: PolymarketClobMarketInfo | null) {
  const feeRateBps = derivePolymarketEffectiveFeeRateBps(clobMarketInfo, quote.buyPrice);
  return {
    ...quote,
    feeRateBps,
    execution: {
      ...quote.execution,
      feeRateBps,
    },
  };
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

function createVenueFeedHealth(feed: PolymarketQuote["feedHealth"]): PolymarketQuote["feedHealth"] {
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

  return new ClobClient({
    host: POLY_CLOB_BASE,
    chain: DEFAULT_POLY_CHAIN_ID,
    signer,
    creds,
    signatureType: mapSignatureType(env.POLY_SIGNATURE_TYPE),
    funderAddress: env.POLY_FUNDER_ADDRESS,
    useServerTime: true,
    retryOnError: true,
    throwOnError: true,
  });
}

function mapSignatureType(value: string) {
  switch (value) {
    case "EOA":
      return SignatureTypeV2.EOA;
    case "POLY_PROXY":
      return SignatureTypeV2.POLY_PROXY;
    case "POLY_GNOSIS_SAFE":
      return SignatureTypeV2.POLY_GNOSIS_SAFE;
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

async function refreshPolymarketBalanceAllowanceCache(client: ClobClient, params: BalanceAllowanceParams) {
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

export function extractPolymarketCollateralAllowanceInfo(collateral: PolymarketCollateralLike, signatureType?: string) {
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

export function extractPolymarketCollateralAllowanceUsd(collateral: PolymarketCollateralLike, signatureType?: string) {
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
  const conditional = await withPolymarketClientTimeout("getBalanceAllowance", () =>
    client.getBalanceAllowance(params),
  );
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
  if (isPolymarketPendingExposureOrderStatus(order.status) && matched > 0) {
    return "pending";
  }
  if (matched > 0 && matched < original) {
    return "partially_filled";
  }
  return "live";
}

export function mapPolymarketOrder(
  order: OpenOrder,
  intentId: string,
  context: PolymarketAssetMappingContext = {},
): LiveOrder {
  const createdAt = parsePolymarketTimestamp(order.created_at) ?? Date.now();
  const truth = resolvePolymarketOrderTruth({
    orderId: order.id,
    order,
    trades: [],
    expectedSize: Number(order.original_size),
    expectedSizeIsExact: String(order.side).toUpperCase() !== "BUY",
    orderType: order.order_type,
  });
  return {
    id: `polymarket:${order.id}`,
    asset: context.asset ?? inferPolymarketAsset(order.market),
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
    filledSize: truth.effectiveFilledSize,
    averageFillPrice: truth.averageFillPrice,
    feeUsd: null,
    status: truth.status,
    createdAt,
    updatedAt: createdAt,
    raw: order as unknown as Record<string, unknown>,
  };
}

export function mapPolymarketTradeToFill(
  trade: Trade,
  intentId: string,
  venueOrderIdOrContext?: string | PolymarketTradeMappingContext,
): LiveFill {
  const context =
    typeof venueOrderIdOrContext === "string" ? { venueOrderId: venueOrderIdOrContext } : (venueOrderIdOrContext ?? {});
  const mappingIssue = getPolymarketTradeOrderMappingIssue(trade, context.venueOrderId);
  if (mappingIssue === "maker_side_missing") {
    throw new Error(`Polymarket maker side missing for trade ${trade.id} and order ${context.venueOrderId}`);
  }
  const match = resolvePolymarketTradeOrderMatch(trade, context.venueOrderId) ?? buildAggregateTradeMatch(trade);
  const isMakerOrder = Boolean(context.venueOrderId && context.venueOrderId !== trade.taker_order_id);
  const side: "BUY" | "SELL" = match.side === Side.BUY ? "BUY" : "SELL";
  const filledAt =
    parsePolymarketTimestamp(trade.match_time) ?? parsePolymarketTimestamp(trade.last_update) ?? Date.now();
  return {
    id: `polymarket-fill:${trade.id}${isMakerOrder ? `:${context.venueOrderId}` : ""}`,
    asset: context.asset ?? inferPolymarketAsset(trade.market),
    shadow: false,
    intentId,
    venue: "polymarket" as const,
    venueOrderId: context.venueOrderId ?? trade.taker_order_id,
    tradeId: trade.id,
    marketRef: trade.market,
    tokenId: match.assetId,
    side,
    outcome: normalizePolymarketOutcome(match.outcome),
    price: match.price,
    size: match.size,
    // V2 applies platform and optional builder fees at match time. The trade
    // fee-rate field is not the charged amount; accounting replaces this zero
    // with the exact fee emitted by the Polygon OrderFilled event.
    feeUsd: 0,
    liquidity: match.liquidity,
    filledAt,
    raw: {
      ...(trade as unknown as Record<string, unknown>),
      feeAccounting: "polygon_order_filled_required",
    },
  };
}

export function summarizePolymarketTrades(trades: Trade[], orderId?: string) {
  const matches = trades
    .filter((trade) => isConfirmedPolymarketTrade(trade) || isPendingPolymarketTrade(trade))
    .map((trade) => resolvePolymarketTradeOrderMatch(trade, orderId))
    .filter((match): match is PolymarketTradeOrderMatch => match !== null);
  const filledSize = roundToSixDecimals(matches.reduce((sum, match) => sum + match.size, 0));
  const grossCostUsd = matches.reduce((sum, match) => sum + match.size * match.price, 0);

  return {
    filledSize,
    averageFillPrice: filledSize > 0 ? round4(grossCostUsd / filledSize) : null,
    feeUsd: 0,
  };
}

export function isConfirmedPolymarketTrade(trade: Trade) {
  return normalizePolymarketTradeStatus(trade.status) === "CONFIRMED";
}

export function isPendingPolymarketTrade(trade: Trade) {
  const status = normalizePolymarketTradeStatus(trade.status);
  return status === "MATCHED" || status === "MINED" || status === "RETRYING";
}

export function isFailedPolymarketTrade(trade: Trade) {
  return normalizePolymarketTradeStatus(trade.status) === "FAILED";
}

export function summarizePolymarketTradeLifecycle(trades: Trade[]) {
  return {
    confirmedTrades: trades.filter(isConfirmedPolymarketTrade),
    pendingTrades: trades.filter(isPendingPolymarketTrade),
    failedTrades: trades.filter(isFailedPolymarketTrade),
    unknownTrades: trades.filter((trade) => normalizePolymarketTradeStatus(trade.status) === null),
  };
}

export function extractPolymarketTradesForOrder(trades: Trade[], orderId: string) {
  return trades.filter(
    (trade) =>
      trade.taker_order_id === orderId || trade.maker_orders.some((makerOrder) => makerOrder.order_id === orderId),
  );
}

export type PolymarketTradeOrderMappingIssue = "maker_side_missing";

export function getPolymarketTradeOrderMappingIssue(
  trade: Trade,
  orderId?: string,
): PolymarketTradeOrderMappingIssue | null {
  if (!orderId || trade.taker_order_id === orderId) {
    return null;
  }

  const makerOrder = trade.maker_orders.find((candidate) => candidate.order_id === orderId);
  if (!makerOrder) {
    return null;
  }

  return makerOrder.side === Side.BUY || makerOrder.side === Side.SELL ? null : "maker_side_missing";
}

type PolymarketTradeOrderMatch = {
  assetId: string;
  liquidity: "TAKER" | "MAKER";
  outcome: string;
  price: number;
  side: Side;
  size: number;
};

function resolvePolymarketTradeOrderMatch(trade: Trade, orderId?: string): PolymarketTradeOrderMatch | null {
  if (!orderId || trade.taker_order_id === orderId) {
    return buildAggregateTradeMatch(trade);
  }

  const makerOrder = trade.maker_orders.find((candidate) => candidate.order_id === orderId);
  if (!makerOrder || (makerOrder.side !== Side.BUY && makerOrder.side !== Side.SELL)) {
    return null;
  }

  return {
    assetId: makerOrder.asset_id,
    liquidity: "MAKER",
    outcome: makerOrder.outcome,
    price: Number(makerOrder.price),
    side: makerOrder.side,
    size: Number(makerOrder.matched_amount),
  };
}

function buildAggregateTradeMatch(trade: Trade): PolymarketTradeOrderMatch {
  return {
    assetId: trade.asset_id,
    liquidity: trade.trader_side,
    outcome: trade.outcome,
    price: Number(trade.price),
    side: trade.side,
    size: Number(trade.size),
  };
}

async function getPolymarketOrderForConfirmation(orderId: string, timeoutMs = POLY_CLIENT_TIMEOUT_MS) {
  const client = createClobClient();
  return withPolymarketClientTimeout("getOrderConfirmation", () => client.getOrder(orderId), timeoutMs);
}

function getPolymarketOrderSizeMatched(order: OpenOrder | null) {
  const matched = Number(order?.size_matched ?? 0);
  return Number.isFinite(matched) && matched > 0 ? roundToSixDecimals(matched) : 0;
}

function getPolymarketOrderOriginalSize(order: OpenOrder | null) {
  const original = Number(order?.original_size ?? NaN);
  return Number.isFinite(original) && original > 0 ? original : null;
}

function getPolymarketOrderPrice(order: OpenOrder | null) {
  const price = Number(order?.price ?? NaN);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function isPolymarketPendingExposureOrderStatus(status: string) {
  const normalized = status.toLowerCase();
  return normalized === "matched" || normalized === "mined" || normalized === "retrying";
}

function isPolymarketTerminalOrderStatus(status: VenueOrderStatus) {
  return status === "canceled" || status === "expired" || status === "rejected";
}

function derivePolymarketTruthStatus(input: {
  orderStatus: VenueOrderStatus | null;
  effectiveFilledSize: number;
  expectedSizeSatisfied: boolean;
  hasPendingExposure: boolean;
}): VenueOrderStatus {
  if (input.hasPendingExposure) {
    return "pending";
  }
  if (input.effectiveFilledSize > 1e-6) {
    return input.expectedSizeSatisfied ? "filled" : "partially_filled";
  }

  return input.orderStatus ?? "live";
}

function roundToSixDecimals(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
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
