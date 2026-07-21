import { utils } from "ethers";
import { describe, expect, it, vi } from "vitest";

import {
  applyPolymarketOrderFilledEvidence,
  buildPolymarketOnchainFillIdentity,
  extractPolymarketOrderFilledEvidence,
  fetchPolymarketOrderFilledEvidence,
  POLYMARKET_CTF_EXCHANGE_V2,
  POLYMARKET_NEG_RISK_CTF_EXCHANGE_V2,
  PolymarketOnchainEvidenceError,
  type PolymarketOnchainEvidenceErrorCode,
  type PolymarketTransactionReceiptLike,
} from "@/lib/polymarket-onchain-fill";

const ORDER_FILLED_ABI = [
  "event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)",
];
const orderFilledInterface = new utils.Interface(ORDER_FILLED_ABI);
const ORDER_HASH = `0x${"11".repeat(32)}`;
const OTHER_ORDER_HASH = `0x${"22".repeat(32)}`;
const TRANSACTION_HASH = `0x${"aa".repeat(32)}`;
const TOKEN_ID = "123456789012345678901234567890";
const MAKER = "0x1111111111111111111111111111111111111111";
const TAKER = "0x2222222222222222222222222222222222222222";
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const BUILDER = `0x${"33".repeat(32)}`;
const METADATA = `0x${"44".repeat(32)}`;

describe("Polymarket on-chain fill evidence", () => {
  it("extracts an exact BUY fee and builder attribution from CTF Exchange V2", () => {
    const receipt = buildReceipt([
      buildOrderFilledLog({
        side: 0,
        makerAmountFilled: 4_600_000,
        takerAmountFilled: 10_000_000,
        fee: 12_345,
        builder: BUILDER,
      }),
    ]);

    const evidence = extractPolymarketOrderFilledEvidence(receipt, {
      transactionHash: TRANSACTION_HASH,
      venueOrderId: ORDER_HASH,
      tokenId: TOKEN_ID,
      side: "BUY",
      size: 10,
      price: 0.46,
    });
    expect(evidence).toMatchObject({
      chainId: 137,
      transactionHash: TRANSACTION_HASH,
      exchangeAddress: POLYMARKET_CTF_EXCHANGE_V2,
      orderHash: ORDER_HASH,
      eventCount: 1,
      logIndexes: [7],
      side: "BUY",
      tokenId: TOKEN_ID,
      makerAmountFilledRaw: "4600000",
      takerAmountFilledRaw: "10000000",
      size: 10,
      price: 0.46,
      notionalUsd: 4.6,
      feeRaw: "12345",
      feeUsd: 0.012345,
      builderCodes: [BUILDER],
      metadata: [METADATA],
    });
    expect(buildPolymarketOnchainFillIdentity(evidence)).toEqual({
      fillId: `polymarket-fill:${ORDER_HASH}:${TRANSACTION_HASH}:7`,
      tradeId: `polygon-order-filled:${TRANSACTION_HASH}:7`,
    });
    expect(
      applyPolymarketOrderFilledEvidence(
        {
          id: "polymarket-fill:offchain-trade",
          asset: "btc",
          shadow: false,
          intentId: "intent-1",
          venue: "polymarket",
          venueOrderId: ORDER_HASH,
          tradeId: "offchain-trade",
          marketRef: "market-1",
          tokenId: TOKEN_ID,
          side: "BUY",
          outcome: "UP",
          price: 0.46,
          size: 10,
          feeUsd: 0,
          liquidity: "TAKER",
          filledAt: 123,
          raw: { id: "offchain-trade" },
        },
        evidence,
      ),
    ).toMatchObject({
      id: `polymarket-fill:${ORDER_HASH}:${TRANSACTION_HASH}:7`,
      tradeId: `polygon-order-filled:${TRANSACTION_HASH}:7`,
      price: 0.46,
      size: 10,
      feeUsd: 0.012345,
      raw: { id: "offchain-trade", onchainOrderFilled: evidence },
    });
  });

  it("extracts SELL economics and an explicit zero fee from the neg-risk exchange", () => {
    const receipt = buildReceipt([
      buildOrderFilledLog({
        address: POLYMARKET_NEG_RISK_CTF_EXCHANGE_V2,
        side: 1,
        makerAmountFilled: 4_000_000,
        takerAmountFilled: 2_400_000,
        fee: 0,
      }),
    ]);

    expect(
      extractPolymarketOrderFilledEvidence(receipt, {
        venueOrderId: ORDER_HASH,
        tokenId: TOKEN_ID,
        side: "SELL",
        size: 4,
        price: 0.6,
      }),
    ).toMatchObject({
      exchangeAddress: POLYMARKET_NEG_RISK_CTF_EXCHANGE_V2,
      side: "SELL",
      size: 4,
      price: 0.6,
      notionalUsd: 2.4,
      feeUsd: 0,
      builderCodes: [],
    });
  });

  it("aggregates multiple events for the same order without losing micro-unit precision", () => {
    const receipt = buildReceipt([
      buildOrderFilledLog({
        side: 0,
        makerAmountFilled: 1_500_000,
        takerAmountFilled: 3_000_000,
        fee: 1,
        logIndex: 8,
      }),
      buildOrderFilledLog({
        side: 0,
        makerAmountFilled: 3_500_000,
        takerAmountFilled: 7_000_000,
        fee: 2,
        logIndex: 7,
      }),
    ]);

    expect(
      extractPolymarketOrderFilledEvidence(receipt, {
        venueOrderId: ORDER_HASH,
        tokenId: TOKEN_ID,
        side: "BUY",
        size: 10,
        price: 0.5,
      }),
    ).toMatchObject({
      eventCount: 2,
      logIndexes: [7, 8],
      size: 10,
      notionalUsd: 5,
      feeRaw: "3",
      feeUsd: 0.000003,
    });
  });

  it("rejects failed receipts, untrusted contracts, and mismatched order economics", () => {
    expectEvidenceCode(
      () => extractPolymarketOrderFilledEvidence({ ...buildReceipt([]), status: 0 }, expectedBuy()),
      "receipt_failed",
    );
    expectEvidenceCode(
      () =>
        extractPolymarketOrderFilledEvidence(
          buildReceipt([buildOrderFilledLog({ address: MAKER, side: 0 })]),
          expectedBuy(),
        ),
      "order_fill_missing",
    );
    expectEvidenceCode(
      () =>
        extractPolymarketOrderFilledEvidence(
          buildReceipt([buildOrderFilledLog({ orderHash: OTHER_ORDER_HASH, side: 0 })]),
          expectedBuy(),
        ),
      "order_fill_missing",
    );
    expectEvidenceCode(
      () => extractPolymarketOrderFilledEvidence(buildReceipt([buildOrderFilledLog({ side: 1 })]), expectedBuy()),
      "order_fill_mismatch",
    );
    expectEvidenceCode(
      () =>
        extractPolymarketOrderFilledEvidence(
          buildReceipt([buildOrderFilledLog({ side: 0, takerAmountFilled: 9_000_000 })]),
          expectedBuy(),
        ),
      "order_fill_mismatch",
    );
  });

  it("fetches only confirmed trades from Polygon chain 137", async () => {
    const receipt = buildReceipt([buildOrderFilledLog({ side: 0 })]);
    const reader = {
      getNetwork: vi.fn(async () => ({ chainId: 137 })),
      getTransactionReceipt: vi.fn(async () => receipt),
    };

    await expect(
      fetchPolymarketOrderFilledEvidence(
        { id: "trade-1", status: "TRADE_STATUS_CONFIRMED", transaction_hash: TRANSACTION_HASH },
        expectedBuy(),
        { reader },
      ),
    ).resolves.toMatchObject({ feeUsd: 0.012345, transactionHash: TRANSACTION_HASH });
    expect(reader.getNetwork).toHaveBeenCalledOnce();
    expect(reader.getTransactionReceipt).toHaveBeenCalledWith(TRANSACTION_HASH);
  });

  it("fails closed on missing transaction hashes, non-final trades, and the wrong chain", async () => {
    await expectEvidenceCodeAsync(
      () =>
        fetchPolymarketOrderFilledEvidence(
          { id: "trade-1", status: "MATCHED", transaction_hash: TRANSACTION_HASH },
          expectedBuy(),
          { reader: { getTransactionReceipt: vi.fn() } },
        ),
      "trade_not_confirmed",
    );
    await expectEvidenceCodeAsync(
      () =>
        fetchPolymarketOrderFilledEvidence(
          { id: "trade-1", status: "CONFIRMED", transaction_hash: undefined },
          expectedBuy(),
          { reader: { getTransactionReceipt: vi.fn() } },
        ),
      "transaction_hash_missing",
    );
    await expectEvidenceCodeAsync(
      () =>
        fetchPolymarketOrderFilledEvidence(
          { id: "trade-1", status: "CONFIRMED", transaction_hash: TRANSACTION_HASH },
          expectedBuy(),
          {
            reader: {
              getNetwork: vi.fn(async () => ({ chainId: 1 })),
              getTransactionReceipt: vi.fn(async () => buildReceipt([])),
            },
          },
        ),
      "polygon_chain_mismatch",
    );
  });
});

