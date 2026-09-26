/**
 * Canonical property → department → station scoping for the menu catalogue.
 *
 * The rules mirror the staff-assignment chain and are enforced server-side by
 * `public.neo_menu_departments`, `public.neo_menu_stations` and
 * `public.neo_menu_assert_chain`. This module is the interface half of that one
 * contract: it never widens what the database allows, it only keeps the screen
 * honest so an operator is not offered a choice the backend would reject.
 *
 * Three rules matter and none of them guess:
 *  1. A department is offered for a property when it belongs to that property,
 *     or when it is genuinely organisation-wide (no property of its own).
 *  2. Departments are deduplicated by canonical identity, and a property's own
 *     department always beats the organisation-wide record of the same concept,
 *     so the operator never sees the same department twice.
 *  3. A station is offered only for the selected property, and only for the
 *     selected department (a station with no department cannot be proven wrong,
 *     so it stays; a station naming another department is dropped).
 */

import { departmentCatalogueKey } from "@/lib/role-scoping";

export type MenuDepartment = {
  id: string;
  name: string;
  catalogue_key?: string | null;
  branch_id: string | null;
  active?: boolean | null;
};

export type MenuStation = {
  id: string;
  name: string;
  code?: string | null;
  station_type?: string | null;
  department_id: string | null;
  branch_id: string | null;
  active?: boolean | null;
};

export type MenuRecord = {
  id: string;
  name: string;
  branch_id: string | null;
  status?: string | null;
};

/** Canonical identity of a department: catalogue key first, name only as a last resort. */
export function departmentIdentity(dept: MenuDepartment): string {
  const key = (dept.catalogue_key ?? "").trim();
  if (key) return key;
  return departmentCatalogueKey(dept.name) ?? dept.name.trim().toLowerCase();
}

/**
 * Departments an operator may pick for the selected property, deduplicated.
 * With no property selected ("All Properties") each property keeps its own
 * departments, because they are genuinely different records.
 */
