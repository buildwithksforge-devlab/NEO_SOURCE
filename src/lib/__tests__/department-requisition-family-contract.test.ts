import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const sql = fs.readFileSync(
  path.resolve(process.cwd(), "supabase/migrations/20260924154500_department_requisition_family_guards.sql"),
  "utf8",
);

describe("department requisition family guards", () => {
  it("does not aggregate UUIDs with min()", () => {
    expect(sql).not.toMatch(/min\(n\.(branch_id|department_id)\)/i);
    expect(sql).toContain("array_agg(n.branch_id");
    expect(sql).toContain("array_agg(n.department_id");
  });

  it("rejects mixed property and mixed department selections", () => {
    expect(sql).toContain("Selected needs must belong to one property");
    expect(sql).toContain("Selected needs must belong to one department");
  });

  it("preserves domain-specific authority before Stores handoff", () => {
    expect(sql).toContain("has_permission('kitchen','pastry-requisition','create')");
    expect(sql).toContain("has_permission('kitchen','requisition','create')");
    expect(sql).toContain("has_permission('security','requisition','create')");
    expect(sql).toContain("has_permission('front-office','requisitions','create')");
  });
});
