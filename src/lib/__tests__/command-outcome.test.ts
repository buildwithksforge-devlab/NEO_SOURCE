import { describe, expect, it } from "vitest";
import { isHalt, isSuccess, settlementOutcome } from "@/lib/command-outcome";

describe("settlement outcome", () => {
  it("only reports closure when the backend actually closed the bill", () => {
    const r = settlementOutcome({ closed: true, grand_total: 3250, balance: 0, open_items: 0 });
    expect(r.status).toBe("completed");
    expect(r.message).toContain("closed");
  });

  it("never announces success wording for an unpaid bill", () => {
    const r = settlementOutcome({
      closed: false,
      grand_total: 3250,
      balance: 3250,
      payment_status: "unpaid",
      open_items: 0,
    });
    expect(r.status).toBe("persisted");
    expect(r.reason).toBe("outstanding-balance");
    expect(r.message).not.toContain("closed");
  });

  it("explains that open items keep a fully paid bill open", () => {
    const r = settlementOutcome({ closed: false, grand_total: 3250, balance: 0, open_items: 2 });
    expect(r.reason).toBe("open-items");
  });

  it("blocks reconciliation of a bill with nothing chargeable on it", () => {
    const r = settlementOutcome({ closed: false, grand_total: 0, balance: 0, open_items: 0 });
    expect(isHalt(r.status)).toBe(true);
  });

  it("classifies statuses consistently", () => {
    expect(isSuccess("completed")).toBe(true);
    expect(isSuccess("blocked")).toBe(false);
    expect(isHalt("failed")).toBe(true);
    expect(isHalt("processing")).toBe(false);
  });
});
