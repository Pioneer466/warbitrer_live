import { DEFAULT_STRATEGY_CONFIG, DEFAULT_STRATEGY_CONFIGS } from "@/lib/constants";
import { DEFAULT_GLOBAL_RISK_CONFIG } from "@/lib/risk-settings";
import { MARKET_ASSETS } from "@/lib/market-catalog";
import type { StrategyConfig, StrategyConfigMapUpdate, VersionedStrategyConfigMap } from "@/lib/types";
import { vi } from "vitest";

const storageMocks = vi.hoisted(() => {
  class ConfigurationRevisionConflictError extends Error {
    constructor(readonly conflicts: unknown[]) {
      super("configuration revision conflict");
    }
  }

  return {
    ConfigurationRevisionConflictError,
    readGlobalRiskConfig: vi.fn(),
    readSettings: vi.fn(),
    readSettingsMap: vi.fn(),
    writeGlobalRiskConfig: vi.fn(),
    writeSettings: vi.fn(),
    writeSettingsMap: vi.fn(),
  };
});

vi.mock("@/lib/storage", () => storageMocks);

import { GET as getAssetSettings, PUT as putAssetSettings } from "@/app/api/settings/[asset]/route";
import { GET as getGlobalRisk, PUT as putGlobalRisk } from "@/app/api/settings/risk/route";
import { GET as getSettingsMap, PUT as putSettingsMap } from "@/app/api/settings/route";

