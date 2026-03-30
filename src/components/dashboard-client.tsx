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
import type { DashboardResponse, HistoryResponse, PaperTrade, PairSignal, PaperTradeLeg } from "@/lib/types";

export function DashboardClient() {
  const dashboard = usePollingJson<DashboardResponse>("/api/dashboard", 2_000);
  const history = usePollingJson<HistoryResponse>("/api/history/current-slot", 4_000);

  if (dashboard.loading && !dashboard.data) {
    return (
      <LoadingState
        title="Dashboard"
        description="Connexion au moteur paper et chargement du créneau courant."
      />
    );
  }

  if (!dashboard.data) {
    return <ErrorState message={dashboard.error ?? "Aucune donnée dashboard disponible."} />;
  }

  const { metrics, latestSnapshot, signals, openTrades, slot, workerState, settings } = dashboard.data;
  const historyLabels = history.data?.points.map((point) => formatClock(point.ts).slice(0, 5)) ?? [];
  const historyPoints = history.data?.points ?? [];

  return (
    <div className="space-y-6">
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Capital disponible" value={formatCurrency(metrics.availableCapital)}>
          Déployé: {formatCurrency(metrics.deployedCapital)}
        </StatCard>
        <StatCard label="P&L réalisé" value={formatCurrency(metrics.realizedPnl)}>
          Frais payés: {formatCurrency(metrics.feesPaid)}
        </StatCard>
        <StatCard label="Trades" value={`${metrics.openTrades} / ${metrics.totalTrades}`}>
          Ouverts / Total
        </StatCard>
        <StatCard label="Win rate" value={formatPercent(metrics.winRate)}>
          Résolus: {metrics.resolvedTrades}
        </StatCard>
      </section>

      <section className="rounded-[28px] border border-white/8 bg-panel/90 p-5 shadow-[0_18px_60px_rgba(0,0,0,0.28)] sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-mist/70">Créneau en cours</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">Bitcoin Up or Down · 15 min</h1>
            <p className="mt-2 text-sm text-mist">{slot.label}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
              <p className="text-xs uppercase tracking-[0.22em] text-mist/70">Temps restant</p>
              <p className="mt-2 font-mono text-3xl font-semibold text-white">
                {formatCountdown(slot.secondsRemaining)}
              </p>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
              <p className="text-xs uppercase tracking-[0.22em] text-mist/70">Worker</p>
              <p className="mt-2 text-sm font-medium text-white">
                {workerState.lastError ? "Dégradé" : "Actif"}
              </p>
              <p className="mt-1 text-xs text-mist">
                Dernier tick: {workerState.lastTickAt ? formatDateTime(workerState.lastTickAt) : "--"}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <VenuePanel
            venue="Polymarket"
            status={latestSnapshot?.polymarket.slotAligned ? "Aligné" : "En attente"}
            reason={latestSnapshot?.polymarket.availabilityReason ?? null}
            slotText={latestSnapshot?.polymarket.ref.slotKey === slot.key ? "Créneau courant" : "Hors créneau"}
            rows={[
              { label: "Up", value: latestSnapshot?.polymarket.outcomes.up.buyPrice ?? null },
              { label: "Down", value: latestSnapshot?.polymarket.outcomes.down.buyPrice ?? null },
            ]}
          />
          <VenuePanel
            venue="Kalshi"
            status={latestSnapshot?.kalshi.slotAligned ? "Aligné" : "En attente"}
            reason={latestSnapshot?.kalshi.availabilityReason ?? null}
            slotText={latestSnapshot?.kalshi.ref.slotKey === slot.key ? "Créneau courant" : "Créneau non trouvé"}
            rows={[
              { label: "Yes", value: latestSnapshot?.kalshi.outcomes.yes.buyPrice ?? null },
              { label: "No", value: latestSnapshot?.kalshi.outcomes.no.buyPrice ?? null },
            ]}
          />
        </div>
      </section>

      <section className="rounded-[28px] border border-white/8 bg-panel/90 shadow-[0_18px_60px_rgba(0,0,0,0.24)]">
        <div className="border-b border-white/8 px-5 py-4 sm:px-6">
          <SectionTitle
            title="Opportunités"
            subtitle={`Entrée paper seulement si les deux jambes du même créneau sont exécutables et Σ ≤ ${formatPrice(
              settings.grossEntryThreshold,
              2,
            )}.`}
          />
        </div>
        <div className="divide-y divide-white/6">
          {signals.length === 0 ? (
            <div className="px-5 py-8 text-sm text-mist sm:px-6">Aucun signal disponible pour le créneau courant.</div>
          ) : (
            signals.map((signal) => <SignalRow key={signal.combination} signal={signal} />)
          )}
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <ChartPanel
          title="Polymarket"
          subtitle="Prix d'achat Up / Down sur le créneau courant."
          labels={historyLabels}
          series={[
            {
              key: "poly-up",
              label: "Poly Up",
              color: "#1ce7cf",
              values: historyPoints.map((point) => point.polyUpBuy),
            },
            {
              key: "poly-down",
              label: "Poly Down",
              color: "#ff627d",
              values: historyPoints.map((point) => point.polyDownBuy),
            },
          ]}
        />
        <ChartPanel
          title="Kalshi"
          subtitle="Asks synthétiques Yes / No dérivés du carnet."
          labels={historyLabels}
          series={[
            {
              key: "kalshi-yes",
              label: "Kalshi Yes",
              color: "#ffb84f",
              values: historyPoints.map((point) => point.kalshiYesAsk),
            },
            {
              key: "kalshi-no",
              label: "Kalshi No",
              color: "#9ca8ff",
              values: historyPoints.map((point) => point.kalshiNoAsk),
            },
          ]}
        />
      </section>

      <section className="rounded-[28px] border border-white/8 bg-panel/90 shadow-[0_18px_60px_rgba(0,0,0,0.24)]">
        <div className="flex flex-col gap-3 border-b border-white/8 px-5 py-4 sm:flex-row sm:items-end sm:justify-between sm:px-6">
          <SectionTitle
            title="Positions ouvertes"
            subtitle="Chaque entrée paper contient toujours les deux jambes du même créneau."
          />
          <Link
            href="/trades"
            className="inline-flex rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white transition hover:bg-white/[0.08]"
          >
            Historique complet
          </Link>
        </div>

        <div className="px-5 py-5 sm:px-6">
          {openTrades.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-10 text-center text-sm text-mist">
              Aucune position ouverte.
            </div>
          ) : (
            <div className="space-y-3">
              {openTrades.map((trade) => (
                <OpenTradeRow key={trade.id} trade={trade} />
              ))}
            </div>
          )}
        </div>
      </section>

      {dashboard.error ? <ErrorBanner message={dashboard.error} /> : null}
      {history.error ? <ErrorBanner message={`Historique: ${history.error}`} /> : null}
    </div>
  );
}

