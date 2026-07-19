export type CircuitBreakerAsset = "btc" | "eth" | "sol" | "xrp" | "doge" | "bnb" | "hype";

export type CircuitBreakerScope =
  | { type: "global" }
  | { type: "asset"; asset: CircuitBreakerAsset }
  | { type: "slot"; asset: CircuitBreakerAsset; slotKey: string };

export type CircuitBreakerImpact = "blocked" | "cooldown" | "degraded";
export type CircuitBreakerResolutionPolicy = "owner" | "operator";

export type CircuitBreakerExposure =
  | { state: "none" }
  | { state: "unresolved" }
  | {
      state: "resolved";
      confirmedBy: string;
      confirmedAt: number;
      evidenceId: string;
    };

export type CircuitBreakerIncidentTimestamps = {
  triggeredAt: number;
  updatedAt: number;
  lastObservedAt: number;
  cooldownUntil: number | null;
  acknowledgedAt: number | null;
  resolvedAt: number | null;
};

export type CircuitBreakerIncident = {
  id: string;
  scope: CircuitBreakerScope;
  owner: string;
  incidentKey: string;
  reason: string;
  impact: CircuitBreakerImpact;
  resolutionPolicy: CircuitBreakerResolutionPolicy;
  intentId: string | null;
  exposure: CircuitBreakerExposure;
  revision: number;
  timestamps: CircuitBreakerIncidentTimestamps;
  payload: Readonly<Record<string, unknown>> | null;
};

export type CircuitBreakerScopeAggregate = {
  scope: CircuitBreakerScope;
  scopeKey: string;
  worstImpact: CircuitBreakerImpact;
  dominantIncidentId: string;
  dominantReason: string;
  triggeredAt: number;
  cooldownUntil: number | null;
  activeIncidentCount: number;
  incidentIds: string[];
  incidentKeys: string[];
  intentIds: string[];
  owners: string[];
  reasons: string[];
  blockingIncidentIds: string[];
  cooldownIncidentIds: string[];
  degradedIncidentIds: string[];
  manualKillActive: boolean;
  requiresOperatorAcknowledgement: boolean;
};

export type CircuitBreakerRecoveryProof = {
  owner: string;
  confirmedAt: number;
  evidenceId: string;
};

export type CircuitBreakerPolicyDenialCode =
  | "already_resolved"
  | "condition_not_recovered"
  | "cooldown_active"
  | "invalid_actor"
  | "invalid_recovery_proof"
  | "owner_mismatch"
  | "resolution_policy_mismatch"
  | "revision_conflict"
  | "unresolved_exposure";

export type CircuitBreakerPolicyDecision =
  { allowed: true; code: "allowed" } | { allowed: false; code: CircuitBreakerPolicyDenialCode };

export type OwnerAutoResolveRequest = {
  owner: string;
  expectedRevision: number;
  now: number;
  conditionRecovered: boolean;
  exposureRecoveryProof?: CircuitBreakerRecoveryProof | null;
};

export type OperatorAcknowledgeRequest = {
  operatorId: string;
  expectedRevision: number;
  now: number;
};

export type LegacyCircuitBreakerUiProjection = {
  key: string;
  active: true;
  reason: string;
  triggeredAt: number;
  payload: {
    projectionVersion: "multi-cause-ui-v1";
    uiProjectionOnly: true;
    worstImpact: CircuitBreakerImpact;
    dominantIncidentId: string;
    incidentIds: string[];
    incidentKeys: string[];
    intentIds: string[];
    owners: string[];
    reasons: string[];
    manualKillActive: boolean;
    requiresManualClear: boolean;
    cooldownUntil: number | null;
  };
};

export const MANUAL_KILL_OWNER = "operator";
export const MANUAL_KILL_INCIDENT_KEY = "manual-kill";

const IMPACT_SEVERITY: Record<CircuitBreakerImpact, number> = {
  degraded: 1,
  cooldown: 2,
  blocked: 3,
};

