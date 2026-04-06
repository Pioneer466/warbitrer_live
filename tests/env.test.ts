import { hasKalshiCredentials, hasPolymarketCredentials, readEnv } from "@/lib/env";

describe("env parsing", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DATABASE_URL: "postgres://warbitrer:secret@127.0.0.1:5432/warbitrer_live",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("treats blank optional values as missing", () => {
    process.env.KALSHI_API_KEY_ID = "";
    process.env.KALSHI_PRIVATE_KEY_PATH = "";
    process.env.KALSHI_ENV = "";
    process.env.POLY_PRIVATE_KEY_PATH = "";
    process.env.POLY_API_KEY = "";
    process.env.POLY_API_SECRET = "";
    process.env.POLY_API_PASSPHRASE = "";
    process.env.POLY_RELAYER_API_KEY = "";
    process.env.POLY_RELAYER_URL = "";
    process.env.POLY_FUNDER_ADDRESS = "";
    process.env.POLY_SIGNATURE_TYPE = "";

    const env = readEnv();

    expect(env.KALSHI_API_KEY_ID).toBeUndefined();
    expect(env.KALSHI_PRIVATE_KEY_PATH).toBeUndefined();
    expect(env.KALSHI_ENV).toBeUndefined();
    expect(env.POLY_PRIVATE_KEY_PATH).toBeUndefined();
    expect(env.POLY_API_KEY).toBeUndefined();
    expect(env.POLY_API_SECRET).toBeUndefined();
    expect(env.POLY_API_PASSPHRASE).toBeUndefined();
    expect(env.POLY_RELAYER_API_KEY).toBeUndefined();
    expect(env.POLY_RELAYER_URL).toBeUndefined();
    expect(env.POLY_FUNDER_ADDRESS).toBeUndefined();
    expect(env.POLY_SIGNATURE_TYPE).toBeUndefined();
  });

  it("does not report credentials present when required fields are blank", () => {
    process.env.KALSHI_API_KEY_ID = "";
    process.env.KALSHI_PRIVATE_KEY_PATH = "";
    process.env.POLY_PRIVATE_KEY_PATH = "";
    process.env.POLY_API_KEY = "";
    process.env.POLY_API_SECRET = "";
    process.env.POLY_API_PASSPHRASE = "";
    process.env.POLY_RELAYER_API_KEY = "";
    process.env.POLY_RELAYER_URL = "";
    process.env.POLY_FUNDER_ADDRESS = "";
    process.env.POLY_SIGNATURE_TYPE = "";

    expect(hasKalshiCredentials()).toBe(false);
    expect(hasPolymarketCredentials()).toBe(false);
  });
});
