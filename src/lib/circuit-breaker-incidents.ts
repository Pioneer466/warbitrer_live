import { MANUAL_KILL_INCIDENT_KEY, MANUAL_KILL_OWNER, getCircuitBreakerScopeKey } from "@/lib/circuit-breaker-policy";
import type {
  CircuitBreakerAsset,
  CircuitBreakerExposure,
  CircuitBreakerImpact,
  CircuitBreakerIncident,
  CircuitBreakerResolutionPolicy,
  CircuitBreakerScope,
} from "@/lib/circuit-breaker-policy";
import type { FeedSource, Venue } from "@/lib/types";

export const CIRCUIT_BREAKER_INCIDENT_OWNERS = {
  manualKill: MANUAL_KILL_OWNER,
  marketFeed: "market-data",
  execution: "execution",
  dailyLoss: "risk",
  marketDegraded: "fill-quality",
  polygonRpc: "polygon-rpc-health",
} as const;

export const INITIAL_CIRCUIT_BREAKER_INCIDENT_REVISION = 1;

export type ManualKillIncidentInput = {
  triggeredAt: number;
  operatorId: string;
  note?: string | null;
};

export type MarketFeedIncidentInput = {
  asset: CircuitBreakerAsset;
  slotKey: string;
  venue: Venue;
  source: FeedSource;
  triggeredAt: number;
  stalenessMs: number | null;
  details: readonly string[];
};

export type ExecutionIncidentReason = "hedge_failure" | "primary_no_fill" | "venue_error";
export type ExecutionIncidentDisposition = "cooldown" | "truth_pending" | "manual_intervention";

type ExecutionIncidentBaseInput = {
  asset: CircuitBreakerAsset;
  slotKey: string;
  intentId: string;
  stage: string;
  reason: ExecutionIncidentReason;
  venue: Venue;
  orderId?: string | null;
  triggeredAt: number;
};

export type ExecutionIncidentInput = ExecutionIncidentBaseInput &
  (
    | {
        disposition: "cooldown";
        cooldownUntil: number;
      }
    | {
        disposition: "truth_pending" | "manual_intervention";
        cooldownUntil?: never;
      }
  );

export type DailyLossIncidentInput = {
  triggeredAt: number;
  dayStart: number;
  realizedPnlUsd: number;
  lossCapUsd: number;
};

export type MarketDegradedIncidentInput = {
  asset: CircuitBreakerAsset;
  slotKey: string;
  triggeredAt: number;
  cooldownUntil: number;
  degradedCount: number;
  windowMs: number;
};

export type PolygonRpcFailureKind = "missing_configuration" | "health_check_failed";

export type PolygonRpcIncidentInput = {
  triggeredAt: number;
  failureKind: PolygonRpcFailureKind;
  detail: string;
};

type CanonicalIncidentInput = {
  scope: CircuitBreakerScope;
  owner: string;
  incidentKey: string;
  reason: string;
  impact: CircuitBreakerImpact;
  resolutionPolicy: CircuitBreakerResolutionPolicy;
  intentId: string | null;
  exposure: CircuitBreakerExposure;
  triggeredAt: number;
  cooldownUntil: number | null;
  payload: Readonly<Record<string, unknown>>;
};

const CIRCUIT_BREAKER_ASSETS = new Set<CircuitBreakerAsset>(["btc", "eth", "sol", "xrp", "doge", "bnb", "hype"]);
const VENUES = new Set<Venue>(["polymarket", "kalshi"]);
const FEED_SOURCES = new Set<FeedSource>(["ws", "rest-bootstrap", "rest-fallback", "unavailable"]);
const EXECUTION_REASONS = new Set<ExecutionIncidentReason>(["hedge_failure", "primary_no_fill", "venue_error"]);
const EXECUTION_DISPOSITIONS = new Set<ExecutionIncidentDisposition>([
  "cooldown",
  "truth_pending",
  "manual_intervention",
]);
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
const UTC_DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_IDENTIFIER_LENGTH = 160;
const MAX_INCIDENT_KEY_LENGTH = 1_024;
const MAX_TEXT_LENGTH = 1_024;
const MAX_FEED_DETAILS = 32;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@/%-]*$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export function createManualKillIncident(input: ManualKillIncidentInput): CircuitBreakerIncident {
  assertTimestamp(input.triggeredAt, "triggeredAt");
  const operatorId = assertText(input.operatorId, "operatorId");
  const note = normalizeOptionalText(input.note, "note");

  return createCanonicalIncident({
    scope: { type: "global" },
    owner: CIRCUIT_BREAKER_INCIDENT_OWNERS.manualKill,
    incidentKey: MANUAL_KILL_INCIDENT_KEY,
    reason: "manual",
    impact: "blocked",
    resolutionPolicy: "operator",
    intentId: null,
    exposure: { state: "none" },
    triggeredAt: input.triggeredAt,
    cooldownUntil: null,
    payload: {
      operatorId,
      note,
    },
  });
}

