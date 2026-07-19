import { NextResponse } from "next/server";

import { getLiveExecutionSafety } from "@/lib/execution-safety";
import { HEALTH_THRESHOLDS } from "@/lib/health";
import { ACTIVE_MARKET_ASSETS } from "@/lib/market-catalog";
import { getCurrentSlot } from "@/lib/slot";
import {
  readCircuitBreakers,
  readDatabaseMetrics,
  readLatestSnapshot,
  readSettingsMap,
  readWorkerStates,
  storageMode,
} from "@/lib/storage";
import type {
  CircuitBreaker,
  HealthAssetStatus,
  HealthErrorResponse,
  HealthIssue,
  HealthReadinessResponse,
  MarketSlot,
  OpportunitySnapshot,
  StrategyConfig,
  WorkerState,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const now = Date.now();
    const liveExecution = getLiveExecutionSafety();
    const slots = ACTIVE_MARKET_ASSETS.map((asset) => getCurrentSlot(asset, new Date(now)));
    const [workerStates, circuitBreakers, config, latestSnapshots, database] = await Promise.all([
      readWorkerStates(),
      readCircuitBreakers(),
      readSettingsMap(),
      Promise.all(slots.map((slot) => readLatestSnapshot(slot.asset, slot.key))),
      readDatabaseMetrics().catch(() => null),
    ]);

    const assets = slots.map((slot, index) => {
      return buildAssetHealth({
        slot,
        settings: config[slot.asset].config,
        workerState: workerStates[slot.asset],
        snapshot: latestSnapshots[index],
        circuitBreakers,
        liveExecution,
        now,
      });
    });
    const reasons = assets.flatMap((asset) => asset.reasons);
    const ok = reasons.length === 0;
    const currentStorageMode = storageMode();
    if (currentStorageMode !== "postgres") {
      throw new Error(`Unsupported storage mode: ${currentStorageMode}`);
    }

    const payload = {
      timestamp: now,
      storageMode: "postgres" as const,
      reasons,
      thresholds: HEALTH_THRESHOLDS,
      liveExecutionAllowed: liveExecution.allowed,
      liveExecutionGateEnabled: liveExecution.gateEnabled,
      kalshiEnvironment: liveExecution.kalshiEnvironment,
      liveExecutionBlockReasons: liveExecution.reasons,
      activeBreakers: circuitBreakers.filter((breaker) => breaker.active).length,
      tradingEnabledAssets: assets.filter((asset) => asset.tradingEnabled).map((asset) => asset.asset),
      assets,
      database,
    };
    const response: HealthReadinessResponse = ok
      ? { ...payload, status: "healthy", ok: true }
      : { ...payload, status: "unhealthy", ok: false };

    return NextResponse.json(response, {
      status: ok ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[health] check failed", error);
    const response: HealthErrorResponse = {
      status: "error",
      ok: false,
      error: "health_check_failed",
      timestamp: Date.now(),
      liveExecutionAllowed: false,
    };
    return NextResponse.json(response, {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }
}

function buildAssetHealth(input: {
  slot: MarketSlot;
  settings: StrategyConfig;
  workerState: WorkerState;
  snapshot: OpportunitySnapshot | null;
  circuitBreakers: CircuitBreaker[];
  liveExecution: ReturnType<typeof getLiveExecutionSafety>;
  now: number;
}): HealthAssetStatus {
  const { slot, settings, workerState, snapshot, circuitBreakers, liveExecution, now } = input;
  const feedHealth = snapshot ? [snapshot.polymarket.feedHealth, snapshot.kalshi.feedHealth] : [];
  const workerHeartbeatAgeMs = timestampAgeMs(workerState.loopHealth.updatedAt, now);
  const lastScanAgeMs = timestampAgeMs(workerState.lastScanAt, now);
  const lastExecuteAgeMs = timestampAgeMs(workerState.lastExecuteAt, now);
  const snapshotAgeMs = timestampAgeMs(snapshot?.capturedAt ?? null, now);
  const reasons: HealthIssue[] = [];

  if (settings.enableTrading) {
    if (!settings.shadowMode && workerState.readinessStatus !== "ready") {
      reasons.push(
        issue(slot, "worker_not_ready", `Worker readiness is ${workerState.readinessStatus}, expected ready`),
      );
    }
    if (workerState.currentSlotKey !== slot.key) {
      reasons.push(
        issue(
          slot,
          "worker_slot_mismatch",
          `Worker slot is ${workerState.currentSlotKey ?? "missing"}, expected ${slot.key}`,
        ),
      );
    }

    appendTimestampIssue(reasons, slot, {
      ageMs: workerHeartbeatAgeMs,
      missingCode: "worker_heartbeat_missing",
      staleCode: "worker_heartbeat_stale",
      label: "Worker heartbeat",
      maxAgeMs: HEALTH_THRESHOLDS.workerMaxAgeMs,
    });
    appendTimestampIssue(reasons, slot, {
      ageMs: lastScanAgeMs,
      missingCode: "worker_scan_missing",
      staleCode: "worker_scan_stale",
      label: "Worker scan",
      maxAgeMs: HEALTH_THRESHOLDS.workerMaxAgeMs,
    });
    appendTimestampIssue(reasons, slot, {
      ageMs: lastExecuteAgeMs,
      missingCode: "worker_execute_missing",
      staleCode: "worker_execute_stale",
      label: "Worker execution",
      maxAgeMs: HEALTH_THRESHOLDS.executeMaxAgeMs,
    });

    if (!snapshot) {
      reasons.push(issue(slot, "snapshot_missing", `No snapshot found for current slot ${slot.key}`));
    } else {
      appendTimestampIssue(reasons, slot, {
        ageMs: snapshotAgeMs,
        missingCode: "snapshot_missing",
        staleCode: "snapshot_stale",
        label: "Snapshot",
        maxAgeMs: HEALTH_THRESHOLDS.snapshotMaxAgeMs,
      });

      for (const feed of feedHealth) {
        if (feed.feedStatus !== "ready") {
          reasons.push(issue(slot, "feed_not_ready", `${feed.venue} feed is ${feed.feedStatus}, expected ready`));
        }
        const feedAgeMs = timestampAgeMs(feed.lastMessageAt, now);
        appendTimestampIssue(reasons, slot, {
          ageMs: feedAgeMs,
          missingCode: "feed_timestamp_missing",
          staleCode: "feed_stale",
          label: `${feed.venue} feed`,
          maxAgeMs: HEALTH_THRESHOLDS.feedMaxAgeMs,
        });
      }
    }

    for (const breaker of circuitBreakers) {
      if (breaker.active && isBreakerRelevantToSlot(breaker, slot)) {
        reasons.push(
          issue(
            slot,
            "circuit_breaker_active",
            `Active breaker ${breaker.key}${breaker.reason ? ` (${breaker.reason})` : ""}`,
          ),
        );
      }
    }

    if (!settings.shadowMode && !liveExecution.allowed) {
      reasons.push(
        issue(slot, "live_execution_blocked", `Live execution blocked: ${liveExecution.reasons.join(", ")}`),
      );
    }
  }

  return {
    asset: slot.asset,
    phase: workerState.phase,
    readinessStatus: workerState.readinessStatus,
    tradingEnabled: settings.enableTrading,
    shadowMode: settings.shadowMode,
    healthy: reasons.length === 0,
    reasons,
    workerHeartbeatAgeMs,
    lastScanAgeMs,
    lastExecuteAgeMs,
    snapshotAgeMs,
    feedHealth,
  };
}

function appendTimestampIssue(
  reasons: HealthIssue[],
  slot: MarketSlot,
  input: {
    ageMs: number | null;
    missingCode: HealthIssue["code"];
    staleCode: HealthIssue["code"];
    label: string;
    maxAgeMs: number;
  },
) {
  if (input.ageMs === null) {
    reasons.push(issue(slot, input.missingCode, `${input.label} timestamp is missing`));
    return;
  }
  if (input.ageMs > input.maxAgeMs) {
    reasons.push(issue(slot, input.staleCode, `${input.label} is stale: age=${input.ageMs}ms max=${input.maxAgeMs}ms`));
  }
}

function isBreakerRelevantToSlot(breaker: Pick<CircuitBreaker, "key">, slot: MarketSlot) {
  return breaker.key === "global" || breaker.key === `asset:${slot.asset}` || breaker.key === `slot:${slot.key}`;
}

function timestampAgeMs(timestamp: number | null, now: number) {
  return timestamp !== null && Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null;
}

function issue(slot: MarketSlot, code: HealthIssue["code"], details: string): HealthIssue {
  return {
    asset: slot.asset,
    code,
    details,
  };
}
