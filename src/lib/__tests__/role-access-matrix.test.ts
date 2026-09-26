import { describe, expect, it } from "vitest";
import { navigation } from "@/lib/navigation";
import {
  ROUTE_CAPABILITIES,
  capabilityForPath,
  moduleFeatures,
  pathPermitted,
  type Capability,
} from "@/lib/capabilities";
import {
  STAFF_HIDDEN_GROUPS,
  canAccessPath,
  navItemVisible,
  navigationForAccess,
  type CanFn,
} from "@/lib/nav-permissions";
import { addGrant } from "@/lib/permissions";
import {
  ROLE_ACCESS_SCOPES,
  ROLE_FEATURE_TEMPLATES,
  compileRoleTemplate,
} from "@/lib/role-templates";

/**
 * Exhaustive role-access matrix.
 *
 * Every catalogue role is compiled from its feature template exactly the way
 * `public.neo_apply_feature_templates()` compiles it in the database, then
 * every navigable path is checked against both the sidebar and the route
 * guard. A disagreement anywhere — a visible link the guard refuses, a granted
 * page the sidebar hides, or a link into a module the role was never given —
 * fails the suite.
 */

const FEATURES = moduleFeatures();
const roleKeys = Object.keys(ROLE_FEATURE_TEMPLATES);
// The staff workspace never renders guest-portal navigation, so it is not
// part of the staff access matrix.
const allNavPaths = [
  ...new Set(
    navigation
      .filter((g) => !STAFF_HIDDEN_GROUPS.has(g.title))
      .flatMap((g) => g.items.map((i) => i.to)),
  ),
];
const allRoutePaths = [...new Set(ROUTE_CAPABILITIES.map((e) => e.prefix))];

function canForRole(roleKey: string): CanFn {
  const set = new Set<string>();
  for (const g of compileRoleTemplate(roleKey, FEATURES)) {
    addGrant(set, g.module, g.feature, g.action);
  }
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

function holds(can: CanFn, cap: Capability) {
  return can(cap.module, cap.feature, cap.action);
}

describe("role catalogue compiles into feature-level capabilities", () => {
  it("gives every catalogue role a template and an access scope", () => {
    for (const key of roleKeys) {
      expect(ROLE_FEATURE_TEMPLATES[key]!.length, `empty template: ${key}`).toBeGreaterThan(0);
      expect(ROLE_ACCESS_SCOPES[key], `missing access scope: ${key}`).toBeTruthy();
    }
  });

  it("never templates a feature the interface does not have", () => {
    for (const key of roleKeys) {
      for (const entry of ROLE_FEATURE_TEMPLATES[key]!) {
        const dot = entry.indexOf(".");
        const module = entry.slice(0, dot);
        const feature = entry.slice(dot + 1);
        expect(FEATURES[module], `unknown module in ${key}: ${entry}`).toBeTruthy();
        if (feature !== "*") {
          expect(FEATURES[module], `unknown feature in ${key}: ${entry}`).toContain(feature);
        }
      }
    }
  });

  // Approval authority is granted deliberately per role; it is never implied by
  // how much data a role can see. What the catalogue does guarantee is the floor:
  // a role that only sees its own team or its own records never approves.
  it("never gives approval authority to a team or self scoped role", () => {
    for (const key of roleKeys) {
      const scope = ROLE_ACCESS_SCOPES[key]!;
      if (!["team", "self"].includes(scope)) continue;
      const canApprove = compileRoleTemplate(key, FEATURES).some((g) => g.action === "approve");
      expect(canApprove, `approval authority leaked to ${key} (${scope} scope)`).toBe(false);
    }
  });

  it("keeps destructive authority (delete, void, refund, override) to the owner scope", () => {
    const destructive = new Set(["delete", "void", "refund", "override"]);
    for (const key of roleKeys) {
      if (ROLE_ACCESS_SCOPES[key] === "organisation") continue;
      const leaked = compileRoleTemplate(key, FEATURES).filter((g) => destructive.has(g.action));
      expect(leaked, `destructive authority leaked to ${key}`).toHaveLength(0);
    }
  });
});

describe("navigation, route guards and grants agree for every role", () => {
  it.each(roleKeys)("%s sees exactly the pages its capabilities allow", (roleKey) => {
    const can = canForRole(roleKey);
    const shown = new Set(
      navigationForAccess(can, false, true).flatMap((g) => g.items.map((i) => i.to)),
    );

    for (const path of allNavPaths) {
      // The sidebar answer is capability plus surface ownership: a
      // participation grant in a neighbouring module opens its page but does
      // not put that whole workspace in this role's primary navigation.
      const allowed = navItemVisible(can, path);
      expect(shown.has(path), `${roleKey}: ${allowed ? "granted page hidden" : "link leaked"} — ${path}`).toBe(
        allowed,
      );
      // The guard must reach the same verdict as the sidebar, so typing the URL
      // is never a way past a hidden link.
      expect(
        canAccessPath(can, path),
        `${roleKey}: guard refuses a page the capability allows — ${path}`,
      ).toBe(pathPermitted(can, path));
    }
  });

  it.each(roleKeys)("%s cannot reach a registered route outside its grants", (roleKey) => {
    const can = canForRole(roleKey);
    for (const path of allRoutePaths) {
      const cap = capabilityForPath(path);
      if (cap === null) continue;
      if (!pathPermitted(can, path)) {
        expect(canAccessPath(can, path), `${roleKey}: route reachable without a grant — ${path}`).toBe(
          false,
        );
      }
    }
  });

  it("gives the owner every registered route and a line role almost none", () => {
    const owner = canForRole("owner");
    for (const path of allRoutePaths) {
      expect(canAccessPath(owner, path), `owner blocked from ${path}`).toBe(true);
    }
    const rider = canForRole("rider");
    const reachable = allRoutePaths.filter((p) => canAccessPath(rider, p));
    for (const path of reachable) {
      // NEØ Intelligence is universal entry; its data stays scope-filtered.
      expect(["delivery", "ai"], `rider reached ${path}`).toContain(
        capabilityForPath(path)?.module,
      );
    }
  });

  it("holds no capability at all before permissions have loaded", () => {
    const generous = canForRole("owner");
    const shown = navigationForAccess(generous, true, false).flatMap((g) =>
      g.items.map((i) => i.to),
    );
    for (const path of shown) expect(capabilityForPath(path)).toBeNull();
  });

  it("offers no administrator shortcut around the registry", () => {
    const none = canForRole("__nobody__");
    const asAdmin = navigationForAccess(none, true, true).flatMap((g) => g.items.map((i) => i.to));
    const asMember = navigationForAccess(none, false, true).flatMap((g) => g.items.map((i) => i.to));
    expect(asAdmin).toEqual(asMember);
    for (const path of asAdmin) expect(capabilityForPath(path)).toBeNull();
  });
});
