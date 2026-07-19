import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const STATIC_PATHS = ["/_next", "/favicon.ico"];

export function middleware(request: NextRequest) {
  const user = process.env.APP_BASIC_AUTH_USER;
  const password = process.env.APP_BASIC_AUTH_PASSWORD;

  if (STATIC_PATHS.some((path) => request.nextUrl.pathname.startsWith(path))) {
    return NextResponse.next();
  }

  if (!user || !password) {
    if (process.env.NODE_ENV === "production" || user || password) {
      return authenticationNotConfigured();
    }
    return NextResponse.next();
  }

  const credentials = parseBasicAuthorization(request.headers.get("authorization"));
  if (!credentials) {
    return unauthorized();
  }

  if (credentials.user !== user || credentials.password !== password) {
    return unauthorized();
  }

  return NextResponse.next();
}

export function parseBasicAuthorization(authorization: string | null) {
  if (!authorization?.match(/^Basic\s+/i)) {
    return null;
  }

  try {
    const encoded = authorization.replace(/^Basic\s+/i, "").trim();
    const decoded = atob(encoded);
    const separator = decoded.indexOf(":");
    if (separator < 0) {
      return null;
    }
    return {
      user: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};

function unauthorized() {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="warbitrer"',
    },
  });
}

function authenticationNotConfigured() {
  return new NextResponse("Authentication is not configured", {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
