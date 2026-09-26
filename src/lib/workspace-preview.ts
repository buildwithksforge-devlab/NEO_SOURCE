/**
 * Administration → Workspace Preview.
 *
 * Read-only simulation of another role's workspace for the Owner / System
 * Administrator. Nothing here changes the administrator's own role, profile,
 * assignments or permissions: the preview only *renders* what a role would see,
 * using the organisation's real configuration (roles, permissions, dashboards)
 * and the data the administrator is already allowed to read under RLS.
 */

import { navigation, type NavGroup } from "./navigation";
import { STAFF_HIDDEN_GROUPS, navItemVisible, permissionModuleForPath } from "./nav-permissions";
import { canFromPermissions } from "./permissions";
import { resolveCatalogueRoleKey } from "./role-aliases";

/** Roles the preview offers, in operational order. Must exist in public.roles. */
export const PREVIEW_ROLES = [
  "Owner",
  "General Manager",
  "IT/System Administrator",
  "Finance Manager",
  "Accountant",
  "Front Office Manager",
  "Receptionist",
  "Restaurant Manager",
  "Waiter / Waitress",
  "Barista",
  "Coffee Station Supervisor",
  "Bar Manager",
  "Bar Attendant",
  "Kitchen Manager",
  "Hot Kitchen Supervisor",
  "Chef",
  "Pastry Supervisor",
  "Pastry Chef",
  "Procurement Officer",
  "Storekeeper",
  "Housekeeping Supervisor",
  "Housekeeper",
  "Maintenance Officer",
  "Marketing Manager",
  "Events Manager",
  "Human Resources",
  "Delivery Manager",
  "Rider",
] as const;

export type PreviewRoleName = (typeof PREVIEW_ROLES)[number];

/** Department → station combinations covered by the preview. */
export const PREVIEW_COMBINATIONS: { department: string; station: string }[] = [
  { department: "Front Office", station: "Reception / Front Desk" },
  { department: "Restaurant", station: "Restaurant Floor" },
  { department: "Restaurant", station: "Coffee Station" },
  { department: "Bar", station: "Main Bar" },
  { department: "Kitchen", station: "Hot Kitchen" },
  { department: "Kitchen", station: "Pastry" },
  { department: "Housekeeping", station: "Housekeeping" },
  { department: "Procurement", station: "Procurement" },
  { department: "Inventory & Stores", station: "Main Store" },
  { department: "Finance", station: "Accounts" },
  { department: "Marketing", station: "Marketing" },
  { department: "Events", station: "Events" },
  { department: "Maintenance", station: "Maintenance" },
  { department: "Delivery", station: "Delivery" },
  { department: "Human Resources", station: "HR" },
  { department: "Administration", station: "Administration" },
];

/**
 * Dashboard resolved from the approved catalogue key first, so a role keeps
 * the same dashboard whether it is stored under its approved name or an
 * obvious variant of it (HR Manager, Waitress, Events Manager, ...).
 */
const DASHBOARD_BY_CATALOGUE_KEY: Record<string, string> = {
  owner: "owner",
  "it-system-administrator": "administration",
  "operations-manager": "general-manager",
  "finance-manager": "finance",
  accountant: "finance",
  cashier: "finance",
  "front-office-manager": "front-office",
  "front-office-supervisor": "front-office",
  receptionist: "front-office",
  "front-office-cashier": "front-office",
  "reservations-agent": "front-office",
  "food-and-beverage-manager": "restaurant-operations",
  "restaurant-manager": "restaurant-operations",
  waiter: "restaurant-floor",
  barista: "coffee-station",
  "coffee-station-supervisor": "coffee-station",
  "bar-manager": "bar",
  "bar-attendant": "bar",
  "head-chef": "kitchen-overview",
  "hot-kitchen-supervisor": "hot-kitchen",
  "hot-kitchen-chef": "hot-kitchen",
  "kitchen-steward": "kitchen-overview",
  "head-pastry-chef": "pastry",
  "pastry-chef": "pastry",
  "housekeeping-manager": "housekeeping",
  "housekeeping-supervisor": "housekeeping",
  housekeeper: "housekeeping",
  "laundry-manager": "housekeeping",
  "laundry-supervisor": "housekeeping",
  "laundry-attendant": "housekeeping",
  "procurement-manager": "procurement",
  "procurement-officer": "procurement",
  storekeeper: "stores",
  "receiving-clerk": "stores",
  "marketing-manager": "marketing",
  "social-media-manager": "marketing",
  "sales-and-events-manager": "events",
  "events-coordinator": "events",
  "delivery-manager": "delivery",
  rider: "delivery",
  driver: "delivery",
  "human-resources-manager": "human-resources",
  "hr-officer": "human-resources",
  "maintenance-manager": "maintenance",
  "maintenance-technician": "maintenance",
  "maintenance-officer": "maintenance",
  "grounds-worker": "maintenance",
  "security-supervisor": "staff",
  "security-guard": "staff",
  "banqueting-staff": "events",
};

