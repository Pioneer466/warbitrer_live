import {
  calculateMismatchAdjustedPnl,
  conditionCfFinalAverage,
  estimateMismatchRisk,
  evaluateEconomicMismatchGate,
} from "@/lib/mismatch-risk";
import type {
  KalshiCfBenchmarkWindow,
  KalshiQuote,
  MarketAsset,
  MismatchRiskEstimate,
  PairCombination,
  PolymarketQuote,
} from "@/lib/types";

export const MISMATCH_RISK_RUNTIME_MODEL_VERSION =
  "structural-ewma-gaussian-v1-uncalibrated";

const DEFAULT_MAX_OBSERVATIONS = 900;
const DEFAULT_STATISTICS_OBSERVATIONS = 300;
const DEFAULT_MINIMUM_OBSERVATIONS = 30;
const DEFAULT_MAX_PAIR_SKEW_MS = 1_500;
const DEFAULT_MAX_RETURN_GAP_MS = 10_000;
const DEFAULT_FUTURE_TOLERANCE_MS = 1_000;
const DEFAULT_EWMA_HALF_LIFE_MS = 60_000;
const DEFAULT_CORRELATION_PRIOR_OBSERVATIONS = 20;
const FINAL_AVERAGE_SAMPLE_COUNT = 60;
const FINAL_MINUTE_MS = 60_000;
const SLOT_OPEN_CAPTURE_WINDOW_MS = 30_000;
const ROBUST_CLIP_MULTIPLIER = 6;
const MIN_LOG_VOLATILITY = 1e-9;

export type MismatchRiskRuntimeOptions = {
  maxObservations?: number;
  statisticsObservations?: number;
  minimumObservations?: number;
  maxPairSkewMs?: number;
  maxReturnGapMs?: number;
  futureToleranceMs?: number;
  ewmaHalfLifeMs?: number;
  correlationPriorObservations?: number;
};

export type MismatchRiskObservationInput = {
  asset: MarketAsset;
  polymarket: PolymarketQuote;
  kalshi: KalshiQuote;
  now: number;
  maxSourceAgeMs: number;
};

export type MismatchRiskRuntimeEstimateInput = MismatchRiskObservationInput & {
  combination: PairCombination;
  slotStartTs: number;
  slotEndTs: number;
  pairSize: number;
  totalCostUsd: number;
};

export type MismatchRiskRuntimeStatistics = {
  available: boolean;
  reason: "insufficient_history" | "insufficient_returns" | null;
  observationCount: number;
  returnCount: number;
  effectiveObservationCount: number;
  chainlinkLogVolatilityPerSqrtSecond: number | null;
  cfLogVolatilityPerSqrtSecond: number | null;
  rawCorrelation: number | null;
  shrunkCorrelation: number | null;
  basisLog: number | null;
  basisBps: number | null;
};

type RuntimeOptions = Required<MismatchRiskRuntimeOptions>;

type PairedObservation = {
  pairTimestampMs: number;
  chainlinkTimestampMs: number;
  cfTimestampMs: number;
  chainlinkPriceUsd: number;
  cfPriceUsd: number;
};

type ReturnObservation = {
  timestampMs: number;
  chainlink: number;
  cf: number;
};

type ExtractedReference = {
  chainlinkPriceUsd: number;
  chainlinkTimestampMs: number;
  cfPriceUsd: number;
  cfTimestampMs: number;
  chainlinkAgeMs: number;
  cfAgeMs: number;
};

type ReferenceExtractionResult =
  | { available: true; reference: ExtractedReference }
  | { available: false; reason: string; chainlinkAgeMs: number | null; cfAgeMs: number | null };

type Forecast = {
  chainlinkTerminalMean: number;
  chainlinkTerminalStdDev: number;
  cfFinalAverageMean: number;
  cfFinalAverageStdDev: number;
  correlation: number;
};

export class MismatchRiskRuntime {
  private readonly options: RuntimeOptions;
  private readonly observations = new Map<MarketAsset, PairedObservation[]>();

  constructor(options: MismatchRiskRuntimeOptions = {}) {
    this.options = normalizeOptions(options);
  }

  observe(input: MismatchRiskObservationInput): boolean {
    try {
      return this.ingestObservation(input);
    } catch {
      return false;
    }
  }

