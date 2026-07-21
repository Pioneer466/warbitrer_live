import { describe, expect, it } from "vitest";

import type { AccountingFillEvidence } from "@/lib/accounting-ledger";
import {
  buildAccountingFillMutationRequestId,
  buildAccountingMutationRequestId,
  buildShadowAccountingFillIdentity,
  buildTerminalAccountingProjection,
  classifyKalshiAccountingFee,
  classifyPolymarketAccountingFee,
} from "@/lib/accounting-runtime";
import type { OrderIntent } from "@/lib/types";

describe("accounting runtime evidence", () => {
  it("accepts explicit zero Kalshi fees as final venue evidence", () => {
    expect(classifyKalshiAccountingFee({ fee_cost: "0" }, 0.12)).toEqual({
      feeUsd: 0,
      finality: "final",
      venueTruth: "kalshi_fill",
      feeProvenance: "venue_explicit",
    });
  });

  it("keeps estimated and invalid Kalshi fees out of final accounting", () => {
    expect(classifyKalshiAccountingFee({}, 0.12)).toMatchObject({
      feeUsd: 0.12,
      finality: "non_final",
      feeProvenance: "estimated",
    });
    expect(classifyKalshiAccountingFee({ fee_cost: "not-a-number" }, 0.12)).toMatchObject({
      feeUsd: 0.12,
      finality: "ambiguous",
      feeProvenance: "invalid",
    });
  });

  it("requires confirmed Polymarket truth and exact on-chain fee evidence", () => {
    expect(
      classifyPolymarketAccountingFee({
        tradeStatus: "CONFIRMED",
        onchainFeeUsd: 0,
        onchainEvidencePresent: true,
      }),
    ).toMatchObject({
      finality: "final",
      venueTruth: "polymarket_order_filled_onchain",
      feeProvenance: "onchain_event",
    });
    expect(
      classifyPolymarketAccountingFee({
        tradeStatus: "CONFIRMED",
        onchainFeeUsd: undefined,
        onchainEvidencePresent: false,
      }),
    ).toMatchObject({ finality: "ambiguous", feeProvenance: "missing" });
    expect(
      classifyPolymarketAccountingFee({
        tradeStatus: "MATCHED",
        onchainFeeUsd: 0.01,
        onchainEvidencePresent: true,
      }),
    ).toMatchObject({ finality: "non_final", feeProvenance: "onchain_event" });
  });

  it("does not infer a zero Polymarket fee from liquidity or builder assumptions", () => {
    expect(
      classifyPolymarketAccountingFee({
        tradeStatus: "CONFIRMED",
        onchainFeeUsd: 0,
        onchainEvidencePresent: false,
      }),
    ).toMatchObject({
      feeUsd: 0,
      finality: "ambiguous",
      venueTruth: "polymarket_trade_confirmed_without_onchain_fee",
      feeProvenance: "invalid",
    });

    expect(
      classifyPolymarketAccountingFee({
        tradeStatus: "CONFIRMED",
        onchainFeeUsd: "not-a-number",
        onchainEvidencePresent: true,
      }),
    ).toMatchObject({ finality: "ambiguous", feeProvenance: "invalid" });
  });

  it("normalizes the documented prefixed Polymarket status without accepting unknown states", () => {
    expect(
      classifyPolymarketAccountingFee({
        tradeStatus: "TRADE_STATUS_CONFIRMED",
        onchainFeeUsd: 0,
        onchainEvidencePresent: true,
      }),
    ).toMatchObject({ finality: "final", venueTruth: "polymarket_order_filled_onchain" });
    expect(
      classifyPolymarketAccountingFee({
        tradeStatus: "TRADE_STATUS_SETTLED",
        onchainFeeUsd: 0,
        onchainEvidencePresent: true,
      }),
    ).toMatchObject({ finality: "non_final", venueTruth: "polymarket_trade_unknown" });
  });

  it("builds stable RFC-4122-shaped mutation ids from canonical identity", () => {
    const first = buildAccountingMutationRequestId("fill", { b: 2, a: 1 });
    const replay = buildAccountingMutationRequestId("fill", { a: 1, b: 2 });
    const changed = buildAccountingMutationRequestId("fill", { a: 1, b: 3 });

    expect(first).toBe(replay);
    expect(first).not.toBe(changed);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("keeps synthetic fill identity stable across shadow replay", () => {
    expect(buildShadowAccountingFillIdentity("intent-1", "leg-poly")).toEqual({
      fillId: "shadow-fill:intent-1:leg-poly",
      tradeId: "shadow-trade:intent-1:leg-poly",
    });
    expect(() => buildShadowAccountingFillIdentity("", "leg-poly")).toThrow(/intent and leg ids/);
  });

  it("keeps fill mutation replay identity independent from mutable raw payloads", () => {
    const intent = buildIntent("settled");
    const evidence = buildEntryFills(intent)[0]!;
    const fill = {
      ...evidence,
      liquidity: "TAKER" as const,
      raw: { status: "CONFIRMED", last_update: "first" },
    };
    const classification = {
      finality: "final" as const,
      venueTruth: "polymarket_trade_confirmed",
      feeProvenance: "venue_explicit" as const,
    };

    expect(buildAccountingFillMutationRequestId(fill, evidence.legId, classification)).toBe(
      buildAccountingFillMutationRequestId(
        { ...fill, raw: { status: "CONFIRMED", last_update: "later" } },
        evidence.legId,
        classification,
      ),
    );
    expect(buildAccountingFillMutationRequestId(fill, evidence.legId, classification)).not.toBe(
      buildAccountingFillMutationRequestId(fill, evidence.legId, {
        ...classification,
        finality: "non_final",
      }),
    );
  });
});

describe("terminal accounting projection", () => {
  it("derives exact settled P&L and versioned settlement facts", () => {
    const intent = buildIntent("settled");
    const result = buildTerminalAccountingProjection({
      terminalIntent: intent,
      fills: buildEntryFills(intent),
      version: 1,
      capturedAt: 1_100,
      settlementObservedAt: 1_100,
    });

    expect(result.terminalIntent.realizedPnlUsd).toBe(0.98);
    expect(result.terminalIntent.roi).toBe(0.10864745);
    expect(result.ledgerInput.settlements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "intent-1:accounting:v1:settlement:poly-leg", payoutUsd: 10 }),
        expect.objectContaining({ id: "intent-1:accounting:v1:settlement:kalshi-leg", payoutUsd: 0 }),
      ]),
    );
  });

  it("derives an unwound result exclusively from final buy and sell fills", () => {
    const intent = buildIntent("unwound");
    const entryFills = buildEntryFills(intent);
    const fills: AccountingFillEvidence[] = [
      entryFills[0]!,
      {
        ...entryFills[0]!,
        id: "poly-exit",
        tradeId: "poly-exit-trade",
        venueOrderId: "poly-exit-order",
        side: "SELL",
        price: 0.46,
        feeUsd: 0.01,
        filledAt: 1_050,
      },
    ];
    const result = buildTerminalAccountingProjection({
      terminalIntent: {
        ...intent,
        legs: intent.legs.map((leg) =>
          leg.id === "kalshi-leg" ? { ...leg, filledSize: 0, feeUsd: 0, payoutUsd: null } : leg,
        ) as OrderIntent["legs"],
      },
      fills,
      version: 1,
      capturedAt: 1_100,
      settlementObservedAt: 1_100,
    });

    expect(result.ledgerInput.settlements).toEqual([]);
    expect(result.terminalIntent.realizedPnlUsd).toBe(0.58);
  });

  it("rejects non-final fill evidence before creating stable accounting", () => {
    const intent = buildIntent("settled");
    const fills = buildEntryFills(intent);
    fills[0] = { ...fills[0]!, finality: "non_final" };

    expect(() =>
      buildTerminalAccountingProjection({
        terminalIntent: intent,
        fills,
        version: 1,
        capturedAt: 1_100,
        settlementObservedAt: 1_100,
      }),
    ).toThrow(/non_final/);
  });
});

