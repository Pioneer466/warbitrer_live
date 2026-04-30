"use client";

import { useState } from "react";

import { TradingToggle } from "@/components/trading-toggle";
import { usePollingJson } from "@/components/use-polling-json";
import {
  Chip,
  formatV2Countdown,
  formatV2Usd,
  MetricCell,
  MiniLineChart,
  PageSection,
  SectionLabel,
  Surface,
  V2EmptyState,
  V2Expand,
  V2_TONE_TEXT,
  type V2Tone,
} from "@/components/v2-ui";
import { formatDateTime, formatPrice } from "@/lib/format";
import { isRiskActivePosition } from "@/lib/positions";
import type {
  DashboardResponse,
  HistoryResponse,
  LiveOpportunity,
  MarketAsset,
  OrderIntent,
  PositionSnapshot,
  VenueBalance,
  VenueFeedHealth,
} from "@/lib/types";

export function DashboardClient({ asset }: { asset: MarketAsset }) {
  const dashboard = usePollingJson<DashboardResponse>(`/api/dashboard/${asset}`, 1_000);
  const history = usePollingJson<HistoryResponse>(`/api/history/current-slot?asset=${asset}`, 1_000);
  const [showAllPositions, setShowAllPositions] = useState(false);

  if (dashboard.loading && !dashboard.data) {
    return <PanelMessage title="Chargement" message="Connexion au moteur live." />;
  }

  if (!dashboard.data) {
    return <PanelMessage title="Erreur" message={dashboard.error ?? "Aucune donnée live disponible."} tone="rose" />;
  }

  const { config, workerState, latestSnapshot, feedHealth, slot, venueBalances, opportunities, openIntents, positions, pnl, circuitBreakers, runEvents } = dashboard.data;
  const historyPoints = history.data?.points ?? [];
  const historyFeedHealth = history.data?.feedHealth ?? feedHealth;
  const polyFeed = historyFeedHealth.find((item) => item.venue === "polymarket") ?? latestSnapshot?.polymarket.feedHealth ?? null;
  const kalshiFeed = historyFeedHealth.find((item) => item.venue === "kalshi") ?? latestSnapshot?.kalshi.feedHealth ?? null;
  const activeBreakers = circuitBreakers.filter((breaker) => breaker.active);
  const displayPositions = positions.filter(isDisplayablePosition);
  const visiblePositions = showAllPositions ? displayPositions : displayPositions.slice(0, 3);
  const mode = !config.enableTrading ? "off" : config.shadowMode ? "shadow" : "live";
  const modeTone: V2Tone = mode === "live" ? "gold" : mode === "shadow" ? "indigo" : "amber";
  const accountDeltaUsd = pnl?.accountDeltaUsd ?? (pnl ? pnl.realizedPnlUsd + pnl.unrealizedPnlUsd : null);

  return (
    <div className="flex flex-col gap-7">
      <PageSection watermark={asset.toUpperCase()}>
        <Surface glow>
          <div className="flex flex-col gap-4 border-b border-[var(--wa-gold-border)] px-5 py-4 lg:flex-row lg:items-center lg:justify-between sm:px-6">
            <div>
              <div className="mb-1 text-[9px] uppercase tracking-[0.26em] text-[rgba(201,168,100,0.45)]">Créneau live</div>
              <div className="font-mono text-sm text-[var(--wa-ivory)]">{slot.label}</div>
              <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-[var(--wa-dim)]">
                phase {workerState.phase} · readiness {workerState.readinessStatus}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <TradingToggle asset={slot.asset} />
              <div className="font-mono text-[42px] leading-none text-[var(--wa-ivory)]">{formatV2Countdown(slot.secondsRemaining)}</div>
              <Chip tone={modeTone}>{mode}</Chip>
            </div>
          </div>
          <div className="grid md:grid-cols-2 xl:grid-cols-4">
            <MetricCell label="Equity" value={formatV2Usd(pnl?.equityUsd, true)} tone="gold" />
            <MetricCell label="Cash" value={formatV2Usd(pnl?.cashUsd, true)} tone="gold" />
            <MetricCell label="Positions" value={String(displayPositions.length)} meta={`${openIntents.length} intents`} />
            <MetricCell
              label={accountDeltaUsd !== null && accountDeltaUsd < 0 ? "Drawdown" : "Delta Compte"}
              value={formatSignedUsd(accountDeltaUsd)}
              tone={accountDeltaUsd !== null && accountDeltaUsd >= 0 ? "emerald" : "rose"}
              meta={pnl ? `Strat ${formatSignedUsd(pnl.strategyPnlUsd)} · Frais ${formatV2Usd(pnl.feesUsd)}` : undefined}
            />
          </div>
          <div className="flex flex-wrap gap-2 border-t border-[var(--wa-gold-border)] px-5 py-3 sm:px-6">
            <Chip tone={workerState.readinessStatus === "ready" ? "emerald" : "rose"}>{workerState.readinessStatus}</Chip>
            {activeBreakers.map((breaker) => <Chip key={breaker.key} tone="rose">{breaker.key}</Chip>)}
          </div>
        </Surface>
      </PageSection>

      <section>
        <SectionLabel right={`poly ${formatFeedMeta(polyFeed)} · kalshi ${formatFeedMeta(kalshiFeed)}`}>Flux de Prix</SectionLabel>
        <div className="grid gap-3 xl:grid-cols-2">
          <Surface>
            <ChartHeader
              title="Polymarket — UP / DOWN"
              feed={polyFeed}
              legend={[
                { label: "UP", color: "#2563eb" },
                { label: "DOWN", color: "#93c5fd" },
              ]}
            />
            <MiniLineChart
              height={100}
              series={[
                { key: "poly-up", color: "#2563eb", values: historyPoints.map((point) => point.polyUpBuy) },
                { key: "poly-down", color: "#93c5fd", values: historyPoints.map((point) => point.polyDownBuy) },
              ]}
            />
          </Surface>
          <Surface>
            <ChartHeader
              title="Kalshi — UP / DOWN"
              feed={kalshiFeed}
              legend={[
                { label: "UP = NO", color: "var(--wa-rose)" },
                { label: "DOWN = YES", color: "var(--wa-gold)" },
              ]}
            />
            <MiniLineChart
              height={100}
              series={[
                { key: "kalshi-yes", color: "var(--wa-gold)", values: historyPoints.map((point) => point.kalshiYesLast) },
                { key: "kalshi-no", color: "var(--wa-rose)", values: historyPoints.map((point) => point.kalshiNoLast) },
              ]}
            />
          </Surface>
        </div>
      </section>

      <section>
        <SectionLabel right={`seuil ≤ ${formatPrice(config.grossEntryThreshold, 3)} · budget ${formatV2Usd(config.maxPairNotionalUsd)}`}>Opportunités</SectionLabel>
        {opportunities.length === 0 ? (
          <Surface><V2EmptyState message="Aucune opportunité calculée pour ce créneau" /></Surface>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {opportunities.map((opportunity) => <OpportunityCard key={opportunity.id} opportunity={opportunity} />)}
          </div>
        )}
      </section>

      <section>
        <SectionLabel right={`${openIntents.length} actifs`}>Intents Ouverts</SectionLabel>
        <Surface>
          {openIntents.length === 0 ? (
            <V2EmptyState message="Aucun intent live ouvert" />
          ) : (
            openIntents.map((intent, index) => <IntentRow key={intent.id} intent={intent} last={index === openIntents.length - 1} />)
          )}
        </Surface>
      </section>

      <section>
        <SectionLabel right={`${displayPositions.length} lignes`}>Positions Ouvertes</SectionLabel>
        <Surface>
          {displayPositions.length === 0 ? (
            <V2EmptyState message="Aucune position" />
          ) : (
            <>
              {visiblePositions.map((position, index) => (
                <PositionRow key={position.id} position={position} last={index === visiblePositions.length - 1 && displayPositions.length <= 3} />
              ))}
              {displayPositions.length > 3 ? (
                <div className="border-t border-[var(--wa-gold-border)] px-5 py-3">
                  <V2Expand expanded={showAllPositions} n={displayPositions.length - 3} onClick={() => setShowAllPositions((value) => !value)} />
                </div>
              ) : null}
            </>
          )}
        </Surface>
      </section>

      <section className="grid gap-3 xl:grid-cols-2">
        <div>
          <SectionLabel right={workerState.readinessStatus}>Readiness</SectionLabel>
          <Surface>
            {workerState.readiness.map((check, index) => (
              <div key={check.key} className={`px-5 py-3 ${index < workerState.readiness.length - 1 ? "border-b border-[var(--wa-gold-border)]" : ""}`}>
                <div className="mb-1 flex items-center justify-between gap-3">
                  <span className="text-sm text-[var(--wa-ivory)]">{check.label}</span>
                  <Chip tone={check.status === "ready" ? "emerald" : check.status === "blocked" ? "rose" : "amber"}>{check.status}</Chip>
                </div>
                <div className="text-[11px] text-[var(--wa-mist)]">{check.details}</div>
              </div>
            ))}
          </Surface>
        </div>
        <div>
          <SectionLabel right={`${activeBreakers.length} breakers · ${runEvents.length} events`}>Logs</SectionLabel>
          <Surface>
            {activeBreakers.map((breaker) => (
              <div key={breaker.key} className="border-b border-[rgba(232,80,106,0.18)] bg-[rgba(232,80,106,0.06)] px-5 py-3 text-xs text-[var(--wa-rose)]">
                {breaker.key} — {breaker.reason}
              </div>
            ))}
            {runEvents.slice(0, 6).map((event, index) => (
              <div key={`${event.id}-${event.createdAt}`} className={`px-5 py-3 ${index < Math.min(runEvents.length - 1, 5) ? "border-b border-[var(--wa-gold-border)]" : ""}`}>
                <div className="mb-1 flex items-center justify-between gap-3">
                  <span className="font-mono text-[11px] text-[var(--wa-ivory)]">{event.eventType}</span>
                  <span className="font-mono text-[9px] text-[var(--wa-dim)]">{formatDateTime(event.createdAt)}</span>
                </div>
                <div className="text-[11px] text-[var(--wa-mist)]">{event.message}</div>
              </div>
            ))}
          </Surface>
        </div>
      </section>

      <section>
        <SectionLabel right="liquidités venues">Balances</SectionLabel>
        <div className="grid gap-px overflow-hidden rounded-lg border border-[var(--wa-gold-border)] bg-[var(--wa-gold-border)] xl:grid-cols-2">
          {venueBalances.map((balance) => <VenueBalanceRow key={balance.venue} balance={balance} />)}
        </div>
      </section>

      {dashboard.error ? <PanelMessage title="Erreur" message={dashboard.error} tone="rose" /> : null}
      {history.error ? <PanelMessage title="Erreur" message={history.error} tone="rose" /> : null}
    </div>
  );
}

