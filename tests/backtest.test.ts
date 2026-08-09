import {
  buildBacktestExportCommand,
  buildBacktestVariants,
  parseBacktestAssets,
  simulateOpportunity,
  summarizeVariant,
} from "@/lib/backtest";
import { DEFAULT_STRATEGY_CONFIGS } from "@/lib/constants";
import { MARKET_ASSETS } from "@/lib/market-catalog";
import { normalizeSettings, normalizeSettingsMap } from "@/lib/settings-schema";
import type {
  KalshiQuote,
  LiveOpportunity,
  MarketAsset,
  OpportunitySnapshot,
  OutcomeQuote,
  PolymarketQuote,
  Venue,
  VenueFeedHealth,
} from "@/lib/types";

const NOW = 1774899060000;
const SLOT_START = 1774899000000;
const SLOT_END = 1774899900000;
const SLOT_KEY = "btc:1774899000000";

describe("local backtest helpers", () => {
  it("parses all assets and builds strategy variants", () => {
    expect(parseBacktestAssets("all")).toEqual(MARKET_ASSETS);

    const variants = buildBacktestVariants(normalizeSettingsMap(DEFAULT_STRATEGY_CONFIGS));
    expect(variants.map((variant) => variant.name)).toEqual([
      "current_safe",
      "mismatch_off_depth_safe",
      "mismatch_soft",
      "loose_thresholds",
      "dynamic_primary_shadow",
      "theoretical_bruteforce",
    ]);
    expect(variants.find((variant) => variant.name === "theoretical_bruteforce")?.deployable).toBe(false);
    expect(variants.find((variant) => variant.name === "theoretical_bruteforce")?.settingsByAsset.btc.maxLegPrice).toBe(
      0.99,
    );
    expect(variants.find((variant) => variant.name === "mismatch_off_depth_safe")?.settingsByAsset.btc).toMatchObject({
      mismatchGuardMode: "audit",
      mismatchGuardEnabled: false,
    });
    expect(variants.find((variant) => variant.name === "mismatch_soft")?.settingsByAsset.btc).toMatchObject({
      mismatchGuardMode: "legacy_enforce",
      mismatchGuardEnabled: true,
    });
  });

  it("turns insufficient exact-size depth into a simulated no-fill", () => {
    const result = simulateOpportunity(
      { name: "current_safe", deployable: true, allowDepthBypass: false },
      normalizeSettings({ minimumEntryDepthCoverageRatio: 0.5 }),
      buildSnapshot(),
      buildOpportunity({
        polyDepth: 5,
        kalshiDepth: 100,
      }),
      { polyResolution: "UP", kalshiResolution: "NO" },
    );

    expect(result.status).toBe("no_fill");
    expect(result.noFill).toBe(true);
    expect(result.skipReason).toContain("depth coverage");
  });

  it("keeps exact-size hedge sizing and computes mismatch losses from true resolutions", () => {
    const result = simulateOpportunity(
      { name: "current_safe", deployable: true, allowDepthBypass: false },
      normalizeSettings({
        minimumEntryDepthCoverageRatio: 0.5,
        adaptiveSlippageTightBps: 1,
        adaptiveSlippageDefaultBps: 1,
        adaptiveSlippageThinBps: 1,
      }),
      buildSnapshot(),
      buildOpportunity({
        polyDepth: 100,
        kalshiDepth: 100,
      }),
      { polyResolution: "DOWN", kalshiResolution: "YES" },
    );

    expect(result.status).toBe("filled");
    expect(result.size).toBe(10);
    expect(result.payoutUsd).toBe(0);
    expect(result.costUsd).toBeCloseTo(9.001, 4);
    expect(result.pnlUsd).toBeCloseTo(-9.001, 4);
    expect(result.mismatch).toBe(true);
    expect(result.mismatchLossUsd).toBe(10);
  });

  it("never simulates adaptive slippage above the configured live maximum", () => {
    const result = simulateOpportunity(
      { name: "current_safe", deployable: true, allowDepthBypass: false },
      normalizeSettings({
        maxSlippageBps: 5,
        adaptiveSlippageTightBps: 100,
        adaptiveSlippageDefaultBps: 100,
        adaptiveSlippageThinBps: 100,
      }),
      buildSnapshot(),
      buildOpportunity({ polyDepth: 100, kalshiDepth: 100 }),
      { polyResolution: "UP", kalshiResolution: "NO" },
    );

    expect(result.status).toBe("filled");
    expect(result.polyPrice).toBe(0.2001);
    expect(result.kalshiPrice).toBe(0.7003);
  });

  it("penalizes no-fills and mismatch losses in the risk score", () => {
    const variant = buildBacktestVariants(normalizeSettingsMap(DEFAULT_STRATEGY_CONFIGS))[0];
    const filled = simulateOpportunity(
      { name: "current_safe", deployable: true, allowDepthBypass: false },
      normalizeSettings({
        adaptiveSlippageTightBps: 1,
        adaptiveSlippageDefaultBps: 1,
        adaptiveSlippageThinBps: 1,
      }),
      buildSnapshot(),
      buildOpportunity({ polyDepth: 100, kalshiDepth: 100 }),
      { polyResolution: "DOWN", kalshiResolution: "YES" },
    );
    const noFill = simulateOpportunity(
      { name: "current_safe", deployable: true, allowDepthBypass: false },
      normalizeSettings({ minimumEntryDepthCoverageRatio: 0.5 }),
      buildSnapshot({ slotKey: "btc:1774899900000" }),
      buildOpportunity({ slotKey: "btc:1774899900000", polyDepth: 5, kalshiDepth: 100 }),
      { polyResolution: "UP", kalshiResolution: "NO" },
    );

    const summary = summarizeVariant(variant, [filled, noFill]);
    expect(summary.netPnlUsd).toBeCloseTo(-9.001, 4);
    expect(summary.noFills).toBe(1);
    expect(summary.mismatchLossUsd).toBe(10);
    expect(summary.riskScoreUsd).toBeLessThan(summary.netPnlUsd);
  });

  it("prints a VPS-only table-filtered export command", () => {
    const command = buildBacktestExportCommand({
      database: "warbitrer_live",
      output: "/tmp/warbitrer.dump",
    });

    expect(command).toContain("pg_dump -Fc");
    expect(command).toContain("ionice -c2 -n7");
    expect(command).toContain("public.opportunity_snapshots");
    expect(command).toContain("public.order_intents");
    expect(command).not.toContain("backtest:strategies");
  });
});

