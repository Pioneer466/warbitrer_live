"use client";

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
  V2_TONE_TEXT,
  type V2Tone,
} from "@/components/v2-ui";
import { formatDateTime, formatPrice } from "@/lib/format";
import { resolveMismatchGuardMode } from "@/lib/mismatch-guard-mode";
import {
  formatMismatchAuditDecision,
  formatRiskProbability,
  getMismatchModelDisplayState,
} from "@/lib/mismatch-risk-display";
import type {
  DashboardResponse,
  HistoryResponse,
  LiveOpportunity,
  MarketAsset,
  MarketSlot,
  MismatchGuardMode,
  MismatchRiskCounterfactualDecision,
  OrderIntent,
  VenueFeedHealth,
} from "@/lib/types";

export function DashboardClient({ asset }: { asset: MarketAsset }) {
  const dashboard = usePollingJson<DashboardResponse>(`/api/dashboard/${asset}`, 2_000);
  const history = usePollingJson<HistoryResponse>(`/api/history/current-slot?asset=${asset}`, 2_000);

  if (dashboard.loading && !dashboard.data) {
    return <PanelMessage title="Chargement" message="Connexion au moteur live." />;
  }

  if (!dashboard.data) {
    return <PanelMessage title="Erreur" message={dashboard.error ?? "Aucune donnée live disponible."} tone="rose" />;
  }

  const {
    config,
    workerState,
    latestSnapshot,
    feedHealth,
    slot,
    opportunities,
    openIntents,
    circuitBreakers,
    runEvents,
  } = dashboard.data;
  const historyPoints = history.data?.points ?? [];
  const historyFeedHealth = history.data?.feedHealth ?? feedHealth;
  const polyFeed =
    historyFeedHealth.find((item) => item.venue === "polymarket") ?? latestSnapshot?.polymarket.feedHealth ?? null;
  const kalshiFeed =
    historyFeedHealth.find((item) => item.venue === "kalshi") ?? latestSnapshot?.kalshi.feedHealth ?? null;
  const activeBreakers = circuitBreakers.filter((breaker) => breaker.active);
  const openIntentNotionalUsd = openIntents.reduce((sum, intent) => sum + deriveIntentCapitalUsd(intent), 0);
  const readyFeedCount = [polyFeed, kalshiFeed].filter((feed) => feed?.feedStatus === "ready").length;
  const eligibleCount = opportunities.filter((opportunity) => opportunity.eligible).length;
  const bestGrossCost = opportunities.reduce<number | null>(
    (best, opportunity) =>
      opportunity.grossCost === null
        ? best
        : best === null
          ? opportunity.grossCost
          : Math.min(best, opportunity.grossCost),
    null,
  );
  const operationalChecks = workerState.readiness.filter((check) => check.status !== "ready");
  const operationalEvents = runEvents.filter((event) => event.level !== "info").slice(0, 4);
  const guardMode = resolveMismatchGuardMode(config);
  const tradingMode = !config.enableTrading ? "off" : config.shadowMode ? "shadow" : "live";

  return (
    <div className="flex flex-col gap-7">
      <PageSection watermark={asset.toUpperCase()}>
        <Surface glow>
          <div className="flex flex-col gap-4 border-b border-[var(--wa-gold-border)] px-5 py-4 lg:flex-row lg:items-center lg:justify-between sm:px-6">
            <div>
              <div className="mb-1 text-[9px] uppercase tracking-[0.26em] text-[rgba(201,168,100,0.45)]">
                Créneau live
              </div>
              <div className="font-mono text-sm text-[var(--wa-ivory)]">{slot.label}</div>
              <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-[var(--wa-dim)]">
                phase {workerState.phase} · readiness {workerState.readinessStatus}
              </div>
            </div>
            <SlotModeBar slot={slot} />
          </div>
          <div className="grid md:grid-cols-2 xl:grid-cols-4">
            <MetricCell
              label="Moteur"
              value={workerState.readinessStatus}
              tone={workerState.readinessStatus === "ready" ? "emerald" : "rose"}
              meta={`phase ${workerState.phase}`}
            />
            <MetricCell
              label="Flux"
              value={`${readyFeedCount}/2 prêts`}
              tone={readyFeedCount === 2 ? "emerald" : "rose"}
              meta={`Poly ${formatFeedMeta(polyFeed)} · Kalshi ${formatFeedMeta(kalshiFeed)}`}
            />
            <MetricCell
              label="Scan"
              value={`${eligibleCount}/${opportunities.length || 2} passent`}
              tone={eligibleCount > 0 ? "emerald" : "mist"}
              meta={`Meilleur brut ${bestGrossCost === null ? "--" : bestGrossCost.toFixed(3)}`}
            />
            <MetricCell
              label="Intents"
              value={openIntents.length > 0 ? String(openIntents.length) : "aucun"}
              tone={openIntents.length > 0 ? "amber" : "mist"}
              meta={`Notionnel ${formatV2Usd(openIntentNotionalUsd)}`}
            />
          </div>
          <div className="flex flex-wrap gap-2 border-t border-[var(--wa-gold-border)] px-5 py-3 sm:px-6">
            <Chip tone={workerState.readinessStatus === "ready" ? "emerald" : "rose"}>
              {workerState.readinessStatus}
            </Chip>
            <Chip
              tone={
                config.mismatchRiskMode === "enforce"
                  ? "rose"
                  : config.mismatchRiskMode === "block_only"
                    ? "amber"
                    : "indigo"
              }
            >
              risk {config.mismatchRiskMode}
            </Chip>
            <Chip tone={guardMode === "audit" ? "indigo" : guardMode === "hard_only" ? "emerald" : "amber"}>
              guard {formatGuardMode(guardMode)}
            </Chip>
            <Chip tone={tradingMode === "live" ? "rose" : tradingMode === "shadow" ? "indigo" : "mist"}>
              {tradingMode}
            </Chip>
            {activeBreakers.map((breaker) => (
              <Chip key={breaker.key} tone="rose">
                {breaker.key}
              </Chip>
            ))}
          </div>
        </Surface>
      </PageSection>

      <section>
        <SectionLabel right={`poly ${formatFeedMeta(polyFeed)} · kalshi ${formatFeedMeta(kalshiFeed)}`}>
          Flux de Prix
        </SectionLabel>
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
              height={132}
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
                { label: "UP", color: "var(--wa-rose)" },
                { label: "DOWN", color: "var(--wa-amber)" },
              ]}
            />
            <MiniLineChart
              height={132}
              series={[
                {
                  key: "kalshi-up",
                  color: "var(--wa-rose)",
                  values: historyPoints.map((point) => point.kalshiYesLast),
                },
                {
                  key: "kalshi-down",
                  color: "var(--wa-amber)",
                  values: historyPoints.map((point) => point.kalshiNoLast),
                },
              ]}
            />
          </Surface>
        </div>
      </section>

      <section>
        <SectionLabel
          right={`seuil ≤ ${formatPrice(config.grossEntryThreshold, 3)} · budget ${formatV2Usd(config.maxPairNotionalUsd)}`}
        >
          Opportunités
        </SectionLabel>
        {opportunities.length === 0 ? (
          <Surface>
            <V2EmptyState message="Aucune opportunité calculée pour ce créneau" />
          </Surface>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {opportunities.map((opportunity) => (
              <OpportunityCard key={opportunity.id} opportunity={opportunity} />
            ))}
          </div>
        )}
      </section>

      {openIntents.length > 0 ? (
        <section>
          <SectionLabel right={`${openIntents.length} actifs · ${formatV2Usd(openIntentNotionalUsd)}`}>
            Intents Ouverts
          </SectionLabel>
          <Surface>
            {openIntents.map((intent, index) => (
              <IntentRow key={intent.id} intent={intent} last={index === openIntents.length - 1} />
            ))}
          </Surface>
        </section>
      ) : null}

      {activeBreakers.length > 0 || operationalChecks.length > 0 || operationalEvents.length > 0 ? (
        <section>
          <SectionLabel
            right={`${activeBreakers.length} breakers · ${operationalChecks.length} checks · ${operationalEvents.length} events`}
          >
            Alertes Opérationnelles
          </SectionLabel>
          <Surface>
            {activeBreakers.map((breaker) => (
              <div
                key={breaker.key}
                className="border-b border-[rgba(232,80,106,0.18)] bg-[rgba(232,80,106,0.06)] px-5 py-3 text-xs text-[var(--wa-rose)]"
              >
                {breaker.key} — {breaker.reason}
              </div>
            ))}
            {operationalChecks.map((check) => (
              <div key={check.key} className="border-b border-[var(--wa-gold-border)] px-5 py-3">
                <div className="mb-1 flex items-center justify-between gap-3">
                  <span className="text-sm text-[var(--wa-ivory)]">{check.label}</span>
                  <Chip tone={check.status === "blocked" ? "rose" : "amber"}>{check.status}</Chip>
                </div>
                <div className="text-[11px] text-[var(--wa-mist)]">{check.details}</div>
              </div>
            ))}
            {operationalEvents.map((event) => (
              <div
                key={`${event.id}-${event.createdAt}`}
                className="border-b border-[var(--wa-gold-border)] px-5 py-3 last:border-b-0"
              >
                <div className="mb-1 flex items-center justify-between gap-3">
                  <span className="font-mono text-[11px] text-[var(--wa-ivory)]">{event.eventType}</span>
                  <span className="font-mono text-[9px] text-[var(--wa-dim)]">{formatDateTime(event.createdAt)}</span>
                </div>
                <div className="text-[11px] text-[var(--wa-mist)]">{event.message}</div>
              </div>
            ))}
          </Surface>
        </section>
      ) : null}

      {dashboard.error ? <PanelMessage title="Erreur" message={dashboard.error} tone="rose" /> : null}
      {history.error ? <PanelMessage title="Erreur" message={history.error} tone="rose" /> : null}
    </div>
  );
}

