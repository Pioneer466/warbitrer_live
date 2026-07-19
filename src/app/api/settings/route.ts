import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { authenticateApiMutation } from "@/lib/api-mutation-auth";
import { createConfigurationConflictResponse } from "@/lib/configuration-api";
import { getLiveSettingsBlockReasons } from "@/lib/execution-safety";
import { MARKET_ASSETS } from "@/lib/market-catalog";
import { strategyConfigMapUpdateSchema } from "@/lib/settings-schema";
import { readSettingsMap, writeSettingsMap } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(
      { configs: await readSettingsMap() },
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

export async function PUT(request: Request) {
  try {
    const mutation = authenticateApiMutation(request);
    const parsed = strategyConfigMapUpdateSchema.safeParse(await request.json());

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: parsed.error.flatten(),
        },
        { status: 400 },
      );
    }

    const blockedAssets = MARKET_ASSETS.flatMap((asset) => {
      const reasons = getLiveSettingsBlockReasons(asset, parsed.data.updates[asset].config);
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

    return NextResponse.json({ configs: await writeSettingsMap(parsed.data.updates, mutation) });
  } catch (error) {
    const conflict = createConfigurationConflictResponse(error);
    if (conflict) {
      return conflict;
    }
    return createApiErrorResponse(error);
  }
}
