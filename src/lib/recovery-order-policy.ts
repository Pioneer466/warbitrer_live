import { normalizePriceToAuthoritativeTick } from "@/lib/entry-admission-policy";
import { calculateKalshiFee, calculatePolymarketLevelFee } from "@/lib/fees";
import {
  getKalshiOutcomeTickSize,
  isKalshiOutcomePriceValid,
  moveKalshiOutcomePriceByTicks,
  normalizeKalshiOutcomePrice,
  parseKalshiPriceGrid,
} from "@/lib/kalshi-price-grid";
import type {
  KalshiPriceRange,
  KalshiQuote,
  LiveMarketState,
  MarketSlot,
  OrderIntent,
  OrderIntentLeg,
  OrderSide,
  PolymarketQuote,
  Venue,
} from "@/lib/types";

export type RecoveryIntentIdentity = Pick<OrderIntent, "id" | "asset" | "slotKey" | "slotStartTs" | "slotEndTs">;

export type RecoveryLegIdentity = Pick<
  OrderIntentLeg,
  "intentId" | "venue" | "outcome" | "marketRef" | "tokenId" | "side"
>;

export type RecoveryMarketStateValidationInput = {
  now: number;
  slot: Pick<MarketSlot, "asset" | "key" | "startTs" | "endTs">;
  intent: RecoveryIntentIdentity;
  leg: RecoveryLegIdentity;
  orderSide: OrderSide;
  marketState: LiveMarketState;
  maxFeedAgeMs: number;
  maxBookAgeMs: number;
};

export type RecoveryMarketStateFailureCode =
  | "invalid_input"
  | "intent_slot_mismatch"
  | "leg_intent_mismatch"
  | "market_rollover"
  | "venue_mismatch"
  | "market_unavailable"
  | "market_not_tradable"
  | "market_resolved"
  | "market_identity_mismatch"
  | "outcome_mismatch"
  | "token_mismatch"
  | "feed_identity_mismatch"
  | "feed_not_ready"
  | "feed_not_ws"
  | "feed_stale"
  | "book_not_ws"
  | "book_stale"
  | "book_unavailable"
  | "invalid_market_tick"
  | "evidence_window_closed";

type ValidatedRecoveryMarketBase = {
  allowed: true;
  side: OrderSide;
  intentId: string;
  slotKey: string;
  marketRef: string;
  referencePrice: number;
  validUntil: number;
  quoteObservedAt: number;
  feedObservedAt: number;
  bookObservedAt: number;
  stateSyncedAt: number;
};

export type ValidatedPolymarketRecoveryState = ValidatedRecoveryMarketBase & {
  venue: "polymarket";
  outcome: "UP" | "DOWN";
  tokenId: string;
  tickSize: number;
};

export type ValidatedKalshiRecoveryState = ValidatedRecoveryMarketBase & {
  venue: "kalshi";
  outcome: "YES" | "NO";
  tokenId: null;
  priceRanges: readonly KalshiPriceRange[];
};

export type RecoveryMarketStateDecision =
  | ValidatedPolymarketRecoveryState
  | ValidatedKalshiRecoveryState
  | {
      allowed: false;
      code: RecoveryMarketStateFailureCode;
      reason: string;
    };

type MarketEvidence = {
  validUntil: number;
  quoteObservedAt: number;
  feedObservedAt: number;
  bookObservedAt: number;
  stateSyncedAt: number;
};

export function validateRecoveryMarketState(input: RecoveryMarketStateValidationInput): RecoveryMarketStateDecision {
  if (
    !isSafeTimestamp(input.now) ||
    !isSafeTimestamp(input.slot.startTs) ||
    !isSafeTimestamp(input.slot.endTs) ||
    input.slot.endTs <= input.slot.startTs ||
    !isPositiveSafeInteger(input.maxFeedAgeMs) ||
    !isPositiveSafeInteger(input.maxBookAgeMs) ||
    !isOrderSide(input.orderSide) ||
    !isNonEmptyString(input.intent.id) ||
    !isNonEmptyString(input.slot.key)
  ) {
    return rejectMarketState("invalid_input", "Recovery identity and freshness inputs must be valid");
  }

  if (
    input.intent.asset !== input.slot.asset ||
    input.intent.slotKey !== input.slot.key ||
    input.intent.slotStartTs !== input.slot.startTs ||
    input.intent.slotEndTs !== input.slot.endTs
  ) {
    return rejectMarketState("intent_slot_mismatch", "Intent and canonical slot identity do not match");
  }

  if (input.leg.intentId !== input.intent.id || input.leg.side !== "BUY") {
    return rejectMarketState("leg_intent_mismatch", "Recovery leg is not the original BUY leg of this intent");
  }

  const state = input.marketState;
  if (
    state.slotKey !== input.slot.key ||
    state.quote.ref.slotKey !== input.slot.key ||
    !refMatchesSlotTimes(state.quote, input.slot)
  ) {
    return rejectMarketState("market_rollover", "Market state belongs to a different slot");
  }

  if (state.venue !== input.leg.venue || state.quote.ref.venue !== state.venue) {
    return rejectMarketState("venue_mismatch", "Recovery leg, state, and quote venues do not match");
  }

  if (state.venue === "polymarket") {
    if (!isPolymarketQuote(state.quote)) {
      return rejectMarketState("venue_mismatch", "Polymarket state does not contain a Polymarket quote");
    }
    return validatePolymarketRecoveryState(input, state, state.quote);
  }

  if (!isKalshiQuote(state.quote)) {
    return rejectMarketState("venue_mismatch", "Kalshi state does not contain a Kalshi quote");
  }
  return validateKalshiRecoveryState(input, state, state.quote);
}

