import type { MarketAsset } from "@/lib/types";

export type MarketCatalogEntry = {
  asset: MarketAsset;
  shortLabel: string;
  title: string;
  aliases: string[];
  polymarketSlugPrefix: string;
  polymarketChainlinkSymbol: string;
  chainlinkDataStreamsFeedId: string | null;
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
    polymarketChainlinkSymbol: "btc/usd",
    chainlinkDataStreamsFeedId: null,
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
    polymarketChainlinkSymbol: "eth/usd",
    chainlinkDataStreamsFeedId: null,
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
    polymarketChainlinkSymbol: "sol/usd",
    chainlinkDataStreamsFeedId: null,
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
    polymarketChainlinkSymbol: "xrp/usd",
    chainlinkDataStreamsFeedId: null,
    kalshiSeriesTicker: "KXXRP15M",
    kalshiEventPath: "kxxrp15m/xrp-15-minute",
    coinbaseProductId: "XRP-USD",
  },
  doge: {
    asset: "doge",
    shortLabel: "DOGE 15m",
    title: "Dogecoin Up or Down - 15 minutes",
    aliases: ["dogecoin", "doge"],
    polymarketSlugPrefix: "doge-updown-15m",
    polymarketChainlinkSymbol: "doge/usd",
    chainlinkDataStreamsFeedId: null,
    kalshiSeriesTicker: "KXDOGE15M",
    kalshiEventPath: "kxdoge15m/dogecoin-15-minute",
    coinbaseProductId: "DOGE-USD",
  },
  bnb: {
    asset: "bnb",
    shortLabel: "BNB 15m",
    title: "BNB Up or Down - 15 minutes",
    aliases: ["bnb", "binance coin"],
    polymarketSlugPrefix: "bnb-updown-15m",
    polymarketChainlinkSymbol: "bnb/usd",
    chainlinkDataStreamsFeedId: "0x000335fd3f3ffa06cfd9297b97367f77145d7a5f132e84c736cc471dd98621fe",
    kalshiSeriesTicker: "KXBNB15M",
    kalshiEventPath: "kxbnb15m/bnb-15-minute",
    coinbaseProductId: "BNB-USD",
  },
  hype: {
    asset: "hype",
    shortLabel: "HYPE 15m",
    title: "HYPE Up or Down - 15 minutes",
    aliases: ["hype", "hyperliquid"],
    polymarketSlugPrefix: "hype-updown-15m",
    polymarketChainlinkSymbol: "hype/usd",
    chainlinkDataStreamsFeedId: "0x0003d34539af562867c3cb309b59efccf40e74b404fb415eeb7699d61322aed9",
    kalshiSeriesTicker: "KXHYPE15M",
    kalshiEventPath: "kxhype15m/hype-15-minute",
    coinbaseProductId: "HYPE-USD",
  },
};

export const MARKET_ASSETS = Object.keys(MARKET_CATALOG) as MarketAsset[];
export const ACTIVE_MARKET_ASSETS: MarketAsset[] = ["btc", "eth", "sol", "xrp", "doge", "bnb", "hype"];

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