/** Mirrors public.dashboard_key_for_role() so the preview opens the same Phase 3 dashboard. */
export function dashboardKeyForRole(role: string): string {
  const catalogueKey = resolveCatalogueRoleKey(role);
  const byCatalogue = catalogueKey ? DASHBOARD_BY_CATALOGUE_KEY[catalogueKey] : undefined;
  if (byCatalogue) return byCatalogue;

  const map: Record<string, string> = {
    Owner: "owner",
    // Legacy title kept only so historical records still resolve a dashboard.
    "System Administrator": "administration",
    "IT/System Administrator": "administration",
    "General Manager": "general-manager",
    "Operations Manager": "general-manager",
    "Finance Manager": "finance",
    Accountant: "finance",
    "Front Office Manager": "front-office",
    Receptionist: "front-office",
    "Restaurant Manager": "restaurant-operations",
    "Waiter / Waitress": "restaurant-floor",
    Barista: "coffee-station",
    "Coffee Station Supervisor": "coffee-station",
    "Bar Manager": "bar",
    "Bar Attendant": "bar",
    "Kitchen Manager": "kitchen-overview",
    "Hot Kitchen Supervisor": "hot-kitchen",
    Chef: "hot-kitchen",
    "Pastry Supervisor": "pastry",
    "Pastry Chef": "pastry",
    "Housekeeping Supervisor": "housekeeping",
    Housekeeper: "housekeeping",
    "Procurement Officer": "procurement",
    Storekeeper: "stores",
    "Marketing Manager": "marketing",
    "Events Manager": "events",
    "Delivery Manager": "delivery",
    Rider: "delivery",
    "Human Resources": "human-resources",
    "Maintenance Officer": "maintenance",
  };
  return map[role] ?? "staff";
}

/** Default department / station a role works from, used to pre-select the scope. */
export function defaultPlacementForRole(role: string): { department: string; station: string } {
  const key = dashboardKeyForRole(role);
  const byKey: Record<string, { department: string; station: string }> = {
    owner: { department: "Administration", station: "Administration" },
    administration: { department: "Administration", station: "Administration" },
    "general-manager": { department: "Administration", station: "Administration" },
    finance: { department: "Finance", station: "Accounts" },
    "front-office": { department: "Front Office", station: "Reception / Front Desk" },
    "restaurant-operations": { department: "Restaurant", station: "Restaurant Floor" },
    "restaurant-floor": { department: "Restaurant", station: "Restaurant Floor" },
    "coffee-station": { department: "Restaurant", station: "Coffee Station" },
    bar: { department: "Bar", station: "Main Bar" },
    "kitchen-overview": { department: "Kitchen", station: "Hot Kitchen" },
    "hot-kitchen": { department: "Kitchen", station: "Hot Kitchen" },
    pastry: { department: "Kitchen", station: "Pastry" },
    housekeeping: { department: "Housekeeping", station: "Housekeeping" },
    procurement: { department: "Procurement", station: "Procurement" },
    stores: { department: "Inventory & Stores", station: "Main Store" },
    marketing: { department: "Marketing", station: "Marketing" },
    events: { department: "Events", station: "Events" },
    delivery: { department: "Delivery", station: "Delivery" },
    "human-resources": { department: "Human Resources", station: "HR" },
    maintenance: { department: "Maintenance", station: "Maintenance" },
  };
  return byKey[key] ?? { department: "Administration", station: "Administration" };
}

/**
 * Permission module that gates each sidebar destination. `null` means the page is
 * personal (own tasks / notifications / requests) and is available to every staff role.
 */
