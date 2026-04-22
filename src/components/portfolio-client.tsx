"use client";

import Link from "next/link";

import { usePollingJson } from "@/components/use-polling-json";
import { formatCountdown, formatCurrency, formatPrice } from "@/lib/format";
import type { MarketAsset, PortfolioDashboardResponse, ReadinessStatus } from "@/lib/types";

type Tone = "default" | "cyan" | "amber" | "rose" | "emerald" | "indigo";

const ORANGE_ASSET_THEME = {
  badge: "border-amber/[0.30] bg-amber/[0.12] text-amber shadow-[0_0_24px_rgba(255,184,79,0.18)]",
  text: "text-amber",
} as const;

const ASSET_THEMES: Record<
  MarketAsset,
  {
    badge: string;
    text: string;
  }
> = {
  btc: ORANGE_ASSET_THEME,
  eth: ORANGE_ASSET_THEME,
  sol: ORANGE_ASSET_THEME,
  xrp: ORANGE_ASSET_THEME,
};

export function PortfolioClient() {
  const portfolio = usePollingJson<PortfolioDashboardResponse>("/api/dashboard", 1_000);

  if (portfolio.loading && !portfolio.data) {
    return <PanelMessage title="Chargement" message="Connexion au portefeuille multi-actifs." />;
  }

  if (!portfolio.data) {
    return <PanelMessage title="Erreur" message={portfolio.error ?? "Aucune donnée portefeuille."} tone="rose" />;
  }

  const { assets, pnl, openPositionsCount, activeBreakers } = portfolio.data;
  const readyAssets = assets.filter((asset) => asset.workerState.readinessStatus === "ready").length;
  const blockedAssets = assets.filter((asset) => asset.workerState.readinessStatus === "blocked").length;
  const liveAssets = assets.filter((asset) => asset.config.enableTrading && !asset.config.shadowMode).length;
  const shadowAssets = assets.filter((asset) => asset.config.enableTrading && asset.config.shadowMode).length;
  const strategyPnlUsd = pnl?.strategyPnlUsd ?? (pnl ? pnl.realizedPnlUsd + pnl.unrealizedPnlUsd : null);

  return (
    <div className="space-y-5">
      <section className="rounded-[32px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 shadow-[0_20px_60px_rgba(0,0,0,0.22)] sm:px-6">
        <div className="flex flex-col gap-3 border-b border-white/6 pb-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-[0.24em] text-mist/70">Vue Multi-Actifs</div>
            <div className="mt-2 text-sm text-mist/75">
              Lecture rapide du moteur global, des modes de trading et des meilleures opportunités par actif.
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusPill tone={blockedAssets > 0 ? "rose" : "emerald"}>{readyAssets}/{assets.length} ready</StatusPill>
            <StatusPill tone={liveAssets > 0 ? "cyan" : "default"}>{liveAssets} live</StatusPill>
            <StatusPill tone={shadowAssets > 0 ? "indigo" : "default"}>{shadowAssets} shadow</StatusPill>
            <StatusPill tone={activeBreakers.length > 0 ? "rose" : "emerald"}>{activeBreakers.length} breakers</StatusPill>
          </div>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SummaryCell
            label="Equity"
            value={pnl ? formatCurrency(pnl.equityUsd) : "--"}
            tone={pnl && pnl.equityUsd >= (pnl.cashUsd ?? 0) ? "cyan" : "default"}
          />
          <SummaryCell label="Cash" value={pnl ? formatCurrency(pnl.cashUsd) : "--"} tone="amber" />
          <SummaryCell
            label="Positions ouvertes"
            value={String(openPositionsCount)}
            meta={pnl ? `${formatCurrency(pnl.positionsValueUsd)} exposés` : `${readyAssets} actifs prêts`}
            tone="indigo"
          />
          <SummaryCell
            label="P&L"
            value={pnl ? formatCurrency(strategyPnlUsd ?? 0) : "--"}
            meta={pnl ? `réalisé ${formatCurrency(pnl.realizedPnlUsd)} · latent ${formatCurrency(pnl.unrealizedPnlUsd)}` : "réalisé + latent"}
            tone={pnl && (strategyPnlUsd ?? 0) >= 0 ? "cyan" : "rose"}
          />
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        {assets.map((asset) => {
          const mode = !asset.config.enableTrading ? "off" : asset.config.shadowMode ? "shadow" : "live";
          const best = asset.bestOpportunity;
          const theme = ASSET_THEMES[asset.asset];
          const feedReadyCount = asset.feedHealth.filter((feed) => feed.feedStatus === "ready").length;
          return (
            <Link
              key={asset.asset}
              href={`/${asset.asset}`}
              className="rounded-[28px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 transition hover:border-white/20 hover:bg-[#10141d]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <span className={`rounded-full border px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] ${theme.badge}`}>
                      {asset.asset.toUpperCase()}
                    </span>
                    <StatusPill tone={getModeTone(mode)}>{mode}</StatusPill>
                    <StatusPill tone={getReadinessTone(asset.workerState.readinessStatus)}>
                      {asset.workerState.readinessStatus}
                    </StatusPill>
                  </div>
                  <div className="mt-2 text-lg text-white">{asset.slot.label}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-mist/70">
                    slot `{asset.slot.key}` · feeds {feedReadyCount}/{asset.feedHealth.length} ready
                    <span className="text-[10px] uppercase tracking-[0.18em] text-mist/45">{asset.workerState.phase}</span>
                  </div>
                </div>
                <div className="rounded-[22px] border border-white/6 bg-white/[0.02] px-4 py-3 text-right">
                  <div className="font-mono text-[34px] leading-none text-white">
                    {formatCountdown(asset.slot.secondsRemaining)}
                  </div>
                  <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-mist/60">
                    fin du créneau
                  </div>
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-4">
                <MiniStat label="Mode" value={mode} tone={getModeTone(mode)} />
                <MiniStat label="Readiness" value={asset.workerState.readinessStatus} tone={getReadinessTone(asset.workerState.readinessStatus)} />
                <MiniStat
                  label="Breakers"
                  value={String(asset.activeBreakers.length)}
                  tone={asset.activeBreakers.length > 0 ? "rose" : "emerald"}
                />
              </div>

              <div className="mt-4 rounded-[20px] border border-white/6 bg-white/[0.02] px-4 py-4 text-sm text-mist">
                {best ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-white">{best.label}</div>
                      <StatusPill tone={best.eligible ? "emerald" : "amber"}>
                        {best.eligible ? "eligible" : "watch"}
                      </StatusPill>
                    </div>
                    <div className={theme.text}>signal prêt pour revue du slot</div>
                    <div className="text-sm text-white/80">
                      brut live {formatPrice(best.grossCost, 3)} · seuil {formatPrice(asset.config.grossEntryThreshold, 3)}
                    </div>
                  </div>
                ) : (
                  "Aucune opportunité calculée pour ce créneau."
                )}
              </div>
            </Link>
          );
        })}
      </section>
    </div>
  );
}

