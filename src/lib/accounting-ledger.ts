import { createHash } from "node:crypto";

import type {
  LiveFill,
  MarketAsset,
  OrderIntent,
  OrderIntentLeg,
  PairCombination,
  Resolution,
  SettlementRecord,
  Venue,
} from "@/lib/types";

const SCALE = 100_000_000n;
const SCALE_NUMBER = 100_000_000;
const MAX_FIXED_UNITS = BigInt(Number.MAX_SAFE_INTEGER);
const TERMINAL_ACCOUNTING_STATUSES = new Set<OrderIntent["status"]>(["settled", "unwound"]);
const MARKET_ASSETS = new Set<MarketAsset>(["btc", "eth", "sol", "xrp", "doge", "bnb", "hype"]);
const VENUES = new Set<Venue>(["polymarket", "kalshi"]);
const PAIR_COMBINATIONS = new Set<PairCombination>(["POLY_UP_KALSHI_NO", "POLY_DOWN_KALSHI_YES"]);

export const ACCOUNTING_LEDGER_SCHEMA = "warbitrer.accounting-ledger.v1" as const;
export const ACCOUNTING_EVIDENCE_SCHEMA = "warbitrer.accounting-evidence.v1" as const;
export const ACCOUNTING_LEDGER_SCALE = SCALE_NUMBER;

export type AccountingEvidenceFinality = "final" | "non_final" | "ambiguous";

export type AccountingIntentIdentity = Pick<
  OrderIntent,
  | "id"
  | "asset"
  | "shadow"
  | "slotKey"
  | "slotStartTs"
  | "slotEndTs"
  | "combination"
  | "status"
  | "primaryVenue"
  | "hedgeVenue"
  | "resolvedAt"
>;

export type AccountingLegIdentity = Pick<
  OrderIntentLeg,
  "id" | "intentId" | "venue" | "outcome" | "marketRef" | "tokenId"
>;

export type AccountingFillEvidence = Pick<
  LiveFill,
  | "id"
  | "asset"
  | "shadow"
  | "intentId"
  | "venue"
  | "venueOrderId"
  | "tradeId"
  | "marketRef"
  | "tokenId"
  | "side"
  | "outcome"
  | "price"
  | "size"
  | "feeUsd"
  | "filledAt"
> & {
  legId: string;
  finality: AccountingEvidenceFinality;
};

export type AccountingSettlementEvidence = Pick<
  SettlementRecord,
  "id" | "asset" | "intentId" | "venue" | "marketRef" | "outcome" | "resolvedOutcome" | "payoutUsd" | "settledAt"
> & {
  legId: string;
  shadow: boolean;
  tokenId?: string;
  settledSize: number;
  feeUsd: number;
  finality: AccountingEvidenceFinality;
};

export type AccountingLedgerInput = {
  version: number;
  capturedAt: number;
  evidenceCompleteness: "complete" | "partial" | "ambiguous";
  intent: AccountingIntentIdentity;
  legs: readonly [AccountingLegIdentity, AccountingLegIdentity];
  fills: readonly AccountingFillEvidence[];
  settlements: readonly AccountingSettlementEvidence[];
};

export type AccountingLedgerErrorCode =
  | "invalid_version"
  | "invalid_intent"
  | "missing_leg"
  | "invalid_leg"
  | "incoherent_identity"
  | "incomplete_evidence"
  | "non_final_evidence"
  | "duplicate_evidence"
  | "missing_settlement"
  | "unexpected_settlement"
  | "settlement_mismatch"
  | "negative_position"
  | "invalid_number"
  | "out_of_domain"
  | "overflow"
  | "invalid_delta";

export class AccountingLedgerError extends Error {
  constructor(
    public readonly code: AccountingLedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AccountingLedgerError";
  }
}

type ExactAccountingAmounts = {
  costBasisUsd: string;
  payoutUsd: string;
  feesUsd: string;
  realizedPnlUsd: string;
  roi: string | null;
};

type NumericAccountingAmounts = {
  costBasisUsd: number;
  payoutUsd: number;
  feesUsd: number;
  realizedPnlUsd: number;
  roi: number | null;
};

export type AccountingLegProjection = NumericAccountingAmounts & {
  legId: string;
  venue: Venue;
  outcome: Resolution;
  boughtSize: number;
  soldSize: number;
  settledSize: number;
  exact: ExactAccountingAmounts & {
    boughtSize: string;
    soldSize: string;
    settledSize: string;
  };
};

