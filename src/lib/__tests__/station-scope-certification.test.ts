/**
 * Station scope certification.
 *
 * Frontline production staff see only the station they are assigned to:
 *   • Hot Kitchen chefs   → Hot Kitchen
 *   • Pastry staff        → Pastry
 *   • Baristas            → Coffee Station
 *   • Bar Attendants      → Main Bar
 *
 * Supervisory reach is departmental, by assignment:
 *   • F&B Manager  → Restaurant Floor, Coffee Station, Main Bar (Food & Beverage)
 *   • Head Chef    → Hot Kitchen, Pastry (Main Kitchen + Pastry & Bakery)
 *
 * The trap this certifies against: Coffee Station, Main Bar and Restaurant
 * Floor all sit under one Food & Beverage department, so a department-wide
 * fallback would show a barista the bar's tickets. Department reach is
 * therefore supervisory only (`scope_rank >= 3`); frontline staff resolve
 * through their explicit station assignment.
 *
 * The database is authoritative — the final case asserts the deployed
 * `neo_kitchen_visible_station_ids` carries the same rule.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  canSeeProductionTicket,
  visibleStationIds,
  type VisibilityStation,
  type VisibilityViewer,
} from "@/lib/kitchen-visibility";

const ORG = "org-1";
const BRANCH = "branch-nairobi";
const FNB = "dept-fnb";
const KITCHEN = "dept-kitchen";
const PASTRY_DEPT = "dept-pastry";

const station = (id: string, departmentId: string): VisibilityStation => ({
  id,
  organizationId: ORG,
  branchId: BRANCH,
  departmentId,
});

/** Mirrors a real property: the F&B department owns three service stations. */
const STATIONS: VisibilityStation[] = [
  station("hot-kitchen", KITCHEN),
  station("pastry", PASTRY_DEPT),
  station("coffee-station", FNB),
  station("main-bar", FNB),
  station("restaurant-floor", FNB),
];

const viewer = (over: Partial<VisibilityViewer>): VisibilityViewer => ({
  organizationId: ORG,
  scope: "self",
  branchIds: [BRANCH],
  departmentIds: [],
  stationIds: [],
  allStations: false,
  queueView: true,
  ...over,
});

const sorted = (ids: string[]) => [...ids].sort();

describe("frontline station scope", () => {
  const frontline: [string, string, string][] = [
    ["Hot Kitchen chef", KITCHEN, "hot-kitchen"],
    ["Pastry staff", PASTRY_DEPT, "pastry"],
    ["Barista", FNB, "coffee-station"],
    ["Bar Attendant", FNB, "main-bar"],
  ];

  for (const [role, dept, assigned] of frontline) {
    it(`shows a ${role} only ${assigned}`, () => {
      const me = viewer({ scope: "self", departmentIds: [dept], stationIds: [assigned] });
      expect(visibleStationIds(me, STATIONS)).toEqual([assigned]);

      for (const other of STATIONS.filter((s) => s.id !== assigned)) {
        expect(
          canSeeProductionTicket(me, { organizationId: ORG, stationId: other.id }, STATIONS),
          `${role} must not see ${other.id} work`,
        ).toBe(false);
      }
      expect(
        canSeeProductionTicket(me, { organizationId: ORG, stationId: assigned }, STATIONS),
      ).toBe(true);
    });
  }

  it("never lets one Food & Beverage station leak into another", () => {
    const barista = viewer({ scope: "team", departmentIds: [FNB], stationIds: ["coffee-station"] });
    const attendant = viewer({ scope: "team", departmentIds: [FNB], stationIds: ["main-bar"] });
    expect(visibleStationIds(barista, STATIONS)).toEqual(["coffee-station"]);
    expect(visibleStationIds(attendant, STATIONS)).toEqual(["main-bar"]);
  });

  it("shows nothing — rather than the whole department — to unassigned frontline staff", () => {
    const unassigned = viewer({ scope: "self", departmentIds: [FNB] });
    expect(visibleStationIds(unassigned, STATIONS)).toEqual([]);
  });

  it("still requires the queue capability before any ticket is visible", () => {
    const chef = viewer({ stationIds: ["hot-kitchen"], queueView: false });
    expect(
      canSeeProductionTicket(chef, { organizationId: ORG, stationId: "hot-kitchen" }, STATIONS),
    ).toBe(false);
  });
});

describe("supervisory station scope", () => {
  it("gives the F&B Manager Restaurant Floor, Coffee Station and Main Bar", () => {
    const fnbManager = viewer({ scope: "department", departmentIds: [FNB] });
    expect(sorted(visibleStationIds(fnbManager, STATIONS))).toEqual(
      sorted(["coffee-station", "main-bar", "restaurant-floor"]),
    );
    // Kitchen production is not the F&B Manager's department by assignment.
    expect(visibleStationIds(fnbManager, STATIONS)).not.toContain("hot-kitchen");
    expect(visibleStationIds(fnbManager, STATIONS)).not.toContain("pastry");
  });

  it("gives the Head Chef Hot Kitchen and Pastry according to assignment", () => {
    const headChef = viewer({ scope: "department", departmentIds: [KITCHEN, PASTRY_DEPT] });
    expect(sorted(visibleStationIds(headChef, STATIONS))).toEqual(sorted(["hot-kitchen", "pastry"]));
    expect(visibleStationIds(headChef, STATIONS)).not.toContain("main-bar");
  });

  it("lets a configured all-stations capability oversee the whole property", () => {
    const oversight = viewer({ scope: "department", allStations: true });
    expect(visibleStationIds(oversight, STATIONS)).toHaveLength(STATIONS.length);
  });

  it("keeps the property boundary hard below organisation reach", () => {
    const headChef = viewer({ scope: "department", departmentIds: [KITCHEN] });
    const otherProperty = [{ ...station("hot-kitchen-mombasa", KITCHEN), branchId: "branch-mombasa" }];
    expect(visibleStationIds(headChef, otherProperty)).toEqual([]);
  });

  it("keeps the tenant boundary hard for every scope", () => {
    const owner = viewer({ scope: "organisation" });
    const foreign = [{ ...station("foreign", KITCHEN), organizationId: "org-2" }];
    expect(visibleStationIds(owner, foreign)).toEqual([]);
  });
});

const HAS_SQL = Boolean(process.env["PGHOST"]);

describe.skipIf(!HAS_SQL)("deployed visibility routine matches the certified rule", () => {
  const src = () =>
    execFileSync(
      "psql",
      [
        "-At",
        "-c",
        `select replace(coalesce(string_agg(p.prosrc,' '),''), chr(10), ' ') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='neo_kitchen_visible_station_ids'`,
      ],
      { encoding: "utf8" },
    );

  it("restricts the department fallback to supervisory scope", () => {
    const body = src();
    expect(body).toContain("s.id = ANY (me.stations)");
    expect(body).toMatch(/scope_rank\(me\.scope\) >= 3[\s\S]*department_id = ANY \(me\.depts\)/);
  });

  it("keeps the tenant and property boundaries in the routine", () => {
    const body = src();
    expect(body).toContain("s.organization_id = me.org");
    expect(body).toContain("s.branch_id = ANY (me.branches)");
  });
});
