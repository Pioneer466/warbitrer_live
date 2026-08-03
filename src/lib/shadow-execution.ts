import {
  applySlippage,
  getVenueMinimumOrderSize,
  quoteMultiLevelBuyLeg,
  type ExecutableBookLevel,
  type MultiLevelLegQuote,
} from "@/lib/fees";
import { ACCOUNTING_LEDGER_SCALE } from "@/lib/accounting-ledger";
import { SHADOW_REENTRY_COOLDOWN_MS } from "@/lib/entry-admission-policy";
import { deriveKalshiBuyPriceLevels } from "@/lib/kalshi";
import { isKalshiOutcomePriceValid, normalizeKalshiOutcomePrice, parseKalshiPriceGrid } from "@/lib/kalshi-price-grid";
import type {
  OpportunitySnapshot,
  OrderIntent,
  OrderIntentLeg,
  ShadowPreparedRestExecutionProof,
  ShadowExecutionAudit,
  StrategyConfig,
} from "@/lib/types";

export const SHADOW_EXECUTION_MODEL_VERSION = "rest-paired-preflight-v3";
export const SHADOW_MIN_COMPLETION_DELAY_MS = 0;
export const SHADOW_PREPARED_REST_PROOF_SCHEMA_VERSION = "rest-paired-preflight-proof-v2" as const;
export const LEGACY_SHADOW_REST_REFETCH_MODEL_VERSION = "rest-orderbook-v2" as const;
export { SHADOW_REENTRY_COOLDOWN_MS } from "@/lib/entry-admission-policy";

type ShadowSettings = Pick<
  StrategyConfig,
  | "executionPriceBuffer"
  | "grossEntryThreshold"
  | "kalshiDepthHeadroomContracts"
  | "kalshiPrimaryDepthSafetyFactor"
  | "maxLegCapitalShare"
  | "maxLegPrice"
  | "maxPairNotionalUsd"
  | "maxSlippageBps"
  | "minOrderSize"
  | "minProjectedNetProfitUsd"
  | "minProjectedNetReturn"
  | "minWorstCaseProfitUsd"
  | "polymarketHedgeDepthSafetyFactor"
  | "polymarketHedgeHeadroomShares"
>;

export type RestPairedPreflightSettings = Pick<
  StrategyConfig,
  | "executionPriceBuffer"
  | "grossEntryThreshold"
  | "kalshiDepthHeadroomContracts"
  | "kalshiPrimaryDepthSafetyFactor"
  | "maxLegCapitalShare"
  | "maxLegPrice"
  | "maxPairNotionalUsd"
  | "minOrderSize"
  | "minProjectedNetProfitUsd"
  | "minProjectedNetReturn"
  | "minWorstCaseProfitUsd"
  | "polymarketHedgeDepthSafetyFactor"
  | "polymarketHedgeHeadroomShares"
>;

export type RestPairedPreflightFailureCode =
  | "invalid_input"
  | "intent_snapshot_mismatch"
  | "market_data_not_ready"
  | "invalid_legs"
  | "orderbook_unavailable"
  | "kalshi_price_grid_unavailable"
  | "invalid_kalshi_price_level"
  | "price_above_absolute_cap"
  | "minimum_size"
  | "insufficient_common_depth"
  | "pair_budget"
  | "max_leg_capital"
  | "gross_entry_threshold"
  | "projected_profit"
  | "projected_return"
  | "worst_case_profit";

export type RestPairedPreflightQuote = {
  commonSize: number;
  grossCost: number;
  totalCostUsd: number;
  worstFillCostUsd: number;
  projectedNetProfitUsd: number;
  projectedNetReturn: number | null;
  worstCaseProfitUsd: number;
  polymarket: MultiLevelLegQuote;
  kalshi: MultiLevelLegQuote;
};

type RestPairedPreflightCommon = {
  requestedPairSize: number;
  minimumPairSize: number;
  maxExecutablePairSize: number;
  priceLimits: {
    polymarket: number | null;
    kalshi: number | null;
  };
};

export type RestPairedPreflightDecision =
  | (RestPairedPreflightCommon & {
      allowed: true;
      status: "eligible";
      code: null;
      reason: null;
      quote: RestPairedPreflightQuote;
    })
  | (RestPairedPreflightCommon & {
      allowed: false;
      status: "rejected";
      code: RestPairedPreflightFailureCode;
      reason: string;
      quote: RestPairedPreflightQuote | null;
    });

export function getShadowRestAdmissionRejection(input: {
  slotEndTs: number;
  restCapturedAt: number;
  restErrors: readonly string[];
  preflight: RestPairedPreflightDecision;
}): { code: string; reason: string } | null {
  if (input.restCapturedAt >= input.slotEndTs) {
    return {
      code: "slot_ended_during_rest_capture",
      reason: "REST capture completed at or after slot end; the candidate can no longer be admitted",
    };
  }
  if (input.restErrors.length > 0) {
    return {
      code: "rest_orderbook_unavailable",
      reason: input.restErrors.join("; "),
    };
  }
  if (!input.preflight.allowed) {
    return {
      code: input.preflight.code ?? "rest_preflight_rejected",
      reason: input.preflight.reason ?? "REST paired preflight rejected the candidate",
    };
  }
  return null;
}

export type ShadowLegCapacity = {
  leg: OrderIntentLeg;
  limitPrice: number | null;
  executableSize: number;
  quote: MultiLevelLegQuote | null;
  levelsAvailable: boolean;
};

export type ShadowPairExecutionDecision = {
  status: "filled" | "no_fill";
  reasonCode: string | null;
  reason: string | null;
  filledPairSize: number;
  realizedGrossCost: number | null;
  realizedTotalCostUsd: number | null;
  projectedNetProfitUsd: number | null;
  legs: [ShadowLegCapacity, ShadowLegCapacity];
};

type ShadowCompletionEvidence = {
  status: "filled" | "no_fill";
  reasonCode: string | null;
  reason: string | null;
  filledPairSize: number;
  realizedGrossCost: number | null;
  realizedTotalCostUsd: number | null;
  projectedNetProfitUsd: number | null;
  legs: Array<{
    venue: OrderIntentLeg["venue"];
    outcome: OrderIntentLeg["outcome"];
    requestedSize: number;
    executableSize: number;
    limitPrice: number | null;
    vwapPrice: number | null;
    feeUsd: number;
  }>;
};

export type ShadowRestRecoveryPlan =
  | { action: "prepared_proof" }
  | { action: "legacy_rest_refetch" }
  | {
      action: "fail_closed";
      reasonCode: "prepared_rest_proof_unavailable" | "unsupported_shadow_model_version";
      reason: string;
    };

export function planShadowRestRecovery(
  audit: Pick<ShadowExecutionAudit, "modelVersion" | "preparedRestExecution">,
): ShadowRestRecoveryPlan {
  if (audit.modelVersion === SHADOW_EXECUTION_MODEL_VERSION) {
    return audit.preparedRestExecution
      ? { action: "prepared_proof" }
      : {
          action: "fail_closed",
          reasonCode: "prepared_rest_proof_unavailable",
          reason: "Durable REST execution proof is unavailable; a new book cannot replace admitted v3 evidence",
        };
  }
  if (audit.modelVersion === LEGACY_SHADOW_REST_REFETCH_MODEL_VERSION && !audit.preparedRestExecution) {
    return { action: "legacy_rest_refetch" };
  }
  return {
    action: "fail_closed",
    reasonCode: "unsupported_shadow_model_version",
    reason: `Shadow model ${audit.modelVersion || "unknown"} is not eligible for REST recovery`,
  };
}

