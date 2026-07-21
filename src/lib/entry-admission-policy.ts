import type {
  KalshiQuote,
  MarketSlot,
  OrderIntent,
  OrderIntentLeg,
  OrderSide,
  PairCombination,
  PolymarketQuote,
  Venue,
} from "@/lib/types";
import { isKalshiOutcomePriceValid, parseKalshiPriceGrid } from "@/lib/kalshi-price-grid";

export type EntryMode = "live" | "shadow";

export const SHADOW_REENTRY_COOLDOWN_MS = 60_000;

export type InitialEntryLeg = Pick<OrderIntentLeg, "venue" | "outcome" | "marketRef" | "tokenId" | "side">;

export type InitialEntryIntent = Pick<
  OrderIntent,
  "asset" | "slotKey" | "slotStartTs" | "slotEndTs" | "combination"
> & {
  legs: readonly InitialEntryLeg[];
};

export type InitialEntryPolymarketQuote = Pick<
  PolymarketQuote,
  | "ref"
  | "conditionId"
  | "status"
  | "slotAligned"
  | "availabilityReason"
  | "feedHealth"
  | "lastMessageAt"
  | "stalenessMs"
  | "source"
  | "outcomes"
  | "resolution"
  | "tokenIds"
  | "orderbookLevels"
  | "feeRateBps"
  | "feeRate"
  | "feeExponent"
  | "feeMetadataPresent"
  | "feesEnabled"
>;

export type InitialEntryKalshiQuote = Pick<
  KalshiQuote,
  | "ref"
  | "status"
  | "slotAligned"
  | "availabilityReason"
  | "feedHealth"
  | "lastMessageAt"
  | "stalenessMs"
  | "source"
  | "outcomes"
  | "resolution"
  | "orderbookLevels"
  | "priceRanges"
>;

export type InitialEntryAdmissionInput = {
  now: number;
  slot: Pick<MarketSlot, "asset" | "key" | "startTs" | "endTs" | "polymarketSlug">;
  intent: InitialEntryIntent;
  polymarket: InitialEntryPolymarketQuote;
  kalshi: InitialEntryKalshiQuote;
  entryCutoffSeconds: number;
  submissionBudgetMs: number;
  maxFeedAgeMs: number;
  maxBookAgeMs: Readonly<Record<Venue, number>>;
  maxPairBookSkewMs: number;
};

export type InitialEntryAdmissionFailureCode =
  | "invalid_input"
  | "intent_slot_mismatch"
  | "slot_not_started"
  | "slot_ended"
  | "entry_window_closed"
  | "invalid_legs"
  | "combination_mismatch"
  | "market_unaligned"
  | "market_unavailable"
  | "market_not_tradable"
  | "market_resolved"
  | "polymarket_identity_mismatch"
  | "kalshi_identity_mismatch"
  | "invalid_market_tick"
  | "fee_schedule_unavailable"
  | "feed_identity_mismatch"
  | "feed_not_ready"
  | "feed_not_ws"
  | "feed_stale"
  | "book_not_ws"
  | "book_stale"
  | "book_unavailable"
  | "pair_book_skew"
  | "evidence_window_closed";

export type InitialEntryAdmissionDecision =
  | {
      allowed: true;
      cutoffAt: number;
      latestSubmissionStartAt: number;
      marketEvidenceValidUntil: number;
      polymarketBookUpdatedAt: number;
      kalshiBookUpdatedAt: number;
      pairBookSkewMs: number;
    }
  | {
      allowed: false;
      code: InitialEntryAdmissionFailureCode;
      reason: string;
    };

type ExpectedCombination = {
  polymarket: "UP" | "DOWN";
  kalshi: "YES" | "NO";
};

const EXPECTED_COMBINATIONS: Record<PairCombination, ExpectedCombination> = {
  POLY_UP_KALSHI_NO: {
    polymarket: "UP",
    kalshi: "NO",
  },
  POLY_DOWN_KALSHI_YES: {
    polymarket: "DOWN",
    kalshi: "YES",
  },
};

