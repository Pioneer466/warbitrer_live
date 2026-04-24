import { normalizeSettings, normalizeSettingsMap } from "@/lib/settings-schema";

describe("settings schema", () => {
  it("applies execution defaults for confirmation timeout and price buffer", () => {
    const settings = normalizeSettings(null);

    expect(settings.immediateOrderConfirmationTimeoutMs).toBe(8000);
    expect(settings.executionPriceBuffer).toBe(0.01);
    expect(settings.kalshiDepthHeadroomContracts).toBe(2);
    expect(settings.kalshiPrimaryPriceTicksSlippage).toBe(2);
    expect(settings.kalshiPrimaryMaxClipContracts).toBe(10);
    expect(settings.kalshiPrimaryMaxClips).toBe(4);
    expect(settings.primaryRetryAttempts).toBe(2);
    expect(settings.primaryRetryDelayMs).toBe(200);
    expect(settings.hedgeRetryAttempts).toBe(3);
    expect(settings.hedgeRetryDelayMs).toBe(350);
    expect(settings.entryCutoffSeconds).toBe(180);
    expect(settings.mismatchGuardEnabled).toBe(true);
    expect(settings.mismatchGuardMinMoveBps).toBe(5);
    expect(settings.mismatchGuardPhase2StartSeconds).toBe(480);
    expect(settings.mismatchGuardPhase2MinMoveBps).toBe(10);
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
      kalshiDepthHeadroomContracts: 3,
      kalshiPrimaryPriceTicksSlippage: 3,
      kalshiPrimaryMaxClipContracts: 8,
      kalshiPrimaryMaxClips: 3,
      primaryRetryAttempts: 4,
      primaryRetryDelayMs: 250,
      hedgeRetryAttempts: 5,
      hedgeRetryDelayMs: 500,
      entryCutoffSeconds: 20,
      maxOpenIntentsPerSlot: 1,
      maxVenueExposureUsd: 1000,
      polyBridgeLowWaterUsdc: 250,
    });

    expect(settings.immediateOrderConfirmationTimeoutMs).toBe(12000);
    expect(settings.executionPriceBuffer).toBe(0.02);
    expect(settings.kalshiDepthHeadroomContracts).toBe(3);
    expect(settings.kalshiPrimaryPriceTicksSlippage).toBe(3);
    expect(settings.kalshiPrimaryMaxClipContracts).toBe(8);
    expect(settings.kalshiPrimaryMaxClips).toBe(3);
    expect(settings.primaryRetryAttempts).toBe(4);
    expect(settings.primaryRetryDelayMs).toBe(250);
    expect(settings.hedgeRetryAttempts).toBe(5);
    expect(settings.hedgeRetryDelayMs).toBe(500);
  });

  it("accepts a 3 minute entry cutoff", () => {
    const settings = normalizeSettings({
      entryCutoffSeconds: 180,
    });

    expect(settings.entryCutoffSeconds).toBe(180);
  });

  it("accepts a 5 minute entry cutoff override", () => {
    const settings = normalizeSettings({
      entryCutoffSeconds: 300,
    });

    expect(settings.entryCutoffSeconds).toBe(300);
  });

  it("rejects a phase 2 start before the minimum elapsed window", () => {
    expect(() =>
      normalizeSettings({
        mismatchGuardMinElapsedSeconds: 60,
        mismatchGuardPhase2StartSeconds: 59,
      }),
    ).toThrow(/Phase 2 mismatch guard must start after the minimum elapsed guard window/);
  });

  it("rejects a phase 2 move threshold below the standard threshold", () => {
    expect(() =>
      normalizeSettings({
        mismatchGuardMinMoveBps: 5,
        mismatchGuardPhase2MinMoveBps: 4,
      }),
    ).toThrow(/Phase 2 mismatch guard move threshold must be >= the standard threshold/);
  });

  it("rejects a phase 2 start inside the entry cutoff window", () => {
    expect(() =>
      normalizeSettings({
        entryCutoffSeconds: 180,
        mismatchGuardPhase2StartSeconds: 720,
      }),
    ).toThrow(/Phase 2 mismatch guard must start before the entry cutoff window/);
  });

  it("normalizes a four-asset settings map with SOL and XRP shadow defaults", () => {
    const settingsMap = normalizeSettingsMap({
      eth: normalizeSettings({
        enableTrading: false,
        shadowMode: true,
        maxPairNotionalUsd: 150,
      }),
    });

    expect(settingsMap.sol.enableTrading).toBe(true);
    expect(settingsMap.sol.shadowMode).toBe(true);
    expect(settingsMap.xrp.enableTrading).toBe(true);
    expect(settingsMap.xrp.shadowMode).toBe(true);
  });
});
