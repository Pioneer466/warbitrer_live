import {
  buildStableClientOrderId,
  buildVenueOrderRequest,
  captureVenueReconcileFetch,
  countRecentKalshiSoftHedgeNoFillEvents,
  countRecentKalshiSoftPrimaryNoFillEvents,
  deriveFastKalshiPrimaryClipIntent,
  deriveKalshiPrimaryFallbackClipPlan,
  deriveLiveRemainingLegSize,
  deriveBufferedRetryLeg,
  deriveSettledVenueResolutions,
  deriveRemainingExposureSize,
  derivePrimaryExitSize,
  deriveSafePolymarketHedgeDepth,
  evaluateBenignHedgeOverfill,
  evaluateExposureRecoveryOptions,
  evaluateStablePnlChangeReadiness,
  estimateRescueHedgeLossUsd,
  estimatePrimaryUnwindLossUsd,
  getOpportunitySnapshotAgeMs,
  getMismatchEstimationSettings,
  getPolymarketHedgeMinNotionalViolation,
  getPolymarketHedgeSubmissionBlock,
  hasUnresolvedHedgeSubmissionAttempt,
  hasUnresolvedPrimarySubmissionAttempt,
  hasKalshiHedgeRetryCapacity,
  holdAcknowledgedOrderPendingAfterConfirmationFailure,
  isFeedHealthBreaker,
  isHedgedPairEconomicsWithinLossCap,
  isBreakerRelevantToSlot,
  isOpportunitySnapshotFresh,
  isLatePrimaryFillRescueEligible,
  isPolymarketOrderbookUnavailableError,
  isOrderAttemptTruthUnresolved,
  isRetryablePolymarketInventorySyncError,
  isTerminalPrimaryOrderWithNoObservedFill,
  isVenueReconcileTruthFresh,
  mergePolymarketTradeObservationStatus,
  immediatePartialOrderType,
  isPrimaryFillSizeHedgable,
  primaryImmediateOrderType,
  mergeObservedSlotResolutionOutcomes,
  resolvePrimaryRetryPlan,
  resolveKalshiPrimaryMultiClipRetryPlan,
  shouldManageFeedHealthBreaker,
  shouldKeepPolymarketLegForResolution,
  shouldHoldHedgeRescueOrderPendingTruth,
  shouldHoldDestructiveReconcileForVenueTruth,
  shouldHoldPolymarketHedgeFailurePendingTruth,
  shouldFailClosedOnSubmissionError,
  shouldKeepSlotExecutionBreakerActive,
  shouldPauseExecutionForBreaker,
  shouldRefreshIdleExecution,
  shouldTreatPrimaryExecutionAsFilled,
  shouldTreatHedgeOrderAsComplete,
  shouldRetryTerminalZeroFillHedge,
  shouldTreatPrimaryOrderAsFilled,
  shouldTreatPrimaryUnwindOrderAsComplete,
  shouldDeferPolymarketUnwindToSettlement,
  shouldUseFastKalshiPrimaryPreparation,
  shouldSyncFeedCircuitBreaker,
  selectWinningExecutionCandidate,
  sumPolymarketAskDepthWithinLimit,
  quotePolymarketBuyFromAsks,
  summarizeIntentLegOrders,
  summarizeIntentLegFills,
  validateWorstFillExecutionCaps,
  validateFinalWsEntryDepthCoverage,
  validateFinalWsEntrySnapshot,
} from "@/lib/engine";
import type { VenueReconcileFetchStates } from "@/lib/engine";
import type {
  CircuitBreaker,
  ExecutionCandidate,
  KalshiQuote,
  LiveFill,
  LiveOpportunity,
  LiveOrder,
  MarketSlot,
  OutcomeQuote,
  OrderIntent,
  PolymarketQuote,
  PositionSnapshot,
  RunEvent,
  VenueBalance,
} from "@/lib/types";
import { DEFAULT_STRATEGY_CONFIG } from "@/lib/constants";
import { deriveHedgedPairEconomics } from "@/lib/settlement";

function buildIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  const base: OrderIntent = {
    id: "intent-1",
    asset: "btc",
    shadow: false,
    slotKey: "btc:slot-1",
    slotStartTs: 1,
    slotEndTs: 2,
    combination: "POLY_DOWN_KALSHI_YES",
    status: "failed",
    createdAt: 1,
    updatedAt: 2,
    resolvedAt: null,
    primaryVenue: "polymarket",
    hedgeVenue: "kalshi",
    grossCost: 0.9,
    targetNotionalUsd: 10,
    maxSlippageBps: 30,
    failureReason: "Primary order not observed before timeout or slot end",
    projectedNetProfitUsd: 1,
    realizedPnlUsd: null,
    roi: null,
    polyResolution: null,
    kalshiResolution: null,
    legs: [
      {
        id: "leg-primary",
        intentId: "intent-1",
        venue: "polymarket",
        outcome: "DOWN",
        marketRef: "poly-market",
        tokenId: "token-1",
        side: "BUY",
        requestedPrice: 0.45,
        requestedSize: 10,
        requestedNotionalUsd: 5,
        filledPrice: 0.45,
        filledSize: 10,
        feeUsd: 0.5,
        status: "filled",
        venueOrderId: "poly-order",
        payoutUsd: null,
        resolvedOutcome: null,
      },
      {
        id: "leg-hedge",
        intentId: "intent-1",
        venue: "kalshi",
        outcome: "YES",
        marketRef: "kalshi-market",
        side: "BUY",
        requestedPrice: 0.45,
        requestedSize: 10,
        requestedNotionalUsd: 5,
        filledPrice: null,
        filledSize: 0,
        feeUsd: 0,
        status: "failed",
        venueOrderId: null,
        payoutUsd: null,
        resolvedOutcome: null,
      },
    ],
  };

  return {
    ...base,
    ...overrides,
    asset: overrides.asset ?? base.asset,
  };
}

describe("mismatch estimation bootstrap", () => {
  it("builds nominal economics before applying enforce sizing", () => {
    const enforceSettings = {
      ...DEFAULT_STRATEGY_CONFIG,
      mismatchRiskMode: "enforce" as const,
    };

    expect(getMismatchEstimationSettings(enforceSettings).mismatchRiskMode).toBe("shadow");
    expect(enforceSettings.mismatchRiskMode).toBe("enforce");
  });

  it("leaves non-enforce modes unchanged", () => {
    const blockOnlySettings = {
      ...DEFAULT_STRATEGY_CONFIG,
      mismatchRiskMode: "block_only" as const,
    };

    expect(getMismatchEstimationSettings(blockOnlySettings)).toBe(blockOnlySettings);
  });
});

describe("ambiguous submission safety", () => {
  it("fails closed for transport errors on both venues until venue truth is authoritative", () => {
    expect(shouldFailClosedOnSubmissionError({ venue: "polymarket" })).toBe(true);
    expect(shouldFailClosedOnSubmissionError({ venue: "kalshi" })).toBe(true);
  });

  it("keeps an intent open when its primary attempt may have reached the venue", () => {
    const attempt = {
      legId: "leg-primary",
      stage: "primary",
      status: "planned" as const,
      truthStatus: null,
    };

    expect(isOrderAttemptTruthUnresolved(attempt)).toBe(true);
    expect(hasUnresolvedPrimarySubmissionAttempt([attempt], "leg-primary")).toBe(true);
    expect(
      hasUnresolvedPrimarySubmissionAttempt(
        [{ ...attempt, status: "confirmed", truthStatus: "filled" }],
        "leg-primary",
      ),
    ).toBe(false);
    expect(
      hasUnresolvedPrimarySubmissionAttempt(
        [{ ...attempt, status: "failed", truthStatus: "not_submitted" }],
        "leg-primary",
      ),
    ).toBe(false);
  });

  it("does not confuse hedge or unwind attempts with a missing primary entry", () => {
    const base = {
      legId: "leg-primary",
      status: "truth_pending" as const,
      truthStatus: "submission_unknown",
    };

    expect(
      hasUnresolvedPrimarySubmissionAttempt(
        [
          { ...base, stage: "hedge" },
          { ...base, stage: "primary_unwind" },
        ],
        "leg-primary",
      ),
    ).toBe(false);
    expect(hasUnresolvedPrimarySubmissionAttempt([{ ...base, stage: "primary_retry:1" }], "leg-primary")).toBe(true);
  });

  it("recognizes every unresolved hedge entry stage without matching unrelated attempts", () => {
    const base = {
      legId: "leg-hedge",
      status: "truth_pending" as const,
      truthStatus: "submission_unknown",
    };

    for (const stage of ["hedge", "incremental_hedge:1", "hedge_retry:1", "hedge_rescue:1"]) {
      expect(hasUnresolvedHedgeSubmissionAttempt([{ ...base, stage }], "leg-hedge")).toBe(true);
    }

    expect(
      hasUnresolvedHedgeSubmissionAttempt(
        [
          { ...base, stage: "primary" },
          { ...base, stage: "primary_unwind:1" },
          { ...base, stage: "hedge", status: "confirmed", truthStatus: "filled" },
          { ...base, stage: "hedge_retry:1", status: "failed", truthStatus: "not_submitted" },
        ],
        "leg-hedge",
      ),
    ).toBe(false);
    expect(hasUnresolvedHedgeSubmissionAttempt([{ ...base, stage: "hedge" }], "another-leg")).toBe(false);
  });

  it("keeps the client order id stable when volatile execution terms change", () => {
    const intent = buildIntent();
    const leg = intent.legs[1];
    const request = {
      marketRef: leg.marketRef,
      outcome: leg.outcome,
      side: "BUY" as const,
      size: 10,
      price: 0.45,
      maxCostUsd: 4.5,
      orderType: "IOC",
      buyMode: "shares" as const,
      clientOrderId: "ignored",
    };

    const first = buildStableClientOrderId({ intent, leg, request, stage: "hedge_retry:1" });
    const repriced = buildStableClientOrderId({
      intent,
      leg,
      stage: "hedge_retry:1",
      request: {
        ...request,
        size: 8,
        price: 0.51,
        maxCostUsd: 4.08,
        buyMode: "amount",
      },
    });

    expect(repriced).toBe(first);
    expect(buildStableClientOrderId({ intent, leg, request, stage: "hedge_retry:2" })).not.toBe(first);
  });

  it("only closes a terminal primary when venue truth shows zero fill", () => {
    expect(isTerminalPrimaryOrderWithNoObservedFill({ status: "canceled", filledSize: 0 })).toBe(true);
    expect(isTerminalPrimaryOrderWithNoObservedFill({ status: "canceled", filledSize: 0.5 })).toBe(false);
    expect(isTerminalPrimaryOrderWithNoObservedFill({ status: "filled", filledSize: 10 })).toBe(false);
  });
});

