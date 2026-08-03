import { DEFAULT_STRATEGY_CONFIG } from "@/lib/constants";
import { ACCOUNTING_LEDGER_SCALE } from "@/lib/accounting-ledger";
import {
  PERSISTED_CONSUMED_LEVEL_LIMIT_PER_LEG,
  PERSISTED_RAW_BOOK_LEVEL_LIMIT_PER_VENUE,
  summarizeRawBookLevelsForProbe,
  summarizeRestPairedPreflightForProbe,
} from "@/lib/entry-probes";
import {
  applyRestPairedPreflightToIntent,
  buildCompletedShadowAuditFromPreparedRestExecution,
  buildPreparedShadowRestExecutionProof,
  buildScheduledShadowAudit,
  deriveRestPairedPreflight,
  deriveShadowDecisionFromRestPreflight,
  getPreparedShadowRestFillEconomics,
  getShadowRestAdmissionRejection,
  LEGACY_SHADOW_REST_REFETCH_MODEL_VERSION,
  SHADOW_EXECUTION_MODEL_VERSION,
  SHADOW_PREPARED_REST_PROOF_SCHEMA_VERSION,
} from "@/lib/shadow-execution";
import type { OpportunitySnapshot, OrderIntent, StrategyConfig } from "@/lib/types";

