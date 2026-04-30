"use client";

import { useState } from "react";

import { usePollingJson } from "@/components/use-polling-json";
import type { MarketAsset, StrategyConfig } from "@/lib/types";

export function TradingToggle({ asset }: { asset: MarketAsset }) {
  const settings = usePollingJson<StrategyConfig>(`/api/settings/${asset}`, 2_000);
  const [busy, setBusy] = useState(false);

  if (!settings.data) {
    return (
      <div className="rounded border border-[var(--wa-gold-border)] bg-[var(--wa-bg0)] px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-[var(--wa-mist)]">
        {asset.toUpperCase()} --
      </div>
    );
  }

  const { enableTrading, shadowMode } = settings.data;
  const mode = !enableTrading ? "off" : shadowMode ? "shadow" : "live";

  async function updateTrading(nextMode: "off" | "shadow" | "live") {
    if (busy || nextMode === mode) {
      return;
    }

    const nextSettings =
      nextMode === "off"
        ? {
            ...settings.data,
            enableTrading: false,
            shadowMode: true,
          }
        : nextMode === "shadow"
          ? {
              ...settings.data,
              enableTrading: true,
              shadowMode: true,
            }
          : {
              ...settings.data,
              enableTrading: true,
              shadowMode: false,
            };

    setBusy(true);
    try {
      const response = await fetch(`/api/settings/${asset}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(nextSettings),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }
    } catch (error) {
      console.error("[trading-toggle] update failed", error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-3 overflow-hidden rounded border border-[var(--wa-gold-border)] bg-[var(--wa-bg0)]">
      <button
        type="button"
        onClick={() => updateTrading("off")}
        disabled={busy}
        aria-pressed={mode === "off"}
        className={`border-r border-[var(--wa-gold-border)] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${
          mode !== "off"
            ? "text-[var(--wa-dim)] hover:text-[var(--wa-ivory)]"
            : "bg-[rgba(245,184,74,0.10)] text-[var(--wa-amber)] shadow-[inset_0_1px_0_rgba(245,184,74,0.10)]"
        }`}
      >
        {asset.toUpperCase()} Off
      </button>
      <button
        type="button"
        onClick={() => updateTrading("shadow")}
        disabled={busy}
        aria-pressed={mode === "shadow"}
        className={`border-r border-[var(--wa-gold-border)] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${
          mode === "shadow"
            ? "bg-[rgba(138,159,255,0.12)] text-[var(--wa-indigo)] shadow-[inset_0_1px_0_rgba(138,159,255,0.10)]"
            : "text-[var(--wa-dim)] hover:text-[var(--wa-ivory)]"
        }`}
      >
        {asset.toUpperCase()} Shadow
      </button>
      <button
        type="button"
        onClick={() => updateTrading("live")}
        disabled={busy}
        aria-pressed={mode === "live"}
        className={`px-4 py-2 font-mono text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${
          mode === "live"
            ? "bg-[rgba(30,216,126,0.13)] text-[var(--wa-emerald)] shadow-[inset_0_1px_0_rgba(30,216,126,0.12)]"
            : "text-[var(--wa-dim)] hover:text-[var(--wa-ivory)]"
        }`}
      >
        {asset.toUpperCase()} Live
      </button>
    </div>
  );
}
