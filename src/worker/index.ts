import { processTick } from "@/lib/engine";
import { DEFAULT_SETTINGS } from "@/lib/constants";
import { readSettings, storageMode } from "@/lib/storage";

async function run() {
  console.log(`[worker] storage=${storageMode()}`);

  while (true) {
    const startedAt = Date.now();
    try {
      await processTick();
      console.log(`[worker] tick ok ${new Date(startedAt).toISOString()}`);
    } catch (error) {
      console.error("[worker] tick error", error);
    }

    const elapsed = Date.now() - startedAt;
    const pollingIntervalMs = await readPollingIntervalMs();
    const waitMs = Math.max(50, pollingIntervalMs - elapsed);
    await sleep(waitMs);
  }
}

run().catch((error) => {
  console.error("[worker] fatal", error);
  process.exitCode = 1;
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readPollingIntervalMs() {
  try {
    const settings = await readSettings();
    return settings.pollingIntervalMs;
  } catch (error) {
    console.error("[worker] settings read failed, using default polling interval", error);
    return DEFAULT_SETTINGS.pollingIntervalMs;
  }
}