export function createMarketFeedIncident(input: MarketFeedIncidentInput): CircuitBreakerIncident {
  assertAsset(input.asset);
  assertSlotIdentity(input.asset, input.slotKey);
  assertVenue(input.venue);
  assertFeedSource(input.source);
  assertTimestamp(input.triggeredAt, "triggeredAt");
  assertNullableNonNegativeNumber(input.stalenessMs, "stalenessMs");
  if (!Array.isArray(input.details) || input.details.length > MAX_FEED_DETAILS) {
    throw new Error(`details must contain at most ${MAX_FEED_DETAILS} entries`);
  }
  const details = input.details.map((detail, index) => assertText(detail, `details[${index}]`));

  return createCanonicalIncident({
    scope: { type: "slot", asset: input.asset, slotKey: input.slotKey },
    owner: CIRCUIT_BREAKER_INCIDENT_OWNERS.marketFeed,
    incidentKey: buildCompositeKey("feed", input.venue),
    reason: "venue_error",
    impact: "blocked",
    resolutionPolicy: "owner",
    intentId: null,
    exposure: { state: "none" },
    triggeredAt: input.triggeredAt,
    cooldownUntil: null,
    payload: {
      asset: input.asset,
      slotKey: input.slotKey,
      venue: input.venue,
      source: input.source,
      stalenessMs: input.stalenessMs,
      details,
    },
  });
}

export function createExecutionIncident(input: ExecutionIncidentInput): CircuitBreakerIncident {
  assertAsset(input.asset);
  assertSlotIdentity(input.asset, input.slotKey);
  assertIdentifier(input.intentId, "intentId");
  assertIdentifier(input.stage, "stage");
  assertExecutionReason(input.reason);
  assertExecutionDisposition(input.disposition);
  assertVenue(input.venue);
  assertTimestamp(input.triggeredAt, "triggeredAt");
  const orderId = normalizeOptionalText(input.orderId, "orderId");

  if (input.reason === "primary_no_fill" && input.disposition !== "cooldown") {
    throw new Error("primary_no_fill incidents must use the cooldown disposition");
  }
  if (input.disposition !== "cooldown" && input.cooldownUntil !== undefined) {
    throw new Error("Only cooldown execution incidents may define cooldownUntil");
  }

  const isCooldown = input.disposition === "cooldown";
  const isManual = input.disposition === "manual_intervention";
  let cooldownUntil: number | null = null;
  if (input.disposition === "cooldown") {
    cooldownUntil = input.cooldownUntil;
    assertFutureTimestamp(cooldownUntil, input.triggeredAt, "cooldownUntil");
  }

  return createCanonicalIncident({
    scope: isCooldown ? { type: "slot", asset: input.asset, slotKey: input.slotKey } : { type: "global" },
    owner: CIRCUIT_BREAKER_INCIDENT_OWNERS.execution,
    incidentKey: buildCompositeKey("execution", input.reason, input.disposition, input.intentId, input.stage),
    reason: input.reason,
    impact: isCooldown ? "cooldown" : "blocked",
    resolutionPolicy: isManual ? "operator" : "owner",
    intentId: input.intentId,
    exposure: isCooldown ? { state: "none" } : { state: "unresolved" },
    triggeredAt: input.triggeredAt,
    cooldownUntil,
    payload: {
      asset: input.asset,
      slotKey: input.slotKey,
      intentId: input.intentId,
      stage: input.stage,
      reason: input.reason,
      disposition: input.disposition,
      venue: input.venue,
      orderId,
      cooldownUntil,
    },
  });
}

