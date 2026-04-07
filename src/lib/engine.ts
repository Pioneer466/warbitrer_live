import { fetchBtcSlotResolution, toKalshiResolution } from "@/lib/btc-resolution";
import { readDatabaseMaintenanceConfig } from "@/lib/db-maintenance";
import { applySlippage, deriveTargetShares } from "@/lib/fees";
import {
  createKalshiAdapter,
  fetchKalshiFills,
  fetchKalshiOrders,
  fetchKalshiResolution,
  getKalshiFillFeeUsd,
  getKalshiFillPriceUsd,
  mapKalshiOrderStatus,
  normalizeKalshiOrderPrice,
} from "@/lib/kalshi";
import { getMarketDataSupervisor } from "@/lib/market-data";
import {
  confirmPolymarketOrderExecution,
  createPolymarketAdapter,
  extractPolymarketTradesForOrder,
  fetchPolymarketOpenOrders,
  fetchPolymarketResolution,
  fetchPolymarketTrades,
  isConfirmedPolymarketTrade,
  isPendingPolymarketTrade,
  mapPolymarketOrder,
  mapPolymarketTradeToFill,
  summarizePolymarketTrades,
} from "@/lib/polymarket";
import { autoConvertPolymarketIfConfigured } from "@/lib/recovery";
import { calculateVenueExposureUsd, countSlotExecutionBlockers } from "@/lib/risk";
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
  readRecentOrderIntents,
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
const IN_FLIGHT_INTENT_STALE_MS = 15_000;
const LATE_PRIMARY_FILL_RESCUE_WINDOW_MS = 15 * 60 * 1000;
const ORDER_SIZE_TOLERANCE = 1e-6;

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
      const openIntents = await readOpenOrderIntents();
      const resumed = await resumeInFlightIntents(
        openIntents.filter((intent) => intent.slotEndTs > now),
        slot,
        settings,
        now,
      );

      await writeWorkerState({
        readinessStatus: readiness.state.readinessStatus,
        readiness: readiness.state.readiness,
      });

      if (!settings.enableTrading || activeBreakers.length > 0) {
        return resumed;
      }

      if (!settings.shadowMode && readiness.state.readinessStatus !== "ready") {
        return resumed;
      }

      if (!snapshot) {
        return resumed;
      }

      const blockingOpenForSlot = countSlotExecutionBlockers(openIntents, slot.key);
      if (blockingOpenForSlot >= settings.maxOpenIntentsPerSlot) {
        return resumed;
      }

      const eligible = snapshot.opportunities.filter((opportunity) => opportunity.eligible);
      const created: OrderIntent[] = [...resumed];
      const positions = await readPositions();
      const exposureUsd = calculateVenueExposureUsd(positions, openIntents);

      for (const opportunity of eligible.slice(0, settings.maxOpenIntentsPerSlot - blockingOpenForSlot)) {
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
          : await executeIntent(intent, slot, settings, now);
        created.push(executed);
      }

      return created;
    },

    async reconcile(slot, now) {
      const [polyPositions, kalshiPositions] = await Promise.all([
        polymarketAdapter.getPositions(now),
        kalshiAdapter.getPositions(now),
      ]);

      const reconcileErrors: string[] = [];
      const allPositions = [...polyPositions, ...kalshiPositions];

      reconcileErrors.push(
        ...(await runReconcileStep("replace_positions", now, async () => {
          await Promise.all([
            replaceVenuePositions("polymarket", polyPositions),
            replaceVenuePositions("kalshi", kalshiPositions),
          ]);
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("auto_convert_polymarket", now, async () => {
          await autoConvertPolymarketIfConfigured(polyPositions, now);
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("reconcile_venue_orders", now, async () => {
          await reconcileVenueOrders(now);
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("reconcile_inflight_intents", now, async () => {
          await reconcileInFlightIntentStates(now);
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("reconcile_settlements", now, async () => {
          await reconcileSettlements(settings, now);
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("refresh_pnl", now, async () => {
          await refreshPnl(now, allPositions);
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("database_maintenance", now, async () => {
          await maybeRunDatabaseMaintenance(now);
        })),
      );

      if (reconcileErrors.length > 0) {
        throw new Error(reconcileErrors.join(" | "));
      }
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

async function executeIntent(intent: OrderIntent, slot: MarketSlot, settings: StrategyConfig, now: number) {
  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
  if (!primaryLeg || !hedgeLeg) {
    throw new Error(`Intent ${intent.id} missing legs`);
  }

  let currentIntent = markIntentStatus(intent, "executing_primary", now);
  await writeOrderIntent(currentIntent);

  const primaryRequest = buildVenueOrderRequest(primaryLeg, settings.maxSlippageBps, "FOK", false);
  let primaryResult: Awaited<ReturnType<VenueAdapter["placeOrder"]>>;
  let primaryOrder: LiveOrder;
  try {
    const primarySubmission = await adapterFor(currentIntent.primaryVenue).placeOrder(primaryRequest);
    primaryResult = await confirmImmediateOrderExecution(
      currentIntent.primaryVenue,
      primaryRequest,
      primarySubmission,
      settings.immediateOrderConfirmationTimeoutMs,
    );
    primaryOrder = buildLiveOrderRecord(currentIntent.id, primaryLeg, primaryRequest, primaryResult, now);
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
  } catch (error) {
    const recovered = await recoverKalshiOrderSubmissionForIntent(
      currentIntent,
      primaryLeg,
      primaryRequest,
      now,
      "primary",
    );
    if (!recovered) {
      currentIntent = markIntentStatus(
        currentIntent,
        "failed",
        now,
        `Primary submission failed (${toErrorMessage(error)})`,
      );
      await writeOrderIntent(currentIntent);
      await writeRunEvent({
        level: "error",
        eventType: "order.primary.submit_failed",
        message: `Primary ${currentIntent.primaryVenue} submission failed for intent ${currentIntent.id}`,
        payload: {
          intentId: currentIntent.id,
          venue: currentIntent.primaryVenue,
          clientOrderId: primaryRequest.clientOrderId,
          error: toErrorMessage(error),
        },
        createdAt: now,
      });
      await writeCircuitBreaker({
        key: `slot:${currentIntent.slotKey}`,
        active: true,
        reason: "venue_error",
        triggeredAt: now,
        payload: {
          intentId: currentIntent.id,
          venue: currentIntent.primaryVenue,
          stage: "primary_submission",
        },
      });
      return currentIntent;
    }

    primaryResult = recovered.result;
    primaryOrder = recovered.order;
  }

  if (primaryResult.status === "filled" && primaryOrder.filledSize > 0) {
    currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "filled", now);
    currentIntent = markIntentStatus(currentIntent, "primary_filled", now);
    await writeOrderIntent(currentIntent);

    if (currentIntent.primaryVenue === "polymarket") {
      currentIntent = await attachRecentPolymarketFillsSafely(currentIntent, "primary", now);
    }

    return executeHedgeLeg(currentIntent, slot, settings, now);
  }

  if (primaryOrder.filledSize > 0) {
    currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "failed", now);
    currentIntent = markIntentStatus(
      currentIntent,
      "failed",
      now,
      `Primary order partially filled or not final (${primaryResult.status}); manual intervention required`,
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

  if (isTerminalOrderStatus(primaryResult.status)) {
    const retried = await retryLegWithinExecutionBuffer(currentIntent, primaryLeg, slot, settings, now, "primary");
    if (retried) {
      currentIntent = retried.intent;
      primaryResult = retried.result;
      primaryOrder = retried.order;
      if (primaryResult.status === "filled" && primaryOrder.filledSize > 0) {
        currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "filled", now);
        currentIntent = markIntentStatus(currentIntent, "primary_filled", now);
        await writeOrderIntent(currentIntent);

        if (currentIntent.primaryVenue === "polymarket") {
          currentIntent = await attachRecentPolymarketFillsSafely(currentIntent, "primary", now);
        }

        return executeHedgeLeg(currentIntent, slot, settings, now);
      }

      if (primaryOrder.filledSize > 0) {
        currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "failed", now);
        currentIntent = markIntentStatus(
          currentIntent,
          "failed",
          now,
          `Primary retry partially filled or not final (${primaryResult.status}); manual intervention required`,
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
            stage: "primary_retry_confirmation",
            orderId: primaryOrder.venueOrderId,
          },
        });
        return currentIntent;
      }
    }
  }

  if (isTerminalOrderStatus(primaryResult.status)) {
    currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "failed", now);
    currentIntent = markIntentStatus(
      currentIntent,
      "failed",
      now,
      describeTerminalNoFill("Primary", primaryResult),
    );
    await writeOrderIntent(currentIntent);
    if (shouldTripBreakerForTerminalNoFill(primaryResult)) {
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
    } else {
      await writeRunEvent({
        level: "warn",
        eventType: "intent.failed.primary_no_fill",
        message: `Intent ${currentIntent.id} closed after primary order was killed without fill`,
        payload: {
          intentId: currentIntent.id,
          venue: currentIntent.primaryVenue,
          orderId: primaryOrder.venueOrderId,
          orderStatus: primaryResult.status,
          detail: extractTerminalNoFillDetail(primaryResult),
        },
        createdAt: now,
      });
    }
    return currentIntent;
  }

  currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "submitted", now);
  await writeOrderIntent(currentIntent);
  await writeRunEvent({
    level: "info",
    eventType: "order.primary.awaiting_confirmation",
    message: `Primary ${currentIntent.primaryVenue} order ${primaryOrder.venueOrderId} awaiting authoritative confirmation`,
    payload: {
      intentId: currentIntent.id,
      venue: currentIntent.primaryVenue,
      orderId: primaryOrder.venueOrderId,
      orderStatus: primaryResult.status,
    },
    createdAt: now,
  });
  return currentIntent;
}

async function executeHedgeLeg(intent: OrderIntent, slot: MarketSlot, settings: StrategyConfig, now: number) {
  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
  if (!primaryLeg || !hedgeLeg) {
    throw new Error(`Intent ${intent.id} missing legs for hedge execution`);
  }

  let currentIntent = markIntentStatus(intent, "hedging", now);
  await writeOrderIntent(currentIntent);

  const hedgeRequest = buildVenueOrderRequest(hedgeLeg, settings.maxSlippageBps, "FOK", false);
  let hedgeResult: Awaited<ReturnType<VenueAdapter["placeOrder"]>>;
  let hedgeOrder: LiveOrder;
  try {
    const hedgeSubmission = await adapterFor(currentIntent.hedgeVenue).placeOrder(hedgeRequest);
    hedgeResult = await confirmImmediateOrderExecution(
      currentIntent.hedgeVenue,
      hedgeRequest,
      hedgeSubmission,
      settings.immediateOrderConfirmationTimeoutMs,
    );
    hedgeOrder = buildLiveOrderRecord(currentIntent.id, hedgeLeg, hedgeRequest, hedgeResult, now);
    await writeVenueOrder(hedgeOrder);
    await writeRunEvent({
      level: "info",
      eventType: "order.hedge.submitted",
      message: `Hedge ${currentIntent.hedgeVenue} order ${hedgeOrder.venueOrderId}`,
      payload: {
        intentId: currentIntent.id,
        venue: currentIntent.hedgeVenue,
      },
      createdAt: now,
    });
  } catch (error) {
    const recovered = await recoverKalshiOrderSubmissionForIntent(
      currentIntent,
      hedgeLeg,
      hedgeRequest,
      now,
      "hedge",
    );
    if (!recovered) {
      await writeRunEvent({
        level: "error",
        eventType: "order.hedge.submit_failed",
        message: `Hedge ${currentIntent.hedgeVenue} submission failed for intent ${currentIntent.id}`,
        payload: {
          intentId: currentIntent.id,
          venue: currentIntent.hedgeVenue,
          clientOrderId: hedgeRequest.clientOrderId,
          error: toErrorMessage(error),
        },
        createdAt: now,
      });
      return attemptPrimaryUnwindAfterHedgeFailure(
        currentIntent,
        primaryLeg,
        hedgeLeg,
        null,
        settings.maxSlippageBps,
        settings.immediateOrderConfirmationTimeoutMs,
        now,
        `Hedge submission failed (${toErrorMessage(error)})`,
      );
    }

    hedgeResult = recovered.result;
    hedgeOrder = recovered.order;
  }

  if (hedgeResult.status === "filled" && hedgeOrder.filledSize > 0) {
    if (currentIntent.hedgeVenue === "polymarket") {
      currentIntent = await attachRecentPolymarketFillsSafely(currentIntent, "hedge", now);
    }
    currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "hedged", now);
    currentIntent = markIntentStatus(currentIntent, "hedged", now);
    await writeOrderIntent(currentIntent);
    return currentIntent;
  }

  if (hedgeOrder.filledSize > 0) {
    currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "failed", now);
    currentIntent = markIntentStatus(
      currentIntent,
      "failed",
      now,
      `Hedge order partially filled or not final (${hedgeResult.status}); manual intervention required`,
    );
    await writeOrderIntent(currentIntent);
    await writeCircuitBreaker({
      key: `slot:${currentIntent.slotKey}`,
      active: true,
      reason: "hedge_failure",
      triggeredAt: now,
      payload: {
        intentId: currentIntent.id,
        venue: currentIntent.hedgeVenue,
        stage: "hedge_partial_fill",
        orderId: hedgeOrder.venueOrderId,
      },
    });
    return currentIntent;
  }

  if (isTerminalOrderStatus(hedgeResult.status)) {
    const retried = await retryLegWithinExecutionBufferWithAttempts(
      currentIntent,
      hedgeLeg,
      slot,
      settings,
      now,
      "hedge",
      settings.hedgeRetryAttempts,
      settings.hedgeRetryDelayMs,
    );
    if (retried) {
      currentIntent = retried.intent;
      hedgeResult = retried.result;
      hedgeOrder = retried.order;

      if (hedgeResult.status === "filled" && hedgeOrder.filledSize > 0) {
        if (currentIntent.hedgeVenue === "polymarket") {
          currentIntent = await attachRecentPolymarketFillsSafely(currentIntent, "hedge", now);
        }
        currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "hedged", now);
        currentIntent = markIntentStatus(currentIntent, "hedged", now);
        await writeOrderIntent(currentIntent);
        return currentIntent;
      }

      if (hedgeOrder.filledSize > 0) {
        currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "failed", now);
        currentIntent = markIntentStatus(
          currentIntent,
          "failed",
          now,
          `Hedge retry partially filled or not final (${hedgeResult.status}); manual intervention required`,
        );
        await writeOrderIntent(currentIntent);
        await writeCircuitBreaker({
          key: `slot:${currentIntent.slotKey}`,
          active: true,
          reason: "hedge_failure",
          triggeredAt: now,
          payload: {
            intentId: currentIntent.id,
            venue: currentIntent.hedgeVenue,
            stage: "hedge_retry_partial_fill",
            orderId: hedgeOrder.venueOrderId,
          },
        });
        return currentIntent;
      }
    }
  }

  if (!isTerminalOrderStatus(hedgeResult.status)) {
    currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "submitted", now);
    await writeOrderIntent(currentIntent);
    await writeRunEvent({
      level: "info",
      eventType: "order.hedge.awaiting_confirmation",
      message: `Hedge ${currentIntent.hedgeVenue} order ${hedgeOrder.venueOrderId} awaiting authoritative confirmation`,
      payload: {
        intentId: currentIntent.id,
        venue: currentIntent.hedgeVenue,
        orderId: hedgeOrder.venueOrderId,
        orderStatus: hedgeResult.status,
      },
      createdAt: now,
    });
    return currentIntent;
  }

  return attemptPrimaryUnwindAfterHedgeFailure(
    currentIntent,
    primaryLeg,
    hedgeLeg,
    hedgeOrder,
    settings.maxSlippageBps,
    settings.immediateOrderConfirmationTimeoutMs,
    now,
    "Hedge order failed",
  );
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
  const polymarketLegs = intent.legs.filter((leg) => leg.venue === "polymarket" && leg.venueOrderId);
  for (const leg of polymarketLegs) {
    const orderId = leg.venueOrderId as string;
    const matching = extractPolymarketTradesForOrder(trades, orderId).filter(isConfirmedPolymarketTrade);
    for (const trade of matching) {
      await writePolymarketFillSafely(trade, intent.id, orderId, "intent_sync");
    }
  }

  intent = (await syncIntentFromStoredVenueFills(intent.id, "polymarket", intent)) ?? intent;
  await writeOrderIntent(intent);
  return intent;
}

async function attachRecentPolymarketFillsSafely(
  intent: OrderIntent,
  stage: "primary" | "hedge",
  now: number,
) {
  try {
    return await attachRecentPolymarketFills(intent);
  } catch (error) {
    await writeRunEvent({
      level: "warn",
      eventType: "fills.polymarket.sync_failed",
      message: `Polymarket fill sync failed during ${stage} for intent ${intent.id}`,
      payload: {
        intentId: intent.id,
        stage,
        error: toErrorMessage(error),
      },
      createdAt: now,
    });
    return intent;
  }
}

async function resumeInFlightIntents(intents: OrderIntent[], slot: MarketSlot, settings: StrategyConfig, now: number) {
  const recentOrders = await readRecentVenueOrders(200);
  const resumed: OrderIntent[] = [];

  for (const intent of intents) {
    if (intent.status !== "executing_primary" && intent.status !== "primary_filled") {
      continue;
    }

    const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
    const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
    if (!primaryLeg || !hedgeLeg) {
      continue;
    }

    let currentIntent = intent;
    const primaryOrder = findLatestIntentOrderForLeg(recentOrders, intent.id, primaryLeg);
    if (!primaryOrder || primaryOrder.status !== "filled") {
      continue;
    }

    currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "filled", now);
    currentIntent = markIntentStatus(currentIntent, "primary_filled", now);
    await writeOrderIntent(currentIntent);

    if (currentIntent.primaryVenue === "polymarket") {
      currentIntent = await attachRecentPolymarketFillsSafely(currentIntent, "primary", now);
    }

    const latestHedgeOrder = findLatestIntentOrderForLeg(recentOrders, intent.id, hedgeLeg);
    if (latestHedgeOrder) {
      continue;
    }

    await writeRunEvent({
      level: "warn",
      eventType: "intent.resume.hedge",
      message: `Resuming hedge submission for intent ${intent.id}`,
      payload: {
        intentId: intent.id,
        slotKey: intent.slotKey,
      },
      createdAt: now,
    });

    resumed.push(await executeHedgeLeg(currentIntent, slot, settings, now));
  }

  return resumed;
}

async function unwindPrimaryLeg(intent: OrderIntent, maxSlippageBps: number, confirmationTimeoutMs: number) {
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
  const result = await confirmImmediateOrderExecution(primaryLeg.venue, request, submission, confirmationTimeoutMs);
  return buildLiveOrderRecord(intent.id, { ...primaryLeg, side: "SELL" }, request, result, Date.now());
}

async function retryLegWithinExecutionBuffer(
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
  stage: "primary" | "hedge",
) {
  if (settings.executionPriceBuffer <= 0) {
    return null;
  }

  const repricedIntent = await repriceIntentWithinExecutionBuffer(intent, slot, settings, now);
  if (!repricedIntent) {
    return null;
  }

  const repricedLeg = repricedIntent.legs.find((candidate) => candidate.id === leg.id);
  if (!repricedLeg) {
    return null;
  }

  await writeOrderIntent(repricedIntent);
  await writeRunEvent({
    level: "info",
    eventType: `order.${stage}.repriced`,
    message: `${stage === "primary" ? "Primary" : "Hedge"} leg repriced within execution buffer for intent ${intent.id}`,
    payload: {
      intentId: intent.id,
      venue: repricedLeg.venue,
      requestedPrice: repricedLeg.requestedPrice,
      requestedSize: repricedLeg.requestedSize,
      grossCost: repricedIntent.grossCost,
      executionPriceBuffer: settings.executionPriceBuffer,
    },
    createdAt: now,
  });

  const request = buildVenueOrderRequest(repricedLeg, settings.maxSlippageBps, "FOK", false);
  const submission = await adapterFor(repricedLeg.venue).placeOrder(request);
  const result = await confirmImmediateOrderExecution(
    repricedLeg.venue,
    request,
    submission,
    settings.immediateOrderConfirmationTimeoutMs,
  );
  const order = buildLiveOrderRecord(repricedIntent.id, repricedLeg, request, result, now);
  await writeVenueOrder(order);
  await writeRunEvent({
    level: "info",
    eventType: `order.${stage}.resubmitted`,
    message: `${stage === "primary" ? "Primary" : "Hedge"} ${repricedLeg.venue} order ${order.venueOrderId} resubmitted after reprice`,
    payload: {
      intentId: repricedIntent.id,
      venue: repricedLeg.venue,
      orderId: order.venueOrderId,
      orderStatus: result.status,
    },
    createdAt: now,
  });

  return {
    intent: repricedIntent,
    order,
    result,
  };
}

async function retryLegWithinExecutionBufferWithAttempts(
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
  stage: "primary" | "hedge",
  attempts: number,
  retryDelayMs: number,
) {
  if (attempts <= 0) {
    return null;
  }

  let currentIntent = intent;
  let lastResult: Awaited<ReturnType<typeof retryLegWithinExecutionBuffer>> = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1 && retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }

    const retried = await retryLegWithinExecutionBuffer(
      currentIntent,
      leg,
      slot,
      settings,
      Date.now(),
      stage,
    );
    if (!retried) {
      return lastResult;
    }

    lastResult = retried;
    currentIntent = retried.intent;

    if (!isTerminalOrderStatus(retried.result.status) || retried.order.filledSize > 0) {
      return retried;
    }

    await writeRunEvent({
      level: "warn",
      eventType: `order.${stage}.retry_terminal`,
      message: `${stage === "primary" ? "Primary" : "Hedge"} retry ${attempt}/${attempts} ended without fill`,
      payload: {
        intentId: retried.intent.id,
        venue: leg.venue,
        attempt,
        attempts,
        orderId: retried.order.venueOrderId,
        orderStatus: retried.result.status,
        detail: extractTerminalNoFillDetail(retried.result),
      },
      createdAt: Date.now(),
    });
  }

  return lastResult;
}

