"use client";

import Link from "next/link";

import { LineChart } from "@/components/line-chart";
import { usePollingJson } from "@/components/use-polling-json";
import {
  formatClock,
  formatCountdown,
  formatCurrency,
  formatDateTime,
  formatPercent,
  formatPrice,
} from "@/lib/format";
import type { DashboardResponse, HistoryResponse, PairSignal, PaperTrade, PaperTradeLeg } from "@/lib/types";

export function DashboardClient() {
  const dashboard = usePollingJson<DashboardResponse>("/api/dashboard", 2_000);
  const history = usePollingJson<HistoryResponse>("/api/history/current-slot", 4_000);

  if (dashboard.loading && !dashboard.data) {
    return <MessagePanel title="Chargement" message="Connexion au moteur paper." />;
  }

  if (!dashboard.data) {
    return <MessagePanel title="Erreur" message={dashboard.error ?? "Aucune donnée disponible."} tone="rose" />;
  }

  const { metrics, latestSnapshot, signals, openTrades, slot, workerState } = dashboard.data;
  const historyLabels = history.data?.points.map((point) => formatClock(point.ts).slice(0, 5)) ?? [];
  const historyPoints = history.data?.points ?? [];

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-white/8 bg-white/[0.02] p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-mist/70">BTC 15m</div>
            <div className="mt-1 text-base text-white">Créneau courant</div>
            <div className="mt-1 text-sm text-mist">{slot.label}</div>
          </div>
          <div className="grid gap-2 sm:grid-cols-4">
            <TopMetric label="Restant" value={formatCountdown(slot.secondsRemaining)} />
            <TopMetric label="Capital" value={formatCurrency(metrics.availableCapital)} />
            <TopMetric label="P&L" value={formatCurrency(metrics.realizedPnl)} />
            <TopMetric label="Win rate" value={formatPercent(metrics.winRate)} />
          </div>
        </div>
        <div className="mt-3 text-xs text-mist">
          Worker: {workerState.lastError ? workerState.lastError : "actif"} · dernier tick{" "}
          {workerState.lastTickAt ? formatDateTime(workerState.lastTickAt) : "--"}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <VenuePanel
          title="Polymarket"
          rows={[
            ["Up", latestSnapshot?.polymarket.outcomes.up.buyPrice ?? null, latestSnapshot?.polymarket.outcomes.up.depth ?? null],
            ["Down", latestSnapshot?.polymarket.outcomes.down.buyPrice ?? null, latestSnapshot?.polymarket.outcomes.down.depth ?? null],
          ]}
          footer={latestSnapshot?.polymarket.availabilityReason ?? "Créneau aligné"}
        />
        <VenuePanel
          title="Kalshi"
          rows={[
            ["Yes", latestSnapshot?.kalshi.outcomes.yes.buyPrice ?? null, latestSnapshot?.kalshi.outcomes.yes.depth ?? null],
            ["No", latestSnapshot?.kalshi.outcomes.no.buyPrice ?? null, latestSnapshot?.kalshi.outcomes.no.depth ?? null],
          ]}
          footer={latestSnapshot?.kalshi.availabilityReason ?? "Créneau aligné"}
        />
      </section>

      <section className="rounded-2xl border border-white/8 bg-white/[0.02]">
        <HeaderRow title="Opportunités" meta="50$ + 50$" />
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-t border-white/6 text-left text-[11px] uppercase tracking-[0.16em] text-mist/70">
                <th className="px-4 py-3 font-normal">Pair</th>
                <th className="px-4 py-3 font-normal">Polymarket</th>
                <th className="px-4 py-3 font-normal">Kalshi</th>
                <th className="px-4 py-3 font-normal">Somme</th>
                <th className="px-4 py-3 font-normal">Statut</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((signal) => (
                <tr key={signal.combination} className="border-t border-white/6 text-mist">
                  <td className="px-4 py-3 text-white">{pairLabel(signal)}</td>
                  <td className="px-4 py-3">{signalLegText(signal.legs[0])}</td>
                  <td className="px-4 py-3">{signalLegText(signal.legs[1])}</td>
                  <td className="px-4 py-3 font-mono text-white">
                    {signal.grossCost === null ? "--" : formatPrice(signal.grossCost, 3)}
                  </td>
                  <td className="px-4 py-3">{signal.eligible ? "Prêt" : signal.reason ?? "--"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl border border-white/8 bg-white/[0.02]">
        <HeaderRow title="Positions ouvertes" meta={<Link href="/trades" className="text-mist hover:text-white">Historique</Link>} />
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-t border-white/6 text-left text-[11px] uppercase tracking-[0.16em] text-mist/70">
                <th className="px-4 py-3 font-normal">Heure</th>
                <th className="px-4 py-3 font-normal">Pair</th>
                <th className="px-4 py-3 font-normal">Polymarket</th>
                <th className="px-4 py-3 font-normal">Kalshi</th>
                <th className="px-4 py-3 font-normal">Capital</th>
                <th className="px-4 py-3 font-normal">Frais</th>
              </tr>
            </thead>
            <tbody>
              {openTrades.length === 0 ? (
                <tr className="border-t border-white/6">
                  <td colSpan={6} className="px-4 py-6 text-center text-mist">Aucune position ouverte.</td>
                </tr>
              ) : (
                openTrades.map((trade) => {
                  const polyLeg = trade.legs.find((leg) => leg.venue === "polymarket");
                  const kalshiLeg = trade.legs.find((leg) => leg.venue === "kalshi");

                  return (
                    <tr key={trade.id} className="border-t border-white/6 text-mist">
                      <td className="px-4 py-3">{formatDateTime(trade.enteredAt)}</td>
                      <td className="px-4 py-3 text-white">{pairLabel(trade)}</td>
                      <td className="px-4 py-3">{polyLeg ? tradeLegText(polyLeg) : "--"}</td>
                      <td className="px-4 py-3">{kalshiLeg ? tradeLegText(kalshiLeg) : "--"}</td>
                      <td className="px-4 py-3 text-white">{formatCurrency(trade.capitalDeployed)}</td>
                      <td className="px-4 py-3">{formatCurrency(trade.feesTotal, 3)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <ChartPanel
          title="Polymarket"
          labels={historyLabels}
          series={[
            { key: "poly-up", label: "Up", color: "#1ce7cf", values: historyPoints.map((point) => point.polyUpBuy) },
            { key: "poly-down", label: "Down", color: "#ff627d", values: historyPoints.map((point) => point.polyDownBuy) },
          ]}
        />
        <ChartPanel
          title="Kalshi"
          labels={historyLabels}
          series={[
            { key: "kalshi-yes", label: "Yes", color: "#ffb84f", values: historyPoints.map((point) => point.kalshiYesAsk) },
            { key: "kalshi-no", label: "No", color: "#9ca8ff", values: historyPoints.map((point) => point.kalshiNoAsk) },
          ]}
        />
      </section>

      {dashboard.error ? <ErrorStrip message={dashboard.error} /> : null}
      {history.error ? <ErrorStrip message={history.error} /> : null}
    </div>
  );
}

function MessagePanel({
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

function TopMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/8 px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.14em] text-mist/70">{label}</div>
      <div className="mt-1 text-sm text-white">{value}</div>
    </div>
  );
}

function HeaderRow({
  title,
  meta,
}: {
  title: string;
  meta?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="text-sm text-white">{title}</div>
      {meta ? <div className="text-xs text-mist">{meta}</div> : null}
    </div>
  );
}

function VenuePanel({
  title,
  rows,
  footer,
}: {
  title: string;
  rows: Array<[string, number | null, number | null]>;
  footer: string;
}) {
  return (
    <section className="rounded-2xl border border-white/8 bg-white/[0.02]">
      <HeaderRow title={title} />
      <div className="overflow-hidden">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr className="border-t border-white/6 text-left text-[11px] uppercase tracking-[0.16em] text-mist/70">
              <th className="px-4 py-3 font-normal">Côté</th>
              <th className="px-4 py-3 font-normal">Prix</th>
              <th className="px-4 py-3 font-normal">Depth</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, price, depth]) => (
              <tr key={label} className="border-t border-white/6 text-mist">
                <td className="px-4 py-3 text-white">{label}</td>
                <td className="px-4 py-3 font-mono">{formatPrice(price, 3)}</td>
                <td className="px-4 py-3">{depth ?? "--"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="border-t border-white/6 px-4 py-3 text-xs text-mist">{footer}</div>
      </div>
    </section>
  );
}

function ChartPanel({
  title,
  labels,
  series,
}: {
  title: string;
  labels: string[];
  series: Array<{ key: string; label: string; color: string; values: Array<number | null> }>;
}) {
  return (
    <section className="rounded-2xl border border-white/8 bg-white/[0.02] p-4">
      <div className="text-sm text-white">{title}</div>
      <div className="mt-3">
        <LineChart labels={labels} series={series} />
      </div>
    </section>
  );
}

function ErrorStrip({ message }: { message: string }) {
  return <div className="rounded-xl border border-rose/20 bg-rose/10 px-4 py-3 text-sm text-rose">{message}</div>;
}

function pairLabel(source: Pick<PairSignal, "combination"> | Pick<PaperTrade, "combination">) {
  return source.combination === "POLY_UP_KALSHI_NO" ? "Up + No" : "Down + Yes";
}

function signalLegText(leg: PairSignal["legs"][number]) {
  if (leg.price === null) {
    return "--";
  }

  return `${formatPrice(leg.price, 3)} · ${formatPrice(leg.units, 2)} u`;
}

function tradeLegText(leg: PaperTradeLeg) {
  return `${leg.outcome} · ${formatPrice(leg.price, 3)} · ${formatPrice(leg.units, 2)} u`;
}
