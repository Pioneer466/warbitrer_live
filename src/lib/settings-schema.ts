import { z } from "zod";

import {
  DEFAULT_MISMATCH_GUARD_ENABLED,
  DEFAULT_MISMATCH_GUARD_MAX_VENUE_DISAGREEMENT_PCT,
  DEFAULT_MISMATCH_GUARD_MIN_ELAPSED_SECONDS,
  DEFAULT_MISMATCH_GUARD_MIN_MOVE_BPS,
  DEFAULT_MISMATCH_GUARD_PHASE2_MIN_MOVE_BPS,
  DEFAULT_MISMATCH_GUARD_PHASE2_START_SECONDS,
  DEFAULT_KALSHI_DEPTH_HEADROOM_CONTRACTS,
  DEFAULT_KALSHI_PRIMARY_DEPTH_SAFETY_FACTOR,
  DEFAULT_KALSHI_PRIMARY_PRICE_TICKS_SLIPPAGE,
  DEFAULT_KALSHI_PRIMARY_MAX_CLIP_CONTRACTS,
  DEFAULT_KALSHI_PRIMARY_MAX_CLIPS,
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
    grossEntryThreshold: z.number().positive().max(1),
    maxLegPrice: z.number().positive().max(1).default(DEFAULT_STRATEGY_CONFIG.maxLegPrice),
    reentryImprovement: z.number().nonnegative().max(0.25),
    pollingIntervalMs: z.number().int().min(250).max(10_000),
    minOrderSize: z.number().positive().max(10_000),
    maxSlippageBps: z.number().int().min(1).max(2_000),
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
    primaryRetryAttempts: z.number().int().min(0).max(10),
    primaryRetryDelayMs: z.number().int().min(0).max(5_000),
    hedgeRetryAttempts: z.number().int().min(0).max(10),
    hedgeRetryDelayMs: z.number().int().min(0).max(5_000),
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
  });
}
