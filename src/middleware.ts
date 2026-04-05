import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const STATIC_PATHS = ["/_next", "/favicon.ico"];

export function middleware(request: NextRequest) {
  const user = process.env.APP_BASIC_AUTH_USER;
  const password = process.env.APP_BASIC_AUTH_PASSWORD;

  if (!user || !password || STATIC_PATHS.some((path) => request.nextUrl.pathname.startsWith(path))) {
    return NextResponse.next();
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Basic ")) {
    return unauthorized();
  }

  const encoded = authorization.slice("Basic ".length).trim();
  const decoded = atob(encoded);
  const separator = decoded.indexOf(":");
  const providedUser = separator >= 0 ? decoded.slice(0, separator) : decoded;
  const providedPassword = separator >= 0 ? decoded.slice(separator + 1) : "";

  if (providedUser !== user || providedPassword !== password) {
    return unauthorized();
  }

  return NextResponse.next();
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