function OpportunityCard({ opportunity }: { opportunity: LiveOpportunity }) {
  return (
    <Surface>
      <div className="border-b border-[var(--wa-gold-border)] px-5 py-4">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div className="font-mono text-sm text-[var(--wa-ivory)]">{opportunity.label}</div>
          <Chip tone={opportunity.eligible ? "emerald" : "amber"}>{opportunity.eligible ? "eligible" : "watch"}</Chip>
        </div>
        <div className="text-[11px] text-[var(--wa-mist)]">
          primaire <span className="text-[var(--wa-ivory)]">{opportunity.primaryVenue ?? "--"}</span> · coût brut{" "}
          <span className={opportunity.eligible ? V2_TONE_TEXT.emerald : V2_TONE_TEXT.mist}>{opportunity.grossCost === null ? "--" : opportunity.grossCost.toFixed(3)}</span>
        </div>
      </div>
      {opportunity.legs.map((leg) => (
        <div key={`${leg.venue}-${leg.outcome}`} className="grid grid-cols-[1fr_auto] gap-3 border-b border-[var(--wa-gold-border)] px-5 py-3">
          <div>
            <div className="mb-1 font-mono text-[11px] text-[var(--wa-ivory)]">{leg.venue} · {leg.outcome}</div>
            <div className="text-[10px] text-[var(--wa-mist)]">{formatV2Usd(leg.targetNotionalUsd)} · fee {formatV2Usd(leg.feeEstimateUsd)}</div>
          </div>
          <div className="font-mono text-xl text-[var(--wa-gold)]">{formatPrice(leg.price, 4)}</div>
        </div>
      ))}
      <div className="grid grid-cols-2 gap-px bg-[var(--wa-gold-border)] text-[10px] sm:grid-cols-4">
        <ProxyMetric label="mismatch" value={opportunity.mismatchRisk ?? "n/a"} tone={getMismatchRiskTone(opportunity.mismatchRisk)} />
        <ProxyMetric label="action" value={formatMismatchAction(opportunity)} />
        <ProxyMetric label="désaccord" value={formatNullablePct(opportunity.venueDisagreementPct)} />
        <ProxyMetric label="zone" value={formatNullableBps(opportunity.deadZoneDistanceBps)} />
      </div>
      {opportunity.reasons.length > 0 ? (
        <div className="px-5 py-3 text-[11px] text-[var(--wa-amber)]">{opportunity.reasons.join(" · ")}</div>
      ) : null}
    </Surface>
  );
}

