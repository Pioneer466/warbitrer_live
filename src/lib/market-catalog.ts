import type { MarketAsset } from "@/lib/types";

export type MarketCatalogEntry = {
  asset: MarketAsset;
  shortLabel: string;
  title: string;
  polymarketSlugPrefix: string;
  kalshiSeriesTicker: string;
  kalshiEventPath: string;
  coinbaseProductId: string;
};

export const MARKET_CATALOG: Record<MarketAsset, MarketCatalogEntry> = {
  btc: {
    asset: "btc",
    shortLabel: "BTC 15m",
    title: "Bitcoin Up or Down - 15 minutes",
    polymarketSlugPrefix: "btc-updown-15m",
    kalshiSeriesTicker: "KXBTC15M",
    kalshiEventPath: "kxbtc15m/bitcoin-price-up-down",
    coinbaseProductId: "BTC-USD",
  },
  eth: {
    asset: "eth",
    shortLabel: "ETH 15m",
    title: "ETH Up or Down - 15 minutes",
    polymarketSlugPrefix: "eth-updown-15m",
    kalshiSeriesTicker: "KXETH15M",
    kalshiEventPath: "kxeth15m/eth-15m-price-up-down",
    coinbaseProductId: "ETH-USD",
  },
};

export const MARKET_ASSETS = Object.keys(MARKET_CATALOG) as MarketAsset[];

export function getMarketCatalogEntry(asset: MarketAsset) {
  return MARKET_CATALOG[asset];
}

export function isMarketAsset(value: string): value is MarketAsset {
  return value === "btc" || value === "eth";
}

export function parseMarketAsset(value: string | null | undefined, fallback: MarketAsset = "btc"): MarketAsset {
  return value && isMarketAsset(value) ? value : fallback;
}

export function inferKalshiAsset(value: string | null | undefined, fallback: MarketAsset = "btc"): MarketAsset {
  const normalized = value?.toUpperCase() ?? "";
  if (normalized.startsWith("KXETH15M")) {
    return "eth";
  }
  if (normalized.startsWith("KXBTC15M")) {
    return "btc";
  }
  return fallback;
}

export function inferPolymarketAsset(value: string | null | undefined, fallback: MarketAsset = "btc"): MarketAsset {
  const normalized = value?.toLowerCase() ?? "";
  if (normalized.includes("eth-updown-15m")) {
    return "eth";
  }
  if (normalized.includes("btc-updown-15m")) {
    return "btc";
  }
  return fallback;
}