async function repriceIntentWithinExecutionBuffer(
  intent: OrderIntent,
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
) {
  const { polymarket: polymarketState, kalshi: kalshiState } = await marketDataSupervisor.readSlotState(slot, now);
  const pair = getLivePairSnapshot(intent, polymarketState.quote, kalshiState.quote);
  if (!pair) {
    return null;
  }

  const allowedGrossCost = settings.grossEntryThreshold + settings.executionPriceBuffer;
  const allowedLegPrice = settings.maxLegPrice + settings.executionPriceBuffer;
  if (
    pair.poly.price > allowedLegPrice + ORDER_SIZE_TOLERANCE ||
    pair.kalshi.price > allowedLegPrice + ORDER_SIZE_TOLERANCE ||
    pair.grossCost > allowedGrossCost + ORDER_SIZE_TOLERANCE
  ) {
    return null;
  }

  const updatedLegs = intent.legs.map((leg) => {
    const liveLeg = leg.venue === "polymarket" ? pair.poly : pair.kalshi;
    const step = liveLeg.minOrderSize ?? (leg.venue === "polymarket" ? settings.minOrderSize : 1);
    const size = deriveTargetShares(leg.requestedNotionalUsd, liveLeg.price, step);
    if (size <= 0 || (liveLeg.depth !== null && size > liveLeg.depth + ORDER_SIZE_TOLERANCE)) {
      return null;
    }

    return {
      ...leg,
      requestedPrice: liveLeg.price,
      requestedSize: size,
    };
  });

  if (updatedLegs.some((leg) => leg === null)) {
    return null;
  }

  return {
    ...intent,
    grossCost: pair.grossCost,
    updatedAt: now,
    legs: updatedLegs as OrderIntent["legs"],
  };
}

