#!/usr/bin/env node

const SLOT_MS = 15 * 60_000;
const SLOT_TOLERANCE_MS = 60_000;
const POLY_GAMMA_BASE = "https://gamma-api.polymarket.com";
const KALSHI_BASE = "https://external-api.kalshi.com/trade-api/v2";

const MARKETS = {
  btc: { polymarketPrefix: "btc-updown-15m", kalshiSeries: "KXBTC15M" },
  eth: { polymarketPrefix: "eth-updown-15m", kalshiSeries: "KXETH15M" },
  sol: { polymarketPrefix: "sol-updown-15m", kalshiSeries: "KXSOL15M" },
  xrp: { polymarketPrefix: "xrp-updown-15m", kalshiSeries: "KXXRP15M" },
  doge: { polymarketPrefix: "doge-updown-15m", kalshiSeries: "KXDOGE15M" },
  bnb: { polymarketPrefix: "bnb-updown-15m", kalshiSeries: "KXBNB15M" },
  hype: { polymarketPrefix: "hype-updown-15m", kalshiSeries: "KXHYPE15M" },
};

const args = parseArgs(process.argv.slice(2));
const startMs = parseAlignedTimestamp(args.start, "--start");
const endMs = parseAlignedTimestamp(args.end, "--end");
const assets = parseAssets(args.assets);
const concurrency = parsePositiveInteger(args.concurrency ?? "8", "--concurrency");

if (endMs <= startMs) {
  fail("--end must be after --start");
}
if ((endMs - startMs) / SLOT_MS > 1_000) {
  fail("Refusing to fetch more than 1,000 slots in one run");
}

const slots = [];
for (let slotStartMs = startMs; slotStartMs < endMs; slotStartMs += SLOT_MS) {
  slots.push({ slotStartMs, slotEndMs: slotStartMs + SLOT_MS });
}

const fetchedAt = new Date().toISOString();
const rows = [];

for (const asset of assets) {
  process.stderr.write(
    `[official-history] ${asset}: ${slots.length} slots from ${new Date(startMs).toISOString()} to ${new Date(endMs).toISOString()}\n`,
  );
  const kalshiMarkets = await fetchKalshiMarkets(asset, startMs, endMs);
  const polymarketObservations = await mapWithConcurrency(slots, concurrency, (slot) =>
    fetchPolymarketObservation(asset, slot),
  );

  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const polymarket = polymarketObservations[index];
    const kalshi = findKalshiObservation(kalshiMarkets, slot);
    const polymarketResolution = polymarket.resolution;
    const kalshiResolution = kalshi.resolution;

    rows.push({
      asset,
      slotKey: `${asset}:${slot.slotStartMs}`,
      slotStartMs: slot.slotStartMs,
      slotEndMs: slot.slotEndMs,
      slotStartUtc: new Date(slot.slotStartMs).toISOString(),
      polymarket,
      kalshi,
      dualFinalized: polymarketResolution !== null && kalshiResolution !== null,
      outcomeMismatch:
        polymarketResolution !== null && kalshiResolution !== null
          ? (polymarketResolution === "UP") !== (kalshiResolution === "YES")
          : null,
      fatalByCombination:
        polymarketResolution !== null && kalshiResolution !== null
          ? {
              POLY_UP_KALSHI_NO: polymarketResolution === "DOWN" && kalshiResolution === "YES",
              POLY_DOWN_KALSHI_YES: polymarketResolution === "UP" && kalshiResolution === "NO",
            }
          : null,
    });
  }
}

