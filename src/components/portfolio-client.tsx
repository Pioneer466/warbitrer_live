"use client";

import Link from "next/link";
import { useState } from "react";

import { usePollingJson } from "@/components/use-polling-json";
import {
  BigMetric,
  Chip,
  formatV2Countdown,
  formatV2Usd,
  MetricCell,
  PageSection,
  SectionLabel,
  Surface,
  V2EmptyState,
  V2_TONE_TEXT,
  type V2Tone,
} from "@/components/v2-ui";
import type { MarketAsset, PortfolioDashboardResponse, ReadinessStatus, StablePnlChange, VenueBalance } from "@/lib/types";

export function PortfolioClient() {
  const portfolio = usePollingJson<PortfolioDashboardResponse>("/api/dashboard", 1_000);
  const [globalBreakerBusy, setGlobalBreakerBusy] = useState(false);
  const [globalBreakerMessage, setGlobalBreakerMessage] = useState<string | null>(null);

  if (portfolio.loading && !portfolio.data) {
    return <PanelMessage title="Chargement" message="Connexion au portefeuille multi-actifs." />;
  }

  if (!portfolio.data) {
    return <PanelMessage title="Erreur" message={portfolio.error ?? "Aucune donnée portefeuille."} tone="rose" />;
  }

  const { assets, pnl, stablePnlChanges, openPositionsCount, venueBalances, activeBreakers } = portfolio.data;
  const globalBreaker = activeBreakers.find((breaker) => breaker.key === "global") ?? null;
  const nonGlobalBreakers = activeBreakers.filter((breaker) => breaker.key !== "global");
  const globalBreakerActive = globalBreaker?.active === true;
  const readyCount = assets.filter((asset) => asset.workerState.readinessStatus === "ready").length;
  const liveCount = assets.filter((asset) => asset.config.enableTrading && !asset.config.shadowMode).length;
  const shadowCount = assets.filter((asset) => asset.config.enableTrading && asset.config.shadowMode).length;
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
      const response = await fetch("/api/circuit-breakers", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          key: "global",
          active: nextActive,
          reason: "manual",
        }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      setGlobalBreakerMessage(nextActive ? "Global circuit breaker activé." : "Global circuit breaker désactivé.");
    } catch (error) {
      setGlobalBreakerMessage(error instanceof Error ? error.message : "Impossible de modifier le global circuit breaker.");
    } finally {
      setGlobalBreakerBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <PageSection watermark="PORT">
        <div className="mb-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <div className="text-[9px] uppercase tracking-[0.30em] text-[rgba(201,168,100,0.45)]">
              Vue Multi-Actifs · {new Date(portfolio.data.fetchedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </div>
            <GlobalBreakerButton active={globalBreakerActive} busy={globalBreakerBusy} onClick={toggleGlobalBreaker} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Chip tone={breakerCount > 0 ? "rose" : "emerald"}>{readyCount}/{assets.length} ready</Chip>
            <Chip tone={liveCount > 0 ? "gold" : "mist"}>{liveCount} live</Chip>
            <Chip tone={shadowCount > 0 ? "indigo" : "mist"}>{shadowCount} shadow</Chip>
            {breakerCount > 0 ? <Chip tone="rose">{breakerCount} breakers</Chip> : null}
          </div>
        </div>

        {globalBreakerActive ? (
          <div className="mb-4 rounded-lg border border-[rgba(232,80,106,0.34)] bg-[rgba(232,80,106,0.10)] px-5 py-4 shadow-[0_0_28px_rgba(232,80,106,0.08)]">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--wa-rose)]">Global circuit breaker actif</div>
                <div className="mt-2 text-sm leading-6 text-[var(--wa-ivory)]">
                  Aucun nouvel ordre live ne doit être lancé tant que ce breaker global est actif.
                </div>
                <div className="mt-1 text-xs text-[var(--wa-mist)]">
                  Raison: {globalBreaker.reason ?? "manual"} · déclenché: {globalBreaker.triggeredAt ? new Date(globalBreaker.triggeredAt).toLocaleString("fr-FR") : "--"}
                </div>
              </div>
              <GlobalBreakerButton active={globalBreakerActive} busy={globalBreakerBusy} onClick={toggleGlobalBreaker} emphasis />
            </div>
          </div>
        ) : null}
        {globalBreakerMessage ? (
          <div className="mb-4 rounded border border-[var(--wa-gold-border)] bg-[rgba(201,168,100,0.05)] px-4 py-3 text-sm text-[var(--wa-mist)]">
            {globalBreakerMessage}
          </div>
        ) : null}
        {nonGlobalBreakers.length > 0 ? <ActiveBreakerList breakers={nonGlobalBreakers} /> : null}

        <Surface glow>
          <div className="grid border-b border-[var(--wa-gold-border)] md:grid-cols-2 xl:grid-cols-4">
            <BigMetric label="Equity totale" value={formatV2Usd(pnl?.equityUsd, true)} tone="gold" huge />
            <BigMetric label="Cash disponible" value={formatV2Usd(pnl?.cashUsd, true)} tone="gold" />
            <BigMetric label="Positions" value={String(openPositionsCount)} sub={pnl ? `${formatV2Usd(pnl.positionsValueUsd)} exposés` : "positions live"} />
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
          {stablePnlChanges.length === 0 ? <V2EmptyState message="Aucune fenêtre stable enregistrée" /> : <StablePnlChart changes={stablePnlChanges.slice(0, 10).reverse()} />}
        </Surface>
      </section>
    </div>
  );
}

