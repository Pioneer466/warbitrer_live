"use client";

import { useState } from "react";

import { usePollingJson } from "@/components/use-polling-json";
import type { MarketAsset, StrategyConfig } from "@/lib/types";

export function TradingToggle({ asset }: { asset: MarketAsset }) {
  const settings = usePollingJson<StrategyConfig>(`/api/settings/${asset}`, 2_000);
  const [busy, setBusy] = useState(false);

  if (!settings.data) {
    return (
      <div className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-mist/70">
        trading --
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
    <div className="flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] p-1">
      <span className="pl-3 text-[11px] uppercase tracking-[0.18em] text-mist/65">Trading</span>
      <button
        type="button"
        onClick={() => updateTrading("off")}
        disabled={busy}
        aria-pressed={mode === "off"}
        className={`rounded-full px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${
          mode !== "off"
            ? "text-mist/55 hover:text-white"
            : "border border-white/8 bg-[#07090e] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
        }`}
      >
        Off
      </button>
      <button
        type="button"
        onClick={() => updateTrading("shadow")}
        disabled={busy}
        aria-pressed={mode === "shadow"}
        className={`rounded-full px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${
          mode === "shadow"
            ? "border border-indigo/25 bg-[linear-gradient(180deg,rgba(146,160,255,0.28),rgba(146,160,255,0.12))] text-indigo-200 shadow-[0_0_18px_rgba(146,160,255,0.22)]"
            : "text-mist/55 hover:text-white"
        }`}
      >
        Shadow
      </button>
      <button
        type="button"
        onClick={() => updateTrading("live")}
        disabled={busy}
        aria-pressed={mode === "live"}
        className={`rounded-full px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${
          mode === "live"
            ? "border border-cyan/25 bg-[linear-gradient(180deg,rgba(28,231,207,0.28),rgba(28,231,207,0.12))] text-cyan shadow-[0_0_18px_rgba(28,231,207,0.22)]"
            : "text-mist/55 hover:text-white"
        }`}
      >
        Live
      </button>
    </div>
  );
}
