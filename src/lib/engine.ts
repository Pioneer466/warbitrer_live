import { fetchBtcSlotResolution, toKalshiResolution } from "@/lib/btc-resolution";
import { readDatabaseMaintenanceConfig } from "@/lib/db-maintenance";
import { applySlippage } from "@/lib/fees";
import {
  createKalshiAdapter,
  fetchKalshiFills,
  fetchKalshiOrders,
  fetchKalshiResolution,
  getKalshiFillFeeUsd,
  getKalshiFillPriceUsd,
} from "@/lib/kalshi";
import { getMarketDataSupervisor } from "@/lib/market-data";
import {
  confirmPolymarketOrderExecution,
  createPolymarketAdapter,
  fetchPolymarketOpenOrders,
  fetchPolymarketResolution,
  fetchPolymarketTrades,
  mapPolymarketOrder,
  mapPolymarketTradeToFill,
} from "@/lib/polymarket";
import { autoConvertPolymarketIfConfigured } from "@/lib/recovery";
import { calculateVenueExposureUsd } from "@/lib/risk";
import { buildSignals } from "@/lib/signals";
import {
  calculateWinningPayout,
  createIntentFromOpportunity,
  finalizeIntent,
  markIntentStatus,
  summarizeVenueFills,
} from "@/lib/settlement";
import { getCurrentSlot } from "@/lib/slot";
import {
  findOrderIntent,
  findVenueOrder,
  readCircuitBreakers,
  readFillsForIntentVenue,
  readLastEntryCosts,
  readLatestSnapshot,
  readOpenOrderIntents,
  readPositions,
  readRecentFills,
  readRecentVenueOrders,
  readSettings,
  readVenueBalances,
  replaceVenuePositions,
  runDatabaseMaintenance,
  writeCircuitBreaker,
  writeFill,
  writeOrderIntent,
  writePnlSnapshot,
  writeRunEvent,
  writeSettlement,
  writeSnapshot,
  writeVenueBalance,
  writeVenueOrder,
  writeWorkerState,
} from "@/lib/storage";
import type {
  ExecutionCoordinator,
  LiveOpportunity,
  LiveOrder,
  MarketSlot,
  OpportunitySnapshot,
  OrderIntent,
  PositionSnapshot,
  StrategyConfig,
  VenueAdapter,
  VenueBalance,
  VenueFeedHealth,
  VenueOrderRequest,
  WorkerState,
} from "@/lib/types";

const RESOLUTION_GRACE_MS = 5_000;
const IMMEDIATE_ORDER_CONFIRMATION_TIMEOUT_MS = 3_000;

const kalshiAdapter = createKalshiAdapter();
const polymarketAdapter = createPolymarketAdapter();
const marketDataSupervisor = getMarketDataSupervisor();
let lastDatabaseMaintenanceAttemptAt: number | null = null;

export async function processTick(now = new Date()) {
  const nowTs = now.getTime();
  const settings = await readSettings();
  const slot = getCurrentSlot(now);
  let scanSucceeded = false;
  let executeSucceeded = false;
  let reconcileSucceeded = false;

  await writeWorkerState({
    phase: "scan",
    currentSlotKey: slot.key,
    lastError: null,
  });

  const coordinator = createExecutionCoordinator(settings);
  const errors: string[] = [];

  try {
    await coordinator.scan(slot, nowTs);
    scanSucceeded = true;
  } catch (error) {
    errors.push(toErrorMessage(error));
  }

  try {
    await writeWorkerState({
      phase: "execute",
      currentSlotKey: slot.key,
    });
    await coordinator.execute(slot, nowTs);
    executeSucceeded = true;
  } catch (error) {
    errors.push(toErrorMessage(error));
  }

  try {
    await writeWorkerState({
      phase: "reconcile",
      currentSlotKey: slot.key,
    });
    await coordinator.reconcile(slot, nowTs);
    reconcileSucceeded = true;
  } catch (error) {
    errors.push(toErrorMessage(error));
  }

  await writeWorkerState({
    phase: "idle",
    currentSlotKey: slot.key,
    lastScanAt: scanSucceeded ? nowTs : undefined,
    lastExecuteAt: executeSucceeded ? nowTs : undefined,
    lastReconcileAt: reconcileSucceeded ? nowTs : undefined,
    lastError: errors[0] ?? null,
  });

  if (errors.length > 0) {
    throw new Error(errors.join(" | "));
  }
}

