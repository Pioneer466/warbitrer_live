import { getCurrentSlot } from "@/lib/slot";
import { fetchKalshiQuote, fetchKalshiResolution } from "@/lib/kalshi";
import { fetchPolymarketQuote, fetchPolymarketResolution } from "@/lib/polymarket";
import {
  readLastEntryCosts,
  readOpenTrades,
  readSettings,
  resolveTrade,
  writeSnapshot,
  writeTrade,
  writeWorkerState,
} from "@/lib/storage";
import { buildSignals } from "@/lib/signals";
import { createTradeFromSignal, settleTrade } from "@/lib/settlement";

export async function processTick(now = new Date()) {
  const settings = await readSettings();
  const slot = getCurrentSlot(now);
  await writeWorkerState({
    currentSlotKey: slot.key,
    lastTickAt: now.getTime(),
    lastError: null,
  });

  try {
    const [polymarket, kalshi] = await Promise.all([
      fetchPolymarketQuote(slot),
      fetchKalshiQuote(slot),
    ]);

    const signals = buildSignals({
      polymarket,
      kalshi,
      settings,
      lastEntryCosts: await readLastEntryCosts(slot.key),
    });

    await writeSnapshot({
      slotKey: slot.key,
      slotStartTs: slot.startTs,
      slotEndTs: slot.endTs,
      capturedAt: now.getTime(),
      polymarket,
      kalshi,
      signals,
    });

    for (const signal of signals.filter((candidate) => candidate.eligible)) {
      await writeTrade(
        createTradeFromSignal({
          signal,
          polymarket,
          kalshi,
          enteredAt: now.getTime(),
          slotKey: slot.key,
          slotStartTs: slot.startTs,
          slotEndTs: slot.endTs,
        }),
      );
    }

    await settleResolvedTrades(now);
    await writeWorkerState({
      currentSlotKey: slot.key,
      lastTickAt: now.getTime(),
      lastError: null,
    });
  } catch (error) {
    await writeWorkerState({
      currentSlotKey: slot.key,
      lastTickAt: now.getTime(),
      lastError: error instanceof Error ? error.message : "Erreur inconnue",
    });
    throw error;
  }
}

export async function settleResolvedTrades(now = new Date()) {
  const openTrades = (await readOpenTrades()).filter((trade) => trade.slotEndTs <= now.getTime());

  for (const trade of openTrades) {
    const polyLeg = trade.legs.find((leg) => leg.venue === "polymarket");
    const kalshiLeg = trade.legs.find((leg) => leg.venue === "kalshi");

    if (!polyLeg || !kalshiLeg) {
      continue;
    }

    const [polyResolution, kalshiResolution] = await Promise.all([
      fetchPolymarketResolution(trade.slotKey ? `btc-updown-15m-${Math.floor(trade.slotStartTs / 1000)}` : polyLeg.marketRef),
      fetchKalshiResolution(kalshiLeg.marketRef),
    ]);

    if (!polyResolution || !kalshiResolution) {
      continue;
    }

    await resolveTrade(
      settleTrade({
        trade,
        polyResolution,
        kalshiResolution,
        resolvedAt: now.getTime(),
      }),
    );
  }
}
