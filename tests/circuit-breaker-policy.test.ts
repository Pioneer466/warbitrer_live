import {
  aggregateCircuitBreakerIncidents,
  evaluateOperatorAcknowledge,
  evaluateOwnerAutoResolve,
  getCircuitBreakerIncidentIdentity,
  getCircuitBreakerScopeKey,
  getEffectiveCircuitBreakerImpact,
  getRelevantCircuitBreakerAggregates,
  getWorstCircuitBreakerImpact,
  getWorstRelevantCircuitBreakerImpact,
  hasUnresolvedCircuitBreakerExposure,
  isAssetCircuitBreakerScope,
  isCircuitBreakerIncidentRelevant,
  isCircuitBreakerScopeRelevant,
  isGlobalCircuitBreakerScope,
  isManualKillIncident,
  isSlotCircuitBreakerScope,
  projectLegacyCircuitBreakersForUi,
  shouldPauseExecutionForCircuitBreakerImpact,
} from "@/lib/circuit-breaker-policy";
import type { CircuitBreakerIncident, CircuitBreakerIncidentTimestamps } from "@/lib/circuit-breaker-policy";

const NOW = 10_000;

type IncidentOverrides = Partial<Omit<CircuitBreakerIncident, "timestamps">> & {
  timestamps?: Partial<CircuitBreakerIncidentTimestamps>;
};

function incident(overrides: IncidentOverrides = {}): CircuitBreakerIncident {
  return {
    id: "incident-feed",
    scope: { type: "asset", asset: "btc" },
    owner: "market-data",
    incidentKey: "kalshi-stale",
    reason: "feed_stale",
    impact: "degraded",
    resolutionPolicy: "owner",
    intentId: null,
    exposure: { state: "none" },
    revision: 3,
    payload: null,
    ...overrides,
    timestamps: {
      triggeredAt: 1_000,
      updatedAt: 2_000,
      lastObservedAt: 2_000,
      cooldownUntil: null,
      acknowledgedAt: null,
      resolvedAt: null,
      ...overrides.timestamps,
    },
  };
}

describe("circuit-breaker scope policy", () => {
  it("identifies global, asset, and slot scopes and produces legacy-compatible keys", () => {
    const global = { type: "global" } as const;
    const asset = { type: "asset", asset: "btc" } as const;
    const slot = { type: "slot", asset: "btc", slotKey: "btc:123" } as const;

    expect(isGlobalCircuitBreakerScope(global)).toBe(true);
    expect(isAssetCircuitBreakerScope(asset)).toBe(true);
    expect(isSlotCircuitBreakerScope(slot)).toBe(true);
    expect(getCircuitBreakerScopeKey(global)).toBe("global");
    expect(getCircuitBreakerScopeKey(asset)).toBe("asset:btc");
    expect(getCircuitBreakerScopeKey(slot)).toBe("slot:btc:123");
    expect(getCircuitBreakerScopeKey({ type: "slot", asset: "btc", slotKey: "123" })).toBe("slot:btc:123");
  });

  it("matches global, asset, and exact slot relevance without leaking across assets or slots", () => {
    expect(isCircuitBreakerScopeRelevant({ type: "global" }, "eth", "eth:2")).toBe(true);
    expect(isCircuitBreakerScopeRelevant({ type: "asset", asset: "btc" }, "btc", "btc:2")).toBe(true);
    expect(isCircuitBreakerScopeRelevant({ type: "asset", asset: "btc" }, "eth", "eth:2")).toBe(false);
    expect(isCircuitBreakerScopeRelevant({ type: "slot", asset: "btc", slotKey: "btc:1" }, "btc", "btc:1")).toBe(true);
    expect(isCircuitBreakerScopeRelevant({ type: "slot", asset: "btc", slotKey: "btc:1" }, "btc", "btc:2")).toBe(false);
    expect(isCircuitBreakerScopeRelevant({ type: "slot", asset: "btc", slotKey: "btc:1" }, "eth", "btc:1")).toBe(false);
    expect(
      isCircuitBreakerIncidentRelevant(
        incident({ scope: { type: "slot", asset: "btc", slotKey: "btc:1" } }),
        "btc",
        null,
      ),
    ).toBe(false);
  });

  it("uses collision-safe stable identities for owner-managed incident keys", () => {
    const left = incident({
      owner: "a:b",
      incidentKey: "c",
      scope: { type: "asset", asset: "btc" },
    });
    const right = incident({
      owner: "a",
      incidentKey: "b:c",
      scope: { type: "asset", asset: "btc" },
    });

    expect(getCircuitBreakerIncidentIdentity(left)).not.toBe(getCircuitBreakerIncidentIdentity(right));
    expect(getCircuitBreakerIncidentIdentity(left)).toBe(getCircuitBreakerIncidentIdentity({ ...left }));
  });
});