export function validateInitialEntryAdmission(input: InitialEntryAdmissionInput): InitialEntryAdmissionDecision {
  const numericIssue = validateAdmissionNumbers(input);
  if (numericIssue) {
    return numericIssue;
  }

  const { intent, slot } = input;
  if (
    !isNonEmptyString(slot.key) ||
    !isNonEmptyString(slot.polymarketSlug) ||
    intent.asset !== slot.asset ||
    intent.slotKey !== slot.key ||
    intent.slotStartTs !== slot.startTs ||
    intent.slotEndTs !== slot.endTs
  ) {
    return reject("intent_slot_mismatch", "Intent and canonical slot identity do not match");
  }

  if (input.now < slot.startTs) {
    return reject("slot_not_started", "The canonical slot has not started");
  }
  if (input.now >= slot.endTs) {
    return reject("slot_ended", "The canonical slot has ended");
  }

  const cutoffAt = slot.endTs - input.entryCutoffSeconds * 1_000;
  const windowLatestSubmissionStartAt = cutoffAt - input.submissionBudgetMs;
  if (!Number.isSafeInteger(cutoffAt) || !Number.isSafeInteger(windowLatestSubmissionStartAt)) {
    return reject("invalid_input", "The entry deadline cannot be represented safely");
  }
  if (input.now >= windowLatestSubmissionStartAt) {
    return reject("entry_window_closed", "The remaining entry window does not cover the submission budget");
  }

  if (intent.legs.length !== 2) {
    return reject("invalid_legs", "An initial pair must contain exactly two legs");
  }
  const polymarketLegs = intent.legs.filter((leg) => leg.venue === "polymarket");
  const kalshiLegs = intent.legs.filter((leg) => leg.venue === "kalshi");
  if (polymarketLegs.length !== 1 || kalshiLegs.length !== 1 || intent.legs.some((leg) => leg.side !== "BUY")) {
    return reject("invalid_legs", "An initial pair requires one BUY leg on each venue");
  }

  const expected = EXPECTED_COMBINATIONS[intent.combination];
  if (!expected) {
    return reject("combination_mismatch", "Unknown pair combination");
  }
  const polymarketLeg = polymarketLegs[0];
  const kalshiLeg = kalshiLegs[0];
  if (polymarketLeg.outcome !== expected.polymarket || kalshiLeg.outcome !== expected.kalshi) {
    return reject("combination_mismatch", "Leg outcomes do not match the pair combination");
  }

  if (!input.polymarket.slotAligned || !input.kalshi.slotAligned) {
    return reject("market_unaligned", "Both venue markets must remain aligned with the canonical slot");
  }
  if (input.polymarket.availabilityReason !== null || input.kalshi.availabilityReason !== null) {
    return reject("market_unavailable", "Both venue markets must remain available");
  }
  if (input.polymarket.status !== "open" || !isTradableKalshiStatus(input.kalshi.status)) {
    return reject("market_not_tradable", "Both venue markets must remain open for trading");
  }
  if (input.polymarket.resolution !== null || input.kalshi.resolution !== null) {
    return reject("market_resolved", "Resolved markets cannot admit a new entry");
  }

  const selectedPolymarketOutcome =
    expected.polymarket === "UP" ? input.polymarket.outcomes.up : input.polymarket.outcomes.down;
  const selectedKalshiOutcome = expected.kalshi === "YES" ? input.kalshi.outcomes.yes : input.kalshi.outcomes.no;
  const selectedTokenId = expected.polymarket === "UP" ? input.polymarket.tokenIds.up : input.polymarket.tokenIds.down;
  const polymarketTickSize = selectedPolymarketOutcome.tickSize;
  const kalshiTickSize = selectedKalshiOutcome.tickSize;

  if (
    input.polymarket.ref.asset !== slot.asset ||
    input.polymarket.ref.venue !== "polymarket" ||
    input.polymarket.ref.slotKey !== slot.key ||
    input.polymarket.ref.slug !== slot.polymarketSlug ||
    !refMatchesSlotTimes(input.polymarket.ref, slot) ||
    !isNonEmptyString(input.polymarket.conditionId) ||
    input.polymarket.ref.conditionId !== input.polymarket.conditionId ||
    polymarketLeg.marketRef !== input.polymarket.conditionId ||
    !isNonEmptyString(selectedTokenId) ||
    polymarketLeg.tokenId !== selectedTokenId ||
    !isNonEmptyString(input.polymarket.tokenIds.up) ||
    !isNonEmptyString(input.polymarket.tokenIds.down) ||
    input.polymarket.tokenIds.up === input.polymarket.tokenIds.down ||
    selectedPolymarketOutcome.outcome !== expected.polymarket
  ) {
    return reject(
      "polymarket_identity_mismatch",
      "Polymarket condition, token, outcome, asset, or slot identity changed",
    );
  }

  if (
    input.kalshi.ref.asset !== slot.asset ||
    input.kalshi.ref.venue !== "kalshi" ||
    input.kalshi.ref.slotKey !== slot.key ||
    !refMatchesSlotTimes(input.kalshi.ref, slot) ||
    !isNonEmptyString(input.kalshi.ref.id) ||
    !isNonEmptyString(input.kalshi.ref.ticker) ||
    !isNonEmptyString(input.kalshi.ref.eventTicker) ||
    input.kalshi.ref.id !== input.kalshi.ref.ticker ||
    kalshiLeg.marketRef !== input.kalshi.ref.id ||
    selectedKalshiOutcome.outcome !== expected.kalshi
  ) {
    return reject("kalshi_identity_mismatch", "Kalshi ticker, outcome, asset, or slot identity changed");
  }

  if (
    !isValidBinaryMarketTick(polymarketTickSize) ||
    !isValidBinaryMarketTick(kalshiTickSize) ||
    selectedPolymarketOutcome.execution.tickSize !== polymarketTickSize ||
    selectedKalshiOutcome.execution.tickSize !== kalshiTickSize
  ) {
    return reject("invalid_market_tick", "Selected venue ticks must be finite and strictly between zero and one");
  }
  if (!hasValidPolymarketFeeSchedule(input.polymarket, selectedPolymarketOutcome)) {
    return reject(
      "fee_schedule_unavailable",
      "Polymarket fee metadata must explicitly and coherently prove whether fees are enabled",
    );
  }
  if (!hasValidKalshiPriceGrid(input.kalshi.priceRanges, selectedKalshiOutcome.buyPrice, expected.kalshi)) {
    return reject(
      "invalid_market_tick",
      "Kalshi price_ranges must be valid, complete, and contain the selected executable price",
    );
  }

  const polymarketFeedIssue = validateFeed(input, "polymarket");
  if (polymarketFeedIssue) {
    return polymarketFeedIssue;
  }
  const kalshiFeedIssue = validateFeed(input, "kalshi");
  if (kalshiFeedIssue) {
    return kalshiFeedIssue;
  }

  const polymarketBookUpdatedAt = selectedPolymarketOutcome.chart.lastUpdatedAt;
  const kalshiBookUpdatedAt = selectedKalshiOutcome.chart.lastUpdatedAt;
  const polymarketBookIssue = validateBookTimestamp(
    "polymarket",
    selectedPolymarketOutcome.chart.source,
    polymarketBookUpdatedAt,
    input.now,
    input.maxBookAgeMs.polymarket,
  );
  if (polymarketBookIssue) {
    return polymarketBookIssue;
  }
  const kalshiBookIssue = validateBookTimestamp(
    "kalshi",
    selectedKalshiOutcome.chart.source,
    kalshiBookUpdatedAt,
    input.now,
    input.maxBookAgeMs.kalshi,
  );
  if (kalshiBookIssue) {
    return kalshiBookIssue;
  }
  if (!isSafeTimestamp(polymarketBookUpdatedAt) || !isSafeTimestamp(kalshiBookUpdatedAt)) {
    return reject("book_stale", "Selected order book timestamps are missing or invalid");
  }

  if (!hasRequiredPolymarketBook(input.polymarket, expected.polymarket)) {
    return reject("book_unavailable", `Polymarket ${expected.polymarket} ask book is unavailable`);
  }
  if (!hasRequiredKalshiBook(input.kalshi, expected.kalshi)) {
    return reject("book_unavailable", `Kalshi ${expected.kalshi} synthetic ask book is unavailable`);
  }

  const pairBookSkewMs = Math.abs(polymarketBookUpdatedAt - kalshiBookUpdatedAt);
  if (pairBookSkewMs > input.maxPairBookSkewMs) {
    return reject("pair_book_skew", "Venue book observations exceed the allowed pair skew");
  }

  const marketEvidenceValidUntil = deriveMarketEvidenceValidUntil(input, polymarketBookUpdatedAt, kalshiBookUpdatedAt);
  if (marketEvidenceValidUntil === null) {
    return reject("invalid_input", "The market evidence deadline cannot be represented safely");
  }
  if (input.now >= marketEvidenceValidUntil) {
    return reject("evidence_window_closed", "Market evidence expires before a live submission can be claimed");
  }
  const latestSubmissionStartAt = Math.min(windowLatestSubmissionStartAt, marketEvidenceValidUntil);

  return {
    allowed: true,
    cutoffAt,
    latestSubmissionStartAt,
    marketEvidenceValidUntil,
    polymarketBookUpdatedAt,
    kalshiBookUpdatedAt,
    pairBookSkewMs,
  };
}

