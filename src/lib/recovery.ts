import { constants as ethersConstants, providers, utils, Wallet } from "ethers";

import { POLY_CTF_ADDRESS, POLY_USDCE_ADDRESS } from "@/lib/constants";
import { isTruthyEnv, readEnv, readSecretValue } from "@/lib/env";
import {
  derivePolymarketProxyAddress,
  readPolymarketSignerAddress,
  submitPolymarketProxyTransactions,
} from "@/lib/polymarket-relayer";
import { readCircuitBreakers, readPositions, readRunEvents, writeRunEvent } from "@/lib/storage";
import type { PositionSnapshot, RecoveryMarket, RecoveryResponse } from "@/lib/types";

const AUTO_CONVERT_COOLDOWN_MS = 15 * 60 * 1000;

export async function buildRecoveryResponse(): Promise<RecoveryResponse> {
  const env = readEnv();
  const [positions, breakers] = await Promise.all([readPositions(), readCircuitBreakers()]);
  const walletValidation = buildWalletValidation(env);
  const markets = buildRecoveryMarkets(positions, env, walletValidation.canDirectConversion);

  return {
    fetchedAt: Date.now(),
    globalKillSwitchActive: breakers.some((breaker) => breaker.key === "global" && breaker.active),
    signatureType: env.POLY_SIGNATURE_TYPE ?? "unknown",
    funderAddress: env.POLY_FUNDER_ADDRESS ?? null,
    walletValidation,
    markets,
    kalshiSettlementMode: "automatic",
  };
}

export async function convertPolymarketMarket(marketRef: string) {
  const recovery = await buildRecoveryResponse();
  const market = recovery.markets.find((candidate) => candidate.marketRef === marketRef);

  if (!market || !market.conversionAction) {
    throw new Error("No directly convertible Polymarket position for this market");
  }

  return executePolymarketConversion(market);
}

export async function redeemPolymarketMarket(marketRef: string) {
  return convertPolymarketMarket(marketRef);
}

export async function autoConvertPolymarketIfConfigured(positions: PositionSnapshot[], now = Date.now()) {
  const env = readEnv();
  const walletValidation = buildWalletValidation(env);
  const autoConvertEnabled = isTruthyEnv(env.POLY_AUTO_CONVERT) || isTruthyEnv(env.POLY_AUTO_REDEEM);

  if (!autoConvertEnabled || !walletValidation.canDirectConversion) {
    return [];
  }

  const breakers = await readCircuitBreakers();
  if (breakers.some((breaker) => breaker.key === "global" && breaker.active)) {
    return [];
  }

  const recentEvents = await readRunEvents(200);
  const markets = buildRecoveryMarkets(positions, env, walletValidation.canDirectConversion).filter(
    (market) => market.conversionAction !== null && market.directConversionSupported,
  );
  const submitted: string[] = [];

  for (const market of markets) {
    const recentlySubmitted = recentEvents.some(
      (event) =>
        (event.eventType === "polymarket.convert.submitted" ||
          event.eventType === "polymarket.redeem.submitted" ||
          event.eventType === "polymarket.merge.submitted") &&
        typeof event.payload?.marketRef === "string" &&
        event.payload.marketRef === market.marketRef &&
        now - event.createdAt < AUTO_CONVERT_COOLDOWN_MS,
    );

    if (recentlySubmitted) {
      continue;
    }

    try {
      const result = await executePolymarketConversion(market);
      if (result.mode === "direct") {
        submitted.push(result.txHash ?? result.relayerTransactionId ?? market.marketRef);
      }
    } catch (error) {
      await writeRunEvent({
        level: "warn",
        eventType: "polymarket.convert.failed",
        message: error instanceof Error ? error.message : "Polymarket convert failed",
        payload: {
          marketRef: market.marketRef,
          conditionId: market.conditionId,
          action: market.conversionAction,
        },
        createdAt: now,
      });
    }
  }

  return submitted;
}

