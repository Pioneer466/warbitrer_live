import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { repairSettledIntentResolutions } from "@/lib/engine";
import { isMarketAsset } from "@/lib/market-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      asset?: string;
      intentId?: string;
      lookbackHours?: number;
      limit?: number;
      includeShadow?: boolean;
    };

    const asset =
      body.asset === undefined || body.asset === "all"
        ? "all"
        : isMarketAsset(body.asset)
          ? body.asset
          : null;

    if (asset === null) {
      return NextResponse.json({ error: "asset invalide" }, { status: 400 });
    }

    return NextResponse.json(
      await repairSettledIntentResolutions({
        asset,
        intentId: body.intentId,
        lookbackHours: body.lookbackHours,
        limit: body.limit,
        includeShadow: body.includeShadow,
      }),
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
