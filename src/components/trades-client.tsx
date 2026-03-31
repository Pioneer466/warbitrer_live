"use client";

import { usePollingJson } from "@/components/use-polling-json";
import { formatCurrency, formatDateTime, formatPrice } from "@/lib/format";
import type { LiveFill, LiveOrder, OrderIntent, TradesResponse } from "@/lib/types";

export function TradesClient() {
  const { data, error, loading } = usePollingJson<TradesResponse>("/api/trades", 4_000);

  if (loading && !data) {
    return <PanelMessage title="Flow Live" message="Chargement des intents, ordres et fills." />;
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

  const grossIntentNotional = data.intents.reduce((sum, intent) => sum + intent.targetNotionalUsd, 0);
  const totalFees = data.orders.reduce((sum, order) => sum + (order.feeUsd ?? 0), 0);

  return (
    <div className="space-y-5">
      <section className="rounded-[32px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 shadow-[0_20px_60px_rgba(0,0,0,0.22)] sm:px-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SummaryCell label="Intents" value={String(data.intents.length)} />
          <SummaryCell label="Orders" value={String(data.orders.length)} />
          <SummaryCell label="Fills" value={String(data.fills.length)} />
          <SummaryCell label="Fees" value={formatCurrency(totalFees)} />
        </div>
        <div className="mt-4 text-sm text-mist">
          notionnel cumulé {formatCurrency(grossIntentNotional)}
        </div>
      </section>

      <Panel title="Intents">
        {data.intents.length === 0 ? (
          <EmptyState message="Aucun intent enregistré." />
        ) : (
          <div className="grid gap-3">
            {data.intents.map((intent) => (
              <IntentRow key={intent.id} intent={intent} />
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Orders">
        {data.orders.length === 0 ? (
          <EmptyState message="Aucun ordre enregistré." />
        ) : (
          <div className="grid gap-3">
            {data.orders.map((order) => (
              <OrderRow key={order.id} order={order} />
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Fills">
        {data.fills.length === 0 ? (
          <EmptyState message="Aucun fill enregistré." />
        ) : (
          <div className="grid gap-3">
            {data.fills.map((fill) => (
              <FillRow key={fill.id} fill={fill} />
            ))}
          </div>
        )}
      </Panel>

      {error ? <PanelMessage title="Erreur" message={error} tone="rose" /> : null}
    </div>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[32px] border border-white/8 bg-[#0d1017]/92 px-5 py-5 sm:px-6">
      <div className="border-b border-white/6 pb-4 text-sm text-white">{title}</div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function IntentRow({ intent }: { intent: OrderIntent }) {
  return (
    <div className="rounded-[24px] border border-white/6 px-4 py-4 text-sm text-mist">
      <div className="flex items-center justify-between gap-3">
        <div className="text-white">
          {intent.combination} · {intent.status} {intent.shadow ? "· shadow" : ""}
        </div>
        <div>{formatDateTime(intent.createdAt)}</div>
      </div>
      <div className="mt-2">
        {intent.primaryVenue} {"->"} {intent.hedgeVenue} · notionnel {formatCurrency(intent.targetNotionalUsd)}
      </div>
      {intent.failureReason ? <div className="mt-2 text-rose">{intent.failureReason}</div> : null}
    </div>
  );
}

function OrderRow({ order }: { order: LiveOrder }) {
  return (
    <div className="rounded-[24px] border border-white/6 px-4 py-4 text-sm text-mist">
      <div className="flex items-center justify-between gap-3">
        <div className="text-white">
          {order.venue} · {order.outcome} · {order.side} {order.shadow ? "· shadow" : ""}
        </div>
        <div>{order.status}</div>
      </div>
      <div className="mt-2">
        size {formatPrice(order.requestedSize, 2)} · filled {formatPrice(order.filledSize, 2)} · avg {formatPrice(order.averageFillPrice, 4)}
      </div>
      <div className="mt-2">
        fee {order.feeUsd === null ? "--" : formatCurrency(order.feeUsd)} · {formatDateTime(order.updatedAt)}
      </div>
    </div>
  );
}

function FillRow({ fill }: { fill: LiveFill }) {
  return (
    <div className="rounded-[24px] border border-white/6 px-4 py-4 text-sm text-mist">
      <div className="flex items-center justify-between gap-3">
        <div className="text-white">
          {fill.venue} · {fill.outcome} · {fill.side} {fill.shadow ? "· shadow" : ""}
        </div>
        <div>{formatDateTime(fill.filledAt)}</div>
      </div>
      <div className="mt-2">
        {formatPrice(fill.size, 2)} @ {formatPrice(fill.price, 4)} · fee {formatCurrency(fill.feeUsd)}
      </div>
    </div>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[24px] border border-white/6 bg-white/[0.02] px-4 py-4">
      <div className="text-[11px] uppercase tracking-[0.18em] text-mist/65">{label}</div>
      <div className="mt-3 font-mono text-[34px] leading-none text-white">{value}</div>
    </div>
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
