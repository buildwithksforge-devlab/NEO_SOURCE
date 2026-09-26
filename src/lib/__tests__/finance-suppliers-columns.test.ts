import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Finance → Suppliers used to select suppliers.status, a column that does not
 * exist, so the payables screen failed to load entirely. Suppliers carry an
 * `active` flag instead; this pins the selection to the real columns.
 */
const finance = readFileSync("src/lib/finance-data.ts", "utf8");

describe("finance supplier query matches the suppliers table", () => {
  const select = /useSuppliers[\s\S]{0,200}?"([^"]*\bname\b[^"]*)"/.exec(finance)?.[1] ?? "";

  it("selects id, name and active", () => {
    expect(select).toContain("id");
    expect(select).toContain("name");
    expect(select).toContain("active");
  });

  it("never selects the non-existent status column", () => {
    expect(select).not.toContain("status");
    expect(finance).not.toMatch(/from\("suppliers"\)[\s\S]{0,120}status/);
  });
});
