import { NextRequest } from "next/server";
import { vi } from "vitest";

import { middleware, parseBasicAuthorization } from "@/middleware";

describe("application Basic Auth middleware", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed in production when credentials are absent", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_BASIC_AUTH_USER", "");
    vi.stubEnv("APP_BASIC_AUTH_PASSWORD", "");

    const response = middleware(new NextRequest("https://warbitrer.test/api/settings"));
    expect(response.status).toBe(503);
  });

  it("fails closed when only one credential is configured", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_BASIC_AUTH_USER", "ops");
    vi.stubEnv("APP_BASIC_AUTH_PASSWORD", "");

    const response = middleware(new NextRequest("https://warbitrer.test/api/settings"));
    expect(response.status).toBe(503);
  });

  it("rejects missing, invalid, and malformed credentials", () => {
    vi.stubEnv("APP_BASIC_AUTH_USER", "ops");
    vi.stubEnv("APP_BASIC_AUTH_PASSWORD", "secret");

    expect(middleware(new NextRequest("https://warbitrer.test/api/settings")).status).toBe(401);
    expect(
      middleware(
        new NextRequest("https://warbitrer.test/api/settings", {
          headers: { authorization: `Basic ${btoa("ops:wrong")}` },
        }),
      ).status,
    ).toBe(401);
    expect(
      middleware(
        new NextRequest("https://warbitrer.test/api/settings", {
          headers: { authorization: "Basic !!!not-base64!!!" },
        }),
      ).status,
    ).toBe(401);
  });

  it("accepts valid credentials and preserves colons in the password", () => {
    vi.stubEnv("APP_BASIC_AUTH_USER", "ops");
    vi.stubEnv("APP_BASIC_AUTH_PASSWORD", "sec:ret");

    const response = middleware(
      new NextRequest("https://warbitrer.test/api/settings", {
        headers: { authorization: `Basic ${btoa("ops:sec:ret")}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("parses Basic credentials without throwing", () => {
    expect(parseBasicAuthorization(`Basic ${btoa("ops:secret")}`)).toEqual({
      user: "ops",
      password: "secret",
    });
    expect(parseBasicAuthorization("Bearer token")).toBeNull();
    expect(parseBasicAuthorization("Basic invalid***")).toBeNull();
  });
});
