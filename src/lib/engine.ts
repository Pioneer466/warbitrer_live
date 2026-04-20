import { toKalshiResolution } from "@/lib/btc-resolution";
import { readDatabaseMaintenanceConfig } from "@/lib/db-maintenance";
import {
  applySlippage,
  deriveVenueTargetSize,
  getVenueMinimumOrderSize,
} from "@/lib/fees";
import {
  createKalshiAdapter,
  fetchKalshiFills,
  fetchKalshiOrders,
  fetchKalshiResolution,
  getKalshiOrderPriceUsd,
  KALSHI_ORDER_PRICE_STEP_USD,
  mapKalshiFillToLiveFill,
  mapKalshiOrderStatus,
  normalizeKalshiOrderPrice,
} from "@/lib/kalshi";
import { getMarketDataSupervisor } from "@/lib/market-data";
import { getMarketCatalogEntry, isMarketAsset, MARKET_ASSETS } from "@/lib/market-catalog";
import { fetchSlotResolution } from "@/lib/market-resolution";
import { buildPnlSnapshot } from "@/lib/pnl";
import {
  confirmPolymarketOrderExecution,
  createPolymarketAdapter,
  extractPolymarketTradesForOrder,
  fetchPolymarketOpenOrders,
  getPolymarketConditionalSellableBalance,
  fetchPolymarketResolution,
  fetchPolymarketTrades,
  isConfirmedPolymarketTrade,
  isPendingPolymarketTrade,
  mapPolymarketOrder,
  mapPolymarketTradeToFill,
  summarizePolymarketTrades,
} from "@/lib/polymarket";
import { autoConvertPolymarketIfConfigured, reconcilePolymarketProxyConversions } from "@/lib/recovery";
import { calculateVenueExposureUsd, countSlotExecutionBlockers, hasUnresolvedExposureBlocker } from "@/lib/risk";
import { buildSignals } from "@/lib/signals";
import {
  calculateWinningPayout,
  createIntentFromOpportunity,
  finalizeIntent,
  finalizeUnwoundIntent,
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
  readLiveFeesUsd,
  readLiveRealizedPnlUsd,
  readOpenOrderIntents,
  readPositions,
  readRunEvents,
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
  CircuitBreaker,
  LiveFill,
  LiveOpportunity,
  LiveOrder,
  MarketAsset,
  MarketSlot,
  OpportunitySnapshot,
  OrderIntent,
  PositionSnapshot,
  StrategyConfig,
  RunEvent,
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
const RECONCILE_STEP_TIMEOUT_MS = 30_000;
const KALSHI_SOFT_HEDGE_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const KALSHI_SOFT_HEDGE_FAILURE_THRESHOLD = 2;
const KALSHI_SOFT_HEDGE_FAILURE_GLOBAL_COOLDOWN_MS = 30 * 60 * 1000;

const kalshiAdapter = createKalshiAdapter();
const polymarketAdapter = createPolymarketAdapter();
const marketDataSupervisor = getMarketDataSupervisor();
let lastDatabaseMaintenanceAttemptAt: number | null = null;

function buildSlotBreakerKey(slotKey: string): CircuitBreaker["key"] {
  return `slot:${slotKey}` as CircuitBreaker["key"];
}

function buildAssetBreakerKey(asset: MarketAsset): CircuitBreaker["key"] {
  return `asset:${asset}` as CircuitBreaker["key"];
}

function buildPolymarketSlotSlug(asset: MarketAsset, slotStartTs: number) {
  return `${getMarketCatalogEntry(asset).polymarketSlugPrefix}-${Math.floor(slotStartTs / 1000)}`;
}

export async function processTick(now = new Date()) {
  const nowTs = now.getTime();
  const errors: string[] = [];
  for (const asset of MARKET_ASSETS) {
    const settings = await readSettings(asset);
    const slot = getCurrentSlot(asset, now);
    let scanSucceeded = false;
    let executeSucceeded = false;
    let reconcileSucceeded = false;
    const assetErrors: string[] = [];

    await writeWorkerState(asset, {
      phase: "scan",
      currentSlotKey: slot.key,
      lastError: null,
    });

    const coordinator = createExecutionCoordinator(asset, settings);

    try {
      await coordinator.scan(slot, nowTs);
      scanSucceeded = true;
    } catch (error) {
      const message = `[${asset}] ${toErrorMessage(error)}`;
      assetErrors.push(message);
      errors.push(message);
    }

    try {
      await writeWorkerState(asset, {
        phase: "execute",
        currentSlotKey: slot.key,
      });
      await coordinator.execute(slot, nowTs);
      executeSucceeded = true;
    } catch (error) {
      const message = `[${asset}] ${toErrorMessage(error)}`;
      assetErrors.push(message);
      errors.push(message);
    }

    try {
      await writeWorkerState(asset, {
        phase: "reconcile",
        currentSlotKey: slot.key,
      });
      await coordinator.reconcile(slot, nowTs);
      reconcileSucceeded = true;
    } catch (error) {
      const message = `[${asset}] ${toErrorMessage(error)}`;
      assetErrors.push(message);
      errors.push(message);
    }

    await writeWorkerState(asset, {
      phase: "idle",
      currentSlotKey: slot.key,
      lastScanAt: scanSucceeded ? nowTs : undefined,
      lastExecuteAt: executeSucceeded ? nowTs : undefined,
      lastReconcileAt: reconcileSucceeded ? nowTs : undefined,
      lastError: assetErrors[0] ?? null,
    });
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" | "));
  }
}