function hasValidPolymarketFeeSchedule(quote: InitialEntryPolymarketQuote, outcome: PolymarketQuote["outcomes"]["up"]) {
  if (
    quote.feeMetadataPresent !== true ||
    typeof quote.feesEnabled !== "boolean" ||
    !isFiniteNonNegative(quote.feeRateBps) ||
    !isFiniteNonNegative(outcome.feeRateBps) ||
    outcome.execution.feeRateBps !== outcome.feeRateBps
  ) {
    return false;
  }

  if (quote.feesEnabled) {
    return (
      typeof quote.feeRate === "number" &&
      Number.isFinite(quote.feeRate) &&
      quote.feeRate > 0 &&
      typeof quote.feeExponent === "number" &&
      Number.isFinite(quote.feeExponent) &&
      quote.feeExponent >= 0
    );
  }

  return (
    quote.feeRate === 0 &&
    quote.feeRateBps === 0 &&
    outcome.feeRateBps === 0 &&
    (quote.feeExponent === undefined ||
      quote.feeExponent === null ||
      (Number.isFinite(quote.feeExponent) && quote.feeExponent >= 0))
  );
}

function deriveMarketEvidenceValidUntil(
  input: InitialEntryAdmissionInput,
  polymarketBookUpdatedAt: number,
  kalshiBookUpdatedAt: number,
) {
  const observations: Array<readonly [number | null, number]> = [
    [input.polymarket.lastMessageAt, input.maxFeedAgeMs],
    [input.polymarket.feedHealth.lastMessageAt, input.maxFeedAgeMs],
    [input.kalshi.lastMessageAt, input.maxFeedAgeMs],
    [input.kalshi.feedHealth.lastMessageAt, input.maxFeedAgeMs],
    [polymarketBookUpdatedAt, input.maxBookAgeMs.polymarket],
    [kalshiBookUpdatedAt, input.maxBookAgeMs.kalshi],
  ];
  let validUntil = Number.MAX_SAFE_INTEGER;
  for (const [observedAt, maxAgeMs] of observations) {
    if (!isSafeTimestamp(observedAt)) {
      return null;
    }
    const deadline = observedAt + maxAgeMs;
    if (!Number.isSafeInteger(deadline)) {
      return null;
    }
    validUntil = Math.min(validUntil, deadline);
  }
  return validUntil;
}

