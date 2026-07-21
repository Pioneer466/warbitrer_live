import { NextResponse } from "next/server";
import { z } from "zod";

import { createApiErrorResponse } from "@/lib/api-error";
import { authenticateApiMutation } from "@/lib/api-mutation-auth";
import { repairSettledIntentResolutions } from "@/lib/engine";
import { isMarketAsset } from "@/lib/market-catalog";
import type { MarketAsset } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const settlementRepairRequestSchema = z
  .object({
    asset: z
      .union([
        z.literal("all"),
        z.custom<MarketAsset>((value) => typeof value === "string" && isMarketAsset(value), {
          message: "asset must be all or a supported market asset",
        }),
      ])
      .optional(),
    intentId: z.string().trim().min(1).max(256).optional(),
    lookbackHours: z
      .number()
      .finite()
      .min(1)
      .max(24 * 365)
      .optional(),
    limit: z.number().int().min(1).max(1_000).optional(),
    includeShadow: z.boolean().optional(),
    confirmBatch: z.literal("repair-settled-intents").optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.intentId && value.confirmBatch !== "repair-settled-intents") {
      context.addIssue({
        code: "custom",
        path: ["confirmBatch"],
        message: "confirmBatch=repair-settled-intents is required for a batch repair",
      });
    }
  });

export async function POST(request: Request) {
  try {
    authenticateApiMutation(request);

    const parsed = settlementRepairRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const body = parsed.data;

    return NextResponse.json(
      await repairSettledIntentResolutions({
        asset: body.asset ?? "all",
        intentId: body.intentId,
        lookbackHours: body.lookbackHours,
        limit: body.limit,
        includeShadow: body.includeShadow,
      }),
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
