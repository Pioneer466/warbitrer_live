import { fetchPolymarketDepositAddresses } from "@/lib/bridge";
import { fetchBtcSlotResolution, toKalshiResolution } from "@/lib/btc-resolution";
import { applySlippage } from "@/lib/fees";
import {
  createKalshiAdapter,
  fetchKalshiFills,
  fetchKalshiOrders,
  fetchKalshiQuote,
  fetchKalshiResolution,
} from "@/lib/kalshi";
import {
  createPolymarketAdapter,
  fetchPolymarketOpenOrders,
  fetchPolymarketQuote,
  fetchPolymarketResolution,
  fetchPolymarketTrades,
  mapPolymarketOrder,
  mapPolymarketTradeToFill,
} from "@/lib/polymarket";
import { buildSignals } from "@/lib/signals";
import { calculateWinningPayout, createIntentFromOpportunity, finalizeIntent, markIntentStatus } from "@/lib/settlement";
import { getCurrentSlot } from "@/lib/slot";
import {
  findOrderIntent,
  findVenueOrder,
  readBridgeTransfers,
  readCircuitBreakers,
  readLastEntryCosts,
  readLatestSnapshot,
  readOpenOrderIntents,
  readRecentFills,
  readRecentVenueOrders,
  readSettings,
  readVenueBalances,
  replaceVenuePositions,
  writeBridgeTransfer,
  writeCircuitBreaker,
  writeFill,
  writeOrderIntent,
  writePnlSnapshot,
  writeRunEvent,
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
  OrderIntent,
  PositionSnapshot,
  StrategyConfig,
  VenueAdapter,
  VenueBalance,
  VenueOrderRequest,
  WorkerState,
} from "@/lib/types";

const RESOLUTION_GRACE_MS = 5_000;
const POLYMARKET_SETTLEMENT_LOOKBACK = 50;

const kalshiAdapter = createKalshiAdapter();
const polymarketAdapter = createPolymarketAdapter();

export async function processTick(now = new Date()) {
  const nowTs = now.getTime();
  const settings = await readSettings();
  const slot = getCurrentSlot(now);

  await writeWorkerState({
    phase: "scan",
    currentSlotKey: slot.key,
    lastError: null,
  });

  const coordinator = createExecutionCoordinator(settings);
  const errors: string[] = [];

  try {
    await coordinator.scan(slot, nowTs);
  } catch (error) {
    errors.push(toErrorMessage(error));
  }

  try {
    await writeWorkerState({
      phase: "execute",
      currentSlotKey: slot.key,
    });
    await coordinator.execute(slot, nowTs);
  } catch (error) {
    errors.push(toErrorMessage(error));
  }

  try {
    await writeWorkerState({
      phase: "reconcile",
      currentSlotKey: slot.key,
    });
    await coordinator.reconcile(slot, nowTs);
  } catch (error) {
    errors.push(toErrorMessage(error));
  }

  await writeWorkerState({
    phase: "idle",
    currentSlotKey: slot.key,
    lastScanAt: nowTs,
    lastExecuteAt: nowTs,
    lastReconcileAt: nowTs,
    lastError: errors[0] ?? null,
  });

  if (errors.length > 0) {
    throw new Error(errors.join(" | "));
  }
}

