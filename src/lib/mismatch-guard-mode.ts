import type { MismatchGuardMode, StrategyConfig } from "@/lib/types";

/**
 * Persisted configurations created before guard modes only have the legacy
 * boolean. Resolve those conservatively without silently changing production
 * behaviour during a deploy.
 */
export function resolveMismatchGuardMode(
  settings: Partial<Pick<StrategyConfig, "mismatchGuardEnabled" | "mismatchGuardMode">>,
): MismatchGuardMode {
  if (settings.mismatchGuardMode) {
    return settings.mismatchGuardMode;
  }
  if (settings.mismatchGuardEnabled !== undefined) {
    return settings.mismatchGuardEnabled ? "legacy_enforce" : "audit";
  }
  return "hard_only";
}

export function isMismatchGuardEnabled(mode: MismatchGuardMode) {
  return mode !== "audit";
}