function validatePolymarketRecoveryState(
  input: RecoveryMarketStateValidationInput,
  state: LiveMarketState,
  quote: PolymarketQuote,
): RecoveryMarketStateDecision {
  if (!quote.slotAligned || quote.availabilityReason !== null) {
    return rejectMarketState("market_unavailable", "Polymarket is unavailable or no longer slot-aligned");
  }
  if (quote.status !== "open") {
    return rejectMarketState("market_not_tradable", "Polymarket market is not open");
  }
  if (quote.resolution !== null) {
    return rejectMarketState("market_resolved", "Resolved Polymarket market cannot accept recovery orders");
  }

  const marketRef = quote.conditionId;
  if (
    quote.ref.asset !== input.slot.asset ||
    !isNonEmptyString(quote.ref.id) ||
    !isNonEmptyString(marketRef) ||
    quote.ref.conditionId !== marketRef ||
    state.marketRef !== marketRef ||
    input.leg.marketRef !== marketRef
  ) {
    return rejectMarketState("market_identity_mismatch", "Polymarket condition or asset identity changed");
  }

  if (input.leg.outcome !== "UP" && input.leg.outcome !== "DOWN") {
    return rejectMarketState("outcome_mismatch", "Polymarket recovery outcome must be UP or DOWN");
  }
  const outcome = input.leg.outcome;
  const selected = outcome === "UP" ? quote.outcomes.up : quote.outcomes.down;
  if (selected.outcome !== outcome) {
    return rejectMarketState("outcome_mismatch", "Polymarket outcome mapping changed");
  }

  const tokenId = outcome === "UP" ? quote.tokenIds.up : quote.tokenIds.down;
  if (
    !isNonEmptyString(tokenId) ||
    !isNonEmptyString(input.leg.tokenId) ||
    input.leg.tokenId !== tokenId ||
    !isNonEmptyString(quote.tokenIds.up) ||
    !isNonEmptyString(quote.tokenIds.down) ||
    quote.tokenIds.up === quote.tokenIds.down
  ) {
    return rejectMarketState("token_mismatch", "Polymarket recovery token no longer matches the intent leg");
  }

  const referencePrice = input.orderSide === "BUY" ? selected.buyPrice : selected.sellPrice;
  const executionPrice = input.orderSide === "BUY" ? selected.execution.buyPrice : selected.execution.sellPrice;
  const tickSize = selected.tickSize;
  if (
    referencePrice === null ||
    executionPrice !== referencePrice ||
    !isBinaryPrice(tickSize) ||
    selected.execution.tickSize !== tickSize
  ) {
    return rejectMarketState("invalid_market_tick", "Polymarket executable price or tick is unavailable");
  }
  const normalized = normalizePriceToAuthoritativeTick({
    price: referencePrice,
    tickSize,
    side: input.orderSide,
  });
  if (!normalized.ok || normalized.adjusted) {
    return rejectMarketState("invalid_market_tick", "Polymarket executable price is off its authoritative tick");
  }

  const levels = selectPolymarketLevels(quote, outcome, input.orderSide);
  if (!hasExecutableLevel(levels)) {
    return rejectMarketState("book_unavailable", "Selected Polymarket recovery book side is unavailable");
  }

  const evidence = validateMarketEvidence(input, state, quote, selected.chart.source, selected.chart.lastUpdatedAt);
  if (!evidence.ok) {
    return evidence.failure;
  }

  return {
    allowed: true,
    venue: "polymarket",
    side: input.orderSide,
    intentId: input.intent.id,
    slotKey: input.slot.key,
    marketRef,
    outcome,
    tokenId,
    referencePrice,
    tickSize,
    ...evidence.value,
  };
}

