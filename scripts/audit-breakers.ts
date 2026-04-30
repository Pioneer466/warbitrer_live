import fs from "node:fs";

import { isMarketAsset } from "@/lib/market-catalog";
import { readCircuitBreakers, readOpenOrderIntents, readWorkerStates } from "@/lib/storage";
import type { CircuitBreakerKey, OrderIntent } from "@/lib/types";

const DEFAULT_ENV_PATH = process.env.WARBITRER_ENV_PATH || "/etc/warbitrer/warbitrer.env";

async function main() {
  loadRuntimeEnv();

  const json = process.argv.includes("--json");
  const [breakers, openIntents, workerStates] = await Promise.all([
    readCircuitBreakers(),
    readOpenOrderIntents(),
    readWorkerStates(),
  ]);
  const workerStateList = Object.values(workerStates);
  const now = Date.now();
  const detailed = breakers.map((breaker) => {
    const scope = parseBreakerScope(breaker.key);
    const cooldownUntil = getPayloadNumber(breaker.payload, "cooldownUntil");
    const unresolvedIntentIds = openIntents
      .filter((intent) => matchesBreakerScope(scope, intent))
      .map((intent) => intent.id);

    return {
      key: breaker.key,
      active: breaker.active,
      reason: breaker.reason,
      triggeredAt: breaker.triggeredAt,
      scope,
      requiresManualClear: getPayloadBoolean(breaker.payload, "requiresManualClear"),
      cooldownUntil,
      cooldownRemainingMs: cooldownUntil === null ? null : Math.max(0, cooldownUntil - now),
      unresolvedIntentIds,
      workerStates: workerStateList
        .filter((state) => scope.type === "global" || state.asset === scope.asset)
        .map((state) => ({
          asset: state.asset,
          phase: state.phase,
          readinessStatus: state.readinessStatus,
          currentSlotKey: state.currentSlotKey,
          lastError: state.lastError,
        })),
      payload: breaker.payload,
    };
  });

  if (json) {
    console.log(JSON.stringify({ fetchedAt: now, active: detailed.filter((item) => item.active), breakers: detailed }, null, 2));
    return;
  }

  const active = detailed.filter((item) => item.active);
  console.log(`Breakers actifs: ${active.length}/${detailed.length}`);
  for (const breaker of active) {
    const cooldown = breaker.cooldownUntil === null
      ? "aucun cooldown"
      : `cooldown ${new Date(breaker.cooldownUntil).toISOString()} (${Math.ceil((breaker.cooldownRemainingMs ?? 0) / 1000)}s)`;
    const manual = breaker.requiresManualClear ? "manual-clear requis" : "clear auto possible";
    const unresolved = breaker.unresolvedIntentIds.length > 0
      ? `intents ouverts: ${breaker.unresolvedIntentIds.join(", ")}`
      : "aucun intent ouvert";
    console.log(`- ${breaker.key} · ${breaker.reason ?? "sans raison"} · ${manual} · ${cooldown} · ${unresolved}`);
  }
  if (active.length === 0) {
    console.log("Aucun breaker actif.");
  }
}

function parseBreakerScope(key: CircuitBreakerKey) {
  if (key === "global") {
    return { type: "global" as const, asset: null, slotKey: null };
  }

  if (key.startsWith("asset:")) {
    const asset = key.slice("asset:".length);
    return { type: "asset" as const, asset: isMarketAsset(asset) ? asset : null, slotKey: null };
  }

  const [, asset, ...slotParts] = key.split(":");
  return {
    type: "slot" as const,
    asset: asset && isMarketAsset(asset) ? asset : null,
    slotKey: slotParts.join(":") || null,
  };
}

function matchesBreakerScope(scope: ReturnType<typeof parseBreakerScope>, intent: Pick<OrderIntent, "asset" | "slotKey">) {
  if (scope.type === "global") {
    return true;
  }
  if (scope.asset !== null && intent.asset !== scope.asset) {
    return false;
  }
  return scope.type !== "slot" || scope.slotKey === null || intent.slotKey === scope.slotKey;
}

function getPayloadBoolean(payload: Record<string, unknown> | null, key: string) {
  return payload?.[key] === true;
}

function getPayloadNumber(payload: Record<string, unknown> | null, key: string) {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function loadRuntimeEnv() {
  if (!fs.existsSync(DEFAULT_ENV_PATH)) {
    return;
  }

  for (const [key, value] of Object.entries(loadEnvFile(DEFAULT_ENV_PATH))) {
    process.env[key] = process.env[key] ?? value;
  }
}

function loadEnvFile(path: string) {
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
  const env: Record<string, string> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  return env;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
