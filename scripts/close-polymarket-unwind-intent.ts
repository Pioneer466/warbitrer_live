import fs from "node:fs";

import { deriveRemainingExposureSize, summarizeIntentLegFills } from "@/lib/engine";
import { fetchPolymarketResolution } from "@/lib/polymarket";
import { getCurrentSlot } from "@/lib/slot";
import {
  findOrderIntent,
  readCircuitBreakers,
  readFillsForIntentVenue,
  readRecentOrderIntents,
  readOpenOrderIntents,
  writeCircuitBreaker,
  writeOrderIntent,
  writeRunEvent,
} from "@/lib/storage";
import { finalizeUnwoundIntent } from "@/lib/settlement";
import type { OrderIntent, OrderIntentLeg } from "@/lib/types";

const DEFAULT_ENV_PATH = process.env.WARBITRER_ENV_PATH || "/etc/warbitrer/warbitrer.env";

async function main() {
  ensureDatabaseUrl();

  const intentId = readCliFlag("--intent-id");
  const slotKey = readCliFlag("--slot-key");
  if (!intentId && !slotKey) {
    throw new Error("Usage: npm run intent:close-poly-unwind -- --intent-id <intent-id> | --slot-key <slot-key>");
  }

  const now = Date.now();
  const intent = intentId ? await findOrderIntent(intentId) : await findIntentBySlotKey(slotKey!);
  if (!intent) {
    throw new Error(
      intentId ? `Intent introuvable: ${intentId}` : `Aucun intent compatible introuvable pour le slot ${slotKey}`,
    );
  }

  if (intent.status !== "unwind_required") {
    throw new Error(`Intent ${intentId} n'est pas en unwind_required (status=${intent.status})`);
  }
  if (intent.primaryVenue !== "polymarket") {
    throw new Error(`Intent ${intentId} n'a pas Polymarket en primaire (primaryVenue=${intent.primaryVenue})`);
  }

  const primaryLeg = intent.legs.find((leg) => leg.venue === "polymarket");
  if (!primaryLeg) {
    throw new Error(`Intent ${intentId} sans leg primaire Polymarket`);
  }

  const slot = getCurrentSlot(intent.asset, new Date(intent.slotStartTs + 1));
  const slotSlug = slot.polymarketSlug;
  const polyResolution = intent.polyResolution ?? (await fetchPolymarketResolution(slotSlug).catch(() => null));
  if (polyResolution === null) {
    throw new Error(
      `Resolution Polymarket introuvable pour ${slotSlug}. Attends la resolution ou passe par /api/recovery.`,
    );
  }

  const fills = await readFillsForIntentVenue(intent.id, "polymarket");
  const entryFillSummary = summarizeIntentLegFills(fills, primaryLeg, "entry");
  const exitFillSummary = summarizeIntentLegFills(fills, primaryLeg, "exit");
  const entryFilledSize = entryFillSummary?.filledSize ?? primaryLeg.filledSize;
  const exitFilledSize = exitFillSummary?.filledSize ?? 0;
  const remainingExposureSize = deriveRemainingExposureSize(entryFilledSize, exitFilledSize);
  const exitAverageFillPrice = exitFillSummary?.averageFillPrice ?? primaryLeg.filledPrice ?? 0;
  const exitFeeUsd = exitFillSummary?.feeUsd ?? 0;
  const residualPayoutUsd = primaryLeg.outcome === polyResolution ? remainingExposureSize : 0;
  const payoutUsd = round4(exitFilledSize * exitAverageFillPrice - exitFeeUsd + residualPayoutUsd);

  const updatedPrimaryLeg = applyManualUnwindSettlement(primaryLeg, entryFillSummary, {
    payoutUsd,
    polyResolution,
  });

  const closedIntent = finalizeUnwoundIntent({
    intent: {
      ...intent,
      updatedAt: now,
      polyResolution,
      failureReason: "Intent manually closed after Polymarket settlement / reclaim",
      legs: intent.legs.map((leg) => (leg.id === primaryLeg.id ? updatedPrimaryLeg : leg)) as OrderIntent["legs"],
    },
    now,
    failureReason: "Intent manually closed after Polymarket settlement / reclaim",
  });

  const persistedClosedIntent = await writeOrderIntent(closedIntent);
  await clearResolvedSlotBreaker(persistedClosedIntent.asset, persistedClosedIntent.slotKey);
  await writeRunEvent({
    level: "warn",
    eventType: "intent.unwound.manual_close",
    message: `Intent ${persistedClosedIntent.id} manually closed after Polymarket settlement`,
    payload: {
      intentId: persistedClosedIntent.id,
      slotKey: persistedClosedIntent.slotKey,
      polyResolution,
      payoutUsd,
      remainingExposureSize,
    },
    createdAt: now,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        intentId: persistedClosedIntent.id,
        status: persistedClosedIntent.status,
        polyResolution,
        realizedPnlUsd: persistedClosedIntent.realizedPnlUsd,
        slotBreakerCleared: true,
      },
      null,
      2,
    ),
  );
}