export type CanonicalAccountingProof = {
  schema: typeof ACCOUNTING_LEDGER_SCHEMA;
  version: number;
  capturedAt: number;
  evidenceCompleteness: "complete";
  intent: {
    id: string;
    asset: MarketAsset;
    shadow: boolean;
    slotKey: string;
    slotStartTs: number;
    slotEndTs: number;
    combination: PairCombination;
    status: "settled" | "unwound";
    primaryVenue: Venue;
    hedgeVenue: Venue;
    resolvedAt: number;
  };
  legs: Array<{
    id: string;
    intentId: string;
    venue: Venue;
    outcome: Resolution;
    marketRef: string;
    tokenId: string | null;
  }>;
  fills: Array<{
    id: string;
    legId: string;
    asset: MarketAsset;
    shadow: boolean;
    intentId: string;
    venue: Venue;
    venueOrderId: string;
    tradeId: string;
    marketRef: string;
    tokenId: string | null;
    side: "BUY" | "SELL";
    outcome: Resolution;
    price: string;
    size: string;
    grossUsd: string;
    feeUsd: string;
    filledAt: number;
    finality: "final";
  }>;
  settlements: Array<{
    id: string;
    legId: string;
    asset: MarketAsset;
    shadow: boolean;
    intentId: string;
    venue: Venue;
    marketRef: string;
    tokenId: string | null;
    outcome: Resolution;
    resolvedOutcome: Resolution;
    settledSize: string;
    payoutUsd: string;
    feeUsd: string;
    settledAt: number;
    finality: "final";
  }>;
  legTotals: Array<{
    legId: string;
    venue: Venue;
    outcome: Resolution;
    boughtSize: string;
    soldSize: string;
    settledSize: string;
    costBasisUsd: string;
    payoutUsd: string;
    feesUsd: string;
    realizedPnlUsd: string;
    roi: string | null;
  }>;
  totals: ExactAccountingAmounts;
};

export type CanonicalAccountingEvidence = {
  schema: typeof ACCOUNTING_EVIDENCE_SCHEMA;
  intent: Omit<CanonicalAccountingProof["intent"], "status" | "resolvedAt">;
  legs: CanonicalAccountingProof["legs"];
  fills: CanonicalAccountingProof["fills"];
  settlements: CanonicalAccountingProof["settlements"];
  legTotals: CanonicalAccountingProof["legTotals"];
  totals: CanonicalAccountingProof["totals"];
};

export type AccountingLedgerProjection = NumericAccountingAmounts & {
  schema: typeof ACCOUNTING_LEDGER_SCHEMA;
  version: number;
  intentId: string;
  capturedAt: number;
  legs: AccountingLegProjection[];
  exact: ExactAccountingAmounts;
  evidence: CanonicalAccountingEvidence;
  evidenceJson: string;
  evidenceSha256: string;
  proof: CanonicalAccountingProof;
  proofJson: string;
  proofSha256: string;
};

export type AccountingLedgerDelta = NumericAccountingAmounts & {
  intentId: string;
  fromVersion: number;
  toVersion: number;
  fromProofSha256: string;
  toProofSha256: string;
  fromEvidenceSha256: string;
  toEvidenceSha256: string;
  exact: ExactAccountingAmounts;
};

type FixedFill = {
  evidence: AccountingFillEvidence;
  price: bigint;
  size: bigint;
  gross: bigint;
  fee: bigint;
};

type FixedSettlement = {
  evidence: AccountingSettlementEvidence & { resolvedOutcome: Resolution };
  settledSize: bigint;
  payout: bigint;
  fee: bigint;
};

type FixedLegProjection = {
  leg: AccountingLegIdentity;
  boughtSize: bigint;
  soldSize: bigint;
  settledSize: bigint;
  costBasis: bigint;
  payout: bigint;
  fees: bigint;
  realizedPnl: bigint;
  roi: bigint | null;
};

/**
 * Reduces a complete terminal evidence set without consulting requested order values.
 * ROI uses gross BUY cost plus every durable fill/settlement fee as its basis.
 */
export function calculateAccountingLedger(input: AccountingLedgerInput): AccountingLedgerProjection {
  validateSafeInteger(input.version, "version", 1, "invalid_version");
  validateSafeInteger(input.capturedAt, "capturedAt", 0, "invalid_intent");
  if (input.evidenceCompleteness !== "complete") {
    fail("incomplete_evidence", `Accounting evidence is ${input.evidenceCompleteness}, not complete`);
  }

  const intent = validateIntent(input.intent, input.capturedAt);
  const legs = validateLegs(intent, input.legs);
  const legById = new Map(legs.map((leg) => [leg.id, leg]));

  if (input.fills.length === 0) {
    fail("incomplete_evidence", "At least one durable final fill is required for realized accounting");
  }

  const fills = validateFills(input.fills, intent, legById, input.capturedAt);
  const settlements = validateSettlements(input.settlements, intent, legById, input.capturedAt);
  const fixedLegs = legs.map((leg) => calculateLeg(leg, fills, settlements, intent.status));

  const costBasis = checkedSum(
    fixedLegs.map((leg) => leg.costBasis),
    "total cost basis",
  );
  const payout = checkedSum(
    fixedLegs.map((leg) => leg.payout),
    "total payout",
  );
  const fees = checkedSum(
    fixedLegs.map((leg) => leg.fees),
    "total fees",
  );
  const realizedPnl = checkedFixed(payout - costBasis - fees, "total realized P&L");
  const roiBasis = checkedFixed(costBasis + fees, "total ROI basis");
  const roi = roiBasis > 0n ? divideFixed(realizedPnl, roiBasis, "total ROI") : null;

  const exact = exactAmounts(costBasis, payout, fees, realizedPnl, roi);
  const proof: CanonicalAccountingProof = {
    schema: ACCOUNTING_LEDGER_SCHEMA,
    version: input.version,
    capturedAt: input.capturedAt,
    evidenceCompleteness: "complete",
    intent,
    legs: legs.map(canonicalLeg),
    fills: fills.map(canonicalFill),
    settlements: settlements.map(canonicalSettlement),
    legTotals: fixedLegs.map((leg) => ({
      legId: leg.leg.id,
      venue: leg.leg.venue,
      outcome: leg.leg.outcome,
      boughtSize: formatFixed(leg.boughtSize),
      soldSize: formatFixed(leg.soldSize),
      settledSize: formatFixed(leg.settledSize),
      ...exactAmounts(leg.costBasis, leg.payout, leg.fees, leg.realizedPnl, leg.roi),
    })),
    totals: exact,
  };
  const proofJson = JSON.stringify(proof);
  const evidence = canonicalEvidenceFromProof(proof);
  const evidenceJson = JSON.stringify(evidence);

  return {
    schema: ACCOUNTING_LEDGER_SCHEMA,
    version: input.version,
    intentId: intent.id,
    capturedAt: input.capturedAt,
    ...numericAmounts(costBasis, payout, fees, realizedPnl, roi),
    legs: fixedLegs.map(toLegProjection),
    exact,
    evidence,
    evidenceJson,
    evidenceSha256: sha256(evidenceJson),
    proof,
    proofJson,
    proofSha256: sha256(proofJson),
  };
}

