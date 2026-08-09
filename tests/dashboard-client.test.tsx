import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DashboardClient } from "@/components/dashboard-client";
import { DEFAULT_STRATEGY_CONFIG } from "@/lib/constants";
import type { DashboardResponse, HistoryResponse, LiveOpportunity } from "@/lib/types";

const polling = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("@/components/use-polling-json", () => ({
  usePollingJson: (url: string) => polling.read(url),
}));

describe("asset dashboard", () => {
  beforeAll(() => vi.stubGlobal("React", React));
  afterAll(() => vi.unstubAllGlobals());

  it("keeps scan decisions visible while removing duplicated portfolio and diagnostic panels", () => {
    const dashboard = buildDashboard();
    const history: HistoryResponse = {
      fetchedAt: 1_000,
      slot: dashboard.slot,
      points: [],
      feedHealth: dashboard.feedHealth,
    };
    polling.read.mockImplementation((url: string) => ({
      data: url.startsWith("/api/history/") ? history : dashboard,
      error: null,
      loading: false,
      refresh: vi.fn(),
    }));

    const markup = renderToStaticMarkup(React.createElement(DashboardClient, { asset: "btc" }));

    expect(markup).toContain("Flux de Prix");
    expect(markup).toContain("Opportunités");
    expect(markup).toContain("modèle calibré");
    expect(markup).toContain("modèle + hard");
    expect(markup).toContain("Pourquoi ça bloque");
    expect(markup).toContain("guard hard");
    expect(markup).not.toContain("Risque Mismatch");
    expect(markup).not.toContain("Balances");
    expect(markup).not.toContain("Readiness");
    expect(markup).not.toContain("Delta Compte");
    expect(markup).not.toContain("Intents Ouverts");
    expect(markup).not.toContain("Alertes Opérationnelles");
  });
});

