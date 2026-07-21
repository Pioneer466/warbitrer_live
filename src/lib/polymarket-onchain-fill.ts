import type { Trade } from "@polymarket/clob-client-v2";
import { BigNumber, providers, utils } from "ethers";

import { normalizePolymarketTradeStatus } from "@/lib/polymarket-trade-status";
import type { LiveFill } from "@/lib/types";

export const POLYGON_CHAIN_ID = 137;
export const POLYMARKET_COLLATERAL_DECIMALS = 6;
export const POLYMARKET_CTF_EXCHANGE_V2 = "0xE111180000d2663C0091e4f400237545B87B996B";
export const POLYMARKET_NEG_RISK_CTF_EXCHANGE_V2 = "0xe2222d279d744050d28e00520010520000310F59";

const POLYMARKET_ORDER_FILLED_EVIDENCE_SCHEMA = "warbitrer.polymarket-order-filled.v1" as const;
const POLYMARKET_EXCHANGE_SOURCE_COMMIT = "ccc0596074f4dfd62c944fbca4de252893b82b4b";
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const RECEIPT_TIMEOUT_MS = 15_000;
const RECEIPT_CACHE_LIMIT = 512;
const ORDER_FILLED_ABI = [
  "event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)",
] as const;
const orderFilledInterface = new utils.Interface(ORDER_FILLED_ABI);
const orderFilledTopic = orderFilledInterface.getEventTopic("OrderFilled").toLowerCase();
const exchangeAddresses = new Set(
  [POLYMARKET_CTF_EXCHANGE_V2, POLYMARKET_NEG_RISK_CTF_EXCHANGE_V2].map((address) => address.toLowerCase()),
);
const providerByRpcUrl = new Map<string, providers.JsonRpcProvider>();
const receiptCache = new Map<string, Promise<PolymarketTransactionReceiptLike>>();

export type PolymarketReceiptLogLike = {
  address: string;
  topics: readonly string[];
  data: string;
  logIndex: number;
};

export type PolymarketTransactionReceiptLike = {
  transactionHash: string;
  blockNumber: number;
  status?: number;
  logs: readonly PolymarketReceiptLogLike[];
};

export type PolymarketReceiptReader = {
  getTransactionReceipt(transactionHash: string): Promise<PolymarketTransactionReceiptLike | null>;
  getNetwork?(): Promise<{ chainId: number }>;
};

export type PolymarketOrderFilledEvidence = {
  schema: typeof POLYMARKET_ORDER_FILLED_EVIDENCE_SCHEMA;
  chainId: typeof POLYGON_CHAIN_ID;
  contractSourceCommit: typeof POLYMARKET_EXCHANGE_SOURCE_COMMIT;
  transactionHash: string;
  blockNumber: number;
  exchangeAddress: string;
  orderHash: string;
  logIndexes: number[];
  eventCount: number;
  side: LiveFill["side"];
  tokenId: string;
  makerAmountFilledRaw: string;
  takerAmountFilledRaw: string;
  size: number;
  price: number;
  notionalUsd: number;
  feeRaw: string;
  feeUsd: number;
  builderCodes: string[];
  metadata: string[];
};

export function buildPolymarketOnchainFillIdentity(evidence: PolymarketOrderFilledEvidence) {
  const eventKey = `${evidence.transactionHash}:${evidence.logIndexes.join(",")}`;
  return {
    fillId: `polymarket-fill:${evidence.orderHash}:${eventKey}`,
    tradeId: `polygon-order-filled:${eventKey}`,
  };
}

export function applyPolymarketOrderFilledEvidence(fill: LiveFill, evidence: PolymarketOrderFilledEvidence): LiveFill {
  if (
    fill.venue !== "polymarket" ||
    fill.venueOrderId.toLowerCase() !== evidence.orderHash ||
    fill.side !== evidence.side ||
    (fill.tokenId ?? null) !== evidence.tokenId
  ) {
    throw new PolymarketOnchainEvidenceError(
      "order_fill_mismatch",
      `OrderFilled evidence does not match fill ${fill.id}`,
    );
  }
  const identity = buildPolymarketOnchainFillIdentity(evidence);
  return {
    ...fill,
    id: identity.fillId,
    tradeId: identity.tradeId,
    price: evidence.price,
    size: evidence.size,
    feeUsd: evidence.feeUsd,
    raw: {
      ...fill.raw,
      onchainOrderFilled: evidence,
    },
  };
}

