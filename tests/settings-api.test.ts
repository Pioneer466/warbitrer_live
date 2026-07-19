import { DEFAULT_STRATEGY_CONFIG, DEFAULT_STRATEGY_CONFIGS } from "@/lib/constants";
import { vi } from "vitest";

const storageMocks = vi.hoisted(() => ({
  readSettings: vi.fn(),
  readSettingsMap: vi.fn(),
  writeSettings: vi.fn(),
}));

vi.mock("@/lib/storage", () => storageMocks);

import { PUT as putAssetSettings } from "@/app/api/settings/[asset]/route";
import { PUT as putSettingsMap } from "@/app/api/settings/route";

function request(body: unknown) {
  return new Request("https://warbitrer.test/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("settings API live gate", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      LIVE_EXECUTION_ALLOWED: "false",
      KALSHI_ENV: "prod",
    };
    storageMocks.writeSettings.mockImplementation(async (_asset, settings) => settings);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  it("rejects an asset transition to live when the environment gate is disabled", async () => {
    const response = await putAssetSettings(
      request({ ...DEFAULT_STRATEGY_CONFIG, enableTrading: true, shadowMode: false }),
      { params: Promise.resolve({ asset: "btc" }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "live_execution_blocked",
      reasons: ["environment_gate_disabled"],
    });
    expect(storageMocks.writeSettings).not.toHaveBeenCalled();
  });

  it("allows shadow execution while the live gate is disabled", async () => {
    const response = await putAssetSettings(
      request({ ...DEFAULT_STRATEGY_CONFIG, enableTrading: true, shadowMode: true }),
      { params: Promise.resolve({ asset: "btc" }) },
    );

    expect(response.status).toBe(200);
    expect(storageMocks.writeSettings).toHaveBeenCalledOnce();
  });

  it("allows an active asset live only with the gate and Kalshi production", async () => {
    process.env.LIVE_EXECUTION_ALLOWED = "true";
    const response = await putAssetSettings(
      request({ ...DEFAULT_STRATEGY_CONFIG, enableTrading: true, shadowMode: false }),
      { params: Promise.resolve({ asset: "btc" }) },
    );

    expect(response.status).toBe(200);
    expect(storageMocks.writeSettings).toHaveBeenCalledOnce();
  });

  it("rejects live for an asset without an active worker", async () => {
    process.env.LIVE_EXECUTION_ALLOWED = "true";
    const response = await putAssetSettings(
      request({ ...DEFAULT_STRATEGY_CONFIG, enableTrading: true, shadowMode: false }),
      { params: Promise.resolve({ asset: "bnb" }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reasons: ["asset_worker_inactive"] });
  });

  it("rejects a bulk update atomically before any write when one asset requests blocked live", async () => {
    const body = structuredClone(DEFAULT_STRATEGY_CONFIGS);
    body.btc = { ...body.btc, enableTrading: true, shadowMode: false };

    const response = await putSettingsMap(request(body));

    expect(response.status).toBe(409);
    expect(storageMocks.writeSettings).not.toHaveBeenCalled();
  });
});