export function createExecutionCoordinator(settings: StrategyConfig): ExecutionCoordinator {
  return {
    async scan(slot, now) {
      const balances = await refreshBalances(settings, now);
      const [polymarket, kalshi] = await Promise.all([
        fetchPolymarketQuote(slot),
        fetchKalshiQuote(slot),
      ]);

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

      return {
        slotKey: slot.key,
        slotStartTs: slot.startTs,
        slotEndTs: slot.endTs,
        capturedAt: now,
        polymarket,
        kalshi,
        opportunities,
      };
    },

    async execute(slot, now) {
      const readiness = await computeReadiness(now);
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

      const snapshot = await refreshLatestSnapshot(slot);
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

      for (const opportunity of eligible.slice(0, settings.maxOpenIntentsPerSlot - openForSlot.length)) {
        const intent = createIntentFromOpportunity({
          opportunity,
          slotStartTs: slot.startTs,
          slotEndTs: slot.endTs,
          now,
          maxSlippageBps: settings.maxSlippageBps,
          shadow: settings.shadowMode,
        });

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

      await reconcileVenueOrders(now);
      await reconcileSettlements(now);
      await refreshPnl(now, [...polyPositions, ...kalshiPositions]);

      if ((await readBridgeTransfers(1)).length === 0) {
        const depositAddresses = await fetchPolymarketDepositAddresses().catch(() => null);
        if (depositAddresses) {
          await writeBridgeTransfer(depositAddresses);
        }
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
        balance.status = balance.status === "ready" ? "degraded" : balance.status;
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

async function computeReadiness(now: number): Promise<{ state: Partial<WorkerState>; breakers: Awaited<ReturnType<typeof readCircuitBreakers>> }> {
  const balances = await readVenueBalances();
  const breakers = await readCircuitBreakers();
  const checks = balances.map((balance) => ({
    key: `${balance.venue}:balance`,
    label: `${balance.venue} readiness`,
    status: balance.status,
    details: balance.notes.join(" | ") || "Venue ready",
    checkedAt: now,
  }));
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

async function executeIntent(intent: OrderIntent, settings: StrategyConfig, now: number) {
  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
  const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
  if (!primaryLeg || !hedgeLeg) {
    throw new Error(`Intent ${intent.id} missing legs`);
  }

  let currentIntent = markIntentStatus(intent, "executing_primary", now);
  await writeOrderIntent(currentIntent);

  const primaryRequest = buildVenueOrderRequest(primaryLeg, settings.maxSlippageBps, "FOK", false);
  const primaryResult = await adapterFor(currentIntent.primaryVenue).placeOrder(primaryRequest);
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
  if (primaryResult.status !== "filled") {
    currentIntent = markIntentStatus(currentIntent, "failed", now, "Primary order not filled");
    await writeOrderIntent(currentIntent);
    return currentIntent;
  }

  if (currentIntent.primaryVenue === "polymarket") {
    currentIntent = await attachRecentPolymarketFills(currentIntent);
  }

  currentIntent = markIntentStatus(currentIntent, "hedging", Date.now());
  await writeOrderIntent(currentIntent);

  const hedgeRequest = buildVenueOrderRequest(hedgeLeg, settings.maxSlippageBps, "FOK", false);
  const hedgeResult = await adapterFor(currentIntent.hedgeVenue).placeOrder(hedgeRequest);
  const hedgeOrder = buildLiveOrderRecord(currentIntent.id, hedgeLeg, hedgeRequest, hedgeResult, Date.now());
  await writeVenueOrder(hedgeOrder);

  if (hedgeResult.status === "filled") {
    currentIntent = updateIntentLeg(currentIntent, hedgeLeg.venue, hedgeOrder, "hedged", Date.now());
    currentIntent = markIntentStatus(currentIntent, "hedged", Date.now());
    if (currentIntent.hedgeVenue === "polymarket") {
      currentIntent = await attachRecentPolymarketFills(currentIntent);
    }
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
  const matching = trades.filter((trade) => intent.legs.some((leg) => leg.venueOrderId === trade.taker_order_id));

  for (const trade of matching) {
    const leg = intent.legs.find((candidate) => candidate.venueOrderId === trade.taker_order_id);
    if (!leg) {
      continue;
    }

    await writeFill(mapPolymarketTradeToFill(trade, intent.id));
    const weightedPrice = Number(trade.price);
    intent = updateIntentLegWithFill(intent, leg.venue, Number(trade.size), weightedPrice, Number(trade.price) * Number(trade.size) * (Number(trade.fee_rate_bps) / 10_000));
  }

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
  const result = await adapterFor(primaryLeg.venue).placeOrder(request);
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
      (order) => order.venue === "polymarket" && order.venueOrderId === trade.taker_order_id,
    );
    if (!existingOrder) {
      continue;
    }

    await writeFill(mapPolymarketTradeToFill(trade, existingOrder.intentId));
    const intent = await findOrderIntent(existingOrder.intentId);
    if (!intent) {
      continue;
    }
    const updatedIntent = updateIntentLegWithFill(
      intent,
      "polymarket",
      Number(trade.size),
      Number(trade.price),
      Number(trade.price) * Number(trade.size) * (Number(trade.fee_rate_bps) / 10_000),
    );
    await writeOrderIntent(updatedIntent);
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
      price: Number(fill.yes_price_dollars),
      size: Number(fill.count_fp),
      feeUsd: 0,
      liquidity: fill.is_taker ? "TAKER" : "MAKER",
      filledAt: fill.created_time ? Date.parse(fill.created_time) : now,
      raw: fill as unknown as Record<string, unknown>,
    });

    const intent = await findOrderIntent(existingOrder.intentId);
    if (!intent) {
      continue;
    }
    const updatedIntent = updateIntentLegWithFill(
      intent,
      "kalshi",
      Number(fill.count_fp),
      Number(fill.yes_price_dollars),
      0,
    );
    await writeOrderIntent(updatedIntent);
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

function updateIntentLegWithFill(
  intent: OrderIntent,
  venue: OrderIntent["legs"][number]["venue"],
  fillSize: number,
  fillPrice: number,
  feeUsd: number,
) {
  return {
    ...intent,
    updatedAt: Date.now(),
    legs: intent.legs.map((leg) =>
      leg.venue === venue
        ? {
            ...leg,
            filledSize: round4(leg.filledSize + fillSize),
            filledPrice: fillPrice,
            feeUsd: round4(leg.feeUsd + feeUsd),
            status: leg.status === "unwound" ? "unwound" : "filled",
          }
        : leg,
    ) as OrderIntent["legs"],
  };
}

function adapterFor(venue: OrderIntent["primaryVenue"]) {
  return venue === "polymarket" ? polymarketAdapter : kalshiAdapter;
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
