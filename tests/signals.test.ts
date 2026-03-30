import { buildSignals } from "@/lib/signals";
import type { KalshiQuote, PaperSettings, PolymarketQuote } from "@/lib/types";

const settings: PaperSettings = {
  initialCapital: 10_000,
  budgetPerTrade: 250,
  grossEntryThreshold: 0.93,
  reentryImprovement: 0.01,
  pollingIntervalMs: 1_000,
  minOrderSize: 5,
};

const polymarket: PolymarketQuote = {
  ref: {
    venue: "polymarket",
    id: "poly-market",
    slug: "btc-updown-15m-1774899000",
    title: "Poly BTC 15m",
    url: "https://polymarket.com/event/test",
    startTime: "2026-03-30T19:30:00.000Z",
    endTime: "2026-03-30T19:45:00.000Z",
  },
  status: "open",
  slotAligned: true,
  availabilityReason: null,
  outcomes: {
    up: {
      outcome: "UP",
      buyPrice: 0.42,
      sellPrice: 0.43,
      midPrice: 0.425,
      bestBid: 0.43,
      bestAsk: 0.42,
      depth: 200,
    },
    down: {
      outcome: "DOWN",
      buyPrice: 0.59,
      sellPrice: 0.6,
      midPrice: 0.595,
      bestBid: 0.6,
      bestAsk: 0.59,
      depth: 200,
    },
  },
  feeRate: 0.25,
  feeExponent: 2,
  feeType: "crypto_fees_v2",
  feeScheduleRaw: {
    rate: 0.25,
    exponent: 2,
    takerOnly: true,
    rebateRate: 0.2,
  },
  resolution: null,
  tokenIds: {
    up: "up-token",
    down: "down-token",
  },
};

const kalshi: KalshiQuote = {
  ref: {
    venue: "kalshi",
    id: "KXBTC15M-26MAR301545-45",
    ticker: "KXBTC15M-26MAR301545-45",
    seriesTicker: "KXBTC15M",
    title: "BTC price up in next 15 mins?",
    url: "https://kalshi.com/markets/kxbtc15m/bitcoin-price-up-down/test",
    startTime: "2026-03-30T19:30:00.000Z",
    endTime: "2026-03-30T19:45:00.000Z",
  },
  status: "active",
  slotAligned: true,
  availabilityReason: null,
  outcomes: {
    yes: {
      outcome: "YES",
      buyPrice: 0.35,
      sellPrice: 0.34,
      midPrice: 0.345,
      bestBid: 0.34,
      bestAsk: 0.35,
      depth: 180,
    },
    no: {
      outcome: "NO",
      buyPrice: 0.49,
      sellPrice: 0.48,
      midPrice: 0.485,
      bestBid: 0.48,
      bestAsk: 0.49,
      depth: 180,
    },
  },
  feeMultiplier: 1,
  feeType: "quadratic",
  resolution: null,
};

describe("signal engine", () => {
  it("marks the sub-threshold opposite pair as eligible", () => {
    const [signal] = buildSignals({
      polymarket,
      kalshi,
      settings,
      lastEntryCosts: {},
    });

    expect(signal.combination).toBe("POLY_UP_KALSHI_NO");
    expect(signal.grossCost).toBe(0.91);
    expect(signal.thresholdMet).toBe(true);
    expect(signal.eligible).toBe(true);
    expect(signal.units).toBe(180);
  });

  it("blocks re-entry when the improvement is below one cent", () => {
    const [signal] = buildSignals({
      polymarket,
      kalshi,
      settings,
      lastEntryCosts: {
        POLY_UP_KALSHI_NO: 0.915,
      },
    });

    expect(signal.eligible).toBe(false);
    expect(signal.reason).toBe("Pas d'amélioration suffisante");
  });

  it("blocks entry when Kalshi is not aligned on the same slot", () => {
    const [signal] = buildSignals({
      polymarket,
      kalshi: {
        ...kalshi,
        slotAligned: false,
        availabilityReason: "Marché Kalshi du créneau courant indisponible",
        ref: {
          ...kalshi.ref,
          startTime: "2026-03-30T19:45:00.000Z",
          endTime: "2026-03-30T20:00:00.000Z",
          slotKey: "1774899900000",
        },
      },
      settings,
      lastEntryCosts: {},
    });

    expect(signal.eligible).toBe(false);
    expect(signal.grossCost).toBeNull();
    expect(signal.reason).toBe("Marché Kalshi du créneau courant indisponible");
  });
});
