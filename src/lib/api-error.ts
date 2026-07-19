import { NextResponse } from "next/server";

import { ApiMutationAuthError } from "@/lib/api-mutation-auth";

export function createApiErrorResponse(error: unknown) {
  if (error instanceof ApiMutationAuthError) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        status: error.status,
        timestamp: Date.now(),
      },
      {
        status: error.status,
        headers: error.status === 401 ? { "WWW-Authenticate": 'Basic realm="warbitrer"' } : undefined,
      },
    );
  }

  const message = getErrorMessage(error);
  const status = isConnectivityError(error) ? 503 : 500;

  console.error("[api] request failed", error);

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
  const message = getErrorMessage(error);

  return (
    message.includes("ECONNREFUSED") ||
    message.includes("ENOTFOUND") ||
    message.includes("DATABASE_URL") ||
    message.includes("password authentication failed") ||
    message.includes("connect")
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    const nested: string[] = error.errors.map((entry) => getErrorMessage(entry)).filter((entry) => entry.length > 0);

    if (nested.length > 0) {
      return nested.join(" | ");
    }
  }

  if (error instanceof Error) {
    if (error.message.length > 0) {
      return error.message;
    }

    if (error.name.length > 0) {
      return error.name;
    }
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  return "Erreur interne";
}
