"use client";

import { useState } from "react";

import { Chip, PageSection, SectionLabel, Surface, V2EmptyState } from "@/components/v2-ui";
import { usePollingJson } from "@/components/use-polling-json";
import { formatCurrency, formatPrice } from "@/lib/format";
import { ACTIVE_MARKET_ASSETS } from "@/lib/market-catalog";
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
  const groupedMarkets = ACTIVE_MARKET_ASSETS
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
    <div className="flex flex-col gap-7">
      <PageSection watermark="REC">
        <Surface glow>
          <div className="grid gap-px bg-[var(--wa-gold-border)] xl:grid-cols-2">
            <div className="bg-[var(--wa-bg1)] px-5 py-5 sm:px-6">
              <div className="mb-2 text-[10px] uppercase tracking-[0.24em] text-[rgba(201,168,100,0.50)]">Kill Switch</div>
              <div className="text-sm text-[var(--wa-ivory)]">
                {globalBreakerActive ? "Global actif: aucun nouvel ordre live." : "Global inactif."}
              </div>
              <button
                type="button"
                onClick={toggleKillSwitch}
                disabled={busy === "kill-switch"}
                className={`mt-4 rounded border px-4 py-2 text-xs uppercase tracking-[0.16em] transition disabled:opacity-50 ${
                  globalBreakerActive
                    ? "border-[rgba(232,80,106,0.28)] bg-[rgba(232,80,106,0.09)] text-[var(--wa-rose)]"
                    : "border-[rgba(30,216,126,0.28)] bg-[rgba(30,216,126,0.09)] text-[var(--wa-emerald)]"
                }`}
              >
                {globalBreakerActive ? "release" : "engage"}
              </button>
            </div>

            <div className="bg-[var(--wa-bg1)] px-5 py-5 text-sm text-[var(--wa-mist)] sm:px-6">
              <div className="mb-2 text-[10px] uppercase tracking-[0.24em] text-[rgba(201,168,100,0.50)]">Settlement</div>
              <div className="text-[var(--wa-ivory)]">Polymarket: redeem ou merge manuel/direct selon le wallet.</div>
              <div className="mt-2">Signature type: {recoveryData.signatureType}</div>
              <div className="mt-1">Kalshi: settlement automatique, aucun claim manuel requis.</div>
            </div>
          </div>

          {actionMessage ? <div className="border-t border-[var(--wa-gold-border)] px-5 py-4 text-sm text-[var(--wa-mist)] sm:px-6">{actionMessage}</div> : null}
          {manualTx ? (
            <div className="border-t border-[var(--wa-gold-border)] px-5 py-4 text-sm text-[var(--wa-mist)] sm:px-6">
              <div className="text-[var(--wa-ivory)]">Transaction manuelle preparee</div>
              <div className="mt-2">operation: {manualTx.operation ?? "redeem"}</div>
              {manualTx.amount ? <div className="mt-1">amount: {manualTx.amount}</div> : null}
              <div className="mt-2">to: {manualTx.to}</div>
              <div className="mt-1">conditionId: {manualTx.conditionId}</div>
              <div className="mt-1">indexSets: {manualTx.indexSets.join(", ")}</div>
              <div className="mt-2 break-all font-mono text-xs text-[var(--wa-dim)]">{manualTx.data}</div>
            </div>
          ) : null}
        </Surface>
      </PageSection>

      <section>
        <SectionLabel>Validation Wallet</SectionLabel>
        <Surface>
          <div className="border-b border-[var(--wa-gold-border)] px-5 py-4 text-sm text-[var(--wa-mist)] sm:px-6">
            <div className="text-[var(--wa-ivory)]">
              {recoveryData.walletValidation.canDirectConversion
                ? "Configuration wallet complete pour une conversion directe."
                : "Configuration wallet incomplete. Le mode manuel reste disponible tant que les pre-requis ne sont pas tous valides."}
            </div>
            <div className="mt-1 text-[11px] text-[var(--wa-dim)]">
              Verification du wallet Polymarket pour conversion directe, EOA on-chain ou proxy via relayer gasless.
            </div>
          </div>
          <div className="grid gap-px bg-[var(--wa-gold-border)]">
            {recoveryData.walletValidation.checks.map((check) => (
              <div key={check.key} className="bg-[var(--wa-bg1)] px-5 py-4 text-sm text-[var(--wa-mist)] sm:px-6">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[var(--wa-ivory)]">{check.label}</div>
                  <Chip tone={check.status === "ready" ? "emerald" : check.status === "blocked" ? "rose" : "amber"}>{check.status}</Chip>
                </div>
                <div className="mt-2">{check.details}</div>
              </div>
            ))}
          </div>
        </Surface>
      </section>

      <section>
        <SectionLabel right={`${recoveryData.markets.length} marchés`}>Recup Polymarket</SectionLabel>
        <Surface>
          {recoveryData.markets.length === 0 ? (
            <V2EmptyState message="Aucune position Polymarket reclaimable ou mergeable pour l’instant" />
          ) : (
            <div className="grid gap-px bg-[var(--wa-gold-border)]">
              {groupedMarkets.map((group) => (
                <div key={group.asset} className="bg-[var(--wa-bg1)]">
                  <div className="flex items-center justify-between gap-3 border-b border-[var(--wa-gold-border)] px-5 py-4 sm:px-6">
                    <div>
                      <div className="font-mono text-xl text-[var(--wa-gold)]">{group.asset.toUpperCase()}</div>
                      <div className="mt-1 text-sm text-[var(--wa-mist)]">{group.markets.length} marché(s) récupérable(s)</div>
                    </div>
                  </div>

                  {group.markets.map((market) => (
                    <div key={market.marketRef} className="border-b border-[var(--wa-gold-border)] px-5 py-4 last:border-b-0 sm:px-6">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                          <div className="text-sm text-[var(--wa-ivory)]">{market.title}</div>
                          <div className="mt-1 font-mono text-[10px] text-[var(--wa-dim)]">
                            {market.conditionId} {market.url ? "· lien marche disponible" : ""}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {market.redeemable ? <Chip tone="emerald">redeemable</Chip> : null}
                          {market.mergeable ? <Chip tone="amber">mergeable</Chip> : null}
                          <Chip tone={market.directConversionSupported ? "emerald" : "mist"}>
                            {market.directConversionSupported ? "direct" : "manual"}
                          </Chip>
                        </div>
                      </div>

                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        {market.outcomes.map((outcome) => (
                          <div key={outcome.outcome} className="rounded border border-[var(--wa-gold-border)] bg-[var(--wa-bg0)] px-3 py-3 text-sm text-[var(--wa-mist)]">
                            <div className="font-mono text-[var(--wa-ivory)]">{outcome.outcome}</div>
                            <div className="mt-2">
                              size {formatPrice(outcome.size, 2)} · valeur {formatCurrency(outcome.currentValueUsd)}
                            </div>
                          </div>
                        ))}
                      </div>

                      {market.notes.length > 0 ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {market.notes.map((note) => (
                            <span key={note} className="rounded border border-[var(--wa-gold-border)] bg-[rgba(201,168,100,0.06)] px-3 py-1 text-xs text-[var(--wa-mist)]">
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
                            className="rounded border border-[rgba(30,216,126,0.28)] bg-[rgba(30,216,126,0.09)] px-4 py-2 text-xs uppercase tracking-[0.16em] text-[var(--wa-emerald)] transition disabled:opacity-50"
                          >
                            {formatConversionLabel(market)}
                          </button>
                        ) : null}
                        {market.url ? (
                          <a
                            href={market.url}
                            target="_blank"
                            rel="noreferrer"
                            className="rounded border border-[var(--wa-gold-border)] bg-[rgba(201,168,100,0.06)] px-4 py-2 text-xs uppercase tracking-[0.16em] text-[var(--wa-mist)] transition hover:text-[var(--wa-ivory)]"
                          >
                            open market
                          </a>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </Surface>
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
    <Surface className={tone === "rose" ? "border-[rgba(232,80,106,0.28)]" : ""}>
      <div className={`px-5 py-6 text-sm ${tone === "rose" ? "text-[var(--wa-rose)]" : "text-[var(--wa-mist)]"}`}>
      <div className="text-[var(--wa-ivory)]">{title}</div>
      <div className="mt-2">{message}</div>
      </div>
    </Surface>
  );
}
