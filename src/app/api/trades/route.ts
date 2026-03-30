import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { readTrades } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await readTrades(), {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return createApiErrorResponse(error);
  }
}
