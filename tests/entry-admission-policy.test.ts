import {
  evaluateReentryPolicy,
  normalizePriceToAuthoritativeTick,
  validateInitialEntryAdmission,
} from "@/lib/entry-admission-policy";
import type {
  InitialEntryAdmissionFailureCode,
  InitialEntryAdmissionInput,
  PriceTickNormalizationFailureCode,
  ReentryPolicyFailureCode,
} from "@/lib/entry-admission-policy";
import type { OutcomeQuote, Venue, VenueFeedHealth, VenueMarketRef } from "@/lib/types";

const NOW = 1_800_000_300_000;
const SLOT_START = NOW - 60_000;
const SLOT_END = NOW + 600_000;
const SLOT_KEY = `btc:${SLOT_START}`;

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
    id: venue === "polymarket" ? "poly-market" : "KXBTC15M-TEST",
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

function buildOutcome(outcome: OutcomeQuote["outcome"], lastUpdatedAt: number): OutcomeQuote {
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

function buildAdmissionInput(): InitialEntryAdmissionInput {
  return {
    now: NOW,
    slot: {
      asset: "btc",
      key: SLOT_KEY,
      startTs: SLOT_START,
      endTs: SLOT_END,
      polymarketSlug: "btc-updown-15m-test",
    },
    intent: {
      asset: "btc",
      slotKey: SLOT_KEY,
      slotStartTs: SLOT_START,
      slotEndTs: SLOT_END,
      combination: "POLY_UP_KALSHI_NO",
      legs: [
        {
          venue: "polymarket",
          outcome: "UP",
          marketRef: "condition-1",
          tokenId: "up-token",
          side: "BUY",
        },
        {
          venue: "kalshi",
          outcome: "NO",
          marketRef: "KXBTC15M-TEST",
          side: "BUY",
        },
      ],
    },
    polymarket: {
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
        up: buildOutcome("UP", NOW - 200),
        down: buildOutcome("DOWN", NOW - 200),
      },
      resolution: null,
      tokenIds: {
        up: "up-token",
        down: "down-token",
      },
      orderbookLevels: {
        upBids: [[0.39, 20]],
        upAsks: [[0.4, 20]],
        downBids: [[0.59, 20]],
        downAsks: [[0.6, 20]],
      },
      feeRateBps: 0,
      feeRate: 0,
      feeExponent: 0,
      feeMetadataPresent: true,
      feesEnabled: false,
    },
    kalshi: {
      ref: buildRef("kalshi"),
      status: "active",
      slotAligned: true,
      availabilityReason: null,
      feedHealth: buildFeed("kalshi"),
      lastMessageAt: NOW - 100,
      stalenessMs: 100,
      source: "ws",
      outcomes: {
        yes: buildOutcome("YES", NOW - 250),
        no: buildOutcome("NO", NOW - 250),
      },
      resolution: null,
      priceRanges: [{ start: "0.0000", end: "1.0000", step: "0.0100" }],
      orderbookLevels: {
        yesBids: [[0.59, 20]],
        noBids: [[0.39, 20]],
      },
    },
    entryCutoffSeconds: 180,
    submissionBudgetMs: 1_000,
    maxFeedAgeMs: 1_000,
    maxBookAgeMs: {
      polymarket: 1_000,
      kalshi: 1_000,
    },
    maxPairBookSkewMs: 500,
  };
}

function expectAdmissionFailure(input: InitialEntryAdmissionInput, code: InitialEntryAdmissionFailureCode) {
  const result = validateInitialEntryAdmission(input);
  expect(result.allowed).toBe(false);
  if (!result.allowed) {
    expect(result.code).toBe(code);
    expect(result.reason.length).toBeGreaterThan(0);
  }
}

