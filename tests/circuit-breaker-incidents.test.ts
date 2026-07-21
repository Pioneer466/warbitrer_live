import {
  CIRCUIT_BREAKER_INCIDENT_OWNERS,
  INITIAL_CIRCUIT_BREAKER_INCIDENT_REVISION,
  createDailyLossIncident,
  createExecutionIncident,
  createManualKillIncident,
  createMarketDegradedIncident,
  createMarketFeedIncident,
  createPolygonRpcIncident,
} from "@/lib/circuit-breaker-incidents";
import {
  getCircuitBreakerIncidentIdentity,
  getEffectiveCircuitBreakerImpact,
  isManualKillIncident,
} from "@/lib/circuit-breaker-policy";

const NOW = Date.UTC(2026, 6, 20, 12, 0, 0);
const DAY_START = Date.UTC(2026, 6, 20);
const SLOT_KEY = "btc:1784547900000";

describe("circuit-breaker incident factories", () => {
  it("creates a stable operator-owned manual kill incident", () => {
    const first = createManualKillIncident({
      triggeredAt: NOW,
      operatorId: "operator-1",
      note: "Planned maintenance",
    });
    const second = createManualKillIncident({
      triggeredAt: NOW + 1,
      operatorId: "operator-2",
    });
    const exactReplay = createManualKillIncident({
      triggeredAt: NOW,
      operatorId: "operator-1",
      note: "Planned maintenance",
    });

    expect(first).toMatchObject({
      scope: { type: "global" },
      owner: "operator",
      incidentKey: "manual-kill",
      reason: "manual",
      impact: "blocked",
      resolutionPolicy: "operator",
      intentId: null,
      exposure: { state: "none" },
      revision: INITIAL_CIRCUIT_BREAKER_INCIDENT_REVISION,
      timestamps: {
        triggeredAt: NOW,
        updatedAt: NOW,
        lastObservedAt: NOW,
        cooldownUntil: null,
        acknowledgedAt: null,
        resolvedAt: null,
      },
      payload: {
        operatorId: "operator-1",
        note: "Planned maintenance",
      },
    });
    expect(isManualKillIncident(first)).toBe(true);
    expect(first.id).toBe(exactReplay.id);
    expect(first.id).not.toBe(second.id);
    expect(getCircuitBreakerIncidentIdentity(first)).toBe(getCircuitBreakerIncidentIdentity(second));
  });

  it("creates one owner-resolvable blocked feed incident per venue and slot", () => {
    const input = {
      asset: "btc" as const,
      slotKey: SLOT_KEY,
      venue: "kalshi" as const,
      source: "rest-fallback" as const,
      triggeredAt: NOW,
      stalenessMs: 2_500,
      details: ["sequence gap", "REST fallback only"],
    };
    const first = createMarketFeedIncident(input);
    const repeated = createMarketFeedIncident({
      ...input,
      triggeredAt: NOW + 1_000,
      stalenessMs: 3_500,
    });
    const otherVenue = createMarketFeedIncident({
      ...input,
      venue: "polymarket",
    });

    expect(first).toMatchObject({
      scope: { type: "slot", asset: "btc", slotKey: SLOT_KEY },
      owner: CIRCUIT_BREAKER_INCIDENT_OWNERS.marketFeed,
      incidentKey: "feed:kalshi",
      reason: "venue_error",
      impact: "blocked",
      resolutionPolicy: "owner",
      exposure: { state: "none" },
    });
    expect(first.payload).toEqual({
      asset: "btc",
      slotKey: SLOT_KEY,
      venue: "kalshi",
      source: "rest-fallback",
      stalenessMs: 2_500,
      details: ["sequence gap", "REST fallback only"],
    });
    expect(first.id).not.toBe(repeated.id);
    expect(getCircuitBreakerIncidentIdentity(first)).toBe(getCircuitBreakerIncidentIdentity(repeated));
    expect(first.id).not.toBe(otherVenue.id);
    expect(getCircuitBreakerIncidentIdentity(first)).not.toBe(getCircuitBreakerIncidentIdentity(otherVenue));
  });

  it("creates slot-scoped execution cooldowns without unresolved exposure", () => {
    const incident = createExecutionIncident({
      asset: "btc",
      slotKey: SLOT_KEY,
      intentId: "intent:123",
      stage: "primary_no_fill_cooldown",
      reason: "primary_no_fill",
      disposition: "cooldown",
      venue: "kalshi",
      orderId: "order-1",
      triggeredAt: NOW,
      cooldownUntil: NOW + 60_000,
    });

    expect(incident).toMatchObject({
      scope: { type: "slot", asset: "btc", slotKey: SLOT_KEY },
      owner: CIRCUIT_BREAKER_INCIDENT_OWNERS.execution,
      reason: "primary_no_fill",
      impact: "cooldown",
      resolutionPolicy: "owner",
      intentId: "intent:123",
      exposure: { state: "none" },
      timestamps: { cooldownUntil: NOW + 60_000 },
    });
    expect(incident.incidentKey).toContain("intent%3A123");
    expect(getEffectiveCircuitBreakerImpact(incident, NOW + 59_999)).toBe("cooldown");
    expect(getEffectiveCircuitBreakerImpact(incident, NOW + 60_000)).toBeNull();
  });

  it("creates owner-resolvable global incidents for ambiguous execution truth", () => {
    const incident = createExecutionIncident({
      asset: "btc",
      slotKey: SLOT_KEY,
      intentId: "intent-1",
      stage: "primary_submission_truth_pending",
      reason: "venue_error",
      disposition: "truth_pending",
      venue: "polymarket",
      triggeredAt: NOW,
    });

    expect(incident).toMatchObject({
      scope: { type: "global" },
      impact: "blocked",
      resolutionPolicy: "owner",
      intentId: "intent-1",
      exposure: { state: "unresolved" },
      timestamps: { cooldownUntil: null },
    });
    expect(getEffectiveCircuitBreakerImpact(incident, NOW + 1_000_000)).toBe("blocked");
  });

  it("requires operator acknowledgement after execution exposure is proven resolved", () => {
    const incident = createExecutionIncident({
      asset: "btc",
      slotKey: SLOT_KEY,
      intentId: "intent-1",
      stage: "late_primary_fill_after_close",
      reason: "hedge_failure",
      disposition: "manual_intervention",
      venue: "polymarket",
      orderId: "order-1",
      triggeredAt: NOW,
    });

    expect(incident).toMatchObject({
      scope: { type: "global" },
      owner: CIRCUIT_BREAKER_INCIDENT_OWNERS.execution,
      impact: "blocked",
      resolutionPolicy: "operator",
      intentId: "intent-1",
      exposure: { state: "unresolved" },
    });
  });

  it("uses intent, stage, reason, and disposition in the execution identity", () => {
    const base = {
      asset: "btc" as const,
      slotKey: SLOT_KEY,
      intentId: "intent-1",
      stage: "hedge_failure_unwind_pending",
      reason: "hedge_failure" as const,
      disposition: "truth_pending" as const,
      venue: "kalshi" as const,
      triggeredAt: NOW,
    };
    const first = createExecutionIncident(base);
    const repeated = createExecutionIncident({ ...base, triggeredAt: NOW + 1 });
    const escalated = createExecutionIncident({
      ...base,
      disposition: "manual_intervention",
    });
    const nextStage = createExecutionIncident({
      ...base,
      stage: "hedge_truth_unavailable",
    });

    expect(first.id).not.toBe(repeated.id);
    expect(getCircuitBreakerIncidentIdentity(first)).toBe(getCircuitBreakerIncidentIdentity(repeated));
    expect(first.id).not.toBe(escalated.id);
    expect(first.id).not.toBe(nextStage.id);
  });

  it("keeps composite execution identities collision-safe", () => {
    const left = createExecutionIncident({
      asset: "btc",
      slotKey: SLOT_KEY,
      intentId: "a:b",
      stage: "c",
      reason: "venue_error",
      disposition: "truth_pending",
      venue: "kalshi",
      triggeredAt: NOW,
    });
    const right = createExecutionIncident({
      asset: "btc",
      slotKey: SLOT_KEY,
      intentId: "a",
      stage: "b:c",
      reason: "venue_error",
      disposition: "truth_pending",
      venue: "kalshi",
      triggeredAt: NOW,
    });

    expect(left.incidentKey).not.toBe(right.incidentKey);
    expect(getCircuitBreakerIncidentIdentity(left)).not.toBe(getCircuitBreakerIncidentIdentity(right));
    expect(left.id).not.toBe(right.id);
  });

  it("partitions daily loss incidents by exact UTC day", () => {
    const first = createDailyLossIncident({
      triggeredAt: NOW,
      dayStart: DAY_START,
      realizedPnlUsd: -125.5,
      lossCapUsd: 100,
    });
    const repeated = createDailyLossIncident({
      triggeredAt: NOW + 1,
      dayStart: DAY_START,
      realizedPnlUsd: -130,
      lossCapUsd: 100,
    });
    const nextDay = createDailyLossIncident({
      triggeredAt: DAY_START + 24 * 60 * 60 * 1_000,
      dayStart: DAY_START + 24 * 60 * 60 * 1_000,
      realizedPnlUsd: -101,
      lossCapUsd: 100,
    });

    expect(first).toMatchObject({
      scope: { type: "global" },
      owner: CIRCUIT_BREAKER_INCIDENT_OWNERS.dailyLoss,
      incidentKey: "daily-loss:2026-07-20",
      reason: "daily_loss_cap",
      impact: "blocked",
      resolutionPolicy: "owner",
      exposure: { state: "none" },
      payload: {
        utcDay: "2026-07-20",
        dayStart: DAY_START,
        dayEnd: DAY_START + 24 * 60 * 60 * 1_000,
        realizedPnlUsd: -125.5,
        lossCapUsd: 100,
        thresholdUsd: -100,
      },
    });
    expect(first.id).not.toBe(repeated.id);
    expect(getCircuitBreakerIncidentIdentity(first)).toBe(getCircuitBreakerIncidentIdentity(repeated));
    expect(first.id).not.toBe(nextDay.id);
    expect(getCircuitBreakerIncidentIdentity(first)).not.toBe(getCircuitBreakerIncidentIdentity(nextDay));
  });

  it("creates owner-resolvable market-quality cooldowns per slot", () => {
    const incident = createMarketDegradedIncident({
      asset: "btc",
      slotKey: SLOT_KEY,
      triggeredAt: NOW,
      cooldownUntil: NOW + 300_000,
      degradedCount: 3,
      windowMs: 900_000,
    });

    expect(incident).toMatchObject({
      scope: { type: "slot", asset: "btc", slotKey: SLOT_KEY },
      owner: CIRCUIT_BREAKER_INCIDENT_OWNERS.marketDegraded,
      incidentKey: "market-degraded",
      reason: "market_degraded",
      impact: "cooldown",
      resolutionPolicy: "owner",
      exposure: { state: "none" },
      timestamps: { cooldownUntil: NOW + 300_000 },
    });
  });

  it("creates a stable owner-resolved Polygon RPC incident", () => {
    const first = createPolygonRpcIncident({
      triggeredAt: NOW,
      failureKind: "health_check_failed",
      detail: "HTTP 503",
    });
    const repeated = createPolygonRpcIncident({
      triggeredAt: NOW + 1,
      failureKind: "missing_configuration",
      detail: "RPC URL missing",
    });

    expect(first).toMatchObject({
      scope: { type: "global" },
      owner: CIRCUIT_BREAKER_INCIDENT_OWNERS.polygonRpc,
      incidentKey: "rpc-unhealthy",
      reason: "rpc_unhealthy",
      impact: "blocked",
      resolutionPolicy: "owner",
      intentId: null,
      exposure: { state: "none" },
      payload: {
        failureKind: "health_check_failed",
        detail: "HTTP 503",
        checkedAt: NOW,
      },
    });
    expect(first.id).not.toBe(repeated.id);
    expect(getCircuitBreakerIncidentIdentity(first)).toBe(getCircuitBreakerIncidentIdentity(repeated));
  });
});