export async function autoRedeemPolymarketIfConfigured(positions: PositionSnapshot[], now = Date.now()) {
  return autoConvertPolymarketIfConfigured(positions, now);
}

export function buildRedeemTxData(conditionId: string) {
  const ctfInterface = new utils.Interface([
    "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
  ]);

  return ctfInterface.encodeFunctionData("redeemPositions", [
    POLY_USDCE_ADDRESS,
    ethersConstants.HashZero,
    conditionId,
    [1, 2],
  ]);
}

export function buildMergeTxData(conditionId: string, amount: string) {
  const ctfInterface = new utils.Interface([
    "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)",
  ]);

  return ctfInterface.encodeFunctionData("mergePositions", [
    POLY_USDCE_ADDRESS,
    ethersConstants.HashZero,
    conditionId,
    [1, 2],
    amount,
  ]);
}

function buildRecoveryMarkets(
  positions: PositionSnapshot[],
  env = readEnv(),
  directConversionSupported = buildWalletValidation(env).canDirectConversion,
): RecoveryMarket[] {
  const polymarketPositions = positions.filter((position) => position.venue === "polymarket");
  const marketsByRef = new Map<string, RecoveryMarket>();

  for (const position of polymarketPositions) {
    const raw = position.raw as Record<string, unknown>;
    const existing = marketsByRef.get(position.marketRef);
    const title = typeof raw.title === "string" && raw.title ? raw.title : position.marketRef;
    const slug = typeof raw.slug === "string" ? raw.slug : null;
    const url = slug ? `https://polymarket.com/event/${slug}` : null;

    if (!existing) {
      marketsByRef.set(position.marketRef, {
        marketRef: position.marketRef,
        conditionId: position.marketRef,
        title,
        url,
        outcomes: [],
        redeemable: false,
        mergeable: false,
        conversionAction: null,
        mergeableSize: null,
        directConversionSupported,
        notes: [],
      });
    }

    const market = marketsByRef.get(position.marketRef)!;
    market.outcomes.push({
      outcome: position.outcome,
      size: position.size,
      currentValueUsd: position.currentValueUsd,
      redeemable: position.redeemable,
      mergeable: position.mergeable,
    });
    market.redeemable ||= position.redeemable;
    market.mergeable ||= position.mergeable;
  }

  for (const market of marketsByRef.values()) {
    market.conversionAction = deriveRecoveryAction(market);
    market.mergeableSize = market.mergeable ? deriveMergeableSize(market) : null;

    if (market.redeemable) {
      market.notes.push("Gains Polymarket reclaimables vers USDC.e.");
    }
    if (market.mergeable) {
      market.notes.push("Paire complete mergeable vers USDC.e.");
      if (market.mergeableSize !== null) {
        market.notes.push(`Full sets mergeables: ${market.mergeableSize.toFixed(6)}`);
      }
    }
    if (directConversionSupported && env.POLY_SIGNATURE_TYPE === "POLY_PROXY" && (market.redeemable || market.mergeable)) {
      market.notes.push("Proxy wallet: conversion gasless via relayer Polymarket.");
    }
    if (!directConversionSupported && (market.redeemable || market.mergeable)) {
      market.notes.push("Conversion directe non prete: preparation manuelle ou UI Polymarket.");
    }
  }

  return [...marketsByRef.values()].sort((left, right) => {
    const leftRank = Number(left.redeemable) * 2 + Number(left.mergeable);
    const rightRank = Number(right.redeemable) * 2 + Number(right.mergeable);
    return rightRank - leftRank || left.title.localeCompare(right.title);
  });
}

