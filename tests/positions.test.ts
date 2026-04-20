import { isRiskActivePosition } from "@/lib/positions";
import type { PositionSnapshot } from "@/lib/types";

function buildPosition(overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
  const base: PositionSnapshot = {
    id: "position-1",
    asset: "btc",
    venue: "polymarket",
    marketRef: "market-1",
    outcome: "UP",
    size: 10,
    averagePrice: 0.4,
    currentPrice: 0,
    currentValueUsd: 0,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: -4,
    redeemable: false,
    mergeable: false,
    updatedAt: 1,
    raw: {},
  };

  return {
    ...base,
    ...overrides,
    asset: overrides.asset ?? base.asset,
  };
}

describe("risk active positions", () => {
  it("hides polymarket recovery-only ghosts from open positions", () => {
    expect(
      isRiskActivePosition(
        buildPosition({
          redeemable: true,
          size: 140.31,
          currentValueUsd: 0,
          unrealizedPnlUsd: -47.65,
        }),
      ),
    ).toBe(false);
  });

  it("keeps live-valued polymarket positions visible", () => {
    expect(
      isRiskActivePosition(
        buildPosition({
          redeemable: true,
          currentValueUsd: 12.34,
        }),
      ),
    ).toBe(true);
  });

  it("keeps non-polymarket positions visible when they still have size", () => {
    expect(
      isRiskActivePosition(
        buildPosition({
          venue: "kalshi",
          redeemable: false,
          mergeable: false,
          size: 3,
          currentValueUsd: 0,
        }),
      ),
    ).toBe(true);
  });
});
