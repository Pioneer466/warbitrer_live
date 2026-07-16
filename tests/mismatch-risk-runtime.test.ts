import {
  MISMATCH_RISK_RUNTIME_MODEL_VERSION,
  MismatchRiskRuntime,
} from "@/lib/mismatch-risk-runtime";
import type {
  KalshiCfBenchmarkWindow,
  KalshiQuote,
  MarketAsset,
  PolymarketQuote,
} from "@/lib/types";

const ASSET: MarketAsset = "btc";
const BASE_TS = 1_800_000_000_000;

function polymarketQuote(
  price: number,
  timestampMs: number,
  overrides: Partial<PolymarketQuote> = {},
): PolymarketQuote {
  return {
    ref: { asset: ASSET, venue: "polymarket" },
    slotAligned: true,
    chainlinkLivePriceUsd: price,
    chainlinkLivePriceCapturedAt: timestampMs,
    observedSlotOpenPriceUsd: 100,
    observedSlotOpenCapturedAt: BASE_TS - 1_000,
    ...overrides,
  } as PolymarketQuote;
}

function kalshiQuote(
  price: number,
  timestampMs: number,
  finalMinuteAverage15m: KalshiCfBenchmarkWindow | null = null,
  overrides: Partial<KalshiQuote> = {},
): KalshiQuote {
  return {
    ref: { asset: ASSET, venue: "kalshi" },
    slotAligned: true,
    targetPriceUsd: 100,
    cfBenchmarks: {
      indexId: "BRTI",
      liveValueUsd: price,
      sourceTimestampMs: timestampMs,
      receivedAtMs: timestampMs,
      capturedAt: timestampMs,
      trailing60s: {
        valueUsd: price,
        windowSize: 60,
        windowStartTsMs: timestampMs - 60_000,
        windowEndTsExclusive: timestampMs,
      },
      finalMinuteAverage15m,
    },
    ...overrides,
  } as KalshiQuote;
}

function feedHistory(
  runtime: MismatchRiskRuntime,
  count: number,
  startTs = BASE_TS,
): { polymarket: PolymarketQuote; kalshi: KalshiQuote; now: number } {
  let polymarket = polymarketQuote(100, startTs);
  let kalshi = kalshiQuote(100.02, startTs);
  for (let index = 0; index < count; index += 1) {
    const now = startTs + index * 1_000;
    const chainlinkPrice =
      100 + 0.02 * index + 0.12 * Math.sin(index * 0.73);
    const cfPrice =
      chainlinkPrice * 1.0002 + 0.025 * Math.cos(index * 0.61);
    polymarket = polymarketQuote(chainlinkPrice, now);
    kalshi = kalshiQuote(cfPrice, now);
    expect(
      runtime.observe({
        asset: ASSET,
        polymarket,
        kalshi,
        now,
        maxSourceAgeMs: 2_500,
      }),
    ).toBe(true);
  }
  return { polymarket, kalshi, now: startTs + (count - 1) * 1_000 };
}

describe("MismatchRiskRuntime observations", () => {
  it("aligns, deduplicates, and bounds per-asset observations", () => {
    const runtime = new MismatchRiskRuntime({
      minimumObservations: 3,
      statisticsObservations: 5,
      maxObservations: 5,
      maxPairSkewMs: 500,
    });
    const latest = feedHistory(runtime, 8);

    expect(runtime.getObservationCount(ASSET)).toBe(5);
    expect(
      runtime.observe({
        asset: ASSET,
        ...latest,
        maxSourceAgeMs: 2_500,
      }),
    ).toBe(false);
    expect(
      runtime.observe({
        asset: ASSET,
        polymarket: polymarketQuote(101, latest.now + 1_000),
        kalshi: kalshiQuote(101, latest.now + 1_600),
        now: latest.now + 1_600,
        maxSourceAgeMs: 2_500,
      }),
    ).toBe(false);
    expect(runtime.getObservationCount(ASSET)).toBe(5);
  });

  it("calculates finite robust volatility, shrunk correlation, and basis", () => {
    const runtime = new MismatchRiskRuntime({ minimumObservations: 10 });
    feedHistory(runtime, 60);

    const statistics = runtime.getStatistics(ASSET);
    expect(statistics.available).toBe(true);
    expect(statistics.observationCount).toBe(60);
    expect(statistics.returnCount).toBe(59);
    expect(statistics.chainlinkLogVolatilityPerSqrtSecond).toBeGreaterThan(0);
    expect(statistics.cfLogVolatilityPerSqrtSecond).toBeGreaterThan(0);
    expect(Math.abs(statistics.shrunkCorrelation!)).toBeLessThanOrEqual(
      Math.abs(statistics.rawCorrelation!),
    );
    expect(statistics.basisBps).toBeGreaterThan(-20);
    expect(statistics.basisBps).toBeLessThan(20);
  });
});

