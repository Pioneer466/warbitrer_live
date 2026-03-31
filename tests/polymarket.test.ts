import { derivePolymarketDepth, extractPolymarketResolution } from "@/lib/polymarket";

describe("Polymarket helpers", () => {
  it("detects resolution from terminal outcome prices", () => {
    expect(extractPolymarketResolution('["1","0"]')).toBe("UP");
    expect(extractPolymarketResolution('["0","1"]')).toBe("DOWN");
    expect(extractPolymarketResolution('["0.61","0.39"]')).toBeNull();
  });

  it("uses the ask side depth closest to the targeted buy execution", () => {
    const depth = derivePolymarketDepth(
      {
        bids: [
          { price: "0.70", size: "126.24" },
          { price: "0.72", size: "193.85" },
        ],
        asks: [
          { price: "0.80", size: "774.5" },
          { price: "0.81", size: "219.32" },
        ],
      },
      0.72,
    );

    expect(depth).toBe(774.5);
  });
});
