import type { CircuitBreakerIncident, CircuitBreakerIncidentTimestamps } from "@/lib/circuit-breaker-policy";
import {
  isShadowAccountingTerminalizationIncident,
  selectAcknowledgeableBreakerIncident,
  shouldListOperationalBreaker,
} from "@/lib/circuit-breaker-ui";
import type { CircuitBreaker } from "@/lib/types";

const TIMESTAMPS: CircuitBreakerIncidentTimestamps = {
  triggeredAt: 1,
  updatedAt: 1,
  lastObservedAt: 1,
  cooldownUntil: null,
  acknowledgedAt: null,
  resolvedAt: null,
};

function incident(overrides: Partial<CircuitBreakerIncident> = {}): CircuitBreakerIncident {
  return {
    id: "incident-1",
    scope: { type: "global" },
    owner: "execution",
    incidentKey: "venue-error",
    reason: "venue_error",
    impact: "blocked",
    resolutionPolicy: "operator",
    intentId: "intent-1",
    exposure: {
      state: "resolved",
      confirmedBy: "execution",
      confirmedAt: 2,
      evidenceId: "intent:intent-1:revision:2",
    },
    revision: 2,
    timestamps: TIMESTAMPS,
    payload: null,
    ...overrides,
  };
}

function breaker(payload: Record<string, unknown>): CircuitBreaker {
  return {
    key: "global",
    active: true,
    reason: "manual",
    triggeredAt: 1,
    payload,
  };
}

describe("circuit-breaker UI policy", () => {
  it("keeps the manual-kill toggle separate while listing every other global cause", () => {
    expect(
      shouldListOperationalBreaker(
        breaker({
          manualKillActive: true,
          incidentKeys: ["manual-kill"],
        }),
      ),
    ).toBe(false);
    expect(
      shouldListOperationalBreaker(
        breaker({
          manualKillActive: true,
          incidentKeys: ["manual-kill", "venue-error"],
        }),
      ),
    ).toBe(true);
    expect(
      shouldListOperationalBreaker(
        breaker({
          manualKillActive: false,
          incidentKeys: ["venue-error"],
        }),
      ),
    ).toBe(true);
  });

  it("selects only an exact non-manual operator incident with resolved exposure", () => {
    const manualKill = incident({
      id: "manual",
      owner: "operator",
      incidentKey: "manual-kill",
      intentId: null,
      exposure: { state: "none" },
    });
    const unresolved = incident({
      id: "unresolved",
      exposure: { state: "unresolved" },
    });
    const resolved = incident({ id: "resolved" });

    expect(selectAcknowledgeableBreakerIncident([manualKill, unresolved, resolved], "global", "intent-1")).toBe(
      resolved,
    );
    expect(selectAcknowledgeableBreakerIncident([manualKill, unresolved], "global", "intent-1")).toBeNull();
    expect(selectAcknowledgeableBreakerIncident([resolved], "global", "another-intent")).toBeNull();
  });

  it("allows only the explicit shadow accounting recovery flow to select unresolved exposure", () => {
    const accounting = incident({
      id: "shadow-accounting",
      reason: "hedge_failure",
      exposure: { state: "unresolved" },
      payload: {
        stage: "accounting_terminalization_venue_settlement",
        disposition: "manual_intervention",
      },
    });
    const unrelated = incident({
      id: "unrelated",
      exposure: { state: "unresolved" },
      payload: { stage: "late_fill", disposition: "manual_intervention" },
    });

    expect(isShadowAccountingTerminalizationIncident(accounting)).toBe(true);
    expect(selectAcknowledgeableBreakerIncident([accounting], "global", "intent-1")).toBeNull();
    expect(selectAcknowledgeableBreakerIncident([unrelated], "global", "intent-1", true)).toBeNull();
    expect(selectAcknowledgeableBreakerIncident([accounting], "global", "intent-1", true)).toBe(accounting);
  });
});
