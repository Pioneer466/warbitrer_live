import { isRiskActivePosition } from "@/lib/positions";
import type { PnlSnapshot, PositionSnapshot, VenueBalance } from "@/lib/types";

export function buildPnlSnapshot({
  capturedAt,
  balances,
  positions,
  realizedPnlUsd,
  feesUsd,
}: {
  capturedAt: number;
  balances: VenueBalance[];
  positions: PositionSnapshot[];
  realizedPnlUsd: number;
  feesUsd: number;
}): PnlSnapshot {
  const cashUsd = round4(balances.reduce((sum, balance) => sum + balance.availableBalanceUsd, 0));
  const equityUsd = round4(balances.reduce((sum, balance) => sum + balance.totalBalanceUsd, 0));
  const positionsValueUsd = round4(Math.max(0, equityUsd - cashUsd));
  const unrealizedPnlUsd = round4(
    positions.reduce((sum, position) => sum + (isRiskActivePosition(position) ? position.unrealizedPnlUsd : 0), 0),
  );

  return enrichPnlSnapshot({
    capturedAt,
    cashUsd,
    equityUsd,
    positionsValueUsd,
    realizedPnlUsd: round4(realizedPnlUsd),
    unrealizedPnlUsd,
    feesUsd: round4(feesUsd),
    venueBreakdown: balances,
  });
}

export function enrichPnlSnapshot(
  snapshot: Omit<PnlSnapshot, "strategyPnlUsd" | "accountDeltaUsd" | "baselineEquityUsd" | "peakEquityUsd" | "drawdownUsd">,
  baselineEquityUsd?: number | null,
  peakEquityUsd?: number | null,
): PnlSnapshot {
  const effectiveBaseline = baselineEquityUsd ?? snapshot.equityUsd;
  const effectivePeak = peakEquityUsd ?? snapshot.equityUsd;
  const strategyPnlUsd = round4(snapshot.realizedPnlUsd + snapshot.unrealizedPnlUsd);

  return {
    ...snapshot,
    strategyPnlUsd,
    accountDeltaUsd: round4(snapshot.equityUsd - effectiveBaseline),
    baselineEquityUsd: effectiveBaseline,
    peakEquityUsd: effectivePeak,
    drawdownUsd: round4(snapshot.equityUsd - effectivePeak),
  };
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
