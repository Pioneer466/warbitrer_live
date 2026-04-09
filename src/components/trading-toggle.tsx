"use client";

import { useState } from "react";

import { usePollingJson } from "@/components/use-polling-json";
import type { StrategyConfig } from "@/lib/types";

export function TradingToggle() {
  const settings = usePollingJson<StrategyConfig>("/api/settings", 2_000);
  const [busy, setBusy] = useState(false);

  if (!settings.data) {
    return (
      <div className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-mist/70">
        trading --
      </div>
    );
  }

  const { enableTrading } = settings.data;

  async function updateTrading(nextEnabled: boolean) {
    if (busy || nextEnabled === enableTrading) {
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...settings.data,
          enableTrading: nextEnabled,
        }),
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
        onClick={() => updateTrading(false)}
        disabled={busy}
        aria-pressed={!enableTrading}
        className={`rounded-full px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${
          enableTrading
            ? "text-mist/55 hover:text-white"
            : "border border-white/8 bg-[#07090e] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
        }`}
      >
        Off
      </button>
      <button
        type="button"
        onClick={() => updateTrading(true)}
        disabled={busy}
        aria-pressed={enableTrading}
        className={`rounded-full px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${
          enableTrading
            ? "border border-cyan/25 bg-[linear-gradient(180deg,rgba(28,231,207,0.28),rgba(28,231,207,0.12))] text-cyan shadow-[0_0_18px_rgba(28,231,207,0.22)]"
            : "text-mist/55 hover:text-white"
        }`}
      >
        On
      </button>
    </div>
  );
}
