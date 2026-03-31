import fs from "node:fs";

import { ClobClient } from "@polymarket/clob-client";
import { SignatureType } from "@polymarket/clob-client";
import { Wallet } from "ethers";

const DEFAULT_ENV_PATH = process.env.WARBITRER_ENV_PATH || "/etc/warbitrer/warbitrer.env";
const POLY_CLOB_BASE = "https://clob.polymarket.com";
const POLY_CHAIN_ID = 137;

async function main() {
  const env = loadEnvFile(DEFAULT_ENV_PATH);
  const privateKey = readSecret({
    inline: env.POLY_PRIVATE_KEY,
    path: env.POLY_PRIVATE_KEY_PATH,
    label: "POLY_PRIVATE_KEY",
  });

  if (!env.POLY_FUNDER_ADDRESS) {
    throw new Error("POLY_FUNDER_ADDRESS manquant dans l'env");
  }

  if (!env.POLY_SIGNATURE_TYPE) {
    throw new Error("POLY_SIGNATURE_TYPE manquant dans l'env");
  }

  const signer = new Wallet(privateKey.trim());
  const client = new ClobClient(
    POLY_CLOB_BASE,
    POLY_CHAIN_ID,
    signer,
    undefined,
    mapSignatureType(env.POLY_SIGNATURE_TYPE),
    env.POLY_FUNDER_ADDRESS,
    undefined,
    true,
  );

  const creds = await client.createOrDeriveApiKey();

  console.log("Copie ces valeurs dans /etc/warbitrer/warbitrer.env :");
  console.log(`POLY_API_KEY=${creds.key}`);
  console.log(`POLY_API_SECRET=${creds.secret}`);
  console.log(`POLY_API_PASSPHRASE=${creds.passphrase}`);
}

function loadEnvFile(path: string) {
  if (!fs.existsSync(path)) {
    throw new Error(`Env file introuvable: ${path}`);
  }

  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
  const env: Record<string, string> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    env[key] = value;
  }

  return env;
}

function readSecret(options: { inline?: string; path?: string; label: string }) {
  if (options.inline) {
    return options.inline;
  }

  if (options.path) {
    return fs.readFileSync(options.path, "utf8").trim();
  }

  throw new Error(`${options.label} manquant`);
}

function mapSignatureType(value: string) {
  switch (value) {
    case "EOA":
      return SignatureType.EOA;
    case "POLY_PROXY":
      return SignatureType.POLY_PROXY;
    case "POLY_GNOSIS_SAFE":
      return SignatureType.POLY_GNOSIS_SAFE;
    default:
      throw new Error(`Unsupported POLY_SIGNATURE_TYPE: ${value}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
