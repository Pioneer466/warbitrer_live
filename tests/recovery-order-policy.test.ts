import {
  deriveKalshiRecoveryOrderPrice,
  derivePolymarketRecoveryOrderPrice,
  evaluateRecoveryLossCap,
  normalizeKalshiBuyPriceCap,
  normalizePolymarketBuyPriceCap,
  validateRecoveryMarketState,
} from "@/lib/recovery-order-policy";
import type { RecoveryMarketStateValidationInput } from "@/lib/recovery-order-policy";
import type {
  KalshiQuote,
  LiveMarketState,
  OutcomeQuote,
  PolymarketQuote,
  Venue,
  VenueFeedHealth,
  VenueMarketRef,
} from "@/lib/types";

const NOW = 1_800_000_300_000;
const SLOT_START = NOW - 60_000;
const SLOT_END = NOW + 840_000;
const SLOT_KEY = `btc:${SLOT_START}`;
const PRICE_RANGES = [{ start: "0.0000", end: "1.0000", step: "0.0100" }];

function buildFeed(venue: Venue): VenueFeedHealth {
  return {
    asset: "btc",
    venue,
    feedStatus: "ready",
    source: "ws",
    lastMessageAt: NOW - 100,
    stalenessMs: 100,
    details: [],
    subscriptions: [],
  };
}

function buildRef(venue: Venue): VenueMarketRef {
  return {
    asset: "btc",
    venue,
    id: venue === "polymarket" ? "poly-market-id" : "KXBTC15M-TEST",
    conditionId: venue === "polymarket" ? "condition-1" : undefined,
    ticker: venue === "kalshi" ? "KXBTC15M-TEST" : undefined,
    eventTicker: venue === "kalshi" ? "KXBTC15M-EVENT" : undefined,
    slug: venue === "polymarket" ? "btc-updown-15m-test" : undefined,
    title: "BTC 15m",
    url: "https://example.test/market",
    startTime: new Date(SLOT_START).toISOString(),
    endTime: new Date(SLOT_END).toISOString(),
    slotKey: SLOT_KEY,
  };
}

function buildOutcome(outcome: OutcomeQuote["outcome"], lastUpdatedAt = NOW - 200): OutcomeQuote {
  return {
    outcome,
    buyPrice: 0.4,
    sellPrice: 0.39,
    midPrice: 0.395,
    bestBid: 0.39,
    bestAsk: 0.4,
    depth: 20,
    tickSize: 0.01,
    minOrderSize: 1,
    feeRateBps: 0,
    execution: {
      buyPrice: 0.4,
      sellPrice: 0.39,
      midPrice: 0.395,
      bestBid: 0.39,
      bestAsk: 0.4,
      depth: 20,
      tickSize: 0.01,
      minOrderSize: 1,
      feeRateBps: 0,
    },
    chart: {
      label: "best_ask_live",
      price: 0.4,
      source: "ws",
      lastUpdatedAt,
    },
  };
}

function buildPolymarketState(): LiveMarketState<PolymarketQuote> {
  return {
    venue: "polymarket",
    slotKey: SLOT_KEY,
    marketRef: "condition-1",
    lastBootstrapAt: NOW - 10_000,
    lastSyncAt: NOW - 50,
    quote: {
      ref: buildRef("polymarket"),
      conditionId: "condition-1",
      status: "open",
      slotAligned: true,
      availabilityReason: null,
      feedHealth: buildFeed("polymarket"),
      lastMessageAt: NOW - 100,
      stalenessMs: 100,
      source: "ws",
      outcomes: {
        up: buildOutcome("UP"),
        down: buildOutcome("DOWN"),
      },
      resolution: null,
      tokenIds: {
        up: "up-token",
        down: "down-token",
      },
      orderbookLevels: {
        upBids: [[0.39, 20]],
        upAsks: [[0.4, 20]],
        downBids: [[0.39, 20]],
        downAsks: [[0.4, 20]],
      },
      chainlinkLivePriceUsd: null,
      chainlinkLivePriceCapturedAt: null,
      observedSlotOpenPriceUsd: null,
      observedSlotOpenCapturedAt: null,
      feeRateBps: 0,
      feeRate: null,
      feeExponent: null,
      negRisk: false,
    },
  };
}