function buildWalletValidation(env = readEnv()): RecoveryResponse["walletValidation"] {
  const checks: RecoveryResponse["walletValidation"]["checks"] = [];
  const requiredReady: boolean[] = [];
  let signerAddress: string | null = null;
  let derivedProxyAddress: string | null = null;

  const pushCheck = (check: RecoveryResponse["walletValidation"]["checks"][number], required = false) => {
    checks.push(check);
    if (required) {
      requiredReady.push(check.status === "ready");
    }
  };

  try {
    signerAddress = readPolymarketSignerAddress(env);
    derivedProxyAddress = derivePolymarketProxyAddress(signerAddress);
    pushCheck({
      key: "poly:signer-private-key",
      label: "Signer private key",
      status: "ready",
      details: `Signer detecte: ${signerAddress}`,
      checkedAt: Date.now(),
    }, true);
  } catch (error) {
    pushCheck({
      key: "poly:signer-private-key",
      label: "Signer private key",
      status: "blocked",
      details: error instanceof Error ? error.message : "Cle privee illisible",
      checkedAt: Date.now(),
    }, true);
  }

  if (env.POLY_SIGNATURE_TYPE === "EOA") {
    pushCheck({
      key: "poly:signature-type",
      label: "Wallet signature type",
      status: "ready",
      details: "POLY_SIGNATURE_TYPE=EOA",
      checkedAt: Date.now(),
    }, true);

    const addressMatches =
      signerAddress !== null &&
      Boolean(env.POLY_FUNDER_ADDRESS) &&
      signerAddress.toLowerCase() === env.POLY_FUNDER_ADDRESS!.toLowerCase();
    pushCheck({
      key: "poly:eoa-funder",
      label: "EOA funder address",
      status: addressMatches ? "ready" : "blocked",
      details: addressMatches
        ? "POLY_FUNDER_ADDRESS correspond au signer EOA"
        : "POLY_FUNDER_ADDRESS doit etre la meme adresse publique que le signer EOA",
      checkedAt: Date.now(),
    }, true);

    pushCheck({
      key: "poly:eoa-rpc",
      label: "Polygon RPC",
      status: env.POLYGON_RPC_URL ? "ready" : "blocked",
      details: env.POLYGON_RPC_URL
        ? `RPC configure: ${env.POLYGON_RPC_URL}`
        : "POLYGON_RPC_URL manquant pour envoyer la transaction on-chain",
      checkedAt: Date.now(),
    }, true);
  } else if (env.POLY_SIGNATURE_TYPE === "POLY_PROXY") {
    pushCheck({
      key: "poly:signature-type",
      label: "Wallet signature type",
      status: "ready",
      details: "POLY_SIGNATURE_TYPE=POLY_PROXY",
      checkedAt: Date.now(),
    }, true);

    const proxyMatches =
      derivedProxyAddress !== null &&
      Boolean(env.POLY_FUNDER_ADDRESS) &&
      derivedProxyAddress.toLowerCase() === env.POLY_FUNDER_ADDRESS!.toLowerCase();
    pushCheck({
      key: "poly:proxy-funder",
      label: "Proxy funder address",
      status: proxyMatches ? "ready" : "blocked",
      details: proxyMatches
        ? `POLY_FUNDER_ADDRESS correspond au proxy derive: ${derivedProxyAddress}`
        : derivedProxyAddress
          ? `POLY_FUNDER_ADDRESS doit etre le proxy wallet derive du signer: ${derivedProxyAddress}`
          : "Impossible de deriver l'adresse proxy sans signer valide",
      checkedAt: Date.now(),
    }, true);

    pushCheck({
      key: "poly:proxy-relayer-key",
      label: "Relayer API key",
      status: env.POLY_RELAYER_API_KEY ? "ready" : "blocked",
      details: env.POLY_RELAYER_API_KEY
        ? "RELAYER_API_KEY present pour le relayer gasless"
        : "Creer une relayer API key dans Polymarket > Settings > API Keys",
      checkedAt: Date.now(),
    }, true);

    pushCheck({
      key: "poly:proxy-rpc",
      label: "Polygon RPC",
      status: env.POLYGON_RPC_URL ? "ready" : "degraded",
      details: env.POLYGON_RPC_URL
        ? `RPC configure: ${env.POLYGON_RPC_URL}`
        : "POLYGON_RPC_URL absent: le relayer peut encore fonctionner, mais sans estimation de gas precise",
      checkedAt: Date.now(),
    });
  } else if (env.POLY_SIGNATURE_TYPE === "POLY_GNOSIS_SAFE") {
    pushCheck({
      key: "poly:signature-type",
      label: "Wallet signature type",
      status: "degraded",
      details: "POLY_GNOSIS_SAFE detecte: la conversion in-app n'est pas encore cablee pour ce mode",
      checkedAt: Date.now(),
    }, true);
  } else {
    pushCheck({
      key: "poly:signature-type",
      label: "Wallet signature type",
      status: "blocked",
      details: "POLY_SIGNATURE_TYPE manquant ou invalide",
      checkedAt: Date.now(),
    }, true);
  }

  pushCheck({
    key: "poly:l2-creds",
    label: "CLOB API credentials",
    status: env.POLY_API_KEY && env.POLY_API_SECRET && env.POLY_API_PASSPHRASE ? "ready" : "degraded",
    details:
      env.POLY_API_KEY && env.POLY_API_SECRET && env.POLY_API_PASSPHRASE
        ? "POLY_API_KEY / SECRET / PASSPHRASE presents"
        : "Deriver les credentials via npm run poly:derive-api-key pour le trading CLOB",
    checkedAt: Date.now(),
  });

  const canDirectConversion = requiredReady.length > 0 && requiredReady.every(Boolean);
  return {
    canDirectConversion,
    checks,
  };
}

