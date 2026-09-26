import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260920125355_497143f5-5240-4c6d-9b93-aeccc0e95475.sql",
  "utf8",
);

describe("landscaping recurrence persistence contract", () => {
  it("enforces one occurrence per workspace, property, schedule and due date", () => {
    expect(migration).toContain(
      "(organization_id, branch_id, schedule_id, service_date)",
    );
    expect(migration).toContain(
      "WHERE schedule_id IS NOT NULL AND branch_id IS NOT NULL",
    );
  });

  it("uses the same partial unique index predicate as its conflict target", () => {
    expect(migration).toMatch(
      /ON CONFLICT \(organization_id, branch_id, schedule_id, service_date\)\s+WHERE schedule_id IS NOT NULL AND branch_id IS NOT NULL\s+DO NOTHING/,
    );
  });

  it("locks due schedules and advances exactly the processed occurrence", () => {
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("v_occurrence_date := v_sched.next_due_date");
    expect(migration).toContain("AND next_due_date = v_occurrence_date");
  });

  it("copies the schedule's canonical area, equipment, worker and instructions", () => {
    for (const field of [
      "v_sched.area_id",
      "v_sched.equipment_asset_id",
      "v_sched.assignee_user_id",
      "v_sched.instructions",
    ]) {
      expect(migration).toContain(field);
    }
  });

  it("rejects cross-property area and equipment references before generation", () => {
    expect(migration).toContain("a.organization_id = v_sched.organization_id");
    expect(migration).toContain("a.branch_id = v_sched.branch_id");
    expect(migration).toContain("equipment outside its property");
  });
});