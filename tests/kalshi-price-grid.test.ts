import {
  getKalshiOutcomeTickSize,
  isKalshiOutcomePriceValid,
  moveKalshiOutcomePriceByTicks,
  normalizeKalshiOutcomePrice,
  parseKalshiPriceGrid,
  type KalshiPriceRange,
} from "@/lib/kalshi-price-grid";

const LINEAR_CENT: KalshiPriceRange[] = [{ start: "0.0000", end: "1.0000", step: "0.0100" }];
const DECI_CENT: KalshiPriceRange[] = [{ start: "0.0000", end: "1.0000", step: "0.0010" }];
const TAPERED: KalshiPriceRange[] = [
  { start: "0.0000", end: "0.1000", step: "0.0010" },
  { start: "0.1000", end: "0.9000", step: "0.0100" },
  { start: "0.9000", end: "1.0000", step: "0.0010" },
];

describe("Kalshi authoritative price grids", () => {
  it("normalizes linear and decicent prices conservatively", () => {
    expect(
      normalizeKalshiOutcomePrice({ price: 0.4513, outcome: "YES", side: "BUY", priceRanges: LINEAR_CENT }),
    ).toMatchObject({ price: 0.46, yesBookPrice: 0.46, bookSide: "bid", adjusted: true });
    expect(
      normalizeKalshiOutcomePrice({ price: 0.4513, outcome: "YES", side: "SELL", priceRanges: LINEAR_CENT }),
    ).toMatchObject({ price: 0.45, yesBookPrice: 0.45, bookSide: "ask", adjusted: true });
    expect(
      normalizeKalshiOutcomePrice({ price: 0.4513, outcome: "YES", side: "BUY", priceRanges: DECI_CENT }),
    ).toMatchObject({ price: 0.452, yesBookPrice: 0.452 });
  });

  it.each([
    ["BUY YES", "YES" as const, "BUY" as const, 0.4513, "bid", 0.46],
    ["SELL NO", "NO" as const, "SELL" as const, 0.5487, "bid", 0.54],
    ["BUY NO", "NO" as const, "BUY" as const, 0.5487, "ask", 0.55],
    ["SELL YES", "YES" as const, "SELL" as const, 0.4513, "ask", 0.45],
  ])("normalizes %s using the YES book", (_label, outcome, side, price, bookSide, expected) => {
    expect(normalizeKalshiOutcomePrice({ price, outcome, side, priceRanges: LINEAR_CENT })).toMatchObject({
      price: expected,
      bookSide,
    });
  });

  it("walks the dynamic grid across tapered boundaries", () => {
    expect(
      moveKalshiOutcomePriceByTicks({ price: 0.099, outcome: "YES", side: "BUY", ticks: 1, priceRanges: TAPERED }),
    ).toMatchObject({ price: 0.1 });
    expect(
      moveKalshiOutcomePriceByTicks({ price: 0.1, outcome: "YES", side: "BUY", ticks: 1, priceRanges: TAPERED }),
    ).toMatchObject({ price: 0.11 });
    expect(
      moveKalshiOutcomePriceByTicks({ price: 0.9, outcome: "YES", side: "SELL", ticks: 1, priceRanges: TAPERED }),
    ).toMatchObject({ price: 0.89 });
    expect(
      moveKalshiOutcomePriceByTicks({ price: 0.901, outcome: "NO", side: "BUY", ticks: 1, priceRanges: TAPERED }),
    ).toMatchObject({ price: 0.902 });
  });

  it("derives the directional tick at a range boundary", () => {
    expect(getKalshiOutcomeTickSize({ price: 0.1, outcome: "YES", side: "BUY", priceRanges: TAPERED })).toBe(0.01);
    expect(getKalshiOutcomeTickSize({ price: 0.1, outcome: "YES", side: "SELL", priceRanges: TAPERED })).toBe(0.001);
  });

  it("rejects missing, malformed, gapped, overlapping, or incomplete grids", () => {
    expect(() => parseKalshiPriceGrid([])).toThrow("price_ranges is missing");
    expect(() => parseKalshiPriceGrid([{ start: "0", end: "1", step: "0.00001" }])).toThrow("Invalid");
    expect(() =>
      parseKalshiPriceGrid([
        { start: "0", end: "0.5", step: "0.01" },
        { start: "0.6", end: "1", step: "0.01" },
      ]),
    ).toThrow("ordered and contiguous");
    expect(() => parseKalshiPriceGrid([{ start: "0.1", end: "1", step: "0.01" }])).toThrow("must cover");
  });

  it("validates exact grid membership and rejects non-tradable endpoints", () => {
    expect(isKalshiOutcomePriceValid({ price: 0.45, outcome: "YES", priceRanges: LINEAR_CENT })).toBe(true);
    expect(isKalshiOutcomePriceValid({ price: 0.451, outcome: "YES", priceRanges: LINEAR_CENT })).toBe(false);
    expect(isKalshiOutcomePriceValid({ price: 0, outcome: "YES", priceRanges: LINEAR_CENT })).toBe(false);
    expect(isKalshiOutcomePriceValid({ price: 1, outcome: "NO", priceRanges: LINEAR_CENT })).toBe(false);
  });
});
