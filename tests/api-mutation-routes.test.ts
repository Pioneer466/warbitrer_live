import { vi } from "vitest";

const storageMocks = vi.hoisted(() => ({
  OrderIntentRevisionConflictError: class OrderIntentRevisionConflictError extends Error {},
  readCircuitBreakers: vi.fn(),
  readOpenOrderIntents: vi.fn(),
  writeCircuitBreaker: vi.fn(),
  writeOrderIntent: vi.fn(),
}));

const recoveryMocks = vi.hoisted(() => ({
  buildRecoveryResponse: vi.fn(),
  convertPolymarketMarket: vi.fn(),
}));

const engineMocks = vi.hoisted(() => ({
  repairSettledIntentResolutions: vi.fn(),
}));

vi.mock("@/lib/storage", () => storageMocks);
vi.mock("@/lib/recovery", () => recoveryMocks);
vi.mock("@/lib/engine", () => engineMocks);

import { PUT as updateCircuitBreaker } from "@/app/api/circuit-breakers/route";
import { POST as recoverPolymarketMarket } from "@/app/api/recovery/route";
import { POST as repairSettlements } from "@/app/api/recovery/settlements/route";

const NOW = 1_800_000_000_000;
const AUTHORIZATION = `Basic ${Buffer.from("ops:secret", "utf8").toString("base64")}`;

const mutationRoutes = [
  {
    name: "PUT /api/circuit-breakers",
    body: { key: "global", active: true },
    invoke: updateCircuitBreaker,
    businessHandler: storageMocks.writeCircuitBreaker,
    expectedResponse: {
      key: "global",
      active: true,
      reason: "manual",
      triggeredAt: NOW,
      payload: null,
      closedIntentIds: [],
    },
  },
  {
    name: "POST /api/recovery",
    body: { action: "redeem", marketRef: "condition-1" },
    invoke: recoverPolymarketMarket,
    businessHandler: recoveryMocks.convertPolymarketMarket,
    expectedResponse: { status: "submitted", marketRef: "condition-1" },
  },
  {
    name: "POST /api/recovery/settlements",
    body: { asset: "btc", intentId: "intent-1", includeShadow: false },
    invoke: repairSettlements,
    businessHandler: engineMocks.repairSettledIntentResolutions,
    expectedResponse: { scanned: 1, repaired: 1 },
  },
] as const;

describe.each(mutationRoutes)("$name authentication", ({ body, invoke, businessHandler, expectedResponse }) => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_BASIC_AUTH_USER", "ops");
    vi.stubEnv("APP_BASIC_AUTH_PASSWORD", "secret");

    storageMocks.readCircuitBreakers.mockResolvedValue([]);
    storageMocks.readOpenOrderIntents.mockResolvedValue([]);
    storageMocks.writeCircuitBreaker.mockResolvedValue(undefined);
    storageMocks.writeOrderIntent.mockImplementation(async (intent) => intent);
    recoveryMocks.buildRecoveryResponse.mockResolvedValue({});
    recoveryMocks.convertPolymarketMarket.mockResolvedValue({ status: "submitted", marketRef: "condition-1" });
    engineMocks.repairSettledIntentResolutions.mockResolvedValue({ scanned: 1, repaired: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("returns 401 before parsing the body or invoking business logic", async () => {
    const { request, parseBody } = mutationRequest(body);

    const response = await invoke(request);

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe('Basic realm="warbitrer"');
    expect(await response.json()).toEqual({
      error: "API mutation authentication is required",
      code: "api_mutation_auth_required",
      status: 401,
      timestamp: NOW,
    });
    expect(parseBody).not.toHaveBeenCalled();
    expect(businessHandler).not.toHaveBeenCalled();
  });

  it("returns 503 before parsing the body when production credentials are absent", async () => {
    vi.stubEnv("APP_BASIC_AUTH_USER", "");
    vi.stubEnv("APP_BASIC_AUTH_PASSWORD", "");
    const { request, parseBody } = mutationRequest(body);

    const response = await invoke(request);

    expect(response.status).toBe(503);
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(await response.json()).toEqual({
      error: "API mutation authentication is not configured",
      code: "api_mutation_auth_not_configured",
      status: 503,
      timestamp: NOW,
    });
    expect(parseBody).not.toHaveBeenCalled();
    expect(businessHandler).not.toHaveBeenCalled();
  });

  it("preserves the business response after successful authentication", async () => {
    const { request, parseBody } = mutationRequest(body, AUTHORIZATION);

    const response = await invoke(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expectedResponse);
    expect(parseBody).toHaveBeenCalledOnce();
    expect(businessHandler).toHaveBeenCalledOnce();
  });
});

function mutationRequest(body: unknown, authorization?: string) {
  const parseBody = vi.fn(async () => body);
  const request = {
    headers: new Headers(authorization ? { authorization } : undefined),
    json: parseBody,
  } as unknown as Request;

  return { request, parseBody };
}