function getLivePairSnapshot(
  intent: OrderIntent,
  polymarket: OpportunitySnapshot["polymarket"],
  kalshi: OpportunitySnapshot["kalshi"],
) {
  const isDownYes = intent.combination === "POLY_DOWN_KALSHI_YES";
  const polyOutcome = isDownYes ? polymarket.outcomes.down : polymarket.outcomes.up;
  const kalshiOutcome = isDownYes ? kalshi.outcomes.yes : kalshi.outcomes.no;
  const polyPrice = polyOutcome.buyPrice;
  const kalshiPrice = kalshiOutcome.buyPrice;

  if (polyPrice === null || kalshiPrice === null) {
    return null;
  }

  return {
    grossCost: round4(polyPrice + kalshiPrice),
    poly: {
      price: polyPrice,
      depth: polyOutcome.depth,
      minOrderSize: polyOutcome.minOrderSize,
    },
    kalshi: {
      price: kalshiPrice,
      depth: kalshiOutcome.depth,
      minOrderSize: kalshiOutcome.minOrderSize,
    },
  };
}

async function attemptPrimaryUnwindAfterHedgeFailure(
  intent: OrderIntent,
  primaryLeg: OrderIntent["legs"][number],
  hedgeLeg: OrderIntent["legs"][number],
  hedgeOrder: LiveOrder | null,
  maxSlippageBps: number,
  confirmationTimeoutMs: number,
  now: number,
  failureReason: string,
) {
  let currentIntent = hedgeOrder
    ? updateIntentLeg(intent, hedgeLeg.venue, hedgeOrder, "failed", now)
    : intent;
  currentIntent = markIntentStatus(currentIntent, "unwind_required", now, failureReason);
  await writeOrderIntent(currentIntent);

  try {
    const unwindResult = await unwindPrimaryLeg(currentIntent, maxSlippageBps, confirmationTimeoutMs);
    await writeVenueOrder(unwindResult);

    if (unwindResult.status === "filled" && unwindResult.filledSize + ORDER_SIZE_TOLERANCE >= primaryLeg.filledSize) {
      currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, unwindResult, "unwound", now);
      currentIntent = markIntentStatus(currentIntent, "unwound", now, "Hedge failed, primary unwound");
      await writeOrderIntent(currentIntent);
    } else if (unwindResult.filledSize > 0) {
      currentIntent = markIntentStatus(
        currentIntent,
        "failed",
        now,
        `Primary unwind partially filled (${unwindResult.status}); manual intervention required`,
      );
      await writeOrderIntent(currentIntent);
    } else if (isTerminalOrderStatus(unwindResult.status)) {
      currentIntent = markIntentStatus(currentIntent, "failed", now, `Primary unwind failed (${unwindResult.status})`);
      await writeOrderIntent(currentIntent);
    } else {
      await writeRunEvent({
        level: "warn",
        eventType: "order.unwind.awaiting_confirmation",
        message: `Primary unwind order ${unwindResult.venueOrderId} awaiting authoritative confirmation`,
        payload: {
          intentId: currentIntent.id,
          venue: currentIntent.primaryVenue,
          orderId: unwindResult.venueOrderId,
          orderStatus: unwindResult.status,
        },
        createdAt: now,
      });
    }
  } catch (error) {
    currentIntent = markIntentStatus(
      currentIntent,
      "failed",
      now,
      `Primary unwind submission failed (${toErrorMessage(error)}); manual intervention required`,
    );
    await writeOrderIntent(currentIntent);
    await writeRunEvent({
      level: "error",
      eventType: "order.unwind.submit_failed",
      message: `Primary unwind submission failed for intent ${currentIntent.id}`,
      payload: {
        intentId: currentIntent.id,
        venue: currentIntent.primaryVenue,
        error: toErrorMessage(error),
      },
      createdAt: now,
    });
  }

  await writeCircuitBreaker({
    key: `slot:${currentIntent.slotKey}`,
    active: true,
    reason: "hedge_failure",
    triggeredAt: now,
    payload: {
      intentId: currentIntent.id,
      venue: currentIntent.primaryVenue,
      stage: "hedge_failure",
      hedgeOrderId: hedgeOrder?.venueOrderId ?? null,
    },
  });

  return currentIntent;
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
      status: mapKalshiOrderStatus(
        order.status,
        Number(order.fill_count_fp ?? existing.filledSize),
        Number(order.remaining_count_fp ?? 0),
      ),
      filledSize: Number(order.fill_count_fp ?? existing.filledSize),
      averageFillPrice: Number(order.yes_price_dollars ?? order.no_price_dollars ?? existing.averageFillPrice ?? 0),
      feeUsd: Number(order.taker_fees_dollars ?? order.maker_fees_dollars ?? existing.feeUsd ?? 0),
      updatedAt: now,
      raw: order as unknown as Record<string, unknown>,
    });
  }

  for (const existingOrder of recentOrders.filter((order) => order.venue === "polymarket")) {
    const matchingTrades = extractPolymarketTradesForOrder(polyTrades, existingOrder.venueOrderId);
    if (matchingTrades.length === 0) {
      continue;
    }

    const confirmedTrades = matchingTrades.filter(isConfirmedPolymarketTrade);
    const confirmedSummary = summarizePolymarketTrades(confirmedTrades);
    if (confirmedSummary.filledSize > 0) {
      await writeVenueOrder({
        ...existingOrder,
        status: deriveConfirmedVenueOrderStatus(existingOrder, confirmedSummary.filledSize),
        filledSize: confirmedSummary.filledSize,
        averageFillPrice: confirmedSummary.averageFillPrice,
        feeUsd: confirmedSummary.feeUsd,
        updatedAt: now,
        raw: {
          ...(existingOrder.raw ?? {}),
          trades: matchingTrades,
        },
      });
      for (const trade of confirmedTrades) {
        await writePolymarketFillSafely(trade, existingOrder.intentId, existingOrder.venueOrderId, "reconcile");
      }
      touchedIntentLegs.add(`${existingOrder.intentId}:polymarket`);
      continue;
    }

    if (matchingTrades.some(isPendingPolymarketTrade)) {
      await writeVenueOrder({
        ...existingOrder,
        status: "pending",
        updatedAt: now,
        raw: {
          ...(existingOrder.raw ?? {}),
          trades: matchingTrades,
        },
      });
    }
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

  await reconcileLatePrimaryFillRescue(now);
}

