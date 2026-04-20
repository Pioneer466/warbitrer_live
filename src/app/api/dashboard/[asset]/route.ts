import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { isMarketAsset } from "@/lib/market-catalog";
import { getCurrentSlot } from "@/lib/slot";
import { readDashboard } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ asset: string }> }) {
  try {
    const { asset } = await context.params;
    if (!isMarketAsset(asset)) {
      return NextResponse.json({ error: "asset invalide" }, { status: 400 });
    }

    const payload = await readDashboard(getCurrentSlot(asset));
    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return createApiErrorResponse(error);
  }
}