export function buildScheduledShadowAudit(
  intent: Pick<OrderIntent, "createdAt" | "grossCost" | "legs">,
  restStartedAt = intent.createdAt,
  options: {
    signalGrossCost?: number;
    restCapturedAt?: number | null;
    restErrors?: string[];
    preparedRestExecution?: ShadowPreparedRestExecutionProof | null;
  } = {},
): ShadowExecutionAudit {
  const requestedPairSize = getRequestedPairSize(intent.legs);
  const restCapturedAt = options.restCapturedAt ?? null;
  return {
    modelVersion: SHADOW_EXECUTION_MODEL_VERSION,
    status: "scheduled",
    scheduledAt: intent.createdAt,
    completionNotBeforeAt: intent.createdAt + SHADOW_MIN_COMPLETION_DELAY_MS,
    restStartedAt,
    restCapturedAt,
    restFetchDurationMs: restCapturedAt === null ? null : Math.max(0, restCapturedAt - restStartedAt),
    restErrors: options.restErrors ?? [],
    evaluatedAt: null,
    latencyMs: null,
    nextEligibleAt: null,
    requestedPairSize,
    filledPairSize: 0,
    fillRatio: 0,
    signalGrossCost: options.signalGrossCost ?? intent.grossCost,
    realizedGrossCost: null,
    realizedTotalCostUsd: null,
    projectedNetProfitUsd: null,
    reasonCode: null,
    reason: null,
    preparedRestExecution: options.preparedRestExecution ?? null,
    legs: intent.legs.map((leg) => ({
      venue: leg.venue,
      outcome: leg.outcome,
      requestedSize: leg.requestedSize,
      executableSize: 0,
      limitPrice: null,
      vwapPrice: null,
      feeUsd: 0,
      slippageBps: null,
    })),
  };
}

export function buildCompletedShadowAudit(
  intent: Pick<OrderIntent, "createdAt" | "grossCost" | "legs" | "shadowExecution">,
  decision: ShadowPairExecutionDecision,
  evaluatedAt: number,
  rest: {
    startedAt: number;
    capturedAt: number;
    errors?: string[];
  },
): ShadowExecutionAudit {
  return buildCompletedShadowAuditFromEvidence(
    intent,
    {
      status: decision.status,
      reasonCode: decision.reasonCode,
      reason: decision.reason,
      filledPairSize: decision.filledPairSize,
      realizedGrossCost: decision.realizedGrossCost,
      realizedTotalCostUsd: decision.realizedTotalCostUsd,
      projectedNetProfitUsd: decision.projectedNetProfitUsd,
      legs: decision.legs.map((capacity) => ({
        venue: capacity.leg.venue,
        outcome: capacity.leg.outcome,
        requestedSize: capacity.leg.requestedSize,
        executableSize: capacity.executableSize,
        limitPrice: capacity.limitPrice,
        vwapPrice: capacity.quote?.vwapPrice ?? null,
        feeUsd: capacity.quote?.feeUsd ?? 0,
      })),
    },
    evaluatedAt,
    rest,
  );
}

export function buildCompletedShadowAuditFromPreparedRestExecution(
  intent: Pick<
    OrderIntent,
    | "asset"
    | "combination"
    | "createdAt"
    | "fatalLossExposureUsd"
    | "grossCost"
    | "id"
    | "legs"
    | "shadowExecution"
    | "slotEndTs"
    | "slotKey"
    | "targetNotionalUsd"
  >,
  proof: unknown,
  evaluatedAt: number,
): ShadowExecutionAudit {
  assertPreparedShadowRestExecutionProof(intent, proof);
  const scheduled = intent.shadowExecution;
  if (
    !scheduled ||
    scheduled.modelVersion !== SHADOW_EXECUTION_MODEL_VERSION ||
    scheduled.modelVersion !== proof.modelVersion ||
    scheduled.restStartedAt > proof.capturedAt ||
    (scheduled.restCapturedAt !== null && scheduled.restCapturedAt !== proof.capturedAt)
  ) {
    throw new Error(`Shadow intent ${intent.id} has conflicting durable REST model or capture evidence`);
  }
  return buildCompletedShadowAuditFromEvidence(
    intent,
    {
      status: "filled",
      reasonCode: null,
      reason: null,
      filledPairSize: proof.filledPairSize,
      realizedGrossCost: proof.realizedGrossCost,
      realizedTotalCostUsd: proof.realizedTotalCostUsd,
      projectedNetProfitUsd: proof.projectedNetProfitUsd,
      legs: proof.legs.map((leg) => ({
        venue: leg.venue,
        outcome: leg.outcome,
        requestedSize: leg.requestedSize,
        executableSize: leg.executableSize,
        limitPrice: leg.limitPrice,
        vwapPrice: leg.vwapPrice,
        feeUsd: leg.feeUsd,
      })),
    },
    evaluatedAt,
    {
      startedAt: scheduled?.restStartedAt ?? proof.capturedAt,
      capturedAt: proof.capturedAt,
      errors: scheduled?.restErrors ?? [],
    },
  );
}

export function getPreparedShadowRestFillEconomics(
  intent: OrderIntent,
  audit: ShadowExecutionAudit,
  legId: string,
): {
  price: number;
  size: number;
  notionalUsd: number;
  feeUsd: number;
  totalCostUsd: number;
} | null {
  if (audit.modelVersion !== SHADOW_EXECUTION_MODEL_VERSION) {
    if (
      audit.modelVersion !== LEGACY_SHADOW_REST_REFETCH_MODEL_VERSION ||
      (audit.preparedRestExecution !== null && audit.preparedRestExecution !== undefined)
    ) {
      throw new Error(
        `Shadow intent ${intent.id} cannot fill from unsupported or conflicting model ${audit.modelVersion || "unknown"}`,
      );
    }
    return null;
  }
  if (audit.status !== "filled") {
    throw new Error(`Shadow intent ${intent.id} has no completed v3 fill evidence`);
  }

  const proof = audit.preparedRestExecution;
  assertPreparedShadowRestExecutionProof(intent, proof);
  if (
    proof.modelVersion !== audit.modelVersion ||
    audit.restCapturedAt !== proof.capturedAt ||
    !numbersClose(audit.filledPairSize, proof.filledPairSize) ||
    typeof audit.realizedGrossCost !== "number" ||
    !numbersClose(audit.realizedGrossCost, proof.realizedGrossCost, 1e-10) ||
    typeof audit.realizedTotalCostUsd !== "number" ||
    !numbersClose(audit.realizedTotalCostUsd, proof.realizedTotalCostUsd, 1e-8) ||
    typeof audit.projectedNetProfitUsd !== "number" ||
    !numbersClose(audit.projectedNetProfitUsd, proof.projectedNetProfitUsd, 1e-8)
  ) {
    throw new Error(`Shadow intent ${intent.id} has a completed audit that conflicts with its durable REST proof`);
  }

  const proofLeg = proof.legs.find((candidate) => candidate.legId === legId);
  const intentLeg = intent.legs.find((candidate) => candidate.id === legId);
  const auditLeg = intentLeg
    ? audit.legs.find((candidate) => candidate.venue === intentLeg.venue && candidate.outcome === intentLeg.outcome)
    : null;
  if (
    !proofLeg ||
    !intentLeg ||
    !auditLeg ||
    !numbersClose(auditLeg.requestedSize, proofLeg.requestedSize) ||
    !numbersClose(auditLeg.executableSize, proofLeg.executableSize) ||
    auditLeg.limitPrice === null ||
    !numbersClose(auditLeg.limitPrice, proofLeg.limitPrice) ||
    auditLeg.vwapPrice === null ||
    !numbersClose(auditLeg.vwapPrice, proofLeg.vwapPrice, 1e-10) ||
    !numbersClose(auditLeg.feeUsd, proofLeg.feeUsd, 1e-8)
  ) {
    throw new Error(`Shadow intent ${intent.id} has a completed leg audit that conflicts with its durable REST proof`);
  }

  return {
    price: canonicalizePreparedShadowFillPrice(proofLeg.notionalUsd, proofLeg.executableSize),
    size: proofLeg.executableSize,
    notionalUsd: proofLeg.notionalUsd,
    feeUsd: proofLeg.feeUsd,
    totalCostUsd: proofLeg.totalCostUsd,
  };
}

