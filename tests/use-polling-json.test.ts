import { buildPollingErrorState, parsePollingJsonResponse, type PollingState } from "@/components/use-polling-json";
import type { HealthErrorResponse, HealthResponse } from "@/lib/types";

describe("polling JSON response policy", () => {
  it("parses an explicitly accepted non-2xx health payload", async () => {
    const payload: HealthErrorResponse = {
      status: "error",
      ok: false,
      error: "health_check_failed",
      timestamp: 1_800_000_000_000,
      liveExecutionAllowed: false,
    };
    const response = new Response(JSON.stringify(payload), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });

    const result = await parsePollingJsonResponse<HealthResponse>(response, {
      parseJsonOnNonOk: true,
    });

    expect(result.data).toEqual(payload);
    expect(result.error).toBe("health_check_failed");
    expect(result.data.liveExecutionAllowed).toBe(false);
  });

  it("rejects non-2xx JSON unless the caller explicitly opts in", async () => {
    const response = new Response(JSON.stringify({ error: "unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });

    await expect(parsePollingJsonResponse(response)).rejects.toThrow("unavailable");
  });

  it("clears stale data after an unstructured error when requested", async () => {
    const current: PollingState<{ liveExecutionAllowed: boolean }> = {
      data: { liveExecutionAllowed: true },
      error: null,
      loading: false,
    };
    const response = new Response("upstream unavailable", { status: 503 });

    await expect(
      parsePollingJsonResponse(response, {
        parseJsonOnNonOk: true,
      }),
    ).rejects.toThrow("upstream unavailable");
    expect(buildPollingErrorState(current, new Error("upstream unavailable"), true)).toEqual({
      data: null,
      error: "upstream unavailable",
      loading: false,
    });
  });
});
