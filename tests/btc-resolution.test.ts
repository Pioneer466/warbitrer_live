import { deriveBtcResolution, toKalshiResolution } from "@/lib/btc-resolution";

describe("btc reference resolution", () => {
  it("maps the slot candle direction to paper resolutions", () => {
    expect(deriveBtcResolution(100, 110)).toBe("UP");
    expect(deriveBtcResolution(110, 100)).toBe("DOWN");
    expect(deriveBtcResolution(100, 100)).toBeNull();
    expect(toKalshiResolution("UP")).toBe("YES");
    expect(toKalshiResolution("DOWN")).toBe("NO");
  });
});
