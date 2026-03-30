import { NextResponse } from "next/server";

import { readTrades } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await readTrades(), {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