export function createDailyLossIncident(input: DailyLossIncidentInput): CircuitBreakerIncident {
  assertTimestamp(input.triggeredAt, "triggeredAt");
  assertUtcDayStart(input.dayStart);
  assertFiniteNumber(input.realizedPnlUsd, "realizedPnlUsd");
  assertPositiveNumber(input.lossCapUsd, "lossCapUsd");
  const dayEnd = input.dayStart + UTC_DAY_MS;
  assertTimestamp(dayEnd, "dayEnd");
  if (input.triggeredAt < input.dayStart || input.triggeredAt >= dayEnd) {
    throw new Error("triggeredAt must fall within the supplied UTC day");
  }
  const utcDay = new Date(input.dayStart).toISOString().slice(0, 10);

  return createCanonicalIncident({
    scope: { type: "global" },
    owner: CIRCUIT_BREAKER_INCIDENT_OWNERS.dailyLoss,
    incidentKey: buildCompositeKey("daily-loss", utcDay),
    reason: "daily_loss_cap",
    impact: "blocked",
    resolutionPolicy: "owner",
    intentId: null,
    exposure: { state: "none" },
    triggeredAt: input.triggeredAt,
    cooldownUntil: null,
    payload: {
      utcDay,
      dayStart: input.dayStart,
      dayEnd,
      realizedPnlUsd: input.realizedPnlUsd,
      lossCapUsd: input.lossCapUsd,
      thresholdUsd: -input.lossCapUsd,
    },
  });
}

export function createMarketDegradedIncident(input: MarketDegradedIncidentInput): CircuitBreakerIncident {
  assertAsset(input.asset);
  assertSlotIdentity(input.asset, input.slotKey);
  assertTimestamp(input.triggeredAt, "triggeredAt");
  assertFutureTimestamp(input.cooldownUntil, input.triggeredAt, "cooldownUntil");
  assertPositiveSafeInteger(input.degradedCount, "degradedCount");
  assertPositiveSafeInteger(input.windowMs, "windowMs");

  return createCanonicalIncident({
    scope: { type: "slot", asset: input.asset, slotKey: input.slotKey },
    owner: CIRCUIT_BREAKER_INCIDENT_OWNERS.marketDegraded,
    incidentKey: "market-degraded",
    reason: "market_degraded",
    impact: "cooldown",
    resolutionPolicy: "owner",
    intentId: null,
    exposure: { state: "none" },
    triggeredAt: input.triggeredAt,
    cooldownUntil: input.cooldownUntil,
    payload: {
      asset: input.asset,
      slotKey: input.slotKey,
      degradedCount: input.degradedCount,
      windowMs: input.windowMs,
      cooldownUntil: input.cooldownUntil,
    },
  });
}

export function createPolygonRpcIncident(input: PolygonRpcIncidentInput): CircuitBreakerIncident {
  assertTimestamp(input.triggeredAt, "triggeredAt");
  if (input.failureKind !== "missing_configuration" && input.failureKind !== "health_check_failed") {
    throw new Error(`Unsupported Polygon RPC failure kind: ${String(input.failureKind)}`);
  }
  const detail = assertText(input.detail, "detail");

  return createCanonicalIncident({
    scope: { type: "global" },
    owner: CIRCUIT_BREAKER_INCIDENT_OWNERS.polygonRpc,
    incidentKey: "rpc-unhealthy",
    reason: "rpc_unhealthy",
    impact: "blocked",
    resolutionPolicy: "owner",
    intentId: null,
    exposure: { state: "none" },
    triggeredAt: input.triggeredAt,
    cooldownUntil: null,
    payload: {
      failureKind: input.failureKind,
      detail,
      checkedAt: input.triggeredAt,
    },
  });
}

function createCanonicalIncident(input: CanonicalIncidentInput): CircuitBreakerIncident {
  assertIdentifier(input.owner, "owner");
  assertIdentifier(input.incidentKey, "incidentKey", MAX_INCIDENT_KEY_LENGTH);
  assertIdentifier(input.reason, "reason");
  assertTimestamp(input.triggeredAt, "triggeredAt");
  if (input.cooldownUntil !== null) {
    assertFutureTimestamp(input.cooldownUntil, input.triggeredAt, "cooldownUntil");
  }
  if (input.impact === "cooldown" && input.cooldownUntil === null) {
    throw new Error("Cooldown incidents require cooldownUntil");
  }
  if (input.impact !== "cooldown" && input.cooldownUntil !== null) {
    throw new Error("Only cooldown incidents may define cooldownUntil");
  }

  const scope = cloneScope(input.scope);
  return {
    id: buildDeterministicIncidentId(scope, input.owner, input.incidentKey, input.triggeredAt),
    scope,
    owner: input.owner,
    incidentKey: input.incidentKey,
    reason: input.reason,
    impact: input.impact,
    resolutionPolicy: input.resolutionPolicy,
    intentId: input.intentId,
    exposure: { ...input.exposure },
    revision: INITIAL_CIRCUIT_BREAKER_INCIDENT_REVISION,
    timestamps: {
      triggeredAt: input.triggeredAt,
      updatedAt: input.triggeredAt,
      lastObservedAt: input.triggeredAt,
      cooldownUntil: input.cooldownUntil,
      acknowledgedAt: null,
      resolvedAt: null,
    },
    payload: { ...input.payload },
  };
}

