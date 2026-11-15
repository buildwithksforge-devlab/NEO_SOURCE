import { describe, expect, it } from "vitest";
import { mpesaObservationInterval, mpesaResultApplied } from "@/lib/mpesa-application-result";

describe("delayed M-Pesa evidence", () => {
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
