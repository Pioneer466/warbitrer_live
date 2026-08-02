import {
  buildLateEntryProbeCombinationKey,
  buildLateEntryProbeId,
  classifyEntryFunnel,
  ENTRY_FUNNEL_CODES,
  ENTRY_PROBE_MAX_LEG_PRICE_CAPS,
  ENTRY_PROBE_SAFETY_FRACTIONS,
  ENTRY_PROBE_VARIANTS,
  getEntryProbeEstimateReadinessRejection,
  getLateEntryProbeCaptureRejection,
  getMissingLateEntryProbeCombinations,
  LATE_ENTRY_PROBE_TARGETS_SECONDS,
  nextLateEntryProbeIdentity,
  nextLateEntryProbeTarget,
  REST_PAIR_PROBE_SCHEMA_VERSION,
} from "@/lib/entry-probes";
import type {
  EntryFunnelCode,
  EntryFunnelProgress,
  LateEntryProbeIdentity,
  RestPairProbeProof,
} from "@/lib/entry-probes";

describe("late entry probe scheduling", () => {
  it("uses the six exact diagnostic targets", () => {
    expect(LATE_ENTRY_PROBE_TARGETS_SECONDS).toEqual([55, 45, 35, 25, 15, 5]);
  });

  it.each([
    [56, null],
    [55.1, null],
    [55, 55],
    [50, 55],
    [45.1, 55],
    [45, 45],
    [40, 45],
    [35, 35],
    [25, 25],
    [15, 15],
    [5, 5],
    [0.001, 5],
    [0, null],
    [-1, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
  ])("selects the countdown band at %s seconds", (secondsRemaining, expected) => {
    expect(nextLateEntryProbeTarget(secondsRemaining, [])).toBe(expected);
  });

  it("is idempotent inside a target band", () => {
    expect(nextLateEntryProbeTarget(54, [55])).toBeNull();
    expect(nextLateEntryProbeTarget(50, [55, 55])).toBeNull();
    expect(nextLateEntryProbeTarget(44, [55])).toBe(45);
  });

  it("resumes in the current band without backfilling missed targets", () => {
    expect(nextLateEntryProbeTarget(20, [])).toBe(25);
    expect(nextLateEntryProbeTarget(20, [25])).toBeNull();
    expect(nextLateEntryProbeTarget(14, [25])).toBe(15);
  });

  it("scopes restart idempotence by asset and slot", () => {
    const seen: LateEntryProbeIdentity[] = [
      { asset: "btc", slotKey: "btc:old", targetSeconds: 55 },
      { asset: "eth", slotKey: "eth:current", targetSeconds: 55 },
      { asset: "btc", slotKey: "btc:current", targetSeconds: 55 },
    ];

    expect(
      nextLateEntryProbeIdentity({
        asset: "btc",
        slotKey: "btc:current",
        secondsRemaining: 52,
        seen,
      }),
    ).toBeNull();
    expect(
      nextLateEntryProbeIdentity({
        asset: "btc",
        slotKey: "btc:next",
        secondsRemaining: 52,
        seen,
      }),
    ).toEqual({ asset: "btc", slotKey: "btc:next", targetSeconds: 55 });
  });

  it("builds one stable id per asset, slot, and target", () => {
    const identity: LateEntryProbeIdentity = {
      asset: "hype",
      slotKey: "hype:slot/with spaces",
      targetSeconds: 15,
    };
    const id = buildLateEntryProbeId(identity);

    expect(id).toBe(buildLateEntryProbeId({ ...identity }));
    expect(id).not.toBe(buildLateEntryProbeId({ ...identity, targetSeconds: 5 }));
    expect(id).not.toBe(buildLateEntryProbeId({ ...identity, asset: "bnb" }));
    expect(id).not.toBe(buildLateEntryProbeId({ ...identity, slotKey: "hype:other" }));
  });

  it("retries only missing combinations after a partial durable capture", () => {
    const identity: LateEntryProbeIdentity = {
      asset: "btc",
      slotKey: "btc:1800000000000",
      targetSeconds: 25,
    };
    const upKey = buildLateEntryProbeCombinationKey(identity, "POLY_UP_KALSHI_NO");
    const downKey = buildLateEntryProbeCombinationKey(identity, "POLY_DOWN_KALSHI_YES");

    expect(getMissingLateEntryProbeCombinations(identity, [])).toEqual(["POLY_UP_KALSHI_NO", "POLY_DOWN_KALSHI_YES"]);
    expect(getMissingLateEntryProbeCombinations(identity, [upKey])).toEqual(["POLY_DOWN_KALSHI_YES"]);
    expect(getMissingLateEntryProbeCombinations(identity, [upKey, downKey])).toEqual([]);
  });

  it("rejects REST capture at slot end and on snapshot or opportunity identity drift", () => {
    const aligned = {
      now: 1_850,
      slot: { asset: "btc" as const, key: "btc:1000", startTs: 1_000, endTs: 1_900 },
      snapshot: {
        asset: "btc" as const,
        slotKey: "btc:1000",
        slotStartTs: 1_000,
        slotEndTs: 1_900,
      },
      opportunity: { asset: "btc" as const, slotKey: "btc:1000" },
    };

    expect(getLateEntryProbeCaptureRejection(aligned)).toBeNull();
    expect(getLateEntryProbeCaptureRejection({ ...aligned, now: 1_900 })).toBe("slot_ended");
    expect(
      getLateEntryProbeCaptureRejection({
        ...aligned,
        snapshot: { ...aligned.snapshot, slotEndTs: 2_000 },
      }),
    ).toBe("slot_identity_mismatch");
    expect(
      getLateEntryProbeCaptureRejection({
        ...aligned,
        opportunity: { ...aligned.opportunity, slotKey: "btc:other" },
      }),
    ).toBe("opportunity_identity_mismatch");
  });

  it("requires an execution-usable calibrated estimate for the main disposition", () => {
    const estimate = {
      available: true,
      executionUsable: true,
      modelVersion: "structural-v1-pava-jeffreys-v1-calibrated-abc123",
      pFatalUpper95: 0.04,
    };

    expect(getEntryProbeEstimateReadinessRejection(estimate)).toBeNull();
    expect(getEntryProbeEstimateReadinessRejection({ ...estimate, executionUsable: false })).toBe(
      "execution_reference_unusable",
    );
    expect(
      getEntryProbeEstimateReadinessRejection({
        ...estimate,
        modelVersion: "structural-ewma-gaussian-v1-uncalibrated",
      }),
    ).toBe("model_uncalibrated");
    expect(getEntryProbeEstimateReadinessRejection({ ...estimate, modelVersion: "structural-v1" })).toBe(
      "model_uncalibrated",
    );
    expect(getEntryProbeEstimateReadinessRejection({ ...estimate, pFatalUpper95: null })).toBe("risk_unavailable");
  });
});

describe("entry probe evidence", () => {
  it("enumerates every cap and safety-fraction counterfactual once", () => {
    expect(ENTRY_PROBE_MAX_LEG_PRICE_CAPS).toEqual([0.49, 0.6, 0.7, 0.99]);
    expect(ENTRY_PROBE_SAFETY_FRACTIONS).toEqual([0.5, 0.75, 1]);
    expect(ENTRY_PROBE_VARIANTS).toHaveLength(12);
    expect(new Set(ENTRY_PROBE_VARIANTS.map((variant) => JSON.stringify(variant))).size).toBe(12);
    expect(ENTRY_PROBE_VARIANTS[0]).toEqual({ maxLegPriceCap: 0.49, safetyFraction: 0.5 });
    expect(ENTRY_PROBE_VARIANTS.at(-1)).toEqual({ maxLegPriceCap: 0.99, safetyFraction: 1 });
  });

  it("defines a JSON-round-trippable diagnostic-only REST pair proof", () => {
    const identity: LateEntryProbeIdentity = {
      asset: "bnb",
      slotKey: "bnb:1800000000000",
      targetSeconds: 5,
    };
    const proof: RestPairProbeProof = {
      schemaVersion: REST_PAIR_PROBE_SCHEMA_VERSION,
      probeId: buildLateEntryProbeId(identity),
      identity,
      diagnosticOnly: true,
      combination: "POLY_UP_KALSHI_NO",
      capturedAt: 1_800_000_894_500,
      capturedSecondsRemaining: 5.5,
      requestedPairSize: 10,
      polymarketBook: {
        venue: "polymarket",
        marketRef: "condition-1",
        instrumentId: "up-token",
        outcome: "UP",
        source: "rest",
        capturedAt: 1_800_000_894_450,
        bestAskPrice: 0.47,
        tickSize: 0.01,
        minimumOrderSize: 1,
        asks: [[0.47, 20]],
        errorCode: null,
      },
      kalshiBook: {
        venue: "kalshi",
        marketRef: "KXBNB15M-TEST",
        instrumentId: "KXBNB15M-TEST:NO",
        outcome: "NO",
        source: "rest",
        capturedAt: 1_800_000_894_460,
        bestAskPrice: 0.46,
        tickSize: 0.01,
        minimumOrderSize: 1,
        asks: [[0.46, 15]],
        errorCode: null,
      },
      variants: [],
      funnel: { code: "rest", outcome: "stopped" },
    };

    expect(JSON.parse(JSON.stringify(proof))).toEqual(proof);
    expect(proof).not.toHaveProperty("intentId");
    expect(proof).not.toHaveProperty("orderId");
  });
});

describe("entry funnel classification", () => {
  it.each(ENTRY_FUNNEL_CODES)("assigns an exclusive stopped bucket at %s", (expectedCode) => {
    const progress = progressStoppedAt(expectedCode);

    expect(classifyEntryFunnel(progress)).toEqual({ code: expectedCode, outcome: "stopped" });
  });

  it("uses the settled bucket only once when the funnel completes", () => {
    const progress = Object.fromEntries(ENTRY_FUNNEL_CODES.map((code) => [code, true])) as EntryFunnelProgress;

    expect(classifyEntryFunnel(progress)).toEqual({ code: "settled", outcome: "completed" });
  });

  it("fails closed at the earliest missing stage when evidence is inconsistent", () => {
    const progress: EntryFunnelProgress = {
      signal: true,
      base: true,
      rest: false,
      risk: true,
      admission: true,
      primary: true,
      hedge: true,
      settled: true,
    };

    expect(classifyEntryFunnel(progress)).toEqual({ code: "rest", outcome: "stopped" });
  });
});

function progressStoppedAt(stoppedAt: EntryFunnelCode): EntryFunnelProgress {
  let stopped = false;
  return Object.fromEntries(
    ENTRY_FUNNEL_CODES.map((code) => {
      if (code === stoppedAt) {
        stopped = true;
      }
      return [code, !stopped];
    }),
  ) as EntryFunnelProgress;
}
