import {
  applySlippage,
  getVenueMinimumOrderSize,
  quoteMultiLevelBuyLeg,
  type ExecutableBookLevel,
  type MultiLevelLegQuote,
} from "@/lib/fees";
import { deriveKalshiBuyPriceLevels, normalizeKalshiOrderPrice } from "@/lib/kalshi";
import type {
  OpportunitySnapshot,
  OrderIntent,
  OrderIntentLeg,
  ShadowExecutionAudit,
  StrategyConfig,
} from "@/lib/types";

export const SHADOW_EXECUTION_MODEL_VERSION = "rest-orderbook-v2";
export const SHADOW_MIN_COMPLETION_DELAY_MS = 15_000;
export const SHADOW_REENTRY_COOLDOWN_MS = 60_000;

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

export function buildScheduledShadowAudit(
  intent: Pick<OrderIntent, "createdAt" | "grossCost" | "legs">,
  restStartedAt = intent.createdAt,
): ShadowExecutionAudit {
  const requestedPairSize = getRequestedPairSize(intent.legs);
  return {
    modelVersion: SHADOW_EXECUTION_MODEL_VERSION,
    status: "scheduled",
    scheduledAt: intent.createdAt,
    completionNotBeforeAt: intent.createdAt + SHADOW_MIN_COMPLETION_DELAY_MS,
    restStartedAt,
    restCapturedAt: null,
    restFetchDurationMs: null,
    restErrors: [],
    evaluatedAt: null,
    latencyMs: null,
    nextEligibleAt: null,
    requestedPairSize,
    filledPairSize: 0,
    fillRatio: 0,
    signalGrossCost: intent.grossCost,
    realizedGrossCost: null,
    realizedTotalCostUsd: null,
    projectedNetProfitUsd: null,
    reasonCode: null,
    reason: null,
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
  intent: Pick<OrderIntent, "createdAt" | "grossCost" | "legs">,
  decision: ShadowPairExecutionDecision,
  evaluatedAt: number,
  rest: {
    startedAt: number;
    capturedAt: number;
    errors?: string[];
  },
): ShadowExecutionAudit {
  const requestedPairSize = getRequestedPairSize(intent.legs);
  return {
    modelVersion: SHADOW_EXECUTION_MODEL_VERSION,
    status: decision.status,
    scheduledAt: intent.createdAt,
    completionNotBeforeAt: intent.createdAt + SHADOW_MIN_COMPLETION_DELAY_MS,
    restStartedAt: rest.startedAt,
    restCapturedAt: rest.capturedAt,
    restFetchDurationMs: Math.max(0, rest.capturedAt - rest.startedAt),
    restErrors: rest.errors ?? [],
    evaluatedAt,
    latencyMs: Math.max(0, evaluatedAt - intent.createdAt),
    nextEligibleAt: evaluatedAt + SHADOW_REENTRY_COOLDOWN_MS,
    requestedPairSize,
    filledPairSize: decision.filledPairSize,
    fillRatio: requestedPairSize > 0 ? round4(decision.filledPairSize / requestedPairSize) : 0,
    signalGrossCost: intent.grossCost,
    realizedGrossCost: decision.realizedGrossCost,
    realizedTotalCostUsd: decision.realizedTotalCostUsd,
    projectedNetProfitUsd: decision.projectedNetProfitUsd,
    reasonCode: decision.reasonCode,
    reason: decision.reason,
    legs: decision.legs.map((capacity) => ({
      venue: capacity.leg.venue,
      outcome: capacity.leg.outcome,
      requestedSize: capacity.leg.requestedSize,
      executableSize: capacity.executableSize,
      limitPrice: capacity.limitPrice,
      vwapPrice: capacity.quote?.vwapPrice ?? null,
      feeUsd: capacity.quote?.feeUsd ?? 0,
      slippageBps: deriveSlippageBps(capacity.leg.requestedPrice, capacity.quote?.vwapPrice ?? null),
    })),
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
  const nextEligibleAt = lastIntent.shadowExecution?.nextEligibleAt ??
    completedAt + SHADOW_REENTRY_COOLDOWN_MS;
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
    return noFill(
      capacities,
      "orderbook_unavailable",
      "Carnet complet indisponible au moment de l'exécution shadow",
    );
  }

  if (capacities.some((capacity) => capacity.limitPrice === null)) {
    return noFill(capacities, "price_limit_unavailable", "Limite de prix shadow indisponible");
  }

  const commonExecutableSize = Math.floor(
    Math.min(requestedPairSize, capacities[0].executableSize, capacities[1].executableSize),
  );
  if (commonExecutableSize < minimumPairSize) {
    const movedBeyondLimit = capacities.some(
      (capacity) => capacity.levelsAvailable && capacity.executableSize === 0,
    );
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

    const executablePair: [MultiLevelLegQuote, MultiLevelLegQuote] = [
      polymarketQuote,
      kalshiQuote,
    ];
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

function deriveLegCapacity(
  leg: OrderIntentLeg,
  snapshot: OpportunitySnapshot,
  settings: ShadowSettings,
  requestedPairSize: number,
): ShadowLegCapacity {
  const levels = getBuyLevels(snapshot, leg);
  const limitPrice = deriveLimitPrice(leg, settings);
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
    const raw = leg.outcome === "UP"
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
    .filter((level) =>
      Number.isFinite(level.price) &&
      Number.isFinite(level.size) &&
      level.price > 0 &&
      level.price < 1 &&
      level.size > 0,
    );
}

function deriveLimitPrice(leg: OrderIntentLeg, settings: ShadowSettings) {
  if (leg.requestedPrice === null || leg.requestedPrice <= 0) {
    return null;
  }
  const rawLimit = Math.min(
    settings.maxLegPrice,
    applySlippage(leg.requestedPrice, settings.maxSlippageBps),
  );
  return leg.venue === "kalshi" ? normalizeKalshiOrderPrice(rawLimit, "BUY") : round4(rawLimit);
}

function getEconomicIssue(quotes: [MultiLevelLegQuote, MultiLevelLegQuote], settings: ShadowSettings) {
  const pairSize = Math.min(quotes[0].size, quotes[1].size);
  const grossCost = (quotes[0].vwapPrice ?? Number.POSITIVE_INFINITY) +
    (quotes[1].vwapPrice ?? Number.POSITIVE_INFINITY);
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
  return leg.outcome === "YES"
    ? snapshot.kalshi.outcomes.yes.minOrderSize
    : snapshot.kalshi.outcomes.no.minOrderSize;
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

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