function OpportunityCard({ opportunity }: { opportunity: LiveOpportunity }) {
  const estimate = opportunity.mismatchRiskEstimate ?? null;
  const audit = opportunity.mismatchRiskAudit ?? null;
  const modelState = getMismatchModelDisplayState(estimate);
  const pFatalUpper95 = audit?.pFatalUpper95 ?? estimate?.pFatalUpper95 ?? null;
  const maximumAllowed = audit?.maximumAllowedFatalProbability ?? estimate?.maximumAllowedFatalProbability ?? null;

  return (
    <Surface>
      <div className="border-b border-[var(--wa-gold-border)] px-5 py-4">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div className="font-mono text-sm text-[var(--wa-ivory)]">{opportunity.label}</div>
          <Chip tone={opportunity.eligible ? "emerald" : "amber"}>{opportunity.eligible ? "eligible" : "bloquée"}</Chip>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-[var(--wa-mist)]">
          <Chip tone={modelState === "calibrated" ? "emerald" : modelState === "uncalibrated" ? "amber" : "mist"}>
            modèle {modelState}
          </Chip>
          <Chip tone={!estimate ? "mist" : estimate.executionUsable === false ? "amber" : "emerald"}>
            {!estimate
              ? "références --"
              : estimate.executionUsable === false
                ? "références non exécutables"
                : "références fraîches"}
          </Chip>
          <Chip tone={getMismatchActionTone(opportunity)}>{formatMismatchAction(opportunity)}</Chip>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-px bg-[var(--wa-gold-border)] text-[10px] sm:grid-cols-4">
        <ProxyMetric
          label="coût brut / seuil"
          value={`${opportunity.grossCost === null ? "--" : opportunity.grossCost.toFixed(3)} / ${opportunity.threshold.toFixed(3)}`}
          tone={opportunity.thresholdMet ? "emerald" : "amber"}
        />
        <ProxyMetric
          label="P&L net projeté"
          value={formatSignedUsd(opportunity.projectedNetProfitUsd)}
          tone={
            opportunity.projectedNetProfitUsd !== null && opportunity.projectedNetProfitUsd >= 0 ? "emerald" : "rose"
          }
        />
        <ProxyMetric
          label="P fatal 95%"
          value={formatRiskProbability(pFatalUpper95)}
          tone={riskLimitTone(pFatalUpper95, maximumAllowed)}
        />
        <ProxyMetric label="limite modèle" value={formatRiskProbability(maximumAllowed)} />
      </div>
      <div className="grid gap-px bg-[var(--wa-gold-border)] sm:grid-cols-2">
        {opportunity.legs.map((leg) => (
          <div key={`${leg.venue}-${leg.outcome}`} className="bg-[var(--wa-bg0)] px-5 py-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="font-mono text-[11px] text-[var(--wa-ivory)]">
                {leg.venue} · {leg.outcome}
              </div>
              <div className="font-mono text-lg text-[var(--wa-gold)]">{formatPrice(leg.price, 4)}</div>
            </div>
            <div className="text-[10px] text-[var(--wa-mist)]">
              taille {formatPrice(leg.size, 2)} · profondeur {formatPrice(leg.depth, 2)} · coût{" "}
              {formatV2Usd(leg.targetNotionalUsd)}
            </div>
          </div>
        ))}
      </div>
      <MismatchPolicySummary opportunity={opportunity} />
      {opportunity.reasons.length > 0 ? (
        <div className="border-t border-[var(--wa-gold-border)] px-5 py-3">
          <div className="mb-1 text-[8px] uppercase tracking-[0.16em] text-[var(--wa-dim)]">Pourquoi ça bloque</div>
          <div className="text-[11px] leading-5 text-[var(--wa-amber)]">{opportunity.reasons.join(" · ")}</div>
        </div>
      ) : null}
    </Surface>
  );
}

