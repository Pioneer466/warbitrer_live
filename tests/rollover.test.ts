import { createDb, getLastEntryCosts, getOpenTrades, getSettings, insertSnapshot, insertTrade, updateTradeResolution } from "@/lib/db";
import { buildSignals } from "@/lib/signals";
import { createTradeFromSignal, settleTrade } from "@/lib/settlement";
import type { KalshiQuote, PolymarketQuote, SnapshotRecord } from "@/lib/types";

function createSnapshot(slotKey: string, slotStartTs: number): SnapshotRecord {
  const polymarket: PolymarketQuote = {
    ref: {
      venue: "polymarket",
      id: "poly-market",
      slotKey: slotKey,
      slug: `btc-updown-15m-${Math.floor(slotStartTs / 1000)}`,
      title: "Poly BTC",
      url: "https://polymarket.com/event/test",
      startTime: new Date(slotStartTs).toISOString(),
      endTime: new Date(slotStartTs + 900_000).toISOString(),
    },
    status: "open",
    slotAligned: true,
    availabilityReason: null,
    outcomes: {
      up: { outcome: "UP", buyPrice: 0.4, sellPrice: 0.41, midPrice: 0.405, bestBid: 0.41, bestAsk: 0.4, depth: 100 },
      down: { outcome: "DOWN", buyPrice: 0.6, sellPrice: 0.61, midPrice: 0.605, bestBid: 0.61, bestAsk: 0.6, depth: 100 },
    },
    feeRate: 0.25,
    feeExponent: 2,
    feeType: "crypto_fees_v2",
    feeScheduleRaw: { rate: 0.25, exponent: 2, takerOnly: true, rebateRate: 0.2 },
    resolution: null,
    tokenIds: { up: "up", down: "down" },
  };

  const kalshi: KalshiQuote = {
    ref: {
      venue: "kalshi",
      id: "kalshi-market",
      slotKey: slotKey,
      ticker: "kalshi-market",
      seriesTicker: "KXBTC15M",
      title: "Kalshi BTC",
      url: "https://kalshi.com/test",
      startTime: new Date(slotStartTs).toISOString(),
      endTime: new Date(slotStartTs + 900_000).toISOString(),
    },
    status: "active",
    slotAligned: true,
    availabilityReason: null,
    outcomes: {
      yes: { outcome: "YES", buyPrice: 0.34, sellPrice: 0.33, midPrice: 0.335, bestBid: 0.33, bestAsk: 0.34, depth: 120 },
      no: { outcome: "NO", buyPrice: 0.49, sellPrice: 0.48, midPrice: 0.485, bestBid: 0.48, bestAsk: 0.49, depth: 120 },
    },
    feeMultiplier: 1,
    feeType: "quadratic",
    resolution: null,
  };

  const settings = {
    ...getSettings(createDb(":memory:")),
  };
  const signals = buildSignals({
    polymarket,
    kalshi,
    settings,
    lastEntryCosts: {},
  });

  return {
    slotKey,
    slotStartTs,
    slotEndTs: slotStartTs + 900_000,
    capturedAt: slotStartTs + 30_000,
    polymarket,
    kalshi,
    signals,
  };
}

describe("rollover flow", () => {
  it("stores one slot, settles its trade, and rolls into the next slot cleanly", () => {
    const db = createDb(":memory:");
    const settings = getSettings(db);

    const firstSnapshot = createSnapshot("slot-1", 1_000_000);
    insertSnapshot(db, firstSnapshot);

    const signal = buildSignals({
      polymarket: firstSnapshot.polymarket,
      kalshi: firstSnapshot.kalshi,
      settings,
      lastEntryCosts: getLastEntryCosts(db, "slot-1"),
    })[0];

    const trade = createTradeFromSignal({
      signal,
      polymarket: firstSnapshot.polymarket,
      kalshi: firstSnapshot.kalshi,
      enteredAt: firstSnapshot.capturedAt,
      slotKey: firstSnapshot.slotKey,
      slotStartTs: firstSnapshot.slotStartTs,
      slotEndTs: firstSnapshot.slotEndTs,
    });

    insertTrade(db, trade);
    expect(getOpenTrades(db)).toHaveLength(1);

    updateTradeResolution(
      db,
      settleTrade({
        trade,
        polyResolution: "UP",
        kalshiResolution: "YES",
        resolvedAt: 1_900_000,
      }),
    );
    expect(getOpenTrades(db)).toHaveLength(0);

    const secondSnapshot = createSnapshot("slot-2", 1_900_000);
    insertSnapshot(db, secondSnapshot);
    expect(getLastEntryCosts(db, "slot-2")).toEqual({});
  });
});
