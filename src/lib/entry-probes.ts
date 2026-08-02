import { createHash } from "node:crypto";

import type { RestPairedPreflightDecision } from "@/lib/shadow-execution";
import type { MarketAsset, MismatchRiskEstimate, PairCombination, Venue } from "@/lib/types";

export const LATE_ENTRY_PROBE_TARGETS_SECONDS = [55, 45, 35, 25, 15, 5] as const;
export const ENTRY_PROBE_MAX_LEG_PRICE_CAPS = [0.49, 0.6, 0.7, 0.99] as const;
export const ENTRY_PROBE_SAFETY_FRACTIONS = [0.5, 0.75, 1] as const;
export const REST_PAIR_PROBE_SCHEMA_VERSION = "rest-pair-probe-v1" as const;
export const PERSISTED_CONSUMED_LEVEL_LIMIT_PER_LEG = 64;
export const PERSISTED_RAW_BOOK_LEVEL_LIMIT_PER_VENUE = 64;
export const LATE_ENTRY_PROBE_COMBINATIONS = [
  "POLY_UP_KALSHI_NO",
  "POLY_DOWN_KALSHI_YES",
] as const satisfies readonly PairCombination[];

export type LateEntryProbeTargetSeconds = (typeof LATE_ENTRY_PROBE_TARGETS_SECONDS)[number];
export type EntryProbeMaxLegPriceCap = (typeof ENTRY_PROBE_MAX_LEG_PRICE_CAPS)[number];
export type EntryProbeSafetyFraction = (typeof ENTRY_PROBE_SAFETY_FRACTIONS)[number];

export type LateEntryProbeIdentity = {
  asset: MarketAsset;
  slotKey: string;
  targetSeconds: LateEntryProbeTargetSeconds;
};

export type LateEntryProbeCaptureRejectionCode =
  "slot_ended" | "slot_identity_mismatch" | "opportunity_identity_mismatch";

export type EntryProbeEstimateReadinessRejectionCode =
  "risk_unavailable" | "execution_reference_unusable" | "model_uncalibrated";

export type EntryProbeVariant = {
  maxLegPriceCap: EntryProbeMaxLegPriceCap;
  safetyFraction: EntryProbeSafetyFraction;
};

export const ENTRY_PROBE_VARIANTS: readonly EntryProbeVariant[] = ENTRY_PROBE_MAX_LEG_PRICE_CAPS.flatMap(
  (maxLegPriceCap) =>
    ENTRY_PROBE_SAFETY_FRACTIONS.map((safetyFraction) => ({
      maxLegPriceCap,
      safetyFraction,
    })),
);

export type RestProbeBookLevel = readonly [price: number, size: number];

export function summarizeRawBookLevelsForProbe<T>(levels: readonly T[]) {
  return summarizeBoundedLevelCollection(levels, PERSISTED_RAW_BOOK_LEVEL_LIMIT_PER_VENUE);
}

export type RestProbeVenueBookProof = {
  venue: Venue;
  marketRef: string;
  instrumentId: string;
  outcome: "UP" | "DOWN" | "YES" | "NO";
  source: "rest";
  capturedAt: number;
  bestAskPrice: number | null;
  tickSize: number | null;
  minimumOrderSize: number | null;
  asks: readonly RestProbeBookLevel[];
  errorCode: string | null;
};

export type RestProbeLegVariantProof = {
  limitPrice: number | null;
  executableSize: number;
  vwapPrice: number | null;
  totalCostUsd: number | null;
};

export type RestPairProbeVariantRejectionCode =
  | "book_unavailable"
  | "price_cap_exceeded"
  | "insufficient_common_depth"
  | "non_positive_aligned_margin"
  | "fatal_probability_above_limit";

export type RestPairProbeVariantProof = EntryProbeVariant & {
  polymarket: RestProbeLegVariantProof;
  kalshi: RestProbeLegVariantProof;
  commonExecutableSize: number;
  totalCostUsd: number | null;
  payoutUsd: number | null;
  alignedProfitUsd: number | null;
  alignedReturn: number | null;
  maximumAllowedFatalProbability: number | null;
  fatalProbabilityUpper95: number | null;
  eligible: boolean;
  rejectionCode: RestPairProbeVariantRejectionCode | null;
};

export type EntryFunnelCode = "signal" | "base" | "rest" | "risk" | "admission" | "primary" | "hedge" | "settled";

export const ENTRY_FUNNEL_CODES: readonly EntryFunnelCode[] = [
  "signal",
  "base",
  "rest",
  "risk",
  "admission",
  "primary",
  "hedge",
  "settled",
];

export type EntryFunnelProgress = Readonly<Record<EntryFunnelCode, boolean>>;

export type EntryFunnelClassification =
  | {
      code: EntryFunnelCode;
      outcome: "stopped";
    }
  | {
      code: "settled";
      outcome: "completed";
    };