export function createExecutionCoordinator(settings: StrategyConfig): ExecutionCoordinator {
  let latestScanSnapshot: OpportunitySnapshot | null = null;

  return {
    async scan(slot, now) {
      const balances = await refreshBalances(settings, now);
      const { polymarket: polymarketState, kalshi: kalshiState } = await marketDataSupervisor.readSlotState(slot, now);
      const polymarket = polymarketState.quote;
      const kalshi = kalshiState.quote;

      const opportunities = buildSignals({
        slotKey: slot.key,
        now,
        polymarket,
        kalshi,
        settings,
        balances,
        lastEntryCosts: await readLastEntryCosts(slot.key),
        secondsRemaining: slot.secondsRemaining,
      });

      await writeSnapshot({
        slotKey: slot.key,
        slotStartTs: slot.startTs,
        slotEndTs: slot.endTs,
        capturedAt: now,
        polymarket,
        kalshi,
        opportunities,
      });

      await syncFeedCircuitBreaker(slot, [polymarket.feedHealth, kalshi.feedHealth], now);

      latestScanSnapshot = {
        slotKey: slot.key,
        slotStartTs: slot.startTs,
        slotEndTs: slot.endTs,
        capturedAt: now,
        polymarket,
        kalshi,
        opportunities,
      };

      return latestScanSnapshot;
    },

    async execute(slot, now) {
      const snapshot = latestScanSnapshot ?? (await refreshLatestSnapshot(slot));
      const readiness = await computeReadiness(snapshot, now);
      const activeBreakers = readiness.breakers.filter((breaker) => breaker.active);

      await writeWorkerState({
        readinessStatus: readiness.state.readinessStatus,
        readiness: readiness.state.readiness,
      });

      if (!settings.enableTrading || activeBreakers.length > 0) {
        return [];
      }

      if (!settings.shadowMode && readiness.state.readinessStatus !== "ready") {
        return [];
      }

      if (!snapshot) {
        return [];
      }

      const openIntents = await readOpenOrderIntents();
      const openForSlot = openIntents.filter((intent) => intent.slotKey === slot.key);
      if (openForSlot.length >= settings.maxOpenIntentsPerSlot) {
        return [];
      }

      const eligible = snapshot.opportunities.filter((opportunity) => opportunity.eligible);
      const created: OrderIntent[] = [];
      const positions = await readPositions();
      const exposureUsd = calculateVenueExposureUsd(positions, openIntents);

      for (const opportunity of eligible.slice(0, settings.maxOpenIntentsPerSlot - openForSlot.length)) {
        const intent = createIntentFromOpportunity({
          opportunity,
          slotStartTs: slot.startTs,
          slotEndTs: slot.endTs,
          now,
          maxSlippageBps: settings.maxSlippageBps,
          shadow: settings.shadowMode,
        });

        if (wouldExceedVenueExposure(intent, exposureUsd, settings.maxVenueExposureUsd)) {
          await writeRunEvent({
            level: "warn",
            eventType: "intent.skipped.exposure_limit",
            message: `Intent ${intent.id} exceeds venue exposure limit`,
            payload: {
              slotKey: intent.slotKey,
              limitUsd: settings.maxVenueExposureUsd,
              exposureUsd,
            },
            createdAt: now,
          });
          continue;
        }

        for (const leg of intent.legs) {
          exposureUsd[leg.venue] += leg.requestedNotionalUsd;
        }

        await writeOrderIntent(intent);
        await writeRunEvent({
          level: "info",
          eventType: "intent.created",
          message: `Intent ${intent.id} created for ${intent.combination}`,
          payload: {
            slotKey: intent.slotKey,
            primaryVenue: intent.primaryVenue,
          },
          createdAt: now,
        });

        const executed = settings.shadowMode
          ? await executeShadowIntent(intent, now)
          : await executeIntent(intent, settings, now);
        created.push(executed);
      }

      return created;
    },

    async reconcile(slot, now) {
      const [polyPositions, kalshiPositions] = await Promise.all([
        polymarketAdapter.getPositions(now),
        kalshiAdapter.getPositions(now),
      ]);

      await Promise.all([
        replaceVenuePositions("polymarket", polyPositions),
        replaceVenuePositions("kalshi", kalshiPositions),
      ]);

      await autoConvertPolymarketIfConfigured(polyPositions, now);

      await reconcileVenueOrders(now);
      await reconcileSettlements(now);
      await refreshPnl(now, [...polyPositions, ...kalshiPositions]);
      await maybeRunDatabaseMaintenance(now);
    },
  };
}

