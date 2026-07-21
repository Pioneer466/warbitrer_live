import { createAbstractSigner } from "@polymarket/builder-abstract-signer";
import { CallType, type RelayerTransaction, encodeProxyTransactionData } from "@polymarket/builder-relayer-client";
import { providers, utils, Wallet } from "ethers";
import { concat, encodePacked, getCreate2Address, keccak256, toHex, type Hex } from "viem";

import { DEFAULT_POLY_CHAIN_ID } from "@/lib/constants";
import { type LiveEnv, readEnv, readSecretValue } from "@/lib/env";
import { fetchJson } from "@/lib/fetch-json";

const DEFAULT_POLY_RELAYER_URL = "https://relayer-v2.polymarket.com";
const POLY_PROXY_FACTORY = "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052" as const;
const POLY_RELAY_HUB = "0xD216153c06E857cD7f72665E0aF1d7D82172F494" as const;
const POLY_PROXY_INIT_CODE_HASH = "0xd21df8dc65880a8606f09fe0ce3df9b8869287ab0b058be05aa9e8af6330a00b" as const;
const DEFAULT_PROXY_GAS_LIMIT = BigInt(10_000_000);

type ProxyRelayPayload = {
  address: string;
  nonce: string;
};

type ProxyRelayerSubmitResponse = {
  transactionID: string;
  state: string;
  transactionHash?: string | null;
};

type ProxyTransactionRequest = {
  type: "PROXY";
  from: string;
  to: string;
  proxyWallet: string;
  data: string;
  nonce: string;
  signature: string;
  signatureParams: {
    gasPrice: string;
    gasLimit: string;
    relayerFee: string;
    relayHub: string;
    relay: string;
  };
  metadata: string;
};

type ProxyRelayTransaction = {
  to: string;
  data: string;
  value: string;
};

export type ProxyRelayerSubmission = {
  transactionId: string;
  transactionHash: string | null;
  state: string;
};

export type ProxyRelayerTransactionStatus = {
  transactionID?: string;
  transactionHash?: string | null;
  state: string;
};

export function readPolymarketSignerAddress(env = readEnv()) {
  return normalizeAddress(readPolymarketSigner(env).address, "POLY_PRIVATE_KEY");
}

export function derivePolymarketProxyAddress(signerAddress: string) {
  const normalizedSignerAddress = normalizeAddress(signerAddress, "signerAddress");
  return getCreate2Address({
    bytecodeHash: POLY_PROXY_INIT_CODE_HASH,
    from: POLY_PROXY_FACTORY,
    salt: keccak256(encodePacked(["address"], [normalizedSignerAddress])),
  });
}

export function buildPolymarketRelayerHeaders(apiKey: string, ownerAddress: string) {
  return {
    RELAYER_API_KEY: apiKey,
    RELAYER_API_KEY_ADDRESS: ownerAddress,
  };
}

