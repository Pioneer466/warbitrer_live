import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { isMarketAsset } from "@/lib/market-catalog";
import { readTrades } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const asset = url.searchParams.get("asset");
    const scope = asset && isMarketAsset(asset) ? asset : "all";
    return NextResponse.json(await readTrades(scope), {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return createApiErrorResponse(error);
  }
}