async function refreshBalances(settings: StrategyConfig, now: number): Promise<VenueBalance[]> {
  const balances = await Promise.allSettled([polymarketAdapter.getBalance(), kalshiAdapter.getBalance()]);
  const mapped = balances.map((result, index) => {
    const venue = index === 0 ? "polymarket" : "kalshi";
    if (result.status === "fulfilled") {
      const balance = result.value;
      if (venue === "polymarket" && balance.availableBalanceUsd < settings.polyBridgeLowWaterUsdc) {
        balance.notes = [...balance.notes, "USDC disponible sous le seuil bridge configuré."];
      }
      return balance;
    }

    return {
      venue,
      capturedAt: now,
      status: "blocked",
      currency: venue === "polymarket" ? "USDC" : "USD",
      availableBalanceUsd: 0,
      totalBalanceUsd: 0,
      portfolioValueUsd: 0,
      allowanceUsd: venue === "polymarket" ? 0 : null,
      notes: [toErrorMessage(result.reason)],
      raw: {},
    } as VenueBalance;
  });

  for (const balance of mapped) {
    await writeVenueBalance(balance);
  }

  return mapped;
}

async function computeReadiness(
  snapshot: OpportunitySnapshot | null,
  now: number,
): Promise<{ state: Partial<WorkerState>; breakers: Awaited<ReturnType<typeof readCircuitBreakers>> }> {
  const balances = await readVenueBalances();
  const slotKey = snapshot?.slotKey ?? null;
  const breakers = (await readCircuitBreakers()).filter(
    (breaker) => breaker.key === "global" || (slotKey !== null && breaker.key === `slot:${slotKey}`),
  );
  const checks = balances.map((balance) => ({
    key: `${balance.venue}:balance`,
    label: `${balance.venue} readiness`,
    status: balance.status,
    details: balance.notes.join(" | ") || "Venue ready",
    checkedAt: now,
  }));
  const feedHealth = snapshot ? [snapshot.polymarket.feedHealth, snapshot.kalshi.feedHealth] : [];
  checks.push(
    ...feedHealth.map((feed) => ({
      key: `${feed.venue}:market-data`,
      label: `${feed.venue} market data`,
      status: feed.feedStatus,
      details: [
        `source=${feed.source}`,
        feed.stalenessMs === null ? "staleness=na" : `staleness=${feed.stalenessMs}ms`,
        ...feed.details,
      ].join(" | "),
      checkedAt: now,
    })),
  );
  const activeBreakers = breakers.filter((breaker) => breaker.active);
  if (activeBreakers.length > 0) {
    checks.push({
      key: "circuit-breaker",
      label: "Circuit breaker",
      status: "blocked",
      details: activeBreakers.map((breaker) => `${breaker.key}:${breaker.reason}`).join(" | "),
      checkedAt: now,
    });
  }

  return {
    state: {
      readinessStatus: checks.some((check) => check.status === "blocked")
        ? "blocked"
        : checks.some((check) => check.status === "degraded")
          ? "degraded"
          : "ready",
      readiness: checks,
    },
    breakers,
  };
}

async function syncFeedCircuitBreaker(slot: MarketSlot, feedHealth: VenueFeedHealth[], now: number) {
  const key = `slot:${slot.key}` as const;
  const breakers = await readCircuitBreakers();
  for (const breaker of breakers) {
    if (breaker.active && breaker.key.startsWith("slot:") && breaker.key !== key) {
      await writeCircuitBreaker({
        key: breaker.key,
        active: false,
        reason: null,
        triggeredAt: null,
        payload: null,
      });
    }
  }
  const blockedFeeds = feedHealth.filter((feed) => feed.feedStatus === "blocked");

  if (blockedFeeds.length === 0) {
    await writeCircuitBreaker({
      key,
      active: false,
      reason: null,
      triggeredAt: null,
      payload: null,
    });
    return;
  }

  await writeCircuitBreaker({
    key,
    active: true,
    reason: "venue_error",
    triggeredAt: now,
    payload: {
      feeds: blockedFeeds.map((feed) => ({
        venue: feed.venue,
        source: feed.source,
        stalenessMs: feed.stalenessMs,
        details: feed.details,
      })),
    },
  });
}