describe("MismatchRiskRuntime estimates", () => {
  it("fails closed for insufficient, stale, skewed, and invalid inputs", () => {
    const runtime = new MismatchRiskRuntime({ minimumObservations: 5 });
    const now = BASE_TS;
    const polymarket = polymarketQuote(100, now);
    const kalshi = kalshiQuote(100, now);
    const common = {
      asset: ASSET,
      combination: "POLY_UP_KALSHI_NO" as const,
      polymarket,
      kalshi,
      slotStartTs: BASE_TS - 1_000,
      slotEndTs: now + 120_000,
      now,
      pairSize: 10,
      totalCostUsd: 9,
      maxSourceAgeMs: 2_500,
    };

    expect(runtime.estimate(common)).toMatchObject({
      available: false,
      reason: "insufficient_history",
    });
    expect(
      runtime.estimate({
        ...common,
        now: now + 3_000,
      }),
    ).toMatchObject({ available: false, reason: "chainlink_stale" });
    expect(
      runtime.estimate({
        ...common,
        kalshi: kalshiQuote(100, now + 2_000),
        now: now + 2_000,
      }),
    ).toMatchObject({ available: false, reason: "oracle_timestamp_skew" });
    expect(
      runtime.estimate({ ...common, pairSize: Number.NaN }),
    ).toMatchObject({ available: false, reason: "invalid_economics" });
    expect(
      runtime.estimate({
        ...common,
        kalshi: kalshiQuote(100, now, null, { targetPriceUsd: null }),
      }),
    ).toMatchObject({ available: false, reason: "kalshi_strike_unavailable" });
    expect(
      runtime.estimate({
        ...common,
        polymarket: polymarketQuote(100, now, {
          observedSlotOpenCapturedAt: common.slotStartTs - 1,
        }),
      }),
    ).toMatchObject({
      available: false,
      reason: "chainlink_start_timestamp_outside_slot_open_window",
    });

    const outsideOpenWindowNow = common.slotStartTs + 30_001;
    expect(
      runtime.estimate({
        ...common,
        now: outsideOpenWindowNow,
        polymarket: polymarketQuote(100, outsideOpenWindowNow, {
          observedSlotOpenCapturedAt: outsideOpenWindowNow,
        }),
        kalshi: kalshiQuote(100, outsideOpenWindowNow),
      }),
    ).toMatchObject({
      available: false,
      reason: "chainlink_start_timestamp_outside_slot_open_window",
    });
    expect(runtime.estimate({} as never)).toMatchObject({
      available: false,
      reason: "invalid_input",
    });
  });

  it("produces a deterministic uncalibrated shadow estimate before the final minute", () => {
    const runtime = new MismatchRiskRuntime({ minimumObservations: 20 });
    const latest = feedHistory(runtime, 80);
    const input = {
      asset: ASSET,
      combination: "POLY_UP_KALSHI_NO" as const,
      ...latest,
      slotStartTs: BASE_TS - 1_000,
      slotEndTs: latest.now + 180_000,
      pairSize: 20,
      totalCostUsd: 18,
      maxSourceAgeMs: 2_500,
    };

    const first = runtime.estimate(input);
    const second = runtime.estimate(input);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      available: true,
      modelVersion: MISMATCH_RISK_RUNTIME_MODEL_VERSION,
      reason: null,
      fatalPnlUsd: -18,
      observationCount: 80,
    });
    expect(first.pFatal! + first.pAligned! + first.pDouble!).toBeCloseTo(1, 10);
    expect(first.pFatalUpper95).toBeGreaterThanOrEqual(first.pFatal!);
    expect(first.breakEvenFatalProbability).toBeCloseTo(0.1, 12);
    expect(runtime.getObservationCount(ASSET)).toBe(80);

    const complementary = runtime.estimate({
      ...input,
      combination: "POLY_DOWN_KALSHI_YES",
    });
    expect(complementary.available).toBe(true);
    expect(complementary.pFatal).toBeCloseTo(first.pDouble!, 12);
    expect(complementary.pDouble).toBeCloseTo(first.pFatal!, 12);
    expect(complementary.pAligned).toBeCloseTo(first.pAligned!, 12);
    expect(runtime.getObservationCount(ASSET)).toBe(80);
  });

  it("requires and conditions on Kalshi's exact partial average in the final minute", () => {
    const runtime = new MismatchRiskRuntime({ minimumObservations: 20 });
    const latest = feedHistory(runtime, 80);
    const slotEndTs = latest.now + 30_000;
    const common = {
      asset: ASSET,
      combination: "POLY_UP_KALSHI_NO" as const,
      polymarket: latest.polymarket,
      slotStartTs: BASE_TS - 1_000,
      slotEndTs,
      now: latest.now,
      pairSize: 20,
      totalCostUsd: 18,
      maxSourceAgeMs: 2_500,
    };

    expect(runtime.estimate({ ...common, kalshi: latest.kalshi })).toMatchObject({
      available: false,
      reason: "final_minute_average_unavailable",
    });

    const window = (valueUsd: number): KalshiCfBenchmarkWindow => ({
      valueUsd,
      windowSize: 30,
      windowStartTsMs: slotEndTs - 60_000,
      windowEndTsExclusive: latest.now,
    });
    const highAverage = runtime.estimate({
      ...common,
      kalshi: kalshiQuote(
        latest.kalshi.cfBenchmarks!.liveValueUsd,
        latest.now,
        window(102),
      ),
    });
    const lowAverage = runtime.estimate({
      ...common,
      kalshi: kalshiQuote(
        latest.kalshi.cfBenchmarks!.liveValueUsd,
        latest.now,
        window(98),
      ),
    });

    expect(highAverage.available).toBe(true);
    expect(lowAverage.available).toBe(true);
    expect(highAverage.pFatal).toBeGreaterThan(lowAverage.pFatal!);
    expect(highAverage.pFatalUpper95).toBeGreaterThanOrEqual(highAverage.pFatal!);
    expect(lowAverage.pFatalUpper95).toBeGreaterThanOrEqual(lowAverage.pFatal!);
  });
});