/**
 * A JSON-safe diagnostic proof. It intentionally contains no order, intent,
 * reservation, or submission identifier: a late probe can only observe books.
 */
export type RestPairProbeProof = {
  schemaVersion: typeof REST_PAIR_PROBE_SCHEMA_VERSION;
  probeId: string;
  identity: LateEntryProbeIdentity;
  diagnosticOnly: true;
  combination: PairCombination;
  capturedAt: number;
  capturedSecondsRemaining: number;
  requestedPairSize: number;
  polymarketBook: RestProbeVenueBookProof & { venue: "polymarket"; outcome: "UP" | "DOWN" };
  kalshiBook: RestProbeVenueBookProof & { venue: "kalshi"; outcome: "YES" | "NO" };
  variants: readonly RestPairProbeVariantProof[];
  funnel: EntryFunnelClassification;
};

export function isLateEntryProbeTargetSeconds(value: number): value is LateEntryProbeTargetSeconds {
  return LATE_ENTRY_PROBE_TARGETS_SECONDS.some((target) => target === value);
}

/**
 * Selects the target owning the current countdown band. Missed earlier bands
 * are never backfilled with newer evidence, so a restart cannot relabel one
 * current book as several historical probes.
 */
export function nextLateEntryProbeTarget(
  secondsRemaining: number,
  seenTargets: readonly number[],
): LateEntryProbeTargetSeconds | null {
  if (!Number.isFinite(secondsRemaining) || secondsRemaining <= 0) {
    return null;
  }

  const target = LATE_ENTRY_PROBE_TARGETS_SECONDS.find((candidate, index) => {
    const nextLowerTarget = LATE_ENTRY_PROBE_TARGETS_SECONDS[index + 1];
    return secondsRemaining <= candidate && (nextLowerTarget === undefined || secondsRemaining > nextLowerTarget);
  });

  if (target === undefined || seenTargets.some((seenTarget) => seenTarget === target)) {
    return null;
  }
  return target;
}

export function nextLateEntryProbeIdentity(input: {
  asset: MarketAsset;
  slotKey: string;
  secondsRemaining: number;
  seen: readonly LateEntryProbeIdentity[];
}): LateEntryProbeIdentity | null {
  const seenTargets = input.seen
    .filter((probe) => probe.asset === input.asset && probe.slotKey === input.slotKey)
    .map((probe) => probe.targetSeconds);
  const targetSeconds = nextLateEntryProbeTarget(input.secondsRemaining, seenTargets);
  if (targetSeconds === null) {
    return null;
  }
  return {
    asset: input.asset,
    slotKey: input.slotKey,
    targetSeconds,
  };
}

export function buildLateEntryProbeId(identity: LateEntryProbeIdentity): string {
  if (!identity.slotKey.trim()) {
    throw new TypeError("Late-entry probe slotKey must be non-empty");
  }
  if (!isLateEntryProbeTargetSeconds(identity.targetSeconds)) {
    throw new TypeError("Late-entry probe targetSeconds is not configured");
  }
  return `${REST_PAIR_PROBE_SCHEMA_VERSION}:${identity.asset}:${encodeURIComponent(identity.slotKey)}:${identity.targetSeconds}`;
}

export function buildLateEntryProbeCombinationKey(
  identity: LateEntryProbeIdentity,
  combination: PairCombination,
): string {
  if (!LATE_ENTRY_PROBE_COMBINATIONS.includes(combination)) {
    throw new TypeError("Late-entry probe combination is not configured");
  }
  return `${buildLateEntryProbeId(identity)}:${combination}`;
}

export function getMissingLateEntryProbeCombinations(
  identity: LateEntryProbeIdentity,
  persistedProbeKeys: readonly string[],
): PairCombination[] {
  const persisted = new Set(persistedProbeKeys);
  return LATE_ENTRY_PROBE_COMBINATIONS.filter(
    (combination) => !persisted.has(buildLateEntryProbeCombinationKey(identity, combination)),
  );
}

export function getLateEntryProbeCaptureRejection(input: {
  now: number;
  slot: {
    asset: MarketAsset;
    key: string;
    startTs: number;
    endTs: number;
  };
  snapshot: {
    asset: MarketAsset;
    slotKey: string;
    slotStartTs: number;
    slotEndTs: number;
  };
  opportunity: {
    asset: MarketAsset;
    slotKey: string;
  };
}): LateEntryProbeCaptureRejectionCode | null {
  if (!Number.isFinite(input.now) || input.now >= input.slot.endTs) {
    return "slot_ended";
  }
  if (
    input.snapshot.asset !== input.slot.asset ||
    input.snapshot.slotKey !== input.slot.key ||
    input.snapshot.slotStartTs !== input.slot.startTs ||
    input.snapshot.slotEndTs !== input.slot.endTs
  ) {
    return "slot_identity_mismatch";
  }
  if (input.opportunity.asset !== input.slot.asset || input.opportunity.slotKey !== input.slot.key) {
    return "opportunity_identity_mismatch";
  }
  return null;
}

