import { describe, expect, it } from "vitest";
import { navigation } from "@/lib/navigation";
import { ROUTE_CAPABILITIES, capabilityForPath, moduleFeatures } from "@/lib/capabilities";
import { STAFF_HIDDEN_GROUPS, canAccessPath, navigationForAccess, type CanFn } from "@/lib/nav-permissions";
import { addGrant } from "@/lib/permissions";
import {
  ROLE_ACCESS_SCOPES,
  ROLE_FEATURE_TEMPLATES,
  actionsForScope,
  compileRoleTemplate,
} from "@/lib/role-templates";

/**
 * Named production UAT matrix.
 *
 * The exhaustive machine-generated matrix lives in `role-access-matrix.test.ts`.
 * This suite pins the specific, human-stated certification claims for the roles
 * the business signs off on, so a future template edit that quietly re-opens
 * Administration to an Operations Manager — or lets a waiter see another
 * waiter's records — fails by name rather than in an anonymous loop.
 */

const FEATURES = moduleFeatures();

/** Business role name -> catalogue key actually shipped in the templates. */
const UAT_ROLES: Record<string, string> = {
  Owner: "owner",
  "Operations Manager": "operations-manager",
  "IT / System Administrator": "it-system-administrator",
  "Finance Manager": "finance-manager",
  Accountant: "accountant",
  "Procurement Manager": "procurement-manager",
  Stores: "storekeeper",
  "Front Office Supervisor": "front-office-supervisor",
  Receptionist: "receptionist",
  "Housekeeping Supervisor": "housekeeping-supervisor",
  Housekeeper: "housekeeper",
  "F&B / Restaurant Manager": "food-and-beverage-manager",
  Waiter: "waiter",
  Barista: "barista",
  "Head Chef": "head-chef",
  "Events Manager": "sales-and-events-manager",
  "Delivery Manager": "delivery-manager",
  "Rider / Driver": "rider",
  "HR Manager": "human-resources-manager",
  "Maintenance Manager": "maintenance-manager",
  "Maintenance Technician": "maintenance-technician",
};

function canForRole(roleKey: string): CanFn {
  const set = new Set<string>();
  for (const g of compileRoleTemplate(roleKey, FEATURES)) addGrant(set, g.module, g.feature, g.action);
  return (module, actionOrFeature, action) => {
    if (action === undefined) {
      return set.has(`${module}:${actionOrFeature}`) || set.has(`${module}.*.${actionOrFeature}`);
    }
    return (
      set.has(`${module}.${actionOrFeature}.${action}`) ||
      set.has(`${module}.*.${action}`) ||
      set.has(`${module}:${action}`)
    );
  };
}

function grantsFor(roleKey: string) {
  return compileRoleTemplate(roleKey, FEATURES);
}

function sidebarGroups(roleKey: string) {
  return navigationForAccess(canForRole(roleKey), false, true).map((g) => g.title);
}

function reachablePaths(roleKey: string) {
  const can = canForRole(roleKey);
  return [...new Set(ROUTE_CAPABILITIES.map((e) => e.prefix))].filter((p) => canAccessPath(can, p));
}

describe("UAT — every certified role exists and is scoped", () => {
  it.each(Object.entries(UAT_ROLES))("%s resolves to a shipped template", (_name, key) => {
    expect(ROLE_FEATURE_TEMPLATES[key], `no template for ${key}`).toBeTruthy();
    expect(ROLE_ACCESS_SCOPES[key], `no access scope for ${key}`).toBeTruthy();
    expect(grantsFor(key).length).toBeGreaterThan(0);
  });
});

describe("UAT — administration stays with the owner and the system administrator", () => {
  const ADMIN_GROUPS = ["Administration", "Platform & Readiness"];

  it("Operations Manager has no Administration and no Platform & Readiness", () => {
    const groups = sidebarGroups("operations-manager");
    for (const g of ADMIN_GROUPS) expect(groups, `operations-manager kept ${g}`).not.toContain(g);
    const admin = grantsFor("operations-manager").filter((g) => g.module === "administration");
    expect(admin, "operations-manager holds administration grants").toHaveLength(0);
  });

  it("the Configuration Centre is reachable only by the owner and the system administrator", () => {
    const allowed = new Set(["owner", "it-system-administrator"]);
    for (const [name, key] of Object.entries(UAT_ROLES)) {
      const can = canForRole(key);
      expect(canAccessPath(can, "/settings"), `${name} at /settings`).toBe(allowed.has(key));
    }
  });

  it("no line or operational role reaches the platform readiness surfaces", () => {
    // HR keeps `administration.users`/`administration.departments` by design —
    // it provisions workers — so it is exempted here, not silently passing.
    const EXEMPT = new Set(["owner", "it-system-administrator", "human-resources-manager"]);
    const groupTitles = new Set(ADMIN_GROUPS);
    const adminPaths = navigation
      .filter((g) => groupTitles.has(g.title) && !STAFF_HIDDEN_GROUPS.has(g.title))
      .flatMap((g) => g.items.map((i) => i.to));
    for (const [name, key] of Object.entries(UAT_ROLES)) {
      if (EXEMPT.has(key)) continue;
      const can = canForRole(key);
      for (const path of adminPaths) {
        const cap = capabilityForPath(path);
        if (cap === null) continue;
        expect(canAccessPath(can, path), `${name} reached ${path}`).toBe(false);
      }
    }
  });
});