function buildKalshiState(): LiveMarketState<KalshiQuote> {
  return {
    venue: "kalshi",
    slotKey: SLOT_KEY,
    marketRef: "KXBTC15M-TEST",
    lastBootstrapAt: NOW - 10_000,
    lastSyncAt: NOW - 50,
    quote: {
      ref: buildRef("kalshi"),
      status: "active",
      slotAligned: true,
      availabilityReason: null,
      feedHealth: buildFeed("kalshi"),
      lastMessageAt: NOW - 100,
      stalenessMs: 100,
      source: "ws",
      outcomes: {
        yes: buildOutcome("YES"),
        no: buildOutcome("NO"),
      },
      targetPriceUsd: 100_000,
      resolution: null,
      feeMultiplier: 1,
      feeType: "quadratic",
      lastTradeYesPrice: 0.39,
      lastTradeNoPrice: 0.61,
      priceLevelStructure: "linear_cent",
      priceRanges: PRICE_RANGES.map((range) => ({ ...range })),
      orderbookLevels: {
        yesBids: [[0.6, 20]],
        noBids: [[0.39, 20]],
      },
    },
  };
}

function buildValidationInput(
  venue: Venue = "polymarket",
  orderSide: "BUY" | "SELL" = "SELL",
): RecoveryMarketStateValidationInput {
  return {
    now: NOW,
    slot: {
      asset: "btc",
      key: SLOT_KEY,
      startTs: SLOT_START,
      endTs: SLOT_END,
    },
    intent: {
      id: "intent-1",
      asset: "btc",
      slotKey: SLOT_KEY,
      slotStartTs: SLOT_START,
      slotEndTs: SLOT_END,
    },
    leg:
      venue === "polymarket"
        ? {
            intentId: "intent-1",
            venue,
            outcome: "UP",
            marketRef: "condition-1",
            tokenId: "up-token",
            side: "BUY",
          }
        : {
            intentId: "intent-1",
            venue,
            outcome: "NO",
            marketRef: "KXBTC15M-TEST",
            side: "BUY",
          },
    orderSide,
    marketState: venue === "polymarket" ? buildPolymarketState() : buildKalshiState(),
    maxFeedAgeMs: 1_000,
    maxBookAgeMs: 1_000,
  };
}

describe("recovery market-state validation", () => {
  it("returns an exact, time-bounded Polymarket recovery proof", () => {
    expect(validateRecoveryMarketState(buildValidationInput())).toEqual({
      allowed: true,
      venue: "polymarket",
      side: "SELL",
      intentId: "intent-1",
      slotKey: SLOT_KEY,
      marketRef: "condition-1",
      outcome: "UP",
      tokenId: "up-token",
      referencePrice: 0.39,
      tickSize: 0.01,
      validUntil: NOW + 800,
      quoteObservedAt: NOW - 100,
      feedObservedAt: NOW - 100,
      bookObservedAt: NOW - 200,
      stateSyncedAt: NOW - 50,
    });
  });

  it("validates Kalshi outcome identity and authoritative price_ranges", () => {
    expect(validateRecoveryMarketState(buildValidationInput("kalshi", "BUY"))).toMatchObject({
      allowed: true,
      venue: "kalshi",
      side: "BUY",
      marketRef: "KXBTC15M-TEST",
      outcome: "NO",
      tokenId: null,
      referencePrice: 0.4,
      priceRanges: PRICE_RANGES,
      validUntil: NOW + 800,
    });
  });

  it("accepts a valid Kalshi SELL bid without requiring a BUY ask", () => {
    const input = buildValidationInput("kalshi", "SELL");
    const quote = input.marketState.quote as KalshiQuote;
    quote.outcomes.no.buyPrice = null;
    quote.outcomes.no.execution.buyPrice = null;

    expect(validateRecoveryMarketState(input)).toMatchObject({
      allowed: true,
      venue: "kalshi",
      side: "SELL",
      referencePrice: 0.39,
    });
  });

  it("rejects a state rolled over to another slot", () => {
    const input = buildValidationInput();
    input.marketState.slotKey = `btc:${SLOT_END}`;

    expect(validateRecoveryMarketState(input)).toMatchObject({
      allowed: false,
      code: "market_rollover",
    });
  });

  it("treats validUntil as an exclusive stale boundary", () => {
    const stillFresh = buildValidationInput();
    const freshQuote = stillFresh.marketState.quote as PolymarketQuote;
    freshQuote.lastMessageAt = NOW - 999;
    freshQuote.feedHealth.lastMessageAt = NOW - 999;
    freshQuote.outcomes.up.chart.lastUpdatedAt = NOW - 999;
    stillFresh.marketState.lastSyncAt = NOW - 999;

    expect(validateRecoveryMarketState(stillFresh)).toMatchObject({
      allowed: true,
      validUntil: NOW + 1,
    });

    const expired = buildValidationInput();
    const expiredQuote = expired.marketState.quote as PolymarketQuote;
    expiredQuote.lastMessageAt = NOW - 1_000;
    expiredQuote.feedHealth.lastMessageAt = NOW - 1_000;
    expiredQuote.outcomes.up.chart.lastUpdatedAt = NOW - 1_000;
    expired.marketState.lastSyncAt = NOW - 1_000;

    expect(validateRecoveryMarketState(expired)).toMatchObject({
      allowed: false,
      code: "evidence_window_closed",
    });
  });

  it("rejects changed token identity, REST evidence, and a false Kalshi tick", () => {
    const tokenMismatch = buildValidationInput();
    tokenMismatch.leg.tokenId = "down-token";
    expect(validateRecoveryMarketState(tokenMismatch)).toMatchObject({ allowed: false, code: "token_mismatch" });

    const restBook = buildValidationInput();
    (restBook.marketState.quote as PolymarketQuote).outcomes.up.chart.source = "rest-fallback";
    expect(validateRecoveryMarketState(restBook)).toMatchObject({ allowed: false, code: "book_not_ws" });

    const invalidGridTick = buildValidationInput("kalshi", "BUY");
    (invalidGridTick.marketState.quote as KalshiQuote).outcomes.no.tickSize = 0.02;
    expect(validateRecoveryMarketState(invalidGridTick)).toMatchObject({
      allowed: false,
      code: "invalid_market_tick",
    });
  });
});

