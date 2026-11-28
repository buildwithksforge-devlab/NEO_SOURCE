import { describe, expect, it } from "vitest";
import { mpesaObservationInterval, mpesaResultApplied, mpesaSupportsTotal } from "@/lib/mpesa-application-result";

describe("delayed M-Pesa evidence", () => {
  it("requires a supported whole KES amount without silently rounding the bill", () => {
    expect(mpesaSupportsTotal(51, "KES")).toBe(true);
    expect(mpesaSupportsTotal("51", "KES")).toBe(true);
    for (const amount of [51.5, 0, -1, NaN, Infinity, null, true, "", Number.MAX_SAFE_INTEGER + 1]) {
      expect(mpesaSupportsTotal(amount, "KES")).toBe(false);
    }
    expect(mpesaSupportsTotal(51, "USD")).toBe(false);
  });
  it.each([undefined, "initiated", "pending", "unknown", "timeout", "cancelled", "failed"])(
    "keeps observing %s without treating it as collected money", (status) => {
      expect(mpesaObservationInterval(status)).toBe(4000);
      expect(mpesaResultApplied({ status, applied: true }, 0)).toBe(false);
    },
  );
  it("stops only after the saved success and requires matching atomic application", () => {
    expect(mpesaObservationInterval("success")).toBe(false);
    expect(mpesaResultApplied({ status: "success" }, 0)).toBe(false);
    expect(mpesaResultApplied({ status: "success", applied: true }, 0)).toBe(true);
  });
});