describe("REST paired preflight", () => {
  it("classifies a REST capture ending at the slot boundary before risk, proof, or admission", () => {
    const intent = buildIntent();
    const decision = deriveRestPairedPreflight({
      intent,
      snapshot: buildSnapshot({
        polyAsks: [[0.4, 50]],
        kalshiYesBids: [[0.52, 50]],
      }),
      settings: settings(),
    });

    expect(
      getShadowRestAdmissionRejection({
        slotEndTs: intent.slotEndTs,
        restCapturedAt: intent.slotEndTs,
        restErrors: ["a concurrent REST error must not hide the terminal slot classification"],
        preflight: decision,
      }),
    ).toEqual({
      code: "slot_ended_during_rest_capture",
      reason: "REST capture completed at or after slot end; the candidate can no longer be admitted",
    });
    expect(
      getShadowRestAdmissionRejection({
        slotEndTs: intent.slotEndTs,
        restCapturedAt: intent.slotEndTs - 1,
        restErrors: [],
        preflight: decision,
      }),
    ).toBeNull();
  });

  it("uses complete REST depth under the absolute cap instead of signal-relative slippage", () => {
    const decision = deriveRestPairedPreflight({
      intent: buildIntent({ polyPrice: 0.4 }),
      snapshot: buildSnapshot({
        polyAsks: [[0.41, 50]],
        kalshiYesBids: [[0.52, 50]],
      }),
      settings: settings(),
    });

    expect(decision).toMatchObject({
      allowed: true,
      status: "eligible",
      requestedPairSize: 10,
      maxExecutablePairSize: 10,
      priceLimits: {
        polymarket: 0.49,
        kalshi: 0.49,
      },
      quote: {
        commonSize: 10,
        grossCost: 0.89,
        polymarket: {
          limitPrice: 0.41,
          vwapPrice: 0.41,
        },
        kalshi: {
          limitPrice: 0.48,
          vwapPrice: 0.48,
        },
      },
    });
  });

  it("selects the largest common size after both depth haircuts and headrooms", () => {
    const decision = deriveRestPairedPreflight({
      intent: buildIntent(),
      snapshot: buildSnapshot({
        polyAsks: [[0.4, 10]],
        kalshiYesBids: [[0.52, 20]],
      }),
      settings: settings(),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.maxExecutablePairSize).toBe(7);
    expect(decision.quote?.commonSize).toBe(7);
    expect(decision.quote?.polymarket).toMatchObject({
      displayedDepth: 10,
      executableDepth: 7,
    });
    expect(decision.quote?.kalshi).toMatchObject({
      displayedDepth: 20,
      executableDepth: 12,
    });
  });

  it("shrinks to the largest size that fits worst-fill pair and leg budgets", () => {
    const pairBudgetDecision = deriveRestPairedPreflight({
      intent: buildIntent(),
      snapshot: buildSnapshot({
        polyAsks: [[0.3, 20]],
        kalshiYesBids: [[0.55, 20]],
      }),
      settings: settings({
        maxPairNotionalUsd: 5,
        maxLegCapitalShare: 1,
        polymarketHedgeDepthSafetyFactor: 1,
        polymarketHedgeHeadroomShares: 0,
        kalshiPrimaryDepthSafetyFactor: 1,
        kalshiDepthHeadroomContracts: 0,
      }),
    });

    expect(pairBudgetDecision.allowed).toBe(true);
    expect(pairBudgetDecision.maxExecutablePairSize).toBe(10);
    expect(pairBudgetDecision.quote?.commonSize).toBe(6);
    expect(pairBudgetDecision.quote?.worstFillCostUsd).toBeLessThanOrEqual(5);

    const legBudgetDecision = deriveRestPairedPreflight({
      intent: buildIntent(),
      snapshot: buildSnapshot({
        polyAsks: [[0.3, 20]],
        kalshiYesBids: [[0.51, 20]],
      }),
      settings: settings({
        maxPairNotionalUsd: 10,
        maxLegCapitalShare: 0.5,
        polymarketHedgeDepthSafetyFactor: 1,
        polymarketHedgeHeadroomShares: 0,
        kalshiPrimaryDepthSafetyFactor: 1,
        kalshiDepthHeadroomContracts: 0,
      }),
    });

    expect(legBudgetDecision.allowed).toBe(true);
    expect(legBudgetDecision.maxExecutablePairSize).toBe(10);
    expect(legBudgetDecision.quote?.commonSize).toBe(9);
    expect(legBudgetDecision.quote?.kalshi.worstFillCostUsd).toBeLessThanOrEqual(5);
  });

  it("can shrink on the configured worst-fill profit threshold", () => {
    const decision = deriveRestPairedPreflight({
      intent: buildIntent(),
      snapshot: buildSnapshot({
        polyAsks: [
          [0.3, 5],
          [0.49, 5],
        ],
        kalshiYesBids: [[0.55, 10]],
      }),
      settings: settings({
        maxPairNotionalUsd: 100,
        maxLegCapitalShare: 1,
        minWorstCaseProfitUsd: 0.6,
        polymarketHedgeDepthSafetyFactor: 1,
        polymarketHedgeHeadroomShares: 0,
        kalshiPrimaryDepthSafetyFactor: 1,
        kalshiDepthHeadroomContracts: 0,
      }),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.maxExecutablePairSize).toBe(10);
    expect(decision.quote).toMatchObject({
      commonSize: 5,
      worstCaseProfitUsd: 1.16,
    });
  });

  it("rounds a non-grid absolute Kalshi cap down and never crosses it", () => {
    const decision = deriveRestPairedPreflight({
      intent: buildIntent(),
      snapshot: buildSnapshot({
        polyAsks: [[0.4, 50]],
        kalshiYesBids: [[0.5, 50]],
      }),
      settings: settings({ maxLegPrice: 0.495 }),
    });

    expect(decision).toMatchObject({
      allowed: false,
      code: "price_above_absolute_cap",
      priceLimits: {
        polymarket: 0.495,
        kalshi: 0.49,
      },
      quote: null,
    });
  });

  it("fails closed when the Kalshi price grid or a REST level is invalid", () => {
    const missingGrid = buildSnapshot({
      polyAsks: [[0.4, 50]],
      kalshiYesBids: [[0.52, 50]],
    });
    missingGrid.kalshi.priceRanges = null;

    expect(
      deriveRestPairedPreflight({
        intent: buildIntent(),
        snapshot: missingGrid,
        settings: settings(),
      }),
    ).toMatchObject({
      allowed: false,
      code: "kalshi_price_grid_unavailable",
    });

    expect(
      deriveRestPairedPreflight({
        intent: buildIntent(),
        snapshot: buildSnapshot({
          polyAsks: [[0.4, 50]],
          kalshiYesBids: [[0.525, 50]],
        }),
        settings: settings(),
      }),
    ).toMatchObject({
      allowed: false,
      code: "invalid_kalshi_price_level",
    });
  });

  it("returns economic evidence with a structured reason when no size is admissible", () => {
    const decision = deriveRestPairedPreflight({
      intent: buildIntent(),
      snapshot: buildSnapshot({
        polyAsks: [[0.48, 50]],
        kalshiYesBids: [[0.52, 50]],
      }),
      settings: settings(),
    });

    expect(decision).toMatchObject({
      allowed: false,
      status: "rejected",
      code: "gross_entry_threshold",
      maxExecutablePairSize: 10,
      quote: {
        commonSize: 5,
        grossCost: 0.96,
      },
    });
    expect(decision.reason).toContain("gross cost");
  });

  it("binds the admitted intent and deterministic shadow fill to the exact REST quote", () => {
    const intent = buildIntent({ polyPrice: 0.4 });
    const decision = deriveRestPairedPreflight({
      intent,
      snapshot: buildSnapshot({
        polyAsks: [[0.41, 50]],
        kalshiYesBids: [[0.52, 50]],
      }),
      settings: settings(),
    });
    if (!decision.allowed) {
      throw new Error(`expected eligible preflight: ${decision.code}`);
    }

    const admitted = applyRestPairedPreflightToIntent(intent, decision, 20_000);
    expect(admitted.updatedAt).toBe(20_000);
    expect(admitted.grossCost).toBe(0.89);
    expect(admitted.fatalMismatchPnlUsd).toBe(-decision.quote.worstFillCostUsd);
    expect(admitted.fatalLossExposureUsd).toBe(decision.quote.worstFillCostUsd);
    expect(admitted.legs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ venue: "polymarket", requestedPrice: 0.41, requestedSize: 10 }),
        expect.objectContaining({ venue: "kalshi", requestedPrice: 0.48, requestedSize: 10 }),
      ]),
    );

    expect(deriveShadowDecisionFromRestPreflight(admitted, decision)).toMatchObject({
      status: "filled",
      filledPairSize: 10,
      realizedGrossCost: 0.89,
      realizedTotalCostUsd: decision.quote.totalCostUsd,
      legs: [
        { limitPrice: 0.41, executableSize: 10 },
        { limitPrice: 0.48, executableSize: 10 },
      ],
    });
  });

  it("replays the admitted REST proof after a durable round trip without changing its economics", () => {
    const signalIntent = buildIntent({ polyPrice: 0.4 });
    const decision = deriveRestPairedPreflight({
      intent: signalIntent,
      snapshot: buildSnapshot({
        polyAsks: [[0.41, 50]],
        kalshiYesBids: [[0.52, 50]],
      }),
      settings: settings(),
    });
    if (!decision.allowed) {
      throw new Error(`expected eligible preflight: ${decision.code}`);
    }

    const restStartedAt = 20_000;
    const restCapturedAt = 20_125;
    const admittedIntent = applyRestPairedPreflightToIntent(signalIntent, decision, restCapturedAt);
    const preparedRestExecution = buildPreparedShadowRestExecutionProof(admittedIntent, decision, restCapturedAt);
    const persistedIntent = JSON.parse(
      JSON.stringify({
        ...admittedIntent,
        shadowExecution: buildScheduledShadowAudit(admittedIntent, restStartedAt, {
          signalGrossCost: signalIntent.grossCost,
          restCapturedAt,
          preparedRestExecution,
        }),
      }),
    ) as OrderIntent;

    const completed = buildCompletedShadowAuditFromPreparedRestExecution(
      persistedIntent,
      persistedIntent.shadowExecution?.preparedRestExecution,
      21_000,
    );

    expect(completed).toMatchObject({
      status: "filled",
      signalGrossCost: signalIntent.grossCost,
      realizedTotalCostUsd: decision.quote.totalCostUsd,
      projectedNetProfitUsd: decision.quote.projectedNetProfitUsd,
      restStartedAt,
      restCapturedAt,
      restFetchDurationMs: restCapturedAt - restStartedAt,
      preparedRestExecution,
    });
    expect(completed.realizedGrossCost).toBeCloseTo(decision.quote.grossCost, 10);
    expect(completed.legs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ venue: "polymarket", limitPrice: 0.41, vwapPrice: 0.41 }),
        expect.objectContaining({ venue: "kalshi", limitPrice: 0.48, vwapPrice: 0.48 }),
      ]),
    );
    expect(preparedRestExecution).toMatchObject({
      schemaVersion: SHADOW_PREPARED_REST_PROOF_SCHEMA_VERSION,
      modelVersion: SHADOW_EXECUTION_MODEL_VERSION,
    });
    for (const leg of preparedRestExecution.legs) {
      expect(leg.vwapPrice * leg.executableSize).toBeCloseTo(leg.notionalUsd, 10);
      expect(leg.totalCostUsd).toBeCloseTo(leg.notionalUsd + leg.feeUsd, 5);
      const fill = getPreparedShadowRestFillEconomics(persistedIntent, completed, leg.legId);
      expect(fill).toMatchObject({
        price: Math.round((leg.notionalUsd / leg.executableSize) * ACCOUNTING_LEDGER_SCALE) / ACCOUNTING_LEDGER_SCALE,
        size: leg.executableSize,
        notionalUsd: leg.notionalUsd,
        feeUsd: leg.feeUsd,
        totalCostUsd: leg.totalCostUsd,
      });
    }

    const corruptedProof = {
      ...preparedRestExecution,
      realizedTotalCostUsd: preparedRestExecution.realizedTotalCostUsd + 1,
    };
    expect(() => buildCompletedShadowAuditFromPreparedRestExecution(persistedIntent, corruptedProof, 21_000)).toThrow(
      "inconsistent durable REST economics",
    );
  });

  it("uses canonical per-leg notionals for proof replay instead of rounded quote VWAPs", () => {
    const signalIntent = buildIntent({ polyPrice: 0.4, pairSize: 7 });
    const decision = deriveRestPairedPreflight({
      intent: signalIntent,
      snapshot: buildSnapshot({
        polyAsks: [
          [0.401, 3],
          [0.409, 4],
        ],
        kalshiYesBids: [[0.52, 20]],
      }),
      settings: settings({
        polymarketHedgeDepthSafetyFactor: 1,
        polymarketHedgeHeadroomShares: 0,
        kalshiPrimaryDepthSafetyFactor: 1,
        kalshiDepthHeadroomContracts: 0,
      }),
    });
    if (!decision.allowed) {
      throw new Error(`expected eligible preflight: ${decision.code}`);
    }

    const capturedAt = 20_125;
    const admittedIntent = applyRestPairedPreflightToIntent(signalIntent, decision, capturedAt);
    const proof = buildPreparedShadowRestExecutionProof(admittedIntent, decision, capturedAt);
    const polymarketProof = proof.legs.find((leg) => leg.venue === "polymarket");
    if (!polymarketProof) {
      throw new Error("missing polymarket proof leg");
    }

    expect(polymarketProof.vwapPrice).not.toBe(decision.quote.polymarket.vwapPrice);
    expect(polymarketProof.vwapPrice * polymarketProof.executableSize).toBeCloseTo(polymarketProof.notionalUsd, 10);

    const persistedIntent: OrderIntent = {
      ...admittedIntent,
      shadowExecution: buildScheduledShadowAudit(admittedIntent, 20_000, {
        restCapturedAt: capturedAt,
        preparedRestExecution: proof,
      }),
    };
    const completed = buildCompletedShadowAuditFromPreparedRestExecution(persistedIntent, proof, 21_000);
    const rawPrice = polymarketProof.notionalUsd / polymarketProof.executableSize;
    const fill = getPreparedShadowRestFillEconomics(persistedIntent, completed, polymarketProof.legId);
    expect(fill?.price).toBe(Math.round(rawPrice * ACCOUNTING_LEDGER_SCALE) / ACCOUNTING_LEDGER_SCALE);
    expect(
      Math.abs((fill?.price ?? 0) * polymarketProof.executableSize - polymarketProof.notionalUsd),
    ).toBeLessThanOrEqual(polymarketProof.executableSize / (2 * ACCOUNTING_LEDGER_SCALE) + Number.EPSILON);
  });

  it("canonicalizes production-style floating point artifacts before durable fill replay", () => {
    const signalIntent = buildIntent({ polyPrice: 0.4, kalshiPrice: 0.48, pairSize: 10 });
    const decision = deriveRestPairedPreflight({
      intent: signalIntent,
      snapshot: buildSnapshot({
        polyAsks: [[0.44, 20]],
        kalshiYesBids: [[0.51, 20]],
      }),
      settings: settings({
        polymarketHedgeDepthSafetyFactor: 1,
        polymarketHedgeHeadroomShares: 0,
        kalshiPrimaryDepthSafetyFactor: 1,
        kalshiDepthHeadroomContracts: 0,
      }),
    });
    if (!decision.allowed) {
      throw new Error(`expected eligible preflight: ${decision.code}`);
    }

    const capturedAt = 20_125;
    const admittedIntent = applyRestPairedPreflightToIntent(signalIntent, decision, capturedAt);
    const proof = buildPreparedShadowRestExecutionProof(admittedIntent, decision, capturedAt);
    const persistedIntent: OrderIntent = JSON.parse(
      JSON.stringify({
        ...admittedIntent,
        shadowExecution: buildScheduledShadowAudit(admittedIntent, 20_000, {
          restCapturedAt: capturedAt,
          preparedRestExecution: proof,
        }),
      }),
    );
    const completed = buildCompletedShadowAuditFromPreparedRestExecution(
      persistedIntent,
      persistedIntent.shadowExecution?.preparedRestExecution,
      21_000,
    );
    const prices = proof.legs.map((leg) => leg.notionalUsd / leg.executableSize);
    expect(prices).toEqual([0.44000000000000006, 0.49000000000000005]);
    expect(
      proof.legs.map((leg) => getPreparedShadowRestFillEconomics(persistedIntent, completed, leg.legId)?.price),
    ).toEqual([0.44, 0.49]);
  });

  it("rejects proofs that conflict with admitted limits, reservations, schema, or audit model", () => {
    const signalIntent = buildIntent({ polyPrice: 0.4 });
    const decision = deriveRestPairedPreflight({
      intent: signalIntent,
      snapshot: buildSnapshot({
        polyAsks: [[0.41, 50]],
        kalshiYesBids: [[0.52, 50]],
      }),
      settings: settings(),
    });
    if (!decision.allowed) {
      throw new Error(`expected eligible preflight: ${decision.code}`);
    }
    const capturedAt = 20_125;
    const admittedIntent = applyRestPairedPreflightToIntent(signalIntent, decision, capturedAt);
    const proof = buildPreparedShadowRestExecutionProof(admittedIntent, decision, capturedAt);
    const persistedIntent: OrderIntent = {
      ...admittedIntent,
      shadowExecution: buildScheduledShadowAudit(admittedIntent, 20_000, {
        restCapturedAt: capturedAt,
        preparedRestExecution: proof,
      }),
    };

    const wrongLimit = structuredClone(proof);
    wrongLimit.legs[0].limitPrice -= 0.01;
    expect(() => buildCompletedShadowAuditFromPreparedRestExecution(persistedIntent, wrongLimit, 21_000)).toThrow(
      "conflicting durable REST leg proof",
    );

    const overReservedFee = structuredClone(proof);
    overReservedFee.legs[0].feeUsd = persistedIntent.legs[0].feeUsd + 1;
    expect(() => buildCompletedShadowAuditFromPreparedRestExecution(persistedIntent, overReservedFee, 21_000)).toThrow(
      "conflicting durable REST leg proof",
    );

    const wrongSchema = { ...proof, schemaVersion: "rest-paired-preflight-proof-v1" };
    expect(() => buildCompletedShadowAuditFromPreparedRestExecution(persistedIntent, wrongSchema, 21_000)).toThrow(
      "invalid durable REST execution proof",
    );

    const unknownModelIntent: OrderIntent = {
      ...persistedIntent,
      shadowExecution: {
        ...persistedIntent.shadowExecution!,
        modelVersion: "rest-orderbook-v99",
      },
    };
    expect(() => buildCompletedShadowAuditFromPreparedRestExecution(unknownModelIntent, proof, 21_000)).toThrow(
      "conflicting durable REST model",
    );
  });

  it("fails closed before fast-path fills when a completed non-v3 audit carries a v3 proof", () => {
    const signalIntent = buildIntent({ polyPrice: 0.4 });
    const decision = deriveRestPairedPreflight({
      intent: signalIntent,
      snapshot: buildSnapshot({
        polyAsks: [[0.41, 50]],
        kalshiYesBids: [[0.52, 50]],
      }),
      settings: settings(),
    });
    if (!decision.allowed) {
      throw new Error(`expected eligible preflight: ${decision.code}`);
    }
    const capturedAt = 20_125;
    const admittedIntent = applyRestPairedPreflightToIntent(signalIntent, decision, capturedAt);
    const proof = buildPreparedShadowRestExecutionProof(admittedIntent, decision, capturedAt);
    const persistedIntent: OrderIntent = {
      ...admittedIntent,
      shadowExecution: buildScheduledShadowAudit(admittedIntent, 20_000, {
        restCapturedAt: capturedAt,
        preparedRestExecution: proof,
      }),
    };
    const completed = buildCompletedShadowAuditFromPreparedRestExecution(persistedIntent, proof, 21_000);

    for (const modelVersion of [LEGACY_SHADOW_REST_REFETCH_MODEL_VERSION, "rest-orderbook-v99"]) {
      expect(() =>
        getPreparedShadowRestFillEconomics(persistedIntent, { ...completed, modelVersion }, persistedIntent.legs[0].id),
      ).toThrow("cannot fill from unsupported or conflicting model");
    }

    expect(() =>
      getPreparedShadowRestFillEconomics(
        persistedIntent,
        { ...completed, modelVersion: "rest-orderbook-v99", preparedRestExecution: null },
        persistedIntent.legs[0].id,
      ),
    ).toThrow("cannot fill from unsupported or conflicting model");

    expect(
      getPreparedShadowRestFillEconomics(
        persistedIntent,
        {
          ...completed,
          modelVersion: LEGACY_SHADOW_REST_REFETCH_MODEL_VERSION,
          preparedRestExecution: null,
        },
        persistedIntent.legs[0].id,
      ),
    ).toBeNull();
  });

  it("keeps analytical scalars but omits consumed levels from compact probe variants", () => {
    const decision = deriveRestPairedPreflight({
      intent: buildIntent(),
      snapshot: buildSnapshot({
        polyAsks: [
          [0.4, 5],
          [0.41, 5],
        ],
        kalshiYesBids: [[0.52, 20]],
      }),
      settings: settings({
        polymarketHedgeDepthSafetyFactor: 1,
        polymarketHedgeHeadroomShares: 0,
        kalshiPrimaryDepthSafetyFactor: 1,
        kalshiDepthHeadroomContracts: 0,
      }),
    });
    if (!decision.allowed) {
      throw new Error(`expected eligible preflight: ${decision.code}`);
    }

    const compact = summarizeRestPairedPreflightForProbe(decision);
    expect(compact.quote).toMatchObject({
      commonSize: 10,
      worstFillCostUsd: decision.quote.worstFillCostUsd,
      polymarket: {
        size: 10,
        displayedDepth: 10,
        executableDepth: 10,
        vwapPrice: 0.405,
        limitPrice: 0.41,
      },
    });
    expect(JSON.stringify(compact)).not.toContain("consumedLevels");

    const admissionProof = summarizeRestPairedPreflightForProbe(decision, { includeConsumedLevels: true });
    expect(admissionProof.quote?.polymarket).toHaveProperty("consumedLevels");
  });

  it("bounds persisted consumed levels while retaining full scalars and a deterministic hash", () => {
    const polyAsks = Array.from({ length: 80 }, (_, index) => [0.2 + index / 1_000, 1] as [number, number]);
    const decision = deriveRestPairedPreflight({
      intent: buildIntent({ pairSize: 80 }),
      snapshot: buildSnapshot({
        polyAsks,
        kalshiYesBids: [[0.7, 100]],
      }),
      settings: settings({
        maxPairNotionalUsd: 100,
        maxLegCapitalShare: 1,
        polymarketHedgeDepthSafetyFactor: 1,
        polymarketHedgeHeadroomShares: 0,
        kalshiPrimaryDepthSafetyFactor: 1,
        kalshiDepthHeadroomContracts: 0,
      }),
    });
    if (!decision.allowed) {
      throw new Error(`expected eligible preflight: ${decision.code}`);
    }

    const first = summarizeRestPairedPreflightForProbe(decision, { includeConsumedLevels: true });
    const second = summarizeRestPairedPreflightForProbe(decision, { includeConsumedLevels: true });
    const stored = first.quote?.polymarket;
    if (!stored || !("consumedLevels" in stored)) {
      throw new Error("missing persisted consumed-level summary");
    }

    expect(stored).toMatchObject({
      notionalUsd: decision.quote.polymarket.notionalUsd,
      feeUsd: decision.quote.polymarket.feeUsd,
      costUsd: decision.quote.polymarket.costUsd,
      consumedLevelCount: 80,
      consumedLevelsRetainedCount: PERSISTED_CONSUMED_LEVEL_LIMIT_PER_LEG,
      consumedLevelsTruncated: true,
    });
    expect(stored.consumedLevels).toHaveLength(PERSISTED_CONSUMED_LEVEL_LIMIT_PER_LEG);
    expect(stored.consumedLevels[0]).toEqual(decision.quote.polymarket.consumedLevels[0]);
    expect(stored.consumedLevels.at(-1)).toEqual(decision.quote.polymarket.consumedLevels.at(-1));
    expect(stored.consumedLevelsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.quote?.polymarket).toMatchObject({ consumedLevelsSha256: stored.consumedLevelsSha256 });
  });

  it("bounds raw REST books with head/tail provenance before probe persistence", () => {
    const levels = Array.from({ length: 100 }, (_, index) => [index / 1_000, index + 1] as [number, number]);
    const first = summarizeRawBookLevelsForProbe(levels);
    const second = summarizeRawBookLevelsForProbe(levels);

    expect(first).toMatchObject({
      levelCount: 100,
      retainedLevelCount: PERSISTED_RAW_BOOK_LEVEL_LIMIT_PER_VENUE,
      truncated: true,
      retainedRanges: [
        { startIndex: 0, endIndexExclusive: 32 },
        { startIndex: 68, endIndexExclusive: 100 },
      ],
    });
    expect(first.levels).toHaveLength(PERSISTED_RAW_BOOK_LEVEL_LIMIT_PER_VENUE);
    expect(first.levels[0]).toEqual(levels[0]);
    expect(first.levels.at(-1)).toEqual(levels.at(-1));
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.sha256).toBe(first.sha256);
  });
});

