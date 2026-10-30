import { describe, expect, it } from "vitest";
import {
  displayStations,
  selectedDisplayStation,
  stationDepartment,
  DISPLAY_ROUTES,
} from "@/lib/production-displays";
import { pathPermitted } from "@/lib/capabilities";
import { navigationForRole, type Role } from "@/lib/navigation";

const stations = [
  { id: "k", name: "Hot Kitchen", station_type: "production" },
  { id: "c", name: "Coffee Station", station_type: "beverage" },
  { id: "b", name: "Main Bar", station_type: "bar" },
  { id: "p", name: "Pastry", station_type: "production" },
  { id: "u", name: "Unconfigured", station_type: "production" },
];
const canOnly = (module: string, feature: string) => (m: string, f: string, a?: string) =>
  m === module && f === feature && a === "view";
describe("production display boundaries", () => {
  it("keeps coffee separate from beverage/bar despite its beverage station type", () => {
    expect(stationDepartment(stations[1]!)).toBe("coffee");
    expect(displayStations(stations, "bar").map((s) => s.id)).toEqual(["b"]);
  });
  it("does not classify unknown production stations as kitchen", () => {
    expect(stationDepartment(stations[4]!)).toBeNull();
    expect(displayStations(stations, "kitchen").map((s) => s.id)).toEqual(["k"]);
  });
  it("keeps kitchen and pastry independent", () => {
    expect(displayStations(stations, "pastry").map((s) => s.id)).toEqual(["p"]);
  });
  it("refuses stale or forged station bookmarks instead of silently switching stations", () => {
    const kitchen = displayStations(stations, "kitchen");
    expect(selectedDisplayStation(kitchen, "other-property")).toBeUndefined();
    expect(selectedDisplayStation(kitchen, "all")).toBeUndefined();
    expect(selectedDisplayStation(kitchen, "b")).toBeUndefined();
    expect(selectedDisplayStation(kitchen, undefined)?.id).toBe("k");
  });
  it("does not widen an empty station assignment", () => {
    expect(selectedDisplayStation([], undefined)).toBeUndefined();
    expect(displayStations([], "overview")).toEqual([]);
  });
  it("allows personal PIN setup without granting production permissions", () => {
    const denied = () => false;

    // Personal settings are available within the authenticated shell.
    expect(pathPermitted(denied, "/staff-display-code")).toBe(true);

    // A non-production employee must not gain station privileges.
    expect(pathPermitted(denied, "/production-displays")).toBe(false);
    expect(pathPermitted(denied, DISPLAY_ROUTES.kitchen)).toBe(false);
    expect(pathPermitted(denied, DISPLAY_ROUTES.bar)).toBe(false);
    expect(pathPermitted(denied, DISPLAY_ROUTES.coffee)).toBe(false);
    expect(pathPermitted(denied, DISPLAY_ROUTES.pastry)).toBe(false);

    // A Laundry or Housekeeping permission does not grant Kitchen access.
    const laundryOnly = (module: string) => module === "laundry";
    expect(pathPermitted(laundryOnly, "/staff-display-code")).toBe(true);
    expect(pathPermitted(laundryOnly, DISPLAY_ROUTES.kitchen)).toBe(false);

    // Existing Kitchen authorization remains unchanged.
    const kitchenStaff = (module: string, feature: string, action?: string) =>
      module === "kitchen" && feature === "ticket" && action === "accept";

    expect(pathPermitted(kitchenStaff, "/staff-display-code")).toBe(true);
  });
  it("opens bar through its own queue permission without opening kitchen or manager overview", () => {
    const can = canOnly("bar", "queue");
    expect(pathPermitted(can, DISPLAY_ROUTES.bar)).toBe(true);
    expect(pathPermitted(can, DISPLAY_ROUTES.kitchen)).toBe(false);
    expect(pathPermitted(can, DISPLAY_ROUTES.overview)).toBe(false);
  });
  it("does not grant production displays through a waiter's ordering permission", () => {
    for (const path of Object.values(DISPLAY_ROUTES))
      expect(pathPermitted(canOnly("restaurant", "orders"), path)).toBe(false);
  });
  it("requires explicit all-stations oversight to open the combined display", () => {
    expect(pathPermitted(canOnly("kitchen", "queue"), DISPLAY_ROUTES.overview)).toBe(false);
    expect(pathPermitted(canOnly("kitchen", "all_stations"), DISPLAY_ROUTES.overview)).toBe(true);
  });
  it("shows personal PIN settings to every staff navigation role", () => {
    const roles: Role[] = [
      "owner",
      "manager",
      "front-office",
      "waiter",
      "kitchen",
      "housekeeping",
      "maintenance",
      "store",
      "accountant",
      "marketing",
      "hr",
    ];

    for (const role of roles) {
      const items = navigationForRole(role).flatMap((group) => group.items);

      expect(
        items.filter((item) => item.to === "/staff-display-code"),
      ).toHaveLength(1);
    }

    const housekeeping = navigationForRole("housekeeping").flatMap(
      (group) => group.items,
    );

    expect(
      housekeeping.some((item) => item.to === "/production-displays"),
    ).toBe(false);
  });
});
