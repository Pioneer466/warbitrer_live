import type { DecodedV2Report, DecodedV3Report, Report } from "@chainlink/data-streams-sdk";

import { normalizeChainlinkV3Report } from "@/lib/chainlink-data-streams";
import { MARKET_CATALOG } from "@/lib/market-catalog";

describe("Chainlink Data Streams", () => {
  const feedId = MARKET_CATALOG.bnb.chainlinkDataStreamsFeedId!;
  const report: Report = {
    feedID: feedId,
    fullReport: "0x",
    validFromTimestamp: 1_784_830_500,
    observationsTimestamp: 1_784_830_501,
  };

  it("maps the official BNB and HYPE V3 feed identifiers", () => {
    expect(MARKET_CATALOG.bnb.chainlinkDataStreamsFeedId).toBe(
      "0x000335fd3f3ffa06cfd9297b97367f77145d7a5f132e84c736cc471dd98621fe",
    );
    expect(MARKET_CATALOG.hype.chainlinkDataStreamsFeedId).toBe(
      "0x0003d34539af562867c3cb309b59efccf40e74b404fb415eeb7699d61322aed9",
    );
  });

  it("normalizes a signed V3 observation using its source timestamp", () => {
    const decoded = {
      version: "V3",
      nativeFee: 0n,
      linkFee: 0n,
      expiresAt: 1_784_830_510,
      price: 566_020_000_000_000_000_000n,
      bid: 566_010_000_000_000_000_000n,
      ask: 566_030_000_000_000_000_000n,
    } satisfies DecodedV3Report;

    expect(normalizeChainlinkV3Report("bnb", feedId, report, decoded, 1_784_830_501_250)).toEqual({
      asset: "bnb",
      feedId,
      priceUsd: 566.02,
      sourceTimestampMs: 1_784_830_501_000,
      receivedAt: 1_784_830_501_250,
    });
  });

  it("rejects a report from another feed or schema", () => {
    const decoded = {
      version: "V3",
      nativeFee: 0n,
      linkFee: 0n,
      expiresAt: 2,
      price: 1n,
      bid: 1n,
      ask: 1n,
    } satisfies DecodedV3Report;

    expect(() =>
      normalizeChainlinkV3Report("bnb", feedId, { ...report, feedID: `0x${"f".repeat(64)}` }, decoded),
    ).toThrow("Feed Chainlink inattendu");
    expect(() =>
      normalizeChainlinkV3Report("bnb", feedId, report, {
        version: "V2",
        nativeFee: 0n,
        linkFee: 0n,
        expiresAt: 2,
        price: 1n,
      } satisfies DecodedV2Report),
    ).toThrow("Schema Chainlink inattendu");
  });
});