  estimate(input: MismatchRiskRuntimeEstimateInput): MismatchRiskEstimate {
    try {
      return this.calculateEstimate(input);
    } catch {
      const asset = (
        input as Partial<MismatchRiskRuntimeEstimateInput> | null | undefined
      )?.asset;
      return unavailableEstimate(
        "invalid_input",
        asset ? (this.observations.get(asset)?.length ?? 0) : 0,
      );
    }
  }

  private ingestObservation(input: MismatchRiskObservationInput): boolean {
    const extracted = extractReference(input, this.options);
    if (!extracted.available) {
      return false;
    }

    const { reference } = extracted;
    const assetObservations = this.observations.get(input.asset) ?? [];
    const previous = assetObservations.at(-1);
    if (
      previous &&
      (reference.chainlinkTimestampMs <= previous.chainlinkTimestampMs ||
        reference.cfTimestampMs <= previous.cfTimestampMs)
    ) {
      return false;
    }

    assetObservations.push({
      pairTimestampMs: Math.max(
        reference.chainlinkTimestampMs,
        reference.cfTimestampMs,
      ),
      chainlinkTimestampMs: reference.chainlinkTimestampMs,
      cfTimestampMs: reference.cfTimestampMs,
      chainlinkPriceUsd: reference.chainlinkPriceUsd,
      cfPriceUsd: reference.cfPriceUsd,
    });
    if (assetObservations.length > this.options.maxObservations) {
      assetObservations.splice(
        0,
        assetObservations.length - this.options.maxObservations,
      );
    }
    this.observations.set(input.asset, assetObservations);
    return true;
  }