function buildDeterministicIncidentId(
  scope: CircuitBreakerScope,
  owner: string,
  incidentKey: string,
  triggeredAt: number,
) {
  return ["cbi", "v1", getCircuitBreakerScopeKey(scope), owner, incidentKey, String(triggeredAt)]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function buildCompositeKey(...parts: string[]) {
  return parts.map((part) => encodeURIComponent(part)).join(":");
}

function cloneScope(scope: CircuitBreakerScope): CircuitBreakerScope {
  if (scope.type === "global") {
    return { type: "global" };
  }
  assertAsset(scope.asset);
  if (scope.type === "asset") {
    return { type: "asset", asset: scope.asset };
  }
  assertSlotIdentity(scope.asset, scope.slotKey);
  return { type: "slot", asset: scope.asset, slotKey: scope.slotKey };
}

function assertAsset(asset: CircuitBreakerAsset): void {
  if (!CIRCUIT_BREAKER_ASSETS.has(asset)) {
    throw new Error(`Unsupported circuit-breaker asset: ${String(asset)}`);
  }
}

function assertSlotIdentity(asset: CircuitBreakerAsset, slotKey: string): void {
  assertIdentifier(slotKey, "slotKey");
  if (!slotKey.startsWith(`${asset}:`) || slotKey.length === asset.length + 1) {
    throw new Error(`slotKey must belong to asset ${asset}`);
  }
}

function assertVenue(venue: Venue): void {
  if (!VENUES.has(venue)) {
    throw new Error(`Unsupported venue: ${String(venue)}`);
  }
}

function assertFeedSource(source: FeedSource): void {
  if (!FEED_SOURCES.has(source)) {
    throw new Error(`Unsupported feed source: ${String(source)}`);
  }
}

function assertExecutionReason(reason: ExecutionIncidentReason): void {
  if (!EXECUTION_REASONS.has(reason)) {
    throw new Error(`Unsupported execution incident reason: ${String(reason)}`);
  }
}

function assertExecutionDisposition(disposition: ExecutionIncidentDisposition): void {
  if (!EXECUTION_DISPOSITIONS.has(disposition)) {
    throw new Error(`Unsupported execution incident disposition: ${String(disposition)}`);
  }
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_TIMESTAMP_MS) {
    throw new Error(`${field} must be a valid non-negative millisecond timestamp`);
  }
}

function assertFutureTimestamp(value: number, triggeredAt: number, field: string): void {
  assertTimestamp(value, field);
  if (value <= triggeredAt) {
    throw new Error(`${field} must be later than triggeredAt`);
  }
}

function assertUtcDayStart(value: number): void {
  assertTimestamp(value, "dayStart");
  if (value % UTC_DAY_MS !== 0) {
    throw new Error("dayStart must be exactly midnight UTC");
  }
}

function assertFiniteNumber(value: number, field: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be finite`);
  }
}

function assertPositiveNumber(value: number, field: string): void {
  assertFiniteNumber(value, field);
  if (value <= 0) {
    throw new Error(`${field} must be positive`);
  }
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
}

function assertNullableNonNegativeNumber(value: number | null, field: string): void {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${field} must be null or a finite non-negative number`);
  }
}

function assertIdentifier(value: string, field: string, maxLength = MAX_IDENTIFIER_LENGTH): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new Error(`${field} must be a bounded canonical identifier`);
  }
  return value;
}

function assertText(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_TEXT_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new Error(`${field} must be bounded non-empty text without control characters`);
  }
  return value;
}

function normalizeOptionalText(value: string | null | undefined, field: string): string | null {
  return value === null || value === undefined ? null : assertText(value, field);
}
