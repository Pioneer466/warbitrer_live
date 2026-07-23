import { ACTIVE_MARKET_ASSETS, inferKalshiAsset, inferPolymarketAsset, MARKET_ASSETS } from "@/lib/market-catalog";

describe("market catalog", () => {
  it("keeps assets in canonical order", () => {
    expect(MARKET_ASSETS).toEqual(["btc", "eth", "sol", "xrp", "doge", "bnb", "hype"]);
    expect(ACTIVE_MARKET_ASSETS).toEqual(["btc", "eth", "sol", "xrp", "doge", "bnb", "hype"]);
  });

  it("infers assets from Kalshi series tickers", () => {
    expect(inferKalshiAsset("KXBTC15M-26APR201445")).toBe("btc");
    expect(inferKalshiAsset("KXETH15M-26APR201445")).toBe("eth");
    expect(inferKalshiAsset("KXSOL15M-26APR201445")).toBe("sol");
    expect(inferKalshiAsset("KXXRP15M-26APR201445")).toBe("xrp");
    expect(inferKalshiAsset("KXDOGE15M-26APR201445")).toBe("doge");
    expect(inferKalshiAsset("KXBNB15M-26APR201445")).toBe("bnb");
    expect(inferKalshiAsset("KXHYPE15M-26APR201445")).toBe("hype");
  });

  it("infers assets from Polymarket slugs and titles", () => {
    expect(inferPolymarketAsset("btc-updown-15m-1776709800")).toBe("btc");
    expect(inferPolymarketAsset("eth-updown-15m-1776709800")).toBe("eth");
    expect(inferPolymarketAsset("sol-updown-15m-1776709800")).toBe("sol");
    expect(inferPolymarketAsset("xrp-updown-15m-1776709800")).toBe("xrp");
    expect(inferPolymarketAsset("doge-updown-15m-1776709800")).toBe("doge");
    expect(inferPolymarketAsset("bnb-updown-15m-1776709800")).toBe("bnb");
    expect(inferPolymarketAsset("hype-updown-15m-1776709800")).toBe("hype");
    expect(inferPolymarketAsset("Solana Up or Down - 15 minutes")).toBe("sol");
    expect(inferPolymarketAsset("XRP Up or Down - 15 minutes")).toBe("xrp");
    expect(inferPolymarketAsset("Whether XRP will close higher in 15 minutes?")).toBe("xrp");
    expect(inferPolymarketAsset("Dogecoin Up or Down - 15 minutes")).toBe("doge");
    expect(inferPolymarketAsset("BNB Up or Down - 15 minutes")).toBe("bnb");
    expect(inferPolymarketAsset("HYPE Up or Down - 15 minutes")).toBe("hype");
  });
});
