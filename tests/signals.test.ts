import { buildSignals } from "@/lib/signals";
import type { KalshiQuote, PolymarketQuote, StrategyConfig, VenueBalance, VenueFeedHealth } from "@/lib/types";

const readyFeed = (venue: "polymarket" | "kalshi"): VenueFeedHealth => ({
  venue,
  feedStatus: "ready",
  source: "ws",
  lastMessageAt: 1774899060000,
  stalenessMs: 0,
  details: ["feed ok"],
  subscriptions: [],
});

const settings: StrategyConfig = {
  enableTrading: true,
  shadowMode: true,
  maxPairNotionalUsd: 50,
  grossEntryThreshold: 0.93,
  maxLegPrice: 0.49,
  reentryImprovement: 0.01,
  pollingIntervalMs: 1_000,
  minOrderSize: 0.01,
  maxSlippageBps: 30,
  immediateOrderConfirmationTimeoutMs: 8_000,
  executionPriceBuffer: 0.01,
  hedgeRetryAttempts: 3,
  hedgeRetryDelayMs: 350,
  entryCutoffSeconds: 20,
  maxOpenIntentsPerSlot: 1,
  maxVenueExposureUsd: 1_000,
  polyBridgeLowWaterUsdc: 100,
};

const balances: VenueBalance[] = [
  {
    venue: "polymarket",
    capturedAt: 0,
    status: "ready",
    currency: "USDC",
    availableBalanceUsd: 1_000,
    totalBalanceUsd: 1_000,
    portfolioValueUsd: 1_000,
    allowanceUsd: 1_000,
    notes: [],
    raw: {},
  },
  {
    venue: "kalshi",
    capturedAt: 0,
    status: "ready",
    currency: "USD",
    availableBalanceUsd: 1_000,
    totalBalanceUsd: 1_000,
    portfolioValueUsd: 1_000,
    allowanceUsd: null,
    notes: [],
    raw: {},
  },
];

const polymarket: PolymarketQuote = {
  ref: {
    venue: "polymarket",
    id: "poly-market",
    conditionId: "condition-1",
    slug: "btc-updown-15m-1774899000",
    title: "Poly BTC 15m",
    url: "https://polymarket.com/event/test",
    startTime: "2026-03-30T19:30:00.000Z",
    endTime: "2026-03-30T19:45:00.000Z",
    slotKey: "1774899000000",
  },
  conditionId: "condition-1",
  status: "open",
  slotAligned: true,
  availabilityReason: null,
  feedHealth: readyFeed("polymarket"),
  lastMessageAt: 1774899060000,
  stalenessMs: 0,
  source: "ws",
  outcomes: {
    up: {
      outcome: "UP",
      buyPrice: 0.42,
      sellPrice: 0.41,
      midPrice: 0.415,
      bestBid: 0.41,
      bestAsk: 0.42,
      depth: 300,
      tickSize: 0.001,
      minOrderSize: 0.01,
      feeRateBps: 10,
      execution: {
        buyPrice: 0.42,
        sellPrice: 0.41,
        midPrice: 0.415,
        bestBid: 0.41,
        bestAsk: 0.42,
        depth: 300,
        tickSize: 0.001,
        minOrderSize: 0.01,
        feeRateBps: 10,
      },
      chart: {
        label: "best_ask_live",
        price: 0.42,
        source: "ws",
        lastUpdatedAt: 1774899060000,
      },
    },
    down: {
      outcome: "DOWN",
      buyPrice: 0.59,
      sellPrice: 0.58,
      midPrice: 0.585,
      bestBid: 0.58,
      bestAsk: 0.59,
      depth: 300,
      tickSize: 0.001,
      minOrderSize: 0.01,
      feeRateBps: 10,
      execution: {
        buyPrice: 0.59,
        sellPrice: 0.58,
        midPrice: 0.585,
        bestBid: 0.58,
        bestAsk: 0.59,
        depth: 300,
        tickSize: 0.001,
        minOrderSize: 0.01,
        feeRateBps: 10,
      },
      chart: {
        label: "best_ask_live",
        price: 0.59,
        source: "ws",
        lastUpdatedAt: 1774899060000,
      },
    },
  },
  resolution: null,
  tokenIds: {
    up: "up-token",
    down: "down-token",
  },
  feeRateBps: 10,
  negRisk: false,
};