function validateKalshiRecoveryState(
  input: RecoveryMarketStateValidationInput,
  state: LiveMarketState,
  quote: KalshiQuote,
): RecoveryMarketStateDecision {
  if (!quote.slotAligned || quote.availabilityReason !== null) {
    return rejectMarketState("market_unavailable", "Kalshi is unavailable or no longer slot-aligned");
  }
  if (quote.status !== "active" && quote.status !== "open") {
    return rejectMarketState("market_not_tradable", "Kalshi market is not open");
  }
  if (quote.resolution !== null) {
    return rejectMarketState("market_resolved", "Resolved Kalshi market cannot accept recovery orders");
  }

  const marketRef = quote.ref.id;
  if (
    quote.ref.asset !== input.slot.asset ||
    !isNonEmptyString(marketRef) ||
    !isNonEmptyString(quote.ref.ticker) ||
    quote.ref.ticker !== marketRef ||
    state.marketRef !== marketRef ||
    input.leg.marketRef !== marketRef
  ) {
    return rejectMarketState("market_identity_mismatch", "Kalshi ticker or asset identity changed");
  }

  if (input.leg.outcome !== "YES" && input.leg.outcome !== "NO") {
    return rejectMarketState("outcome_mismatch", "Kalshi recovery outcome must be YES or NO");
  }
  const outcome = input.leg.outcome;
  const selected = outcome === "YES" ? quote.outcomes.yes : quote.outcomes.no;
  if (selected.outcome !== outcome) {
    return rejectMarketState("outcome_mismatch", "Kalshi outcome mapping changed");
  }
  if (input.leg.tokenId !== undefined && input.leg.tokenId !== "") {
    return rejectMarketState("token_mismatch", "Kalshi recovery legs must not carry a Polymarket token id");
  }

  const referencePrice = input.orderSide === "BUY" ? selected.buyPrice : selected.sellPrice;
  const executionPrice = input.orderSide === "BUY" ? selected.execution.buyPrice : selected.execution.sellPrice;
  if (quote.priceRanges === null || referencePrice === null || executionPrice !== referencePrice) {
    return rejectMarketState("invalid_market_tick", "Kalshi executable price or price_ranges is unavailable");
  }

  try {
    parseKalshiPriceGrid(quote.priceRanges);
    if (
      !isKalshiOutcomePriceValid({ price: referencePrice, outcome, priceRanges: quote.priceRanges }) ||
      !isBinaryPrice(selected.tickSize) ||
      selected.execution.tickSize !== selected.tickSize ||
      getKalshiOutcomeTickSize({
        price: referencePrice,
        outcome,
        side: input.orderSide,
        priceRanges: quote.priceRanges,
      }) !== selected.tickSize
    ) {
      return rejectMarketState("invalid_market_tick", "Kalshi executable price or tick is off the authoritative grid");
    }
  } catch {
    return rejectMarketState("invalid_market_tick", "Kalshi price_ranges or selected price is invalid");
  }

  const levels = selectKalshiLevels(quote, outcome, input.orderSide);
  if (!hasExecutableLevel(levels)) {
    return rejectMarketState("book_unavailable", "Selected Kalshi recovery book side is unavailable");
  }

  const evidence = validateMarketEvidence(input, state, quote, selected.chart.source, selected.chart.lastUpdatedAt);
  if (!evidence.ok) {
    return evidence.failure;
  }

  return {
    allowed: true,
    venue: "kalshi",
    side: input.orderSide,
    intentId: input.intent.id,
    slotKey: input.slot.key,
    marketRef,
    outcome,
    tokenId: null,
    referencePrice,
    priceRanges: quote.priceRanges.map((range) => ({ ...range })),
    ...evidence.value,
  };
}

export type RecoveryPriceFailureCode =
  | "invalid_input"
  | "invalid_price"
  | "invalid_tick"
  | "price_grid_error"
  | "tick_movement_out_of_bounds"
  | "missing_buy_price_cap"
  | "invalid_buy_price_cap";

export type PolymarketRecoveryPriceInput = {
  referencePrice: number;
  tickSize: number;
  side: OrderSide;
  ticks: number;
  maximumBuyPrice?: number | null;
};