export function isGlobalCircuitBreakerScope(
  scope: CircuitBreakerScope,
): scope is Extract<CircuitBreakerScope, { type: "global" }> {
  return scope.type === "global";
}

export function isAssetCircuitBreakerScope(
  scope: CircuitBreakerScope,
): scope is Extract<CircuitBreakerScope, { type: "asset" }> {
  return scope.type === "asset";
}

export function isSlotCircuitBreakerScope(
  scope: CircuitBreakerScope,
): scope is Extract<CircuitBreakerScope, { type: "slot" }> {
  return scope.type === "slot";
}

export function getCircuitBreakerScopeKey(scope: CircuitBreakerScope) {
  if (scope.type === "global") {
    return "global";
  }
  if (scope.type === "asset") {
    return `asset:${scope.asset}`;
  }
  return scope.slotKey.startsWith(`${scope.asset}:`) ? `slot:${scope.slotKey}` : `slot:${scope.asset}:${scope.slotKey}`;
}

export function getCircuitBreakerIncidentIdentity(
  incident: Pick<CircuitBreakerIncident, "scope" | "owner" | "incidentKey">,
) {
  return JSON.stringify([getScopeIdentityParts(incident.scope), incident.owner, incident.incidentKey]);
}

export function isCircuitBreakerScopeRelevant(
  scope: CircuitBreakerScope,
  asset: CircuitBreakerAsset,
  slotKey: string | null,
) {
  if (scope.type === "global") {
    return true;
  }
  if (scope.asset !== asset) {
    return false;
  }
  return scope.type === "asset" || (slotKey !== null && scope.slotKey === slotKey);
}

export function isCircuitBreakerIncidentRelevant(
  incident: Pick<CircuitBreakerIncident, "scope">,
  asset: CircuitBreakerAsset,
  slotKey: string | null,
) {
  return isCircuitBreakerScopeRelevant(incident.scope, asset, slotKey);
}

export function isManualKillIncident(
  incident: Pick<CircuitBreakerIncident, "scope" | "owner" | "incidentKey" | "resolutionPolicy">,
) {
  return (
    incident.scope.type === "global" &&
    incident.owner === MANUAL_KILL_OWNER &&
    incident.incidentKey === MANUAL_KILL_INCIDENT_KEY &&
    incident.resolutionPolicy === "operator"
  );
}

export function isCircuitBreakerIncidentOpen(incident: Pick<CircuitBreakerIncident, "timestamps">) {
  return incident.timestamps.resolvedAt === null;
}

export function hasUnresolvedCircuitBreakerExposure(
  incident: Pick<CircuitBreakerIncident, "owner" | "exposure" | "timestamps">,
  now: number,
) {
  if (incident.exposure.state === "none") {
    return false;
  }
  if (incident.exposure.state === "unresolved") {
    return true;
  }
  return !isValidRecoveryProof(
    incident,
    {
      owner: incident.exposure.confirmedBy,
      confirmedAt: incident.exposure.confirmedAt,
      evidenceId: incident.exposure.evidenceId,
    },
    now,
  );
}

export function getEffectiveCircuitBreakerImpact(
  incident: CircuitBreakerIncident,
  now: number,
): CircuitBreakerImpact | null {
  if (!isCircuitBreakerIncidentOpen(incident)) {
    return null;
  }

  if (isManualKillIncident(incident) || hasUnresolvedCircuitBreakerExposure(incident, now)) {
    return "blocked";
  }

  if (incident.impact !== "cooldown") {
    return incident.impact;
  }

  const cooldownUntil = incident.timestamps.cooldownUntil;
  if (!isFiniteTimestamp(cooldownUntil)) {
    return "blocked";
  }
  return now < cooldownUntil ? "cooldown" : null;
}

