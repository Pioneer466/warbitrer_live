import { ACTIVE_MARKET_ASSETS } from "@/lib/market-catalog";
import type { MarketAsset, WorkerRole } from "@/lib/types";

export type WorkerRuntimeOptions = {
  role: WorkerRole;
  asset: MarketAsset | null;
  startupJitterMs: number;
  arbiterWindowMs: number;
};

export function parseWorkerRuntimeOptions(
  argv = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): WorkerRuntimeOptions {
  const role = parseWorkerRole(readOption(argv, "role") ?? env.WARBITRER_WORKER_ROLE ?? "legacy");
  const asset = parseWorkerAsset(readOption(argv, "asset") ?? env.WARBITRER_WORKER_ASSET ?? null);
  if (role === "asset-live" && !asset) {
    throw new Error("WARBITRER_WORKER_ASSET ou --asset est requis pour le role asset-live");
  }

  return {
    role,
    asset,
    startupJitterMs: resolveStartupJitterMs(asset, env.WARBITRER_ASSET_STARTUP_JITTER_MS),
    arbiterWindowMs: resolveArbiterWindowMs(env.WARBITRER_EXECUTION_ARBITER_WINDOW_MS),
  };
}

export function resolveStartupJitterMs(asset: MarketAsset | null, raw: string | undefined) {
  if (!asset) {
    return 0;
  }

  if (!raw || raw === "auto") {
    return Math.max(0, ACTIVE_MARKET_ASSETS.indexOf(asset)) * 250;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

export function resolveArbiterWindowMs(raw: string | undefined) {
  if (!raw) {
    return 25;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(250, Math.floor(parsed))) : 25;
}

function parseWorkerRole(value: string): WorkerRole {
  if (value === "asset-live" || value === "reconciler" || value === "notifier" || value === "legacy") {
    return value;
  }

  throw new Error(`Worker role invalide: ${value}`);
}

function parseWorkerAsset(value: string | null): MarketAsset | null {
  if (value === null || value === "") {
    return null;
  }

  if (ACTIVE_MARKET_ASSETS.includes(value as MarketAsset)) {
    return value as MarketAsset;
  }

  throw new Error(`Worker asset invalide: ${value}`);
}

function readOption(argv: string[], name: string) {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] ?? null : null;
}