function ActiveBreakerList({ breakers }: { breakers: PortfolioDashboardResponse["activeBreakers"] }) {
  return (
    <div className="mb-4 rounded-lg border border-[rgba(232,80,106,0.22)] bg-[rgba(232,80,106,0.06)] px-5 py-4">
      <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--wa-rose)]">
        Breakers slot / asset actifs
      </div>
      <div className="flex flex-wrap gap-2">
        {breakers.map((breaker) => (
          <Chip key={breaker.key} tone="rose">
            {breaker.key} · {breaker.reason ?? "unknown"}
          </Chip>
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
          </div>
          <div className="text-sm text-[var(--wa-ivory)]">{asset.slot.label}</div>
          <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-[var(--wa-dim)]">
            {asset.workerState.phase} · feeds {feedReadyCount}/{asset.feedHealth.length}
          </div>
        </div>
        <div className="font-mono text-3xl leading-none text-[var(--wa-ivory)]">{formatV2Countdown(asset.slot.secondsRemaining)}</div>
      </div>
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded border border-[var(--wa-gold-border)] bg-[var(--wa-gold-border)]">
        <MiniStat label="Budget" value={formatV2Usd(asset.config.maxPairNotionalUsd)} />
        <MiniStat label="Seuil" value={asset.config.grossEntryThreshold.toFixed(3)} />
        <MiniStat label="Breakers" value={String(asset.activeBreakers.length)} tone={asset.activeBreakers.length > 0 ? "rose" : "emerald"} />
      </div>
      <div className="mt-4 border-t border-[var(--wa-gold-border)] pt-4 text-sm text-[var(--wa-mist)]">
        {best ? (
          <div className="flex items-center justify-between gap-3">
            <span>brut live {best.grossCost === null ? "--" : best.grossCost.toFixed(3)} · primaire {best.primaryVenue ?? "--"}</span>
            <Chip tone={best.eligible ? "emerald" : "amber"}>{best.eligible ? "eligible" : "watch"}</Chip>
          </div>
        ) : (
          "Aucune opportunité calculée pour ce créneau."
        )}
      </div>
    </Link>
  );
}

function PortfolioVenueRow({ balance, last }: { balance: VenueBalance; last: boolean }) {
  const allowance = balance.raw["allowanceUnlimited"] === true
    ? "Illimitée"
    : balance.allowanceUsd === null
      ? "--"
      : formatV2Usd(balance.allowanceUsd);

  return (
    <div className={`grid gap-4 bg-[var(--wa-bg1)] px-5 py-4 lg:grid-cols-[120px_1fr_82px] ${last ? "" : "border-b border-[var(--wa-gold-border)]"}`}>
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
        <Chip tone={balance.status === "ready" ? "emerald" : balance.status === "degraded" ? "amber" : "rose"}>{balance.status}</Chip>
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
  const x = (index: number) => pad.left + (index + 0.5) / changes.length * innerWidth;
  const y = (value: number) => pad.top + (1 - (value - min) / range) * innerHeight;
  const line = values.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-[280px] w-full" preserveAspectRatio="xMidYMid meet">
      <line x1={pad.left} y1={y(0)} x2={width - pad.right} y2={y(0)} stroke="rgba(201,168,100,0.16)" strokeDasharray="4,4" />
      <path d={line} fill="none" stroke="var(--wa-gold)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
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
                <text x={labelX} y={labelY} textAnchor="middle" fontSize="13" fill={value >= 0 ? "var(--wa-emerald)" : "var(--wa-rose)"} fontFamily="IBM Plex Mono">
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

function getReadinessTone(status: ReadinessStatus): V2Tone {
  return status === "ready" ? "emerald" : status === "blocked" ? "rose" : "amber";
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
