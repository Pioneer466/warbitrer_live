#!/usr/bin/env node

import fs from "node:fs";

const SLOT_MS = 15 * 60_000;
const ASSETS = ["btc", "eth", "sol", "xrp", "doge", "bnb", "hype"];

const args = parseArgs(process.argv.slice(2));
const windowStartMs = parseTimestamp(args.start, "--start");
const windowEndMs = parseTimestamp(args.end, "--end");
const databaseWindowRows = readResolutionCsv(args["database-window"]);
const retainedRows = readResolutionCsv(args.retained);
const modelRows = readCsv(args.model).map(normalizeModelRow);
const external = JSON.parse(fs.readFileSync(args.external, "utf8"));
const externalRows = external.rows.map(normalizeExternalResolution);

const recentMerge = mergeResolutionRows(databaseWindowRows.filter(inWindow), externalRows.filter(inWindow));
const expectedSlotsPerAsset = (windowEndMs - windowStartMs) / SLOT_MS;
const recentRows = recentMerge.rows.sort(compareResolutionRows);
validateCompleteWindow(recentRows, expectedSlotsPerAsset);

const retainedMerge = mergeResolutionRows(retainedRows, externalRows);
const commonSlots = findCommonSlots(retainedMerge.rows);
const commonRows = retainedMerge.rows.filter((row) => commonSlots.has(row.slotStartMs)).sort(compareResolutionRows);

if (args["combined-output"]) {
  fs.writeFileSync(args["combined-output"], serializeResolutionCsv(recentRows));
}

const priorRows = retainedRows.filter((row) => row.slotStartMs < windowStartMs);
const modelSummary = summarizeModel(modelRows);
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  inputs: {
    databaseWindow: args["database-window"],
    retained: args.retained,
    external: args.external,
    model: args.model,
  },
  recent72h: {
    startUtc: new Date(windowStartMs).toISOString(),
    endUtc: new Date(windowEndMs).toISOString(),
    expectedSlotsPerAsset,
    databaseRows: databaseWindowRows.length,
    externallyRecoveredRows: recentMerge.addedCount,
    overlapValidationRows: recentMerge.overlapCount,
    overlapConflicts: recentMerge.conflicts,
    statsByAsset: summarizeByAsset(recentRows),
    clusters: summarizeClusters(recentRows),
    pairwiseMismatchCorrelation: summarizePairwiseCorrelations(recentRows),
  },
  commonRetainedWindow: {
    startUtc: new Date(Math.min(...commonSlots)).toISOString(),
    endUtc: new Date(Math.max(...commonSlots) + SLOT_MS).toISOString(),
    slotsPerAsset: commonSlots.size,
    statsByAsset: summarizeByAsset(commonRows),
    clusters: summarizeClusters(commonRows),
    pairwiseMismatchCorrelation: summarizePairwiseCorrelations(commonRows),
  },
  retainedByAsset: summarizeByAsset(retainedMerge.rows),
  priorToRecentWindowByAsset: summarizeByAsset(priorRows),
  model: modelSummary,
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

function normalizeResolutionRow(row) {
  return {
    asset: row.asset,
    slotKey: row.slot_key,
    slotStartMs: Number(row.slot_start_ts),
    slotEndMs: Number(row.slot_end_ts),
    slotStartUtc: row.slot_start_utc,
    polymarketResolution: row.polymarket_resolution,
    kalshiResolution: row.kalshi_resolution,
    polymarketSettlementValueUsd: toNullableNumber(row.polymarket_settlement_value_usd),
    kalshiSettlementValueUsd: toNullableNumber(row.kalshi_settlement_value_usd),
    source: row.source,
    outcomeMismatch: toBoolean(row.outcome_mismatch),
    fatalPolyUpKalshiNo: toBoolean(row.fatal_poly_up_kalshi_no),
    fatalPolyDownKalshiYes: toBoolean(row.fatal_poly_down_kalshi_yes),
    polymarketBenchmarkConflict: toBoolean(row.polymarket_benchmark_conflict),
    kalshiBenchmarkConflict: toBoolean(row.kalshi_benchmark_conflict),
  };
}

