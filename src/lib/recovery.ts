import { constants as ethersConstants, providers, utils, Wallet } from "ethers";

import { POLY_CTF_ADDRESS, POLY_USDCE_ADDRESS } from "@/lib/constants";
import { isTruthyEnv, readEnv, readSecretValue } from "@/lib/env";
import { readCircuitBreakers, readPositions, readRunEvents, writeRunEvent } from "@/lib/storage";
import type { PositionSnapshot, RecoveryMarket, RecoveryResponse } from "@/lib/types";

const AUTO_REDEEM_COOLDOWN_MS = 15 * 60 * 1000;

export async function buildRecoveryResponse(): Promise<RecoveryResponse> {
  const [positions, breakers] = await Promise.all([readPositions(), readCircuitBreakers()]);
  const env = readEnv();
  const markets = buildRecoveryMarkets(positions, env);

  return {
    fetchedAt: Date.now(),
    globalKillSwitchActive: breakers.some((breaker) => breaker.key === "global" && breaker.active),
    signatureType: env.POLY_SIGNATURE_TYPE ?? "unknown",
    funderAddress: env.POLY_FUNDER_ADDRESS ?? null,
    eoaValidation: buildEoaValidation(env),
    markets,
    kalshiSettlementMode: "automatic",
  };
}

export async function redeemPolymarketMarket(marketRef: string) {
  const recovery = await buildRecoveryResponse();
  const market = recovery.markets.find((candidate) => candidate.marketRef === marketRef);

  if (!market || !market.redeemable) {
    throw new Error("No redeemable Polymarket position for this market");
  }

  return redeemPolymarketCondition(market.conditionId, market.marketRef);
}

export async function autoRedeemPolymarketIfConfigured(positions: PositionSnapshot[], now = Date.now()) {
  const env = readEnv();
  if (!isTruthyEnv(env.POLY_AUTO_REDEEM) || env.POLY_SIGNATURE_TYPE !== "EOA") {
    return [];
  }

  const breakers = await readCircuitBreakers();
  if (breakers.some((breaker) => breaker.key === "global" && breaker.active)) {
    return [];
  }

  const recentEvents = await readRunEvents(200);
  const markets = buildRecoveryMarkets(positions, env).filter((market) => market.redeemable && market.directRedeemSupported);
  const submitted: string[] = [];

  for (const market of markets) {
    const recentlySubmitted = recentEvents.some(
      (event) =>
        event.eventType === "polymarket.redeem.submitted" &&
        typeof event.payload?.marketRef === "string" &&
        event.payload.marketRef === market.marketRef &&
        now - event.createdAt < AUTO_REDEEM_COOLDOWN_MS,
    );

    if (recentlySubmitted) {
      continue;
    }

    try {
      const result = await redeemPolymarketCondition(market.conditionId, market.marketRef);
      if (result.mode === "direct") {
        submitted.push(result.txHash);
      }
    } catch (error) {
      await writeRunEvent({
        level: "warn",
        eventType: "polymarket.redeem.failed",
        message: error instanceof Error ? error.message : "Polymarket redeem failed",
        payload: {
          marketRef: market.marketRef,
          conditionId: market.conditionId,
        },
        createdAt: now,
      });
    }
  }

  return submitted;
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

function buildRecoveryMarkets(
  positions: PositionSnapshot[],
  env = readEnv(),
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
        directRedeemSupported: env.POLY_SIGNATURE_TYPE === "EOA",
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
    if (market.redeemable) {
      market.notes.push("Gains Polymarket reclaimables vers USDC.e.");
    }
    if (market.mergeable) {
      market.notes.push("Paire complete mergeable vers USDC.e.");
    }
    if (env.POLY_SIGNATURE_TYPE !== "EOA" && (market.redeemable || market.mergeable)) {
      market.notes.push("Proxy/Gnosis: preparation manuelle depuis cette page, execution directe non activee.");
    }
  }

  return [...marketsByRef.values()].sort((left, right) => {
    const leftRank = Number(left.redeemable) * 2 + Number(left.mergeable);
    const rightRank = Number(right.redeemable) * 2 + Number(right.mergeable);
    return rightRank - leftRank || left.title.localeCompare(right.title);
  });
}