const unresolved = rows.filter((row) => !row.dualFinalized);
const conflicts = rows.filter(
  (row) => row.polymarket.benchmarkConflict === true || row.kalshi.benchmarkConflict === true,
);

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      source: "official-venue-apis",
      fetchedAt,
      window: {
        startMs,
        endMs,
        startUtc: new Date(startMs).toISOString(),
        endUtc: new Date(endMs).toISOString(),
        slotCountPerAsset: slots.length,
      },
      assets,
      summary: {
        rowCount: rows.length,
        dualFinalizedCount: rows.length - unresolved.length,
        unresolvedCount: unresolved.length,
        benchmarkConflictCount: conflicts.length,
      },
      rows,
    },
    null,
    2,
  )}\n`,
);

if (unresolved.length > 0 || conflicts.length > 0) {
  process.exitCode = 2;
}

async function fetchPolymarketObservation(asset, slot) {
  const marketConfig = MARKETS[asset];
  const slug = `${marketConfig.polymarketPrefix}-${Math.floor(slot.slotStartMs / 1_000)}`;
  const events = await fetchJson(`${POLY_GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`);
  const event = Array.isArray(events) ? events.find((candidate) => candidate?.slug === slug) : null;
  const market = event?.markets?.find((candidate) => candidate?.slug === slug) ?? null;
  const resolution =
    market?.closed === true && String(market?.umaResolutionStatus ?? "").toLowerCase() === "resolved"
      ? extractPolymarketResolution(market?.outcomePrices)
      : null;
  const finalPriceUsd = readPositiveFinite(event?.eventMetadata?.finalPrice);
  const priceToBeatUsd = readPositiveFinite(event?.eventMetadata?.priceToBeat);
  const metadataResolution =
    finalPriceUsd === null || priceToBeatUsd === null ? null : finalPriceUsd >= priceToBeatUsd ? "UP" : "DOWN";

  return {
    slug,
    marketRef: readNonEmptyString(market?.conditionId) ?? readNonEmptyString(market?.id),
    status: market?.closed === true ? "closed" : readNonEmptyString(market?.umaResolutionStatus),
    resolution,
    settlementValueUsd: metadataResolution === resolution ? finalPriceUsd : null,
    referenceValueUsd: priceToBeatUsd,
    benchmarkSource: metadataResolution === resolution ? "polymarket-gamma-event-final-price" : null,
    benchmarkConflict: resolution !== null && metadataResolution !== null && metadataResolution !== resolution,
  };
}

async function fetchKalshiMarkets(asset, start, end) {
  const params = new URLSearchParams({
    series_ticker: MARKETS[asset].kalshiSeries,
    min_close_ts: String(Math.floor((start + SLOT_MS - SLOT_TOLERANCE_MS) / 1_000)),
    max_close_ts: String(Math.ceil((end + SLOT_TOLERANCE_MS) / 1_000)),
    limit: "1000",
  });
  const response = await fetchJson(`${KALSHI_BASE}/markets?${params.toString()}`);
  return Array.isArray(response?.markets) ? response.markets : [];
}

function findKalshiObservation(markets, slot) {
  const market =
    markets
      .filter(
        (candidate) =>
          withinTolerance(Date.parse(candidate?.open_time), slot.slotStartMs) &&
          withinTolerance(Date.parse(candidate?.close_time), slot.slotEndMs),
      )
      .sort((left, right) => Date.parse(left.open_time) - Date.parse(right.open_time))[0] ?? null;
  const status = String(market?.status ?? "").toLowerCase();
  const result = String(market?.result ?? "").toLowerCase();
  const resolution = status === "finalized" && (result === "yes" || result === "no") ? result.toUpperCase() : null;
  const expirationValueUsd = readPositiveFinite(market?.expiration_value);
  const strikePriceUsd = readPositiveFinite(market?.floor_strike);
  const capStrikePriceUsd = readPositiveFinite(market?.cap_strike);
  const impliedResolution = deriveKalshiResolution({
    expirationValueUsd,
    strikePriceUsd,
    capStrikePriceUsd,
    strikeType: String(market?.strike_type ?? "").toLowerCase(),
  });

  return {
    ticker: readNonEmptyString(market?.ticker),
    status: status || null,
    resolution,
    settlementValueUsd: impliedResolution === resolution ? expirationValueUsd : null,
    referenceValueUsd: strikePriceUsd ?? capStrikePriceUsd,
    benchmarkSource: impliedResolution === resolution ? "kalshi-expiration-value" : null,
    benchmarkConflict: resolution !== null && impliedResolution !== null && impliedResolution !== resolution,
  };
}

function deriveKalshiResolution(input) {
  if (input.expirationValueUsd === null) {
    return null;
  }
  if (input.strikeType === "greater" && input.strikePriceUsd !== null) {
    return input.expirationValueUsd > input.strikePriceUsd ? "YES" : "NO";
  }
  if (input.strikeType === "greater_or_equal" && input.strikePriceUsd !== null) {
    return input.expirationValueUsd >= input.strikePriceUsd ? "YES" : "NO";
  }
  if (input.strikeType === "less" && input.capStrikePriceUsd !== null) {
    return input.expirationValueUsd < input.capStrikePriceUsd ? "YES" : "NO";
  }
  if (input.strikeType === "less_or_equal" && input.capStrikePriceUsd !== null) {
    return input.expirationValueUsd <= input.capStrikePriceUsd ? "YES" : "NO";
  }
  return null;
}

function extractPolymarketResolution(raw) {
  try {
    const [up, down] = JSON.parse(raw);
    if (Number(up) >= 0.999) {
      return "UP";
    }
    if (Number(down) >= 0.999) {
      return "DOWN";
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "warbitrer-history-audit/1" },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) {
        return await response.json();
      }
      lastError = new Error(`HTTP ${response.status} for ${new URL(url).origin}`);
      if (response.status !== 429 && response.status < 500) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(250 * 2 ** (attempt - 1));
  }
  throw lastError;
}

async function mapWithConcurrency(values, limit, callback) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith("--")) {
      fail(`Unexpected argument ${key}`);
    }
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`Missing value for ${key}`);
    }
    parsed[key.slice(2)] = value;
    index += 1;
  }
  if (!parsed.start || !parsed.end) {
    fail("Usage: fetch-official-mismatch-history.mjs --start ISO --end ISO [--assets btc,...] [--concurrency 8]");
  }
  return parsed;
}

function parseAssets(value) {
  const selected = value ? value.split(",").map((asset) => asset.trim().toLowerCase()) : Object.keys(MARKETS);
  const invalid = selected.filter((asset) => !MARKETS[asset]);
  if (invalid.length > 0) {
    fail(`Unknown assets: ${invalid.join(", ")}`);
  }
  return [...new Set(selected)];
}

function parseAlignedTimestamp(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    fail(`${label} must be an ISO timestamp`);
  }
  if (timestamp % SLOT_MS !== 0) {
    fail(`${label} must be aligned to a 15-minute UTC boundary`);
  }
  return timestamp;
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return parsed;
}

function readPositiveFinite(value) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function readNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function withinTolerance(value, target) {
  return Number.isFinite(value) && Math.abs(value - target) <= SLOT_TOLERANCE_MS;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
