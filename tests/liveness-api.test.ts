import { GET } from "@/app/api/liveness/route";

describe("liveness API", () => {
  it("returns a static no-store 200 without touching runtime dependencies", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      service: "warbitrer-web",
    });
  });
});
