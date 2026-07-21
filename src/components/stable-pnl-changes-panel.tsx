"use client";

import { formatCurrency, formatDateTime } from "@/lib/format";
import type { StablePnlChange } from "@/lib/types";

const STABLE_CHANGE_WINDOW_MS = 15 * 60 * 1000;
const STABLE_CHANGE_VISIBLE_WINDOWS = 5;

export function StablePnlChangesPanel({
  changes,
  title = "Évolution Drawdown Stable",
  meta,
  showAsset = false,
}: {
  changes: StablePnlChange[];
  title?: string;
  meta?: string;
  showAsset?: boolean;
}) {
  const groupedChanges = compactStableChangesByWindow(changes).slice(0, STABLE_CHANGE_VISIBLE_WINDOWS);

  return (
    <section className="rounded-[28px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 sm:px-6">
      <div className="flex flex-col gap-2 border-b border-white/6 pb-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="text-sm text-white">{title}</div>
        {meta ? <div className="text-xs text-mist/70">{meta}</div> : null}
      </div>

      <div className="mt-4 grid gap-3">
        {groupedChanges.length === 0 ? (
          <div className="rounded-[22px] border border-white/6 bg-white/[0.02] px-4 py-8 text-center text-sm text-mist/70">
            Aucun point stable enregistré.
          </div>
        ) : (
          groupedChanges.map(({ latest: change, assets, count, windowStart }) => (
            <div
              key={change.intentId}
              className="rounded-[18px] border border-white/6 bg-white/[0.02] px-3 py-3 text-sm text-mist"
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.16em] text-mist/60">Drawdown Stable</div>
                  <div className="mt-2 text-white">
                    {showAsset ? `${change.asset.toUpperCase()} · ` : ""}
                    {formatCombination(change.combination)}
                  </div>
                  <div className="mt-1 text-xs text-mist/60">{formatDateTime(change.changedAt)}</div>
                  {count > 1 ? (
                    <div className="mt-2 text-xs text-mist/70">
                      Fenêtre {formatDateTime(windowStart)} · trades{" "}
                      {assets.map((asset) => asset.toUpperCase()).join(" · ")}
                    </div>
                  ) : null}
                </div>
                <div
                  className={`font-mono text-[30px] leading-none ${change.drawdownUsd >= 0 ? "text-emerald-300" : "text-rose"}`}
                >
                  {formatCurrency(change.drawdownUsd)}
                </div>
              </div>
              <div className="mt-3 grid gap-2 text-xs text-mist/70 sm:grid-cols-4">
                <div>Delta {formatCurrency(change.accountDeltaUsd)}</div>
                <div>Equity {formatCurrency(change.equityUsd)}</div>
                <div>Trade {formatCurrency(change.realizedPnlUsd)}</div>
                <div>ROI {change.roi === null ? "--" : `${(change.roi * 100).toFixed(2)}%`}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function compactStableChangesByWindow(changes: StablePnlChange[]) {
  const groups = new Map<
    number,
    {
      latest: StablePnlChange;
      assets: StablePnlChange["asset"][];
      count: number;
      windowStart: number;
    }
  >();

  for (const change of changes) {
    const windowStart = Math.floor(change.changedAt / STABLE_CHANGE_WINDOW_MS) * STABLE_CHANGE_WINDOW_MS;
    const existing = groups.get(windowStart);

    if (!existing) {
      groups.set(windowStart, {
        latest: change,
        assets: [change.asset],
        count: 1,
        windowStart,
      });
      continue;
    }

    existing.count += 1;
    if (!existing.assets.includes(change.asset)) {
      existing.assets.push(change.asset);
    }
    if (change.changedAt > existing.latest.changedAt) {
      existing.latest = change;
    }
  }

  return [...groups.values()].sort((left, right) => right.latest.changedAt - left.latest.changedAt);
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
