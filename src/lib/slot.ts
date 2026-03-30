import { FIFTEEN_MINUTES_MS } from "@/lib/constants";
import type { MarketSlot } from "@/lib/types";

export function getCurrentSlot(now = new Date()): MarketSlot {
  const nowTs = now.getTime();
  const slotStartTs = Math.floor(nowTs / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS;
  const slotEndTs = slotStartTs + FIFTEEN_MINUTES_MS;

  return {
    key: String(slotStartTs),
    startTs: slotStartTs,
    endTs: slotEndTs,
    startIso: new Date(slotStartTs).toISOString(),
    endIso: new Date(slotEndTs).toISOString(),
    label: formatSlotLabel(slotStartTs, slotEndTs),
    polymarketSlug: `btc-updown-15m-${Math.floor(slotStartTs / 1000)}`,
    secondsRemaining: Math.max(0, Math.floor((slotEndTs - nowTs) / 1000)),
  };
}

export function formatSlotLabel(startTs: number, endTs: number) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  });

  return `${formatter.format(startTs)} - ${formatter.format(endTs)}`;
}
