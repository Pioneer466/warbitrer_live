"use client";

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
import type { DashboardResponse, HistoryResponse, LiveOpportunity, OrderIntent, PositionSnapshot } from "@/lib/types";

export function DashboardClient() {
  const dashboard = usePollingJson<DashboardResponse>("/api/dashboard", 2_000);
  const history = usePollingJson<HistoryResponse>("/api/history/current-slot", 4_000);

  if (dashboard.loading && !dashboard.data) {
    return <PanelMessage title="Chargement" message="Connexion au moteur live." />;
  }

  if (!dashboard.data) {
    return (
      <PanelMessage
        title="Erreur"
        message={dashboard.error ?? "Aucune donnée live disponible."}
        tone="rose"
      />
    );
  }

  const { config, workerState, slot, venueBalances, opportunities, openIntents, positions, pnl, recentFills, circuitBreakers, runEvents } =
    dashboard.data;

  const historyPoints = history.data?.points ?? [];
  const historyLabels = historyPoints.map((point) => formatClock(point.ts).slice(0, 5));
  const activeBreakers = circuitBreakers.filter((breaker) => breaker.active);
  const perLegNotionalUsd = config.maxPairNotionalUsd / 2;
  const kalshiDisplay = buildNormalizedBinaryDisplay(
    historyPoints.map((point) => point.kalshiYesAsk),
    historyPoints.map((point) => point.kalshiNoAsk),
  );

  return (
    <div className="space-y-5">
      <section className="rounded-[32px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 shadow-[0_20px_60px_rgba(0,0,0,0.22)] sm:px-6">
        <div className="flex flex-col gap-4 border-b border-white/6 pb-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <div className="text-[11px] uppercase tracking-[0.24em] text-mist/70">Live BTC 15m</div>
            <div className="text-sm text-white">{slot.label}</div>
            <div className="text-xs text-mist/70">
              phase `{workerState.phase}` · readiness `{workerState.readinessStatus}`
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="font-mono text-[40px] leading-none text-white">
                {formatCountdown(slot.secondsRemaining)}
              </div>
              <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-mist/60">
                fin du créneau
              </div>
            </div>
            <StatusBadge tone={!config.enableTrading ? "amber" : config.shadowMode ? "indigo" : "cyan"}>
              {!config.enableTrading ? "trading off" : config.shadowMode ? "shadow" : "live"}
            </StatusBadge>
          </div>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCell label="Equity" value={pnl ? formatCurrency(pnl.equityUsd) : "--"} />
          <MetricCell label="Cash" value={pnl ? formatCurrency(pnl.cashUsd) : "--"} />
          <MetricCell label="Positions" value={String(positions.length)} meta={`${openIntents.length} intents ouverts`} />
          <MetricCell
            label="P&L"
            value={pnl ? formatCurrency(pnl.realizedPnlUsd + pnl.unrealizedPnlUsd) : "--"}
            meta={pnl ? `Frais ${formatCurrency(pnl.feesUsd)}` : undefined}
            tone={pnl && pnl.realizedPnlUsd + pnl.unrealizedPnlUsd >= 0 ? "cyan" : "rose"}
          />
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        {venueBalances.map((balance) => (
          <VenueBalanceCard key={balance.venue} balance={balance} />
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <ChartPanel
          title="Polymarket UP / DOWN"
          labels={historyLabels}
          series={[
            {
              key: "poly-up",
              label: "Poly UP",
              color: "#1ce7cf",
              fill: "rgba(28,231,207,0.08)",
              values: historyPoints.map((point) => point.polyUpBuy),
            },
            {
              key: "poly-down",
              label: "Poly DOWN",
              color: "#92a0ff",
              fill: "rgba(146,160,255,0.08)",
              values: historyPoints.map((point) => point.polyDownBuy),
            },
          ]}
        />
        <ChartPanel
          title="Kalshi YES / NO"
          meta="vue normalisee et lisse pour lisibilite ; execution sur asks bruts"
          labels={historyLabels}
          series={[
            {
              key: "kalshi-yes",
              label: "Kalshi YES",
              color: "#ffb84f",
              fill: "rgba(255,184,79,0.08)",
              values: kalshiDisplay.yes,
            },
            {
              key: "kalshi-no",
              label: "Kalshi NO",
              color: "#ff7a5c",
              fill: "rgba(255,122,92,0.08)",
              values: kalshiDisplay.no,
            },
          ]}
        />
      </section>

      <section className="rounded-[28px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 sm:px-6">
        <SectionHeader
          title="Opportunités"
          meta={`Entree si cout total <= ${formatPrice(config.grossEntryThreshold, 3)} · prix max/jambe <= ${formatPrice(config.maxLegPrice, 2)} · ${formatCurrency(config.maxPairNotionalUsd)} total = ${formatCurrency(perLegNotionalUsd)} par jambe`}
        />
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          {opportunities.length === 0 ? (
            <EmptyState message="Aucune opportunité calculée pour ce créneau." />
          ) : (
            opportunities.map((opportunity) => (
              <OpportunityCard key={opportunity.id} opportunity={opportunity} />
            ))
          )}
        </div>
      </section>

      <section className="rounded-[28px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 sm:px-6">
        <SectionHeader title="Intents Ouverts" meta={`${openIntents.length} actifs`} />
        <div className="mt-4 grid gap-4">
          {openIntents.length === 0 ? (
            <EmptyState message="Aucun intent live ouvert." />
          ) : (
            openIntents.map((intent) => <IntentCard key={intent.id} intent={intent} />)
          )}
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <Panel title="Positions" meta={`${positions.length} lignes`}>
          {positions.length === 0 ? (
            <EmptyState message="Aucune position live." />
          ) : (
            <div className="grid gap-3">
              {positions.map((position) => (
                <PositionRow key={position.id} position={position} />
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Recent Fills" meta={`${recentFills.length} événements`}>
          {recentFills.length === 0 ? (
            <EmptyState message="Aucun fill enregistré." />
          ) : (
            <div className="grid gap-3">
              {recentFills.slice(0, 8).map((fill) => (
                <div key={fill.id} className="rounded-[18px] border border-white/6 px-3 py-3 text-sm text-mist">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-white">
                      {fill.venue} · {fill.outcome} · {fill.side}
                    </div>
                    <div>{formatDateTime(fill.filledAt)}</div>
                  </div>
                  <div className="mt-2">
                    {formatPrice(fill.size, 2)} @ {formatPrice(fill.price, 4)} · fee {formatCurrency(fill.feeUsd)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <Panel title="Readiness" meta={workerState.readinessStatus}>
          <div className="grid gap-3">
            {workerState.readiness.map((check) => (
              <div key={check.key} className="rounded-[18px] border border-white/6 px-3 py-3 text-sm text-mist">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-white">{check.label}</div>
                  <StatusBadge tone={check.status === "ready" ? "cyan" : check.status === "degraded" ? "amber" : "rose"}>
                    {check.status}
                  </StatusBadge>
                </div>
                <div className="mt-2">{check.details}</div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Breakers & Logs" meta={`${activeBreakers.length} actifs`}>
          <div className="grid gap-3">
            {activeBreakers.map((breaker) => (
              <div key={breaker.key} className="rounded-[18px] border border-rose/20 bg-rose/10 px-3 py-3 text-sm text-rose">
                {breaker.key} · {breaker.reason ?? "unknown"}
              </div>
            ))}
            {runEvents.slice(0, 6).map((event) => (
              <div key={`${event.id}-${event.createdAt}`} className="rounded-[18px] border border-white/6 px-3 py-3 text-sm text-mist">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-white">{event.eventType}</div>
                  <div>{formatDateTime(event.createdAt)}</div>
                </div>
                <div className="mt-2">{event.message}</div>
              </div>
            ))}
          </div>
        </Panel>
      </section>

      {dashboard.error ? <PanelMessage title="Erreur" message={dashboard.error} tone="rose" /> : null}
      {history.error ? <PanelMessage title="Erreur" message={history.error} tone="rose" /> : null}
    </div>
  );
}

function VenueBalanceCard({ balance }: { balance: DashboardResponse["venueBalances"][number] }) {
  return (
    <section className="rounded-[32px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 sm:px-6">
      <div className="flex items-center justify-between gap-3 border-b border-white/6 pb-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.24em] text-mist/70">{balance.venue}</div>
          <div className="mt-1 text-sm text-white">{formatCurrency(balance.totalBalanceUsd)} total</div>
        </div>
        <StatusBadge tone={balance.status === "ready" ? "cyan" : balance.status === "degraded" ? "amber" : "rose"}>
          {balance.status}
        </StatusBadge>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <MetricCell label="Disponible" value={formatCurrency(balance.availableBalanceUsd)} compact />
        <MetricCell label="Portfolio" value={formatCurrency(balance.portfolioValueUsd)} compact />
        <MetricCell label="Allowance" value={balance.allowanceUsd === null ? "--" : formatCurrency(balance.allowanceUsd)} compact />
      </div>
      {balance.notes.length > 0 ? (
        <div className="mt-4 rounded-[18px] border border-white/6 bg-white/[0.02] px-3 py-3 text-sm text-mist">
          {balance.notes.join(" | ")}
        </div>
      ) : null}
    </section>
  );
}

function OpportunityCard({ opportunity }: { opportunity: LiveOpportunity }) {
  return (
    <div className="rounded-[24px] border border-white/6 bg-white/[0.02] px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-white">{opportunity.label}</div>
          <div className="mt-1 text-sm text-mist">
            primaire {opportunity.primaryVenue ?? "--"} · cout total {formatPrice(opportunity.grossCost, 3)}
          </div>
        </div>
        <StatusBadge tone={opportunity.eligible ? "cyan" : "amber"}>
          {opportunity.eligible ? "eligible" : "blocked"}
        </StatusBadge>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {opportunity.legs.map((leg) => (
          <div key={`${leg.venue}-${leg.outcome}`} className="rounded-[18px] border border-white/6 px-3 py-3 text-sm text-mist">
            <div className="text-white">
              {leg.venue} · {leg.outcome}
            </div>
            <div className="mt-2">
              prix {formatPrice(leg.price, 4)} · notionnel {formatCurrency(leg.targetNotionalUsd)} · size {formatPrice(leg.size, 2)} · fee {formatCurrency(leg.feeEstimateUsd)}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 text-sm text-mist">
        PnL projeté {opportunity.projectedNetProfitUsd === null ? "--" : formatCurrency(opportunity.projectedNetProfitUsd)}
        {opportunity.projectedNetReturn === null ? "" : ` · ${formatPercent(opportunity.projectedNetReturn)}`}
      </div>
      {opportunity.reasons.length > 0 ? (
        <div className="mt-3 rounded-[18px] border border-amber/20 bg-amber/10 px-3 py-3 text-sm text-amber">
          <div className="flex flex-wrap gap-2">
            {opportunity.reasons.map((reason) => (
              <span key={reason} className="rounded-full border border-amber/20 bg-black/10 px-2 py-1">
                {reason}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function IntentCard({ intent }: { intent: OrderIntent }) {
  return (
    <div className="rounded-[24px] border border-white/6 bg-white/[0.02] px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-white">{intent.combination}</div>
          <div className="mt-1 text-sm text-mist">
            {intent.primaryVenue} {"->"} {intent.hedgeVenue} · {formatDateTime(intent.createdAt)}
          </div>
        </div>
        <StatusBadge tone={intent.status === "hedged" ? "cyan" : intent.status === "failed" || intent.status === "unwound" ? "rose" : "amber"}>
          {intent.status}
        </StatusBadge>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {intent.legs.map((leg) => (
          <div key={leg.id} className="rounded-[18px] border border-white/6 px-3 py-3 text-sm text-mist">
            <div className="text-white">
              {leg.venue} · {leg.outcome}
            </div>
            <div className="mt-2">
              req {formatPrice(leg.requestedSize, 2)} · filled {formatPrice(leg.filledSize, 2)} · fee {formatCurrency(leg.feeUsd)}
            </div>
          </div>
        ))}
      </div>
      {intent.failureReason ? (
        <div className="mt-3 rounded-[18px] border border-rose/20 bg-rose/10 px-3 py-3 text-sm text-rose">
          {intent.failureReason}
        </div>
      ) : null}
    </div>
  );
}

function PositionRow({ position }: { position: PositionSnapshot }) {
  return (
    <div className="rounded-[18px] border border-white/6 px-3 py-3 text-sm text-mist">
      <div className="flex items-center justify-between gap-3">
        <div className="text-white">
          {position.venue} · {position.outcome}
        </div>
        <div>{formatCurrency(position.currentValueUsd)}</div>
      </div>
      <div className="mt-2">
        size {formatPrice(position.size, 2)} · avg {formatPrice(position.averagePrice, 4)} · unrealized {formatCurrency(position.unrealizedPnlUsd)}
      </div>
    </div>
  );
}

function Panel({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 sm:px-6">
      <SectionHeader title={title} meta={meta} />
      <div className="mt-4">{children}</div>
    </section>
  );
}

function ChartPanel({
  title,
  meta,
  labels,
  series,
}: {
  title: string;
  meta?: string;
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
    <Panel title={title} meta={meta}>
      <LineChart labels={labels} series={series} />
    </Panel>
  );
}

function SectionHeader({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="flex flex-col gap-2 border-b border-white/6 pb-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="text-sm text-white">{title}</div>
      {meta ? <div className="text-xs text-mist/70">{meta}</div> : null}
    </div>
  );
}

function MetricCell({
  label,
  value,
  meta,
  tone = "default",
  compact = false,
}: {
  label: string;
  value: string;
  meta?: string;
  tone?: "default" | "cyan" | "rose";
  compact?: boolean;
}) {
  return (
    <div className="rounded-[24px] border border-white/6 bg-white/[0.02] px-4 py-4">
      <div className="text-[11px] uppercase tracking-[0.18em] text-mist/65">{label}</div>
      <div
        className={`mt-3 font-mono ${compact ? "text-[24px]" : "text-[34px]"} leading-none ${
          tone === "cyan" ? "text-cyan" : tone === "rose" ? "text-rose" : "text-white"
        }`}
      >
        {value}
      </div>
      {meta ? <div className="mt-2 text-xs text-mist/60">{meta}</div> : null}
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

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-[22px] border border-white/6 bg-white/[0.02] px-4 py-8 text-center text-sm text-mist/70">
      {message}
    </div>
  );
}

function StatusBadge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "cyan" | "amber" | "rose" | "indigo";
}) {
  const toneClass =
    tone === "cyan"
      ? "border-cyan/20 bg-cyan/10 text-cyan"
      : tone === "indigo"
        ? "border-[rgba(146,160,255,0.18)] bg-[rgba(146,160,255,0.08)] text-[#92a0ff]"
      : tone === "amber"
        ? "border-amber/20 bg-amber/10 text-amber"
        : "border-rose/20 bg-rose/10 text-rose";

  return <span className={`rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.16em] ${toneClass}`}>{children}</span>;
}

function buildNormalizedBinaryDisplay(
  left: Array<number | null>,
  right: Array<number | null>,
) {
  const normalized = left.map((leftValue, index) => {
    const rightValue = right[index];
    if (leftValue === null || rightValue === null) {
      return null;
    }

    const total = leftValue + rightValue;
    if (!Number.isFinite(total) || total <= 0) {
      return null;
    }

    return {
      left: leftValue / total,
      right: rightValue / total,
    };
  });

  return {
    yes: smoothSeries(normalized.map((point) => point?.left ?? null)),
    no: smoothSeries(normalized.map((point) => point?.right ?? null)),
  };
}

function smoothSeries(values: Array<number | null>) {
  return values.map((_, index) => {
    const window = values
      .slice(Math.max(0, index - 1), Math.min(values.length, index + 2))
      .filter((value): value is number => value !== null);

    if (window.length === 0) {
      return null;
    }

    return window.reduce((sum, value) => sum + value, 0) / window.length;
  });
}
