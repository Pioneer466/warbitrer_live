// Scans run at most every 10s with a 15s watchdog; executions have a 90s
// watchdog. These margins avoid flapping while still detecting dead loops.
export const HEALTH_THRESHOLDS = {
  workerMaxAgeMs: 30_000,
  executeMaxAgeMs: 120_000,
  snapshotMaxAgeMs: 30_000,
  feedMaxAgeMs: 10_000,
} as const;