async function writePolymarketFillSafely(
  trade: Parameters<typeof mapPolymarketTradeToFill>[0],
  intentId: string,
  venueOrderId: string,
  stage: "intent_sync" | "reconcile",
) {
  try {
    await writeFill(mapPolymarketTradeToFill(trade, intentId, venueOrderId));
  } catch (error) {
    await writeRunEvent({
      level: "warn",
      eventType: "fills.polymarket.write_failed",
      message: `Polymarket fill write failed during ${stage} for intent ${intentId}`,
      payload: {
        intentId,
        stage,
        venueOrderId,
        tradeId: trade.id,
        error: toErrorMessage(error),
      },
      createdAt: Date.now(),
    });
  }
}

async function reconcileLatePrimaryFillRescue(now: number) {
  const [recentIntents, recentOrders] = await Promise.all([readRecentOrderIntents(200), readRecentVenueOrders(200)]);

  for (const intent of recentIntents) {
    if (intent.status !== "failed") {
      continue;
    }
    if (
      now - intent.updatedAt > LATE_PRIMARY_FILL_RESCUE_WINDOW_MS ||
      intent.failureReason?.includes("Late primary fill detected")
    ) {
      continue;
    }

    const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
    const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
    if (!primaryLeg || !hedgeLeg) {
      continue;
    }

    const primaryOrder = findLatestIntentOrderForLeg(recentOrders, intent.id, primaryLeg);
    if (!primaryOrder || primaryOrder.status !== "filled" || primaryOrder.filledSize <= 0) {
      continue;
    }

    const hedgeOrder = findLatestIntentOrderForLeg(recentOrders, intent.id, hedgeLeg);
    if (hedgeOrder?.status === "filled" || (hedgeOrder?.filledSize ?? 0) > 0) {
      continue;
    }

    let rescued = updateIntentLeg(intent, primaryLeg.venue, primaryOrder, "filled", now);
    if (intent.slotEndTs > now) {
      rescued = markIntentStatus(rescued, "primary_filled", now, "Late primary fill detected; resuming hedge");
      await writeOrderIntent(rescued);
      await writeRunEvent({
        level: "error",
        eventType: "intent.reopened.late_primary_fill",
        message: `Intent ${intent.id} reopened after primary fill was confirmed late`,
        payload: {
          intentId: intent.id,
          slotKey: intent.slotKey,
          venue: intent.primaryVenue,
          orderId: primaryOrder.venueOrderId,
        },
        createdAt: now,
      });
      continue;
    }

    rescued = markIntentStatus(
      rescued,
      "failed",
      now,
      "Late primary fill detected after intent had already failed; manual intervention required",
    );
    await writeOrderIntent(rescued);
    await writeCircuitBreaker({
      key: "global",
      active: true,
      reason: "hedge_failure",
      triggeredAt: now,
      payload: {
        intentId: intent.id,
        slotKey: intent.slotKey,
        venue: intent.primaryVenue,
        orderId: primaryOrder.venueOrderId,
        stage: "late_primary_fill_after_close",
      },
    });
    await writeRunEvent({
      level: "error",
      eventType: "intent.failed.late_primary_fill",
      message: `Late primary fill detected after intent ${intent.id} was already closed`,
      payload: {
        intentId: intent.id,
        slotKey: intent.slotKey,
        venue: intent.primaryVenue,
        orderId: primaryOrder.venueOrderId,
      },
      createdAt: now,
    });
  }
}