const kalshi: KalshiQuote = {
  ref: {
    venue: "kalshi",
    id: "KXBTC15M-26MAR301545-45",
    ticker: "KXBTC15M-26MAR301545-45",
    title: "BTC price up in next 15 mins?",
    url: "https://kalshi.com/markets/kxbtc15m/bitcoin-price-up-down/test",
    startTime: "2026-03-30T19:30:00.000Z",
    endTime: "2026-03-30T19:45:00.000Z",
    slotKey: "1774899000000",
  },
  status: "active",
  slotAligned: true,
  availabilityReason: null,
  feedHealth: readyFeed("kalshi"),
  lastMessageAt: 1774899060000,
  stalenessMs: 0,
  source: "ws",
  outcomes: {
    yes: {
      outcome: "YES",
      buyPrice: 0.35,
      sellPrice: 0.34,
      midPrice: 0.345,
      bestBid: 0.34,
      bestAsk: 0.35,
      depth: 180,
      tickSize: 0.001,
      minOrderSize: 1,
      feeRateBps: null,
      execution: {
        buyPrice: 0.35,
        sellPrice: 0.34,
        midPrice: 0.345,
        bestBid: 0.34,
        bestAsk: 0.35,
        depth: 180,
        tickSize: 0.001,
        minOrderSize: 1,
        feeRateBps: null,
      },
      chart: {
        label: "best_ask_live",
        price: 0.35,
        source: "ws",
        lastUpdatedAt: 1774899060000,
      },
    },
    no: {
      outcome: "NO",
      buyPrice: 0.49,
      sellPrice: 0.48,
      midPrice: 0.485,
      bestBid: 0.48,
      bestAsk: 0.49,
      depth: 180,
      tickSize: 0.001,
      minOrderSize: 1,
      feeRateBps: null,
      execution: {
        buyPrice: 0.49,
        sellPrice: 0.48,
        midPrice: 0.485,
        bestBid: 0.48,
        bestAsk: 0.49,
        depth: 180,
        tickSize: 0.001,
        minOrderSize: 1,
        feeRateBps: null,
      },
      chart: {
        label: "best_ask_live",
        price: 0.49,
        source: "ws",
        lastUpdatedAt: 1774899060000,
      },
    },
  },
  feeMultiplier: 1,
  feeType: "quadratic",
  lastTradeYesPrice: 0.35,
  lastTradeNoPrice: 0.65,
  resolution: null,
};

describe("live signal engine", () => {
  it("marks the sub-threshold pair as eligible and chooses a primary venue", () => {
    const [signal] = buildSignals({
      slotKey: "1774899000000",
      now: 1774899060000,
      polymarket,
      kalshi,
      settings,
      balances,
      lastEntryCosts: {},
      secondsRemaining: 180,
    });

    expect(signal.combination).toBe("POLY_UP_KALSHI_NO");
    expect(signal.grossCost).toBe(0.91);
    expect(signal.eligible).toBe(true);
    expect(signal.primaryVenue).toBe("kalshi");
    expect(signal.legs[0].size).toBeGreaterThan(0);
    expect(signal.legs[1].size).toBeGreaterThan(0);
  });

  it("blocks re-entry when the improvement is below the configured threshold", () => {
    const [signal] = buildSignals({
      slotKey: "1774899000000",
      now: 1774899060000,
      polymarket,
      kalshi,
      settings,
      balances,
      lastEntryCosts: {
        POLY_UP_KALSHI_NO: 0.915,
      },
      secondsRemaining: 180,
    });

    expect(signal.eligible).toBe(false);
    expect(signal.reasons).toContain("Pas d'amélioration suffisante");
  });

  it("blocks late entries inside the cutoff window", () => {
    const [signal] = buildSignals({
      slotKey: "1774899000000",
      now: 1774899060000,
      polymarket,
      kalshi,
      settings,
      balances,
      lastEntryCosts: {},
      secondsRemaining: 20,
    });

    expect(signal.eligible).toBe(false);
    expect(signal.reasons).toContain("Entrée bloquée sur les 20 dernières secondes");
  });

  it("blocks entries when a venue feed is stale", () => {
    const [signal] = buildSignals({
      slotKey: "1774899000000",
      now: 1774899060000,
      polymarket: {
        ...polymarket,
        feedHealth: {
          ...polymarket.feedHealth,
          feedStatus: "degraded",
          stalenessMs: 2_800,
        },
      },
      kalshi,
      settings,
      balances,
      lastEntryCosts: {},
      secondsRemaining: 180,
    });

    expect(signal.eligible).toBe(false);
    expect(signal.reasons).toContain("Feed Polymarket stale");
  });
});