function buildCompletedShadowAuditFromEvidence(
  intent: Pick<OrderIntent, "createdAt" | "grossCost" | "legs" | "shadowExecution">,
  evidence: ShadowCompletionEvidence,
  evaluatedAt: number,
  rest: {
    startedAt: number;
    capturedAt: number;
    errors?: string[];
  },
): ShadowExecutionAudit {
  const scheduled = intent.shadowExecution;
  const requestedPairSize = scheduled?.requestedPairSize ?? getRequestedPairSize(intent.legs);
  return {
    modelVersion: scheduled?.modelVersion ?? SHADOW_EXECUTION_MODEL_VERSION,
    status: evidence.status,
    scheduledAt: scheduled?.scheduledAt ?? intent.createdAt,
    completionNotBeforeAt: scheduled?.completionNotBeforeAt ?? intent.createdAt + SHADOW_MIN_COMPLETION_DELAY_MS,
    restStartedAt: rest.startedAt,
    restCapturedAt: rest.capturedAt,
    restFetchDurationMs: Math.max(0, rest.capturedAt - rest.startedAt),
    restErrors: rest.errors ?? [],
    evaluatedAt,
    latencyMs: Math.max(0, evaluatedAt - intent.createdAt),
    nextEligibleAt: evaluatedAt + SHADOW_REENTRY_COOLDOWN_MS,
    requestedPairSize,
    filledPairSize: evidence.filledPairSize,
    fillRatio: requestedPairSize > 0 ? round4(evidence.filledPairSize / requestedPairSize) : 0,
    signalGrossCost: scheduled?.signalGrossCost ?? intent.grossCost,
    realizedGrossCost: evidence.realizedGrossCost,
    realizedTotalCostUsd: evidence.realizedTotalCostUsd,
    projectedNetProfitUsd: evidence.projectedNetProfitUsd,
    reasonCode: evidence.reasonCode,
    reason: evidence.reason,
    preparedRestExecution: scheduled?.preparedRestExecution ?? null,
    legs: evidence.legs.map((legEvidence) => {
      const intentLeg = intent.legs.find(
        (leg) => leg.venue === legEvidence.venue && leg.outcome === legEvidence.outcome,
      );
      return {
        ...legEvidence,
        slippageBps: deriveSlippageBps(intentLeg?.requestedPrice ?? null, legEvidence.vwapPrice),
      };
    }),
  };
}

export function getShadowReentryCooldownRemainingMs(
  lastIntent: Pick<OrderIntent, "updatedAt" | "shadowExecution"> | null | undefined,
  now: number,
) {
  if (!lastIntent) {
    return 0;
  }
  const completedAt = lastIntent.shadowExecution?.evaluatedAt ?? lastIntent.updatedAt;
  const nextEligibleAt = lastIntent.shadowExecution?.nextEligibleAt ?? completedAt + SHADOW_REENTRY_COOLDOWN_MS;
  return Math.max(0, nextEligibleAt - now);
}

export function deriveShadowPairExecution(input: {
  intent: OrderIntent;
  snapshot: OpportunitySnapshot;
  settings: ShadowSettings;
}): ShadowPairExecutionDecision {
  const requestedPairSize = getRequestedPairSize(input.intent.legs);
  const minimumPairSize = Math.ceil(
    Math.max(
      ...input.intent.legs.map((leg) =>
        getVenueMinimumOrderSize(
          leg.venue,
          getSnapshotMinimumOrderSize(input.snapshot, leg),
          leg.venue === "polymarket" ? input.settings.minOrderSize : 1,
        ),
      ),
    ),
  );
  const capacities = input.intent.legs.map((leg) =>
    deriveLegCapacity(leg, input.snapshot, input.settings, Math.floor(requestedPairSize)),
  ) as [ShadowLegCapacity, ShadowLegCapacity];

  if (
    input.snapshot.slotKey !== input.intent.slotKey ||
    input.snapshot.polymarket.feedHealth.feedStatus !== "ready" ||
    input.snapshot.kalshi.feedHealth.feedStatus !== "ready" ||
    !input.snapshot.polymarket.slotAligned ||
    !input.snapshot.kalshi.slotAligned
  ) {
    return noFill(
      capacities,
      "market_data_not_ready",
      "Données venues non prêtes ou non alignées au moment de l'exécution shadow",
    );
  }

  if (capacities.some((capacity) => !capacity.levelsAvailable)) {
    return noFill(capacities, "orderbook_unavailable", "Carnet complet indisponible au moment de l'exécution shadow");
  }

  if (capacities.some((capacity) => capacity.limitPrice === null)) {
    return noFill(capacities, "price_limit_unavailable", "Limite de prix shadow indisponible");
  }

  const commonExecutableSize = Math.floor(
    Math.min(requestedPairSize, capacities[0].executableSize, capacities[1].executableSize),
  );
  if (commonExecutableSize < minimumPairSize) {
    const movedBeyondLimit = capacities.some((capacity) => capacity.levelsAvailable && capacity.executableSize === 0);
    return noFill(
      capacities,
      movedBeyondLimit ? "price_moved_beyond_limit" : "insufficient_common_depth",
      movedBeyondLimit
        ? "Le prix a dépassé la limite de slippage avant l'exécution shadow"
        : "Profondeur commune insuffisante après les haircuts de liquidité",
    );
  }

  let lastEconomicReason = "L'économie de la paire n'est plus éligible après lecture REST et slippage";
  for (let size = commonExecutableSize; size >= minimumPairSize; size -= 1) {
    const pairQuotes = capacities.map((capacity) =>
      quoteLegAtSize(capacity.leg, input.snapshot, input.settings, capacity.limitPrice, size),
    ) as [MultiLevelLegQuote | null, MultiLevelLegQuote | null];
    const [polymarketQuote, kalshiQuote] = pairQuotes;
    if (!polymarketQuote || !kalshiQuote) {
      continue;
    }

    const executablePair: [MultiLevelLegQuote, MultiLevelLegQuote] = [polymarketQuote, kalshiQuote];
    const economicIssue = getEconomicIssue(executablePair, input.settings);
    if (economicIssue) {
      lastEconomicReason = economicIssue;
      continue;
    }

    const realizedTotalCostUsd = round4(polymarketQuote.costUsd + kalshiQuote.costUsd);
    const realizedGrossCost = round4((polymarketQuote.vwapPrice ?? 0) + (kalshiQuote.vwapPrice ?? 0));
    return {
      status: "filled",
      reasonCode: null,
      reason: null,
      filledPairSize: size,
      realizedGrossCost,
      realizedTotalCostUsd,
      projectedNetProfitUsd: round4(size - realizedTotalCostUsd),
      legs: capacities.map((capacity, index) => ({
        ...capacity,
        quote: executablePair[index],
      })) as [ShadowLegCapacity, ShadowLegCapacity],
    };
  }

  return noFill(capacities, "economics_no_longer_eligible", lastEconomicReason);
}