function IntentRow({ intent, last }: { intent: OrderIntent; last: boolean }) {
  return (
    <div className={`px-5 py-4 text-sm ${last ? "" : "border-b border-[var(--wa-gold-border)]"}`}>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="font-mono text-[var(--wa-ivory)]">{intent.asset.toUpperCase()} · {intent.combination}</div>
        <Chip tone={getIntentTone(intent)}>{intent.status}</Chip>
      </div>
      <div className="mb-3 text-[11px] text-[var(--wa-mist)]">
        {intent.primaryVenue} → {intent.hedgeVenue} · {formatDateTime(intent.createdAt)}
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {intent.legs.map((leg) => (
          <div key={leg.id} className="rounded border border-[var(--wa-gold-border)] bg-[var(--wa-bg0)] px-3 py-2">
            <div className="mb-1 font-mono text-[11px] text-[var(--wa-ivory)]">{leg.venue} · {leg.outcome}</div>
            <div className="text-[10px] text-[var(--wa-mist)]">
              {leg.filledSize > 0 && leg.filledPrice !== null
                ? `investi ${formatV2Usd(deriveLegCapitalUsd(leg))} · req ${formatPrice(leg.requestedSize, 2)} · filled ${formatPrice(leg.filledSize, 2)} · fee ${formatV2Usd(leg.feeUsd)}`
                : `notionnel ${formatV2Usd(leg.requestedNotionalUsd)} · req ${formatPrice(leg.requestedSize, 2)} · filled ${formatPrice(leg.filledSize, 2)} · fee ${formatV2Usd(leg.feeUsd)}`}
            </div>
          </div>
        ))}
      </div>
      {intent.entrySizingReason ? <div className="mt-2 rounded border border-[rgba(245,184,74,0.18)] bg-[rgba(245,184,74,0.06)] px-3 py-2 text-[10px] text-[var(--wa-amber)]">{intent.entrySizingReason}</div> : null}
      {intent.failureReason ? <div className="mt-2 rounded border border-[rgba(232,80,106,0.18)] bg-[rgba(232,80,106,0.06)] px-3 py-2 text-[10px] text-[var(--wa-rose)]">{intent.failureReason}</div> : null}
    </div>
  );
}

