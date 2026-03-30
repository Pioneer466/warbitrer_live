import { processTick } from "@/lib/engine";
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

    const settings = await readSettings();
    const elapsed = Date.now() - startedAt;
    const waitMs = Math.max(50, settings.pollingIntervalMs - elapsed);
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
