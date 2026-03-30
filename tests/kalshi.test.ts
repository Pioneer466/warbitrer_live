import { deriveKalshiOutcomeQuotes } from "@/lib/kalshi";

describe("Kalshi quote derivation", () => {
  it("builds yes/no asks from the reciprocal bid-only orderbook", () => {
    const quotes = deriveKalshiOutcomeQuotes({
      yes_dollars: [
        ["0.10", "12"],
        ["0.67", "114"],
        ["0.76", "1719.12"],
      ],
      no_dollars: [
        ["0.14", "12"],
        ["0.22", "5"],
        ["0.33", "100"],
      ],
    });

    expect(quotes.yes.sellPrice).toBe(0.76);
    expect(quotes.yes.buyPrice).toBe(0.67);
    expect(quotes.no.sellPrice).toBe(0.33);
    expect(quotes.no.buyPrice).toBe(0.24);
    expect(quotes.yes.depth).toBe(100);
    expect(quotes.no.depth).toBe(1719.12);
  });
});
