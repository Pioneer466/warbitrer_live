import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { getCurrentSlot } from "@/lib/slot";
import { readHistoryPoints, readLatestSnapshot } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const slot = getCurrentSlot();
    const [points, latestSnapshot] = await Promise.all([
      readHistoryPoints(slot),
      readLatestSnapshot(slot.key),
    ]);

    return NextResponse.json(
      {
        fetchedAt: Date.now(),
        slot,
        feedHealth: latestSnapshot ? [latestSnapshot.polymarket.feedHealth, latestSnapshot.kalshi.feedHealth] : [],
        points,
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    return createApiErrorResponse(error);
  }
}
