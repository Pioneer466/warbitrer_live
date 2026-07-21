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
import {
  acknowledgeCircuitBreaker,
  acknowledgeManualKillBreaker,
  CircuitBreakerIncidentPersistenceError,
  readCurrentCircuitBreakerIncidents,
  readOpenOrderIntents,
  writeCircuitBreakerIncident,
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
    const acknowledge = isManualKillIncident(incident) ? acknowledgeManualKillBreaker : acknowledgeCircuitBreaker;
    const acknowledged = await acknowledge({
      incidentId: incident.id,
      expectedRevision: body.expectedRevision,
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
      closedIntentIds: [],
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
