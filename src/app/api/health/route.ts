import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { readCircuitBreakers, readSettings, readWorkerState } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [workerState, circuitBreakers, config] = await Promise.all([
      readWorkerState(),
      readCircuitBreakers(),
      readSettings(),
    ]);

    return NextResponse.json({
      ok: workerState.readinessStatus !== "blocked",
      timestamp: Date.now(),
      phase: workerState.phase,
      readinessStatus: workerState.readinessStatus,
      activeBreakers: circuitBreakers.filter((breaker) => breaker.active).length,
      tradingEnabled: config.enableTrading,
      shadowMode: config.shadowMode,
    });
  } catch (error) {
    return createApiErrorResponse(error);
  }
}
