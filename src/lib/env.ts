import fs from "node:fs";

import { z } from "zod";

import { POLY_SIGNATURE_TYPES } from "@/lib/constants";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  KALSHI_API_KEY_ID: z.string().min(1).optional(),
  KALSHI_PRIVATE_KEY_PEM: z.string().min(1).optional(),
  KALSHI_PRIVATE_KEY_PATH: z.string().min(1).optional(),
  KALSHI_ENV: z.enum(["prod", "demo"]).optional(),
  POLY_PRIVATE_KEY: z.string().min(1).optional(),
  POLY_PRIVATE_KEY_PATH: z.string().min(1).optional(),
  POLY_API_KEY: z.string().min(1).optional(),
  POLY_API_SECRET: z.string().min(1).optional(),
  POLY_API_PASSPHRASE: z.string().min(1).optional(),
  POLY_FUNDER_ADDRESS: z.string().min(1).optional(),
  POLY_SIGNATURE_TYPE: z.enum(POLY_SIGNATURE_TYPES).optional(),
  POLY_BRIDGE_LOW_WATER_USDC: z.string().optional(),
  POLY_AUTO_REDEEM: z.string().optional(),
  POLYGON_RPC_URL: z.string().min(1).optional(),
});

export type LiveEnv = z.infer<typeof envSchema>;

export function readEnv(): LiveEnv {
  return envSchema.parse(normalizeEnv(process.env));
}

export function hasKalshiCredentials(env = readEnv()) {
  return Boolean(env.KALSHI_API_KEY_ID && (env.KALSHI_PRIVATE_KEY_PEM || env.KALSHI_PRIVATE_KEY_PATH));
}

export function hasPolymarketCredentials(env = readEnv()) {
  return Boolean(
    (env.POLY_PRIVATE_KEY || env.POLY_PRIVATE_KEY_PATH) &&
      env.POLY_API_KEY &&
      env.POLY_API_SECRET &&
      env.POLY_API_PASSPHRASE &&
      env.POLY_FUNDER_ADDRESS &&
      env.POLY_SIGNATURE_TYPE,
  );
}

export function readSecretValue(options: {
  inline?: string;
  path?: string;
  label: string;
}) {
  if (options.inline) {
    return options.inline;
  }

  if (options.path) {
    return fs.readFileSync(options.path, "utf8").trim();
  }

  throw new Error(`${options.label} missing`);
}

export function isTruthyEnv(value: string | undefined) {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizeEnv(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      typeof value === "string" && value.trim() === "" ? undefined : value,
    ]),
  );
}
