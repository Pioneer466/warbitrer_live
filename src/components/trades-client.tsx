"use client";

import { usePollingJson } from "@/components/use-polling-json";
import { formatCurrency, formatDateTime, formatPercent, formatPrice } from "@/lib/format";
import type { TradesResponse } from "@/lib/types";

export function TradesClient() {
  const { data, error, loading } = usePollingJson<TradesResponse>("/api/trades", 4_000);

  if (loading && !data) {
    return (
      <div className="rounded-[28px] border border-white/8 bg-white/[0.03] px-6 py-16 text-center">
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
    <div className="space-y-6">
      <section className="rounded-[32px] border border-white/8 bg-[#0c1018]/90 px-5 py-6 shadow-[0_24px_80px_rgba(0,0,0,0.35)] sm:px-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.28em] text-mist/70">Historique complet</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
              Trades paper BTC 15m
            </h1>
            <p className="mt-2 text-sm text-mist">
              Résultat net, frais, ROI et divergence potentielle entre Polymarket et Kalshi.
            </p>
          </div>
          <div className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-mist">
            {data.trades.length} trade{data.trades.length > 1 ? "s" : ""}
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-[28px] border border-white/8 bg-white/[0.03]">
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse">
            <thead className="bg-white/[0.03]">
              <tr className="text-left text-xs uppercase tracking-[0.24em] text-mist/70">
                <th className="px-4 py-4 font-medium">Date</th>
                <th className="px-4 py-4 font-medium">Statut</th>
                <th className="px-4 py-4 font-medium">Combo</th>
                <th className="px-4 py-4 font-medium">Entrée</th>
                <th className="px-4 py-4 font-medium">Capital</th>
                <th className="px-4 py-4 font-medium">Frais</th>
                <th className="px-4 py-4 font-medium">P&L</th>
                <th className="px-4 py-4 font-medium">ROI</th>
                <th className="px-4 py-4 font-medium">Résolution</th>
              </tr>
            </thead>
            <tbody>
              {data.trades.map((trade) => (
                <tr key={trade.id} className="border-t border-white/6 align-top">
                  <td className="px-4 py-4 text-sm text-mist">{formatDateTime(trade.enteredAt)}</td>
                  <td className="px-4 py-4">
                    <span
                      className={`inline-flex rounded-full px-3 py-1 text-xs uppercase tracking-[0.22em] ${
                        trade.status === "resolved"
                          ? "bg-cyan/12 text-cyan"
                          : "bg-amber/12 text-amber"
                      }`}
                    >
                      {trade.status}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-sm font-medium text-white">{trade.combination}</td>
                  <td className="px-4 py-4 text-sm text-white">
                    {formatPrice(trade.grossPairCost, 3)}
                    <div className="mt-1 text-xs text-mist">
                      {trade.thresholdMet ? "≤ 0.93" : "> 0.93"} | {trade.units} unités
                    </div>
                  </td>
                  <td className="px-4 py-4 text-sm text-white">{formatCurrency(trade.capitalDeployed)}</td>
                  <td className="px-4 py-4 text-sm text-white">{formatCurrency(trade.feesTotal, 3)}</td>
                  <td
                    className={`px-4 py-4 text-sm font-medium ${
                      (trade.realizedPnl ?? 0) >= 0 ? "text-cyan" : "text-rose"
                    }`}
                  >
                    {trade.realizedPnl === null ? "--" : formatCurrency(trade.realizedPnl)}
                  </td>
                  <td className="px-4 py-4 text-sm text-white">
                    {trade.roi === null ? "--" : formatPercent(trade.roi)}
                  </td>
                  <td className="px-4 py-4 text-sm text-mist">
                    <div>Poly: {trade.polyResolution ?? "--"}</div>
                    <div className="mt-1">Kalshi: {trade.kalshiResolution ?? "--"}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {error ? (
        <div className="rounded-2xl border border-rose/20 bg-rose/10 px-4 py-3 text-sm text-rose">
          {error}
        </div>
      ) : null}
    </div>
  );
}