export type KalshiRecoveryPriceInput = {
  referencePrice: number;
  outcome: "YES" | "NO";
  side: OrderSide;
  ticks: number;
  priceRanges: readonly KalshiPriceRange[];
  maximumBuyPrice?: number | null;
};

type AuthoritativeRecoveryPriceBase = {
  ok: true;
  side: OrderSide;
  price: number;
  normalizedReferencePrice: number;
  ticks: number;
  adjusted: boolean;
  capped: boolean;
};

export type AuthoritativePolymarketRecoveryPrice = AuthoritativeRecoveryPriceBase & {
  venue: "polymarket";
  tickSize: number;
  tickIndex: number;
};

export type AuthoritativeKalshiRecoveryPrice = AuthoritativeRecoveryPriceBase & {
  venue: "kalshi";
  outcome: "YES" | "NO";
  yesBookPrice: number;
  bookSide: "bid" | "ask";
};

export type AuthoritativeRecoveryOrderPrice = AuthoritativePolymarketRecoveryPrice | AuthoritativeKalshiRecoveryPrice;

export type RecoveryOrderPriceDecision =
  | AuthoritativeRecoveryOrderPrice
  | {
      ok: false;
      code: RecoveryPriceFailureCode;
      reason: string;
    };

export type AuthoritativePolymarketBuyPriceCap = {
  ok: true;
  venue: "polymarket";
  price: number;
  tickSize: number;
  tickIndex: number;
  adjusted: boolean;
};

export type AuthoritativeKalshiBuyPriceCap = {
  ok: true;
  venue: "kalshi";
  outcome: "YES" | "NO";
  price: number;
  yesBookPrice: number;
  adjusted: boolean;
};

type RecoveryBuyPriceCapFailure = {
  ok: false;
  code: "invalid_buy_price_cap" | "invalid_tick" | "price_grid_error";
  reason: string;
};

export type PolymarketBuyPriceCapDecision = AuthoritativePolymarketBuyPriceCap | RecoveryBuyPriceCapFailure;
export type KalshiBuyPriceCapDecision = AuthoritativeKalshiBuyPriceCap | RecoveryBuyPriceCapFailure;
export type RecoveryBuyPriceCapDecision = PolymarketBuyPriceCapDecision | KalshiBuyPriceCapDecision;

export function normalizePolymarketBuyPriceCap(input: {
  maximumBuyPrice: number;
  tickSize: number;
}): PolymarketBuyPriceCapDecision {
  if (!isBinaryPrice(input.maximumBuyPrice)) {
    return rejectBuyCap("invalid_buy_price_cap", "Maximum BUY price must be strictly between zero and one");
  }
  const normalized = normalizePriceToAuthoritativeTick({
    price: input.maximumBuyPrice,
    tickSize: input.tickSize,
    side: "SELL",
  });
  if (!normalized.ok) {
    return rejectBuyCap(
      normalized.code === "invalid_tick" ? "invalid_tick" : "invalid_buy_price_cap",
      normalized.reason,
    );
  }
  return {
    ok: true,
    venue: "polymarket",
    price: normalized.price,
    tickSize: input.tickSize,
    tickIndex: normalized.tickIndex,
    adjusted: normalized.adjusted,
  };
}

export function normalizeKalshiBuyPriceCap(input: {
  maximumBuyPrice: number;
  outcome: "YES" | "NO";
  priceRanges: readonly KalshiPriceRange[];
}): KalshiBuyPriceCapDecision {
  if (!isBinaryPrice(input.maximumBuyPrice)) {
    return rejectBuyCap("invalid_buy_price_cap", "Maximum BUY price must be strictly between zero and one");
  }
  try {
    const normalized = normalizeKalshiOutcomePrice({
      price: input.maximumBuyPrice,
      outcome: input.outcome,
      side: "SELL",
      priceRanges: input.priceRanges,
    });
    return {
      ok: true,
      venue: "kalshi",
      outcome: input.outcome,
      price: normalized.price,
      yesBookPrice: normalized.yesBookPrice,
      adjusted: normalized.adjusted,
    };
  } catch (error) {
    return rejectBuyCap("price_grid_error", error instanceof Error ? error.message : "Invalid Kalshi price grid");
  }
}