  private calculateEstimate(
    input: MismatchRiskRuntimeEstimateInput,
  ): MismatchRiskEstimate {
    const extracted = extractReference(input, this.options);
    const currentObservationCount = this.observations.get(input.asset)?.length ?? 0;
    if (!extracted.available) {
      return unavailableEstimate(
        extracted.reason,
        currentObservationCount,
        extracted.chainlinkAgeMs,
        extracted.cfAgeMs,
      );
    }

    this.observe(input);
    const observationCount = this.observations.get(input.asset)?.length ?? 0;
    const { reference } = extracted;
    if (!isPositiveFinite(input.pairSize) || !isNonNegativeFinite(input.totalCostUsd)) {
      return unavailableEstimate(
        "invalid_economics",
        observationCount,
        reference.chainlinkAgeMs,
        reference.cfAgeMs,
      );
    }
    if (
      !isNonNegativeFinite(input.slotStartTs) ||
      !isPositiveFinite(input.slotEndTs) ||
      input.slotStartTs >= input.slotEndTs
    ) {
      return unavailableEstimate(
        "slot_invalid",
        observationCount,
        reference.chainlinkAgeMs,
        reference.cfAgeMs,
      );
    }
    if (input.slotEndTs <= input.now) {
      return unavailableEstimate(
        "slot_closed",
        observationCount,
        reference.chainlinkAgeMs,
        reference.cfAgeMs,
      );
    }
    const chainlinkStartPrice = input.polymarket.observedSlotOpenPriceUsd;
    const chainlinkStartTimestampMs =
      input.polymarket.observedSlotOpenCapturedAt;
    const kalshiStrikePrice = input.kalshi.targetPriceUsd;
    if (!isPositiveFinite(chainlinkStartPrice)) {
      return unavailableEstimate(
        "chainlink_start_unavailable",
        observationCount,
        reference.chainlinkAgeMs,
        reference.cfAgeMs,
      );
    }
    if (!isNonNegativeFinite(chainlinkStartTimestampMs)) {
      return unavailableEstimate(
        "chainlink_start_timestamp_unavailable",
        observationCount,
        reference.chainlinkAgeMs,
        reference.cfAgeMs,
      );
    }
    if (
      chainlinkStartTimestampMs < input.slotStartTs ||
      chainlinkStartTimestampMs > input.slotStartTs + SLOT_OPEN_CAPTURE_WINDOW_MS
    ) {
      return unavailableEstimate(
        "chainlink_start_timestamp_outside_slot_open_window",
        observationCount,
        reference.chainlinkAgeMs,
        reference.cfAgeMs,
      );
    }
    if (chainlinkStartTimestampMs > input.now + this.options.futureToleranceMs) {
      return unavailableEstimate(
        "chainlink_start_timestamp_invalid",
        observationCount,
        reference.chainlinkAgeMs,
        reference.cfAgeMs,
      );
    }
    if (!isPositiveFinite(kalshiStrikePrice)) {
      return unavailableEstimate(
        "kalshi_strike_unavailable",
        observationCount,
        reference.chainlinkAgeMs,
        reference.cfAgeMs,
      );
    }

    const statistics = this.getStatistics(input.asset);
    if (!statistics.available) {
      return unavailableEstimate(
        statistics.reason ?? "insufficient_history",
        statistics.observationCount,
        reference.chainlinkAgeMs,
        reference.cfAgeMs,
      );
    }

    try {
      const forecast = buildForecast({
        input,
        reference,
        statistics,
      });
      if (!forecast) {
        return unavailableEstimate(
          "final_minute_average_unavailable",
          observationCount,
          reference.chainlinkAgeMs,
          reference.cfAgeMs,
        );
      }

      const risk = estimateMismatchRisk({
        combination: input.combination,
        chainlinkStartPrice,
        chainlinkTerminalMean: forecast.chainlinkTerminalMean,
        chainlinkTerminalStdDev: forecast.chainlinkTerminalStdDev,
        kalshiStrikePrice,
        cfFinalAverageMean: forecast.cfFinalAverageMean,
        cfFinalAverageStdDev: forecast.cfFinalAverageStdDev,
        correlation: forecast.correlation,
        asOfMs: input.now,
        chainlinkSourceTimestampMs: reference.chainlinkTimestampMs,
        cfSourceTimestampMs: reference.cfTimestampMs,
        maxSourceAgeMs: input.maxSourceAgeMs,
        maxFutureSkewMs: this.options.futureToleranceMs,
      });
      if (!risk.available) {
        return unavailableEstimate(
          risk.reason,
          observationCount,
          reference.chainlinkAgeMs,
          reference.cfAgeMs,
        );
      }

      const probabilities = risk.probabilities;
      const pFatalUpper95 = structuralFatalProbabilityUpperBound(
        probabilities.pFatal,
        statistics.effectiveObservationCount,
      );
      const pnl = calculateMismatchAdjustedPnl({
        pairSize: input.pairSize,
        totalCostUsd: input.totalCostUsd,
        probabilities,
        pFatalUpper95,
      });
      const gate = evaluateEconomicMismatchGate({
        pairSize: input.pairSize,
        totalCostUsd: input.totalCostUsd,
        pFatalUpper95,
      });

      return {
        available: true,
        modelVersion: MISMATCH_RISK_RUNTIME_MODEL_VERSION,
        reason: null,
        pFatal: probabilities.pFatal,
        pFatalUpper95,
        pAligned: probabilities.pAligned,
        pDouble: probabilities.pDouble,
        expectedPnlUsd: pnl.expectedPnlUsd,
        conservativePnlUsd: pnl.conservativePnlUsd,
        fatalPnlUsd: pnl.fatalPnlUsd,
        breakEvenFatalProbability: gate.pBreakEven,
        maximumAllowedFatalProbability: gate.maximumAllowedFatalProbability,
        chainlinkAgeMs: risk.chainlinkAgeMs,
        cfAgeMs: risk.cfAgeMs,
        observationCount,
      };
    } catch {
      return unavailableEstimate(
        "model_error",
        observationCount,
        reference.chainlinkAgeMs,
        reference.cfAgeMs,
      );
    }
  }

