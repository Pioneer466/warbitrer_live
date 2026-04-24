"use client";

import { useState } from "react";

import { usePollingJson } from "@/components/use-polling-json";
import { formatCurrency, formatDateTime, formatPrice } from "@/lib/format";
import { MARKET_ASSETS } from "@/lib/market-catalog";
import type { LiveFill, LiveOrder, MarketAsset, OrderIntent, TradesResponse } from "@/lib/types";

type OrderGroup = {
  key: string;
  label: string;
  orders: LiveOrder[];
};

const TRADE_FILTERS: Array<MarketAsset | "all"> = ["all", ...MARKET_ASSETS];

export function TradesClient() {
  const [assetFilter, setAssetFilter] = useState<MarketAsset | "all">("all");
  const { data, error, loading } = usePollingJson<TradesResponse>(`/api/trades?asset=${assetFilter}`, 4_000);
  const [showAllIntents, setShowAllIntents] = useState(false);
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
  const intentNotionalUsd = intents.reduce((sum, intent) => sum + intent.targetNotionalUsd, 0);
  const executedNotionalUsd = fills.reduce((sum, fill) => sum + fill.price * fill.size, 0);
  const totalFees = fills.reduce((sum, fill) => sum + fill.feeUsd, 0);
  const visibleIntents = showAllIntents ? intents : intents.slice(0, 3);
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

      <Panel title="Intents" meta={`${intents.length} total · ${visibleIntents.length} affichés`}>
        {intents.length === 0 ? (
          <EmptyState message="Aucun intent enregistré." />
        ) : (
          <>
            <div className="grid gap-3">
              {visibleIntents.map((intent) => (
                <IntentRow key={intent.id} intent={intent} />
              ))}
            </div>
            {intents.length > 3 ? (
              <ExpandButton
                expanded={showAllIntents}
                collapsedLabel={`Voir les ${intents.length - 3} intents suivants`}
                expandedLabel="Réduire la liste"
                onClick={() => setShowAllIntents((value) => !value)}
              />
            ) : null}
          </>
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
  const pairSettlement = getPairSettlementSummary(intent);
  const venueResolutionStatus = getVenueResolutionStatus(intent);
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
        {intent.primaryVenue} {"->"} {intent.hedgeVenue} · notionnel {formatCurrency(intent.targetNotionalUsd)}
      </div>
      {shouldShowResolutionSummary ? (
        <div className={`mt-3 rounded-[18px] border px-3 py-3 ${
          pairSettlement.status === "double_win"
            ? "border-emerald-400/20 bg-emerald-400/10"
            : pairSettlement.status === "double_loss"
              ? "border-rose/20 bg-rose/10"
              : "border-amber/20 bg-amber/10"
        }`}>
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-white">Résolutions venues</div>
            <span
              className={`rounded-full border px-2 py-1 text-[11px] uppercase tracking-[0.14em] ${
                venueResolutionStatus === "complete"
                  ? "border-white/10 bg-black/10 text-mist"
                  : "border-amber/20 bg-black/10 text-amber"
              }`}
            >
              {venueResolutionStatus === "complete" ? "confirmées" : "incomplètes"}
            </span>
          </div>
          <div className="mt-2">
            Polymarket {intent.polyResolution ?? "--"} · Kalshi {intent.kalshiResolution ?? "--"}
          </div>
          <div className="mt-2 text-xs text-mist/80">
            affichage brut des résolutions venues; ne présume pas que la paire était parfaitement couverte
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="text-white">Résultat paire</div>
            <span
              className={`rounded-full border px-2 py-1 text-[11px] uppercase tracking-[0.14em] ${
                pairSettlement.status === "double_win"
                  ? "border-emerald-400/20 bg-black/10 text-emerald-300"
                  : pairSettlement.status === "double_loss"
                    ? "border-rose/20 bg-black/10 text-rose"
                    : pairSettlement.status === "split"
                      ? "border-amber/20 bg-black/10 text-amber"
                      : "border-white/10 bg-black/10 text-mist"
              }`}
            >
              {pairSettlement.label}
            </span>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {intent.legs.map((leg) => {
              const settlement = getLegSettlementSummary(intent, leg);
              return (
                <div key={`${intent.id}:${leg.id}:settlement`} className="rounded-[14px] border border-white/6 px-3 py-2">
                  <div className="text-white">
                    {leg.venue} · {leg.outcome}
                  </div>
                  <div className="mt-1 text-xs text-mist">
                    résolu {settlement.resolvedOutcome ?? "--"} ·{" "}
                    <span
                      className={
                        settlement.status === "won"
                          ? "text-emerald-300"
                          : settlement.status === "lost"
                            ? "text-rose"
                            : "text-mist"
                      }
                    >
                      {settlement.status === "won"
                        ? "jambe gagnante"
                        : settlement.status === "lost"
                          ? "jambe perdante"
                          : "issue inconnue"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
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
              notionnel {formatCurrency(leg.requestedNotionalUsd)} · req {formatPrice(leg.requestedSize, 2)} · filled {formatPrice(leg.filledSize, 2)} · fee {formatCurrency(leg.feeUsd)}
            </div>
          </div>
        ))}
      </div>
      {intent.failureReason ? <div className="mt-3 text-rose">{intent.failureReason}</div> : null}
    </div>
  );
}

function getLegSettlementSummary(
  intent: Pick<OrderIntent, "polyResolution" | "kalshiResolution">,
  leg: Pick<OrderIntent["legs"][number], "venue" | "outcome">,
) {
  const resolvedOutcome = leg.venue === "polymarket" ? intent.polyResolution : intent.kalshiResolution;
  if (resolvedOutcome === null) {
    return {
      resolvedOutcome: null,
      status: null as "won" | "lost" | null,
    };
  }

  return {
    resolvedOutcome,
    status: leg.outcome === resolvedOutcome ? ("won" as const) : ("lost" as const),
  };
}

function getPairSettlementSummary(intent: Pick<OrderIntent, "polyResolution" | "kalshiResolution" | "legs">) {
  const legResults = intent.legs.map((leg) => getLegSettlementSummary(intent, leg));
  if (legResults.some((result) => result.status === null)) {
    return {
      status: "incomplete" as const,
      label: "issue incomplète",
    };
  }

  const wonCount = legResults.filter((result) => result.status === "won").length;
  if (wonCount === legResults.length) {
    return {
      status: "double_win" as const,
      label: "double gain",
    };
  }
  if (wonCount === 0) {
    return {
      status: "double_loss" as const,
      label: "double perte",
    };
  }

  return {
    status: "split" as const,
    label: "une gagnante · une perdante",
  };
}

function getVenueResolutionStatus(intent: Pick<OrderIntent, "polyResolution" | "kalshiResolution">) {
  return intent.polyResolution !== null && intent.kalshiResolution !== null ? "complete" : "incomplete";
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
