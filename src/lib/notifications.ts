import {
  enqueueNotificationDelivery,
  getPgDb,
  listPendingNotificationDeliveries,
  markNotificationDeliveryFailed,
  markNotificationDeliverySent,
} from "@/lib/postgres-db";
import { isTruthyEnv, readEnv } from "@/lib/env";
import { formatDateTime, formatPrice } from "@/lib/format";
import type { NotificationKind, RunEvent } from "@/lib/types";

type TelegramConfig = {
  enabled: boolean;
  botToken: string | null;
  chatId: string | null;
};

type QueuedNotification = {
  asset: RunEvent["asset"];
  kind: NotificationKind;
  dedupeKey: string;
  message: string;
  payload: Record<string, unknown> | null;
  createdAt: number;
};

let flushPromise: Promise<void> | null = null;

export function buildQueuedNotificationFromRunEvent(event: RunEvent): QueuedNotification | null {
  if (!event.payload || typeof event.payload !== "object") {
    return null;
  }

  const payload = event.payload;
  const intentId = typeof payload.intentId === "string" ? payload.intentId : null;
  if (!intentId) {
    return null;
  }

  if (event.eventType === "intent.live_traded") {
    if (payload.stage !== "hedged") {
      return null;
    }

    return {
      asset: event.asset ?? null,
      kind: "trade_live",
      dedupeKey: `trade_live:${intentId}`,
      message: buildTradeLiveMessage(event),
      payload,
      createdAt: event.createdAt,
    };
  }

  if (event.eventType === "intent.manual_intervention_required") {
    return {
      asset: event.asset ?? null,
      kind: "manual_intervention",
      dedupeKey: `manual_intervention:${intentId}`,
      message: buildManualInterventionMessage(event),
      payload,
      createdAt: event.createdAt,
    };
  }

  if (event.eventType === "intent.incident") {
    const stage = typeof payload.stage === "string" ? payload.stage : "incident";
    return {
      asset: event.asset ?? null,
      kind: "incident",
      dedupeKey: `incident:${intentId}:${stage}`,
      message: buildIncidentMessage(event),
      payload,
      createdAt: event.createdAt,
    };
  }

  return null;
}

export async function queueRunEventNotification(event: RunEvent) {
  const notification = buildQueuedNotificationFromRunEvent(event);
  if (!notification || !readTelegramConfig().enabled) {
    return null;
  }

  const pool = await getPgDb();
  return enqueueNotificationDelivery(pool, {
    asset: notification.asset ?? null,
    channel: "telegram",
    kind: notification.kind,
    dedupeKey: notification.dedupeKey,
    message: notification.message,
    payload: notification.payload,
    createdAt: notification.createdAt,
  });
}

export function schedulePendingNotificationFlush(limit = 10) {
  if (!readTelegramConfig().enabled || flushPromise) {
    return;
  }

  flushPromise = flushPendingNotificationDeliveries(limit)
    .catch((error) => {
      console.warn("[notifications] flush failed", error);
    })
    .finally(() => {
      flushPromise = null;
    });
}

async function flushPendingNotificationDeliveries(limit: number) {
  const config = readTelegramConfig();
  if (!config.enabled || !config.botToken || !config.chatId) {
    return;
  }

  const pool = await getPgDb();
  const deliveries = await listPendingNotificationDeliveries(pool, limit);
  for (const delivery of deliveries) {
    if (delivery.channel !== "telegram" || !delivery.id) {
      continue;
    }

    try {
      await sendTelegramMessage(config, delivery.message);
      await markNotificationDeliverySent(pool, delivery.id, Date.now());
    } catch (error) {
      await markNotificationDeliveryFailed(pool, delivery.id, toErrorMessage(error), Date.now());
    }
  }
}

function readTelegramConfig(): TelegramConfig {
  const env = readEnv();
  const enabled = isTruthyEnv(env.TELEGRAM_ENABLED);
  return {
    enabled: enabled && Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    botToken: env.TELEGRAM_BOT_TOKEN ?? null,
    chatId: env.TELEGRAM_CHAT_ID ?? null,
  };
}

async function sendTelegramMessage(config: TelegramConfig, message: string) {
  if (!config.botToken || !config.chatId) {
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: config.chatId,
      text: message,
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new Error(`Telegram HTTP ${response.status}: ${await response.text()}`);
  }
}

