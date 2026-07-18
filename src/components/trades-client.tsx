"use client";

import { useState } from "react";

import { usePollingJson } from "@/components/use-polling-json";
import { IntentMismatchRiskDetails } from "@/components/mismatch-risk-view";
import {
  Chip,
  formatV2Usd,
  MetricCell,
  PageSection,
  SectionLabel,
  Surface,
  V2EmptyState,
  V2Expand,
  type V2Tone,
} from "@/components/v2-ui";
import { formatDateTime, formatPrice } from "@/lib/format";
import { ACTIVE_MARKET_ASSETS } from "@/lib/market-catalog";
import {
  classifySettledIntentMismatch,
  formatMismatchSettlementClassification,
  summarizeMismatchRiskAudits,
  type MismatchAuditSummary,
  type MismatchSettlementClassification,
} from "@/lib/mismatch-risk-display";
import type { LiveFill, LiveOrder, MarketAsset, OrderIntent, TradesResponse } from "@/lib/types";

const TRADE_FILTERS: Array<MarketAsset | "all"> = ["all", ...ACTIVE_MARKET_ASSETS];

type OrderGroup = {
  key: string;
  label: string;
  orders: LiveOrder[];
};

export function TradesClient() {
  const [assetFilter, setAssetFilter] = useState<MarketAsset | "all">("all");
  const [showAllFills, setShowAllFills] = useState(false);
  const { data, error, loading } = usePollingJson<TradesResponse>(`/api/trades?asset=${assetFilter}`, 4_000);

  if (loading && !data) {
    return <PanelMessage title="Flow Live" message="Chargement des intents, ordres et exécutions." />;
  }

  if (!data) {
    return <PanelMessage title="Erreur" message={error ?? "Impossible de charger le flow live."} tone="rose" />;
  }

  const intents = [...data.intents].sort((left, right) => right.createdAt - left.createdAt);
  const orders = [...data.orders].sort((left, right) => right.createdAt - left.createdAt);
  const fills = [...data.fills].sort((left, right) => right.filledAt - left.filledAt);
  const intentMap = new Map(intents.map((intent) => [intent.id, intent]));
  const successIntents = intents.filter((intent) => intent.status === "hedged" || intent.status === "settled");
  const errorIntents = intents.filter(isErrorIntent);
  const pendingIntents = intents.filter(
    (intent) => !successIntents.includes(intent) && !errorIntents.includes(intent),
  );
  const totalNotional = intents.reduce((sum, intent) => sum + deriveIntentCapitalUsd(intent), 0);
  const totalFees = fills.reduce((sum, fill) => sum + fill.feeUsd, 0);
  const visibleFills = showAllFills ? fills : fills.slice(0, 8);
  const orderGroups = groupOrdersByPair(orders, intentMap);
  const mismatchAuditSummary = summarizeMismatchRiskAudits(intents);

  return (
    <div className="flex flex-col gap-7">
      <PageSection watermark="TRD">
        <Surface glow>
          <div className="grid md:grid-cols-2 xl:grid-cols-4">
            <MetricCell label="Notionnel engagé" value={formatV2Usd(totalNotional)} tone="gold" />
            <MetricCell label="Positions ouvertes" value={String(successIntents.filter((intent) => intent.status === "hedged").length)} meta="intents hedged" />
            <MetricCell label="Trades réalisés" value={String(successIntents.filter((intent) => intent.status === "settled").length)} tone="emerald" />
            <MetricCell label="Frais payés" value={formatV2Usd(totalFees)} tone="rose" meta="fills enregistrés" />
          </div>
          <MismatchAuditSummaryStrip summary={mismatchAuditSummary} />
          <div className="flex flex-wrap gap-1 border-t border-[var(--wa-gold-border)] px-4 py-3">
            {TRADE_FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setAssetFilter(value)}
                className={`rounded border px-3 py-1.5 text-[9px] uppercase tracking-[0.18em] transition ${
                  assetFilter === value
                    ? "border-[var(--wa-gold-border-strong)] bg-[rgba(201,168,100,0.10)] text-[var(--wa-gold)]"
                    : "border-transparent text-[var(--wa-mist)] hover:border-[var(--wa-gold-border)]"
                }`}
              >
                {value}
              </button>
            ))}
          </div>
        </Surface>
      </PageSection>

      <section>
        <SectionLabel right={`${successIntents.length} réussis · ${pendingIntents.length} en cours · ${errorIntents.length} non exécutés/erreurs`}>Intents</SectionLabel>
        {intents.length === 0 ? (
          <Surface><V2EmptyState message="Aucun intent pour ce filtre" /></Surface>
        ) : (
          <div className="grid gap-3 xl:grid-cols-3">
            <IntentColumn title="Réussis" subtitle="hedged / settled" intents={successIntents} emptyMessage="Aucun trade réussi." tone="emerald" />
            <IntentColumn title="En cours" subtitle="shadow en attente / exécution" intents={pendingIntents} emptyMessage="Aucun intent en cours." tone="amber" />
            <IntentColumn title="Non exécutés / erreurs" subtitle="no fill / failed / recovery" intents={errorIntents} emptyMessage="Aucun rejet ou incident." tone="rose" />
          </div>
        )}
      </section>

      <section>
        <SectionLabel right={`${fills.length} fills`}>Exécutions</SectionLabel>
        <Surface>
          <div className="hidden grid-cols-[90px_1fr_82px_80px_80px_80px_96px] gap-3 border-b border-[var(--wa-gold-border)] bg-[var(--wa-bg0)] px-5 py-2 md:grid">
            {["Actif", "Venue · Outcome · Side", "Status", "Size", "Prix", "Fee", "Heure"].map((header) => (
              <div key={header} className="text-[8px] uppercase tracking-[0.18em] text-[rgba(201,168,100,0.38)]">{header}</div>
            ))}
          </div>
          {fills.length === 0 ? (
            <V2EmptyState message="Aucune exécution" />
          ) : (
            <>
              {visibleFills.map((fill, index) => <FillRow key={fill.id} fill={fill} intent={intentMap.get(fill.intentId) ?? null} last={index === visibleFills.length - 1 && fills.length <= 8} />)}
              {fills.length > 8 ? (
                <div className="border-t border-[var(--wa-gold-border)] px-5 py-3">
                  <V2Expand expanded={showAllFills} n={fills.length - 8} onClick={() => setShowAllFills((value) => !value)} />
                </div>
              ) : null}
            </>
          )}
        </Surface>
      </section>

      <section>
        <SectionLabel right={`${orders.length} ordres · ${orderGroups.length} groupes`}>Orders Par Pair</SectionLabel>
        {orders.length === 0 ? (
          <Surface><V2EmptyState message="Aucun ordre enregistré" /></Surface>
        ) : (
          <div className="grid gap-3">
            {orderGroups.map((group) => <OrderGroupSection key={group.key} group={group} intentsById={intentMap} />)}
          </div>
        )}
      </section>

      {error ? <PanelMessage title="Erreur" message={error} tone="rose" /> : null}
    </div>
  );
}

