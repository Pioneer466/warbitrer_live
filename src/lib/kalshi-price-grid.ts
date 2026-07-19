import type { OrderSide } from "@/lib/types";

export type KalshiPriceRange = {
  start: string;
  end: string;
  step: string;
};

export type KalshiBookSide = "bid" | "ask";

export class KalshiPriceGridError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KalshiPriceGridError";
  }
}

const PRICE_SCALE = 10_000;
const PRICE_PATTERN = /^(?:0(?:\.\d{1,4})?|1(?:\.0{1,4})?)$/;

export function parseKalshiPriceGrid(ranges: readonly KalshiPriceRange[]) {
  if (ranges.length === 0) {
    throw new KalshiPriceGridError("Kalshi price_ranges is missing");
  }

  const parsed = ranges.map((range, index) => {
    const start = parseFixedPrice(range.start, `price_ranges[${index}].start`);
    const end = parseFixedPrice(range.end, `price_ranges[${index}].end`);
    const step = parseFixedPrice(range.step, `price_ranges[${index}].step`);
    if (start >= end) {
      throw new KalshiPriceGridError(`Kalshi price range ${index} must have start < end`);
    }
    if (step <= 0 || (end - start) % step !== 0) {
      throw new KalshiPriceGridError(`Kalshi price range ${index} has an invalid step`);
    }
    return { start, end, step };
  });

  if (parsed[0]?.start !== 0 || parsed.at(-1)?.end !== PRICE_SCALE) {
    throw new KalshiPriceGridError("Kalshi price_ranges must cover 0.0000 through 1.0000");
  }
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index]!.start !== parsed[index - 1]!.end) {
      throw new KalshiPriceGridError("Kalshi price_ranges must be ordered and contiguous");
    }
  }

  const units = new Set<number>();
  for (const range of parsed) {
    for (let price = range.start; price <= range.end; price += range.step) {
      units.add(price);
    }
  }

  const prices = [...units].sort((left, right) => left - right);
  if (prices.length < 2 || prices[0] !== 0 || prices.at(-1) !== PRICE_SCALE) {
    throw new KalshiPriceGridError("Kalshi price_ranges produced an incomplete grid");
  }
  return prices;
}

export function getKalshiV2BookDirection(outcome: "YES" | "NO", side: OrderSide): KalshiBookSide {
  return (outcome === "YES") === (side === "BUY") ? "bid" : "ask";
}

export function normalizeKalshiOutcomePrice(input: {
  price: number;
  outcome: "YES" | "NO";
  side: OrderSide;
  priceRanges: readonly KalshiPriceRange[];
}) {
  const yesPriceUnits = toPriceUnits(input.outcome === "YES" ? input.price : 1 - input.price, "order price");
  const grid = parseKalshiPriceGrid(input.priceRanges);
  const bookSide = getKalshiV2BookDirection(input.outcome, input.side);
  const normalizedYesUnits = findGridPrice(grid, yesPriceUnits, bookSide === "bid" ? "ceil" : "floor");
  assertTradablePrice(normalizedYesUnits);
  const outcomeUnits = input.outcome === "YES" ? normalizedYesUnits : PRICE_SCALE - normalizedYesUnits;

  return {
    price: fromPriceUnits(outcomeUnits),
    yesBookPrice: fromPriceUnits(normalizedYesUnits),
    bookSide,
    adjusted: normalizedYesUnits !== yesPriceUnits,
  };
}

export function moveKalshiOutcomePriceByTicks(input: {
  price: number;
  outcome: "YES" | "NO";
  side: OrderSide;
  ticks: number;
  priceRanges: readonly KalshiPriceRange[];
}) {
  if (!Number.isSafeInteger(input.ticks) || input.ticks < 0) {
    throw new KalshiPriceGridError(`Invalid Kalshi tick count: ${input.ticks}`);
  }

  const normalized = normalizeKalshiOutcomePrice(input);
  const grid = parseKalshiPriceGrid(input.priceRanges);
  const yesUnits = toPriceUnits(normalized.yesBookPrice, "normalized YES price");
  const index = grid.indexOf(yesUnits);
  if (index < 0) {
    throw new KalshiPriceGridError("Normalized Kalshi price is absent from its grid");
  }

  const direction = normalized.bookSide === "bid" ? 1 : -1;
  const targetIndex = index + direction * input.ticks;
  const targetYesUnits = grid[targetIndex];
  if (targetYesUnits === undefined) {
    throw new KalshiPriceGridError("Kalshi tick movement leaves the tradable price grid");
  }
  assertTradablePrice(targetYesUnits);

  return {
    price: fromPriceUnits(input.outcome === "YES" ? targetYesUnits : PRICE_SCALE - targetYesUnits),
    yesBookPrice: fromPriceUnits(targetYesUnits),
    bookSide: normalized.bookSide,
  };
}

export function getKalshiOutcomeTickSize(input: {
  price: number;
  outcome: "YES" | "NO";
  side: OrderSide;
  priceRanges: readonly KalshiPriceRange[];
}) {
  const current = normalizeKalshiOutcomePrice(input);
  if (current.adjusted) {
    throw new KalshiPriceGridError("Kalshi quote price is not on the authoritative grid");
  }
  const adjacent = moveKalshiOutcomePriceByTicks({ ...input, ticks: 1 });
  return fromPriceUnits(Math.abs(toPriceUnits(adjacent.price, "adjacent price") - toPriceUnits(input.price, "price")));
}

export function isKalshiOutcomePriceValid(input: {
  price: number;
  outcome: "YES" | "NO";
  priceRanges: readonly KalshiPriceRange[];
}) {
  try {
    const yesUnits = toPriceUnits(input.outcome === "YES" ? input.price : 1 - input.price, "price");
    return yesUnits > 0 && yesUnits < PRICE_SCALE && parseKalshiPriceGrid(input.priceRanges).includes(yesUnits);
  } catch {
    return false;
  }
}

function findGridPrice(grid: number[], price: number, direction: "ceil" | "floor") {
  const candidate =
    direction === "ceil" ? grid.find((entry) => entry >= price) : grid.findLast((entry) => entry <= price);
  if (candidate === undefined) {
    throw new KalshiPriceGridError("Kalshi order price is outside the authoritative grid");
  }
  return candidate;
}

function parseFixedPrice(value: string, label: string) {
  if (!PRICE_PATTERN.test(value)) {
    throw new KalshiPriceGridError(`Invalid ${label}: ${value}`);
  }
  return toPriceUnits(Number(value), label);
}

function toPriceUnits(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new KalshiPriceGridError(`Invalid ${label}: ${value}`);
  }
  const scaled = value * PRICE_SCALE;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-7) {
    throw new KalshiPriceGridError(`${label} exceeds four decimal places: ${value}`);
  }
  return rounded;
}

function fromPriceUnits(value: number) {
  return Number((value / PRICE_SCALE).toFixed(4));
}

function assertTradablePrice(value: number) {
  if (value <= 0 || value >= PRICE_SCALE) {
    throw new KalshiPriceGridError("Kalshi order price must be strictly between 0 and 1");
  }
}
