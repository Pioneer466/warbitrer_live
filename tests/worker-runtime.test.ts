import { parseWorkerRuntimeOptions, resolveArbiterWindowMs, resolveStartupJitterMs } from "@/worker/runtime";

describe("worker runtime options", () => {
  it("parses an asset-live worker from CLI options", () => {
    const runtime = parseWorkerRuntimeOptions(["--role", "asset-live", "--asset", "eth"], {});

    expect(runtime.role).toBe("asset-live");
    expect(runtime.asset).toBe("eth");
    expect(runtime.startupJitterMs).toBe(250);
    expect(runtime.arbiterWindowMs).toBe(25);
  });

  it("parses role and asset from env", () => {
    const runtime = parseWorkerRuntimeOptions([], {
      WARBITRER_WORKER_ROLE: "asset-live",
      WARBITRER_WORKER_ASSET: "xrp",
      WARBITRER_EXECUTION_ARBITER_WINDOW_MS: "40",
      WARBITRER_ASSET_STARTUP_JITTER_MS: "125",
    });

    expect(runtime.role).toBe("asset-live");
    expect(runtime.asset).toBe("xrp");
    expect(runtime.startupJitterMs).toBe(125);
    expect(runtime.arbiterWindowMs).toBe(40);
  });

  it("rejects asset-live without an asset", () => {
    expect(() => parseWorkerRuntimeOptions(["--role", "asset-live"], {})).toThrow(/asset-live/);
  });

  it("clamps arbiter window and derives automatic startup jitter", () => {
    expect(resolveArbiterWindowMs("1000")).toBe(250);
    expect(resolveArbiterWindowMs("bad")).toBe(25);
    expect(resolveStartupJitterMs("doge", "auto")).toBe(1_000);
  });
});