/** Computes the signed economic difference between two verified revisions of one intent. */
export function calculateAccountingLedgerDelta(
  previous: AccountingLedgerProjection,
  next: AccountingLedgerProjection,
): AccountingLedgerDelta {
  validateProjectionProof(previous, "previous");
  validateProjectionProof(next, "next");
  if (previous.intentId !== next.intentId) {
    fail("invalid_delta", "Accounting versions belong to different intents");
  }
  if (next.version <= previous.version) {
    fail("invalid_delta", "The next accounting version must be newer than the previous version");
  }
  if (
    JSON.stringify(previous.proof.intent) !== JSON.stringify(next.proof.intent) ||
    JSON.stringify(previous.proof.legs) !== JSON.stringify(next.proof.legs)
  ) {
    fail("invalid_delta", "Accounting identity changed between versions");
  }

  const previousTotals = fixedTotalsFromProof(previous.proof.totals);
  const nextTotals = fixedTotalsFromProof(next.proof.totals);
  const costBasis = checkedFixed(nextTotals.costBasis - previousTotals.costBasis, "cost basis delta");
  const payout = checkedFixed(nextTotals.payout - previousTotals.payout, "payout delta");
  const fees = checkedFixed(nextTotals.fees - previousTotals.fees, "fees delta");
  const realizedPnl = checkedFixed(nextTotals.realizedPnl - previousTotals.realizedPnl, "realized P&L delta");
  const roi =
    previousTotals.roi === null || nextTotals.roi === null
      ? null
      : checkedFixed(nextTotals.roi - previousTotals.roi, "ROI delta");

  return {
    intentId: previous.intentId,
    fromVersion: previous.version,
    toVersion: next.version,
    fromProofSha256: previous.proofSha256,
    toProofSha256: next.proofSha256,
    fromEvidenceSha256: previous.evidenceSha256,
    toEvidenceSha256: next.evidenceSha256,
    ...numericAmounts(costBasis, payout, fees, realizedPnl, roi),
    exact: exactAmounts(costBasis, payout, fees, realizedPnl, roi),
  };
}

function validateIntent(input: AccountingIntentIdentity, capturedAt: number): CanonicalAccountingProof["intent"] {
  const id = requiredId(input.id, "intent.id", "invalid_intent");
  const slotKey = requiredId(input.slotKey, "intent.slotKey", "invalid_intent");
  if (!MARKET_ASSETS.has(input.asset) || typeof input.shadow !== "boolean") {
    fail("invalid_intent", "Intent asset or execution mode is invalid");
  }
  if (!PAIR_COMBINATIONS.has(input.combination)) {
    fail("invalid_intent", `Intent ${id} has an invalid pair combination`);
  }
  if (!VENUES.has(input.primaryVenue) || !VENUES.has(input.hedgeVenue)) {
    fail("invalid_intent", `Intent ${id} has an invalid execution venue`);
  }
  validateSafeInteger(input.slotStartTs, "intent.slotStartTs", 0, "invalid_intent");
  validateSafeInteger(input.slotEndTs, "intent.slotEndTs", 1, "invalid_intent");
  if (input.slotEndTs <= input.slotStartTs) {
    fail("invalid_intent", "Intent slot end must be after slot start");
  }
  if (!TERMINAL_ACCOUNTING_STATUSES.has(input.status)) {
    fail("invalid_intent", `Intent ${id} is not terminal for realized accounting`);
  }
  if (input.resolvedAt === null) {
    fail("invalid_intent", `Intent ${id} has no durable resolution timestamp`);
  }
  validateSafeInteger(input.resolvedAt, "intent.resolvedAt", 0, "invalid_intent");
  if (input.resolvedAt > capturedAt) {
    fail("invalid_intent", "Intent resolution is newer than the evidence capture");
  }
  if (input.resolvedAt < input.slotStartTs) {
    fail("invalid_intent", "Intent resolution predates its canonical slot");
  }
  if (input.primaryVenue === input.hedgeVenue) {
    fail("invalid_intent", "Primary and hedge venues must differ");
  }

  return {
    id,
    asset: input.asset,
    shadow: input.shadow,
    slotKey,
    slotStartTs: input.slotStartTs,
    slotEndTs: input.slotEndTs,
    combination: input.combination,
    status: input.status as "settled" | "unwound",
    primaryVenue: input.primaryVenue,
    hedgeVenue: input.hedgeVenue,
    resolvedAt: input.resolvedAt,
  };
}

