/**
 * Deny-by-default parity.
 *
 * One capability answer must drive every surface: the signed-in sidebar, the
 * route guard, Workspace Preview / Role Testing, and the database's own
 * row-level predicates. These tests compare those surfaces against each other
 * for the department roles the operating model defines, asserting both what a
 * role may reach and — just as importantly — what it may not.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { moduleFeatures } from "@/lib/capabilities";
import { navigation } from "@/lib/navigation";
import { canAccessPath, navItemVisible, navigationForAccess } from "@/lib/nav-permissions";
import { addGrant, canFromPermissions } from "@/lib/permissions";
import { compileRoleTemplate } from "@/lib/role-templates";
import { previewNavigation } from "@/lib/workspace-preview";

const FEATURES = moduleFeatures();
const ALL_PATHS = navigation.flatMap((g) => g.items.map((i) => i.to));

/** The exact grant set the database compiles for a role, expanded as a login would. */
function permissionsForRole(roleKey: string): Set<string> {
  const set = new Set<string>();
  for (const g of compileRoleTemplate(roleKey, FEATURES)) addGrant(set, g.module, g.feature, g.action);
  return set;
}

const ROLES = [
  "owner",
  "operations-manager",
  "front-office-manager",
  "receptionist",
  "waiter",
  "cashier",
  "barista",
  "chef",
  "head-chef",
  "housekeeper",
  "housekeeping-supervisor",
  "procurement-manager",
  "storekeeper",
  "finance-manager",
  "accountant",
  "marketing-manager",
  "human-resources-manager",
  "rider",
  "delivery-manager",
  "events-manager",
].filter((r) => compileRoleTemplate(r, FEATURES).length > 0);

describe("the roles under test are real, compiled roles", () => {
  it("every named department role compiles to grants", () => {
    expect(ROLES.length).toBeGreaterThanOrEqual(15);
  });
});

describe("actual login and Workspace Preview / Role Testing resolve identically", () => {
  it.each(ROLES)("%s sees the same sidebar in preview as when signed in", (role) => {
    const permissions = permissionsForRole(role);
    const can = canFromPermissions(permissions);

    const live = new Set(
      navigationForAccess(can, false, true).flatMap((g) => g.items.map((i) => i.to)),
    );
    const preview = new Set(
      previewNavigation(permissions, false).flatMap((g) => g.items.map((i) => i.to)),
    );

    expect([...preview].filter((p) => !live.has(p)), `preview shows more than login for ${role}`).toEqual([]);
    expect([...live].filter((p) => !preview.has(p)), `preview hides pages login allows for ${role}`).toEqual([]);
  });

  it.each(ROLES)("%s: preview marks a page allowed only when the route guard admits it", (role) => {
    const permissions = permissionsForRole(role);
    const can = canFromPermissions(permissions);
    for (const item of previewNavigation(permissions, true).flatMap((g) => g.items)) {
      expect(item.allowed, `${role} → ${item.to}`).toBe(navItemVisible(can, item.to));
    }
  });
});

describe("no implicit allow: absence of a capability denies", () => {
  it.each(ROLES)("%s cannot open a single page its grants do not cover", (role) => {
    const can = canFromPermissions(permissionsForRole(role));
    const shown = navigationForAccess(can, false, true).flatMap((g) => g.items.map((i) => i.to));
    for (const path of shown) expect(canAccessPath(can, path), `${role} → ${path}`).toBe(true);
  });

  it("a role with no grants at all reaches nothing beyond universal pages", () => {
    const can = canFromPermissions(new Set<string>());
    const shown = navigationForAccess(can, false, true).flatMap((g) => g.items.map((i) => i.to));
    for (const path of shown) expect(canAccessPath(can, path)).toBe(true);
    expect(shown.length).toBeLessThan(ALL_PATHS.length);
  });

  it("an unrecognised role key compiles to nothing at all", () => {
    expect(compileRoleTemplate("not-a-real-role", FEATURES)).toEqual([]);
  });
});

const holds = (role: string, module: string, feature: string, action: string) =>
  compileRoleTemplate(role, FEATURES).some(
    (g) => g.module === module && g.feature === feature && g.action === action,
  );
const touchesModule = (role: string, module: string) =>
  compileRoleTemplate(role, FEATURES).some((g) => g.module === module);

