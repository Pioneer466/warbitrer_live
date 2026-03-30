"use client";

import { useState } from "react";

type ResetPaperButtonProps = {
  className?: string;
};

export function ResetPaperButton({ className = "" }: ResetPaperButtonProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReset() {
    if (pending) {
      return;
    }

    const confirmed = window.confirm(
      "Réinitialiser le paper trading ? Cela efface les trades, snapshots, P&L et le capital simulé.",
    );

    if (!confirmed) {
      return;
    }

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/reset-paper", {
        method: "POST",
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }

      window.location.reload();
    } catch (caughtError) {
      setPending(false);
      setError(caughtError instanceof Error ? caughtError.message : "Reset impossible");
    }
  }

  return (
    <div className={`flex flex-col items-end gap-2 ${className}`.trim()}>
      <button
        type="button"
        onClick={handleReset}
        disabled={pending}
        className="rounded-full border border-white/10 px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] text-mist transition hover:border-white/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Reset..." : "Réinitialiser"}
      </button>
      {error ? <div className="text-[11px] text-rose">{error}</div> : null}
    </div>
  );
}
