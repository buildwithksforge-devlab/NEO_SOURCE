import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canSeeProductionTicket,
  visibleStationIds,
  type VisibilityStation,
  type VisibilityViewer,
} from "@/lib/kitchen-visibility";

const ORG_A = "org-a";
const ORG_B = "org-b";
const PROP_1 = "prop-1";
const PROP_2 = "prop-2";
const DEPT_KITCHEN = "dept-kitchen";
const DEPT_FNB = "dept-fnb";
const DEPT_BAR = "dept-bar";

const stations: VisibilityStation[] = [
  { id: "grill", organizationId: ORG_A, branchId: PROP_1, departmentId: DEPT_KITCHEN },
  { id: "hot-kitchen", organizationId: ORG_A, branchId: PROP_1, departmentId: DEPT_KITCHEN },
  { id: "coffee", organizationId: ORG_A, branchId: PROP_1, departmentId: DEPT_FNB },
  { id: "main-bar", organizationId: ORG_A, branchId: PROP_1, departmentId: DEPT_BAR },
  { id: "grill-p2", organizationId: ORG_A, branchId: PROP_2, departmentId: DEPT_KITCHEN },
  { id: "grill-org-b", organizationId: ORG_B, branchId: "prop-x", departmentId: "dept-x" },
];

const grillTicket = { organizationId: ORG_A, stationId: "grill" };

const viewer = (over: Partial<VisibilityViewer>): VisibilityViewer => ({
  organizationId: ORG_A,
  scope: "self",
  branchIds: [PROP_1],
  departmentIds: [],
  stationIds: [],
  allStations: false,
  queueView: true,
  ...over,
});

describe("kitchen queue visibility matrix (active property)", () => {
  it("owner / system admin sees the ticket across the organisation", () => {
    for (const scope of ["organisation", "technical"]) {
      expect(
        canSeeProductionTicket(viewer({ scope, allStations: true, branchIds: [] }), grillTicket, stations),
      ).toBe(true);
    }
  });

  it("F&B manager with all-stations capability sees kitchen production at the property", () => {
    const fnb = viewer({ scope: "department", departmentIds: [DEPT_FNB], allStations: true });
    expect(canSeeProductionTicket(fnb, grillTicket, stations)).toBe(true);
    expect(visibleStationIds(fnb, stations)).not.toContain("grill-p2");
  });

  it("head chef / kitchen manager sees the kitchen queues they manage, not only assigned tickets", () => {
    const chef = viewer({ scope: "department", departmentIds: [DEPT_KITCHEN] });
    expect(canSeeProductionTicket(chef, grillTicket, stations)).toBe(true);
    expect(visibleStationIds(chef, stations)).toEqual(expect.arrayContaining(["grill", "hot-kitchen"]));
  });

  it("station chef with an explicit station assignment sees that station", () => {
    const grillChef = viewer({ scope: "team", stationIds: ["grill"] });
    expect(canSeeProductionTicket(grillChef, grillTicket, stations)).toBe(true);
  });

  it("department fallback is supervisory reach, not frontline reach", () => {
    // Supervisor over the kitchen department.
    const supervisor = viewer({ scope: "department", departmentIds: [DEPT_KITCHEN] });
    expect(canSeeProductionTicket(supervisor, grillTicket, stations)).toBe(true);
    // Frontline staff with no station assignment see nothing rather than the
    // whole department.
    const unassignedChef = viewer({ scope: "team", departmentIds: [DEPT_KITCHEN] });
    expect(canSeeProductionTicket(unassignedChef, grillTicket, stations)).toBe(false);
  });

  it("unrelated F&B roles do not gain grill access", () => {
    const barista = viewer({ scope: "self", departmentIds: [DEPT_FNB], stationIds: ["coffee"] });
    const barAttendant = viewer({ scope: "self", departmentIds: [DEPT_BAR], stationIds: ["main-bar"] });
    expect(canSeeProductionTicket(barista, grillTicket, stations)).toBe(false);
    expect(canSeeProductionTicket(barAttendant, grillTicket, stations)).toBe(false);
    expect(visibleStationIds(barista, stations)).toEqual(["coffee"]);
    expect(visibleStationIds(barAttendant, stations)).toEqual(["main-bar"]);
  });

  it("a user at property B cannot see a property A ticket", () => {
    const otherProperty = viewer({
      scope: "department",
      branchIds: [PROP_2],
      departmentIds: [DEPT_KITCHEN],
      allStations: true,
    });
    expect(canSeeProductionTicket(otherProperty, grillTicket, stations)).toBe(false);
  });

  it("another organisation can never see the ticket", () => {
    const foreign = viewer({ organizationId: ORG_B, scope: "organisation", allStations: true });
    expect(canSeeProductionTicket(foreign, grillTicket, stations)).toBe(false);
  });

  it("kitchen queue permission is still required", () => {
    const noPermission = viewer({ scope: "organisation", allStations: true, queueView: false });
    expect(canSeeProductionTicket(noPermission, grillTicket, stations)).toBe(false);
  });
});

describe("database contract", () => {
  const dir = "supabase/migrations";
  const sql = readdirSync(dir)
    .map((f) => readFileSync(`${dir}/${f}`, "utf8"))
    .join("\n");

  it("ships the station resolver and the additive production read policy", () => {
    expect(sql).toContain("neo_kitchen_visible_station_ids");
    expect(sql).toContain("station_tickets_production_read");
  });

  it("keeps the tenant and capability anchors on the read policy", () => {
    const policy = sql.slice(sql.indexOf("station_tickets_production_read"));
    expect(policy).toContain("organization_id = public.current_org_id()");
    expect(policy).toContain("has_permission('kitchen', 'queue', 'view')");
  });

  it("does not modify the protected send-to-kitchen RPC", () => {
    const migration = readFileSync(
      `${dir}/${readdirSync(dir).sort().at(-1)!}`,
      "utf8",
    );
    expect(migration).not.toContain("neo_pos_send_to_kitchen");
  });
});