export type PolymarketOnchainEvidenceErrorCode =
  | "trade_not_confirmed"
  | "transaction_hash_missing"
  | "transaction_hash_invalid"
  | "polygon_rpc_missing"
  | "polygon_chain_mismatch"
  | "receipt_unavailable"
  | "receipt_failed"
  | "receipt_transaction_mismatch"
  | "order_hash_invalid"
  | "order_fill_missing"
  | "order_fill_invalid"
  | "order_fill_mismatch";

export class PolymarketOnchainEvidenceError extends Error {
  constructor(
    readonly code: PolymarketOnchainEvidenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PolymarketOnchainEvidenceError";
  }
}

export function extractPolymarketOrderFilledEvidence(
  receipt: PolymarketTransactionReceiptLike,
  expected: Pick<LiveFill, "venueOrderId" | "tokenId" | "side" | "size" | "price"> & {
    transactionHash?: string;
  },
): PolymarketOrderFilledEvidence {
  const transactionHash = normalizeHash(
    receipt.transactionHash,
    "transaction_hash_invalid",
    "receipt transaction hash",
  );
  if (expected.transactionHash) {
    const expectedTransactionHash = normalizeHash(
      expected.transactionHash,
      "transaction_hash_invalid",
      "expected transaction hash",
    );
    if (transactionHash !== expectedTransactionHash) {
      throw new PolymarketOnchainEvidenceError(
        "receipt_transaction_mismatch",
        `Receipt ${transactionHash} does not match expected transaction ${expectedTransactionHash}`,
      );
    }
  }
  if (receipt.status !== 1) {
    throw new PolymarketOnchainEvidenceError(
      "receipt_failed",
      `Polymarket transaction ${transactionHash} is not a successful Polygon receipt`,
    );
  }
  if (!Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0) {
    throw new PolymarketOnchainEvidenceError("order_fill_invalid", "Polymarket receipt has an invalid block number");
  }

  const orderHash = normalizeHash(expected.venueOrderId, "order_hash_invalid", "Polymarket venue order id");
  const expectedTokenId = parseUnsignedInteger(expected.tokenId, "expected token id");
  const expectedSide = expected.side === "BUY" ? 0 : 1;
  const decoded = receipt.logs.flatMap((log) => {
    if (
      !exchangeAddresses.has(log.address.toLowerCase()) ||
      log.topics[0]?.toLowerCase() !== orderFilledTopic ||
      log.topics.length !== 4
    ) {
      return [];
    }

    try {
      const parsed = orderFilledInterface.parseLog({ data: log.data, topics: [...log.topics] });
      const parsedOrderHash = String(parsed.args.orderHash).toLowerCase();
      if (parsedOrderHash !== orderHash) {
        return [];
      }
      if (!Number.isSafeInteger(log.logIndex) || log.logIndex < 0) {
        throw new PolymarketOnchainEvidenceError("order_fill_invalid", "OrderFilled log has an invalid log index");
      }
      return [
        {
          exchangeAddress: utils.getAddress(log.address),
          logIndex: log.logIndex,
          side: BigNumber.from(parsed.args.side).toNumber(),
          tokenId: BigNumber.from(parsed.args.tokenId),
          makerAmountFilled: BigNumber.from(parsed.args.makerAmountFilled),
          takerAmountFilled: BigNumber.from(parsed.args.takerAmountFilled),
          fee: BigNumber.from(parsed.args.fee),
          builder: String(parsed.args.builder).toLowerCase(),
          metadata: String(parsed.args.metadata).toLowerCase(),
        },
      ];
    } catch (error) {
      if (error instanceof PolymarketOnchainEvidenceError) {
        throw error;
      }
      throw new PolymarketOnchainEvidenceError(
        "order_fill_invalid",
        `Unable to decode Polymarket OrderFilled log: ${toErrorMessage(error)}`,
      );
    }
  });

  if (decoded.length === 0) {
    throw new PolymarketOnchainEvidenceError(
      "order_fill_missing",
      `No CTF Exchange V2 OrderFilled event found for order ${orderHash} in ${transactionHash}`,
    );
  }

  const observedAddresses = new Set(decoded.map((event) => event.exchangeAddress.toLowerCase()));
  if (observedAddresses.size !== 1) {
    throw new PolymarketOnchainEvidenceError(
      "order_fill_mismatch",
      `Order ${orderHash} was emitted by multiple exchange contracts in one transaction`,
    );
  }
  for (const event of decoded) {
    if (event.side !== expectedSide || !event.tokenId.eq(expectedTokenId)) {
      throw new PolymarketOnchainEvidenceError(
        "order_fill_mismatch",
        `OrderFilled identity does not match ${expected.side} token ${expected.tokenId}`,
      );
    }
  }

  const makerAmountFilled = sumBigNumbers(decoded.map((event) => event.makerAmountFilled));
  const takerAmountFilled = sumBigNumbers(decoded.map((event) => event.takerAmountFilled));
  const fee = sumBigNumbers(decoded.map((event) => event.fee));
  const sizeRaw = expected.side === "BUY" ? takerAmountFilled : makerAmountFilled;
  const notionalRaw = expected.side === "BUY" ? makerAmountFilled : takerAmountFilled;
  const expectedSizeRaw = decimalToMicroUnits(expected.size, "expected fill size");
  const expectedNotionalRaw = decimalToMicroUnits(expected.size * expected.price, "expected fill notional");
  assertRawAmountClose(sizeRaw, expectedSizeRaw, 1, "size");
  assertRawAmountClose(notionalRaw, expectedNotionalRaw, Math.max(2, decoded.length), "notional");

  const size = microUnitsToNumber(sizeRaw, "fill size");
  const notionalUsd = microUnitsToNumber(notionalRaw, "fill notional");
  const feeUsd = microUnitsToNumber(fee, "fill fee");
  if (size <= 0 || notionalUsd < 0 || feeUsd < 0) {
    throw new PolymarketOnchainEvidenceError("order_fill_invalid", "OrderFilled amounts must be non-negative");
  }
  const price = Math.round((notionalUsd / size) * 100_000_000) / 100_000_000;
  if (!Number.isFinite(price) || price < 0 || price > 1) {
    throw new PolymarketOnchainEvidenceError("order_fill_invalid", `OrderFilled price ${price} is outside [0, 1]`);
  }

  return {
    schema: POLYMARKET_ORDER_FILLED_EVIDENCE_SCHEMA,
    chainId: POLYGON_CHAIN_ID,
    contractSourceCommit: POLYMARKET_EXCHANGE_SOURCE_COMMIT,
    transactionHash,
    blockNumber: receipt.blockNumber,
    exchangeAddress: decoded[0]!.exchangeAddress,
    orderHash,
    logIndexes: decoded.map((event) => event.logIndex).sort((left, right) => left - right),
    eventCount: decoded.length,
    side: expected.side,
    tokenId: expectedTokenId.toString(),
    makerAmountFilledRaw: makerAmountFilled.toString(),
    takerAmountFilledRaw: takerAmountFilled.toString(),
    size,
    price,
    notionalUsd,
    feeRaw: fee.toString(),
    feeUsd,
    builderCodes: uniqueSorted(decoded.map((event) => event.builder).filter((builder) => builder !== ZERO_BYTES32)),
    metadata: uniqueSorted(decoded.map((event) => event.metadata)),
  };
}

