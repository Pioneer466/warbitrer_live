"use client";

import { formatCurrency, formatDateTime } from "@/lib/format";
import type { StablePnlChange } from "@/lib/types";

export function StablePnlChangesPanel({
  changes,
  title = "Évolution P&L Stable",
  meta,
  showAsset = false,
}: {
  changes: StablePnlChange[];
  title?: string;
  meta?: string;
  showAsset?: boolean;
}) {
  return (
    <section className="rounded-[28px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 sm:px-6">
      <div className="flex flex-col gap-2 border-b border-white/6 pb-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="text-sm text-white">{title}</div>
        {meta ? <div className="text-xs text-mist/70">{meta}</div> : null}
      </div>

      <div className="mt-4 grid gap-3">
        {changes.length === 0 ? (
          <div className="rounded-[22px] border border-white/6 bg-white/[0.02] px-4 py-8 text-center text-sm text-mist/70">
            Aucun trade settled.
          </div>
        ) : (
          changes.map((change) => (
            <div key={change.intentId} className="rounded-[18px] border border-white/6 bg-white/[0.02] px-3 py-3 text-sm text-mist">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="text-white">
                    {showAsset ? `${change.asset.toUpperCase()} · ` : ""}
                    {formatCombination(change.combination)}
                  </div>
                  <div className="mt-1 text-xs text-mist/60">{formatDateTime(change.changedAt)}</div>
                </div>
                <div className={`font-mono text-lg leading-none ${change.realizedPnlUsd >= 0 ? "text-emerald-300" : "text-rose"}`}>
                  {formatCurrency(change.realizedPnlUsd)}
                </div>
              </div>
              <div className="mt-3 grid gap-2 text-xs text-mist/70 sm:grid-cols-3">
                <div>Cumul {formatCurrency(change.cumulativeRealizedPnlUsd)}</div>
                <div>DD {formatCurrency(change.drawdownUsd)}</div>
                <div>ROI {change.roi === null ? "--" : `${(change.roi * 100).toFixed(2)}%`}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function formatCombination(combination: StablePnlChange["combination"]) {
  if (combination === "POLY_UP_KALSHI_NO") {
    return "Poly UP · Kalshi NO";
  }

  if (combination === "POLY_DOWN_KALSHI_YES") {
    return "Poly DOWN · Kalshi YES";
  }

  return combination;
}
