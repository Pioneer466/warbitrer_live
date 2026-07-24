import { NextResponse } from "next/server";
import { z } from "zod";

import { createApiErrorResponse } from "@/lib/api-error";
import { authenticateApiMutation } from "@/lib/api-mutation-auth";
import { createManualKillIncident } from "@/lib/circuit-breaker-incidents";
import {
  aggregateCircuitBreakerIncidents,
  getCircuitBreakerScopeKey,
  isManualKillIncident,
  projectLegacyCircuitBreakersForUi,
} from "@/lib/circuit-breaker-policy";
import type { CircuitBreakerIncident, CircuitBreakerScopeAggregate } from "@/lib/circuit-breaker-policy";
import { isShadowAccountingTerminalizationIncident } from "@/lib/circuit-breaker-ui";
import {
  acknowledgeCircuitBreaker,
  acknowledgeManualKillBreaker,
  CircuitBreakerIncidentPersistenceError,
  findOrderIntent,
  readCurrentCircuitBreakerIncidents,
  readOpenOrderIntents,
  readOrderAttemptsForIntent,
  readVenueOrdersForIntent,
  writeCircuitBreakerExposureRecovery,
  writeCircuitBreakerIncident,
  writeOrderIntent,
} from "@/lib/storage";
import type { CircuitBreaker, CircuitBreakerKey, CircuitBreakerReason } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const manualKillMutationSchema = z.discriminatedUnion("active", [
  z
    .object({
      key: z.literal("global"),
      active: z.literal(true),
      reason: z.union([z.literal("manual"), z.null()]).optional(),
      payload: z
        .object({
          note: z.unknown().optional(),
        })
        .strict()
        .nullable()
        .optional(),
    })
    .strict(),
  z
    .object({
      key: z.string().trim().min(1).max(512).optional(),
      active: z.literal(false),
      reason: z.literal("manual").optional(),
      incidentId: z.string().trim().min(1).max(256),
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
]);

export async function GET(request: Request) {
  try {
    const now = Date.now();
    const incidents = await readCurrentCircuitBreakerIncidents();
    const aggregates = aggregateCircuitBreakerIncidents(incidents, now);
    const breakers = projectLegacyBreakers(aggregates);
    const url = new URL(request.url);
    const body =
      url.searchParams.get("details") === "1"
        ? await buildDetailedBreakerResponse(incidents, aggregates, breakers, now)
        : breakers;

    return NextResponse.json(body, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return createApiErrorResponse(error);
  }
}

async function buildDetailedBreakerResponse(
  incidents: CircuitBreakerIncident[],
  aggregates: CircuitBreakerScopeAggregate[],
  breakers: CircuitBreaker[],
  now: number,
) {
  const openIntentIds = new Set((await readOpenOrderIntents()).map((intent) => intent.id));
  const aggregateByKey = new Map(aggregates.map((aggregate) => [aggregate.scopeKey, aggregate]));
  const detailed = breakers.map((breaker) => {
    const aggregate = aggregateByKey.get(breaker.key);
    const cooldownUntil = aggregate?.cooldownUntil ?? null;
    return {
      ...breaker,
      scope: aggregate?.scope ?? null,
      activeIncidentCount: aggregate?.activeIncidentCount ?? 0,
      incidentIds: aggregate?.incidentIds ?? [],
      intentIds: aggregate?.intentIds ?? [],
      dominantIncidentId: aggregate?.dominantIncidentId ?? null,
      manualKillActive: aggregate?.manualKillActive ?? false,
      requiresManualClear: aggregate?.requiresOperatorAcknowledgement ?? false,
      cooldownUntil,
      cooldownRemainingMs: cooldownUntil === null ? null : Math.max(0, cooldownUntil - now),
      unresolvedIntentIds: (aggregate?.intentIds ?? []).filter((intentId) => openIntentIds.has(intentId)),
    };
  });
  const manualKillIncident = incidents.find(isManualKillIncident) ?? null;

  return {
    fetchedAt: now,
    global: detailed.find((breaker) => breaker.key === "global") ?? null,
    manualKillIncident,
    activeBreakers: detailed,
    breakers: detailed,
    incidents,
  };
}

export async function PUT(request: Request) {
  try {
    const mutation = authenticateApiMutation(request);
    const parsed = manualKillMutationSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const body = parsed.data;

    if (body.active) {
      const triggeredAt = Date.now();
      const note = sanitizeOperatorNote(body.payload?.note);
      const incident = createManualKillIncident({
        triggeredAt,
        operatorId: mutation.actor,
        note,
      });
      const persisted = await writeCircuitBreakerIncident({
        incident,
        actor: mutation.actor,
        requestId: `api:${mutation.requestId}`,
      });
      return NextResponse.json({
        key: "global",
        active: true,
        reason: "manual",
        triggeredAt: persisted.timestamps.triggeredAt,
        payload: {
          projectionVersion: "multi-cause-ui-v1",
          uiProjectionOnly: true,
          dominantIncidentId: persisted.id,
          incidentIds: [persisted.id],
          intentIds: [],
          manualKillActive: true,
          requiresManualClear: true,
          cooldownUntil: null,
        },
        incidentId: persisted.id,
        revision: persisted.revision,
        closedIntentIds: [],
      });
    }

    const incidents = await readCurrentCircuitBreakerIncidents();
    const incident = incidents.find((candidate) => candidate.id === body.incidentId) ?? null;
    if (!incident) {
      return NextResponse.json({ error: `Open incident ${body.incidentId} not found` }, { status: 404 });
    }
    const incidentScopeKey = getCircuitBreakerScopeKey(incident.scope);
    if (body.key !== undefined && body.key !== incidentScopeKey) {
      return NextResponse.json({ error: "key does not match the requested incident scope" }, { status: 400 });
    }
    const shadowRecovery = await recoverShadowAccountingIncidentForAcknowledgement(
      incident,
      body.expectedRevision,
      mutation.requestId,
    );
    const acknowledge = isManualKillIncident(incident) ? acknowledgeManualKillBreaker : acknowledgeCircuitBreaker;
    const acknowledged = await acknowledge({
      incidentId: incident.id,
      expectedRevision: shadowRecovery.incident.revision,
      operatorId: mutation.actor,
      actor: mutation.actor,
      requestId: `api:${mutation.requestId}`,
    });
    const remainingIncidents = await readCurrentCircuitBreakerIncidents();
    const remainingAggregate = aggregateCircuitBreakerIncidents(remainingIncidents, Date.now()).find(
      (aggregate) => aggregate.scopeKey === getCircuitBreakerScopeKey(incident.scope),
    );
    const remainingBreaker = remainingAggregate ? projectLegacyBreakers([remainingAggregate])[0] : null;

    return NextResponse.json({
      key: incidentScopeKey,
      active: remainingBreaker !== null,
      reason: remainingBreaker?.reason ?? null,
      triggeredAt: remainingBreaker?.triggeredAt ?? null,
      payload: remainingBreaker?.payload ?? null,
      acknowledgedIncidentId: acknowledged.id,
      revision: acknowledged.revision,
      closedIntentIds: shadowRecovery.recoveredIntentId ? [shadowRecovery.recoveredIntentId] : [],
    });
  } catch (error) {
    if (error instanceof CircuitBreakerIncidentPersistenceError) {
      const status = error.code === "incident_not_found" ? 404 : 409;
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          incidentId: error.incidentId,
          status,
          timestamp: Date.now(),
        },
        { status },
      );
    }
    return createApiErrorResponse(error);
  }
}

async function recoverShadowAccountingIncidentForAcknowledgement(
  incident: CircuitBreakerIncident,
  expectedRevision: number,
  requestId: string,
) {
  if (!isShadowAccountingTerminalizationIncident(incident)) {
    return { incident, recoveredIntentId: null };
  }
  if (incident.revision !== expectedRevision) {
    throw new CircuitBreakerIncidentPersistenceError(
      "revision_conflict",
      `Expected circuit-breaker revision ${expectedRevision}, found ${incident.revision}`,
      incident.id,
    );
  }
  if (!incident.intentId) {
    throwShadowRecoveryDenied(incident.id, "Shadow accounting incident is missing its intent");
  }

  const intent = await findOrderIntent(incident.intentId);
  const needsIntentRepair =
    intent?.status === "manual_required" &&
    intent.failureReason?.startsWith("Stable accounting evidence is incomplete (");
  const alreadyRepaired = intent?.status === "hedged" && intent.failureReason === null;
  if (
    !intent ||
    !intent.shadow ||
    (!needsIntentRepair && !alreadyRepaired) ||
    intent.legs.length !== 2 ||
    intent.legs.some((leg) => leg.filledSize <= 0)
  ) {
    throwShadowRecoveryDenied(incident.id, "Intent is not an eligible shadow accounting false positive");
  }

  const [attempts, orders] = await Promise.all([
    readOrderAttemptsForIntent(intent.id),
    readVenueOrdersForIntent(intent.id),
  ]);
  if (attempts.some((attempt) => !attempt.shadow) || orders.some((order) => !order.shadow)) {
    throwShadowRecoveryDenied(incident.id, "Live execution evidence exists for this intent");
  }

  let recoveredIncident = incident;
  if (incident.exposure.state === "unresolved") {
    const confirmedAt = Date.now();
    recoveredIncident = await writeCircuitBreakerExposureRecovery({
      incidentId: incident.id,
      expectedRevision: incident.revision,
      owner: incident.owner,
      recoveryProof: {
        owner: incident.owner,
        confirmedAt,
        evidenceId: `shadow-intent:${intent.id}:no-live-execution`,
      },
      actor: incident.owner,
      requestId: `api-shadow-proof:${requestId}`,
    });
  }

  if (needsIntentRepair) {
    await writeOrderIntent({
      ...intent,
      status: "hedged",
      failureReason: null,
      resolvedAt: null,
      updatedAt: Date.now(),
    });
  }

  return { incident: recoveredIncident, recoveredIntentId: intent.id };
}

function throwShadowRecoveryDenied(incidentId: string, message: string): never {
  throw new CircuitBreakerIncidentPersistenceError("invalid_recovery_proof", message, incidentId);
}

function sanitizeOperatorNote(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  return (
    value
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, 1_024) || null
  );
}

function projectLegacyBreakers(aggregates: CircuitBreakerScopeAggregate[]): CircuitBreaker[] {
  return projectLegacyCircuitBreakersForUi(aggregates).map((breaker) => ({
    key: breaker.key as CircuitBreakerKey,
    active: true,
    reason: breaker.reason as CircuitBreakerReason,
    triggeredAt: breaker.triggeredAt,
    payload: breaker.payload,
  }));
}