function IntentColumn({ title, subtitle, intents, emptyMessage, tone }: { title: string; subtitle: string; intents: OrderIntent[]; emptyMessage: string; tone: V2Tone }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? intents : intents.slice(0, 4);
  return (
    <Surface>
      <div className="flex items-center justify-between gap-3 border-b border-[var(--wa-gold-border)] px-5 py-4">
        <div className="flex items-center gap-3">
          <span className={`h-4 w-[3px] rounded ${tone === "emerald" ? "bg-[var(--wa-emerald)]" : tone === "amber" ? "bg-[var(--wa-amber)]" : "bg-[var(--wa-rose)]"}`} />
          <div>
            <div className="text-sm text-[var(--wa-ivory)]">{title}</div>
            <div className="mt-0.5 text-[9px] text-[var(--wa-dim)]">{subtitle}</div>
          </div>
        </div>
        <span className={`font-mono text-sm ${tone === "emerald" ? "text-[var(--wa-emerald)]" : tone === "amber" ? "text-[var(--wa-amber)]" : "text-[var(--wa-rose)]"}`}>{intents.length}</span>
      </div>
      {visible.length === 0 ? <V2EmptyState message={emptyMessage} /> : visible.map((intent, index) => <IntentRow key={intent.id} intent={intent} last={index === visible.length - 1 && intents.length <= 4} />)}
      {intents.length > 4 ? (
        <div className="border-t border-[var(--wa-gold-border)] px-5 py-3">
          <V2Expand expanded={expanded} n={intents.length - 4} onClick={() => setExpanded((value) => !value)} />
        </div>
      ) : null}
    </Surface>
  );
}

