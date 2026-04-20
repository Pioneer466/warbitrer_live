"use client";

import { useState } from "react";

import { usePollingJson } from "@/components/use-polling-json";
import { formatCurrency, formatPrice } from "@/lib/format";
import type { RecoveryResponse } from "@/lib/types";

export function RecoveryClient() {
  const recovery = usePollingJson<RecoveryResponse>("/api/recovery", 4_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [manualTx, setManualTx] = useState<{
    to: string;
    data: string;
    conditionId: string;
    indexSets: number[];
    amount?: string;
    operation?: "redeem" | "merge";
  } | null>(null);

  if (recovery.loading && !recovery.data) {
    return <PanelMessage title="Recuperation" message="Chargement des positions reclaimables." />;
  }

  if (!recovery.data) {
    return <PanelMessage title="Erreur" message={recovery.error ?? "Impossible de charger la page Recup."} tone="rose" />;
  }

  const recoveryData = recovery.data;
  const globalBreakerActive = recoveryData.globalKillSwitchActive;
  const groupedMarkets = (["btc", "eth"] as const)
    .map((asset) => ({
      asset,
      markets: recoveryData.markets.filter((market) => market.asset === asset),
    }))
    .filter((group) => group.markets.length > 0);

  async function toggleKillSwitch() {
    setBusy("kill-switch");
    setActionMessage(null);
    setManualTx(null);
    try {
      const response = await fetch("/api/circuit-breakers", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          key: "global",
          active: !globalBreakerActive,
          reason: "manual",
        }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      setActionMessage(globalBreakerActive ? "Kill switch global desactive." : "Kill switch global active.");
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "Impossible de modifier le kill switch.");
    } finally {
      setBusy(null);
    }
  }

  async function convert(marketRef: string) {
    setBusy(marketRef);
    setActionMessage(null);
    setManualTx(null);
    try {
      const response = await fetch("/api/recovery", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "convert",
          marketRef,
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        mode?: "direct" | "manual";
        txHash?: string | null;
        relayerTransactionId?: string;
        relayerState?: string;
        action?: "redeem" | "merge";
        amount?: string;
        reason?: string;
        error?: string;
        tx?: {
          to: string;
          data: string;
          conditionId: string;
          indexSets: number[];
          amount?: string;
          operation?: "redeem" | "merge";
        };
      };

      if (!response.ok) {
        throw new Error(payload.error ?? "Conversion impossible");
      }

      if (payload.mode === "direct" && payload.txHash) {
        const verb = payload.action === "merge" ? "Merge" : "Redeem";
        setActionMessage(
          payload.action === "merge" && payload.amount
            ? `${verb} envoye pour ${payload.amount}. Tx: ${payload.txHash}`
            : `${verb} envoye. Tx: ${payload.txHash}`,
        );
      } else if (payload.mode === "direct" && payload.relayerTransactionId) {
        const verb = payload.action === "merge" ? "Merge" : "Redeem";
        const amountSuffix = payload.action === "merge" && payload.amount ? ` pour ${payload.amount}` : "";
        const stateSuffix = payload.relayerState ? ` · ${payload.relayerState}` : "";
        setActionMessage(`${verb} envoye via relayer${amountSuffix}. Id: ${payload.relayerTransactionId}${stateSuffix}`);
      } else {
        setActionMessage(payload.reason ?? "Mode manuel requis pour ce wallet.");
        if (payload.tx) {
          setManualTx(payload.tx);
        }
      }
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "Conversion impossible");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-[32px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 shadow-[0_20px_60px_rgba(0,0,0,0.22)] sm:px-6">
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="rounded-[24px] border border-white/6 bg-white/[0.02] px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-mist/65">Kill Switch</div>
                <div className="mt-3 text-sm text-white">
                  {globalBreakerActive ? "Global active: aucun nouvel ordre live." : "Global inactif."}
                </div>
              </div>
              <button
                type="button"
                onClick={toggleKillSwitch}
                disabled={busy === "kill-switch"}
                className={`rounded-full border px-4 py-2 text-xs uppercase tracking-[0.16em] transition ${
                  globalBreakerActive
                    ? "border-rose/20 bg-rose/10 text-rose"
                    : "border-cyan/20 bg-cyan/10 text-cyan"
                } disabled:opacity-50`}
              >
                {globalBreakerActive ? "release" : "engage"}
              </button>
            </div>
          </div>

          <div className="rounded-[24px] border border-white/6 bg-white/[0.02] px-4 py-4 text-sm text-mist">
            <div className="text-[11px] uppercase tracking-[0.18em] text-mist/65">Settlement</div>
            <div className="mt-3 text-white">Polymarket: redeem ou merge manuel/direct selon le wallet.</div>
            <div className="mt-2">Signature type: {recoveryData.signatureType}</div>
            <div className="mt-1">Kalshi: settlement automatique, aucun claim manuel requis.</div>
          </div>
        </div>

        {actionMessage ? <div className="mt-4 rounded-[18px] border border-white/6 px-3 py-3 text-sm text-mist">{actionMessage}</div> : null}
        {manualTx ? (
          <div className="mt-4 rounded-[18px] border border-white/6 bg-white/[0.02] px-3 py-3 text-sm text-mist">
            <div className="text-white">Transaction manuelle preparee</div>
            <div className="mt-2">operation: {manualTx.operation ?? "redeem"}</div>
            {manualTx.amount ? <div className="mt-1">amount: {manualTx.amount}</div> : null}
            <div className="mt-2">to: {manualTx.to}</div>
            <div className="mt-1">conditionId: {manualTx.conditionId}</div>
            <div className="mt-1">indexSets: {manualTx.indexSets.join(", ")}</div>
            <div className="mt-2 break-all font-mono text-xs text-mist/80">{manualTx.data}</div>
          </div>
        ) : null}
      </section>

      <section className="rounded-[32px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 sm:px-6">
        <div className="border-b border-white/6 pb-4">
          <div className="text-sm text-white">Validation Wallet</div>
          <div className="mt-1 text-xs text-mist/70">
            Verification du wallet Polymarket pour la conversion directe, en EOA on-chain ou en proxy via relayer gasless.
          </div>
        </div>

        <div className="mt-4 rounded-[18px] border border-white/6 bg-white/[0.02] px-3 py-3 text-sm text-mist">
          {recoveryData.walletValidation.canDirectConversion
            ? "Configuration wallet complete pour une conversion directe."
            : "Configuration wallet incomplete. Le mode manuel reste disponible tant que les pre-requis ne sont pas tous valides."}
        </div>

        <div className="mt-4 grid gap-3">
          {recoveryData.walletValidation.checks.map((check) => (
            <div key={check.key} className="rounded-[18px] border border-white/6 px-3 py-3 text-sm text-mist">
              <div className="flex items-center justify-between gap-3">
                <div className="text-white">{check.label}</div>
                <Badge tone={check.status === "ready" ? "cyan" : check.status === "degraded" ? "amber" : "default"}>
                  {check.status}
                </Badge>
              </div>
              <div className="mt-2">{check.details}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-[32px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 sm:px-6">
        <div className="border-b border-white/6 pb-4">
          <div className="text-sm text-white">Recup Polymarket</div>
          <div className="mt-1 text-xs text-mist/70">
            Gains resolus a redeem en USDC.e, ou paires YES/NO a merge si presentes.
          </div>
        </div>

        <div className="mt-4 grid gap-4">
          {recoveryData.markets.length === 0 ? (
            <EmptyState message="Aucune position Polymarket reclaimable ou mergeable pour l’instant." />
          ) : (
            groupedMarkets.map((group) => (
              <div key={group.asset} className="space-y-4">
                <div className="rounded-[18px] border border-white/6 bg-white/[0.02] px-3 py-3">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-mist/65">{group.asset.toUpperCase()}</div>
                  <div className="mt-2 text-sm text-white">{group.markets.length} marché(s) récupérable(s)</div>
                </div>

                {group.markets.map((market) => (
                  <div key={market.marketRef} className="rounded-[24px] border border-white/6 bg-white/[0.02] px-4 py-4">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <div className="text-white">{market.title}</div>
                        <div className="mt-1 text-sm text-mist">
                          {market.conditionId} {market.url ? "· lien marche disponible" : ""}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {market.redeemable ? <Badge tone="cyan">redeemable</Badge> : null}
                        {market.mergeable ? <Badge tone="amber">mergeable</Badge> : null}
                        <Badge tone={market.directConversionSupported ? "cyan" : "default"}>
                          {market.directConversionSupported ? "direct" : "manual"}
                        </Badge>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      {market.outcomes.map((outcome) => (
                        <div key={outcome.outcome} className="rounded-[18px] border border-white/6 px-3 py-3 text-sm text-mist">
                          <div className="text-white">{outcome.outcome}</div>
                          <div className="mt-2">
                            size {formatPrice(outcome.size, 2)} · valeur {formatCurrency(outcome.currentValueUsd)}
                          </div>
                        </div>
                      ))}
                    </div>

                    {market.notes.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-2 text-sm text-mist">
                        {market.notes.map((note) => (
                          <span key={note} className="rounded-full border border-white/6 bg-white/[0.03] px-3 py-1">
                            {note}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    <div className="mt-4 flex flex-wrap gap-3">
                      {market.conversionAction ? (
                        <button
                          type="button"
                          onClick={() => convert(market.marketRef)}
                          disabled={busy === market.marketRef}
                          className="rounded-full border border-cyan/20 bg-cyan/10 px-4 py-2 text-xs uppercase tracking-[0.16em] text-cyan transition disabled:opacity-50"
                        >
                          {formatConversionLabel(market)}
                        </button>
                      ) : null}
                      {market.url ? (
                        <a
                          href={market.url}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-full border border-white/8 bg-white/[0.03] px-4 py-2 text-xs uppercase tracking-[0.16em] text-mist transition hover:text-white"
                        >
                          open market
                        </a>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function formatConversionLabel(market: RecoveryResponse["markets"][number]) {
  if (market.conversionAction === "merge") {
    return market.directConversionSupported ? "merge now" : "prepare merge";
  }

  return market.directConversionSupported ? "redeem now" : "prepare redeem";
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

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-[22px] border border-white/6 bg-white/[0.02] px-4 py-8 text-center text-sm text-mist/70">
      {message}
    </div>
  );
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "cyan" | "amber" | "default";
}) {
  const toneClass =
    tone === "cyan"
      ? "border-cyan/20 bg-cyan/10 text-cyan"
      : tone === "amber"
        ? "border-amber/20 bg-amber/10 text-amber"
        : "border-white/8 bg-white/[0.03] text-mist";

  return <span className={`rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.16em] ${toneClass}`}>{children}</span>;
}