function request(body: unknown) {
  return new Request("https://warbitrer.test/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("settings API revision contract and live gate", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      APP_BASIC_AUTH_PASSWORD: "",
      APP_BASIC_AUTH_USER: "",
      LIVE_EXECUTION_ALLOWED: "false",
      KALSHI_ENV: "prod",
    };
    storageMocks.readSettings.mockResolvedValue(versionedAsset("btc"));
    storageMocks.readSettingsMap.mockResolvedValue(versionedSettingsMap());
    storageMocks.readGlobalRiskConfig.mockResolvedValue({
      config: DEFAULT_GLOBAL_RISK_CONFIG,
      revision: 0,
      updatedAt: 100,
    });
    storageMocks.writeSettings.mockImplementation(async (asset, update) => ({
      asset,
      config: update.config,
      revision: update.expectedRevision + 1,
      updatedAt: 200,
    }));
    storageMocks.writeSettingsMap.mockImplementation(async (updates) =>
      Object.fromEntries(
        MARKET_ASSETS.map((asset) => [
          asset,
          {
            asset,
            config: updates[asset].config,
            revision: updates[asset].expectedRevision + 1,
            updatedAt: 200,
          },
        ]),
      ),
    );
    storageMocks.writeGlobalRiskConfig.mockImplementation(async (update) => ({
      config: update.config,
      revision: update.expectedRevision + 1,
      updatedAt: 200,
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  it("returns versioned GET envelopes with no-store caching", async () => {
    const assetResponse = await getAssetSettings(request(null), {
      params: Promise.resolve({ asset: "btc" }),
    });
    const bulkResponse = await getSettingsMap();
    const riskResponse = await getGlobalRisk();

    expect(await assetResponse.json()).toEqual(versionedAsset("btc"));
    expect(await bulkResponse.json()).toEqual({ configs: versionedSettingsMap() });
    expect(await riskResponse.json()).toEqual({ config: DEFAULT_GLOBAL_RISK_CONFIG, revision: 0, updatedAt: 100 });
    expect(assetResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(bulkResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(riskResponse.headers.get("Cache-Control")).toBe("no-store");
  });

  it("authenticates a mutation before parsing its body", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.APP_BASIC_AUTH_USER = "ops";
    process.env.APP_BASIC_AUTH_PASSWORD = "secret";
    const parseBody = vi.fn(async () => assetUpdate());
    const unauthenticated = {
      headers: new Headers(),
      json: parseBody,
    } as unknown as Request;

    const response = await putAssetSettings(unauthenticated, {
      params: Promise.resolve({ asset: "btc" }),
    });

    expect(response.status).toBe(401);
    expect(parseBody).not.toHaveBeenCalled();
    expect(storageMocks.writeSettings).not.toHaveBeenCalled();
  });

  it("rejects an asset transition to live when the environment gate is disabled", async () => {
    const response = await putAssetSettings(request(assetUpdate({ enableTrading: true, shadowMode: false })), {
      params: Promise.resolve({ asset: "btc" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "live_execution_blocked",
      reasons: ["environment_gate_disabled"],
    });
    expect(storageMocks.writeSettings).not.toHaveBeenCalled();
  });

  it("allows shadow execution while the live gate is disabled", async () => {
    const response = await putAssetSettings(request(assetUpdate({ enableTrading: true, shadowMode: true })), {
      params: Promise.resolve({ asset: "btc" }),
    });

    expect(response.status).toBe(200);
    expect(storageMocks.writeSettings).toHaveBeenCalledWith(
      "btc",
      assetUpdate({ enableTrading: true, shadowMode: true }),
      expect.objectContaining({ actor: "local-dev", requestId: expect.any(String) }),
    );
  });

  it("allows an active asset live only with the gate and Kalshi production", async () => {
    process.env.LIVE_EXECUTION_ALLOWED = "true";
    const response = await putAssetSettings(request(assetUpdate({ enableTrading: true, shadowMode: false })), {
      params: Promise.resolve({ asset: "btc" }),
    });

    expect(response.status).toBe(200);
    expect(storageMocks.writeSettings).toHaveBeenCalledOnce();
  });

  it("rejects live for an asset without an active worker", async () => {
    process.env.LIVE_EXECUTION_ALLOWED = "true";
    const response = await putAssetSettings(request(assetUpdate({ enableTrading: true, shadowMode: false })), {
      params: Promise.resolve({ asset: "bnb" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reasons: ["asset_worker_inactive"] });
  });

  it("rejects a bulk update atomically before any write when one asset requests blocked live", async () => {
    const updates = strategyUpdates();
    updates.btc.config = { ...updates.btc.config, enableTrading: true, shadowMode: false };

    const response = await putSettingsMap(request({ updates }));

    expect(response.status).toBe(409);
    expect(storageMocks.writeSettingsMap).not.toHaveBeenCalled();
    expect(storageMocks.writeSettings).not.toHaveBeenCalled();
  });

  it("returns structured revision conflicts", async () => {
    const conflicts = [
      {
        configurationType: "strategy",
        key: "btc",
        expectedRevision: 2,
        actualRevision: 3,
      },
    ];
    storageMocks.writeSettings.mockRejectedValueOnce(new storageMocks.ConfigurationRevisionConflictError(conflicts));

    const response = await putAssetSettings(request(assetUpdate()), {
      params: Promise.resolve({ asset: "btc" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "configuration_revision_conflict",
      conflicts,
    });
  });

  it("requires expectedRevision for global-risk mutations", async () => {
    const response = await putGlobalRisk(request({ config: DEFAULT_GLOBAL_RISK_CONFIG }));

    expect(response.status).toBe(400);
    expect(storageMocks.writeGlobalRiskConfig).not.toHaveBeenCalled();
  });
});

function assetUpdate(overrides: Partial<StrategyConfig> = {}) {
  return {
    config: { ...DEFAULT_STRATEGY_CONFIG, ...overrides },
    expectedRevision: 0,
  };
}

function strategyUpdates(): StrategyConfigMapUpdate {
  return Object.fromEntries(
    MARKET_ASSETS.map((asset) => [
      asset,
      {
        config: structuredClone(DEFAULT_STRATEGY_CONFIGS[asset]),
        expectedRevision: 0,
      },
    ]),
  ) as StrategyConfigMapUpdate;
}

function versionedAsset(asset: (typeof MARKET_ASSETS)[number]) {
  return {
    asset,
    config: structuredClone(DEFAULT_STRATEGY_CONFIGS[asset]),
    revision: 0,
    updatedAt: 100,
  };
}

function versionedSettingsMap(): VersionedStrategyConfigMap {
  return Object.fromEntries(MARKET_ASSETS.map((asset) => [asset, versionedAsset(asset)])) as VersionedStrategyConfigMap;
}
