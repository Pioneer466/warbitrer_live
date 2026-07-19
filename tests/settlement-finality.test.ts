import { fetchVenueSettlementResolutions } from "@/lib/settlement-finality";
import { vi } from "vitest";

const SLOT_START_TS = 1_720_000_000_000;
const POLYMARKET_MARKET_REF = "condition-1";
const KALSHI_MARKET_REF = "KXBTC15M-FINALITY";
const originalEnv = process.env;

const intent = {
  asset: "btc" as const,
  slotStartTs: SLOT_START_TS,
  legs: [
    { venue: "polymarket" as const, marketRef: POLYMARKET_MARKET_REF },
    { venue: "kalshi" as const, marketRef: KALSHI_MARKET_REF },
  ],
};

describe("settlement finality", () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DATABASE_URL: "postgres://test:test@localhost:5432/warbitrer_test",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("waits while Polymarket is closed but UMA is only proposed", async () => {
    stubVenueResponses({
      polymarketUmaStatus: "proposed",
      kalshiStatus: "finalized",
    });

    await expect(fetchVenueSettlementResolutions(intent)).resolves.toBeNull();
  });

  it.each(["determined", "settled"])("waits while Kalshi is %s but not finalized", async (kalshiStatus) => {
    stubVenueResponses({
      polymarketUmaStatus: "resolved",
      kalshiStatus,
    });

    await expect(fetchVenueSettlementResolutions(intent)).resolves.toBeNull();
  });

  it("returns both outcomes only when both venues are final", async () => {
    const fetchMock = stubVenueResponses({
      polymarketUmaStatus: "resolved",
      kalshiStatus: "finalized",
    });

    await expect(fetchVenueSettlementResolutions(intent)).resolves.toEqual({
      polyResolution: "UP",
      kalshiResolution: "NO",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `/markets?slug=btc-updown-15m-${Math.floor(SLOT_START_TS / 1_000)}`,
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(`/markets/${KALSHI_MARKET_REF}`);
  });

  it("fails closed before fetching when either venue leg is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchVenueSettlementResolutions({
        ...intent,
        legs: intent.legs.filter((leg) => leg.venue === "polymarket"),
      }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function stubVenueResponses({
  polymarketUmaStatus,
  kalshiStatus,
}: {
  polymarketUmaStatus: string;
  kalshiStatus: string;
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("gamma-api.polymarket.com/markets?slug=")) {
      return jsonResponse([
        {
          id: "market-1",
          conditionId: POLYMARKET_MARKET_REF,
          slug: `btc-updown-15m-${Math.floor(SLOT_START_TS / 1_000)}`,
          closed: true,
          outcomePrices: '["1","0"]',
          umaResolutionStatus: polymarketUmaStatus,
        },
      ]);
    }
    if (url.includes(`/markets/${KALSHI_MARKET_REF}`)) {
      return jsonResponse({
        market: {
          ticker: KALSHI_MARKET_REF,
          status: kalshiStatus,
          result: "no",
        },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}