export async function fetchPolymarketOrderFilledEvidence(
  trade: Pick<Trade, "id" | "status" | "transaction_hash">,
  fill: Pick<LiveFill, "venueOrderId" | "tokenId" | "side" | "size" | "price">,
  options: {
    reader?: PolymarketReceiptReader;
    rpcUrl?: string;
    timeoutMs?: number;
  } = {},
) {
  if (normalizePolymarketTradeStatus(trade.status) !== "CONFIRMED") {
    throw new PolymarketOnchainEvidenceError("trade_not_confirmed", `Polymarket trade ${trade.id} is not confirmed`);
  }
  const transactionHash = normalizeHash(
    trade.transaction_hash,
    trade.transaction_hash ? "transaction_hash_invalid" : "transaction_hash_missing",
    `transaction hash for Polymarket trade ${trade.id}`,
  );
  const rpcUrl = options.rpcUrl?.trim() || process.env.POLYGON_RPC_URL?.trim();
  if (!options.reader && !rpcUrl) {
    throw new PolymarketOnchainEvidenceError(
      "polygon_rpc_missing",
      "POLYGON_RPC_URL is required for exact Polymarket fill accounting",
    );
  }
  const reader = options.reader ?? getPolygonProvider(rpcUrl!);
  if (reader.getNetwork) {
    const network = await withTimeout(
      reader.getNetwork(),
      options.timeoutMs ?? RECEIPT_TIMEOUT_MS,
      `Polygon network lookup timed out for Polymarket trade ${trade.id}`,
    );
    if (network.chainId !== POLYGON_CHAIN_ID) {
      throw new PolymarketOnchainEvidenceError(
        "polygon_chain_mismatch",
        `POLYGON_RPC_URL returned chain ${network.chainId}; expected ${POLYGON_CHAIN_ID}`,
      );
    }
  }

  const receipt = await readReceipt(reader, transactionHash, options.timeoutMs ?? RECEIPT_TIMEOUT_MS, rpcUrl ?? null);
  if (!receipt) {
    throw new PolymarketOnchainEvidenceError(
      "receipt_unavailable",
      `Polygon receipt ${transactionHash} is not available for confirmed Polymarket trade ${trade.id}`,
    );
  }
  return extractPolymarketOrderFilledEvidence(receipt, { ...fill, transactionHash });
}

