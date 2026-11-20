import { describe, expect, it } from "vitest";
import { chooseGuestFulfilment, orderBucket } from "@/lib/guest-presentation";

const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();

describe("guest order buckets", () => {
  it("keeps live kitchen and dispatch states active", () => {
    for (const status of ["pending", "pending-payment", "in-preparation", "rider-assigned", "out-for-delivery", "ready-for-pickup", "on_the_way"]) {
      expect(orderBucket(status)).toBe("active");
    }
  });

  it("distinguishes a rider pickup from a customer's collection", () => {
    expect(orderBucket("collected", null, "delivery")).toBe("active");
    expect(orderBucket("collected", null, "pickup")).toBe("completed");
  });

  it("treats a future scheduled order as scheduled, not active", () => {
    expect(orderBucket("confirmed", future)).toBe("scheduled");
    expect(orderBucket("confirmed", past)).toBe("active");
  });

  it("never shows a cancelled order as scheduled", () => {
    expect(orderBucket("cancelled", future)).toBe("cancelled");
    expect(orderBucket("rejected")).toBe("cancelled");
  });

  it("closes out delivered and completed orders", () => {
    expect(orderBucket("delivered")).toBe("completed");
    expect(orderBucket("closed")).toBe("completed");
  });

  it("does not leave an unknown status stuck in active", () => {
    expect(orderBucket("some_unmapped_state")).toBe("completed");
    expect(orderBucket(null)).toBe("completed");
  });
});

describe("guest fulfilment selection", () => {
  const delivery = [{ id: "delivery-dish" }];
  const pickup = [{ id: "pickup-dish" }];
  const roomService = [{ id: "room-dish" }];

  it("opens collection at properties with a collection menu and zero delivery dishes", () => {
    expect(chooseGuestFulfilment(false, { "room-service": roomService, pickup, delivery: [] })).toBe("pickup");
    expect(chooseGuestFulfilment(true, { "room-service": roomService, pickup, delivery: [] })).toBe("room-service");
  });

  it("opens a mode where the requested dish is actually published", () => {
    const catalogues = { "room-service": roomService, pickup, delivery };
    expect(chooseGuestFulfilment(false, catalogues, "pickup-dish")).toBe("pickup");
    expect(chooseGuestFulfilment(false, catalogues, "room-dish")).toBe("delivery");
  });
});