  getStatistics(asset: MarketAsset): MismatchRiskRuntimeStatistics {
    const all = this.observations.get(asset) ?? [];
    const observations = all.slice(-this.options.statisticsObservations);
    if (observations.length < this.options.minimumObservations) {
      return unavailableStatistics("insufficient_history", observations.length);
    }

    const returns = calculateReturns(observations, this.options.maxReturnGapMs);
    if (returns.length < this.options.minimumObservations - 1) {
      return unavailableStatistics(
        "insufficient_returns",
        observations.length,
        returns.length,
      );
    }

    const chainlinkValues = returns.map((value) => value.chainlink);
    const cfValues = returns.map((value) => value.cf);
    const clippedChainlink = robustClip(chainlinkValues);
    const clippedCf = robustClip(cfValues);
    const latestTimestampMs = returns.at(-1)?.timestampMs ?? 0;

    let totalWeight = 0;
    let weightedChainlinkSquare = 0;
    let weightedCfSquare = 0;
    let weightedCrossProduct = 0;
    let squaredWeightTotal = 0;
    for (let index = 0; index < returns.length; index += 1) {
      const ageMs = Math.max(0, latestTimestampMs - returns[index].timestampMs);
      const weight = Math.exp(
        (-Math.LN2 * ageMs) / this.options.ewmaHalfLifeMs,
      );
      totalWeight += weight;
      squaredWeightTotal += weight * weight;
      weightedChainlinkSquare += weight * clippedChainlink[index] ** 2;
      weightedCfSquare += weight * clippedCf[index] ** 2;
      weightedCrossProduct += weight * clippedChainlink[index] * clippedCf[index];
    }

    if (totalWeight <= 0) {
      return unavailableStatistics(
        "insufficient_returns",
        observations.length,
        returns.length,
      );
    }

    const chainlinkVariance = weightedChainlinkSquare / totalWeight;
    const cfVariance = weightedCfSquare / totalWeight;
    const covariance = weightedCrossProduct / totalWeight;
    const rawCorrelation =
      chainlinkVariance <= 0 || cfVariance <= 0
        ? 0
        : clamp(
            covariance / Math.sqrt(chainlinkVariance * cfVariance),
            -1,
            1,
          );
    const shrinkageWeight =
      returns.length /
      (returns.length + this.options.correlationPriorObservations);
    const shrunkCorrelation = rawCorrelation * shrinkageWeight;
    const basisLog = robustEwmaBasis(
      observations,
      latestTimestampMs,
      this.options.ewmaHalfLifeMs,
    );
    const effectiveObservationCount =
      squaredWeightTotal <= 0
        ? returns.length
        : Math.max(1, (totalWeight * totalWeight) / squaredWeightTotal);

    return {
      available: true,
      reason: null,
      observationCount: observations.length,
      returnCount: returns.length,
      effectiveObservationCount,
      chainlinkLogVolatilityPerSqrtSecond: Math.max(
        MIN_LOG_VOLATILITY,
        Math.sqrt(Math.max(0, chainlinkVariance)),
      ),
      cfLogVolatilityPerSqrtSecond: Math.max(
        MIN_LOG_VOLATILITY,
        Math.sqrt(Math.max(0, cfVariance)),
      ),
      rawCorrelation,
      shrunkCorrelation,
      basisLog,
      basisBps: Math.expm1(basisLog) * 10_000,
    };
  }

  getObservationCount(asset: MarketAsset): number {
    return this.observations.get(asset)?.length ?? 0;
  }

  reset(asset?: MarketAsset): void {
    if (asset === undefined) {
      this.observations.clear();
      return;
    }
    this.observations.delete(asset);
  }
}

function normalizeOptions(options: MismatchRiskRuntimeOptions): RuntimeOptions {
  const normalized = {
    maxObservations: options.maxObservations ?? DEFAULT_MAX_OBSERVATIONS,
    statisticsObservations:
      options.statisticsObservations ?? DEFAULT_STATISTICS_OBSERVATIONS,
    minimumObservations:
      options.minimumObservations ?? DEFAULT_MINIMUM_OBSERVATIONS,
    maxPairSkewMs: options.maxPairSkewMs ?? DEFAULT_MAX_PAIR_SKEW_MS,
    maxReturnGapMs: options.maxReturnGapMs ?? DEFAULT_MAX_RETURN_GAP_MS,
    futureToleranceMs:
      options.futureToleranceMs ?? DEFAULT_FUTURE_TOLERANCE_MS,
    ewmaHalfLifeMs: options.ewmaHalfLifeMs ?? DEFAULT_EWMA_HALF_LIFE_MS,
    correlationPriorObservations:
      options.correlationPriorObservations ??
      DEFAULT_CORRELATION_PRIOR_OBSERVATIONS,
  };

  assertIntegerAtLeast(normalized.minimumObservations, 3, "minimumObservations");
  assertIntegerAtLeast(normalized.maxObservations, normalized.minimumObservations, "maxObservations");
  assertIntegerAtLeast(
    normalized.statisticsObservations,
    normalized.minimumObservations,
    "statisticsObservations",
  );
  if (normalized.statisticsObservations > normalized.maxObservations) {
    normalized.statisticsObservations = normalized.maxObservations;
  }
  assertNonNegativeFinite(normalized.maxPairSkewMs, "maxPairSkewMs");
  assertPositiveFinite(normalized.maxReturnGapMs, "maxReturnGapMs");
  assertNonNegativeFinite(normalized.futureToleranceMs, "futureToleranceMs");
  assertPositiveFinite(normalized.ewmaHalfLifeMs, "ewmaHalfLifeMs");
  assertNonNegativeFinite(
    normalized.correlationPriorObservations,
    "correlationPriorObservations",
  );
  return normalized;
}