async function executeIntent(intent: OrderIntent, settings: StrategyConfig, now: number) {
  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
  if (!primaryLeg || !hedgeLeg) {
    throw new Error(`Intent ${intent.id} missing legs`);
  }

  let currentIntent = markIntentStatus(intent, "executing_primary", now);
  await writeOrderIntent(currentIntent);

  const primaryRequest = buildVenueOrderRequest(primaryLeg, settings.maxSlippageBps, "FOK", false);
  const primarySubmission = await adapterFor(currentIntent.primaryVenue).placeOrder(primaryRequest);
  const primaryResult = await confirmImmediateOrderExecution(currentIntent.primaryVenue, primaryRequest, primarySubmission);
  const primaryOrder = buildLiveOrderRecord(currentIntent.id, primaryLeg, primaryRequest, primaryResult, now);
  await writeVenueOrder(primaryOrder);
  await writeRunEvent({
    level: "info",
    eventType: "order.primary.submitted",
    message: `Primary ${currentIntent.primaryVenue} order ${primaryOrder.venueOrderId}`,
    payload: {
      intentId: currentIntent.id,
      venue: currentIntent.primaryVenue,
    },
    createdAt: now,
  });

  currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "filled", now);
  if (currentIntent.primaryVenue === "polymarket") {
    currentIntent = await attachRecentPolymarketFills(currentIntent);
  }

  if (primaryResult.status !== "filled" || primaryOrder.filledSize <= 0) {
    currentIntent = markIntentStatus(
      currentIntent,
      "failed",
      now,
      `Primary order not authoritatively filled (${primaryResult.status})`,
    );
    await writeOrderIntent(currentIntent);
    await writeCircuitBreaker({
      key: `slot:${currentIntent.slotKey}`,
      active: true,
      reason: "venue_error",
      triggeredAt: now,
      payload: {
        intentId: currentIntent.id,
        venue: currentIntent.primaryVenue,
        stage: "primary_confirmation",
        orderId: primaryOrder.venueOrderId,
      },
    });
    return currentIntent;
  }

  currentIntent = markIntentStatus(currentIntent, "hedging", Date.now());
  await writeOrderIntent(currentIntent);

  const hedgeRequest = buildVenueOrderRequest(hedgeLeg, settings.maxSlippageBps, "FOK", false);
  const hedgeSubmission = await adapterFor(currentIntent.hedgeVenue).placeOrder(hedgeRequest);
  const hedgeResult = await confirmImmediateOrderExecution(currentIntent.hedgeVenue, hedgeRequest, hedgeSubmission);
  const hedgeOrder = buildLiveOrderRecord(currentIntent.id, hedgeLeg, hedgeRequest, hedgeResult, Date.now());
  await writeVenueOrder(hedgeOrder);

  if (currentIntent.hedgeVenue === "polymarket") {
    currentIntent = await attachRecentPolymarketFills(currentIntent);
  }

  if (hedgeResult.status === "filled" && hedgeOrder.filledSize > 0) {
    currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "hedged", Date.now());
    currentIntent = markIntentStatus(currentIntent, "hedged", Date.now());
    await writeOrderIntent(currentIntent);
    return currentIntent;
  }

  currentIntent = markIntentStatus(currentIntent, "unwind_required", Date.now(), "Hedge order failed");
  await writeOrderIntent(currentIntent);

  const unwindResult = await unwindPrimaryLeg(currentIntent, settings.maxSlippageBps);
  currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, unwindResult, "unwound", Date.now());
  currentIntent = markIntentStatus(currentIntent, "unwound", Date.now(), "Hedge failed, primary unwound");
  await writeOrderIntent(currentIntent);
  await writeVenueOrder(unwindResult);
  await writeCircuitBreaker({
    key: `slot:${currentIntent.slotKey}`,
    active: true,
    reason: "hedge_failure",
    triggeredAt: Date.now(),
    payload: {
      intentId: currentIntent.id,
      venue: currentIntent.primaryVenue,
    },
  });

  return currentIntent;
}

async function executeShadowIntent(intent: OrderIntent, now: number) {
  let currentIntent = markIntentStatus(intent, "executing_primary", now);
  await writeOrderIntent(currentIntent);

  const primaryLeg = currentIntent.legs.find((leg) => leg.venue === currentIntent.primaryVenue);
  const hedgeLeg = currentIntent.legs.find((leg) => leg.venue === currentIntent.hedgeVenue);
  if (!primaryLeg || !hedgeLeg) {
    throw new Error(`Intent ${intent.id} missing legs for shadow execution`);
  }

  const primaryOrder = buildShadowOrder(currentIntent.id, primaryLeg, now, "primary");
  const hedgeOrder = buildShadowOrder(currentIntent.id, hedgeLeg, now + 1, "hedge");
  await writeVenueOrder(primaryOrder);
  await writeVenueOrder(hedgeOrder);
  await writeFill(buildShadowFill(currentIntent.id, primaryLeg, now, primaryOrder.venueOrderId));
  await writeFill(buildShadowFill(currentIntent.id, hedgeLeg, now + 1, hedgeOrder.venueOrderId));

  currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "filled", now);
  currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "hedged", now + 1);
  currentIntent = markIntentStatus(currentIntent, "hedged", now + 1);
  await writeOrderIntent(currentIntent);
  await writeRunEvent({
    level: "info",
    eventType: "intent.shadow.executed",
    message: `Shadow intent ${currentIntent.id} executed without venue submission`,
    payload: {
      slotKey: currentIntent.slotKey,
      primaryVenue: currentIntent.primaryVenue,
    },
    createdAt: now,
  });

  return currentIntent;
}

