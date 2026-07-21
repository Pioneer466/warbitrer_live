import {
  processAssetExecutionTick,
  processAssetScanTick,
  processExecutionTick,
  processReconcileTick,
  processScanTick,
} from "@/lib/engine";
import { isTruthyEnv, readEnv } from "@/lib/env";
import {
  CIRCUIT_BREAKER_INCIDENT_OWNERS,
  createPolygonRpcIncident,
  type PolygonRpcFailureKind,
} from "@/lib/circuit-breaker-incidents";
import { shutdownMarketDataSupervisor } from "@/lib/market-data";
import { ACTIVE_MARKET_ASSETS } from "@/lib/market-catalog";
import { schedulePendingNotificationFlush, waitForPendingNotificationFlush } from "@/lib/notifications";
import { checkPolygonRpcEndpoint } from "@/lib/polygon-rpc-health";
import {
  closeStorage,
  readCurrentCircuitBreakerIncidents,
  resolveCircuitBreakerIncident,
  storageMode,
  writeCircuitBreakerIncident,
} from "@/lib/storage";
import type { MarketAsset } from "@/lib/types";
import {
  COLD_SCAN_INTERVAL_MS,
  deriveNextScanIntervalMs,
  HOT_SCAN_INTERVAL_MS,
  HOT_SIGNAL_TTL_MS,
  isHotOpportunitySnapshot,
} from "@/worker/hot-cold";
import { parseWorkerRuntimeOptions } from "@/worker/runtime";
import {
  runCoordinatedWorkerTasks,
  runWatchdogBoundTask,
  shutdownWorkerResources,
  WorkerShutdownCoordinator,
  WorkerTaskTimeoutError,
} from "@/worker/shutdown";

const SCAN_TICK_TIMEOUT_MS = 15_000;
const EXECUTION_TICK_TIMEOUT_MS = 90_000;
const RECONCILE_TICK_TIMEOUT_MS = 120_000;
const NOTIFICATION_FLUSH_INTERVAL_MS = 1_000;
const SNAPSHOT_PERSIST_INTERVAL_MS = 1_000;
const EXECUTION_IDLE_INTERVAL_MS = readPositiveIntEnv("WARBITRER_EXECUTION_IDLE_INTERVAL_MS", 1_000, 100, 10_000);
const RECONCILE_INTERVAL_MS = 3_000;
const MIN_LOOP_SLEEP_MS = 10;

const shutdownCoordinator = new WorkerShutdownCoordinator();
let wakeExecutionLoop: (() => void) | null = null;

async function run() {
  const runtime = parseWorkerRuntimeOptions();
  console.log(`[worker] storage=${storageMode()}`);
  console.log(`[worker] role=${runtime.role} asset=${runtime.asset ?? "all"} arbiter=${runtime.arbiterWindowMs}ms`);

  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);

  if (runtime.role === "reconciler" || runtime.role === "legacy") {
    await checkPolygonRpcHealth();
  }

  if (runtime.startupJitterMs > 0) {
    console.log(`[worker] startup jitter ${runtime.startupJitterMs}ms`);
    await shutdownCoordinator.wait(runtime.startupJitterMs);
  }
  if (shutdownCoordinator.isRequested) {
    return;
  }

  if (runtime.role === "asset-live") {
    const asset = runtime.asset;
    if (!asset) {
      throw new Error("asset-live requires an asset");
    }
    console.log(
      `[worker] asset-live started: asset=${asset} scan=${COLD_SCAN_INTERVAL_MS}/${HOT_SCAN_INTERVAL_MS}ms hotTtl=${HOT_SIGNAL_TTL_MS}ms snapshots=${SNAPSHOT_PERSIST_INTERVAL_MS}ms executorIdle=${EXECUTION_IDLE_INTERVAL_MS}ms`,
    );
    await runCoordinatedWorkerTasks([() => runScanLoop(asset), () => runExecutionLoop(asset)], requestLoopShutdown);
    return;
  }

  if (runtime.role === "reconciler") {
    console.log(`[worker] reconciler started: interval=${RECONCILE_INTERVAL_MS}ms`);
    await runReconcileLoop();
    return;
  }

  if (runtime.role === "notifier") {
    console.log(`[worker] notifier started: interval=${NOTIFICATION_FLUSH_INTERVAL_MS}ms`);
    await runNotificationFlushLoop();
    return;
  }

  console.log(
    `[worker] legacy realtime loops enabled: assets=${ACTIVE_MARKET_ASSETS.join(",")} scan=${COLD_SCAN_INTERVAL_MS}/${HOT_SCAN_INTERVAL_MS}ms hotTtl=${HOT_SIGNAL_TTL_MS}ms snapshots=${SNAPSHOT_PERSIST_INTERVAL_MS}ms executorIdle=${EXECUTION_IDLE_INTERVAL_MS}ms reconcile=${RECONCILE_INTERVAL_MS}ms`,
  );
  await runCoordinatedWorkerTasks(
    [runScanLoop, runExecutionLoop, runReconcileLoop, runNotificationFlushLoop],
    requestLoopShutdown,
  );
}