function hasValidKalshiPriceGrid(
  priceRanges: KalshiQuote["priceRanges"],
  selectedPrice: number | null,
  outcome: "YES" | "NO",
) {
  if (!priceRanges || selectedPrice === null) {
    return false;
  }
  try {
    parseKalshiPriceGrid(priceRanges);
    return isKalshiOutcomePriceValid({
      price: selectedPrice,
      outcome,
      priceRanges,
    });
  } catch {
    return false;
  }
}

export type PriceTickNormalizationFailureCode =
  "invalid_side" | "invalid_price" | "invalid_tick" | "normalized_price_out_of_bounds";

export type PriceTickNormalizationResult =
  | {
      ok: true;
      price: number;
      tickIndex: number;
      adjusted: boolean;
    }
  | {
      ok: false;
      code: PriceTickNormalizationFailureCode;
      reason: string;
    };

export function normalizePriceToAuthoritativeTick(input: {
  price: number;
  tickSize: number;
  side: OrderSide;
}): PriceTickNormalizationResult {
  if (input.side !== "BUY" && input.side !== "SELL") {
    return {
      ok: false,
      code: "invalid_side",
      reason: "Order side must be BUY or SELL",
    };
  }
  if (!Number.isFinite(input.price) || input.price <= 0 || input.price >= 1) {
    return {
      ok: false,
      code: "invalid_price",
      reason: "Binary-market price must be finite and strictly between zero and one",
    };
  }
  if (!Number.isFinite(input.tickSize) || input.tickSize <= 0 || input.tickSize >= 1) {
    return {
      ok: false,
      code: "invalid_tick",
      reason: "Authoritative tick must be finite and strictly between zero and one",
    };
  }

  const rawTickIndex = input.price / input.tickSize;
  if (!Number.isFinite(rawTickIndex)) {
    return {
      ok: false,
      code: "invalid_tick",
      reason: "Price-to-tick ratio is not finite",
    };
  }

  const nearestTickIndex = Math.round(rawTickIndex);
  const tickIndexTolerance = Number.EPSILON * 32 * Math.max(1, Math.abs(rawTickIndex));
  const alignedTickIndex = Math.abs(rawTickIndex - nearestTickIndex) <= tickIndexTolerance ? nearestTickIndex : null;
  const tickIndex = alignedTickIndex ?? (input.side === "BUY" ? Math.ceil(rawTickIndex) : Math.floor(rawTickIndex));
  if (!Number.isSafeInteger(tickIndex) || tickIndex <= 0) {
    return {
      ok: false,
      code: "normalized_price_out_of_bounds",
      reason: "Normalized price does not map to a safe positive tick index",
    };
  }

  const precision = Math.min(15, countDecimalPlaces(input.tickSize));
  const normalizedPrice = Number((tickIndex * input.tickSize).toFixed(precision));
  if (!Number.isFinite(normalizedPrice) || normalizedPrice <= 0 || normalizedPrice >= 1) {
    return {
      ok: false,
      code: "normalized_price_out_of_bounds",
      reason: "Normalized binary-market price must remain strictly between zero and one",
    };
  }

  return {
    ok: true,
    price: normalizedPrice,
    tickIndex,
    adjusted: Math.abs(normalizedPrice - input.price) > priceTolerance(input.price, normalizedPrice),
  };
}