export function derivePolymarketRecoveryOrderPrice(input: PolymarketRecoveryPriceInput): RecoveryOrderPriceDecision {
  const requestFailure = validateRecoveryPriceRequest(input);
  if (requestFailure) {
    return requestFailure;
  }

  const normalized = normalizePriceToAuthoritativeTick({
    price: input.referencePrice,
    tickSize: input.tickSize,
    side: input.side,
  });
  if (!normalized.ok) {
    return rejectPrice(normalized.code === "invalid_tick" ? "invalid_tick" : "invalid_price", normalized.reason);
  }

  let capped = false;
  let targetTickIndex: number;
  if (input.side === "BUY") {
    const cap = normalizePolymarketBuyPriceCap({
      maximumBuyPrice: input.maximumBuyPrice!,
      tickSize: input.tickSize,
    });
    if (!cap.ok) {
      return rejectPrice(cap.code, cap.reason);
    }
    if (input.ticks > cap.tickIndex - normalized.tickIndex) {
      targetTickIndex = cap.tickIndex;
      capped = true;
    } else {
      targetTickIndex = normalized.tickIndex + input.ticks;
    }
  } else {
    targetTickIndex = normalized.tickIndex - input.ticks;
  }
  if (!Number.isSafeInteger(targetTickIndex) || targetTickIndex <= 0) {
    return rejectPrice("tick_movement_out_of_bounds", "Polymarket tick movement leaves the tradable grid");
  }
  const moved = normalizePriceToAuthoritativeTick({
    price: targetTickIndex * input.tickSize,
    tickSize: input.tickSize,
    side: input.side,
  });
  if (!moved.ok || moved.tickIndex !== targetTickIndex) {
    return rejectPrice("tick_movement_out_of_bounds", "Polymarket tick movement leaves the tradable grid");
  }

  return {
    ok: true,
    venue: "polymarket",
    side: input.side,
    price: moved.price,
    normalizedReferencePrice: normalized.price,
    tickSize: input.tickSize,
    tickIndex: moved.tickIndex,
    ticks: input.ticks,
    adjusted: normalized.adjusted || input.ticks > 0 || capped,
    capped,
  };
}

export function deriveKalshiRecoveryOrderPrice(input: KalshiRecoveryPriceInput): RecoveryOrderPriceDecision {
  const requestFailure = validateRecoveryPriceRequest(input);
  if (requestFailure) {
    return requestFailure;
  }

  try {
    const pricingInput = {
      price: input.referencePrice,
      outcome: input.outcome,
      side: input.side,
      ticks: input.ticks,
      priceRanges: input.priceRanges,
    };
    const normalized = normalizeKalshiOutcomePrice(pricingInput);
    let moved: ReturnType<typeof moveKalshiOutcomePriceByTicks>;
    let capped = false;
    if (input.side === "BUY") {
      const cap = normalizeKalshiBuyPriceCap({
        maximumBuyPrice: input.maximumBuyPrice!,
        outcome: input.outcome,
        priceRanges: input.priceRanges,
      });
      if (!cap.ok) {
        return rejectPrice(cap.code, cap.reason);
      }
      try {
        moved = moveKalshiOutcomePriceByTicks(pricingInput);
      } catch {
        moved = normalizeKalshiOutcomePrice({ ...pricingInput, price: cap.price });
        capped = true;
      }
      if (moved.price > cap.price + floatingTolerance(moved.price, cap.price)) {
        moved = normalizeKalshiOutcomePrice({ ...pricingInput, price: cap.price });
        capped = true;
      }
    } else {
      moved = moveKalshiOutcomePriceByTicks(pricingInput);
    }

    return {
      ok: true,
      venue: "kalshi",
      side: input.side,
      outcome: input.outcome,
      price: moved.price,
      normalizedReferencePrice: normalized.price,
      yesBookPrice: moved.yesBookPrice,
      bookSide: moved.bookSide,
      ticks: input.ticks,
      adjusted: normalized.adjusted || input.ticks > 0 || capped,
      capped,
    };
  } catch (error) {
    return rejectPrice("price_grid_error", error instanceof Error ? error.message : "Invalid Kalshi price grid");
  }
}

export type RecoveryFeeSchedule =
  | {
      venue: "polymarket";
      feeRateBps: number;
      feeRate: number | null;
      feeExponent: number | null;
    }
  | {
      venue: "kalshi";
      feeMultiplier: number;
      maker: boolean;
    };

export type RecoveryLossCapInput = {
  action: "unwind" | "rescue";
  orderPrice: AuthoritativeRecoveryOrderPrice;
  size: number;
  entryPrice: number;
  allocatedEntryFeeUsd: number;
  fee: RecoveryFeeSchedule;
  maxLossUsd: number;
};

type RecoveryLossEconomics = {
  action: "unwind" | "rescue";
  venue: Venue;
  normalizedOrderPrice: number;
  size: number;
  allocatedEntryFeeUsd: number;
  orderFeeUsd: number;
  totalFeeUsd: number;
  worstCaseLossUsd: number;
  maxLossUsd: number;
  remainingLossBudgetUsd: number;
};