/**
 * Evaluates a paired entry directly from complete REST books.
 *
 * The signal prices are deliberately not used as relative slippage anchors here.
 * Both books are clipped by the configured absolute leg cap, and the Kalshi cap
 * is moved down to an authoritative outcome-price tick before depth is quoted.
 */
export function deriveRestPairedPreflight(input: {
  intent: OrderIntent;
  snapshot: OpportunitySnapshot;
  settings: RestPairedPreflightSettings;
}): RestPairedPreflightDecision {
  const requestedPairSize = getRestPreflightRequestedPairSize(input.intent.legs);
  const initialCommon: RestPairedPreflightCommon = {
    requestedPairSize,
    minimumPairSize: 0,
    maxExecutablePairSize: 0,
    priceLimits: {
      polymarket: null,
      kalshi: null,
    },
  };

  if (!isValidRestPreflightSettings(input.settings)) {
    return rejectRestPairedPreflight(initialCommon, "invalid_input", "REST preflight settings are invalid");
  }

  if (input.snapshot.asset !== input.intent.asset || input.snapshot.slotKey !== input.intent.slotKey) {
    return rejectRestPairedPreflight(
      initialCommon,
      "intent_snapshot_mismatch",
      "Intent and REST snapshot identities do not match",
    );
  }

  if (
    input.snapshot.polymarket.feedHealth.feedStatus !== "ready" ||
    input.snapshot.kalshi.feedHealth.feedStatus !== "ready" ||
    !input.snapshot.polymarket.slotAligned ||
    !input.snapshot.kalshi.slotAligned
  ) {
    return rejectRestPairedPreflight(
      initialCommon,
      "market_data_not_ready",
      "REST books are not ready and aligned for the intent slot",
    );
  }

  const polymarketLegs = input.intent.legs.filter((leg) => leg.venue === "polymarket");
  const kalshiLegs = input.intent.legs.filter((leg) => leg.venue === "kalshi");
  const polymarketLeg = polymarketLegs[0];
  const kalshiLeg = kalshiLegs[0];
  if (
    input.intent.legs.length !== 2 ||
    polymarketLegs.length !== 1 ||
    kalshiLegs.length !== 1 ||
    !polymarketLeg ||
    !kalshiLeg ||
    input.intent.legs.some((leg) => leg.side !== "BUY") ||
    (polymarketLeg.outcome !== "UP" && polymarketLeg.outcome !== "DOWN") ||
    (kalshiLeg.outcome !== "YES" && kalshiLeg.outcome !== "NO") ||
    !doPreflightLegsMatchCombination(input.intent)
  ) {
    return rejectRestPairedPreflight(
      initialCommon,
      "invalid_legs",
      "A REST pair requires one matching BUY leg on each venue",
    );
  }
  const kalshiOutcome: "YES" | "NO" = kalshiLeg.outcome;

  const rawMinimumPairSize = Math.max(
    getVenueMinimumOrderSize(
      "polymarket",
      getSnapshotMinimumOrderSize(input.snapshot, polymarketLeg),
      input.settings.minOrderSize,
    ),
    getVenueMinimumOrderSize("kalshi", getSnapshotMinimumOrderSize(input.snapshot, kalshiLeg), 1),
    input.settings.minOrderSize,
  );
  if (!Number.isFinite(rawMinimumPairSize) || rawMinimumPairSize <= 0) {
    return rejectRestPairedPreflight(initialCommon, "invalid_input", "REST snapshot minimum order sizes are invalid");
  }
  const minimumPairSize = Math.ceil(Math.max(rawMinimumPairSize, 1));
  const commonWithMinimum: RestPairedPreflightCommon = {
    ...initialCommon,
    minimumPairSize,
  };
  const requestedPairSizeCap = Math.floor(requestedPairSize);
  if (!Number.isFinite(requestedPairSize) || requestedPairSize <= 0 || requestedPairSizeCap < minimumPairSize) {
    return rejectRestPairedPreflight(
      commonWithMinimum,
      "minimum_size",
      "Requested pair size is below the venue minimum",
    );
  }

  const polymarketLevels = getBuyLevels(input.snapshot, polymarketLeg);
  const kalshiLevels = getBuyLevels(input.snapshot, kalshiLeg);
  if (polymarketLevels.length === 0 || kalshiLevels.length === 0) {
    return rejectRestPairedPreflight(
      commonWithMinimum,
      "orderbook_unavailable",
      "A complete buy book is unavailable for at least one venue",
    );
  }

  let kalshiPriceLimit: number;
  try {
    kalshiPriceLimit = deriveKalshiAbsoluteBuyCap(
      input.settings.maxLegPrice,
      kalshiOutcome,
      input.snapshot.kalshi.priceRanges,
    );
  } catch {
    return rejectRestPairedPreflight(
      {
        ...commonWithMinimum,
        priceLimits: {
          polymarket: input.settings.maxLegPrice,
          kalshi: null,
        },
      },
      "kalshi_price_grid_unavailable",
      "Kalshi authoritative price grid is unavailable or invalid",
    );
  }

  const rawKalshiLevels = deriveKalshiBuyPriceLevels(input.snapshot.kalshi.orderbookLevels, kalshiOutcome);
  if (
    rawKalshiLevels.some(
      ([price, size]) =>
        Number.isFinite(price) &&
        Number.isFinite(size) &&
        size > 0 &&
        !isKalshiOutcomePriceValid({
          price,
          outcome: kalshiOutcome,
          priceRanges: input.snapshot.kalshi.priceRanges ?? [],
        }),
    )
  ) {
    return rejectRestPairedPreflight(
      commonWithMinimum,
      "invalid_kalshi_price_level",
      "Kalshi REST book contains a price outside the authoritative grid",
    );
  }

  const priceLimits = {
    polymarket: input.settings.maxLegPrice,
    kalshi: kalshiPriceLimit,
  };
  const commonWithLimits: RestPairedPreflightCommon = {
    ...commonWithMinimum,
    priceLimits,
  };
  if (
    !polymarketLevels.some((level) => level.price <= priceLimits.polymarket + 1e-9) ||
    !kalshiLevels.some((level) => level.price <= priceLimits.kalshi + 1e-9)
  ) {
    return rejectRestPairedPreflight(
      commonWithLimits,
      "price_above_absolute_cap",
      "At least one REST book has no executable level below the absolute leg cap",
    );
  }

  let maxExecutablePairSize = 0;
  let lastRejected: {
    failure: RestPreflightFailure;
    quote: RestPairedPreflightQuote;
  } | null = null;
  for (let size = requestedPairSizeCap; size >= minimumPairSize; size -= 1) {
    const quote = quoteRestPreflightPair({
      size,
      snapshot: input.snapshot,
      settings: input.settings,
      polymarketLevels,
      kalshiLevels,
      priceLimits,
    });
    if (!quote) {
      continue;
    }
    if (maxExecutablePairSize === 0) {
      maxExecutablePairSize = size;
    }

    const failure = evaluateRestPreflightEconomics(quote, input.settings);
    if (!failure) {
      return {
        ...commonWithLimits,
        maxExecutablePairSize,
        allowed: true,
        status: "eligible",
        code: null,
        reason: null,
        quote,
      };
    }
    lastRejected = { failure, quote };
  }

  const completedCommon = {
    ...commonWithLimits,
    maxExecutablePairSize,
  };
  if (!lastRejected) {
    return rejectRestPairedPreflight(
      completedCommon,
      "insufficient_common_depth",
      "Common executable REST depth is below the minimum after safety haircuts and headrooms",
    );
  }

  return rejectRestPairedPreflight(
    completedCommon,
    lastRejected.failure.code,
    lastRejected.failure.reason,
    lastRejected.quote,
  );
}