function buildIntent(status: "settled" | "unwound"): OrderIntent {
  return {
    id: "intent-1",
    revision: 4,
    asset: "btc",
    shadow: false,
    slotKey: "btc:slot",
    slotStartTs: 1,
    slotEndTs: 900,
    combination: "POLY_UP_KALSHI_NO",
    status,
    createdAt: 10,
    updatedAt: 1_100,
    resolvedAt: 1_100,
    primaryVenue: "polymarket",
    hedgeVenue: "kalshi",
    grossCost: 0.9,
    targetNotionalUsd: 10,
    maxSlippageBps: 30,
    failureReason: status === "unwound" ? "hedge failed" : null,
    projectedNetProfitUsd: 1,
    realizedPnlUsd: 999,
    roi: 999,
    polyResolution: status === "settled" ? "UP" : null,
    kalshiResolution: status === "settled" ? "YES" : null,
    legs: [
      {
        id: "poly-leg",
        intentId: "intent-1",
        venue: "polymarket",
        outcome: "UP",
        marketRef: "poly-market",
        tokenId: "poly-token",
        side: "BUY",
        requestedPrice: 0.4,
        requestedSize: 10,
        requestedNotionalUsd: 4,
        filledPrice: 0.4,
        filledSize: 10,
        feeUsd: 0.01,
        status: status === "unwound" ? "unwound" : "filled",
        venueOrderId: "poly-order",
        payoutUsd: status === "unwound" ? 4.6 : null,
        resolvedOutcome: status === "settled" ? "UP" : null,
      },
      {
        id: "kalshi-leg",
        intentId: "intent-1",
        venue: "kalshi",
        outcome: "NO",
        marketRef: "kalshi-market",
        side: "BUY",
        requestedPrice: 0.5,
        requestedSize: 10,
        requestedNotionalUsd: 5,
        filledPrice: 0.5,
        filledSize: 10,
        feeUsd: 0.01,
        status: "hedged",
        venueOrderId: "kalshi-order",
        payoutUsd: null,
        resolvedOutcome: status === "settled" ? "YES" : null,
      },
    ],
  };
}

function buildEntryFills(intent: OrderIntent): AccountingFillEvidence[] {
  return [
    {
      id: "poly-entry",
      legId: "poly-leg",
      asset: intent.asset,
      shadow: intent.shadow,
      intentId: intent.id,
      venue: "polymarket",
      venueOrderId: "poly-order",
      tradeId: "poly-trade",
      marketRef: "poly-market",
      tokenId: "poly-token",
      side: "BUY",
      outcome: "UP",
      price: 0.4,
      size: 10,
      feeUsd: 0.01,
      filledAt: 1_000,
      finality: "final",
    },
    {
      id: "kalshi-entry",
      legId: "kalshi-leg",
      asset: intent.asset,
      shadow: intent.shadow,
      intentId: intent.id,
      venue: "kalshi",
      venueOrderId: "kalshi-order",
      tradeId: "kalshi-trade",
      marketRef: "kalshi-market",
      side: "BUY",
      outcome: "NO",
      price: 0.5,
      size: 10,
      feeUsd: 0.01,
      filledAt: 1_000,
      finality: "final",
    },
  ];
}
