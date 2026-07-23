"use client";

import Link from "next/link";
import { useState } from "react";

import { usePollingJson } from "@/components/use-polling-json";
import { GlobalRiskBudgetPanel } from "@/components/mismatch-risk-view";
import {
  BigMetric,
  Chip,
  formatV2Countdown,
  formatV2Usd,
  PageSection,
  SectionLabel,
  Surface,
  V2EmptyState,
  V2_TONE_TEXT,
  type V2Tone,
} from "@/components/v2-ui";
import {
  formatMismatchAuditDecision,
  formatMismatchEconomicsBasis,
  formatRiskProbability,
  getMismatchModelDisplayState,
  isMismatchBlockingDecision,
} from "@/lib/mismatch-risk-display";
import { selectAcknowledgeableBreakerIncident, shouldListOperationalBreaker } from "@/lib/circuit-breaker-ui";
import type { CircuitBreakerIncident } from "@/lib/circuit-breaker-policy";
import type { GlobalRiskConfig } from "@/lib/risk-settings";
import type {
  CircuitBreaker,
  CircuitBreakerKey,
  LiveOpportunity,
  MismatchRiskCounterfactualDecision,
  OrderIntent,
  PortfolioDashboardResponse,
  ReadinessStatus,
  StablePnlChange,
  VenueBalance,
  VersionedConfiguration,
} from "@/lib/types";

type BreakerDetailsResponse = {
  manualKillIncident: CircuitBreakerIncident | null;
  incidents: CircuitBreakerIncident[];
};