describe("effective circuit-breaker impact", () => {
  it("returns declared blocked and degraded impacts for open incidents", () => {
    expect(getEffectiveCircuitBreakerImpact(incident({ impact: "blocked" }), NOW)).toBe("blocked");
    expect(getEffectiveCircuitBreakerImpact(incident({ impact: "degraded" }), NOW)).toBe("degraded");
  });

  it("expires a cooldown exactly at its deadline", () => {
    const cooldown = incident({
      impact: "cooldown",
      timestamps: { cooldownUntil: NOW },
    });

    expect(getEffectiveCircuitBreakerImpact(cooldown, NOW - 1)).toBe("cooldown");
    expect(getEffectiveCircuitBreakerImpact(cooldown, NOW)).toBeNull();
  });

  it("fails closed when a cooldown deadline is missing or invalid", () => {
    expect(
      getEffectiveCircuitBreakerImpact(incident({ impact: "cooldown", timestamps: { cooldownUntil: null } }), NOW),
    ).toBe("blocked");
    expect(
      getEffectiveCircuitBreakerImpact(
        incident({ impact: "cooldown", timestamps: { cooldownUntil: Number.NaN } }),
        NOW,
      ),
    ).toBe("blocked");
  });

  it("keeps unresolved exposure blocked after its cooldown elapsed", () => {
    const unresolved = incident({
      impact: "cooldown",
      intentId: "intent-1",
      exposure: { state: "unresolved" },
      timestamps: { cooldownUntil: NOW - 1 },
    });

    expect(hasUnresolvedCircuitBreakerExposure(unresolved, NOW)).toBe(true);
    expect(getEffectiveCircuitBreakerImpact(unresolved, NOW)).toBe("blocked");
  });

  it("accepts only a valid persisted owner recovery proof", () => {
    const recovered = incident({
      impact: "cooldown",
      intentId: "intent-1",
      exposure: {
        state: "resolved",
        confirmedBy: "market-data",
        confirmedAt: 9_000,
        evidenceId: "venue-proof-1",
      },
      timestamps: { cooldownUntil: NOW - 1 },
    });
    const invalid = incident({
      ...recovered,
      exposure: {
        state: "resolved",
        confirmedBy: "another-owner",
        confirmedAt: 9_000,
        evidenceId: "venue-proof-1",
      },
    });

    expect(hasUnresolvedCircuitBreakerExposure(recovered, NOW)).toBe(false);
    expect(getEffectiveCircuitBreakerImpact(recovered, NOW)).toBeNull();
    expect(hasUnresolvedCircuitBreakerExposure(invalid, NOW)).toBe(true);
    expect(getEffectiveCircuitBreakerImpact(invalid, NOW)).toBe("blocked");
  });

  it("fails closed on a future-dated persisted recovery proof", () => {
    const futureProof = incident({
      impact: "cooldown",
      exposure: {
        state: "resolved",
        confirmedBy: "market-data",
        confirmedAt: NOW + 1,
        evidenceId: "future-proof",
      },
      timestamps: { cooldownUntil: NOW - 1 },
    });

    expect(hasUnresolvedCircuitBreakerExposure(futureProof, NOW)).toBe(true);
    expect(getEffectiveCircuitBreakerImpact(futureProof, NOW)).toBe("blocked");
  });

  it("does not treat acknowledgement alone as incident resolution", () => {
    const acknowledged = incident({
      impact: "blocked",
      exposure: { state: "unresolved" },
      timestamps: { acknowledgedAt: 9_000, resolvedAt: null },
    });

    expect(getEffectiveCircuitBreakerImpact(acknowledged, NOW)).toBe("blocked");
  });

  it("ignores resolved incidents", () => {
    expect(
      getEffectiveCircuitBreakerImpact(incident({ impact: "blocked", timestamps: { resolvedAt: 9_000 } }), NOW),
    ).toBeNull();
  });

  it("identifies manual kill by exact ownership identity and keeps it blocked", () => {
    const manualKill = incident({
      scope: { type: "global" },
      owner: "operator",
      incidentKey: "manual-kill",
      reason: "operator_requested",
      impact: "cooldown",
      resolutionPolicy: "operator",
      timestamps: { cooldownUntil: NOW - 1 },
    });

    expect(isManualKillIncident(manualKill)).toBe(true);
    expect(getEffectiveCircuitBreakerImpact(manualKill, NOW)).toBe("blocked");
    expect(isManualKillIncident({ ...manualKill, owner: "risk" })).toBe(false);
    expect(isManualKillIncident({ ...manualKill, incidentKey: "manual" })).toBe(false);
    expect(
      isManualKillIncident({
        ...manualKill,
        scope: { type: "asset", asset: "btc" },
      }),
    ).toBe(false);
    expect(isManualKillIncident({ ...manualKill, resolutionPolicy: "owner" })).toBe(false);
  });

  it("orders impact severity independently of reason labels", () => {
    expect(getWorstCircuitBreakerImpact(["degraded", "blocked", "cooldown"])).toBe("blocked");
    expect(getWorstCircuitBreakerImpact([null, "degraded"])).toBe("degraded");
    expect(getWorstCircuitBreakerImpact([null])).toBeNull();
    expect(shouldPauseExecutionForCircuitBreakerImpact("blocked")).toBe(true);
    expect(shouldPauseExecutionForCircuitBreakerImpact("cooldown")).toBe(true);
    expect(shouldPauseExecutionForCircuitBreakerImpact("degraded")).toBe(false);
  });
});

