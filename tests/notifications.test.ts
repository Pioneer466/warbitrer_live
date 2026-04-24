import { buildQueuedNotificationFromRunEvent } from "@/lib/notifications";
import type { RunEvent } from "@/lib/types";

describe("telegram notification mapping", () => {
  it("maps a live trade event to one deduped trade notification", () => {
    const event: RunEvent = {
      asset: "eth",
      level: "info",
      eventType: "intent.live_traded",
      message: "Live trade engaged for intent intent-1",
      payload: {
        intentId: "intent-1",
        asset: "eth",
        slotKey: "eth:1777000000000",
        combination: "POLY_DOWN_KALSHI_YES",
        primaryVenue: "kalshi",
        hedgeVenue: "polymarket",
        targetNotionalUsd: 20,
        grossCost: 0.93,
        primaryFilledSize: 10,
        primaryFilledPrice: 0.44,
      },
      createdAt: 1_777_000_000_000,
    };

    const notification = buildQueuedNotificationFromRunEvent(event);

    expect(notification).toMatchObject({
      asset: "eth",
      kind: "trade_live",
      dedupeKey: "trade_live:intent-1",
    });
    expect(notification?.message).toContain("LIVE TRADE");
    expect(notification?.message).toContain("ETH · POLY_DOWN_KALSHI_YES");
  });

  it("maps a manual intervention event to one deduped incident notification", () => {
    const event: RunEvent = {
      asset: "sol",
      level: "error",
      eventType: "intent.manual_intervention_required",
      message: "Manual intervention required for intent intent-2",
      payload: {
        intentId: "intent-2",
        asset: "sol",
        slotKey: "sol:1777000000000",
        combination: "POLY_UP_KALSHI_NO",
        primaryVenue: "kalshi",
        hedgeVenue: "polymarket",
        stage: "primary_unwind_failed",
        failureReason: "Primary unwind failed (canceled); manual intervention required",
      },
      createdAt: 1_777_000_000_000,
    };

    const notification = buildQueuedNotificationFromRunEvent(event);

    expect(notification).toMatchObject({
      asset: "sol",
      kind: "manual_intervention",
      dedupeKey: "manual_intervention:intent-2",
    });
    expect(notification?.message).toContain("MANUAL INTERVENTION REQUIRED");
    expect(notification?.message).toContain("stage primary_unwind_failed");
  });

  it("ignores unrelated run events", () => {
    const event: RunEvent = {
      asset: "btc",
      level: "info",
      eventType: "order.primary.submitted",
      message: "Primary kalshi order x",
      payload: {
        intentId: "intent-3",
      },
      createdAt: 1_777_000_000_000,
    };

    expect(buildQueuedNotificationFromRunEvent(event)).toBeNull();
  });
});
