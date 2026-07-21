import {
  AccountingLedgerError,
  calculateAccountingLedger,
  calculateAccountingLedgerDelta,
  type AccountingFillEvidence,
  type AccountingLedgerInput,
  type AccountingSettlementEvidence,
} from "@/lib/accounting-ledger";

const CAPTURED_AT = 1_774_899_960_000;

function createInput(overrides: Partial<AccountingLedgerInput> = {}): AccountingLedgerInput {
  const fills: AccountingFillEvidence[] = [
    {
      id: "fill-poly-1",
      legId: "leg-poly",
      asset: "btc",
      shadow: false,
      intentId: "intent-1",
      venue: "polymarket",
      venueOrderId: "order-poly-1",
      tradeId: "trade-poly-1",
      marketRef: "condition-1",
      tokenId: "token-up",
      side: "BUY",
      outcome: "UP",
      price: 0.4,
      size: 10,
      feeUsd: 0.01,
      filledAt: 1_774_899_100_000,
      finality: "final",
    },
    {
      id: "fill-kalshi-1",
      legId: "leg-kalshi",
      asset: "btc",
      shadow: false,
      intentId: "intent-1",
      venue: "kalshi",
      venueOrderId: "order-kalshi-1",
      tradeId: "trade-kalshi-1",
      marketRef: "KXBTC15M-1",
      side: "BUY",
      outcome: "NO",
      price: 0.5,
      size: 10,
      feeUsd: 0.02,
      filledAt: 1_774_899_100_001,
      finality: "final",
    },
  ];
  const settlements: AccountingSettlementEvidence[] = [
    {
      id: "settlement-poly-1",
      legId: "leg-poly",
      asset: "btc",
      shadow: false,
      intentId: "intent-1",
      venue: "polymarket",
      marketRef: "condition-1",
      tokenId: "token-up",
      outcome: "UP",
      resolvedOutcome: "UP",
      settledSize: 10,
      payoutUsd: 10,
      feeUsd: 0,
      settledAt: 1_774_899_950_000,
      finality: "final",
    },
    {
      id: "settlement-kalshi-1",
      legId: "leg-kalshi",
      asset: "btc",
      shadow: false,
      intentId: "intent-1",
      venue: "kalshi",
      marketRef: "KXBTC15M-1",
      outcome: "NO",
      resolvedOutcome: "YES",
      settledSize: 10,
      payoutUsd: 0,
      feeUsd: 0,
      settledAt: 1_774_899_950_001,
      finality: "final",
    },
  ];

  return {
    version: 1,
    capturedAt: CAPTURED_AT,
    evidenceCompleteness: "complete",
    intent: {
      id: "intent-1",
      asset: "btc",
      shadow: false,
      slotKey: "btc:1774899000000",
      slotStartTs: 1_774_899_000_000,
      slotEndTs: 1_774_899_900_000,
      combination: "POLY_UP_KALSHI_NO",
      status: "settled",
      primaryVenue: "kalshi",
      hedgeVenue: "polymarket",
      resolvedAt: 1_774_899_950_000,
    },
    legs: [
      {
        id: "leg-poly",
        intentId: "intent-1",
        venue: "polymarket",
        outcome: "UP",
        marketRef: "condition-1",
        tokenId: "token-up",
      },
      {
        id: "leg-kalshi",
        intentId: "intent-1",
        venue: "kalshi",
        outcome: "NO",
        marketRef: "KXBTC15M-1",
      },
    ],
    fills,
    settlements,
    ...overrides,
  };
}