export type RecoveryLossCapDecision =
  | (RecoveryLossEconomics & {
      allowed: true;
      reason: "within_loss_cap";
    })
  | (RecoveryLossEconomics & {
      allowed: false;
      code: "loss_cap_exceeded";
      reason: string;
    })
  | {
      allowed: false;
      code: "invalid_input" | "action_side_mismatch" | "fee_venue_mismatch" | "invalid_fee";
      reason: string;
    };

export function evaluateRecoveryLossCap(input: RecoveryLossCapInput): RecoveryLossCapDecision {
  const allocatedEntryFeeUsd = input.allocatedEntryFeeUsd;
  if (
    !input.orderPrice ||
    input.orderPrice.ok !== true ||
    !isBinaryPrice(input.orderPrice.price) ||
    !Number.isFinite(input.size) ||
    input.size <= 0 ||
    !isBinaryPrice(input.entryPrice) ||
    !isFiniteNonNegative(allocatedEntryFeeUsd) ||
    !isFiniteNonNegative(input.maxLossUsd)
  ) {
    return rejectLoss("invalid_input", "Recovery economics inputs must be finite and non-negative");
  }

  const expectedSide = input.action === "unwind" ? "SELL" : "BUY";
  if (input.orderPrice.side !== expectedSide) {
    return rejectLoss("action_side_mismatch", `${input.action} recovery requires a ${expectedSide} order price`);
  }
  if (input.fee.venue !== input.orderPrice.venue) {
    return rejectLoss("fee_venue_mismatch", "Fee schedule venue does not match the normalized order price");
  }
  if (!isValidFeeSchedule(input.fee)) {
    return rejectLoss("invalid_fee", "Recovery fee schedule contains invalid values");
  }

  const calculatedOrderFeeUsd = calculateRecoveryOrderFee(input.orderPrice, input.size, input.fee);
  if (!isFiniteNonNegative(calculatedOrderFeeUsd)) {
    return rejectLoss("invalid_fee", "Recovery order fee could not be calculated safely");
  }

  const normalizedEntryFeeUsd = roundMoneyUp(allocatedEntryFeeUsd);
  const orderFeeUsd = roundMoneyUp(calculatedOrderFeeUsd);
  const maxLossUsd = roundMoneyDown(input.maxLossUsd);
  const entryCostUsd = input.size * input.entryPrice + normalizedEntryFeeUsd;
  const rawWorstCaseLossUsd =
    input.action === "unwind"
      ? Math.max(0, entryCostUsd - (input.size * input.orderPrice.price - orderFeeUsd))
      : Math.max(0, entryCostUsd + input.size * input.orderPrice.price + orderFeeUsd - input.size);
  if (!isFiniteNonNegative(rawWorstCaseLossUsd)) {
    return rejectLoss("invalid_input", "Recovery worst-case loss cannot be represented safely");
  }
  const worstCaseLossUsd = roundMoneyUp(rawWorstCaseLossUsd);

  const economics: RecoveryLossEconomics = {
    action: input.action,
    venue: input.orderPrice.venue,
    normalizedOrderPrice: input.orderPrice.price,
    size: input.size,
    allocatedEntryFeeUsd: normalizedEntryFeeUsd,
    orderFeeUsd,
    totalFeeUsd: roundMoneyUp(normalizedEntryFeeUsd + orderFeeUsd),
    worstCaseLossUsd,
    maxLossUsd,
    remainingLossBudgetUsd: roundMoneyDown(Math.max(0, maxLossUsd - worstCaseLossUsd)),
  };

  if (worstCaseLossUsd > maxLossUsd) {
    return {
      allowed: false,
      code: "loss_cap_exceeded",
      reason: "Normalized recovery price and fees exceed the configured worst-case loss cap",
      ...economics,
    };
  }

  return {
    allowed: true,
    reason: "within_loss_cap",
    ...economics,
  };
}

