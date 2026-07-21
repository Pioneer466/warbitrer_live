import { checkPolygonRpcEndpoint } from "@/lib/polygon-rpc-health";

describe("Polygon RPC health", () => {
  it("requires a configured endpoint", async () => {
    await expect(checkPolygonRpcEndpoint("  ")).resolves.toEqual({
      ok: false,
      failureKind: "missing_configuration",
      detail: "POLYGON_RPC_URL is missing",
    });
  });

  it("verifies Polygon mainnet and a readable block number", async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      methods.push(request.method);
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: request.method === "eth_chainId" ? "0x89" : "0x2faf080",
      });
    }) as typeof fetch;

    await expect(checkPolygonRpcEndpoint("https://polygon.example", { fetchImpl, timeoutMs: 1_000 })).resolves.toEqual({
      ok: true,
      chainId: 137,
      blockNumber: 50_000_000,
    });
    expect(methods).toEqual(["eth_chainId", "eth_blockNumber"]);
  });

  it("fails closed on a valid RPC for the wrong chain", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" })) as typeof fetch;

    await expect(checkPolygonRpcEndpoint("https://ethereum.example", { fetchImpl })).resolves.toMatchObject({
      ok: false,
      failureKind: "health_check_failed",
      detail: "RPC returned chain ID 1; expected Polygon mainnet 137",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects HTTP failures and malformed JSON-RPC quantities", async () => {
    const httpFailure = vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch;
    await expect(checkPolygonRpcEndpoint("https://polygon.example", { fetchImpl: httpFailure })).resolves.toMatchObject(
      {
        ok: false,
        detail: "eth_chainId returned HTTP 503",
      },
    );

    const malformed = vi.fn(async () => Response.json({ jsonrpc: "2.0", id: 1, result: "137" })) as typeof fetch;
    await expect(checkPolygonRpcEndpoint("https://polygon.example", { fetchImpl: malformed })).resolves.toMatchObject({
      ok: false,
      detail: "eth_chainId failed: missing hexadecimal result",
    });
  });
});
