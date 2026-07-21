import { createHash } from "node:crypto";

import {
  calculateAccountingLedger,
  type AccountingEvidenceFinality,
  type AccountingFillEvidence,
  type AccountingLedgerInput,
  type AccountingLedgerProjection,
} from "@/lib/accounting-ledger";
import { normalizePolymarketTradeStatus } from "@/lib/polymarket-trade-status";
import type { LiveFill, OrderIntent } from "@/lib/types";

const ACCOUNTING_RUNTIME_SCHEMA = "warbitrer.accounting-runtime.v2" as const;
const FIXED_SCALE = 100_000_000;

export type AccountingFillProvenance = {
  schema: typeof ACCOUNTING_RUNTIME_SCHEMA;
  finality: AccountingEvidenceFinality;
  venueTruth: string;
  feeProvenance:
    "venue_explicit" | "onchain_event" | "protocol_zero" | "estimated" | "missing" | "invalid" | "synthetic_exact";
};

export type AccountingFeeClassification = {
  feeUsd: number;
  finality: AccountingEvidenceFinality;
  venueTruth: string;
  feeProvenance: AccountingFillProvenance["feeProvenance"];
};

export function classifyKalshiAccountingFee(
  raw: {
    fee_cost?: unknown;
    fees_paid_dollars?: unknown;
    taker_fees_dollars?: unknown;
    maker_fees_dollars?: unknown;
  },
  estimatedFeeUsd: number | null,
): AccountingFeeClassification {
  const candidates = [raw.fee_cost, raw.fees_paid_dollars, raw.taker_fees_dollars, raw.maker_fees_dollars];
  const explicit = candidates.find((value) => value !== undefined && value !== null && value !== "");
  if (explicit !== undefined) {
    const parsed = typeof explicit === "number" ? explicit : Number(explicit);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return {
        feeUsd: parsed,
        finality: "final",
        venueTruth: "kalshi_fill",
        feeProvenance: "venue_explicit",
      };
    }
    return {
      feeUsd: validProvisionalFee(estimatedFeeUsd),
      finality: "ambiguous",
      venueTruth: "kalshi_fill",
      feeProvenance: "invalid",
    };
  }

  if (estimatedFeeUsd !== null && Number.isFinite(estimatedFeeUsd) && estimatedFeeUsd >= 0) {
    return {
      feeUsd: estimatedFeeUsd,
      finality: "non_final",
      venueTruth: "kalshi_fill",
      feeProvenance: "estimated",
    };
  }

  return {
    feeUsd: 0,
    finality: "ambiguous",
    venueTruth: "kalshi_fill",
    feeProvenance: "missing",
  };
}

export function classifyPolymarketAccountingFee(input: {
  tradeStatus: unknown;
  onchainFeeUsd: unknown;
  onchainEvidencePresent: boolean;
}): AccountingFeeClassification {
  const feeMissing =
    input.onchainFeeUsd === undefined ||
    input.onchainFeeUsd === null ||
    (typeof input.onchainFeeUsd === "string" && input.onchainFeeUsd.trim() === "");
  const parsedFee =
    typeof input.onchainFeeUsd === "number"
      ? input.onchainFeeUsd
      : typeof input.onchainFeeUsd === "string" && input.onchainFeeUsd.trim() !== ""
        ? Number(input.onchainFeeUsd)
        : Number.NaN;
  const exactFeeValid = Number.isFinite(parsedFee) && parsedFee >= 0;
  const feeUsd = exactFeeValid ? parsedFee : 0;
  const tradeStatus = normalizePolymarketTradeStatus(input.tradeStatus);

  if (tradeStatus !== "CONFIRMED") {
    return {
      feeUsd,
      finality: "non_final",
      venueTruth: tradeStatus === null ? "polymarket_trade_unknown" : `polymarket_trade_${tradeStatus}`,
      feeProvenance:
        input.onchainEvidencePresent && exactFeeValid ? "onchain_event" : feeMissing ? "missing" : "invalid",
    };
  }
  if (!input.onchainEvidencePresent || !exactFeeValid) {
    return {
      feeUsd,
      finality: "ambiguous",
      venueTruth: "polymarket_trade_confirmed_without_onchain_fee",
      feeProvenance: feeMissing ? "missing" : "invalid",
    };
  }
  return {
    feeUsd,
    finality: "final",
    venueTruth: "polymarket_order_filled_onchain",
    feeProvenance: "onchain_event",
  };
}

export function attachAccountingFillProvenance(
  fill: LiveFill,
  classification: Pick<AccountingFeeClassification, "finality" | "venueTruth" | "feeProvenance">,
): LiveFill {
  const provenance: AccountingFillProvenance = {
    schema: ACCOUNTING_RUNTIME_SCHEMA,
    finality: classification.finality,
    venueTruth: classification.venueTruth,
    feeProvenance: classification.feeProvenance,
  };
  return {
    ...fill,
    raw: {
      ...fill.raw,
      accounting: provenance,
    },
  };
}

