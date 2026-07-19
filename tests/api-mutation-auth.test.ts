import { vi } from "vitest";

import {
  ApiMutationAuthError,
  authenticateApiMutation,
  type ApiMutationAuthEnvironment,
} from "@/lib/api-mutation-auth";

const productionWithoutAuth = {
  NODE_ENV: "production",
} satisfies ApiMutationAuthEnvironment;

const configuredAuth = {
  NODE_ENV: "production",
  APP_BASIC_AUTH_USER: "ops",
  APP_BASIC_AUTH_PASSWORD: "sec:ret",
} satisfies ApiMutationAuthEnvironment;

describe("API mutation authentication", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads server credentials from the process environment by default", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("APP_BASIC_AUTH_USER", "");
    vi.stubEnv("APP_BASIC_AUTH_PASSWORD", "");

    expect(authenticateApiMutation(request()).actor).toBe("local-dev");
  });

  it("uses a server-generated UUID for unauthenticated local development", () => {
    const result = authenticateApiMutation(request(), {
      env: { NODE_ENV: "development" },
    });

    expect(result.actor).toBe("local-dev");
    expect(result.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("accepts an injected request ID factory after local authorization", () => {
    const requestIdFactory = vi.fn(() => "test-request-id");

    expect(
      authenticateApiMutation(request(), {
        env: { NODE_ENV: "test" },
        requestIdFactory,
      }),
    ).toEqual({
      actor: "local-dev",
      requestId: "test-request-id",
    });
    expect(requestIdFactory).toHaveBeenCalledOnce();
  });

  it("fails closed in production when both credentials are absent", () => {
    const requestIdFactory = vi.fn(() => "must-not-be-created");

    const error = captureAuthError(() =>
      authenticateApiMutation(request(), {
        env: productionWithoutAuth,
        requestIdFactory,
      }),
    );

    expect(error).toMatchObject({
      name: "ApiMutationAuthError",
      status: 503,
      code: "api_mutation_auth_not_configured",
      message: "API mutation authentication is not configured",
    });
    expect(requestIdFactory).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "username only",
      env: { NODE_ENV: "development", APP_BASIC_AUTH_USER: "ops" },
    },
    {
      label: "password only",
      env: { NODE_ENV: "development", APP_BASIC_AUTH_PASSWORD: "secret" },
    },
    {
      label: "blank password",
      env: {
        NODE_ENV: "production",
        APP_BASIC_AUTH_USER: "ops",
        APP_BASIC_AUTH_PASSWORD: "   ",
      },
    },
  ])("fails closed for a partial configuration: $label", ({ env }) => {
    const error = captureAuthError(() =>
      authenticateApiMutation(request(), {
        env,
      }),
    );

    expect(error).toMatchObject({
      status: 503,
      code: "api_mutation_auth_misconfigured",
    });
  });

  it.each(["ops:admin", "ops\nadmin"])(
    "fails closed when configured username %j cannot be represented safely",
    (configuredUser) => {
      const error = captureAuthError(() =>
        authenticateApiMutation(request(basic("ops", "secret")), {
          env: {
            NODE_ENV: "production",
            APP_BASIC_AUTH_USER: configuredUser,
            APP_BASIC_AUTH_PASSWORD: "secret",
          },
        }),
      );

      expect(error).toMatchObject({
        status: 503,
        code: "api_mutation_auth_misconfigured",
      });
    },
  );

  it("derives the actor from an exact Basic Auth match", () => {
    const result = authenticateApiMutation(request(basic("ops", "sec:ret")), {
      env: configuredAuth,
      requestIdFactory: () => "request-123",
    });

    expect(result).toEqual({
      actor: "basic:ops",
      requestId: "request-123",
    });
    expect(JSON.stringify(result)).not.toContain("sec:ret");
  });

  it("supports UTF-8 credentials and a case-insensitive Basic scheme", () => {
    const user = "op\u00e9rateur";
    const password = "s\u00e9curit\u00e9";
    const result = authenticateApiMutation(
      request(`bAsIc ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`),
      {
        env: {
          NODE_ENV: "production",
          APP_BASIC_AUTH_USER: user,
          APP_BASIC_AUTH_PASSWORD: password,
        },
        requestIdFactory: () => "request-utf8",
      },
    );

    expect(result.actor).toBe(`basic:${user}`);
  });

  it("accepts valid unpadded base64 credentials", () => {
    const authorization = basic("ops", "sec:ret").replace(/=+$/, "");

    expect(
      authenticateApiMutation(request(authorization), {
        env: configuredAuth,
        requestIdFactory: () => "request-unpadded",
      }),
    ).toEqual({
      actor: "basic:ops",
      requestId: "request-unpadded",
    });
  });

  it.each([
    ["missing header", undefined],
    ["wrong scheme", "Bearer token"],
    ["invalid alphabet", "Basic !!!not-base64!!!"],
    ["invalid padding", "Basic b3BzOnNlY3JldA="],
    ["non-canonical base64", "Basic b3BzOnNlY3JldB=="],
    ["missing separator", `Basic ${Buffer.from("ops", "utf8").toString("base64")}`],
    ["invalid UTF-8", "Basic /zo="],
    ["wrong username", basic("other", "sec:ret")],
    ["wrong password", basic("ops", "wrong")],
  ])("rejects $label without creating an audit ID", (_label, authorization) => {
    const requestIdFactory = vi.fn(() => "must-not-be-created");
    const error = captureAuthError(() =>
      authenticateApiMutation(request(authorization), {
        env: configuredAuth,
        requestIdFactory,
      }),
    );

    expect(error).toMatchObject({
      status: 401,
      code: "api_mutation_auth_required",
      message: "API mutation authentication is required",
    });
    expect(requestIdFactory).not.toHaveBeenCalled();
    expect(String(error)).not.toContain(configuredAuth.APP_BASIC_AUTH_PASSWORD);
    expect(JSON.stringify(error)).not.toContain(configuredAuth.APP_BASIC_AUTH_PASSWORD);
  });
});

function request(authorization?: string) {
  return new Request("https://warbitrer.test/api/settings", {
    headers: authorization ? { authorization } : undefined,
  });
}

function basic(user: string, password: string) {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

function captureAuthError(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiMutationAuthError);
    return error as ApiMutationAuthError;
  }

  throw new Error("Expected API mutation authentication to fail");
}