function settings(overrides: Partial<StrategyConfig> = {}) {
  return {
    ...DEFAULT_STRATEGY_CONFIG,
    ...overrides,
  };
}

function buildIntent(overrides: { polyPrice?: number; kalshiPrice?: number; pairSize?: number } = {}): OrderIntent {
  const polyPrice = overrides.polyPrice ?? 0.4;
  const kalshiPrice = overrides.kalshiPrice ?? 0.48;
  const pairSize = overrides.pairSize ?? 10;
  return {
    id: "rest-preflight-intent",
    revision: 0,
    asset: "btc",
    shadow: true,
    slotKey: "btc:slot-1",
    slotStartTs: 1_000,
    slotEndTs: 901_000,
    combination: "POLY_UP_KALSHI_NO",
    status: "pending",
    createdAt: 10_000,
    updatedAt: 10_000,
    resolvedAt: null,
    primaryVenue: "kalshi",
    hedgeVenue: "polymarket",
    grossCost: polyPrice + kalshiPrice,
    targetNotionalUsd: pairSize * (polyPrice + kalshiPrice),
    maxSlippageBps: 30,
    failureReason: null,
    projectedNetProfitUsd: 1,
    realizedPnlUsd: null,
    roi: null,
    polyResolution: null,
    kalshiResolution: null,
    legs: [
      {
        id: "poly-leg",
        intentId: "rest-preflight-intent",
        venue: "polymarket",
        outcome: "UP",
        marketRef: "poly-market",
        tokenId: "poly-token",
        side: "BUY",
        requestedPrice: polyPrice,
        requestedSize: pairSize,
        requestedNotionalUsd: pairSize * polyPrice,
        filledPrice: null,
        filledSize: 0,
        feeUsd: 0,
        status: "pending",
        venueOrderId: null,
        payoutUsd: null,
        resolvedOutcome: null,
      },
      {
        id: "kalshi-leg",
        intentId: "rest-preflight-intent",
        venue: "kalshi",
        outcome: "NO",
        marketRef: "kalshi-market",
        side: "BUY",
        requestedPrice: kalshiPrice,
        requestedSize: pairSize,
        requestedNotionalUsd: pairSize * kalshiPrice,
        filledPrice: null,
        filledSize: 0,
        feeUsd: 0,
        status: "pending",
        venueOrderId: null,
        payoutUsd: null,
        resolvedOutcome: null,
      },
    ],
  };
}