function buildDashboard(): DashboardResponse {
  const opportunity = {
    asset: "btc",
    id: "btc-up-no",
    slotKey: "btc:slot",
    capturedAt: 1_000,
    combination: "POLY_UP_KALSHI_NO",
    label: "Poly Up + Kalshi No",
    grossCost: 0.91,
    threshold: 0.93,
    thresholdMet: true,
    worstCaseProfitUsd: 0.8,
    projectedNetProfitUsd: 0.7,
    projectedNetReturn: 0.07,
    estimatedFeesUsd: 0.1,
    eligible: false,
    primaryVenue: "kalshi",
    primarySelection: null,
    improvementFromLastEntry: null,
    reasons: ["Probabilité fatale supérieure à la limite économique"],
    mismatchGuardAction: "allow",
    mismatchSizeMultiplier: 1,
    mismatchGuardAudit: {
      configuredMode: "hard_only",
      active: { action: "allow", sizeMultiplier: 1, reasonCodes: [], reasons: [] },
      hardOnly: { action: "allow", sizeMultiplier: 1, reasonCodes: [], reasons: [] },
      legacyEnforce: {
        action: "reduce_size",
        sizeMultiplier: 0.5,
        reasonCodes: ["moderate_venue_disagreement"],
        reasons: ["désaccord modéré"],
      },
    },
    mismatchRisk: "medium",
    venueDisagreementPct: 0.08,
    deadZoneDistanceBps: 8,
    deadZoneWidthBps: 4,
    referencePayoutCount: 1,
    secondsElapsedInSlot: 400,
    chainlinkMoveBps: 12,
    openDriftBps: 2,
    chainlinkLivePriceUsd: 100_000,
    observedSlotOpenPriceUsd: 99_900,
    kalshiTargetPriceUsd: 99_950,
    mismatchRiskEstimate: {
      available: true,
      executionUsable: true,
      executionReason: null,
      modelVersion: "structural-ewma-isotonic-calibrated-test",
      reason: null,
      pFatal: 0.04,
      pFatalUpper95: 0.06,
      pAligned: 0.92,
      pDouble: 0.04,
      expectedPnlUsd: 0.3,
      conservativePnlUsd: -0.1,
      fatalPnlUsd: -9.1,
      breakEvenFatalProbability: 0.09,
      maximumAllowedFatalProbability: 0.045,
      chainlinkAgeMs: 100,
      cfAgeMs: 120,
      observationCount: 1_000,
    },
    mismatchRiskAudit: {
      evaluatedAt: 1_000,
      policyMode: "block_only",
      decision: "would_block",
      source: "scan",
      baseEligible: false,
      baseReasons: [],
      blockingReasonCodes: ["fatal_probability_above_limit"],
      blockingReasons: ["Probabilité fatale supérieure à la limite économique"],
      diagnosticReasonCodes: [],
      economicsBasis: "executable",
      pairSize: 10,
      totalCostUsd: 9.1,
      breakEvenFatalProbability: 0.09,
      maximumAllowedFatalProbability: 0.045,
      pFatal: 0.04,
      pFatalUpper95: 0.06,
      conservativePnlUsd: -0.1,
      fatalPnlUsd: -9.1,
      estimateAvailable: true,
      executionUsable: true,
      executionReason: null,
      modelVersion: "structural-ewma-isotonic-calibrated-test",
      enforceReady: true,
      enforceReasons: [],
      guardMode: "hard_only",
      hardInvariantReasonCodes: [],
      legacyGuardReasonCodes: ["moderate_venue_disagreement"],
      policyComparisons: {
        calibratedModel: "would_block",
        calibratedModelPlusHardInvariants: "would_block",
        legacyGuard: "would_reduce_size",
      },
      legacyGuardAction: "reduce_size",
      legacySizeMultiplier: 0.5,
    },
    legs: [
      {
        venue: "polymarket",
        outcome: "UP",
        marketRef: "poly",
        price: 0.55,
        depth: 50,
        targetNotionalUsd: 5.5,
        size: 10,
        tickSize: 0.01,
        minOrderSize: 1,
        feeEstimateUsd: 0,
      },
      {
        venue: "kalshi",
        outcome: "NO",
        marketRef: "kalshi",
        price: 0.36,
        depth: 50,
        targetNotionalUsd: 3.6,
        size: 10,
        tickSize: 0.01,
        minOrderSize: 1,
        feeEstimateUsd: 0,
      },
    ],
  } satisfies LiveOpportunity;

  const feed = (venue: "polymarket" | "kalshi") => ({
    asset: "btc" as const,
    venue,
    feedStatus: "ready" as const,
    source: "ws" as const,
    lastMessageAt: 1_000,
    stalenessMs: 100,
    details: [],
    subscriptions: [],
  });

  return {
    fetchedAt: 1_000,
    slot: {
      asset: "btc",
      key: "btc:slot",
      startTs: 0,
      endTs: 900_000,
      startIso: "1970-01-01T00:00:00.000Z",
      endIso: "1970-01-01T00:15:00.000Z",
      label: "BTC 15m",
      polymarketSlug: "btc-updown-15m",
      secondsRemaining: 300,
    },
    config: {
      ...DEFAULT_STRATEGY_CONFIG,
      enableTrading: true,
      shadowMode: true,
      mismatchGuardMode: "hard_only",
    },
    workerState: {
      asset: "btc",
      phase: "scan",
      currentSlotKey: "btc:slot",
      lastScanAt: 1_000,
      lastExecuteAt: null,
      lastReconcileAt: null,
      lastError: null,
      readinessStatus: "ready",
      readiness: [],
      loopHealth: {
        lastScanDurationMs: 10,
        lastExecutionDurationMs: null,
        lastReconcileDurationMs: null,
        lastScanAgeMs: 0,
        lastCandidateScore: null,
        lockBusyCount: 0,
        staleSignalCount: 0,
        updatedAt: 1_000,
      },
    },
    latestSnapshot: null,
    feedHealth: [feed("polymarket"), feed("kalshi")],
    opportunities: [opportunity],
    venueBalances: [],
    openIntents: [],
    recentOrders: [],
    recentFills: [],
    positions: [],
    pnl: null,
    stablePnlChanges: [],
    fillQuality: {} as DashboardResponse["fillQuality"],
    bridgeTransfers: [],
    circuitBreakers: [],
    runEvents: [{ level: "info", eventType: "scan.ok", message: "healthy", payload: null, createdAt: 1_000 }],
  };
}