function validateMarketEvidence(
  input: RecoveryMarketStateValidationInput,
  state: LiveMarketState,
  quote: PolymarketQuote | KalshiQuote,
  bookSource: string,
  bookObservedAt: number | null,
): { ok: true; value: MarketEvidence } | { ok: false; failure: RecoveryMarketStateDecision } {
  if (quote.feedHealth.asset !== input.slot.asset || quote.feedHealth.venue !== state.venue) {
    return {
      ok: false,
      failure: rejectMarketState("feed_identity_mismatch", "Feed identity does not match the recovery market"),
    };
  }
  if (quote.feedHealth.feedStatus !== "ready") {
    return { ok: false, failure: rejectMarketState("feed_not_ready", "Recovery market feed is not ready") };
  }
  if (quote.source !== "ws" || quote.feedHealth.source !== "ws") {
    return {
      ok: false,
      failure: rejectMarketState("feed_not_ws", "Recovery quote and feed must both be WebSocket-backed"),
    };
  }
  if (bookSource !== "ws") {
    return {
      ok: false,
      failure: rejectMarketState("book_not_ws", "Recovery order book must be WebSocket-backed"),
    };
  }

  const feedObservations = [quote.lastMessageAt, quote.feedHealth.lastMessageAt, state.lastSyncAt];
  if (feedObservations.some((observedAt) => !isFreshObservation(observedAt, input.now, input.maxFeedAgeMs))) {
    return {
      ok: false,
      failure: rejectMarketState("feed_stale", "Recovery feed timestamps are missing, future-dated, or stale"),
    };
  }
  if (!isFreshObservation(bookObservedAt, input.now, input.maxBookAgeMs)) {
    return {
      ok: false,
      failure: rejectMarketState("book_stale", "Recovery book timestamp is missing, future-dated, or stale"),
    };
  }

  const [quoteObservedAt, feedObservedAt, stateSyncedAt] = feedObservations;
  if (
    !isSafeTimestamp(quoteObservedAt) ||
    !isSafeTimestamp(feedObservedAt) ||
    !isSafeTimestamp(stateSyncedAt) ||
    !isSafeTimestamp(bookObservedAt)
  ) {
    return {
      ok: false,
      failure: rejectMarketState("feed_stale", "Recovery evidence timestamps are invalid"),
    };
  }

  const deadlines = [
    quoteObservedAt + input.maxFeedAgeMs,
    feedObservedAt + input.maxFeedAgeMs,
    stateSyncedAt + input.maxFeedAgeMs,
    bookObservedAt + input.maxBookAgeMs,
  ];
  if (deadlines.some((deadline) => !Number.isSafeInteger(deadline))) {
    return {
      ok: false,
      failure: rejectMarketState("invalid_input", "Recovery evidence deadline cannot be represented safely"),
    };
  }
  const validUntil = Math.min(...deadlines);
  if (input.now >= validUntil) {
    return {
      ok: false,
      failure: rejectMarketState("evidence_window_closed", "Recovery evidence has no remaining validity"),
    };
  }

  return {
    ok: true,
    value: {
      validUntil,
      quoteObservedAt,
      feedObservedAt,
      bookObservedAt,
      stateSyncedAt,
    },
  };
}

function validateRecoveryPriceRequest(input: {
  referencePrice: number;
  side: OrderSide;
  ticks: number;
  maximumBuyPrice?: number | null;
}): Extract<RecoveryOrderPriceDecision, { ok: false }> | null {
  if (!isOrderSide(input.side) || !Number.isSafeInteger(input.ticks) || input.ticks < 0) {
    return rejectPrice("invalid_input", "Recovery side and tick count must be valid");
  }
  if (!isBinaryPrice(input.referencePrice)) {
    return rejectPrice("invalid_price", "Recovery reference price must be strictly between zero and one");
  }
  if (input.side === "BUY" && input.maximumBuyPrice === undefined) {
    return rejectPrice("missing_buy_price_cap", "BUY recovery pricing requires an explicit maximum price");
  }
  const maximumBuyPrice = input.maximumBuyPrice;
  if (
    input.side === "BUY" &&
    (maximumBuyPrice === null ||
      maximumBuyPrice === undefined ||
      !Number.isFinite(maximumBuyPrice) ||
      maximumBuyPrice <= 0 ||
      maximumBuyPrice >= 1)
  ) {
    return rejectPrice("invalid_buy_price_cap", "Maximum BUY price must be strictly between zero and one");
  }
  return null;
}

function calculateRecoveryOrderFee(
  orderPrice: AuthoritativeRecoveryOrderPrice,
  size: number,
  fee: RecoveryFeeSchedule,
) {
  if (orderPrice.venue === "polymarket" && fee.venue === "polymarket") {
    return calculatePolymarketLevelFee({
      shares: size,
      price: orderPrice.price,
      feeRateBps: fee.feeRateBps,
      feeRate: fee.feeRate ?? undefined,
      feeExponent: fee.feeExponent ?? undefined,
    });
  }
  if (orderPrice.venue === "kalshi" && fee.venue === "kalshi") {
    return calculateKalshiFee({
      contracts: size,
      price: orderPrice.price,
      feeMultiplier: fee.feeMultiplier,
      maker: fee.maker,
    });
  }
  return Number.NaN;
}

