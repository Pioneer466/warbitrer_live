import { getCurrentSlot, getCurrentSlots } from "@/lib/slot";

describe("slot resolver", () => {
  it("floors UTC time to the current 15 minute window", () => {
    const slot = getCurrentSlot("btc", new Date("2026-03-30T19:37:10.000Z"));

    expect(slot.startIso).toBe("2026-03-30T19:30:00.000Z");
    expect(slot.endIso).toBe("2026-03-30T19:45:00.000Z");
    expect(slot.key).toBe("btc:1774899000000");
    expect(slot.polymarketSlug).toBe("btc-updown-15m-1774899000");
    expect(slot.secondsRemaining).toBe(470);
  });

  it("builds ETH slots with namespaced keys and ETH slugs", () => {
    const slot = getCurrentSlot("eth", new Date("2026-03-30T19:37:10.000Z"));

    expect(slot.key).toBe("eth:1774899000000");
    expect(slot.polymarketSlug).toBe("eth-updown-15m-1774899000");
    expect(slot.asset).toBe("eth");
  });

  it("builds SOL and XRP slots with namespaced keys and matching slugs", () => {
    const now = new Date("2026-03-30T19:37:10.000Z");
    const solSlot = getCurrentSlot("sol", now);
    const xrpSlot = getCurrentSlot("xrp", now);

    expect(solSlot.key).toBe("sol:1774899000000");
    expect(solSlot.polymarketSlug).toBe("sol-updown-15m-1774899000");
    expect(xrpSlot.key).toBe("xrp:1774899000000");
    expect(xrpSlot.polymarketSlug).toBe("xrp-updown-15m-1774899000");
  });

  it("returns all four current slots in canonical asset order", () => {
    const slots = getCurrentSlots(new Date("2026-03-30T19:37:10.000Z"));

    expect(slots.map((slot) => slot.asset)).toEqual(["btc", "eth", "sol", "xrp"]);
  });
});
