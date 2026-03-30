"use client";

import { usePollingJson } from "@/components/use-polling-json";
import { formatCurrency, formatDateTime, formatPercent, formatPrice } from "@/lib/format";
import type { PaperTrade, TradesResponse } from "@/lib/types";

export function TradesClient() {
  const { data, error, loading } = usePollingJson<TradesResponse>("/api/trades", 4_000);

  if (loading && !data) {
    return <PanelMessage title="Trades" message="Chargement de l’historique." />;
  }

  if (!data) {
    return <PanelMessage title="Erreur" message={error ?? "Impossible de charger l’historique."} tone="rose" />;
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-white/8 bg-white/[0.02] px-4 py-3">
        <div className="text-sm text-white">Historique des trades</div>
        <div className="mt-1 text-xs text-mist">{data.trades.length} trade{data.trades.length > 1 ? "s" : ""}</div>
      </section>

      <section className="rounded-2xl border border-white/8 bg-white/[0.02]">
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-[0.16em] text-mist/70">
                <th className="px-4 py-3 font-normal">Date</th>
                <th className="px-4 py-3 font-normal">Pair</th>
                <th className="px-4 py-3 font-normal">Polymarket</th>
                <th className="px-4 py-3 font-normal">Kalshi</th>
                <th className="px-4 py-3 font-normal">Somme</th>
                <th className="px-4 py-3 font-normal">Capital</th>
                <th className="px-4 py-3 font-normal">Frais</th>
                <th className="px-4 py-3 font-normal">P&L</th>
                <th className="px-4 py-3 font-normal">ROI</th>
                <th className="px-4 py-3 font-normal">Statut</th>
              </tr>
            </thead>
            <tbody>
              {data.trades.length === 0 ? (
                <tr className="border-t border-white/6">
                  <td colSpan={10} className="px-4 py-6 text-center text-mist">Aucun trade.</td>
                </tr>
              ) : (
                data.trades.map((trade) => {
                  const polyLeg = trade.legs.find((leg) => leg.venue === "polymarket");
                  const kalshiLeg = trade.legs.find((leg) => leg.venue === "kalshi");

                  return (
                    <tr key={trade.id} className="border-t border-white/6 text-mist">
                      <td className="px-4 py-3">{formatDateTime(trade.enteredAt)}</td>
                      <td className="px-4 py-3 text-white">{pairLabel(trade)}</td>
                      <td className="px-4 py-3">{polyLeg ? legText(polyLeg.outcome, polyLeg.price, polyLeg.units) : "--"}</td>
                      <td className="px-4 py-3">{kalshiLeg ? legText(kalshiLeg.outcome, kalshiLeg.price, kalshiLeg.units) : "--"}</td>
                      <td className="px-4 py-3 font-mono text-white">{formatPrice(trade.grossPairCost, 3)}</td>
                      <td className="px-4 py-3 text-white">{formatCurrency(trade.capitalDeployed)}</td>
                      <td className="px-4 py-3">{formatCurrency(trade.feesTotal, 3)}</td>
                      <td className={`px-4 py-3 ${trade.realizedPnl !== null && trade.realizedPnl < 0 ? "text-rose" : "text-white"}`}>
                        {trade.realizedPnl === null ? "--" : formatCurrency(trade.realizedPnl)}
                      </td>
                      <td className="px-4 py-3">{trade.roi === null ? "--" : formatPercent(trade.roi)}</td>
                      <td className="px-4 py-3">{trade.status}</td>
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
    <div className={`rounded-2xl border px-4 py-6 text-sm ${tone === "rose" ? "border-rose/20 bg-rose/10 text-rose" : "border-white/8 bg-white/[0.02] text-mist"}`}>
      <div className="text-white">{title}</div>
      <div className="mt-1">{message}</div>
    </div>
  );
}

function pairLabel(trade: PaperTrade) {
  return trade.combination === "POLY_UP_KALSHI_NO" ? "Up + No" : "Down + Yes";
}

function legText(outcome: string, price: number, units: number) {
  return `${outcome} · ${formatPrice(price, 3)} · ${formatPrice(units, 2)} u`;
}
