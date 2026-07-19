import { NextResponse } from "next/server";

import { ConfigurationRevisionConflictError } from "@/lib/storage";

export function createConfigurationConflictResponse(error: unknown) {
  if (!(error instanceof ConfigurationRevisionConflictError)) {
    return null;
  }

  return NextResponse.json(
    {
      error: "configuration_revision_conflict",
      conflicts: error.conflicts,
      timestamp: Date.now(),
    },
    { status: 409 },
  );
}
