import { readFileSync } from "node:fs";

describe("VPS worker shutdown budgets", () => {
  it.each([
    ["warbitrer-asset@.service", 150],
    ["warbitrer-reconciler.service", 180],
    ["warbitrer-notifier.service", 75],
  ])("allows %s to finish its watchdog-bound tick and cleanup", (fileName, expectedSeconds) => {
    const source = readFileSync(new URL(`../deploy/vps/${fileName}`, import.meta.url), "utf8");
    expect(source).toContain(`TimeoutStopSec=${expectedSeconds}`);
    expect(source).toContain("KillSignal=SIGTERM");
    expect(source).toContain("KillMode=control-group");
  });
});