function extractReference(
  input: MismatchRiskObservationInput,
  options: RuntimeOptions,
): ReferenceExtractionResult {
  if (
    !isNonNegativeFinite(input.now) ||
    !isNonNegativeFinite(input.maxSourceAgeMs)
  ) {
    return unavailableReference("invalid_input");
  }
  if (
    input.polymarket.ref.asset !== input.asset ||
    input.kalshi.ref.asset !== input.asset
  ) {
    return unavailableReference("asset_mismatch");
  }
  if (!input.polymarket.slotAligned || !input.kalshi.slotAligned) {
    return unavailableReference("markets_not_aligned");
  }
  if (
    input.polymarket.ref.slotKey &&
    input.kalshi.ref.slotKey &&
    input.polymarket.ref.slotKey !== input.kalshi.ref.slotKey
  ) {
    return unavailableReference("market_slot_mismatch");
  }

  const chainlinkPriceUsd = input.polymarket.chainlinkLivePriceUsd;
  const chainlinkTimestampMs = input.polymarket.chainlinkLivePriceCapturedAt;
  const cf = input.kalshi.cfBenchmarks;
  if (!isPositiveFinite(chainlinkPriceUsd) || !isNonNegativeFinite(chainlinkTimestampMs)) {
    return unavailableReference("chainlink_unavailable");
  }
  if (
    !cf ||
    !isPositiveFinite(cf.liveValueUsd) ||
    !isNonNegativeFinite(cf.sourceTimestampMs)
  ) {
    return unavailableReference("cf_unavailable", input.now - chainlinkTimestampMs, null);
  }

  const chainlinkAgeMs = input.now - chainlinkTimestampMs;
  const cfAgeMs = input.now - cf.sourceTimestampMs;
  if (chainlinkAgeMs < -options.futureToleranceMs) {
    return unavailableReference(
      "chainlink_timestamp_in_future",
      chainlinkAgeMs,
      cfAgeMs,
    );
  }
  if (cfAgeMs < -options.futureToleranceMs) {
    return unavailableReference("cf_timestamp_in_future", chainlinkAgeMs, cfAgeMs);
  }
  if (chainlinkAgeMs > input.maxSourceAgeMs) {
    return unavailableReference("chainlink_stale", chainlinkAgeMs, cfAgeMs);
  }
  if (cfAgeMs > input.maxSourceAgeMs) {
    return unavailableReference("cf_stale", chainlinkAgeMs, cfAgeMs);
  }
  if (Math.abs(chainlinkTimestampMs - cf.sourceTimestampMs) > options.maxPairSkewMs) {
    return unavailableReference("oracle_timestamp_skew", chainlinkAgeMs, cfAgeMs);
  }

  return {
    available: true,
    reference: {
      chainlinkPriceUsd,
      chainlinkTimestampMs,
      cfPriceUsd: cf.liveValueUsd,
      cfTimestampMs: cf.sourceTimestampMs,
      chainlinkAgeMs: Math.max(0, chainlinkAgeMs),
      cfAgeMs: Math.max(0, cfAgeMs),
    },
  };
}

