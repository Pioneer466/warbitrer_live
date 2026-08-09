"use client";

import { useState } from "react";

import { usePollingJson } from "@/components/use-polling-json";
import { resolveMismatchGuardMode } from "@/lib/mismatch-guard-mode";
import type {
  HealthResponse,
  MarketAsset,
  MismatchGuardMode,
  MismatchRiskMode,
  StrategyConfig,
  VersionedStrategyConfig,
} from "@/lib/types";

export function TradingToggle({ asset }: { asset: MarketAsset }) {
  const settings = usePollingJson<VersionedStrategyConfig>(`/api/settings/${asset}`, 2_000);
  const health = usePollingJson<HealthResponse>("/api/health", 5_000, {
    parseJsonOnNonOk: true,
    clearDataOnError: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!settings.data) {
    return (
      <div className="rounded border border-[var(--wa-gold-border)] bg-[var(--wa-bg0)] px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-[var(--wa-mist)]">
        {asset.toUpperCase()} --
      </div>
    );
  }

  const currentSettings = settings.data.config;
  const currentRevision = settings.data.revision;
  const { enableTrading, shadowMode } = currentSettings;
  const mode = !enableTrading ? "off" : shadowMode ? "shadow" : "live";
  const mismatchGuardMode = resolveMismatchGuardMode(currentSettings);
  const liveExecutionAllowed =
    health.error === null && health.data?.status === "healthy" && health.data.liveExecutionAllowed === true;

  async function writeSettings(nextSettings: StrategyConfig) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/settings/${asset}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          config: nextSettings,
          expectedRevision: currentRevision,
        }),
      });

      if (!response.ok) {
        if (response.status === 409) {
          settings.refresh();
        }
        throw new Error(await response.text());
      }
      settings.refresh();
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

    if (
      nextMode === "live" &&
      (!liveExecutionAllowed ||
        !window.confirm(
          `Activer le trading LIVE pour ${asset.toUpperCase()} ? Des ordres réels pourront être soumis immédiatement.`,
        ))
    ) {
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
        "Activer risk enforce ? Les nouvelles entrées seront bloquées si la calibration, les références ou les budgets de risque ne sont pas prêts.",
      )
    ) {
      return;
    }

    void writeSettings({
      ...currentSettings,
      mismatchRiskMode: nextMode,
    });
  }

  function updateMismatchGuardMode(nextMode: MismatchGuardMode) {
    if (busy || nextMode === mismatchGuardMode) {
      return;
    }

    if (
      nextMode === "audit" &&
      !window.confirm(
        "Passer le garde-fou mismatch en audit ? Les invariants structurels ne bloqueront plus les entrées et le live restera interdit.",
      )
    ) {
      return;
    }

    void writeSettings({
      ...currentSettings,
      mismatchGuardMode: nextMode,
      mismatchGuardEnabled: nextMode !== "audit",
    });
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-1 sm:w-auto xl:flex-row">
      <div className="grid grid-cols-3 overflow-hidden rounded border border-[var(--wa-gold-border)] bg-[var(--wa-bg0)]">
        <ModeButton active={mode === "off"} busy={busy} label="Off" tone="amber" onClick={() => updateTrading("off")} />
        <ModeButton
          active={mode === "shadow"}
          busy={busy}
          label="Shadow"
          tone="indigo"
          onClick={() => updateTrading("shadow")}
          bordered
        />
        <ModeButton
          active={mode === "live"}
          busy={busy}
          label="Live"
          tone="emerald"
          onClick={() => updateTrading("live")}
          disabled={!liveExecutionAllowed}
        />
      </div>

      <div className="grid grid-cols-3 overflow-hidden rounded border border-[var(--wa-gold-border)] bg-[var(--wa-bg0)]">
        <ModeButton
          active={mismatchGuardMode === "audit"}
          busy={busy}
          label="Guard Audit"
          tone="indigo"
          onClick={() => updateMismatchGuardMode("audit")}
        />
        <ModeButton
          active={mismatchGuardMode === "hard_only"}
          busy={busy}
          label="Guard Hard"
          tone="emerald"
          onClick={() => updateMismatchGuardMode("hard_only")}
          bordered
        />
        <ModeButton
          active={mismatchGuardMode === "legacy_enforce"}
          busy={busy}
          label="Guard Legacy"
          tone="amber"
          onClick={() => updateMismatchGuardMode("legacy_enforce")}
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
      {mode === "live" && !liveExecutionAllowed ? (
        <div className="max-w-[360px] text-[10px] text-[var(--wa-rose)]">
          Configuration live bloquée par le serveur.
        </div>
      ) : null}
    </div>
  );
}

function ModeButton({
  active,
  busy,
  label,
  tone,
  onClick,
  disabled = false,
  bordered = false,
}: {
  active: boolean;
  busy: boolean;
  label: string;
  tone: "amber" | "indigo" | "emerald" | "rose";
  onClick: () => void;
  disabled?: boolean;
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
      disabled={busy || disabled}
      aria-pressed={active}
      className={`${bordered ? "border-x border-[var(--wa-gold-border)]" : ""} min-w-0 whitespace-nowrap px-3 py-2 font-mono text-[9px] uppercase tracking-[0.12em] transition disabled:opacity-50 ${
        active ? activeClass : "text-[var(--wa-dim)] hover:text-[var(--wa-ivory)]"
      }`}
    >
      {label}
    </button>
  );
}
