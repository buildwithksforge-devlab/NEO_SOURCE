import { describe, expect, it } from "vitest";
import { moduleFeatures } from "@/lib/capabilities";
import { canAccessPath, type CanFn } from "@/lib/nav-permissions";
import { addGrant } from "@/lib/permissions";
import {
  ROLE_ACCESS_SCOPES,
  ROLE_FEATURE_TEMPLATES,
  UNIVERSAL_VIEW_FEATURES,
  actionsForScope,
  compileRoleTemplate,
} from "@/lib/role-templates";

/**
 * Department isolation.
 *
 * The access matrix suite proves a role can reach what it was granted. This
 * suite proves the opposite half of the contract: a role can NOT reach another
 * department's work, no role outside the delivery line can dispatch, and
 * self-scoped roles never hold authority actions anywhere.
 */

const FEATURES = moduleFeatures();

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

/**
 * Strict checker: exact feature grants only. The legacy module-level shortcut
 * (`module:action`) is deliberately ignored here, because department isolation
 * is a statement about individual features, not whole modules.
 */
function strictCanForRole(roleKey: string): CanFn {
  const grants = compileRoleTemplate(roleKey, FEATURES);
  return (module, featureOrAction, action) => {
    if (action === undefined) return false;
    return grants.some(
      (g) => g.module === module && (g.feature === featureOrAction || g.feature === "*") && g.action === action,
    );
  };
}

const roleKeys = Object.keys(ROLE_FEATURE_TEMPLATES);

/** Modules each role's template names — everything else must be denied. */
function templatedModules(roleKey: string): Set<string> {
  const mods = new Set<string>();
  for (const entry of ROLE_FEATURE_TEMPLATES[roleKey] ?? []) mods.add(entry.slice(0, entry.indexOf(".")));
  for (const entry of UNIVERSAL_VIEW_FEATURES) mods.add(entry.slice(0, entry.indexOf(".")));
  return mods;
}

const AUTHORITY_ACTIONS = ["approve", "reject", "delete", "override", "refund", "void"];

describe("department isolation — deny by default", () => {
  it.each(roleKeys)("%s cannot view any module outside its template", (roleKey) => {
    const can = canForRole(roleKey);
    const allowed = templatedModules(roleKey);
    const foreign = Object.keys(FEATURES).filter((m) => !allowed.has(m));
    for (const module of foreign) {
      for (const feature of FEATURES[module] ?? []) {
        expect(can(module, feature, "view"), `${roleKey} must not view ${module}.${feature}`).toBe(false);
      }
    }
  });

  it.each(roleKeys.filter((r) => (ROLE_ACCESS_SCOPES[r] ?? "self") === "self"))(
    "%s is self-scoped and holds no authority actions",
    (roleKey) => {
      const can = canForRole(roleKey);
      const actions = actionsForScope("self");
      for (const authority of AUTHORITY_ACTIONS) {
        expect(actions).not.toContain(authority);
      }
      for (const module of Object.keys(FEATURES)) {
        for (const feature of FEATURES[module] ?? []) {
          for (const authority of AUTHORITY_ACTIONS) {
            expect(can(module, feature, authority), `${roleKey} must not ${authority} ${module}.${feature}`).toBe(
              false,
            );
          }
        }
      }
    },
  );
});

describe("delivery dispatch authority is confined to the delivery line", () => {
  const dispatchRoles = roleKeys.filter((r) => templatedModules(r).has("delivery"));

  it("only roles templated into delivery reach the delivery workspace", () => {
    for (const roleKey of roleKeys) {
      const can = canForRole(roleKey);
      const reachable = canAccessPath(can, "/delivery");
      expect(reachable, `${roleKey} reachability of /delivery`).toBe(dispatchRoles.includes(roleKey));
    }
  });

  it("riders never hold roster or dispatch authority over other riders", () => {
    const can = canForRole("rider");
    expect(can("delivery", "overview", "approve")).toBe(false);
    expect(can("delivery", "overview", "delete")).toBe(false);
    expect(can("human-resources", "staff", "view")).toBe(false);
  });

  it("the delivery manager holds delivery authority but not finance or HR", () => {
    const can = canForRole("delivery-manager");
    expect(can("delivery", "overview", "view")).toBe(true);
    expect(can("delivery", "overview", "approve")).toBe(true);
    expect(can("finance", "ledger", "view")).toBe(false);
    expect(can("human-resources", "staff", "view")).toBe(false);
  });
});

describe("kitchen and stores stay in their own departments", () => {
  it("kitchen roles cannot touch procurement authority", () => {
    for (const roleKey of ["head-chef", "hot-kitchen-chef", "pastry-chef"].filter((r) => ROLE_FEATURE_TEMPLATES[r])) {
      const can = strictCanForRole(roleKey);
      expect(can("procurement", "lpos", "approve"), `${roleKey} approving LPOs`).toBe(false);
    }
  });

  it("procurement and stores roles cannot run the kitchen queue", () => {
    for (const roleKey of ["procurement-officer", "storekeeper", "receiving-clerk"].filter(
      (r) => ROLE_FEATURE_TEMPLATES[r],
    )) {
      const can = strictCanForRole(roleKey);
      expect(can("kitchen", "queue", "edit"), `${roleKey} editing kitchen queue`).toBe(false);
    }
  });
});