function MismatchPolicySummary({ opportunity }: { opportunity: LiveOpportunity }) {
  const comparisons = opportunity.mismatchRiskAudit?.policyComparisons;
  const guardAudit = opportunity.mismatchGuardAudit;
  if (!comparisons && !guardAudit) {
    return null;
  }

  return (
    <div className="grid grid-cols-2 gap-px border-t border-[var(--wa-gold-border)] bg-[var(--wa-gold-border)] text-[10px] sm:grid-cols-4">
      <ProxyMetric
        label="modèle calibré"
        value={comparisons ? formatPolicyShort(comparisons.calibratedModel) : "--"}
        tone={comparisons ? policyTone(comparisons.calibratedModel) : "mist"}
      />
      <ProxyMetric
        label="modèle + hard"
        value={comparisons ? formatPolicyShort(comparisons.calibratedModelPlusHardInvariants) : "--"}
        tone={comparisons ? policyTone(comparisons.calibratedModelPlusHardInvariants) : "mist"}
      />
      <ProxyMetric
        label="legacy"
        value={comparisons ? formatLegacyPolicyShort(comparisons.legacyGuard) : "--"}
        tone={
          comparisons?.legacyGuard === "would_block"
            ? "rose"
            : comparisons?.legacyGuard === "would_reduce_size"
              ? "amber"
              : "emerald"
        }
      />
      <ProxyMetric
        label="signal structurel"
        value={`${opportunity.mismatchRisk ?? "n/a"} · ${formatNullablePct(opportunity.venueDisagreementPct)} · ${formatNullableBps(opportunity.deadZoneDistanceBps)}`}
        tone={getMismatchRiskTone(opportunity.mismatchRisk)}
      />
    </div>
  );
}