function getPolygonProvider(rpcUrl: string) {
  const cached = providerByRpcUrl.get(rpcUrl);
  if (cached) {
    return cached;
  }
  const provider = new providers.JsonRpcProvider(rpcUrl, POLYGON_CHAIN_ID);
  providerByRpcUrl.set(rpcUrl, provider);
  return provider;
}

async function readReceipt(
  reader: PolymarketReceiptReader,
  transactionHash: string,
  timeoutMs: number,
  rpcUrl: string | null,
) {
  const cacheKey = rpcUrl ? `${rpcUrl}\u0000${transactionHash}` : null;
  let pending = cacheKey ? receiptCache.get(cacheKey) : undefined;
  if (!pending) {
    pending = withTimeout(
      reader.getTransactionReceipt(transactionHash),
      timeoutMs,
      `Polygon receipt lookup timed out for ${transactionHash}`,
    ).then((receipt) => {
      if (!receipt) {
        throw new PolymarketOnchainEvidenceError("receipt_unavailable", `Polygon receipt ${transactionHash} not found`);
      }
      return receipt;
    });
    if (cacheKey) {
      receiptCache.set(cacheKey, pending);
      trimReceiptCache();
      pending.catch(() => receiptCache.delete(cacheKey));
    }
  }
  try {
    return await pending;
  } catch (error) {
    if (error instanceof PolymarketOnchainEvidenceError) {
      if (error.code === "receipt_unavailable") {
        return null;
      }
      throw error;
    }
    throw new PolymarketOnchainEvidenceError(
      "receipt_unavailable",
      `Unable to read Polygon receipt ${transactionHash}: ${toErrorMessage(error)}`,
    );
  }
}

function trimReceiptCache() {
  while (receiptCache.size > RECEIPT_CACHE_LIMIT) {
    const oldest = receiptCache.keys().next().value as string | undefined;
    if (!oldest) {
      return;
    }
    receiptCache.delete(oldest);
  }
}

function normalizeHash(
  value: unknown,
  code: "transaction_hash_missing" | "transaction_hash_invalid" | "order_hash_invalid",
  label: string,
) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value.trim())) {
    throw new PolymarketOnchainEvidenceError(code, `${label} must be a 32-byte hex value`);
  }
  return value.trim().toLowerCase();
}

function parseUnsignedInteger(value: unknown, label: string) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    throw new PolymarketOnchainEvidenceError("order_fill_invalid", `${label} must be an unsigned integer`);
  }
  return BigNumber.from(value.trim());
}

function decimalToMicroUnits(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new PolymarketOnchainEvidenceError("order_fill_invalid", `${label} must be finite and non-negative`);
  }
  const scaled = Math.round(value * 10 ** POLYMARKET_COLLATERAL_DECIMALS);
  if (!Number.isSafeInteger(scaled)) {
    throw new PolymarketOnchainEvidenceError("order_fill_invalid", `${label} exceeds safe numeric precision`);
  }
  return BigNumber.from(scaled);
}

function microUnitsToNumber(value: BigNumber, label: string) {
  const parsed = Number(utils.formatUnits(value, POLYMARKET_COLLATERAL_DECIMALS));
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(Math.round(parsed * 10 ** POLYMARKET_COLLATERAL_DECIMALS))) {
    throw new PolymarketOnchainEvidenceError("order_fill_invalid", `${label} exceeds safe numeric precision`);
  }
  return parsed;
}

function assertRawAmountClose(actual: BigNumber, expected: BigNumber, tolerance: number, label: string) {
  const delta = actual.gte(expected) ? actual.sub(expected) : expected.sub(actual);
  if (delta.gt(tolerance)) {
    throw new PolymarketOnchainEvidenceError(
      "order_fill_mismatch",
      `OrderFilled ${label} ${actual.toString()} differs from trade ${expected.toString()} micro-units`,
    );
  }
}

function sumBigNumbers(values: readonly BigNumber[]) {
  return values.reduce((sum, value) => sum.add(value), BigNumber.from(0));
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new PolymarketOnchainEvidenceError("receipt_unavailable", message)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }) as Promise<T>;
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
