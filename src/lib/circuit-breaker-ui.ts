import {
  getCircuitBreakerScopeKey,
  isManualKillIncident,
  type CircuitBreakerIncident,
} from "@/lib/circuit-breaker-policy";
import type { CircuitBreaker, CircuitBreakerKey } from "@/lib/types";

export function shouldListOperationalBreaker(breaker: CircuitBreaker) {
  if (breaker.key !== "global") {
    return true;
  }

  const incidentKeys = Array.isArray(breaker.payload?.incidentKeys)
    ? breaker.payload.incidentKeys.filter((value): value is string => typeof value === "string")
    : [];
  return (
    breaker.payload?.manualKillActive !== true || incidentKeys.some((incidentKey) => incidentKey !== "manual-kill")
  );
}

export function selectAcknowledgeableBreakerIncident(
  incidents: readonly CircuitBreakerIncident[],
  key: CircuitBreakerKey,
  intentId?: string,
  allowUnresolvedShadowAccounting = false,
) {
  return (
    incidents.find(
      (incident) =>
        getCircuitBreakerScopeKey(incident.scope) === key &&
        incident.resolutionPolicy === "operator" &&
        !isManualKillIncident(incident) &&
        (incident.exposure.state !== "unresolved" ||
          (allowUnresolvedShadowAccounting && isShadowAccountingTerminalizationIncident(incident))) &&
        (intentId === undefined || incident.intentId === intentId),
    ) ?? null
  );
}

export function isShadowAccountingTerminalizationIncident(incident: CircuitBreakerIncident) {
  return (
    incident.owner === "execution" &&
    incident.reason === "hedge_failure" &&
    incident.payload?.disposition === "manual_intervention" &&
    typeof incident.payload?.stage === "string" &&
    incident.payload.stage.startsWith("accounting_terminalization_")
  );
}
