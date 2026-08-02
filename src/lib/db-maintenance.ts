import { readEnv, type LiveEnv } from "@/lib/env";
import { ORACLE_SAMPLE_RETENTION_MS, SLOT_RESOLUTION_RETENTION_MS } from "@/lib/oracle-history";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type DatabaseMaintenanceConfig = {
  intervalMs: number;
  retention: {
    snapshotsMs: number | null;
    oracleSamplesMs: number | null;
    slotResolutionsMs: number | null;
    entryExecutionProbesMs: number | null;
    pnlSnapshotsMs: number | null;
    runEventsMs: number | null;
    fillsMs: number | null;
    venueOrdersMs: number | null;
    closedIntentsMs: number | null;
    settlementsMs: number | null;
    bridgeTransfersMs: number | null;
  };
};

export const DEFAULT_DATABASE_MAINTENANCE_CONFIG: DatabaseMaintenanceConfig = {
  intervalMs: 60 * MINUTE_MS,
  retention: {
    snapshotsMs: 72 * HOUR_MS,
    oracleSamplesMs: ORACLE_SAMPLE_RETENTION_MS,
    slotResolutionsMs: SLOT_RESOLUTION_RETENTION_MS,
    entryExecutionProbesMs: 45 * DAY_MS,
    pnlSnapshotsMs: 30 * DAY_MS,
    runEventsMs: 30 * DAY_MS,
    fillsMs: 180 * DAY_MS,
    venueOrdersMs: 180 * DAY_MS,
    closedIntentsMs: 180 * DAY_MS,
    settlementsMs: 365 * DAY_MS,
    bridgeTransfersMs: 365 * DAY_MS,
  },
};

export function readDatabaseMaintenanceConfig(env = readEnv()): DatabaseMaintenanceConfig {
  return {
    intervalMs: parseWindowEnv(
      env.DB_MAINTENANCE_INTERVAL_MINUTES,
      "DB_MAINTENANCE_INTERVAL_MINUTES",
      MINUTE_MS,
      DEFAULT_DATABASE_MAINTENANCE_CONFIG.intervalMs,
      false,
    )!,
    retention: {
      snapshotsMs: parseWindowEnv(
        env.DB_RETENTION_SNAPSHOTS_HOURS,
        "DB_RETENTION_SNAPSHOTS_HOURS",
        HOUR_MS,
        DEFAULT_DATABASE_MAINTENANCE_CONFIG.retention.snapshotsMs,
      ),
      oracleSamplesMs: DEFAULT_DATABASE_MAINTENANCE_CONFIG.retention.oracleSamplesMs,
      slotResolutionsMs: DEFAULT_DATABASE_MAINTENANCE_CONFIG.retention.slotResolutionsMs,
      entryExecutionProbesMs: DEFAULT_DATABASE_MAINTENANCE_CONFIG.retention.entryExecutionProbesMs,
      pnlSnapshotsMs: parseWindowEnv(
        env.DB_RETENTION_PNL_DAYS,
        "DB_RETENTION_PNL_DAYS",
        DAY_MS,
        DEFAULT_DATABASE_MAINTENANCE_CONFIG.retention.pnlSnapshotsMs,
      ),
      runEventsMs: parseWindowEnv(
        env.DB_RETENTION_RUN_EVENTS_DAYS,
        "DB_RETENTION_RUN_EVENTS_DAYS",
        DAY_MS,
        DEFAULT_DATABASE_MAINTENANCE_CONFIG.retention.runEventsMs,
      ),
      fillsMs: parseWindowEnv(
        env.DB_RETENTION_FILLS_DAYS,
        "DB_RETENTION_FILLS_DAYS",
        DAY_MS,
        DEFAULT_DATABASE_MAINTENANCE_CONFIG.retention.fillsMs,
      ),
      venueOrdersMs: parseWindowEnv(
        env.DB_RETENTION_ORDERS_DAYS,
        "DB_RETENTION_ORDERS_DAYS",
        DAY_MS,
        DEFAULT_DATABASE_MAINTENANCE_CONFIG.retention.venueOrdersMs,
      ),
      closedIntentsMs: parseWindowEnv(
        env.DB_RETENTION_CLOSED_INTENTS_DAYS,
        "DB_RETENTION_CLOSED_INTENTS_DAYS",
        DAY_MS,
        DEFAULT_DATABASE_MAINTENANCE_CONFIG.retention.closedIntentsMs,
      ),
      settlementsMs: parseWindowEnv(
        env.DB_RETENTION_SETTLEMENTS_DAYS,
        "DB_RETENTION_SETTLEMENTS_DAYS",
        DAY_MS,
        DEFAULT_DATABASE_MAINTENANCE_CONFIG.retention.settlementsMs,
      ),
      bridgeTransfersMs: parseWindowEnv(
        env.DB_RETENTION_BRIDGE_TRANSFERS_DAYS,
        "DB_RETENTION_BRIDGE_TRANSFERS_DAYS",
        DAY_MS,
        DEFAULT_DATABASE_MAINTENANCE_CONFIG.retention.bridgeTransfersMs,
      ),
    },
  };
}

function parseWindowEnv(
  raw: string | undefined,
  label: keyof LiveEnv | string,
  unitMs: number,
  fallbackMs: number | null,
  allowDisable = true,
) {
  if (raw === undefined) {
    return fallbackMs;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }

  if (parsed === 0) {
    if (allowDisable) {
      return null;
    }

    throw new Error(`${label} must be greater than zero`);
  }

  return parsed * unitMs;
}