export async function submitPolymarketProxyTransactions(
  transactions: ProxyRelayTransaction[],
  metadata = "",
  env = readEnv(),
): Promise<ProxyRelayerSubmission> {
  if (env.POLY_SIGNATURE_TYPE !== "POLY_PROXY") {
    throw new Error("Polymarket proxy relayer submission requires POLY_SIGNATURE_TYPE=POLY_PROXY.");
  }

  if (!env.POLY_RELAYER_API_KEY) {
    throw new Error("POLY_RELAYER_API_KEY missing. Create a relayer API key in Polymarket settings.");
  }

  const signer = readPolymarketSigner(env);
  const signerAddress = signer.address;
  const expectedProxyAddress = derivePolymarketProxyAddress(signerAddress);
  const configuredFunder = normalizeAddress(env.POLY_FUNDER_ADDRESS, "POLY_FUNDER_ADDRESS");

  if (configuredFunder !== expectedProxyAddress) {
    throw new Error(
      `POLY_FUNDER_ADDRESS must match the derived Polymarket proxy wallet for this signer. Expected ${expectedProxyAddress}.`,
    );
  }

  const relayerUrl = readRelayerUrl(env);
  const relayPayload = await fetchJson<ProxyRelayPayload>(
    `${relayerUrl}/relay-payload?address=${encodeURIComponent(signerAddress)}&type=PROXY`,
  );
  const abstractSigner = createAbstractSigner(DEFAULT_POLY_CHAIN_ID, signer);
  const request = await buildProxyTransactionRequest(
    abstractSigner,
    signerAddress,
    relayPayload,
    transactions,
    metadata,
  );
  const response = await fetchJson<ProxyRelayerSubmitResponse>(`${relayerUrl}/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildPolymarketRelayerHeaders(env.POLY_RELAYER_API_KEY, signerAddress),
    },
    body: JSON.stringify(request),
  });

  return {
    transactionId: response.transactionID,
    transactionHash: normalizeOptionalHash(response.transactionHash),
    state: response.state,
  };
}

export async function waitForPolymarketRelayerTransaction(
  transactionId: string,
  env = readEnv(),
  maxPolls = 8,
  pollFrequencyMs = 1_500,
) {
  if (!env.POLY_RELAYER_API_KEY) {
    return null;
  }

  const signerAddress = readPolymarketSignerAddress(env);
  const relayerUrl = readRelayerUrl(env);

  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const transactions = await fetchJson<RelayerTransaction[]>(
      `${relayerUrl}/transaction?id=${encodeURIComponent(transactionId)}`,
      {
        headers: buildPolymarketRelayerHeaders(env.POLY_RELAYER_API_KEY, signerAddress),
      },
    ).catch(() => []);

    const transaction = transactions[0];
    if (!transaction) {
      await sleep(pollFrequencyMs);
      continue;
    }

    if (transaction.state === "STATE_FAILED") {
      return transaction;
    }

    if (transaction.state === "STATE_MINED" || transaction.state === "STATE_CONFIRMED") {
      return transaction;
    }

    await sleep(pollFrequencyMs);
  }

  return null;
}

export async function getPolymarketRelayerTransaction(
  transactionId: string,
  env = readEnv(),
): Promise<ProxyRelayerTransactionStatus | null> {
  if (!env.POLY_RELAYER_API_KEY) {
    return null;
  }

  const signerAddress = readPolymarketSignerAddress(env);
  const relayerUrl = readRelayerUrl(env);
  const transactions = await fetchJson<RelayerTransaction[]>(
    `${relayerUrl}/transaction?id=${encodeURIComponent(transactionId)}`,
    {
      headers: buildPolymarketRelayerHeaders(env.POLY_RELAYER_API_KEY, signerAddress),
    },
  ).catch(() => []);

  return transactions[0] ?? null;
}

async function buildProxyTransactionRequest(
  signer: ReturnType<typeof createAbstractSigner>,
  signerAddress: string,
  relayPayload: ProxyRelayPayload,
  transactions: ProxyRelayTransaction[],
  metadata: string,
): Promise<ProxyTransactionRequest> {
  const normalizedSignerAddress = normalizeAddress(signerAddress, "signerAddress");
  const proxyWallet = derivePolymarketProxyAddress(normalizedSignerAddress);
  const data = encodeProxyTransactionData(
    transactions.map((transaction) => ({
      to: normalizeAddress(transaction.to, "transaction.to"),
      typeCode: CallType.Call,
      data: transaction.data,
      value: transaction.value,
    })),
  ) as Hex;
  const gasLimit = await estimateProxyGasLimit(signer, signerAddress, data);
  const relayerFee = "0";
  const requestHash = createProxyStructHash({
    from: normalizedSignerAddress,
    to: POLY_PROXY_FACTORY,
    data,
    txFee: relayerFee,
    gasPrice: "0",
    gasLimit,
    nonce: relayPayload.nonce,
    relayHubAddress: POLY_RELAY_HUB,
    relayAddress: normalizeAddress(relayPayload.address, "relayPayload.address"),
  });
  const signature = await signer.signMessage(requestHash);

  return {
    type: "PROXY",
    from: normalizedSignerAddress,
    to: POLY_PROXY_FACTORY,
    proxyWallet,
    data,
    nonce: relayPayload.nonce,
    signature,
    signatureParams: {
      gasPrice: "0",
      gasLimit,
      relayerFee,
      relayHub: POLY_RELAY_HUB,
      relay: normalizeAddress(relayPayload.address, "relayPayload.address"),
    },
    metadata,
  };
}

function createProxyStructHash(options: {
  from: Hex;
  to: Hex;
  data: Hex;
  txFee: string;
  gasPrice: string;
  gasLimit: string;
  nonce: string;
  relayHubAddress: Hex;
  relayAddress: Hex;
}) {
  return keccak256(
    concat([
      toHex("rlx:"),
      options.from,
      options.to,
      options.data,
      toHex(BigInt(options.txFee), { size: 32 }),
      toHex(BigInt(options.gasPrice), { size: 32 }),
      toHex(BigInt(options.gasLimit), { size: 32 }),
      toHex(BigInt(options.nonce), { size: 32 }),
      options.relayHubAddress,
      options.relayAddress,
    ]),
  );
}

async function estimateProxyGasLimit(
  signer: ReturnType<typeof createAbstractSigner>,
  signerAddress: string,
  data: string,
) {
  try {
    const gasLimit = await signer.estimateGas({
      from: signerAddress,
      to: POLY_PROXY_FACTORY,
      data,
    });
    return gasLimit.toString();
  } catch {
    return DEFAULT_PROXY_GAS_LIMIT.toString();
  }
}

function readPolymarketSigner(env: LiveEnv) {
  const privateKey = readSecretValue({
    inline: env.POLY_PRIVATE_KEY,
    path: env.POLY_PRIVATE_KEY_PATH,
    label: "POLY_PRIVATE_KEY",
  });

  if (env.POLYGON_RPC_URL) {
    return new Wallet(privateKey, new providers.JsonRpcProvider(env.POLYGON_RPC_URL));
  }

  return new Wallet(privateKey);
}

function normalizeAddress(value: string | undefined, label: string) {
  if (!value) {
    throw new Error(`${label} missing`);
  }

  try {
    return utils.getAddress(value) as Hex;
  } catch {
    throw new Error(`${label} must be a valid 0x-prefixed Ethereum address.`);
  }
}

function normalizeOptionalHash(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  return value.trim() ? value : null;
}

function readRelayerUrl(env: LiveEnv) {
  return (env.POLY_RELAYER_URL ?? DEFAULT_POLY_RELAYER_URL).replace(/\/+$/, "");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
