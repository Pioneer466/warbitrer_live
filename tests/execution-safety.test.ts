import { createKalshiAdapter } from "@/lib/kalshi";
import {
  assertNewLiveExecutionAllowed,
  getLiveExecutionSafety,
  getLiveSettingsBlockReasons,
  isLiveMismatchRiskEnforced,
  LiveExecutionBlockedError,
  requestsLiveExecution,
} from "@/lib/execution-safety";
import type { VenueOrderRequest } from "@/lib/types";

const ORDER: VenueOrderRequest = {
  marketRef: "market-1",
  tokenId: "token-1",
  outcome: "YES",
  side: "BUY",
  size: 10,
  price: 0.45,
  maxCostUsd: 4.5,
  orderType: "FOK",
  clientOrderId: "safety-test-1",
};

describe("live execution safety", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it("fails closed unless the gate, production venue, and Polygon accounting RPC are configured", () => {
    expect(getLiveExecutionSafety({})).toMatchObject({
      allowed: false,
      kalshiEnvironment: "missing",
      polygonRpcConfigured: false,
      reasons: ["environment_gate_disabled", "kalshi_not_production", "polygon_rpc_missing"],
    });
    expect(getLiveExecutionSafety({ LIVE_EXECUTION_ALLOWED: "true", KALSHI_ENV: "demo" })).toMatchObject({
      allowed: false,
      gateEnabled: true,
      kalshiEnvironment: "demo",
      reasons: ["kalshi_not_production", "polygon_rpc_missing"],
    });
    expect(
      getLiveExecutionSafety({
        LIVE_EXECUTION_ALLOWED: "true",
        KALSHI_ENV: "prod",
        POLYGON_RPC_URL: "https://polygon.example",
      }),
    ).toEqual({
      allowed: true,
      gateEnabled: true,
      kalshiEnvironment: "prod",
      polygonRpcConfigured: true,
      reasons: [],
    });
  });

  it("distinguishes live settings from scan and shadow settings", () => {
    expect(requestsLiveExecution({ enableTrading: false, shadowMode: true })).toBe(false);
    expect(requestsLiveExecution({ enableTrading: true, shadowMode: true })).toBe(false);
    expect(requestsLiveExecution({ enableTrading: true, shadowMode: false })).toBe(true);
    expect(isLiveMismatchRiskEnforced({ mismatchRiskMode: "shadow" })).toBe(false);
    expect(isLiveMismatchRiskEnforced({ mismatchRiskMode: "block_only" })).toBe(false);
    expect(isLiveMismatchRiskEnforced({ mismatchRiskMode: "enforce" })).toBe(true);
  });

  it("allows every active asset and blocks unknown worker identities", () => {
    const env = {
      LIVE_EXECUTION_ALLOWED: "true",
      KALSHI_ENV: "prod",
      POLYGON_RPC_URL: "https://polygon.example",
    };
    const enforced = { enableTrading: true, shadowMode: false, mismatchRiskMode: "enforce" as const };
    expect(getLiveSettingsBlockReasons("btc", enforced, env)).toEqual([]);
    expect(getLiveSettingsBlockReasons("bnb", enforced, env)).toEqual([]);
    expect(getLiveSettingsBlockReasons("hype", enforced, env)).toEqual([]);
    expect(
      getLiveSettingsBlockReasons("inactive" as Parameters<typeof getLiveSettingsBlockReasons>[0], enforced, env),
    ).toEqual(["asset_worker_inactive"]);
  });

  it("blocks live settings unless mismatch risk is fail-closed in enforce mode", () => {
    const env = {
      LIVE_EXECUTION_ALLOWED: "true",
      KALSHI_ENV: "prod",
      POLYGON_RPC_URL: "https://polygon.example",
    };

    expect(
      getLiveSettingsBlockReasons("btc", { enableTrading: true, shadowMode: false, mismatchRiskMode: "shadow" }, env),
    ).toEqual(["mismatch_risk_not_enforced"]);
  });

  it("throws a typed error when a new live entry is not authorized", () => {
    expect(() =>
      assertNewLiveExecutionAllowed({
        LIVE_EXECUTION_ALLOWED: "false",
        KALSHI_ENV: "prod",
        POLYGON_RPC_URL: "https://polygon.example",
      }),
    ).toThrow(LiveExecutionBlockedError);
  });

  it("blocks the Kalshi adapter before order IO when Kalshi is not production", async () => {
    process.env = {
      ...originalEnv,
      LIVE_EXECUTION_ALLOWED: "true",
      KALSHI_ENV: "demo",
    };

    await expect(createKalshiAdapter().placeOrder(ORDER)).rejects.toThrow("kalshi_not_production");
  });
});