function buildSnapshot(input: {
  polyAsks: Array<[number, number]>;
  kalshiYesBids: Array<[number, number]>;
}): OpportunitySnapshot {
  return {
    asset: "btc",
    slotKey: "btc:slot-1",
    slotStartTs: 1_000,
    slotEndTs: 901_000,
    capturedAt: 25_000,
    polymarket: {
      slotAligned: true,
      feedHealth: { feedStatus: "ready" },
      feeRateBps: 0,
      feeRate: 0,
      feeExponent: 0,
      outcomes: {
        up: { minOrderSize: 5 },
        down: { minOrderSize: 5 },
      },
      orderbookLevels: {
        upBids: [],
        upAsks: input.polyAsks,
        downBids: [],
        downAsks: [],
      },
    },
    kalshi: {
      slotAligned: true,
      feedHealth: { feedStatus: "ready" },
      feeMultiplier: 1,
      priceLevelStructure: "linear_cent",
      priceRanges: [{ start: "0.0000", end: "1.0000", step: "0.0100" }],
      outcomes: {
        yes: { minOrderSize: 1 },
        no: { minOrderSize: 1 },
      },
      orderbookLevels: {
        yesBids: input.kalshiYesBids,
        noBids: [],
      },
    },
    opportunities: [],
  } as unknown as OpportunitySnapshot;
}