function expectLedgerError(code: AccountingLedgerError["code"], work: () => unknown) {
  try {
    work();
    throw new Error("Expected accounting reducer to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(AccountingLedgerError);
    expect((error as AccountingLedgerError).code).toBe(code);
  }
}

describe("accounting ledger reducer", () => {
  it("derives exact cost basis, gross payout, fees, realized P&L and ROI only from durable evidence", () => {
    const ledger = calculateAccountingLedger(createInput());

    expect(ledger).toMatchObject({
      costBasisUsd: 9,
      payoutUsd: 10,
      feesUsd: 0.03,
      realizedPnlUsd: 0.97,
    });
    expect(ledger.roi).toBeCloseTo(0.10741971, 8);
    expect(ledger.exact).toEqual({
      costBasisUsd: "9.00000000",
      payoutUsd: "10.00000000",
      feesUsd: "0.03000000",
      realizedPnlUsd: "0.97000000",
      roi: "0.10741971",
    });
    expect(ledger.proofSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(ledger.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is invariant to leg, fill and settlement input order and replays byte-for-byte", () => {
    const input = createInput();
    const first = calculateAccountingLedger(input);
    const replay = calculateAccountingLedger(input);
    const reordered = calculateAccountingLedger({
      ...input,
      legs: [input.legs[1], input.legs[0]],
      fills: [...input.fills].reverse(),
      settlements: [...input.settlements].reverse(),
    });

    expect(replay).toEqual(first);
    expect(reordered.proofJson).toBe(first.proofJson);
    expect(reordered.proofSha256).toBe(first.proofSha256);
    expect(reordered.evidenceSha256).toBe(first.evidenceSha256);
  });

  it("keeps economic evidence identity stable across later recognition versions", () => {
    const first = calculateAccountingLedger(createInput());
    const replayedLater = calculateAccountingLedger(
      createInput({
        version: 2,
        capturedAt: CAPTURED_AT + 60_000,
      }),
    );

    expect(replayedLater.proofSha256).not.toBe(first.proofSha256);
    expect(replayedLater.evidenceJson).toBe(first.evidenceJson);
    expect(replayedLater.evidenceSha256).toBe(first.evidenceSha256);
  });

  it("changes the canonical proof hash when economic evidence changes", () => {
    const baseline = createInput();
    const changed = createInput({
      fills: baseline.fills.map((fill) => (fill.id === "fill-poly-1" ? { ...fill, price: 0.41 } : fill)),
    });

    const baselineLedger = calculateAccountingLedger(baseline);
    const changedLedger = calculateAccountingLedger(changed);
    expect(changedLedger.proofSha256).not.toBe(baselineLedger.proofSha256);
    expect(changedLedger.evidenceSha256).not.toBe(baselineLedger.evidenceSha256);
  });

  it("sums multiple fills with deterministic fixed-point multiplication", () => {
    const input = createInput();
    const polyFill = input.fills[0];
    const ledger = calculateAccountingLedger({
      ...input,
      fills: [
        { ...polyFill, id: "fill-poly-a", tradeId: "trade-poly-a", size: 4, price: 0.4, feeUsd: 0.004 },
        { ...polyFill, id: "fill-poly-b", tradeId: "trade-poly-b", size: 6, price: 0.45, feeUsd: 0.006 },
        input.fills[1],
      ],
    });

    expect(ledger.costBasisUsd).toBe(9.3);
    expect(ledger.feesUsd).toBe(0.03);
    expect(ledger.realizedPnlUsd).toBe(0.67);
    expect(ledger.legs.find((leg) => leg.legId === "leg-poly")?.exact).toMatchObject({
      boughtSize: "10.00000000",
      costBasisUsd: "4.30000000",
      feesUsd: "0.01000000",
    });
  });

  it("accounts for gross unwind proceeds and all entry/exit fees without requested-order fallback", () => {
    const input = createInput();
    const ledger = calculateAccountingLedger({
      ...input,
      intent: { ...input.intent, status: "unwound" },
      fills: [
        input.fills[0],
        {
          ...input.fills[0],
          id: "fill-poly-exit",
          venueOrderId: "order-poly-exit",
          tradeId: "trade-poly-exit",
          side: "SELL",
          price: 0.35,
          size: 10,
          feeUsd: 0.04,
          filledAt: 1_774_899_200_000,
        },
      ],
      settlements: [],
    });

    expect(ledger).toMatchObject({
      costBasisUsd: 4,
      payoutUsd: 3.5,
      feesUsd: 0.05,
      realizedPnlUsd: -0.55,
    });
  });

  it("fails closed when residual shares have no complete settlement proof", () => {
    const input = createInput();
    expectLedgerError("missing_settlement", () =>
      calculateAccountingLedger({
        ...input,
        settlements: input.settlements.filter((settlement) => settlement.legId !== "leg-poly"),
      }),
    );
    expectLedgerError("incomplete_evidence", () =>
      calculateAccountingLedger({ ...input, evidenceCompleteness: "partial" }),
    );
  });

  it("rejects a settled intent without durable BUY evidence for both legs", () => {
    const input = createInput();

    expectLedgerError("incomplete_evidence", () =>
      calculateAccountingLedger({
        ...input,
        fills: input.fills.filter((fill) => fill.legId === "leg-poly"),
        settlements: input.settlements.filter((settlement) => settlement.legId === "leg-poly"),
      }),
    );
  });

  it("rejects ambiguous/non-final evidence and incoherent identities", () => {
    const input = createInput();
    expectLedgerError("non_final_evidence", () =>
      calculateAccountingLedger({
        ...input,
        fills: [{ ...input.fills[0], finality: "ambiguous" }, input.fills[1]],
      }),
    );
    expectLedgerError("incoherent_identity", () =>
      calculateAccountingLedger({
        ...input,
        fills: [{ ...input.fills[0], marketRef: "wrong-market" }, input.fills[1]],
      }),
    );
    expectLedgerError("out_of_domain", () =>
      calculateAccountingLedger({
        ...input,
        fills: [{ ...input.fills[0], side: "HOLD" as never }, input.fills[1]],
      }),
    );
  });

  it("rejects missing legs, duplicate trade evidence and binary settlement mismatches", () => {
    const input = createInput();
    expectLedgerError("missing_leg", () => calculateAccountingLedger({ ...input, legs: [input.legs[0]] as never }));
    expectLedgerError("duplicate_evidence", () =>
      calculateAccountingLedger({
        ...input,
        fills: [
          input.fills[0],
          {
            ...input.fills[1],
            venue: "polymarket",
            venueOrderId: input.fills[0].venueOrderId,
            tradeId: input.fills[0].tradeId,
          },
        ],
      }),
    );
    expectLedgerError("settlement_mismatch", () =>
      calculateAccountingLedger({
        ...input,
        settlements: [{ ...input.settlements[0], payoutUsd: 9.99 }, input.settlements[1]],
      }),
    );
    expectLedgerError("settlement_mismatch", () =>
      calculateAccountingLedger({
        ...input,
        settlements: [{ ...input.settlements[0], settledAt: input.fills[0].filledAt - 1 }, input.settlements[1]],
      }),
    );
  });

  it("allows a venue trade id to be reused by a different venue order", () => {
    const input = createInput();
    const first = input.fills[0];
    const ledger = calculateAccountingLedger({
      ...input,
      fills: [
        { ...first, id: "fill-poly-a", size: 4 },
        { ...first, id: "fill-poly-b", venueOrderId: "order-poly-b", size: 6 },
        input.fills[1],
      ],
    });

    expect(ledger.exact.costBasisUsd).toBe("9.00000000");
  });

  it("rejects NaN, values outside the binary/fixed domain, oversells and aggregate overflow", () => {
    const input = createInput();
    expectLedgerError("invalid_number", () =>
      calculateAccountingLedger({
        ...input,
        fills: [{ ...input.fills[0], feeUsd: Number.NaN }, input.fills[1]],
      }),
    );
    expectLedgerError("out_of_domain", () =>
      calculateAccountingLedger({
        ...input,
        fills: [{ ...input.fills[0], price: 1.01 }, input.fills[1]],
      }),
    );
    expectLedgerError("out_of_domain", () =>
      calculateAccountingLedger({
        ...input,
        fills: [{ ...input.fills[0], price: 0.123456789 }, input.fills[1]],
      }),
    );
    expectLedgerError("negative_position", () =>
      calculateAccountingLedger({
        ...input,
        intent: { ...input.intent, status: "unwound" },
        fills: [
          input.fills[0],
          {
            ...input.fills[0],
            id: "fill-poly-exit",
            venueOrderId: "order-poly-exit",
            tradeId: "trade-poly-exit",
            side: "SELL",
            size: 11,
          },
        ],
        settlements: [],
      }),
    );
    expectLedgerError("overflow", () =>
      calculateAccountingLedger({
        ...input,
        fills: input.fills.map((fill) => ({ ...fill, size: 90_071_992.54740991, price: 1 })),
        settlements: input.settlements.map((settlement) => ({
          ...settlement,
          settledSize: 90_071_992.54740991,
          payoutUsd: settlement.payoutUsd === 0 ? 0 : 90_071_992.54740991,
        })),
      }),
    );
  });

  it("computes signed deltas between verified accounting versions", () => {
    const firstInput = createInput({
      intent: { ...createInput().intent, status: "unwound" },
      fills: [
        { ...createInput().fills[0], size: 5, feeUsd: 0.01 },
        {
          ...createInput().fills[0],
          id: "fill-poly-exit-1",
          venueOrderId: "order-poly-exit-1",
          tradeId: "trade-poly-exit-1",
          side: "SELL",
          size: 5,
          price: 0.45,
          feeUsd: 0.01,
        },
      ],
      settlements: [],
    });
    const secondInput: AccountingLedgerInput = {
      ...firstInput,
      version: 2,
      fills: [
        ...firstInput.fills,
        {
          ...firstInput.fills[0],
          id: "fill-poly-entry-2",
          venueOrderId: "order-poly-entry-2",
          tradeId: "trade-poly-entry-2",
          size: 2,
          price: 0.5,
          feeUsd: 0.005,
        },
        {
          ...firstInput.fills[0],
          id: "fill-poly-exit-2",
          venueOrderId: "order-poly-exit-2",
          tradeId: "trade-poly-exit-2",
          side: "SELL",
          size: 2,
          price: 0.4,
          feeUsd: 0.005,
        },
      ],
    };

    const delta = calculateAccountingLedgerDelta(
      calculateAccountingLedger(firstInput),
      calculateAccountingLedger(secondInput),
    );

    expect(delta).toMatchObject({
      fromVersion: 1,
      toVersion: 2,
      costBasisUsd: 1,
      payoutUsd: 0.8,
      feesUsd: 0.01,
      realizedPnlUsd: -0.21,
    });
    expect(delta.fromProofSha256).not.toBe(delta.toProofSha256);
    expect(delta.fromEvidenceSha256).not.toBe(delta.toEvidenceSha256);
  });
});
