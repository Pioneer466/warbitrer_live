import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { settingsSchema } from "@/lib/settings-schema";
import { readSettings, writeSettings } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await readSettings(), {
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
    const parsed = settingsSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: parsed.error.flatten(),
        },
        { status: 400 },
      );
    }

    return NextResponse.json(await writeSettings(parsed.data));
  } catch (error) {
    return createApiErrorResponse(error);
  }
}
