import { z } from "zod";

import {
  DEFAULT_MISMATCH_GUARD_ENABLED,
  DEFAULT_MISMATCH_GUARD_MAX_VENUE_DISAGREEMENT_PCT,
  DEFAULT_MISMATCH_GUARD_MIN_ELAPSED_SECONDS,
  DEFAULT_MISMATCH_GUARD_MIN_MOVE_BPS,
  DEFAULT_MISMATCH_GUARD_PHASE2_MIN_MOVE_BPS,
  DEFAULT_MISMATCH_GUARD_PHASE2_START_SECONDS,
  DEFAULT_MISMATCH_RISK_MODE,
  DEFAULT_MIN_PROJECTED_NET_PROFIT_USD,
  DEFAULT_MIN_PROJECTED_NET_RETURN,
  DEFAULT_MIN_WORST_CASE_PROFIT_USD,
  DEFAULT_PRIMARY_SELECTION_MODE,
  DEFAULT_MINIMUM_ENTRY_DEPTH_COVERAGE_RATIO,
  DEFAULT_ADAPTIVE_SLIPPAGE_TIGHT_BPS,
  DEFAULT_ADAPTIVE_SLIPPAGE_DEFAULT_BPS,
  DEFAULT_ADAPTIVE_SLIPPAGE_THIN_BPS,
  DEFAULT_DAILY_LOSS_CAP_ENABLED,
  DEFAULT_DAILY_LOSS_HARD_CAP_USD,
  DEFAULT_KALSHI_DEPTH_HEADROOM_CONTRACTS,
  DEFAULT_KALSHI_PRIMARY_DEPTH_SAFETY_FACTOR,
  DEFAULT_KALSHI_PRIMARY_PRICE_TICKS_SLIPPAGE,
  DEFAULT_KALSHI_PRIMARY_PROBE_CLIP_CONTRACTS,
  DEFAULT_KALSHI_PRIMARY_MAX_CLIP_CONTRACTS,
  DEFAULT_KALSHI_PRIMARY_MAX_CLIPS,
  DEFAULT_POLYMARKET_HEDGE_BOOK_MAX_AGE_MS,
  DEFAULT_POLYMARKET_HEDGE_DEPTH_SAFETY_FACTOR,
  DEFAULT_POLYMARKET_HEDGE_HEADROOM_SHARES,
  DEFAULT_MAX_SIGNAL_AGE_MS,
  DEFAULT_HEDGE_RESCUE_ALLOW_PARTIAL,
  DEFAULT_HEDGE_RESCUE_DELAY_MS,
  DEFAULT_HEDGE_RESCUE_ENABLED,
  DEFAULT_HEDGE_RESCUE_MAX_ATTEMPTS,
  DEFAULT_HEDGE_RESCUE_MAX_LOSS_USD,
  DEFAULT_HEDGE_RESCUE_MIN_ADVANTAGE_USD,
  DEFAULT_FORCED_UNWIND_ENABLED,
  DEFAULT_FORCED_UNWIND_HOLD_SECONDS_TO_SETTLEMENT,
  DEFAULT_FORCED_UNWIND_MAX_ATTEMPTS,
  DEFAULT_FORCED_UNWIND_MAX_LOSS_USD,
  DEFAULT_FORCED_UNWIND_TICK_LADDER,
  DEFAULT_STRATEGY_CONFIG,
  DEFAULT_STRATEGY_CONFIGS,
} from "@/lib/constants";
import type { StrategyConfig, StrategyConfigMap } from "@/lib/types";

const SLOT_DURATION_SECONDS = 15 * 60;