function buildOpportunity(
  overrides: {
    slotKey?: string;
    polyDepth?: number;
    kalshiDepth?: number;
  } = {},
): LiveOpportunity {
  const slotKey = overrides.slotKey ?? SLOT_KEY;
  return {
    id: `opp-${slotKey}`,
    asset: "btc",
    slotKey,
    capturedAt: NOW,
    combination: "POLY_UP_KALSHI_NO",
    label: "Poly Up + Kalshi No",
    grossCost: 0.9,
    threshold: 0.93,
    thresholdMet: true,
    eligible: true,
    primaryVenue: "kalshi",
    primarySelection: null,
    improvementFromLastEntry: null,
    estimatedFeesUsd: 0,
    projectedNetProfitUsd: 1,
    projectedNetReturn: 0.1,
    worstCaseProfitUsd: 1,
    reasons: [],
    mismatchGuardAction: "allow",
    mismatchSizeMultiplier: 1,
    referencePayoutCount: 1,
    deadZoneDistanceBps: null,
    deadZoneWidthBps: null,
    mismatchRisk: "low",
    venueDisagreementPct: null,
    secondsElapsedInSlot: 60,
    chainlinkMoveBps: 10,
    openDriftBps: 1,
    chainlinkLivePriceUsd: 100100,
    observedSlotOpenPriceUsd: 100000,
    kalshiTargetPriceUsd: 100010,
    legs: [
      {
        venue: "polymarket",
        outcome: "UP",
        marketRef: "poly-market",
        tokenId: "poly-up",
        price: 0.2,
        depth: overrides.polyDepth ?? 100,
        targetNotionalUsd: 2,
        size: 10,
        tickSize: 0.001,
        minOrderSize: 0.01,
        feeEstimateUsd: 0,
      },
      {
        venue: "kalshi",
        outcome: "NO",
        marketRef: "KXBTC15M-1",
        price: 0.7,
        depth: overrides.kalshiDepth ?? 100,
        targetNotionalUsd: 7,
        size: 10,
        tickSize: 0.01,
        minOrderSize: 1,
        feeEstimateUsd: 0,
      },
    ],
  };
}