export function getWorstCircuitBreakerImpact(
  impacts: ReadonlyArray<CircuitBreakerImpact | null>,
): CircuitBreakerImpact | null {
  let worst: CircuitBreakerImpact | null = null;
  for (const impact of impacts) {
    if (impact !== null && (worst === null || IMPACT_SEVERITY[impact] > IMPACT_SEVERITY[worst])) {
      worst = impact;
    }
  }
  return worst;
}

export function shouldPauseExecutionForCircuitBreakerImpact(impact: CircuitBreakerImpact | null) {
  return impact === "blocked" || impact === "cooldown";
}

export function aggregateCircuitBreakerIncidents(
  incidents: ReadonlyArray<CircuitBreakerIncident>,
  now: number,
): CircuitBreakerScopeAggregate[] {
  const byScope = new Map<string, Array<{ incident: CircuitBreakerIncident; effectiveImpact: CircuitBreakerImpact }>>();

  for (const incident of incidents) {
    const effectiveImpact = getEffectiveCircuitBreakerImpact(incident, now);
    if (effectiveImpact === null) {
      continue;
    }

    const scopeIdentity = JSON.stringify(getScopeIdentityParts(incident.scope));
    const entries = byScope.get(scopeIdentity) ?? [];
    entries.push({ incident, effectiveImpact });
    byScope.set(scopeIdentity, entries);
  }

  return [...byScope.values()].map(buildScopeAggregate).sort((left, right) => compareScopes(left.scope, right.scope));
}

export function getRelevantCircuitBreakerAggregates(
  aggregates: ReadonlyArray<CircuitBreakerScopeAggregate>,
  asset: CircuitBreakerAsset,
  slotKey: string | null,
) {
  return aggregates
    .filter((aggregate) => isCircuitBreakerScopeRelevant(aggregate.scope, asset, slotKey))
    .sort((left, right) => compareScopes(left.scope, right.scope));
}

export function getWorstRelevantCircuitBreakerImpact(
  aggregates: ReadonlyArray<CircuitBreakerScopeAggregate>,
  asset: CircuitBreakerAsset,
  slotKey: string | null,
) {
  return getWorstCircuitBreakerImpact(
    getRelevantCircuitBreakerAggregates(aggregates, asset, slotKey).map((aggregate) => aggregate.worstImpact),
  );
}

export function evaluateOwnerAutoResolve(
  incident: CircuitBreakerIncident,
  request: OwnerAutoResolveRequest,
): CircuitBreakerPolicyDecision {
  const commonDenial = evaluateCommonResolutionPreconditions(incident, request.expectedRevision);
  if (commonDenial !== null) {
    return commonDenial;
  }
  if (incident.resolutionPolicy !== "owner") {
    return denied("resolution_policy_mismatch");
  }
  if (!request.owner.trim()) {
    return denied("invalid_actor");
  }
  if (request.owner !== incident.owner) {
    return denied("owner_mismatch");
  }
  if (!request.conditionRecovered) {
    return denied("condition_not_recovered");
  }

  const exposureDenial = evaluateExposureResolution(incident, request.exposureRecoveryProof, request.now);
  if (exposureDenial !== null) {
    return exposureDenial;
  }

  if (
    incident.impact === "cooldown" &&
    (!isFiniteTimestamp(incident.timestamps.cooldownUntil) || request.now < incident.timestamps.cooldownUntil)
  ) {
    return denied("cooldown_active");
  }

  return { allowed: true, code: "allowed" };
}

export function evaluateOperatorAcknowledge(
  incident: CircuitBreakerIncident,
  request: OperatorAcknowledgeRequest,
): CircuitBreakerPolicyDecision {
  const commonDenial = evaluateCommonResolutionPreconditions(incident, request.expectedRevision);
  if (commonDenial !== null) {
    return commonDenial;
  }
  if (incident.resolutionPolicy !== "operator") {
    return denied("resolution_policy_mismatch");
  }
  if (!request.operatorId.trim()) {
    return denied("invalid_actor");
  }

  // Operators acknowledge a recovery already proven and persisted by the
  // owning subsystem; they cannot manufacture venue/exposure evidence.
  const exposureDenial = evaluateExposureResolution(incident, undefined, request.now);
  if (exposureDenial !== null) {
    return exposureDenial;
  }

  return { allowed: true, code: "allowed" };
}

