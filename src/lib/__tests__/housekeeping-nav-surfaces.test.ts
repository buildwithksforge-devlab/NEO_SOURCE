import { describe, expect, it } from "vitest";
import { navigationForAccess, type CanFn } from "@/lib/nav-permissions";
import { addGrant, canFromPermissions } from "@/lib/permissions";
import { dashboardSpec } from "@/lib/dashboards";

/**
 * Phase 1B.1 — housekeeping navigation and dashboard surfaces.
 *
 * The grants below mirror the live role definitions exactly, so this test
 * fails the moment a neighbouring-module participation grant (raising a
 * requisition, reporting a fault, reading the room rack) drags a whole
 * foreign workspace back into a housekeeping sidebar.
 */
type Grant = [string, string, string];

function canFor(grants: Grant[]): CanFn {
  const set = new Set<string>();
  for (const [module, feature, action] of grants) addGrant(set, module, feature, action);
  return canFromPermissions(set);
}

/** Live Housekeeper role. */
const HOUSEKEEPER: Grant[] = [
  ["housekeeping", "*", "assigned.view"],
  ["housekeeping", "*", "cleaning.start"],
  ["housekeeping", "*", "cleaning.complete"],
  ["housekeeping", "*", "guest-requests.manage"],
  ["housekeeping", "*", "lost-found.report"],
  ["approvals", "*", "create"],
  ["approvals", "*", "view"],
  ["maintenance", "*", "work-orders.create"],
  ["stores", "*", "requisition.create"],
  ["stores", "*", "requisition.submit"],
  ["tasks", "*", "view"],
];

/** Live Housekeeping Manager role. */
const HOUSEKEEPING_MANAGER: Grant[] = [
  ["housekeeping", "*", "view"],
  ["housekeeping", "*", "edit"],
  ["housekeeping", "*", "create"],
  ["housekeeping", "*", "approve"],
  ["housekeeping", "*", "assign"],
  ["housekeeping", "*", "assigned.view"],
  ["housekeeping", "board", "view"],
  ["housekeeping", "overview", "view"],
  ["housekeeping", "my-work", "view"],
  ["housekeeping", "lost-found", "view"],
  ["housekeeping", "reports", "view"],
  ["housekeeping", "requisitions", "create"],
  ["housekeeping", "tasks", "assign"],
  ["housekeeping", "*", "lost-found.manage"],
  ["housekeeping", "*", "room.ready"],
  ["laundry", "*", "view"],
  ["laundry", "overview", "view"],
  ["maintenance", "*", "work-orders.create"],
  ["maintenance", "overview", "view"],
  ["maintenance", "overview", "edit"],
  ["stores", "*", "view"],
  ["stores", "overview", "view"],
  ["stores", "issues", "view"],
  ["stores", "*", "requisition.create"],
  ["stores", "*", "requisition.view-all"],
  ["front-office", "rack", "view"],
  ["pms", "*", "rooms.view"],
  ["pms", "*", "availability.view"],
  ["pms", "*", "dashboard.view"],
];

/** Live Storekeeper role (used for the multi-role union case). */
const STOREKEEPER: Grant[] = [
  ["stores", "*", "view"],
  ["stores", "*", "edit"],
  ["stores", "overview", "edit"],
  ["stores", "issues", "edit"],
];

const labels = (can: CanFn) =>
  navigationForAccess(can, false, true).flatMap((g) => g.items.map((i) => i.label));

describe("housekeeper primary navigation", () => {
  const nav = labels(canFor(HOUSEKEEPER));

  it("keeps the personal housekeeping surface", () => {
    expect(nav).toContain("My Housekeeping Work");
    expect(nav).toContain("Tasks");
    expect(nav).toContain("Notifications");
  });

  it("excludes manager, stores, procurement and maintenance workspaces", () => {
    for (const hidden of [
      "Housekeeping",
      "Lost & Found",
      "Approvals",
      "Inventory & Stores",
      "Department Requests",
      "Stock Counts",
      "Stores Tasks",
      "Store Issues",
      "Procurement",
      "Purchase Requests",
      "Goods Receiving",
      "Maintenance",
      "Laundry",
      "Reports & BI",
      "Room Rack",
    ]) {
      expect(nav, `${hidden} must not appear for an ordinary housekeeper`).not.toContain(hidden);
    }
  });
});