export function applyRestPairedPreflightToIntent(
  intent: OrderIntent,
  decision: Extract<RestPairedPreflightDecision, { allowed: true }>,
  now: number,
): OrderIntent {
  const quoteByVenue = {
    polymarket: decision.quote.polymarket,
    kalshi: decision.quote.kalshi,
  } as const;
  const legs = intent.legs.map((leg) => {
    const quote = quoteByVenue[leg.venue];
    if (quote.limitPrice === null) {
      throw new Error(`REST preflight omitted the ${leg.venue} limit price`);
    }
    return {
      ...leg,
      requestedPrice: quote.limitPrice,
      requestedSize: decision.quote.commonSize,
      requestedNotionalUsd: quote.worstFillNotionalUsd,
      feeUsd: quote.worstFillFeeUsd,
    };
  }) as OrderIntent["legs"];
  const grossCost = legs.reduce((sum, leg) => sum + (leg.requestedPrice ?? 0), 0);
  return {
    ...intent,
    grossCost: round4(grossCost),
    targetNotionalUsd: round4(legs.reduce((sum, leg) => sum + leg.requestedNotionalUsd, 0)),
    projectedNetProfitUsd: decision.quote.worstCaseProfitUsd,
    fatalMismatchPnlUsd: -decision.quote.worstFillCostUsd,
    conservativeExpectedPnlUsd: null,
    fatalLossExposureUsd: decision.quote.worstFillCostUsd,
    legs,
    updatedAt: now,
  };
}

export function deriveShadowDecisionFromRestPreflight(
  intent: OrderIntent,
  decision: Extract<RestPairedPreflightDecision, { allowed: true }>,
): ShadowPairExecutionDecision {
  const quoteByVenue = {
    polymarket: decision.quote.polymarket,
    kalshi: decision.quote.kalshi,
  } as const;
  return {
    status: "filled",
    reasonCode: null,
    reason: null,
    filledPairSize: decision.quote.commonSize,
    realizedGrossCost: decision.quote.grossCost,
    realizedTotalCostUsd: decision.quote.totalCostUsd,
    projectedNetProfitUsd: decision.quote.projectedNetProfitUsd,
    legs: intent.legs.map((leg) => {
      const quote = quoteByVenue[leg.venue];
      return {
        leg,
        limitPrice: quote.limitPrice,
        executableSize: quote.size,
        quote,
        levelsAvailable: true,
      };
    }) as ShadowPairExecutionDecision["legs"],
  };
}

export function buildPreparedShadowRestExecutionProof(
  intent: OrderIntent,
  decision: Extract<RestPairedPreflightDecision, { allowed: true }>,
  capturedAt: number,
): ShadowPreparedRestExecutionProof {
  const quoteByVenue = {
    polymarket: decision.quote.polymarket,
    kalshi: decision.quote.kalshi,
  } as const;
  const filledPairSize = decision.quote.commonSize;
  const legs = intent.legs.map((leg) => {
    const quote = quoteByVenue[leg.venue];
    if (quote.limitPrice === null || quote.vwapPrice === null) {
      throw new Error(`REST preflight proof omitted executable ${leg.venue} prices`);
    }
    const notionalUsd = quote.notionalUsd;
    const feeUsd = quote.feeUsd;
    return {
      legId: leg.id,
      venue: leg.venue,
      outcome: leg.outcome,
      requestedSize: leg.requestedSize,
      executableSize: quote.size,
      limitPrice: quote.limitPrice,
      notionalUsd,
      vwapPrice: notionalUsd / quote.size,
      feeUsd,
      totalCostUsd: round5(notionalUsd + feeUsd),
    };
  });
  const realizedTotalCostUsd = round5(legs.reduce((sum, leg) => sum + leg.totalCostUsd, 0));
  const realizedGrossCost = legs.reduce((sum, leg) => sum + leg.notionalUsd, 0) / filledPairSize;
  const proof: ShadowPreparedRestExecutionProof = {
    schemaVersion: SHADOW_PREPARED_REST_PROOF_SCHEMA_VERSION,
    modelVersion: SHADOW_EXECUTION_MODEL_VERSION,
    intentId: intent.id,
    asset: intent.asset,
    slotKey: intent.slotKey,
    combination: intent.combination,
    capturedAt,
    filledPairSize,
    realizedGrossCost,
    realizedTotalCostUsd,
    projectedNetProfitUsd: round5(filledPairSize - realizedTotalCostUsd),
    legs,
  };
  assertPreparedShadowRestExecutionProof(intent, proof);
  return proof;
}

