import { describe, expect, it } from "vitest";
import { RECORD_SOURCES } from "@/lib/record-search";

describe("global record search route integrity", () => {
  it("points supplier search at the real supplier administration route", () => {
    const supplier = RECORD_SOURCES.find((source) => source.kind === "supplier");
    expect(supplier?.page).toBe("/admin/suppliers");
    expect(supplier?.map({ id: "s1", name: "Supplier One" })?.to).toBe("/admin/suppliers");
  });
});