describe("venue reconciliation source truth", () => {
  const freshStates: VenueReconcileFetchStates = {
    polymarketOrders: { ok: true, error: null },
    polymarketFills: { ok: true, error: null },
    kalshiOrders: { ok: true, error: null },
    kalshiFills: { ok: true, error: null },
  };

  it("preserves the difference between a successful empty response and a failed fetch", async () => {
    const emptyResponse = await captureVenueReconcileFetch(async () => [] as string[], ["fallback"]);
    const failedResponse = await captureVenueReconcileFetch(async () => {
      throw new Error("venue unavailable");
    }, [] as string[]);

    expect(emptyResponse).toEqual({
      value: [],
      state: { ok: true, error: null },
    });
    expect(failedResponse).toEqual({
      value: [],
      state: { ok: false, error: "venue unavailable" },
    });
  });

  it("requires successful order and fill fetches before destructive reconciliation", () => {
    const failedKalshiStates: VenueReconcileFetchStates = {
      ...freshStates,
      kalshiOrders: { ok: false, error: "orders unavailable" },
    };
    const failedPolymarketFillStates: VenueReconcileFetchStates = {
      ...freshStates,
      polymarketFills: { ok: false, error: "fills unavailable" },
    };

    expect(isVenueReconcileTruthFresh("kalshi", freshStates)).toBe(true);
    expect(isVenueReconcileTruthFresh("kalshi", failedKalshiStates)).toBe(false);
    expect(isVenueReconcileTruthFresh("polymarket", failedPolymarketFillStates)).toBe(false);
    expect(
      shouldHoldDestructiveReconcileForVenueTruth({
        venue: "kalshi",
        fetchStates: freshStates,
      }),
    ).toBe(false);
    expect(
      shouldHoldDestructiveReconcileForVenueTruth({
        venue: "kalshi",
        fetchStates: undefined,
      }),
    ).toBe(true);
    expect(
      shouldHoldDestructiveReconcileForVenueTruth({
        venue: "kalshi",
        fetchStates: failedKalshiStates,
      }),
    ).toBe(true);
    expect(
      shouldHoldDestructiveReconcileForVenueTruth({
        venue: "polymarket",
        fetchStates: failedPolymarketFillStates,
      }),
    ).toBe(true);
  });
});

describe("acknowledged order confirmation failures", () => {
  it("keeps a terminal zero-fill acknowledgement pending until confirmation truth is available", () => {
    const held = holdAcknowledgedOrderPendingAfterConfirmationFailure(
      {
        venue: "polymarket",
        venueOrderId: "order-1",
        status: "canceled",
        filledSize: 0,
        averageFillPrice: null,
        feeUsd: 0,
        raw: { acknowledged: true },
      },
      "maker side missing",
    );

    expect(held.status).toBe("pending");
    expect(held.raw).toMatchObject({
      acknowledgedStatus: "canceled",
      confirmationTruthPending: true,
      confirmationError: "maker side missing",
    });
  });

  it("preserves positive-fill acknowledgement state while recording confirmation ambiguity", () => {
    const held = holdAcknowledgedOrderPendingAfterConfirmationFailure(
      {
        venue: "polymarket",
        venueOrderId: "order-1",
        status: "filled",
        filledSize: 2,
        averageFillPrice: 0.5,
        feeUsd: 0,
        raw: {},
      },
      "trades unavailable",
    );

    expect(held.status).toBe("filled");
    expect(held.filledSize).toBe(2);
    expect(held.raw.confirmationTruthPending).toBe(true);
  });
});

function buildKalshiPrimaryPolymarketHedgeIntent(
  overrides: {
    kalshiPrice?: number;
    kalshiFeeUsd?: number;
    polymarketPrice?: number;
    polymarketFilledSize?: number;
  } = {},
): OrderIntent {
  const base = buildIntent();
  const kalshiPrice = overrides.kalshiPrice ?? 0.417;
  const polymarketPrice = overrides.polymarketPrice ?? 0.49;

  return buildIntent({
    primaryVenue: "kalshi",
    hedgeVenue: "polymarket",
    combination: "POLY_UP_KALSHI_NO",
    status: "hedging",
    failureReason: null,
    legs: [
      {
        ...base.legs[1],
        id: "leg-primary",
        venue: "kalshi",
        outcome: "NO",
        requestedPrice: kalshiPrice,
        requestedSize: 10,
        requestedNotionalUsd: kalshiPrice * 10,
        filledPrice: kalshiPrice,
        filledSize: 10,
        feeUsd: overrides.kalshiFeeUsd ?? 0.17,
        status: "filled",
        venueOrderId: "kalshi-order",
      },
      {
        ...base.legs[0],
        id: "leg-hedge",
        venue: "polymarket",
        outcome: "UP",
        requestedPrice: polymarketPrice,
        requestedSize: 10,
        requestedNotionalUsd: 5,
        filledPrice: polymarketPrice,
        filledSize: overrides.polymarketFilledSize ?? 10.2,
        feeUsd: 0,
        status: "submitted",
        venueOrderId: "poly-order",
      },
    ],
  });
}

function buildOrder(overrides: Partial<LiveOrder> = {}): LiveOrder {
  const base: LiveOrder = {
    id: "order-1",
    asset: "btc",
    shadow: false,
    intentId: "intent-1",
    venue: "polymarket",
    venueOrderId: "sell-1",
    clientOrderId: "client-1",
    marketRef: "poly-market",
    tokenId: "token-1",
    side: "SELL",
    outcome: "DOWN",
    orderType: "FAK",
    requestedPrice: 0.44,
    requestedSize: 10,
    filledSize: 0,
    averageFillPrice: null,
    feeUsd: 0,
    status: "canceled",
    createdAt: 1,
    updatedAt: 2,
    raw: {},
  };

  return {
    ...base,
    ...overrides,
    asset: overrides.asset ?? base.asset,
  };
}

function buildVenueBalance(overrides: Partial<VenueBalance> = {}): VenueBalance {
  const base: VenueBalance = {
    venue: "polymarket",
    capturedAt: 1,
    status: "ready",
    currency: "USDC",
    availableBalanceUsd: 100,
    totalBalanceUsd: 100,
    portfolioValueUsd: 100,
    allowanceUsd: 100,
    notes: [],
    raw: {},
  };

  return {
    ...base,
    ...overrides,
  };
}

function buildWorstFillOpportunity(overrides: Partial<LiveOpportunity> = {}): LiveOpportunity {
  return {
    asset: "btc",
    id: "candidate",
    slotKey: "btc:slot-1",
    capturedAt: 1_000,
    combination: "POLY_DOWN_KALSHI_YES",
    label: "Poly Down + Kalshi Yes",
    grossCost: 0.92,
    threshold: 0.93,
    thresholdMet: true,
    worstCaseProfitUsd: 0.8,
    fatalMismatchPnlUsd: -9.2,
    conservativeExpectedPnlUsd: 0.8,
    mismatchRiskEstimate: null,
    eligible: true,
    primaryVenue: "polymarket",
    primarySelection: null,
    improvementFromLastEntry: null,
    estimatedFeesUsd: 0.2,
    projectedNetProfitUsd: 0.8,
    projectedNetReturn: 0.087,
    reasons: [],
    legs: [
      {
        venue: "polymarket",
        outcome: "DOWN",
        marketRef: "poly-market",
        tokenId: "token-1",
        price: 0.46,
        depth: 100,
        targetNotionalUsd: 4.5,
        size: 10,
        tickSize: 0.001,
        minOrderSize: 5,
        feeEstimateUsd: 0.1,
      },
      {
        venue: "kalshi",
        outcome: "YES",
        marketRef: "kalshi-market",
        price: 0.46,
        depth: 100,
        targetNotionalUsd: 4.5,
        size: 10,
        tickSize: 0.01,
        minOrderSize: 1,
        feeEstimateUsd: 0.1,
      },
    ],
    mismatchGuardAction: "allow",
    mismatchSizeMultiplier: 1,
    referencePayoutCount: 1,
    deadZoneDistanceBps: null,
    deadZoneWidthBps: null,
    mismatchRisk: null,
    venueDisagreementPct: null,
    secondsElapsedInSlot: null,
    chainlinkMoveBps: null,
    openDriftBps: null,
    chainlinkLivePriceUsd: null,
    observedSlotOpenPriceUsd: null,
    kalshiTargetPriceUsd: null,
    ...overrides,
  };
}

describe("worst-fill execution caps", () => {
  const readyBalances = [
    buildVenueBalance({ venue: "polymarket", capturedAt: 1_000 }),
    buildVenueBalance({
      venue: "kalshi",
      capturedAt: 1_000,
      currency: "USD",
    }),
  ];
  const validate = (overrides: Partial<Parameters<typeof validateWorstFillExecutionCaps>[0]> = {}) =>
    validateWorstFillExecutionCaps({
      opportunity: buildWorstFillOpportunity(),
      intent: buildIntent({ status: "pending", failureReason: null }),
      settings: { ...DEFAULT_STRATEGY_CONFIG },
      balances: readyBalances,
      openIntents: [],
      venueExposureUsd: { polymarket: 0, kalshi: 0 },
      balanceMaxAgeMs: 10_000,
      now: 1_000,
      ...overrides,
    });

  it("accepts worst-fill economics that fit every deterministic cap", () => {
    expect(validate()).toBeNull();
  });

  it("blocks an actual order limit above the configured leg-price cap", () => {
    const opportunity = buildWorstFillOpportunity();
    opportunity.legs[0] = { ...opportunity.legs[0], price: 0.5 };

    expect(validate({ opportunity })).toContain("exceeds max leg price");
  });

  it("checks fees against fresh balances after existing reservations", () => {
    expect(
      validate({
        balances: readyBalances.map((balance) =>
          balance.venue === "kalshi" ? { ...balance, availableBalanceUsd: 4.59 } : balance,
        ),
      }),
    ).toContain("exceeds available balance");
  });

  it("reserves the full payout-plus-loss rescue bound on a Polymarket hedge", () => {
    const intent = buildIntent({
      primaryVenue: "kalshi",
      hedgeVenue: "polymarket",
      status: "pending",
      failureReason: null,
    });
    expect(
      validate({
        intent,
        balances: readyBalances.map((balance) =>
          balance.venue === "polymarket" ? { ...balance, availableBalanceUsd: 6 } : balance,
        ),
      }),
    ).toContain("polymarket requirement");
  });

  it("applies venue exposure to worst-fill cost including fees", () => {
    expect(
      validate({
        settings: {
          ...DEFAULT_STRATEGY_CONFIG,
          maxVenueExposureUsd: 10,
        },
        venueExposureUsd: { polymarket: 5.5, kalshi: 0 },
      }),
    ).toContain("exceeds venue limit");
  });
});