function validateLegs(
  intent: CanonicalAccountingProof["intent"],
  input: readonly AccountingLegIdentity[],
): AccountingLegIdentity[] {
  if (input.length !== 2) {
    fail("missing_leg", `Expected exactly two accounting legs, received ${input.length}`);
  }

  const ids = new Set<string>();
  const venues = new Set<Venue>();
  const legs = input.map((leg) => {
    const id = requiredId(leg.id, "leg.id", "invalid_leg");
    if (!VENUES.has(leg.venue)) {
      fail("invalid_leg", `Leg ${id} has an invalid venue`);
    }
    if (ids.has(id)) {
      fail("invalid_leg", `Duplicate leg id ${id}`);
    }
    ids.add(id);
    if (leg.intentId !== intent.id) {
      fail("incoherent_identity", `Leg ${id} belongs to a different intent`);
    }
    if (venues.has(leg.venue)) {
      fail("invalid_leg", `Duplicate ${leg.venue} leg`);
    }
    venues.add(leg.venue);
    const marketRef = requiredId(leg.marketRef, `leg ${id} marketRef`, "invalid_leg");
    const tokenId = optionalId(leg.tokenId, `leg ${id} tokenId`, "invalid_leg");
    if (leg.venue === "polymarket" && tokenId === null) {
      fail("invalid_leg", `Polymarket leg ${id} requires a token id`);
    }
    validateVenueOutcome(leg.venue, leg.outcome, `leg ${id}`);
    return { ...leg, id, marketRef, tokenId: tokenId ?? undefined };
  });

  if (!venues.has("polymarket") || !venues.has("kalshi")) {
    fail("missing_leg", "Accounting requires exactly one Polymarket leg and one Kalshi leg");
  }
  if (!venues.has(intent.primaryVenue) || !venues.has(intent.hedgeVenue)) {
    fail("incoherent_identity", "Intent primary/hedge venues do not match its legs");
  }

  const expected = expectedOutcomes(intent.combination);
  for (const leg of legs) {
    if (leg.outcome !== expected[leg.venue]) {
      fail("incoherent_identity", `${leg.venue} outcome does not match ${intent.combination}`);
    }
  }

  return legs.sort(compareLegs);
}

function validateFills(
  input: readonly AccountingFillEvidence[],
  intent: CanonicalAccountingProof["intent"],
  legById: Map<string, AccountingLegIdentity>,
  capturedAt: number,
): FixedFill[] {
  const ids = new Set<string>();
  const tradeKeys = new Set<string>();

  return input
    .map((fill) => {
      const id = requiredId(fill.id, "fill.id", "incoherent_identity");
      if (fill.finality !== "final") {
        fail("non_final_evidence", `Fill ${id} is ${fill.finality}`);
      }
      if (ids.has(id)) {
        fail("duplicate_evidence", `Duplicate fill id ${id}`);
      }
      ids.add(id);
      const venueOrderId = requiredId(fill.venueOrderId, `fill ${id} venueOrderId`, "incoherent_identity");
      const tradeId = requiredId(fill.tradeId, `fill ${id} tradeId`, "incoherent_identity");
      const tradeKey = `${fill.venue}\u0000${venueOrderId}\u0000${tradeId}`;
      if (tradeKeys.has(tradeKey)) {
        fail("duplicate_evidence", `Duplicate venue order trade ${fill.venue}/${venueOrderId}/${tradeId}`);
      }
      tradeKeys.add(tradeKey);

      const leg = legById.get(fill.legId);
      if (!leg) {
        fail("incoherent_identity", `Fill ${id} references unknown leg ${fill.legId}`);
      }
      assertEvidenceIdentity(fill, leg, intent, `Fill ${id}`);
      if (fill.side !== "BUY" && fill.side !== "SELL") {
        fail("out_of_domain", `Fill ${id} has invalid side ${String(fill.side)}`);
      }
      validateSafeInteger(fill.filledAt, `fill ${id} filledAt`, 0, "invalid_number");
      if (fill.filledAt > capturedAt) {
        fail("incoherent_identity", `Fill ${id} is newer than the evidence capture`);
      }

      const price = toFixed(fill.price, `fill ${id} price`, {
        minExclusive: 0n,
        max: SCALE,
        maximumErrorCode: "out_of_domain",
      });
      const size = toFixed(fill.size, `fill ${id} size`, { minExclusive: 0n, max: MAX_FIXED_UNITS });
      const fee = toFixed(fill.feeUsd, `fill ${id} feeUsd`, { min: 0n, max: MAX_FIXED_UNITS });
      const gross = multiplyFixed(price, size, `fill ${id} gross amount`);
      return {
        evidence: { ...fill, id, venueOrderId, tradeId },
        price,
        size,
        gross,
        fee,
      };
    })
    .sort(compareFills);
}

