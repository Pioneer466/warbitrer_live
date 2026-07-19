import { DEFAULT_STRATEGY_CONFIGS } from "@/lib/constants";
import { ACTIVE_MARKET_ASSETS, MARKET_ASSETS } from "@/lib/market-catalog";
import { getCurrentSlot } from "@/lib/slot";
import type {
  CircuitBreaker,
  HealthAssetStatus,
  HealthIssueCode,
  HealthReadinessResponse,
  HealthResponse,
  MarketAsset,
  OpportunitySnapshot,
  VenueFeedHealth,
  VersionedStrategyConfigMap,
  WorkerState,
} from "@/lib/types";
import { vi } from "vitest";

const storageMocks = vi.hoisted(() => ({
  readCircuitBreakers: vi.fn(),
  readDatabaseMetrics: vi.fn(),
  readLatestSnapshot: vi.fn(),
  readSettingsMap: vi.fn(),
  readWorkerStates: vi.fn(),
  storageMode: vi.fn(() => "postgres"),
}));

vi.mock("@/lib/storage", () => storageMocks);

import { GET } from "@/app/api/health/route";
import { HEALTH_THRESHOLDS } from "@/lib/health";

const NOW = 1_800_000_000_000;

describe("health API fail-closed readiness", () => {
  let settings: VersionedStrategyConfigMap;
  let workerStates: Record<MarketAsset, WorkerState>;
  let snapshots: Partial<Record<MarketAsset, OpportunitySnapshot | null>>;
  let circuitBreakers: CircuitBreaker[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("LIVE_EXECUTION_ALLOWED", "false");
    vi.stubEnv("KALSHI_ENV", "prod");
    vi.clearAllMocks();

    settings = buildSettings();
    workerStates = buildWorkerStates();
    snapshots = Object.fromEntries(ACTIVE_MARKET_ASSETS.map((asset) => [asset, buildSnapshot(asset)]));
    circuitBreakers = [];

    storageMocks.readSettingsMap.mockImplementation(async () => settings);
    storageMocks.readWorkerStates.mockImplementation(async () => workerStates);
    storageMocks.readCircuitBreakers.mockImplementation(async () => circuitBreakers);
    storageMocks.readLatestSnapshot.mockImplementation(async (asset: MarketAsset) => snapshots[asset] ?? null);
    storageMocks.readDatabaseMetrics.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns 200 for a healthy enabled shadow asset", async () => {
    const response = await GET();
    const body = asReadinessResponse(await response.json());

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.ok).toBe(true);
    expect(body.status).toBe("healthy");
    expect(body.reasons).toEqual([]);
    expect(body.thresholds).toEqual(HEALTH_THRESHOLDS);
    expect(assetHealth(body, "btc")).toMatchObject({
      healthy: true,
      reasons: [],
      workerHeartbeatAgeMs: 100,
      lastScanAgeMs: 100,
      lastExecuteAgeMs: 100,
      snapshotAgeMs: 100,
    });
  });

  it("returns 503 when the worker heartbeat is stale", async () => {
    workerStates.btc.loopHealth.updatedAt = NOW - HEALTH_THRESHOLDS.workerMaxAgeMs - 1;

    const response = await GET();
    const body = asReadinessResponse(await response.json());

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.status).toBe("unhealthy");
    expect(reasonCodes(assetHealth(body, "btc"))).toContain("worker_heartbeat_stale");
  });

  it.each([
    ["lastScanAt", "worker_scan_stale", HEALTH_THRESHOLDS.workerMaxAgeMs],
    ["lastExecuteAt", "worker_execute_stale", HEALTH_THRESHOLDS.executeMaxAgeMs],
  ] as const)("requires a recent %s timestamp", async (field, expectedCode, maxAgeMs) => {
    workerStates.btc[field] = NOW - maxAgeMs - 1;

    const response = await GET();
    const body = asReadinessResponse(await response.json());

    expect(response.status).toBe(503);
    expect(reasonCodes(assetHealth(body, "btc"))).toContain(expectedCode);
  });

  it("does not treat a 30s-old execution timestamp as a dead executor", async () => {
    workerStates.btc.lastExecuteAt = NOW - HEALTH_THRESHOLDS.workerMaxAgeMs - 1;

    const response = await GET();
    const body = asReadinessResponse(await response.json());

    expect(response.status).toBe(200);
    expect(reasonCodes(assetHealth(body, "btc"))).not.toContain("worker_execute_stale");
  });

  it("returns 503 when the current-slot snapshot is missing", async () => {
    snapshots.btc = null;

    const response = await GET();
    const body = asReadinessResponse(await response.json());

    expect(response.status).toBe(503);
    expect(reasonCodes(assetHealth(body, "btc"))).toContain("snapshot_missing");
  });

  it("returns 503 when the snapshot or a persisted feed timestamp has become stale", async () => {
    const snapshot = buildSnapshot("btc");
    snapshot.capturedAt = NOW - HEALTH_THRESHOLDS.snapshotMaxAgeMs - 1;
    snapshot.polymarket.feedHealth.lastMessageAt = NOW - HEALTH_THRESHOLDS.feedMaxAgeMs - 1;
    snapshots.btc = snapshot;

    const response = await GET();
    const body = asReadinessResponse(await response.json());
    const codes = reasonCodes(assetHealth(body, "btc"));

    expect(response.status).toBe(503);
    expect(codes).toContain("snapshot_stale");
    expect(codes).toContain("feed_stale");
  });

  it("treats active global, asset, and current-slot breakers as unhealthy", async () => {
    const slotKey = getCurrentSlot("btc", new Date(NOW)).key;

    const relevantKeys: CircuitBreaker["key"][] = ["global", "asset:btc", `slot:${slotKey}` as CircuitBreaker["key"]];
    for (const key of relevantKeys) {
      circuitBreakers = [buildBreaker(key)];

      const response = await GET();
      const body = asReadinessResponse(await response.json());

      expect(response.status).toBe(503);
      expect(reasonCodes(assetHealth(body, "btc"))).toContain("circuit_breaker_active");
    }
  });

  it("preserves disabled assets even when workers, snapshots, and breakers are unhealthy", async () => {
    for (const asset of MARKET_ASSETS) {
      settings[asset] = {
        ...settings[asset],
        config: {
          ...settings[asset].config,
          enableTrading: false,
          shadowMode: true,
        },
      };
      workerStates[asset] = buildWorkerState(asset, null);
      snapshots[asset] = null;
    }
    circuitBreakers = [buildBreaker("global")];

    const response = await GET();
    const body = asReadinessResponse(await response.json());

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.activeBreakers).toBe(1);
    expect(body.tradingEnabledAssets).toEqual([]);
    expect(body.assets.every((asset) => asset.healthy && asset.reasons.length === 0)).toBe(true);
  });

  it("does not apply live readiness status to an otherwise healthy shadow asset", async () => {
    workerStates.btc.readinessStatus = "blocked";

    const response = await GET();
    const body = asReadinessResponse(await response.json());

    expect(response.status).toBe(200);
    expect(assetHealth(body, "btc")).toMatchObject({
      readinessStatus: "blocked",
      healthy: true,
      reasons: [],
    });
  });

  it("requires ready worker state for live execution", async () => {
    vi.stubEnv("LIVE_EXECUTION_ALLOWED", "true");
    settings.btc = {
      ...settings.btc,
      config: {
        ...settings.btc.config,
        shadowMode: false,
      },
    };
    workerStates.btc.readinessStatus = "blocked";

    const response = await GET();
    const body = asReadinessResponse(await response.json());

    expect(response.status).toBe(503);
    expect(reasonCodes(assetHealth(body, "btc"))).toContain("worker_not_ready");
  });

  it("returns 503 when the health check itself fails", async () => {
    storageMocks.readWorkerStates.mockRejectedValueOnce(new Error("database unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await GET();
    const body = (await response.json()) as HealthResponse;

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toEqual({
      status: "error",
      ok: false,
      error: "health_check_failed",
      timestamp: NOW,
      liveExecutionAllowed: false,
    });
    consoleError.mockRestore();
  });
});

