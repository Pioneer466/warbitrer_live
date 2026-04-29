import {
  processAssetExecutionTick,
  processAssetScanTick,
  processExecutionTick,
  processReconcileTick,
  processScanTick,
} from "@/lib/engine";
import { ACTIVE_MARKET_ASSETS } from "@/lib/market-catalog";
import { schedulePendingNotificationFlush } from "@/lib/notifications";
import { storageMode } from "@/lib/storage";
import type { MarketAsset } from "@/lib/types";
import { parseWorkerRuntimeOptions } from "@/worker/runtime";

const SCAN_TICK_TIMEOUT_MS = 15_000;
const EXECUTION_TICK_TIMEOUT_MS = 90_000;
const RECONCILE_TICK_TIMEOUT_MS = 120_000;
const NOTIFICATION_FLUSH_INTERVAL_MS = 1_000;
const SCAN_INTERVAL_MS = 250;
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
      `[worker] asset-live started: asset=${asset} scan=${SCAN_INTERVAL_MS}ms snapshots=${SNAPSHOT_PERSIST_INTERVAL_MS}ms executor=${EXECUTION_INTERVAL_MS}ms`,
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
    `[worker] legacy realtime loops enabled: assets=${ACTIVE_MARKET_ASSETS.join(",")} scan=${SCAN_INTERVAL_MS}ms snapshots=${SNAPSHOT_PERSIST_INTERVAL_MS}ms executor=${EXECUTION_INTERVAL_MS}ms reconcile=${RECONCILE_INTERVAL_MS}ms`,
  );
  await Promise.all([runScanLoop(), runExecutionLoop(), runReconcileLoop(), runNotificationFlushLoop()]);
}

run().catch(async (error) => {
  console.error("[worker] fatal", error);
  await sleep(WORKER_FATAL_EXIT_DELAY_MS);
  process.exit(1);
});

async function runScanLoop(asset?: MarketAsset) {
  await runLoop({
    name: asset ? `scan:${asset}` : "scan",
    timeoutMs: SCAN_TICK_TIMEOUT_MS,
    resolveIntervalMs: async () => SCAN_INTERVAL_MS,
    tick: async () => {
      if (asset) {
        await processAssetScanTick(asset);
      } else {
        await processScanTick();
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

class WorkerLoopTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerLoopTimeoutError";
  }
}
