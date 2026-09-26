import { navigation, type NavGroup } from "./navigation";
import { capabilityForPath, pathPermitted, type Capability } from "./capabilities";

/**
 * Navigation authorization.
 *
 * Every navigable route resolves through the single capability registry in
 * `./capabilities`, so the sidebar, the tab strips and the route guard apply
 * one identical `module.feature.action` check. Grants are feature-level:
 * "Restaurant floor" no longer implies Orders, KDS, Reports or Settings.
 */
export function permissionCapabilityForPath(to: string): Capability | null {
  return capabilityForPath(to);
}

export function permissionModuleForPath(to: string): string | null {
  return capabilityForPath(to)?.module ?? null;
}

export function permissionFeatureForPath(to: string): string | null {
  return capabilityForPath(to)?.feature ?? null;
}

/** The action a path demands — "view" unless the route is a configuration screen. */
export function permissionActionForPath(to: string): string {
  return capabilityForPath(to)?.action ?? "view";
}

export type CanFn = (module: string, actionOrFeature: string, action?: string) => boolean;

/** One check, used by navigation, tabs and the route guard alike. */
export function canAccessPath(can: CanFn, to: string): boolean {
  return pathPermitted(can, to);
}

/**
 * Primary-sidebar surface gates.
 *
 * A route being technically reachable does not make it part of a role's daily
 * workspace. Neighbouring departments hand each other narrow participation
 * grants — a housekeeping manager may raise a stores requisition, report a
 * maintenance fault or read the room rack — and those grants must not drop an
 * entire foreign module into the sidebar. Each gate names the capability that
 * denotes *running* the module, evaluated with the same resolver; nothing here
 * grants or removes authority, and the route guard is untouched.
 */
type SurfaceGate = { prefixes: string[]; anyOf: Capability[] };

const cap = (module: string, feature: string, action: string): Capability => ({
  module,
  feature,
  action,
});

export const NAV_SURFACE_GATES: SurfaceGate[] = [
  {
    // Front Office / PMS workspace — owned by front-office staff, not by a
    // department that merely reads the rack or room availability.
    prefixes: ["/pms", "/front-office", "/reservations", "/rooms", "/guests", "/rates", "/credit-accounts"],
    // Reading a room rack or availability figure is participation; the desk
    // workspace belongs to whoever handles reservations, arrivals or folios.
    anyOf: [
      cap("front-office", "reservations", "view"),
      cap("front-office", "arrivals", "view"),
      cap("front-office", "in-house", "view"),
      cap("front-office", "folios", "view"),
    ],
  },
  {
    // Stores administration — raising or receiving a requisition is
    // participation; running the store requires store authoring authority.
    prefixes: ["/inventory"],
    anyOf: [cap("stores", "overview", "edit"), cap("stores", "items", "manage")],
  },
  {
    prefixes: ["/procurement", "/lpos"],
    anyOf: [cap("procurement", "overview", "view")],
  },
  {
    // Reporting a fault is participation; the maintenance module belongs to
    // whoever actually works the work orders.
    prefixes: ["/maintenance", "/assets"],
    anyOf: [
      cap("maintenance", "work-orders", "update"),
      cap("maintenance", "work-orders", "assign"),
      // A technician works the jobs handed to them: their personal work
      // surfaces are maintenance work, not fault reporting, so the gate must
      // let them in. Each item is still filtered by its own capability.
      cap("maintenance", "my-jobs", "view"),
      cap("maintenance", "my-tasks", "view"),
    ],
  },
];

/** Modules whose approval authority legitimately puts Approvals in the sidebar. */
const APPROVAL_MODULES = [
  "approvals",
  "housekeeping",
  "laundry",
  "maintenance",
  "stores",
  "procurement",
  "finance",
  "human-resources",
  "front-office",
  "restaurant",
  "kitchen",
  "administration",
  "events",
  "marketing",
];

/** Approvals is universal to *open*, but only reviewers keep it in the sidebar. */
export function hasApprovalAuthority(can: CanFn): boolean {
  return APPROVAL_MODULES.some((m) => can(m, "*", "approve") || can(m, "requests", "approve"));
}

function surfacePermitted(can: CanFn, to: string): boolean {
  if (to === "/approvals") return hasApprovalAuthority(can);
  for (const gate of NAV_SURFACE_GATES) {
    const matches = gate.prefixes.some((p) => to === p || to.startsWith(`${p}/`));
    if (!matches) continue;
    return gate.anyOf.some((c) => can(c.module, c.feature, c.action));
  }
  return true;
}

/** Sidebar visibility: permitted by capability *and* part of this role's workspace. */
export function navItemVisible(can: CanFn, to: string): boolean {
  return canAccessPath(can, to) && surfacePermitted(can, to);
}

/**
 * Filters navigation down to what the resolver actually permits. There is no
 * administrator shortcut: administrative authority is itself a granted
 * permission, so the sidebar always reflects the same effective access the
 * database enforces. While access is still hydrating, only universal pages show.
 */
export function filterNavigationByAccess(
  groups: NavGroup[],
  can: CanFn,
  _isAdmin: boolean,
  permissionsLoaded: boolean,
): NavGroup[] {
  if (!permissionsLoaded) return groups;
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => navItemVisible(can, item.to)),
    }))
    .filter((group) => group.items.length > 0);
}

/** The staff workspace never shows guest-facing portal navigation. */
export const STAFF_HIDDEN_GROUPS = new Set(["Customer Portal"]);

function staffGroups(groups: NavGroup[]): NavGroup[] {
  return groups.filter((group) => !STAFF_HIDDEN_GROUPS.has(group.title));
}

export function navigationForAccess(
  can: CanFn,
  isAdmin: boolean,
  permissionsLoaded: boolean,
): NavGroup[] {
  // Until the resolver answers, show only the pages every member may open,
  // so nothing unauthorized flashes and the shell still works.
  if (!permissionsLoaded) {
    return staffGroups(navigation)
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => capabilityForPath(item.to) === null),
      }))
      .filter((group) => group.items.length > 0);
  }
  return filterNavigationByAccess(staffGroups(navigation), can, isAdmin, true);
}