function buildTradeLiveMessage(event: RunEvent) {
  const payload = event.payload as Record<string, unknown>;
  const asset = typeof payload.asset === "string" ? payload.asset.toUpperCase() : String(event.asset ?? "--").toUpperCase();
  const combination = typeof payload.combination === "string" ? payload.combination : "--";
  const targetNotionalUsd = typeof payload.targetNotionalUsd === "number" ? payload.targetNotionalUsd : null;
  const investedNotionalUsd =
    typeof payload.investedNotionalUsd === "number" ? payload.investedNotionalUsd : targetNotionalUsd;
  const entrySizingReason = typeof payload.entrySizingReason === "string" ? payload.entrySizingReason : null;
  const grossCost = typeof payload.grossCost === "number" ? payload.grossCost : null;
  const polymarketOutcome = typeof payload.polymarketOutcome === "string" ? payload.polymarketOutcome : null;
  const kalshiOutcome = typeof payload.kalshiOutcome === "string" ? payload.kalshiOutcome : null;
  const polymarketRequestedNotionalUsd =
    typeof payload.polymarketRequestedNotionalUsd === "number" ? payload.polymarketRequestedNotionalUsd : null;
  const polymarketInvestedUsd =
    typeof payload.polymarketInvestedUsd === "number" ? payload.polymarketInvestedUsd : polymarketRequestedNotionalUsd;
  const polymarketFilledSize = typeof payload.polymarketFilledSize === "number" ? payload.polymarketFilledSize : null;
  const kalshiRequestedNotionalUsd =
    typeof payload.kalshiRequestedNotionalUsd === "number" ? payload.kalshiRequestedNotionalUsd : null;
  const kalshiInvestedUsd =
    typeof payload.kalshiInvestedUsd === "number" ? payload.kalshiInvestedUsd : kalshiRequestedNotionalUsd;
  const kalshiFilledSize = typeof payload.kalshiFilledSize === "number" ? payload.kalshiFilledSize : null;
  const pairLabel =
    polymarketOutcome && kalshiOutcome
      ? `Poly ${polymarketOutcome} Kalshi ${kalshiOutcome}`
      : formatCombinationLabel(combination);

  return [
    "TRADE",
    `${asset} - ${pairLabel}`,
    `Traded : ${formatTelegramUsd(investedNotionalUsd)}`,
    `Gross : ${grossCost !== null ? formatPrice(grossCost, 2) : "--"}`,
    "",
    "NOTIONNEL",
    ...(entrySizingReason ? [`Raison : ${entrySizingReason}`] : []),
    `Poly : ${formatTelegramUsd(polymarketInvestedUsd)} - filled : ${formatPrice(polymarketFilledSize, 2)}`,
    `Kalshi : ${formatTelegramUsd(kalshiInvestedUsd)} - filled : ${formatPrice(kalshiFilledSize, 2)}`,
  ].join("\n");
}

function formatCombinationLabel(combination: string) {
  if (combination === "POLY_UP_KALSHI_NO") {
    return "Poly UP Kalshi NO";
  }

  if (combination === "POLY_DOWN_KALSHI_YES") {
    return "Poly DOWN Kalshi YES";
  }

  return combination;
}

function formatTelegramUsd(value: number | null) {
  return value === null ? "--" : `${value.toFixed(2)}$`;
}

function buildManualInterventionMessage(event: RunEvent) {
  const payload = event.payload as Record<string, unknown>;
  const asset = typeof payload.asset === "string" ? payload.asset.toUpperCase() : String(event.asset ?? "--").toUpperCase();
  const combination = typeof payload.combination === "string" ? payload.combination : "--";
  const slotKey = typeof payload.slotKey === "string" ? payload.slotKey : "--";
  const failureReason = typeof payload.failureReason === "string" ? payload.failureReason : event.message;
  const stage = typeof payload.stage === "string" ? payload.stage : "--";

  return [
    "MANUAL INTERVENTION REQUIRED",
    `${asset} · ${combination}`,
    `${formatDateTime(event.createdAt)} · ${slotKey}`,
    `stage ${stage}`,
    failureReason,
  ].join("\n");
}

function buildIncidentMessage(event: RunEvent) {
  const payload = event.payload as Record<string, unknown>;
  const asset = typeof payload.asset === "string" ? payload.asset.toUpperCase() : String(event.asset ?? "--").toUpperCase();
  const combination = typeof payload.combination === "string" ? payload.combination : "--";
  const slotKey = typeof payload.slotKey === "string" ? payload.slotKey : "--";
  const reason = typeof payload.reason === "string" ? payload.reason : event.message;
  const stage = typeof payload.stage === "string" ? payload.stage : "--";

  return [
    "INCIDENT",
    `${asset} · ${combination}`,
    `${formatDateTime(event.createdAt)} · ${slotKey}`,
    `stage ${stage}`,
    reason,
  ].join("\n");
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
