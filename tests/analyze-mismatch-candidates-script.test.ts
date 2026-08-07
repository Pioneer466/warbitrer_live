import {
  normalizeCandidateRows,
  parseCandidateAnalysisArgs,
  summarizeResolvedCandidateVariants,
  type ResolvedCandidateVariantRow,
} from "../scripts/analyze-mismatch-candidates";

describe("mismatch candidate analysis CLI", () => {
  it("defaults to a read-only retained window and accepts explicit timestamps", () => {
    const now = Date.parse("2026-08-07T12:00:00Z");
    const defaults = parseCandidateAnalysisArgs([], now);
    const explicit = parseCandidateAnalysisArgs(["--from", "2026-08-01T00:00:00Z", "--to=2026-08-07T00:00:00Z"], now);

    expect(defaults.toMs).toBe(now);
    expect(defaults.fromMs).toBeLessThan(now);
    expect(explicit).toMatchObject({
      fromMs: Date.parse("2026-08-01T00:00:00Z"),
      toMs: Date.parse("2026-08-07T00:00:00Z"),
      help: false,
    });
    expect(() => parseCandidateAnalysisArgs(["--persist"], now)).toThrow("Unknown option");
  });

  it("normalizes exact official-resolution economics and rejects contradictions", () => {
    const row = queryRow();

    expect(normalizeCandidateRows([row])).toEqual([
      expect.objectContaining({
        probeKind: "late_probe",
        asset: "btc",
        targetSecondsRemaining: 45,
        maxLegPriceCap: 0.7,
        safetyFraction: 0.75,
        payoutCount: 1,
        fatal: false,
        pnlUsd: 1,
      }),
    ]);
    expect(() => normalizeCandidateRows([{ ...row, fatal: true }])).toThrow("must match a zero payout count");
    expect(() => normalizeCandidateRows([{ ...row, pnl_usd: 2 }])).toThrow("contradicts payout and cost");
  });

  it("reports policy, horizon, asset, and combination cohorts without hiding losses", () => {
    const rows: ResolvedCandidateVariantRow[] = [
      candidate({ asset: "btc", pnlUsd: 1, payoutCount: 1, fatal: false }),
      candidate({ asset: "eth", pnlUsd: -9, payoutCount: 0, fatal: true }),
      candidate({
        asset: "btc",
        targetSecondsRemaining: null,
        capturedSecondsRemaining: 95,
        maxLegPriceCap: 0.6,
        safetyFraction: 0.5,
        pairSize: 10,
        totalCostUsd: 9,
        payoutCount: 2,
        fatal: false,
        pnlUsd: 11,
      }),
    ];

    const report = summarizeResolvedCandidateVariants(rows);

    expect(report.overall).toMatchObject({
      count: 3,
      fatalCount: 1,
      fatalRate: 1 / 3,
      totalPnlUsd: 3,
    });
    expect(report.byAsset.btc).toMatchObject({ count: 2, totalPnlUsd: 12 });
    expect(report.byHorizon["late-t45/seconds_over_30_to_60"]).toMatchObject({ count: 2, fatalCount: 1 });
    expect(report.byHorizon["candidate/seconds_over_60_to_120"]).toMatchObject({ count: 1, totalPnlUsd: 11 });
    expect(report.byPolicy["max-leg-0.70/safety-0.75"]).toMatchObject({ count: 2, totalPnlUsd: -8 });
  });
});

function queryRow() {
  return {
    probe_kind: "late_probe",
    asset: "btc",
    combination: "POLY_UP_KALSHI_NO",
    target_seconds_remaining: "45",
    captured_seconds_remaining: "44.5",
    max_leg_price_cap: "0.7",
    safety_fraction: "0.75",
    pair_size: "10",
    total_cost_usd: "9",
    payout_count: "1",
    fatal: false,
    pnl_usd: "1",
  };
}

function candidate(overrides: Partial<ResolvedCandidateVariantRow> = {}): ResolvedCandidateVariantRow {
  return {
    probeKind: "late_probe",
    asset: "btc",
    combination: "POLY_UP_KALSHI_NO",
    targetSecondsRemaining: 45,
    capturedSecondsRemaining: 44.5,
    maxLegPriceCap: 0.7,
    safetyFraction: 0.75,
    pairSize: 10,
    totalCostUsd: 9,
    payoutCount: 1,
    fatal: false,
    pnlUsd: 1,
    ...overrides,
  };
}
