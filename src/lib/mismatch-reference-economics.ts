import { POLYMARKET_MIN_MARKET_BUY_AMOUNT_USD } from "@/lib/constants";
import {
  calculateKalshiFee,
  calculatePolymarketLevelFee,
} from "@/lib/fees";
import type {
  KalshiQuote,
  LiveOpportunity,
  MismatchEconomicsBasis,
  PolymarketQuote,
  StrategyConfig,
} from "@/lib/types";

export type MismatchEstimateEconomics = {
  basis: MismatchEconomicsBasis;
  pairSize: number | null;
  totalCostUsd: number | null;
};

export function deriveMismatchEstimateEconomics(input: {
  opportunity: LiveOpportunity;
  polymarket: PolymarketQuote;
  kalshi: KalshiQuote;
  settings: Pick<StrategyConfig, "minOrderSize">;
}): MismatchEstimateEconomics {
  const executablePairSize = Math.min(
    input.opportunity.legs[0].size,
    input.opportunity.legs[1].size,
  );
  const executableTotalCostUsd = input.opportunity.legs.reduce(
    (sum, leg) => sum + leg.targetNotionalUsd + leg.feeEstimateUsd,
    0,
  );
  if (
    isPositiveFinite(executablePairSize) &&
    isPositiveFinite(executableTotalCostUsd)
  ) {
    return {
      basis: "executable",
      pairSize: executablePairSize,
      totalCostUsd: executableTotalCostUsd,
    };
  }

  const polymarketLeg = input.opportunity.legs.find(
    (leg) => leg.venue === "polymarket",
  );
  const kalshiLeg = input.opportunity.legs.find(
    (leg) => leg.venue === "kalshi",
  );
  const polymarketPrice = polymarketLeg?.price;
  const kalshiPrice = kalshiLeg?.price;
  if (
    !isProbabilityPrice(polymarketPrice) ||
    !isProbabilityPrice(kalshiPrice)
  ) {
    return { basis: "unavailable", pairSize: null, totalCostUsd: null };
  }

  const referencePairSize = Math.ceil(
    Math.max(
      1,
      input.settings.minOrderSize,
      polymarketLeg?.minOrderSize ?? 0,
      kalshiLeg?.minOrderSize ?? 0,
      POLYMARKET_MIN_MARKET_BUY_AMOUNT_USD / polymarketPrice,
    ),
  );
  if (!isPositiveFinite(referencePairSize)) {
    return { basis: "unavailable", pairSize: null, totalCostUsd: null };
  }

  const polymarketFeeUsd = calculatePolymarketLevelFee({
    shares: referencePairSize,
    price: polymarketPrice,
    feeRateBps:
      polymarketLeg?.outcome === "UP"
        ? input.polymarket.outcomes.up.feeRateBps ?? input.polymarket.feeRateBps
        : input.polymarket.outcomes.down.feeRateBps ?? input.polymarket.feeRateBps,
    feeRate: input.polymarket.feeRate ?? undefined,
    feeExponent: input.polymarket.feeExponent ?? undefined,
  });
  const kalshiFeeUsd = calculateKalshiFee({
    contracts: referencePairSize,
    price: kalshiPrice,
    feeMultiplier: input.kalshi.feeMultiplier,
  });
  const totalCostUsd =
    referencePairSize * (polymarketPrice + kalshiPrice) +
    polymarketFeeUsd +
    kalshiFeeUsd;

  return {
    basis: "reference",
    pairSize: referencePairSize,
    totalCostUsd: round4(totalCostUsd),
  };
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isProbabilityPrice(value: number | null | undefined): value is number {
  return isPositiveFinite(value) && value <= 1;
}

function round4(value: number) {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}
