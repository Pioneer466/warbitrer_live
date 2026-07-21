import { vi } from "vitest";

const storageMocks = vi.hoisted(() => ({
  CircuitBreakerIncidentPersistenceError: class CircuitBreakerIncidentPersistenceError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly incidentId: string | null = null,
    ) {
      super(message);
    }
  },
  acknowledgeCircuitBreaker: vi.fn(),
  acknowledgeManualKillBreaker: vi.fn(),
  readCurrentCircuitBreakerIncidents: vi.fn(),
  readOpenOrderIntents: vi.fn(),
  writeCircuitBreakerIncident: vi.fn(),
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
import { createManualKillIncident, createPolygonRpcIncident } from "@/lib/circuit-breaker-incidents";

const NOW = 1_800_000_000_000;
const AUTHORIZATION = `Basic ${Buffer.from("ops:secret", "utf8").toString("base64")}`;

const mutationRoutes = [
  {
    name: "PUT /api/circuit-breakers",
    body: { key: "global", active: true },
    invoke: updateCircuitBreaker,
    businessHandler: storageMocks.writeCircuitBreakerIncident,
    expectedResponse: {
      key: "global",
      active: true,
      reason: "manual",
      triggeredAt: NOW,
      payload: {
        projectionVersion: "multi-cause-ui-v1",
        uiProjectionOnly: true,
        dominantIncidentId: expect.any(String),
        incidentIds: [expect.any(String)],
        intentIds: [],
        manualKillActive: true,
        requiresManualClear: true,
        cooldownUntil: null,
      },
      incidentId: expect.any(String),
      revision: 1,
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

    storageMocks.readCurrentCircuitBreakerIncidents.mockResolvedValue([]);
    storageMocks.readOpenOrderIntents.mockResolvedValue([]);
    storageMocks.writeCircuitBreakerIncident.mockImplementation(async ({ incident }) => incident);
    storageMocks.acknowledgeCircuitBreaker.mockImplementation(async (input) => ({ id: input.incidentId }));
    storageMocks.acknowledgeManualKillBreaker.mockImplementation(async (input) => ({ id: input.incidentId }));
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

describe("PUT /api/circuit-breakers exact incident semantics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_BASIC_AUTH_USER", "ops");
    vi.stubEnv("APP_BASIC_AUTH_PASSWORD", "secret");
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("rejects broad scope clears without an exact incident revision", async () => {
    const { request } = mutationRequest({ key: "global", active: false }, AUTHORIZATION);

    const response = await updateCircuitBreaker(request);

    expect(response.status).toBe(400);
    expect(storageMocks.acknowledgeCircuitBreaker).not.toHaveBeenCalled();
    expect(storageMocks.acknowledgeManualKillBreaker).not.toHaveBeenCalled();
  });

  it("acknowledges only the requested manual kill while another global cause remains active", async () => {
    const manual = createManualKillIncident({
      triggeredAt: NOW - 2_000,
      operatorId: "basic:ops",
    });
    const rpc = createPolygonRpcIncident({
      triggeredAt: NOW - 1_000,
      failureKind: "health_check_failed",
      detail: "timeout",
    });
    storageMocks.readCurrentCircuitBreakerIncidents.mockResolvedValueOnce([manual, rpc]).mockResolvedValueOnce([rpc]);
    storageMocks.acknowledgeManualKillBreaker.mockResolvedValue({
      ...manual,
      revision: 2,
      timestamps: { ...manual.timestamps, acknowledgedAt: NOW, resolvedAt: NOW },
    });
    const { request } = mutationRequest(
      {
        key: "global",
        active: false,
        incidentId: manual.id,
        expectedRevision: manual.revision,
      },
      AUTHORIZATION,
    );

    const response = await updateCircuitBreaker(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      key: "global",
      active: true,
      reason: "rpc_unhealthy",
      acknowledgedIncidentId: manual.id,
      closedIntentIds: [],
    });
    expect(storageMocks.acknowledgeManualKillBreaker).toHaveBeenCalledWith(
      expect.objectContaining({ incidentId: manual.id, expectedRevision: 1, operatorId: "basic:ops" }),
    );
    expect(storageMocks.acknowledgeCircuitBreaker).not.toHaveBeenCalled();
  });

  it("refuses to create arbitrary breaker causes through the manual endpoint", async () => {
    const { request } = mutationRequest({ key: "asset:btc", active: true, reason: "venue_error" }, AUTHORIZATION);

    const response = await updateCircuitBreaker(request);

    expect(response.status).toBe(400);
    expect(storageMocks.writeCircuitBreakerIncident).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", null],
    ["an unknown property", { key: "global", active: true, force: true }],
    ["a non-integer revision", { active: false, incidentId: "incident-1", expectedRevision: 1.5 }],
    ["an oversized incident ID", { active: false, incidentId: "x".repeat(257), expectedRevision: 1 }],
  ])("rejects %s before mutating persistence", async (_label, body) => {
    const { request } = mutationRequest(body, AUTHORIZATION);

    const response = await updateCircuitBreaker(request);

    expect(response.status).toBe(400);
    expect(storageMocks.writeCircuitBreakerIncident).not.toHaveBeenCalled();
    expect(storageMocks.acknowledgeCircuitBreaker).not.toHaveBeenCalled();
    expect(storageMocks.acknowledgeManualKillBreaker).not.toHaveBeenCalled();
  });

  it("rejects an acknowledgement whose supplied scope does not match the exact incident", async () => {
    const manual = createManualKillIncident({
      triggeredAt: NOW - 1_000,
      operatorId: "basic:ops",
    });
    storageMocks.readCurrentCircuitBreakerIncidents.mockResolvedValue([manual]);
    const { request } = mutationRequest(
      {
        key: "asset:btc",
        active: false,
        incidentId: manual.id,
        expectedRevision: manual.revision,
      },
      AUTHORIZATION,
    );

    const response = await updateCircuitBreaker(request);

    expect(response.status).toBe(400);
    expect(storageMocks.acknowledgeManualKillBreaker).not.toHaveBeenCalled();
  });

  it("sanitizes and bounds the manual kill operator note", async () => {
    storageMocks.writeCircuitBreakerIncident.mockImplementation(async ({ incident }) => incident);
    const { request } = mutationRequest(
      {
        key: "global",
        active: true,
        payload: { note: `  investigate\n${"x".repeat(2_000)}  ` },
      },
      AUTHORIZATION,
    );

    const response = await updateCircuitBreaker(request);

    expect(response.status).toBe(200);
    const [[{ incident }]] = storageMocks.writeCircuitBreakerIncident.mock.calls;
    expect(incident.payload.note).toHaveLength(1_024);
    expect(incident.payload.note).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(incident.payload.note).toMatch(/^investigate x/);
  });
});

describe("POST /api/recovery/settlements validation", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_BASIC_AUTH_USER", "ops");
    vi.stubEnv("APP_BASIC_AUTH_PASSWORD", "secret");
    vi.clearAllMocks();
    engineMocks.repairSettledIntentResolutions.mockResolvedValue({ scanned: 1, repaired: 1 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it.each([
    ["an empty body", {}],
    ["an unconfirmed batch", { asset: "all" }],
    ["an excessive limit", { confirmBatch: "repair-settled-intents", limit: 1_001 }],
    ["an excessive lookback", { confirmBatch: "repair-settled-intents", lookbackHours: 24 * 365 + 1 }],
    ["an unknown property", { intentId: "intent-1", unexpected: true }],
  ])("rejects %s before invoking business logic", async (_label, body) => {
    const { request } = mutationRequest(body, AUTHORIZATION);

    const response = await repairSettlements(request);

    expect(response.status).toBe(400);
    expect(engineMocks.repairSettledIntentResolutions).not.toHaveBeenCalled();
  });

  it("accepts an explicitly confirmed bounded batch", async () => {
    const { request } = mutationRequest(
      {
        asset: "btc",
        lookbackHours: 48,
        limit: 100,
        includeShadow: false,
        confirmBatch: "repair-settled-intents",
      },
      AUTHORIZATION,
    );

    const response = await repairSettlements(request);

    expect(response.status).toBe(200);
    expect(engineMocks.repairSettledIntentResolutions).toHaveBeenCalledWith({
      asset: "btc",
      intentId: undefined,
      lookbackHours: 48,
      limit: 100,
      includeShadow: false,
    });
  });
});

describe("POST /api/recovery validation", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_BASIC_AUTH_USER", "ops");
    vi.stubEnv("APP_BASIC_AUTH_PASSWORD", "secret");
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it.each([
    ["an empty body", {}],
    ["an unsupported action", { action: "withdraw", marketRef: "condition-1" }],
    ["a blank market", { action: "redeem", marketRef: "   " }],
    ["an oversized market", { action: "convert", marketRef: "x".repeat(257) }],
    ["an unknown property", { action: "redeem", marketRef: "condition-1", force: true }],
  ])("rejects %s before invoking business logic", async (_label, body) => {
    const { request } = mutationRequest(body, AUTHORIZATION);

    const response = await recoverPolymarketMarket(request);

    expect(response.status).toBe(400);
    expect(recoveryMocks.convertPolymarketMarket).not.toHaveBeenCalled();
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
