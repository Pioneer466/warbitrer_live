"use client";

import { ResetPaperButton } from "@/components/reset-paper-button";
import { usePollingJson } from "@/components/use-polling-json";
import { formatCurrency, formatDateTime, formatPercent, formatPrice } from "@/lib/format";
import type { PaperTrade, TradesResponse } from "@/lib/types";

export function TradesClient() {
  const { data, error, loading } = usePollingJson<TradesResponse>("/api/trades", 4_000);

  if (loading && !data) {
    return <PanelMessage title="Trades" message="Chargement de l’historique." />;
  }

  if (!data) {
    return (
      <PanelMessage
        title="Erreur"
        message={error ?? "Impossible de charger l’historique."}
        tone="rose"
      />
    );
  }

  const resolvedTrades = data.trades.filter((trade) => trade.status === "resolved");
  const wins = resolvedTrades.filter((trade) => (trade.realizedPnl ?? 0) > 0).length;
  const openTrades = data.trades.filter((trade) => trade.status === "open").length;
  const realizedPnl = resolvedTrades.reduce((sum, trade) => sum + (trade.realizedPnl ?? 0), 0);

  return (
    <div className="space-y-5">
      <section className="rounded-[32px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 shadow-[0_20px_60px_rgba(0,0,0,0.22)] sm:px-6">
        <div className="flex flex-col gap-4 border-b border-white/6 pb-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-[0.24em] text-mist/70">Historique</div>
            <div className="mt-1 text-sm text-mist">
              {data.trades.length} trade{data.trades.length > 1 ? "s" : ""} · {openTrades} ouvert
              {openTrades > 1 ? "s" : ""}
            </div>
          </div>
          <ResetPaperButton />
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SummaryCell label="Total" value={String(data.trades.length)} />
          <SummaryCell label="Résolus" value={String(resolvedTrades.length)} />
          <SummaryCell
            label="P&L"
            value={formatCurrency(realizedPnl)}
            tone={realizedPnl >= 0 ? "cyan" : "rose"}
          />
          <SummaryCell
            label="Win Rate"
            value={resolvedTrades.length === 0 ? "--" : formatPercent(wins / resolvedTrades.length)}
          />
        </div>
      </section>

      <section className="rounded-[32px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 sm:px-6">
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-white/6 text-left text-[11px] uppercase tracking-[0.18em] text-mist/60">
                <th className="px-0 py-3 font-normal">Entrée</th>
                <th className="px-4 py-3 font-normal">Pair</th>
                <th className="px-4 py-3 font-normal">Polymarket</th>
                <th className="px-4 py-3 font-normal">Kalshi</th>
                <th className="px-4 py-3 font-normal">Somme</th>
                <th className="px-4 py-3 font-normal">Capital</th>
                <th className="px-4 py-3 font-normal">Frais</th>
                <th className="px-4 py-3 font-normal">P&L</th>
                <th className="px-4 py-3 font-normal">ROI</th>
                <th className="px-4 py-3 font-normal">Résolution</th>
                <th className="px-4 py-3 font-normal">Statut</th>
              </tr>
            </thead>
            <tbody>
              {data.trades.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-0 py-10 text-center text-sm text-mist/70">
                    Aucun trade paper.
                  </td>
                </tr>
              ) : (
                data.trades.map((trade) => {
                  const polyLeg = trade.legs.find((leg) => leg.venue === "polymarket");
                  const kalshiLeg = trade.legs.find((leg) => leg.venue === "kalshi");

                  return (
                    <tr key={trade.id} className="border-b border-white/6 text-mist">
                      <td className="px-0 py-4 align-top">{formatDateTime(trade.enteredAt)}</td>
                      <td className="px-4 py-4 align-top text-white">{pairLabel(trade)}</td>
                      <td className="px-4 py-4 align-top">{polyLeg ? legText(polyLeg) : "--"}</td>
                      <td className="px-4 py-4 align-top">{kalshiLeg ? legText(kalshiLeg) : "--"}</td>
                      <td className="px-4 py-4 align-top font-mono text-white">
                        {formatPrice(trade.grossPairCost, 3)}
                      </td>
                      <td className="px-4 py-4 align-top text-white">
                        {formatCurrency(trade.capitalDeployed)}
                      </td>
                      <td className="px-4 py-4 align-top">{formatCurrency(trade.feesTotal)}</td>
                      <td
                        className={`px-4 py-4 align-top ${
                          trade.realizedPnl !== null
                            ? trade.realizedPnl >= 0
                              ? "text-cyan"
                              : "text-rose"
                            : "text-mist"
                        }`}
                      >
                        {trade.realizedPnl === null ? "--" : formatCurrency(trade.realizedPnl)}
                      </td>
                      <td className="px-4 py-4 align-top">
                        {trade.roi === null ? "--" : formatPercent(trade.roi)}
                      </td>
                      <td className="px-4 py-4 align-top">
                        {trade.status === "resolved"
                          ? `${trade.polyResolution ?? "--"} / ${trade.kalshiResolution ?? "--"}`
                          : "--"}
                      </td>
                      <td className="px-4 py-4 align-top">
                        <StatusPill status={trade.status} />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {error ? <PanelMessage title="Erreur" message={error} tone="rose" /> : null}
    </div>
  );
}

function PanelMessage({
  title,
  message,
  tone = "default",
}: {
  title: string;
  message: string;
  tone?: "default" | "rose";
}) {
  return (
    <div
      className={`rounded-[28px] border px-5 py-6 text-sm ${
        tone === "rose"
          ? "border-rose/20 bg-rose/10 text-rose"
          : "border-white/8 bg-[#0d1017]/92 text-mist"
      }`}
    >
      <div className="text-white">{title}</div>
      <div className="mt-2">{message}</div>
    </div>
  );
}

function SummaryCell({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "cyan" | "rose";
}) {
  return (
    <div className="rounded-[24px] border border-white/6 bg-white/[0.02] px-4 py-4">
      <div className="text-[11px] uppercase tracking-[0.18em] text-mist/65">{label}</div>
      <div
        className={`mt-3 font-mono text-[34px] leading-none ${
          tone === "cyan" ? "text-cyan" : tone === "rose" ? "text-rose" : "text-white"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: PaperTrade["status"] }) {
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] ${
        status === "resolved"
          ? "border-cyan/20 bg-cyan/10 text-cyan"
          : "border-amber/20 bg-amber/10 text-amber"
      }`}
    >
      {status}
    </span>
  );
}

function pairLabel(trade: PaperTrade) {
  return trade.combination === "POLY_UP_KALSHI_NO" ? "Up + No" : "Down + Yes";
}

function legText(leg: PaperTrade["legs"][number]) {
  return `${leg.outcome} · ${formatPrice(leg.price, 3)} · ${formatPrice(leg.units, 2)} u`;
}