function PositionRow({ position, last }: { position: PositionSnapshot; last: boolean }) {
  return (
    <div className={`grid gap-3 px-5 py-3 text-sm md:grid-cols-[1fr_auto] ${last ? "" : "border-b border-[var(--wa-gold-border)]"}`}>
      <div>
        <div className="mb-1 text-[var(--wa-ivory)]">{position.venue} · {position.outcome}</div>
        <div className="text-[11px] text-[var(--wa-mist)]">size {formatPrice(position.size, 2)} · avg {formatPrice(position.averagePrice, 4)} · unrealized {formatV2Usd(position.unrealizedPnlUsd)}</div>
      </div>
      <div className="font-mono text-[var(--wa-gold)]">{formatV2Usd(position.currentValueUsd)}</div>
    </div>
  );
}

function VenueBalanceRow({ balance }: { balance: VenueBalance }) {
  const allowance = balance.raw["allowanceUnlimited"] === true ? "Illimitée" : balance.allowanceUsd === null ? "--" : formatV2Usd(balance.allowanceUsd);
  return (
    <div className="bg-[var(--wa-bg1)] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[9px] uppercase tracking-[0.22em] text-[rgba(201,168,100,0.5)]">{balance.venue}</div>
          <div className="mt-1 text-sm text-[var(--wa-ivory)]">{balance.currency}</div>
        </div>
        <Chip tone={balance.status === "ready" ? "emerald" : balance.status === "degraded" ? "amber" : "rose"}>{balance.status}</Chip>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <BalanceMetric label="Disponible" value={formatV2Usd(balance.availableBalanceUsd)} tone="gold" />
        <BalanceMetric label="Portfolio" value={formatV2Usd(balance.portfolioValueUsd)} />
        <BalanceMetric label="Allowance" value={allowance} />
      </div>
    </div>
  );
}