function expectedBuy() {
  return {
    transactionHash: TRANSACTION_HASH,
    venueOrderId: ORDER_HASH,
    tokenId: TOKEN_ID,
    side: "BUY" as const,
    size: 10,
    price: 0.46,
  };
}

function buildReceipt(logs: PolymarketTransactionReceiptLike["logs"]): PolymarketTransactionReceiptLike {
  return {
    transactionHash: TRANSACTION_HASH,
    blockNumber: 77,
    status: 1,
    logs,
  };
}

function buildOrderFilledLog(input: {
  address?: string;
  orderHash?: string;
  side: 0 | 1;
  tokenId?: string;
  makerAmountFilled?: number;
  takerAmountFilled?: number;
  fee?: number;
  builder?: string;
  metadata?: string;
  logIndex?: number;
}) {
  const encoded = orderFilledInterface.encodeEventLog(orderFilledInterface.getEvent("OrderFilled"), [
    input.orderHash ?? ORDER_HASH,
    MAKER,
    TAKER,
    input.side,
    input.tokenId ?? TOKEN_ID,
    input.makerAmountFilled ?? 4_600_000,
    input.takerAmountFilled ?? 10_000_000,
    input.fee ?? 12_345,
    input.builder ?? ZERO_BYTES32,
    input.metadata ?? METADATA,
  ]);
  return {
    address: input.address ?? POLYMARKET_CTF_EXCHANGE_V2,
    topics: encoded.topics,
    data: encoded.data,
    logIndex: input.logIndex ?? 7,
  };
}

function expectEvidenceCode(action: () => unknown, code: PolymarketOnchainEvidenceErrorCode) {
  try {
    action();
    throw new Error(`Expected Polymarket evidence error ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(PolymarketOnchainEvidenceError);
    expect(error).toMatchObject({ code });
  }
}

async function expectEvidenceCodeAsync(action: () => Promise<unknown>, code: PolymarketOnchainEvidenceErrorCode) {
  try {
    await action();
    throw new Error(`Expected Polymarket evidence error ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(PolymarketOnchainEvidenceError);
    expect(error).toMatchObject({ code });
  }
}
