import { NextResponse } from "next/server";

import { getCurrentSlot } from "@/lib/slot";
import { readHistoryPoints } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const slot = getCurrentSlot();

  return NextResponse.json(
    {
      fetchedAt: Date.now(),
      slot,
      points: await readHistoryPoints(slot),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