function validateSettlements(
  input: readonly AccountingSettlementEvidence[],
  intent: CanonicalAccountingProof["intent"],
  legById: Map<string, AccountingLegIdentity>,
  capturedAt: number,
): FixedSettlement[] {
  const ids = new Set<string>();
  const legIds = new Set<string>();

  return input
    .map((settlement) => {
      const id = requiredId(settlement.id, "settlement.id", "incoherent_identity");
      if (settlement.finality !== "final") {
        fail("non_final_evidence", `Settlement ${id} is ${settlement.finality}`);
      }
      if (ids.has(id) || legIds.has(settlement.legId)) {
        fail("duplicate_evidence", `Duplicate settlement evidence for ${id}/${settlement.legId}`);
      }
      ids.add(id);
      legIds.add(settlement.legId);
      const leg = legById.get(settlement.legId);
      if (!leg) {
        fail("incoherent_identity", `Settlement ${id} references unknown leg ${settlement.legId}`);
      }
      assertEvidenceIdentity(settlement, leg, intent, `Settlement ${id}`);
      if (settlement.resolvedOutcome === null) {
        fail("non_final_evidence", `Settlement ${id} has no final venue resolution`);
      }
      validateVenueOutcome(settlement.venue, settlement.resolvedOutcome, `settlement ${id}`);
      validateSafeInteger(settlement.settledAt, `settlement ${id} settledAt`, 0, "invalid_number");
      if (settlement.settledAt > capturedAt) {
        fail("incoherent_identity", `Settlement ${id} is newer than the evidence capture`);
      }
      const settledSize = toFixed(settlement.settledSize, `settlement ${id} settledSize`, {
        minExclusive: 0n,
        max: MAX_FIXED_UNITS,
      });
      const payout = toFixed(settlement.payoutUsd, `settlement ${id} payoutUsd`, {
        min: 0n,
        max: MAX_FIXED_UNITS,
      });
      const fee = toFixed(settlement.feeUsd, `settlement ${id} feeUsd`, {
        min: 0n,
        max: MAX_FIXED_UNITS,
      });
      const expectedPayout = settlement.outcome === settlement.resolvedOutcome ? settledSize : 0n;
      if (payout !== expectedPayout) {
        fail(
          "settlement_mismatch",
          `Settlement ${id} payout ${formatFixed(payout)} does not match final binary resolution`,
        );
      }
      return {
        evidence: { ...settlement, id, resolvedOutcome: settlement.resolvedOutcome },
        settledSize,
        payout,
        fee,
      };
    })
    .sort(compareSettlements);
}

function calculateLeg(
  leg: AccountingLegIdentity,
  fills: readonly FixedFill[],
  settlements: readonly FixedSettlement[],
  intentStatus: "settled" | "unwound",
): FixedLegProjection {
  const legFills = fills.filter((fill) => fill.evidence.legId === leg.id);
  const buyFills = legFills.filter((fill) => fill.evidence.side === "BUY");
  const sellFills = legFills.filter((fill) => fill.evidence.side === "SELL");
  const boughtSize = checkedSum(
    buyFills.map((fill) => fill.size),
    `leg ${leg.id} bought size`,
  );
  const soldSize = checkedSum(
    sellFills.map((fill) => fill.size),
    `leg ${leg.id} sold size`,
  );
  if (intentStatus === "settled" && boughtSize === 0n) {
    fail("incomplete_evidence", `Settled intent has no durable BUY fill for leg ${leg.id}`);
  }
  if (soldSize > boughtSize) {
    fail("negative_position", `Leg ${leg.id} sells more shares than its durable buys`);
  }

  const remainingSize = boughtSize - soldSize;
  const settlement = settlements.find((candidate) => candidate.evidence.legId === leg.id);
  if (remainingSize > 0n && !settlement) {
    fail("missing_settlement", `Leg ${leg.id} retains ${formatFixed(remainingSize)} shares without final settlement`);
  }
  if (remainingSize === 0n && settlement) {
    fail("unexpected_settlement", `Leg ${leg.id} has settlement evidence but no residual position`);
  }
  if (settlement && settlement.settledSize !== remainingSize) {
    fail(
      "settlement_mismatch",
      `Leg ${leg.id} settles ${formatFixed(settlement.settledSize)} of ${formatFixed(remainingSize)} residual shares`,
    );
  }
  const lastFillAt = legFills.reduce((latest, fill) => Math.max(latest, fill.evidence.filledAt), 0);
  if (settlement && settlement.evidence.settledAt < lastFillAt) {
    fail("settlement_mismatch", `Leg ${leg.id} has a fill timestamp after its final settlement`);
  }

  const costBasis = checkedSum(
    buyFills.map((fill) => fill.gross),
    `leg ${leg.id} cost basis`,
  );
  const saleProceeds = checkedSum(
    sellFills.map((fill) => fill.gross),
    `leg ${leg.id} sale proceeds`,
  );
  const payout = checkedFixed(saleProceeds + (settlement?.payout ?? 0n), `leg ${leg.id} payout`);
  const fees = checkedFixed(
    checkedSum(
      legFills.map((fill) => fill.fee),
      `leg ${leg.id} fill fees`,
    ) + (settlement?.fee ?? 0n),
    `leg ${leg.id} fees`,
  );
  const realizedPnl = checkedFixed(payout - costBasis - fees, `leg ${leg.id} realized P&L`);
  const roiBasis = checkedFixed(costBasis + fees, `leg ${leg.id} ROI basis`);

  return {
    leg,
    boughtSize,
    soldSize,
    settledSize: settlement?.settledSize ?? 0n,
    costBasis,
    payout,
    fees,
    realizedPnl,
    roi: roiBasis > 0n ? divideFixed(realizedPnl, roiBasis, `leg ${leg.id} ROI`) : null,
  };
}

