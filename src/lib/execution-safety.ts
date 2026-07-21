import { isTruthyEnv } from "@/lib/env";
import { ACTIVE_MARKET_ASSETS } from "@/lib/market-catalog";
import type { MarketAsset, StrategyConfig } from "@/lib/types";

export const LIVE_EXECUTION_ENV_KEY = "LIVE_EXECUTION_ALLOWED";

type ExecutionEnvironment = Partial<
  Record<"LIVE_EXECUTION_ALLOWED" | "KALSHI_ENV" | "POLYGON_RPC_URL", string | undefined>
>;

export type LiveExecutionSafety = {
  allowed: boolean;
  gateEnabled: boolean;
  kalshiEnvironment: "prod" | "demo" | "missing" | "invalid";
  polygonRpcConfigured: boolean;
  reasons: Array<"environment_gate_disabled" | "kalshi_not_production" | "polygon_rpc_missing">;
};

export class LiveExecutionBlockedError extends Error {
  readonly code = "live_execution_blocked";
  readonly reasons: LiveExecutionSafety["reasons"];

  constructor(safety: LiveExecutionSafety) {
    super(`Live execution blocked: ${safety.reasons.join(", ")}`);
    this.name = "LiveExecutionBlockedError";
    this.reasons = safety.reasons;
  }
}

export function getLiveExecutionSafety(env: ExecutionEnvironment = readExecutionEnvironment()): LiveExecutionSafety {
  const gateEnabled = isTruthyEnv(env.LIVE_EXECUTION_ALLOWED);
  const kalshiEnvironment = normalizeKalshiEnvironment(env.KALSHI_ENV);
  const polygonRpcConfigured = Boolean(env.POLYGON_RPC_URL?.trim());
  const reasons: LiveExecutionSafety["reasons"] = [];

  if (!gateEnabled) {
    reasons.push("environment_gate_disabled");
  }
  if (kalshiEnvironment !== "prod") {
    reasons.push("kalshi_not_production");
  }
  if (!polygonRpcConfigured) {
    reasons.push("polygon_rpc_missing");
  }

  return {
    allowed: reasons.length === 0,
    gateEnabled,
    kalshiEnvironment,
    polygonRpcConfigured,
    reasons,
  };
}

export function isLiveExecutionAllowed(env: ExecutionEnvironment = readExecutionEnvironment()) {
  return getLiveExecutionSafety(env).allowed;
}

export function requestsLiveExecution(settings: Pick<StrategyConfig, "enableTrading" | "shadowMode">) {
  return settings.enableTrading && !settings.shadowMode;
}

export function getLiveSettingsBlockReasons(
  asset: MarketAsset,
  settings: Pick<StrategyConfig, "enableTrading" | "shadowMode">,
  env: ExecutionEnvironment = readExecutionEnvironment(),
) {
  if (!requestsLiveExecution(settings)) {
    return [];
  }

  const reasons: Array<LiveExecutionSafety["reasons"][number] | "asset_worker_inactive"> = [
    ...getLiveExecutionSafety(env).reasons,
  ];
  if (!ACTIVE_MARKET_ASSETS.includes(asset)) {
    reasons.push("asset_worker_inactive");
  }
  return reasons;
}

export function assertNewLiveExecutionAllowed(env: ExecutionEnvironment = readExecutionEnvironment()) {
  const safety = getLiveExecutionSafety(env);
  if (!safety.allowed) {
    throw new LiveExecutionBlockedError(safety);
  }
}

export function assertProductionVenueEnvironment(
  env: Pick<ExecutionEnvironment, "KALSHI_ENV"> = readExecutionEnvironment(),
) {
  const kalshiEnvironment = normalizeKalshiEnvironment(env.KALSHI_ENV);
  if (kalshiEnvironment !== "prod") {
    throw new LiveExecutionBlockedError({
      allowed: false,
      gateEnabled: isTruthyEnv(process.env.LIVE_EXECUTION_ALLOWED),
      kalshiEnvironment,
      polygonRpcConfigured: Boolean(process.env.POLYGON_RPC_URL?.trim()),
      reasons: ["kalshi_not_production"],
    });
  }
}

function normalizeKalshiEnvironment(value: string | undefined): LiveExecutionSafety["kalshiEnvironment"] {
  if (value === undefined || value.trim() === "") {
    return "missing";
  }
  if (value === "prod" || value === "demo") {
    return value;
  }
  return "invalid";
}

function readExecutionEnvironment(): ExecutionEnvironment {
  return {
    LIVE_EXECUTION_ALLOWED: process.env.LIVE_EXECUTION_ALLOWED,
    KALSHI_ENV: process.env.KALSHI_ENV,
    POLYGON_RPC_URL: process.env.POLYGON_RPC_URL,
  };
}
