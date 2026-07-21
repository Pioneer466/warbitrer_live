import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { parseMarketAsset } from "@/lib/market-catalog";
import { getCurrentSlot } from "@/lib/slot";
import { readHistoryPoints, readLatestSnapshot } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const asset = parseMarketAsset(url.searchParams.get("asset"));
    const slot = getCurrentSlot(asset);
    const [points, latestSnapshot] = await Promise.all([readHistoryPoints(slot), readLatestSnapshot(asset, slot.key)]);
    const fallbackPoints =
      points.length > 0 || !latestSnapshot
        ? points
        : [
            {
              ts: latestSnapshot.capturedAt,
              polyUpBuy: latestSnapshot.polymarket.outcomes.up.chart.price,
              polyDownBuy: latestSnapshot.polymarket.outcomes.down.chart.price,
              kalshiYesLast: latestSnapshot.kalshi.outcomes.yes.chart.price,
              kalshiNoLast: latestSnapshot.kalshi.outcomes.no.chart.price,
              grossCostUpNo:
                latestSnapshot.opportunities.find((item) => item.combination === "POLY_UP_KALSHI_NO")?.grossCost ??
                null,
              grossCostDownYes:
                latestSnapshot.opportunities.find((item) => item.combination === "POLY_DOWN_KALSHI_YES")?.grossCost ??
                null,
            },
          ];

    return NextResponse.json(
      {
        fetchedAt: Date.now(),
        slot,
        feedHealth: latestSnapshot ? [latestSnapshot.polymarket.feedHealth, latestSnapshot.kalshi.feedHealth] : [],
        points: fallbackPoints,
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
