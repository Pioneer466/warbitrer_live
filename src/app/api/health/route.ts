import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { getCurrentSlot } from "@/lib/slot";
import { readCircuitBreakers, readLatestSnapshot, readSettings, readWorkerState } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const slot = getCurrentSlot();
    const [workerState, circuitBreakers, config, latestSnapshot] = await Promise.all([
      readWorkerState(),
      readCircuitBreakers(),
      readSettings(),
      readLatestSnapshot(slot.key),
    ]);

    return NextResponse.json({
      ok: workerState.readinessStatus !== "blocked",
      timestamp: Date.now(),
      phase: workerState.phase,
      readinessStatus: workerState.readinessStatus,
      activeBreakers: circuitBreakers.filter((breaker) => breaker.active).length,
      tradingEnabled: config.enableTrading,
      shadowMode: config.shadowMode,
      feedHealth: latestSnapshot ? [latestSnapshot.polymarket.feedHealth, latestSnapshot.kalshi.feedHealth] : [],
    });
  } catch (error) {
    return createApiErrorResponse(error);
  }
}