async function attachRecentPolymarketFills(intent: OrderIntent) {
  const trades = await fetchPolymarketTrades();
  const orderIds = new Set(
    intent.legs
      .filter((leg) => leg.venue === "polymarket" && leg.venueOrderId)
      .map((leg) => leg.venueOrderId as string),
  );
  const matching = trades.filter(
    (trade) =>
      orderIds.has(trade.taker_order_id) || trade.maker_orders.some((makerOrder) => orderIds.has(makerOrder.order_id)),
  );

  for (const trade of matching) {
    await writeFill(mapPolymarketTradeToFill(trade, intent.id));
  }

  intent = (await syncIntentFromStoredVenueFills(intent.id, "polymarket", intent)) ?? intent;
  await writeOrderIntent(intent);
  return intent;
}

async function unwindPrimaryLeg(intent: OrderIntent, maxSlippageBps: number) {
  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  if (!primaryLeg || primaryLeg.filledSize <= 0) {
    throw new Error(`Unable to unwind intent ${intent.id}: no primary fill`);
  }

  const request = buildVenueOrderRequest(
    {
      ...primaryLeg,
      requestedPrice:
        primaryLeg.filledPrice === null ? primaryLeg.requestedPrice : primaryLeg.filledPrice * 0.99,
      side: "SELL",
      requestedSize: primaryLeg.filledSize,
      requestedNotionalUsd: primaryLeg.filledSize * (primaryLeg.filledPrice ?? primaryLeg.requestedPrice ?? 0),
    },
    maxSlippageBps,
    primaryLeg.venue === "polymarket" ? "FAK" : "IOC",
    true,
  );
  const submission = await adapterFor(primaryLeg.venue).placeOrder(request);
  const result = await confirmImmediateOrderExecution(primaryLeg.venue, request, submission);
  return buildLiveOrderRecord(intent.id, { ...primaryLeg, side: "SELL" }, request, result, Date.now());
}

async function reconcileVenueOrders(now: number) {
  const [recentOrders, polyOpenOrders, kalshiOrders, polyTrades, kalshiFills] = await Promise.all([
    readRecentVenueOrders(200),
    fetchPolymarketOpenOrders().catch(() => []),
    fetchKalshiOrders().catch(() => []),
    fetchPolymarketTrades().catch(() => []),
    fetchKalshiFills().catch(() => []),
  ]);
  const touchedIntentLegs = new Set<string>();

  for (const order of polyOpenOrders) {
    const existing = await findVenueOrder("polymarket", order.id);
    if (!existing) {
      continue;
    }
    await writeVenueOrder({
      ...mapPolymarketOrder(order, existing.intentId),
      intentId: existing.intentId,
      id: existing.id,
    });
  }

  for (const order of kalshiOrders) {
    const existing = await findVenueOrder("kalshi", order.order_id);
    if (!existing) {
      continue;
    }
    await writeVenueOrder({
      ...existing,
      status: order.status === "executed" ? "filled" : existing.status,
      filledSize: Number(order.fill_count_fp ?? existing.filledSize),
      averageFillPrice: Number(order.yes_price_dollars ?? order.no_price_dollars ?? existing.averageFillPrice ?? 0),
      feeUsd: Number(order.taker_fees_dollars ?? order.maker_fees_dollars ?? existing.feeUsd ?? 0),
      updatedAt: now,
      raw: order as unknown as Record<string, unknown>,
    });
  }

  for (const trade of polyTrades) {
    const existingOrder = recentOrders.find(
      (order) =>
        order.venue === "polymarket" &&
        (order.venueOrderId === trade.taker_order_id ||
          trade.maker_orders.some((makerOrder) => makerOrder.order_id === order.venueOrderId)),
    );
    if (!existingOrder) {
      continue;
    }

    await writeFill(mapPolymarketTradeToFill(trade, existingOrder.intentId));
    touchedIntentLegs.add(`${existingOrder.intentId}:polymarket`);
  }

  for (const fill of kalshiFills) {
    const existingOrder = recentOrders.find(
      (order) => order.venue === "kalshi" && order.venueOrderId === fill.order_id,
    );
    if (!existingOrder) {
      continue;
    }

    await writeFill({
      id: `kalshi-fill:${fill.trade_id}`,
      shadow: false,
      intentId: existingOrder.intentId,
      venue: "kalshi",
      venueOrderId: fill.order_id,
      tradeId: fill.trade_id,
      marketRef: fill.market_ticker,
      side: fill.action === "sell" ? "SELL" : "BUY",
      outcome: fill.side === "yes" ? "YES" : "NO",
      price: getKalshiFillPriceUsd(fill) ?? 0,
      size: Number(fill.count_fp),
      feeUsd: getKalshiFillFeeUsd(fill),
      liquidity: fill.is_taker ? "TAKER" : "MAKER",
      filledAt: fill.created_time ? Date.parse(fill.created_time) : now,
      raw: fill as unknown as Record<string, unknown>,
    });
    touchedIntentLegs.add(`${existingOrder.intentId}:kalshi`);
  }

  for (const entry of touchedIntentLegs) {
    const [intentId, venue] = entry.split(":") as [string, "polymarket" | "kalshi"];
    await syncIntentFromStoredVenueFills(intentId, venue);
  }
}

