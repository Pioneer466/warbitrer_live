import { deriveKalshiOutcomeQuotes, extractKalshiLastTradePrices } from "@/lib/kalshi";
import { applyLevelDelta, computeFeedStatus } from "@/lib/market-data";

describe("market data helpers", () => {
  it("marks feeds ready, degraded, then blocked as staleness grows", () => {
    expect(computeFeedStatus(1_000, true, 2_000)).toEqual({
      status: "ready",
      stalenessMs: 1_000,
    });
    expect(computeFeedStatus(1_000, true, 4_500)).toEqual({
      status: "degraded",
      stalenessMs: 3_500,
    });
    expect(computeFeedStatus(1_000, true, 8_000)).toEqual({
      status: "blocked",
      stalenessMs: 7_000,
    });
  });

  it("applies top-of-book level deltas and removes empty levels", () => {
    const levels = new Map<string, number>([
      ["0.34", 10],
      ["0.35", 20],
    ]);

    applyLevelDelta(levels, "0.35", 18);
    applyLevelDelta(levels, "0.36", 12);
    applyLevelDelta(levels, "0.34", 0);

    const quotes = deriveKalshiOutcomeQuotes({
      yes_dollars: [...levels.entries()].map(([price, size]) => [price, String(size)] as [string, string]),
      no_dollars: [
        ["0.61", "15"],
        ["0.62", "8"],
      ],
    });

    expect(quotes.yes.sellPrice).toBe(0.36);
    expect(quotes.no.buyPrice).toBe(0.64);
  });

  it("extracts the freshest Kalshi trade price for audit purposes", () => {
    const tradePrices = extractKalshiLastTradePrices([
      {
        yes_price_dollars: "0.33",
        created_time: "2026-04-01T10:00:00.000Z",
      },
      {
        yes_price_dollars: "0.35",
        created_time: "2026-04-01T10:00:01.000Z",
      },
    ]);

    expect(tradePrices.yes).toBe(0.35);
    expect(tradePrices.no).toBe(0.65);
  });
});
