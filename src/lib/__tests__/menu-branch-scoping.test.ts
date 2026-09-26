import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";
import {
  canHardDeleteMenu,
  departmentIdentity,
  isMenuDepartmentValid,
  isMenuStationValid,
  menuDepartmentsForBranch,
  menuStationsFor,
  menusForBranch,
  pruneMenuSelection,
  type MenuDepartment,
  type MenuStation,
} from "@/lib/menu-scoping";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const SQL = read("src/lib/__tests__/fixtures/menu-branch-chain.sql");
const menuPage = read("src/routes/_shell.pos.menu.tsx");
const manager = read("src/components/pos/MenuCatalogueManager.tsx");

const fn = (name: string) => {
  const start = SQL.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} missing from fixture`).toBeGreaterThan(-1);
  const next = SQL.indexOf("CREATE OR REPLACE FUNCTION", start + 10);
  return SQL.slice(start, next === -1 ? undefined : next);
};

const BRANCH_A = "branch-a";
const BRANCH_B = "branch-b";

const departments: MenuDepartment[] = [
  { id: "kit-a", name: "Main Kitchen", branch_id: BRANCH_A, catalogue_key: "main-kitchen" },
  { id: "kit-b", name: "Main Kitchen", branch_id: BRANCH_B, catalogue_key: "main-kitchen" },
  // The organisation-wide twin of a department that also exists per property.
  { id: "kit-org", name: "Kitchen", branch_id: null, catalogue_key: null },
  { id: "bar-a", name: "Bar", branch_id: BRANCH_A, catalogue_key: "bar" },
  { id: "closed-a", name: "Pastry", branch_id: BRANCH_A, catalogue_key: "pastry-and-bakery", active: false },
];

const stations: MenuStation[] = [
  { id: "st-hot-a", name: "Hot Line", department_id: "kit-a", branch_id: BRANCH_A },
  { id: "st-hot-b", name: "Hot Line", department_id: "kit-b", branch_id: BRANCH_B },
  { id: "st-bar-a", name: "Bar Station", department_id: "bar-a", branch_id: BRANCH_A },
  { id: "st-any-a", name: "Pass", department_id: null, branch_id: BRANCH_A },
  { id: "st-off", name: "Old Grill", department_id: "kit-a", branch_id: BRANCH_A, active: false },
];

describe("property-scoped department dropdown", () => {
  it("offers only the selected property's departments", () => {
    const ids = menuDepartmentsForBranch(departments, BRANCH_A).map((d) => d.id);
    expect(ids).toContain("kit-a");
    expect(ids).toContain("bar-a");
    expect(ids).not.toContain("kit-b");
  });

  it("hides the organisation-wide duplicate when the property has its own", () => {
    const visible = menuDepartmentsForBranch(departments, BRANCH_A);
    expect(visible.filter((d) => departmentIdentity(d) === "main-kitchen")).toHaveLength(1);
    expect(visible.map((d) => d.id)).not.toContain("kit-org");
  });

  it("never lists the same department twice for one property", () => {
    const names = menuDepartmentsForBranch(departments, BRANCH_B).map((d) => d.name);
    expect(names.filter((n) => n === "Main Kitchen")).toHaveLength(1);
  });

  it("keeps each property's own department in All Properties mode", () => {
    const ids = menuDepartmentsForBranch(departments, null).map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(["kit-a", "kit-b"]));
  });

  it("drops inactive departments", () => {
    expect(menuDepartmentsForBranch(departments, BRANCH_A).map((d) => d.id)).not.toContain("closed-a");
  });
});

describe("property- and department-scoped station dropdown", () => {
  it("offers only stations of the selected property", () => {
    const ids = menuStationsFor(stations, BRANCH_A, null).map((s) => s.id);
    expect(ids).toContain("st-hot-a");
    expect(ids).not.toContain("st-hot-b");
  });

  it("narrows to the selected department, keeping department-less stations", () => {
    const ids = menuStationsFor(stations, BRANCH_A, "kit-a").map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["st-hot-a", "st-any-a"]));
    expect(ids).not.toContain("st-bar-a");
  });

  it("deduplicates identically named stations and drops retired ones", () => {
    const names = menuStationsFor(stations, BRANCH_A, null).map((s) => s.name);
    expect(names.filter((n) => n === "Hot Line")).toHaveLength(1);
    expect(menuStationsFor(stations, BRANCH_A, "kit-a").map((s) => s.id)).not.toContain("st-off");
  });
});

describe("dependent selections clear themselves", () => {
  it("detects a department invalidated by a property change", () => {
    expect(isMenuDepartmentValid(departments, BRANCH_A, "kit-a")).toBe(true);
    expect(isMenuDepartmentValid(departments, BRANCH_B, "kit-a")).toBe(false);
  });

  it("detects a station invalidated by a property or department change", () => {
    expect(isMenuStationValid(stations, BRANCH_A, "kit-a", "st-hot-a")).toBe(true);
    expect(isMenuStationValid(stations, BRANCH_B, "kit-b", "st-hot-a")).toBe(false);
    expect(isMenuStationValid(stations, BRANCH_A, "bar-a", "st-hot-a")).toBe(false);
  });

  it("clears both when the property changes", () => {
    expect(pruneMenuSelection(departments, stations, BRANCH_B, "kit-a", "st-hot-a")).toEqual({
      departmentId: null,
      stationId: null,
    });
  });

  it("clears only the station when the department changes", () => {
    expect(pruneMenuSelection(departments, stations, BRANCH_A, "bar-a", "st-hot-a")).toEqual({
      departmentId: "bar-a",
      stationId: null,
    });
  });
});

describe("menu list scoping", () => {
  const menus = [
    { id: "m-a", name: "À la carte", branch_id: BRANCH_A },
    { id: "m-b", name: "À la carte", branch_id: BRANCH_B },
  ];

  it("shows only the selected property's menus", () => {
    expect(menusForBranch(menus, BRANCH_A).map((m) => m.id)).toEqual(["m-a"]);
  });

  it("shows every menu when All Properties is explicitly selected", () => {
    expect(menusForBranch(menus, null)).toHaveLength(2);
  });

  it("labels the property in All Properties mode so identical names are not duplicates", () => {
    expect(manager).toContain("branchName.get(m.branch_id)");
    expect(menuPage).toContain("branchLabel(m.branch_id)");
    expect(menuPage).toContain("i.branch_name");
  });
});

describe("safe removal", () => {
  it("permits hard delete only for an unreferenced menu", () => {
    expect(canHardDeleteMenu({ categories: 0, items: 0 })).toBe(true);
    expect(canHardDeleteMenu({ categories: 1, items: 0 })).toBe(false);
    expect(canHardDeleteMenu({ categories: 0, items: 3 })).toBe(false);
  });

  it("offers deactivate/retire instead of deletion when the menu is in use", () => {
    expect(manager).toContain("safeToDelete");
    expect(manager).toContain("In use");
    expect(manager).toContain("MENU_STATUSES");
  });
});

describe("server-side enforcement", () => {
  const chain = fn("neo_menu_assert_chain");

  it("is the single authority for the property → department → station chain", () => {
    expect(chain).toContain("That department belongs to another property");
    expect(chain).toContain("That production station belongs to another property");
    expect(chain).toContain("That production station belongs to another department");
    expect(chain).toContain("neo_branch_in_scope(_branch)");
  });

  it("is re-checked on item save and on inline station assignment", () => {
    expect(fn("neo_menu_save_item")).toContain("PERFORM public.neo_menu_assert_chain(_target_branch, _department, _station)");
    expect(fn("neo_menu_save_item")).toContain("That category belongs to another property");
    const settlement = read("src/lib/__tests__/fixtures/pos-settlement-menu.sql");
    expect(settlement).toContain("PERFORM public.neo_menu_assert_chain(_item.branch_id, NULL, _station_id)");
  });

  it("scopes the department and station lookups to the caller's properties", () => {
    for (const source of [fn("neo_menu_departments"), fn("neo_menu_stations")]) {
      expect(source).toContain("organization_id = public.current_org_id()");
      expect(source).toContain("public.neo_branch_in_scope");
      expect(source).toContain("has_permission('restaurant','menu','view')");
    }
  });

  it("deduplicates in the database as well as the interface", () => {
    expect(fn("neo_menu_departments")).toContain("row_number() OVER");
    expect(fn("neo_menu_stations")).toContain("row_number() OVER");
  });

  it("never lets a menu migrate between properties", () => {
    expect(fn("neo_menu_save")).toContain("_target_branch := _existing.branch_id");
  });

  it("blocks hard delete of a referenced menu in the database", () => {
    expect(fn("neo_menu_delete")).toContain("Deactivate or retire it instead of deleting");
  });

  it("gates every lifecycle action on a menu capability", () => {
    expect(fn("neo_menu_save")).toContain("has_permission('restaurant','menu','create')");
    expect(fn("neo_menu_save")).toContain("has_permission('restaurant','menu','edit')");
    expect(fn("neo_menu_set_status")).toContain("has_permission('restaurant','menu','edit')");
    expect(fn("neo_menu_delete")).toContain("has_permission('restaurant','menu','delete')");
  });

  it("is registered and never callable anonymously", () => {
    for (const name of [
      "neo_menu_departments",
      "neo_menu_stations",
      "neo_menu_save",
      "neo_menu_set_status",
      "neo_menu_delete",
      "neo_menu_save_item",
    ]) {
      expect(RPC_MANIFEST[name]).toBe("authenticated");
      expect(SQL).toContain(`REVOKE ALL ON FUNCTION public.${name}(`);
    }
    // The chain guard is server-only: never reachable as a client RPC.
    expect(RPC_MANIFEST["neo_menu_assert_chain"]).toBeUndefined();
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public.neo_menu_assert_chain(");
  });
});