export type ReentryPolicyInput = {
  mode: EntryMode;
  candidateGrossCost: number;
  reentryImprovement: number;
  previous: {
    mode: EntryMode;
    grossCost: number;
  } | null;
};

export type ReentryPolicyFailureCode =
  | "invalid_mode"
  | "invalid_candidate_cost"
  | "invalid_improvement"
  | "invalid_previous_mode"
  | "invalid_previous_cost"
  | "insufficient_improvement";

export type ReentryPolicyDecision =
  | {
      allowed: true;
      reason: "no_same_mode_baseline" | "sufficient_improvement";
      maximumAllowedCost: number | null;
      improvement: number | null;
    }
  | {
      allowed: false;
      code: ReentryPolicyFailureCode;
      reason: string;
      maximumAllowedCost: number | null;
      improvement: number | null;
    };

export function evaluateReentryPolicy(input: ReentryPolicyInput): ReentryPolicyDecision {
  if (!isEntryMode(input.mode)) {
    return rejectReentry("invalid_mode", "Entry mode must be live or shadow");
  }
  if (!isFiniteNonNegative(input.candidateGrossCost)) {
    return rejectReentry("invalid_candidate_cost", "Candidate gross cost must be finite and non-negative");
  }
  if (!isFiniteNonNegative(input.reentryImprovement)) {
    return rejectReentry("invalid_improvement", "Required reentry improvement must be finite and non-negative");
  }
  if (input.previous === null) {
    return {
      allowed: true,
      reason: "no_same_mode_baseline",
      maximumAllowedCost: null,
      improvement: null,
    };
  }
  if (!isEntryMode(input.previous.mode)) {
    return rejectReentry("invalid_previous_mode", "Previous entry mode must be live or shadow");
  }
  if (input.previous.mode !== input.mode) {
    return {
      allowed: true,
      reason: "no_same_mode_baseline",
      maximumAllowedCost: null,
      improvement: null,
    };
  }
  if (!isFiniteNonNegative(input.previous.grossCost)) {
    return rejectReentry("invalid_previous_cost", "Previous gross cost must be finite and non-negative");
  }

  const maximumAllowedCost = input.previous.grossCost - input.reentryImprovement;
  const improvement = input.previous.grossCost - input.candidateGrossCost;
  const tolerance = priceTolerance(input.candidateGrossCost, maximumAllowedCost);
  if (input.candidateGrossCost <= maximumAllowedCost + tolerance) {
    return {
      allowed: true,
      reason: "sufficient_improvement",
      maximumAllowedCost,
      improvement,
    };
  }

  return {
    allowed: false,
    code: "insufficient_improvement",
    reason: "Candidate gross cost does not improve enough over the same-mode baseline",
    maximumAllowedCost,
    improvement,
  };
}