function SlotModeBar({ slot }: { slot: MarketSlot }) {
  const totalSeconds = Math.max(1, Math.floor((slot.endTs - slot.startTs) / 1000));
  const remainingRatio = Math.max(0, Math.min(1, slot.secondsRemaining / totalSeconds));
  const elapsedRatio = 1 - remainingRatio;

  return (
    <div className="flex flex-col gap-3 lg:items-end">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-3">
          <div className="font-mono text-[42px] leading-none text-[var(--wa-ivory)]">
            {formatV2Countdown(slot.secondsRemaining)}
          </div>
          <div className="hidden min-w-[132px] sm:block">
            <div className="mb-1 h-0.5 overflow-hidden rounded-full bg-[rgba(201,168,100,0.16)]">
              <div
                className="h-full rounded-full bg-[linear-gradient(90deg,var(--wa-gold),var(--wa-amber),var(--wa-rose))] transition-all"
                style={{
                  width: `${Math.max(4, elapsedRatio * 100)}%`,
                }}
              />
            </div>
            <div className="text-[9px] uppercase tracking-[0.18em] text-[var(--wa-dim)]">fin du créneau</div>
          </div>
        </div>
        <TradingToggle asset={slot.asset} />
      </div>
    </div>
  );
}

function IntentRow({ intent, last }: { intent: OrderIntent; last: boolean }) {
  const audit = intent.mismatchRiskAudit ?? null;
  return (
    <div className={`px-5 py-4 text-sm ${last ? "" : "border-b border-[var(--wa-gold-border)]"}`}>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="font-mono text-[var(--wa-ivory)]">
          {intent.asset.toUpperCase()} · {intent.combination}
        </div>
        <Chip tone={getIntentTone(intent)}>{intent.status}</Chip>
      </div>
      <div className="mb-3 text-[11px] text-[var(--wa-mist)]">
        {intent.primaryVenue} → {intent.hedgeVenue} · {formatDateTime(intent.createdAt)}
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {intent.legs.map((leg) => (
          <div key={leg.id} className="rounded border border-[var(--wa-gold-border)] bg-[var(--wa-bg0)] px-3 py-2">
            <div className="mb-1 font-mono text-[11px] text-[var(--wa-ivory)]">
              {leg.venue} · {leg.outcome}
            </div>
            <div className="text-[10px] text-[var(--wa-mist)]">
              {leg.filledSize > 0 && leg.filledPrice !== null
                ? `investi ${formatV2Usd(deriveLegCapitalUsd(leg))} · req ${formatPrice(leg.requestedSize, 2)} · filled ${formatPrice(leg.filledSize, 2)} · fee ${formatV2Usd(leg.feeUsd)}${deriveLegCashAdjustmentUsd(leg) > 0 ? ` · adj ${formatV2Usd(deriveLegCashAdjustmentUsd(leg))}` : ""}${formatLegRiskReservations(leg)}`
                : `notionnel ${formatV2Usd(leg.requestedNotionalUsd)} · req ${formatPrice(leg.requestedSize, 2)} · filled ${formatPrice(leg.filledSize, 2)} · fee ${formatV2Usd(leg.feeUsd)}${formatLegRiskReservations(leg)}`}
            </div>
          </div>
        ))}
      </div>
      {audit ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 rounded border border-[var(--wa-gold-border)] bg-[var(--wa-bg0)] px-3 py-2 font-mono text-[10px] text-[var(--wa-mist)]">
          <span>audit {formatMismatchAuditDecision(audit.decision)}</span>
          <span>P95 {formatRiskProbability(audit.pFatalUpper95)}</span>
          <span>limite {formatRiskProbability(audit.maximumAllowedFatalProbability)}</span>
          <span>P&L conservateur {formatSignedUsd(audit.conservativePnlUsd)}</span>
        </div>
      ) : null}
      {intent.entrySizingReason ? (
        <div className="mt-2 rounded border border-[rgba(245,184,74,0.18)] bg-[rgba(245,184,74,0.06)] px-3 py-2 text-[10px] text-[var(--wa-amber)]">
          {intent.entrySizingReason}
        </div>
      ) : null}
      {intent.failureReason ? (
        <div className="mt-2 rounded border border-[rgba(232,80,106,0.18)] bg-[rgba(232,80,106,0.06)] px-3 py-2 text-[10px] text-[var(--wa-rose)]">
          {intent.failureReason}
        </div>
      ) : null}
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
              <span
                key={item.label}
                className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--wa-mist)]"
              >
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
    <Surface className={tone === "rose" ? "border-[rgba(232,80,106,0.28)]" : ""}>
      <div
        className={
          tone === "rose" ? "px-5 py-6 text-sm text-[var(--wa-rose)]" : "px-5 py-6 text-sm text-[var(--wa-mist)]"
        }
      >
        <div className="text-[var(--wa-ivory)]">{title}</div>
        <div className="mt-2">{message}</div>
      </div>
    </Surface>
  );
}

