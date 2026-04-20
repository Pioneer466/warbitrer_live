import { z } from "zod";

import { DEFAULT_STRATEGY_CONFIG, DEFAULT_STRATEGY_CONFIGS } from "@/lib/constants";
import type { StrategyConfig, StrategyConfigMap } from "@/lib/types";

export const settingsSchema = z.object({
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
  hedgeRetryAttempts: z.number().int().min(0).max(10),
  hedgeRetryDelayMs: z.number().int().min(0).max(5_000),
  entryCutoffSeconds: z.number().int().min(1).max(300),
  maxOpenIntentsPerSlot: z.number().int().min(1).max(10),
  maxVenueExposureUsd: z.number().positive().max(1_000_000),
  polyBridgeLowWaterUsdc: z.number().nonnegative().max(1_000_000),
});

export type SettingsInput = z.infer<typeof settingsSchema>;

export const settingsMapSchema = z.object({
  btc: settingsSchema,
  eth: settingsSchema,
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
  });
}