function buildSettings() {
  return Object.fromEntries(
    MARKET_ASSETS.map((asset) => [
      asset,
      {
        asset,
        config: {
          ...structuredClone(DEFAULT_STRATEGY_CONFIGS[asset]),
          enableTrading: asset === "btc",
          shadowMode: true,
        },
        revision: 0,
        updatedAt: NOW - 1_000,
      },
    ]),
  ) as VersionedStrategyConfigMap;
}

function buildWorkerStates() {
  return Object.fromEntries(
    MARKET_ASSETS.map((asset) => [asset, buildWorkerState(asset, getCurrentSlot(asset, new Date(NOW)).key)]),
  ) as Record<MarketAsset, WorkerState>;
}

function buildWorkerState(asset: MarketAsset, currentSlotKey: string | null): WorkerState {
  return {
    asset,
    phase: "execute",
    currentSlotKey,
    lastScanAt: currentSlotKey ? NOW - 100 : null,
    lastExecuteAt: currentSlotKey ? NOW - 100 : null,
    lastReconcileAt: null,
    lastError: null,
    readinessStatus: currentSlotKey ? "ready" : "blocked",
    readiness: [],
    loopHealth: {
      lastScanDurationMs: 10,
      lastExecutionDurationMs: 10,
      lastReconcileDurationMs: null,
      lastScanAgeMs: currentSlotKey ? 100 : null,
      lastCandidateScore: null,
      lockBusyCount: 0,
      staleSignalCount: 0,
      updatedAt: currentSlotKey ? NOW - 100 : null,
    },
  };
}

function buildSnapshot(asset: MarketAsset): OpportunitySnapshot {
  const slot = getCurrentSlot(asset, new Date(NOW));
  return {
    asset,
    slotKey: slot.key,
    slotStartTs: slot.startTs,
    slotEndTs: slot.endTs,
    capturedAt: NOW - 100,
    polymarket: {
      feedHealth: buildFeed(asset, "polymarket"),
    },
    kalshi: {
      feedHealth: buildFeed(asset, "kalshi"),
    },
    opportunities: [],
  } as unknown as OpportunitySnapshot;
}

function buildFeed(asset: MarketAsset, venue: VenueFeedHealth["venue"]): VenueFeedHealth {
  return {
    asset,
    venue,
    feedStatus: "ready",
    source: "ws",
    lastMessageAt: NOW - 100,
    stalenessMs: 100,
    details: [],
    subscriptions: [],
  };
}

function buildBreaker(key: CircuitBreaker["key"]): CircuitBreaker {
  return {
    key,
    active: true,
    reason: "manual",
    triggeredAt: NOW - 1_000,
    payload: null,
  };
}

function asReadinessResponse(payload: unknown): HealthReadinessResponse {
  const body = payload as HealthResponse;
  expect(body.status).not.toBe("error");
  if (body.status === "error") {
    throw new Error("Expected readiness response");
  }
  return body;
}

function assetHealth(body: HealthReadinessResponse, asset: MarketAsset) {
  const health = body.assets.find((candidate) => candidate.asset === asset);
  expect(health).toBeDefined();
  return health!;
}

function reasonCodes(asset: HealthAssetStatus): HealthIssueCode[] {
  return asset.reasons.map((reason) => reason.code);
}