function buildForecast(args: {
  input: MismatchRiskRuntimeEstimateInput;
  reference: ExtractedReference;
  statistics: MismatchRiskRuntimeStatistics;
}): Forecast | null {
  const { input, reference, statistics } = args;
  const chainlinkVolatility =
    statistics.chainlinkLogVolatilityPerSqrtSecond;
  const cfVolatility = statistics.cfLogVolatilityPerSqrtSecond;
  const incrementCorrelation = statistics.shrunkCorrelation;
  if (
    chainlinkVolatility === null ||
    cfVolatility === null ||
    incrementCorrelation === null
  ) {
    return null;
  }

  const horizonSeconds = (input.slotEndTs - input.now) / 1_000;
  const chainlinkTerminalStdDev =
    reference.chainlinkPriceUsd * chainlinkVolatility * Math.sqrt(horizonSeconds);
  if (input.slotEndTs - input.now > FINAL_MINUTE_MS) {
    const secondsBeforeFinalMinute = horizonSeconds - FINAL_AVERAGE_SAMPLE_COUNT;
    const cfAverageVarianceTime = secondsBeforeFinalMinute + FINAL_AVERAGE_SAMPLE_COUNT / 3;
    const covarianceTime = secondsBeforeFinalMinute + FINAL_AVERAGE_SAMPLE_COUNT / 2;
    const geometry =
      covarianceTime /
      Math.sqrt(horizonSeconds * cfAverageVarianceTime);
    return {
      chainlinkTerminalMean: reference.chainlinkPriceUsd,
      chainlinkTerminalStdDev,
      cfFinalAverageMean: reference.cfPriceUsd,
      cfFinalAverageStdDev:
        reference.cfPriceUsd * cfVolatility * Math.sqrt(cfAverageVarianceTime),
      correlation: clamp(incrementCorrelation * geometry, -0.999, 0.999),
    };
  }

  const finalMinuteAverage = input.kalshi.cfBenchmarks?.finalMinuteAverage15m;
  if (
    !isValidFinalMinuteAverage(
      finalMinuteAverage,
      input.slotEndTs,
      input.now,
      reference.cfTimestampMs,
      input.maxSourceAgeMs,
    )
  ) {
    return null;
  }
  const remainingSampleCount =
    FINAL_AVERAGE_SAMPLE_COUNT - finalMinuteAverage.windowSize;
  const remainingMeanStdDev =
    remainingSampleCount === 0
      ? 0
      : reference.cfPriceUsd *
        cfVolatility *
        Math.sqrt(Math.max(horizonSeconds, 1 / FINAL_AVERAGE_SAMPLE_COUNT) / 3);
  const conditioned = conditionCfFinalAverage({
    observedAverage: finalMinuteAverage.valueUsd,
    observedSampleCount: finalMinuteAverage.windowSize,
    remainingMean: reference.cfPriceUsd,
    remainingMeanStdDev,
    strike: input.kalshi.targetPriceUsd ?? undefined,
    totalSampleCount: FINAL_AVERAGE_SAMPLE_COUNT,
  });

  return {
    chainlinkTerminalMean: reference.chainlinkPriceUsd,
    chainlinkTerminalStdDev,
    cfFinalAverageMean: conditioned.finalAverageMean,
    cfFinalAverageStdDev: conditioned.finalAverageStdDev,
    correlation:
      conditioned.finalAverageStdDev === 0
        ? 0
        : clamp(incrementCorrelation * (Math.sqrt(3) / 2), -0.999, 0.999),
  };
}

function isValidFinalMinuteAverage(
  value: KalshiCfBenchmarkWindow | null | undefined,
  slotEndTs: number,
  now: number,
  cfSourceTimestampMs: number,
  maxSourceAgeMs: number,
): value is KalshiCfBenchmarkWindow {
  if (
    !value ||
    !isPositiveFinite(value.valueUsd) ||
    !Number.isInteger(value.windowSize) ||
    value.windowSize < 1 ||
    value.windowSize > FINAL_AVERAGE_SAMPLE_COUNT ||
    !isNonNegativeFinite(value.windowStartTsMs) ||
    !isNonNegativeFinite(value.windowEndTsExclusive) ||
    value.windowStartTsMs >= value.windowEndTsExclusive
  ) {
    return false;
  }

  const finalMinuteStart = slotEndTs - FINAL_MINUTE_MS;
  return (
    value.windowStartTsMs >= finalMinuteStart - DEFAULT_FUTURE_TOLERANCE_MS &&
    value.windowStartTsMs <= now + DEFAULT_FUTURE_TOLERANCE_MS &&
    now - value.windowEndTsExclusive <= maxSourceAgeMs &&
    value.windowEndTsExclusive <= now + DEFAULT_FUTURE_TOLERANCE_MS &&
    value.windowEndTsExclusive <= slotEndTs + DEFAULT_FUTURE_TOLERANCE_MS &&
    Math.abs(value.windowEndTsExclusive - cfSourceTimestampMs) <= maxSourceAgeMs
  );
}