function validateAdmissionNumbers(
  input: InitialEntryAdmissionInput,
): Extract<InitialEntryAdmissionDecision, { allowed: false }> | null {
  if (
    !isSafeTimestamp(input.now) ||
    !isSafeTimestamp(input.slot.startTs) ||
    !isSafeTimestamp(input.slot.endTs) ||
    input.slot.endTs <= input.slot.startTs ||
    !isFiniteNonNegative(input.entryCutoffSeconds) ||
    !isFiniteNonNegative(input.submissionBudgetMs) ||
    !isFiniteNonNegative(input.maxFeedAgeMs) ||
    !isFiniteNonNegative(input.maxBookAgeMs.polymarket) ||
    !isFiniteNonNegative(input.maxBookAgeMs.kalshi) ||
    !isFiniteNonNegative(input.maxPairBookSkewMs)
  ) {
    return reject("invalid_input", "Admission timing and freshness limits must be finite and non-negative");
  }
  return null;
}

function validateFeed(
  input: InitialEntryAdmissionInput,
  venue: Venue,
): Extract<InitialEntryAdmissionDecision, { allowed: false }> | null {
  const quote = venue === "polymarket" ? input.polymarket : input.kalshi;
  if (quote.feedHealth.asset !== input.slot.asset || quote.feedHealth.venue !== venue) {
    return reject("feed_identity_mismatch", `${venue} feed identity does not match the canonical market`);
  }
  if (quote.feedHealth.feedStatus !== "ready") {
    return reject("feed_not_ready", `${venue} feed is not ready`);
  }
  if (quote.source !== "ws" || quote.feedHealth.source !== "ws") {
    return reject("feed_not_ws", `${venue} quote and feed must both be WebSocket-backed`);
  }
  if (
    !isFiniteNonNegative(quote.stalenessMs) ||
    quote.stalenessMs > input.maxFeedAgeMs ||
    !isFiniteNonNegative(quote.feedHealth.stalenessMs) ||
    quote.feedHealth.stalenessMs > input.maxFeedAgeMs ||
    !isFreshObservation(quote.lastMessageAt, input.now, input.maxFeedAgeMs) ||
    !isFreshObservation(quote.feedHealth.lastMessageAt, input.now, input.maxFeedAgeMs)
  ) {
    return reject("feed_stale", `${venue} feed timestamps are missing, future-dated, or stale`);
  }
  return null;
}