export function getEntryProbeEstimateReadinessRejection(
  estimate: Pick<MismatchRiskEstimate, "available" | "executionUsable" | "modelVersion" | "pFatalUpper95"> | null,
): EntryProbeEstimateReadinessRejectionCode | null {
  if (
    !estimate?.available ||
    typeof estimate.pFatalUpper95 !== "number" ||
    !Number.isFinite(estimate.pFatalUpper95) ||
    estimate.pFatalUpper95 < 0 ||
    estimate.pFatalUpper95 > 1
  ) {
    return "risk_unavailable";
  }
  if (estimate.executionUsable !== true) {
    return "execution_reference_unusable";
  }
  const modelVersion = estimate.modelVersion.toLowerCase();
  if (modelVersion.includes("uncalibrated") || !modelVersion.includes("calibrated")) {
    return "model_uncalibrated";
  }
  return null;
}

export function summarizeRestPairedPreflightForProbe(
  decision: RestPairedPreflightDecision,
  options: { includeConsumedLevels?: boolean } = {},
) {
  return {
    status: decision.status,
    code: decision.code,
    reason: decision.reason,
    requestedPairSize: decision.requestedPairSize,
    minimumPairSize: decision.minimumPairSize,
    maxExecutablePairSize: decision.maxExecutablePairSize,
    priceLimits: decision.priceLimits,
    quote: decision.quote
      ? {
          commonSize: decision.quote.commonSize,
          grossCost: decision.quote.grossCost,
          totalCostUsd: decision.quote.totalCostUsd,
          worstFillCostUsd: decision.quote.worstFillCostUsd,
          projectedNetProfitUsd: decision.quote.projectedNetProfitUsd,
          projectedNetReturn: decision.quote.projectedNetReturn,
          worstCaseProfitUsd: decision.quote.worstCaseProfitUsd,
          polymarket: summarizeProbeLegQuote(decision.quote.polymarket, options.includeConsumedLevels === true),
          kalshi: summarizeProbeLegQuote(decision.quote.kalshi, options.includeConsumedLevels === true),
        }
      : null,
  };
}

function summarizeProbeLegQuote(
  quote: NonNullable<RestPairedPreflightDecision["quote"]>["polymarket"],
  includeConsumedLevels: boolean,
) {
  const scalars = {
    size: quote.size,
    displayedDepth: quote.displayedDepth,
    executableDepth: quote.executableDepth,
    notionalUsd: quote.notionalUsd,
    feeUsd: quote.feeUsd,
    costUsd: quote.costUsd,
    worstFillNotionalUsd: quote.worstFillNotionalUsd,
    worstFillFeeUsd: quote.worstFillFeeUsd,
    worstFillCostUsd: quote.worstFillCostUsd,
    vwapPrice: quote.vwapPrice,
    limitPrice: quote.limitPrice,
  };
  if (!includeConsumedLevels) {
    return scalars;
  }

  const bounded = summarizeBoundedLevelCollection(quote.consumedLevels, PERSISTED_CONSUMED_LEVEL_LIMIT_PER_LEG);

  return {
    ...scalars,
    consumedLevelCount: bounded.levelCount,
    consumedLevelsRetainedCount: bounded.retainedLevelCount,
    consumedLevelsTruncated: bounded.truncated,
    consumedLevelsSha256: bounded.sha256,
    consumedLevelsRetainedRanges: bounded.retainedRanges,
    consumedLevels: bounded.levels,
  };
}

function summarizeBoundedLevelCollection<T>(levels: readonly T[], limit: number) {
  const levelCount = levels.length;
  const truncated = levelCount > limit;
  const headCount = truncated ? Math.floor(limit / 2) : levelCount;
  const tailCount = truncated ? limit - headCount : 0;
  const retainedLevels = truncated
    ? [...levels.slice(0, headCount), ...levels.slice(levelCount - tailCount)]
    : [...levels];
  const retainedRanges = truncated
    ? [
        { startIndex: 0, endIndexExclusive: headCount },
        { startIndex: levelCount - tailCount, endIndexExclusive: levelCount },
      ]
    : [{ startIndex: 0, endIndexExclusive: levelCount }];

  return {
    levelCount,
    retainedLevelCount: retainedLevels.length,
    truncated,
    sha256: createHash("sha256").update(JSON.stringify(levels)).digest("hex"),
    retainedRanges,
    levels: retainedLevels,
  };
}

/** Returns the first stage not passed, or the unique completed bucket. */
export function classifyEntryFunnel(progress: EntryFunnelProgress): EntryFunnelClassification {
  for (const code of ENTRY_FUNNEL_CODES) {
    if (!progress[code]) {
      return { code, outcome: "stopped" };
    }
  }
  return { code: "settled", outcome: "completed" };
}
