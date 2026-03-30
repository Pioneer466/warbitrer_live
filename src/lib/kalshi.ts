import { KALSHI_BASE } from "@/lib/constants";
import { fetchJson } from "@/lib/fetch-json";
import type { KalshiQuote, MarketSlot, OutcomeQuote } from "@/lib/types";

export type KalshiMarketSummary = {
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

const SLOT_TOLERANCE_MS = 1_000;

export async function fetchKalshiQuote(slot: MarketSlot): Promise<KalshiQuote> {
  const [list, series] = await Promise.all([
    fetchJson<KalshiMarketList>(`${KALSHI_BASE}/markets?series_ticker=KXBTC15M&status=open`),
    fetchJson<KalshiSeriesResponse>(`${KALSHI_BASE}/series/KXBTC15M`),
  ]);

  const market = resolveKalshiMarketForSlot(list.markets, slot);
  if (!market) {
    return createUnavailableKalshiQuote(
      slot,
      series.series,
      "Marché Kalshi du créneau courant indisponible",
    );
  }

  const orderbook = await fetchJson<KalshiOrderbook>(
    `${KALSHI_BASE}/markets/${market.ticker}/orderbook`,
  );
  const derived = deriveKalshiOutcomeQuotes(orderbook.orderbook_fp);

  return {
    ref: {
      venue: "kalshi",
      id: market.ticker,
      slotKey: buildSlotKeyFromIso(market.open_time),
      ticker: market.ticker,
      seriesTicker: series.series.ticker,
      title: market.title,
      url: `https://kalshi.com/markets/kxbtc15m/bitcoin-price-up-down/${market.event_ticker.toLowerCase()}`,
      startTime: market.open_time,
      endTime: market.close_time,
    },
    status: market.status,
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
      seriesTicker: series.ticker,
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
  };
}

function withinTolerance(left: number, right: number) {
  return Math.abs(left - right) <= SLOT_TOLERANCE_MS;
}

function getStatusRank(status: string) {
  return status === "active" ? 0 : status === "open" ? 1 : 2;
}