function validateBookTimestamp(
  venue: Venue,
  source: string,
  observedAt: number | null,
  now: number,
  maxAgeMs: number,
): Extract<InitialEntryAdmissionDecision, { allowed: false }> | null {
  if (source !== "ws") {
    return reject("book_not_ws", `${venue} selected order book is not WebSocket-backed`);
  }
  if (!isFreshObservation(observedAt, now, maxAgeMs)) {
    return reject("book_stale", `${venue} selected order book timestamp is missing, future-dated, or stale`);
  }
  return null;
}

function hasRequiredPolymarketBook(quote: InitialEntryPolymarketQuote, outcome: ExpectedCombination["polymarket"]) {
  const levels = outcome === "UP" ? quote.orderbookLevels?.upAsks : quote.orderbookLevels?.downAsks;
  return hasExecutableLevel(levels);
}

function hasRequiredKalshiBook(quote: InitialEntryKalshiQuote, outcome: ExpectedCombination["kalshi"]) {
  const oppositeBidLevels = outcome === "YES" ? quote.orderbookLevels?.noBids : quote.orderbookLevels?.yesBids;
  return hasExecutableLevel(oppositeBidLevels);
}

function hasExecutableLevel(levels: Array<[number, number]> | null | undefined) {
  return Boolean(
    levels?.some(
      ([price, size]) => Number.isFinite(price) && price > 0 && price < 1 && Number.isFinite(size) && size > 0,
    ),
  );
}

function isFreshObservation(observedAt: number | null, now: number, maxAgeMs: number) {
  return isSafeTimestamp(observedAt) && observedAt <= now && now - observedAt <= maxAgeMs;
}

function isSafeTimestamp(value: number | null): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNonNegative(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTradableKalshiStatus(status: string) {
  return status === "active" || status === "open";
}

function refMatchesSlotTimes(
  ref: PolymarketQuote["ref"] | KalshiQuote["ref"],
  slot: Pick<MarketSlot, "startTs" | "endTs">,
) {
  return Date.parse(ref.startTime) === slot.startTs && Date.parse(ref.endTime) === slot.endTs;
}

function isValidBinaryMarketTick(value: number | null) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1;
}

function isEntryMode(mode: string): mode is EntryMode {
  return mode === "live" || mode === "shadow";
}

function reject(
  code: InitialEntryAdmissionFailureCode,
  reason: string,
): Extract<InitialEntryAdmissionDecision, { allowed: false }> {
  return {
    allowed: false,
    code,
    reason,
  };
}

function rejectReentry(code: ReentryPolicyFailureCode, reason: string): ReentryPolicyDecision {
  return {
    allowed: false,
    code,
    reason,
    maximumAllowedCost: null,
    improvement: null,
  };
}

function countDecimalPlaces(value: number) {
  const [coefficient, exponentText] = value.toString().toLowerCase().split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const fractionLength = coefficient.split(".")[1]?.length ?? 0;
  return Math.max(0, fractionLength - exponent);
}

function priceTolerance(left: number, right: number) {
  return Number.EPSILON * 32 * Math.max(1, Math.abs(left), Math.abs(right));
}
