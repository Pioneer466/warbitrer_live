import { constants as ethersConstants, utils } from "ethers";

import { POLY_PUSD_ADDRESS } from "@/lib/constants";
import {
  buildMergeTxData,
  buildRecoveryMarkets,
  buildRedeemTxData,
  classifyPolymarketRelayerTerminalState,
} from "@/lib/recovery";
import type { PositionSnapshot } from "@/lib/types";

describe("recovery helpers", () => {
  it("encodes redeemPositions for binary CTF markets", () => {
    const iface = new utils.Interface([
      "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
    ]);

    const txData = buildRedeemTxData("0x" + "12".repeat(32));
    const decoded = iface.decodeFunctionData("redeemPositions", txData);

    expect(decoded.collateralToken).toBe(POLY_PUSD_ADDRESS);
    expect(decoded.parentCollectionId).toBe(ethersConstants.HashZero);
    expect(decoded.conditionId).toBe("0x" + "12".repeat(32));
    expect(decoded.indexSets.map((value: any) => Number(value))).toEqual([1, 2]);
  });

  it("classifies Polymarket relayer terminal states according to the docs", () => {
    expect(classifyPolymarketRelayerTerminalState("STATE_NEW")).toBeNull();
    expect(classifyPolymarketRelayerTerminalState("STATE_EXECUTED")).toBeNull();
    expect(classifyPolymarketRelayerTerminalState("STATE_MINED")).toBeNull();
    expect(classifyPolymarketRelayerTerminalState("STATE_CONFIRMED")).toBe("confirmed");
    expect(classifyPolymarketRelayerTerminalState("STATE_FAILED")).toBe("failed");
    expect(classifyPolymarketRelayerTerminalState("STATE_INVALID")).toBe("failed");
  });

  it("encodes mergePositions with a 6-decimal collateral amount", () => {
    const iface = new utils.Interface([
      "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)",
    ]);

    const txData = buildMergeTxData("0x" + "34".repeat(32), "1234500");
    const decoded = iface.decodeFunctionData("mergePositions", txData);

    expect(decoded.collateralToken).toBe(POLY_PUSD_ADDRESS);
    expect(decoded.parentCollectionId).toBe(ethersConstants.HashZero);
    expect(decoded.conditionId).toBe("0x" + "34".repeat(32));
    expect(decoded.partition.map((value: any) => Number(value))).toEqual([1, 2]);
    expect(decoded.amount.toString()).toBe("1234500");
  });

  it("ignores ghost redeemable markets when the redeemable size is zero", () => {
    const positions: PositionSnapshot[] = [
      {
        id: "polymarket:ghost",
        asset: "btc",
        venue: "polymarket",
        marketRef: "0xghost",
        outcome: "UP",
        size: 0,
        averagePrice: null,
        currentPrice: 0,
        currentValueUsd: 0,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        redeemable: true,
        mergeable: false,
        updatedAt: 1,
        raw: {
          title: "Ghost market",
          slug: "ghost-market",
        },
      },
    ];

    expect(buildRecoveryMarkets(positions, { POLY_SIGNATURE_TYPE: "POLY_PROXY" } as any, true)).toEqual([]);
  });

  it("keeps redeemable markets actionable when there is positive redeemable size", () => {
    const positions: PositionSnapshot[] = [
      {
        id: "polymarket:redeemable",
        asset: "btc",
        venue: "polymarket",
        marketRef: "0xredeemable",
        outcome: "UP",
        size: 2.5,
        averagePrice: 0.4,
        currentPrice: 1,
        currentValueUsd: 2.5,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        redeemable: true,
        mergeable: false,
        updatedAt: 1,
        raw: {
          title: "Redeemable market",
          slug: "redeemable-market",
        },
      },
    ];

    expect(buildRecoveryMarkets(positions, { POLY_SIGNATURE_TYPE: "POLY_PROXY" } as any, true)).toMatchObject([
      {
        marketRef: "0xredeemable",
        redeemable: true,
        redeemableSize: 2.5,
        mergeable: false,
        conversionAction: "redeem",
      },
    ]);
  });
});
