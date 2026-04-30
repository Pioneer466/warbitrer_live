import fs from "node:fs";

import {
  createPolymarketAdapter,
  extractPolymarketTradesForOrder,
  fetchPolymarketTrades,
  resolvePolymarketOrderTruth,
} from "@/lib/polymarket";
import {
  findOrderIntent,
  readFillsForIntentVenue,
  readRecentVenueOrders,
} from "@/lib/storage";

const DEFAULT_ENV_PATH = process.env.WARBITRER_ENV_PATH || "/etc/warbitrer/warbitrer.env";

async function main() {
  loadRuntimeEnv();

  const intentId = readCliFlag("--intent-id") ?? process.argv[2];
  if (!intentId || intentId.startsWith("--")) {
    throw new Error("Usage: npm run intent:audit -- --intent-id <intent-id>");
  }

  const intent = await findOrderIntent(intentId);
  if (!intent) {
    throw new Error(`Intent introuvable: ${intentId}`);
  }

  const recentOrders = await readRecentVenueOrders(1000, intent.asset);
  const orders = recentOrders.filter((order) => order.intentId === intent.id);
  const [polymarketFills, kalshiFills, polymarketTrades, positions] = await Promise.all([
    readFillsForIntentVenue(intent.id, "polymarket"),
    readFillsForIntentVenue(intent.id, "kalshi"),
    fetchPolymarketTrades().catch(() => []),
    createPolymarketAdapter().getPositions().catch(() => []),
  ]);

  const polymarketTokenIds = new Set(
    intent.legs
      .filter((leg) => leg.venue === "polymarket" && leg.tokenId)
      .map((leg) => leg.tokenId),
  );
  const relevantPositions = positions.filter(
    (position) =>
      position.asset === intent.asset &&
      (polymarketTokenIds.size === 0 || polymarketTokenIds.has(extractPositionTokenId(position) ?? "")),
  );

  const auditedOrders = orders.map((order) => {
    if (order.venue !== "polymarket") {
      return order;
    }

    const trades = extractPolymarketTradesForOrder(polymarketTrades, order.venueOrderId);
    const truth = resolvePolymarketOrderTruth({
      orderId: order.venueOrderId,
      order: extractPolymarketOpenOrderFromRaw(order.raw),
      trades,
      expectedSize: order.requestedSize,
      expectedSizeIsExact: order.side !== "BUY",
      orderType: order.orderType,
    });

    return {
      ...order,
      polymarketTruth: truth,
      polymarketTrades: trades.map((trade) => ({
        id: trade.id,
        status: trade.status,
        side: trade.side,
        size: Number(trade.size),
        price: Number(trade.price),
        takerOrderId: trade.taker_order_id,
        makerOrderIds: trade.maker_orders.map((makerOrder) => makerOrder.order_id),
      })),
    };
  });

  const primaryLeg = intent.legs.find((leg) => leg.venue === intent.primaryVenue) ?? null;
  const hedgeLeg = intent.legs.find((leg) => leg.venue === intent.hedgeVenue) ?? null;
  const netExposure = primaryLeg && hedgeLeg
    ? {
        primaryFilledSize: primaryLeg.filledSize,
        hedgeFilledSize: hedgeLeg.filledSize,
        unhedgedPrimarySize: round6(Math.max(0, primaryLeg.filledSize - hedgeLeg.filledSize)),
        overfilledHedgeSize: round6(Math.max(0, hedgeLeg.filledSize - primaryLeg.filledSize)),
      }
    : null;

  console.log(
    JSON.stringify(
      {
        intent: {
          id: intent.id,
          status: intent.status,
          slotKey: intent.slotKey,
          primaryVenue: intent.primaryVenue,
          hedgeVenue: intent.hedgeVenue,
          failureReason: intent.failureReason,
          legs: intent.legs,
        },
        netExposure,
        orders: auditedOrders,
        fills: {
          polymarket: polymarketFills,
          kalshi: kalshiFills,
        },
        positions: relevantPositions,
      },
      null,
      2,
    ),
  );
}

function extractPolymarketOpenOrderFromRaw(raw: Record<string, unknown> | null | undefined) {
  const direct = raw?.order;
  if (direct && typeof direct === "object") {
    return direct as Parameters<typeof resolvePolymarketOrderTruth>[0]["order"];
  }

  if (
    raw &&
    typeof raw.id === "string" &&
    typeof raw.status === "string" &&
    typeof raw.original_size !== "undefined" &&
    typeof raw.size_matched !== "undefined"
  ) {
    return raw as unknown as Parameters<typeof resolvePolymarketOrderTruth>[0]["order"];
  }

  return null;
}

function extractPositionTokenId(position: { id: string; raw: Record<string, unknown> }) {
  if (typeof position.raw.asset === "string") {
    return position.raw.asset;
  }
  if (typeof position.raw.asset_id === "string") {
    return position.raw.asset_id;
  }
  if (typeof position.raw.tokenId === "string") {
    return position.raw.tokenId;
  }
  if (typeof position.raw.token_id === "string") {
    return position.raw.token_id;
  }
  if (position.id.startsWith("polymarket:")) {
    return position.id.slice("polymarket:".length);
  }
  return null;
}

function readCliFlag(flag: string) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }

  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function loadRuntimeEnv() {
  if (!fs.existsSync(DEFAULT_ENV_PATH)) {
    return;
  }

  for (const [key, value] of Object.entries(loadEnvFile(DEFAULT_ENV_PATH))) {
    process.env[key] = process.env[key] ?? value;
  }
}

function loadEnvFile(path: string) {
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
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  return env;
}

function round6(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