function ChartHeader({
  title,
  feed,
  legend = [],
}: {
  title: string;
  feed: VenueFeedHealth | null;
  legend?: Array<{ label: string; color: string }>;
}) {
  return (
    <div className="flex flex-col gap-3 px-5 pb-2 pt-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[9px] uppercase tracking-[0.22em] text-[rgba(201,168,100,0.45)]">{title}</span>
        {legend.length > 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            {legend.map((item) => (
              <span key={item.label} className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--wa-mist)]">
                <span className="h-2 w-5 rounded-full" style={{ backgroundColor: item.color }} />
                {item.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="shrink-0">
        <Chip tone={feed?.feedStatus === "ready" ? "emerald" : "rose"}>{feed?.source ?? "--"}</Chip>
      </div>
    </div>
  );
}

function ProxyMetric({ label, value, tone = "mist" }: { label: string; value: string; tone?: V2Tone }) {
  return (
    <div className="bg-[var(--wa-bg0)] px-3 py-3">
      <div className="mb-1 text-[8px] uppercase tracking-[0.16em] text-[var(--wa-dim)]">{label}</div>
      <div className={`font-mono text-xs ${V2_TONE_TEXT[tone]}`}>{value}</div>
    </div>
  );
}

function BalanceMetric({ label, value, tone = "mist" }: { label: string; value: string; tone?: V2Tone }) {
  return (
    <div>
      <div className="mb-1 text-[8px] uppercase tracking-[0.16em] text-[var(--wa-dim)]">{label}</div>
      <div className={`font-mono text-xs ${V2_TONE_TEXT[tone]}`}>{value}</div>
    </div>
  );
}

function PanelMessage({ title, message, tone = "default" }: { title: string; message: string; tone?: "default" | "rose" }) {
  return (
    <Surface className={tone === "rose" ? "border-[rgba(232,80,106,0.28)]" : ""}>
      <div className={tone === "rose" ? "px-5 py-6 text-sm text-[var(--wa-rose)]" : "px-5 py-6 text-sm text-[var(--wa-mist)]"}>
        <div className="text-[var(--wa-ivory)]">{title}</div>
        <div className="mt-2">{message}</div>
      </div>
    </Surface>
  );
}

function isDisplayablePosition(position: PositionSnapshot) {
  return isRiskActivePosition(position) || position.redeemable || position.mergeable || Math.abs(position.currentValueUsd) > 0.01;
}

function formatFeedMeta(feed: VenueFeedHealth | null) {
  if (!feed) {
    return "--";
  }
  return `${feed.stalenessMs ?? "--"}ms`;
}

function formatMismatchAction(opportunity: LiveOpportunity) {
  if (opportunity.mismatchGuardAction === "reduce_size") {
    return `x${opportunity.mismatchSizeMultiplier.toFixed(2)}`;
  }
  return opportunity.mismatchGuardAction;
}

function formatNullablePct(value: number | null) {
  return value === null ? "--" : `${(value * 100).toFixed(2)}%`;
}

function formatNullableBps(value: number | null) {
  return value === null ? "--" : `${value.toFixed(1)} bps`;
}

function getMismatchRiskTone(risk: LiveOpportunity["mismatchRisk"]): V2Tone {
  return risk === "high" ? "rose" : risk === "medium" ? "amber" : risk === "low" ? "emerald" : "mist";
}

function getIntentTone(intent: OrderIntent): V2Tone {
  if (intent.status === "hedged" || intent.status === "settled") {
    return "emerald";
  }
  if (intent.status === "failed" || intent.status === "unwind_required" || intent.status === "unwound" || intent.status === "canceled") {
    return "rose";
  }
  if (intent.status === "skipped") {
    return "indigo";
  }
  return "amber";
}

function deriveLegCapitalUsd(leg: OrderIntent["legs"][number]) {
  const tradedNotional = leg.filledSize > 0 && leg.filledPrice !== null ? leg.filledSize * leg.filledPrice : leg.requestedNotionalUsd;
  return Math.round((tradedNotional + leg.feeUsd) * 10_000) / 10_000;
}

function formatSignedUsd(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${formatV2Usd(Math.abs(value))}`;
}