describe("initial entry admission policy", () => {
  it("accepts a fresh, aligned POLY_UP_KALSHI_NO pair with enough submission time", () => {
    expect(validateInitialEntryAdmission(buildAdmissionInput())).toEqual({
      allowed: true,
      cutoffAt: SLOT_END - 180_000,
      latestSubmissionStartAt: NOW + 750,
      marketEvidenceValidUntil: NOW + 750,
      polymarketBookUpdatedAt: NOW - 200,
      kalshiBookUpdatedAt: NOW - 250,
      pairBookSkewMs: 50,
    });
  });

  it("closes the immutable submission capability when otherwise-fresh evidence has no remaining lifetime", () => {
    const input = buildAdmissionInput();
    input.polymarket.outcomes.up.chart.lastUpdatedAt = NOW - input.maxBookAgeMs.polymarket;
    input.kalshi.outcomes.no.chart.lastUpdatedAt = NOW - input.maxBookAgeMs.kalshi;

    expectAdmissionFailure(input, "evidence_window_closed");
  });

  it("keeps the slot submission deadline when it is earlier than every evidence deadline", () => {
    const input = buildAdmissionInput();
    input.entryCutoffSeconds = 599;
    input.submissionBudgetMs = 500;

    expect(validateInitialEntryAdmission(input)).toMatchObject({
      allowed: true,
      cutoffAt: NOW + 1_000,
      latestSubmissionStartAt: NOW + 500,
      marketEvidenceValidUntil: NOW + 750,
    });
  });

  it("accepts the opposite supported combination with its exact outcome token and synthetic Kalshi ask", () => {
    const input = buildAdmissionInput();
    input.intent.combination = "POLY_DOWN_KALSHI_YES";
    input.intent.legs = [
      {
        venue: "kalshi",
        outcome: "YES",
        marketRef: "KXBTC15M-TEST",
        side: "BUY",
      },
      {
        venue: "polymarket",
        outcome: "DOWN",
        marketRef: "condition-1",
        tokenId: "down-token",
        side: "BUY",
      },
    ];

    expect(validateInitialEntryAdmission(input).allowed).toBe(true);
  });

  it("requires authoritative Kalshi price ranges that contain the selected executable price", () => {
    const missing = buildAdmissionInput();
    missing.kalshi.priceRanges = null;
    expectAdmissionFailure(missing, "invalid_market_tick");

    const incomplete = buildAdmissionInput();
    incomplete.kalshi.priceRanges = [{ start: "0.0000", end: "0.5000", step: "0.0100" }];
    expectAdmissionFailure(incomplete, "invalid_market_tick");

    const offGrid = buildAdmissionInput();
    offGrid.kalshi.priceRanges = [{ start: "0.0000", end: "1.0000", step: "0.0200" }];
    offGrid.kalshi.outcomes.no.buyPrice = 0.41;
    offGrid.kalshi.outcomes.no.execution.buyPrice = 0.41;
    expectAdmissionFailure(offGrid, "invalid_market_tick");
  });

  it("requires an explicit coherent Polymarket fee schedule", () => {
    const missing = buildAdmissionInput();
    missing.polymarket.feeMetadataPresent = false;
    expectAdmissionFailure(missing, "fee_schedule_unavailable");

    const unknown = buildAdmissionInput();
    unknown.polymarket.feesEnabled = null;
    expectAdmissionFailure(unknown, "fee_schedule_unavailable");

    const contradictoryZero = buildAdmissionInput();
    contradictoryZero.polymarket.feeRateBps = 10;
    expectAdmissionFailure(contradictoryZero, "fee_schedule_unavailable");

    const enabled = buildAdmissionInput();
    enabled.polymarket.feesEnabled = true;
    enabled.polymarket.feeRate = 0.02;
    enabled.polymarket.feeExponent = 1;
    enabled.polymarket.feeRateBps = 120;
    enabled.polymarket.outcomes.up.feeRateBps = 120;
    enabled.polymarket.outcomes.up.execution.feeRateBps = 120;
    expect(validateInitialEntryAdmission(enabled).allowed).toBe(true);
  });

  it.each<[string, (input: InitialEntryAdmissionInput) => void, InitialEntryAdmissionFailureCode]>([
    ["non-finite clock", (input) => void (input.now = Number.NaN), "invalid_input"],
    ["reversed slot", (input) => void (input.slot.endTs = input.slot.startTs), "invalid_input"],
    ["negative cutoff", (input) => void (input.entryCutoffSeconds = -1), "invalid_input"],
    ["non-finite budget", (input) => void (input.submissionBudgetMs = Number.POSITIVE_INFINITY), "invalid_input"],
    ["negative feed age", (input) => void (input.maxFeedAgeMs = -1), "invalid_input"],
    [
      "invalid venue book age",
      (input) => void (input.maxBookAgeMs = { ...input.maxBookAgeMs, kalshi: Number.NaN }),
      "invalid_input",
    ],
    ["negative pair skew", (input) => void (input.maxPairBookSkewMs = -1), "invalid_input"],
    ["intent asset", (input) => void (input.intent.asset = "eth"), "intent_slot_mismatch"],
    ["intent slot key", (input) => void (input.intent.slotKey = "btc:other"), "intent_slot_mismatch"],
    ["intent start", (input) => void (input.intent.slotStartTs += 1), "intent_slot_mismatch"],
    ["intent end", (input) => void (input.intent.slotEndTs -= 1), "intent_slot_mismatch"],
    ["empty slot key", (input) => void (input.slot.key = ""), "intent_slot_mismatch"],
    ["empty canonical Poly slug", (input) => void (input.slot.polymarketSlug = ""), "intent_slot_mismatch"],
    ["slot not started", (input) => void (input.now = SLOT_START - 1), "slot_not_started"],
    ["slot ended", (input) => void (input.now = SLOT_END), "slot_ended"],
    [
      "submission budget reaches cutoff",
      (input) => void (input.now = SLOT_END - input.entryCutoffSeconds * 1_000 - input.submissionBudgetMs),
      "entry_window_closed",
    ],
  ])("fails closed for %s", (_label, mutate, code) => {
    const input = buildAdmissionInput();
    mutate(input);
    expectAdmissionFailure(input, code);
  });

  it.each<[string, (input: InitialEntryAdmissionInput) => void, InitialEntryAdmissionFailureCode]>([
    ["one leg", (input) => void (input.intent.legs = [input.intent.legs[0]]), "invalid_legs"],
    [
      "duplicate venue",
      (input) => void (input.intent.legs = [input.intent.legs[0], { ...input.intent.legs[1], venue: "polymarket" }]),
      "invalid_legs",
    ],
    [
      "initial sell leg",
      (input) => void (input.intent.legs = [{ ...input.intent.legs[0], side: "SELL" }, input.intent.legs[1]]),
      "invalid_legs",
    ],
    [
      "Polymarket outcome",
      (input) => void (input.intent.legs = [{ ...input.intent.legs[0], outcome: "DOWN" }, input.intent.legs[1]]),
      "combination_mismatch",
    ],
    [
      "Kalshi outcome",
      (input) => void (input.intent.legs = [input.intent.legs[0], { ...input.intent.legs[1], outcome: "YES" }]),
      "combination_mismatch",
    ],
    ["combination label", (input) => void (input.intent.combination = "POLY_DOWN_KALSHI_YES"), "combination_mismatch"],
  ])("rejects incoherent pair structure: %s", (_label, mutate, code) => {
    const input = buildAdmissionInput();
    mutate(input);
    expectAdmissionFailure(input, code);
  });

  it.each<[string, (input: InitialEntryAdmissionInput) => void, InitialEntryAdmissionFailureCode]>([
    ["Polymarket unaligned", (input) => void (input.polymarket.slotAligned = false), "market_unaligned"],
    ["Kalshi unaligned", (input) => void (input.kalshi.slotAligned = false), "market_unaligned"],
    [
      "Polymarket unavailable",
      (input) => void (input.polymarket.availabilityReason = "unavailable"),
      "market_unavailable",
    ],
    ["Polymarket closed", (input) => void (input.polymarket.status = "closed"), "market_not_tradable"],
    ["Kalshi non-tradable", (input) => void (input.kalshi.status = "paused"), "market_not_tradable"],
    ["Polymarket resolved", (input) => void (input.polymarket.resolution = "UP"), "market_resolved"],
    ["Kalshi resolved", (input) => void (input.kalshi.resolution = "NO"), "market_resolved"],
  ])("rejects non-tradable/final market state: %s", (_label, mutate, code) => {
    const input = buildAdmissionInput();
    mutate(input);
    expectAdmissionFailure(input, code);
  });

  it.each<[string, (input: InitialEntryAdmissionInput) => void, InitialEntryAdmissionFailureCode]>([
    ["Polymarket asset", (input) => void (input.polymarket.ref.asset = "eth"), "polymarket_identity_mismatch"],
    ["Polymarket venue", (input) => void (input.polymarket.ref.venue = "kalshi"), "polymarket_identity_mismatch"],
    ["Polymarket slot", (input) => void (input.polymarket.ref.slotKey = "btc:other"), "polymarket_identity_mismatch"],
    [
      "Polymarket start time",
      (input) => void (input.polymarket.ref.startTime = new Date(SLOT_START + 1).toISOString()),
      "polymarket_identity_mismatch",
    ],
    [
      "Polymarket end time",
      (input) => void (input.polymarket.ref.endTime = new Date(SLOT_END - 1).toISOString()),
      "polymarket_identity_mismatch",
    ],
    [
      "Polymarket slug",
      (input) => void (input.polymarket.ref.slug = "btc-updown-15m-other"),
      "polymarket_identity_mismatch",
    ],
    [
      "Polymarket ref condition",
      (input) => void (input.polymarket.ref.conditionId = "condition-2"),
      "polymarket_identity_mismatch",
    ],
    [
      "Polymarket leg condition",
      (input) =>
        void (input.intent.legs = [{ ...input.intent.legs[0], marketRef: "condition-2" }, input.intent.legs[1]]),
      "polymarket_identity_mismatch",
    ],
    [
      "Polymarket outcome token",
      (input) => void (input.intent.legs = [{ ...input.intent.legs[0], tokenId: "down-token" }, input.intent.legs[1]]),
      "polymarket_identity_mismatch",
    ],
    [
      "duplicate Polymarket tokens",
      (input) => void (input.polymarket.tokenIds.down = input.polymarket.tokenIds.up),
      "polymarket_identity_mismatch",
    ],
    [
      "Polymarket outcome mapping",
      (input) => void (input.polymarket.outcomes.up = { ...input.polymarket.outcomes.up, outcome: "DOWN" }),
      "polymarket_identity_mismatch",
    ],
    ["Kalshi asset", (input) => void (input.kalshi.ref.asset = "eth"), "kalshi_identity_mismatch"],
    ["Kalshi venue", (input) => void (input.kalshi.ref.venue = "polymarket"), "kalshi_identity_mismatch"],
    ["Kalshi slot", (input) => void (input.kalshi.ref.slotKey = "btc:other"), "kalshi_identity_mismatch"],
    [
      "Kalshi start time",
      (input) => void (input.kalshi.ref.startTime = new Date(SLOT_START + 1).toISOString()),
      "kalshi_identity_mismatch",
    ],
    [
      "Kalshi end time",
      (input) => void (input.kalshi.ref.endTime = new Date(SLOT_END - 1).toISOString()),
      "kalshi_identity_mismatch",
    ],
    ["Kalshi ticker", (input) => void (input.kalshi.ref.ticker = "OTHER"), "kalshi_identity_mismatch"],
    ["Kalshi event ticker", (input) => void (input.kalshi.ref.eventTicker = ""), "kalshi_identity_mismatch"],
    [
      "Kalshi leg market",
      (input) => void (input.intent.legs = [input.intent.legs[0], { ...input.intent.legs[1], marketRef: "OTHER" }]),
      "kalshi_identity_mismatch",
    ],
    [
      "Kalshi outcome mapping",
      (input) => void (input.kalshi.outcomes.no = { ...input.kalshi.outcomes.no, outcome: "YES" }),
      "kalshi_identity_mismatch",
    ],
  ])("rejects changed venue identity: %s", (_label, mutate, code) => {
    const input = buildAdmissionInput();
    mutate(input);
    expectAdmissionFailure(input, code);
  });

  it.each<[string, (input: InitialEntryAdmissionInput) => void]>([
    ["missing selected Polymarket tick", (input) => void (input.polymarket.outcomes.up.tickSize = null)],
    ["zero selected Polymarket tick", (input) => void (input.polymarket.outcomes.up.tickSize = 0)],
    ["non-finite selected Kalshi tick", (input) => void (input.kalshi.outcomes.no.tickSize = Number.NaN)],
    ["unit selected Kalshi tick", (input) => void (input.kalshi.outcomes.no.tickSize = 1)],
    ["divergent selected execution tick", (input) => void (input.polymarket.outcomes.up.execution.tickSize = 0.001)],
  ])("rejects %s", (_label, mutate) => {
    const input = buildAdmissionInput();
    mutate(input);
    expectAdmissionFailure(input, "invalid_market_tick");
  });

  it.each<[string, (input: InitialEntryAdmissionInput) => void, InitialEntryAdmissionFailureCode]>([
    ["feed asset", (input) => void (input.polymarket.feedHealth.asset = "eth"), "feed_identity_mismatch"],
    ["feed venue", (input) => void (input.kalshi.feedHealth.venue = "polymarket"), "feed_identity_mismatch"],
    ["degraded feed", (input) => void (input.polymarket.feedHealth.feedStatus = "degraded"), "feed_not_ready"],
    ["REST quote", (input) => void (input.polymarket.source = "rest-fallback"), "feed_not_ws"],
    ["REST feed", (input) => void (input.kalshi.feedHealth.source = "rest-bootstrap"), "feed_not_ws"],
    ["missing quote timestamp", (input) => void (input.polymarket.lastMessageAt = null), "feed_stale"],
    ["future feed timestamp", (input) => void (input.kalshi.feedHealth.lastMessageAt = input.now + 1), "feed_stale"],
    [
      "stale quote timestamp",
      (input) => void (input.polymarket.lastMessageAt = input.now - input.maxFeedAgeMs - 1),
      "feed_stale",
    ],
    [
      "reported staleness above limit",
      (input) => void (input.kalshi.stalenessMs = input.maxFeedAgeMs + 1),
      "feed_stale",
    ],
    ["REST book", (input) => void (input.polymarket.outcomes.up.chart.source = "rest-fallback"), "book_not_ws"],
    ["missing book timestamp", (input) => void (input.kalshi.outcomes.no.chart.lastUpdatedAt = null), "book_stale"],
    [
      "future book timestamp",
      (input) => void (input.polymarket.outcomes.up.chart.lastUpdatedAt = input.now + 1),
      "book_stale",
    ],
    [
      "stale book timestamp",
      (input) => void (input.kalshi.outcomes.no.chart.lastUpdatedAt = input.now - input.maxBookAgeMs.kalshi - 1),
      "book_stale",
    ],
    ["missing multilevel book", (input) => void (input.polymarket.orderbookLevels = null), "book_unavailable"],
    [
      "empty selected Poly asks",
      (input) => {
        if (input.polymarket.orderbookLevels) {
          input.polymarket.orderbookLevels.upAsks = [];
        }
      },
      "book_unavailable",
    ],
    [
      "invalid selected Kalshi synthetic asks",
      (input) => {
        if (input.kalshi.orderbookLevels) {
          input.kalshi.orderbookLevels.yesBids = [[0, 10]];
        }
      },
      "book_unavailable",
    ],
    [
      "pair book skew",
      (input) => void (input.kalshi.outcomes.no.chart.lastUpdatedAt = input.now - input.maxPairBookSkewMs - 201),
      "pair_book_skew",
    ],
  ])("rejects unhealthy market-data evidence: %s", (_label, mutate, code) => {
    const input = buildAdmissionInput();
    mutate(input);
    expectAdmissionFailure(input, code);
  });
});

