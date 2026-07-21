import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { isMarketAsset } from "@/lib/market-catalog";
import { getCurrentSlot } from "@/lib/slot";
import { readDashboard } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ASSET_DASHBOARD_CACHE_TTL_MS = 1_500;
const dashboardCacheByAsset = new Map<
  string,
  {
    capturedAt: number;
    payload: Awaited<ReturnType<typeof readDashboard>>;
  }
>();

export async function GET(_request: Request, context: { params: Promise<{ asset: string }> }) {
  try {
    const { asset } = await context.params;
    if (!isMarketAsset(asset)) {
      return NextResponse.json({ error: "asset invalide" }, { status: 400 });
    }

    const now = Date.now();
    const cached = dashboardCacheByAsset.get(asset);
    let payload = cached && now - cached.capturedAt <= ASSET_DASHBOARD_CACHE_TTL_MS ? cached.payload : null;
    if (!payload) {
      payload = await readDashboard(getCurrentSlot(asset));
      dashboardCacheByAsset.set(asset, { capturedAt: now, payload });
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
