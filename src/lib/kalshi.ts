import { KALSHI_BASE } from "@/lib/constants";
import { fetchJson } from "@/lib/fetch-json";
import type { KalshiQuote, OutcomeQuote } from "@/lib/types";

type KalshiMarketList = {
  markets: Array<{
    ticker: string;
    event_ticker: string;
    title: string;
    open_time: string;
    close_time: string;
    status: string;
    yes_bid_dollars: string;
    yes_ask_dollars: string;
    no_bid_dollars: string;
    no_ask_dollars: string;
    yes_bid_size_fp: string;
    yes_ask_size_fp: string;
    no_bid_size_fp: string;
    no_ask_size_fp: string;
  }>;
};

type KalshiSeriesResponse = {
  series: {
    ticker: string;
    fee_multiplier: number;
    fee_type: string;
    title: string;
  };
};

type KalshiOrderbook = {
  orderbook_fp: {
    yes_dollars: Array<[string, string]>;
    no_dollars: Array<[string, string]>;
  };
};

type KalshiMarketResponse = {
  market: {
    ticker: string;
    event_ticker: string;
    title: string;
    open_time: string;
    close_time: string;
    status: string;
    result: "yes" | "no" | "";
    yes_bid_dollars: string;
    yes_ask_dollars: string;
    no_bid_dollars: string;
    no_ask_dollars: string;
    yes_bid_size_fp: string;
    yes_ask_size_fp: string;
    no_bid_size_fp: string;
    no_ask_size_fp: string;
  };
};

export async function fetchKalshiQuote(): Promise<KalshiQuote> {
  const [list, series] = await Promise.all([
    fetchJson<KalshiMarketList>(`${KALSHI_BASE}/markets?series_ticker=KXBTC15M&status=open`),
    fetchJson<KalshiSeriesResponse>(`${KALSHI_BASE}/series/KXBTC15M`),
  ]);

  const market =
    list.markets.find((candidate) => candidate.status === "active") ??
    list.markets.find((candidate) => candidate.status === "open") ??
    list.markets[0];
  if (!market) {
    throw new Error("Aucun marché Kalshi actif pour KXBTC15M");
  }

  const orderbook = await fetchJson<KalshiOrderbook>(
    `${KALSHI_BASE}/markets/${market.ticker}/orderbook`,
  );
  const derived = deriveKalshiOutcomeQuotes(orderbook.orderbook_fp);

  return {
    ref: {
      venue: "kalshi",
      id: market.ticker,
      ticker: market.ticker,
      seriesTicker: series.series.ticker,
      title: market.title,
      url: `https://kalshi.com/markets/kxbtc15m/bitcoin-price-up-down/${market.event_ticker.toLowerCase()}`,
      startTime: market.open_time,
      endTime: market.close_time,
    },
    status: market.status,
    outcomes: derived,
    feeMultiplier: series.series.fee_multiplier,
    feeType: series.series.fee_type,
    resolution: null,
  };
}

export async function fetchKalshiResolution(ticker: string) {
  const response = await fetchJson<KalshiMarketResponse>(`${KALSHI_BASE}/markets/${ticker}`);
  if (response.market.status !== "finalized" || !response.market.result) {
    return null;
  }

  return response.market.result === "yes" ? ("YES" as const) : ("NO" as const);
}

export function deriveKalshiOutcomeQuotes(orderbook: KalshiOrderbook["orderbook_fp"]) {
  const yesBidLevel = getBestLevel(orderbook.yes_dollars);
  const noBidLevel = getBestLevel(orderbook.no_dollars);

  const yesBid = yesBidLevel?.price ?? null;
  const noBid = noBidLevel?.price ?? null;
  const yesAsk = noBid === null ? null : round4(1 - noBid);
  const noAsk = yesBid === null ? null : round4(1 - yesBid);

  const yesOutcome: OutcomeQuote = {
    outcome: "YES",
    buyPrice: yesAsk,
    sellPrice: yesBid,
    midPrice: yesAsk !== null && yesBid !== null ? round4((yesAsk + yesBid) / 2) : null,
    bestBid: yesBid,
    bestAsk: yesAsk,
    depth: noBidLevel?.size ?? null,
  };

  const noOutcome: OutcomeQuote = {
    outcome: "NO",
    buyPrice: noAsk,
    sellPrice: noBid,
    midPrice: noAsk !== null && noBid !== null ? round4((noAsk + noBid) / 2) : null,
    bestBid: noBid,
    bestAsk: noAsk,
    depth: yesBidLevel?.size ?? null,
  };

  return {
    yes: yesOutcome,
    no: noOutcome,
  };
}

function getBestLevel(levels: Array<[string, string]>) {
  if (levels.length === 0) {
    return null;
  }

  const bestLevel = levels
    .map(([levelPrice, levelSize]) => ({
      price: Number(levelPrice),
      size: Number(levelSize),
    }))
    .sort((left, right) => right.price - left.price)[0];

  return bestLevel;
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