async function executePolymarketConversion(market: RecoveryMarket) {
  if (market.conversionAction === "redeem") {
    return redeemPolymarketCondition(market.conditionId, market.marketRef);
  }

  if (market.conversionAction === "merge") {
    return mergePolymarketCondition(market);
  }

  throw new Error("No convertible action available for this market");
}

async function redeemPolymarketCondition(conditionId: string, marketRef: string) {
  const env = readEnv();
  const walletValidation = buildWalletValidation(env);
  const txData = buildRedeemTxData(conditionId);

  if (env.POLY_SIGNATURE_TYPE === "POLY_PROXY" && walletValidation.canDirectConversion) {
    const submitted = await submitPolymarketProxyTransactions(
      [
        {
          to: POLY_CTF_ADDRESS,
          data: txData,
          value: "0",
        },
      ],
      `redeem:${marketRef}`,
      env,
    );
    const txHash = submitted.transactionHash;
    const relayerState = submitted.state;

    await writeRunEvent({
      level: "info",
      eventType: "polymarket.redeem.submitted",
      message: `Redeem submitted for ${marketRef} via proxy relayer`,
      payload: {
        marketRef,
        conditionId,
        txHash,
        relayerTransactionId: submitted.transactionId,
        relayerState,
      },
      createdAt: Date.now(),
    });

    await writeRunEvent({
      level: "info",
      eventType: "polymarket.convert.submitted",
      message: `Redeem submitted for ${marketRef} via proxy relayer`,
      payload: {
        marketRef,
        conditionId,
        txHash,
        relayerTransactionId: submitted.transactionId,
        relayerState,
        action: "redeem",
      },
      createdAt: Date.now(),
    });

    return {
      ok: true as const,
      mode: "direct" as const,
      txHash,
      relayerTransactionId: submitted.transactionId,
      relayerState,
      marketRef,
      conditionId,
      action: "redeem" as const,
    };
  }

  if (env.POLY_SIGNATURE_TYPE !== "EOA" || !walletValidation.canDirectConversion) {
    return {
      ok: false as const,
      mode: "manual" as const,
      reason: buildManualConversionReason(env.POLY_SIGNATURE_TYPE ?? "unknown", "redeem"),
      tx: {
        to: POLY_CTF_ADDRESS,
        data: txData,
        value: "0",
        conditionId,
        indexSets: [1, 2],
        operation: "redeem" as const,
      },
    };
  }

  const privateKey = readSecretValue({
    inline: env.POLY_PRIVATE_KEY,
    path: env.POLY_PRIVATE_KEY_PATH,
    label: "POLY_PRIVATE_KEY",
  });
  const provider = new providers.JsonRpcProvider(env.POLYGON_RPC_URL ?? "https://polygon-rpc.com");
  const signer = new Wallet(privateKey, provider);

  if (!env.POLY_FUNDER_ADDRESS || signer.address.toLowerCase() !== env.POLY_FUNDER_ADDRESS.toLowerCase()) {
    throw new Error(
      "Direct redeem only supported when POLY_SIGNATURE_TYPE=EOA and POLY_FUNDER_ADDRESS matches the signer wallet address.",
    );
  }

  const tx = await signer.sendTransaction({
    to: POLY_CTF_ADDRESS,
    data: txData,
    value: 0,
  });

  await writeRunEvent({
    level: "info",
    eventType: "polymarket.redeem.submitted",
    message: `Redeem submitted for ${marketRef}`,
    payload: {
      marketRef,
      conditionId,
      txHash: tx.hash,
    },
    createdAt: Date.now(),
  });

  await writeRunEvent({
    level: "info",
    eventType: "polymarket.convert.submitted",
    message: `Redeem submitted for ${marketRef}`,
    payload: {
      marketRef,
      conditionId,
      txHash: tx.hash,
      action: "redeem",
    },
    createdAt: Date.now(),
  });

  return {
    ok: true as const,
    mode: "direct" as const,
    txHash: tx.hash,
    marketRef,
    conditionId,
    action: "redeem" as const,
  };
}

