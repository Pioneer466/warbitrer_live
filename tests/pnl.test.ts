import { buildPnlSnapshot } from "@/lib/pnl";
import type { PositionSnapshot, VenueBalance } from "@/lib/types";

describe("pnl snapshot", () => {
  it("derives equity from venue totals and realized pnl from aggregated intents", () => {
    const balances: VenueBalance[] = [
      {
        venue: "kalshi",
        capturedAt: 1,
        status: "ready",
        currency: "USD",
        availableBalanceUsd: 33.89,
        totalBalanceUsd: 33.89,
        portfolioValueUsd: 33.89,
        allowanceUsd: null,
        notes: [],
        raw: {},
      },
      {
        venue: "polymarket",
        capturedAt: 1,
        status: "ready",
        currency: "USDC",
        availableBalanceUsd: 69.58,
        totalBalanceUsd: 71.99,
        portfolioValueUsd: 71.99,
        allowanceUsd: 69.58,
        notes: [],
        raw: {},
      },
    ];

    const positions: PositionSnapshot[] = [
      {
        id: "kalshi:one",
        venue: "kalshi",
        marketRef: "KXBTC15M-1",
        outcome: "YES",
        size: 20.51,
        averagePrice: null,
        currentPrice: null,
        currentValueUsd: 9.6397,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        redeemable: false,
        mergeable: false,
        updatedAt: 1,
        raw: {},
      },
    ];

    const snapshot = buildPnlSnapshot({
      capturedAt: 10,
      balances,
      positions,
      realizedPnlUsd: 12.34,
      feesUsd: 11.36,
    });

    expect(snapshot.cashUsd).toBeCloseTo(103.47, 4);
    expect(snapshot.equityUsd).toBeCloseTo(105.88, 4);
    expect(snapshot.positionsValueUsd).toBeCloseTo(2.41, 4);
    expect(snapshot.realizedPnlUsd).toBeCloseTo(12.34, 4);
    expect(snapshot.unrealizedPnlUsd).toBeCloseTo(0, 4);
    expect(snapshot.strategyPnlUsd).toBeCloseTo(12.34, 4);
    expect(snapshot.accountDeltaUsd).toBeCloseTo(0, 4);
    expect(snapshot.baselineEquityUsd).toBeCloseTo(105.88, 4);
    expect(snapshot.peakEquityUsd).toBeCloseTo(105.88, 4);
    expect(snapshot.drawdownUsd).toBeCloseTo(0, 4);
    expect(snapshot.feesUsd).toBeCloseTo(11.36, 4);
  });

  it("ignores polymarket recovery-only ghosts in unrealized pnl", () => {
    const balances: VenueBalance[] = [
      {
        venue: "polymarket",
        capturedAt: 1,
        status: "ready",
        currency: "USDC",
        availableBalanceUsd: 100,
        totalBalanceUsd: 100,
        portfolioValueUsd: 100,
        allowanceUsd: 100,
        notes: [],
        raw: {},
      },
    ];

    const positions: PositionSnapshot[] = [
      {
        id: "polymarket:ghost",
        venue: "polymarket",
        marketRef: "ghost-market",
        outcome: "UP",
        size: 140.31,
        averagePrice: 0.3396,
        currentPrice: 0,
        currentValueUsd: 0,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: -47.65,
        redeemable: true,
        mergeable: false,
        updatedAt: 1,
        raw: {},
      },
    ];

    const snapshot = buildPnlSnapshot({
      capturedAt: 10,
      balances,
      positions,
      realizedPnlUsd: 0,
      feesUsd: 0,
    });

    expect(snapshot.unrealizedPnlUsd).toBe(0);
    expect(snapshot.strategyPnlUsd).toBe(0);
  });
});