describe("circuit-breaker incident factory validation", () => {
  it("rejects invalid timestamps instead of creating ambiguous incidents", () => {
    expect(() =>
      createManualKillIncident({
        triggeredAt: Number.NaN,
        operatorId: "operator-1",
      }),
    ).toThrow(/triggeredAt/);
    expect(() =>
      createPolygonRpcIncident({
        triggeredAt: 1.5,
        failureKind: "health_check_failed",
        detail: "timeout",
      }),
    ).toThrow(/triggeredAt/);
  });

  it("rejects non-canonical identifiers and cross-asset slot identities", () => {
    expect(() =>
      createManualKillIncident({
        triggeredAt: NOW,
        operatorId: "\n",
      }),
    ).toThrow(/operatorId/);
    expect(() =>
      createMarketFeedIncident({
        asset: "btc",
        slotKey: "eth:1784547900000",
        venue: "kalshi",
        source: "ws",
        triggeredAt: NOW,
        stalenessMs: 0,
        details: [],
      }),
    ).toThrow(/slotKey/);
  });

  it("accepts identifiers produced by the current slot, intent, stage, and venue adapters", () => {
    expect(() =>
      createExecutionIncident({
        asset: "btc",
        slotKey: "btc:1784547900000",
        intentId: "550e8400-e29b-41d4-a716-446655440000",
        stage: "primary_submission_truth_pending",
        reason: "venue_error",
        disposition: "truth_pending",
        venue: "polymarket",
        orderId: "0x0123456789abcdef/adapter+proof=",
        triggeredAt: NOW,
      }),
    ).not.toThrow();
  });

  it("rejects expired cooldowns and unsafe execution semantics", () => {
    expect(() =>
      createMarketDegradedIncident({
        asset: "btc",
        slotKey: SLOT_KEY,
        triggeredAt: NOW,
        cooldownUntil: NOW,
        degradedCount: 3,
        windowMs: 900_000,
      }),
    ).toThrow(/cooldownUntil/);
    expect(() =>
      createExecutionIncident({
        asset: "btc",
        slotKey: SLOT_KEY,
        intentId: "intent-1",
        stage: "truth_pending",
        reason: "primary_no_fill",
        disposition: "truth_pending",
        venue: "kalshi",
        triggeredAt: NOW,
      }),
    ).toThrow(/primary_no_fill/);
    expect(() =>
      createExecutionIncident({
        asset: "btc",
        slotKey: SLOT_KEY,
        intentId: "intent-1",
        stage: "truth_pending",
        reason: "not-a-reason" as "venue_error",
        disposition: "truth_pending",
        venue: "kalshi",
        triggeredAt: NOW,
      }),
    ).toThrow(/Unsupported execution incident reason/);
    expect(() =>
      createExecutionIncident({
        asset: "btc",
        slotKey: SLOT_KEY,
        intentId: "intent-1",
        stage: "truth_pending",
        reason: "venue_error",
        disposition: "unexpected" as "truth_pending",
        venue: "kalshi",
        triggeredAt: NOW,
      }),
    ).toThrow(/Unsupported execution incident disposition/);
    expect(() =>
      createExecutionIncident({
        asset: "btc",
        slotKey: SLOT_KEY,
        intentId: "intent-1",
        stage: "truth_pending",
        reason: "venue_error",
        disposition: "truth_pending",
        venue: "kalshi",
        triggeredAt: NOW,
        cooldownUntil: NOW + 1,
      } as unknown as Parameters<typeof createExecutionIncident>[0]),
    ).toThrow(/Only cooldown execution incidents/);
  });

  it("rejects non-UTC daily windows and triggers outside their day", () => {
    expect(() =>
      createDailyLossIncident({
        triggeredAt: NOW,
        dayStart: DAY_START + 1,
        realizedPnlUsd: -101,
        lossCapUsd: 100,
      }),
    ).toThrow(/midnight UTC/);
    expect(() =>
      createDailyLossIncident({
        triggeredAt: DAY_START - 1,
        dayStart: DAY_START,
        realizedPnlUsd: -101,
        lossCapUsd: 100,
      }),
    ).toThrow(/within the supplied UTC day/);
  });

  it("rejects invalid numeric evidence and unbounded diagnostic text", () => {
    expect(() =>
      createMarketFeedIncident({
        asset: "btc",
        slotKey: SLOT_KEY,
        venue: "kalshi",
        source: "rest-fallback",
        triggeredAt: NOW,
        stalenessMs: -1,
        details: [],
      }),
    ).toThrow(/stalenessMs/);
    expect(() =>
      createPolygonRpcIncident({
        triggeredAt: NOW,
        failureKind: "health_check_failed",
        detail: "line one\nline two",
      }),
    ).toThrow(/control characters/);
  });

  it("copies caller-owned feed detail arrays", () => {
    const details = ["stale feed"];
    const incident = createMarketFeedIncident({
      asset: "btc",
      slotKey: SLOT_KEY,
      venue: "kalshi",
      source: "rest-fallback",
      triggeredAt: NOW,
      stalenessMs: 1_000,
      details,
    });

    details.push("mutated later");
    expect(incident.payload?.details).toEqual(["stale feed"]);
  });
});
