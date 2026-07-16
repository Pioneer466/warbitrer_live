import { DEFAULT_GLOBAL_RISK_CONFIG, normalizeGlobalRiskConfig } from "@/lib/risk-settings";

describe("global mismatch-risk settings", () => {
  it("fills an absent or partial persisted payload from safe defaults", () => {
    expect(normalizeGlobalRiskConfig(undefined)).toEqual(DEFAULT_GLOBAL_RISK_CONFIG);
    expect(normalizeGlobalRiskConfig({ oracleMaxAgeMs: 4_000 })).toEqual({
      ...DEFAULT_GLOBAL_RISK_CONFIG,
      oracleMaxAgeMs: 4_000,
    });
  });

  it("rejects absolute limits below their expected-loss counterparts", () => {
    expect(() =>
      normalizeGlobalRiskConfig({
        clusterExpectedFatalLossShare: 0.2,
        clusterAbsoluteFatalLossShare: 0.1,
      }),
    ).toThrow("Absolute fatal-loss share");

    expect(() =>
      normalizeGlobalRiskConfig({
        clusterExpectedFatalLossCapUsd: 100,
        clusterAbsoluteFatalLossCapUsd: 50,
      }),
    ).toThrow("Absolute fatal-loss cap");
  });

  it("rejects stale-data windows outside the bounded operating range", () => {
    expect(() => normalizeGlobalRiskConfig({ balanceMaxAgeMs: 999 })).toThrow();
    expect(() => normalizeGlobalRiskConfig({ oracleMaxAgeMs: 30_001 })).toThrow();
  });
});
