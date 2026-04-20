"use client";

import { useState } from "react";

import { LineChart } from "@/components/line-chart";
import { usePollingJson } from "@/components/use-polling-json";
import { TradingToggle } from "@/components/trading-toggle";
import {
  formatClock,
  formatCountdown,
  formatCurrency,
  formatDateTime,
  formatPercent,
  formatPrice,
} from "@/lib/format";
import { isRiskActivePosition } from "@/lib/positions";
import type {
  DashboardResponse,
  HistoryResponse,
  LiveOpportunity,
  MarketAsset,
  OrderIntent,
  PositionSnapshot,
  VenueFeedHealth,
} from "@/lib/types";

export function DashboardClient({ asset }: { asset: MarketAsset }) {
  const dashboard = usePollingJson<DashboardResponse>(`/api/dashboard/${asset}`, 1_000);
  const history = usePollingJson<HistoryResponse>(`/api/history/current-slot?asset=${asset}`, 1_000);
  const [showAllPositions, setShowAllPositions] = useState(false);
  const [showAllRecentFills, setShowAllRecentFills] = useState(false);

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

  const { config, workerState, latestSnapshot, feedHealth, slot, venueBalances, opportunities, openIntents, positions, pnl, recentFills, circuitBreakers, runEvents } =
    dashboard.data;

  const historyPoints = history.data?.points ?? [];
  const historyFeedHealth = history.data?.feedHealth ?? feedHealth;
  const historyLabels = historyPoints.map((point) => formatClock(point.ts).slice(0, 5));
  const activeBreakers = circuitBreakers.filter((breaker) => breaker.active);
  const perLegNotionalUsd = config.maxPairNotionalUsd / 2;
  const polyFeed = historyFeedHealth.find((item) => item.venue === "polymarket") ?? latestSnapshot?.polymarket.feedHealth ?? null;
  const kalshiFeed = historyFeedHealth.find((item) => item.venue === "kalshi") ?? latestSnapshot?.kalshi.feedHealth ?? null;
  const displayPositions = positions.filter(isDisplayablePosition);
  const sortedPositions = [...displayPositions].sort((left, right) => {
    const leftScore = Math.max(Math.abs(left.currentValueUsd), Math.abs(left.unrealizedPnlUsd), Math.abs(left.size));
    const rightScore = Math.max(Math.abs(right.currentValueUsd), Math.abs(right.unrealizedPnlUsd), Math.abs(right.size));
    return rightScore - leftScore || right.updatedAt - left.updatedAt;
  });
  const visiblePositions = showAllPositions ? sortedPositions : sortedPositions.slice(0, 2);
  const visibleRecentFills = showAllRecentFills ? recentFills : recentFills.slice(0, 2);
  const strategyPnlUsd = pnl?.strategyPnlUsd ?? (pnl ? pnl.realizedPnlUsd + pnl.unrealizedPnlUsd : null);
  const accountDeltaUsd = pnl?.accountDeltaUsd ?? strategyPnlUsd;
  const drawdownUsd = pnl?.drawdownUsd ?? 0;
  const showDrawdownHeadline = pnl ? drawdownUsd <= -5 : false;
  const accountHeadlineLabel = showDrawdownHeadline ? "Drawdown" : "Delta Compte";
  const accountHeadlineValue = showDrawdownHeadline ? drawdownUsd : (accountDeltaUsd ?? 0);
  const accountHeadlineMeta = pnl
    ? showDrawdownHeadline
      ? `Depuis pic ${formatCurrency(pnl.peakEquityUsd ?? pnl.equityUsd)} · Delta total ${formatCurrency(accountDeltaUsd ?? 0)} · Strategie ${formatCurrency(strategyPnlUsd ?? 0)}`
      : `DD ${formatCurrency(drawdownUsd)} · Strategie ${formatCurrency(strategyPnlUsd ?? 0)} · Frais ${formatCurrency(pnl.feesUsd)}`
    : undefined;

  return (
    <div className="space-y-5">
      <section className="rounded-[32px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 shadow-[0_20px_60px_rgba(0,0,0,0.22)] sm:px-6">
        <div className="flex flex-col gap-4 border-b border-white/6 pb-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <div className="text-[11px] uppercase tracking-[0.24em] text-mist/70">Live {slot.asset.toUpperCase()} 15m</div>
            <div className="text-sm text-white">{slot.label}</div>
            <div className="text-xs text-mist/70">
              phase `{workerState.phase}` · readiness `{workerState.readinessStatus}`
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <TradingToggle asset={slot.asset} />
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
          <MetricCell label="Positions" value={String(displayPositions.length)} meta={`${openIntents.length} intents ouverts`} />
          <MetricCell
            label={accountHeadlineLabel}
            value={pnl ? formatCurrency(accountHeadlineValue) : "--"}
            meta={accountHeadlineMeta}
            tone={pnl && accountHeadlineValue >= 0 ? "cyan" : "rose"}
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
          meta={formatFeedMeta(polyFeed)}
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
          meta={formatFeedMeta(kalshiFeed)}
          labels={historyLabels}
          series={[
            {
              key: "kalshi-yes",
              label: "Kalshi YES",
              color: "#ffb84f",
              fill: "rgba(255,184,79,0.08)",
              values: historyPoints.map((point) => point.kalshiYesLast),
            },
            {
              key: "kalshi-no",
              label: "Kalshi NO",
              color: "#ff7a5c",
              fill: "rgba(255,122,92,0.08)",
              values: historyPoints.map((point) => point.kalshiNoLast),
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
        <Panel title="Positions Ouvertes" meta={`${displayPositions.length} lignes`}>
          {displayPositions.length === 0 ? (
            <EmptyState message="Aucune position live." />
          ) : (
            <div className="grid gap-3">
              {visiblePositions.map((position) => (
                <PositionRow key={position.id} position={position} />
              ))}
              {displayPositions.length > 2 ? (
                <ExpandButton
                  expanded={showAllPositions}
                  collapsedLabel={`Afficher ${displayPositions.length - 2} positions de plus`}
                  expandedLabel="Réduire la liste"
                  onClick={() => setShowAllPositions((value) => !value)}
                />
              ) : null}
            </div>
          )}
        </Panel>

        <Panel title="Exécutions Récentes" meta={`${recentFills.length} événements`}>
          {recentFills.length === 0 ? (
            <EmptyState message="Aucune exécution enregistrée." />
          ) : (
            <div className="grid gap-3">
              {visibleRecentFills.map((fill) => (
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
              {recentFills.length > 2 ? (
                <ExpandButton
                  expanded={showAllRecentFills}
                  collapsedLabel={`Afficher ${recentFills.length - 2} exécutions de plus`}
                  expandedLabel="Réduire la liste"
                  onClick={() => setShowAllRecentFills((value) => !value)}
                />
              ) : null}
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

function VenueBalanceCard({
  balance,
}: {
  balance: DashboardResponse["venueBalances"][number];
}) {
  const allowanceDisplay =
    balance.raw["allowanceUnlimited"] === true
      ? "Illimitée"
      : balance.allowanceUsd === null
        ? "--"
        : formatCurrency(balance.allowanceUsd);

  return (
    <section className="rounded-[32px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 sm:px-6">
      <div className="flex items-center justify-between gap-3 border-b border-white/6 pb-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.24em] text-mist/70">{balance.venue}</div>
          <div className="mt-1 text-sm text-white">{balance.currency}</div>
        </div>
        <StatusBadge tone={balance.status === "ready" ? "cyan" : balance.status === "degraded" ? "amber" : "rose"}>
          {balance.status}
        </StatusBadge>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <MetricCell label="Disponible" value={formatCurrency(balance.availableBalanceUsd)} compact />
        <MetricCell label="Portfolio" value={formatCurrency(balance.portfolioValueUsd)} compact />
        <MetricCell label="Allowance" value={allowanceDisplay} compact />
      </div>
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
              target {formatCurrency(leg.requestedNotionalUsd)} · req {formatPrice(leg.requestedSize, 2)} · filled {formatPrice(leg.filledSize, 2)} · fee {formatCurrency(leg.feeUsd)}
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
        <div className="flex items-center gap-2 text-white">
          {position.venue} · {position.outcome}
          {position.redeemable ? <StatusBadge tone="cyan">redeemable</StatusBadge> : null}
          {position.mergeable ? <StatusBadge tone="amber">mergeable</StatusBadge> : null}
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

function ExpandButton({
  expanded,
  collapsedLabel,
  expandedLabel,
  onClick,
}: {
  expanded: boolean;
  collapsedLabel: string;
  expandedLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-[18px] border border-white/8 bg-white/[0.03] px-4 py-3 text-left text-sm text-mist transition hover:border-white/12 hover:bg-white/[0.05] hover:text-white"
    >
      {expanded ? expandedLabel : collapsedLabel}
    </button>
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

function formatFeedMeta(feedHealth: VenueFeedHealth | null) {
  if (!feedHealth) {
    return "best ask live";
  }

  const freshness = feedHealth.stalenessMs === null ? "staleness n/a" : `${feedHealth.stalenessMs} ms`;
  const last = feedHealth.lastMessageAt ? ` · last ${formatClock(feedHealth.lastMessageAt)}` : "";
  return `best ask live · ${feedHealth.source} · ${freshness}${last}`;
}

function isDisplayablePosition(position: PositionSnapshot) {
  return isRiskActivePosition(position);
}
