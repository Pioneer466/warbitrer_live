import { z } from "zod";

export const settingsSchema = z.object({
  initialCapital: z.number().positive(),
  budgetPerTrade: z.number().positive(),
  grossEntryThreshold: z.number().positive().max(1),
  reentryImprovement: z.number().nonnegative().max(0.25),
  pollingIntervalMs: z.number().int().min(250).max(10_000),
  minOrderSize: z.number().int().min(1).max(1_000),
});

export type SettingsInput = z.infer<typeof settingsSchema>;
