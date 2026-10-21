import { describe, expect, it } from "vitest";
import {
  displayStations,
  selectedDisplayStation,
  stationDepartment,
  DISPLAY_ROUTES,
} from "@/lib/production-displays";
import { pathPermitted } from "@/lib/capabilities";

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
  it("does not offer a display PIN to a read-only production observer", () => {
    expect(pathPermitted(canOnly("kitchen", "queue"), "/staff-display-code")).toBe(false);
    expect(
      pathPermitted(
        (m, f, a) => m === "kitchen" && f === "ticket" && a === "accept",
        "/staff-display-code",
      ),
    ).toBe(true);
    expect(
      pathPermitted(
        (m, f, a) => m === "bar" && f === "queue" && a === "edit",
        "/staff-display-code",
      ),
    ).toBe(true);
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
});
