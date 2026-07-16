import {
  ORACLE_COLD_SAMPLE_CADENCE_MS,
  ORACLE_FINAL_MINUTE_SAMPLE_CADENCE_MS,
  ORACLE_HOT_SAMPLE_CADENCE_MS,
  ORACLE_SAMPLE_RETENTION_MS,
  SLOT_RESOLUTION_RETENTION_MS,
  oracleSampleCadenceMs,
  shouldPersistOracleSample,
} from "@/lib/oracle-history";

describe("oracle history sampling", () => {
  it("keeps dense samples bounded while retaining compact labels for long calibration", () => {
    expect(ORACLE_SAMPLE_RETENTION_MS).toBe(45 * 24 * 60 * 60_000);
    expect(SLOT_RESOLUTION_RETENTION_MS).toBe(365 * 24 * 60 * 60_000);
  });

  it("samples cold, hot, and final-minute windows at distinct cadences", () => {
    expect(oracleSampleCadenceMs(100_000, 0, false)).toBe(ORACLE_COLD_SAMPLE_CADENCE_MS);
    expect(oracleSampleCadenceMs(100_000, 0, true)).toBe(ORACLE_HOT_SAMPLE_CADENCE_MS);
    expect(oracleSampleCadenceMs(60_000, 0, false)).toBe(ORACLE_FINAL_MINUTE_SAMPLE_CADENCE_MS);
  });

  it("persists the first sample and then respects the active cadence", () => {
    expect(shouldPersistOracleSample(null, 100_000, 10_000, false)).toBe(true);
    expect(shouldPersistOracleSample(10_000, 100_000, 24_999, false)).toBe(false);
    expect(shouldPersistOracleSample(10_000, 100_000, 25_000, false)).toBe(true);
    expect(shouldPersistOracleSample(10_000, 100_000, 14_999, true)).toBe(false);
    expect(shouldPersistOracleSample(10_000, 100_000, 15_000, true)).toBe(true);
    expect(shouldPersistOracleSample(10_000, 60_000, 10_999, false)).toBe(false);
    expect(shouldPersistOracleSample(10_000, 60_000, 11_000, false)).toBe(true);
  });
});
