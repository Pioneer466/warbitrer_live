import { buildSignals } from "@/lib/signals";
import type { KalshiQuote, PolymarketQuote, StrategyConfig, VenueBalance, VenueFeedHealth } from "@/lib/types";

const SLOT_KEY = "btc:1774899000000";

const readyFeed = (venue: "polymarket" | "kalshi"): VenueFeedHealth => ({
  asset: "btc",
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
  primaryRetryAttempts: 2,
  primaryRetryDelayMs: 200,
  hedgeRetryAttempts: 3,
  hedgeRetryDelayMs: 350,
  entryCutoffSeconds: 20,
  maxOpenIntentsPerSlot: 1,
  maxVenueExposureUsd: 1_000,
  polyBridgeLowWaterUsdc: 100,
  mismatchGuardEnabled: false,
  mismatchGuardMinElapsedSeconds: 60,
  mismatchGuardMinMoveBps: 5,
  mismatchGuardPhase2StartSeconds: 480,
  mismatchGuardPhase2MinMoveBps: 10,
  mismatchGuardMaxVenueDisagreementPct: 0.12,
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
    asset: "btc",
    venue: "polymarket",
    id: "poly-market",
    conditionId: "condition-1",
    slug: "btc-updown-15m-1774899000",
    title: "Poly BTC 15m",
    url: "https://polymarket.com/event/test",
    startTime: "2026-03-30T19:30:00.000Z",
    endTime: "2026-03-30T19:45:00.000Z",
    slotKey: SLOT_KEY,
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
  chainlinkLivePriceUsd: 100100,
  chainlinkLivePriceCapturedAt: 1774899060000,
  observedSlotOpenPriceUsd: 100000,
  observedSlotOpenCapturedAt: 1774899005000,
  feeRateBps: 10,
  negRisk: false,
};

const kalshi: KalshiQuote = {
  ref: {
    asset: "btc",
    venue: "kalshi",
    id: "KXBTC15M-26MAR301545-45",
    ticker: "KXBTC15M-26MAR301545-45",
    title: "BTC price up in next 15 mins?",
    url: "https://kalshi.com/markets/kxbtc15m/bitcoin-price-up-down/test",
    startTime: "2026-03-30T19:30:00.000Z",
    endTime: "2026-03-30T19:45:00.000Z",
    slotKey: SLOT_KEY,
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
  targetPriceUsd: 100010,
  feeMultiplier: 1,
  feeType: "quadratic",
  lastTradeYesPrice: 0.35,
  lastTradeNoPrice: 0.65,
  resolution: null,
};

function buildV3Settings(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    ...settings,
    mismatchGuardEnabled: true,
    entryCutoffSeconds: 180,
    mismatchGuardMinElapsedSeconds: 60,
    mismatchGuardMinMoveBps: 5,
    mismatchGuardPhase2StartSeconds: 480,
    mismatchGuardPhase2MinMoveBps: 10,
    ...overrides,
  };
}

describe("live signal engine", () => {
  it("marks the sub-threshold pair as eligible and chooses a primary venue", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
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

  it("keeps the polymarket leg at a 10 USD budget even when the venue minimum is 5 shares", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899060000,
      polymarket: {
        ...polymarket,
        outcomes: {
          ...polymarket.outcomes,
          up: {
            ...polymarket.outcomes.up,
            minOrderSize: 5,
          },
        },
      },
      kalshi,
      settings: {
        ...settings,
        maxPairNotionalUsd: 20,
      },
      balances,
      lastEntryCosts: {},
      secondsRemaining: 180,
    });

    expect(signal.eligible).toBe(true);
    expect(signal.legs[0].targetNotionalUsd).toBe(10);
    expect(signal.legs[0].size).toBeCloseTo(23.8, 2);
  });

  it("still prefers Kalshi as the primary venue even when Polymarket looks shallower on displayed depth", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899060000,
      polymarket: {
        ...polymarket,
        outcomes: {
          ...polymarket.outcomes,
          up: {
            ...polymarket.outcomes.up,
            depth: 30,
          },
        },
      },
      kalshi: {
        ...kalshi,
        outcomes: {
          ...kalshi.outcomes,
          no: {
            ...kalshi.outcomes.no,
            depth: 300,
          },
        },
      },
      settings: {
        ...settings,
        maxPairNotionalUsd: 20,
      },
      balances,
      lastEntryCosts: {},
      secondsRemaining: 180,
    });

    expect(signal.eligible).toBe(true);
    expect(signal.primaryVenue).toBe("kalshi");
  });

  it("blocks entries when the polymarket budget cannot satisfy the venue minimum size", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899060000,
      polymarket: {
        ...polymarket,
        outcomes: {
          ...polymarket.outcomes,
          up: {
            ...polymarket.outcomes.up,
            minOrderSize: 25,
          },
        },
      },
      kalshi,
      settings: {
        ...settings,
        maxPairNotionalUsd: 20,
      },
      balances,
      lastEntryCosts: {},
      secondsRemaining: 180,
    });

    expect(signal.eligible).toBe(false);
    expect(signal.reasons).toContain("Taille minimum Polymarket non atteinte");
  });

  it("blocks re-entry when the improvement is below the configured threshold", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
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
      slotKey: SLOT_KEY,
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

  it("blocks entries when Polymarket already looks terminal", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899060000,
      polymarket: {
        ...polymarket,
        status: "closed",
        resolution: "UP",
      },
      kalshi,
      settings,
      balances,
      lastEntryCosts: {},
      secondsRemaining: 180,
    });

    expect(signal.eligible).toBe(false);
    expect(signal.reasons).toContain("Marché Polymarket déjà résolu");
  });

  it("blocks entries when Kalshi already looks terminal", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899060000,
      polymarket,
      kalshi: {
        ...kalshi,
        status: "finalized",
        resolution: "YES",
      },
      settings,
      balances,
      lastEntryCosts: {},
      secondsRemaining: 180,
    });

    expect(signal.eligible).toBe(false);
    expect(signal.reasons).toContain("Marché Kalshi déjà résolu");
  });

  it("blocks entries when a venue feed is stale", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
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

  it("shares the same slot-level mismatch metrics across both opportunities", () => {
    const [first, second] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899120000,
      slotStartTs: 1774899000000,
      polymarket: {
        ...polymarket,
        chainlinkLivePriceUsd: 100120,
      },
      kalshi: {
        ...kalshi,
        targetPriceUsd: 100015,
      },
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(first.mismatchRisk).toBe("low");
    expect(second.mismatchRisk).toBe("low");
    expect(second.venueDisagreementPct).toBe(first.venueDisagreementPct);
    expect(second.secondsElapsedInSlot).toBe(first.secondsElapsedInSlot);
    expect(second.chainlinkMoveBps).toBe(first.chainlinkMoveBps);
    expect(second.openDriftBps).toBe(first.openDriftBps);
    expect(second.chainlinkLivePriceUsd).toBe(first.chainlinkLivePriceUsd);
    expect(second.observedSlotOpenPriceUsd).toBe(first.observedSlotOpenPriceUsd);
    expect(second.kalshiTargetPriceUsd).toBe(first.kalshiTargetPriceUsd);
  });

  it("marks mismatch risk high when the slot is too recent", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899030000,
      slotStartTs: 1774899000000,
      polymarket,
      kalshi,
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(signal.mismatchRisk).toBe("high");
    expect(signal.eligible).toBe(false);
    expect(signal.reasons.join(" | ")).toContain("créneau trop récent");
  });

  it("marks mismatch risk high when the Chainlink move is too small", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899120000,
      slotStartTs: 1774899000000,
      polymarket: {
        ...polymarket,
        chainlinkLivePriceUsd: 100040,
      },
      kalshi: {
        ...kalshi,
        targetPriceUsd: 100010,
      },
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(signal.mismatchRisk).toBe("high");
    expect(signal.eligible).toBe(false);
    expect(signal.chainlinkMoveBps).toBe(4);
    expect(signal.reasons.join(" | ")).toContain("mouvement Chainlink trop faible");
  });

  it("marks mismatch risk high when open drift dominates the live move", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899120000,
      slotStartTs: 1774899000000,
      polymarket: {
        ...polymarket,
        chainlinkLivePriceUsd: 100110,
      },
      kalshi: {
        ...kalshi,
        targetPriceUsd: 100120,
      },
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(signal.mismatchRisk).toBe("high");
    expect(signal.eligible).toBe(false);
    expect(signal.chainlinkMoveBps).toBe(11);
    expect(signal.openDriftBps).toBeCloseTo(11.9856, 4);
    expect(signal.reasons.join(" | ")).toContain("écart d'ouverture dominant");
  });

  it("marks mismatch risk high when venue disagreement is too wide", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899120000,
      slotStartTs: 1774899000000,
      polymarket,
      kalshi: {
        ...kalshi,
        outcomes: {
          ...kalshi.outcomes,
          yes: {
            ...kalshi.outcomes.yes,
            buyPrice: 0.24,
            sellPrice: 0.23,
            midPrice: 0.235,
            bestBid: 0.23,
            bestAsk: 0.24,
            execution: {
              ...kalshi.outcomes.yes.execution,
              buyPrice: 0.24,
              sellPrice: 0.23,
              midPrice: 0.235,
              bestBid: 0.23,
              bestAsk: 0.24,
            },
            chart: {
              ...kalshi.outcomes.yes.chart,
              price: 0.24,
            },
          },
        },
      },
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(signal.mismatchRisk).toBe("high");
    expect(signal.eligible).toBe(false);
    expect(signal.venueDisagreementPct).toBe(0.18);
    expect(signal.reasons.join(" | ")).toContain("désaccord venues élevé");
  });

  it("marks mismatch risk medium on borderline proxy conditions without blocking the entry", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899120000,
      slotStartTs: 1774899000000,
      polymarket: {
        ...polymarket,
        chainlinkLivePriceUsd: 100065,
      },
      kalshi: {
        ...kalshi,
        targetPriceUsd: 100014,
      },
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(signal.mismatchRisk).toBe("medium");
    expect(signal.eligible).toBe(true);
    expect(signal.reasons).toEqual([]);
  });

  it("blocks when the Chainlink live reference is missing", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899120000,
      slotStartTs: 1774899000000,
      polymarket: {
        ...polymarket,
        chainlinkLivePriceUsd: null,
        chainlinkLivePriceCapturedAt: null,
      },
      kalshi,
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(signal.mismatchRisk).toBe("high");
    expect(signal.eligible).toBe(false);
    expect(signal.chainlinkMoveBps).toBeNull();
    expect(signal.reasons.join(" | ")).toContain("données de référence indisponibles");
  });

  it("blocks when the observed slot open snapshot is missing", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899120000,
      slotStartTs: 1774899000000,
      polymarket: {
        ...polymarket,
        observedSlotOpenPriceUsd: null,
        observedSlotOpenCapturedAt: null,
      },
      kalshi,
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(signal.mismatchRisk).toBe("high");
    expect(signal.eligible).toBe(false);
    expect(signal.chainlinkMoveBps).toBeNull();
    expect(signal.openDriftBps).toBeNull();
    expect(signal.reasons.join(" | ")).toContain("données de référence indisponibles");
  });

  it("blocks before 60s and switches into the standard guard window at 60s", () => {
    const [tooEarly] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899059000,
      slotStartTs: 1774899000000,
      polymarket: {
        ...polymarket,
        chainlinkLivePriceUsd: 100050,
      },
      kalshi: {
        ...kalshi,
        targetPriceUsd: 100005,
      },
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    const [standardWindow] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899060000,
      slotStartTs: 1774899000000,
      polymarket: {
        ...polymarket,
        chainlinkLivePriceUsd: 100050,
      },
      kalshi: {
        ...kalshi,
        targetPriceUsd: 100005,
      },
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(tooEarly.mismatchRisk).toBe("high");
    expect(tooEarly.eligible).toBe(false);
    expect(tooEarly.reasons.join(" | ")).toContain("créneau trop récent");
    expect(standardWindow.mismatchRisk).toBe("medium");
    expect(standardWindow.eligible).toBe(true);
    expect(standardWindow.reasons).toEqual([]);
  });

  it("keeps the standard threshold before phase 2 starts", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899479000,
      slotStartTs: 1774899000000,
      polymarket: {
        ...polymarket,
        chainlinkLivePriceUsd: 100070,
      },
      kalshi: {
        ...kalshi,
        targetPriceUsd: 100005,
      },
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(signal.secondsElapsedInSlot).toBe(479);
    expect(signal.chainlinkMoveBps).toBe(7);
    expect(signal.mismatchRisk).toBe("medium");
    expect(signal.eligible).toBe(true);
  });

  it("switches to the stricter late threshold at 480s", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899480000,
      slotStartTs: 1774899000000,
      polymarket: {
        ...polymarket,
        chainlinkLivePriceUsd: 100070,
      },
      kalshi: {
        ...kalshi,
        targetPriceUsd: 100005,
      },
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(signal.secondsElapsedInSlot).toBe(480);
    expect(signal.chainlinkMoveBps).toBe(7);
    expect(signal.mismatchRisk).toBe("high");
    expect(signal.eligible).toBe(false);
    expect(signal.reasons.join(" | ")).toContain("fenêtre tardive");
    expect(signal.reasons.join(" | ")).toContain("10.00 bps");
  });

  it("keeps the stricter late threshold active until the cutoff window", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899719000,
      slotStartTs: 1774899000000,
      polymarket: {
        ...polymarket,
        chainlinkLivePriceUsd: 100070,
      },
      kalshi: {
        ...kalshi,
        targetPriceUsd: 100005,
      },
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(signal.secondsElapsedInSlot).toBe(719);
    expect(signal.mismatchRisk).toBe("high");
    expect(signal.eligible).toBe(false);
    expect(signal.reasons.join(" | ")).toContain("10.00 bps");
  });

  it("blocks at 720s because the entry cutoff window starts", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899720000,
      slotStartTs: 1774899000000,
      secondsRemaining: 180,
      polymarket: {
        ...polymarket,
        chainlinkLivePriceUsd: 100250,
      },
      kalshi: {
        ...kalshi,
        targetPriceUsd: 100005,
      },
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(signal.secondsElapsedInSlot).toBe(720);
    expect(signal.mismatchRisk).toBe("low");
    expect(signal.eligible).toBe(false);
    expect(signal.reasons).toContain("Entrée bloquée sur les 180 dernières secondes");
  });

  it("allows a 7 bps move mid-slot but blocks the same move in the late window", () => {
    const [midSlot] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899300000,
      slotStartTs: 1774899000000,
      polymarket: {
        ...polymarket,
        chainlinkLivePriceUsd: 100070,
      },
      kalshi: {
        ...kalshi,
        targetPriceUsd: 100005,
      },
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    const [lateSlot] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899600000,
      slotStartTs: 1774899000000,
      polymarket: {
        ...polymarket,
        chainlinkLivePriceUsd: 100070,
      },
      kalshi: {
        ...kalshi,
        targetPriceUsd: 100005,
      },
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(midSlot.secondsElapsedInSlot).toBe(300);
    expect(midSlot.mismatchRisk).toBe("medium");
    expect(midSlot.eligible).toBe(true);
    expect(lateSlot.secondsElapsedInSlot).toBe(600);
    expect(lateSlot.mismatchRisk).toBe("high");
    expect(lateSlot.eligible).toBe(false);
    expect(lateSlot.reasons.join(" | ")).toContain("10.00 bps");
  });
});
