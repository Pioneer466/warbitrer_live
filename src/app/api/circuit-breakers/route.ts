import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { readCircuitBreakers, writeCircuitBreaker } from "@/lib/storage";
import type { CircuitBreakerKey, CircuitBreakerReason } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await readCircuitBreakers(), {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return createApiErrorResponse(error);
  }
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