const ROUTE_MODULE: Record<string, string | null> = {
  "/": null,
  "/tasks": null,
  "/notifications": null,
  "/approvals": null,
  "/ai-insights": "reports",
  "/front-office": "front-office",
  "/pms": "pms",
  "/pms/reservations": "pms",
  "/pms/arrivals": "pms",
  "/pms/in-house": "pms",
  "/pms/departures": "pms",
  "/pms/availability": "pms",
  "/pms/rack": "pms",
  "/stays": "pms",
  "/pms/rooms": "pms",
  "/pms/requests": "pms",
  "/pms/waitlist": "pms",
  "/pms/groups": "pms",
  "/pms/folios": "pms",
  "/reservations": "front-office",
  "/guests": "front-office",
  "/rooms": "front-office",
  "/rates": "front-office",
  "/pos": "restaurant",
  "/kitchen": "kitchen",
  "/delivery": "delivery",
  "/housekeeping": "housekeeping",
  "/laundry": "laundry",
  "/maintenance": "maintenance",
  "/events": "events",
  "/inventory": "stores",
  "/procurement": "procurement",
  "/finance": "finance",
  "/credit-accounts": "finance",
  "/crm": "crm-customers",
  "/crm/customers": "crm-customers",
  "/crm/corporate": "crm-corporate",
  "/crm/loyalty": "crm-loyalty",
  "/crm/communications": "crm-communications",
  "/crm/feedback": "crm-feedback",
  "/crm/segments": "crm-segments",
  "/crm/duplicates": "crm-customers",
  "/crm/settings": "administration",
  "/marketing": "marketing",
  "/hr": "human-resources",
  "/reports": "reports",
  "/users": "administration",
  "/roles": "administration",
  "/departments": "administration",
  "/audit-logs": "administration",
  "/settings": "administration",
};

export const routeModule = (to: string) => ROUTE_MODULE[to] ?? "administration";

/**
 * Some modules do not expose a plain `view` action. The PMS uses granular actions,
 * so each front-office destination declares the exact action that unlocks it.
 */
const ROUTE_ACTION: Record<string, string> = {
  "/pms": "dashboard.view",
  "/pms/reservations": "reservations.view",
  "/pms/arrivals": "reservations.view",
  "/pms/in-house": "reservations.view",
  "/pms/departures": "reservations.view",
  "/pms/availability": "availability.view",
  "/pms/rack": "rooms.view",
  "/stays": "rooms.view",
  "/pms/rooms": "rooms.view",
  "/pms/requests": "reservations.view",
  "/pms/waitlist": "reservations.view",
  "/pms/groups": "reservations.view",
  "/pms/folios": "folios.view",
};

export const routeAction = (to: string) => ROUTE_ACTION[to] ?? "view";

export type PreviewNavItem = {
  label: string;
  to: string;
  module: string | null;
  allowed: boolean;
};

export type PreviewNavGroup = { title: string; items: PreviewNavItem[] };

/**
 * Sidebar a role would see.
 *
 * This deliberately uses the same route→module map and the same `module.*.view`
 * check the live sidebar and route guard use, so Role Testing and an actual
 * login can never disagree about which pages a role can open.
 */
export function previewNavigation(
  permissions: Set<string>,
  includeBlocked: boolean,
): PreviewNavGroup[] {
  // Feature-level, through the very same check the live sidebar and the route
  // guard use — a coarse `module:view` test here would show pages the real
  // login refuses.
  const can = canFromPermissions(permissions);
  // Guest-facing portal groups never appear in a staff workspace, so the
  // preview must not offer them either.
  const groups: PreviewNavGroup[] = (navigation as NavGroup[])
    .filter((group) => !STAFF_HIDDEN_GROUPS.has(group.title))
    .map((group) => ({
      title: group.title,
      items: group.items.map((item) => ({
        label: item.label,
        to: item.to,
        module: permissionModuleForPath(item.to),
        allowed: navItemVisible(can, item.to),
      })),
    }));
  return groups
    .map((g) => ({ ...g, items: includeBlocked ? g.items : g.items.filter((i) => i.allowed) }))
    .filter((g) => g.items.length > 0);
}

/** Sensitive actions the preview always blocks, whatever the selected role may hold. */
export const PREVIEW_BLOCKED_ACTIONS: { label: string; requires: string }[] = [
  { label: "Approve request", requires: "administration:approve — blocked in preview mode" },
  { label: "Void bill", requires: "finance:void — blocked in preview mode" },
  { label: "Process refund", requires: "finance:refund — blocked in preview mode" },
  { label: "Adjust stock", requires: "stores:edit — blocked in preview mode" },
  { label: "Send guest message", requires: "crm-communications:create — blocked in preview mode" },
  { label: "Delete record", requires: "administration:delete — blocked in preview mode" },
];

export const ROLE_TESTING_CHECKS = [
  { id: "dashboard", label: "Correct dashboard" },
  { id: "sidebar", label: "Correct sidebar" },
  { id: "organization", label: "Correct organization access" },
  { id: "branch", label: "Correct branch access" },
  { id: "department", label: "Correct department access" },
  { id: "station", label: "Correct station access" },
  { id: "tasks", label: "Correct task visibility" },
  { id: "notifications", label: "Correct notification visibility" },
  { id: "approvals", label: "Correct approval authority" },
  { id: "restricted", label: "Restricted actions blocked" },
  { id: "urls", label: "Unauthorized URLs blocked" },
  { id: "rls", label: "RLS test status" },
  { id: "login", label: "Actual test-user login status" },
] as const;