export const settingsSchema = z
  .object({
    enableTrading: z.boolean(),
    shadowMode: z.boolean(),
    maxPairNotionalUsd: z.number().positive().max(50_000),
    maxLegCapitalShare: z.number().min(0.5).max(1).default(DEFAULT_STRATEGY_CONFIG.maxLegCapitalShare),
    maxSignalAgeMs: z.number().int().min(250).max(5_000).default(DEFAULT_MAX_SIGNAL_AGE_MS),
    grossEntryThreshold: z.number().positive().max(1),
    minProjectedNetProfitUsd: z
      .number()
      .nonnegative()
      .max(10_000)
      .default(DEFAULT_MIN_PROJECTED_NET_PROFIT_USD),
    minProjectedNetReturn: z
      .number()
      .nonnegative()
      .max(1)
      .default(DEFAULT_MIN_PROJECTED_NET_RETURN),
    minWorstCaseProfitUsd: z
      .number()
      .nonnegative()
      .max(10_000)
      .default(DEFAULT_MIN_WORST_CASE_PROFIT_USD),
    maxLegPrice: z.number().positive().max(1).default(DEFAULT_STRATEGY_CONFIG.maxLegPrice),
    reentryImprovement: z.number().nonnegative().max(0.25),
    pollingIntervalMs: z.number().int().min(250).max(10_000),
    minOrderSize: z.number().positive().max(10_000),
    maxSlippageBps: z.number().int().min(1).max(2_000),
    primarySelectionMode: z
      .enum(["kalshi_only", "shadow", "dynamic"])
      .default(DEFAULT_PRIMARY_SELECTION_MODE),
    minimumEntryDepthCoverageRatio: z
      .number()
      .positive()
      .max(1)
      .default(DEFAULT_MINIMUM_ENTRY_DEPTH_COVERAGE_RATIO),
    adaptiveSlippageTightBps: z
      .number()
      .int()
      .min(1)
      .max(2_000)
      .default(DEFAULT_ADAPTIVE_SLIPPAGE_TIGHT_BPS),
    adaptiveSlippageDefaultBps: z
      .number()
      .int()
      .min(1)
      .max(2_000)
      .default(DEFAULT_ADAPTIVE_SLIPPAGE_DEFAULT_BPS),
    adaptiveSlippageThinBps: z
      .number()
      .int()
      .min(1)
      .max(2_000)
      .default(DEFAULT_ADAPTIVE_SLIPPAGE_THIN_BPS),
    dailyLossCapEnabled: z.boolean().default(DEFAULT_DAILY_LOSS_CAP_ENABLED),
    dailyLossHardCapUsd: z.number().positive().max(1_000_000).default(DEFAULT_DAILY_LOSS_HARD_CAP_USD),
    immediateOrderConfirmationTimeoutMs: z.number().int().min(1_000).max(30_000),
    executionPriceBuffer: z.number().nonnegative().max(0.1),
    kalshiDepthHeadroomContracts: z
      .number()
      .int()
      .nonnegative()
      .max(1_000)
      .default(DEFAULT_KALSHI_DEPTH_HEADROOM_CONTRACTS),
    kalshiPrimaryDepthSafetyFactor: z
      .number()
      .positive()
      .max(1)
      .default(DEFAULT_KALSHI_PRIMARY_DEPTH_SAFETY_FACTOR),
    kalshiPrimaryPriceTicksSlippage: z
      .number()
      .int()
      .nonnegative()
      .max(10)
      .default(DEFAULT_KALSHI_PRIMARY_PRICE_TICKS_SLIPPAGE),
    kalshiPrimaryProbeClipContracts: z
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(DEFAULT_KALSHI_PRIMARY_PROBE_CLIP_CONTRACTS),
    kalshiPrimaryMaxClipContracts: z
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(DEFAULT_KALSHI_PRIMARY_MAX_CLIP_CONTRACTS),
    kalshiPrimaryMaxClips: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(DEFAULT_KALSHI_PRIMARY_MAX_CLIPS),
    polymarketHedgeDepthSafetyFactor: z
      .number()
      .positive()
      .max(1)
      .default(DEFAULT_POLYMARKET_HEDGE_DEPTH_SAFETY_FACTOR),
    polymarketHedgeHeadroomShares: z
      .number()
      .nonnegative()
      .max(1_000)
      .default(DEFAULT_POLYMARKET_HEDGE_HEADROOM_SHARES),
    polymarketHedgeBookMaxAgeMs: z
      .number()
      .int()
      .min(100)
      .max(5_000)
      .default(DEFAULT_POLYMARKET_HEDGE_BOOK_MAX_AGE_MS),
    primaryRetryAttempts: z.number().int().min(0).max(10),
    primaryRetryDelayMs: z.number().int().min(0).max(5_000),
    hedgeRetryAttempts: z.number().int().min(0).max(10),
    hedgeRetryDelayMs: z.number().int().min(0).max(5_000),
    hedgeRescueEnabled: z.boolean().default(DEFAULT_HEDGE_RESCUE_ENABLED),
    hedgeRescueMaxAttempts: z.number().int().min(1).max(10).default(DEFAULT_HEDGE_RESCUE_MAX_ATTEMPTS),
    hedgeRescueDelayMs: z.number().int().min(0).max(5_000).default(DEFAULT_HEDGE_RESCUE_DELAY_MS),
    hedgeRescueMaxLossUsd: z.number().nonnegative().max(10_000).default(DEFAULT_HEDGE_RESCUE_MAX_LOSS_USD),
    hedgeRescueMinAdvantageUsd: z
      .number()
      .nonnegative()
      .max(10_000)
      .default(DEFAULT_HEDGE_RESCUE_MIN_ADVANTAGE_USD),
    hedgeRescueAllowPartial: z.boolean().default(DEFAULT_HEDGE_RESCUE_ALLOW_PARTIAL),
    forcedUnwindEnabled: z.boolean().default(DEFAULT_FORCED_UNWIND_ENABLED),
    forcedUnwindMaxAttempts: z.number().int().min(1).max(10).default(DEFAULT_FORCED_UNWIND_MAX_ATTEMPTS),
    forcedUnwindTickLadder: z
      .array(z.number().int().min(0).max(50))
      .min(1)
      .max(10)
      .default([...DEFAULT_FORCED_UNWIND_TICK_LADDER]),
    forcedUnwindMaxLossUsd: z.number().nonnegative().max(10_000).default(DEFAULT_FORCED_UNWIND_MAX_LOSS_USD),
    forcedUnwindHoldSecondsToSettlement: z
      .number()
      .int()
      .min(0)
      .max(SLOT_DURATION_SECONDS)
      .default(DEFAULT_FORCED_UNWIND_HOLD_SECONDS_TO_SETTLEMENT),
    entryCutoffSeconds: z.number().int().min(1).max(300),
    maxOpenIntentsPerSlot: z.number().int().min(1).max(10),
    maxVenueExposureUsd: z.number().positive().max(1_000_000),
    polyBridgeLowWaterUsdc: z.number().nonnegative().max(1_000_000),
    mismatchGuardEnabled: z.boolean().default(DEFAULT_MISMATCH_GUARD_ENABLED),
    mismatchGuardMinElapsedSeconds: z
      .number()
      .int()
      .min(0)
      .max(600)
      .default(DEFAULT_MISMATCH_GUARD_MIN_ELAPSED_SECONDS),
    mismatchGuardMinMoveBps: z
      .number()
      .nonnegative()
      .max(500)
      .default(DEFAULT_MISMATCH_GUARD_MIN_MOVE_BPS),
    mismatchGuardPhase2StartSeconds: z
      .number()
      .int()
      .min(0)
      .max(SLOT_DURATION_SECONDS)
      .default(DEFAULT_MISMATCH_GUARD_PHASE2_START_SECONDS),
    mismatchGuardPhase2MinMoveBps: z
      .number()
      .nonnegative()
      .max(500)
      .default(DEFAULT_MISMATCH_GUARD_PHASE2_MIN_MOVE_BPS),
    mismatchGuardMaxVenueDisagreementPct: z
      .number()
      .nonnegative()
      .max(0.5)
      .default(DEFAULT_MISMATCH_GUARD_MAX_VENUE_DISAGREEMENT_PCT),
    mismatchRiskMode: z
      .enum(["shadow", "block_only", "enforce"])
      .default(DEFAULT_MISMATCH_RISK_MODE),
  })
  .superRefine((settings, ctx) => {
    if (settings.mismatchGuardPhase2StartSeconds < settings.mismatchGuardMinElapsedSeconds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mismatchGuardPhase2StartSeconds"],
        message: "Phase 2 mismatch guard must start after the minimum elapsed guard window",
      });
    }

    if (settings.mismatchGuardPhase2MinMoveBps < settings.mismatchGuardMinMoveBps) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mismatchGuardPhase2MinMoveBps"],
        message: "Phase 2 mismatch guard move threshold must be >= the standard threshold",
      });
    }

    if (
      settings.adaptiveSlippageTightBps > settings.adaptiveSlippageDefaultBps ||
      settings.adaptiveSlippageDefaultBps > settings.adaptiveSlippageThinBps
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["adaptiveSlippageDefaultBps"],
        message: "Adaptive slippage tiers must be ordered tight <= default <= thin",
      });
    }

    const latestPhase2Start = SLOT_DURATION_SECONDS - settings.entryCutoffSeconds - 1;
    if (settings.mismatchGuardPhase2StartSeconds > latestPhase2Start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mismatchGuardPhase2StartSeconds"],
        message: "Phase 2 mismatch guard must start before the entry cutoff window",
      });
    }
  });