// This lossy projection exists only for legacy operator UI reads. Execution and
// readiness decisions must consume incidents or scope aggregates directly.
export function projectLegacyCircuitBreakersForUi(
  aggregates: ReadonlyArray<CircuitBreakerScopeAggregate>,
): LegacyCircuitBreakerUiProjection[] {
  return [...aggregates]
    .sort((left, right) => compareScopes(left.scope, right.scope))
    .map((aggregate) => ({
      key: aggregate.scopeKey,
      active: true,
      reason: aggregate.dominantReason,
      triggeredAt: aggregate.triggeredAt,
      payload: {
        projectionVersion: "multi-cause-ui-v1",
        uiProjectionOnly: true,
        worstImpact: aggregate.worstImpact,
        dominantIncidentId: aggregate.dominantIncidentId,
        incidentIds: [...aggregate.incidentIds],
        incidentKeys: [...aggregate.incidentKeys],
        intentIds: [...aggregate.intentIds],
        owners: [...aggregate.owners],
        reasons: [...aggregate.reasons],
        manualKillActive: aggregate.manualKillActive,
        requiresManualClear: aggregate.requiresOperatorAcknowledgement,
        cooldownUntil: aggregate.cooldownUntil,
      },
    }));
}

function buildScopeAggregate(
  entries: Array<{
    incident: CircuitBreakerIncident;
    effectiveImpact: CircuitBreakerImpact;
  }>,
): CircuitBreakerScopeAggregate {
  const sortedByIdentity = [...entries].sort((left, right) => compareIncidentIdentity(left.incident, right.incident));
  const dominant = [...entries].sort(compareDominantIncident)[0];
  const worstImpact = getWorstCircuitBreakerImpact(entries.map((entry) => entry.effectiveImpact));

  if (!dominant || worstImpact === null) {
    throw new Error("Cannot aggregate an empty circuit-breaker scope");
  }

  const cooldownUntilValues = entries
    .filter((entry) => entry.effectiveImpact === "cooldown")
    .map((entry) => entry.incident.timestamps.cooldownUntil)
    .filter(isFiniteTimestamp);

  return {
    scope: dominant.incident.scope,
    scopeKey: getCircuitBreakerScopeKey(dominant.incident.scope),
    worstImpact,
    dominantIncidentId: dominant.incident.id,
    dominantReason: dominant.incident.reason,
    triggeredAt: Math.min(...entries.map((entry) => normalizedTimestamp(entry.incident.timestamps.triggeredAt))),
    cooldownUntil: cooldownUntilValues.length > 0 ? Math.max(...cooldownUntilValues) : null,
    activeIncidentCount: entries.length,
    incidentIds: sortedByIdentity.map((entry) => entry.incident.id),
    incidentKeys: uniqueSorted(entries.map((entry) => entry.incident.incidentKey)),
    intentIds: uniqueSorted(
      entries.flatMap((entry) => (entry.incident.intentId === null ? [] : [entry.incident.intentId])),
    ),
    owners: uniqueSorted(entries.map((entry) => entry.incident.owner)),
    reasons: uniqueSorted(entries.map((entry) => entry.incident.reason)),
    blockingIncidentIds: idsForImpact(entries, "blocked"),
    cooldownIncidentIds: idsForImpact(entries, "cooldown"),
    degradedIncidentIds: idsForImpact(entries, "degraded"),
    manualKillActive: entries.some((entry) => isManualKillIncident(entry.incident)),
    requiresOperatorAcknowledgement: entries.some((entry) => entry.incident.resolutionPolicy === "operator"),
  };
}

