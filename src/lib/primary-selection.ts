import type { LiveOpportunity, OpportunityLeg, PrimarySelectionAudit, PrimarySelectionMode, Venue } from "@/lib/types";

const KALSHI_TIE_PREFERENCE_RATIO = 1.1;
const SCORE_SLIPPAGE_PENALTY_BPS = 1_000;

export type PrimaryCandidateScore = {
  venue: Venue;
  score: number;
  coveredSize: number;
  coverageRatio: number;
  vwap: number | null;
  slippageBps: number | null;
};

export function scorePrimaryCandidate(
  leg: Pick<OpportunityLeg, "venue" | "depth" | "price" | "size">,
  _hedgeLeg: Pick<OpportunityLeg, "depth" | "size">,
): PrimaryCandidateScore {
  const targetSize = Math.max(0, leg.size);
  const visibleDepth = normalizeDepth(leg.depth);
  const coveredSize = Math.min(targetSize, visibleDepth);
  const coverageRatio = targetSize > 0 ? visibleDepth / targetSize : 0;
  const slippageBps = 0;
  const slippagePenalty = Math.max(0, 1 - slippageBps / SCORE_SLIPPAGE_PENALTY_BPS);

  return {
    venue: leg.venue,
    score: coverageRatio * slippagePenalty,
    coveredSize,
    coverageRatio,
    vwap: leg.price,
    slippageBps,
  };
}

export function choosePrimaryVenueForOpportunity(
  opportunity: Pick<LiveOpportunity, "legs">,
  mode: PrimarySelectionMode,
): { primaryVenue: Venue | null; audit: PrimarySelectionAudit | null } {
  const polymarketLeg = opportunity.legs.find((leg) => leg.venue === "polymarket");
  const kalshiLeg = opportunity.legs.find((leg) => leg.venue === "kalshi");
  if (!polymarketLeg || !kalshiLeg) {
    return { primaryVenue: null, audit: null };
  }

  const polymarketScore = scorePrimaryCandidate(polymarketLeg, kalshiLeg);
  const kalshiScore = scorePrimaryCandidate(kalshiLeg, polymarketLeg);
  const recommendedPrimaryVenue = recommendPrimaryVenue(polymarketScore, kalshiScore);
  const livePrimaryVenue =
    mode === "dynamic"
      ? recommendedPrimaryVenue
      : mode === "kalshi_only" || mode === "shadow"
        ? "kalshi"
        : "kalshi";

  return {
    primaryVenue: livePrimaryVenue,
    audit: {
      mode,
      livePrimaryVenue,
      recommendedPrimaryVenue,
      polymarketScore: finiteOrNull(polymarketScore.score),
      kalshiScore: finiteOrNull(kalshiScore.score),
      polymarketCoveredSize: finiteOrNull(polymarketScore.coveredSize),
      kalshiCoveredSize: finiteOrNull(kalshiScore.coveredSize),
      polymarketCoverageRatio: finiteOrNull(polymarketScore.coverageRatio),
      kalshiCoverageRatio: finiteOrNull(kalshiScore.coverageRatio),
      reason: describePrimarySelectionRecommendation(polymarketScore, kalshiScore, recommendedPrimaryVenue),
    },
  };
}

function recommendPrimaryVenue(polymarketScore: PrimaryCandidateScore, kalshiScore: PrimaryCandidateScore): Venue {
  if (kalshiScore.score <= polymarketScore.score * KALSHI_TIE_PREFERENCE_RATIO) {
    return "kalshi";
  }
  return "polymarket";
}

function describePrimarySelectionRecommendation(
  polymarketScore: PrimaryCandidateScore,
  kalshiScore: PrimaryCandidateScore,
  recommended: Venue,
) {
  if (recommended === "kalshi") {
    return kalshiScore.score <= polymarketScore.score
      ? "kalshi_scarcer_leg"
      : "kalshi_tie_preference";
  }
  return "polymarket_scarcer_leg";
}

function normalizeDepth(depth: number | null) {
  return typeof depth === "number" && Number.isFinite(depth) && depth > 0 ? depth : 0;
}

function finiteOrNull(value: number) {
  return Number.isFinite(value) ? value : null;
}
