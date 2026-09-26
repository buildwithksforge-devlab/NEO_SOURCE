import { describe, expect, it } from "vitest";
import { navigation } from "@/lib/navigation";
import { capabilityForPath, moduleFeatures } from "@/lib/capabilities";
import { canAccessPath, navigationForAccess, STAFF_HIDDEN_GROUPS, type CanFn } from "@/lib/nav-permissions";
import { addGrant, canFromPermissions } from "@/lib/permissions";
import { compileRoleTemplate } from "@/lib/role-templates";
import { SETTINGS_CATEGORIES, entryCapability } from "@/lib/settings-catalogue";

/**
 * Configuration and administration access regressions.
 *
 * These prove the two defects the configuration cleanup closed stay closed: a
 * single feature grant must never unlock its whole module, and Operations
 * Management must never regain system administration.
 */

const FEATURES = moduleFeatures();

function canForGrants(grants: { module: string; feature: string; action: string }[]): CanFn {
  const set = new Set<string>();
  for (const g of grants) addGrant(set, g.module, g.feature, g.action);
  return canFromPermissions(set) as CanFn;
}

function canForRole(roleKey: string): CanFn {
  return canForGrants(compileRoleTemplate(roleKey, FEATURES));
}

describe("feature grants do not leak across a module", () => {
  const can = canForGrants([{ module: "administration", feature: "users", action: "view" }]);

  it("allows exactly the granted feature", () => {
    expect(can("administration", "users", "view")).toBe(true);
    expect(canAccessPath(can, "/users")).toBe(true);
  });

  it.each(["/roles", "/departments", "/stations", "/settings", "/audit-logs", "/admin/access-matrix", "/admin/branches", "/admin/payments-mpesa"])(
    "refuses direct access to %s",
    (path) => {
      expect(canAccessPath(can, path)).toBe(false);
    },
  );

  it("does not satisfy a bare module:action check", () => {
    expect(can("administration", "view")).toBe(false);
  });

  it("hides the unrelated pages from navigation", () => {
    const links = navigationForAccess(can, true, true).flatMap((g) => g.items.map((i) => i.to));
    for (const path of ["/roles", "/departments", "/stations", "/settings"]) {
      expect(links).not.toContain(path);
    }
  });
});

describe("module-wide grants still work", () => {
  const can = canForGrants([{ module: "administration", feature: "*", action: "view" }]);
  it("satisfies both key shapes", () => {
    expect(can("administration", "view")).toBe(true);
    expect(can("administration", "departments", "view")).toBe(true);
  });
});

describe("Operations Manager", () => {
  const can = canForRole("operations-manager");
  const groups = navigationForAccess(can, false, true);

  it("has no Administration group", () => {
    expect(groups.map((g) => g.title)).not.toContain("Administration");
  });

  it("has no Platform & Readiness group", () => {
    expect(groups.map((g) => g.title).filter((t) => /platform/i.test(t))).toEqual([]);
  });

  it.each(["/users", "/roles", "/departments", "/stations", "/settings", "/audit-logs", "/admin/branches"])(
    "cannot open %s directly",
    (path) => {
      expect(canAccessPath(can, path)).toBe(false);
    },
  );

  it("keeps its operational access", () => {
    expect(canAccessPath(can, "/pms")).toBe(true);
    expect(canAccessPath(can, "/pos")).toBe(true);
  });
});

describe("Owner and IT System Administrator keep configuration authority", () => {
  it("owner can open every configuration entry", () => {
    const can = canForRole("owner");
    for (const category of SETTINGS_CATEGORIES) {
      for (const entry of category.entries) {
        if (!entry.to) continue;
        expect(canAccessPath(can, entry.to), `owner → ${entry.to}`).toBe(true);
      }
    }
  });

  it("IT System Administrator keeps every administration, integration and platform surface", () => {
    const can = canForRole("it-system-administrator");
    for (const category of SETTINGS_CATEGORIES) {
      for (const entry of category.entries) {
        const cap = entry.to ? capabilityForPath(entry.to) : null;
        if (!cap || !["administration", "integrations", "platform"].includes(cap.module)) continue;
        expect(canAccessPath(can, entry.to!), `it-system-administrator → ${entry.to}`).toBe(true);
      }
    }
  });
});


describe("configuration routes are capability-gated", () => {
  it("every catalogue entry resolves a capability", () => {
    for (const category of SETTINGS_CATEGORIES) {
      for (const entry of category.entries) {
        if (!entry.to) continue;
        expect(entryCapability(entry), `${entry.to} has no capability`).not.toBeNull();
      }
    }
  });

  it("admin configuration pages are not covered by one blanket key", () => {
    const branding = capabilityForPath("/admin/brand-identity");
    const payments = capabilityForPath("/admin/payments-mpesa");
    const roles = capabilityForPath("/admin/access-matrix");
    expect(branding).not.toEqual(payments);
    expect(branding).not.toEqual(roles);
    expect(payments).not.toEqual(roles);
  });

  it("navigation never offers a path without a resolvable capability", () => {
    for (const group of navigation.filter((g) => !STAFF_HIDDEN_GROUPS.has(g.title))) {
      for (const item of group.items) {
        expect(typeof item.to).toBe("string");
      }
    }
  });
});