describe("authoritative recovery order pricing", () => {
  it("normalizes off-grid BUY caps downward on both authoritative grids", () => {
    expect(
      normalizePolymarketBuyPriceCap({
        maximumBuyPrice: 0.305,
        tickSize: 0.01,
      }),
    ).toEqual({
      ok: true,
      venue: "polymarket",
      price: 0.3,
      tickSize: 0.01,
      tickIndex: 30,
      adjusted: true,
    });

    expect(
      normalizeKalshiBuyPriceCap({
        maximumBuyPrice: 0.415,
        outcome: "NO",
        priceRanges: PRICE_RANGES,
      }),
    ).toEqual({
      ok: true,
      venue: "kalshi",
      outcome: "NO",
      price: 0.41,
      yesBookPrice: 0.59,
      adjusted: true,
    });
  });

  it("rounds a Polymarket BUY upward while keeping the final order on the capped tick", () => {
    expect(
      derivePolymarketRecoveryOrderPrice({
        referencePrice: 0.301,
        tickSize: 0.01,
        side: "BUY",
        ticks: 0,
        maximumBuyPrice: 0.31,
      }),
    ).toEqual({
      ok: true,
      venue: "polymarket",
      side: "BUY",
      price: 0.31,
      normalizedReferencePrice: 0.31,
      tickSize: 0.01,
      tickIndex: 31,
      ticks: 0,
      adjusted: true,
      capped: false,
    });

    expect(
      derivePolymarketRecoveryOrderPrice({
        referencePrice: 0.301,
        tickSize: 0.01,
        side: "BUY",
        ticks: 0,
        maximumBuyPrice: 0.305,
      }),
    ).toEqual({
      ok: true,
      venue: "polymarket",
      side: "BUY",
      price: 0.3,
      normalizedReferencePrice: 0.31,
      tickSize: 0.01,
      tickIndex: 30,
      ticks: 0,
      adjusted: true,
      capped: true,
    });
  });

  it("moves Polymarket and Kalshi SELL prices in the aggressive direction by authoritative ticks", () => {
    expect(
      derivePolymarketRecoveryOrderPrice({
        referencePrice: 0.309,
        tickSize: 0.01,
        side: "SELL",
        ticks: 2,
      }),
    ).toMatchObject({
      ok: true,
      price: 0.28,
      normalizedReferencePrice: 0.3,
      tickIndex: 28,
    });

    expect(
      deriveKalshiRecoveryOrderPrice({
        referencePrice: 0.401,
        outcome: "NO",
        side: "SELL",
        ticks: 1,
        priceRanges: PRICE_RANGES,
      }),
    ).toMatchObject({
      ok: true,
      venue: "kalshi",
      side: "SELL",
      outcome: "NO",
      normalizedReferencePrice: 0.4,
      price: 0.39,
      yesBookPrice: 0.61,
    });
  });

  it("requires an explicit BUY cap and keeps Kalshi tick movement on the floored cap", () => {
    expect(
      derivePolymarketRecoveryOrderPrice({
        referencePrice: 0.4,
        tickSize: 0.01,
        side: "BUY",
        ticks: 0,
      }),
    ).toMatchObject({ ok: false, code: "missing_buy_price_cap" });

    const cap = normalizeKalshiBuyPriceCap({
      maximumBuyPrice: 0.415,
      outcome: "NO",
      priceRanges: PRICE_RANGES,
    });
    const order = deriveKalshiRecoveryOrderPrice({
      referencePrice: 0.401,
      outcome: "NO",
      side: "BUY",
      ticks: 1,
      priceRanges: PRICE_RANGES,
      maximumBuyPrice: 0.415,
    });

    expect(cap).toMatchObject({ ok: true, price: 0.41 });
    expect(order).toMatchObject({
      ok: true,
      price: 0.41,
      normalizedReferencePrice: 0.41,
      capped: true,
    });
  });
});