void runWorkerProcess();

async function runWorkerProcess() {
  let failed = false;
  try {
    await run();
  } catch (error) {
    requestLoopShutdown();
    failed = true;
    console.error("[worker] fatal", error);
  }

  try {
    await shutdownWorkerResources({
      closeMarketData: shutdownMarketDataSupervisor,
      waitForNotifications: waitForPendingNotificationFlush,
      closeStorage,
    });
    console.log("[worker] shutdown complete");
  } catch (error) {
    failed = true;
    console.error("[worker] shutdown failed", error);
  } finally {
    process.removeListener("SIGTERM", requestShutdown);
    process.removeListener("SIGINT", requestShutdown);
  }

  if (failed) {
    process.exit(1);
  }
}

async function runScanLoop(asset?: MarketAsset) {
  let hotUntil = 0;
  await runLoop({
    name: asset ? `scan:${asset}` : "scan",
    timeoutMs: SCAN_TICK_TIMEOUT_MS,
    resolveIntervalMs: async () => deriveNextScanIntervalMs(Date.now(), hotUntil),
    tick: async () => {
      const now = Date.now();
      if (asset) {
        const snapshot = await processAssetScanTick(asset);
        if (isHotOpportunitySnapshot(snapshot)) {
          hotUntil = now + HOT_SIGNAL_TTL_MS;
        }
      } else {
        const snapshots = await processScanTick();
        if (snapshots.some(isHotOpportunitySnapshot)) {
          hotUntil = now + HOT_SIGNAL_TTL_MS;
        }
      }
      wakeExecutor();
    },
  });
}

async function runExecutionLoop(asset?: MarketAsset) {
  while (!shutdownCoordinator.isRequested) {
    const startedAt = Date.now();
    try {
      await runWithWatchdog(asset ? `executor:${asset}` : "executor", EXECUTION_TICK_TIMEOUT_MS, () =>
        asset ? processAssetExecutionTick(asset) : processExecutionTick(),
      );
    } catch (error) {
      console.error("[worker] executor error", error);
      if (error instanceof WorkerTaskTimeoutError) {
        throw error;
      }
    }

    if (shutdownCoordinator.isRequested) {
      break;
    }

    const elapsed = Date.now() - startedAt;
    const waitMs = Math.max(MIN_LOOP_SLEEP_MS, EXECUTION_IDLE_INTERVAL_MS - elapsed);
    await sleepUntilExecutionWake(waitMs);
  }
}

async function runReconcileLoop() {
  await runLoop({
    name: "reconcile",
    timeoutMs: RECONCILE_TICK_TIMEOUT_MS,
    resolveIntervalMs: async () => RECONCILE_INTERVAL_MS,
    tick: processReconcileTick,
  });
}

async function runNotificationFlushLoop() {
  await runLoop({
    name: "notification_flush",
    timeoutMs: 5_000,
    resolveIntervalMs: async () => NOTIFICATION_FLUSH_INTERVAL_MS,
    tick: async () => {
      schedulePendingNotificationFlush();
    },
  });
}

