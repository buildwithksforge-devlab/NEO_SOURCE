import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const sql = fs.readFileSync(
  path.resolve(process.cwd(), "supabase/migrations/20260924161500_maintenance_assignment_create_guards.sql"),
  "utf8",
);

describe("maintenance assignment/create guards", () => {
  it("normalizes missing cost estimate", () => {
    expect(sql).toContain("COALESCE(NEW.cost_estimate,0)");
  });
  it("builds technicians from eligible active employees", () => {
    expect(sql).toContain("FROM public.employees e");
    expect(sql).toContain("neo_maintenance_technician_eligible(e.profile_id");
  });
});
