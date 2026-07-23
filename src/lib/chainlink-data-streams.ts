import { createClient, decodeReport, type Report } from "@chainlink/data-streams-sdk";

import { readChainlinkDataStreamsCredentials } from "@/lib/env";
import { getMarketCatalogEntry } from "@/lib/market-catalog";
import type { MarketAsset } from "@/lib/types";

const CHAINLINK_DATA_STREAMS_API_URL = "https://api.dataengine.chain.link";
const CHAINLINK_DATA_STREAMS_WS_URL = "wss://ws.dataengine.chain.link";
const CHAINLINK_V3_PRICE_DECIMALS = 18;
const CHAINLINK_STREAM_RECONNECT_ATTEMPTS = 1_000_000;

export type ChainlinkPriceObservation = {
  asset: MarketAsset;
  feedId: string;
  priceUsd: number;
  sourceTimestampMs: number;
  receivedAt: number;
};

export type ChainlinkDataStreamConnection = {
  close: () => Promise<void>;
};

type ConnectChainlinkDataStreamOptions = {
  asset: MarketAsset;
  onObservation: (observation: ChainlinkPriceObservation) => void;
  onStatus: (status: "connecting" | "subscribed" | "error" | "closed", details: string) => void;
};

export async function connectChainlinkDataStream(
  options: ConnectChainlinkDataStreamOptions,
): Promise<ChainlinkDataStreamConnection> {
  const feedId = getMarketCatalogEntry(options.asset).chainlinkDataStreamsFeedId;
  if (!feedId) {
    throw new Error(`Aucun feed Chainlink Data Streams direct configure pour ${options.asset.toUpperCase()}`);
  }

  const credentials = readChainlinkDataStreamsCredentials();
  if (!credentials) {
    throw new Error("Identifiants Chainlink Data Streams absents");
  }

  const client = createClient({
    ...credentials,
    endpoint: CHAINLINK_DATA_STREAMS_API_URL,
    wsEndpoint: CHAINLINK_DATA_STREAMS_WS_URL,
  });
  const stream = client.createStream([feedId], {
    maxReconnectAttempts: CHAINLINK_STREAM_RECONNECT_ATTEMPTS,
  });

  const applyReport = (report: Report) => {
    try {
      const observation = normalizeChainlinkV3Report(
        options.asset,
        feedId,
        report,
        decodeReport(report.fullReport, report.feedID),
      );
      options.onObservation(observation);
      options.onStatus("subscribed", `Chainlink Data Streams ${options.asset.toUpperCase()} actif`);
    } catch (error) {
      options.onStatus("error", formatChainlinkError(error));
    }
  };

  stream.on("report", applyReport);
  stream.on("error", (error) => {
    options.onStatus("error", formatChainlinkError(error));
  });
  stream.on("disconnected", () => {
    options.onStatus("connecting", `Chainlink Data Streams ${options.asset.toUpperCase()} deconnecte`);
  });
  stream.on("reconnecting", ({ attempt }) => {
    options.onStatus(
      "connecting",
      `reconnexion Chainlink Data Streams ${options.asset.toUpperCase()} tentative ${attempt}`,
    );
  });

  options.onStatus("connecting", `connexion Chainlink Data Streams ${options.asset.toUpperCase()}`);
  await stream.connect();
  options.onStatus("subscribed", `Chainlink Data Streams ${options.asset.toUpperCase()} connecte`);

  try {
    applyReport(await client.getLatestReport(feedId));
  } catch (error) {
    options.onStatus("error", `dernier rapport Chainlink indisponible: ${formatChainlinkError(error)}`);
  }

  return {
    close: async () => {
      await stream.close();
      options.onStatus("closed", `Chainlink Data Streams ${options.asset.toUpperCase()} ferme`);
    },
  };
}

export function normalizeChainlinkV3Report(
  asset: MarketAsset,
  expectedFeedId: string,
  report: Report,
  decoded: ReturnType<typeof decodeReport>,
  receivedAt = Date.now(),
): ChainlinkPriceObservation {
  if (report.feedID.toLowerCase() !== expectedFeedId.toLowerCase()) {
    throw new Error(`Feed Chainlink inattendu: ${report.feedID}`);
  }
  if (decoded.version !== "V3") {
    throw new Error(`Schema Chainlink inattendu: ${decoded.version}`);
  }

  const priceUsd = Number(decoded.price) / 10 ** CHAINLINK_V3_PRICE_DECIMALS;
  const sourceTimestampMs = report.observationsTimestamp * 1_000;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new Error("Prix Chainlink invalide");
  }
  if (!Number.isSafeInteger(sourceTimestampMs) || sourceTimestampMs <= 0) {
    throw new Error("Timestamp Chainlink invalide");
  }

  return {
    asset,
    feedId: expectedFeedId,
    priceUsd,
    sourceTimestampMs,
    receivedAt,
  };
}

function formatChainlinkError(error: unknown) {
  return error instanceof Error ? error.message : "Erreur Chainlink Data Streams";
}
