import { normalizeSettings, normalizeSettingsMap } from "@/lib/settings-schema";

describe("settings schema", () => {
  it("applies execution defaults for confirmation timeout and price buffer", () => {
    const settings = normalizeSettings(null);

    expect(settings.immediateOrderConfirmationTimeoutMs).toBe(8000);
    expect(settings.executionPriceBuffer).toBe(0.01);
    expect(settings.maxLegCapitalShare).toBe(0.7);
    expect(settings.maxSignalAgeMs).toBe(1000);
    expect(settings.minProjectedNetProfitUsd).toBe(0.25);
    expect(settings.minProjectedNetReturn).toBe(0.02);
    expect(settings.minWorstCaseProfitUsd).toBe(0.25);
    expect(settings.primarySelectionMode).toBe("shadow");
    expect(settings.minimumEntryDepthCoverageRatio).toBe(0.5);
    expect(settings.adaptiveSlippageTightBps).toBe(15);
    expect(settings.adaptiveSlippageDefaultBps).toBe(30);
    expect(settings.adaptiveSlippageThinBps).toBe(60);
    expect(settings.dailyLossCapEnabled).toBe(true);
    expect(settings.dailyLossHardCapUsd).toBe(20);
    expect(settings.pollingIntervalMs).toBe(1000);
    expect(settings.kalshiDepthHeadroomContracts).toBe(2);
    expect(settings.kalshiPrimaryDepthSafetyFactor).toBe(0.7);
    expect(settings.kalshiPrimaryPriceTicksSlippage).toBe(2);
    expect(settings.kalshiPrimaryProbeClipContracts).toBe(5);
    expect(settings.kalshiPrimaryMaxClipContracts).toBe(10);
    expect(settings.kalshiPrimaryMaxClips).toBe(4);
    expect(settings.polymarketHedgeDepthSafetyFactor).toBe(0.8);
    expect(settings.polymarketHedgeHeadroomShares).toBe(1);
    expect(settings.polymarketHedgeBookMaxAgeMs).toBe(500);
    expect(settings.primaryRetryAttempts).toBe(2);
    expect(settings.primaryRetryDelayMs).toBe(200);
    expect(settings.hedgeRetryAttempts).toBe(3);
    expect(settings.hedgeRetryDelayMs).toBe(350);
    expect(settings.hedgeRescueEnabled).toBe(true);
    expect(settings.hedgeRescueMaxAttempts).toBe(3);
    expect(settings.hedgeRescueDelayMs).toBe(150);
    expect(settings.hedgeRescueMaxLossUsd).toBe(1);
    expect(settings.hedgeRescueMinAdvantageUsd).toBe(0.05);
    expect(settings.hedgeRescueAllowPartial).toBe(true);
    expect(settings.forcedUnwindEnabled).toBe(true);
    expect(settings.forcedUnwindMaxAttempts).toBe(3);
    expect(settings.forcedUnwindTickLadder).toEqual([1, 3, 6]);
    expect(settings.forcedUnwindMaxLossUsd).toBe(2);
    expect(settings.forcedUnwindHoldSecondsToSettlement).toBe(45);
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
      maxLegCapitalShare: 0.8,
      maxSignalAgeMs: 750,
      grossEntryThreshold: 0.93,
      maxLegPrice: 0.49,
      reentryImprovement: 0.01,
      pollingIntervalMs: 500,
      minOrderSize: 5,
      maxSlippageBps: 30,
      immediateOrderConfirmationTimeoutMs: 12000,
      executionPriceBuffer: 0.02,
      kalshiDepthHeadroomContracts: 3,
      kalshiPrimaryDepthSafetyFactor: 0.6,
      kalshiPrimaryPriceTicksSlippage: 3,
      kalshiPrimaryProbeClipContracts: 6,
      kalshiPrimaryMaxClipContracts: 8,
      kalshiPrimaryMaxClips: 3,
      polymarketHedgeDepthSafetyFactor: 0.75,
      polymarketHedgeHeadroomShares: 2,
      polymarketHedgeBookMaxAgeMs: 400,
      primaryRetryAttempts: 4,
      primaryRetryDelayMs: 250,
      hedgeRetryAttempts: 5,
      hedgeRetryDelayMs: 500,
      hedgeRescueEnabled: true,
      hedgeRescueMaxAttempts: 4,
      hedgeRescueDelayMs: 100,
      hedgeRescueMaxLossUsd: 0.75,
      hedgeRescueMinAdvantageUsd: 0.03,
      hedgeRescueAllowPartial: false,
      forcedUnwindEnabled: true,
      forcedUnwindMaxAttempts: 4,
      forcedUnwindTickLadder: [1, 2, 4, 8],
      forcedUnwindMaxLossUsd: 3,
      forcedUnwindHoldSecondsToSettlement: 30,
      entryCutoffSeconds: 20,
      maxOpenIntentsPerSlot: 1,
      maxVenueExposureUsd: 1000,
      polyBridgeLowWaterUsdc: 250,
    });

    expect(settings.immediateOrderConfirmationTimeoutMs).toBe(12000);
    expect(settings.executionPriceBuffer).toBe(0.02);
    expect(settings.maxLegCapitalShare).toBe(0.8);
    expect(settings.maxSignalAgeMs).toBe(750);
    expect(settings.kalshiDepthHeadroomContracts).toBe(3);
    expect(settings.kalshiPrimaryDepthSafetyFactor).toBe(0.6);
    expect(settings.kalshiPrimaryPriceTicksSlippage).toBe(3);
    expect(settings.kalshiPrimaryProbeClipContracts).toBe(6);
    expect(settings.kalshiPrimaryMaxClipContracts).toBe(8);
    expect(settings.kalshiPrimaryMaxClips).toBe(3);
    expect(settings.polymarketHedgeDepthSafetyFactor).toBe(0.75);
    expect(settings.polymarketHedgeHeadroomShares).toBe(2);
    expect(settings.polymarketHedgeBookMaxAgeMs).toBe(400);
    expect(settings.primaryRetryAttempts).toBe(4);
    expect(settings.primaryRetryDelayMs).toBe(250);
    expect(settings.hedgeRetryAttempts).toBe(5);
    expect(settings.hedgeRetryDelayMs).toBe(500);
    expect(settings.hedgeRescueMaxAttempts).toBe(4);
    expect(settings.hedgeRescueDelayMs).toBe(100);
    expect(settings.hedgeRescueMaxLossUsd).toBe(0.75);
    expect(settings.hedgeRescueMinAdvantageUsd).toBe(0.03);
    expect(settings.hedgeRescueAllowPartial).toBe(false);
    expect(settings.forcedUnwindMaxAttempts).toBe(4);
    expect(settings.forcedUnwindTickLadder).toEqual([1, 2, 4, 8]);
    expect(settings.forcedUnwindMaxLossUsd).toBe(3);
    expect(settings.forcedUnwindHoldSecondsToSettlement).toBe(30);
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

  it("rejects stale signal ages outside the live freshness window", () => {
    expect(() =>
      normalizeSettings({
        maxSignalAgeMs: 249,
      }),
    ).toThrow();

    expect(() =>
      normalizeSettings({
        maxSignalAgeMs: 5_001,
      }),
    ).toThrow();
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

  it("normalizes a seven-asset settings map with shadow defaults", () => {
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
    expect(settingsMap.doge.enableTrading).toBe(true);
    expect(settingsMap.doge.shadowMode).toBe(true);
    expect(settingsMap.bnb.enableTrading).toBe(true);
    expect(settingsMap.bnb.shadowMode).toBe(true);
    expect(settingsMap.hype.enableTrading).toBe(true);
    expect(settingsMap.hype.shadowMode).toBe(true);
  });
});
