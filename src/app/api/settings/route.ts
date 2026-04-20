import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { settingsMapSchema } from "@/lib/settings-schema";
import { readSettingsMap, writeSettings } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await readSettingsMap(), {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return createApiErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const parsed = settingsMapSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: parsed.error.flatten(),
        },
        { status: 400 },
      );
    }

    await Promise.all([
      writeSettings("btc", parsed.data.btc),
      writeSettings("eth", parsed.data.eth),
    ]);
    return NextResponse.json(parsed.data);
  } catch (error) {
    return createApiErrorResponse(error);
  }
}
