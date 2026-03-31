import { z } from "zod";

import { DEFAULT_STRATEGY_CONFIG } from "@/lib/constants";
import type { StrategyConfig } from "@/lib/types";

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
  entryCutoffSeconds: z.number().int().min(1).max(120),
  maxOpenIntentsPerSlot: z.number().int().min(1).max(10),
  maxVenueExposureUsd: z.number().positive().max(1_000_000),
  polyBridgeLowWaterUsdc: z.number().nonnegative().max(1_000_000),
});

export type SettingsInput = z.infer<typeof settingsSchema>;

export function normalizeSettings(
  input: Partial<StrategyConfig> | null | undefined,
): StrategyConfig {
  return settingsSchema.parse({
    ...DEFAULT_STRATEGY_CONFIG,
    ...(input ?? {}),
  });
}
