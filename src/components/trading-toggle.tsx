"use client";

import { useState } from "react";

import { usePollingJson } from "@/components/use-polling-json";
import type { MarketAsset, MismatchRiskMode, StrategyConfig } from "@/lib/types";

export function TradingToggle({ asset }: { asset: MarketAsset }) {
  const settings = usePollingJson<StrategyConfig>(`/api/settings/${asset}`, 2_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!settings.data) {
    return (
      <div className="rounded border border-[var(--wa-gold-border)] bg-[var(--wa-bg0)] px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-[var(--wa-mist)]">
        {asset.toUpperCase()} --
      </div>
    );
  }

  const currentSettings = settings.data;
  const { enableTrading, shadowMode } = currentSettings;
  const mode = !enableTrading ? "off" : shadowMode ? "shadow" : "live";

  async function writeSettings(nextSettings: StrategyConfig) {
    setBusy(true);
    setError(null);
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
    } catch (writeError) {
      const message = writeError instanceof Error ? writeError.message : "Mise à jour impossible";
      setError(message);
      console.error("[asset-mode-controls] update failed", writeError);
    } finally {
      setBusy(false);
    }
  }

  function updateTrading(nextMode: "off" | "shadow" | "live") {
    if (busy || nextMode === mode) {
      return;
    }

    const nextSettings =
      nextMode === "off"
        ? {
            ...currentSettings,
            enableTrading: false,
            shadowMode: true,
          }
        : nextMode === "shadow"
          ? {
              ...currentSettings,
              enableTrading: true,
              shadowMode: true,
            }
          : {
              ...currentSettings,
              enableTrading: true,
              shadowMode: false,
            };

    void writeSettings(nextSettings);
  }

  function updateMismatchRiskMode(nextMode: MismatchRiskMode) {
    if (busy || nextMode === currentSettings.mismatchRiskMode) {
      return;
    }

    if (
      nextMode === "enforce" &&
      !window.confirm(
        "Activer risk enforce ? Le modèle actuel est non calibré et les nouvelles entrées seront bloquées tant qu'il le restera.",
      )
    ) {
      return;
    }

    void writeSettings({
      ...currentSettings,
      mismatchRiskMode: nextMode,
    });
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-1 sm:w-auto">
      <div className="grid grid-cols-3 overflow-hidden rounded border border-[var(--wa-gold-border)] bg-[var(--wa-bg0)]">
        <ModeButton
          active={mode === "off"}
          busy={busy}
          label={`${asset.toUpperCase()} Off`}
          tone="amber"
          onClick={() => updateTrading("off")}
        />
        <ModeButton
          active={mode === "shadow"}
          busy={busy}
          label={`${asset.toUpperCase()} Shadow`}
          tone="indigo"
          onClick={() => updateTrading("shadow")}
          bordered
        />
        <ModeButton
          active={mode === "live"}
          busy={busy}
          label={`${asset.toUpperCase()} Live`}
          tone="emerald"
          onClick={() => updateTrading("live")}
        />
      </div>

      <div className="grid grid-cols-3 overflow-hidden rounded border border-[var(--wa-gold-border)] bg-[var(--wa-bg0)]">
        <ModeButton
          active={currentSettings.mismatchRiskMode === "shadow"}
          busy={busy}
          label="Risk Shadow"
          tone="indigo"
          onClick={() => updateMismatchRiskMode("shadow")}
        />
        <ModeButton
          active={currentSettings.mismatchRiskMode === "block_only"}
          busy={busy}
          label="Risk Block"
          tone="amber"
          onClick={() => updateMismatchRiskMode("block_only")}
          bordered
        />
        <ModeButton
          active={currentSettings.mismatchRiskMode === "enforce"}
          busy={busy}
          label="Risk Enforce"
          tone="rose"
          onClick={() => updateMismatchRiskMode("enforce")}
        />
      </div>

      {error ? <div className="max-w-[360px] text-[10px] text-[var(--wa-rose)]">{error}</div> : null}
    </div>
  );
}

function ModeButton({
  active,
  busy,
  label,
  tone,
  onClick,
  bordered = false,
}: {
  active: boolean;
  busy: boolean;
  label: string;
  tone: "amber" | "indigo" | "emerald" | "rose";
  onClick: () => void;
  bordered?: boolean;
}) {
  const activeClass = {
    amber: "bg-[rgba(245,184,74,0.10)] text-[var(--wa-amber)] shadow-[inset_0_1px_0_rgba(245,184,74,0.10)]",
    indigo: "bg-[rgba(138,159,255,0.12)] text-[var(--wa-indigo)] shadow-[inset_0_1px_0_rgba(138,159,255,0.10)]",
    emerald: "bg-[rgba(30,216,126,0.13)] text-[var(--wa-emerald)] shadow-[inset_0_1px_0_rgba(30,216,126,0.12)]",
    rose: "bg-[rgba(232,80,106,0.12)] text-[var(--wa-rose)] shadow-[inset_0_1px_0_rgba(232,80,106,0.10)]",
  }[tone];

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-pressed={active}
      className={`${bordered ? "border-x border-[var(--wa-gold-border)]" : ""} min-w-0 whitespace-nowrap px-3 py-2 font-mono text-[9px] uppercase tracking-[0.12em] transition disabled:opacity-50 ${
        active ? activeClass : "text-[var(--wa-dim)] hover:text-[var(--wa-ivory)]"
      }`}
    >
      {label}
    </button>
  );
}
