import { ACTIVE_MARKET_ASSETS, getMarketCatalogEntry } from "@/lib/market-catalog";
import { FIFTEEN_MINUTES_MS } from "@/lib/constants";
import type { MarketAsset, MarketSlot } from "@/lib/types";

export function getCurrentSlot(asset: MarketAsset, now = new Date()): MarketSlot {
  const nowTs = now.getTime();
  const slotStartTs = Math.floor(nowTs / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS;
  const slotEndTs = slotStartTs + FIFTEEN_MINUTES_MS;
  const market = getMarketCatalogEntry(asset);

  return {
    asset,
    key: `${asset}:${slotStartTs}`,
    startTs: slotStartTs,
    endTs: slotEndTs,
    startIso: new Date(slotStartTs).toISOString(),
    endIso: new Date(slotEndTs).toISOString(),
    label: formatSlotLabel(slotStartTs, slotEndTs),
    polymarketSlug: `${market.polymarketSlugPrefix}-${Math.floor(slotStartTs / 1000)}`,
    secondsRemaining: Math.max(0, Math.floor((slotEndTs - nowTs) / 1000)),
  };
}

export function getCurrentSlots(now = new Date()): MarketSlot[] {
  return ACTIVE_MARKET_ASSETS.map((asset) => getCurrentSlot(asset, now));
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
