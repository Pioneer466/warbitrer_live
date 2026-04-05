import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { buildRecoveryResponse, convertPolymarketMarket } from "@/lib/recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await buildRecoveryResponse(), {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return createApiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      action?: "redeem" | "convert";
      marketRef?: string;
    };

    if ((body.action !== "redeem" && body.action !== "convert") || !body.marketRef) {
      return NextResponse.json({ error: "action=convert|redeem and marketRef are required" }, { status: 400 });
    }

    return NextResponse.json(await convertPolymarketMarket(body.marketRef));
  } catch (error) {
    return createApiErrorResponse(error);
  }
}