describe("final WS entry snapshot", () => {
  type TestPolymarketQuote = PolymarketQuote & {
    orderbookLevels: NonNullable<PolymarketQuote["orderbookLevels"]>;
  };
  type TestKalshiQuote = KalshiQuote & {
    orderbookLevels: NonNullable<KalshiQuote["orderbookLevels"]>;
  };

  const slot: MarketSlot = {
    asset: "btc",
    key: "btc:slot-1",
    startTs: 0,
    endTs: 10_000,
    startIso: new Date(0).toISOString(),
    endIso: new Date(10_000).toISOString(),
    label: "BTC test slot",
    polymarketSlug: "btc-test-slot",
    secondsRemaining: 10,
  };
  const intent = buildIntent({
    status: "pending",
    failureReason: null,
    slotKey: slot.key,
  });
  const outcome = (name: OutcomeQuote["outcome"]): OutcomeQuote => {
    const execution = {
      buyPrice: 0.5,
      sellPrice: 0.49,
      midPrice: 0.495,
      bestBid: 0.49,
      bestAsk: 0.5,
      depth: 100,
      tickSize: 0.01,
      minOrderSize: 1,
      feeRateBps: 0,
    };
    return {
      outcome: name,
      ...execution,
      execution,
      chart: {
        label: "best_ask_live",
        price: 0.5,
        source: "ws",
        lastUpdatedAt: 1_000,
      },
    };
  };
  const buildPolymarketQuote = (): TestPolymarketQuote => {
    return {
      ref: {
        asset: "btc",
        venue: "polymarket",
        id: "poly-market",
        title: "BTC test market",
        url: "https://polymarket.com/event/btc-test-slot",
        startTime: slot.startIso,
        endTime: slot.endIso,
        slotKey: slot.key,
      },
      conditionId: "poly-market",
      status: "open",
      slotAligned: true,
      availabilityReason: null,
      feedHealth: {
        asset: "btc",
        venue: "polymarket",
        feedStatus: "ready",
        source: "ws",
        lastMessageAt: 1_000,
        stalenessMs: 0,
        details: [],
        subscriptions: [],
      },
      lastMessageAt: 1_000,
      source: "ws",
      stalenessMs: 0,
      orderbookLevels: { upBids: [], upAsks: [], downBids: [], downAsks: [] },
      outcomes: { up: outcome("UP"), down: outcome("DOWN") },
      resolution: null,
      tokenIds: { up: "poly-up", down: "poly-down" },
      chainlinkLivePriceUsd: null,
      chainlinkLivePriceCapturedAt: null,
      observedSlotOpenPriceUsd: null,
      observedSlotOpenCapturedAt: null,
      feeRateBps: 0,
      negRisk: false,
    };
  };
  const buildKalshiQuote = (): TestKalshiQuote => {
    return {
      ref: {
        asset: "btc",
        venue: "kalshi",
        id: "KXBTC15M-TEST",
        ticker: "KXBTC15M-TEST",
        title: "BTC test market",
        url: "https://kalshi.com/markets/test",
        startTime: slot.startIso,
        endTime: slot.endIso,
        slotKey: slot.key,
      },
      status: "active",
      slotAligned: true,
      availabilityReason: null,
      feedHealth: {
        asset: "btc",
        venue: "kalshi",
        feedStatus: "ready",
        source: "ws",
        lastMessageAt: 1_000,
        stalenessMs: 0,
        details: [],
        subscriptions: [],
      },
      lastMessageAt: 1_000,
      source: "ws",
      stalenessMs: 0,
      orderbookLevels: { yesBids: [], noBids: [] },
      outcomes: { yes: outcome("YES"), no: outcome("NO") },
      targetPriceUsd: null,
      resolution: null,
      feeMultiplier: 0,
      feeType: "quadratic",
      lastTradeYesPrice: null,
      lastTradeNoPrice: null,
    };
  };

  it("accepts only a fresh aligned WS snapshot", () => {
    const polymarket = buildPolymarketQuote();
    const kalshi = buildKalshiQuote();
    expect(
      validateFinalWsEntrySnapshot(
        slot,
        intent.legs[0],
        intent.legs[1],
        polymarket,
        kalshi,
        DEFAULT_STRATEGY_CONFIG,
        1_000,
      ),
    ).toBeNull();

    polymarket.source = "rest-fallback";
    expect(
      validateFinalWsEntrySnapshot(
        slot,
        intent.legs[0],
        intent.legs[1],
        polymarket,
        kalshi,
        DEFAULT_STRATEGY_CONFIG,
        1_000,
      ),
    ).toContain("non-WS source");
  });

  it("rejects stale books and slot changes", () => {
    const polymarket = buildPolymarketQuote();
    const kalshi = buildKalshiQuote();
    polymarket.outcomes.down.chart.lastUpdatedAt = 0;
    expect(
      validateFinalWsEntrySnapshot(
        slot,
        intent.legs[0],
        intent.legs[1],
        polymarket,
        kalshi,
        DEFAULT_STRATEGY_CONFIG,
        2_000,
      ),
    ).toContain("stale or not WS");

    polymarket.outcomes.down.chart.lastUpdatedAt = 2_000;
    kalshi.ref.slotKey = "btc:other-slot";
    expect(
      validateFinalWsEntrySnapshot(
        slot,
        intent.legs[0],
        intent.legs[1],
        polymarket,
        kalshi,
        DEFAULT_STRATEGY_CONFIG,
        2_000,
      ),
    ).toContain("slot alignment changed");
  });

  it("requires executable depth on both legs at the final submission boundary", () => {
    const polymarket = buildPolymarketQuote();
    const kalshi = buildKalshiQuote();
    polymarket.orderbookLevels.downAsks = [[0.45, 100]];
    kalshi.orderbookLevels.noBids = [[0.55, 100]];

    expect(
      validateFinalWsEntryDepthCoverage(
        slot,
        intent.legs[0],
        intent.legs[1],
        polymarket,
        kalshi,
        DEFAULT_STRATEGY_CONFIG,
        1_000,
      ),
    ).toBeNull();

    // This would pass the configurable 50% scan threshold after safety factors,
    // but the final no-resize boundary must require the whole hedge.
    kalshi.orderbookLevels.noBids = [[0.55, 10]];
    expect(
      validateFinalWsEntryDepthCoverage(
        slot,
        intent.legs[0],
        intent.legs[1],
        polymarket,
        kalshi,
        DEFAULT_STRATEGY_CONFIG,
        1_000,
      ),
    ).toContain("executable depth coverage");
  });
});

function buildPosition(overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
  const base: PositionSnapshot = {
    id: "position-1",
    asset: "btc",
    venue: "polymarket",
    marketRef: "poly-market",
    outcome: "DOWN",
    size: 10,
    averagePrice: 0.45,
    currentPrice: 0.5,
    currentValueUsd: 5,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0.5,
    redeemable: false,
    mergeable: false,
    updatedAt: 1,
    raw: {},
  };

  return {
    ...base,
    ...overrides,
  };
}

