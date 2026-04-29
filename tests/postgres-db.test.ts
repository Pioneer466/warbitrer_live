import { buildBootstrapStrategyConfigs } from "@/lib/postgres-db";
import { normalizeSettings } from "@/lib/settings-schema";

describe("postgres bootstrap strategy configs", () => {
  it("clones ETH strategy parameters into shadow assets while forcing shadow mode", () => {
    const legacy = normalizeSettings({
      enableTrading: false,
      shadowMode: true,
      maxPairNotionalUsd: 50,
      maxSignalAgeMs: 1000,
      grossEntryThreshold: 0.93,
      maxLegPrice: 0.49,
      reentryImprovement: 0.01,
      pollingIntervalMs: 1000,
      minOrderSize: 5,
      maxSlippageBps: 30,
      immediateOrderConfirmationTimeoutMs: 8000,
      executionPriceBuffer: 0.01,
      hedgeRetryAttempts: 3,
      hedgeRetryDelayMs: 350,
      entryCutoffSeconds: 180,
      maxOpenIntentsPerSlot: 1,
      maxVenueExposureUsd: 1000,
      polyBridgeLowWaterUsdc: 250,
    });

    const configs = buildBootstrapStrategyConfigs(legacy, {
      enableTrading: false,
      shadowMode: false,
      maxPairNotionalUsd: 275,
      maxSignalAgeMs: 750,
      grossEntryThreshold: 0.88,
      maxLegPrice: 0.44,
      reentryImprovement: 0.02,
      pollingIntervalMs: 750,
      minOrderSize: 12,
      maxSlippageBps: 45,
      immediateOrderConfirmationTimeoutMs: 12000,
      executionPriceBuffer: 0.03,
      hedgeRetryAttempts: 4,
      hedgeRetryDelayMs: 600,
      entryCutoffSeconds: 120,
      maxOpenIntentsPerSlot: 2,
      maxVenueExposureUsd: 2500,
      polyBridgeLowWaterUsdc: 600,
    });

    expect(configs.eth.maxPairNotionalUsd).toBe(275);
    expect(configs.sol.maxPairNotionalUsd).toBe(275);
    expect(configs.xrp.maxPairNotionalUsd).toBe(275);
    expect(configs.doge.maxPairNotionalUsd).toBe(275);
    expect(configs.bnb.maxPairNotionalUsd).toBe(275);
    expect(configs.hype.maxPairNotionalUsd).toBe(275);
    expect(configs.eth.maxSignalAgeMs).toBe(750);
    expect(configs.sol.maxSignalAgeMs).toBe(750);
    expect(configs.sol.enableTrading).toBe(true);
    expect(configs.sol.shadowMode).toBe(true);
    expect(configs.xrp.enableTrading).toBe(true);
    expect(configs.xrp.shadowMode).toBe(true);
    expect(configs.doge.enableTrading).toBe(true);
    expect(configs.doge.shadowMode).toBe(true);
    expect(configs.bnb.enableTrading).toBe(true);
    expect(configs.bnb.shadowMode).toBe(true);
    expect(configs.hype.enableTrading).toBe(true);
    expect(configs.hype.shadowMode).toBe(true);
  });
});