async function mergePolymarketCondition(market: RecoveryMarket) {
  if (market.mergeableSize === null || market.mergeableSize <= 0) {
    throw new Error("No mergeable full set size available for this market");
  }

  const env = readEnv();
  const walletValidation = buildWalletValidation(env);
  const amount = toRawCollateralAmount(market.mergeableSize);
  const txData = buildMergeTxData(market.conditionId, amount);

  if (env.POLY_SIGNATURE_TYPE === "POLY_PROXY" && walletValidation.canDirectConversion) {
    const submitted = await submitPolymarketProxyTransactions(
      [
        {
          to: POLY_CTF_ADDRESS,
          data: txData,
          value: "0",
        },
      ],
      `merge:${market.marketRef}`,
      env,
    );
    const txHash = submitted.transactionHash;
    const relayerState = submitted.state;

    await writeRunEvent({
      level: "info",
      eventType: "polymarket.merge.submitted",
      message: `Merge submitted for ${market.marketRef} via proxy relayer`,
      payload: {
        marketRef: market.marketRef,
        conditionId: market.conditionId,
        txHash,
        relayerTransactionId: submitted.transactionId,
        relayerState,
        amount,
      },
      createdAt: Date.now(),
    });

    await writeRunEvent({
      level: "info",
      eventType: "polymarket.convert.submitted",
      message: `Merge submitted for ${market.marketRef} via proxy relayer`,
      payload: {
        marketRef: market.marketRef,
        conditionId: market.conditionId,
        txHash,
        relayerTransactionId: submitted.transactionId,
        relayerState,
        action: "merge",
        amount,
      },
      createdAt: Date.now(),
    });

    return {
      ok: true as const,
      mode: "direct" as const,
      txHash,
      relayerTransactionId: submitted.transactionId,
      relayerState,
      marketRef: market.marketRef,
      conditionId: market.conditionId,
      amount,
      action: "merge" as const,
    };
  }

  if (env.POLY_SIGNATURE_TYPE !== "EOA" || !walletValidation.canDirectConversion) {
    return {
      ok: false as const,
      mode: "manual" as const,
      reason: buildManualConversionReason(env.POLY_SIGNATURE_TYPE ?? "unknown", "merge"),
      tx: {
        to: POLY_CTF_ADDRESS,
        data: txData,
        value: "0",
        conditionId: market.conditionId,
        indexSets: [1, 2],
        amount,
        operation: "merge" as const,
      },
    };
  }

  const privateKey = readSecretValue({
    inline: env.POLY_PRIVATE_KEY,
    path: env.POLY_PRIVATE_KEY_PATH,
    label: "POLY_PRIVATE_KEY",
  });
  const provider = new providers.JsonRpcProvider(env.POLYGON_RPC_URL ?? "https://polygon-rpc.com");
  const signer = new Wallet(privateKey, provider);

  if (!env.POLY_FUNDER_ADDRESS || signer.address.toLowerCase() !== env.POLY_FUNDER_ADDRESS.toLowerCase()) {
    throw new Error(
      "Direct merge only supported when POLY_SIGNATURE_TYPE=EOA and POLY_FUNDER_ADDRESS matches the signer wallet address.",
    );
  }

  const tx = await signer.sendTransaction({
    to: POLY_CTF_ADDRESS,
    data: txData,
    value: 0,
  });

  await writeRunEvent({
    level: "info",
    eventType: "polymarket.merge.submitted",
    message: `Merge submitted for ${market.marketRef}`,
    payload: {
      marketRef: market.marketRef,
      conditionId: market.conditionId,
      txHash: tx.hash,
      amount,
    },
    createdAt: Date.now(),
  });

  await writeRunEvent({
    level: "info",
    eventType: "polymarket.convert.submitted",
    message: `Merge submitted for ${market.marketRef}`,
    payload: {
      marketRef: market.marketRef,
      conditionId: market.conditionId,
      txHash: tx.hash,
      action: "merge",
      amount,
    },
    createdAt: Date.now(),
  });

  return {
    ok: true as const,
    mode: "direct" as const,
    txHash: tx.hash,
    marketRef: market.marketRef,
    conditionId: market.conditionId,
    amount,
    action: "merge" as const,
  };
}

