import { utils, Wallet, providers, constants as ethersConstants } from "ethers";
import { NextResponse } from "next/server";

import { createApiErrorResponse } from "@/lib/api-error";
import { POLY_CTF_ADDRESS, POLY_USDCE_ADDRESS } from "@/lib/constants";
import { readEnv, readSecretValue } from "@/lib/env";
import { readCircuitBreakers, readPositions, writeRunEvent } from "@/lib/storage";
import type { RecoveryMarket, RecoveryResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await buildRecoveryResponse(), {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return createApiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      action?: "redeem";
      marketRef?: string;
    };

    if (body.action !== "redeem" || !body.marketRef) {
      return NextResponse.json({ error: "action=redeem and marketRef are required" }, { status: 400 });
    }

    const env = readEnv();
    const recovery = await buildRecoveryResponse();
    const market = recovery.markets.find((candidate) => candidate.marketRef === body.marketRef);

    if (!market || !market.redeemable) {
      return NextResponse.json({ error: "No redeemable Polymarket position for this market" }, { status: 404 });
    }

    const txData = buildRedeemTxData(market.conditionId);

    if (env.POLY_SIGNATURE_TYPE !== "EOA") {
      return NextResponse.json({
        ok: false,
        mode: "manual",
        reason: `Direct redeem is not supported in-app for ${env.POLY_SIGNATURE_TYPE}. Use the Polymarket UI or a relayer-compatible wallet.`,
        tx: {
          to: POLY_CTF_ADDRESS,
          data: txData,
          value: "0",
          conditionId: market.conditionId,
          indexSets: [1, 2],
        },
      });
    }

    const privateKey = readSecretValue({
      inline: env.POLY_PRIVATE_KEY,
      path: env.POLY_PRIVATE_KEY_PATH,
      label: "POLY_PRIVATE_KEY",
    });
    const provider = new providers.JsonRpcProvider(env.POLYGON_RPC_URL ?? "https://polygon-rpc.com");
    const signer = new Wallet(privateKey, provider);

    if (!env.POLY_FUNDER_ADDRESS || signer.address.toLowerCase() !== env.POLY_FUNDER_ADDRESS.toLowerCase()) {
      return NextResponse.json(
        {
          ok: false,
          error: "Direct redeem only supported when POLY_SIGNATURE_TYPE=EOA and POLY_FUNDER_ADDRESS matches the signer wallet address.",
        },
        { status: 409 },
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
      message: `Redeem submitted for ${market.marketRef}`,
      payload: {
        marketRef: market.marketRef,
        conditionId: market.conditionId,
        txHash: tx.hash,
      },
      createdAt: Date.now(),
    });

    return NextResponse.json({
      ok: true,
      mode: "direct",
      txHash: tx.hash,
      marketRef: market.marketRef,
      conditionId: market.conditionId,
    });
  } catch (error) {
    return createApiErrorResponse(error);
  }
}

async function buildRecoveryResponse(): Promise<RecoveryResponse> {
  const [positions, breakers] = await Promise.all([readPositions(), readCircuitBreakers()]);
  const env = readEnv();
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

  return {
    fetchedAt: Date.now(),
    globalKillSwitchActive: breakers.some((breaker) => breaker.key === "global" && breaker.active),
    signatureType: env.POLY_SIGNATURE_TYPE ?? "unknown",
    funderAddress: env.POLY_FUNDER_ADDRESS ?? null,
    markets: [...marketsByRef.values()].sort((left, right) => {
      const leftRank = Number(left.redeemable) * 2 + Number(left.mergeable);
      const rightRank = Number(right.redeemable) * 2 + Number(right.mergeable);
      return rightRank - leftRank || left.title.localeCompare(right.title);
    }),
    kalshiSettlementMode: "automatic",
  };
}

function buildRedeemTxData(conditionId: string) {
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