function buildExecutionCandidate(overrides: Partial<ExecutionCandidate> = {}): ExecutionCandidate {
  return {
    asset: "btc",
    slotKey: "btc:slot-1",
    scanSequence: 1,
    capturedAt: 1_000,
    expiresAt: 2_000,
    combination: "POLY_DOWN_KALSHI_YES",
    projectedNetProfitUsd: 0.2,
    grossCost: 0.91,
    signalAgeMs: 0,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("late primary fill rescue eligibility", () => {
  it("allows rescue for primary-timeout failures without unwind activity", () => {
    expect(isLatePrimaryFillRescueEligible(buildIntent(), [])).toBe(true);
  });

  it("blocks rescue once hedge failure or unwind flow already started", () => {
    expect(
      isLatePrimaryFillRescueEligible(
        buildIntent({
          failureReason: "Hedge order failed",
        }),
        [],
      ),
    ).toBe(false);

    expect(
      isLatePrimaryFillRescueEligible(
        buildIntent({
          failureReason: "Primary unwind submission failed (boom); manual intervention required",
        }),
        [buildOrder()],
      ),
    ).toBe(false);
  });
});

describe("opportunity snapshot freshness", () => {
  it("accepts snapshots inside maxSignalAgeMs and rejects stale ones", () => {
    expect(isOpportunitySnapshotFresh({ capturedAt: 1_000 }, 1_999, 1_000)).toBe(true);
    expect(isOpportunitySnapshotFresh({ capturedAt: 1_000 }, 2_001, 1_000)).toBe(false);
  });

  it("clamps negative ages when clocks are equalized by fresh process time", () => {
    expect(getOpportunitySnapshotAgeMs({ capturedAt: 2_000 }, 1_900)).toBe(0);
  });
});

describe("worker hot path throttles", () => {
  it("refreshes idle execution readiness at one hertz", () => {
    expect(shouldRefreshIdleExecution(null, 1_000)).toBe(true);
    expect(shouldRefreshIdleExecution(1_000, 1_999)).toBe(false);
    expect(shouldRefreshIdleExecution(1_000, 2_000)).toBe(true);
  });

  it("syncs feed breakers immediately on transition and periodically while stable", () => {
    const previous = { signature: "btc:slot:ready", syncedAt: 1_000 };

    expect(shouldSyncFeedCircuitBreaker(previous, "btc:slot:ready", 5_999)).toBe(false);
    expect(shouldSyncFeedCircuitBreaker(previous, "btc:slot:ready", 6_000)).toBe(true);
    expect(shouldSyncFeedCircuitBreaker(previous, "btc:slot:kalshi:unavailable", 1_001)).toBe(true);
  });
});

describe("execution candidate arbitration", () => {
  it("selects the highest projected net profit among fresh candidates", () => {
    const winner = selectWinningExecutionCandidate(
      [
        buildExecutionCandidate({ asset: "btc", projectedNetProfitUsd: 0.18, capturedAt: 1_000 }),
        buildExecutionCandidate({ asset: "eth", projectedNetProfitUsd: 0.32, capturedAt: 950 }),
      ],
      1_010,
    );

    expect(winner?.asset).toBe("eth");
  });

  it("uses freshness and asset order as deterministic tie breakers", () => {
    expect(
      selectWinningExecutionCandidate(
        [
          buildExecutionCandidate({ asset: "eth", projectedNetProfitUsd: 0.2, capturedAt: 900 }),
          buildExecutionCandidate({ asset: "btc", projectedNetProfitUsd: 0.2, capturedAt: 950 }),
        ],
        1_000,
      )?.asset,
    ).toBe("btc");

    expect(
      selectWinningExecutionCandidate(
        [
          buildExecutionCandidate({ asset: "eth", projectedNetProfitUsd: 0.2, capturedAt: 950 }),
          buildExecutionCandidate({ asset: "btc", projectedNetProfitUsd: 0.2, capturedAt: 950 }),
        ],
        1_000,
      )?.asset,
    ).toBe("btc");
  });

  it("ignores expired candidates before any order path can run", () => {
    const winner = selectWinningExecutionCandidate(
      [
        buildExecutionCandidate({ asset: "btc", projectedNetProfitUsd: 1, expiresAt: 999 }),
        buildExecutionCandidate({ asset: "eth", projectedNetProfitUsd: 0.1, expiresAt: 1_500 }),
      ],
      1_000,
    );

    expect(winner?.asset).toBe("eth");
  });
});

describe("settlement venue resolutions", () => {
  it("requires actual venue outcomes instead of falling back to an external reference", () => {
    expect(
      deriveSettledVenueResolutions({
        polymarketResolution: "DOWN",
        kalshiResolution: "YES",
      }),
    ).toEqual({
      polyResolution: "DOWN",
      kalshiResolution: "YES",
    });

    expect(
      deriveSettledVenueResolutions({
        polymarketResolution: "DOWN",
        kalshiResolution: null,
      }),
    ).toBeNull();
  });

  it("accumulates official venue outcomes observed on different reconciliation polls", () => {
    expect(
      mergeObservedSlotResolutionOutcomes({
        storedSource: "official-venue-resolution",
        storedPolymarketResolution: "UP",
        storedKalshiResolution: null,
        fetchedPolymarketResolution: null,
        fetchedKalshiResolution: "NO",
      }),
    ).toEqual({
      polymarketResolution: "UP",
      kalshiResolution: "NO",
    });
  });

  it("does not promote snapshot outcomes to official truth when venue fetches are empty", () => {
    expect(
      mergeObservedSlotResolutionOutcomes({
        storedSource: "market-data-observation",
        storedPolymarketResolution: "UP",
        storedKalshiResolution: "NO",
        fetchedPolymarketResolution: null,
        fetchedKalshiResolution: null,
      }),
    ).toEqual({
      polymarketResolution: null,
      kalshiResolution: null,
    });
  });
});

describe("primary exit sizing", () => {
  it("caps the unwind size to the smallest observable polymarket inventory", () => {
    expect(
      derivePrimaryExitSize({
        filledSize: 20.04,
        positionSize: 20.04,
        sellableSize: 19.264187,
      }),
    ).toBe(19.264187);
  });

  it("falls back to the confirmed fill size when no fresher inventory snapshot exists", () => {
    expect(
      derivePrimaryExitSize({
        filledSize: 20.04,
        positionSize: null,
        sellableSize: null,
      }),
    ).toBe(20.04);
  });
});

describe("post-slot polymarket handling", () => {
  it("keeps an in-the-money polymarket leg for resolution instead of forcing a market exit", () => {
    expect(
      shouldKeepPolymarketLegForResolution(
        {
          venue: "polymarket",
          outcome: "DOWN",
          filledSize: 10,
          payoutUsd: null,
        },
        "DOWN",
      ),
    ).toBe(true);

    expect(
      shouldKeepPolymarketLegForResolution(
        {
          venue: "polymarket",
          outcome: "DOWN",
          filledSize: 10,
          payoutUsd: null,
        },
        "UP",
      ),
    ).toBe(false);
  });
});

describe("remaining exposure sizing", () => {
  it("derives the net primary exposure after unwind fills", () => {
    expect(deriveRemainingExposureSize(22.68, 21.67)).toBe(1.01);
    expect(deriveRemainingExposureSize(20.04, 20.04)).toBe(0);
  });
});

describe("hedge retry repricing", () => {
  it("can reprice the hedge leg from live venue liquidity without revalidating the whole pair", () => {
    const hedgeLeg = buildIntent({
      primaryVenue: "polymarket",
      hedgeVenue: "kalshi",
    }).legs[1];

    expect(
      deriveBufferedRetryLeg(
        hedgeLeg,
        {
          price: 0.42,
          depth: 25,
          minOrderSize: 1,
        },
        {
          executionPriceBuffer: 0.01,
          maxLegPrice: 0.49,
          maxSlippageBps: 30,
          minOrderSize: 5,
          kalshiDepthHeadroomContracts: 2,
        },
      ),
    ).toMatchObject({
      id: hedgeLeg.id,
      venue: "kalshi",
      requestedPrice: 0.42,
    });
  });

  it("adds one Kalshi order-price rung per hedge retry attempt", () => {
    const hedgeLeg = buildIntent({
      primaryVenue: "polymarket",
      hedgeVenue: "kalshi",
    }).legs[1];

    expect(
      deriveBufferedRetryLeg(
        hedgeLeg,
        {
          price: 0.42,
          depth: 25,
          minOrderSize: 1,
        },
        {
          executionPriceBuffer: 0.03,
          maxLegPrice: 0.49,
          maxSlippageBps: 0,
          minOrderSize: 5,
          kalshiDepthHeadroomContracts: 2,
        },
        3,
      ),
    ).toMatchObject({
      id: hedgeLeg.id,
      venue: "kalshi",
      requestedPrice: 0.44,
    });
  });

  it("refuses a Kalshi retry rung once the effective order price would exceed the allowed cap", () => {
    const hedgeLeg = buildIntent({
      primaryVenue: "polymarket",
      hedgeVenue: "kalshi",
    }).legs[1];

    expect(
      deriveBufferedRetryLeg(
        hedgeLeg,
        {
          price: 0.49,
          depth: 25,
          minOrderSize: 1,
        },
        {
          executionPriceBuffer: 0.01,
          maxLegPrice: 0.49,
          maxSlippageBps: 30,
          minOrderSize: 5,
          kalshiDepthHeadroomContracts: 2,
        },
        2,
      ),
    ).toBeNull();
  });

  it("allows a retry above the legacy leg-price cap when it stays inside the original price buffer", () => {
    const hedgeLeg = {
      ...buildIntent({
        primaryVenue: "polymarket",
        hedgeVenue: "kalshi",
      }).legs[1],
      requestedPrice: 0.58,
      requestedNotionalUsd: 11.6,
    };

    expect(
      deriveBufferedRetryLeg(
        hedgeLeg,
        {
          price: 0.585,
          depth: 25,
          minOrderSize: 1,
        },
        {
          executionPriceBuffer: 0.01,
          maxLegPrice: 0.49,
          maxSlippageBps: 0,
          minOrderSize: 5,
          kalshiDepthHeadroomContracts: 2,
        },
      ),
    ).toMatchObject({
      requestedPrice: 0.585,
      requestedNotionalUsd: 5.85,
    });
  });

  it("refuses a Kalshi retry when displayed depth only matches the order size without headroom", () => {
    const hedgeLeg = {
      ...buildIntent({
        primaryVenue: "polymarket",
        hedgeVenue: "kalshi",
      }).legs[1],
      requestedPrice: 0.48,
      requestedSize: 20,
      requestedNotionalUsd: 10,
    };

    expect(
      deriveBufferedRetryLeg(
        hedgeLeg,
        {
          price: 0.48,
          depth: 20,
          minOrderSize: 1,
        },
        {
          executionPriceBuffer: 0.01,
          maxLegPrice: 0.49,
          maxSlippageBps: 0,
          minOrderSize: 5,
          kalshiDepthHeadroomContracts: 2,
        },
      ),
    ).toBeNull();
  });

  it("reprices a polymarket hedge retry while preserving the size to cover", () => {
    const primaryLeg = {
      ...buildIntent().legs[0],
      requestedPrice: 0.45,
      requestedSize: 22.22,
      requestedNotionalUsd: 10,
    };

    expect(
      deriveBufferedRetryLeg(
        primaryLeg,
        {
          price: 0.46,
          depth: 25,
          minOrderSize: 5,
        },
        {
          executionPriceBuffer: 0.01,
          maxLegPrice: 0.49,
          maxSlippageBps: 30,
          minOrderSize: 5,
          kalshiDepthHeadroomContracts: 2,
        },
      ),
    ).toMatchObject({
      id: primaryLeg.id,
      venue: "polymarket",
      requestedPrice: 0.46,
      requestedSize: 22.22,
      requestedNotionalUsd: 10.2212,
    });
  });

  it("adds one Polymarket tick per retry attempt when repricing a polymarket leg", () => {
    const primaryLeg = {
      ...buildIntent().legs[0],
      requestedPrice: 0.45,
      requestedSize: 22.22,
      requestedNotionalUsd: 10,
    };

    expect(
      deriveBufferedRetryLeg(
        primaryLeg,
        {
          price: 0.458,
          depth: 25,
          minOrderSize: 5,
          tickSize: 0.001,
        },
        {
          executionPriceBuffer: 0.01,
          maxLegPrice: 0.49,
          maxSlippageBps: 30,
          minOrderSize: 5,
          kalshiDepthHeadroomContracts: 2,
        },
        3,
      ),
    ).toMatchObject({
      id: primaryLeg.id,
      venue: "polymarket",
      requestedPrice: 0.46,
      requestedSize: 22.22,
      requestedNotionalUsd: 10.2212,
    });
  });
});

describe("kalshi hedge safety guards", () => {
  it("requires the final Kalshi retry rung to remain inside the allowed cap", () => {
    const hedgeLeg = buildIntent({
      primaryVenue: "polymarket",
      hedgeVenue: "kalshi",
    }).legs[1];

    expect(
      hasKalshiHedgeRetryCapacity(
        hedgeLeg,
        {
          price: 0.42,
          depth: 25,
          minOrderSize: 1,
        },
        {
          executionPriceBuffer: 0.03,
          maxLegPrice: 0.49,
          maxSlippageBps: 0,
          minOrderSize: 5,
          kalshiDepthHeadroomContracts: 2,
        },
        3,
      ),
    ).toBe(true);

    expect(
      hasKalshiHedgeRetryCapacity(
        hedgeLeg,
        {
          price: 0.49,
          depth: 25,
          minOrderSize: 1,
        },
        {
          executionPriceBuffer: 0.01,
          maxLegPrice: 0.49,
          maxSlippageBps: 30,
          minOrderSize: 5,
          kalshiDepthHeadroomContracts: 2,
        },
        2,
      ),
    ).toBe(false);
  });
});

describe("venue order request sizing", () => {
  it("keeps Polymarket primary atomic while allowing partial immediate hedges", () => {
    expect(primaryImmediateOrderType("polymarket")).toBe("FOK");
    expect(primaryImmediateOrderType("kalshi")).toBe("IOC");
    expect(immediatePartialOrderType("polymarket")).toBe("FAK");
    expect(immediatePartialOrderType("kalshi")).toBe("IOC");
  });

  it("uses exact-share mode for Polymarket BUY hedges by default", () => {
    const polymarketLeg = {
      ...buildIntent().legs[0],
      requestedPrice: 0.42,
      requestedSize: 20,
      requestedNotionalUsd: 10,
    };

    const request = buildVenueOrderRequest(polymarketLeg, 30, "FOK", false);

    expect(request.price).toBeCloseTo(0.42126, 5);
    expect(request.size).toBe(20);
    expect(request.maxCostUsd).toBe(10);
    expect(request.buyMode).toBe("shares");
  });

  it("keeps kalshi max cost aligned to the derived order limit", () => {
    const kalshiLeg = {
      ...buildIntent().legs[1],
      requestedPrice: 0.42,
      requestedSize: 20,
      requestedNotionalUsd: 10,
    };

    const request = buildVenueOrderRequest(kalshiLeg, 30, "FOK", false);

    expect(request.price).toBe(0.43);
    expect(request.maxCostUsd).toBeCloseTo(8.6, 4);
  });

  it("can widen a Kalshi primary buy by whole ticks instead of only by basis points", () => {
    const kalshiLeg = {
      ...buildIntent().legs[1],
      requestedPrice: 0.48,
      requestedSize: 20,
      requestedNotionalUsd: 9.6,
    };

    const request = buildVenueOrderRequest(kalshiLeg, 30, "IOC", false, {
      kalshiPriceTicksSlippage: 2,
    });

    expect(request.price).toBe(0.5);
    expect(request.maxCostUsd).toBe(10);
  });

  it("blocks Polymarket hedge entries whose projected hedge notional is below the $1 CLOB floor", () => {
    expect(
      getPolymarketHedgeMinNotionalViolation({
        venue: "polymarket",
        side: "BUY",
        requestedNotionalUsd: 0.65,
      }),
    ).toEqual({
      requestedNotionalUsd: 0.65,
      minimumNotionalUsd: 1,
    });

    expect(
      getPolymarketHedgeMinNotionalViolation({
        venue: "polymarket",
        side: "BUY",
        requestedNotionalUsd: 1,
      }),
    ).toBeNull();

    expect(
      getPolymarketHedgeSubmissionBlock({
        venue: "polymarket",
        side: "BUY",
        requestedNotionalUsd: 0.65,
      }),
    ).toEqual({
      action: "manual_required",
      stage: "polymarket_hedge_below_minimum_notional",
      requestedNotionalUsd: 0.65,
      minimumNotionalUsd: 1,
    });
  });
});

describe("Kalshi primary IOC handling", () => {
  it("uses fast first-entry preparation only for fresh Kalshi-primary signals", () => {
    expect(
      shouldUseFastKalshiPrimaryPreparation(
        {
          primaryVenue: "kalshi",
        },
        1_000,
        1_000,
      ),
    ).toBe(true);

    expect(
      shouldUseFastKalshiPrimaryPreparation(
        {
          primaryVenue: "kalshi",
        },
        999,
        1_000,
      ),
    ).toBe(false);

    expect(
      shouldUseFastKalshiPrimaryPreparation(
        {
          primaryVenue: "polymarket",
        },
        1_000,
        1_000,
      ),
    ).toBe(false);
  });

  it("builds descending fallback clips around 20, 10, then 5 contracts", () => {
    expect(deriveKalshiPrimaryFallbackClipPlan(22)).toEqual([20, 10, 5]);
    expect(deriveKalshiPrimaryFallbackClipPlan(16)).toEqual([16, 10, 5]);
    expect(deriveKalshiPrimaryFallbackClipPlan(7)).toEqual([7, 5]);
  });

  it("caps a fast Kalshi primary clip without repricing the signal", () => {
    const intent = buildIntent({
      primaryVenue: "kalshi",
      hedgeVenue: "polymarket",
      grossCost: 0.91,
      legs: [
        {
          ...buildIntent().legs[0],
          id: "leg-hedge",
          venue: "polymarket",
          requestedPrice: 0.46,
          requestedSize: 22,
          requestedNotionalUsd: 10.12,
        },
        {
          ...buildIntent().legs[1],
          id: "leg-primary",
          venue: "kalshi",
          requestedPrice: 0.45,
          requestedSize: 22,
          requestedNotionalUsd: 9.9,
        },
      ],
    });

    const clipped = deriveFastKalshiPrimaryClipIntent(intent, "leg-primary", 10, 123);

    expect(clipped?.grossCost).toBe(0.91);
    expect(clipped?.updatedAt).toBe(123);
    expect(clipped?.legs.find((leg) => leg.id === "leg-primary")).toMatchObject({
      requestedPrice: 0.45,
      requestedSize: 10,
      requestedNotionalUsd: 4.5,
    });
    expect(clipped?.legs.find((leg) => leg.id === "leg-hedge")).toMatchObject({
      requestedPrice: 0.46,
      requestedSize: 22,
    });
  });

  it("treats a partial Kalshi primary order as hedgable when contracts actually filled", () => {
    expect(
      shouldTreatPrimaryOrderAsFilled(
        { primaryVenue: "kalshi" },
        {
          filledSize: 3,
          orderType: "IOC",
          requestedSize: 10,
          status: "partially_filled",
        },
      ),
    ).toBe(true);

    expect(
      shouldTreatPrimaryExecutionAsFilled(
        { primaryVenue: "kalshi" },
        {
          venue: "kalshi",
          venueOrderId: "kal-1",
          filledSize: 3,
          averageFillPrice: 0.48,
          feeUsd: 0.01,
          status: "partially_filled",
          raw: {},
        },
        {
          filledSize: 3,
          orderType: "IOC",
          requestedSize: 10,
          status: "partially_filled",
        },
      ),
    ).toBe(true);
  });

  it("does not treat a partial Polymarket primary order as filled", () => {
    expect(
      shouldTreatPrimaryOrderAsFilled(
        { primaryVenue: "polymarket" },
        {
          filledSize: 3,
          orderType: "FOK",
          requestedSize: 10,
          status: "partially_filled",
        },
      ),
    ).toBe(false);
  });

  it("hedges a fully matched Polymarket FOK while venue truth is still pending", () => {
    const pendingFullOrder = {
      filledSize: 10,
      orderType: "FOK",
      requestedSize: 10,
      status: "pending" as const,
    };

    expect(shouldTreatPrimaryOrderAsFilled({ primaryVenue: "polymarket" }, pendingFullOrder)).toBe(true);
    expect(
      shouldTreatPrimaryExecutionAsFilled(
        { primaryVenue: "polymarket" },
        {
          venue: "polymarket",
          venueOrderId: "poly-1",
          filledSize: 10,
          averageFillPrice: 0.48,
          feeUsd: 0,
          status: "pending",
          raw: {
            orderTruth: {
              expectedSizeSatisfied: true,
              hasPendingExposure: true,
            },
          },
        },
        pendingFullOrder,
      ),
    ).toBe(true);
  });

  it("requires a complete Polymarket primary fill before resume can hedge it", () => {
    expect(isPrimaryFillSizeHedgable({ primaryVenue: "polymarket" }, { filledSize: 9, requestedSize: 10 })).toBe(false);
    expect(isPrimaryFillSizeHedgable({ primaryVenue: "polymarket" }, { filledSize: 10, requestedSize: 10 })).toBe(true);
    expect(isPrimaryFillSizeHedgable({ primaryVenue: "kalshi" }, { filledSize: 1, requestedSize: 10 })).toBe(true);
  });

  it("requires a Polymarket hedge to cover the requested size before marking it complete", () => {
    const hedgeLeg = {
      ...buildIntent().legs[0],
      venue: "polymarket" as const,
      requestedSize: 9,
    };

    expect(
      shouldTreatHedgeOrderAsComplete(hedgeLeg, {
        filledSize: 8.99,
        status: "filled",
      }),
    ).toBe(false);

    expect(
      shouldTreatHedgeOrderAsComplete(hedgeLeg, {
        filledSize: 9,
        status: "pending",
      }),
    ).toBe(true);

    expect(
      shouldTreatHedgeOrderAsComplete(hedgeLeg, {
        filledSize: 10,
        status: "filled",
      }),
    ).toBe(false);
  });

  it("classifies a small profitable hedge overfill as benign", () => {
    const evaluation = evaluateBenignHedgeOverfill(buildKalshiPrimaryPolymarketHedgeIntent(), {
      minWorstCaseProfitUsd: 0.25,
    });

    expect(evaluation.benign).toBe(true);
    expect(evaluation.overfilledHedgeSize).toBeCloseTo(0.2, 6);
    expect(evaluation.overfillNotionalUsd).toBeCloseTo(0.098, 6);
    expect(evaluation.economics.netWorstCaseUsd).toBeCloseTo(0.662, 6);
  });

  it("rejects hedge overfills that are too large even when still profitable", () => {
    const evaluation = evaluateBenignHedgeOverfill(
      buildKalshiPrimaryPolymarketHedgeIntent({ polymarketFilledSize: 10.7 }),
      {
        minWorstCaseProfitUsd: 0.25,
      },
    );

    expect(evaluation.economicallyCovered).toBe(true);
    expect(evaluation.overfillNotionalUsd).toBeCloseTo(0.343, 6);
    expect(evaluation.benign).toBe(false);
  });

  it("rejects small hedge overfills when the actual pair is not economically covered", () => {
    const evaluation = evaluateBenignHedgeOverfill(buildKalshiPrimaryPolymarketHedgeIntent({ kalshiPrice: 0.49 }), {
      minWorstCaseProfitUsd: 0.25,
    });

    expect(evaluation.overfillNotionalUsd).toBeCloseTo(0.098, 6);
    expect(evaluation.economicallyCovered).toBe(false);
    expect(evaluation.benign).toBe(false);
  });

  it("allows Polymarket BUY hedge retries only after terminal zero-fill truth", () => {
    expect(
      shouldRetryTerminalZeroFillHedge(
        { hedgeVenue: "polymarket" },
        { venue: "polymarket", side: "BUY" },
        {
          status: "canceled",
          filledSize: 0,
          raw: {
            orderTruth: {
              terminalZeroFill: true,
            },
          },
        },
      ),
    ).toBe(true);

    expect(
      shouldRetryTerminalZeroFillHedge(
        { hedgeVenue: "polymarket" },
        { venue: "polymarket", side: "BUY" },
        {
          status: "canceled",
          filledSize: 0,
          raw: {
            orderTruth: {
              terminalZeroFill: false,
              pendingFilledSize: 10,
            },
          },
        },
      ),
    ).toBe(false);

    expect(
      shouldRetryTerminalZeroFillHedge(
        { hedgeVenue: "polymarket" },
        { venue: "polymarket", side: "BUY" },
        {
          status: "canceled",
          filledSize: 0,
          raw: {
            softNoFill: true,
            error: "order couldn't be fully filled. FOK orders are fully filled or killed.",
          },
        },
      ),
    ).toBe(false);
  });

  it("keeps soft Polymarket hedge no-fills pending regardless of age until truth is authoritative", () => {
    const now = 1774899060000;
    const hedgeLeg = { venue: "polymarket" as const, side: "BUY" as const };
    const softNoFillOrder = {
      status: "canceled" as const,
      filledSize: 0,
      venueOrderId: "killed:order-1",
      raw: {
        softNoFill: true,
        orderTruth: {
          terminalZeroFill: false,
        },
      },
    };

    expect(
      shouldHoldPolymarketHedgeFailurePendingTruth(
        {
          hedgeVenue: "polymarket",
          status: "truth_pending",
          updatedAt: now - 9_000,
        },
        hedgeLeg,
        softNoFillOrder,
        now,
      ),
    ).toBe(true);

    expect(
      shouldHoldPolymarketHedgeFailurePendingTruth(
        {
          hedgeVenue: "polymarket",
          status: "truth_pending",
          updatedAt: now - 11_000,
        },
        hedgeLeg,
        softNoFillOrder,
        now,
      ),
    ).toBe(true);
  });

  it("keeps holding when Polymarket reports pending exposure truth", () => {
    const now = 1774899060000;

    expect(
      shouldHoldPolymarketHedgeFailurePendingTruth(
        {
          hedgeVenue: "polymarket",
          status: "truth_pending",
          updatedAt: now - 60_000,
        },
        { venue: "polymarket", side: "BUY" },
        {
          status: "canceled",
          filledSize: 0,
          venueOrderId: "killed:order-1",
          raw: {
            orderTruth: {
              terminalZeroFill: false,
              pendingFilledSize: 5,
            },
          },
        },
        now,
      ),
    ).toBe(true);
  });

  it("holds an acknowledged rescue while venue truth is nonterminal", () => {
    expect(
      shouldHoldHedgeRescueOrderPendingTruth(
        {
          hedgeVenue: "polymarket",
          status: "rescue_hedge",
          updatedAt: 1_000,
        },
        { venue: "polymarket", side: "BUY" },
        {
          status: "live",
          filledSize: 0,
          venueOrderId: "rescue-order-1",
          raw: {
            orderTruth: {
              terminalZeroFill: true,
            },
          },
        },
        2_000,
      ),
    ).toBe(true);
  });
});

describe("forced unwind request pricing", () => {
  it("can override the request price when building a reduce-only Kalshi sell", () => {
    const intent = buildIntent({
      primaryVenue: "kalshi",
      legs: [
        {
          ...buildIntent().legs[1],
          venue: "kalshi",
          side: "SELL",
          requestedPrice: 0.52,
          requestedSize: 7,
          requestedNotionalUsd: 3.64,
        },
        buildIntent().legs[0],
      ],
    });

    const request = buildVenueOrderRequest(intent.legs[0], 30, "IOC", true, {
      overridePrice: 0.47,
    });

    expect(request.price).toBe(0.47);
    expect(request.reduceOnly).toBe(true);
    expect(request.side).toBe("SELL");
  });

  it("estimates primary unwind loss from the filled entry and expected exit", () => {
    expect(estimatePrimaryUnwindLossUsd(buildIntent().legs[0], 7, 0.4)).toBe(0.35);
    expect(estimatePrimaryUnwindLossUsd(buildIntent().legs[0], 7, 0.5)).toBe(0);
  });
});

describe("primary unwind completion", () => {
  it("trusts a venue-filled unwind order even when the local requested size is higher", () => {
    expect(
      shouldTreatPrimaryUnwindOrderAsComplete({
        status: "filled",
        filledSize: 8.999,
        requestedSize: 9,
      }),
    ).toBe(true);
  });

  it("does not treat no-fill terminal unwind orders as complete", () => {
    expect(
      shouldTreatPrimaryUnwindOrderAsComplete({
        status: "canceled",
        filledSize: 0,
        requestedSize: 9,
      }),
    ).toBe(false);
  });
});

describe("Polymarket reconciliation status monotonicity", () => {
  it.each(["live", "partially_filled", "filled", "canceled", "rejected", "expired"] as const)(
    "does not downgrade an existing %s order when venue trades are only pending",
    (status) => {
      expect(mergePolymarketTradeObservationStatus(status, "pending")).toBe(status);
    },
  );

  it("keeps an already pending order pending", () => {
    expect(mergePolymarketTradeObservationStatus("pending", "pending")).toBe("pending");
  });

  it("accepts a non-pending trade observation", () => {
    expect(mergePolymarketTradeObservationStatus("pending", "filled")).toBe("filled");
  });
});

describe("retryable polymarket unwind errors", () => {
  it("treats inventory sync errors as retryable", () => {
    expect(
      isRetryablePolymarketInventorySyncError(
        new Error(
          "not enough balance / allowance: the balance is not enough -> balance: 19264187, order amount: 20040000",
        ),
      ),
    ).toBe(true);

    expect(isRetryablePolymarketInventorySyncError(new Error("Unable to unwind intent x: no exitable size"))).toBe(
      true,
    );
    expect(isRetryablePolymarketInventorySyncError(new Error("authentication failed"))).toBe(false);
  });
});

describe("slot execution breakers", () => {
  it("ignores slot breakers from old slots when evaluating the current slot", () => {
    expect(isBreakerRelevantToSlot({ key: "global" }, "btc", "btc:slot-2")).toBe(true);
    expect(isBreakerRelevantToSlot({ key: "asset:btc" }, "btc", "btc:slot-2")).toBe(true);
    expect(isBreakerRelevantToSlot({ key: "slot:btc:slot-2" }, "btc", "btc:slot-2")).toBe(true);
    expect(isBreakerRelevantToSlot({ key: "slot:btc:slot-1" }, "btc", "btc:slot-2")).toBe(false);
  });

  it("does not keep a recovered slot hedge breaker active just because it is the current slot", () => {
    const breaker: Pick<CircuitBreaker, "active" | "key" | "payload" | "reason"> = {
      key: "slot:btc:slot-1",
      active: true,
      reason: "hedge_failure",
      payload: {
        lockSlot: true,
      },
    };

    expect(shouldKeepSlotExecutionBreakerActive(breaker, 100, new Set(["btc:slot-1"]), new Set())).toBe(false);
    expect(shouldKeepSlotExecutionBreakerActive(breaker, 100, new Set(["btc:slot-2"]), new Set())).toBe(false);
  });

  it("keeps a slot hedge breaker active while the slot still has unresolved exposure", () => {
    const breaker: Pick<CircuitBreaker, "active" | "key" | "payload" | "reason"> = {
      key: "slot:btc:slot-1",
      active: true,
      reason: "hedge_failure",
      payload: {
        stage: "hedge_failure_unwind_pending",
      },
    };

    expect(shouldKeepSlotExecutionBreakerActive(breaker, 100, new Set(["btc:slot-1"]), new Set(["btc:slot-1"]))).toBe(
      true,
    );
    expect(shouldKeepSlotExecutionBreakerActive(breaker, 100, new Set(["btc:slot-1"]), new Set())).toBe(false);
  });

  it("keeps a global hedge breaker active through its cooldown", () => {
    const breaker: Pick<CircuitBreaker, "active" | "key" | "payload" | "reason"> = {
      key: "global",
      active: true,
      reason: "hedge_failure",
      payload: {
        cooldownUntil: 200,
      },
    };

    expect(shouldKeepSlotExecutionBreakerActive(breaker, 150, new Set(["btc:slot-1"]), new Set())).toBe(true);
    expect(shouldKeepSlotExecutionBreakerActive(breaker, 250, new Set(["btc:slot-1"]), new Set())).toBe(false);
  });

  it("pauses live execution while any global breaker remains active", () => {
    const breaker: Pick<CircuitBreaker, "active" | "key" | "payload" | "reason"> = {
      key: "global",
      active: true,
      reason: "hedge_failure",
      payload: {
        cooldownUntil: 200,
      },
    };

    expect(shouldPauseExecutionForBreaker(breaker, 150, "btc", "btc:slot-1")).toBe(true);
    expect(shouldPauseExecutionForBreaker(breaker, 250, "btc", "btc:slot-1")).toBe(true);
  });

  it("keeps a manual-clear global hedge breaker active until an operator clears it", () => {
    const breaker: Pick<CircuitBreaker, "active" | "key" | "payload" | "reason"> = {
      key: "global",
      active: true,
      reason: "hedge_failure",
      payload: {
        requiresManualClear: true,
      },
    };

    expect(shouldKeepSlotExecutionBreakerActive(breaker, 1_000, new Set(["btc:slot-1"]), new Set())).toBe(true);
  });

  it("does not keep a primary no-fill slot breaker active without cooldown or unresolved exposure", () => {
    const breaker: Pick<CircuitBreaker, "active" | "key" | "payload" | "reason"> = {
      key: "slot:eth:slot-1",
      active: true,
      reason: "primary_no_fill",
      payload: {
        lockSlot: true,
        stage: "primary_no_fill_slot_lock",
      },
    };

    expect(shouldKeepSlotExecutionBreakerActive(breaker, 100, new Set(["eth:slot-1"]), new Set())).toBe(false);
    expect(shouldKeepSlotExecutionBreakerActive(breaker, 100, new Set(["eth:slot-2"]), new Set())).toBe(false);
  });

  it("lets preflight skip slot breakers expire after their short cooldown", () => {
    const breaker: Pick<CircuitBreaker, "active" | "key" | "payload" | "reason"> = {
      key: "slot:eth:slot-1",
      active: true,
      reason: "primary_no_fill",
      payload: {
        stage: "preflight_skipped",
        cooldownUntil: 200,
      },
    };

    expect(shouldKeepSlotExecutionBreakerActive(breaker, 150, new Set(["eth:slot-1"]), new Set())).toBe(true);
    expect(shouldKeepSlotExecutionBreakerActive(breaker, 250, new Set(["eth:slot-1"]), new Set())).toBe(false);
  });
});

describe("Polymarket hedge preflight helpers", () => {
  it("sums only ask depth executable within the hedge limit price", () => {
    expect(
      sumPolymarketAskDepthWithinLimit(
        [
          { price: "0.12", size: "3" },
          { price: "0.13", size: "4" },
          { price: "0.14", size: "100" },
        ],
        0.13,
      ),
    ).toBe(7);
  });

  it("applies safety factor and headroom to Polymarket hedge depth", () => {
    expect(deriveSafePolymarketHedgeDepth(10, 0.8, 1)).toBe(7);
    expect(deriveSafePolymarketHedgeDepth(1, 0.8, 1)).toBe(0);
  });

  it("quotes Polymarket buy VWAP from executable asks", () => {
    expect(
      quotePolymarketBuyFromAsks(
        [
          { price: "0.12", size: "3" },
          { price: "0.13", size: "4" },
          { price: "0.14", size: "100" },
        ],
        0.13,
        5,
      ),
    ).toEqual({
      filledSize: 5,
      costUsd: 0.62,
      vwap: 0.124,
    });
  });
});

describe("recovery option evaluation", () => {
  it("chooses a full rescue hedge inside the loss cap", () => {
    expect(
      evaluateExposureRecoveryOptions({
        rescueHedgeLossUsd: 0.2,
        rescueHedgeSize: 9,
        unhedgedSize: 9,
        unwindLossUsd: 0.5,
        holdExpectedLossUsd: null,
        holdWorstCaseLossUsd: null,
        hedgeRescueMaxLossUsd: 1,
        hedgeRescueMinAdvantageUsd: 0.05,
        secondsToSettlement: 400,
        holdWindowSeconds: 45,
        allowPartial: true,
      }),
    ).toMatchObject({ decision: "rescue_hedge_full" });
  });

  it("chooses a partial rescue hedge when it is cheaper than unwind", () => {
    expect(
      evaluateExposureRecoveryOptions({
        rescueHedgeLossUsd: 0.2,
        rescueHedgeSize: 5,
        unhedgedSize: 9,
        unwindLossUsd: 0.4,
        holdExpectedLossUsd: null,
        holdWorstCaseLossUsd: null,
        hedgeRescueMaxLossUsd: 1,
        hedgeRescueMinAdvantageUsd: 0.05,
        secondsToSettlement: 400,
        holdWindowSeconds: 45,
        allowPartial: true,
      }),
    ).toMatchObject({ decision: "rescue_hedge_partial" });
  });

  it("rejects partial rescue hedges when partial rescue is disabled", () => {
    expect(
      evaluateExposureRecoveryOptions({
        rescueHedgeLossUsd: 0.2,
        rescueHedgeSize: 5,
        unhedgedSize: 9,
        unwindLossUsd: 0.4,
        holdExpectedLossUsd: null,
        holdWorstCaseLossUsd: null,
        hedgeRescueMaxLossUsd: 1,
        hedgeRescueMinAdvantageUsd: 0.05,
        secondsToSettlement: 400,
        holdWindowSeconds: 45,
        allowPartial: false,
      }),
    ).toMatchObject({ decision: "unwind" });
  });

  it("chooses hold near settlement when EV and worst case fit the cap", () => {
    expect(
      evaluateExposureRecoveryOptions({
        rescueHedgeLossUsd: 0.6,
        rescueHedgeSize: 0,
        unhedgedSize: 5,
        unwindLossUsd: 0.5,
        holdExpectedLossUsd: 0.1,
        holdWorstCaseLossUsd: 0.8,
        hedgeRescueMaxLossUsd: 1,
        hedgeRescueMinAdvantageUsd: 0.05,
        secondsToSettlement: 20,
        holdWindowSeconds: 45,
        allowPartial: true,
      }),
    ).toMatchObject({ decision: "hold_to_settlement" });
  });

  it("falls back to unwind when rescue is too expensive", () => {
    expect(
      evaluateExposureRecoveryOptions({
        rescueHedgeLossUsd: 1.2,
        rescueHedgeSize: 9,
        unhedgedSize: 9,
        unwindLossUsd: 0.4,
        holdExpectedLossUsd: 0.8,
        holdWorstCaseLossUsd: 2,
        hedgeRescueMaxLossUsd: 1,
        hedgeRescueMinAdvantageUsd: 0.05,
        secondsToSettlement: 20,
        holdWindowSeconds: 45,
        allowPartial: true,
      }),
    ).toMatchObject({ decision: "unwind" });
  });

  it("estimates the locked loss of a rescue hedge", () => {
    expect(
      estimateRescueHedgeLossUsd({
        primaryEntryPrice: 0.53,
        hedgePrice: 0.49,
        size: 10,
      }),
    ).toBe(0.2);
  });

  it("includes hedge fees when enforcing the rescue loss cap", () => {
    const lossWithFee = estimateRescueHedgeLossUsd({
      primaryEntryPrice: 0.53,
      hedgePrice: 0.49,
      size: 10,
      hedgeFeeUsd: 0.01,
    });

    expect(lossWithFee).toBe(0.21);
    expect(
      evaluateExposureRecoveryOptions({
        rescueHedgeLossUsd: lossWithFee,
        rescueHedgeSize: 10,
        unhedgedSize: 10,
        unwindLossUsd: 0.5,
        holdExpectedLossUsd: null,
        holdWorstCaseLossUsd: null,
        hedgeRescueMaxLossUsd: 0.2,
        hedgeRescueMinAdvantageUsd: 0.05,
        secondsToSettlement: 60,
        holdWindowSeconds: 45,
        allowPartial: false,
      }),
    ).toMatchObject({ decision: "unwind" });
  });

  it("accepts a fully hedged rescue loss only inside its explicit cap", () => {
    const rescuedIntent = buildKalshiPrimaryPolymarketHedgeIntent({
      kalshiPrice: 0.417,
      kalshiFeeUsd: 0.17,
      polymarketPrice: 0.586,
      polymarketFilledSize: 10,
    });
    const economics = deriveHedgedPairEconomics(rescuedIntent.legs);

    expect(economics.netWorstCaseUsd).toBe(-0.2);
    expect(isHedgedPairEconomicsWithinLossCap(economics, 0.2)).toBe(true);
    expect(isHedgedPairEconomicsWithinLossCap(economics, 0.19)).toBe(false);
    expect(isHedgedPairEconomicsWithinLossCap(economics)).toBe(false);
  });
});

describe("feed breaker management", () => {
  it("recognizes feed-health slot breakers from their payload shape", () => {
    expect(
      isFeedHealthBreaker({
        reason: "venue_error",
        payload: {
          feeds: [
            {
              venue: "kalshi",
            },
          ],
        },
      }),
    ).toBe(true);

    expect(
      isFeedHealthBreaker({
        reason: "hedge_failure",
        payload: {
          lockSlot: true,
        },
      }),
    ).toBe(false);
  });

  it("does not let feed sync overwrite an active execution slot lock", () => {
    expect(
      shouldManageFeedHealthBreaker({
        active: true,
        reason: "primary_no_fill",
        payload: {
          lockSlot: true,
          stage: "primary_no_fill_slot_lock",
        },
      }),
    ).toBe(false);

    expect(
      shouldManageFeedHealthBreaker({
        active: true,
        reason: "venue_error",
        payload: {
          feeds: [],
        },
      }),
    ).toBe(true);
  });
});

describe("primary retry plan", () => {
  it("uses the configured multi-attempt retry plan for Kalshi soft no-fills", () => {
    expect(
      resolvePrimaryRetryPlan(
        "kalshi",
        {
          raw: {
            softNoFill: true,
          },
        },
        {
          primaryRetryAttempts: 2,
          primaryRetryDelayMs: 200,
        },
      ),
    ).toEqual({
      attempts: 2,
      retryDelayMs: 200,
    });
  });

  it("keeps a single immediate retry for non-soft or non-Kalshi failures", () => {
    expect(
      resolvePrimaryRetryPlan(
        "kalshi",
        {
          raw: {},
        },
        {
          primaryRetryAttempts: 4,
          primaryRetryDelayMs: 500,
        },
      ),
    ).toEqual({
      attempts: 1,
      retryDelayMs: 0,
    });

    expect(
      resolvePrimaryRetryPlan(
        "polymarket",
        {
          raw: {
            softNoFill: true,
          },
        },
        {
          primaryRetryAttempts: 4,
          primaryRetryDelayMs: 500,
        },
      ),
    ).toEqual({
      attempts: 1,
      retryDelayMs: 0,
    });
  });

  it("moves Kalshi multi-clip fallback directly to the next clip after a soft no-fill", () => {
    expect(
      resolveKalshiPrimaryMultiClipRetryPlan("kalshi", {
        raw: {
          softNoFill: true,
        },
      }),
    ).toEqual({
      attempts: 0,
      retryDelayMs: 0,
    });

    expect(
      resolveKalshiPrimaryMultiClipRetryPlan("kalshi", {
        raw: {},
      }),
    ).toEqual({
      attempts: 1,
      retryDelayMs: 0,
    });
  });
});

describe("kalshi soft no-fill escalation", () => {
  it("counts only recent Kalshi soft hedge no-fills toward the global breaker threshold", () => {
    const events: Pick<RunEvent, "createdAt" | "eventType" | "payload">[] = [
      {
        createdAt: 1_000,
        eventType: "order.hedge.no_fill",
        payload: {
          venue: "kalshi",
          softNoFill: true,
          slotKey: "slot-1",
        },
      },
      {
        createdAt: 2_000,
        eventType: "order.hedge.no_fill",
        payload: {
          venue: "kalshi",
          softNoFill: true,
          slotKey: "slot-2",
        },
      },
      {
        createdAt: 2_500,
        eventType: "order.hedge.no_fill",
        payload: {
          venue: "polymarket",
          softNoFill: true,
        },
      },
      {
        createdAt: 100,
        eventType: "order.hedge.no_fill",
        payload: {
          venue: "kalshi",
          softNoFill: true,
        },
      },
    ];

    expect(countRecentKalshiSoftHedgeNoFillEvents(events, 2_500, 2_000)).toBe(2);
  });

  it("does not count recent Polymarket soft hedge no-fills toward the Kalshi threshold", () => {
    const events: Pick<RunEvent, "createdAt" | "eventType" | "payload">[] = [
      {
        createdAt: 1_000,
        eventType: "order.hedge.no_fill",
        payload: {
          venue: "polymarket",
          softNoFill: true,
          slotKey: "slot-1",
        },
      },
      {
        createdAt: 2_000,
        eventType: "order.hedge.no_fill",
        payload: {
          venue: "polymarket",
          softNoFill: true,
          slotKey: "slot-2",
        },
      },
    ];

    expect(countRecentKalshiSoftHedgeNoFillEvents(events, 2_500, 2_000)).toBe(0);
  });

  it("counts only recent Kalshi soft primary no-fills toward the primary slot lock telemetry", () => {
    const events: Pick<RunEvent, "createdAt" | "eventType" | "payload">[] = [
      {
        createdAt: 1_000,
        eventType: "order.primary.no_fill",
        payload: {
          venue: "kalshi",
          softNoFill: true,
          slotKey: "slot-1",
        },
      },
      {
        createdAt: 2_000,
        eventType: "order.primary.no_fill",
        payload: {
          venue: "kalshi",
          softNoFill: true,
          slotKey: "slot-2",
        },
      },
      {
        createdAt: 2_100,
        eventType: "order.primary.no_fill",
        payload: {
          venue: "polymarket",
          softNoFill: true,
          slotKey: "slot-3",
        },
      },
      {
        createdAt: 2_200,
        eventType: "order.primary.no_fill",
        payload: {
          venue: "kalshi",
          softNoFill: false,
          slotKey: "slot-4",
        },
      },
    ];

    expect(countRecentKalshiSoftPrimaryNoFillEvents(events, 2_500, 2_000)).toBe(2);
  });
});

describe("polymarket closed orderbook errors", () => {
  it("detects when a token orderbook has disappeared", () => {
    expect(
      isPolymarketOrderbookUnavailableError(
        new Error(
          "the orderbook 110016697850489733765199292378131676749047131268297622626845863046634270666333 does not exist",
        ),
      ),
    ).toBe(true);
    expect(isPolymarketOrderbookUnavailableError(new Error("market not found"))).toBe(false);
  });
});

describe("intent fill summaries", () => {
  it("aggregates multiple primary entry orders for the same leg", () => {
    const kalshiLeg = buildIntent({
      primaryVenue: "kalshi",
      hedgeVenue: "polymarket",
      legs: [
        {
          id: "leg-hedge",
          intentId: "intent-1",
          venue: "polymarket",
          outcome: "DOWN",
          marketRef: "poly-market",
          tokenId: "token-1",
          side: "BUY",
          requestedPrice: 0.45,
          requestedSize: 22,
          requestedNotionalUsd: 9.9,
          filledPrice: null,
          filledSize: 0,
          feeUsd: 0,
          status: "pending",
          venueOrderId: null,
          payoutUsd: null,
          resolvedOutcome: null,
        },
        {
          id: "leg-primary",
          intentId: "intent-1",
          venue: "kalshi",
          outcome: "YES",
          marketRef: "kalshi-market",
          side: "BUY",
          requestedPrice: 0.45,
          requestedSize: 22,
          requestedNotionalUsd: 9.9,
          filledPrice: null,
          filledSize: 0,
          feeUsd: 0,
          status: "pending",
          venueOrderId: null,
          payoutUsd: null,
          resolvedOutcome: null,
        },
      ],
    }).legs[1];

    const summary = summarizeIntentLegOrders(
      [
        buildOrder({
          venue: "kalshi",
          side: "BUY",
          outcome: "YES",
          marketRef: "kalshi-market",
          venueOrderId: "kalshi-clip-2",
          filledSize: 7,
          averageFillPrice: 0.46,
          feeUsd: 0.13,
          status: "filled",
          updatedAt: 2,
        }),
        buildOrder({
          venue: "kalshi",
          side: "BUY",
          outcome: "YES",
          marketRef: "kalshi-market",
          venueOrderId: "kalshi-clip-1",
          filledSize: 8,
          averageFillPrice: 0.45,
          feeUsd: 0.14,
          status: "filled",
          updatedAt: 1,
        }),
      ],
      kalshiLeg,
      "entry",
    );

    expect(summary).toEqual({
      filledSize: 15,
      averageFillPrice: 0.4547,
      feeUsd: 0.27,
      venueOrderId: "kalshi-clip-2",
      lastFilledAt: 2,
    });
  });

  it("separates entry fills from unwind fills on the same venue", () => {
    const leg = buildIntent().legs[0];
    const fills: LiveFill[] = [
      {
        id: "fill-buy",
        asset: "btc",
        shadow: false,
        intentId: "intent-1",
        venue: "polymarket",
        venueOrderId: "buy-1",
        tradeId: "trade-buy",
        marketRef: "poly-market",
        tokenId: "token-1",
        side: "BUY",
        outcome: "DOWN",
        price: 0.38,
        size: 22.68,
        feeUsd: 0.86,
        liquidity: "TAKER",
        filledAt: 1,
        raw: {},
      },
      {
        id: "fill-sell",
        asset: "btc",
        shadow: false,
        intentId: "intent-1",
        venue: "polymarket",
        venueOrderId: "sell-1",
        tradeId: "trade-sell",
        marketRef: "poly-market",
        tokenId: "token-1",
        side: "SELL",
        outcome: "DOWN",
        price: 0.4,
        size: 21.67,
        feeUsd: 0.87,
        liquidity: "TAKER",
        filledAt: 2,
        raw: {},
      },
    ];

    expect(summarizeIntentLegFills(fills, leg, "entry")?.filledSize).toBe(22.68);
    expect(summarizeIntentLegFills(fills, leg, "exit")?.filledSize).toBe(21.67);
  });
});

describe("live remaining leg size", () => {
  it("matches the live position back to the polymarket token when available", () => {
    const leg = buildIntent().legs[0];

    expect(
      deriveLiveRemainingLegSize(
        [
          {
            id: "polymarket:token-1",
            asset: "btc",
            venue: "polymarket",
            marketRef: "poly-market",
            outcome: "DOWN",
            size: 1.01,
            averagePrice: 0.38,
            currentPrice: 1,
            currentValueUsd: 1.01,
            realizedPnlUsd: 0,
            unrealizedPnlUsd: 0,
            redeemable: true,
            mergeable: false,
            updatedAt: 3,
            raw: {
              asset: "token-1",
            },
          },
        ],
        leg,
      ),
    ).toBe(1.01);
  });
});

describe("polymarket post-slot unwind handling", () => {
  it("defers Polymarket primary unwind to settlement/redeem after the resolution grace window", () => {
    expect(
      shouldDeferPolymarketUnwindToSettlement(
        {
          primaryVenue: "polymarket",
          slotEndTs: 1_000,
        },
        6_000,
      ),
    ).toBe(true);

    expect(
      shouldDeferPolymarketUnwindToSettlement(
        {
          primaryVenue: "polymarket",
          slotEndTs: 1_000,
        },
        5_999,
      ),
    ).toBe(false);

    expect(
      shouldDeferPolymarketUnwindToSettlement(
        {
          primaryVenue: "kalshi",
          slotEndTs: 1_000,
        },
        6_000,
      ),
    ).toBe(false);
  });
});

describe("stable pnl readiness", () => {
  it("waits for settled venues and cash-equivalent balances before recording", () => {
    const intent = buildIntent({
      status: "settled",
      realizedPnlUsd: 0.4,
      roi: 0.087,
      polyResolution: "UP",
      kalshiResolution: "YES",
    });
    const balances = [
      buildVenueBalance({
        venue: "polymarket",
        availableBalanceUsd: 100,
        totalBalanceUsd: 100,
        portfolioValueUsd: 100,
      }),
      buildVenueBalance({
        venue: "kalshi",
        currency: "USD",
        allowanceUsd: null,
        availableBalanceUsd: 50,
        totalBalanceUsd: 50,
        portfolioValueUsd: 50,
      }),
    ];

    expect(evaluateStablePnlChangeReadiness(intent, balances, []).ready).toBe(true);
  });

  it("blocks while Polymarket portfolio value has not returned to available cash", () => {
    const intent = buildIntent({
      status: "settled",
      realizedPnlUsd: 0.4,
      polyResolution: "UP",
      kalshiResolution: "YES",
    });
    const balances = [
      buildVenueBalance({
        venue: "polymarket",
        availableBalanceUsd: 100,
        totalBalanceUsd: 100.25,
        portfolioValueUsd: 100.25,
      }),
      buildVenueBalance({
        venue: "kalshi",
        currency: "USD",
        allowanceUsd: null,
        availableBalanceUsd: 50,
        totalBalanceUsd: 50,
        portfolioValueUsd: 50,
      }),
    ];

    expect(evaluateStablePnlChangeReadiness(intent, balances, []).ready).toBe(false);
  });

  it("blocks while the Kalshi market still has active exposure", () => {
    const intent = buildIntent({
      status: "settled",
      realizedPnlUsd: 0.4,
      polyResolution: "UP",
      kalshiResolution: "YES",
    });
    const balances = [
      buildVenueBalance({ venue: "polymarket" }),
      buildVenueBalance({
        venue: "kalshi",
        currency: "USD",
        allowanceUsd: null,
        availableBalanceUsd: 50,
        totalBalanceUsd: 50,
        portfolioValueUsd: 50,
      }),
    ];

    expect(
      evaluateStablePnlChangeReadiness(intent, balances, [
        buildPosition({
          venue: "kalshi",
          marketRef: "kalshi-market",
          outcome: "YES",
          currentValueUsd: 10,
        }),
      ]).ready,
    ).toBe(false);
  });
});