async function findIntentBySlotKey(slotKey: string) {
  const recentIntents = await readRecentOrderIntents(200);
  const candidates = recentIntents.filter(
    (intent) =>
      intent.slotKey === slotKey && intent.status === "unwind_required" && intent.primaryVenue === "polymarket",
  );

  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length > 1) {
    throw new Error(
      `Plusieurs intents Polymarket unwind_required trouves pour le slot ${slotKey}: ${candidates.map((intent) => intent.id).join(", ")}`,
    );
  }

  return candidates[0];
}

function applyManualUnwindSettlement(
  leg: OrderIntentLeg,
  entryFillSummary: ReturnType<typeof summarizeIntentLegFills>,
  params: {
    payoutUsd: number;
    polyResolution: "UP" | "DOWN";
  },
): OrderIntentLeg {
  return {
    ...leg,
    venueOrderId: entryFillSummary?.venueOrderId ?? leg.venueOrderId,
    filledSize: entryFillSummary?.filledSize ?? leg.filledSize,
    filledPrice: entryFillSummary?.averageFillPrice ?? leg.filledPrice,
    feeUsd: entryFillSummary?.feeUsd ?? leg.feeUsd,
    status: "unwound",
    payoutUsd: params.payoutUsd,
    resolvedOutcome: params.polyResolution,
  };
}

async function clearResolvedSlotBreaker(asset: OrderIntent["asset"], slotKey: string) {
  const [openIntents, breakers] = await Promise.all([readOpenOrderIntents(), readCircuitBreakers()]);
  const stillBlocked = openIntents.some((intent) => intent.slotKey === slotKey && intent.status === "unwind_required");
  if (stillBlocked) {
    return;
  }

  const slotBreaker = breakers.find(
    (breaker) => breaker.key === `slot:${slotKey}` && breaker.active && breaker.reason === "hedge_failure",
  );
  if (!slotBreaker) {
    return;
  }

  const currentSlotKey = getCurrentSlot(asset, new Date()).key;
  if (slotKey === currentSlotKey) {
    return;
  }

  await writeCircuitBreaker({
    key: slotBreaker.key,
    active: false,
    reason: null,
    triggeredAt: null,
    payload: null,
  });
}

function readCliFlag(flag: string) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }

  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function ensureDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return;
  }

  const env = loadEnvFile(DEFAULT_ENV_PATH);
  if (!env.DATABASE_URL) {
    throw new Error(`DATABASE_URL manquant dans ${DEFAULT_ENV_PATH}`);
  }

  process.env.DATABASE_URL = env.DATABASE_URL;
}

function loadEnvFile(path: string) {
  if (!fs.existsSync(path)) {
    throw new Error(`Env file introuvable: ${path}`);
  }

  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
  const env: Record<string, string> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  return env;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
