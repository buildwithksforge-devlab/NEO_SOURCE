/**
 * Housekeeping supervision matrix.
 *
 * A Housekeeping Manager supervises the department: assign, reassign, set
 * priority, inspect, release rooms, report and requisition. An ordinary
 * Housekeeper works only the rooms assigned to them: accept, start, complete,
 * fill in their own checklist and report a fault — never assign, inspect,
 * release, or raise a stores requisition.
 *
 * The database is the enforcement point, so the grants below mirror the
 * compiled role defaults and the assertions mirror the RLS predicates.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addGrant, canFromPermissions } from "@/lib/permissions";

const RLS = readFileSync(join(process.cwd(), "src/lib/__tests__/fixtures/ownership-isolation.sql"), "utf8");
const policy = (name: string) => {
  const i = RLS.indexOf(`(${name})`);
  expect(i, `${name} missing from fixture`).toBeGreaterThan(-1);
  const rest = RLS.slice(i);
  return rest.slice(0, rest.indexOf("\n\n"));
};

/** Compiled default grants, as `provision_catalogue_roles` seeds them. */
const MANAGER: Array<[string, string]> = [
  ["housekeeping", "board.view"],
  ["housekeeping", "assign"],
  ["housekeeping", "inspect"],
  ["housekeeping", "inspection.fail"],
  ["housekeeping", "room.ready"],
  ["housekeeping", "create"],
  ["housekeeping", "edit"],
  ["housekeeping", "reports.view"],
  ["maintenance", "work-orders.create"],
  ["stores", "requisition.create"],
  ["stores", "requisition.submit"],
];

const HOUSEKEEPER: Array<[string, string]> = [
  ["housekeeping", "assigned.view"],
  ["housekeeping", "cleaning.start"],
  ["housekeeping", "cleaning.complete"],
  ["housekeeping", "lost-found.manage"],
  ["housekeeping", "guest-requests.manage"],
  ["maintenance", "work-orders.create"],
  ["stores", "consumption.record"],
];

function grants(rows: Array<[string, string]>) {
  const set = new Set<string>();
  for (const [module, action] of rows) {
    const dot = action.lastIndexOf(".");
    if (dot > 0) addGrant(set, module, action.slice(0, dot), action.slice(dot + 1));
    else addGrant(set, module, "*", action);
  }
  return set;
}

const manager = grants(MANAGER);
const housekeeper = grants(HOUSEKEEPER);
const can = (set: Set<string>, module: string, action: string) => canFromPermissions(set)(module, action);

describe("Housekeeping Manager supervises the department", () => {
  it.each([
    ["housekeeping", "board.view"],
    ["housekeeping", "tasks.assign"],
    ["housekeeping", "tasks.create"],
    ["housekeeping", "tasks.edit"],
    ["housekeeping", "inspections.edit"],
    ["housekeeping", "room.ready"],
    ["housekeeping", "reports.view"],
    ["maintenance", "work-orders.create"],
    ["stores", "requisition.create"],
    ["stores", "requisition.submit"],
  ])("may %s.%s", (module, action) => {
    expect(can(manager, module, action)).toBe(true);
  });
});

describe("Housekeeper works only assigned rooms", () => {
  it.each([
    ["housekeeping", "assigned.view"],
    ["housekeeping", "cleaning.start"],
    ["housekeeping", "cleaning.complete"],
    ["maintenance", "work-orders.create"],
  ])("keeps %s.%s", (module, action) => {
    expect(can(housekeeper, module, action)).toBe(true);
  });

  it.each([
    ["housekeeping", "tasks.assign"],
    ["housekeeping", "tasks.create"],
    ["housekeeping", "tasks.edit"],
    ["housekeeping", "tasks.delete"],
    ["housekeeping", "inspections.create"],
    ["housekeeping", "inspections.edit"],
    ["housekeeping", "room.ready"],
    ["housekeeping", "board.view"],
    ["stores", "requisition.create"],
    ["stores", "requisition.submit"],
  ])("is denied %s.%s", (module, action) => {
    expect(can(housekeeper, module, action)).toBe(false);
  });
});

describe("the database asks for the supervisory feature, not any housekeeping grant", () => {
  it("cleaning task writes require housekeeping.tasks", () => {
    expect(policy("housekeeping_jobs_insert")).toContain(
      "has_permission('housekeeping'::text, 'tasks'::text, 'create'::text)",
    );
    expect(policy("housekeeping_jobs_update")).toContain(
      "has_permission('housekeeping'::text, 'tasks'::text, 'edit'::text)",
    );
    expect(policy("housekeeping_jobs_delete")).toContain(
      "has_permission('housekeeping'::text, 'tasks'::text, 'delete'::text)",
    );
  });

  it("never falls back to a module-wide housekeeping action check", () => {
    for (const name of ["housekeeping_jobs_insert", "housekeeping_jobs_update", "housekeeping_jobs_delete"]) {
      expect(policy(name)).not.toMatch(/has_permission\('housekeeping'::text, '(create|edit|delete|approve)'::text\)/);
    }
  });

  it("keeps every write inside the signed-in workspace", () => {
    expect(policy("housekeeping_jobs_insert")).toContain("organization_id = current_org_id()");
    expect(policy("housekeeping_jobs_delete")).toContain("organization_id = current_org_id()");
    expect(policy("housekeeping_jobs_update")).toContain(
      "in_my_scope(organization_id, branch_id, department_id, NULL::uuid, assignee_id, created_by)",
    );
  });

  it("never widens a write to any workspace administrator", () => {
    for (const name of ["housekeeping_jobs_insert", "housekeeping_jobs_update", "housekeeping_jobs_delete"]) {
      expect(policy(name)).toContain("is_org_admin_for(organization_id)");
      expect(policy(name)).not.toMatch(/is_org_admin\(\)/);
    }
  });
});