function MismatchAuditSummaryStrip({ summary }: { summary: MismatchAuditSummary }) {
  if (summary.auditedCount === 0 && summary.classifiedSettlementCount === 0) {
    return null;
  }

  return (
    <div className="border-t border-[var(--wa-gold-border)] bg-[var(--wa-bg0)] px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[9px] uppercase tracking-[0.20em] text-[rgba(201,168,100,0.45)]">
          Audit mismatch · intents chargés
        </span>
        {summary.auditedCount > 0 ? <Chip tone="amber">block_only · {summary.auditedCount} audités</Chip> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {summary.auditedCount > 0 ? (
          <>
            <Chip tone="rose">{summary.blockCount} auraient bloqué</Chip>
            <Chip tone="emerald">{summary.allowCount} auraient autorisé</Chip>
            {summary.failOpenCount > 0 ? <Chip tone="amber">{summary.failOpenCount} fail-open</Chip> : null}
            {summary.unavailableCount > 0 ? <Chip tone="mist">{summary.unavailableCount} sans verdict</Chip> : null}
            <Chip tone={summary.enforceNotReadyCount > 0 ? "amber" : "emerald"}>
              risk enforce prêt {summary.enforceReadyCount}/{summary.auditedCount}
            </Chip>
          </>
        ) : null}
        {summary.classifiedSettlementCount > 0 ? (
          <>
            <Chip tone="rose">{summary.fatalMismatchCount} mismatch fatal</Chip>
            <Chip tone="gold">{summary.doublePayoutCount} double payout</Chip>
            <Chip tone="emerald">{summary.alignedSettlementCount} alignés</Chip>
          </>
        ) : null}
      </div>
    </div>
  );
}

function IntentRow({ intent, last }: { intent: OrderIntent; last: boolean }) {
  const settlement = deriveSettlementSummary(intent);

  return (
    <div className={`px-5 py-4 text-sm ${last ? "" : "border-b border-[var(--wa-gold-border)]"}`}>
      <div className="mb-1 flex items-start justify-between gap-3">
        <div className="font-mono text-[var(--wa-ivory)]">{intent.asset.toUpperCase()} · {intent.combination}</div>
        <Chip tone={getIntentTone(intent)}>{intent.status}</Chip>
      </div>
      <div className="mb-3 text-[11px] text-[var(--wa-mist)]">
        {formatDateTime(intent.createdAt)} · {intent.primaryVenue} → {intent.hedgeVenue} · notionnel {formatV2Usd(deriveIntentCapitalUsd(intent))}
      </div>
      {settlement ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {settlement.classification ? (
            <Chip tone={getSettlementClassificationTone(settlement.classification)}>
              {formatMismatchSettlementClassification(settlement.classification)}
            </Chip>
          ) : (
            <Chip tone={settlement.aligned === null ? "mist" : settlement.aligned ? "emerald" : "rose"}>
              {settlement.aligned === null ? "venues --" : settlement.aligned ? "venues alignées" : "venues non alignées"}
            </Chip>
          )}
          <span className={`font-mono text-[11px] ${settlement.pnlTone === "emerald" ? "text-[var(--wa-emerald)]" : settlement.pnlTone === "rose" ? "text-[var(--wa-rose)]" : "text-[var(--wa-mist)]"}`}>
            P&amp;L {formatSignedUsd(intent.realizedPnlUsd)}
            {intent.roi !== null ? ` · ROI ${(intent.roi * 100).toFixed(2)}%` : ""}
          </span>
          <span className="font-mono text-[10px] text-[var(--wa-dim)]">
            poly {intent.polyResolution ?? "--"} · kalshi {intent.kalshiResolution ?? "--"}
          </span>
        </div>
      ) : null}
      <div className="grid gap-2 md:grid-cols-2">
        {intent.legs.map((leg) => (
          <div key={leg.id} className="rounded border border-[var(--wa-gold-border)] bg-[var(--wa-bg0)] px-3 py-2">
            <div className="mb-1 font-mono text-[11px] text-[var(--wa-ivory)]">{leg.venue} · {leg.outcome}</div>
            <div className="text-[10px] text-[var(--wa-mist)]">
              {leg.filledSize > 0 && leg.filledPrice !== null
                ? `investi ${formatV2Usd(deriveLegCapitalUsd(leg))} · req ${formatPrice(leg.requestedSize, 2)} · filled ${formatPrice(leg.filledSize, 2)} · fee ${formatV2Usd(leg.feeUsd)}${deriveLegCashAdjustmentUsd(leg) > 0 ? ` · adj ${formatV2Usd(deriveLegCashAdjustmentUsd(leg))}` : ""}${formatLegRiskReservations(leg)}`
                : `req ${formatPrice(leg.requestedSize, 2)} · filled 0 · notionnel ${formatV2Usd(leg.requestedNotionalUsd)}${formatLegRiskReservations(leg)}`}
            </div>
          </div>
        ))}
      </div>
      <IntentMismatchRiskDetails intent={intent} />
      {intent.shadowExecution ? <ShadowExecutionDetails intent={intent} /> : null}
      {intent.failureReason ? <div className="mt-2 rounded bg-[rgba(232,80,106,0.06)] px-3 py-2 text-[10px] text-[var(--wa-rose)]">{intent.failureReason}</div> : null}
      {intent.entrySizingReason ? <div className="mt-2 rounded border border-[rgba(245,184,74,0.18)] bg-[rgba(245,184,74,0.06)] px-3 py-2 text-[10px] text-[var(--wa-amber)]">{intent.entrySizingReason}</div> : null}
    </div>
  );
}