async function reconcileSettlements(settings: StrategyConfig, now: number) {
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

    const exitAdjustedIntent = await maybeExitPolymarketLegAtSlotEnd(
      intent,
      settings,
      polyResolution,
      now,
    );
    if (exitAdjustedIntent.status !== "hedged") {
      continue;
    }

    const payoutUsd = calculateWinningPayout(exitAdjustedIntent.legs, polyResolution, kalshiResolution);
    const settled = finalizeIntent({
      intent: exitAdjustedIntent,
      polyResolution,
      kalshiResolution,
      payoutUsd,
      now,
    });
    await writeOrderIntent(settled);
    for (const leg of settled.legs) {
      const resolvedOutcome = leg.venue === "polymarket" ? polyResolution : kalshiResolution;
      const legPayoutUsd = leg.payoutUsd ?? (leg.outcome === resolvedOutcome ? leg.filledSize : 0);
      await writeSettlement({
        id: `${settled.id}:${leg.venue}:${leg.marketRef}:${leg.outcome}`,
        intentId: settled.id,
        venue: leg.venue,
        marketRef: leg.marketRef,
        outcome: leg.outcome,
        resolvedOutcome,
        payoutUsd: legPayoutUsd,
        settledAt: now,
        raw: {
          slotKey: settled.slotKey,
          filledSize: leg.filledSize,
          filledPrice: leg.filledPrice,
          legPayoutUsd,
          polyResolution,
          kalshiResolution,
        },
      });
    }
  }
}

