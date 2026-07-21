import { NextResponse } from "next/server";
import { z } from "zod";

import { createApiErrorResponse } from "@/lib/api-error";
import { authenticateApiMutation } from "@/lib/api-mutation-auth";
import { buildRecoveryResponse, convertPolymarketMarket } from "@/lib/recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const recoveryMutationSchema = z
  .object({
    action: z.enum(["redeem", "convert"]),
    marketRef: z.string().trim().min(1).max(256),
  })
  .strict();

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
    authenticateApiMutation(request);

    const parsed = recoveryMutationSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    return NextResponse.json(await convertPolymarketMarket(parsed.data.marketRef));
  } catch (error) {
    return createApiErrorResponse(error);
  }
}
