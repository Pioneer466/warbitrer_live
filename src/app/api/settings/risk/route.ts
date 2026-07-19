import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { authenticateApiMutation } from "@/lib/api-mutation-auth";
import { createConfigurationConflictResponse } from "@/lib/configuration-api";
import { globalRiskConfigUpdateSchema } from "@/lib/risk-settings";
import { readGlobalRiskConfig, writeGlobalRiskConfig } from "@/lib/storage";

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
    const mutation = authenticateApiMutation(request);
    const parsed = globalRiskConfigUpdateSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    return NextResponse.json(await writeGlobalRiskConfig(parsed.data, mutation));
  } catch (error) {
    const conflict = createConfigurationConflictResponse(error);
    if (conflict) {
      return conflict;
    }
    return createApiErrorResponse(error);
  }
}
