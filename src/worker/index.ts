import { processTick } from "@/lib/engine";
import { DEFAULT_STRATEGY_CONFIG } from "@/lib/constants";
import { MARKET_ASSETS } from "@/lib/market-catalog";
import { schedulePendingNotificationFlush } from "@/lib/notifications";
import { readSettingsMap, storageMode } from "@/lib/storage";

const WORKER_TICK_TIMEOUT_MS = 90_000;
const WORKER_FATAL_EXIT_DELAY_MS = 5_000;

async function run() {
  console.log(`[worker] storage=${storageMode()}`);

  while (true) {
    const startedAt = Date.now();
    try {
      await processTickWithWatchdog();
    } catch (error) {
      console.error("[worker] tick error", error);
      if (error instanceof WorkerTickTimeoutError) {
        throw error;
      }
    }

    schedulePendingNotificationFlush();

    const elapsed = Date.now() - startedAt;
    const pollingIntervalMs = await readPollingIntervalMs();
    const waitMs = Math.max(50, pollingIntervalMs - elapsed);
    await sleep(waitMs);
  }
}

run().catch(async (error) => {
  console.error("[worker] fatal", error);
  await sleep(WORKER_FATAL_EXIT_DELAY_MS);
  process.exit(1);
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readPollingIntervalMs() {
  try {
    const settings = await readSettingsMap();
    return Math.min(...MARKET_ASSETS.map((asset) => settings[asset].pollingIntervalMs));
  } catch (error) {
    console.error("[worker] settings read failed, using default live polling interval", error);
    return DEFAULT_STRATEGY_CONFIG.pollingIntervalMs;
  }
}

async function processTickWithWatchdog() {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new WorkerTickTimeoutError(`processTick timed out after ${WORKER_TICK_TIMEOUT_MS}ms`));
    }, WORKER_TICK_TIMEOUT_MS);
  });

  return Promise.race([processTick(), timeoutPromise]).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });
}

class WorkerTickTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerTickTimeoutError";
  }
}