function assertEvidenceIdentity(
  evidence: {
    asset: MarketAsset;
    shadow: boolean;
    intentId: string;
    legId: string;
    venue: Venue;
    marketRef: string;
    tokenId?: string;
    outcome: Resolution;
  },
  leg: AccountingLegIdentity,
  intent: CanonicalAccountingProof["intent"],
  label: string,
) {
  const tokenId = optionalId(evidence.tokenId, `${label} tokenId`, "incoherent_identity");
  const legTokenId = optionalId(leg.tokenId, `leg ${leg.id} tokenId`, "invalid_leg");
  if (
    evidence.asset !== intent.asset ||
    evidence.shadow !== intent.shadow ||
    evidence.intentId !== intent.id ||
    evidence.legId !== leg.id ||
    evidence.venue !== leg.venue ||
    evidence.marketRef !== leg.marketRef ||
    tokenId !== legTokenId ||
    evidence.outcome !== leg.outcome
  ) {
    fail("incoherent_identity", `${label} does not match its intent and leg identity`);
  }
}

function canonicalLeg(leg: AccountingLegIdentity): CanonicalAccountingProof["legs"][number] {
  return {
    id: leg.id,
    intentId: leg.intentId,
    venue: leg.venue,
    outcome: leg.outcome,
    marketRef: leg.marketRef,
    tokenId: optionalId(leg.tokenId, `leg ${leg.id} tokenId`, "invalid_leg"),
  };
}

function canonicalFill(fill: FixedFill): CanonicalAccountingProof["fills"][number] {
  return {
    id: fill.evidence.id,
    legId: fill.evidence.legId,
    asset: fill.evidence.asset,
    shadow: fill.evidence.shadow,
    intentId: fill.evidence.intentId,
    venue: fill.evidence.venue,
    venueOrderId: fill.evidence.venueOrderId,
    tradeId: fill.evidence.tradeId,
    marketRef: fill.evidence.marketRef,
    tokenId: optionalId(fill.evidence.tokenId, `fill ${fill.evidence.id} tokenId`, "incoherent_identity"),
    side: fill.evidence.side,
    outcome: fill.evidence.outcome,
    price: formatFixed(fill.price),
    size: formatFixed(fill.size),
    grossUsd: formatFixed(fill.gross),
    feeUsd: formatFixed(fill.fee),
    filledAt: fill.evidence.filledAt,
    finality: "final",
  };
}

function canonicalSettlement(settlement: FixedSettlement): CanonicalAccountingProof["settlements"][number] {
  return {
    id: settlement.evidence.id,
    legId: settlement.evidence.legId,
    asset: settlement.evidence.asset,
    shadow: settlement.evidence.shadow,
    intentId: settlement.evidence.intentId,
    venue: settlement.evidence.venue,
    marketRef: settlement.evidence.marketRef,
    tokenId: optionalId(
      settlement.evidence.tokenId,
      `settlement ${settlement.evidence.id} tokenId`,
      "incoherent_identity",
    ),
    outcome: settlement.evidence.outcome,
    resolvedOutcome: settlement.evidence.resolvedOutcome,
    settledSize: formatFixed(settlement.settledSize),
    payoutUsd: formatFixed(settlement.payout),
    feeUsd: formatFixed(settlement.fee),
    settledAt: settlement.evidence.settledAt,
    finality: "final",
  };
}

function toLegProjection(leg: FixedLegProjection): AccountingLegProjection {
  return {
    legId: leg.leg.id,
    venue: leg.leg.venue,
    outcome: leg.leg.outcome,
    boughtSize: fixedToNumber(leg.boughtSize),
    soldSize: fixedToNumber(leg.soldSize),
    settledSize: fixedToNumber(leg.settledSize),
    ...numericAmounts(leg.costBasis, leg.payout, leg.fees, leg.realizedPnl, leg.roi),
    exact: {
      boughtSize: formatFixed(leg.boughtSize),
      soldSize: formatFixed(leg.soldSize),
      settledSize: formatFixed(leg.settledSize),
      ...exactAmounts(leg.costBasis, leg.payout, leg.fees, leg.realizedPnl, leg.roi),
    },
  };
}

