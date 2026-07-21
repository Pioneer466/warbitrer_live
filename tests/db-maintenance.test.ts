import { DEFAULT_DATABASE_MAINTENANCE_CONFIG, readDatabaseMaintenanceConfig } from "@/lib/db-maintenance";
import { ORACLE_SAMPLE_RETENTION_MS, SLOT_RESOLUTION_RETENTION_MS } from "@/lib/oracle-history";

describe("database maintenance config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DATABASE_URL: "postgres://warbitrer:secret@127.0.0.1:5432/warbitrer_live",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses sane defaults when retention env vars are absent", () => {
    expect(readDatabaseMaintenanceConfig()).toEqual(DEFAULT_DATABASE_MAINTENANCE_CONFIG);
    expect(DEFAULT_DATABASE_MAINTENANCE_CONFIG.retention.oracleSamplesMs).toBe(ORACLE_SAMPLE_RETENTION_MS);
    expect(DEFAULT_DATABASE_MAINTENANCE_CONFIG.retention.slotResolutionsMs).toBe(SLOT_RESOLUTION_RETENTION_MS);
  });

  it("allows disabling specific retention windows with zero", () => {
    process.env.DB_RETENTION_SNAPSHOTS_HOURS = "0";
    process.env.DB_RETENTION_SETTLEMENTS_DAYS = "0";

    const config = readDatabaseMaintenanceConfig();

    expect(config.retention.snapshotsMs).toBeNull();
    expect(config.retention.settlementsMs).toBeNull();
    expect(config.retention.fillsMs).toBe(DEFAULT_DATABASE_MAINTENANCE_CONFIG.retention.fillsMs);
  });

  it("parses explicit maintenance windows", () => {
    process.env.DB_MAINTENANCE_INTERVAL_MINUTES = "15";
    process.env.DB_RETENTION_SNAPSHOTS_HOURS = "12";
    process.env.DB_RETENTION_FILLS_DAYS = "45";

    const config = readDatabaseMaintenanceConfig();

    expect(config.intervalMs).toBe(15 * 60_000);
    expect(config.retention.snapshotsMs).toBe(12 * 60 * 60_000);
    expect(config.retention.fillsMs).toBe(45 * 24 * 60 * 60_000);
  });

  it("rejects negative or invalid values", () => {
    process.env.DB_RETENTION_RUN_EVENTS_DAYS = "-1";
    expect(() => readDatabaseMaintenanceConfig()).toThrow("DB_RETENTION_RUN_EVENTS_DAYS");

    process.env = {
      ...originalEnv,
      DATABASE_URL: "postgres://warbitrer:secret@127.0.0.1:5432/warbitrer_live",
      DB_MAINTENANCE_INTERVAL_MINUTES: "abc",
    };
    expect(() => readDatabaseMaintenanceConfig()).toThrow("DB_MAINTENANCE_INTERVAL_MINUTES");
  });
});
