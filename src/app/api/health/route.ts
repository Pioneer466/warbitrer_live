import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { getLiveExecutionSafety } from "@/lib/execution-safety";
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const liveExecution = getLiveExecutionSafety();
    const slots = ACTIVE_MARKET_ASSETS.map((asset) => getCurrentSlot(asset));
    const [workerStates, circuitBreakers, config, latestSnapshots, database] = await Promise.all([
      readWorkerStates(),
      readCircuitBreakers(),
      readSettingsMap(),
      Promise.all(slots.map((slot) => readLatestSnapshot(slot.asset, slot.key))),
      readDatabaseMetrics().catch(() => null),
    ]);

    const assets = slots.map((slot, index) => {
      const latestSnapshot = latestSnapshots[index];
      const assetConfig = config[slot.asset];
      const assetState = workerStates[slot.asset];
      return {
        asset: slot.asset,
        phase: assetState.phase,
        readinessStatus: assetState.readinessStatus,
        tradingEnabled: assetConfig.enableTrading,
        shadowMode: assetConfig.shadowMode,
        feedHealth: latestSnapshot ? [latestSnapshot.polymarket.feedHealth, latestSnapshot.kalshi.feedHealth] : [],
      };
    });

    return NextResponse.json({
      ok:
        assets.every((asset) => !asset.tradingEnabled || asset.readinessStatus === "ready") &&
        assets.every((asset) => !asset.tradingEnabled || asset.shadowMode || liveExecution.allowed),
      timestamp: Date.now(),
      storageMode: storageMode(),
      liveExecutionAllowed: liveExecution.allowed,
      liveExecutionGateEnabled: liveExecution.gateEnabled,
      kalshiEnvironment: liveExecution.kalshiEnvironment,
      liveExecutionBlockReasons: liveExecution.reasons,
      activeBreakers: circuitBreakers.filter((breaker) => breaker.active).length,
      tradingEnabledAssets: assets.filter((asset) => asset.tradingEnabled).map((asset) => asset.asset),
      assets,
      database,
    });
  } catch (error) {
    return createApiErrorResponse(error);
  }
}