function calculateReturns(
  observations: PairedObservation[],
  maxReturnGapMs: number,
): ReturnObservation[] {
  const returns: ReturnObservation[] = [];
  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1];
    const current = observations[index];
    const elapsedMs = current.pairTimestampMs - previous.pairTimestampMs;
    if (elapsedMs <= 0 || elapsedMs > maxReturnGapMs) {
      continue;
    }
    const rootSeconds = Math.sqrt(elapsedMs / 1_000);
    const chainlink =
      Math.log(current.chainlinkPriceUsd / previous.chainlinkPriceUsd) /
      rootSeconds;
    const cf = Math.log(current.cfPriceUsd / previous.cfPriceUsd) / rootSeconds;
    if (Number.isFinite(chainlink) && Number.isFinite(cf)) {
      returns.push({ timestampMs: current.pairTimestampMs, chainlink, cf });
    }
  }
  return returns;
}

function robustClip(values: number[]): number[] {
  const center = median(values);
  const deviations = values.map((value) => Math.abs(value - center));
  const madScale = 1.4826 * median(deviations);
  const rmsScale = Math.sqrt(
    values.reduce((sum, value) => sum + (value - center) ** 2, 0) /
      Math.max(1, values.length),
  );
  const scale = Math.max(madScale, rmsScale * 0.25, MIN_LOG_VOLATILITY);
  const lower = center - ROBUST_CLIP_MULTIPLIER * scale;
  const upper = center + ROBUST_CLIP_MULTIPLIER * scale;
  return values.map((value) => clamp(value, lower, upper));
}

function robustEwmaBasis(
  observations: PairedObservation[],
  latestTimestampMs: number,
  halfLifeMs: number,
): number {
  const bases = observations.map((observation) =>
    Math.log(observation.cfPriceUsd / observation.chainlinkPriceUsd),
  );
  const clipped = robustClip(bases);
  let totalWeight = 0;
  let weightedBasis = 0;
  for (let index = 0; index < observations.length; index += 1) {
    const ageMs = Math.max(
      0,
      latestTimestampMs - observations[index].pairTimestampMs,
    );
    const weight = Math.exp((-Math.LN2 * ageMs) / halfLifeMs);
    totalWeight += weight;
    weightedBasis += weight * clipped[index];
  }
  return totalWeight <= 0 ? 0 : weightedBasis / totalWeight;
}

function structuralFatalProbabilityUpperBound(
  pFatal: number,
  effectiveObservationCount: number,
): number {
  // This is an explicit finite-history stress buffer, not a label-calibrated interval.
  const margin = Math.min(
    0.05,
    0.25 / Math.sqrt(Math.max(1, effectiveObservationCount)),
  );
  return clamp(Math.max(pFatal, pFatal + margin), 0, 1);
}

function unavailableEstimate(
  reason: string,
  observationCount: number,
  chainlinkAgeMs: number | null = null,
  cfAgeMs: number | null = null,
): MismatchRiskEstimate {
  return {
    available: false,
    modelVersion: MISMATCH_RISK_RUNTIME_MODEL_VERSION,
    reason,
    pFatal: null,
    pFatalUpper95: null,
    pAligned: null,
    pDouble: null,
    expectedPnlUsd: null,
    conservativePnlUsd: null,
    fatalPnlUsd: null,
    breakEvenFatalProbability: null,
    maximumAllowedFatalProbability: null,
    chainlinkAgeMs:
      chainlinkAgeMs === null ? null : Math.max(0, chainlinkAgeMs),
    cfAgeMs: cfAgeMs === null ? null : Math.max(0, cfAgeMs),
    observationCount,
  };
}

function unavailableStatistics(
  reason: "insufficient_history" | "insufficient_returns",
  observationCount: number,
  returnCount = 0,
): MismatchRiskRuntimeStatistics {
  return {
    available: false,
    reason,
    observationCount,
    returnCount,
    effectiveObservationCount: 0,
    chainlinkLogVolatilityPerSqrtSecond: null,
    cfLogVolatilityPerSqrtSecond: null,
    rawCorrelation: null,
    shrunkCorrelation: null,
    basisLog: null,
    basisBps: null,
  };
}

function unavailableReference(
  reason: string,
  chainlinkAgeMs: number | null = null,
  cfAgeMs: number | null = null,
): ReferenceExtractionResult {
  return { available: false, reason, chainlinkAgeMs, cfAgeMs };
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function assertIntegerAtLeast(value: number, minimum: number, field: string): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${field} must be an integer >= ${minimum}`);
  }
}

function assertPositiveFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive finite number`);
  }
}

function assertNonNegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative finite number`);
  }
}
