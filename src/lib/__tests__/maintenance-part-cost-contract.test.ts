import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const sql = fs.readFileSync(
  path.resolve(process.cwd(), "supabase/migrations/20260924162500_maintenance_part_cost_guard.sql"),
  "utf8",
);

describe("maintenance part valuation guard", () => {
  it("normalizes unknown cost to zero instead of aborting the repair", () => {
    expect(sql).toContain("COALESCE(NEW.unit_cost,0)");
  });
});
