import { POLY_CLOB_BASE, POLY_GAMMA_BASE } from "@/lib/constants";
import { fetchJson } from "@/lib/fetch-json";
import type { MarketSlot, OutcomeQuote, PolymarketQuote } from "@/lib/types";

type GammaMarketResponse = Array<{
  id: string;
  question: string;
  slug: string;
  endDate: string;
  startDate: string;
  outcomes: string;
  clobTokenIds: string;
  feeType: string | null;
  feeSchedule: {
    rate: number;
    exponent: number;
    takerOnly: boolean;
    rebateRate: number;
  } | null;
  active: boolean;
  closed: boolean;
  bestBid?: number;
  bestAsk?: number;
  events?: Array<{
    id: string;
    slug: string;
    title: string;
  }>;
  enableOrderBook: boolean;
  outcomePrices: string;
}>;

type CLOBBook = {
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
};

type PriceResponse = { price: string };
type MidpointResponse = { mid: string };

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
      title: market.question,
      url: `https://polymarket.com/event/${market.slug}`,
      startTime: market.startDate,
      endTime: market.endDate,
    },
    status: market.closed ? "closed" : "open",
    slotAligned: true,
    availabilityReason: null,
    outcomes: {
      up: upQuote,
      down: downQuote,
    },
    feeRate: market.feeSchedule?.rate ?? 0.25,
    feeExponent: market.feeSchedule?.exponent ?? 2,
    feeType: market.feeType,
    feeScheduleRaw: market.feeSchedule,
    resolution: extractPolymarketResolution(market.outcomePrices),
    tokenIds: {
      up: upTokenId,
      down: downTokenId,
    },
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
  const levels = [...book.asks, ...book.bids]
    .map((level) => ({
      price: Number(level.price),
      size: Number(level.size),
    }))
    .sort((left, right) => Math.abs(left.price - executionPrice) - Math.abs(right.price - executionPrice));

  return levels[0]?.size ?? null;
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

  return {
    outcome,
    buyPrice,
    sellPrice,
    midPrice: Number(midpoint.mid),
    bestBid: sellPrice,
    bestAsk: buyPrice,
    depth: derivePolymarketDepth(book, buyPrice),
  };
}

async function fetchPolymarketMarket(slug: string) {
  const markets = await fetchJson<GammaMarketResponse>(`${POLY_GAMMA_BASE}/markets?slug=${slug}`);
  return markets[0] ?? null;
}
