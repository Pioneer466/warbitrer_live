"use client";

import { usePollingJson } from "@/components/use-polling-json";
import { formatCurrency, formatDateTime, formatPercent, formatPrice } from "@/lib/format";
import type { PaperTrade, PaperTradeLeg, TradesResponse } from "@/lib/types";

export function TradesClient() {
  const { data, error, loading } = usePollingJson<TradesResponse>("/api/trades", 4_000);

  if (loading && !data) {
    return (
      <div className="rounded-[28px] border border-white/8 bg-panel/90 px-6 py-16 text-center">
        <p className="text-sm uppercase tracking-[0.28em] text-mist/70">Trades</p>
        <p className="mt-4 text-2xl font-semibold text-white">Chargement de l’historique</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-[28px] border border-rose/20 bg-rose/10 px-6 py-10 text-center text-rose">
        {error ?? "Impossible de charger l’historique."}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="rounded-[28px] border border-white/8 bg-panel/90 px-5 py-6 shadow-[0_18px_60px_rgba(0,0,0,0.24)] sm:px-6">
        <p className="text-sm uppercase tracking-[0.28em] text-mist/70">Historique</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">Trades paper BTC 15m</h1>
        <p className="mt-2 text-sm text-mist">
          Chaque entrée liste explicitement les deux jambes, le coût d’entrée, les frais et le résultat final.
        </p>
      </section>

      {data.trades.length === 0 ? (
        <section className="rounded-[28px] border border-white/8 bg-panel/90 px-6 py-16 text-center text-sm text-mist">
          Aucun trade enregistré pour le moment.
        </section>
      ) : (
        data.trades.map((trade) => <TradeCard key={trade.id} trade={trade} />)
      )}

      {error ? (
        <div className="rounded-2xl border border-rose/20 bg-rose/10 px-4 py-3 text-sm text-rose">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function TradeCard({ trade }: { trade: PaperTrade }) {
  return (
    <section className="rounded-[28px] border border-white/8 bg-panel/90 p-5 shadow-[0_18px_60px_rgba(0,0,0,0.2)] sm:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-lg font-semibold text-white">{formatCombinationLabel(trade.combination)}</p>
            <StatusChip label={trade.status === "resolved" ? "Résolu" : "Ouvert"} tone={trade.status === "resolved" ? "cyan" : "amber"} />
            <StatusChip label={trade.thresholdMet ? "≤ 0.93" : "> 0.93"} tone={trade.thresholdMet ? "cyan" : "default"} />
          </div>
          <p className="mt-2 text-sm text-mist">
            Pris le {formatDateTime(trade.enteredAt)} · entrée {formatPrice(trade.grossPairCost, 3)} · {trade.units} unités
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MiniMetric label="Capital" value={formatCurrency(trade.capitalDeployed)} />
          <MiniMetric label="Frais" value={formatCurrency(trade.feesTotal, 3)} />
          <MiniMetric
            label="P&L"
            value={trade.realizedPnl === null ? "--" : formatCurrency(trade.realizedPnl)}
            tone={trade.realizedPnl !== null && trade.realizedPnl < 0 ? "rose" : "default"}
          />
          <MiniMetric label="ROI" value={trade.roi === null ? "--" : formatPercent(trade.roi)} />
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {trade.legs.map((leg) => (
          <TradeLegCard key={leg.id} leg={leg} />
        ))}
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <MiniMetric label="Quasi-arb théorique" value={formatCurrency(trade.theoreticalSameResolutionProfit)} />
        <MiniMetric label="Résolution Poly" value={trade.polyResolution ?? "--"} />
        <MiniMetric label="Résolution Kalshi" value={trade.kalshiResolution ?? "--"} />
      </div>
    </section>
  );
}

function TradeLegCard({ leg }: { leg: PaperTradeLeg }) {
  return (
    <div className="rounded-[22px] border border-white/8 bg-[#0d1119] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-white">
            {leg.venue === "polymarket" ? "Polymarket" : "Kalshi"} {leg.outcome}
          </p>
          <p className="mt-1 text-xs uppercase tracking-[0.22em] text-mist/70">{leg.units} unités</p>
        </div>
        <StatusChip
          label={leg.status === "open" ? "Ouvert" : leg.status === "won" ? "Win" : "Loss"}
          tone={leg.status === "won" ? "cyan" : leg.status === "lost" ? "rose" : "amber"}
        />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MiniMetric label="Prix" value={formatPrice(leg.price)} />
        <MiniMetric label="Coût brut" value={formatCurrency(leg.grossCost)} />
        <MiniMetric label="Fee USD" value={formatCurrency(leg.feeUsd, 3)} />
        <MiniMetric label="Net shares" value={formatPrice(leg.netShares)} />
      </div>
    </div>
  );
}

function MiniMetric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "rose";
}) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-3">
      <p className="text-xs uppercase tracking-[0.2em] text-mist/70">{label}</p>
      <p className={`mt-2 text-sm font-medium ${tone === "rose" ? "text-rose" : "text-white"}`}>{value}</p>
    </div>
  );
}

function StatusChip({
  label,
  tone,
}: {
  label: string;
  tone: "cyan" | "amber" | "rose" | "default";
}) {
  const toneClass =
    tone === "cyan"
      ? "border-cyan/20 bg-cyan/10 text-cyan"
      : tone === "amber"
        ? "border-amber/20 bg-amber/10 text-amber"
        : tone === "rose"
          ? "border-rose/20 bg-rose/10 text-rose"
          : "border-white/10 bg-white/[0.04] text-mist";

  return (
    <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] ${toneClass}`}>
      {label}
    </span>
  );
}

function formatCombinationLabel(combination: PaperTrade["combination"]) {
  if (combination === "POLY_UP_KALSHI_NO") {
    return "Poly Up + Kalshi No";
  }

  return "Poly Down + Kalshi Yes";
}
