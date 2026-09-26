import { describe, expect, it } from "vitest";
import { HOUSEKEEPING_STATUSES, canonicalHousekeepingStatus, housekeepingLabel } from "@/lib/operations";

describe("canonical housekeeping vocabulary", () => {
  it("maps every legacy alias onto one canonical condition", () => {
    expect(canonicalHousekeepingStatus("in-progress")).toBe("cleaning_in_progress");
    expect(canonicalHousekeepingStatus("Cleaning In Progress")).toBe("cleaning_in_progress");
    expect(canonicalHousekeepingStatus("cleaning")).toBe("cleaning_in_progress");
    expect(canonicalHousekeepingStatus("awaiting-inspection")).toBe("awaiting_inspection");
    expect(canonicalHousekeepingStatus("vacant-dirty")).toBe("dirty");
    expect(canonicalHousekeepingStatus("failed")).toBe("rework_required");
  });

  it("labels every canonical key without falling back to a raw value", () => {
    for (const status of HOUSEKEEPING_STATUSES) {
      expect(housekeepingLabel(status.key)).toBe(status.label);
    }
    expect(housekeepingLabel("in-progress")).toBe("Cleaning in Progress");
  });
});