function evaluateCommonResolutionPreconditions(
  incident: CircuitBreakerIncident,
  expectedRevision: number,
): CircuitBreakerPolicyDecision | null {
  if (!isCircuitBreakerIncidentOpen(incident)) {
    return denied("already_resolved");
  }
  if (expectedRevision !== incident.revision) {
    return denied("revision_conflict");
  }
  return null;
}

function evaluateExposureResolution(
  incident: CircuitBreakerIncident,
  recoveryProof: CircuitBreakerRecoveryProof | null | undefined,
  now: number,
): CircuitBreakerPolicyDecision | null {
  if (incident.exposure.state === "none") {
    return null;
  }

  if (incident.exposure.state === "resolved") {
    return hasUnresolvedCircuitBreakerExposure(incident, now) ? denied("invalid_recovery_proof") : null;
  }

  if (recoveryProof === null || recoveryProof === undefined) {
    return denied("unresolved_exposure");
  }

  return isValidRecoveryProof(incident, recoveryProof, now) ? null : denied("invalid_recovery_proof");
}

function isValidRecoveryProof(
  incident: Pick<CircuitBreakerIncident, "owner" | "timestamps">,
  proof: CircuitBreakerRecoveryProof,
  now: number,
) {
  return (
    proof.owner === incident.owner &&
    proof.evidenceId.trim().length > 0 &&
    isFiniteTimestamp(proof.confirmedAt) &&
    isFiniteTimestamp(incident.timestamps.triggeredAt) &&
    proof.confirmedAt >= incident.timestamps.triggeredAt &&
    proof.confirmedAt <= now
  );
}

function denied(code: CircuitBreakerPolicyDenialCode): CircuitBreakerPolicyDecision {
  return { allowed: false, code };
}

function idsForImpact(
  entries: Array<{
    incident: CircuitBreakerIncident;
    effectiveImpact: CircuitBreakerImpact;
  }>,
  impact: CircuitBreakerImpact,
) {
  return entries
    .filter((entry) => entry.effectiveImpact === impact)
    .map((entry) => entry.incident.id)
    .sort(compareText);
}

function compareDominantIncident(
  left: { incident: CircuitBreakerIncident; effectiveImpact: CircuitBreakerImpact },
  right: { incident: CircuitBreakerIncident; effectiveImpact: CircuitBreakerImpact },
) {
  const manualKillDelta = Number(isManualKillIncident(right.incident)) - Number(isManualKillIncident(left.incident));
  if (manualKillDelta !== 0) {
    return manualKillDelta;
  }

  const impactDelta = IMPACT_SEVERITY[right.effectiveImpact] - IMPACT_SEVERITY[left.effectiveImpact];
  if (impactDelta !== 0) {
    return impactDelta;
  }

  const timeDelta =
    normalizedTimestamp(left.incident.timestamps.triggeredAt) -
    normalizedTimestamp(right.incident.timestamps.triggeredAt);
  return timeDelta || compareIncidentIdentity(left.incident, right.incident);
}

function compareIncidentIdentity(
  left: Pick<CircuitBreakerIncident, "id" | "scope" | "owner" | "incidentKey">,
  right: Pick<CircuitBreakerIncident, "id" | "scope" | "owner" | "incidentKey">,
) {
  return (
    compareText(getCircuitBreakerIncidentIdentity(left), getCircuitBreakerIncidentIdentity(right)) ||
    compareText(left.id, right.id)
  );
}

function compareScopes(left: CircuitBreakerScope, right: CircuitBreakerScope) {
  return compareText(JSON.stringify(getScopeIdentityParts(left)), JSON.stringify(getScopeIdentityParts(right)));
}

function getScopeIdentityParts(scope: CircuitBreakerScope) {
  if (scope.type === "global") {
    return ["0-global"];
  }
  if (scope.type === "asset") {
    return ["1-asset", scope.asset];
  }
  return ["2-slot", scope.asset, scope.slotKey];
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedTimestamp(value: number) {
  return isFiniteTimestamp(value) ? value : Number.MAX_SAFE_INTEGER;
}

function isFiniteTimestamp(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