async function maybeExitPolymarketLegAtSlotEnd(
  intent: OrderIntent,
  settings: StrategyConfig,
  polyResolution: "UP" | "DOWN",
  now: number,
) {
  if (intent.shadow) {
    return intent;
  }

  const polymarketLeg = intent.legs.find((leg) => leg.venue === "polymarket");
  if (
    !polymarketLeg ||
    polymarketLeg.filledSize <= 0 ||
    polymarketLeg.payoutUsd !== null ||
    now < intent.slotEndTs + RESOLUTION_GRACE_MS
  ) {
    return intent;
  }

  const slot = getCurrentSlot(new Date(intent.slotStartTs + 1));
  const { polymarket: polymarketState } = await marketDataSupervisor.readSlotState(slot, now);
  const outcome =
    polymarketLeg.outcome === "UP" ? polymarketState.quote.outcomes.up : polymarketState.quote.outcomes.down;
  const sellPrice = outcome.sellPrice ?? outcome.bestBid;

  if (sellPrice === null || sellPrice <= 0) {
    return intent;
  }

  const permissivePrice = Math.max(0.001, sellPrice - settings.executionPriceBuffer);
  const exitLeg = {
    ...polymarketLeg,
    side: "SELL" as const,
    requestedPrice: permissivePrice,
    requestedSize: polymarketLeg.filledSize,
    requestedNotionalUsd: polymarketLeg.filledSize * permissivePrice,
  };

  let lastOrder: LiveOrder | null = null;
  for (let attempt = 1; attempt <= settings.hedgeRetryAttempts; attempt += 1) {
    if (attempt > 1 && settings.hedgeRetryDelayMs > 0) {
      await sleep(settings.hedgeRetryDelayMs);
    }

    const request = buildVenueOrderRequest(exitLeg, settings.maxSlippageBps, "FOK", true);
    const submission = await polymarketAdapter.placeOrder(request);
    const result = await confirmImmediateOrderExecution(
      "polymarket",
      request,
      submission,
      settings.immediateOrderConfirmationTimeoutMs,
    );
    const order = buildLiveOrderRecord(intent.id, exitLeg, request, result, Date.now());
    lastOrder = order;
    await writeVenueOrder(order);

    if (order.status === "filled" && order.filledSize + ORDER_SIZE_TOLERANCE >= polymarketLeg.filledSize) {
      const averageExitPrice = order.averageFillPrice ?? permissivePrice;
      const payoutUsd = round4(order.filledSize * averageExitPrice - (order.feeUsd ?? 0));
      const updated = {
        ...intent,
        updatedAt: now,
        failureReason: null,
        legs: intent.legs.map((leg) =>
          leg.id === polymarketLeg.id
            ? {
                ...leg,
                status: "unwound",
                payoutUsd,
                resolvedOutcome: polyResolution,
              }
            : leg,
        ) as OrderIntent["legs"],
      };
      await writeRunEvent({
        level: "info",
        eventType: "order.slot_exit.polymarket_filled",
        message: `Polymarket slot-end exit filled for intent ${intent.id}`,
        payload: {
          intentId: intent.id,
          orderId: order.venueOrderId,
          filledSize: order.filledSize,
          averageExitPrice,
          payoutUsd,
        },
        createdAt: now,
      });
      return updated;
    }

    await writeRunEvent({
      level: "warn",
      eventType: "order.slot_exit.polymarket_retry",
      message: `Polymarket slot-end exit ${attempt}/${settings.hedgeRetryAttempts} did not fill for intent ${intent.id}`,
      payload: {
        intentId: intent.id,
        attempt,
        attempts: settings.hedgeRetryAttempts,
        orderId: order.venueOrderId,
        orderStatus: order.status,
      },
      createdAt: now,
    });
  }

  if (lastOrder?.filledSize && lastOrder.filledSize > ORDER_SIZE_TOLERANCE) {
    const failed = markIntentStatus(
      intent,
      "failed",
      now,
      `Polymarket slot-end exit partially filled (${lastOrder.status}); manual intervention required`,
    );
    await writeOrderIntent(failed);
    await writeCircuitBreaker({
      key: "global",
      active: true,
      reason: "hedge_failure",
      triggeredAt: now,
      payload: {
        intentId: intent.id,
        stage: "polymarket_slot_exit_partial_fill",
        orderId: lastOrder.venueOrderId,
      },
    });
    return failed;
  }

  return intent;
}