export function menuDepartmentsForBranch(
  departments: MenuDepartment[],
  branchId: string | null | undefined,
): MenuDepartment[] {
  const usable = departments.filter(
    (d) => d.active !== false && (!branchId || d.branch_id === branchId || d.branch_id === null),
  );
  const best = new Map<string, MenuDepartment>();
  for (const dept of usable) {
    const key = branchId ? departmentIdentity(dept) : `${dept.branch_id ?? "org"}::${departmentIdentity(dept)}`;
    const held = best.get(key);
    // A property-specific record always wins over the organisation-wide one.
    if (!held || (held.branch_id === null && dept.branch_id !== null)) best.set(key, dept);
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Stations valid for the selected property and department, deduplicated by name. */
export function menuStationsFor(
  stations: MenuStation[],
  branchId: string | null | undefined,
  departmentId: string | null | undefined,
): MenuStation[] {
  const usable = stations.filter(
    (s) =>
      s.active !== false &&
      (!branchId || s.branch_id === branchId || s.branch_id === null) &&
      // A station that names another department is never offered; one with no
      // department at all cannot be proven invalid.
      (!departmentId || s.department_id === null || s.department_id === departmentId),
  );
  const best = new Map<string, MenuStation>();
  for (const station of usable) {
    const ident = station.name.trim().toLowerCase();
    const key = branchId ? ident : `${station.branch_id ?? "org"}::${ident}`;
    const held = best.get(key);
    if (
      !held ||
      (held.branch_id === null && station.branch_id !== null) ||
      (held.department_id === null && station.department_id !== null)
    ) {
      best.set(key, station);
    }
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Menus visible for the selected property. "All Properties" shows every menu. */
export function menusForBranch<T extends MenuRecord>(menus: T[], branchId: string | null | undefined): T[] {
  if (!branchId) return menus;
  return menus.filter((m) => m.branch_id === branchId || m.branch_id === null);
}

/** True when the department survives a change of property. */
export function isMenuDepartmentValid(
  departments: MenuDepartment[],
  branchId: string | null | undefined,
  departmentId: string | null | undefined,
): boolean {
  if (!departmentId) return true;
  return menuDepartmentsForBranch(departments, branchId).some((d) => d.id === departmentId);
}

/** True when the station survives a change of property or department. */
export function isMenuStationValid(
  stations: MenuStation[],
  branchId: string | null | undefined,
  departmentId: string | null | undefined,
  stationId: string | null | undefined,
): boolean {
  if (!stationId) return true;
  return menuStationsFor(stations, branchId, departmentId).some((s) => s.id === stationId);
}

/** Drops a dependent selection the new property/department no longer permits. */
export function pruneMenuSelection(
  departments: MenuDepartment[],
  stations: MenuStation[],
  branchId: string | null,
  departmentId: string | null,
  stationId: string | null,
): { departmentId: string | null; stationId: string | null } {
  const dept = isMenuDepartmentValid(departments, branchId, departmentId) ? departmentId : null;
  const station = isMenuStationValid(stations, branchId, dept, stationId) ? stationId : null;
  return { departmentId: dept, stationId: station };
}

/** A menu may only be permanently removed when nothing references it. */
export function canHardDeleteMenu(counts: { categories: number; items: number }): boolean {
  return counts.categories === 0 && counts.items === 0;
}

export const MENU_STATUSES = ["active", "inactive", "retired"] as const;
export const MENU_SERVICE_TYPES = [
  "all-day",
  "breakfast",
  "lunch",
  "dinner",
  "brunch",
  "bar",
  "room-service",
  "banquet",
] as const;

/**
 * The outlet a menu belongs to.
 *
 * A bar terminal must not be able to sell the restaurant's steaks, so the
 * menu — not the item — carries the outlet, and the terminal sells only the
 * menus its outlet owns. `all` stays available everywhere.
 */
export const MENU_OUTLETS = [
  "all",
  "restaurant",
  "bar",
  "coffee",
  "room-service",
  "delivery",
  "banqueting",
] as const;

export type MenuOutlet = (typeof MENU_OUTLETS)[number];

export const MENU_OUTLET_LABELS: Record<MenuOutlet, string> = {
  all: "All outlets",
  restaurant: "Restaurant",
  bar: "Bar",
  coffee: "Coffee shop",
  "room-service": "Room service",
  delivery: "Delivery",
  banqueting: "Banqueting",
};

/** Which outlet a POS order is trading through, from its order type. */
export function outletForOrderType(orderType: string | null | undefined): MenuOutlet | null {
  const raw = (orderType ?? "").toLowerCase().replace(/_/g, "-");
  if (raw.startsWith("bar")) return "bar";
  if (raw.startsWith("coffee")) return "coffee";
  if (raw === "room-service") return "room-service";
  if (raw === "delivery") return "delivery";
  if (raw === "banquet" || raw === "banqueting") return "banqueting";
  return null;
}

/** The outlet a floor area belongs to, when it names one. */
export function outletForArea(areaOutlet: string | null | undefined): MenuOutlet | null {
  const raw = (areaOutlet ?? "").toLowerCase().replace(/_/g, "-");
  return (MENU_OUTLETS as readonly string[]).includes(raw) && raw !== "all"
    ? (raw as MenuOutlet)
    : null;
}

/**
 * The outlet an order is trading through.
 *
 * The order type is the explicit statement; the table's floor area is the
 * fallback, so a tab opened on a bar table sells bar menus rather than the
 * whole hotel catalogue.
 */
export function outletForOrder(
  orderType: string | null | undefined,
  areaOutlet: string | null | undefined,
): MenuOutlet | null {
  return outletForOrderType(orderType) ?? outletForArea(areaOutlet);
}

/**
 * The catalogue a terminal may sell from.
 *
 * When the outlet has its own menus, only those are offered. When it has none
 * configured yet, the caller is told so explicitly rather than being silently
 * handed the whole hotel catalogue.
 */
export function scopeCatalogueToOutlet<T extends { menu_outlet?: string | null }>(
  rows: readonly T[],
  outlet: MenuOutlet | null,
): { rows: T[]; outletConfigured: boolean } {
  if (!outlet) return { rows: [...rows], outletConfigured: true };
  // A menu tagged "all" is shared hotel-wide and stays sellable at every
  // terminal; only menus owned by a *different* outlet are withheld.
  const owned = rows.filter((r) => {
    const own = r.menu_outlet ?? "all";
    return own === outlet || own === "all";
  });
  if (owned.length > 0) return { rows: owned, outletConfigured: true };
  return { rows: [], outletConfigured: false };
}