export function buildAccountingMutationRequestId(...identity: readonly unknown[]) {
  const digest = createHash("sha256")
    .update(canonicalizeJson([ACCOUNTING_RUNTIME_SCHEMA, ...identity]), "utf8")
    .digest("hex");
  const variant = ((Number.parseInt(digest[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function buildAccountingFillMutationRequestId(
  fill: LiveFill,
  legId: string,
  classification: Pick<AccountingFeeClassification, "finality" | "venueTruth" | "feeProvenance">,
) {
  return buildAccountingMutationRequestId(
    "fill",
    legId,
    {
      id: fill.id,
      asset: fill.asset,
      shadow: fill.shadow,
      intentId: fill.intentId,
      venue: fill.venue,
      venueOrderId: fill.venueOrderId,
      tradeId: fill.tradeId,
      marketRef: fill.marketRef,
      tokenId: fill.tokenId ?? null,
      side: fill.side,
      outcome: fill.outcome,
      price: fill.price,
      size: fill.size,
      feeUsd: fill.feeUsd,
      filledAt: fill.filledAt,
    },
    classification,
  );
}

export function buildShadowAccountingFillIdentity(intentId: string, legId: string) {
  if (!intentId.trim() || !legId.trim()) {
    throw new Error("Shadow accounting fill identity requires intent and leg ids");
  }
  return {
    fillId: `shadow-fill:${intentId}:${legId}`,
    tradeId: `shadow-trade:${intentId}:${legId}`,
  };
}

export function buildTerminalAccountingProjection(input: {
  terminalIntent: OrderIntent;
  fills: readonly AccountingFillEvidence[];
  version: number;
  capturedAt: number;
  settlementObservedAt: number;
}): {
  terminalIntent: OrderIntent;
  ledgerInput: AccountingLedgerInput;
  projection: AccountingLedgerProjection;
} {
  const { terminalIntent } = input;
  if (terminalIntent.status !== "settled" && terminalIntent.status !== "unwound") {
    throw new Error(`Accounting finalization requires settled or unwound intent ${terminalIntent.id}`);
  }
  if (terminalIntent.resolvedAt === null) {
    throw new Error(`Accounting finalization requires resolvedAt for intent ${terminalIntent.id}`);
  }

  const settlements: AccountingLedgerInput["settlements"] = terminalIntent.legs.flatMap((leg) => {
    const residualUnits = input.fills.reduce((total, fill) => {
      if (fill.legId !== leg.id) {
        return total;
      }
      const sizeUnits = toFixedUnits(fill.size, `fill ${fill.id} size`);
      return total + (fill.side === "BUY" ? sizeUnits : -sizeUnits);
    }, 0n);
    if (residualUnits < 0n) {
      throw new Error(`Accounting fills sell more than bought for intent ${terminalIntent.id} leg ${leg.id}`);
    }
    if (residualUnits === 0n) {
      return [];
    }
    if (leg.resolvedOutcome === null) {
      throw new Error(`Accounting settlement proof is missing for intent ${terminalIntent.id} leg ${leg.id}`);
    }
    const settledSize = Number(residualUnits) / FIXED_SCALE;
    return [
      {
        id: `${terminalIntent.id}:accounting:v${input.version}:settlement:${leg.id}`,
        legId: leg.id,
        asset: terminalIntent.asset,
        shadow: terminalIntent.shadow,
        intentId: terminalIntent.id,
        venue: leg.venue,
        marketRef: leg.marketRef,
        tokenId: leg.tokenId,
        outcome: leg.outcome,
        resolvedOutcome: leg.resolvedOutcome,
        settledSize,
        payoutUsd: leg.outcome === leg.resolvedOutcome ? settledSize : 0,
        feeUsd: 0,
        settledAt: input.settlementObservedAt,
        finality: "final" as const,
      },
    ];
  });
  const ledgerInput: AccountingLedgerInput = {
    version: input.version,
    capturedAt: input.capturedAt,
    evidenceCompleteness: "complete",
    intent: terminalIntent,
    legs: terminalIntent.legs,
    fills: input.fills,
    settlements,
  };
  const projection = calculateAccountingLedger(ledgerInput);
  const projectedLegs = new Map(projection.legs.map((leg) => [leg.legId, leg]));

  return {
    terminalIntent: {
      ...terminalIntent,
      realizedPnlUsd: projection.realizedPnlUsd,
      roi: projection.roi,
      legs: terminalIntent.legs.map((leg) => {
        const projected = projectedLegs.get(leg.id);
        return projected
          ? {
              ...leg,
              feeUsd: projected.feesUsd,
              payoutUsd: projected.payoutUsd,
            }
          : leg;
      }) as OrderIntent["legs"],
    },
    ledgerInput,
    projection,
  };
}

function validProvisionalFee(value: number | null) {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : 0;
}

function toFixedUnits(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  const scaled = value * FIXED_SCALE;
  if (!Number.isSafeInteger(Math.round(scaled)) || Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    throw new Error(`${label} cannot be represented exactly at scale 1e8`);
  }
  return BigInt(Math.round(scaled));
}

function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Accounting mutation identity contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalizeJson(entry)}`).join(",")}}`;
  }
  throw new Error(`Accounting mutation identity contains unsupported ${typeof value}`);
}
