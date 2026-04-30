import { buildSignals } from "@/lib/signals";
import type {
  KalshiQuote,
  OutcomeQuote,
  PolymarketQuote,
  StrategyConfig,
  VenueBalance,
  VenueFeedHealth,
} from "@/lib/types";

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
  maxLegCapitalShare: 0.7,
  maxSignalAgeMs: 1000,
  grossEntryThreshold: 0.93,
  minProjectedNetProfitUsd: 0,
  minProjectedNetReturn: 0,
  minWorstCaseProfitUsd: 0,
  maxLegPrice: 0.49,
  reentryImprovement: 0.01,
  pollingIntervalMs: 1_000,
  minOrderSize: 0.01,
  maxSlippageBps: 30,
  immediateOrderConfirmationTimeoutMs: 8_000,
  executionPriceBuffer: 0.01,
  kalshiDepthHeadroomContracts: 2,
  kalshiPrimaryDepthSafetyFactor: 0.7,
  kalshiPrimaryPriceTicksSlippage: 2,
  kalshiPrimaryProbeClipContracts: 5,
  kalshiPrimaryMaxClipContracts: 10,
  kalshiPrimaryMaxClips: 4,
  polymarketHedgeDepthSafetyFactor: 0.8,
  polymarketHedgeHeadroomShares: 1,
  polymarketHedgeBookMaxAgeMs: 500,
  primaryRetryAttempts: 2,
  primaryRetryDelayMs: 200,
  hedgeRetryAttempts: 3,
  hedgeRetryDelayMs: 350,
  hedgeRescueEnabled: true,
  hedgeRescueMaxAttempts: 3,
  hedgeRescueDelayMs: 150,
  hedgeRescueMaxLossUsd: 1,
  hedgeRescueMinAdvantageUsd: 0.05,
  hedgeRescueAllowPartial: true,
  forcedUnwindEnabled: true,
  forcedUnwindMaxAttempts: 3,
  forcedUnwindTickLadder: [1, 3, 6],
  forcedUnwindMaxLossUsd: 2,
  forcedUnwindHoldSecondsToSettlement: 45,
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
  orderbookLevels: null,
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

function withOutcomeQuote(outcome: OutcomeQuote, patch: Partial<OutcomeQuote>): OutcomeQuote {
  const next = {
    ...outcome,
    ...patch,
  };

  return {
    ...next,
    execution: {
      ...outcome.execution,
      buyPrice: next.buyPrice,
      sellPrice: next.sellPrice,
      midPrice: next.midPrice,
      bestBid: next.bestBid,
      bestAsk: next.bestAsk,
      depth: next.depth,
      minOrderSize: next.minOrderSize,
      feeRateBps: next.feeRateBps,
    },
    chart: {
      ...outcome.chart,
      price: next.buyPrice,
    },
  };
}

function tradablePolymarket(overrides: Partial<PolymarketQuote> = {}): PolymarketQuote {
  const base = {
    ...polymarket,
    outcomes: {
      up: withOutcomeQuote(polymarket.outcomes.up, {
        buyPrice: 0.42,
        sellPrice: 0.41,
        midPrice: 0.415,
        bestBid: 0.41,
        bestAsk: 0.42,
        depth: 300,
      }),
      down: withOutcomeQuote(polymarket.outcomes.down, {
        buyPrice: 0.42,
        sellPrice: 0.41,
        midPrice: 0.415,
        bestBid: 0.41,
        bestAsk: 0.42,
        depth: 300,
      }),
    },
  };

  return {
    ...base,
    ...overrides,
    outcomes: overrides.outcomes ?? base.outcomes,
  };
}