describe("housekeeping manager primary navigation", () => {
  const nav = labels(canFor(HOUSEKEEPING_MANAGER));

  it("keeps the housekeeping management surfaces", () => {
    for (const shown of [
      "Housekeeping",
      "My Housekeeping Work",
      "Lost & Found",
      "Laundry",
      "Tasks",
      "Notifications",
      "Approvals",
    ]) {
      expect(nav, `${shown} must be available to a housekeeping manager`).toContain(shown);
    }
  });

  it("excludes neighbouring modules reached only through participation grants", () => {
    for (const hidden of [
      "Front Office",
      "Room Rack",
      "Rooms & Types",
      "Availability",
      "Inventory & Stores",
      "Store Issues",
      "Stock Counts",
      "Procurement",
      "Maintenance",
      "Grounds & Landscaping",
      "Assets & Equipment",
    ]) {
      expect(nav, `${hidden} must not appear for a housekeeping manager`).not.toContain(hidden);
    }
  });
});

describe("multi-role users keep the union of their legitimate surfaces", () => {
  const nav = labels(canFor([...HOUSEKEEPER, ...STOREKEEPER]));

  it("adds the stores workspace without losing the personal housekeeping surface", () => {
    expect(nav).toContain("My Housekeeping Work");
    expect(nav).toContain("Inventory & Stores");
  });
});

describe("housekeeping dashboard surfaces follow the same capabilities", () => {
  const spec = dashboardSpec("housekeeping");
  const permitted = (can: CanFn) => (w: { requires?: { module: string; feature: string; action: string } }) =>
    !w.requires || can(w.requires.module, w.requires.feature, w.requires.action);

  it("omits department-wide figures and allocation actions for a housekeeper", () => {
    const can = canFor(HOUSEKEEPER);
    const widgets = spec.widgets.filter(permitted(can)).map((w) => w.id);
    const actions = spec.quickActions.filter(permitted(can)).map((a) => a.label);

    expect(widgets).not.toContain("dirty-rooms");
    expect(widgets).not.toContain("unassigned");
    expect(widgets).not.toContain("team-tasks");
    expect(widgets).toContain("my-jobs");
    expect(widgets).toContain("my-tasks");

    expect(actions).not.toContain("Assign cleaner");
    expect(actions).not.toContain("Request supplies");
    expect(actions).not.toContain("Housekeeping workspace");
    expect(actions).toContain("My housekeeping work");
    expect(actions).toContain("Start cleaning task");
    // The register itself is supervisory; the housekeeper reports from My Work.
    expect(actions).not.toContain("Lost and found");
  });

  it("keeps the departmental figures and allocation actions for the manager", () => {
    const can = canFor(HOUSEKEEPING_MANAGER);
    const widgets = spec.widgets.filter(permitted(can)).map((w) => w.id);
    const actions = spec.quickActions.filter(permitted(can)).map((a) => a.label);

    expect(widgets).toContain("dirty-rooms");
    expect(widgets).toContain("unassigned");
    expect(widgets).toContain("team-tasks");
    expect(widgets).toContain("my-jobs");
    expect(actions).toContain("Assign cleaner");
    expect(actions).toContain("Request supplies");
    expect(actions).toContain("Housekeeping workspace");
  });

  it("every gated widget names a real housekeeping capability", () => {
    for (const w of spec.widgets) {
      if (!w.requires) continue;
      expect(w.requires.module).toBe("housekeeping");
      expect(w.requires.feature).not.toBe("*");
    }
  });
});
