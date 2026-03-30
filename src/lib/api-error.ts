import { NextResponse } from "next/server";

export function createApiErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Erreur interne";
  const status = isConnectivityError(error) ? 503 : 500;

  return NextResponse.json(
    {
      error: message,
      status,
      timestamp: Date.now(),
    },
    { status },
  );
}

function isConnectivityError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("ECONNREFUSED") ||
    error.message.includes("ENOTFOUND") ||
    error.message.includes("DATABASE_URL") ||
    error.message.includes("connect")
  );
}