function buildSnapshot(
  overrides: {
    asset?: MarketAsset;
    slotKey?: string;
    polymarket?: Partial<PolymarketQuote>;
    kalshi?: Partial<KalshiQuote>;
  } = {},
): OpportunitySnapshot {
  const asset = overrides.asset ?? "btc";
  const slotKey = overrides.slotKey ?? SLOT_KEY;
  return {
    id: 1,
    asset,
    slotKey,
    slotStartTs: SLOT_START,
    slotEndTs: SLOT_END,
    capturedAt: NOW,
    polymarket: {
      ...buildPolymarketQuote(asset, slotKey),
      ...overrides.polymarket,
    },
    kalshi: {
      ...buildKalshiQuote(asset, slotKey),
      ...overrides.kalshi,
    },
    opportunities: [],
  };
}

function buildPolymarketQuote(asset: MarketAsset, slotKey: string): PolymarketQuote {
  return {
    ref: {
      asset,
      venue: "polymarket",
      id: "poly-market",
      conditionId: "condition-1",
      slug: "btc-updown-15m-1774899000",
      title: "Poly BTC 15m",
      url: "https://polymarket.com/event/test",
      startTime: new Date(SLOT_START).toISOString(),
      endTime: new Date(SLOT_END).toISOString(),
      slotKey,
    },
    conditionId: "condition-1",
    status: "open",
    slotAligned: true,
    availabilityReason: null,
    feedHealth: readyFeed(asset, "polymarket"),
    lastMessageAt: NOW,
    stalenessMs: 0,
    source: "ws",
    outcomes: {
      up: outcomeQuote("UP", 0.2, 100),
      down: outcomeQuote("DOWN", 0.8, 100),
    },
    resolution: null,
    tokenIds: {
      up: "up-token",
      down: "down-token",
    },
    orderbookLevels: {
      upBids: [[0.19, 100]],
      upAsks: [[0.2, 100]],
      downBids: [[0.79, 100]],
      downAsks: [[0.8, 100]],
    },
    chainlinkLivePriceUsd: 100100,
    chainlinkLivePriceCapturedAt: NOW,
    observedSlotOpenPriceUsd: 100000,
    observedSlotOpenCapturedAt: SLOT_START + 5000,
    feeRateBps: 0,
    negRisk: false,
  };
}

function buildKalshiQuote(asset: MarketAsset, slotKey: string): KalshiQuote {
  return {
    ref: {
      asset,
      venue: "kalshi",
      id: "KXBTC15M-1",
      ticker: "KXBTC15M-1",
      title: "Kalshi BTC 15m",
      url: "https://kalshi.com/markets/test",
      startTime: new Date(SLOT_START).toISOString(),
      endTime: new Date(SLOT_END).toISOString(),
      slotKey,
    },
    status: "active",
    slotAligned: true,
    availabilityReason: null,
    feedHealth: readyFeed(asset, "kalshi"),
    lastMessageAt: NOW,
    stalenessMs: 0,
    source: "ws",
    outcomes: {
      yes: outcomeQuote("YES", 0.3, 100),
      no: outcomeQuote("NO", 0.7, 100),
    },
    targetPriceUsd: 100010,
    resolution: null,
    feeMultiplier: 0,
    feeType: "quadratic",
    lastTradeYesPrice: 0.3,
    lastTradeNoPrice: 0.7,
    priceLevelStructure: "deci_cent",
    priceRanges: [{ start: "0.0000", end: "1.0000", step: "0.0010" }],
    orderbookLevels: {
      yesBids: [[0.69, 100]],
      noBids: [[0.29, 100]],
    },
  };
}

function outcomeQuote(outcome: OutcomeQuote["outcome"], buyPrice: number, depth: number): OutcomeQuote {
  return {
    outcome,
    buyPrice,
    sellPrice: Math.max(0, buyPrice - 0.01),
    midPrice: buyPrice - 0.005,
    bestBid: Math.max(0, buyPrice - 0.01),
    bestAsk: buyPrice,
    depth,
    tickSize: 0.001,
    minOrderSize: 1,
    feeRateBps: 0,
    execution: {
      buyPrice,
      sellPrice: Math.max(0, buyPrice - 0.01),
      midPrice: buyPrice - 0.005,
      bestBid: Math.max(0, buyPrice - 0.01),
      bestAsk: buyPrice,
      depth,
      tickSize: 0.001,
      minOrderSize: 1,
      feeRateBps: 0,
    },
    chart: {
      label: "best_ask_live",
      price: buyPrice,
      source: "ws",
      lastUpdatedAt: NOW,
    },
  };
}

function readyFeed(asset: MarketAsset, venue: Venue): VenueFeedHealth {
  return {
    asset,
    venue,
    feedStatus: "ready",
    source: "ws",
    lastMessageAt: NOW,
    stalenessMs: 0,
    details: [],
    subscriptions: [],
  };
}