function deriveRecoveryAction(market: RecoveryMarket): RecoveryMarket["conversionAction"] {
  if (market.redeemable) {
    return "redeem";
  }

  if (market.mergeable) {
    return "merge";
  }

  return null;
}

function deriveMergeableSize(market: RecoveryMarket) {
  const mergeableOutcomes = market.outcomes.filter((outcome) => outcome.size > 0);
  if (mergeableOutcomes.length < 2) {
    return null;
  }

  const size = Math.min(...mergeableOutcomes.map((outcome) => outcome.size));
  return floorToTokenPrecision(size);
}

function floorToTokenPrecision(value: number) {
  return Math.floor(value * 1_000_000) / 1_000_000;
}

function toRawCollateralAmount(value: number) {
  const normalized = floorToTokenPrecision(value).toFixed(6);
  const raw = utils.parseUnits(normalized, 6);
  if (raw.lte(0)) {
    throw new Error("Merge amount is too small after 6-decimal normalization");
  }

  return raw.toString();
}

function buildManualConversionReason(signatureType: RecoveryResponse["signatureType"], action: "redeem" | "merge") {
  if (signatureType === "POLY_PROXY") {
    return `Direct ${action} via proxy requires a valid Magic Link signer export, a matching POLY_FUNDER_ADDRESS, and POLY_RELAYER_API_KEY.`;
  }

  if (signatureType === "EOA") {
    return `Direct ${action} via EOA requires a signer private key, a matching POLY_FUNDER_ADDRESS, and a working Polygon RPC URL.`;
  }

  return `Direct ${action} is not supported in-app for ${signatureType}. Use the Polymarket UI or a relayer-compatible wallet.`;
}