function SummaryCell({
  label,
  value,
  meta,
  tone = "default",
}: {
  label: string;
  value: string;
  meta?: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded-[24px] border border-white/6 bg-white/[0.02] px-4 py-4">
      <div className="text-[11px] uppercase tracking-[0.18em] text-mist/65">{label}</div>
      <div className="mt-3 font-mono text-[34px] leading-none text-white">{value}</div>
      {meta ? <div className="mt-2 text-xs text-mist/60">{meta}</div> : null}
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded-[18px] border border-white/6 bg-white/[0.02] px-3 py-3">
      <div className="text-[11px] uppercase tracking-[0.16em] text-mist/60">{label}</div>
      <div className="mt-2 text-sm text-white">{value}</div>
    </div>
  );
}

function StatusPill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`rounded-full border px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] ${getPillToneClass(tone)}`}>{children}</span>;
}

function getModeTone(mode: "off" | "shadow" | "live"): Tone {
  return mode === "off" ? "amber" : mode === "shadow" ? "indigo" : "cyan";
}

function getReadinessTone(status: ReadinessStatus): Tone {
  return status === "ready" ? "emerald" : status === "degraded" ? "amber" : "rose";
}

function getPillToneClass(tone: Tone) {
  switch (tone) {
    case "cyan":
      return "border-cyan/20 bg-cyan/10 text-cyan";
    case "amber":
      return "border-amber/20 bg-amber/10 text-amber";
    case "rose":
      return "border-rose/20 bg-rose/10 text-rose";
    case "emerald":
      return "border-emerald-400/20 bg-emerald-400/10 text-emerald-300";
    case "indigo":
      return "border-indigo-400/20 bg-indigo-400/10 text-indigo-200";
    default:
      return "border-white/8 bg-white/[0.03] text-mist";
  }
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
