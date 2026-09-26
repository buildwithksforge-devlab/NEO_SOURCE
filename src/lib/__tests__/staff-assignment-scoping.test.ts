import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RETIRED_ROLE_KEYS,
  departmentCatalogueKey,
  departmentsForBranch,
  isDepartmentValidForBranch,
  pruneRoleIds,
  roleDepartmentKey,
  rolesForDepartment,
  type CatalogueScope,
  type ScopedDepartment,
  type ScopedRole,
} from "@/lib/role-scoping";

/**
 * Staff assignment must obey the canonical property → department → role chain.
 * Departments are property-scoped, roles belong to a department by canonical
 * relationship (never by name), and nothing stale survives a change of either.
 */
const BRANCH_A = "branch-a";
const BRANCH_B = "branch-b";

const departments: ScopedDepartment[] = [
  { id: "hk-a", name: "Housekeeping", branch_id: BRANCH_A, catalogue_key: "housekeeping" },
  { id: "hk-b", name: "Housekeeping", branch_id: BRANCH_B, catalogue_key: "housekeeping" },
  { id: "fo-a", name: "Front Office", branch_id: BRANCH_A, catalogue_key: "front-office" },
  { id: "exec", name: "Executive Management", branch_id: null, catalogue_key: "executive-management" },
  { id: "closed", name: "Closed", branch_id: BRANCH_A, catalogue_key: "bar", active: false },
];

const catalogue: CatalogueScope[] = [
  { role_key: "owner", department: "Executive", access_scope: "organisation" },
  { role_key: "it-system-administrator", department: "IT and Systems", access_scope: "technical" },
  { role_key: "housekeeper", department: "Housekeeping", access_scope: "self" },
  { role_key: "receptionist", department: "Front Office", access_scope: "self" },
  { role_key: "night-auditor", department: "Front Office", access_scope: "team", retired: true },
];

const roles: ScopedRole[] = [
  { id: "r-owner", name: "Owner", access_scope: "organisation", department_id: "exec", normalized_role_key: "owner" },
  {
    id: "r-sysadmin",
    name: "IT/System Administrator",
    access_scope: "technical",
    department_id: null,
    normalized_role_key: "it-system-administrator",
  },
  // Housekeeper's role row points at the *other* property's department: the
  // canonical key must still match, so the role is offered in both properties.
  { id: "r-hk", name: "Housekeeper", access_scope: "self", department_id: "hk-b", normalized_role_key: "housekeeper" },
  { id: "r-recep", name: "Receptionist", access_scope: "self", department_id: "fo-a", normalized_role_key: "receptionist" },
  // No canonical department relationship at all (bespoke tenant role).
  { id: "r-custom", name: "Special Projects", access_scope: null, department_id: null, normalized_role_key: null },
  {
    id: "r-night",
    name: "Night Auditor",
    access_scope: "team",
    department_id: "fo-a",
    normalized_role_key: "night-auditor",
  },
];

describe("branch-aware department dropdown", () => {
  it("offers only the selected property's departments plus organisation-wide ones", () => {
    const visible = departmentsForBranch(departments, BRANCH_A).map((d) => d.id);
    expect(visible).toEqual(["hk-a", "fo-a", "exec"]);
    expect(visible).not.toContain("hk-b");
  });

  it("never shows duplicate departments from another property", () => {
    const names = departmentsForBranch(departments, BRANCH_B).map((d) => d.name);
    expect(names.filter((n) => n === "Housekeeping")).toHaveLength(1);
  });

  it("detects a department that a property change invalidates", () => {
    expect(isDepartmentValidForBranch(departments, BRANCH_A, "hk-a")).toBe(true);
    expect(isDepartmentValidForBranch(departments, BRANCH_B, "hk-a")).toBe(false);
    expect(isDepartmentValidForBranch(departments, BRANCH_B, "exec")).toBe(true);
  });
});

describe("department-aware roles", () => {
  it("shows only roles of the selected department plus organisation-wide roles", () => {
    const ids = rolesForDepartment(roles, departments, "hk-a", catalogue).map((r) => r.id);
    expect(ids).toContain("r-hk");
    expect(ids).toContain("r-owner");
    expect(ids).toContain("r-sysadmin");
    expect(ids).not.toContain("r-recep");
  });

  it("does not dump every role when no department is selected", () => {
    const ids = rolesForDepartment(roles, departments, null, catalogue).map((r) => r.id);
    expect(ids).toEqual(["r-owner", "r-sysadmin"]);
  });

  it("resolves the role's department canonically, not by property id or name", () => {
    expect(roleDepartmentKey(roles[2]!, departments, catalogue)).toBe("housekeeping");
    expect(roleDepartmentKey(roles[1]!, departments, catalogue)).toBe("it-and-systems");
  });

  it("maps catalogue department labels without guessing ambiguous ones", () => {
    expect(departmentCatalogueKey("Kitchen")).toBe("main-kitchen");
    expect(departmentCatalogueKey("Food & Beverage")).toBe("food-and-beverage");
    expect(departmentCatalogueKey("Supply Chain")).toBeNull();
  });

  it("clears role selections that the new department no longer permits", () => {
    const kept = pruneRoleIds(["r-hk", "r-owner", "r-custom"], roles, departments, "fo-a", catalogue);
    expect(kept).toEqual(["r-owner", "r-custom"]);
  });
});