async function reconcileSettlements(now: number) {
  const openIntents = await readOpenOrderIntents();
  const settledCandidates = openIntents.filter(
    (intent) => intent.status === "hedged" && intent.slotEndTs + RESOLUTION_GRACE_MS <= now,
  );

  for (const intent of settledCandidates) {
    let referenceResolution: "UP" | "DOWN" | null = null;
    try {
      referenceResolution = await fetchBtcSlotResolution(intent.slotStartTs, intent.slotEndTs);
    } catch {
      referenceResolution = null;
    }

    const polyResolution =
      referenceResolution ??
      (await fetchPolymarketResolution(`btc-updown-15m-${Math.floor(intent.slotStartTs / 1000)}`));
    const kalshiLeg = intent.legs.find((leg) => leg.venue === "kalshi");
    const kalshiResolution =
      referenceResolution === null
        ? kalshiLeg?.marketRef
          ? await fetchKalshiResolution(kalshiLeg.marketRef)
          : null
        : toKalshiResolution(referenceResolution);

    if (!polyResolution || !kalshiResolution) {
      continue;
    }

    const payoutUsd = calculateWinningPayout(intent.legs, polyResolution, kalshiResolution);
    const settled = finalizeIntent({
      intent,
      polyResolution,
      kalshiResolution,
      payoutUsd,
      now,
    });
    await writeOrderIntent(settled);
    for (const leg of settled.legs) {
      const resolvedOutcome = leg.venue === "polymarket" ? polyResolution : kalshiResolution;
      await writeSettlement({
        id: `${settled.id}:${leg.venue}:${leg.marketRef}:${leg.outcome}`,
        intentId: settled.id,
        venue: leg.venue,
        marketRef: leg.marketRef,
        outcome: leg.outcome,
        resolvedOutcome,
        payoutUsd: leg.outcome === resolvedOutcome ? leg.filledSize : 0,
        settledAt: now,
        raw: {
          slotKey: settled.slotKey,
          filledSize: leg.filledSize,
          filledPrice: leg.filledPrice,
          polyResolution,
          kalshiResolution,
        },
      });
    }
  }
}

async function refreshPnl(now: number, positions: PositionSnapshot[]) {
  const balances = await readVenueBalances();
  const cashUsd = balances.reduce((sum, balance) => sum + balance.availableBalanceUsd, 0);
  const positionsValueUsd = positions.reduce((sum, position) => sum + position.currentValueUsd, 0);
  const realizedPnlUsd = positions.reduce((sum, position) => sum + position.realizedPnlUsd, 0);
  const unrealizedPnlUsd = positions.reduce((sum, position) => sum + position.unrealizedPnlUsd, 0);
  const recentFills = await readRecentFills(200);
  const feesUsd = recentFills.reduce((sum, fill) => sum + fill.feeUsd, 0);

  await writePnlSnapshot({
    capturedAt: now,
    cashUsd,
    equityUsd: balances.reduce((sum, balance) => sum + balance.totalBalanceUsd, 0),
    positionsValueUsd,
    realizedPnlUsd,
    unrealizedPnlUsd,
    feesUsd,
    venueBreakdown: balances,
  });
}