export function assertPreparedShadowRestExecutionProof(
  intent: Pick<
    OrderIntent,
    | "asset"
    | "combination"
    | "createdAt"
    | "fatalLossExposureUsd"
    | "grossCost"
    | "id"
    | "legs"
    | "slotEndTs"
    | "slotKey"
    | "targetNotionalUsd"
  >,
  proof: unknown,
): asserts proof is ShadowPreparedRestExecutionProof {
  if (!proof || typeof proof !== "object") {
    throw new Error(`Shadow intent ${intent.id} has no durable REST execution proof`);
  }
  const candidate = proof as Partial<ShadowPreparedRestExecutionProof>;
  if (
    candidate.schemaVersion !== SHADOW_PREPARED_REST_PROOF_SCHEMA_VERSION ||
    candidate.modelVersion !== SHADOW_EXECUTION_MODEL_VERSION ||
    candidate.intentId !== intent.id ||
    candidate.asset !== intent.asset ||
    candidate.slotKey !== intent.slotKey ||
    candidate.combination !== intent.combination ||
    !Number.isSafeInteger(candidate.capturedAt) ||
    (candidate.capturedAt ?? -1) < intent.createdAt ||
    (candidate.capturedAt ?? Number.POSITIVE_INFINITY) >= intent.slotEndTs ||
    !Number.isSafeInteger(candidate.filledPairSize) ||
    !isPositiveFinite(candidate.filledPairSize) ||
    !isPositiveFinite(candidate.realizedGrossCost) ||
    !isPositiveFinite(candidate.realizedTotalCostUsd) ||
    typeof candidate.projectedNetProfitUsd !== "number" ||
    !Number.isFinite(candidate.projectedNetProfitUsd) ||
    !Array.isArray(candidate.legs) ||
    candidate.legs.length !== intent.legs.length
  ) {
    throw new Error(`Shadow intent ${intent.id} has an invalid durable REST execution proof`);
  }

  const seenLegIds = new Set<string>();
  for (const proofLeg of candidate.legs) {
    const intentLeg = intent.legs.find((leg) => leg.id === proofLeg.legId);
    if (
      !intentLeg ||
      seenLegIds.has(proofLeg.legId) ||
      proofLeg.venue !== intentLeg.venue ||
      proofLeg.outcome !== intentLeg.outcome ||
      !numbersClose(proofLeg.requestedSize, intentLeg.requestedSize) ||
      !numbersClose(proofLeg.requestedSize, candidate.filledPairSize) ||
      !isPositiveFinite(proofLeg.executableSize) ||
      !numbersClose(proofLeg.executableSize, candidate.filledPairSize) ||
      !isTradablePrice(proofLeg.limitPrice) ||
      intentLeg.requestedPrice === null ||
      !numbersClose(proofLeg.limitPrice, intentLeg.requestedPrice) ||
      !isPositiveFinite(proofLeg.notionalUsd) ||
      !isTradablePrice(proofLeg.vwapPrice) ||
      !numbersClose(proofLeg.vwapPrice, proofLeg.notionalUsd / proofLeg.executableSize, 1e-10) ||
      proofLeg.vwapPrice > proofLeg.limitPrice + 1e-6 ||
      !isNonNegativeFinite(proofLeg.feeUsd) ||
      !isPositiveFinite(proofLeg.totalCostUsd) ||
      !numbersClose(proofLeg.totalCostUsd, round5(proofLeg.notionalUsd + proofLeg.feeUsd), 1e-8) ||
      proofLeg.notionalUsd > intentLeg.requestedNotionalUsd + 1e-4 ||
      proofLeg.feeUsd > intentLeg.feeUsd + 1e-5 ||
      proofLeg.totalCostUsd >
        (intentLeg.worstFillCostUsd ?? intentLeg.requestedNotionalUsd + Math.max(0, intentLeg.feeUsd)) + 1e-4
    ) {
      throw new Error(`Shadow intent ${intent.id} has a conflicting durable REST leg proof`);
    }
    seenLegIds.add(proofLeg.legId);
  }

  const notionalUsd = candidate.legs.reduce((sum, leg) => sum + leg.notionalUsd, 0);
  const grossCost = notionalUsd / candidate.filledPairSize;
  const totalCostUsd = round5(candidate.legs.reduce((sum, leg) => sum + leg.totalCostUsd, 0));
  const admittedWorstFillCostUsd = intent.legs.reduce(
    (sum, leg) => sum + (leg.worstFillCostUsd ?? leg.requestedNotionalUsd + Math.max(0, leg.feeUsd)),
    0,
  );
  if (
    !numbersClose(grossCost, candidate.realizedGrossCost, 1e-10) ||
    !numbersClose(totalCostUsd, candidate.realizedTotalCostUsd, 1e-8) ||
    !numbersClose(
      round5(candidate.filledPairSize - candidate.realizedTotalCostUsd),
      candidate.projectedNetProfitUsd,
      1e-8,
    ) ||
    candidate.realizedGrossCost > intent.grossCost + 1e-6 ||
    notionalUsd > intent.targetNotionalUsd + 1e-4 ||
    candidate.realizedTotalCostUsd > admittedWorstFillCostUsd + 1e-4 ||
    (isPositiveFinite(intent.fatalLossExposureUsd) &&
      candidate.realizedTotalCostUsd > intent.fatalLossExposureUsd + 1e-4)
  ) {
    throw new Error(`Shadow intent ${intent.id} has inconsistent durable REST economics`);
  }
}

type RestPreflightFailure = {
  code: RestPairedPreflightFailureCode;
  reason: string;
};

function doPreflightLegsMatchCombination(intent: OrderIntent) {
  const polymarketLeg = intent.legs.find((leg) => leg.venue === "polymarket");
  const kalshiLeg = intent.legs.find((leg) => leg.venue === "kalshi");
  if (!polymarketLeg || !kalshiLeg) {
    return false;
  }
  return intent.combination === "POLY_UP_KALSHI_NO"
    ? polymarketLeg.outcome === "UP" && kalshiLeg.outcome === "NO"
    : intent.combination === "POLY_DOWN_KALSHI_YES"
      ? polymarketLeg.outcome === "DOWN" && kalshiLeg.outcome === "YES"
      : false;
}

function getRestPreflightRequestedPairSize(legs: OrderIntent["legs"]) {
  const requestedPairSize = Math.min(...legs.map((leg) => leg.requestedSize));
  return Number.isFinite(requestedPairSize) && requestedPairSize > 0 ? round4(requestedPairSize) : 0;
}

function deriveKalshiAbsoluteBuyCap(
  maxLegPrice: number,
  outcome: "YES" | "NO",
  priceRanges: OpportunitySnapshot["kalshi"]["priceRanges"],
) {
  if (!priceRanges) {
    throw new Error("Kalshi price grid unavailable");
  }
  const outcomePrices = parseKalshiPriceGrid(priceRanges)
    .map((yesPriceUnits) => (outcome === "YES" ? yesPriceUnits : 10_000 - yesPriceUnits) / 10_000)
    .filter((price) => price > 0 && price < 1 && price <= maxLegPrice + 1e-9);
  const price = Math.max(...outcomePrices);
  if (!Number.isFinite(price) || price <= 0 || price > maxLegPrice + 1e-9) {
    throw new Error("No tradable Kalshi price below the absolute cap");
  }
  return round4(price);
}