async function runLoop({
  name,
  timeoutMs,
  resolveIntervalMs,
  tick,
}: {
  name: string;
  timeoutMs: number;
  resolveIntervalMs: () => Promise<number>;
  tick: () => Promise<void> | void;
}) {
  while (!shutdownCoordinator.isRequested) {
    const startedAt = Date.now();
    try {
      await runWithWatchdog(name, timeoutMs, tick);
    } catch (error) {
      console.error(`[worker] ${name} error`, error);
      if (error instanceof WorkerTaskTimeoutError) {
        throw error;
      }
    }

    if (shutdownCoordinator.isRequested) {
      break;
    }

    const elapsed = Date.now() - startedAt;
    const intervalMs = await resolveIntervalMs();
    const waitMs = Math.max(MIN_LOOP_SLEEP_MS, intervalMs - elapsed);
    await shutdownCoordinator.wait(waitMs);
  }
}

async function runWithWatchdog<T>(name: string, timeoutMs: number, task: () => Promise<T> | T) {
  return runWatchdogBoundTask({
    name,
    timeoutMs,
    task,
    onTimeout: (error) => {
      console.error(`[worker] ${name} watchdog expired`, error);
      requestLoopShutdown();
    },
  });
}

function requestShutdown(signal: NodeJS.Signals) {
  if (!requestLoopShutdown()) {
    return;
  }

  console.log(`[worker] shutdown requested by ${signal}`);
}

function requestLoopShutdown() {
  const requested = shutdownCoordinator.request();
  wakeExecutor();
  return requested;
}

function wakeExecutor() {
  const wake = wakeExecutionLoop;
  wakeExecutionLoop = null;
  wake?.();
}

function sleepUntilExecutionWake(ms: number) {
  return new Promise<void>((resolve) => {
    const timeoutHandle = setTimeout(done, ms);

    wakeExecutionLoop = done;

    function done() {
      if (wakeExecutionLoop === done) {
        wakeExecutionLoop = null;
      }
      clearTimeout(timeoutHandle);
      resolve();
    }
  });
}

function readPositiveIntEnv(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

async function checkPolygonRpcHealth() {
  const env = readEnv();
  const autoConvertEnabled = isTruthyEnv(env.POLY_AUTO_CONVERT);
  const liveExecutionEnabled = isTruthyEnv(env.LIVE_EXECUTION_ALLOWED);
  const rpcRequired = autoConvertEnabled || liveExecutionEnabled;
  const health = await checkPolygonRpcEndpoint(env.POLYGON_RPC_URL);
  if (!health.ok) {
    if (rpcRequired) {
      await writeRpcUnhealthyBreaker(health.failureKind, health.detail);
    } else {
      console.warn(`[worker] Polygon RPC health check degraded while live execution is disabled: ${health.detail}`);
    }
    return;
  }

  await resolveRecoveredPolygonRpcBreakers();
  console.log(`[worker] Polygon RPC ready: chain=${health.chainId} block=${health.blockNumber}`);
}

async function writeRpcUnhealthyBreaker(failureKind: PolygonRpcFailureKind, detail: string) {
  const triggeredAt = Date.now();
  const incident = createPolygonRpcIncident({
    triggeredAt,
    failureKind,
    detail: detail.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1_024) || "unknown RPC failure",
  });
  await writeCircuitBreakerIncident({
    incident,
    actor: CIRCUIT_BREAKER_INCIDENT_OWNERS.polygonRpc,
    requestId: `observe:${incident.id}`,
  });
}

async function resolveRecoveredPolygonRpcBreakers() {
  const incidents = await readCurrentCircuitBreakerIncidents();
  const ownedRpcIncidents = incidents.filter(
    (incident) =>
      incident.owner === CIRCUIT_BREAKER_INCIDENT_OWNERS.polygonRpc &&
      incident.incidentKey === "rpc-unhealthy" &&
      incident.resolutionPolicy === "owner",
  );
  for (const incident of ownedRpcIncidents) {
    await resolveCircuitBreakerIncident({
      incidentId: incident.id,
      expectedRevision: incident.revision,
      owner: CIRCUIT_BREAKER_INCIDENT_OWNERS.polygonRpc,
      actor: CIRCUIT_BREAKER_INCIDENT_OWNERS.polygonRpc,
      requestId: `rpc-recovered:${incident.id}:${incident.revision}`,
      conditionRecovered: true,
    });
  }
}
