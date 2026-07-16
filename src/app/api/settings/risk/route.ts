import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { globalRiskConfigSchema } from "@/lib/risk-settings";
import { readGlobalRiskConfig, writeGlobalRiskConfig, writeRunEvent } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await readGlobalRiskConfig(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return createApiErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const parsed = globalRiskConfigSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const previous = await readGlobalRiskConfig();
    const updated = await writeGlobalRiskConfig(parsed.data);
    await writeRunEvent({
      level: "warn",
      eventType: "risk.global_config.updated",
      message: "Global mismatch risk configuration updated",
      payload: { previous, updated },
      createdAt: Date.now(),
    }).catch((error) => {
      console.error("[risk] failed to persist global risk configuration audit event", error);
    });
    return NextResponse.json(updated);
  } catch (error) {
    return createApiErrorResponse(error);
  }
}