export function PortfolioClient() {
  const portfolio = usePollingJson<PortfolioDashboardResponse>("/api/dashboard", 3_000);
  const globalRisk = usePollingJson<VersionedConfiguration<GlobalRiskConfig>>("/api/settings/risk", 5_000);
  const [globalBreakerBusy, setGlobalBreakerBusy] = useState(false);
  const [breakerClearBusyKey, setBreakerClearBusyKey] = useState<string | null>(null);
  const [globalBreakerMessage, setGlobalBreakerMessage] = useState<string | null>(null);

  if (portfolio.loading && !portfolio.data) {
    return <PanelMessage title="Chargement" message="Connexion au portefeuille multi-actifs." />;
  }

  if (!portfolio.data) {
    return <PanelMessage title="Erreur" message={portfolio.error ?? "Aucune donnée portefeuille."} tone="rose" />;
  }

  const { assets, pnl, stablePnlChanges, openPositionsCount, venueBalances, activeBreakers, manualRequiredIntents } =
    portfolio.data;
  const globalBreaker = activeBreakers.find((breaker) => breaker.key === "global") ?? null;
  const operationalBreakers = activeBreakers.filter(shouldListOperationalBreaker);
  const globalBreakerActive = globalBreaker?.payload?.manualKillActive === true;
  const readyCount = assets.filter((asset) => asset.workerState.readinessStatus === "ready").length;
  const liveCount = assets.filter((asset) => asset.config.enableTrading && !asset.config.shadowMode).length;
  const shadowCount = assets.filter((asset) => asset.config.enableTrading && asset.config.shadowMode).length;
  const enforceRiskCount = assets.filter((asset) => asset.config.mismatchRiskMode === "enforce").length;
  const uncalibratedCount = assets.filter(
    (asset) => getMismatchModelDisplayState(asset.bestOpportunity?.mismatchRiskEstimate) === "uncalibrated",
  ).length;
  const breakerCount = activeBreakers.length || assets.reduce((sum, asset) => sum + asset.activeBreakers.length, 0);
  const strategyPnlUsd = pnl?.strategyPnlUsd ?? (pnl ? pnl.realizedPnlUsd + pnl.unrealizedPnlUsd : null);
  const accountDeltaUsd = pnl?.accountDeltaUsd ?? strategyPnlUsd ?? null;
  const drawdownUsd = pnl?.drawdownUsd ?? null;
  const drawdownTone: V2Tone = drawdownUsd === null ? "mist" : drawdownUsd >= 0 ? "emerald" : "rose";

  async function toggleGlobalBreaker() {
    setGlobalBreakerBusy(true);
    setGlobalBreakerMessage(null);
    try {
      const nextActive = !globalBreakerActive;
      let acknowledgement: { incidentId: string; expectedRevision: number } | null = null;
      if (!nextActive) {
        const detailsResponse = await fetch("/api/circuit-breakers?details=1", { cache: "no-store" });
        if (!detailsResponse.ok) {
          throw new Error(await detailsResponse.text());
        }
        const details = (await detailsResponse.json()) as BreakerDetailsResponse;
        if (!details.manualKillIncident) {
          throw new Error("Aucun incident manual-kill actif à acquitter.");
        }
        acknowledgement = {
          incidentId: details.manualKillIncident.id,
          expectedRevision: details.manualKillIncident.revision,
        };
      }
      const response = await fetch("/api/circuit-breakers", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          key: "global",
          active: nextActive,
          reason: "manual",
          ...acknowledgement,
        }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      setGlobalBreakerMessage(nextActive ? "Global circuit breaker activé." : "Global circuit breaker désactivé.");
    } catch (error) {
      setGlobalBreakerMessage(
        error instanceof Error ? error.message : "Impossible de modifier le global circuit breaker.",
      );
    } finally {
      setGlobalBreakerBusy(false);
    }
  }

  async function acknowledgeBreaker(key: CircuitBreakerKey, intentId?: string) {
    const breaker = activeBreakers.find((candidate) => candidate.key === key);
    if (!breaker?.active) {
      return;
    }

    if (!window.confirm(`Acquitter un incident exact de ${key} ? L'exposition doit déjà être prouvée résolue.`)) {
      return;
    }

    setBreakerClearBusyKey(key);
    setGlobalBreakerMessage(null);
    try {
      const detailsResponse = await fetch("/api/circuit-breakers?details=1", { cache: "no-store" });
      if (!detailsResponse.ok) {
        throw new Error(await detailsResponse.text());
      }
      const details = (await detailsResponse.json()) as BreakerDetailsResponse;
      const incident = selectAcknowledgeableBreakerIncident(details.incidents, key, intentId);
      if (!incident) {
        throw new Error(`Aucun incident opérateur avec exposition résolue n'est acquittable pour ${key}.`);
      }
      const response = await fetch("/api/circuit-breakers", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          key,
          active: false,
          incidentId: incident.id,
          expectedRevision: incident.revision,
        }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const result = (await response.json().catch(() => null)) as { active?: boolean } | null;
      setGlobalBreakerMessage(
        result?.active === true
          ? `Incident acquitté; ${key} reste actif pour une autre cause.`
          : `Incident acquitté; ${key} n'a plus de cause active.`,
      );
    } catch (error) {
      setGlobalBreakerMessage(error instanceof Error ? error.message : `Impossible de désactiver ${key}.`);
    } finally {
      setBreakerClearBusyKey(null);
    }
  }

  async function clearManualIntervention(intent: OrderIntent) {
    const breaker = findBreakerForIntent(activeBreakers, intent);
    if (!breaker) {
      setGlobalBreakerMessage(`Aucun breaker actif trouvé pour l'intent ${intent.id}.`);
      return;
    }
    await acknowledgeBreaker(breaker.key, intent.id);
  }

  return (
    <div className="flex flex-col gap-8">
      <PageSection watermark="PORT">
        <div className="mb-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <div className="text-[9px] uppercase tracking-[0.30em] text-[rgba(201,168,100,0.45)]">
              Vue Multi-Actifs ·{" "}
              {new Date(portfolio.data.fetchedAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </div>
            <GlobalBreakerButton active={globalBreakerActive} busy={globalBreakerBusy} onClick={toggleGlobalBreaker} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Chip tone={breakerCount > 0 ? "rose" : "emerald"}>
              {readyCount}/{assets.length} ready
            </Chip>
            <Chip tone={liveCount > 0 ? "gold" : "mist"}>{liveCount} live</Chip>
            <Chip tone={shadowCount > 0 ? "indigo" : "mist"}>{shadowCount} shadow</Chip>
            <Chip tone={enforceRiskCount > 0 ? "rose" : "indigo"}>{enforceRiskCount} risk enforce</Chip>
            {uncalibratedCount > 0 ? <Chip tone="amber">{uncalibratedCount} modèles non calibrés</Chip> : null}
            {breakerCount > 0 ? <Chip tone="rose">{breakerCount} breakers</Chip> : null}
          </div>
        </div>

        {globalBreakerActive ? (
          <div className="mb-4 rounded-lg border border-[rgba(232,80,106,0.34)] bg-[rgba(232,80,106,0.10)] px-5 py-4 shadow-[0_0_28px_rgba(232,80,106,0.08)]">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--wa-rose)]">
                  Global circuit breaker actif
                </div>
                <div className="mt-2 text-sm leading-6 text-[var(--wa-ivory)]">
                  Aucun nouvel ordre live ne doit être lancé tant que ce breaker global est actif.
                </div>
                <div className="mt-1 text-xs text-[var(--wa-mist)]">
                  Raison: {globalBreaker.reason ?? "manual"} · déclenché:{" "}
                  {globalBreaker.triggeredAt ? new Date(globalBreaker.triggeredAt).toLocaleString("fr-FR") : "--"}
                </div>
              </div>
              <GlobalBreakerButton
                active={globalBreakerActive}
                busy={globalBreakerBusy}
                onClick={toggleGlobalBreaker}
                emphasis
              />
            </div>
          </div>
        ) : null}
        {globalBreakerMessage ? (
          <div className="mb-4 rounded border border-[var(--wa-gold-border)] bg-[rgba(201,168,100,0.05)] px-4 py-3 text-sm text-[var(--wa-mist)]">
            {globalBreakerMessage}
          </div>
        ) : null}
        {manualRequiredIntents.length > 0 ? (
          <ManualInterventionList
            intents={manualRequiredIntents}
            breakers={activeBreakers}
            busyKey={breakerClearBusyKey}
            onClear={clearManualIntervention}
          />
        ) : null}
        {operationalBreakers.length > 0 ? (
          <ActiveBreakerList
            breakers={operationalBreakers}
            busyKey={breakerClearBusyKey}
            onClear={acknowledgeBreaker}
          />
        ) : null}

        <Surface glow>
          <div className="grid border-b border-[var(--wa-gold-border)] md:grid-cols-2 xl:grid-cols-4">
            <BigMetric label="Equity totale" value={formatV2Usd(pnl?.equityUsd, true)} tone="gold" huge />
            <BigMetric label="Cash disponible" value={formatV2Usd(pnl?.cashUsd, true)} tone="gold" />
            <BigMetric
              label="Positions"
              value={String(openPositionsCount)}
              sub={pnl ? `${formatV2Usd(pnl.positionsValueUsd)} exposés` : "positions live"}
            />
            <BigMetric
              label="Delta Compte"
              value={formatSignedUsd(drawdownUsd)}
              tone={drawdownTone}
              sub={pnl ? `Drawdown global · Delta ${formatSignedUsd(accountDeltaUsd)}` : undefined}
            />
          </div>
          <div className="flex flex-wrap items-center gap-5 px-5 py-4 sm:px-6">
            <DailyPnl label="Réalisé" value={pnl?.realizedPnlUsd ?? null} />
            <Divider />
            <DailyPnl label="Non réalisé" value={pnl?.unrealizedPnlUsd ?? null} />
            <Divider />
            <DailyPnl label="Drawdown" value={pnl?.drawdownUsd ?? null} />
            <Divider />
            <DailyPnl label="Net compte" value={accountDeltaUsd} />
          </div>
        </Surface>
      </PageSection>

      <section>
        <SectionLabel right="liquidités venues">Polymarket &amp; Kalshi</SectionLabel>
        <div className="overflow-hidden rounded-lg border border-[var(--wa-gold-border)]">
          {venueBalances.map((balance, index) => (
            <PortfolioVenueRow key={balance.venue} balance={balance} last={index === venueBalances.length - 1} />
          ))}
        </div>
      </section>

      <section>
        <SectionLabel right="cluster multi-actifs">Budget de Risque</SectionLabel>
        <GlobalRiskBudgetPanel
          config={globalRisk.data?.config ?? null}
          error={globalRisk.error}
          loading={globalRisk.loading}
        />
      </section>

      <section>
        <SectionLabel right={`${assets.length} actifs`}>Actifs</SectionLabel>
        <div className="grid overflow-hidden rounded-lg border border-[var(--wa-gold-border)] md:grid-cols-2 xl:grid-cols-3">
          {assets.map((asset) => (
            <AssetCard key={asset.asset} asset={asset} />
          ))}
        </div>
      </section>

      <section>
        <SectionLabel right="10 dernières fenêtres stables · drawdown">P&amp;L Global</SectionLabel>
        <Surface>
          {stablePnlChanges.length === 0 ? (
            <V2EmptyState message="Aucune fenêtre stable enregistrée" />
          ) : (
            <StablePnlChart changes={stablePnlChanges.slice(0, 10).reverse()} />
          )}
        </Surface>
      </section>
    </div>
  );
}

