import { constants as ethersConstants, utils } from "ethers";

import { POLY_USDCE_ADDRESS } from "@/lib/constants";
import { buildMergeTxData, buildRedeemTxData } from "@/lib/recovery";

describe("recovery helpers", () => {
  it("encodes redeemPositions for binary CTF markets", () => {
    const iface = new utils.Interface([
      "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
    ]);

    const txData = buildRedeemTxData("0x" + "12".repeat(32));
    const decoded = iface.decodeFunctionData("redeemPositions", txData);

    expect(decoded.collateralToken).toBe(POLY_USDCE_ADDRESS);
    expect(decoded.parentCollectionId).toBe(ethersConstants.HashZero);
    expect(decoded.conditionId).toBe("0x" + "12".repeat(32));
    expect(decoded.indexSets.map((value: any) => Number(value))).toEqual([1, 2]);
  });

  it("encodes mergePositions with a 6-decimal collateral amount", () => {
    const iface = new utils.Interface([
      "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)",
    ]);

    const txData = buildMergeTxData("0x" + "34".repeat(32), "1234500");
    const decoded = iface.decodeFunctionData("mergePositions", txData);

    expect(decoded.collateralToken).toBe(POLY_USDCE_ADDRESS);
    expect(decoded.parentCollectionId).toBe(ethersConstants.HashZero);
    expect(decoded.conditionId).toBe("0x" + "34".repeat(32));
    expect(decoded.partition.map((value: any) => Number(value))).toEqual([1, 2]);
    expect(decoded.amount.toString()).toBe("1234500");
  });
});