function ShadowExecutionDetails({ intent }: { intent: OrderIntent }) {
  const audit = intent.shadowExecution;
  if (!audit) {
    return null;
  }
  const latency = audit.latencyMs === null ? null : `${(audit.latencyMs / 1000).toFixed(1)}s`;
  const restLatency = audit.restFetchDurationMs === null
    ? null
    : `${(audit.restFetchDurationMs / 1000).toFixed(1)}s`;
  const cooldown = audit.nextEligibleAt === null
    ? ""
    : ` · prochain essai ${formatDateTime(audit.nextEligibleAt)}`;
  const meta = audit.status === "scheduled"
    ? audit.restCapturedAt === null
      ? `lecture REST lancée ${formatDateTime(audit.restStartedAt)}`
      : `REST ${restLatency ?? "--"} · confirmation simulée ${formatDateTime(audit.completionNotBeforeAt)}`
    : audit.status === "filled"
      ? `REST ${restLatency ?? "--"} · total ${latency ?? "--"} · fill ${(audit.fillRatio * 100).toFixed(0)}% · coût ${audit.realizedGrossCost === null ? "--" : formatPrice(audit.realizedGrossCost, 4)}${cooldown}`
      : `REST ${restLatency ?? "--"} · total ${latency ?? "--"} · ${audit.reason ?? audit.reasonCode ?? "aucun fill"}${cooldown}`;
  return (
    <div className="mt-2 rounded border border-[var(--wa-gold-border)] bg-[var(--wa-bg0)] px-3 py-2 text-[10px] text-[var(--wa-mist)]">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[var(--wa-ivory)]">{audit.modelVersion}</span>
        <Chip tone={audit.status === "filled" ? "emerald" : audit.status === "no_fill" ? "rose" : "amber"}>{audit.status}</Chip>
      </div>
      <div>{meta}</div>
    </div>
  );
}