function ManualInterventionList({
  intents,
  breakers,
  busyKey,
  onClear,
}: {
  intents: OrderIntent[];
  breakers: CircuitBreaker[];
  busyKey: string | null;
  onClear: (intent: OrderIntent) => void;
}) {
  return (
    <div className="mb-4 rounded-lg border border-[rgba(232,80,106,0.34)] bg-[rgba(232,80,106,0.10)] px-5 py-4 shadow-[0_0_28px_rgba(232,80,106,0.08)]">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--wa-rose)]">
            Intervention manuelle requise
          </div>
          <div className="mt-1 text-sm text-[var(--wa-mist)]">
            Vérifie que l&apos;exposition a été traitée avant de lever le blocage.
          </div>
        </div>
        <Chip tone="rose">{intents.length} intent(s)</Chip>
      </div>
      <div className="flex flex-col gap-3">
        {intents.map((intent) => {
          const breaker = findBreakerForIntent(breakers, intent);
          const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue);
          const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue);
          return (
            <div
              key={intent.id}
              className="grid gap-3 rounded border border-[rgba(232,80,106,0.22)] bg-[rgba(10,14,22,0.30)] px-3 py-3 lg:grid-cols-[1fr_auto]"
            >
              <div className="min-w-0">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Chip tone="rose">{intent.asset.toUpperCase()}</Chip>
                  <Chip tone="rose">{intent.status}</Chip>
                  <Chip tone={intent.shadow ? "indigo" : "gold"}>{intent.shadow ? "shadow" : "live"}</Chip>
                  {breaker ? (
                    <Chip tone="rose">{breaker.reason ?? "breaker"}</Chip>
                  ) : (
                    <Chip tone="amber">sans breaker</Chip>
                  )}
                </div>
                <div className="text-sm text-[var(--wa-ivory)]">
                  {intent.combination} · {intent.primaryVenue} → {intent.hedgeVenue}
                </div>
                <div className="mt-1 text-xs text-[var(--wa-mist)]">
                  {new Date(intent.createdAt).toLocaleString("fr-FR")} · slot {intent.slotKey}
                </div>
                <div className="mt-2 grid gap-1 text-xs text-[var(--wa-mist)] sm:grid-cols-2">
                  <IntentLegLine label="primaire" leg={primaryLeg} />
                  <IntentLegLine label="hedge" leg={hedgeLeg} />
                </div>
                {intent.failureReason ? (
                  <div className="mt-2 text-xs leading-5 text-[var(--wa-rose)]">{intent.failureReason}</div>
                ) : null}
              </div>
              <div className="flex items-start lg:justify-end">
                <button
                  type="button"
                  onClick={() => onClear(intent)}
                  disabled={!breaker || busyKey === breaker.key}
                  className="w-full rounded border border-[rgba(232,80,106,0.34)] bg-[rgba(232,80,106,0.12)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--wa-rose)] transition hover:bg-[rgba(232,80,106,0.18)] disabled:cursor-not-allowed disabled:opacity-50 lg:w-auto"
                  title={
                    breaker
                      ? "Acquitter l'incident après preuve durable de résolution de l'exposition"
                      : "Aucun breaker actif associé"
                  }
                >
                  {breaker && busyKey === breaker.key ? "acquittement..." : "Acquitter incident"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function IntentLegLine({ label, leg }: { label: string; leg: OrderIntent["legs"][number] | undefined }) {
  if (!leg) {
    return <div>{label}: --</div>;
  }
  return (
    <div>
      {label}: {leg.venue} · {leg.outcome} · filled {formatSize(leg.filledSize)}/{formatSize(leg.requestedSize)}
    </div>
  );
}

function ActiveBreakerList({
  breakers,
  busyKey,
  onClear,
}: {
  breakers: PortfolioDashboardResponse["activeBreakers"];
  busyKey: string | null;
  onClear: (key: CircuitBreakerKey) => void;
}) {
  return (
    <div className="mb-4 rounded-lg border border-[rgba(232,80,106,0.22)] bg-[rgba(232,80,106,0.06)] px-5 py-4">
      <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--wa-rose)]">
        Breakers opérationnels actifs
      </div>
      <div className="flex flex-col gap-2">
        {breakers.map((breaker) => (
          <div
            key={breaker.key}
            className="flex flex-col gap-2 rounded border border-[rgba(232,80,106,0.18)] bg-[rgba(10,14,22,0.22)] px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap gap-2">
                <Chip tone="rose">{breaker.key}</Chip>
                <Chip tone="rose">{breaker.reason ?? "unknown"}</Chip>
              </div>
              <div className="truncate text-[10px] text-[var(--wa-mist)]">
                {breaker.triggeredAt ? new Date(breaker.triggeredAt).toLocaleString("fr-FR") : "déclenchement inconnu"}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onClear(breaker.key)}
              disabled={busyKey === breaker.key || breaker.payload?.requiresManualClear !== true}
              title={
                breaker.payload?.requiresManualClear === true
                  ? "Acquitter un incident opérateur exact"
                  : "Ce breaker est résolu automatiquement par son sous-système propriétaire"
              }
              className="w-full rounded border border-[rgba(232,80,106,0.34)] bg-[rgba(232,80,106,0.10)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--wa-rose)] transition hover:bg-[rgba(232,80,106,0.16)] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            >
              {busyKey === breaker.key ? "acquittement..." : "acquitter"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function GlobalBreakerButton({
  active,
  busy,
  emphasis = false,
  onClick,
}: {
  active: boolean;
  busy: boolean;
  emphasis?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`rounded border px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] transition disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? "border-[rgba(232,80,106,0.36)] bg-[rgba(232,80,106,0.13)] text-[var(--wa-rose)] hover:bg-[rgba(232,80,106,0.18)]"
          : "border-[rgba(30,216,126,0.28)] bg-[rgba(30,216,126,0.08)] text-[var(--wa-emerald)] hover:bg-[rgba(30,216,126,0.12)]"
      } ${emphasis ? "w-full sm:w-auto" : ""}`}
    >
      {busy ? "mise à jour" : active ? "Désactiver global" : "Activer global"}
    </button>
  );
}

function AssetCard({ asset }: { asset: PortfolioDashboardResponse["assets"][number] }) {
  const mode = !asset.config.enableTrading ? "off" : asset.config.shadowMode ? "shadow" : "live";
  const modeTone: V2Tone = mode === "live" ? "gold" : mode === "shadow" ? "indigo" : "amber";
  const readinessTone = getReadinessTone(asset.workerState.readinessStatus);
  const best = asset.bestOpportunity;
  const bestAudit = best?.mismatchRiskAudit ?? null;
  const feedReadyCount = asset.feedHealth.filter((feed) => feed.feedStatus === "ready").length;

  return (
    <Link
      href={`/${asset.asset}`}
      className="border-b border-r border-[var(--wa-gold-border)] bg-[var(--wa-bg1)] p-5 transition hover:bg-[rgba(201,168,100,0.035)]"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="font-mono text-xl font-semibold text-[var(--wa-gold)]">{asset.asset.toUpperCase()}</span>
            <Chip tone={modeTone}>{mode}</Chip>
            <Chip tone={readinessTone}>{asset.workerState.readinessStatus}</Chip>
            <Chip
              tone={
                asset.config.mismatchRiskMode === "enforce"
                  ? "rose"
                  : asset.config.mismatchRiskMode === "block_only"
                    ? "amber"
                    : "indigo"
              }
            >
              risk {asset.config.mismatchRiskMode}
            </Chip>
          </div>
          <div className="text-sm text-[var(--wa-ivory)]">{asset.slot.label}</div>
          <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-[var(--wa-dim)]">
            {asset.workerState.phase} · feeds {feedReadyCount}/{asset.feedHealth.length}
          </div>
        </div>
        <div className="font-mono text-3xl leading-none text-[var(--wa-ivory)]">
          {formatV2Countdown(asset.slot.secondsRemaining)}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded border border-[var(--wa-gold-border)] bg-[var(--wa-gold-border)] sm:grid-cols-4">
        <MiniStat label="Budget" value={formatV2Usd(asset.config.maxPairNotionalUsd)} />
        <MiniStat label="Seuil" value={asset.config.grossEntryThreshold.toFixed(3)} />
        <MiniStat
          label="P fatal 95%"
          value={formatRiskProbability(bestAudit ? bestAudit.pFatalUpper95 : best?.mismatchRiskEstimate?.pFatalUpper95)}
          tone={getAssetMismatchTone(best)}
        />
        <MiniStat
          label="Breakers"
          value={String(asset.activeBreakers.length)}
          tone={asset.activeBreakers.length > 0 ? "rose" : "emerald"}
        />
      </div>
      <div className="mt-4 border-t border-[var(--wa-gold-border)] pt-4 text-sm text-[var(--wa-mist)]">
        {best ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span>
                brut live {best.grossCost === null ? "--" : best.grossCost.toFixed(3)} · primaire{" "}
                {best.primaryVenue ?? "--"}
              </span>
              <Chip tone={best.eligible ? "emerald" : "amber"}>{best.eligible ? "eligible" : "watch"}</Chip>
            </div>
            {bestAudit ? (
              <div className="flex flex-wrap gap-2">
                <Chip tone={getAuditDecisionTone(bestAudit.decision)}>
                  block_only · {formatMismatchAuditDecision(bestAudit.decision)}
                </Chip>
                <Chip
                  tone={
                    bestAudit.economicsBasis === "executable"
                      ? "emerald"
                      : bestAudit.economicsBasis === "reference"
                        ? "amber"
                        : "mist"
                  }
                >
                  {formatMismatchEconomicsBasis(bestAudit.economicsBasis)}
                </Chip>
              </div>
            ) : null}
          </div>
        ) : (
          "Aucune opportunité calculée pour ce créneau."
        )}
      </div>
    </Link>
  );
}

function PortfolioVenueRow({ balance, last }: { balance: VenueBalance; last: boolean }) {
  const allowance =
    balance.raw["allowanceUnlimited"] === true
      ? "Illimitée"
      : balance.allowanceUsd === null
        ? "--"
        : formatV2Usd(balance.allowanceUsd);

  return (
    <div
      className={`grid gap-4 bg-[var(--wa-bg1)] px-5 py-4 lg:grid-cols-[120px_1fr_82px] ${last ? "" : "border-b border-[var(--wa-gold-border)]"}`}
    >
      <div>
        <div className="mb-1 text-[9px] uppercase tracking-[0.22em] text-[rgba(201,168,100,0.50)]">{balance.venue}</div>
        <div className="text-sm text-[var(--wa-ivory)]">{balance.currency}</div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <VenueMetric label="Disponible" value={formatV2Usd(balance.availableBalanceUsd)} tone="gold" />
        <VenueMetric label="Portfolio" value={formatV2Usd(balance.portfolioValueUsd)} />
        <VenueMetric label="Allowance" value={allowance} />
      </div>
      <div className="flex items-start justify-start lg:justify-end">
        <Chip tone={balance.status === "ready" ? "emerald" : balance.status === "degraded" ? "amber" : "rose"}>
          {balance.status}
        </Chip>
      </div>
    </div>
  );
}

function StablePnlChart({ changes }: { changes: StablePnlChange[] }) {
  const width = 1200;
  const height = 280;
  const pad = { top: 54, bottom: 52, left: 84, right: 44 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const values = changes.map((change) => change.drawdownUsd);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const range = max - min || 1;
  const x = (index: number) => pad.left + ((index + 0.5) / changes.length) * innerWidth;
  const y = (value: number) => pad.top + (1 - (value - min) / range) * innerHeight;
  const line = values
    .map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`)
    .join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-[280px] w-full" preserveAspectRatio="xMidYMid meet">
      <line
        x1={pad.left}
        y1={y(0)}
        x2={width - pad.right}
        y2={y(0)}
        stroke="rgba(201,168,100,0.16)"
        strokeDasharray="4,4"
      />
      <path
        d={line}
        fill="none"
        stroke="var(--wa-gold)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {values.map((value, index) => (
        <g key={`${changes[index]!.intentId}-${changes[index]!.changedAt}`}>
          {(() => {
            const label = formatChartUsd(value);
            const labelWidth = label.length * 9 + 16;
            const labelX = Math.max(pad.left, Math.min(width - pad.right, x(index)));
            const labelY = Math.max(24, Math.min(height - 18, y(value) + [-24, 30, -38, 44][index % 4]!));
            const labelRectX = Math.max(8, Math.min(width - labelWidth - 8, labelX - labelWidth / 2));
            return (
              <>
                <circle cx={x(index)} cy={y(value)} r="4" fill="var(--wa-gold)" />
                <rect
                  x={labelRectX}
                  y={labelY - 16}
                  width={labelWidth}
                  height="24"
                  rx="4"
                  fill="rgba(4,6,12,0.82)"
                  stroke="rgba(201,168,100,0.18)"
                />
                <text
                  x={labelX}
                  y={labelY}
                  textAnchor="middle"
                  fontSize="13"
                  fill={value >= 0 ? "var(--wa-emerald)" : "var(--wa-rose)"}
                  fontFamily="IBM Plex Mono"
                >
                  {label}
                </text>
              </>
            );
          })()}
        </g>
      ))}
    </svg>
  );
}

function MiniStat({ label, value, tone = "mist" }: { label: string; value: string; tone?: V2Tone }) {
  return (
    <div className="bg-[var(--wa-bg0)] px-3 py-3">
      <div className="mb-1 text-[8px] uppercase tracking-[0.18em] text-[var(--wa-dim)]">{label}</div>
      <div className={`font-mono text-sm ${V2_TONE_TEXT[tone]}`}>{value}</div>
    </div>
  );
}

function VenueMetric({ label, value, tone = "mist" }: { label: string; value: string; tone?: V2Tone }) {
  return (
    <div>
      <div className="mb-1 text-[8px] uppercase tracking-[0.18em] text-[var(--wa-dim)]">{label}</div>
      <div className={`font-mono text-sm ${V2_TONE_TEXT[tone]}`}>{value}</div>
    </div>
  );
}

function DailyPnl({ label, value }: { label: string; value: number | null }) {
  const tone: V2Tone = value === null ? "mist" : value >= 0 ? "emerald" : "rose";
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--wa-dim)]">{label}</span>
      <span className={`font-mono text-sm ${V2_TONE_TEXT[tone]}`}>{formatSignedUsd(value)}</span>
    </div>
  );
}

function Divider() {
  return <div className="hidden h-5 w-px bg-[var(--wa-gold-border)] sm:block" />;
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

function getReadinessTone(status: ReadinessStatus): V2Tone {
  return status === "ready" ? "emerald" : status === "blocked" ? "rose" : "amber";
}

function getAssetMismatchTone(opportunity: LiveOpportunity | null): V2Tone {
  const estimate = opportunity?.mismatchRiskEstimate;
  const modelState = getMismatchModelDisplayState(estimate);
  if (modelState === "uncalibrated") {
    return "amber";
  }
  if (!estimate || modelState === "unavailable" || estimate.pFatalUpper95 === null) {
    return "mist";
  }
  if (
    estimate.maximumAllowedFatalProbability !== null &&
    estimate.pFatalUpper95 > estimate.maximumAllowedFatalProbability
  ) {
    return "rose";
  }
  return "emerald";
}

function getAuditDecisionTone(decision: MismatchRiskCounterfactualDecision): V2Tone {
  if (isMismatchBlockingDecision(decision)) {
    return "rose";
  }
  if (decision === "would_allow") {
    return "emerald";
  }
  if (decision === "would_allow_fail_open" || decision === "reference_allow") {
    return "amber";
  }
  return "mist";
}

function findBreakerForIntent(breakers: CircuitBreaker[], intent: OrderIntent) {
  return (
    breakers.find(
      (breaker) =>
        breaker.active && Array.isArray(breaker.payload?.intentIds) && breaker.payload.intentIds.includes(intent.id),
    ) ??
    breakers.find((breaker) => breaker.active && breaker.key === `slot:${intent.slotKey}`) ??
    breakers.find((breaker) => breaker.active && breaker.key === `asset:${intent.asset}`) ??
    breakers.find((breaker) => breaker.active && breaker.key === "global") ??
    null
  );
}

function formatSignedUsd(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${formatV2Usd(Math.abs(value))}`;
}

function formatChartUsd(value: number) {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatSize(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}