function exactAmounts(
  costBasis: bigint,
  payout: bigint,
  fees: bigint,
  realizedPnl: bigint,
  roi: bigint | null,
): ExactAccountingAmounts {
  return {
    costBasisUsd: formatFixed(costBasis),
    payoutUsd: formatFixed(payout),
    feesUsd: formatFixed(fees),
    realizedPnlUsd: formatFixed(realizedPnl),
    roi: roi === null ? null : formatFixed(roi),
  };
}

function numericAmounts(
  costBasis: bigint,
  payout: bigint,
  fees: bigint,
  realizedPnl: bigint,
  roi: bigint | null,
): NumericAccountingAmounts {
  return {
    costBasisUsd: fixedToNumber(costBasis),
    payoutUsd: fixedToNumber(payout),
    feesUsd: fixedToNumber(fees),
    realizedPnlUsd: fixedToNumber(realizedPnl),
    roi: roi === null ? null : fixedToNumber(roi),
  };
}

function fixedTotalsFromProof(totals: ExactAccountingAmounts) {
  return {
    costBasis: parseCanonicalFixed(totals.costBasisUsd, "proof cost basis"),
    payout: parseCanonicalFixed(totals.payoutUsd, "proof payout"),
    fees: parseCanonicalFixed(totals.feesUsd, "proof fees"),
    realizedPnl: parseCanonicalFixed(totals.realizedPnlUsd, "proof realized P&L"),
    roi: totals.roi === null ? null : parseCanonicalFixed(totals.roi, "proof ROI"),
  };
}

function validateProjectionProof(projection: AccountingLedgerProjection, label: string) {
  if (projection.proof.schema !== ACCOUNTING_LEDGER_SCHEMA || projection.schema !== ACCOUNTING_LEDGER_SCHEMA) {
    fail("invalid_delta", `${label} projection uses an unsupported accounting schema`);
  }
  const canonicalJson = JSON.stringify(projection.proof);
  const canonicalEvidence = canonicalEvidenceFromProof(projection.proof);
  const canonicalEvidenceJson = JSON.stringify(canonicalEvidence);
  if (
    projection.proofJson !== canonicalJson ||
    projection.proofSha256 !== sha256(canonicalJson) ||
    projection.evidenceJson !== canonicalEvidenceJson ||
    projection.evidenceSha256 !== sha256(canonicalEvidenceJson) ||
    JSON.stringify(projection.evidence) !== canonicalEvidenceJson ||
    projection.proof.version !== projection.version ||
    projection.proof.intent.id !== projection.intentId
  ) {
    fail("invalid_delta", `${label} projection proof is not internally consistent`);
  }
}

function canonicalEvidenceFromProof(proof: CanonicalAccountingProof): CanonicalAccountingEvidence {
  return {
    schema: ACCOUNTING_EVIDENCE_SCHEMA,
    intent: {
      id: proof.intent.id,
      asset: proof.intent.asset,
      shadow: proof.intent.shadow,
      slotKey: proof.intent.slotKey,
      slotStartTs: proof.intent.slotStartTs,
      slotEndTs: proof.intent.slotEndTs,
      combination: proof.intent.combination,
      primaryVenue: proof.intent.primaryVenue,
      hedgeVenue: proof.intent.hedgeVenue,
    },
    legs: proof.legs,
    fills: proof.fills,
    settlements: proof.settlements,
    legTotals: proof.legTotals,
    totals: proof.totals,
  };
}

function expectedOutcomes(combination: PairCombination): Record<Venue, Resolution> {
  switch (combination) {
    case "POLY_UP_KALSHI_NO":
      return { polymarket: "UP", kalshi: "NO" };
    case "POLY_DOWN_KALSHI_YES":
      return { polymarket: "DOWN", kalshi: "YES" };
  }
  fail("invalid_intent", `Unsupported pair combination ${String(combination)}`);
}

function validateVenueOutcome(venue: Venue, outcome: Resolution, label: string) {
  if (!VENUES.has(venue)) {
    fail("incoherent_identity", `${label} has invalid venue ${String(venue)}`);
  }
  const valid = venue === "polymarket" ? outcome === "UP" || outcome === "DOWN" : outcome === "YES" || outcome === "NO";
  if (!valid) {
    fail("incoherent_identity", `${label} has invalid ${venue} outcome ${outcome}`);
  }
}

function compareLegs(left: AccountingLegIdentity, right: AccountingLegIdentity) {
  return compareText(left.venue, right.venue) || compareText(left.id, right.id);
}

function compareFills(left: FixedFill, right: FixedFill) {
  return (
    compareText(left.evidence.venue, right.evidence.venue) ||
    compareText(left.evidence.marketRef, right.evidence.marketRef) ||
    compareText(left.evidence.outcome, right.evidence.outcome) ||
    left.evidence.filledAt - right.evidence.filledAt ||
    compareText(left.evidence.venueOrderId, right.evidence.venueOrderId) ||
    compareText(left.evidence.tradeId, right.evidence.tradeId) ||
    compareText(left.evidence.id, right.evidence.id)
  );
}

