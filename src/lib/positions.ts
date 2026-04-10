import type { PositionSnapshot } from "@/lib/types";

const POSITION_VALUE_EPSILON_USD = 0.05;
const POSITION_SIZE_EPSILON = 0.05;

export function isRiskActivePosition(position: PositionSnapshot) {
  const meaningfulValue = Math.abs(position.currentValueUsd) > POSITION_VALUE_EPSILON_USD;
  const meaningfulSize = Math.abs(position.size) > POSITION_SIZE_EPSILON;

  if (position.venue === "polymarket" && (position.redeemable || position.mergeable)) {
    return meaningfulValue;
  }

  return meaningfulValue || meaningfulSize;
}