function tradableKalshi(overrides: Partial<KalshiQuote> = {}): KalshiQuote {
  const base = {
    ...kalshi,
    outcomes: {
      yes: withOutcomeQuote(kalshi.outcomes.yes, {
        buyPrice: 0.35,
        sellPrice: 0.34,
        midPrice: 0.345,
        bestBid: 0.34,
        bestAsk: 0.35,
        depth: 180,
      }),
      no: withOutcomeQuote(kalshi.outcomes.no, {
        buyPrice: 0.35,
        sellPrice: 0.34,
        midPrice: 0.345,
        bestBid: 0.34,
        bestAsk: 0.35,
        depth: 180,
      }),
    },
  };

  return {
    ...base,
    ...overrides,
    outcomes: overrides.outcomes ?? base.outcomes,
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

  it("sizes an asymmetric balanced payout pair under the total pair budget", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899060000,
      polymarket: {
        ...polymarket,
        outcomes: {
          ...polymarket.outcomes,
          up: withOutcomeQuote(polymarket.outcomes.up, {
            buyPrice: 0.35,
            depth: 300,
          }),
        },
      },
      kalshi: {
        ...kalshi,
        outcomes: {
          ...kalshi.outcomes,
          no: withOutcomeQuote(kalshi.outcomes.no, {
            buyPrice: 0.58,
            depth: 300,
          }),
        },
      },
      settings: {
        ...settings,
        maxPairNotionalUsd: 20,
        kalshiDepthHeadroomContracts: 0,
        kalshiPrimaryDepthSafetyFactor: 1,
      },
      balances,
      lastEntryCosts: {},
      secondsRemaining: 180,
    });

    const polyCost = signal.legs[0].targetNotionalUsd + signal.legs[0].feeEstimateUsd;
    const kalshiCost = signal.legs[1].targetNotionalUsd + signal.legs[1].feeEstimateUsd;

    expect(signal.combination).toBe("POLY_UP_KALSHI_NO");
    expect(signal.grossCost).toBe(0.93);
    expect(signal.eligible).toBe(true);
    expect(signal.legs[0].size).toBeGreaterThan(0);
    expect(signal.legs[0].size).toBe(signal.legs[1].size);
    expect(signal.legs[1].targetNotionalUsd).toBeGreaterThan(signal.legs[0].targetNotionalUsd);
    expect(polyCost + kalshiCost).toBeLessThanOrEqual(20);
    expect(polyCost).toBeLessThanOrEqual(14);
    expect(kalshiCost).toBeLessThanOrEqual(14);
    expect(signal.projectedNetProfitUsd).toBeGreaterThan(0);
  });

  it("blocks otherwise valid signals when configured net profit floors are not met", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899060000,
      polymarket,
      kalshi,
      settings: {
        ...settings,
        minProjectedNetProfitUsd: 999,
        minProjectedNetReturn: 0.5,
        minWorstCaseProfitUsd: 999,
      },
      balances,
      lastEntryCosts: {},
      secondsRemaining: 180,
    });

    expect(signal.eligible).toBe(false);
    expect(signal.reasons.join(" | ")).toContain("Profit net projeté trop faible");
    expect(signal.reasons.join(" | ")).toContain("ROI net projeté trop faible");
    expect(signal.reasons.join(" | ")).toContain("Profit worst-case trop faible");
  });

  it("blocks entries whose Polymarket hedge notional is below the $1 execution floor", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899060000,
      polymarket: {
        ...polymarket,
        outcomes: {
          ...polymarket.outcomes,
          up: withOutcomeQuote(polymarket.outcomes.up, {
            buyPrice: 0.1,
            depth: 100,
          }),
        },
      },
      kalshi: {
        ...kalshi,
        outcomes: {
          ...kalshi.outcomes,
          no: withOutcomeQuote(kalshi.outcomes.no, {
            buyPrice: 0.78,
            depth: 100,
          }),
        },
      },
      settings: {
        ...settings,
        maxPairNotionalUsd: 1.1,
        maxLegCapitalShare: 0.9,
        minOrderSize: 1,
        kalshiDepthHeadroomContracts: 0,
      },
      balances,
      lastEntryCosts: {},
      secondsRemaining: 180,
    });

    expect(signal.eligible).toBe(false);
    expect(signal.reasons).toContain("Hedge Polymarket sous minimum $1.00");
  });

  it("blocks a pair above the gross entry threshold even when asymmetric sizing is possible", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899060000,
      polymarket: {
        ...polymarket,
        outcomes: {
          ...polymarket.outcomes,
          up: withOutcomeQuote(polymarket.outcomes.up, {
            buyPrice: 0.35,
            depth: 300,
          }),
        },
      },
      kalshi: {
        ...kalshi,
        outcomes: {
          ...kalshi.outcomes,
          no: withOutcomeQuote(kalshi.outcomes.no, {
            buyPrice: 0.59,
            depth: 300,
          }),
        },
      },
      settings: {
        ...settings,
        maxPairNotionalUsd: 20,
        kalshiDepthHeadroomContracts: 0,
        kalshiPrimaryDepthSafetyFactor: 1,
      },
      balances,
      lastEntryCosts: {},
      secondsRemaining: 180,
    });

    expect(signal.grossCost).toBe(0.94);
    expect(signal.eligible).toBe(false);
    expect(signal.reasons).toContain("Seuil brut non atteint");
    expect(signal.legs[0].size).toBeGreaterThan(0);
  });

  it("keeps the pair inside the total fee-aware budget even when the venue minimum is 5 shares", () => {
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
    expect(signal.legs[0].targetNotionalUsd).toBeCloseTo(8.82, 4);
    expect(signal.legs[0].size).toBe(21);
    expect(signal.legs[1].size).toBe(21);
    expect(
      signal.legs[0].targetNotionalUsd +
        signal.legs[0].feeEstimateUsd +
        signal.legs[1].targetNotionalUsd +
        signal.legs[1].feeEstimateUsd,
    ).toBeLessThanOrEqual(20);
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

  it("clips the pair size to safe Kalshi executable depth instead of blocking the opportunity", () => {
    const [, signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899060000,
      polymarket: {
        ...polymarket,
        outcomes: {
          ...polymarket.outcomes,
          down: {
            ...polymarket.outcomes.down,
            buyPrice: 0.4,
            sellPrice: 0.39,
            midPrice: 0.395,
            bestBid: 0.39,
            bestAsk: 0.4,
            execution: {
              ...polymarket.outcomes.down.execution,
              buyPrice: 0.4,
              sellPrice: 0.39,
              midPrice: 0.395,
              bestBid: 0.39,
              bestAsk: 0.4,
            },
            chart: {
              ...polymarket.outcomes.down.chart,
              price: 0.4,
            },
          },
        },
      },
      kalshi: {
        ...kalshi,
        outcomes: {
          ...kalshi.outcomes,
          yes: {
            ...kalshi.outcomes.yes,
            buyPrice: 0.49,
            sellPrice: 0.48,
            midPrice: 0.485,
            bestBid: 0.48,
            bestAsk: 0.49,
            depth: 20,
            execution: {
              ...kalshi.outcomes.yes.execution,
              buyPrice: 0.49,
              sellPrice: 0.48,
              midPrice: 0.485,
              bestBid: 0.48,
              bestAsk: 0.49,
              depth: 20,
            },
            chart: {
              ...kalshi.outcomes.yes.chart,
              price: 0.49,
            },
          },
        },
      },
      settings: {
        ...settings,
        maxPairNotionalUsd: 20,
        kalshiDepthHeadroomContracts: 2,
      },
      balances,
      lastEntryCosts: {},
      secondsRemaining: 180,
    });

    expect(signal.combination).toBe("POLY_DOWN_KALSHI_YES");
    expect(signal.legs[0].size).toBe(12);
    expect(signal.legs[1].size).toBe(12);
    expect(signal.legs[0].targetNotionalUsd).toBeCloseTo(4.8, 4);
    expect(signal.legs[1].targetNotionalUsd).toBeCloseTo(5.88, 4);
    expect(signal.eligible).toBe(true);
    expect(signal.reasons).not.toContain("Liquidité Kalshi insuffisante après headroom (2 contrats)");
  });

  it("sizes Kalshi from cumulative depth within the configured price ticks, not only from the top level", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899060000,
      polymarket: {
        ...polymarket,
        outcomes: {
          ...polymarket.outcomes,
          up: {
            ...polymarket.outcomes.up,
            buyPrice: 0.42,
            depth: 300,
            execution: {
              ...polymarket.outcomes.up.execution,
              buyPrice: 0.42,
              depth: 300,
            },
          },
        },
      },
      kalshi: {
        ...kalshi,
        outcomes: {
          ...kalshi.outcomes,
          no: {
            ...kalshi.outcomes.no,
            buyPrice: 0.49,
            depth: 5,
            execution: {
              ...kalshi.outcomes.no.execution,
              buyPrice: 0.49,
              depth: 5,
            },
          },
        },
        orderbookLevels: {
          yesBids: [
            [0.51, 5],
            [0.5, 10],
            [0.49, 10],
          ],
          noBids: [[0.35, 180]],
        },
      },
      settings: {
        ...settings,
        maxPairNotionalUsd: 20,
        kalshiDepthHeadroomContracts: 0,
        kalshiPrimaryDepthSafetyFactor: 0.7,
        kalshiPrimaryPriceTicksSlippage: 2,
      },
      balances,
      lastEntryCosts: {},
      secondsRemaining: 180,
    });

    expect(signal.combination).toBe("POLY_UP_KALSHI_NO");
    expect(signal.legs[0].size).toBe(17);
    expect(signal.legs[1].size).toBe(17);
    expect(signal.legs[1].targetNotionalUsd).toBeCloseTo(8.33, 4);
    expect(signal.eligible).toBe(true);
  });

  it("uses the total pair budget beyond the old 20-contract leg-budget clip", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899060000,
      polymarket: {
        ...polymarket,
        outcomes: {
          ...polymarket.outcomes,
          up: withOutcomeQuote(polymarket.outcomes.up, {
            buyPrice: 0.4,
            depth: 300,
          }),
        },
      },
      kalshi: {
        ...kalshi,
        outcomes: {
          ...kalshi.outcomes,
          no: withOutcomeQuote(kalshi.outcomes.no, {
            buyPrice: 0.45,
            depth: 300,
          }),
        },
      },
      settings: {
        ...settings,
        maxPairNotionalUsd: 20,
        kalshiDepthHeadroomContracts: 0,
        kalshiPrimaryDepthSafetyFactor: 1,
      },
      balances,
      lastEntryCosts: {},
      secondsRemaining: 180,
    });

    expect(signal.combination).toBe("POLY_UP_KALSHI_NO");
    expect(signal.legs[0].size).toBe(23);
    expect(signal.legs[1].size).toBe(23);
    expect(signal.legs[0].targetNotionalUsd).toBe(9.2);
    expect(signal.legs[1].targetNotionalUsd).toBe(10.35);
    expect(signal.eligible).toBe(true);
  });

  it("caps balanced payout sizing when fees would exceed the total pair budget", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899060000,
      polymarket: {
        ...polymarket,
        outcomes: {
          ...polymarket.outcomes,
          up: withOutcomeQuote(polymarket.outcomes.up, {
            buyPrice: 0.4,
            depth: 300,
          }),
        },
      },
      kalshi: {
        ...kalshi,
        outcomes: {
          ...kalshi.outcomes,
          no: withOutcomeQuote(kalshi.outcomes.no, {
            buyPrice: 0.49,
            depth: 300,
          }),
        },
      },
      settings: {
        ...settings,
        maxPairNotionalUsd: 20,
        kalshiDepthHeadroomContracts: 0,
        kalshiPrimaryDepthSafetyFactor: 1,
      },
      balances,
      lastEntryCosts: {},
      secondsRemaining: 180,
    });

    expect(signal.combination).toBe("POLY_UP_KALSHI_NO");
    expect(signal.legs[0].size).toBe(22);
    expect(signal.legs[1].size).toBe(22);
    expect(
      signal.legs[0].targetNotionalUsd +
        signal.legs[0].feeEstimateUsd +
        signal.legs[1].targetNotionalUsd +
        signal.legs[1].feeEstimateUsd,
    ).toBeLessThanOrEqual(20);
    expect(signal.eligible).toBe(true);
  });

  it("caps the displayed opportunity size to the configured Kalshi multi-clip capacity", () => {
    const [, signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899060000,
      polymarket: {
        ...polymarket,
        outcomes: {
          ...polymarket.outcomes,
          down: {
            ...polymarket.outcomes.down,
            buyPrice: 0.4,
            depth: 300,
            execution: {
              ...polymarket.outcomes.down.execution,
              buyPrice: 0.4,
              depth: 300,
            },
          },
        },
      },
      kalshi: {
        ...kalshi,
        outcomes: {
          ...kalshi.outcomes,
          yes: {
            ...kalshi.outcomes.yes,
            buyPrice: 0.25,
            depth: 500,
            execution: {
              ...kalshi.outcomes.yes.execution,
              buyPrice: 0.25,
              depth: 500,
            },
          },
        },
      },
      settings: {
        ...settings,
        maxPairNotionalUsd: 50,
        kalshiPrimaryMaxClipContracts: 10,
        kalshiPrimaryMaxClips: 4,
        kalshiDepthHeadroomContracts: 0,
        kalshiPrimaryDepthSafetyFactor: 1,
      },
      balances,
      lastEntryCosts: {},
      secondsRemaining: 180,
    });

    expect(signal.combination).toBe("POLY_DOWN_KALSHI_YES");
    expect(signal.legs[0].size).toBe(40);
    expect(signal.legs[1].size).toBe(40);
    expect(signal.eligible).toBe(true);
  });

  it("blocks entries when the balanced model cannot satisfy venue minimum size under budget", () => {
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
    expect(signal.reasons).toContain("Budget/profit insuffisant frais inclus");
  });

  it("blocks entries when the 70% leg capital cap prevents the minimum Kalshi size", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899060000,
      polymarket: {
        ...polymarket,
        outcomes: {
          ...polymarket.outcomes,
          up: withOutcomeQuote(polymarket.outcomes.up, {
            buyPrice: 0.1,
            depth: 300,
          }),
        },
      },
      kalshi: {
        ...kalshi,
        outcomes: {
          ...kalshi.outcomes,
          no: withOutcomeQuote(kalshi.outcomes.no, {
            buyPrice: 0.8,
            depth: 300,
            minOrderSize: 20,
          }),
        },
      },
      settings: {
        ...settings,
        maxPairNotionalUsd: 20,
        kalshiDepthHeadroomContracts: 0,
        kalshiPrimaryDepthSafetyFactor: 1,
      },
      balances,
      lastEntryCosts: {},
      secondsRemaining: 180,
    });

    expect(signal.grossCost).toBe(0.9);
    expect(signal.eligible).toBe(false);
    expect(signal.reasons).toContain("Budget/profit insuffisant frais inclus");
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

  it("shares slot-level mismatch metrics while keeping combination-specific dead-zone metrics", () => {
    const [upNo, downYes] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899120000,
      slotStartTs: 1774899000000,
      polymarket: tradablePolymarket({
        chainlinkLivePriceUsd: 100120,
      }),
      kalshi: tradableKalshi({
        targetPriceUsd: 100015,
      }),
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(upNo.mismatchRisk).toBe("low");
    expect(downYes.mismatchRisk).toBe("low");
    expect(downYes.venueDisagreementPct).toBe(upNo.venueDisagreementPct);
    expect(downYes.secondsElapsedInSlot).toBe(upNo.secondsElapsedInSlot);
    expect(downYes.chainlinkMoveBps).toBe(upNo.chainlinkMoveBps);
    expect(downYes.openDriftBps).toBe(upNo.openDriftBps);
    expect(downYes.chainlinkLivePriceUsd).toBe(upNo.chainlinkLivePriceUsd);
    expect(downYes.observedSlotOpenPriceUsd).toBe(upNo.observedSlotOpenPriceUsd);
    expect(downYes.kalshiTargetPriceUsd).toBe(upNo.kalshiTargetPriceUsd);
    expect(upNo.deadZoneDistanceBps).toBeNull();
    expect(downYes.deadZoneDistanceBps).toBeGreaterThan(0);
  });

  it("blocks only POLY_UP_KALSHI_NO inside the dead-zone when Kalshi target is below Poly open", () => {
    const [upNo, downYes] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899120000,
      slotStartTs: 1774899000000,
      polymarket: tradablePolymarket({
        chainlinkLivePriceUsd: 99975,
        observedSlotOpenPriceUsd: 100000,
      }),
      kalshi: tradableKalshi({
        targetPriceUsd: 99950,
      }),
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(upNo.combination).toBe("POLY_UP_KALSHI_NO");
    expect(upNo.mismatchGuardAction).toBe("block");
    expect(upNo.mismatchRisk).toBe("high");
    expect(upNo.eligible).toBe(false);
    expect(upNo.referencePayoutCount).toBe(0);
    expect(upNo.deadZoneDistanceBps).toBe(0);
    expect(upNo.deadZoneWidthBps).toBeCloseTo(5.0025, 4);
    expect(upNo.reasons.join(" | ")).toContain("zone morte");

    expect(downYes.combination).toBe("POLY_DOWN_KALSHI_YES");
    expect(downYes.mismatchGuardAction).toBe("allow");
    expect(downYes.mismatchRisk).toBe("low");
    expect(downYes.eligible).toBe(true);
    expect(downYes.referencePayoutCount).toBe(2);
    expect(downYes.deadZoneDistanceBps).toBeNull();
  });

  it("blocks only POLY_DOWN_KALSHI_YES inside the dead-zone when Kalshi target is above Poly open", () => {
    const [upNo, downYes] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899120000,
      slotStartTs: 1774899000000,
      polymarket: tradablePolymarket({
        chainlinkLivePriceUsd: 100025,
        observedSlotOpenPriceUsd: 100000,
      }),
      kalshi: tradableKalshi({
        targetPriceUsd: 100050,
      }),
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(upNo.mismatchGuardAction).toBe("allow");
    expect(upNo.mismatchRisk).toBe("low");
    expect(upNo.eligible).toBe(true);
    expect(upNo.referencePayoutCount).toBe(2);
    expect(upNo.deadZoneDistanceBps).toBeNull();

    expect(downYes.mismatchGuardAction).toBe("block");
    expect(downYes.mismatchRisk).toBe("high");
    expect(downYes.eligible).toBe(false);
    expect(downYes.referencePayoutCount).toBe(0);
    expect(downYes.deadZoneDistanceBps).toBe(0);
    expect(downYes.deadZoneWidthBps).toBe(5);
    expect(downYes.reasons.join(" | ")).toContain("zone morte");
  });

  it("blocks a too-recent slot instead of entering with the removed 25% safeguard size", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899030000,
      slotStartTs: 1774899000000,
      polymarket: tradablePolymarket({
        chainlinkLivePriceUsd: 99900,
        observedSlotOpenPriceUsd: 100000,
      }),
      kalshi: tradableKalshi({
        targetPriceUsd: 99950,
      }),
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(signal.mismatchGuardAction).toBe("block");
    expect(signal.mismatchSizeMultiplier).toBe(1);
    expect(signal.mismatchRisk).toBe("high");
    expect(signal.eligible).toBe(false);
    expect(signal.reasons.join(" | ")).toContain("taille x0.25 désactivée");
  });

  it("reduces size by 50% on soft venue disagreement without blocking", () => {
    const baseKalshi = tradableKalshi({
      targetPriceUsd: 99950,
    });
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899120000,
      slotStartTs: 1774899000000,
      polymarket: tradablePolymarket({
        chainlinkLivePriceUsd: 99800,
        observedSlotOpenPriceUsd: 100000,
      }),
      kalshi: {
        ...baseKalshi,
        outcomes: {
          ...baseKalshi.outcomes,
          yes: withOutcomeQuote(baseKalshi.outcomes.yes, {
            buyPrice: 0.34,
            sellPrice: 0.33,
            midPrice: 0.335,
            bestBid: 0.33,
            bestAsk: 0.34,
          }),
        },
      },
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(signal.venueDisagreementPct).toBe(0.08);
    expect(signal.mismatchGuardAction).toBe("reduce_size");
    expect(signal.mismatchSizeMultiplier).toBe(0.5);
    expect(signal.mismatchRisk).toBe("medium");
    expect(signal.eligible).toBe(true);
    expect(signal.reasons).toEqual([]);
  });

  it("blocks when venue disagreement is above the hard cap", () => {
    const baseKalshi = tradableKalshi();
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899120000,
      slotStartTs: 1774899000000,
      polymarket: tradablePolymarket(),
      kalshi: {
        ...baseKalshi,
        outcomes: {
          ...baseKalshi.outcomes,
          yes: withOutcomeQuote(baseKalshi.outcomes.yes, {
            buyPrice: 0.24,
            sellPrice: 0.23,
            midPrice: 0.235,
            bestBid: 0.23,
            bestAsk: 0.24,
          }),
        },
      },
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(signal.mismatchGuardAction).toBe("block");
    expect(signal.mismatchRisk).toBe("high");
    expect(signal.eligible).toBe(false);
    expect(signal.venueDisagreementPct).toBe(0.18);
    expect(signal.reasons.join(" | ")).toContain("désaccord venues élevé");
  });

  it("blocks when the Chainlink live reference is missing", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899120000,
      slotStartTs: 1774899000000,
      polymarket: tradablePolymarket({
        chainlinkLivePriceUsd: null,
        chainlinkLivePriceCapturedAt: null,
      }),
      kalshi: tradableKalshi(),
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(signal.mismatchGuardAction).toBe("block");
    expect(signal.mismatchRisk).toBe("high");
    expect(signal.eligible).toBe(false);
    expect(signal.referencePayoutCount).toBeNull();
    expect(signal.deadZoneDistanceBps).toBeNull();
    expect(signal.chainlinkMoveBps).toBeNull();
    expect(signal.reasons.join(" | ")).toContain("données de référence indisponibles");
  });

  it("blocks when the observed slot open snapshot is missing", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899120000,
      slotStartTs: 1774899000000,
      polymarket: tradablePolymarket({
        observedSlotOpenPriceUsd: null,
        observedSlotOpenCapturedAt: null,
      }),
      kalshi: tradableKalshi(),
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(signal.mismatchGuardAction).toBe("block");
    expect(signal.mismatchRisk).toBe("high");
    expect(signal.eligible).toBe(false);
    expect(signal.chainlinkMoveBps).toBeNull();
    expect(signal.openDriftBps).toBeNull();
    expect(signal.reasons.join(" | ")).toContain("données de référence indisponibles");
  });

  it("reduces size near a dead-zone using the active standard and late thresholds", () => {
    const [, midSlot] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899300000,
      slotStartTs: 1774899000000,
      polymarket: tradablePolymarket({
        chainlinkLivePriceUsd: 100125,
        observedSlotOpenPriceUsd: 100000,
      }),
      kalshi: tradableKalshi({
        targetPriceUsd: 100050,
      }),
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    const [, lateSlot] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899600000,
      slotStartTs: 1774899000000,
      polymarket: tradablePolymarket({
        chainlinkLivePriceUsd: 100125,
        observedSlotOpenPriceUsd: 100000,
      }),
      kalshi: tradableKalshi({
        targetPriceUsd: 100050,
      }),
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(midSlot.combination).toBe("POLY_DOWN_KALSHI_YES");
    expect(midSlot.deadZoneDistanceBps).toBeCloseTo(7.4963, 4);
    expect(midSlot.mismatchGuardAction).toBe("reduce_size");
    expect(midSlot.mismatchSizeMultiplier).toBe(0.5);
    expect(midSlot.eligible).toBe(true);
    expect(lateSlot.mismatchGuardAction).toBe("block");
    expect(lateSlot.mismatchSizeMultiplier).toBe(1);
    expect(lateSlot.eligible).toBe(false);
    expect(lateSlot.reasons.join(" | ")).toContain("taille x0.25 désactivée");
  });

  it("blocks removed 25% safeguard sizing before entering tiny trades", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899030000,
      slotStartTs: 1774899000000,
      polymarket: {
        ...tradablePolymarket({
          chainlinkLivePriceUsd: 99900,
          observedSlotOpenPriceUsd: 100000,
        }),
        outcomes: {
          ...tradablePolymarket().outcomes,
          up: withOutcomeQuote(tradablePolymarket().outcomes.up, {
            minOrderSize: 25,
          }),
        },
      },
      kalshi: tradableKalshi({
        targetPriceUsd: 99950,
      }),
      settings: buildV3Settings({
        maxPairNotionalUsd: 20,
      }),
      balances,
      lastEntryCosts: {},
    });

    expect(signal.mismatchGuardAction).toBe("block");
    expect(signal.mismatchSizeMultiplier).toBe(1);
    expect(signal.eligible).toBe(false);
    expect(signal.reasons.join(" | ")).toContain("taille x0.25 désactivée");
  });

  it("does not block or reduce when mismatch guard actions are disabled, while keeping metrics", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899120000,
      slotStartTs: 1774899000000,
      polymarket: tradablePolymarket({
        chainlinkLivePriceUsd: 99975,
        observedSlotOpenPriceUsd: 100000,
      }),
      kalshi: tradableKalshi({
        targetPriceUsd: 99950,
      }),
      settings: buildV3Settings({
        mismatchGuardEnabled: false,
      }),
      balances,
      lastEntryCosts: {},
    });

    expect(signal.referencePayoutCount).toBe(0);
    expect(signal.deadZoneDistanceBps).toBe(0);
    expect(signal.mismatchGuardAction).toBe("allow");
    expect(signal.mismatchSizeMultiplier).toBe(1);
    expect(signal.mismatchRisk).toBe("low");
    expect(signal.eligible).toBe(true);
  });

  it("blocks at 720s because the entry cutoff window starts", () => {
    const [signal] = buildSignals({
      slotKey: SLOT_KEY,
      now: 1774899720000,
      slotStartTs: 1774899000000,
      secondsRemaining: 180,
      polymarket: tradablePolymarket({
        chainlinkLivePriceUsd: 100250,
      }),
      kalshi: tradableKalshi({
        targetPriceUsd: 100005,
      }),
      settings: buildV3Settings(),
      balances,
      lastEntryCosts: {},
    });

    expect(signal.secondsElapsedInSlot).toBe(720);
    expect(signal.mismatchRisk).toBe("low");
    expect(signal.eligible).toBe(false);
    expect(signal.reasons).toContain("Entrée bloquée sur les 180 dernières secondes");
  });
});