function isValidFeeSchedule(fee: RecoveryFeeSchedule) {
  if (fee.venue === "polymarket") {
    return (
      isFiniteNonNegative(fee.feeRateBps) &&
      isOptionalFiniteNonNegative(fee.feeRate) &&
      isOptionalFiniteNonNegative(fee.feeExponent)
    );
  }
  return isFiniteNonNegative(fee.feeMultiplier) && typeof fee.maker === "boolean";
}

function selectPolymarketLevels(quote: PolymarketQuote, outcome: "UP" | "DOWN", side: OrderSide) {
  if (outcome === "UP") {
    return side === "BUY" ? quote.orderbookLevels?.upAsks : quote.orderbookLevels?.upBids;
  }
  return side === "BUY" ? quote.orderbookLevels?.downAsks : quote.orderbookLevels?.downBids;
}

function selectKalshiLevels(quote: KalshiQuote, outcome: "YES" | "NO", side: OrderSide) {
  const consumesYesBids = (outcome === "YES") === (side === "SELL");
  return consumesYesBids ? quote.orderbookLevels?.yesBids : quote.orderbookLevels?.noBids;
}

function hasExecutableLevel(levels: Array<[number, number]> | null | undefined) {
  return Boolean(levels?.some(([price, size]) => isBinaryPrice(price) && Number.isFinite(size) && size > 0));
}

function isPolymarketQuote(quote: PolymarketQuote | KalshiQuote): quote is PolymarketQuote {
  return quote.ref.venue === "polymarket" && "conditionId" in quote && "tokenIds" in quote;
}

function isKalshiQuote(quote: PolymarketQuote | KalshiQuote): quote is KalshiQuote {
  return quote.ref.venue === "kalshi" && "priceRanges" in quote && "feeMultiplier" in quote;
}

function refMatchesSlotTimes(quote: PolymarketQuote | KalshiQuote, slot: Pick<MarketSlot, "startTs" | "endTs">) {
  return Date.parse(quote.ref.startTime) === slot.startTs && Date.parse(quote.ref.endTime) === slot.endTs;
}

function isFreshObservation(observedAt: number | null, now: number, maxAgeMs: number) {
  return isSafeTimestamp(observedAt) && observedAt <= now && now - observedAt <= maxAgeMs;
}

function isSafeTimestamp(value: number | null): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

function isFiniteNonNegative(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOptionalFiniteNonNegative(value: number | null | undefined) {
  return value === undefined || value === null || isFiniteNonNegative(value);
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isBinaryPrice(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1;
}

function isOrderSide(value: string): value is OrderSide {
  return value === "BUY" || value === "SELL";
}

function floatingTolerance(left: number, right: number) {
  return Number.EPSILON * 32 * Math.max(1, Math.abs(left), Math.abs(right));
}

const MONEY_SCALE = 100_000_000;

function roundMoneyUp(value: number) {
  return roundMoney(value, "up");
}

function roundMoneyDown(value: number) {
  return roundMoney(value, "down");
}

function roundMoney(value: number, direction: "up" | "down") {
  const scaled = value * MONEY_SCALE;
  const nearest = Math.round(scaled);
  const tolerance = Number.EPSILON * 32 * Math.max(1, Math.abs(scaled));
  const units =
    Math.abs(scaled - nearest) <= tolerance ? nearest : direction === "up" ? Math.ceil(scaled) : Math.floor(scaled);
  return Math.max(0, units / MONEY_SCALE);
}

function rejectMarketState(
  code: RecoveryMarketStateFailureCode,
  reason: string,
): Extract<RecoveryMarketStateDecision, { allowed: false }> {
  return { allowed: false, code, reason };
}

function rejectPrice(
  code: RecoveryPriceFailureCode,
  reason: string,
): Extract<RecoveryOrderPriceDecision, { ok: false }> {
  return { ok: false, code, reason };
}

function rejectBuyCap(
  code: "invalid_buy_price_cap" | "invalid_tick" | "price_grid_error",
  reason: string,
): Extract<RecoveryBuyPriceCapDecision, { ok: false }> {
  return { ok: false, code, reason };
}

function rejectLoss(
  code: "invalid_input" | "action_side_mismatch" | "fee_venue_mismatch" | "invalid_fee",
  reason: string,
): Extract<RecoveryLossCapDecision, { allowed: false; code: typeof code }> {
  return { allowed: false, code, reason };
}
