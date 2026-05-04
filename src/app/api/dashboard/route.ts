import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { getCurrentSlots } from "@/lib/slot";
import { readPortfolioDashboard } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DASHBOARD_CACHE_TTL_MS = 2_000;
let dashboardCache: {
  capturedAt: number;
  payload: Awaited<ReturnType<typeof readPortfolioDashboard>>;
} | null = null;

export async function GET() {
  try {
    const now = Date.now();
    let payload = dashboardCache && now - dashboardCache.capturedAt <= DASHBOARD_CACHE_TTL_MS
      ? dashboardCache.payload
      : null;
    if (!payload) {
      payload = await readPortfolioDashboard(getCurrentSlots());
      dashboardCache = { capturedAt: now, payload };
    }
    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return createApiErrorResponse(error);
  }
}