export type SettingsInput = z.infer<typeof settingsSchema>;

export const settingsMapSchema = z.object({
  btc: settingsSchema,
  eth: settingsSchema,
  sol: settingsSchema,
  xrp: settingsSchema,
  doge: settingsSchema,
  bnb: settingsSchema,
  hype: settingsSchema,
});

export type SettingsMapInput = z.infer<typeof settingsMapSchema>;

export function normalizeSettings(
  input: Partial<StrategyConfig> | null | undefined,
): StrategyConfig {
  return settingsSchema.parse({
    ...DEFAULT_STRATEGY_CONFIG,
    ...(input ?? {}),
  });
}

export function normalizeSettingsMap(
  input: Partial<StrategyConfigMap> | null | undefined,
): StrategyConfigMap {
  return settingsMapSchema.parse({
    btc: {
      ...DEFAULT_STRATEGY_CONFIGS.btc,
      ...(input?.btc ?? {}),
    },
    eth: {
      ...DEFAULT_STRATEGY_CONFIGS.eth,
      ...(input?.eth ?? {}),
    },
    sol: {
      ...DEFAULT_STRATEGY_CONFIGS.sol,
      ...(input?.sol ?? {}),
    },
    xrp: {
      ...DEFAULT_STRATEGY_CONFIGS.xrp,
      ...(input?.xrp ?? {}),
    },
    doge: {
      ...DEFAULT_STRATEGY_CONFIGS.doge,
      ...(input?.doge ?? {}),
    },
    bnb: {
      ...DEFAULT_STRATEGY_CONFIGS.bnb,
      ...(input?.bnb ?? {}),
    },
    hype: {
      ...DEFAULT_STRATEGY_CONFIGS.hype,
      ...(input?.hype ?? {}),
    },
  });
}
