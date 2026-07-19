import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { getLiveSettingsBlockReasons } from "@/lib/execution-safety";
import { isMarketAsset } from "@/lib/market-catalog";
import { settingsSchema } from "@/lib/settings-schema";
import { readSettings, writeSettings } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ asset: string }> }) {
  try {
    const { asset } = await context.params;
    if (!isMarketAsset(asset)) {
      return NextResponse.json({ error: "asset invalide" }, { status: 400 });
    }

    return NextResponse.json(await readSettings(asset), {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return createApiErrorResponse(error);
  }
}

export async function PUT(request: Request, context: { params: Promise<{ asset: string }> }) {
  try {
    const { asset } = await context.params;
    if (!isMarketAsset(asset)) {
      return NextResponse.json({ error: "asset invalide" }, { status: 400 });
    }

    const body = await request.json();
    const parsed = settingsSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: parsed.error.flatten(),
        },
        { status: 400 },
      );
    }

    const liveBlockReasons = getLiveSettingsBlockReasons(asset, parsed.data);
    if (liveBlockReasons.length > 0) {
      return NextResponse.json(
        {
          error: "live_execution_blocked",
          reasons: liveBlockReasons,
        },
        { status: 409 },
      );
    }

    return NextResponse.json(await writeSettings(asset, parsed.data));
  } catch (error) {
    return createApiErrorResponse(error);
  }
}
