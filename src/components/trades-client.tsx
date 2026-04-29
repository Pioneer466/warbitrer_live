"use client";

import { useState } from "react";

import { usePollingJson } from "@/components/use-polling-json";
import { formatCurrency, formatDateTime, formatPrice } from "@/lib/format";
import { ACTIVE_MARKET_ASSETS } from "@/lib/market-catalog";
import type { LiveFill, LiveOrder, MarketAsset, OrderIntent, TradesResponse } from "@/lib/types";

type OrderGroup = {
  key: string;
  label: string;
  orders: LiveOrder[];
};

const TRADE_FILTERS: Array<MarketAsset | "all"> = ["all", ...ACTIVE_MARKET_ASSETS];

export function TradesClient() {
  const [assetFilter, setAssetFilter] = useState<MarketAsset | "all">("all");
  const { data, error, loading } = usePollingJson<TradesResponse>(`/api/trades?asset=${assetFilter}`, 4_000);
  const [showAllExecutions, setShowAllExecutions] = useState(false);

  if (loading && !data) {
    return <PanelMessage title="Flow Live" message="Chargement des intents, ordres et exécutions." />;
  }

  if (!data) {
    return (
      <PanelMessage
        title="Erreur"
        message={error ?? "Impossible de charger le flow live."}
        tone="rose"
      />
    );
  }

  const intents = [...data.intents].sort((left, right) => right.createdAt - left.createdAt);
  const orders = [...data.orders].sort((left, right) => right.createdAt - left.createdAt);
  const fills = [...data.fills].sort((left, right) => right.filledAt - left.filledAt);
  const intentsById = new Map(intents.map((intent) => [intent.id, intent]));
  const intentNotionalUsd = intents.reduce((sum, intent) => sum + deriveIntentCapitalUsd(intent), 0);
  const executedNotionalUsd = fills.reduce((sum, fill) => sum + fill.price * fill.size, 0);
  const totalFees = fills.reduce((sum, fill) => sum + fill.feeUsd, 0);
  const successfulIntents = intents.filter(isSuccessfulIntent);
  const errorIntents = intents.filter(isErrorIntent);
  const otherIntentsCount = intents.length - successfulIntents.length - errorIntents.length;
  const visibleExecutions = showAllExecutions ? fills : fills.slice(0, 8);
  const orderGroups = groupOrdersByPair(orders, intentsById);

  return (
    <div className="space-y-5">
      <section className="rounded-[32px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 shadow-[0_20px_60px_rgba(0,0,0,0.22)] sm:px-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SummaryCell label="Intents" value={String(intents.length)} meta="1 décision de paire" />
          <SummaryCell label="Orders" value={String(orders.length)} meta="inclut retries, unwind et exits" />
          <SummaryCell label="Exécutions" value={String(fills.length)} meta="fills réellement matchés" />
          <SummaryCell label="Frais Payés" value={formatCurrency(totalFees)} meta="somme des exécutions" />
        </div>
        <div className="mt-4 grid gap-2 text-sm text-mist">
          <div>
            notionnel intents {formatCurrency(intentNotionalUsd)} · notionnel exécuté {formatCurrency(executedNotionalUsd)}
          </div>
          <div>
            intent = décision de paire · order = tentative envoyée à une venue · exécution = trade réellement rempli
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          {TRADE_FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setAssetFilter(value)}
              className={`rounded-full border px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] ${
                assetFilter === value
                  ? "border-cyan/25 bg-cyan/10 text-cyan"
                  : "border-white/8 bg-white/[0.03] text-mist"
              }`}
            >
              {value}
            </button>
          ))}
        </div>
      </section>

      <Panel
        title="Intents"
        meta={`${successfulIntents.length} réussis · ${errorIntents.length} erreurs${otherIntentsCount > 0 ? ` · ${otherIntentsCount} en cours` : ""}`}
      >
        {intents.length === 0 ? (
          <EmptyState message="Aucun intent enregistré." />
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            <IntentListColumn
              title="Trades Réussis"
              meta="hedged / settled"
              intents={successfulIntents}
              emptyMessage="Aucun trade réussi dans cette vue."
            />
            <IntentListColumn
              title="Erreurs"
              meta="failed / recovery / failure reason"
              intents={errorIntents}
              emptyMessage="Aucun intent en erreur dans cette vue."
              tone="rose"
            />
          </div>
        )}
      </Panel>

      <Panel title="Orders Par Pair" meta={`${orders.length} ordres · ${orderGroups.length} groupes`}>
        {orders.length === 0 ? (
          <EmptyState message="Aucun ordre enregistré." />
        ) : (
          <div className="grid gap-4">
            {orderGroups.map((group) => (
              <OrderGroupSection
                key={group.key}
                group={group}
                intentsById={intentsById}
              />
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Exécutions" meta={`${fills.length} événements`}>
        {fills.length === 0 ? (
          <EmptyState message="Aucune exécution enregistrée." />
        ) : (
          <>
            <div className="grid gap-3">
              {visibleExecutions.map((fill) => (
                <FillRow key={fill.id} fill={fill} intent={intentsById.get(fill.intentId) ?? null} />
              ))}
            </div>
            {fills.length > 8 ? (
              <ExpandButton
                expanded={showAllExecutions}
                collapsedLabel={`Voir les ${fills.length - 8} exécutions suivantes`}
                expandedLabel="Réduire la liste"
                onClick={() => setShowAllExecutions((value) => !value)}
              />
            ) : null}
          </>
        )}
      </Panel>

      {error ? <PanelMessage title="Erreur" message={error} tone="rose" /> : null}
    </div>
  );
}

function isSuccessfulIntent(intent: OrderIntent) {
  return intent.status === "hedged" || intent.status === "settled";
}

function isErrorIntent(intent: OrderIntent) {
  return (
    intent.failureReason !== null ||
    intent.status === "failed" ||
    intent.status === "canceled" ||
    intent.status === "unwind_required" ||
    intent.status === "unwound"
  );
}

function IntentListColumn({
  title,
  meta,
  intents,
  emptyMessage,
  tone = "default",
}: {
  title: string;
  meta: string;
  intents: OrderIntent[];
  emptyMessage: string;
  tone?: "default" | "rose";
}) {
  const [expanded, setExpanded] = useState(false);
  const visibleIntents = expanded ? intents : intents.slice(0, 4);

  return (
    <div
      className={`rounded-[24px] border px-4 py-4 ${
        tone === "rose" ? "border-rose/20 bg-rose/[0.04]" : "border-white/6 bg-white/[0.02]"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm text-white">{title}</div>
          <div className="mt-1 text-xs text-mist/60">{meta}</div>
        </div>
        <div className={tone === "rose" ? "text-sm text-rose" : "text-sm text-mist"}>{intents.length}</div>
      </div>

      <div className="mt-4 grid gap-3">
        {visibleIntents.length === 0 ? (
          <EmptyState message={emptyMessage} />
        ) : (
          visibleIntents.map((intent) => <IntentRow key={intent.id} intent={intent} />)
        )}
      </div>

      {intents.length > 4 ? (
        <ExpandButton
          expanded={expanded}
          collapsedLabel={`Voir les ${intents.length - 4} suivants`}
          expandedLabel="Réduire la liste"
          onClick={() => setExpanded((value) => !value)}
        />
      ) : null}
    </div>
  );
}

function Panel({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[32px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 sm:px-6">
      <div className="flex flex-col gap-2 border-b border-white/6 pb-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="text-sm text-white">{title}</div>
        {meta ? <div className="text-xs text-mist/70">{meta}</div> : null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function IntentRow({ intent }: { intent: OrderIntent }) {
  const resolutionAlignment = getResolutionAlignment(intent);
  const normalizedDirection = getNormalizedResolutionDirection(intent);
  const shouldShowResolutionSummary =
    intent.status === "settled" || intent.polyResolution !== null || intent.kalshiResolution !== null;

  return (
    <div className="rounded-[24px] border border-white/6 px-4 py-4 text-sm text-mist">
      <div className="flex items-center justify-between gap-3">
        <div className="text-white">
          {intent.asset.toUpperCase()} · {intent.combination} · {intent.status} {intent.shadow ? "· shadow" : ""}
        </div>
        <div>{formatDateTime(intent.createdAt)}</div>
      </div>
      <div className="mt-2">
        {intent.primaryVenue} {"->"} {intent.hedgeVenue} · notionnel {formatCurrency(deriveIntentCapitalUsd(intent))}
      </div>
      {shouldShowResolutionSummary ? (
        <div className={`mt-3 rounded-[18px] border px-3 py-3 ${
          resolutionAlignment === "mismatch"
            ? "border-rose/20 bg-rose/10"
            : resolutionAlignment === "aligned"
              ? "border-emerald-400/20 bg-emerald-400/10"
              : "border-amber/20 bg-amber/10"
        }`}>
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-white">Résolution</div>
            <span
              className={`rounded-full border px-2 py-1 text-[11px] uppercase tracking-[0.14em] ${
                resolutionAlignment === "mismatch"
                  ? "border-rose/20 bg-black/10 text-rose"
                  : resolutionAlignment === "aligned"
                    ? "border-emerald-400/20 bg-black/10 text-emerald-300"
                    : "border-amber/20 bg-black/10 text-amber"
              }`}
            >
              {resolutionAlignment === "mismatch"
                ? "mismatch"
                : resolutionAlignment === "aligned"
                  ? "aligné"
                  : "incomplet"}
            </span>
          </div>
          <div className="mt-2">
            Polymarket {intent.polyResolution ?? "--"} · Kalshi {intent.kalshiResolution ?? "--"}
          </div>
          {normalizedDirection ? <div className="mt-2">direction normalisée {normalizedDirection}</div> : null}
          {intent.realizedPnlUsd !== null ? (
            <div className={`mt-2 ${intent.realizedPnlUsd >= 0 ? "text-emerald-300" : "text-rose"}`}>
              P&amp;L {formatCurrency(intent.realizedPnlUsd)}
              {intent.roi !== null ? ` · ROI ${(intent.roi * 100).toFixed(2)}%` : ""}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {intent.legs.map((leg) => (
          <div key={leg.id} className="rounded-[18px] border border-white/6 px-3 py-3">
            <div className="text-white">
              {leg.venue} · {leg.outcome}
            </div>
            <div className="mt-2">
              {leg.filledSize > 0 && leg.filledPrice !== null
                ? `investi ${formatCurrency(deriveLegCapitalUsd(leg))} · req ${formatPrice(leg.requestedSize, 2)} · filled ${formatPrice(leg.filledSize, 2)} · fee ${formatCurrency(leg.feeUsd)}`
                : `notionnel ${formatCurrency(leg.requestedNotionalUsd)} · req ${formatPrice(leg.requestedSize, 2)} · filled ${formatPrice(leg.filledSize, 2)} · fee ${formatCurrency(leg.feeUsd)}`}
            </div>
          </div>
        ))}
      </div>
      {intent.entrySizingReason ? <div className="mt-3 text-amber">{intent.entrySizingReason}</div> : null}
      {intent.failureReason ? <div className="mt-3 text-rose">{intent.failureReason}</div> : null}
    </div>
  );
}

function deriveIntentCapitalUsd(intent: OrderIntent) {
  return roundCurrency(
    intent.legs.reduce((sum, leg) => sum + deriveLegCapitalUsd(leg), 0),
  );
}

function deriveLegCapitalUsd(leg: OrderIntent["legs"][number]) {
  const tradedNotional =
    leg.filledSize > 0 && leg.filledPrice !== null ? leg.filledSize * leg.filledPrice : leg.requestedNotionalUsd;
  return roundCurrency(tradedNotional + leg.feeUsd);
}

function roundCurrency(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function getResolutionAlignment(intent: Pick<OrderIntent, "polyResolution" | "kalshiResolution">) {
  const polyDirection = normalizePolymarketResolution(intent.polyResolution);
  const kalshiDirection = normalizeKalshiResolution(intent.kalshiResolution);
  if (polyDirection === null || kalshiDirection === null) {
    return null;
  }

  return polyDirection === kalshiDirection ? "aligned" : "mismatch";
}

function getNormalizedResolutionDirection(intent: Pick<OrderIntent, "polyResolution" | "kalshiResolution">) {
  const polyDirection = normalizePolymarketResolution(intent.polyResolution);
  const kalshiDirection = normalizeKalshiResolution(intent.kalshiResolution);

  if (polyDirection !== null && kalshiDirection !== null) {
    return polyDirection === kalshiDirection ? polyDirection : null;
  }

  return polyDirection ?? kalshiDirection;
}

function normalizePolymarketResolution(resolution: OrderIntent["polyResolution"]) {
  if (resolution === "UP" || resolution === "DOWN") {
    return resolution;
  }

  return null;
}

function normalizeKalshiResolution(resolution: OrderIntent["kalshiResolution"]) {
  if (resolution === "YES") {
    return "UP" as const;
  }
  if (resolution === "NO") {
    return "DOWN" as const;
  }

  return null;
}

function OrderGroupSection({
  group,
  intentsById,
}: {
  group: OrderGroup;
  intentsById: Map<string, OrderIntent>;
}) {
  const [expanded, setExpanded] = useState(false);
  const visibleOrders = expanded ? group.orders : group.orders.slice(0, 6);

  return (
    <div className="rounded-[24px] border border-white/6 bg-white/[0.02] px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-white">{group.label}</div>
        <div className="text-sm text-mist">{group.orders.length} ordres</div>
      </div>
      <div className="mt-3 grid gap-3">
        {visibleOrders.map((order) => (
          <OrderRow key={order.id} order={order} intent={intentsById.get(order.intentId) ?? null} />
        ))}
      </div>
      {group.orders.length > 6 ? (
        <ExpandButton
          expanded={expanded}
          collapsedLabel={`Voir les ${group.orders.length - 6} ordres suivants`}
          expandedLabel="Réduire la liste"
          onClick={() => setExpanded((value) => !value)}
        />
      ) : null}
    </div>
  );
}

function OrderRow({ order, intent }: { order: LiveOrder; intent: OrderIntent | null }) {
  return (
    <div className="rounded-[20px] border border-white/6 px-4 py-4 text-sm text-mist">
      <div className="flex items-center justify-between gap-3">
        <div className="text-white">
          {order.asset.toUpperCase()} · {order.venue} · {order.outcome} · {order.side} {order.shadow ? "· shadow" : ""}
        </div>
        <div>{order.status}</div>
      </div>
      {intent ? (
        <div className="mt-2">
          intent {intent.asset.toUpperCase()} · {intent.combination} · {intent.status}
        </div>
      ) : null}
      <div className="mt-2">
        size {formatPrice(order.requestedSize, 2)} · filled {formatPrice(order.filledSize, 2)} · avg{" "}
        {order.averageFillPrice === null ? "--" : formatPrice(order.averageFillPrice, 4)}
      </div>
      <div className="mt-2">
        fee {formatCurrency(order.feeUsd ?? 0)} · créé {formatDateTime(order.createdAt)}
      </div>
    </div>
  );
}

function FillRow({ fill, intent }: { fill: LiveFill; intent: OrderIntent | null }) {
  return (
    <div className="rounded-[24px] border border-white/6 px-4 py-4 text-sm text-mist">
      <div className="flex items-center justify-between gap-3">
        <div className="text-white">
          {fill.asset.toUpperCase()} · {fill.venue} · {fill.outcome} · {fill.side} {fill.shadow ? "· shadow" : ""}
        </div>
        <div>{formatDateTime(fill.filledAt)}</div>
      </div>
      {intent ? <div className="mt-2">intent {intent.asset.toUpperCase()} · {intent.combination} · {intent.status}</div> : null}
      <div className="mt-2">
        {formatPrice(fill.size, 2)} @ {formatPrice(fill.price, 4)} · fee {formatCurrency(fill.feeUsd)}
      </div>
    </div>
  );
}

function SummaryCell({
  label,
  value,
  meta,
}: {
  label: string;
  value: string;
  meta?: string;
}) {
  return (
    <div className="rounded-[24px] border border-white/6 bg-white/[0.02] px-4 py-4">
      <div className="text-[11px] uppercase tracking-[0.18em] text-mist/65">{label}</div>
      <div className="mt-3 font-mono text-[34px] leading-none text-white">{value}</div>
      {meta ? <div className="mt-2 text-xs text-mist/60">{meta}</div> : null}
    </div>
  );
}

function ExpandButton({
  expanded,
  collapsedLabel,
  expandedLabel,
  onClick,
}: {
  expanded: boolean;
  collapsedLabel: string;
  expandedLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-4 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-mist transition hover:border-white/20 hover:bg-white/[0.06]"
    >
      {expanded ? expandedLabel : collapsedLabel}
    </button>
  );
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

function groupOrdersByPair(orders: LiveOrder[], intentsById: Map<string, OrderIntent>) {
  const groups = new Map<string, OrderGroup>();

  for (const order of orders) {
    const intent = intentsById.get(order.intentId) ?? null;
    const label = `${order.asset.toUpperCase()} · ${intent?.combination ?? `${order.venue} ${order.outcome}`}`;
    const key = `${order.asset}:${intent?.combination ?? `${order.venue}:${order.outcome}`}:${order.shadow ? "shadow" : "live"}`;
    const existing = groups.get(key);
    if (existing) {
      existing.orders.push(order);
      continue;
    }
    groups.set(key, {
      key,
      label: `${label}${order.shadow ? " · shadow" : ""}`,
      orders: [order],
    });
  }

  return [...groups.values()].sort((left, right) => right.orders[0]!.createdAt - left.orders[0]!.createdAt);
}