function buildVenueOrderRequest(
  leg: OrderIntent["legs"][number],
  maxSlippageBps: number,
  orderType: "FOK" | "IOC" | "FAK",
  reduceOnly: boolean,
): VenueOrderRequest {
  return {
    marketRef: leg.marketRef,
    tokenId: leg.tokenId,
    outcome: leg.outcome,
    side: leg.side,
    size: leg.requestedSize,
    price: leg.requestedPrice === null ? null : applySlippage(leg.requestedPrice, maxSlippageBps),
    maxCostUsd: leg.requestedNotionalUsd * (1 + maxSlippageBps / 10_000),
    orderType,
    reduceOnly,
    clientOrderId: crypto.randomUUID(),
  };
}

function buildLiveOrderRecord(
  intentId: string,
  leg: OrderIntent["legs"][number] & { side?: "BUY" | "SELL" },
  request: VenueOrderRequest,
  result: Awaited<ReturnType<VenueAdapter["placeOrder"]>>,
  now: number,
): LiveOrder {
  return {
    id: `${result.venue}:${result.venueOrderId}`,
    shadow: false,
    intentId,
    venue: result.venue,
    venueOrderId: result.venueOrderId,
    clientOrderId: request.clientOrderId,
    marketRef: request.marketRef,
    tokenId: request.tokenId,
    side: request.side,
    outcome: leg.outcome,
    orderType: request.orderType,
    requestedPrice: request.price,
    requestedSize: request.size,
    filledSize: result.filledSize,
    averageFillPrice: result.averageFillPrice,
    feeUsd: result.feeUsd,
    status: result.status,
    createdAt: now,
    updatedAt: now,
    raw: result.raw,
  };
}

function buildShadowOrder(
  intentId: string,
  leg: OrderIntent["legs"][number],
  now: number,
  suffix: string,
): LiveOrder {
  return {
    id: `shadow:${intentId}:${leg.venue}:${suffix}`,
    shadow: true,
    intentId,
    venue: leg.venue,
    venueOrderId: `shadow-${suffix}-${intentId}-${leg.venue}`,
    clientOrderId: `shadow-${suffix}-${intentId}`,
    marketRef: leg.marketRef,
    tokenId: leg.tokenId,
    side: leg.side,
    outcome: leg.outcome,
    orderType: "SHADOW",
    requestedPrice: leg.requestedPrice,
    requestedSize: leg.requestedSize,
    filledSize: leg.requestedSize,
    averageFillPrice: leg.requestedPrice,
    feeUsd: leg.feeUsd > 0 ? leg.feeUsd : deriveLegFeeEstimate(leg),
    status: "filled",
    createdAt: now,
    updatedAt: now,
    raw: {
      shadow: true,
    },
  };
}

function buildShadowFill(
  intentId: string,
  leg: OrderIntent["legs"][number],
  now: number,
  venueOrderId: string,
) {
  return {
    id: `shadow-fill:${intentId}:${leg.venue}:${leg.outcome}:${now}`,
    shadow: true,
    intentId,
    venue: leg.venue,
    venueOrderId,
    tradeId: `shadow-trade:${intentId}:${leg.venue}:${now}`,
    marketRef: leg.marketRef,
    tokenId: leg.tokenId,
    side: leg.side,
    outcome: leg.outcome,
    price: leg.requestedPrice ?? 0,
    size: leg.requestedSize,
    feeUsd: deriveLegFeeEstimate(leg),
    liquidity: "TAKER" as const,
    filledAt: now,
    raw: {
      shadow: true,
    },
  };
}

function deriveLegFeeEstimate(leg: OrderIntent["legs"][number]) {
  return round4(leg.requestedNotionalUsd * 0.001);
}

function updateIntentLeg(
  intent: OrderIntent,
  venue: OrderIntent["legs"][number]["venue"],
  order: LiveOrder,
  status: OrderIntent["legs"][number]["status"],
  now: number,
) {
  return {
    ...intent,
    updatedAt: now,
    legs: intent.legs.map((leg) =>
      leg.venue === venue
        ? {
            ...leg,
            venueOrderId: order.venueOrderId,
            filledSize: order.filledSize || leg.filledSize,
            filledPrice: order.averageFillPrice ?? leg.filledPrice,
            feeUsd: order.feeUsd ?? leg.feeUsd,
            status,
          }
        : leg,
    ) as OrderIntent["legs"],
  };
}

function updateIntentLegFromFillSummary(
  intent: OrderIntent,
  venue: OrderIntent["legs"][number]["venue"],
  summary: ReturnType<typeof summarizeVenueFills>,
  now: number,
) {
  return {
    ...intent,
    updatedAt: now,
    legs: intent.legs.map((leg) =>
      leg.venue === venue
        ? {
            ...leg,
            venueOrderId: summary.venueOrderId ?? leg.venueOrderId,
            filledSize: summary.filledSize,
            filledPrice: summary.averageFillPrice,
            feeUsd: summary.feeUsd,
            status:
              leg.status === "unwound"
                ? "unwound"
                : leg.status === "hedged"
                  ? "hedged"
                  : summary.filledSize > 0
                    ? "filled"
                    : leg.status,
          }
        : leg,
    ) as OrderIntent["legs"],
  };
}

