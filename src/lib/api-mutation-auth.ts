import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export type ApiMutationAuthErrorCode =
  "api_mutation_auth_required" | "api_mutation_auth_not_configured" | "api_mutation_auth_misconfigured";

export class ApiMutationAuthError extends Error {
  readonly name = "ApiMutationAuthError";

  constructor(
    readonly status: 401 | 503,
    readonly code: ApiMutationAuthErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ApiMutationAuthResult = {
  actor: string;
  requestId: string;
};

export type ApiMutationAuthEnvironment = Readonly<{
  NODE_ENV?: string;
  APP_BASIC_AUTH_USER?: string;
  APP_BASIC_AUTH_PASSWORD?: string;
}>;

export type ApiMutationAuthOptions = Readonly<{
  env?: ApiMutationAuthEnvironment;
  requestIdFactory?: () => string;
}>;

export function authenticateApiMutation(
  request: Pick<Request, "headers">,
  options: ApiMutationAuthOptions = {},
): ApiMutationAuthResult {
  const env = options.env ?? process.env;
  const requestIdFactory = options.requestIdFactory ?? randomUUID;
  const configuredUser = normalizeConfiguredCredential(env.APP_BASIC_AUTH_USER);
  const configuredPassword = normalizeConfiguredCredential(env.APP_BASIC_AUTH_PASSWORD);

  if (!configuredUser && !configuredPassword) {
    if (env.NODE_ENV === "production") {
      throw new ApiMutationAuthError(
        503,
        "api_mutation_auth_not_configured",
        "API mutation authentication is not configured",
      );
    }

    return {
      actor: "local-dev",
      requestId: requestIdFactory(),
    };
  }

  if (!configuredUser || !configuredPassword) {
    throw new ApiMutationAuthError(
      503,
      "api_mutation_auth_misconfigured",
      "API mutation authentication is misconfigured",
    );
  }

  if (configuredUser.includes(":") || /[\u0000-\u001f\u007f]/.test(configuredUser)) {
    throw new ApiMutationAuthError(
      503,
      "api_mutation_auth_misconfigured",
      "API mutation authentication is misconfigured",
    );
  }

  const supplied = parseBasicAuthorization(request.headers.get("authorization"));
  if (!supplied) {
    throw new ApiMutationAuthError(401, "api_mutation_auth_required", "API mutation authentication is required");
  }

  const userMatches = constantTimeEqual(supplied.user, configuredUser);
  const passwordMatches = constantTimeEqual(supplied.password, configuredPassword);
  if (!userMatches || !passwordMatches) {
    throw new ApiMutationAuthError(401, "api_mutation_auth_required", "API mutation authentication is required");
  }

  return {
    actor: `basic:${configuredUser}`,
    requestId: requestIdFactory(),
  };
}

function normalizeConfiguredCredential(value: string | undefined) {
  return value && value.trim().length > 0 ? value : undefined;
}

function parseBasicAuthorization(authorization: string | null) {
  if (!authorization) {
    return null;
  }

  const match = /^Basic[ \t]+([A-Za-z0-9+/]+={0,2})$/i.exec(authorization.trim());
  if (!match) {
    return null;
  }

  const encoded = match[1];
  const remainder = encoded.length % 4;
  if (remainder === 1 || (encoded.includes("=") && remainder !== 0)) {
    return null;
  }

  try {
    const padded = encoded.padEnd(encoded.length + ((4 - remainder) % 4), "=");
    const bytes = Buffer.from(padded, "base64");
    const canonical = bytes.toString("base64").replace(/=+$/, "");
    if (canonical !== encoded.replace(/=+$/, "")) {
      return null;
    }

    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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

function constantTimeEqual(actual: string, expected: string) {
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}
