"use client";

import Link from "next/link";

import { usePollingJson } from "@/components/use-polling-json";
import { formatCountdown, formatCurrency, formatPrice } from "@/lib/format";
import type { PortfolioDashboardResponse } from "@/lib/types";

export function PortfolioClient() {
  const portfolio = usePollingJson<PortfolioDashboardResponse>("/api/dashboard", 1_000);

  if (portfolio.loading && !portfolio.data) {
    return <PanelMessage title="Chargement" message="Connexion au portefeuille multi-actifs." />;
  }

  if (!portfolio.data) {
    return <PanelMessage title="Erreur" message={portfolio.error ?? "Aucune donnée portefeuille."} tone="rose" />;
  }

  const { assets, pnl, venueBalances, activeBreakers } = portfolio.data;

  return (
    <div className="space-y-5">
      <section className="rounded-[32px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 shadow-[0_20px_60px_rgba(0,0,0,0.22)] sm:px-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SummaryCell label="Equity" value={pnl ? formatCurrency(pnl.equityUsd) : "--"} />
          <SummaryCell label="Cash" value={pnl ? formatCurrency(pnl.cashUsd) : "--"} />
          <SummaryCell label="Balances" value={String(venueBalances.length)} meta="état compte global" />
          <SummaryCell label="Breakers" value={String(activeBreakers.length)} meta="globaux + asset" />
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        {assets.map((asset) => {
          const mode = !asset.config.enableTrading ? "off" : asset.config.shadowMode ? "shadow" : "live";
          const best = asset.bestOpportunity;
          return (
            <Link
              key={asset.asset}
              href={`/${asset.asset}`}
              className="rounded-[28px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 transition hover:border-white/20 hover:bg-[#10141d]"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.24em] text-mist/70">
                    {asset.asset.toUpperCase()} 15m
                  </div>
                  <div className="mt-2 text-lg text-white">{asset.slot.label}</div>
                  <div className="mt-1 text-sm text-mist/70">
                    phase `{asset.workerState.phase}` · readiness `{asset.workerState.readinessStatus}`
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-[34px] leading-none text-white">
                    {formatCountdown(asset.slot.secondsRemaining)}
                  </div>
                  <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-mist/60">
                    fin du créneau
                  </div>
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <MiniStat label="Mode" value={mode} />
                <MiniStat label="Breakers" value={String(asset.activeBreakers.length)} />
                <MiniStat
                  label="Meilleur brut"
                  value={best?.grossCost !== null && best?.grossCost !== undefined ? formatPrice(best.grossCost, 3) : "--"}
                />
              </div>

              <div className="mt-4 rounded-[20px] border border-white/6 bg-white/[0.02] px-4 py-4 text-sm text-mist">
                {best
                  ? `${best.label} · net ${best.projectedNetProfitUsd === null ? "--" : formatCurrency(best.projectedNetProfitUsd)}`
                  : "Aucune opportunité calculée pour ce créneau."}
              </div>
            </Link>
          );
        })}
      </section>
    </div>
  );
}

function SummaryCell({ label, value, meta }: { label: string; value: string; meta?: string }) {
  return (
    <div className="rounded-[24px] border border-white/6 bg-white/[0.02] px-4 py-4">
      <div className="text-[11px] uppercase tracking-[0.18em] text-mist/65">{label}</div>
      <div className="mt-3 font-mono text-[34px] leading-none text-white">{value}</div>
      {meta ? <div className="mt-2 text-xs text-mist/60">{meta}</div> : null}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[18px] border border-white/6 px-3 py-3">
      <div className="text-[11px] uppercase tracking-[0.16em] text-mist/60">{label}</div>
      <div className="mt-2 text-sm text-white">{value}</div>
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
