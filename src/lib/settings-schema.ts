import { z } from "zod";

import { DEFAULT_SETTINGS } from "@/lib/constants";
import type { PaperSettings } from "@/lib/types";

export const settingsSchema = z.object({
  initialCapital: z.number().positive(),
  budgetPerTrade: z.number().positive(),
  grossEntryThreshold: z.number().positive().max(1),
  maxLegPrice: z.number().positive().max(1).default(DEFAULT_SETTINGS.maxLegPrice),
  reentryImprovement: z.number().nonnegative().max(0.25),
  pollingIntervalMs: z.number().int().min(250).max(10_000),
  minOrderSize: z.number().int().min(1).max(1_000),
});

export type SettingsInput = z.infer<typeof settingsSchema>;

export function normalizeSettings(
  input: Partial<PaperSettings> | null | undefined,
): PaperSettings {
  return settingsSchema.parse({
    ...DEFAULT_SETTINGS,
    ...(input ?? {}),
  });
}
