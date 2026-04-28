import crypto from "node:crypto";

import { POLY_BRIDGE_BASE } from "@/lib/constants";
import { hasPolymarketCredentials, readEnv } from "@/lib/env";
import { fetchJson } from "@/lib/fetch-json";
import type { BridgeTransfer } from "@/lib/types";

type DepositAddressesResponse = {
  address: {
    evm?: string;
    svm?: string;
    btc?: string;
  };
  note?: string;
};

type BridgeQuoteResponse = {
  quoteId?: string;
  txId?: string;
  amountIn?: string;
  amountOut?: string;
  estimatedAmountOut?: string;
  status?: string;
};

type BridgeTxStatusResponse = {
  status: string;
  txHash?: string;
  txId?: string;
  quoteId?: string;
};

export async function fetchPolymarketDepositAddresses(): Promise<BridgeTransfer | null> {
  if (!hasPolymarketCredentials()) {
    return null;
  }

  const env = readEnv();
  const response = await fetchJson<DepositAddressesResponse>(`${POLY_BRIDGE_BASE}/deposit`, {
    method: "POST",
    body: JSON.stringify({
      address: env.POLY_FUNDER_ADDRESS,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  });

  const now = Date.now();
  return {
    id: "poly-bridge-deposit-addresses",
    venue: "polymarket",
    status: "idle",
    createdAt: now,
    updatedAt: now,
    quoteId: null,
    sourceChain: null,
    sourceAsset: null,
    targetAsset: "pUSD",
    amountInUsd: null,
    amountOutUsd: null,
    txHash: null,
    depositAddresses: response.address ?? null,
    raw: response as unknown as Record<string, unknown>,
  };
}

export async function createPolymarketBridgeQuote(input: {
  fromChain: string;
  fromAsset: string;
  amount: string;
}): Promise<BridgeTransfer> {
  const env = readEnv();
  const response = await fetchJson<BridgeQuoteResponse>(`${POLY_BRIDGE_BASE}/quote`, {
    method: "POST",
    body: JSON.stringify({
      address: env.POLY_FUNDER_ADDRESS,
      fromChain: input.fromChain,
      fromAsset: input.fromAsset,
      amount: input.amount,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  });

  const now = Date.now();
  return {
    id: response.quoteId ?? response.txId ?? crypto.randomUUID(),
    venue: "polymarket",
    status: "quoted",
    createdAt: now,
    updatedAt: now,
    quoteId: response.quoteId ?? null,
    sourceChain: input.fromChain,
    sourceAsset: input.fromAsset,
    targetAsset: "pUSD",
    amountInUsd: response.amountIn ? Number(response.amountIn) : Number(input.amount),
    amountOutUsd: response.estimatedAmountOut
      ? Number(response.estimatedAmountOut)
      : response.amountOut
        ? Number(response.amountOut)
        : null,
    txHash: null,
    depositAddresses: null,
    raw: response as unknown as Record<string, unknown>,
  };
}

export async function fetchPolymarketBridgeTransactionStatus(txId: string) {
  return fetchJson<BridgeTxStatusResponse>(`${POLY_BRIDGE_BASE}/tx/${encodeURIComponent(txId)}`);
}