function normalizeExternalResolution(row) {
  return {
    asset: row.asset,
    slotKey: row.slotKey,
    slotStartMs: row.slotStartMs,
    slotEndMs: row.slotEndMs,
    slotStartUtc: row.slotStartUtc,
    polymarketResolution: row.polymarket.resolution,
    kalshiResolution: row.kalshi.resolution,
    polymarketSettlementValueUsd: row.polymarket.settlementValueUsd,
    kalshiSettlementValueUsd: row.kalshi.settlementValueUsd,
    source: "official-venue-apis-recovered",
    outcomeMismatch: row.outcomeMismatch,
    fatalPolyUpKalshiNo: row.fatalByCombination?.POLY_UP_KALSHI_NO ?? null,
    fatalPolyDownKalshiYes: row.fatalByCombination?.POLY_DOWN_KALSHI_YES ?? null,
    polymarketBenchmarkConflict: row.polymarket.benchmarkConflict,
    kalshiBenchmarkConflict: row.kalshi.benchmarkConflict,
  };
}

function normalizeModelRow(row) {
  return {
    asset: row.asset,
    slotKey: row.slot_key,
    slotStartMs: Number(row.slot_start_ts),
    horizonSeconds: Number(row.seconds_before_end),
    capturedAt: toNullableNumber(row.captured_at),
    sampleLagMs: toNullableNumber(row.sample_lag_ms),
    outcomeMismatch: toBoolean(row.outcome_mismatch),
    fatalPolyUpKalshiNo: toBoolean(row.fatal_poly_up_kalshi_no),
    fatalPolyDownKalshiYes: toBoolean(row.fatal_poly_down_kalshi_yes),
    modelAvailable: toBoolean(row.model_available),
    modelReason: row.model_reason || null,
    executionUsable: toBoolean(row.execution_usable),
    executionReason: row.execution_reason || null,
    pFatalPolyUpKalshiNo: toNullableNumber(row.p_fatal_poly_up_kalshi_no),
    pFatalPolyDownKalshiYes: toNullableNumber(row.p_fatal_poly_down_kalshi_yes),
    pDoublePolyUpKalshiNo: toNullableNumber(row.p_double_poly_up_kalshi_no),
    pFatalUpper95PolyUpKalshiNo: toNullableNumber(row.p_fatal_upper95_poly_up_kalshi_no),
    pFatalUpper95PolyDownKalshiYes: toNullableNumber(row.p_fatal_upper95_poly_down_kalshi_yes),
    observationCount: toNullableNumber(row.observation_count),
    chainlinkAgeMs: toNullableNumber(row.chainlink_age_ms),
    cfAgeMs: toNullableNumber(row.cf_age_ms),
    sourceSkewMs: toNullableNumber(row.source_skew_ms),
    modelVersion: row.model_version || null,
  };
}

function readResolutionCsv(path) {
  return readCsv(path).map(normalizeResolutionRow);
}