function compareSettlements(left: FixedSettlement, right: FixedSettlement) {
  return (
    compareText(left.evidence.venue, right.evidence.venue) ||
    compareText(left.evidence.marketRef, right.evidence.marketRef) ||
    compareText(left.evidence.outcome, right.evidence.outcome) ||
    left.evidence.settledAt - right.evidence.settledAt ||
    compareText(left.evidence.id, right.evidence.id)
  );
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requiredId(value: unknown, label: string, code: AccountingLedgerErrorCode): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(code, `${label} must be a non-empty canonical string`);
  }
  return value;
}

function optionalId(value: unknown, label: string, code: AccountingLedgerErrorCode): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requiredId(value, label, code);
}

function validateSafeInteger(value: unknown, label: string, minimum: number, code: AccountingLedgerErrorCode) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail(code, `${label} must be a safe integer >= ${minimum}`);
  }
}

function toFixed(
  value: unknown,
  label: string,
  bounds: {
    min?: bigint;
    minExclusive?: bigint;
    max: bigint;
    maximumErrorCode?: "out_of_domain" | "overflow";
  },
): bigint {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("invalid_number", `${label} must be finite`);
  }
  const fixed = parseNumberToFixed(value, label);
  if (
    (bounds.min !== undefined && fixed < bounds.min) ||
    (bounds.minExclusive !== undefined && fixed <= bounds.minExclusive)
  ) {
    fail("out_of_domain", `${label} is below its permitted domain`);
  }
  if (fixed > bounds.max) {
    fail(bounds.maximumErrorCode ?? "overflow", `${label} exceeds its permitted domain`);
  }
  return fixed;
}

function parseNumberToFixed(value: number, label: string): bigint {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value.toString());
  if (!match) {
    fail("invalid_number", `${label} is not a canonical decimal number`);
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2];
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 400) {
    fail("overflow", `${label} exponent exceeds the fixed-point domain`);
  }

  let digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "");
  let fractionalPlaces = fraction.length - exponent;
  if (fractionalPlaces > 8) {
    const discarded = digits.slice(0, Math.max(0, digits.length - fractionalPlaces + 8));
    const remainder = digits.slice(Math.max(0, digits.length - fractionalPlaces + 8));
    if (remainder.replace(/0/g, "").length > 0) {
      fail("out_of_domain", `${label} has more than 8 decimal places`);
    }
    digits = discarded || "0";
    fractionalPlaces = 8;
  }
  const zeroes = 8 - fractionalPlaces;
  if (zeroes < 0) {
    fail("out_of_domain", `${label} cannot be represented at scale 1e8`);
  }
  const magnitude = BigInt(digits || "0") * 10n ** BigInt(zeroes);
  return sign * magnitude;
}

function multiplyFixed(left: bigint, right: bigint, label: string): bigint {
  const product = left * right;
  const quotient = product / SCALE;
  const remainder = product % SCALE;
  return checkedFixed(quotient + (remainder * 2n >= SCALE ? 1n : 0n), label);
}

function divideFixed(numerator: bigint, denominator: bigint, label: string): bigint {
  if (denominator <= 0n) {
    fail("out_of_domain", `${label} denominator must be positive`);
  }
  const sign = numerator < 0n ? -1n : 1n;
  const magnitude = numerator < 0n ? -numerator : numerator;
  const scaled = magnitude * SCALE;
  const quotient = scaled / denominator;
  const remainder = scaled % denominator;
  return checkedFixed(sign * (quotient + (remainder * 2n >= denominator ? 1n : 0n)), label);
}

function checkedSum(values: readonly bigint[], label: string): bigint {
  return checkedFixed(
    values.reduce((sum, value) => sum + value, 0n),
    label,
  );
}

function checkedFixed(value: bigint, label: string): bigint {
  if (value > MAX_FIXED_UNITS || value < -MAX_FIXED_UNITS) {
    fail("overflow", `${label} exceeds the exact fixed-point domain`);
  }
  return value;
}

function fixedToNumber(value: bigint) {
  checkedFixed(value, "numeric output");
  return Number(value) / SCALE_NUMBER;
}

function formatFixed(value: bigint) {
  const sign = value < 0n ? "-" : "";
  const magnitude = value < 0n ? -value : value;
  const whole = magnitude / SCALE;
  const fraction = (magnitude % SCALE).toString().padStart(8, "0");
  return `${sign}${whole}.${fraction}`;
}

function parseCanonicalFixed(value: string, label: string) {
  const match = /^(-?)(\d+)\.(\d{8})$/.exec(value);
  if (!match) {
    fail("invalid_delta", `${label} is not canonical fixed-point data`);
  }
  const units = BigInt(match[2]) * SCALE + BigInt(match[3]);
  return checkedFixed(match[1] === "-" ? -units : units, label);
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fail(code: AccountingLedgerErrorCode, message: string): never {
  throw new AccountingLedgerError(code, message);
}