async function syncIntentFromStoredVenueFills(
  intentId: string,
  venue: OrderIntent["legs"][number]["venue"],
  currentIntent?: OrderIntent,
) {
  const intent = currentIntent ?? (await findOrderIntent(intentId));
  if (!intent) {
    return currentIntent ?? null;
  }

  const fills = await readFillsForIntentVenue(intentId, venue);
  if (fills.length === 0) {
    return intent;
  }

  const updatedIntent = updateIntentLegFromFillSummary(intent, venue, summarizeVenueFills(fills), Date.now());
  await writeOrderIntent(updatedIntent);
  return updatedIntent;
}

async function confirmImmediateOrderExecution(
  venue: OrderIntent["primaryVenue"],
  request: VenueOrderRequest,
  submission: Awaited<ReturnType<VenueAdapter["placeOrder"]>>,
) {
  if (submission.status === "rejected" || submission.status === "canceled" || submission.status === "expired") {
    return submission;
  }

  if (venue === "polymarket") {
    const confirmation = await confirmPolymarketOrderExecution({
      orderId: submission.venueOrderId,
      expectedSize: request.size,
      timeoutMs: IMMEDIATE_ORDER_CONFIRMATION_TIMEOUT_MS,
    });
    return confirmation.result;
  }

  if (submission.status !== "live" && submission.status !== "pending" && submission.status !== "partially_filled") {
    return submission;
  }

  const deadline = Date.now() + IMMEDIATE_ORDER_CONFIRMATION_TIMEOUT_MS;
  let latest = submission;
  while (Date.now() <= deadline) {
    const liveOrder = await kalshiAdapter.getOrder(submission.venueOrderId).catch(() => null);
    if (liveOrder) {
      latest = normalizeOrderResultFromLiveOrder(liveOrder, submission.raw);
      if (latest.status !== "live" && latest.status !== "pending") {
        return latest;
      }
    }
    await sleep(200);
  }

  return latest;
}

function normalizeOrderResultFromLiveOrder(
  order: LiveOrder,
  fallbackRaw: Record<string, unknown>,
): Awaited<ReturnType<VenueAdapter["placeOrder"]>> {
  return {
    venue: order.venue,
    venueOrderId: order.venueOrderId,
    status: order.status,
    filledSize: order.filledSize,
    averageFillPrice: order.averageFillPrice,
    feeUsd: order.feeUsd ?? 0,
    raw: order.raw ?? fallbackRaw,
  };
}

function adapterFor(venue: OrderIntent["primaryVenue"]) {
  return venue === "polymarket" ? polymarketAdapter : kalshiAdapter;
}

function wouldExceedVenueExposure(
  intent: OrderIntent,
  exposureUsd: Record<"polymarket" | "kalshi", number>,
  maxVenueExposureUsd: number,
) {
  return intent.legs.some((leg) => exposureUsd[leg.venue] + leg.requestedNotionalUsd > maxVenueExposureUsd + 1e-9);
}

async function refreshLatestSnapshot(slot: MarketSlot) {
  return readLatestSnapshot(slot.key);
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Erreur inconnue";
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function maybeRunDatabaseMaintenance(now: number) {
  const config = readDatabaseMaintenanceConfig();
  if (
    lastDatabaseMaintenanceAttemptAt !== null &&
    now - lastDatabaseMaintenanceAttemptAt < config.intervalMs
  ) {
    return;
  }

  lastDatabaseMaintenanceAttemptAt = now;

  try {
    const summary = await runDatabaseMaintenance(config, now);
    const deletedEntries = Object.entries(summary.deleted).filter(([, count]) => count > 0);
    if (deletedEntries.length === 0) {
      return;
    }

    await writeRunEvent({
      level: "info",
      eventType: "db.maintenance.completed",
      message: `Database retention cleanup deleted ${deletedEntries.reduce((sum, [, count]) => sum + count, 0)} rows`,
      payload: {
        deleted: Object.fromEntries(deletedEntries),
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
      },
      createdAt: Date.now(),
    });
  } catch (error) {
    await writeRunEvent({
      level: "warn",
      eventType: "db.maintenance.failed",
      message: error instanceof Error ? error.message : "Database retention cleanup failed",
      payload: null,
      createdAt: Date.now(),
    }).catch(() => undefined);
  }
}
