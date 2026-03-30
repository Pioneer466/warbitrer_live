import { fetchBtcSlotResolution, toKalshiResolution } from "@/lib/btc-resolution";
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

const RESOLUTION_GRACE_MS = 5_000;

export async function processTick(now = new Date()) {
  const settings = await readSettings();
  const slot = getCurrentSlot(now);
  await writeWorkerState({
    currentSlotKey: slot.key,
    lastTickAt: now.getTime(),
    lastError: null,
  });

  const errors: string[] = [];

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
  } catch (error) {
    errors.push(toErrorMessage(error));
  }

  try {
    await settleResolvedTrades(now);
  } catch (error) {
    errors.push(toErrorMessage(error));
  }

  await writeWorkerState({
    currentSlotKey: slot.key,
    lastTickAt: now.getTime(),
    lastError: errors[0] ?? null,
  });

  if (errors.length > 0) {
    throw new Error(errors.join(" | "));
  }
}

export async function settleResolvedTrades(now = new Date()) {
  const openTrades = (await readOpenTrades()).filter(
    (trade) => trade.slotEndTs + RESOLUTION_GRACE_MS <= now.getTime(),
  );
  const resolutionCache = new Map<
    string,
    {
      polyResolution: "UP" | "DOWN" | null;
      kalshiResolution: "YES" | "NO" | null;
    }
  >();

  for (const trade of openTrades) {
    try {
      const polyLeg = trade.legs.find((leg) => leg.venue === "polymarket");
      const kalshiLeg = trade.legs.find((leg) => leg.venue === "kalshi");

      if (!polyLeg || !kalshiLeg) {
        continue;
      }

      const resolutionKey = `${trade.slotStartTs}:${trade.slotEndTs}`;

      if (!resolutionCache.has(resolutionKey)) {
        let referenceResolution: "UP" | "DOWN" | null = null;

        try {
          referenceResolution = await fetchBtcSlotResolution(trade.slotStartTs, trade.slotEndTs);
        } catch {
          referenceResolution = null;
        }

        let polyResolution: "UP" | "DOWN" | null = referenceResolution;
        let kalshiResolution: "YES" | "NO" | null =
          referenceResolution === null ? null : toKalshiResolution(referenceResolution);

        if (!polyResolution || !kalshiResolution) {
          [polyResolution, kalshiResolution] = await Promise.all([
            fetchPolymarketResolution(
              trade.slotKey
                ? `btc-updown-15m-${Math.floor(trade.slotStartTs / 1000)}`
                : polyLeg.marketRef,
            ),
            fetchKalshiResolution(kalshiLeg.marketRef),
          ]);
        }

        resolutionCache.set(resolutionKey, {
          polyResolution,
          kalshiResolution,
        });
      }

      const { polyResolution, kalshiResolution } = resolutionCache.get(resolutionKey)!;

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
    } catch {
      continue;
    }
  }
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Erreur inconnue";
}
