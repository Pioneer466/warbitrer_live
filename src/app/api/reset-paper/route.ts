import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { resetPaperState } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await resetPaperState();
    return NextResponse.json({
      ok: true,
      resetAt: Date.now(),
    });
  } catch (error) {
    return createApiErrorResponse(error);
  }
}
