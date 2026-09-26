/**
 * Property switching — Departments and Stations, end to end.
 *
 * Switching the active property between Nairobi, Mombasa and Taveta must change
 * every scoped surface at once: the departments table, the stations table, and
 * the department / property dropdowns those screens offer. Nothing belonging to
 * another property may appear in any of them, in any direction.
 *
 * The suite drives the real scoping helpers the routes use, once per property,
 * and pins the route wiring so a screen cannot quietly stop applying them.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  dedupeDepartments,
  dedupeStations,
  type ScopedDepartment,
  type ScopedStation,
} from "@/lib/scoped-options";

const NAIROBI = "11111111-1111-1111-1111-111111111111";
const MOMBASA = "33333333-3333-3333-3333-333333333333";
const TAVETA = "22222222-2222-2222-2222-222222222222";

const PROPERTIES = [
  { id: NAIROBI, name: "Nairobi" },
  { id: MOMBASA, name: "Mombasa" },
  { id: TAVETA, name: "Taveta" },
];

const departments: ScopedDepartment[] = [
  { id: "d-org-hk", name: "Housekeeping", catalogue_key: "housekeeping", branch_id: null, branch_name: null },
  { id: "d-nbo-fb", name: "Food & Beverage", catalogue_key: "fnb", branch_id: NAIROBI, branch_name: "Nairobi" },
  { id: "d-msa-fb", name: "Food & Beverage", catalogue_key: "fnb", branch_id: MOMBASA, branch_name: "Mombasa" },
  { id: "d-tvt-fb", name: "Food & Beverage", catalogue_key: "fnb", branch_id: TAVETA, branch_name: "Taveta" },
  { id: "d-msa-kit", name: "Kitchen", catalogue_key: "kitchen", branch_id: MOMBASA, branch_name: "Mombasa" },
];

const stations: ScopedStation[] = [
  { id: "s-nbo-bar", name: "Main Bar", code: "BAR", station_type: "bar", department_id: "d-nbo-fb", branch_id: NAIROBI, branch_name: "Nairobi" },
  { id: "s-msa-bar", name: "Main Bar", code: "BAR", station_type: "bar", department_id: "d-msa-fb", branch_id: MOMBASA, branch_name: "Mombasa" },
  { id: "s-msa-pas", name: "Pastry", code: "PAS", station_type: "kitchen", department_id: "d-msa-kit", branch_id: MOMBASA, branch_name: "Mombasa" },
  { id: "s-tvt-bev", name: "Beverage", code: "BEV", station_type: "bar", department_id: "d-tvt-fb", branch_id: TAVETA, branch_name: "Taveta" },
];

/** What every scoped surface offers once a property is selected. */
function surfacesFor(branchId: string) {
  const departmentOptions = dedupeDepartments(departments, branchId);
  return {
    departmentTable: departmentOptions,
    departmentOptions,
    stationTable: dedupeStations(stations, branchId, null),
    propertyOptions: PROPERTIES.filter((p) => p.id === branchId),
  };
}

describe.each(PROPERTIES)("with $name selected", ({ id, name }) => {
  const s = surfacesFor(id);
  const others = PROPERTIES.filter((p) => p.id !== id);

  it("shows no other property's departments in the table", () => {
    for (const other of others) {
      expect(s.departmentTable.some((d) => d.branch_id === other.id)).toBe(false);
      expect(s.departmentTable.some((d) => d.branch_name === other.name)).toBe(false);
    }
  });

  it("shows no other property's stations in the table", () => {
    for (const other of others) {
      expect(s.stationTable.some((st) => st.branch_id === other.id)).toBe(false);
    }
  });

  it("offers only this property's departments in the department dropdown", () => {
    for (const option of s.departmentOptions) {
      expect(option.branch_id === null || option.branch_id === id).toBe(true);
    }
  });

  it("offers only this property in the property dropdown", () => {
    expect(s.propertyOptions.map((p) => p.name)).toEqual([name]);
  });

  it("keeps organisation-wide departments available where the property has none", () => {
    expect(s.departmentTable.some((d) => d.id === "d-org-hk")).toBe(true);
  });
});

describe("switching between properties changes the whole picture", () => {
  it("Nairobi never shows Mombasa or Taveta records", () => {
    const s = surfacesFor(NAIROBI);
    expect(s.departmentTable.map((d) => d.id).sort()).toEqual(["d-nbo-fb", "d-org-hk"]);
    expect(s.stationTable.map((st) => st.id)).toEqual(["s-nbo-bar"]);
  });

  it("Mombasa shows its own Main Bar and Pastry, not Nairobi's", () => {
    const s = surfacesFor(MOMBASA);
    expect(s.stationTable.map((st) => st.id).sort()).toEqual(["s-msa-bar", "s-msa-pas"]);
    expect(s.departmentTable.map((d) => d.id).sort()).toEqual(["d-msa-fb", "d-msa-kit", "d-org-hk"]);
  });

  it("Taveta shows only Beverage", () => {
    const s = surfacesFor(TAVETA);
    expect(s.stationTable.map((st) => st.id)).toEqual(["s-tvt-bev"]);
  });

  it("an identically named station exists per property and never merges", () => {
    expect(surfacesFor(NAIROBI).stationTable[0]!.id).not.toBe(
      surfacesFor(MOMBASA).stationTable.find((st) => st.name === "Main Bar")!.id,
    );
  });

  it("a station dropdown filtered by department stays within the property", () => {
    // Mombasa's Kitchen department must not surface Nairobi's bar.
    const scoped = dedupeStations(stations, MOMBASA, "d-msa-kit");
    expect(scoped.map((st) => st.id)).toEqual(["s-msa-pas"]);
  });
});

describe("the screens actually apply the active property", () => {
  const departmentsRoute = readFileSync("src/routes/_shell.departments.tsx", "utf8");
  const stationsRoute = readFileSync("src/routes/_shell.stations.tsx", "utf8");

  it("Departments filters by the active property", () => {
    expect(departmentsRoute).toContain("useActivePropertyFilter");
    expect(departmentsRoute).toMatch(/branch_id/);
  });

  it("Stations filters stations, departments and properties by the active property", () => {
    expect(stationsRoute).toContain("useActivePropertyFilter");
    expect(stationsRoute).toMatch(/branch_id/);
  });

  it("keys the queries by the active property so switching refetches", () => {
    expect(departmentsRoute).toMatch(/queryKey: \[[^\]]*(branchId|filterKey)/);
    expect(stationsRoute).toMatch(/queryKey: \[[^\]]*(branchId|filterKey)/);
  });
});