/**
 * Real tenants create their own departments, which carry no canonical
 * `catalogue_key`. The role's own `department_id` relationship must still
 * decide — otherwise every role in the workspace is offered in every
 * department, which is exactly the defect this guards against.
 */
describe("tenant departments without a canonical key", () => {
  const tenantDepartments: ScopedDepartment[] = [
    { id: "d-finance", name: "Finance", branch_id: BRANCH_A, catalogue_key: null },
    { id: "d-kitchen", name: "Main Kitchen", branch_id: BRANCH_A, catalogue_key: null },
    { id: "d-fnb", name: "Food & Beverage", branch_id: BRANCH_A, catalogue_key: null },
    { id: "d-restaurant", name: "Restaurant", branch_id: BRANCH_A, catalogue_key: null },
    { id: "d-grounds", name: "Grounds & Landscaping", branch_id: BRANCH_A, catalogue_key: null },
  ];
  const tenantRoles: ScopedRole[] = [
    { id: "t-cashier", name: "Cashier", access_scope: null, department_id: "d-finance", normalized_role_key: null },
    { id: "t-chef", name: "Head Chef", access_scope: null, department_id: "d-kitchen", normalized_role_key: null },
    { id: "t-barista", name: "Barista", access_scope: null, department_id: "d-fnb", normalized_role_key: null },
    {
      id: "t-coffee",
      name: "Coffee Station Supervisor",
      access_scope: null,
      department_id: "d-fnb",
      normalized_role_key: null,
    },
    { id: "t-waiter", name: "Waiter", access_scope: null, department_id: "d-restaurant", normalized_role_key: null },
    { id: "t-owner", name: "Owner", access_scope: "organisation", department_id: null, normalized_role_key: "owner" },
  ];
  const ids = (dept: string | null) =>
    rolesForDepartment(tenantRoles, tenantDepartments, dept, []).map((r) => r.id);

  it("offers only that department's roles, never the whole catalogue", () => {
    expect(ids("d-finance").sort()).toEqual(["t-cashier", "t-owner"]);
    expect(ids("d-kitchen").sort()).toEqual(["t-chef", "t-owner"]);
    expect(ids("d-restaurant").sort()).toEqual(["t-owner", "t-waiter"]);
  });

  it("treats Coffee Station as a Food & Beverage outlet, not a department", () => {
    expect(ids("d-fnb").sort()).toEqual(["t-barista", "t-coffee", "t-owner"]);
    expect(tenantDepartments.map((d) => d.name)).not.toContain("Coffee Station");
  });

  it("offers nothing but organisation-wide roles for a department with no roles", () => {
    expect(ids("d-grounds")).toEqual(["t-owner"]);
  });

  it("clears an incompatible role when the department changes", () => {
    expect(pruneRoleIds(["t-cashier", "t-owner"], tenantRoles, tenantDepartments, "d-kitchen", [])).toEqual([
      "t-owner",
    ]);
  });
});

describe("Night Auditor retirement", () => {
  it("is never offered for assignment", () => {
    for (const dept of ["fo-a", "hk-a", null]) {
      expect(rolesForDepartment(roles, departments, dept, catalogue).map((r) => r.id)).not.toContain(
        "r-night",
      );
    }
  });

  it("keeps only non-assignable roles retired from the interface role model", () => {
    expect(RETIRED_ROLE_KEYS.has("night-auditor")).toBe(true);
    expect(RETIRED_ROLE_KEYS.has("porter")).toBe(true);
    for (const file of [
      "src/lib/role-aliases.ts",
      "src/lib/role-templates.ts",
      "src/lib/workspace-preview.ts",
    ]) {
      expect(readFileSync(file, "utf8")).not.toContain("night-auditor");
    }
  });
});

describe("server-side enforcement", () => {
  const source = readFileSync("src/lib/users.functions.ts", "utf8");

  it("re-checks role/department validity in the database for create and edit", () => {
    expect(source).toContain("neo_validate_role_assignment");
    for (const fn of ["createStaffUser", "updateStaffAssignment"]) {
      const block = source.slice(source.indexOf(`export const ${fn}`)).slice(0, 2000);
      expect(block).toContain("requireValidAssignment(");
    }
  });

  it("never authorises the assignment by role name", () => {
    expect(source).not.toMatch(/role\.name\s*===|name === "Housekeeper"/);
  });
});