export function createExecutionCoordinator(asset: MarketAsset, settings: StrategyConfig): ExecutionCoordinator {
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
        lastEntryCosts: await readLastEntryCosts(slot.asset, slot.key),
        secondsRemaining: slot.secondsRemaining,
      });

      await writeSnapshot({
        asset: slot.asset,
        slotKey: slot.key,
        slotStartTs: slot.startTs,
        slotEndTs: slot.endTs,
        capturedAt: now,
        polymarket,
        kalshi,
        opportunities,
      });

      await syncFeedCircuitBreaker(slot, [polymarket.feedHealth, kalshi.feedHealth], now);

      const nextSnapshot: OpportunitySnapshot = {
        asset: slot.asset,
        slotKey: slot.key,
        slotStartTs: slot.startTs,
        slotEndTs: slot.endTs,
        capturedAt: now,
        polymarket,
        kalshi,
        opportunities,
      };

      latestScanSnapshot = nextSnapshot;
      return nextSnapshot;
    },

    async execute(slot, now) {
      const snapshot = latestScanSnapshot ?? (await refreshLatestSnapshot(slot));
      const readiness = await computeReadiness(snapshot, slot.asset, now);
      const activeBreakers = readiness.breakers.filter((breaker) => breaker.active);
      const initialOpenIntents = await readOpenOrderIntents(slot.asset);
      const resumed = await resumeInFlightIntents(
        initialOpenIntents.filter((intent) => intent.slotEndTs + RESOLUTION_GRACE_MS > now),
        slot,
        settings,
        now,
      );
      const openIntents = await readOpenOrderIntents(slot.asset);

      await writeWorkerState(slot.asset, {
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

      if (hasUnresolvedExposureBlocker(openIntents)) {
        return resumed;
      }

      const blockingOpenForSlot = countSlotExecutionBlockers(openIntents, slot.key);
      if (blockingOpenForSlot >= settings.maxOpenIntentsPerSlot) {
        return resumed;
      }

      const eligible = snapshot.opportunities.filter((opportunity) => opportunity.eligible);
      const created: OrderIntent[] = [...resumed];
      const positions = await readPositions(slot.asset);
      const exposureUsd = calculateVenueExposureUsd(positions, openIntents);
      const creationBudget = settings.maxOpenIntentsPerSlot - blockingOpenForSlot;
      let createdCount = 0;

      for (const opportunity of eligible) {
        if (createdCount >= creationBudget) {
          break;
        }

        const currentBreakers = (await readCircuitBreakers()).filter(
          (breaker) => breaker.active && isBreakerRelevantToSlot(breaker, slot.asset, slot.key),
        );
        if (currentBreakers.length > 0) {
          break;
        }

        const currentOpenIntents = await readOpenOrderIntents(slot.asset);
        if (hasUnresolvedExposureBlocker(currentOpenIntents)) {
          break;
        }

        if (countSlotExecutionBlockers(currentOpenIntents, slot.key) >= settings.maxOpenIntentsPerSlot) {
          break;
        }

        const baseIntent = createIntentFromOpportunity({
          opportunity,
          slotStartTs: slot.startTs,
          slotEndTs: slot.endTs,
          now,
          maxSlippageBps: settings.maxSlippageBps,
          shadow: settings.shadowMode,
        });

        const preparedIntent =
          settings.shadowMode
            ? { intent: baseIntent, reason: null }
            : await prepareIntentForLiveExecution(baseIntent, slot, settings, now);
        if (!preparedIntent.intent) {
          await writeRunEvent({
            level: "warn",
            eventType:
              preparedIntent.reason === "unsafe_polymarket_primary"
                ? "intent.skipped.unsafe_primary_sequence"
                : "intent.skipped.execution_window",
            message:
              preparedIntent.reason === "unsafe_polymarket_primary"
                ? `Intent ${baseIntent.id} skipped because Kalshi hedge capacity is not robust enough to lead with Polymarket`
                : `Intent ${baseIntent.id} skipped because the live pair no longer fits the execution window`,
            payload: {
              intentId: baseIntent.id,
              slotKey: baseIntent.slotKey,
              combination: baseIntent.combination,
              primaryVenue: baseIntent.primaryVenue,
              reason: preparedIntent.reason,
            },
            createdAt: now,
          });
          continue;
        }
        const intent = preparedIntent.intent;

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
        createdCount += 1;
      }

      return created;
    },

    async reconcile(slot, now) {
      const [polyPositions, kalshiPositions] = await Promise.all([
        polymarketAdapter.getPositions(now),
        kalshiAdapter.getPositions(now),
      ]);

      const reconcileErrors: string[] = [];
      const assetPolyPositions = polyPositions.filter((position) => position.asset === asset);
      const assetKalshiPositions = kalshiPositions.filter((position) => position.asset === asset);
      const allPositions = [...assetPolyPositions, ...assetKalshiPositions];

      reconcileErrors.push(
        ...(await runReconcileStep("replace_positions", now, async () => {
          await Promise.all([
            replaceVenuePositions("polymarket", asset, assetPolyPositions),
            replaceVenuePositions("kalshi", asset, assetKalshiPositions),
          ]);
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("reconcile_polymarket_convert_status", now, async () => {
          if (asset === "btc") {
            await reconcilePolymarketProxyConversions(now);
          }
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("auto_convert_polymarket", now, async () => {
          if (asset === "btc") {
            await autoConvertPolymarketIfConfigured(polyPositions, now);
          }
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("reconcile_venue_orders", now, async () => {
          await reconcileVenueOrders(asset, now);
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("reconcile_inflight_intents", now, async () => {
          await reconcileInFlightIntentStates(asset, now);
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("clear_recovered_intent_messages", now, async () => {
          await clearRecoveredIntentFailureReasons(asset, now);
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("reconcile_slot_end_polymarket_exits", now, async () => {
          await reconcileSlotEndPolymarketExits(asset, settings, now);
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("reconcile_settlements", now, async () => {
          await reconcileSettlements(asset, settings, now);
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("backfill_unwound_pnl", now, async () => {
          await backfillUnwoundIntentPnl(asset, now);
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("refresh_pnl", now, async () => {
          if (asset === "btc") {
            await refreshPnl(now, [...polyPositions, ...kalshiPositions]);
          }
        })),
      );

      reconcileErrors.push(
        ...(await runReconcileStep("database_maintenance", now, async () => {
          if (asset === "btc") {
            await maybeRunDatabaseMaintenance(now);
          }
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
  asset: MarketAsset,
  now: number,
): Promise<{ state: Partial<WorkerState>; breakers: Awaited<ReturnType<typeof readCircuitBreakers>> }> {
  const balances = await readVenueBalances();
  const slotKey = snapshot?.slotKey ?? null;
  const breakers = (await readCircuitBreakers()).filter((breaker) => isBreakerRelevantToSlot(breaker, asset, slotKey));
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
  const key = buildSlotBreakerKey(slot.key);
  const breakers = await readCircuitBreakers();
  for (const breaker of breakers) {
    const breakerAsset = getBreakerAsset(breaker.key);
    const isFeedHealthBreaker =
      breaker.reason === "venue_error" &&
      breaker.payload !== null &&
      typeof breaker.payload === "object" &&
      Array.isArray((breaker.payload as { feeds?: unknown }).feeds);

    if (
      breaker.active &&
      breaker.key.startsWith("slot:") &&
      breaker.key !== key &&
      breakerAsset === slot.asset &&
      isFeedHealthBreaker
    ) {
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
    primaryOrder = buildLiveOrderRecord(currentIntent.asset, currentIntent.id, primaryLeg, primaryRequest, primaryResult, now);
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
        key: buildSlotBreakerKey(currentIntent.slotKey),
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
      key: buildSlotBreakerKey(currentIntent.slotKey),
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
          key: buildSlotBreakerKey(currentIntent.slotKey),
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
        key: buildSlotBreakerKey(currentIntent.slotKey),
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
    hedgeOrder = buildLiveOrderRecord(currentIntent.asset, currentIntent.id, hedgeLeg, hedgeRequest, hedgeResult, now);
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
        settings,
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
    currentIntent = markIntentStatus(currentIntent, "hedged", now, null);
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
      key: buildSlotBreakerKey(currentIntent.slotKey),
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
        currentIntent = markIntentStatus(currentIntent, "hedged", now, null);
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
          key: buildSlotBreakerKey(currentIntent.slotKey),
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

  const hedgeFailureReason = describeTerminalNoFill("Hedge", hedgeResult);
  await writeRunEvent({
    level: shouldTripBreakerForTerminalNoFill(hedgeResult) ? "error" : "warn",
    eventType: "order.hedge.no_fill",
    message: `Hedge ${currentIntent.hedgeVenue} order ended without fill for intent ${currentIntent.id}`,
    payload: {
      intentId: currentIntent.id,
      venue: currentIntent.hedgeVenue,
      orderId: hedgeOrder.venueOrderId,
      orderStatus: hedgeResult.status,
      detail: extractTerminalNoFillDetail(hedgeResult),
      softNoFill: Boolean(hedgeResult.raw?.softNoFill),
    },
    createdAt: now,
  });

  return attemptPrimaryUnwindAfterHedgeFailure(
    currentIntent,
    primaryLeg,
    hedgeLeg,
    hedgeOrder,
    settings,
    now,
    hedgeFailureReason,
    hedgeResult,
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

  const primaryOrder = buildShadowOrder(currentIntent.asset, currentIntent.id, primaryLeg, now, "primary");
  const hedgeOrder = buildShadowOrder(currentIntent.asset, currentIntent.id, hedgeLeg, now + 1, "hedge");
  await writeVenueOrder(primaryOrder);
  await writeVenueOrder(hedgeOrder);
  await writeFill(buildShadowFill(currentIntent.asset, currentIntent.id, primaryLeg, now, primaryOrder.venueOrderId));
  await writeFill(buildShadowFill(currentIntent.asset, currentIntent.id, hedgeLeg, now + 1, hedgeOrder.venueOrderId));

  currentIntent = updateIntentLeg(currentIntent, primaryLeg.venue, primaryOrder, "filled", now);
  currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "hedged", now + 1);
  currentIntent = markIntentStatus(currentIntent, "hedged", now + 1, null);
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
  const recentOrders = await readRecentVenueOrders(200, slot.asset);
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

async function resolvePrimaryExitSize(
  intent: OrderIntent,
  primaryLeg: OrderIntent["legs"][number],
  now: number,
) {
  if (primaryLeg.venue !== "polymarket") {
    return primaryLeg.filledSize;
  }

  const [positions, sellableBalance] = await Promise.all([
    polymarketAdapter.getPositions(now).catch(() => []),
    primaryLeg.tokenId ? getPolymarketConditionalSellableBalance(primaryLeg.tokenId).catch(() => null) : null,
  ]);
  const matchingPosition = positions.find(
    (position) => position.marketRef === primaryLeg.marketRef && position.outcome === primaryLeg.outcome,
  );

  return derivePrimaryExitSize({
    filledSize: primaryLeg.filledSize,
    positionSize: matchingPosition?.size ?? null,
    sellableSize: sellableBalance?.sellable ?? null,
  });
}

async function resolvePrimaryExitPrice(intent: OrderIntent, primaryLeg: OrderIntent["legs"][number], now: number) {
  const slot = getCurrentSlot(intent.asset, new Date(intent.slotStartTs + 1));
  const { polymarket: polymarketState, kalshi: kalshiState } = await marketDataSupervisor.readSlotState(slot, now);

  if (primaryLeg.venue === "polymarket") {
    const outcome = primaryLeg.outcome === "UP" ? polymarketState.quote.outcomes.up : polymarketState.quote.outcomes.down;
    return outcome.sellPrice ?? outcome.bestBid ?? null;
  }

  const outcome = primaryLeg.outcome === "YES" ? kalshiState.quote.outcomes.yes : kalshiState.quote.outcomes.no;
  return outcome.sellPrice ?? outcome.bestBid ?? null;
}

async function unwindPrimaryLeg(intent: OrderIntent, settings: StrategyConfig, now: number) {
  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  if (!primaryLeg || primaryLeg.filledSize <= 0) {
    throw new Error(`Unable to unwind intent ${intent.id}: no primary fill`);
  }

  const requestedSize = await resolvePrimaryExitSize(intent, primaryLeg, now);
  if (requestedSize <= 0) {
    throw new Error(`Unable to unwind intent ${intent.id}: no exitable size`);
  }

  if (requestedSize + ORDER_SIZE_TOLERANCE < primaryLeg.filledSize) {
    await writeRunEvent({
      level: "warn",
      eventType: "order.unwind.size_capped",
      message: `Primary unwind size capped for intent ${intent.id}`,
      payload: {
        intentId: intent.id,
        venue: primaryLeg.venue,
        filledSize: primaryLeg.filledSize,
        requestedSize,
      },
      createdAt: now,
    });
  }

  const liveExitPrice = await resolvePrimaryExitPrice(intent, primaryLeg, now).catch(() => null);
  const fallbackExitPrice =
    primaryLeg.filledPrice === null ? primaryLeg.requestedPrice : primaryLeg.filledPrice * 0.99;
  const requestedPrice = liveExitPrice ?? fallbackExitPrice;

  const request = buildVenueOrderRequest(
    {
      ...primaryLeg,
      requestedPrice,
      side: "SELL",
      requestedSize,
      requestedNotionalUsd: requestedSize * (requestedPrice ?? primaryLeg.filledPrice ?? primaryLeg.requestedPrice ?? 0),
    },
    settings.maxSlippageBps,
    primaryLeg.venue === "polymarket" ? "FAK" : "IOC",
    true,
  );
  const submission = await adapterFor(primaryLeg.venue).placeOrder(request);
  const result = await confirmImmediateOrderExecution(
    primaryLeg.venue,
    request,
    submission,
    settings.immediateOrderConfirmationTimeoutMs,
  );
  return buildLiveOrderRecord(intent.asset, intent.id, { ...primaryLeg, side: "SELL" }, request, result, now);
}

async function retryLegWithinExecutionBuffer(
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
  stage: "primary" | "hedge",
  retryAttempt = 1,
) {
  if (settings.executionPriceBuffer <= 0) {
    return null;
  }

  const repriced = await repriceRetryLegWithinExecutionBuffer(intent, leg, slot, settings, now, stage, retryAttempt);
  if (!repriced) {
    return null;
  }
  const { intent: repricedIntent, leg: repricedLeg } = repriced;
  const request = buildVenueOrderRequest(repricedLeg, settings.maxSlippageBps, "FOK", false);
  const retryPriceLadderTicks = getRetryPriceLadderTicks(repricedLeg, retryAttempt);

  await writeOrderIntent(repricedIntent);
  await writeRunEvent({
    level: "info",
    eventType: `order.${stage}.repriced`,
    message: `${stage === "primary" ? "Primary" : "Hedge"} leg repriced within execution buffer for intent ${intent.id}${
      retryPriceLadderTicks > 0 ? ` (+${retryPriceLadderTicks} retry rung${retryPriceLadderTicks === 1 ? "" : "s"})` : ""
    }`,
    payload: {
      intentId: intent.id,
      venue: repricedLeg.venue,
      requestedPrice: repricedLeg.requestedPrice,
      requestedSize: repricedLeg.requestedSize,
      orderPrice: request.price,
      grossCost: repricedIntent.grossCost,
      executionPriceBuffer: settings.executionPriceBuffer,
      retryAttempt,
      retryPriceLadderTicks,
    },
    createdAt: now,
  });

  const submission = await adapterFor(repricedLeg.venue).placeOrder(request);
  const result = await confirmImmediateOrderExecution(
    repricedLeg.venue,
    request,
    submission,
    settings.immediateOrderConfirmationTimeoutMs,
  );
  const order = buildLiveOrderRecord(repricedIntent.asset, repricedIntent.id, repricedLeg, request, result, now);
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
      retryAttempt,
      retryPriceLadderTicks,
      requestedPrice: repricedLeg.requestedPrice,
      orderPrice: request.price,
    },
    createdAt: now,
  });

  return {
    intent: repricedIntent,
    order,
    result,
  };
}

async function repriceRetryLegWithinExecutionBuffer(
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
  stage: "primary" | "hedge",
  retryAttempt = 1,
) {
  if (stage === "primary") {
    const repricedIntent = await repriceIntentWithinExecutionBuffer(intent, slot, settings, now);
    if (!repricedIntent) {
      return null;
    }

    const repricedLeg = repricedIntent.legs.find((candidate) => candidate.id === leg.id);
    if (!repricedLeg) {
      return null;
    }

    return {
      intent: repricedIntent,
      leg: repricedLeg,
    };
  }

  const repricedLeg = await repriceSingleHedgeLegWithinExecutionBuffer(intent, leg, slot, settings, now, retryAttempt);
  if (!repricedLeg) {
    return null;
  }

  return {
    intent: {
      ...intent,
      updatedAt: now,
      legs: intent.legs.map((candidate) => (candidate.id === leg.id ? repricedLeg : candidate)) as OrderIntent["legs"],
    },
    leg: repricedLeg,
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
      attempt,
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
    const fallbackMinOrderSize = leg.venue === "polymarket" ? settings.minOrderSize : 1;
    const size = deriveVenueTargetSize(leg.venue, leg.requestedNotionalUsd, liveLeg.price, liveLeg.minOrderSize, fallbackMinOrderSize);
    const minimumSize = getVenueMinimumOrderSize(leg.venue, liveLeg.minOrderSize, fallbackMinOrderSize);
    if (
      size <= 0 ||
      size + ORDER_SIZE_TOLERANCE < minimumSize ||
      (liveLeg.depth !== null && size > liveLeg.depth + ORDER_SIZE_TOLERANCE)
    ) {
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

async function repriceSingleHedgeLegWithinExecutionBuffer(
  intent: OrderIntent,
  leg: OrderIntent["legs"][number],
  slot: MarketSlot,
  settings: StrategyConfig,
  now: number,
  retryAttempt = 1,
) {
  const { polymarket: polymarketState, kalshi: kalshiState } = await marketDataSupervisor.readSlotState(slot, now);
  const liveLeg = getLiveIntentLegSnapshot(leg, polymarketState.quote, kalshiState.quote);
  if (!liveLeg) {
    return null;
  }

  return deriveBufferedRetryLeg(leg, liveLeg, {
    executionPriceBuffer: settings.executionPriceBuffer,
    maxLegPrice: settings.maxLegPrice,
    maxSlippageBps: settings.maxSlippageBps,
    minOrderSize: settings.minOrderSize,
  }, retryAttempt);
}

function getLiveIntentLegSnapshot(
  leg: OrderIntent["legs"][number],
  polymarket: OpportunitySnapshot["polymarket"],
  kalshi: OpportunitySnapshot["kalshi"],
) {
  if (leg.venue === "polymarket") {
    const outcome = leg.outcome === "UP" ? polymarket.outcomes.up : leg.outcome === "DOWN" ? polymarket.outcomes.down : null;
    if (!outcome) {
      return null;
    }

    return {
      price: leg.side === "SELL" ? outcome.sellPrice : outcome.buyPrice,
      depth: outcome.depth,
      minOrderSize: outcome.minOrderSize,
      tickSize: outcome.tickSize,
    };
  }

  const outcome = leg.outcome === "YES" ? kalshi.outcomes.yes : leg.outcome === "NO" ? kalshi.outcomes.no : null;
  if (!outcome) {
    return null;
  }

  return {
    price: leg.side === "SELL" ? outcome.sellPrice : outcome.buyPrice,
    depth: outcome.depth,
    minOrderSize: outcome.minOrderSize,
    tickSize: outcome.tickSize,
  };
}

export function deriveBufferedRetryLeg<
  T extends Pick<
    OrderIntent["legs"][number],
    "venue" | "requestedNotionalUsd" | "requestedPrice" | "requestedSize" | "side" | "outcome" | "id" | "intentId" | "status" | "marketRef"
  >,
>(
  leg: T,
  liveLeg: {
    price: number | null;
    depth: number | null;
    minOrderSize: number | null;
    tickSize?: number | null;
  },
  settings: Pick<StrategyConfig, "executionPriceBuffer" | "maxLegPrice" | "maxSlippageBps" | "minOrderSize">,
  retryAttempt = 1,
) {
  if (liveLeg.price === null) {
    return null;
  }

  const requestedPrice = deriveRetryReferencePrice(leg, liveLeg.price, liveLeg.tickSize ?? null, retryAttempt);
  if (requestedPrice === null) {
    return null;
  }

  const allowedLegPrice = settings.maxLegPrice + settings.executionPriceBuffer;
  const boundedPrice =
    leg.venue === "kalshi"
      ? deriveEffectiveKalshiRetryOrderPrice(requestedPrice, leg.side, settings.maxSlippageBps) ?? requestedPrice
      : requestedPrice;
  if (boundedPrice > allowedLegPrice + ORDER_SIZE_TOLERANCE) {
    return null;
  }

  const fallbackMinOrderSize = leg.venue === "polymarket" ? settings.minOrderSize : 1;
  const size = deriveVenueTargetSize(leg.venue, leg.requestedNotionalUsd, requestedPrice, liveLeg.minOrderSize, fallbackMinOrderSize);
  const minimumSize = getVenueMinimumOrderSize(leg.venue, liveLeg.minOrderSize, fallbackMinOrderSize);
  if (
    size <= 0 ||
    size + ORDER_SIZE_TOLERANCE < minimumSize ||
    (liveLeg.depth !== null && size > liveLeg.depth + ORDER_SIZE_TOLERANCE)
  ) {
    return null;
  }

  return {
    ...leg,
    requestedPrice,
    requestedSize: size,
  };
}

function deriveRetryReferencePrice(
  leg: Pick<OrderIntent["legs"][number], "venue" | "side">,
  livePrice: number,
  liveTickSize: number | null,
  retryAttempt: number,
) {
  const retryPriceLadderTicks = getRetryPriceLadderTicks(leg, retryAttempt);
  if (retryPriceLadderTicks <= 0) {
    return livePrice;
  }

  const priceStep =
    leg.venue === "kalshi"
      ? KALSHI_ORDER_PRICE_STEP_USD
      : leg.venue === "polymarket"
        ? Math.max(0.001, liveTickSize ?? 0.001)
        : 0;
  if (priceStep <= 0) {
    return livePrice;
  }

  const priceDelta = retryPriceLadderTicks * priceStep;
  return round4(
    Math.max(
      priceStep,
      livePrice + (leg.side === "SELL" ? -priceDelta : priceDelta),
    ),
  );
}

function deriveEffectiveKalshiRetryOrderPrice(
  requestedPrice: number,
  side: OrderIntent["legs"][number]["side"],
  maxSlippageBps: number,
) {
  return normalizeKalshiOrderPrice(applySlippage(requestedPrice, maxSlippageBps, side), side);
}

function getRetryPriceLadderTicks(
  leg: Pick<OrderIntent["legs"][number], "venue">,
  retryAttempt: number,
) {
  return leg.venue === "kalshi" || leg.venue === "polymarket" ? Math.max(0, retryAttempt - 1) : 0;
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
  settings: StrategyConfig,
  now: number,
  failureReason: string,
  hedgeResult?: Awaited<ReturnType<VenueAdapter["placeOrder"]>>,
) {
  let currentIntent = hedgeOrder
    ? updateIntentLeg(intent, hedgeLeg.venue, hedgeOrder, "failed", now)
    : intent;
  currentIntent = markIntentStatus(currentIntent, "unwind_required", now, failureReason);
  await writeOrderIntent(currentIntent);
  await armHedgeFailureGuards(currentIntent, hedgeOrder, hedgeResult ?? null, now);

  const maxAttempts = Math.max(1, settings.hedgeRetryAttempts);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1 && settings.hedgeRetryDelayMs > 0) {
      await sleep(settings.hedgeRetryDelayMs);
    }

    let unwindResult: LiveOrder;
    try {
      unwindResult = await unwindPrimaryLeg(currentIntent, settings, Date.now());
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      if (
        isPolymarketOrderbookUnavailableError(error) &&
        currentIntent.primaryVenue === "polymarket" &&
        currentIntent.slotEndTs + RESOLUTION_GRACE_MS <= now
      ) {
        currentIntent = await closeIntentAfterPolymarketOrderbookUnavailable(
          currentIntent,
          primaryLeg,
          now,
          errorMessage,
        );
        break;
      }

      if (isRetryablePolymarketInventorySyncError(error)) {
        currentIntent = markIntentStatus(
          currentIntent,
          "unwind_required",
          now,
          `Primary unwind waiting for inventory sync (${errorMessage})`,
        );
        await writeOrderIntent(currentIntent);
        await writeRunEvent({
          level: "warn",
          eventType: "order.unwind.inventory_sync_pending",
          message: `Primary unwind delayed for intent ${currentIntent.id}`,
          payload: {
            intentId: currentIntent.id,
            venue: currentIntent.primaryVenue,
            attempt,
            attempts: maxAttempts,
            error: errorMessage,
          },
          createdAt: now,
        });
        continue;
      }

      currentIntent = markIntentStatus(
        currentIntent,
        "unwind_required",
        now,
        `Primary unwind submission failed (${errorMessage}); manual intervention required`,
      );
      await writeOrderIntent(currentIntent);
      await writeRunEvent({
        level: "error",
        eventType: "order.unwind.submit_failed",
        message: `Primary unwind submission failed for intent ${currentIntent.id}`,
        payload: {
          intentId: currentIntent.id,
          venue: currentIntent.primaryVenue,
          error: errorMessage,
        },
        createdAt: now,
      });
      await tripManualInterventionBreaker(currentIntent, now, hedgeOrder, "primary_unwind_submit_failed");
      break;
    }

    await writeVenueOrder(unwindResult);

    if (unwindResult.status === "filled" && unwindResult.filledSize + ORDER_SIZE_TOLERANCE >= unwindResult.requestedSize) {
      const averageExitPrice = unwindResult.averageFillPrice ?? primaryLeg.filledPrice ?? 0;
      const payoutUsd = round4(unwindResult.filledSize * averageExitPrice - (unwindResult.feeUsd ?? 0));
      currentIntent = finalizeUnwoundIntent({
        intent: {
          ...currentIntent,
          legs: currentIntent.legs.map((leg) =>
            leg.id === primaryLeg.id
              ? {
                  ...leg,
                  status: "unwound",
                  payoutUsd,
                }
              : leg,
          ) as OrderIntent["legs"],
        },
        now,
        failureReason: describeUnwoundAfterFailure(failureReason),
      });
      await writeOrderIntent(currentIntent);
      break;
    }

    if (unwindResult.filledSize > 0) {
      currentIntent = markIntentStatus(
        currentIntent,
        "unwind_required",
        now,
        `Primary unwind partially filled (${unwindResult.status}); manual intervention required`,
      );
      await writeOrderIntent(currentIntent);
      await tripManualInterventionBreaker(currentIntent, now, hedgeOrder, "primary_unwind_partial_fill");
      break;
    }

    if (!isTerminalOrderStatus(unwindResult.status)) {
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
      break;
    }

    if (attempt < maxAttempts) {
      await writeRunEvent({
        level: "warn",
        eventType: "order.unwind.retry_terminal",
        message: `Primary unwind ${attempt}/${maxAttempts} ended without fill for intent ${currentIntent.id}`,
        payload: {
          intentId: currentIntent.id,
          venue: currentIntent.primaryVenue,
          orderId: unwindResult.venueOrderId,
          orderStatus: unwindResult.status,
          attempt,
          attempts: maxAttempts,
        },
        createdAt: now,
      });
      continue;
    }

    currentIntent = markIntentStatus(
      currentIntent,
      "unwind_required",
      now,
      `Primary unwind failed (${unwindResult.status}); manual intervention required`,
    );
    await writeOrderIntent(currentIntent);
    await tripManualInterventionBreaker(currentIntent, now, hedgeOrder, "primary_unwind_failed");
  }

  return currentIntent;
}

async function tripManualInterventionBreaker(
  intent: OrderIntent,
  now: number,
  hedgeOrder: LiveOrder | null,
  stage: string,
) {
  await writeCircuitBreaker({
    key: "global",
    active: true,
    reason: "hedge_failure",
    triggeredAt: now,
    payload: {
      intentId: intent.id,
      slotKey: intent.slotKey,
      venue: intent.primaryVenue,
      stage,
      hedgeOrderId: hedgeOrder?.venueOrderId ?? null,
    },
  });
}

async function reconcileVenueOrders(asset: MarketAsset, now: number) {
  const [recentOrders, polyOpenOrders, kalshiOrders, polyTrades, kalshiFills] = await Promise.all([
    readRecentVenueOrders(200, asset),
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
    const outcomePrice =
      existing.outcome === "YES" || existing.outcome === "NO"
        ? getKalshiOrderPriceUsd(existing.outcome, {
            yes_price_dollars: order.yes_price_dollars,
            no_price_dollars: order.no_price_dollars,
          })
        : null;
    await writeVenueOrder({
      ...existing,
      status: mapKalshiOrderStatus(
        order.status,
        Number(order.fill_count_fp ?? existing.filledSize),
        Number(order.remaining_count_fp ?? 0),
      ),
      filledSize: Number(order.fill_count_fp ?? existing.filledSize),
      averageFillPrice: outcomePrice ?? existing.averageFillPrice,
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
    if (existingOrder.outcome !== "YES" && existingOrder.outcome !== "NO") {
      continue;
    }
    const canonicalKalshiOrder = {
      intentId: existingOrder.intentId,
      venueOrderId: existingOrder.venueOrderId,
      marketRef: existingOrder.marketRef,
      side: existingOrder.side,
      outcome: existingOrder.outcome,
    };

    await writeFill(mapKalshiFillToLiveFill(fill, canonicalKalshiOrder, now));
    touchedIntentLegs.add(`${existingOrder.intentId}:kalshi`);
  }

  for (const entry of touchedIntentLegs) {
    const [intentId, venue] = entry.split(":") as [string, "polymarket" | "kalshi"];
    await syncIntentFromStoredVenueFills(intentId, venue);
  }

  await reconcileLatePrimaryFillRescue(asset, now);
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

async function reconcileLatePrimaryFillRescue(asset: MarketAsset, now: number) {
  const [recentIntents, recentOrders] = await Promise.all([
    readRecentOrderIntents(200, asset),
    readRecentVenueOrders(200, asset),
  ]);

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
    if (!isLatePrimaryFillRescueEligible(intent, recentOrders)) {
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
    if (intent.slotEndTs + RESOLUTION_GRACE_MS > now) {
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

async function reconcileSettlements(asset: MarketAsset, settings: StrategyConfig, now: number) {
  const openIntents = await readOpenOrderIntents(asset);
  const settledCandidates = openIntents.filter(
    (intent) => intent.status === "hedged" && intent.slotEndTs + RESOLUTION_GRACE_MS <= now,
  );

  for (const intent of settledCandidates) {
    let referenceResolution: "UP" | "DOWN" | null = null;
    try {
      referenceResolution = await fetchSlotResolution(intent.asset, intent.slotStartTs, intent.slotEndTs);
    } catch {
      referenceResolution = null;
    }

    const polyResolution =
      referenceResolution ??
      (await fetchPolymarketResolution(buildPolymarketSlotSlug(intent.asset, intent.slotStartTs)));
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
        asset: settled.asset,
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

async function reconcileSlotEndPolymarketExits(asset: MarketAsset, settings: StrategyConfig, now: number) {
  const openIntents = await readOpenOrderIntents(asset);
  const candidates = openIntents.filter(
    (intent) =>
      !intent.shadow &&
      intent.slotEndTs + RESOLUTION_GRACE_MS <= now &&
      (intent.status === "hedged" ||
        ((intent.status === "primary_filled" || intent.status === "hedging") && intent.primaryVenue === "polymarket")),
  );

  for (const intent of candidates) {
    const exited = await maybeExitPolymarketLegAtSlotEnd(intent, settings, now);
    if (!hasRecordedPolymarketSlotExit(intent, exited)) {
      continue;
    }

    if (intent.status === "hedged") {
      await writeOrderIntent(exited);
      continue;
    }

    const closed = finalizeUnwoundIntent({
      intent: exited,
      now,
      failureReason: "Primary exited at slot end after hedge remained incomplete",
    });
    await writeOrderIntent(closed);
    await writeRunEvent({
      level: "warn",
      eventType: "intent.unwound.slot_end_exit",
      message: `Intent ${intent.id} closed via Polymarket slot-end exit after hedge remained incomplete`,
      payload: {
        intentId: intent.id,
        slotKey: intent.slotKey,
        primaryVenue: intent.primaryVenue,
      },
      createdAt: now,
    });
  }
}

async function clearRecoveredIntentFailureReasons(asset: MarketAsset, now: number) {
  const openIntents = await readOpenOrderIntents(asset);
  for (const intent of openIntents) {
    if (intent.status !== "hedged" || !intent.failureReason) {
      continue;
    }

    await writeOrderIntent({
      ...intent,
      updatedAt: now,
      failureReason: null,
    });
  }
}

async function backfillUnwoundIntentPnl(asset: MarketAsset, now: number) {
  const recentIntents = await readRecentOrderIntents(200, asset);
  for (const intent of recentIntents) {
    if (intent.shadow || intent.status !== "unwound" || intent.realizedPnlUsd !== null) {
      continue;
    }

    if (!intent.legs.some((leg) => leg.payoutUsd !== null)) {
      continue;
    }

    await writeOrderIntent(
      finalizeUnwoundIntent({
        intent,
        now,
        failureReason: intent.failureReason,
      }),
    );
  }
}

async function maybeExitPolymarketLegAtSlotEnd(
  intent: OrderIntent,
  settings: StrategyConfig,
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

  const slot = getCurrentSlot(intent.asset, new Date(intent.slotStartTs + 1));
  const { polymarket: polymarketState } = await marketDataSupervisor.readSlotState(slot, now);
  const outcome =
    polymarketLeg.outcome === "UP" ? polymarketState.quote.outcomes.up : polymarketState.quote.outcomes.down;
  const sellPrice = outcome.sellPrice ?? outcome.bestBid;

  if (sellPrice === null || sellPrice <= 0) {
    return intent;
  }

  const permissivePrice = Math.max(0.001, sellPrice - settings.executionPriceBuffer);
  const requestedSize = await resolvePrimaryExitSize(intent, polymarketLeg, now);
  if (requestedSize <= 0) {
    return intent;
  }
  const exitLeg = {
    ...polymarketLeg,
    side: "SELL" as const,
    requestedPrice: permissivePrice,
    requestedSize,
    requestedNotionalUsd: requestedSize * permissivePrice,
  };

  let lastOrder: LiveOrder | null = null;
  for (let attempt = 1; attempt <= settings.hedgeRetryAttempts; attempt += 1) {
    if (attempt > 1 && settings.hedgeRetryDelayMs > 0) {
      await sleep(settings.hedgeRetryDelayMs);
    }

    let order: LiveOrder;
    try {
      const request = buildVenueOrderRequest(exitLeg, settings.maxSlippageBps, "FOK", true);
      const submission = await polymarketAdapter.placeOrder(request);
      const result = await confirmImmediateOrderExecution(
        "polymarket",
        request,
        submission,
        settings.immediateOrderConfirmationTimeoutMs,
      );
      order = buildLiveOrderRecord(intent.asset, intent.id, exitLeg, request, result, Date.now());
      lastOrder = order;
      await writeVenueOrder(order);
    } catch (error) {
      if (isPolymarketOrderbookUnavailableError(error)) {
        await writeRunEvent({
          level: "warn",
          eventType: "order.slot_exit.polymarket_orderbook_unavailable",
          message: `Polymarket slot-end exit unavailable because the orderbook is gone for intent ${intent.id}`,
          payload: {
            intentId: intent.id,
            error: toErrorMessage(error),
          },
          createdAt: now,
        });
        break;
      }

      await writeRunEvent({
        level: "warn",
        eventType: "order.slot_exit.polymarket_submit_failed",
        message: `Polymarket slot-end exit ${attempt}/${settings.hedgeRetryAttempts} submission failed for intent ${intent.id}`,
        payload: {
          intentId: intent.id,
          attempt,
          attempts: settings.hedgeRetryAttempts,
          error: toErrorMessage(error),
        },
        createdAt: now,
      });
      continue;
    }

    if (order.status === "filled" && order.filledSize + ORDER_SIZE_TOLERANCE >= exitLeg.requestedSize) {
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

async function reconcileInFlightIntentStates(asset: MarketAsset, now: number) {
  const [openIntents, recentOrders, settings, livePositions] = await Promise.all([
    readOpenOrderIntents(asset),
    readRecentVenueOrders(200, asset),
    readSettings(asset),
    readPositions(asset),
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
      const primaryVenueFills = await readFillsForIntentVenue(intent.id, primaryLeg.venue);
      const entryFillSummary = summarizeIntentLegFills(primaryVenueFills, primaryLeg, "entry");
      const exitFillSummary = summarizeIntentLegFills(primaryVenueFills, primaryLeg, "exit");
      const entryFilledSize = entryFillSummary?.filledSize ?? primaryLeg.filledSize;
      const exitFilledSize = exitFillSummary?.filledSize ?? 0;
      const liveRemainingSize = deriveLiveRemainingLegSize(livePositions, primaryLeg);
      const remainingExposureSize = deriveRemainingExposureSize(entryFilledSize, exitFilledSize);
      const exitAverageFillPrice =
        exitFillSummary?.averageFillPrice ?? unwindOrder?.averageFillPrice ?? primaryLeg.filledPrice ?? 0;
      const exitFeeUsd = exitFillSummary?.feeUsd ?? (unwindOrder?.feeUsd ?? 0);

      if (entryFillSummary) {
        currentIntent = updateIntentLegFromFillSummary(currentIntent, primaryLeg.id, entryFillSummary, now);
        await writeOrderIntent(currentIntent);
      }

      if (currentIntent.primaryVenue === "polymarket" && currentIntent.slotEndTs + RESOLUTION_GRACE_MS <= now) {
        const polyResolution =
          currentIntent.polyResolution ??
          (await fetchPolymarketResolution(buildPolymarketSlotSlug(currentIntent.asset, currentIntent.slotStartTs)).catch(
            () => null,
          ));
        if (polyResolution !== null) {
          const residualPayoutUsd = primaryLeg.outcome === polyResolution ? remainingExposureSize : 0;
          const payoutUsd = round4(exitFilledSize * exitAverageFillPrice - exitFeeUsd + residualPayoutUsd);
          const failureReason =
            exitFilledSize > 0 && remainingExposureSize > ORDER_SIZE_TOLERANCE
              ? "Primary partially unwound before Polymarket settlement"
              : exitFilledSize > 0
                ? "Primary unwound after hedge failure"
                : "Primary settled on Polymarket after hedge failure";

          currentIntent = finalizeUnwoundIntent({
            intent: {
              ...currentIntent,
              polyResolution,
              legs: currentIntent.legs.map((leg) =>
                leg.id === primaryLeg.id
                  ? {
                      ...leg,
                      status: "unwound",
                      payoutUsd,
                      resolvedOutcome: polyResolution,
                    }
                  : leg,
              ) as OrderIntent["legs"],
            },
            now,
            failureReason,
          });
          await writeOrderIntent(currentIntent);
          continue;
        }
      }

      if (
        (liveRemainingSize <= ORDER_SIZE_TOLERANCE && exitFilledSize > 0) ||
        (exitFillSummary && exitFilledSize + ORDER_SIZE_TOLERANCE >= entryFilledSize && entryFilledSize > 0)
      ) {
        const payoutUsd = round4(exitFilledSize * exitAverageFillPrice - exitFeeUsd);
        currentIntent = finalizeUnwoundIntent({
          intent: {
            ...currentIntent,
            legs: currentIntent.legs.map((leg) =>
              leg.id === primaryLeg.id
                ? {
                    ...leg,
                    status: "unwound",
                    payoutUsd,
                  }
                : leg,
            ) as OrderIntent["legs"],
          },
          now,
          failureReason: "Primary unwound after hedge failure",
        });
        await writeOrderIntent(currentIntent);
        continue;
      }

      if (!unwindOrder) {
        if (stale) {
          currentIntent = await attemptPrimaryUnwindAfterHedgeFailure(
            currentIntent,
            primaryLeg,
            hedgeLeg,
            hedgeOrder,
            settings,
            now,
            currentIntent.failureReason ?? "Retrying primary unwind after hedge failure",
          );
        }
        continue;
      }

      if (unwindOrder.status === "filled" && unwindOrder.filledSize + ORDER_SIZE_TOLERANCE >= unwindOrder.requestedSize) {
        const averageExitPrice = unwindOrder.averageFillPrice ?? primaryLeg.filledPrice ?? 0;
        const payoutUsd = round4(unwindOrder.filledSize * averageExitPrice - (unwindOrder.feeUsd ?? 0));
        currentIntent = finalizeUnwoundIntent({
          intent: {
            ...currentIntent,
            legs: currentIntent.legs.map((leg) =>
              leg.id === primaryLeg.id
                ? {
                    ...leg,
                    status: "unwound",
                    payoutUsd,
                  }
                : leg,
            ) as OrderIntent["legs"],
          },
          now,
          failureReason: "Primary unwound after hedge failure",
        });
        await writeOrderIntent(currentIntent);
        continue;
      }

      if (unwindOrder.filledSize > 0) {
        currentIntent = markIntentStatus(
          currentIntent,
          "unwind_required",
          now,
          `Primary unwind partially filled (${unwindOrder.status}); manual intervention required`,
        );
        await writeOrderIntent(currentIntent);
        await tripManualInterventionBreaker(currentIntent, now, hedgeOrder, "primary_unwind_partial_fill_reconcile");
        continue;
      }

      if (stale && (isTerminalOrderStatus(unwindOrder.status) || isAwaitingOrderConfirmation(unwindOrder.status))) {
        currentIntent = markIntentStatus(
          currentIntent,
          "unwind_required",
          now,
          `Primary unwind not completed (${unwindOrder.status}); manual intervention required`,
        );
        await writeOrderIntent(currentIntent);
        await tripManualInterventionBreaker(currentIntent, now, hedgeOrder, "primary_unwind_not_completed");
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
        key: buildSlotBreakerKey(currentIntent.slotKey),
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
        if (currentIntent.primaryVenue === "polymarket" && currentIntent.slotEndTs + RESOLUTION_GRACE_MS <= now) {
          const exited = await maybeExitPolymarketLegAtSlotEnd(currentIntent, settings, now);
          if (hasRecordedPolymarketSlotExit(currentIntent, exited)) {
            currentIntent = finalizeUnwoundIntent({
              intent: exited,
              now,
              failureReason: "Primary exited at slot end after hedge remained incomplete",
            });
            await writeOrderIntent(currentIntent);
            continue;
          }
        }

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
          settings,
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
      currentIntent = markIntentStatus(currentIntent, "hedged", now, null);
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
        key: buildSlotBreakerKey(currentIntent.slotKey),
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
      if (currentIntent.primaryVenue === "polymarket" && currentIntent.slotEndTs + RESOLUTION_GRACE_MS <= now) {
        const exited = await maybeExitPolymarketLegAtSlotEnd(currentIntent, settings, now);
        if (hasRecordedPolymarketSlotExit(currentIntent, exited)) {
          currentIntent = finalizeUnwoundIntent({
            intent: exited,
            now,
            failureReason: "Primary exited at slot end after hedge remained incomplete",
          });
          await writeOrderIntent(currentIntent);
          continue;
        }
      }

      await attemptPrimaryUnwindAfterHedgeFailure(
        currentIntent,
        primaryLeg,
        hedgeLeg,
        hedgeOrder,
        settings,
        now,
        `Hedge order not completed (${hedgeOrder.status})`,
      );
    }
  }

  await syncActiveHedgeFailureBreakers(now);
}

async function syncActiveHedgeFailureBreakers(now: number) {
  const [openIntents, breakers] = await Promise.all([readOpenOrderIntents(), readCircuitBreakers()]);
  const unresolvedSlots = new Set(
    openIntents.filter((intent) => intent.status === "unwind_required").map((intent) => intent.slotKey),
  );
  const currentSlotKeys = new Set(MARKET_ASSETS.map((asset) => getCurrentSlot(asset, new Date(now)).key));

  for (const breaker of breakers) {
    if (shouldKeepHedgeFailureBreakerActive(breaker, now, currentSlotKeys, unresolvedSlots)) {
      continue;
    }

    if (!breaker.active || breaker.reason !== "hedge_failure") {
      continue;
    }

    if (breaker.key === "global") {
      await writeCircuitBreaker({
        key: "global",
        active: false,
        reason: null,
        triggeredAt: null,
        payload: null,
      });
      continue;
    }

    if (breaker.key.startsWith("slot:")) {
      const slotKey = breaker.key.slice("slot:".length);
      if (!unresolvedSlots.has(slotKey)) {
        await writeCircuitBreaker({
          key: breaker.key,
          active: false,
          reason: null,
          triggeredAt: null,
          payload: null,
        });
      }
    }
  }
}

async function refreshPnl(now: number, positions: PositionSnapshot[]) {
  const [balances, realizedPnlUsd, feesUsd] = await Promise.all([
    readVenueBalances(),
    readLiveRealizedPnlUsd(),
    readLiveFeesUsd(),
  ]);

  await writePnlSnapshot(
    buildPnlSnapshot({
      capturedAt: now,
      balances,
      positions,
      realizedPnlUsd,
      feesUsd,
    }),
  );
}

export function buildVenueOrderRequest(
  leg: OrderIntent["legs"][number],
  maxSlippageBps: number,
  orderType: "FOK" | "IOC" | "FAK",
  reduceOnly: boolean,
): VenueOrderRequest {
  const slippageAdjustedPrice =
    leg.requestedPrice === null ? null : applySlippage(leg.requestedPrice, maxSlippageBps, leg.side);
  const price =
    leg.venue === "kalshi" ? normalizeKalshiOrderPrice(slippageAdjustedPrice, leg.side) : slippageAdjustedPrice;
  const maxCostUsd =
    leg.venue === "polymarket" && leg.side === "BUY"
      ? round4(leg.requestedNotionalUsd)
      : leg.requestedNotionalUsd * (1 + maxSlippageBps / 10_000);

  return {
    marketRef: leg.marketRef,
    tokenId: leg.tokenId,
    outcome: leg.outcome,
    side: leg.side,
    size: leg.requestedSize,
    price,
    maxCostUsd,
    orderType,
    reduceOnly,
    clientOrderId: crypto.randomUUID(),
  };
}

function buildLiveOrderRecord(
  asset: MarketAsset,
  intentId: string,
  leg: OrderIntent["legs"][number] & { side?: "BUY" | "SELL" },
  request: VenueOrderRequest,
  result: Awaited<ReturnType<VenueAdapter["placeOrder"]>>,
  now: number,
): LiveOrder {
  return {
    id: `${result.venue}:${result.venueOrderId}`,
    asset,
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
  asset: MarketAsset,
  intentId: string,
  leg: OrderIntent["legs"][number],
  now: number,
  suffix: string,
): LiveOrder {
  return {
    id: `shadow:${intentId}:${leg.venue}:${suffix}`,
    asset,
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
  asset: MarketAsset,
  intentId: string,
  leg: OrderIntent["legs"][number],
  now: number,
  venueOrderId: string,
) {
  return {
    id: `shadow-fill:${intentId}:${leg.venue}:${leg.outcome}:${now}`,
    asset,
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
  legId: OrderIntent["legs"][number]["id"],
  summary: ReturnType<typeof summarizeVenueFills>,
  now: number,
) {
  return {
    ...intent,
    updatedAt: now,
    legs: intent.legs.map((leg) =>
      leg.id === legId
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
                    ? leg.venue === intent.hedgeVenue
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

  const leg = intent.legs.find((candidate) => candidate.venue === venue);
  if (!leg) {
    return intent;
  }

  const summary = summarizeIntentLegFills(fills, leg, "entry");
  if (!summary) {
    return intent;
  }

  const updatedIntent = updateIntentLegFromFillSummary(intent, leg.id, summary, Date.now());
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
  if (leg.outcome !== "YES" && leg.outcome !== "NO") {
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
      getKalshiOrderPriceUsd(leg.outcome, {
        yes_price_dollars: recoveredOrder.yes_price_dollars,
        no_price_dollars: recoveredOrder.no_price_dollars,
      }) ?? null,
    feeUsd: Number(recoveredOrder.taker_fees_dollars ?? recoveredOrder.maker_fees_dollars ?? 0),
    raw: recoveredOrder as unknown as Record<string, unknown>,
  };
  const order = buildLiveOrderRecord(intent.asset, intent.id, leg, request, result, now);
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

export function isBreakerRelevantToSlot(
  breaker: Pick<CircuitBreaker, "key">,
  asset: MarketAsset,
  slotKey: string | null,
) {
  return (
    breaker.key === "global" ||
    breaker.key === buildAssetBreakerKey(asset) ||
    (slotKey !== null && breaker.key === buildSlotBreakerKey(slotKey))
  );
}

export function shouldKeepHedgeFailureBreakerActive(
  breaker: Pick<CircuitBreaker, "active" | "key" | "payload" | "reason">,
  now: number,
  currentSlotKeys: Set<string>,
  unresolvedSlots: Set<string>,
) {
  if (!breaker.active || breaker.reason !== "hedge_failure") {
    return false;
  }

  const cooldownUntil = getPayloadNumber(breaker.payload, "cooldownUntil");
  if (cooldownUntil !== null && now < cooldownUntil) {
    return true;
  }

  if (breaker.key === "global") {
    return unresolvedSlots.size > 0;
  }

  if (!breaker.key.startsWith("slot:")) {
    return false;
  }

  const slotKey = breaker.key.slice("slot:".length);
  if (unresolvedSlots.has(slotKey)) {
    return true;
  }

  return getPayloadBoolean(breaker.payload, "lockSlot") && currentSlotKeys.has(slotKey);
}

export function countRecentKalshiSoftHedgeNoFillEvents(
  events: Pick<RunEvent, "createdAt" | "eventType" | "payload">[],
  now: number,
  windowMs = KALSHI_SOFT_HEDGE_FAILURE_WINDOW_MS,
) {
  return countRecentSoftHedgeNoFillEvents(events, now, "kalshi", windowMs);
}

export function hasKalshiHedgeRetryCapacity(
  leg: Pick<
    OrderIntent["legs"][number],
    "venue" | "requestedNotionalUsd" | "requestedPrice" | "requestedSize" | "side" | "outcome" | "id" | "intentId" | "status" | "marketRef"
  >,
  liveLeg: {
    price: number | null;
    depth: number | null;
    minOrderSize: number | null;
    tickSize?: number | null;
  },
  settings: Pick<StrategyConfig, "executionPriceBuffer" | "maxLegPrice" | "maxSlippageBps" | "minOrderSize">,
  hedgeRetryAttempts: number,
) {
  return deriveBufferedRetryLeg(leg, liveLeg, settings, Math.max(1, hedgeRetryAttempts)) !== null;
}

function shouldTripBreakerForTerminalNoFill(result: Awaited<ReturnType<VenueAdapter["placeOrder"]>>) {
  return !Boolean(result.raw?.softNoFill);
}

function extractTerminalNoFillDetail(result: Awaited<ReturnType<VenueAdapter["placeOrder"]>>) {
  return typeof result.raw?.error === "string" ? result.raw.error : null;
}

async function prepareIntentForLiveExecution(intent: OrderIntent, slot: MarketSlot, settings: StrategyConfig, now: number) {
  const repricedIntent = await repriceIntentWithinExecutionBuffer(intent, slot, settings, now);
  if (!repricedIntent) {
    return {
      intent: null,
      reason: "pair_outside_execution_window" as const,
    };
  }

  if (!(await canSafelyLeadWithPolymarket(repricedIntent, slot, settings, now))) {
    return {
      intent: null,
      reason: "unsafe_polymarket_primary" as const,
    };
  }

  return {
    intent: repricedIntent,
    reason: null,
  };
}

async function canSafelyLeadWithPolymarket(intent: OrderIntent, slot: MarketSlot, settings: StrategyConfig, now: number) {
  if (intent.primaryVenue !== "polymarket" || intent.hedgeVenue !== "kalshi") {
    return true;
  }

  const hedgeLeg = intent.legs.find((leg) => leg.venue === "kalshi");
  if (!hedgeLeg) {
    return false;
  }

  const { polymarket: polymarketState, kalshi: kalshiState } = await marketDataSupervisor.readSlotState(slot, now);
  const liveLeg = getLiveIntentLegSnapshot(hedgeLeg, polymarketState.quote, kalshiState.quote);
  if (!liveLeg) {
    return false;
  }

  return hasKalshiHedgeRetryCapacity(
    hedgeLeg,
    liveLeg,
    {
      executionPriceBuffer: settings.executionPriceBuffer,
      maxLegPrice: settings.maxLegPrice,
      maxSlippageBps: settings.maxSlippageBps,
      minOrderSize: settings.minOrderSize,
    },
    settings.hedgeRetryAttempts,
  );
}

async function armHedgeFailureGuards(
  intent: OrderIntent,
  hedgeOrder: LiveOrder | null,
  hedgeResult: Awaited<ReturnType<VenueAdapter["placeOrder"]>> | null,
  now: number,
) {
  await writeCircuitBreaker({
      key: buildSlotBreakerKey(intent.slotKey),
    active: true,
    reason: "hedge_failure",
    triggeredAt: now,
    payload: {
      intentId: intent.id,
      slotKey: intent.slotKey,
      venue: intent.hedgeVenue,
      stage: "hedge_no_fill_slot_lock",
      hedgeOrderId: hedgeOrder?.venueOrderId ?? null,
      lockSlot: true,
    },
  });

  if (!Boolean(hedgeResult?.raw?.softNoFill)) {
    return;
  }

  const breakers = await readCircuitBreakers();
  if (breakers.some((breaker) => breaker.key === "global" && breaker.active)) {
    return;
  }

  const recentEvents = await readRunEvents(100, intent.asset);
  const recentSoftNoFills = recentEvents.filter((event) =>
    isRecentSoftHedgeNoFillEvent(event, now, KALSHI_SOFT_HEDGE_FAILURE_WINDOW_MS, intent.hedgeVenue),
  );
  if (recentSoftNoFills.length < KALSHI_SOFT_HEDGE_FAILURE_THRESHOLD) {
    return;
  }

  const cooldownUntil = now + KALSHI_SOFT_HEDGE_FAILURE_GLOBAL_COOLDOWN_MS;
  const slotKeys = Array.from(
    new Set(
      recentSoftNoFills
        .map((event) => getPayloadString(event.payload, "slotKey"))
        .filter((slotKey): slotKey is string => Boolean(slotKey)),
    ),
  );

  await writeCircuitBreaker({
    key: "global",
    active: true,
    reason: "hedge_failure",
    triggeredAt: now,
    payload: {
      intentId: intent.id,
      slotKey: intent.slotKey,
      venue: intent.hedgeVenue,
      stage: `repeated_${intent.hedgeVenue}_soft_no_fill`,
      failureCount: recentSoftNoFills.length,
      threshold: KALSHI_SOFT_HEDGE_FAILURE_THRESHOLD,
      windowMs: KALSHI_SOFT_HEDGE_FAILURE_WINDOW_MS,
      cooldownUntil,
      slotKeys,
    },
  });
  await writeRunEvent({
    level: "error",
    eventType: "breaker.global.hedge_failure",
    message: `Global hedge failure breaker armed after ${recentSoftNoFills.length} recent ${intent.hedgeVenue} soft no-fills`,
    payload: {
      intentId: intent.id,
      slotKey: intent.slotKey,
      venue: intent.hedgeVenue,
      failureCount: recentSoftNoFills.length,
      threshold: KALSHI_SOFT_HEDGE_FAILURE_THRESHOLD,
      windowMs: KALSHI_SOFT_HEDGE_FAILURE_WINDOW_MS,
      cooldownUntil,
      slotKeys,
    },
    createdAt: now,
  });
}

function isRecentSoftHedgeNoFillEvent(
  event: Pick<RunEvent, "createdAt" | "eventType" | "payload">,
  now: number,
  windowMs: number,
  venue?: "kalshi" | "polymarket",
) {
  return (
    event.eventType === "order.hedge.no_fill" &&
    event.createdAt >= now - windowMs &&
    (venue === undefined || getPayloadString(event.payload, "venue") === venue) &&
    getPayloadBoolean(event.payload, "softNoFill")
  );
}

function countRecentSoftHedgeNoFillEvents(
  events: Pick<RunEvent, "createdAt" | "eventType" | "payload">[],
  now: number,
  venue: "kalshi" | "polymarket",
  windowMs: number,
) {
  return events.filter((event) => isRecentSoftHedgeNoFillEvent(event, now, windowMs, venue)).length;
}

function getAssetFromSlotKey(slotKey: string | null | undefined): MarketAsset | null {
  if (!slotKey) {
    return null;
  }

  const [candidate] = slotKey.split(":");
  return candidate && isMarketAsset(candidate) ? candidate : null;
}

function getBreakerAsset(key: CircuitBreaker["key"]): MarketAsset | null {
  if (key.startsWith("asset:")) {
    const candidate = key.slice("asset:".length);
    return isMarketAsset(candidate) ? candidate : null;
  }

  if (key.startsWith("slot:")) {
    return getAssetFromSlotKey(key.slice("slot:".length));
  }

  return null;
}

function getPayloadBoolean(payload: Record<string, unknown> | null, key: string) {
  return payload !== null && payload[key] === true;
}

function getPayloadNumber(payload: Record<string, unknown> | null, key: string) {
  return payload !== null && typeof payload[key] === "number" ? payload[key] : null;
}

function getPayloadString(payload: Record<string, unknown> | null, key: string) {
  return payload !== null && typeof payload[key] === "string" ? payload[key] : null;
}

function describeTerminalNoFill(label: string, result: Awaited<ReturnType<VenueAdapter["placeOrder"]>>) {
  const detail = extractTerminalNoFillDetail(result);
  if (detail) {
    return `${label} order not filled (${detail})`;
  }

  return `${label} order not authoritatively filled (${result.status})`;
}

function describeUnwoundAfterFailure(failureReason: string) {
  return failureReason.toLowerCase().includes("primary unwound")
    ? failureReason
    : `${failureReason}; primary unwound`;
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
  return readLatestSnapshot(slot.asset, slot.key);
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Erreur inconnue";
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function roundToSixDecimals(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function floorToSixDecimals(value: number) {
  return Math.floor(value * 1_000_000) / 1_000_000;
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
  return intent.slotEndTs + RESOLUTION_GRACE_MS <= now || now - intent.updatedAt >= IN_FLIGHT_INTENT_STALE_MS;
}

function hasRecordedPolymarketSlotExit(previous: OrderIntent, next: OrderIntent) {
  const previousLeg = previous.legs.find((leg) => leg.venue === "polymarket");
  const nextLeg = next.legs.find((leg) => leg.venue === "polymarket");
  return previousLeg?.payoutUsd === null && nextLeg?.payoutUsd !== null;
}

export function isLatePrimaryFillRescueEligible(intent: OrderIntent, recentOrders: LiveOrder[]) {
  const failureReason = intent.failureReason?.toLowerCase() ?? "";
  if (
    failureReason.includes("hedge") ||
    failureReason.includes("unwind") ||
    failureReason.includes("manual cleanup") ||
    failureReason.includes("manual intervention required")
  ) {
    return false;
  }

  if (intent.legs.some((leg) => leg.status === "unwound" || leg.payoutUsd !== null)) {
    return false;
  }

  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  if (!primaryLeg) {
    return false;
  }

  return !Boolean(findLatestIntentReduceOnlyOrder(recentOrders, intent.id, primaryLeg));
}

export function derivePrimaryExitSize(params: {
  filledSize: number;
  positionSize?: number | null;
  sellableSize?: number | null;
}) {
  const candidates = [params.filledSize, params.positionSize ?? null, params.sellableSize ?? null].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );

  if (candidates.length === 0) {
    return 0;
  }

  return floorToSixDecimals(Math.min(...candidates));
}

export function deriveRemainingExposureSize(entryFilledSize: number, exitFilledSize: number) {
  return roundToSixDecimals(Math.max(0, entryFilledSize - exitFilledSize));
}

export function deriveLiveRemainingLegSize(
  positions: PositionSnapshot[],
  leg: Pick<OrderIntent["legs"][number], "venue" | "marketRef" | "outcome" | "tokenId">,
) {
  const matchingPositions = positions.filter(
    (position) =>
      position.venue === leg.venue &&
      position.marketRef === leg.marketRef &&
      position.outcome === leg.outcome,
  );
  if (matchingPositions.length === 0) {
    return 0;
  }

  const exactMatch =
    leg.tokenId === undefined
      ? null
      : matchingPositions.find((position) => {
          const rawTokenId = extractPositionTokenId(position);
          return rawTokenId !== null && rawTokenId === leg.tokenId;
        });
  const matchedPosition = exactMatch ?? matchingPositions[0];
  return roundToSixDecimals(Math.max(0, matchedPosition.size));
}

export function summarizeIntentLegFills(
  fills: LiveFill[],
  leg: Pick<OrderIntent["legs"][number], "venue" | "marketRef" | "outcome" | "tokenId" | "side">,
  mode: "entry" | "exit",
) {
  const expectedSide = mode === "entry" ? leg.side : leg.side === "BUY" ? "SELL" : "BUY";
  const matchingFills = fills.filter(
    (fill) =>
      fill.venue === leg.venue &&
      fill.marketRef === leg.marketRef &&
      fill.outcome === leg.outcome &&
      fill.side === expectedSide &&
      (leg.tokenId === undefined || fill.tokenId === undefined || fill.tokenId === leg.tokenId),
  );

  if (matchingFills.length === 0) {
    return null;
  }

  return summarizeVenueFills(matchingFills);
}

export function isRetryablePolymarketInventorySyncError(error: unknown) {
  const normalized = toErrorMessage(error).toLowerCase();
  return (
    normalized.includes("no exitable size") ||
    normalized.includes("not enough balance / allowance") ||
    normalized.includes("balance is not enough") ||
    normalized.includes("allowance is not enough")
  );
}

export function isPolymarketOrderbookUnavailableError(error: unknown) {
  const normalized = toErrorMessage(error).toLowerCase();
  return normalized.includes("orderbook") && normalized.includes("does not exist");
}

async function closeIntentAfterPolymarketOrderbookUnavailable(
  intent: OrderIntent,
  primaryLeg: OrderIntent["legs"][number],
  now: number,
  errorMessage: string,
) {
  const slotSlug = buildPolymarketSlotSlug(intent.asset, intent.slotStartTs);
  const polyResolution = await fetchPolymarketResolution(slotSlug).catch(() => null);
  const failureReason =
    polyResolution === null
      ? `Primary unwind impossible after Polymarket market close (${errorMessage}); waiting for venue settlement / reclaim`
      : `Primary unwind impossible after Polymarket market close (${errorMessage}); market resolved ${polyResolution}, waiting for reclaim`;

  const deferredIntent: OrderIntent = {
    ...intent,
    status: "unwind_required",
    updatedAt: now,
    resolvedAt: null,
    failureReason,
    polyResolution: polyResolution ?? intent.polyResolution,
    legs: intent.legs.map((leg) =>
      leg.id === primaryLeg.id
        ? {
            ...leg,
            resolvedOutcome: polyResolution ?? leg.resolvedOutcome,
          }
        : leg,
    ) as OrderIntent["legs"],
  };

  await writeOrderIntent(deferredIntent);
  await writeRunEvent({
    level: "warn",
    eventType: "intent.unwind.awaiting_polymarket_settlement",
    message: `Intent ${intent.id} deferred to Polymarket settlement after the orderbook disappeared`,
    payload: {
      intentId: intent.id,
      slotKey: intent.slotKey,
      orderbookUnavailable: true,
      error: errorMessage,
      polyResolution,
    },
    createdAt: now,
  });
  return deferredIntent;
}

function extractPositionTokenId(position: PositionSnapshot) {
  if (typeof position.raw.asset === "string") {
    return position.raw.asset;
  }
  if (typeof position.raw.asset_id === "string") {
    return position.raw.asset_id;
  }
  if (typeof position.raw.tokenId === "string") {
    return position.raw.tokenId;
  }
  if (typeof position.raw.token_id === "string") {
    return position.raw.token_id;
  }
  if (position.id.startsWith("polymarket:")) {
    return position.id.slice("polymarket:".length);
  }
  return null;
}

async function runReconcileStep(step: string, now: number, fn: () => Promise<void>) {
  try {
    await withTimeout(fn, RECONCILE_STEP_TIMEOUT_MS, `reconcile step ${step} timed out after ${RECONCILE_STEP_TIMEOUT_MS}ms`);
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

function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });

  return Promise.race([fn(), timeoutPromise]).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }) as Promise<T>;
}