function quoteRestPreflightPair(input: {
  size: number;
  snapshot: OpportunitySnapshot;
  settings: RestPairedPreflightSettings;
  polymarketLevels: ExecutableBookLevel[];
  kalshiLevels: ExecutableBookLevel[];
  priceLimits: {
    polymarket: number;
    kalshi: number;
  };
}): RestPairedPreflightQuote | null {
  const polymarket = quoteMultiLevelBuyLeg({
    venue: "polymarket",
    levels: input.polymarketLevels,
    size: input.size,
    maxPrice: input.priceLimits.polymarket,
    depthSafetyFactor: input.settings.polymarketHedgeDepthSafetyFactor,
    depthHeadroom: input.settings.polymarketHedgeHeadroomShares,
    feeRateBps: input.snapshot.polymarket.feeRateBps,
    feeRate: input.snapshot.polymarket.feeRate ?? undefined,
    feeExponent: input.snapshot.polymarket.feeExponent ?? undefined,
  });
  const kalshi = quoteMultiLevelBuyLeg({
    venue: "kalshi",
    levels: input.kalshiLevels,
    size: input.size,
    maxPrice: input.priceLimits.kalshi,
    depthSafetyFactor: input.settings.kalshiPrimaryDepthSafetyFactor,
    depthHeadroom: input.settings.kalshiDepthHeadroomContracts,
    feeMultiplier: input.snapshot.kalshi.feeMultiplier,
  });
  if (!polymarket || !kalshi) {
    return null;
  }

  const totalCostUsd = polymarket.costUsd + kalshi.costUsd;
  const worstFillCostUsd = polymarket.worstFillCostUsd + kalshi.worstFillCostUsd;
  const grossCost = (polymarket.notionalUsd + kalshi.notionalUsd) / input.size;
  const projectedNetProfitUsd = input.size - totalCostUsd;
  const projectedNetReturn = totalCostUsd > 0 ? projectedNetProfitUsd / totalCostUsd : null;
  const worstCaseProfitUsd = input.size - worstFillCostUsd;
  const numericValues = [totalCostUsd, worstFillCostUsd, grossCost, projectedNetProfitUsd, worstCaseProfitUsd];
  if (numericValues.some((value) => !Number.isFinite(value))) {
    return null;
  }

  return {
    commonSize: input.size,
    grossCost: round4(grossCost),
    totalCostUsd: round4(totalCostUsd),
    worstFillCostUsd: round4(worstFillCostUsd),
    projectedNetProfitUsd: round4(projectedNetProfitUsd),
    projectedNetReturn: projectedNetReturn === null ? null : round4(projectedNetReturn),
    worstCaseProfitUsd: round4(worstCaseProfitUsd),
    polymarket,
    kalshi,
  };
}

function evaluateRestPreflightEconomics(
  quote: RestPairedPreflightQuote,
  settings: RestPairedPreflightSettings,
): RestPreflightFailure | null {
  if (quote.worstFillCostUsd > settings.maxPairNotionalUsd + 1e-9) {
    return {
      code: "pair_budget",
      reason: `Worst-fill pair cost ${quote.worstFillCostUsd.toFixed(4)} exceeds the configured pair budget`,
    };
  }

  const maxLegCostUsd = settings.maxPairNotionalUsd * settings.maxLegCapitalShare;
  if (
    quote.polymarket.worstFillCostUsd > maxLegCostUsd + 1e-9 ||
    quote.kalshi.worstFillCostUsd > maxLegCostUsd + 1e-9
  ) {
    return {
      code: "max_leg_capital",
      reason: "At least one worst-fill leg cost exceeds its configured capital share",
    };
  }

  const allowedGrossCost = settings.grossEntryThreshold + settings.executionPriceBuffer;
  if (quote.grossCost > allowedGrossCost + 1e-9) {
    return {
      code: "gross_entry_threshold",
      reason: `REST gross cost ${quote.grossCost.toFixed(4)} exceeds the buffered entry threshold`,
    };
  }

  if (quote.projectedNetProfitUsd + 1e-9 < settings.minProjectedNetProfitUsd) {
    return {
      code: "projected_profit",
      reason: `Projected REST profit ${quote.projectedNetProfitUsd.toFixed(4)} is below the configured minimum`,
    };
  }

  if (quote.projectedNetReturn === null || quote.projectedNetReturn + 1e-9 < settings.minProjectedNetReturn) {
    return {
      code: "projected_return",
      reason: `Projected REST return ${quote.projectedNetReturn?.toFixed(6) ?? "n/a"} is below the configured minimum`,
    };
  }

  if (quote.worstCaseProfitUsd + 1e-9 < settings.minWorstCaseProfitUsd) {
    return {
      code: "worst_case_profit",
      reason: `Worst-fill REST profit ${quote.worstCaseProfitUsd.toFixed(4)} is below the configured minimum`,
    };
  }

  return null;
}

function rejectRestPairedPreflight(
  common: RestPairedPreflightCommon,
  code: RestPairedPreflightFailureCode,
  reason: string,
  quote: RestPairedPreflightQuote | null = null,
): RestPairedPreflightDecision {
  return {
    ...common,
    allowed: false,
    status: "rejected",
    code,
    reason,
    quote,
  };
}

function isValidRestPreflightSettings(settings: RestPairedPreflightSettings) {
  const nonNegativeValues = [
    settings.executionPriceBuffer,
    settings.grossEntryThreshold,
    settings.kalshiDepthHeadroomContracts,
    settings.minProjectedNetProfitUsd,
    settings.minProjectedNetReturn,
    settings.minWorstCaseProfitUsd,
    settings.polymarketHedgeHeadroomShares,
  ];
  return (
    nonNegativeValues.every((value) => Number.isFinite(value) && value >= 0) &&
    Number.isFinite(settings.maxPairNotionalUsd) &&
    settings.maxPairNotionalUsd > 0 &&
    Number.isFinite(settings.maxLegCapitalShare) &&
    settings.maxLegCapitalShare > 0 &&
    settings.maxLegCapitalShare <= 1 &&
    Number.isFinite(settings.maxLegPrice) &&
    settings.maxLegPrice > 0 &&
    settings.maxLegPrice <= 1 &&
    Number.isFinite(settings.minOrderSize) &&
    settings.minOrderSize > 0 &&
    Number.isFinite(settings.kalshiPrimaryDepthSafetyFactor) &&
    settings.kalshiPrimaryDepthSafetyFactor > 0 &&
    settings.kalshiPrimaryDepthSafetyFactor <= 1 &&
    Number.isFinite(settings.polymarketHedgeDepthSafetyFactor) &&
    settings.polymarketHedgeDepthSafetyFactor > 0 &&
    settings.polymarketHedgeDepthSafetyFactor <= 1
  );
}

function deriveLegCapacity(
  leg: OrderIntentLeg,
  snapshot: OpportunitySnapshot,
  settings: ShadowSettings,
  requestedPairSize: number,
): ShadowLegCapacity {
  const levels = getBuyLevels(snapshot, leg);
  const limitPrice = deriveLimitPrice(leg, snapshot, settings);
  const minimumSize = Math.ceil(
    getVenueMinimumOrderSize(
      leg.venue,
      getSnapshotMinimumOrderSize(snapshot, leg),
      leg.venue === "polymarket" ? settings.minOrderSize : 1,
    ),
  );

  if (levels.length === 0 || limitPrice === null) {
    return {
      leg,
      limitPrice,
      executableSize: 0,
      quote: null,
      levelsAvailable: levels.length > 0,
    };
  }

  for (let size = requestedPairSize; size >= minimumSize; size -= 1) {
    const quote = quoteLegAtSize(leg, snapshot, settings, limitPrice, size);
    if (quote) {
      return { leg, limitPrice, executableSize: size, quote, levelsAvailable: true };
    }
  }

  return { leg, limitPrice, executableSize: 0, quote: null, levelsAvailable: true };
}