describe("authoritative tick normalization", () => {
  it.each([
    { side: "BUY" as const, price: 0.301, tickSize: 0.01, expected: 0.31, adjusted: true },
    { side: "SELL" as const, price: 0.309, tickSize: 0.01, expected: 0.3, adjusted: true },
    { side: "BUY" as const, price: 0.3, tickSize: 0.01, expected: 0.3, adjusted: false },
    { side: "SELL" as const, price: 0.3, tickSize: 0.01, expected: 0.3, adjusted: false },
    { side: "BUY" as const, price: 0.1 + 0.2, tickSize: 0.01, expected: 0.3, adjusted: false },
    { side: "BUY" as const, price: 0.301, tickSize: 0.025, expected: 0.325, adjusted: true },
    { side: "SELL" as const, price: 0.301, tickSize: 0.025, expected: 0.3, adjusted: true },
    { side: "BUY" as const, price: 0.1234561, tickSize: 0.000001, expected: 0.123457, adjusted: true },
  ])("rounds $side $price conservatively on tick $tickSize", ({ side, price, tickSize, expected, adjusted }) => {
    const result = normalizePriceToAuthoritativeTick({ side, price, tickSize });
    expect(result).toMatchObject({
      ok: true,
      price: expected,
      adjusted,
    });
    if (result.ok) {
      const repeated = normalizePriceToAuthoritativeTick({ side, price: result.price, tickSize });
      expect(repeated).toEqual({
        ok: true,
        price: result.price,
        tickIndex: result.tickIndex,
        adjusted: false,
      });
    }
  });

  it.each<[string, number, number, "BUY" | "SELL", PriceTickNormalizationFailureCode]>([
    ["NaN price", Number.NaN, 0.01, "BUY", "invalid_price"],
    ["infinite price", Number.POSITIVE_INFINITY, 0.01, "BUY", "invalid_price"],
    ["zero price", 0, 0.01, "BUY", "invalid_price"],
    ["unit price", 1, 0.01, "BUY", "invalid_price"],
    ["negative price", -0.1, 0.01, "BUY", "invalid_price"],
    ["NaN tick", 0.5, Number.NaN, "BUY", "invalid_tick"],
    ["infinite tick", 0.5, Number.POSITIVE_INFINITY, "BUY", "invalid_tick"],
    ["zero tick", 0.5, 0, "BUY", "invalid_tick"],
    ["negative tick", 0.5, -0.01, "BUY", "invalid_tick"],
    ["unit tick", 0.5, 1, "BUY", "invalid_tick"],
    ["overflowing tick ratio", 0.5, Number.MIN_VALUE, "BUY", "invalid_tick"],
    ["BUY reaches one", 0.999, 0.01, "BUY", "normalized_price_out_of_bounds"],
    ["SELL reaches zero", 0.001, 0.01, "SELL", "normalized_price_out_of_bounds"],
  ])("rejects %s", (_label, price, tickSize, side, code) => {
    expect(normalizePriceToAuthoritativeTick({ price, tickSize, side })).toMatchObject({
      ok: false,
      code,
    });
  });

  it("rejects an invalid runtime side", () => {
    expect(
      normalizePriceToAuthoritativeTick({
        price: 0.5,
        tickSize: 0.01,
        side: "HOLD" as "BUY",
      }),
    ).toMatchObject({
      ok: false,
      code: "invalid_side",
    });
  });
});

