import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Maintenance assignment eligibility.
 *
 * One rule decides who may receive maintenance work: an active staff account
 * with an active employee record at the property in scope, holding the
 * Maintenance "My jobs" capability. Selectors, preventive plans, reassignment
 * and generated work orders all resolve through it, and the database refuses
 * anything else. These checks keep that single rule from drifting apart again.
 */
const migration = readFileSync(
  "supabase/migrations/20260920132603_31750c0e-9249-4834-bdd2-5967999a0d22.sql",
  "utf8",
);
const page = readFileSync("src/routes/_shell.maintenance.index.tsx", "utf8");
const department = readFileSync("src/lib/maintenance-department.ts", "utf8");

describe("eligibility is resolved once, in the database", () => {
  it("resolves effective permission for any member, not only the signed-in one", () => {
    expect(migration).toContain("FUNCTION public.neo_user_has_permission_in_org");
    // Denies must still beat grants, exactly as the session-scoped resolver does.
    expect(migration).toMatch(/h\.effect = 'deny'[\s\S]*THEN false/);
  });

  it("requires active staff, an active employee record and the maintenance capability", () => {
    expect(migration).toContain("FUNCTION public.neo_maintenance_technician_eligible");
    expect(migration).toContain("coalesce(p.account_status, 'active') = 'active'");
    expect(migration).toContain("e.id IS NOT NULL");
    expect(migration).toContain("'maintenance', 'my-jobs', 'view'");
  });

  it("never offers a technician from another property", () => {
    expect(migration).toContain(
      "IF _branch IS NOT NULL AND v_worker_branch IS NOT NULL AND v_worker_branch <> _branch",
    );
  });

  it("scopes the resolver to one workspace", () => {
    expect(migration).toContain("ur.organization_id = _org");
    expect(migration).toContain("pr.organization_id = _org");
  });
});

describe("every assignment surface is guarded on write", () => {
  it("guards ordinary work orders and preventive plans with the same trigger", () => {
    expect(migration).toContain("neo_guard_maintenance_assignee");
    expect(migration).toMatch(
      /BEFORE INSERT OR UPDATE OF assigned_to ON public\.maintenance_work_orders/,
    );
    expect(migration).toMatch(
      /BEFORE INSERT OR UPDATE OF assigned_to ON public\.preventive_maintenance_plans/,
    );
  });

  it("leaves an unchanged historic assignment alone instead of rewriting records", () => {
    expect(migration).toContain("OLD.assigned_to IS NOT DISTINCT FROM NEW.assigned_to");
  });

  it("explains in plain words what is missing", () => {
    expect(migration).toContain("active employee record at this property");
  });
});

describe("the screens read the same list the database enforces", () => {
  it("exposes one technician directory hook", () => {
    expect(department).toContain("neo_maintenance_technicians");
    expect(department).toContain("export function useMaintenanceTechnicians");
  });

  it("uses it for both ordinary assignment and preventive plans", () => {
    expect(page).toContain("useMaintenanceTechnicians");
    expect(page).not.toContain('useStaffLite("maintenance")');
    expect(page.match(/technicians\.data/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it("flags a historic holder who is no longer eligible rather than hiding it", () => {
    expect(page).toContain("Current holder can no longer work maintenance jobs");
  });
});

describe("reported figures are property-scoped and honestly labelled", () => {
  it("filters preventive occurrences by the property being viewed", () => {
    expect(migration).toContain("(_branch IS NULL OR pl.branch_id = _branch)");
  });

  it("only offers the personal maintenance queue to people who can open it", () => {
    expect(migration).toContain("public.has_permission('maintenance', 'my-jobs', 'view')");
  });

  it("distinguishes plans falling due from outstanding occurrences", () => {
    expect(page).toContain("PM plans falling due");
  });
});