function quoteLegAtSize(
  leg: OrderIntentLeg,
  snapshot: OpportunitySnapshot,
  settings: ShadowSettings,
  limitPrice: number | null,
  size: number,
) {
  if (limitPrice === null || size <= 0) {
    return null;
  }
  const levels = getBuyLevels(snapshot, leg);
  if (leg.venue === "polymarket") {
    return quoteMultiLevelBuyLeg({
      venue: "polymarket",
      levels,
      size,
      maxPrice: limitPrice,
      depthSafetyFactor: settings.polymarketHedgeDepthSafetyFactor,
      depthHeadroom: settings.polymarketHedgeHeadroomShares,
      feeRateBps: snapshot.polymarket.feeRateBps,
      feeRate: snapshot.polymarket.feeRate ?? undefined,
      feeExponent: snapshot.polymarket.feeExponent ?? undefined,
    });
  }

  return quoteMultiLevelBuyLeg({
    venue: "kalshi",
    levels,
    size,
    maxPrice: limitPrice,
    depthSafetyFactor: settings.kalshiPrimaryDepthSafetyFactor,
    depthHeadroom: settings.kalshiDepthHeadroomContracts,
    feeMultiplier: snapshot.kalshi.feeMultiplier,
  });
}

function getBuyLevels(snapshot: OpportunitySnapshot, leg: OrderIntentLeg): ExecutableBookLevel[] {
  if (leg.venue === "polymarket") {
    const raw =
      leg.outcome === "UP"
        ? snapshot.polymarket.orderbookLevels?.upAsks
        : snapshot.polymarket.orderbookLevels?.downAsks;
    return normalizeLevels(raw ?? []);
  }

  const outcome = leg.outcome === "YES" ? "YES" : "NO";
  return normalizeLevels(deriveKalshiBuyPriceLevels(snapshot.kalshi.orderbookLevels, outcome));
}

function normalizeLevels(levels: Array<[number, number]>) {
  return levels
    .map(([price, size]) => ({ price, size }))
    .filter(
      (level) =>
        Number.isFinite(level.price) &&
        Number.isFinite(level.size) &&
        level.price > 0 &&
        level.price < 1 &&
        level.size > 0,
    );
}

function deriveLimitPrice(leg: OrderIntentLeg, snapshot: OpportunitySnapshot, settings: ShadowSettings) {
  if (leg.requestedPrice === null || leg.requestedPrice <= 0) {
    return null;
  }
  const rawLimit = Math.min(settings.maxLegPrice, applySlippage(leg.requestedPrice, settings.maxSlippageBps));
  if (leg.venue !== "kalshi") {
    return round4(rawLimit);
  }
  if ((leg.outcome !== "YES" && leg.outcome !== "NO") || snapshot.kalshi.priceRanges === null) {
    return null;
  }
  try {
    return normalizeKalshiOutcomePrice({
      price: rawLimit,
      outcome: leg.outcome,
      side: "BUY",
      priceRanges: snapshot.kalshi.priceRanges,
    }).price;
  } catch {
    return null;
  }
}

function getEconomicIssue(quotes: [MultiLevelLegQuote, MultiLevelLegQuote], settings: ShadowSettings) {
  const pairSize = Math.min(quotes[0].size, quotes[1].size);
  const grossCost =
    (quotes[0].vwapPrice ?? Number.POSITIVE_INFINITY) + (quotes[1].vwapPrice ?? Number.POSITIVE_INFINITY);
  const totalCostUsd = quotes[0].costUsd + quotes[1].costUsd;
  const projectedNetProfitUsd = pairSize - totalCostUsd;
  const projectedNetReturn = totalCostUsd > 0 ? projectedNetProfitUsd / totalCostUsd : null;
  if (grossCost > settings.grossEntryThreshold + settings.executionPriceBuffer + 1e-9) {
    return `Coût brut REST ${grossCost.toFixed(4)} au-dessus de la fenêtre d'exécution`;
  }
  if (totalCostUsd > settings.maxPairNotionalUsd + 1e-9) {
    return `Coût REST ${totalCostUsd.toFixed(4)} USD au-dessus du budget de paire`;
  }
  const maxLegCostUsd = settings.maxPairNotionalUsd * settings.maxLegCapitalShare;
  if (quotes.some((quote) => quote.costUsd > maxLegCostUsd + 1e-9)) {
    return "Une jambe dépasse sa part maximale du capital après slippage";
  }
  if (
    projectedNetProfitUsd + 1e-9 < settings.minProjectedNetProfitUsd ||
    projectedNetProfitUsd + 1e-9 < settings.minWorstCaseProfitUsd
  ) {
    return `Profit REST ${projectedNetProfitUsd.toFixed(4)} USD sous le minimum configuré`;
  }
  if (projectedNetReturn === null || projectedNetReturn + 1e-9 < settings.minProjectedNetReturn) {
    return `Rendement REST ${projectedNetReturn?.toFixed(4) ?? "n/a"} sous le minimum configuré`;
  }
  return null;
}

function getSnapshotMinimumOrderSize(snapshot: OpportunitySnapshot, leg: OrderIntentLeg) {
  if (leg.venue === "polymarket") {
    return leg.outcome === "UP"
      ? snapshot.polymarket.outcomes.up.minOrderSize
      : snapshot.polymarket.outcomes.down.minOrderSize;
  }
  return leg.outcome === "YES" ? snapshot.kalshi.outcomes.yes.minOrderSize : snapshot.kalshi.outcomes.no.minOrderSize;
}

function getRequestedPairSize(legs: OrderIntent["legs"]) {
  return round4(Math.min(...legs.map((leg) => leg.requestedSize)));
}

function noFill(
  legs: [ShadowLegCapacity, ShadowLegCapacity],
  reasonCode: string,
  reason: string,
): ShadowPairExecutionDecision {
  return {
    status: "no_fill",
    reasonCode,
    reason,
    filledPairSize: 0,
    realizedGrossCost: null,
    realizedTotalCostUsd: null,
    projectedNetProfitUsd: null,
    legs,
  };
}

function deriveSlippageBps(requestedPrice: number | null, filledPrice: number | null) {
  if (requestedPrice === null || filledPrice === null || requestedPrice <= 0) {
    return null;
  }
  return round4(((filledPrice - requestedPrice) / requestedPrice) * 10_000);
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTradablePrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1;
}

function canonicalizePreparedShadowFillPrice(notionalUsd: number, executableSize: number) {
  // The proof keeps its canonical notional. Only its derived price is quantized so
  // binary division artifacts cannot cross the exact 1e-8 accounting boundary.
  const price = Math.round((notionalUsd / executableSize) * ACCOUNTING_LEDGER_SCALE) / ACCOUNTING_LEDGER_SCALE;
  if (!isTradablePrice(price)) {
    throw new Error(`Prepared shadow fill price ${price} is outside the tradable range`);
  }
  return price;
}

function numbersClose(left: number, right: number, tolerance = 1e-6) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function round5(value: number) {
  return Math.round(value * 100_000) / 100_000;
}