function formatFeedMeta(feed: VenueFeedHealth | null) {
  if (!feed) {
    return "--";
  }
  return `${feed.stalenessMs ?? "--"}ms`;
}

function formatGuardMode(mode: MismatchGuardMode) {
  if (mode === "hard_only") return "hard";
  if (mode === "legacy_enforce") return "legacy";
  return "audit";
}

function formatMismatchAction(opportunity: LiveOpportunity) {
  if (opportunity.mismatchGuardAction === "reduce_size") {
    return `x${opportunity.mismatchSizeMultiplier.toFixed(2)}`;
  }
  return opportunity.mismatchGuardAction;
}

function getMismatchActionTone(opportunity: LiveOpportunity): V2Tone {
  return opportunity.mismatchGuardAction === "block"
    ? "rose"
    : opportunity.mismatchGuardAction === "reduce_size"
      ? "amber"
      : "emerald";
}

function riskLimitTone(value: number | null, limit: number | null): V2Tone {
  if (value === null || limit === null) return "mist";
  return value <= limit ? "emerald" : "rose";
}

function formatPolicyShort(decision: MismatchRiskCounterfactualDecision) {
  if (decision === "would_allow") return "autorise";
  if (decision === "would_block") return "bloque";
  if (decision === "would_allow_fail_open") return "diagnostic";
  if (decision === "reference_allow") return "réf. autorise";
  if (decision === "reference_block") return "réf. bloque";
  return "indisponible";
}

