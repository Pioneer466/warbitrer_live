"use client";

import { LineChart } from "@/components/line-chart";
import { ResetPaperButton } from "@/components/reset-paper-button";
import { usePollingJson } from "@/components/use-polling-json";
import {
  formatClock,
  formatCountdown,
  formatCurrency,
  formatDateTime,
  formatPercent,
  formatPrice,
} from "@/lib/format";
import type {
  DashboardResponse,
  HistoryResponse,
  PairSignal,
  PaperTrade,
  PaperTradeLeg,
} from "@/lib/types";

export function DashboardClient() {
  const dashboard = usePollingJson<DashboardResponse>("/api/dashboard", 2_000);
  const history = usePollingJson<HistoryResponse>("/api/history/current-slot", 4_000);

  if (dashboard.loading && !dashboard.data) {
    return <MessagePanel title="Chargement" message="Connexion au moteur paper." />;
  }

  if (!dashboard.data) {
    return (
      <MessagePanel
        title="Erreur"
        message={dashboard.error ?? "Aucune donnée disponible."}
        tone="rose"
      />
    );
  }

  const { latestSnapshot, metrics, openTrades, settings, signals, slot, workerState } =
    dashboard.data;
  const historyPoints = history.data?.points ?? [];
  const historyLabels = historyPoints.map((point) => formatClock(point.ts).slice(0, 5));

  return (
    <div className="space-y-5">
      <section className="rounded-[32px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 shadow-[0_20px_60px_rgba(0,0,0,0.22)] sm:px-6">
        <div className="flex flex-col gap-4 border-b border-white/6 pb-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <div className="text-[11px] uppercase tracking-[0.24em] text-mist/70">Paper BTC 15m</div>
            <div className="text-sm text-mist">{slot.label}</div>
            <div className="text-xs text-mist/70">
              {workerState.lastError
                ? workerState.lastError
                : workerState.lastTickAt
                  ? `Dernier tick ${formatDateTime(workerState.lastTickAt)}`
                  : "En attente du premier tick"}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="font-mono text-[40px] leading-none text-white">
                {formatCountdown(slot.secondsRemaining)}
              </div>
              <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-mist/60">
                fin du créneau
              </div>
            </div>
            <ResetPaperButton />
          </div>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCell
            label="Capital"
            value={formatCurrency(metrics.totalEquity)}
            meta={`Disponible ${formatCurrency(metrics.availableCapital)}`}
          />
          <MetricCell
            label="P&L"
            value={formatCurrency(metrics.realizedPnl)}
            meta={`Frais ${formatCurrency(metrics.feesPaid)}`}
            tone={metrics.realizedPnl >= 0 ? "cyan" : "rose"}
          />
          <MetricCell
            label="Trades"
            value={String(metrics.totalTrades)}
            meta={`${metrics.openTrades} ouverts`}
          />
          <MetricCell
            label="Win Rate"
            value={metrics.resolvedTrades === 0 ? "--" : formatPercent(metrics.winRate)}
            meta={`${metrics.resolvedTrades} résolus`}
          />
        </div>
      </section>

      <section className="rounded-[32px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-3 border-b border-white/6 pb-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-1">
            <div className="text-[11px] uppercase tracking-[0.24em] text-mist/70">Marchés actifs</div>
            <div className="text-sm text-white">Polymarket et Kalshi en direct</div>
          </div>
          <div className="text-xs text-mist/70">
            Somme ≤ {formatPrice(settings.grossEntryThreshold, 2)} · jambe ≤ {formatPrice(settings.maxLegPrice, 2)} · 25$ + 25$
          </div>
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-2">
          <VenueCard
            title="Polymarket"
            venueLabel="UP / DOWN"
            status={latestSnapshot?.polymarket.availabilityReason}
            rows={[
              {
                label: "Up",
                price: latestSnapshot?.polymarket.outcomes.up.buyPrice ?? null,
                depth: latestSnapshot?.polymarket.outcomes.up.depth ?? null,
                tone: "cyan",
              },
              {
                label: "Down",
                price: latestSnapshot?.polymarket.outcomes.down.buyPrice ?? null,
                depth: latestSnapshot?.polymarket.outcomes.down.depth ?? null,
                tone: "rose",
              },
            ]}
          />
          <VenueCard
            title="Kalshi"
            venueLabel="YES / NO"
            status={latestSnapshot?.kalshi.availabilityReason}
            rows={[
              {
                label: "Yes",
                price: latestSnapshot?.kalshi.outcomes.yes.buyPrice ?? null,
                depth: latestSnapshot?.kalshi.outcomes.yes.depth ?? null,
                tone: "amber",
              },
              {
                label: "No",
                price: latestSnapshot?.kalshi.outcomes.no.buyPrice ?? null,
                depth: latestSnapshot?.kalshi.outcomes.no.depth ?? null,
                tone: "indigo",
              },
            ]}
          />
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <ChartPanel
          title="Polymarket"
          subtitle="Up / Down"
          labels={historyLabels}
          series={[
            {
              key: "poly-up",
              label: "Up",
              color: "#1ce7cf",
              fill: "rgba(28,231,207,0.08)",
              values: historyPoints.map((point) => point.polyUpBuy),
            },
            {
              key: "poly-down",
              label: "Down",
              color: "#ff627d",
              fill: "rgba(255,98,125,0.07)",
              values: historyPoints.map((point) => point.polyDownBuy),
            },
          ]}
        />
        <ChartPanel
          title="Kalshi"
          subtitle="Yes / No"
          labels={historyLabels}
          series={[
            {
              key: "kalshi-yes",
              label: "Yes",
              color: "#ffb84f",
              fill: "rgba(255,184,79,0.08)",
              values: historyPoints.map((point) => point.kalshiYesAsk),
            },
            {
              key: "kalshi-no",
              label: "No",
              color: "#92a0ff",
              fill: "rgba(146,160,255,0.07)",
              values: historyPoints.map((point) => point.kalshiNoAsk),
            },
          ]}
        />
      </section>

      <section className="rounded-[28px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 sm:px-6">
        <SectionHeader title="Opportunités" meta="Deux combinaisons surveillées" />
        {signals.length === 0 ? (
          <EmptyState message="Aucune opportunité calculée pour le créneau courant." />
        ) : (
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            {signals.map((signal) => (
              <OpportunityCard key={signal.combination} signal={signal} />
            ))}
          </div>
        )}
      </section>

      <section className="rounded-[28px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 sm:px-6">
        <SectionHeader
          title="Opportunités ouvertes"
          meta={`${openTrades.length} position${openTrades.length > 1 ? "s" : ""}`}
        />
        {openTrades.length === 0 ? (
          <EmptyState message="Aucune opportunité ouverte sur le créneau en cours." />
        ) : (
          <div className="mt-4 grid gap-4">
            {openTrades.map((trade) => (
              <OpenTradeCard key={trade.id} trade={trade} />
            ))}
          </div>
        )}
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

function MetricCell({
  label,
  value,
  meta,
  tone = "default",
}: {
  label: string;
  value: string;
  meta: string;
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
      <div className="mt-2 text-xs text-mist/70">{meta}</div>
    </div>
  );
}

function SectionHeader({
  title,
  meta,
}: {
  title: string;
  meta?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="text-[11px] uppercase tracking-[0.24em] text-mist/70">{title}</div>
      {meta ? <div className="text-xs text-mist/65">{meta}</div> : null}
    </div>
  );
}

function VenueCard({
  title,
  venueLabel,
  status,
  rows,
}: {
  title: string;
  venueLabel: string;
  status: string | null | undefined;
  rows: Array<{
    label: string;
    price: number | null;
    depth: number | null;
    tone: "cyan" | "rose" | "amber" | "indigo";
  }>;
}) {
  return (
    <div className="rounded-[26px] border border-white/6 bg-[#0b0e15] p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm text-white">{title}</div>
          <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-mist/55">
            {venueLabel}
          </div>
        </div>
        <div className="text-right text-xs text-mist/65">
          {status && status !== "Créneau aligné" ? status : "Créneau aligné"}
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className={`rounded-[22px] border px-4 py-4 ${priceToneClass(row.tone)}`}>
            <div className="text-[11px] uppercase tracking-[0.18em] text-mist/70">{row.label}</div>
            <div className="mt-3 font-mono text-[34px] leading-none text-white">
              {formatPrice(row.price, 3)}
            </div>
            <div className="mt-2 text-xs text-mist/65">Depth {row.depth === null ? "--" : formatPrice(row.depth, 2)}</div>
          </div>
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
  series: Array<{
    key: string;
    label: string;
    color: string;
    fill: string;
    values: Array<number | null>;
  }>;
}) {
  return (
    <section className="rounded-[28px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 sm:px-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-sm text-white">{title}</div>
          <div className="mt-1 text-xs text-mist/65">{subtitle}</div>
        </div>
      </div>
      <div className="mt-4">
        <LineChart labels={labels} series={series} />
      </div>
    </section>
  );
}

function OpportunityCard({ signal }: { signal: PairSignal }) {
  const ready = signal.eligible;

  return (
    <div
      className={`rounded-[24px] border px-4 py-4 ${
        ready
          ? "border-[rgba(28,231,207,0.18)] bg-[rgba(28,231,207,0.04)]"
          : "border-white/6 bg-white/[0.02]"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm text-white">{pairLabel(signal)}</div>
          <div className="mt-1 text-xs text-mist/65">{signal.label}</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[28px] leading-none text-white">
            {signal.grossCost === null ? "--" : formatPrice(signal.grossCost, 3)}
          </div>
          <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-mist/55">somme</div>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {signal.legs.map((leg) => (
          <div key={`${leg.venue}-${leg.outcome}`} className="rounded-[18px] border border-white/6 px-3 py-3">
            <div className="text-[11px] uppercase tracking-[0.16em] text-mist/55">
              {leg.venue === "polymarket" ? "Polymarket" : "Kalshi"} · {leg.outcome}
            </div>
            <div className="mt-2 font-mono text-[24px] leading-none text-white">
              {formatPrice(leg.price, 3)}
            </div>
            <div className="mt-2 text-xs text-mist/65">
              {leg.price === null ? "--" : `${formatPrice(leg.units, 2)} u pour ${formatCurrency(leg.stakeUsd)}`}
            </div>
          </div>
        ))}
      </div>

      <div className={`mt-4 text-xs ${ready ? "text-cyan" : "text-mist/70"}`}>
        {ready ? "Prête à l’exécution des deux côtés" : signal.reason ?? "En attente"}
      </div>
    </div>
  );
}

function OpenTradeCard({ trade }: { trade: PaperTrade }) {
  const polyLeg = trade.legs.find((leg) => leg.venue === "polymarket");
  const kalshiLeg = trade.legs.find((leg) => leg.venue === "kalshi");

  return (
    <div className="rounded-[24px] border border-white/6 bg-white/[0.02] px-4 py-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-sm text-white">{pairLabel(trade)}</div>
          <div className="mt-1 text-xs text-mist/65">
            Entrée {formatDateTime(trade.enteredAt)} · clôture {formatDateTime(trade.slotEndTs)}
          </div>
        </div>
        <div className="grid gap-3 text-right sm:grid-cols-3">
          <MiniMetric label="Capital" value={formatCurrency(trade.capitalDeployed)} />
          <MiniMetric label="Frais" value={formatCurrency(trade.feesTotal)} />
          <MiniMetric label="Somme" value={formatPrice(trade.grossPairCost, 3)} />
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <LegCard title="Polymarket" leg={polyLeg} />
        <LegCard title="Kalshi" leg={kalshiLeg} />
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="mt-4 rounded-[22px] border border-white/6 bg-white/[0.02] px-4 py-8 text-center text-sm text-mist/70">
      {message}
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.16em] text-mist/55">{label}</div>
      <div className="mt-2 font-mono text-lg text-white">{value}</div>
    </div>
  );
}

function LegCard({ title, leg }: { title: string; leg: PaperTradeLeg | undefined }) {
  return (
    <div className="rounded-[18px] border border-white/6 px-3 py-3">
      <div className="text-[11px] uppercase tracking-[0.16em] text-mist/55">{title}</div>
      {leg ? (
        <>
          <div className="mt-2 text-sm text-white">{leg.outcome}</div>
          <div className="mt-2 font-mono text-[22px] leading-none text-white">
            {formatPrice(leg.price, 3)}
          </div>
          <div className="mt-2 text-xs text-mist/65">
            {formatPrice(leg.units, 2)} u · {formatCurrency(leg.grossCost)}
          </div>
        </>
      ) : (
        <div className="mt-2 text-sm text-mist/65">Indisponible</div>
      )}
    </div>
  );
}

function ErrorStrip({ message }: { message: string }) {
  return (
    <div className="rounded-[20px] border border-rose/20 bg-rose/10 px-4 py-3 text-sm text-rose">
      {message}
    </div>
  );
}

function pairLabel(source: Pick<PairSignal, "combination"> | Pick<PaperTrade, "combination">) {
  return source.combination === "POLY_UP_KALSHI_NO" ? "Up + No" : "Down + Yes";
}

function priceToneClass(tone: "cyan" | "rose" | "amber" | "indigo") {
  if (tone === "cyan") {
    return "border-[rgba(28,231,207,0.14)] bg-[rgba(28,231,207,0.04)]";
  }

  if (tone === "rose") {
    return "border-[rgba(255,98,125,0.14)] bg-[rgba(255,98,125,0.04)]";
  }

  if (tone === "amber") {
    return "border-[rgba(255,184,79,0.14)] bg-[rgba(255,184,79,0.04)]";
  }

  return "border-[rgba(146,160,255,0.14)] bg-[rgba(146,160,255,0.04)]";
}
