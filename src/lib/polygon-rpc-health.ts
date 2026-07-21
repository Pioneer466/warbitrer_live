import { POLYGON_CHAIN_ID } from "@/lib/polymarket-onchain-fill";

const DEFAULT_TIMEOUT_MS = 5_000;

export type PolygonRpcHealthResult =
  | {
      ok: true;
      chainId: typeof POLYGON_CHAIN_ID;
      blockNumber: number;
    }
  | {
      ok: false;
      failureKind: "missing_configuration" | "health_check_failed";
      detail: string;
    };

export async function checkPolygonRpcEndpoint(
  rpcUrl: string | undefined,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<PolygonRpcHealthResult> {
  const normalizedUrl = rpcUrl?.trim();
  if (!normalizedUrl) {
    return {
      ok: false,
      failureKind: "missing_configuration",
      detail: "POLYGON_RPC_URL is missing",
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid Polygon RPC timeout ${timeoutMs}`);
  }

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const chainId = await readRpcQuantity(fetchImpl, normalizedUrl, "eth_chainId", 1, timeoutMs);
    if (chainId !== POLYGON_CHAIN_ID) {
      throw new Error(`RPC returned chain ID ${chainId}; expected Polygon mainnet ${POLYGON_CHAIN_ID}`);
    }
    const blockNumber = await readRpcQuantity(fetchImpl, normalizedUrl, "eth_blockNumber", 2, timeoutMs);
    return { ok: true, chainId: POLYGON_CHAIN_ID, blockNumber };
  } catch (error) {
    return {
      ok: false,
      failureKind: "health_check_failed",
      detail: sanitizeDetail(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function readRpcQuantity(
  fetchImpl: typeof fetch,
  rpcUrl: string,
  method: "eth_chainId" | "eth_blockNumber",
  id: number,
  timeoutMs: number,
) {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: [] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${method} returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { result?: unknown; error?: unknown };
  if (typeof payload.result !== "string" || !/^0x[0-9a-f]+$/i.test(payload.result)) {
    const rpcError =
      payload.error === undefined ? "missing hexadecimal result" : sanitizeDetail(JSON.stringify(payload.error));
    throw new Error(`${method} failed: ${rpcError}`);
  }
  const quantity = BigInt(payload.result);
  if (quantity > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${method} exceeds safe integer precision`);
  }
  return Number(quantity);
}

function sanitizeDetail(value: string) {
  return (
    value
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, 1_024) || "unknown RPC failure"
  );
}
