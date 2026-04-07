import { normalizeSettings } from "@/lib/settings-schema";

describe("settings schema", () => {
  it("applies execution defaults for confirmation timeout and price buffer", () => {
    const settings = normalizeSettings(null);

    expect(settings.immediateOrderConfirmationTimeoutMs).toBe(8000);
    expect(settings.executionPriceBuffer).toBe(0.01);
    expect(settings.hedgeRetryAttempts).toBe(3);
    expect(settings.hedgeRetryDelayMs).toBe(350);
  });

  it("accepts explicit execution buffer overrides", () => {
    const settings = normalizeSettings({
      enableTrading: true,
      shadowMode: false,
      maxPairNotionalUsd: 50,
      grossEntryThreshold: 0.93,
      maxLegPrice: 0.49,
      reentryImprovement: 0.01,
      pollingIntervalMs: 500,
      minOrderSize: 5,
      maxSlippageBps: 30,
      immediateOrderConfirmationTimeoutMs: 12000,
      executionPriceBuffer: 0.02,
      hedgeRetryAttempts: 5,
      hedgeRetryDelayMs: 500,
      entryCutoffSeconds: 20,
      maxOpenIntentsPerSlot: 1,
      maxVenueExposureUsd: 1000,
      polyBridgeLowWaterUsdc: 250,
    });

    expect(settings.immediateOrderConfirmationTimeoutMs).toBe(12000);
    expect(settings.executionPriceBuffer).toBe(0.02);
    expect(settings.hedgeRetryAttempts).toBe(5);
    expect(settings.hedgeRetryDelayMs).toBe(500);
  });
});