describe("recovery worst-case loss cap", () => {
  it("blocks an unwind using the normalized SELL price and both entry and exit fees", () => {
    const orderPrice = derivePolymarketRecoveryOrderPrice({
      referencePrice: 0.309,
      tickSize: 0.01,
      side: "SELL",
      ticks: 0,
    });
    if (!orderPrice.ok) {
      throw new Error(orderPrice.reason);
    }

    const decision = evaluateRecoveryLossCap({
      action: "unwind",
      orderPrice,
      size: 10,
      entryPrice: 0.4,
      allocatedEntryFeeUsd: 0.1,
      fee: {
        venue: "polymarket",
        feeRateBps: 100,
        feeRate: null,
        feeExponent: null,
      },
      maxLossUsd: 1.12,
    });

    expect(decision).toMatchObject({
      allowed: false,
      code: "loss_cap_exceeded",
      normalizedOrderPrice: 0.3,
      orderFeeUsd: 0.03,
      totalFeeUsd: 0.13,
      maxLossUsd: 1.12,
    });
    expect("worstCaseLossUsd" in decision ? decision.worstCaseLossUsd : null).toBeCloseTo(1.13, 10);
  });

  it("allows equality at the unwind cap without rounding the loss down", () => {
    const orderPrice = derivePolymarketRecoveryOrderPrice({
      referencePrice: 0.309,
      tickSize: 0.01,
      side: "SELL",
      ticks: 0,
    });
    if (!orderPrice.ok) {
      throw new Error(orderPrice.reason);
    }

    expect(
      evaluateRecoveryLossCap({
        action: "unwind",
        orderPrice,
        size: 10,
        entryPrice: 0.4,
        allocatedEntryFeeUsd: 0.1,
        fee: { venue: "polymarket", feeRateBps: 100, feeRate: null, feeExponent: null },
        maxLossUsd: 1.13,
      }),
    ).toMatchObject({
      allowed: true,
      reason: "within_loss_cap",
      normalizedOrderPrice: 0.3,
    });
  });

  it("includes the normalized BUY price and Kalshi fee in rescue worst-case loss", () => {
    const orderPrice = deriveKalshiRecoveryOrderPrice({
      referencePrice: 0.391,
      outcome: "YES",
      side: "BUY",
      ticks: 0,
      priceRanges: PRICE_RANGES,
      maximumBuyPrice: 0.4,
    });
    if (!orderPrice.ok) {
      throw new Error(orderPrice.reason);
    }

    const decision = evaluateRecoveryLossCap({
      action: "rescue",
      orderPrice,
      size: 10,
      entryPrice: 0.6,
      allocatedEntryFeeUsd: 0,
      fee: { venue: "kalshi", feeMultiplier: 1, maker: false },
      maxLossUsd: 0.16,
    });

    expect(decision).toMatchObject({
      allowed: false,
      code: "loss_cap_exceeded",
      normalizedOrderPrice: 0.4,
      orderFeeUsd: 0.17,
      worstCaseLossUsd: 0.17,
      maxLossUsd: 0.16,
    });
  });

  it("rejects action/side and fee/venue mismatches before evaluating economics", () => {
    const orderPrice = derivePolymarketRecoveryOrderPrice({
      referencePrice: 0.4,
      tickSize: 0.01,
      side: "SELL",
      ticks: 0,
    });
    if (!orderPrice.ok) {
      throw new Error(orderPrice.reason);
    }

    expect(
      evaluateRecoveryLossCap({
        action: "rescue",
        orderPrice,
        size: 10,
        entryPrice: 0.5,
        allocatedEntryFeeUsd: 0,
        fee: { venue: "polymarket", feeRateBps: 0, feeRate: null, feeExponent: null },
        maxLossUsd: 1,
      }),
    ).toMatchObject({ allowed: false, code: "action_side_mismatch" });

    expect(
      evaluateRecoveryLossCap({
        action: "unwind",
        orderPrice,
        size: 10,
        entryPrice: 0.5,
        allocatedEntryFeeUsd: 0,
        fee: { venue: "kalshi", feeMultiplier: 1, maker: false },
        maxLossUsd: 1,
      }),
    ).toMatchObject({ allowed: false, code: "fee_venue_mismatch" });
  });
});
