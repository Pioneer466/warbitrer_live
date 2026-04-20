import type { MarketAsset } from "@/lib/types";

export type MarketCatalogEntry = {
  asset: MarketAsset;
  shortLabel: string;
  title: string;
  aliases: string[];
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
    aliases: ["bitcoin", "btc"],
    polymarketSlugPrefix: "btc-updown-15m",
    kalshiSeriesTicker: "KXBTC15M",
    kalshiEventPath: "kxbtc15m/bitcoin-price-up-down",
    coinbaseProductId: "BTC-USD",
  },
  eth: {
    asset: "eth",
    shortLabel: "ETH 15m",
    title: "ETH Up or Down - 15 minutes",
    aliases: ["ethereum", "eth"],
    polymarketSlugPrefix: "eth-updown-15m",
    kalshiSeriesTicker: "KXETH15M",
    kalshiEventPath: "kxeth15m/eth-15m-price-up-down",
    coinbaseProductId: "ETH-USD",
  },
  sol: {
    asset: "sol",
    shortLabel: "SOL 15m",
    title: "Solana Up or Down - 15 minutes",
    aliases: ["solana", "sol"],
    polymarketSlugPrefix: "sol-updown-15m",
    kalshiSeriesTicker: "KXSOL15M",
    kalshiEventPath: "kxsol15m/solana-15-minutes",
    coinbaseProductId: "SOL-USD",
  },
  xrp: {
    asset: "xrp",
    shortLabel: "XRP 15m",
    title: "XRP Up or Down - 15 minutes",
    aliases: ["xrp", "ripple"],
    polymarketSlugPrefix: "xrp-updown-15m",
    kalshiSeriesTicker: "KXXRP15M",
    kalshiEventPath: "kxxrp15m/xrp-15-minute",
    coinbaseProductId: "XRP-USD",
  },
};

export const MARKET_ASSETS = Object.keys(MARKET_CATALOG) as MarketAsset[];

export function getMarketCatalogEntry(asset: MarketAsset) {
  return MARKET_CATALOG[asset];
}

export function isMarketAsset(value: string): value is MarketAsset {
  return MARKET_ASSETS.includes(value as MarketAsset);
}

export function parseMarketAsset(value: string | null | undefined, fallback: MarketAsset = "btc"): MarketAsset {
  return value && isMarketAsset(value) ? value : fallback;
}

export function inferKalshiAsset(value: string | null | undefined, fallback: MarketAsset = "btc"): MarketAsset {
  const normalized = value?.toUpperCase() ?? "";
  return (
    MARKET_ASSETS.find((asset) => normalized.startsWith(getMarketCatalogEntry(asset).kalshiSeriesTicker)) ?? fallback
  );
}

export function inferPolymarketAsset(value: string | null | undefined, fallback: MarketAsset = "btc"): MarketAsset {
  const normalized = value?.toLowerCase() ?? "";
  return (
    MARKET_ASSETS.find((asset) => {
      const entry = getMarketCatalogEntry(asset);
      return (
        normalized.includes(entry.polymarketSlugPrefix) ||
        entry.aliases.some((alias) => containsAssetAlias(normalized, alias))
      );
    }) ?? fallback
  );
}

function containsAssetAlias(value: string, alias: string) {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(alias)}([^a-z0-9]|$)`).test(value);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