async function reconcileInFlightIntentStates(now: number) {
  const [openIntents, recentOrders, settings] = await Promise.all([
    readOpenOrderIntents(),
    readRecentVenueOrders(200),
    readSettings(),
  ]);

  for (const intent of openIntents) {
    if (
      intent.status !== "executing_primary" &&
      intent.status !== "primary_filled" &&
      intent.status !== "hedging" &&
      intent.status !== "unwind_required"
    ) {
      continue;
    }

    const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
    const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
    if (!primaryLeg || !hedgeLeg) {
      continue;
    }

    const primaryOrder = findLatestIntentOrderForLeg(recentOrders, intent.id, primaryLeg);
    const hedgeOrder = findLatestIntentOrderForLeg(recentOrders, intent.id, hedgeLeg);
    const unwindOrder = findLatestIntentReduceOnlyOrder(recentOrders, intent.id, primaryLeg);
    const stale = isInFlightIntentStale(intent, now);
    let currentIntent = intent;

    if (intent.status === "unwind_required") {
      if (!unwindOrder) {
        if (stale) {
          currentIntent = markIntentStatus(
            currentIntent,
            "failed",
            now,
            "Primary unwind order not observed before timeout or slot end",
          );
          await writeOrderIntent(currentIntent);
        }
        continue;
      }

      if (unwindOrder.status === "filled" && unwindOrder.filledSize + ORDER_SIZE_TOLERANCE >= primaryLeg.filledSize) {
        currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, unwindOrder, "unwound", now);
        currentIntent = markIntentStatus(currentIntent, "unwound", now, "Primary unwound after hedge failure");
        await writeOrderIntent(currentIntent);
        continue;
      }

      if (unwindOrder.filledSize > 0) {
        currentIntent = markIntentStatus(
          currentIntent,
          "failed",
          now,
          `Primary unwind partially filled (${unwindOrder.status}); manual intervention required`,
        );
        await writeOrderIntent(currentIntent);
        continue;
      }

      if (stale && (isTerminalOrderStatus(unwindOrder.status) || isAwaitingOrderConfirmation(unwindOrder.status))) {
        currentIntent = markIntentStatus(
          currentIntent,
          "failed",
          now,
          `Primary unwind not completed (${unwindOrder.status})`,
        );
        await writeOrderIntent(currentIntent);
      }
      continue;
    }

    if (!primaryOrder) {
      if (intent.status === "executing_primary" && stale) {
        currentIntent = markIntentStatus(
          intent,
          "failed",
          now,
          "Primary order not observed before timeout or slot end",
        );
        await writeOrderIntent(currentIntent);
        await writeRunEvent({
          level: "warn",
          eventType: "intent.failed.primary_missing",
          message: `Intent ${intent.id} closed after primary was never observed`,
          payload: {
            intentId: intent.id,
            slotKey: intent.slotKey,
          },
          createdAt: now,
        });
      }
      continue;
    }

    if (
      primaryOrder.venueOrderId !== primaryLeg.venueOrderId ||
      primaryOrder.filledSize !== primaryLeg.filledSize ||
      primaryOrder.averageFillPrice !== primaryLeg.filledPrice ||
      (primaryOrder.feeUsd ?? 0) !== primaryLeg.feeUsd
    ) {
      currentIntent = updateIntentLeg(
        currentIntent,
        primaryLeg.venue,
        primaryOrder,
        primaryOrder.status === "filled" ? "filled" : primaryLeg.status,
        now,
      );
      await writeOrderIntent(currentIntent);
    }

    if (primaryOrder.status === "filled" && currentIntent.status === "executing_primary") {
      currentIntent = markIntentStatus(currentIntent, hedgeOrder ? "hedging" : "primary_filled", now);
      await writeOrderIntent(currentIntent);
    }

    if (primaryOrder.filledSize > 0 && primaryOrder.status !== "filled") {
      currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "failed", now);
      currentIntent = markIntentStatus(
        currentIntent,
        "failed",
        now,
        `Primary order partially filled or not final (${primaryOrder.status}); manual intervention required`,
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
          stage: "primary_partial_fill",
          orderId: primaryOrder.venueOrderId,
          orderStatus: primaryOrder.status,
        },
      });
      continue;
    }

    if (isTerminalOrderStatus(primaryOrder.status) && stale) {
      currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "failed", now);
      currentIntent = markIntentStatus(
        currentIntent,
        "failed",
        now,
        `Primary order ${primaryOrder.status}`,
      );
      await writeOrderIntent(currentIntent);
      await writeRunEvent({
        level: "warn",
        eventType: "intent.failed.primary_terminal",
        message: `Intent ${intent.id} closed after primary order ended in status ${primaryOrder.status}`,
        payload: {
          intentId: intent.id,
          slotKey: intent.slotKey,
          orderId: primaryOrder.venueOrderId,
          orderStatus: primaryOrder.status,
        },
          createdAt: now,
      });
      continue;
    }

    if (stale && isAwaitingOrderConfirmation(primaryOrder.status)) {
      currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "failed", now);
      currentIntent = markIntentStatus(
        currentIntent,
        "failed",
        now,
        `Primary order not completed before timeout or slot end (${primaryOrder.status})`,
      );
      await writeOrderIntent(currentIntent);
      await writeRunEvent({
        level: "warn",
        eventType: "intent.failed.primary_timeout",
        message: `Intent ${intent.id} closed after primary order stayed unresolved`,
        payload: {
          intentId: intent.id,
          slotKey: intent.slotKey,
          orderId: primaryOrder.venueOrderId,
          orderStatus: primaryOrder.status,
        },
        createdAt: now,
      });
      continue;
    }

    if (primaryOrder.status !== "filled") {
      continue;
    }

    if (!hedgeOrder) {
      if (stale && (intent.status === "primary_filled" || intent.status === "hedging")) {
        await writeRunEvent({
          level: "error",
          eventType: "intent.failed.hedge_missing",
          message: `Intent ${intent.id} has no observable hedge order after primary fill`,
          payload: {
            intentId: intent.id,
            slotKey: intent.slotKey,
            venue: intent.hedgeVenue,
          },
          createdAt: now,
        });
        await attemptPrimaryUnwindAfterHedgeFailure(
          currentIntent,
          primaryLeg,
          hedgeLeg,
          null,
          settings.maxSlippageBps,
          settings.immediateOrderConfirmationTimeoutMs,
          now,
          "Hedge order not observed before timeout or slot end",
        );
      }
      continue;
    }

    if (
      hedgeOrder.venueOrderId !== hedgeLeg.venueOrderId ||
      hedgeOrder.filledSize !== hedgeLeg.filledSize ||
      hedgeOrder.averageFillPrice !== hedgeLeg.filledPrice ||
      (hedgeOrder.feeUsd ?? 0) !== hedgeLeg.feeUsd
    ) {
      currentIntent = updateIntentLeg(
        currentIntent,
        hedgeLeg.venue,
        hedgeOrder,
        hedgeOrder.status === "filled" ? "hedged" : hedgeLeg.status,
        now,
      );
      await writeOrderIntent(currentIntent);
    }

    if (hedgeOrder.status === "filled") {
      currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "hedged", now);
      currentIntent = markIntentStatus(currentIntent, "hedged", now);
      await writeOrderIntent(currentIntent);
      continue;
    }

    if (hedgeOrder.filledSize > 0) {
      currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "failed", now);
      currentIntent = markIntentStatus(
        currentIntent,
        "failed",
        now,
        `Hedge order partially filled or not final (${hedgeOrder.status}); manual intervention required`,
      );
      await writeOrderIntent(currentIntent);
      await writeCircuitBreaker({
        key: `slot:${currentIntent.slotKey}`,
        active: true,
        reason: "hedge_failure",
        triggeredAt: now,
        payload: {
          intentId: currentIntent.id,
          venue: currentIntent.hedgeVenue,
          stage: "hedge_partial_fill",
          orderId: hedgeOrder.venueOrderId,
          orderStatus: hedgeOrder.status,
        },
      });
      continue;
    }

    if (stale && (isTerminalOrderStatus(hedgeOrder.status) || isAwaitingOrderConfirmation(hedgeOrder.status))) {
      await attemptPrimaryUnwindAfterHedgeFailure(
        currentIntent,
        primaryLeg,
        hedgeLeg,
        hedgeOrder,
        settings.maxSlippageBps,
        settings.immediateOrderConfirmationTimeoutMs,
        now,
        `Hedge order not completed (${hedgeOrder.status})`,
      );
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
    equityUsd: cashUsd + positionsValueUsd,
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
  const slippageAdjustedPrice =
    leg.requestedPrice === null ? null : applySlippage(leg.requestedPrice, maxSlippageBps, leg.side);
  const price =
    leg.venue === "kalshi" ? normalizeKalshiOrderPrice(slippageAdjustedPrice, leg.side) : slippageAdjustedPrice;

  return {
    marketRef: leg.marketRef,
    tokenId: leg.tokenId,
    outcome: leg.outcome,
    side: leg.side,
    size: leg.requestedSize,
    price,
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
                    ? venue === intent.hedgeVenue
                      ? "hedged"
                      : "filled"
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
  timeoutMs: number,
) {
  if (submission.status === "rejected" || submission.status === "canceled" || submission.status === "expired") {
    return submission;
  }

  if (venue === "polymarket") {
    const confirmation = await confirmPolymarketOrderExecution({
      orderId: submission.venueOrderId,
      expectedSize: request.size,
      orderType: request.orderType,
      timeoutMs,
    });
    return confirmation.result;
  }

  if (submission.status !== "live" && submission.status !== "pending" && submission.status !== "partially_filled") {
    return submission;
  }

  const deadline = Date.now() + timeoutMs;
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

async function recoverKalshiOrderSubmissionForIntent(
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
  request: VenueOrderRequest,
  now: number,
  stage: "primary" | "hedge",
) {
  if (leg.venue !== "kalshi") {
    return null;
  }

  const kalshiOrders = await fetchKalshiOrders().catch(() => []);
  const recoveredOrder = kalshiOrders.find((order) => order.client_order_id === request.clientOrderId);
  if (!recoveredOrder) {
    return null;
  }

  const filledSize = Number(recoveredOrder.fill_count_fp ?? 0);
  const remainingSize = Number(recoveredOrder.remaining_count_fp ?? 0);
  const result: Awaited<ReturnType<VenueAdapter["placeOrder"]>> = {
    venue: "kalshi",
    venueOrderId: recoveredOrder.order_id,
    status: mapKalshiOrderStatus(recoveredOrder.status, filledSize, remainingSize),
    filledSize,
    averageFillPrice:
      Number(recoveredOrder.yes_price_dollars ?? recoveredOrder.no_price_dollars ?? 0) || null,
    feeUsd: Number(recoveredOrder.taker_fees_dollars ?? recoveredOrder.maker_fees_dollars ?? 0),
    raw: recoveredOrder as unknown as Record<string, unknown>,
  };
  const order = buildLiveOrderRecord(intent.id, leg, request, result, now);
  await writeVenueOrder(order);
  await writeRunEvent({
    level: "warn",
    eventType: `order.${stage}.recovered`,
    message: `${stage === "primary" ? "Primary" : "Hedge"} Kalshi order recovered via client_order_id`,
    payload: {
      intentId: intent.id,
      venue: leg.venue,
      clientOrderId: request.clientOrderId,
      orderId: order.venueOrderId,
      orderStatus: order.status,
    },
    createdAt: now,
  });

  return {
    result,
    order,
  };
}

function isTerminalOrderStatus(status: LiveOrder["status"]) {
  return status === "canceled" || status === "rejected" || status === "expired";
}

function shouldTripBreakerForTerminalNoFill(result: Awaited<ReturnType<VenueAdapter["placeOrder"]>>) {
  return !Boolean(result.raw?.softNoFill);
}

function extractTerminalNoFillDetail(result: Awaited<ReturnType<VenueAdapter["placeOrder"]>>) {
  return typeof result.raw?.error === "string" ? result.raw.error : null;
}

function describeTerminalNoFill(label: string, result: Awaited<ReturnType<VenueAdapter["placeOrder"]>>) {
  const detail = extractTerminalNoFillDetail(result);
  if (detail) {
    return `${label} order not filled (${detail})`;
  }

  return `${label} order not authoritatively filled (${result.status})`;
}

function isAwaitingOrderConfirmation(status: LiveOrder["status"]) {
  return status === "pending" || status === "live";
}

function deriveConfirmedVenueOrderStatus(order: LiveOrder, filledSize: number): LiveOrder["status"] {
  if (order.orderType === "FOK") {
    return filledSize > 0 ? "filled" : order.status;
  }

  return filledSize + ORDER_SIZE_TOLERANCE >= order.requestedSize ? "filled" : "partially_filled";
}

function findLatestIntentOrderForLeg(
  recentOrders: LiveOrder[],
  intentId: string,
  leg: OrderIntent["legs"][number],
) {
  return recentOrders.find(
    (order) =>
      order.intentId === intentId &&
      order.venue === leg.venue &&
      order.side === leg.side,
  ) ?? null;
}

function findLatestIntentReduceOnlyOrder(
  recentOrders: LiveOrder[],
  intentId: string,
  leg: OrderIntent["legs"][number],
) {
  return recentOrders.find(
    (order) =>
      order.intentId === intentId &&
      order.venue === leg.venue &&
      order.side === "SELL",
  ) ?? null;
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

function isInFlightIntentStale(intent: OrderIntent, now: number) {
  return intent.slotEndTs <= now || now - intent.updatedAt >= IN_FLIGHT_INTENT_STALE_MS;
}

async function runReconcileStep(step: string, now: number, fn: () => Promise<void>) {
  try {
    await fn();
    return [] as string[];
  } catch (error) {
    const message = `${step}: ${toErrorMessage(error)}`;
    await writeRunEvent({
      level: "warn",
      eventType: "reconcile.step_failed",
      message,
      payload: {
        step,
      },
      createdAt: now,
    });
    return [message];
  }
}
