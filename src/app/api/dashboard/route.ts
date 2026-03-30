import { NextResponse } from "next/server";

import { getCurrentSlot } from "@/lib/slot";
import { readDashboard } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await readDashboard(getCurrentSlot());
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
