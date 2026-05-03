import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { readCircuitBreakers, readOpenOrderIntents, writeCircuitBreaker } from "@/lib/storage";
import { isMarketAsset } from "@/lib/market-catalog";
import type { CircuitBreaker, CircuitBreakerKey, CircuitBreakerReason, OrderIntent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const breakers = await readCircuitBreakers();
    const url = new URL(request.url);
    const body = url.searchParams.get("details") === "1"
      ? await buildDetailedBreakerResponse(breakers)
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

async function buildDetailedBreakerResponse(breakers: CircuitBreaker[]) {
  const now = Date.now();
  const openIntents = await readOpenOrderIntents();
  const detailed = breakers.map((breaker) => {
    const scope = parseBreakerScope(breaker.key);
    return {
      ...breaker,
      scope,
      requiresManualClear: getPayloadBoolean(breaker.payload, "requiresManualClear"),
      cooldownUntil: getPayloadNumber(breaker.payload, "cooldownUntil"),
      cooldownRemainingMs: getPayloadNumber(breaker.payload, "cooldownUntil") === null
        ? null
        : Math.max(0, getPayloadNumber(breaker.payload, "cooldownUntil")! - now),
      unresolvedIntentIds: findUnresolvedIntentIds(scope, openIntents),
    };
  });

  return {
    fetchedAt: now,
    global: detailed.find((breaker) => breaker.key === "global") ?? null,
    activeBreakers: detailed.filter((breaker) => breaker.active),
    breakers: detailed,
  };
}

function parseBreakerScope(key: CircuitBreakerKey) {
  if (key === "global") {
    return { type: "global" as const, asset: null, slotKey: null };
  }

  if (key.startsWith("asset:")) {
    const asset = key.slice("asset:".length);
    return { type: "asset" as const, asset: isMarketAsset(asset) ? asset : null, slotKey: null };
  }

  const rest = key.slice("slot:".length);
  const [asset] = rest.split(":");
  return {
    type: "slot" as const,
    asset: asset && isMarketAsset(asset) ? asset : null,
    slotKey: rest || null,
  };
}

function findUnresolvedIntentIds(
  scope: ReturnType<typeof parseBreakerScope>,
  openIntents: OrderIntent[],
) {
  return openIntents
    .filter((intent) => matchesBreakerScope(scope, intent))
    .map((intent) => intent.id);
}

function matchesBreakerScope(
  scope: ReturnType<typeof parseBreakerScope>,
  intent: Pick<OrderIntent, "asset" | "slotKey">,
) {
  if (scope.type === "global") {
    return true;
  }
  if (scope.asset !== null && intent.asset !== scope.asset) {
    return false;
  }
  return scope.type !== "slot" || scope.slotKey === null || intent.slotKey === scope.slotKey;
}

function getPayloadBoolean(payload: Record<string, unknown> | null, key: string) {
  return payload?.[key] === true;
}

function getPayloadNumber(payload: Record<string, unknown> | null, key: string) {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as {
      key?: CircuitBreakerKey;
      active?: boolean;
      reason?: CircuitBreakerReason | null;
      payload?: Record<string, unknown> | null;
    };

    if (!body.key || typeof body.active !== "boolean") {
      return NextResponse.json(
        {
          error: "key and active are required",
        },
        { status: 400 },
      );
    }

    const breaker = {
      key: body.key,
      active: body.active,
      reason: body.active ? body.reason ?? "manual" : null,
      triggeredAt: body.active ? Date.now() : null,
      payload: body.payload ?? null,
    };

    await writeCircuitBreaker(breaker);
    return NextResponse.json(breaker);
  } catch (error) {
    return createApiErrorResponse(error);
  }
}