describe("mode-aware reentry policy", () => {
  it.each([
    {
      label: "no prior entry",
      input: { mode: "live" as const, candidateGrossCost: 0.95, reentryImprovement: 0.01, previous: null },
      reason: "no_same_mode_baseline",
    },
    {
      label: "shadow baseline for live candidate",
      input: {
        mode: "live" as const,
        candidateGrossCost: 0.99,
        reentryImprovement: 0.01,
        previous: { mode: "shadow" as const, grossCost: 0.9 },
      },
      reason: "no_same_mode_baseline",
    },
    {
      label: "exact threshold equality",
      input: {
        mode: "shadow" as const,
        candidateGrossCost: 0.95,
        reentryImprovement: 0.02,
        previous: { mode: "shadow" as const, grossCost: 0.97 },
      },
      reason: "sufficient_improvement",
    },
    {
      label: "floating-point threshold equality",
      input: {
        mode: "live" as const,
        candidateGrossCost: 0.2,
        reentryImprovement: 0.1,
        previous: { mode: "live" as const, grossCost: 0.3 },
      },
      reason: "sufficient_improvement",
    },
    {
      label: "strictly better candidate",
      input: {
        mode: "live" as const,
        candidateGrossCost: 0.94,
        reentryImprovement: 0.02,
        previous: { mode: "live" as const, grossCost: 0.97 },
      },
      reason: "sufficient_improvement",
    },
    {
      label: "zero improvement permits equal cost",
      input: {
        mode: "live" as const,
        candidateGrossCost: 0.97,
        reentryImprovement: 0,
        previous: { mode: "live" as const, grossCost: 0.97 },
      },
      reason: "sufficient_improvement",
    },
  ])("allows $label", ({ input, reason }) => {
    expect(evaluateReentryPolicy(input)).toMatchObject({
      allowed: true,
      reason,
    });
  });

  it("rejects a same-mode candidate above the improvement threshold", () => {
    expect(
      evaluateReentryPolicy({
        mode: "live",
        candidateGrossCost: 0.950001,
        reentryImprovement: 0.02,
        previous: { mode: "live", grossCost: 0.97 },
      }),
    ).toMatchObject({
      allowed: false,
      code: "insufficient_improvement",
      maximumAllowedCost: 0.95,
    });
  });

  it.each<[string, () => Parameters<typeof evaluateReentryPolicy>[0], ReentryPolicyFailureCode]>([
    [
      "invalid mode",
      () => ({
        mode: "paper" as "live",
        candidateGrossCost: 0.9,
        reentryImprovement: 0.01,
        previous: null,
      }),
      "invalid_mode",
    ],
    [
      "NaN candidate",
      () => ({ mode: "live", candidateGrossCost: Number.NaN, reentryImprovement: 0.01, previous: null }),
      "invalid_candidate_cost",
    ],
    [
      "negative candidate",
      () => ({ mode: "live", candidateGrossCost: -0.1, reentryImprovement: 0.01, previous: null }),
      "invalid_candidate_cost",
    ],
    [
      "infinite improvement",
      () => ({
        mode: "live",
        candidateGrossCost: 0.9,
        reentryImprovement: Number.POSITIVE_INFINITY,
        previous: null,
      }),
      "invalid_improvement",
    ],
    [
      "negative improvement",
      () => ({ mode: "live", candidateGrossCost: 0.9, reentryImprovement: -0.01, previous: null }),
      "invalid_improvement",
    ],
    [
      "invalid previous mode",
      () => ({
        mode: "live",
        candidateGrossCost: 0.9,
        reentryImprovement: 0.01,
        previous: { mode: "paper" as "live", grossCost: 0.95 },
      }),
      "invalid_previous_mode",
    ],
    [
      "NaN previous cost",
      () => ({
        mode: "shadow",
        candidateGrossCost: 0.9,
        reentryImprovement: 0.01,
        previous: { mode: "shadow", grossCost: Number.NaN },
      }),
      "invalid_previous_cost",
    ],
    [
      "negative previous cost",
      () => ({
        mode: "shadow",
        candidateGrossCost: 0.9,
        reentryImprovement: 0.01,
        previous: { mode: "shadow", grossCost: -0.1 },
      }),
      "invalid_previous_cost",
    ],
  ])("fails closed for %s", (_label, buildInput, code) => {
    expect(evaluateReentryPolicy(buildInput())).toMatchObject({
      allowed: false,
      code,
    });
  });
});