function buildEoaValidation(env = readEnv()): RecoveryResponse["eoaValidation"] {
  const checks: RecoveryResponse["eoaValidation"]["checks"] = [];
  let signerAddress: string | null = null;

  try {
    const privateKey = readSecretValue({
      inline: env.POLY_PRIVATE_KEY,
      path: env.POLY_PRIVATE_KEY_PATH,
      label: "POLY_PRIVATE_KEY",
    });
    signerAddress = new Wallet(privateKey).address;
    checks.push({
      key: "poly:eoa-private-key",
      label: "EOA private key",
      status: "ready",
      details: `Signer detecte: ${signerAddress}`,
      checkedAt: Date.now(),
    });
  } catch (error) {
    checks.push({
      key: "poly:eoa-private-key",
      label: "EOA private key",
      status: "blocked",
      details: error instanceof Error ? error.message : "Cle privee EOA illisible",
      checkedAt: Date.now(),
    });
  }

  const addressMatches =
    signerAddress !== null &&
    Boolean(env.POLY_FUNDER_ADDRESS) &&
    signerAddress.toLowerCase() === env.POLY_FUNDER_ADDRESS!.toLowerCase();
  checks.push({
    key: "poly:eoa-funder",
    label: "EOA funder address",
    status: addressMatches ? "ready" : "blocked",
    details: addressMatches
      ? "POLY_FUNDER_ADDRESS correspond au signer"
      : "POLY_FUNDER_ADDRESS doit etre la meme adresse publique que le signer EOA",
    checkedAt: Date.now(),
  });

  checks.push({
    key: "poly:eoa-signature-type",
    label: "EOA signature type",
    status: env.POLY_SIGNATURE_TYPE === "EOA" ? "ready" : "degraded",
    details:
      env.POLY_SIGNATURE_TYPE === "EOA"
        ? "POLY_SIGNATURE_TYPE=EOA"
        : `Actuel: ${env.POLY_SIGNATURE_TYPE ?? "unset"} · garder POLY_PROXY tant que la migration n'est pas faite`,
    checkedAt: Date.now(),
  });

  checks.push({
    key: "poly:eoa-rpc",
    label: "EOA Polygon RPC",
    status: env.POLYGON_RPC_URL ? "ready" : "degraded",
    details: env.POLYGON_RPC_URL
      ? `RPC configure: ${env.POLYGON_RPC_URL}`
      : "POLYGON_RPC_URL manquant pour le redeem direct",
    checkedAt: Date.now(),
  });

  checks.push({
    key: "poly:eoa-l2-creds",
    label: "EOA L2 credentials",
    status:
      env.POLY_API_KEY && env.POLY_API_SECRET && env.POLY_API_PASSPHRASE ? "ready" : "blocked",
    details:
      env.POLY_API_KEY && env.POLY_API_SECRET && env.POLY_API_PASSPHRASE
        ? "POLY_API_KEY / SECRET / PASSPHRASE presents"
        : "Deriver les credentials via npm run poly:derive-api-key puis les copier dans warbitrer.env",
    checkedAt: Date.now(),
  });

  const canDirectRedeem = checks.every((check) => check.status === "ready");
  return {
    canDirectRedeem,
    checks,
  };
}

async function redeemPolymarketCondition(conditionId: string, marketRef: string) {
  const env = readEnv();
  const txData = buildRedeemTxData(conditionId);

  if (env.POLY_SIGNATURE_TYPE !== "EOA") {
    return {
      ok: false as const,
      mode: "manual" as const,
      reason: `Direct redeem is not supported in-app for ${env.POLY_SIGNATURE_TYPE}. Use the Polymarket UI or a relayer-compatible wallet.`,
      tx: {
        to: POLY_CTF_ADDRESS,
        data: txData,
        value: "0",
        conditionId,
        indexSets: [1, 2],
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

  return {
    ok: true as const,
    mode: "direct" as const,
    txHash: tx.hash,
    marketRef,
    conditionId,
  };
}