describe("multi-cause scope aggregation", () => {
  it("preserves every active cause and derives worst impact separately from dominant reason", () => {
    const oldestDegraded = incident({
      id: "old-feed",
      reason: "feed_stale",
      impact: "degraded",
      timestamps: { triggeredAt: 1_000 },
    });
    const newerExposure = incident({
      id: "new-exposure",
      owner: "execution",
      incidentKey: "unresolved-intent-7",
      reason: "hedge_failure",
      impact: "cooldown",
      intentId: "intent-7",
      exposure: { state: "unresolved" },
      timestamps: { triggeredAt: 2_000, cooldownUntil: 3_000 },
    });

    const [aggregate] = aggregateCircuitBreakerIncidents([newerExposure, oldestDegraded], NOW);

    expect(aggregate).toMatchObject({
      scopeKey: "asset:btc",
      worstImpact: "blocked",
      dominantIncidentId: "new-exposure",
      dominantReason: "hedge_failure",
      activeIncidentCount: 2,
      incidentIds: ["new-exposure", "old-feed"],
      intentIds: ["intent-7"],
      blockingIncidentIds: ["new-exposure"],
      cooldownIncidentIds: [],
      degradedIncidentIds: ["old-feed"],
    });
    expect(shouldPauseExecutionForCircuitBreakerImpact(aggregate.worstImpact)).toBe(true);
  });

  it("is deterministic regardless of input order", () => {
    const entries = [
      incident({ id: "z", owner: "z-owner", incidentKey: "b", reason: "z" }),
      incident({ id: "a", owner: "a-owner", incidentKey: "c", reason: "a" }),
      incident({ id: "b", owner: "a-owner", incidentKey: "a", reason: "b" }),
    ];

    expect(aggregateCircuitBreakerIncidents(entries, NOW)).toEqual(
      aggregateCircuitBreakerIncidents([...entries].reverse(), NOW),
    );
  });

  it("keeps scopes independent and sorts global, asset, then slot", () => {
    const aggregates = aggregateCircuitBreakerIncidents(
      [
        incident({
          id: "slot",
          scope: { type: "slot", asset: "btc", slotKey: "btc:2" },
        }),
        incident({ id: "asset", scope: { type: "asset", asset: "btc" } }),
        incident({ id: "global", scope: { type: "global" } }),
        incident({ id: "other-asset", scope: { type: "asset", asset: "eth" } }),
      ],
      NOW,
    );

    expect(aggregates.map((aggregate) => aggregate.scopeKey)).toEqual([
      "global",
      "asset:btc",
      "asset:eth",
      "slot:btc:2",
    ]);
  });

  it("omits resolved and expired cooldown incidents", () => {
    expect(
      aggregateCircuitBreakerIncidents(
        [
          incident({ id: "resolved", timestamps: { resolvedAt: NOW - 1 } }),
          incident({
            id: "expired",
            impact: "cooldown",
            timestamps: { cooldownUntil: NOW },
          }),
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  it("prioritizes manual kill as the displayed cause while preserving all impacts", () => {
    const aggregate = aggregateCircuitBreakerIncidents(
      [
        incident({
          id: "risk",
          scope: { type: "global" },
          owner: "risk",
          incidentKey: "daily-loss",
          reason: "daily_loss_cap",
          impact: "blocked",
          timestamps: { triggeredAt: 1_000 },
        }),
        incident({
          id: "kill",
          scope: { type: "global" },
          owner: "operator",
          incidentKey: "manual-kill",
          reason: "operator_requested",
          impact: "blocked",
          resolutionPolicy: "operator",
          timestamps: { triggeredAt: 2_000 },
        }),
      ],
      NOW,
    )[0];

    expect(aggregate).toMatchObject({
      dominantIncidentId: "kill",
      dominantReason: "operator_requested",
      manualKillActive: true,
      requiresOperatorAcknowledgement: true,
      worstImpact: "blocked",
    });
  });

  it("computes relevant aggregates and worst impact across global, asset, and current slot", () => {
    const aggregates = aggregateCircuitBreakerIncidents(
      [
        incident({
          id: "global",
          scope: { type: "global" },
          impact: "degraded",
        }),
        incident({
          id: "btc",
          scope: { type: "asset", asset: "btc" },
          impact: "cooldown",
          timestamps: { cooldownUntil: NOW + 1_000 },
        }),
        incident({
          id: "btc-current",
          scope: { type: "slot", asset: "btc", slotKey: "btc:1" },
          impact: "blocked",
        }),
        incident({
          id: "btc-old",
          scope: { type: "slot", asset: "btc", slotKey: "btc:0" },
          impact: "blocked",
        }),
        incident({
          id: "eth",
          scope: { type: "asset", asset: "eth" },
          impact: "blocked",
        }),
      ],
      NOW,
    );

    expect(
      getRelevantCircuitBreakerAggregates(aggregates, "btc", "btc:1").map((aggregate) => aggregate.scopeKey),
    ).toEqual(["global", "asset:btc", "slot:btc:1"]);
    expect(getWorstRelevantCircuitBreakerImpact(aggregates, "btc", "btc:1")).toBe("blocked");
    expect(getWorstRelevantCircuitBreakerImpact(aggregates, "btc", null)).toBe("cooldown");
  });
});

describe("incident resolution policy", () => {
  it("allows only the matching owner to auto-resolve a recovered owner incident", () => {
    const target = incident();
    const baseRequest = {
      owner: "market-data",
      expectedRevision: 3,
      now: NOW,
      conditionRecovered: true,
    };

    expect(evaluateOwnerAutoResolve(target, baseRequest)).toEqual({
      allowed: true,
      code: "allowed",
    });
    expect(evaluateOwnerAutoResolve(target, { ...baseRequest, owner: "risk" })).toEqual({
      allowed: false,
      code: "owner_mismatch",
    });
    expect(evaluateOwnerAutoResolve(target, { ...baseRequest, owner: "" })).toEqual({
      allowed: false,
      code: "invalid_actor",
    });
    expect(evaluateOwnerAutoResolve(target, { ...baseRequest, expectedRevision: 2 })).toEqual({
      allowed: false,
      code: "revision_conflict",
    });
    expect(evaluateOwnerAutoResolve(target, { ...baseRequest, conditionRecovered: false })).toEqual({
      allowed: false,
      code: "condition_not_recovered",
    });
  });

  it("does not auto-resolve operator-owned incidents", () => {
    const target = incident({ resolutionPolicy: "operator" });

    expect(
      evaluateOwnerAutoResolve(target, {
        owner: target.owner,
        expectedRevision: target.revision,
        now: NOW,
        conditionRecovered: true,
      }),
    ).toEqual({ allowed: false, code: "resolution_policy_mismatch" });
  });

  it("requires an owner cooldown to elapse", () => {
    const target = incident({
      impact: "cooldown",
      timestamps: { cooldownUntil: NOW + 1 },
    });
    const request = {
      owner: target.owner,
      expectedRevision: target.revision,
      now: NOW,
      conditionRecovered: true,
    };

    expect(evaluateOwnerAutoResolve(target, request)).toEqual({
      allowed: false,
      code: "cooldown_active",
    });
    expect(
      evaluateOwnerAutoResolve(incident({ impact: "cooldown", timestamps: { cooldownUntil: null } }), request),
    ).toEqual({ allowed: false, code: "cooldown_active" });
  });

  it("does not auto-resolve unresolved exposure after cooldown without fresh owner proof", () => {
    const target = incident({
      owner: "execution",
      intentId: "intent-9",
      impact: "cooldown",
      exposure: { state: "unresolved" },
      timestamps: { cooldownUntil: NOW - 1 },
    });
    const request = {
      owner: "execution",
      expectedRevision: 3,
      now: NOW,
      conditionRecovered: true,
    };

    expect(evaluateOwnerAutoResolve(target, request)).toEqual({
      allowed: false,
      code: "unresolved_exposure",
    });
    expect(
      evaluateOwnerAutoResolve(target, {
        ...request,
        exposureRecoveryProof: {
          owner: "risk",
          confirmedAt: 9_000,
          evidenceId: "proof-9",
        },
      }),
    ).toEqual({ allowed: false, code: "invalid_recovery_proof" });
    expect(
      evaluateOwnerAutoResolve(target, {
        ...request,
        exposureRecoveryProof: {
          owner: "execution",
          confirmedAt: 999,
          evidenceId: "proof-9",
        },
      }),
    ).toEqual({ allowed: false, code: "invalid_recovery_proof" });
    expect(
      evaluateOwnerAutoResolve(target, {
        ...request,
        exposureRecoveryProof: {
          owner: "execution",
          confirmedAt: 9_000,
          evidenceId: "proof-9",
        },
      }),
    ).toEqual({ allowed: true, code: "allowed" });
  });

  it("rejects auto-resolution of an already resolved incident", () => {
    const target = incident({ timestamps: { resolvedAt: NOW - 1 } });

    expect(
      evaluateOwnerAutoResolve(target, {
        owner: target.owner,
        expectedRevision: target.revision,
        now: NOW,
        conditionRecovered: true,
      }),
    ).toEqual({ allowed: false, code: "already_resolved" });
  });

  it("allows an identified operator to acknowledge an operator-policy incident", () => {
    const target = incident({
      resolutionPolicy: "operator",
      impact: "cooldown",
      timestamps: { cooldownUntil: NOW + 60_000 },
    });

    expect(
      evaluateOperatorAcknowledge(target, {
        operatorId: "basic:admin",
        expectedRevision: target.revision,
        now: NOW,
      }),
    ).toEqual({ allowed: true, code: "allowed" });
    expect(
      evaluateOperatorAcknowledge(target, {
        operatorId: "  ",
        expectedRevision: target.revision,
        now: NOW,
      }),
    ).toEqual({ allowed: false, code: "invalid_actor" });
  });

  it("prevents operator acknowledgement from hiding unresolved exposure without owner proof", () => {
    const target = incident({
      owner: "execution",
      resolutionPolicy: "operator",
      intentId: "intent-10",
      exposure: { state: "unresolved" },
    });
    const request = {
      operatorId: "basic:admin",
      expectedRevision: target.revision,
      now: NOW,
    };

    expect(evaluateOperatorAcknowledge(target, request)).toEqual({
      allowed: false,
      code: "unresolved_exposure",
    });
    expect(
      evaluateOperatorAcknowledge(
        {
          ...target,
          exposure: {
            state: "resolved",
            confirmedBy: "execution",
            confirmedAt: 9_000,
            evidenceId: "venue-proof-10",
          },
        },
        request,
      ),
    ).toEqual({ allowed: true, code: "allowed" });
  });

  it("does not let operator acknowledgement resolve owner-policy incidents or stale revisions", () => {
    const ownerPolicy = incident();
    const operatorPolicy = incident({ resolutionPolicy: "operator" });

    expect(
      evaluateOperatorAcknowledge(ownerPolicy, {
        operatorId: "basic:admin",
        expectedRevision: ownerPolicy.revision,
        now: NOW,
      }),
    ).toEqual({ allowed: false, code: "resolution_policy_mismatch" });
    expect(
      evaluateOperatorAcknowledge(operatorPolicy, {
        operatorId: "basic:admin",
        expectedRevision: operatorPolicy.revision - 1,
        now: NOW,
      }),
    ).toEqual({ allowed: false, code: "revision_conflict" });
  });
});

describe("legacy UI projection", () => {
  it("projects one explicitly lossy row per active scope", () => {
    const aggregates = aggregateCircuitBreakerIncidents(
      [
        incident({
          id: "old-feed",
          reason: "feed_stale",
          impact: "degraded",
          timestamps: { triggeredAt: 1_000 },
        }),
        incident({
          id: "risk-block",
          owner: "risk",
          incidentKey: "capital-limit",
          reason: "risk_limit",
          impact: "blocked",
          timestamps: { triggeredAt: 2_000 },
        }),
      ],
      NOW,
    );

    expect(projectLegacyCircuitBreakersForUi(aggregates)).toEqual([
      {
        key: "asset:btc",
        active: true,
        reason: "risk_limit",
        triggeredAt: 1_000,
        payload: {
          projectionVersion: "multi-cause-ui-v1",
          uiProjectionOnly: true,
          worstImpact: "blocked",
          dominantIncidentId: "risk-block",
          incidentIds: ["old-feed", "risk-block"],
          incidentKeys: ["capital-limit", "kalshi-stale"],
          intentIds: [],
          owners: ["market-data", "risk"],
          reasons: ["feed_stale", "risk_limit"],
          manualKillActive: false,
          requiresManualClear: false,
          cooldownUntil: null,
        },
      },
    ]);
  });

  it("marks manual kill and operator acknowledgement without conflating other causes", () => {
    const [projection] = projectLegacyCircuitBreakersForUi(
      aggregateCircuitBreakerIncidents(
        [
          incident({
            id: "kill",
            scope: { type: "global" },
            owner: "operator",
            incidentKey: "manual-kill",
            reason: "operator_requested",
            impact: "blocked",
            resolutionPolicy: "operator",
          }),
          incident({
            id: "rpc",
            scope: { type: "global" },
            owner: "infrastructure",
            incidentKey: "rpc-unhealthy",
            reason: "rpc_unhealthy",
            impact: "degraded",
          }),
        ],
        NOW,
      ),
    );

    expect(projection.reason).toBe("operator_requested");
    expect(projection.payload).toMatchObject({
      worstImpact: "blocked",
      manualKillActive: true,
      requiresManualClear: true,
      incidentIds: ["rpc", "kill"],
    });
  });
});