function FillRow({ fill, intent, last }: { fill: LiveFill; intent: OrderIntent | null; last: boolean }) {
  return (
    <div className={`grid gap-3 px-5 py-3 text-sm md:grid-cols-[90px_1fr_82px_80px_80px_80px_96px] ${last ? "" : "border-b border-[var(--wa-gold-border)]"}`}>
      <div>
        <div className="font-mono text-[11px] font-semibold text-[var(--wa-gold)]">{fill.asset.toUpperCase()}</div>
        {fill.shadow ? <div className="text-[8px] text-[var(--wa-indigo)]">shadow</div> : null}
      </div>
      <div>
        <div className="text-[var(--wa-ivory)]">{fill.venue} · {fill.outcome} · {fill.side}</div>
        {intent ? <div className="mt-1 font-mono text-[9px] text-[var(--wa-dim)]">intent {intent.asset.toUpperCase()} · {intent.combination} · {intent.status}</div> : null}
      </div>
      <div><Chip tone="emerald">filled</Chip></div>
      <div className="font-mono text-[11px] text-[var(--wa-ivory)]">size {formatPrice(fill.size, 2)}</div>
      <div className="font-mono text-[11px] text-[var(--wa-ivory)]">avg {formatPrice(fill.price, 4)}</div>
      <div className="font-mono text-[11px] text-[var(--wa-rose)]">{formatV2Usd(fill.feeUsd)}</div>
      <div className="font-mono text-[10px] text-[var(--wa-mist)]">{formatDateTime(fill.filledAt)}</div>
    </div>
  );
}

function OrderGroupSection({ group, intentsById }: { group: OrderGroup; intentsById: Map<string, OrderIntent> }) {
  const [expanded, setExpanded] = useState(false);
  const visibleOrders = expanded ? group.orders : group.orders.slice(0, 6);
  return (
    <Surface>
      <div className="flex items-center justify-between gap-3 border-b border-[var(--wa-gold-border)] px-5 py-4">
        <div className="text-sm text-[var(--wa-ivory)]">{group.label}</div>
        <div className="font-mono text-xs text-[var(--wa-mist)]">{group.orders.length} ordres</div>
      </div>
      {visibleOrders.map((order, index) => (
        <OrderRow key={order.id} order={order} intent={intentsById.get(order.intentId) ?? null} last={index === visibleOrders.length - 1 && group.orders.length <= 6} />
      ))}
      {group.orders.length > 6 ? (
        <div className="border-t border-[var(--wa-gold-border)] px-5 py-3">
          <V2Expand expanded={expanded} n={group.orders.length - 6} onClick={() => setExpanded((value) => !value)} />
        </div>
      ) : null}
    </Surface>
  );
}

function OrderRow({ order, intent, last }: { order: LiveOrder; intent: OrderIntent | null; last: boolean }) {
  return (
    <div className={`grid gap-3 px-5 py-3 text-sm md:grid-cols-[1fr_auto] ${last ? "" : "border-b border-[var(--wa-gold-border)]"}`}>
      <div>
        <div className="text-[var(--wa-ivory)]">{order.asset.toUpperCase()} · {order.venue} · {order.outcome} · {order.side}</div>
        {intent ? <div className="mt-1 text-[11px] text-[var(--wa-mist)]">intent {intent.asset.toUpperCase()} · {intent.combination} · {intent.status}</div> : null}
        <div className="mt-1 text-[11px] text-[var(--wa-mist)]">size {formatPrice(order.requestedSize, 2)} · filled {formatPrice(order.filledSize, 2)} · avg {order.averageFillPrice === null ? "--" : formatPrice(order.averageFillPrice, 4)}</div>
      </div>
      <div className="flex flex-col items-start gap-2 md:items-end">
        <Chip tone={getOrderTone(order)}>{order.status}</Chip>
        <div className="font-mono text-[10px] text-[var(--wa-dim)]">{formatDateTime(order.createdAt)}</div>
      </div>
    </div>
  );
}

function PanelMessage({ title, message, tone = "default" }: { title: string; message: string; tone?: "default" | "rose" }) {
  return (
    <Surface className={tone === "rose" ? "border-[rgba(232,80,106,0.28)]" : ""}>
      <div className={tone === "rose" ? "px-5 py-6 text-sm text-[var(--wa-rose)]" : "px-5 py-6 text-sm text-[var(--wa-mist)]"}>
        <div className="text-[var(--wa-ivory)]">{title}</div>
        <div className="mt-2">{message}</div>
      </div>
    </Surface>
  );
}

