import { z } from "zod";

export const DEFAULT_GLOBAL_RISK_CONFIG = {
  clusterExpectedFatalLossShare: 0.05,
  clusterExpectedFatalLossCapUsd: 25,
  clusterAbsoluteFatalLossShare: 0.15,
  clusterAbsoluteFatalLossCapUsd: 75,
  balanceMaxAgeMs: 10_000,
  oracleMaxAgeMs: 2_500,
} as const;

export const globalRiskConfigSchema = z
  .object({
    clusterExpectedFatalLossShare: z.number().positive().max(1),
    clusterExpectedFatalLossCapUsd: z.number().positive().max(1_000_000),
    clusterAbsoluteFatalLossShare: z.number().positive().max(1),
    clusterAbsoluteFatalLossCapUsd: z.number().positive().max(1_000_000),
    balanceMaxAgeMs: z.number().int().min(1_000).max(120_000),
    oracleMaxAgeMs: z.number().int().min(500).max(30_000),
  })
  .superRefine((config, ctx) => {
    if (config.clusterAbsoluteFatalLossShare < config.clusterExpectedFatalLossShare) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clusterAbsoluteFatalLossShare"],
        message: "Absolute fatal-loss share must be >= expected fatal-loss share",
      });
    }

    if (config.clusterAbsoluteFatalLossCapUsd < config.clusterExpectedFatalLossCapUsd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clusterAbsoluteFatalLossCapUsd"],
        message: "Absolute fatal-loss cap must be >= expected fatal-loss cap",
      });
    }
  });

export const globalRiskConfigUpdateSchema = z
  .object({
    config: globalRiskConfigSchema,
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

export type GlobalRiskConfig = z.infer<typeof globalRiskConfigSchema>;

export function normalizeGlobalRiskConfig(input: Partial<GlobalRiskConfig> | null | undefined): GlobalRiskConfig {
  return globalRiskConfigSchema.parse({
    ...DEFAULT_GLOBAL_RISK_CONFIG,
    ...(input ?? {}),
  });
}
