import { describe, expect, it } from "vitest";
import { orderBucket } from "@/routes/guest.$hotelSlug.orders";

const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();

describe("guest order buckets", () => {
  it("keeps live kitchen and dispatch states active", () => {
    for (const status of ["pending", "confirmed", "preparing", "ready", "on_the_way"]) {
      expect(orderBucket(status)).toBe("active");
    }
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