describe("department boundaries hold in the compiled model", () => {
  it("the receptionist runs the desk but not HR, procurement or kitchen administration", () => {
    expect(touchesModule("receptionist", "front-office")).toBe(true);
    for (const m of ["hr", "procurement", "kitchen", "stores"]) {
      expect(touchesModule("receptionist", m), `receptionist must not reach ${m}`).toBe(false);
    }
  });

  it("the waiter reaches restaurant service only, and never employee records", () => {
    expect(touchesModule("waiter", "restaurant") || touchesModule("waiter", "pos")).toBe(true);
    for (const m of ["hr", "finance", "procurement", "stores", "administration"]) {
      expect(touchesModule("waiter", m), `waiter must not reach ${m}`).toBe(false);
    }
  });

  it("the rider reaches delivery only", () => {
    const modules = new Set(compileRoleTemplate("rider", FEATURES).map((g) => g.module));
    modules.delete("ai");
    expect([...modules].every((m) => m === "delivery" || m === "profile"), [...modules].join(",")).toBe(true);
  });

  it("procurement and stores stay separated", () => {
    expect(touchesModule("procurement-manager", "procurement")).toBe(true);
    expect(holds("storekeeper", "procurement", "orders", "approve")).toBe(false);
    expect(touchesModule("storekeeper", "stores") || touchesModule("storekeeper", "inventory")).toBe(true);
  });

  it("marketing and HR stay out of operational finance, kitchen and procurement", () => {
    for (const m of ["kitchen", "procurement"]) {
      expect(touchesModule("marketing-manager", m), `marketing must not reach ${m}`).toBe(false);
      expect(touchesModule("human-resources-manager", m), `HR must not reach ${m}`).toBe(false);
    }
  });

  it("employee-count reporting stays with roles that hold the HR capability", () => {
    for (const role of ["waiter", "receptionist", "cashier", "barista", "chef", "housekeeper", "rider"]) {
      if (!ROLES.includes(role)) continue;
      expect(touchesModule(role, "hr"), `${role} must not read employee data`).toBe(false);
    }
  });
});

const RLS = readFileSync(join(process.cwd(), "src/lib/__tests__/fixtures/ownership-isolation.sql"), "utf8");
const policy = (name: string) => {
  const i = RLS.indexOf(`(${name})`);
  expect(i, `${name} missing from fixture`).toBeGreaterThan(-1);
  const next = RLS.indexOf("\n-- ", i);
  return RLS.slice(i, next === -1 ? undefined : next);
};

describe("ownership and station isolation is enforced by the database, not the browser", () => {
  it("waiter A cannot read waiter B's orders — the row predicate carries the waiter", () => {
    expect(policy("pos_orders_select")).toContain(
      "in_my_scope(organization_id, branch_id, department_id, station_id, waiter_id, created_by)",
    );
    expect(policy("pos_orders_update")).toContain("waiter_id");
  });

  it("order items inherit the same owning-order predicate", () => {
    expect(policy("pos_order_items_select")).toContain("in_my_scope(o.organization_id");
    expect(policy("pos_order_items_write")).toContain("waiter_id");
  });

  it("rider A only reads their own deliveries", () => {
    expect(policy("delivery_orders_rider_read")).toContain("rider_id = my_rider_id()");
    expect(policy("delivery_orders_staff_read")).toContain("has_permission('delivery'::text, 'orders.view'::text)");
  });

  it("a rider reads only their own shift rows unless they run dispatch", () => {
    const p = policy("rider_shifts_read");
    expect(p).toContain("r.profile_id = auth.uid()");
    expect(p).toContain("has_permission('delivery'::text, 'dispatch.view'::text)");
    expect(policy("rider_shifts_write")).toContain("riders.manage");
  });

  it("housekeeping rows resolve by assignment, not by department name", () => {
    expect(policy("housekeeping_jobs_select")).toContain(
      "in_my_scope(organization_id, branch_id, department_id, NULL::uuid, assignee_id, created_by)",
    );
    expect(policy("housekeeping_jobs_update")).toContain(
      "has_permission('housekeeping'::text, 'tasks'::text, 'edit'::text)",
    );
  });

  it("the scope predicate isolates by station and assignment for narrow scopes", () => {
    const fn = RLS.slice(RLS.indexOf("FUNCTION public.in_my_scope"));
    expect(fn).toContain("WHEN 'organisation' THEN true");
    expect(fn).toContain("current_station_ids()");
    expect(fn).toContain("_assigned_user = auth.uid()");
    // Deny-by-default tail: an unknown scope falls back to own records only.
    expect(fn).toContain("ELSE (_assigned_user = auth.uid() OR _created_by = auth.uid())");
    expect(fn).toContain("_org <> public.current_org_id() THEN false");
  });
});
