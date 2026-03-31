import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { buildRecoveryResponse, redeemPolymarketMarket } from "@/lib/recovery";

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
      action?: "redeem";
      marketRef?: string;
    };

    if (body.action !== "redeem" || !body.marketRef) {
      return NextResponse.json({ error: "action=redeem and marketRef are required" }, { status: 400 });
    }

    return NextResponse.json(await redeemPolymarketMarket(body.marketRef));
  } catch (error) {
    return createApiErrorResponse(error);
  }
}