function isErrorIntent(intent: OrderIntent) {
  return (
    Boolean(intent.failureReason) ||
    ["failed", "canceled", "unwound", "unwind_required", "truth_pending", "manual_required"].includes(intent.status)
  );
}

function getIntentTone(intent: OrderIntent): V2Tone {
  if (intent.status === "hedged" || intent.status === "settled") {
    return "emerald";
  }
  if (intent.status === "rescue_hedge") {
    return "amber";
  }
  if (isErrorIntent(intent)) {
    return "rose";
  }
  return intent.status === "skipped" ? "indigo" : "amber";
}

function getOrderTone(order: LiveOrder): V2Tone {
  if (order.status === "filled") {
    return "emerald";
  }
  if (order.status === "rejected" || order.status === "expired" || order.status === "canceled") {
    return "rose";
  }
  return order.status === "partially_filled" ? "amber" : "mist";
}

function deriveSettlementSummary(intent: OrderIntent) {
  if (intent.status !== "settled") {
    return null;
  }

  const kalshiDirection = intent.kalshiResolution === "YES" ? "UP" : intent.kalshiResolution === "NO" ? "DOWN" : null;
  const aligned = intent.polyResolution !== null && kalshiDirection !== null ? intent.polyResolution === kalshiDirection : null;
  const classification = classifySettledIntentMismatch(intent);
  const pnlTone: V2Tone = intent.realizedPnlUsd === null ? "mist" : intent.realizedPnlUsd >= 0 ? "emerald" : "rose";

  return { aligned, classification, pnlTone };
}

function getSettlementClassificationTone(
  classification: MismatchSettlementClassification,
): V2Tone {
  return classification === "fatal_mismatch"
    ? "rose"
    : classification === "double_payout"
      ? "gold"
      : "emerald";
}

function deriveIntentCapitalUsd(intent: OrderIntent) {
  return Math.round(intent.legs.reduce((sum, leg) => sum + deriveLegCapitalUsd(leg), 0) * 10_000) / 10_000;
}

function deriveLegCapitalUsd(leg: OrderIntent["legs"][number]) {
  const tradedNotional = leg.filledSize > 0 && leg.filledPrice !== null ? leg.filledSize * leg.filledPrice : leg.requestedNotionalUsd;
  return Math.round((tradedNotional + leg.feeUsd + deriveLegCashAdjustmentUsd(leg)) * 10_000) / 10_000;
}

function deriveLegCashAdjustmentUsd(leg: OrderIntent["legs"][number]) {
  return leg.cashAdjustmentUsd ?? 0;
}

function formatLegRiskReservations(leg: OrderIntent["legs"][number]) {
  const parts: string[] = [];
  if (leg.worstFillCostUsd !== undefined) {
    parts.push(`worst ${formatV2Usd(leg.worstFillCostUsd)}`);
  }
  if ((leg.recoveryReserveUsd ?? 0) > 0) {
    parts.push(`recovery ${formatV2Usd(leg.recoveryReserveUsd)}`);
  }
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

function formatSignedUsd(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${formatV2Usd(Math.abs(value))}`;
}

function groupOrdersByPair(orders: LiveOrder[], intentsById: Map<string, OrderIntent>) {
  const groups = new Map<string, OrderGroup>();
  for (const order of orders) {
    const intent = intentsById.get(order.intentId) ?? null;
    const key = `${order.asset}:${intent?.combination ?? `${order.venue}:${order.outcome}`}:${order.shadow ? "shadow" : "live"}`;
    const existing = groups.get(key);
    if (existing) {
      existing.orders.push(order);
      continue;
    }
    groups.set(key, {
      key,
      label: `${order.asset.toUpperCase()} · ${intent?.combination ?? `${order.venue} ${order.outcome}`}${order.shadow ? " · shadow" : ""}`,
      orders: [order],
    });
  }
  return [...groups.values()].sort((left, right) => right.orders[0]!.createdAt - left.orders[0]!.createdAt);
}