function mergeResolutionRows(primary, recovered) {
  const byKey = new Map(primary.map((row) => [`${row.asset}:${row.slotStartMs}`, row]));
  let addedCount = 0;
  let overlapCount = 0;
  const conflicts = [];

  for (const row of recovered) {
    const key = `${row.asset}:${row.slotStartMs}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      addedCount += 1;
      continue;
    }
    overlapCount += 1;
    if (
      existing.polymarketResolution !== row.polymarketResolution ||
      existing.kalshiResolution !== row.kalshiResolution
    ) {
      conflicts.push({
        key,
        database: [existing.polymarketResolution, existing.kalshiResolution],
        external: [row.polymarketResolution, row.kalshiResolution],
      });
    }
  }

  return { rows: [...byKey.values()], addedCount, overlapCount, conflicts };
}

function validateCompleteWindow(rows, expectedSlotsPerAsset) {
  if (!Number.isSafeInteger(expectedSlotsPerAsset) || expectedSlotsPerAsset <= 0) {
    throw new Error("Analysis window must contain a positive whole number of 15-minute slots");
  }
  for (const asset of ASSETS) {
    const assetRows = rows.filter((row) => row.asset === asset);
    if (assetRows.length !== expectedSlotsPerAsset) {
      throw new Error(`${asset}: expected ${expectedSlotsPerAsset} rows, found ${assetRows.length}`);
    }
    if (
      assetRows.some(
        (row) =>
          !["UP", "DOWN"].includes(row.polymarketResolution) ||
          !["YES", "NO"].includes(row.kalshiResolution) ||
          row.outcomeMismatch === null,
      )
    ) {
      throw new Error(`${asset}: incomplete resolution row in analysis window`);
    }
  }
}

function findCommonSlots(rows) {
  const assetsBySlot = new Map();
  for (const row of rows) {
    if (!["UP", "DOWN"].includes(row.polymarketResolution) || !["YES", "NO"].includes(row.kalshiResolution)) {
      continue;
    }
    const assets = assetsBySlot.get(row.slotStartMs) ?? new Set();
    assets.add(row.asset);
    assetsBySlot.set(row.slotStartMs, assets);
  }
  return new Set(
    [...assetsBySlot.entries()]
      .filter(([, assets]) => ASSETS.every((asset) => assets.has(asset)))
      .map(([slotStartMs]) => slotStartMs),
  );
}

function summarizeByAsset(rows) {
  return ASSETS.map((asset) => {
    const selected = rows.filter((row) => row.asset === asset && row.outcomeMismatch !== null);
    const mismatches = selected.filter((row) => row.outcomeMismatch).length;
    const interval = wilsonInterval(mismatches, selected.length);
    return {
      asset,
      slots: selected.length,
      mismatches,
      mismatchRate: safeDivide(mismatches, selected.length),
      mismatchRateWilson95: interval,
      polyDownKalshiYes: selected.filter((row) => row.fatalPolyUpKalshiNo).length,
      polyUpKalshiNo: selected.filter((row) => row.fatalPolyDownKalshiYes).length,
      benchmarkConflicts: selected.filter(
        (row) => row.polymarketBenchmarkConflict === true || row.kalshiBenchmarkConflict === true,
      ).length,
    };
  });
}

function summarizeClusters(rows) {
  const bySlot = groupBy(rows, (row) => row.slotStartMs);
  const completeSlots = [...bySlot.entries()]
    .filter(([, values]) => new Set(values.map((row) => row.asset)).size === ASSETS.length)
    .map(([slotStartMs, values]) => ({
      slotStartMs,
      mismatchAssets: values.filter((row) => row.outcomeMismatch).map((row) => row.asset),
    }));
  const distribution = {};
  for (const slot of completeSlots) {
    const count = slot.mismatchAssets.length;
    distribution[count] = (distribution[count] ?? 0) + 1;
  }
  const marginalRates = ASSETS.map(
    (asset) =>
      completeSlots.filter((slot) => slot.mismatchAssets.includes(asset)).length / Math.max(completeSlots.length, 1),
  );
  const independentDistribution = poissonBinomialDistribution(marginalRates);
  const observedMean = mean(completeSlots.map((slot) => slot.mismatchAssets.length));
  const observedVariance = mean(completeSlots.map((slot) => (slot.mismatchAssets.length - observedMean) ** 2));
  const independentVariance = marginalRates.reduce((sum, rate) => sum + rate * (1 - rate), 0);
  const maximumSimultaneous = Math.max(...completeSlots.map((slot) => slot.mismatchAssets.length), 0);
  return {
    completeSlots: completeSlots.length,
    slotsWithAnyMismatch: completeSlots.filter((slot) => slot.mismatchAssets.length > 0).length,
    distribution,
    independentExpectedDistribution: Object.fromEntries(
      independentDistribution.map((probability, count) => [count, probability * completeSlots.length]),
    ),
    mismatchCountMean: observedMean,
    mismatchCountVariance: observedVariance,
    independentVariance,
    overdispersionRatio: safeDivide(observedVariance, independentVariance),
    maximumSimultaneous,
    maximumSlots: completeSlots
      .filter((slot) => slot.mismatchAssets.length === maximumSimultaneous && maximumSimultaneous > 0)
      .map((slot) => ({
        slotStartUtc: new Date(slot.slotStartMs).toISOString(),
        assets: slot.mismatchAssets,
      })),
  };
}

function poissonBinomialDistribution(probabilities) {
  let distribution = [1];
  for (const probability of probabilities) {
    const next = Array(distribution.length + 1).fill(0);
    for (let count = 0; count < distribution.length; count += 1) {
      next[count] += distribution[count] * (1 - probability);
      next[count + 1] += distribution[count] * probability;
    }
    distribution = next;
  }
  return distribution;
}

function summarizePairwiseCorrelations(rows) {
  const bySlot = groupBy(rows, (row) => row.slotStartMs);
  const pairs = [];
  for (let leftIndex = 0; leftIndex < ASSETS.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ASSETS.length; rightIndex += 1) {
      const left = ASSETS[leftIndex];
      const right = ASSETS[rightIndex];
      const observations = [];
      for (const values of bySlot.values()) {
        const leftRow = values.find((row) => row.asset === left);
        const rightRow = values.find((row) => row.asset === right);
        if (leftRow?.outcomeMismatch !== null && rightRow?.outcomeMismatch !== null) {
          observations.push([Number(leftRow.outcomeMismatch), Number(rightRow.outcomeMismatch)]);
        }
      }
      pairs.push({
        pair: `${left}/${right}`,
        slots: observations.length,
        phi: pearsonBinary(observations),
      });
    }
  }
  return pairs.sort((left, right) => Math.abs(right.phi ?? 0) - Math.abs(left.phi ?? 0));
}

function summarizeModel(rows) {
  const horizons = [...new Set(rows.map((row) => row.horizonSeconds))].sort((left, right) => right - left);
  return {
    byHorizon: horizons.map((horizon) => summarizeModelSelection(rows.filter((row) => row.horizonSeconds === horizon))),
    at60SecondsByAsset: ASSETS.map((asset) =>
      summarizeModelSelection(
        rows.filter((row) => row.horizonSeconds === 60 && row.asset === asset),
        asset,
      ),
    ),
  };
}

function summarizeModelSelection(rows, asset = null) {
  const sampled = rows.filter((row) => row.capturedAt !== null);
  const available = sampled.filter(
    (row) =>
      row.modelAvailable === true &&
      row.pFatalPolyUpKalshiNo !== null &&
      row.pFatalPolyDownKalshiYes !== null &&
      row.outcomeMismatch !== null,
  );
  const mismatchPredictions = available.map((row) => ({
    predicted: clampProbability(row.pFatalPolyUpKalshiNo + row.pFatalPolyDownKalshiYes),
    actual: Number(row.outcomeMismatch),
  }));
  const directionalPredictions = available.flatMap((row) => [
    { predicted: clampProbability(row.pFatalPolyUpKalshiNo), actual: Number(row.fatalPolyUpKalshiNo) },
    { predicted: clampProbability(row.pFatalPolyDownKalshiYes), actual: Number(row.fatalPolyDownKalshiYes) },
  ]);
  const executionUsablePredictions = available
    .filter((row) => row.executionUsable === true)
    .map((row) => ({
      predicted: clampProbability(row.pFatalPolyUpKalshiNo + row.pFatalPolyDownKalshiYes),
      actual: Number(row.outcomeMismatch),
    }));
  const topDecile = selectTopFraction(mismatchPredictions, 0.1);
  const actualMismatchCount = mismatchPredictions.filter((entry) => entry.actual === 1).length;
  const topDecileMismatchCount = topDecile.filter((entry) => entry.actual === 1).length;

  return {
    asset,
    horizonSeconds: rows[0]?.horizonSeconds ?? null,
    resolutionRows: rows.length,
    sampledRows: sampled.length,
    availableRows: available.length,
    executionUsableRows: available.filter((row) => row.executionUsable === true).length,
    executionUnusableReasons: countValues(
      available.filter((row) => row.executionUsable !== true).map((row) => row.executionReason ?? "unknown"),
    ),
    unavailableReasons: countValues(
      sampled.filter((row) => row.modelAvailable !== true).map((row) => row.modelReason ?? "unknown"),
    ),
    medianSampleLagMs: median(sampled.map((row) => row.sampleLagMs).filter((value) => value !== null)),
    observedMismatchRate: mean(mismatchPredictions.map((entry) => entry.actual)),
    meanPredictedMismatch: mean(mismatchPredictions.map((entry) => entry.predicted)),
    mismatchBrier: brierScore(mismatchPredictions),
    mismatchLogLoss: logLoss(mismatchPredictions),
    mismatchAuc: rocAuc(mismatchPredictions),
    directionalObservedFatalRate: mean(directionalPredictions.map((entry) => entry.actual)),
    directionalMeanPredictedFatal: mean(directionalPredictions.map((entry) => entry.predicted)),
    directionalBrier: brierScore(directionalPredictions),
    directionalAuc: rocAuc(directionalPredictions),
    actualMismatchCount,
    topDecileCount: topDecile.length,
    topDecileMismatchCount,
    topDecileObservedMismatchRate: mean(topDecile.map((entry) => entry.actual)),
    topDecileMeanPredictedMismatch: mean(topDecile.map((entry) => entry.predicted)),
    topDecileMismatchRecall: safeDivide(topDecileMismatchCount, actualMismatchCount),
    thresholdPerformance: [0.05, 0.1, 0.2, 0.5].map((threshold) => summarizeThreshold(mismatchPredictions, threshold)),
    executionUsablePerformance: summarizePredictionPerformance(executionUsablePredictions),
  };
}

function summarizePredictionPerformance(predictions) {
  return {
    rows: predictions.length,
    actualMismatches: predictions.filter((entry) => entry.actual === 1).length,
    observedRate: mean(predictions.map((entry) => entry.actual)),
    meanPredicted: mean(predictions.map((entry) => entry.predicted)),
    brier: brierScore(predictions),
    logLoss: logLoss(predictions),
    auc: rocAuc(predictions),
  };
}

function summarizeThreshold(predictions, threshold) {
  const selected = predictions.filter((entry) => entry.predicted >= threshold);
  const positives = predictions.filter((entry) => entry.actual === 1).length;
  const truePositives = selected.filter((entry) => entry.actual === 1).length;
  return {
    threshold,
    selected: selected.length,
    truePositives,
    precision: safeDivide(truePositives, selected.length),
    recall: safeDivide(truePositives, positives),
  };
}

function selectTopFraction(predictions, fraction) {
  const count = Math.ceil(predictions.length * fraction);
  return [...predictions].sort((left, right) => right.predicted - left.predicted).slice(0, count);
}

function brierScore(predictions) {
  return mean(predictions.map(({ predicted, actual }) => (predicted - actual) ** 2));
}

function logLoss(predictions) {
  return mean(
    predictions.map(({ predicted, actual }) => {
      const bounded = Math.min(1 - 1e-12, Math.max(1e-12, predicted));
      return -(actual * Math.log(bounded) + (1 - actual) * Math.log(1 - bounded));
    }),
  );
}

function rocAuc(predictions) {
  const positives = predictions.filter((entry) => entry.actual === 1);
  const negatives = predictions.filter((entry) => entry.actual === 0);
  if (positives.length === 0 || negatives.length === 0) {
    return null;
  }
  let score = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      score += positive.predicted > negative.predicted ? 1 : positive.predicted === negative.predicted ? 0.5 : 0;
    }
  }
  return score / (positives.length * negatives.length);
}

function wilsonInterval(successes, total) {
  if (total === 0) {
    return { low: null, high: null };
  }
  const z = 1.959963984540054;
  const proportion = successes / total;
  const denominator = 1 + z ** 2 / total;
  const center = (proportion + z ** 2 / (2 * total)) / denominator;
  const halfWidth = (z / denominator) * Math.sqrt((proportion * (1 - proportion)) / total + z ** 2 / (4 * total ** 2));
  return { low: center - halfWidth, high: center + halfWidth };
}

function pearsonBinary(observations) {
  if (observations.length === 0) {
    return null;
  }
  const leftMean = mean(observations.map(([left]) => left));
  const rightMean = mean(observations.map(([, right]) => right));
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (const [left, right] of observations) {
    covariance += (left - leftMean) * (right - rightMean);
    leftVariance += (left - leftMean) ** 2;
    rightVariance += (right - rightMean) ** 2;
  }
  return leftVariance === 0 || rightVariance === 0 ? null : covariance / Math.sqrt(leftVariance * rightVariance);
}

function serializeResolutionCsv(rows) {
  const headers = [
    "asset",
    "slot_key",
    "slot_start_ts",
    "slot_end_ts",
    "slot_start_utc",
    "polymarket_resolution",
    "kalshi_resolution",
    "polymarket_settlement_value_usd",
    "kalshi_settlement_value_usd",
    "source",
    "outcome_mismatch",
    "fatal_poly_up_kalshi_no",
    "fatal_poly_down_kalshi_yes",
    "polymarket_benchmark_conflict",
    "kalshi_benchmark_conflict",
  ];
  const lines = [
    headers,
    ...rows.map((row) => [
      row.asset,
      row.slotKey,
      row.slotStartMs,
      row.slotEndMs,
      row.slotStartUtc,
      row.polymarketResolution,
      row.kalshiResolution,
      row.polymarketSettlementValueUsd,
      row.kalshiSettlementValueUsd,
      row.source,
      row.outcomeMismatch,
      row.fatalPolyUpKalshiNo,
      row.fatalPolyDownKalshiYes,
      row.polymarketBenchmarkConflict,
      row.kalshiBenchmarkConflict,
    ]),
  ];
  return `${lines.map((line) => line.map(csvCell).join(",")).join("\n")}\n`;
}

function readCsv(path) {
  const input = fs.readFileSync(path, "utf8");
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field.replace(/\r$/, ""));
      records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const [headers, ...values] = records.filter((row) => row.some((entry) => entry.length > 0));
  return values.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid arguments near ${key ?? "<end>"}`);
    }
    parsed[key.slice(2)] = value;
    index += 1;
  }
  for (const required of ["start", "end", "database-window", "retained", "external", "model"]) {
    if (!parsed[required]) {
      throw new Error(`Missing --${required}`);
    }
  }
  return parsed;
}

function parseTimestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed % SLOT_MS !== 0) {
    throw new Error(`${label} must be a 15-minute-aligned ISO timestamp`);
  }
  return parsed;
}

function inWindow(row) {
  return row.slotStartMs >= windowStartMs && row.slotStartMs < windowEndMs;
}

function compareResolutionRows(left, right) {
  return left.slotStartMs - right.slotStartMs || left.asset.localeCompare(right.asset);
}

function groupBy(values, keyFunction) {
  const grouped = new Map();
  for (const value of values) {
    const key = keyFunction(value);
    const group = grouped.get(key) ?? [];
    group.push(value);
    grouped.set(key, group);
  }
  return grouped;
}

function countValues(values) {
  return Object.fromEntries(
    [...groupBy(values, (value) => value).entries()]
      .map(([value, entries]) => [value, entries.length])
      .sort((left, right) => right[1] - left[1]),
  );
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint];
}

function safeDivide(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function clampProbability(value) {
  return Math.max(0, Math.min(1, value));
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toBoolean(value) {
  if (value === true || value === "t" || value === "true") {
    return true;
  }
  if (value === false || value === "f" || value === "false") {
    return false;
  }
  return null;
}

function csvCell(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