describe("UAT — record scope separates peers on the same job", () => {
  it("Waiter A cannot read Waiter B: waiters run at self record scope", () => {
    // Capability `restaurant.orders.view` opens the page; which rows load is
    // decided by `public.in_my_scope(...)`, whose 'self' branch resolves to
    // `_assigned_user = auth.uid() OR _created_by = auth.uid()`. Both waiters
    // reach the same screen and never each other's tickets.
    expect(ROLE_ACCESS_SCOPES["waiter"]).toBe("self");
    expect(ROLE_ACCESS_SCOPES["barista"]).toBe("self");
    const actions = new Set(actionsForScope("self"));
    for (const restricted of ["delete", "approve", "void", "refund", "override", "export"]) {
      expect(actions.has(restricted), `self scope grants ${restricted}`).toBe(false);
    }
    const orders = grantsFor("waiter").filter((g) => g.module === "restaurant" && g.feature === "orders");
    expect(orders.map((g) => g.action).sort()).toEqual(["create", "edit", "view"]);
  });

  it("a Rider only reaches rider-scoped work", () => {
    expect(ROLE_ACCESS_SCOPES["rider"]).toBe("self");
    for (const path of reachablePaths("rider")) {
      expect(["delivery", "ai"], `rider reached ${path}`).toContain(capabilityForPath(path)?.module);
    }
    const can = canForRole("rider");
    expect(can("delivery", "dispatch", "assign"), "rider can dispatch to others").toBe(false);
    expect(can("delivery", "orders", "view"), "rider reads every order").toBe(false);
  });

  it("a Housekeeper is narrower than a Housekeeping Supervisor", () => {
    const attendant = new Set(reachablePaths("housekeeper"));
    const supervisor = new Set(reachablePaths("housekeeping-supervisor"));
    expect(attendant.size).toBeLessThan(supervisor.size);
    for (const p of attendant) expect(supervisor.has(p), `supervisor missing ${p}`).toBe(true);
    expect(ROLE_ACCESS_SCOPES["housekeeper"]).toBe("self");
    expect(ROLE_ACCESS_SCOPES["housekeeping-supervisor"]).toBe("department");
  });

  it("a Receptionist is narrower than a Front Office Supervisor", () => {
    const agent = new Set(reachablePaths("receptionist"));
    const supervisor = new Set(reachablePaths("front-office-supervisor"));
    expect(agent.size).toBeLessThan(supervisor.size);
    for (const p of agent) expect(supervisor.has(p), `FO supervisor missing ${p}`).toBe(true);
  });
});

describe("UAT — restricted authority cannot be self-granted", () => {
  const RESTRICTED = new Set(["approve", "void", "refund", "override", "delete"]);

  it("line and team roles hold no restricted action at all", () => {
    for (const [name, key] of Object.entries(UAT_ROLES)) {
      const scope = ROLE_ACCESS_SCOPES[key]!;
      if (scope === "organisation" || scope === "branch" || scope === "department") continue;
      const leaked = grantsFor(key).filter((g) => RESTRICTED.has(g.action));
      expect(leaked.map((g) => `${g.module}.${g.feature}.${g.action}`), `${name} holds restricted authority`).toEqual([]);
    }
  });

  it("a waiter can raise an order but never void or discount it", () => {
    const can = canForRole("waiter");
    expect(can("restaurant", "orders", "create")).toBe(true);
    expect(can("restaurant", "orders", "void")).toBe(false);
    expect(can("restaurant", "orders", "discount")).toBe(false);
  });

  it("guest financial history stays out of kitchen, housekeeping and delivery hands", () => {
    for (const key of ["head-chef", "housekeeper", "rider", "waiter", "barista", "maintenance-technician"]) {
      const can = canForRole(key);
      expect(can("front-office", "folios", "view"), `${key} reads guest folios`).toBe(false);
      expect(can("finance-gl", "*", "view"), `${key} reads the general ledger`).toBe(false);
      expect(can("human-resources", "employees", "view"), `${key} reads the HR directory`).toBe(false);
    }
  });
});
