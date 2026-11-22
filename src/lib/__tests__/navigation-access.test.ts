import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { navigation } from "@/lib/navigation";
import { capabilityForPath, isUniversalRoute, pathPermitted } from "@/lib/capabilities";
import {
  navigationForAccess,
  permissionActionForPath,
  permissionModuleForPath,
  type CanFn,
} from "@/lib/nav-permissions";
import { addGrant } from "@/lib/permissions";

/** Builds the same effective-grant set the signed-in session builds. */
function grantSet(grants: [string, string | null, string][]): Set<string> {
  const set = new Set<string>();
  for (const [module, feature, action] of grants) addGrant(set, module, feature, action);
  return set;
}

function canFor(set: Set<string>): CanFn {
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

const OPERATIONS_MANAGER: [string, string | null, string][] = [
  ["front-office", "*", "view"],
  ["housekeeping", "*", "view"],
  ["maintenance", "*", "view"],
  // Owning the maintenance workspace means working its jobs, not merely
  // reading them — the sidebar surface gate asks for that authority.
  ["maintenance", "work-orders", "update"],
  ["restaurant", "*", "view"],
  ["analytics", "*", "view"],
];

const allNavPaths = navigation.flatMap((g) => g.items.map((i) => i.to));

describe("sidebar navigation matches granted permissions exactly", () => {
  it("shows no link outside the granted modules", () => {
    const can = canFor(grantSet(OPERATIONS_MANAGER));
    const shown = navigationForAccess(can, false, true).flatMap((g) => g.items.map((i) => i.to));

    for (const path of shown) {
      const module = permissionModuleForPath(path);
      if (module === null) continue; // universal page
      expect(can(module, "view"), `cross-module link leaked: ${path}`).toBe(true);
    }
  });

  it("shows every link the grants do allow — nothing granted is hidden", () => {
    const can = canFor(grantSet(OPERATIONS_MANAGER));
    const shown = new Set(
      navigationForAccess(can, false, true).flatMap((g) => g.items.map((i) => i.to)),
    );
    const expected = allNavPaths.filter((p) => {
      const module = permissionModuleForPath(p);
      return module !== null && can(module, permissionActionForPath(p));
    });
    for (const path of expected) expect(shown.has(path), `granted page hidden: ${path}`).toBe(true);
  });

  it("grants nothing beyond universal pages when the user holds no permissions", () => {
    const can = canFor(new Set<string>());
    const shown = navigationForAccess(can, false, true).flatMap((g) => g.items.map((i) => i.to));
    for (const path of shown) expect(permissionModuleForPath(path)).toBeNull();
  });

  it("never grants access through an administrator shortcut", () => {
    const can = canFor(new Set<string>());
    const asAdmin = navigationForAccess(can, true, true).flatMap((g) => g.items.map((i) => i.to));
    const asMember = navigationForAccess(can, false, true).flatMap((g) => g.items.map((i) => i.to));
    expect(asAdmin).toEqual(asMember);
  });

  it("hides every module page while access is still hydrating (no stale authorization)", () => {
    const generous = canFor(grantSet(OPERATIONS_MANAGER));
    const shown = navigationForAccess(generous, true, false).flatMap((g) =>
      g.items.map((i) => i.to),
    );
    for (const path of shown) expect(permissionModuleForPath(path)).toBeNull();
  });
});

describe("route guards agree with the sidebar", () => {
  it("guards every navigable path with the same module check the sidebar uses", () => {
    const can = canFor(grantSet(OPERATIONS_MANAGER));
    const shown = new Set(
      navigationForAccess(can, false, true).flatMap((g) => g.items.map((i) => i.to)),
    );
    for (const path of allNavPaths) {
      const module = permissionModuleForPath(path);
      const guardAllows = module === null || can(module, permissionActionForPath(path));
      const sidebarShows = shown.has(path);
      if (!guardAllows) expect(sidebarShows, `guarded page still linked: ${path}`).toBe(false);
    }
  });

  it("requires more than view access on configuration and approval sub-routes", () => {
    expect(permissionActionForPath("/pos/settings")).toBe("edit");
    expect(permissionActionForPath("/pos/approvals")).toBe("approve");
    expect(permissionActionForPath("/pos")).toBe("view");
  });

  it("maps every navigable path to a known module or an explicit universal page", () => {
    const tree = readFileSync("src/routeTree.gen.ts", "utf8");
    const staffPaths = [...tree.matchAll(/'(\/_shell\/[^']+)': \{\s*id: '[^']+'\s*path: '[^']+'\s*fullPath: '([^']+)'/g)]
      .map((match) => match[2]!);
    expect(staffPaths.length).toBeGreaterThan(allNavPaths.length);
    const missing = [...new Set([...allNavPaths, ...staffPaths])]
      .filter((path) => !isUniversalRoute(path) && !capabilityForPath(path));
    expect(missing).toEqual([]);
  });

  it("resolves case variants and trailing slashes to their existing permission checks", () => {
    const settings = capabilityForPath("/pos/settings");
    expect(settings?.action).toBe("edit");
    expect(capabilityForPath("/PoS/SeTTings/")).toEqual(settings);
    expect(pathPermitted(() => false, "/PoS/SeTTings/")).toBe(false);
    expect(pathPermitted((module, feature, action) =>
      module === settings?.module && feature === settings.feature && action === settings.action,
    "/PoS/SeTTings/")).toBe(true);
    expect(pathPermitted((module, feature, action) =>
      module === "delivery" && feature === "orders" && action === "view-own",
    "/RIDER/PROFILE/")).toBe(true);
  });

  it("keeps explicit staff destinations open and refuses unknown paths", () => {
    expect(pathPermitted(() => false, "/Workspace?home=1")).toBe(true);
    expect(pathPermitted(() => false, "/profile")).toBe(true);
    expect(pathPermitted(() => false, "/dashboards/front-office")).toBe(true);
    expect(pathPermitted(() => true, "/dashboards-unknown")).toBe(false);
    expect(pathPermitted(() => true, "/dashboards/front-office/unknown")).toBe(false);
    expect(pathPermitted(() => true, "/new-unregistered-staff-route")).toBe(false);
  });
});

describe("navigation uniqueness", () => {
  it("never lists the same destination twice", () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const group of navigation) {
      for (const item of group.items) {
        const existing = seen.get(item.to);
        if (existing) duplicates.push(`${item.to} (in "${existing}" and "${group.title}")`);
        else seen.set(item.to, group.title);
      }
    }
    expect(duplicates).toEqual([]);
  });

  it("never lists the same label twice inside one group", () => {
    for (const group of navigation) {
      const labels = group.items.map((i) => i.label);
      expect(new Set(labels).size, `duplicate label in ${group.title}`).toBe(labels.length);
    }
  });
});
