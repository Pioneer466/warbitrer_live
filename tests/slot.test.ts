import { getCurrentSlot } from "@/lib/slot";

describe("slot resolver", () => {
  it("floors UTC time to the current 15 minute window", () => {
    const slot = getCurrentSlot(new Date("2026-03-30T19:37:10.000Z"));

    expect(slot.startIso).toBe("2026-03-30T19:30:00.000Z");
    expect(slot.endIso).toBe("2026-03-30T19:45:00.000Z");
    expect(slot.polymarketSlug).toBe("btc-updown-15m-1774899000");
    expect(slot.secondsRemaining).toBe(470);
  });
});
