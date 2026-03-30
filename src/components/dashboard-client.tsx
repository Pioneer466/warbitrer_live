"use client";

import Link from "next/link";

import { LineChart } from "@/components/line-chart";
import { usePollingJson } from "@/components/use-polling-json";
import { formatClock, formatCountdown, formatCurrency, formatDateTime, formatPercent, formatPrice } from "@/lib/format";
import type { DashboardResponse, HistoryResponse, PaperTrade } from "@/lib/types";

export function DashboardClient() {
  const dashboard = usePollingJson<DashboardResponse>("/api/dashboard", 2_000);
  const history = usePollingJson<HistoryResponse>("/api/history/current-slot", 4_000);

  if (dashboard.loading && !dashboard.data) {
    return <LoadingState title="Dashboard" description="Connexion au moteur paper et chargement des marchés actifs." />;
  }

  if (!dashboard.data) {
    return <ErrorState message={dashboard.error ?? "Aucune donnée dashboard disponible."} />;
  }

  const { metrics, latestSnapshot, signals, openTrades, slot, workerState, settings } = dashboard.data;
  const historyLabels = history.data?.points.map((point) => formatClock(point.ts).slice(0, 5)) ?? [];
  const historyPoints = history.data?.points ?? [];

  return (
    <div className="space-y-6">
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <MetricCard title="Capital" value={formatCurrency(metrics.availableCapital)} accent="cyan">
          Déployé: {formatCurrency(metrics.deployedCapital)}
        </MetricCard>
        <MetricCard title="P&L" value={formatCurrency(metrics.realizedPnl)} accent={metrics.realizedPnl >= 0 ? "cyan" : "rose"}>
          Frais comptés: {formatCurrency(metrics.feesPaid)}
        </MetricCard>
        <MetricCard title="Trades" value={`${metrics.openTrades} / ${metrics.totalTrades}`} accent="default">
          Actifs / Total
        </MetricCard>
        <MetricCard title="Win Rate" value={formatPercent(metrics.winRate)} accent="amber">
          Résolus: {metrics.resolvedTrades}
        </MetricCard>
        <MetricCard title="Stratégie" value="Temporal Basis Arb" accent="lilac">
          Entrée brute ≤ {formatPrice(settings.grossEntryThreshold, 2)}
        </MetricCard>
      </section>

      <section className="overflow-hidden rounded-[32px] border border-white/8 bg-[#0c1018]/90 shadow-[0_24px_80px_rgba(0,0,0,0.35)]">
        <div className="flex flex-col gap-5 border-b border-white/8 px-5 py-5 sm:px-8">
          <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
            <div className="space-y-3">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber/20 font-mono text-xl font-semibold text-amber">
                  BTC
                </div>
                <div>
                  <h1 className="text-3xl font-semibold tracking-tight text-white">
                    Bitcoin Up or Down — 15 Minutes
                  </h1>
                  <p className="text-sm uppercase tracking-[0.26em] text-mist/70">{slot.label}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-3">
                <PricePill
                  tone="cyan"
                  label="Poly Up"
                  value={latestSnapshot?.polymarket.outcomes.up.buyPrice ?? null}
                />
                <PricePill
                  tone="rose"
                  label="Poly Down"
                  value={latestSnapshot?.polymarket.outcomes.down.buyPrice ?? null}
                />
                <PricePill
                  tone="amber"
                  label="Kalshi Yes"
                  value={latestSnapshot?.kalshi.outcomes.yes.buyPrice ?? null}
                />
                <PricePill
                  tone="mist"
                  label="Kalshi No"
                  value={latestSnapshot?.kalshi.outcomes.no.buyPrice ?? null}
                />
              </div>
            </div>
            <div className="flex items-end justify-between gap-6 rounded-[28px] border border-white/8 bg-white/[0.03] px-5 py-4 lg:min-w-[320px]">
              <div>
                <p className="text-xs uppercase tracking-[0.26em] text-mist/70">État worker</p>
                <p className="mt-2 font-mono text-base text-white">
                  {workerState.lastError ? "Dégradé" : "Actif"}
                </p>
                <p className="mt-1 text-sm text-mist">
                  Dernier tick: {workerState.lastTickAt ? formatDateTime(workerState.lastTickAt) : "--"}
                </p>
              </div>
              <div className="text-right">
                <p className="font-mono text-5xl font-semibold leading-none text-white">
                  {formatCountdown(slot.secondsRemaining)}
                </p>
                <p className="mt-2 text-xs uppercase tracking-[0.26em] text-mist/70">Restant</p>
              </div>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            {signals.map((signal) => (
              <SignalCard key={signal.combination} signal={signal} />
            ))}
          </div>
        </div>

        <div className="grid gap-6 px-5 py-5 sm:px-8 lg:grid-cols-2">
          <div className="space-y-3">
            <SectionTitle
              title="Prix Polymarket"
              subtitle="Achats paper exécutables sur les tokens Up / Down."
            />
            <LineChart
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
          </div>
          <div className="space-y-3">
            <SectionTitle
              title="Prix Kalshi"
              subtitle="Asks synthétiques dérivés du carnet Yes / No."
            />
            <LineChart
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
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
          <SectionTitle
            title="Marchés actifs / signaux"
            subtitle="Coûts bruts par paire opposée et capacité exécutable courante."
          />
          <div className="mt-4 space-y-3">
            {signals.map((signal) => (
              <div
                key={signal.combination}
                className={`rounded-2xl border px-4 py-4 ${
                  signal.thresholdMet ? "border-cyan/20 bg-cyan/8" : "border-white/8 bg-white/[0.02]"
                }`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-lg font-semibold text-white">{signal.label}</p>
                    <p className="mt-1 text-sm text-mist">
                      Coût brut: {signal.grossCost !== null ? formatPrice(signal.grossCost, 3) : "--"} | unités:{" "}
                      {signal.units}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] ${
                      signal.eligible
                        ? "bg-cyan/15 text-cyan"
                        : signal.thresholdMet
                          ? "bg-amber/15 text-amber"
                          : "bg-white/6 text-mist"
                    }`}
                  >
                    {signal.eligible ? "Entrée paper" : signal.reason ?? "Observation"}
                  </span>
                </div>
                <div className="mt-4 grid gap-3 text-sm text-mist md:grid-cols-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.22em] text-mist/70">Max budget</p>
                    <p className="mt-1 font-mono text-white">{signal.maxAffordableUnits}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.22em] text-mist/70">Max profondeur</p>
                    <p className="mt-1 font-mono text-white">{signal.maxDepthUnits}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.22em] text-mist/70">Frais estimés</p>
                    <p className="mt-1 font-mono text-white">{formatCurrency(signal.estimatedFees, 3)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.22em] text-mist/70">Amélioration</p>
                    <p className="mt-1 font-mono text-white">
                      {signal.improvementFromLastEntry === null
                        ? "--"
                        : formatPrice(signal.improvementFromLastEntry, 3)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
          <SectionTitle
            title="Positions ouvertes"
            subtitle="Chaque entrée paper reste ouverte jusqu’à la résolution des deux venues."
          />
          <div className="mt-4 space-y-4">
            {openTrades.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-10 text-center text-mist">
                Aucune position ouverte pour le moment.
              </div>
            ) : (
              openTrades.map((trade) => <OpenTradeCard key={trade.id} trade={trade} />)
            )}
          </div>
          <div className="mt-5">
            <Link
              href="/trades"
              className="inline-flex rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white transition hover:bg-white/[0.08]"
            >
              Voir tout l’historique
            </Link>
          </div>
        </div>
      </section>

      {dashboard.error ? <ErrorBanner message={dashboard.error} /> : null}
      {history.error ? <ErrorBanner message={`Historique: ${history.error}`} /> : null}
    </div>
  );
}

function MetricCard({
  title,
  value,
  accent,
  children,
}: {
  title: string;
  value: string;
  accent: "cyan" | "rose" | "amber" | "lilac" | "default";
  children: React.ReactNode;
}) {
  const accentClass =
    accent === "cyan"
      ? "shadow-glow"
      : accent === "amber"
        ? "shadow-warm"
        : accent === "rose"
          ? "shadow-[0_0_0_1px_rgba(255,98,125,0.14),0_18px_50px_rgba(255,98,125,0.12)]"
          : accent === "lilac"
            ? "shadow-[0_0_0_1px_rgba(143,124,255,0.14),0_18px_50px_rgba(143,124,255,0.12)]"
            : "";

  return (
    <div className={`rounded-[28px] border border-white/8 bg-white/[0.03] p-5 ${accentClass}`}>
      <p className="text-sm uppercase tracking-[0.28em] text-mist/70">{title}</p>
      <p className="mt-4 text-4xl font-semibold tracking-tight text-white">{value}</p>
      <p className="mt-2 text-sm text-mist">{children}</p>
    </div>
  );
}

function PricePill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | null;
  tone: "cyan" | "rose" | "amber" | "mist";
}) {
  const toneClass =
    tone === "cyan"
      ? "border-cyan/20 bg-cyan/10 text-cyan"
      : tone === "rose"
        ? "border-rose/20 bg-rose/10 text-rose"
        : tone === "amber"
          ? "border-amber/20 bg-amber/10 text-amber"
          : "border-white/10 bg-white/6 text-mist";

  return (
    <div className={`rounded-2xl border px-4 py-3 ${toneClass}`}>
      <p className="text-xs uppercase tracking-[0.24em]">{label}</p>
      <p className="mt-2 font-mono text-2xl font-semibold">{formatPrice(value)}</p>
    </div>
  );
}

function SignalCard({ signal }: { signal: DashboardResponse["signals"][number] }) {
  return (
    <div
      className={`rounded-[24px] border px-4 py-4 ${
        signal.eligible ? "border-cyan/20 bg-cyan/8" : "border-white/8 bg-white/[0.02]"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-lg font-semibold text-white">{signal.label}</p>
          <p className="mt-1 text-sm text-mist">
            {signal.grossCost !== null ? `Σ = ${formatPrice(signal.grossCost, 3)}` : "Signal incomplet"}
          </p>
        </div>
        <div className="text-right">
          <p
            className={`text-xs uppercase tracking-[0.26em] ${
              signal.thresholdMet ? "text-cyan" : "text-mist/70"
            }`}
          >
            seuil {formatPrice(signal.threshold, 2)}
          </p>
          <p className="mt-2 font-mono text-xl text-white">{signal.units}</p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm text-mist">
        <div className="rounded-2xl bg-white/[0.03] px-3 py-3">
          <p className="text-xs uppercase tracking-[0.22em] text-mist/70">Leg 1</p>
          <p className="mt-1 text-white">
            {signal.legs[0].venue} {signal.legs[0].outcome} @ {formatPrice(signal.legs[0].price)}
          </p>
        </div>
        <div className="rounded-2xl bg-white/[0.03] px-3 py-3">
          <p className="text-xs uppercase tracking-[0.22em] text-mist/70">Leg 2</p>
          <p className="mt-1 text-white">
            {signal.legs[1].venue} {signal.legs[1].outcome} @ {formatPrice(signal.legs[1].price)}
          </p>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight text-white">{title}</h2>
      <p className="mt-1 text-sm text-mist">{subtitle}</p>
    </div>
  );
}

function OpenTradeCard({ trade }: { trade: PaperTrade }) {
  return (
    <div className="rounded-[24px] border border-white/8 bg-[#0b0f17] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-base font-semibold text-white">{trade.combination}</p>
          <p className="mt-1 text-sm text-mist">
            Pris le {formatDateTime(trade.enteredAt)} | coût brut {formatPrice(trade.grossPairCost, 3)}
          </p>
        </div>
        <div className="rounded-full bg-white/[0.06] px-3 py-1 text-xs uppercase tracking-[0.22em] text-cyan">
          {trade.units} unités
        </div>
      </div>
      <div className="mt-4 grid gap-3 text-sm text-mist md:grid-cols-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-mist/70">Capital déployé</p>
          <p className="mt-1 text-white">{formatCurrency(trade.capitalDeployed)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-mist/70">Frais</p>
          <p className="mt-1 text-white">{formatCurrency(trade.feesTotal, 3)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-mist/70">Quasi-arb théorique</p>
          <p className="mt-1 text-white">{formatCurrency(trade.theoreticalSameResolutionProfit)}</p>
        </div>
      </div>
    </div>
  );
}

function LoadingState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-[28px] border border-white/8 bg-white/[0.03] px-6 py-16 text-center">
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
