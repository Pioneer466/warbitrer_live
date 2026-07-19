import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { getLiveSettingsBlockReasons } from "@/lib/execution-safety";
import { MARKET_ASSETS } from "@/lib/market-catalog";
import { settingsMapSchema } from "@/lib/settings-schema";
import { readSettingsMap, writeSettings } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await readSettingsMap(), {
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
    const body = await request.json();
    const parsed = settingsMapSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: parsed.error.flatten(),
        },
        { status: 400 },
      );
    }

    const blockedAssets = MARKET_ASSETS.flatMap((asset) => {
      const reasons = getLiveSettingsBlockReasons(asset, parsed.data[asset]);
      return reasons.length > 0 ? [{ asset, reasons }] : [];
    });
    if (blockedAssets.length > 0) {
      return NextResponse.json(
        {
          error: "live_execution_blocked",
          assets: blockedAssets,
        },
        { status: 409 },
      );
    }

    await Promise.all(MARKET_ASSETS.map((asset) => writeSettings(asset, parsed.data[asset])));
    return NextResponse.json(parsed.data);
  } catch (error) {
    return createApiErrorResponse(error);
  }
}
