import {
  processAssetExecutionTick,
  processAssetScanTick,
  processExecutionTick,
  processReconcileTick,
  processScanTick,
} from "@/lib/engine";
import { isTruthyEnv, readEnv } from "@/lib/env";
import { ACTIVE_MARKET_ASSETS } from "@/lib/market-catalog";
import { schedulePendingNotificationFlush } from "@/lib/notifications";
import { storageMode, writeCircuitBreaker } from "@/lib/storage";
import type { MarketAsset } from "@/lib/types";
import {
  COLD_SCAN_INTERVAL_MS,
  deriveNextScanIntervalMs,
  HOT_SCAN_INTERVAL_MS,
  HOT_SIGNAL_TTL_MS,
  isHotOpportunitySnapshot,
} from "@/worker/hot-cold";
import { parseWorkerRuntimeOptions } from "@/worker/runtime";

const SCAN_TICK_TIMEOUT_MS = 15_000;
const EXECUTION_TICK_TIMEOUT_MS = 90_000;
const RECONCILE_TICK_TIMEOUT_MS = 120_000;
const NOTIFICATION_FLUSH_INTERVAL_MS = 1_000;
const SNAPSHOT_PERSIST_INTERVAL_MS = 1_000;
const EXECUTION_INTERVAL_MS = 100;
const RECONCILE_INTERVAL_MS = 3_000;
const WORKER_FATAL_EXIT_DELAY_MS = 5_000;
const MIN_LOOP_SLEEP_MS = 10;

let shutdownRequested = false;
let wakeExecutionLoop: (() => void) | null = null;

async function run() {
  const runtime = parseWorkerRuntimeOptions();
  console.log(`[worker] storage=${storageMode()}`);
  console.log(
    `[worker] role=${runtime.role} asset=${runtime.asset ?? "all"} arbiter=${runtime.arbiterWindowMs}ms`,
  );

  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);

  await checkPolygonRpcHealth();

  if (runtime.startupJitterMs > 0) {
    console.log(`[worker] startup jitter ${runtime.startupJitterMs}ms`);
    await sleep(runtime.startupJitterMs);
  }

  if (runtime.role === "asset-live") {
    const asset = runtime.asset;
    if (!asset) {
      throw new Error("asset-live requires an asset");
    }
    console.log(
      `[worker] asset-live started: asset=${asset} scan=${COLD_SCAN_INTERVAL_MS}/${HOT_SCAN_INTERVAL_MS}ms snapshots=${SNAPSHOT_PERSIST_INTERVAL_MS}ms executor=${EXECUTION_INTERVAL_MS}ms`,
    );
    await Promise.all([runScanLoop(asset), runExecutionLoop(asset)]);
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
    `[worker] legacy realtime loops enabled: assets=${ACTIVE_MARKET_ASSETS.join(",")} scan=${COLD_SCAN_INTERVAL_MS}/${HOT_SCAN_INTERVAL_MS}ms snapshots=${SNAPSHOT_PERSIST_INTERVAL_MS}ms executor=${EXECUTION_INTERVAL_MS}ms reconcile=${RECONCILE_INTERVAL_MS}ms`,
  );
  await Promise.all([runScanLoop(), runExecutionLoop(), runReconcileLoop(), runNotificationFlushLoop()]);
}

run().catch(async (error) => {
  console.error("[worker] fatal", error);
  await sleep(WORKER_FATAL_EXIT_DELAY_MS);
  process.exit(1);
});

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
  while (!shutdownRequested) {
    const startedAt = Date.now();
    try {
      await runWithWatchdog(asset ? `executor:${asset}` : "executor", EXECUTION_TICK_TIMEOUT_MS, () =>
        asset ? processAssetExecutionTick(asset) : processExecutionTick(),
      );
    } catch (error) {
      console.error("[worker] executor error", error);
      if (error instanceof WorkerLoopTimeoutError) {
        throw error;
      }
    }

    if (shutdownRequested) {
      break;
    }

    const elapsed = Date.now() - startedAt;
    const waitMs = Math.max(MIN_LOOP_SLEEP_MS, EXECUTION_INTERVAL_MS - elapsed);
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
  while (!shutdownRequested) {
    const startedAt = Date.now();
    try {
      await runWithWatchdog(name, timeoutMs, tick);
    } catch (error) {
      console.error(`[worker] ${name} error`, error);
      if (error instanceof WorkerLoopTimeoutError) {
        throw error;
      }
    }

    if (shutdownRequested) {
      break;
    }

    const elapsed = Date.now() - startedAt;
    const intervalMs = await resolveIntervalMs();
    const waitMs = Math.max(MIN_LOOP_SLEEP_MS, intervalMs - elapsed);
    await sleep(waitMs);
  }
}

async function runWithWatchdog<T>(name: string, timeoutMs: number, task: () => Promise<T> | T) {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new WorkerLoopTimeoutError(`${name} loop timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([Promise.resolve().then(task), timeoutPromise]).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });
}

function requestShutdown(signal: NodeJS.Signals) {
  if (shutdownRequested) {
    return;
  }

  shutdownRequested = true;
  wakeExecutor();
  console.log(`[worker] shutdown requested by ${signal}`);
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkPolygonRpcHealth() {
  const env = readEnv();
  const autoConvertEnabled = isTruthyEnv(env.POLY_AUTO_CONVERT);
  if (!env.POLYGON_RPC_URL) {
    if (autoConvertEnabled) {
      await writeRpcUnhealthyBreaker("POLYGON_RPC_URL missing while POLY_AUTO_CONVERT=true");
    } else {
      console.warn("[worker] POLYGON_RPC_URL missing; Polymarket auto-convert RPC health check skipped");
    }
    return;
  }

  try {
    const response = await fetch(env.POLYGON_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_blockNumber",
        params: [],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json() as { result?: unknown; error?: unknown };
    if (typeof payload.result !== "string") {
      throw new Error(payload.error ? JSON.stringify(payload.error) : "missing eth_blockNumber result");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (autoConvertEnabled) {
      await writeRpcUnhealthyBreaker(message);
    } else {
      console.warn(`[worker] POLYGON_RPC_URL health check failed: ${message}`);
    }
  }
}

async function writeRpcUnhealthyBreaker(reason: string) {
  await writeCircuitBreaker({
    key: "global",
    active: true,
    reason: "rpc_unhealthy",
    triggeredAt: Date.now(),
    payload: {
      reason,
      checkedAt: Date.now(),
      requiresManualClear: true,
    },
  });
}

class WorkerLoopTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerLoopTimeoutError";
  }
}