function StatCard({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[24px] border border-white/8 bg-panel/85 p-5">
      <p className="text-xs uppercase tracking-[0.24em] text-mist/70">{label}</p>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-white">{value}</p>
      <p className="mt-2 text-sm text-mist">{children}</p>
    </div>
  );
}

function VenuePanel({
  venue,
  status,
  reason,
  slotText,
  rows,
}: {
  venue: string;
  status: string;
  reason: string | null;
  slotText: string;
  rows: Array<{ label: string; value: number | null }>;
}) {
  return (
    <div className="rounded-[24px] border border-white/8 bg-white/[0.03] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-white">{venue}</p>
          <p className="mt-1 text-xs uppercase tracking-[0.22em] text-mist/70">{slotText}</p>
        </div>
        <StatusChip label={status} tone={reason ? "amber" : "cyan"} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        {rows.map((row) => (
          <div key={row.label} className="rounded-2xl border border-white/8 bg-[#0d1119] px-3 py-3">
            <p className="text-xs uppercase tracking-[0.22em] text-mist/70">{row.label}</p>
            <p className="mt-2 font-mono text-2xl font-semibold text-white">{formatPrice(row.value)}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-sm text-mist">{reason ?? "Marché synchronisé sur le créneau courant."}</p>
    </div>
  );
}

function SignalRow({ signal }: { signal: PairSignal }) {
  const tone = signal.eligible
    ? "cyan"
    : signal.reason?.includes("indisponible") || signal.reason?.includes("alignés")
      ? "amber"
      : "default";
  const label = signal.eligible
    ? "Prêt"
    : signal.reason?.includes("indisponible") || signal.reason?.includes("alignés")
      ? "En attente"
      : "Bloqué";

  return (
    <div className="px-5 py-4 sm:px-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-base font-semibold text-white">{formatCombinationLabel(signal.combination)}</p>
            <StatusChip label={label} tone={tone} />
          </div>
          <p className="mt-2 text-sm text-mist">
            {signal.reason ?? "Les deux jambes sont disponibles et alignées sur le créneau courant."}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <MiniMetric label="Σ brut" value={signal.grossCost === null ? "--" : formatPrice(signal.grossCost, 3)} />
          <MiniMetric label="Unités" value={String(signal.units)} />
          <MiniMetric label="Frais est." value={formatCurrency(signal.estimatedFees, 3)} />
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {signal.legs.map((leg) => (
          <LegQuoteCard
            key={`${signal.combination}-${leg.venue}-${leg.outcome}`}
            label={`${formatVenueLabel(leg.venue)} ${leg.outcome}`}
            price={leg.price}
            depth={leg.depth}
          />
        ))}
      </div>
    </div>
  );
}

function ChartPanel({
  title,
  subtitle,
  labels,
  series,
}: {
  title: string;
  subtitle: string;
  labels: string[];
  series: Array<{ key: string; label: string; color: string; values: Array<number | null> }>;
}) {
  return (
    <div className="rounded-[28px] border border-white/8 bg-panel/90 p-5 shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
      <SectionTitle title={title} subtitle={subtitle} />
      <div className="mt-4">
        <LineChart labels={labels} series={series} />
      </div>
    </div>
  );
}

function OpenTradeRow({ trade }: { trade: PaperTrade }) {
  return (
    <div className="rounded-[24px] border border-white/8 bg-white/[0.03] p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-base font-semibold text-white">{formatCombinationLabel(trade.combination)}</p>
            <StatusChip label="Ouvert" tone="cyan" />
          </div>
          <p className="mt-2 text-sm text-mist">
            Pris le {formatDateTime(trade.enteredAt)} · entrée {formatPrice(trade.grossPairCost, 3)} · {trade.units} unités
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <MiniMetric label="Capital" value={formatCurrency(trade.capitalDeployed)} />
          <MiniMetric label="Frais" value={formatCurrency(trade.feesTotal, 3)} />
          <MiniMetric label="Quasi-arb" value={formatCurrency(trade.theoreticalSameResolutionProfit)} />
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {trade.legs.map((leg) => (
          <OpenLegCard key={leg.id} leg={leg} />
        ))}
      </div>
    </div>
  );
}

function LegQuoteCard({
  label,
  price,
  depth,
}: {
  label: string;
  price: number | null;
  depth: number | null;
}) {
  return (
    <div className="rounded-2xl border border-white/8 bg-[#0d1119] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-white">{label}</p>
        <p className="text-xs uppercase tracking-[0.22em] text-mist/70">Profondeur {depth ?? "--"}</p>
      </div>
      <p className="mt-2 font-mono text-xl font-semibold text-white">{formatPrice(price)}</p>
    </div>
  );
}

function OpenLegCard({ leg }: { leg: PaperTradeLeg }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-[#0d1119] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-white">
          {formatVenueLabel(leg.venue)} {leg.outcome}
        </p>
        <p className="text-xs uppercase tracking-[0.22em] text-mist/70">{leg.units} unités</p>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <MiniMetric label="Prix" value={formatPrice(leg.price)} />
        <MiniMetric label="Coût brut" value={formatCurrency(leg.grossCost)} />
        <MiniMetric label="Net shares" value={formatPrice(leg.netShares)} />
      </div>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-[#0d1119] px-3 py-3">
      <p className="text-xs uppercase tracking-[0.2em] text-mist/70">{label}</p>
      <p className="mt-2 text-sm font-medium text-white">{value}</p>
    </div>
  );
}

function StatusChip({
  label,
  tone,
}: {
  label: string;
  tone: "cyan" | "amber" | "default";
}) {
  const toneClass =
    tone === "cyan"
      ? "border-cyan/20 bg-cyan/10 text-cyan"
      : tone === "amber"
        ? "border-amber/20 bg-amber/10 text-amber"
        : "border-white/10 bg-white/[0.04] text-mist";

  return (
    <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] ${toneClass}`}>
      {label}
    </span>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2 className="text-xl font-semibold tracking-tight text-white">{title}</h2>
      <p className="mt-1 text-sm text-mist">{subtitle}</p>
    </div>
  );
}

function LoadingState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-[28px] border border-white/8 bg-panel/90 px-6 py-16 text-center">
      <p className="text-sm uppercase tracking-[0.28em] text-mist/70">{title}</p>
      <p className="mt-4 text-2xl font-semibold text-white">Initialisation</p>
      <p className="mt-2 text-mist">{description}</p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-[28px] border border-rose/20 bg-rose/10 px-6 py-10 text-center text-rose">
      {message}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-rose/20 bg-rose/10 px-4 py-3 text-sm text-rose">
      {message}
    </div>
  );
}

function formatCombinationLabel(combination: PairSignal["combination"] | PaperTrade["combination"]) {
  if (combination === "POLY_UP_KALSHI_NO") {
    return "Poly Up + Kalshi No";
  }

  return "Poly Down + Kalshi Yes";
}

function formatVenueLabel(venue: PaperTradeLeg["venue"] | PairSignal["legs"][number]["venue"]) {
  return venue === "polymarket" ? "Polymarket" : "Kalshi";
}