function policyTone(decision: MismatchRiskCounterfactualDecision): V2Tone {
  if (decision === "would_block" || decision === "reference_block") return "rose";
  if (decision === "would_allow") return "emerald";
  if (decision === "would_allow_fail_open" || decision === "reference_allow") return "amber";
  return "mist";
}

function formatLegacyPolicyShort(decision: "would_allow" | "would_reduce_size" | "would_block") {
  if (decision === "would_allow") return "autorise";
  if (decision === "would_reduce_size") return "réduit x0.5";
  return "bloque";
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
  if (
    intent.status === "failed" ||
    intent.status === "unwind_required" ||
    intent.status === "truth_pending" ||
    intent.status === "manual_required" ||
    intent.status === "unwound" ||
    intent.status === "canceled"
  ) {
    return "rose";
  }
  if (intent.status === "rescue_hedge") {
    return "amber";
  }
  if (intent.status === "skipped") {
    return "indigo";
  }
  return "amber";
}

function deriveIntentCapitalUsd(intent: OrderIntent) {
  return Math.round(intent.legs.reduce((sum, leg) => sum + deriveLegCapitalUsd(leg), 0) * 10_000) / 10_000;
}

function deriveLegCapitalUsd(leg: OrderIntent["legs"][number]) {
  const tradedNotional =
    leg.filledSize > 0 && leg.filledPrice !== null ? leg.filledSize * leg.filledPrice : leg.requestedNotionalUsd;
  return Math.round((tradedNotional + leg.feeUsd + deriveLegCashAdjustmentUsd(leg)) * 10_000) / 10_000;
}

function deriveLegCashAdjustmentUsd(leg: OrderIntent["legs"][number]) {
  return leg.cashAdjustmentUsd ?? 0;
}

function formatLegRiskReservations(leg: OrderIntent["legs"][number]) {
  const parts: string[] = [];
  if (leg.worstFillCostUsd !== undefined) {
    parts.push(`worst ${formatV2Usd(leg.worstFillCostUsd)}`);
  }
  if ((leg.recoveryReserveUsd ?? 0) > 0) {
    parts.push(`recovery ${formatV2Usd(leg.recoveryReserveUsd)}`);
  }
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

function formatSignedUsd(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${formatV2Usd(Math.abs(value))}`;
}
