import { describe, expect, it } from "vitest";
import { minibarChannelAllowed, minibarStoreAllowed } from "../minibar-options";
describe("minibar property and channel choices", () => {
  it("excludes bar-only items while retaining explicit minibar and unrestricted items", () => {
    expect(minibarChannelAllowed(["bar", "restaurant"])).toBe(false);
    expect(minibarChannelAllowed(["minibar", "restaurant"])).toBe(true);
    expect(minibarChannelAllowed([])).toBe(true);
    expect(minibarChannelAllowed(null)).toBe(true);
    expect(minibarChannelAllowed("minibar")).toBe(false);
  });
  it("offers only active stores from the selected folio property", () => {
    expect(minibarStoreAllowed({ active: true, branch_id: "hotel-a", location_type: "minibar" }, "hotel-a")).toBe(true);
    expect(minibarStoreAllowed({ active: true, branch_id: "hotel-a", location_type: "bar" }, "hotel-a")).toBe(false);
    expect(minibarStoreAllowed({ active: true, branch_id: "hotel-a" }, "hotel-a")).toBe(false);
    expect(minibarStoreAllowed({ active: true, branch_id: "hotel-b", location_type: "minibar" }, "hotel-a")).toBe(false);
    expect(minibarStoreAllowed({ active: false, branch_id: "hotel-a", location_type: "minibar" }, "hotel-a")).toBe(false);
    expect(minibarStoreAllowed({ active: true, branch_id: null, location_type: "minibar" }, "hotel-a")).toBe(false);
    expect(minibarStoreAllowed({ active: true, branch_id: "hotel-a", location_type: "minibar" }, null)).toBe(false);
  });
});
