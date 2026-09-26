import { describe, expect, it } from "vitest";
import { canAccessPath, navigationForAccess, navItemVisible, type CanFn } from "@/lib/nav-permissions";
import { addGrant, canFromPermissions } from "@/lib/permissions";

/**
 * Housekeeper and Housekeeping Manager surfaces, asserted exactly.
 *
 * The nav assertions here are exhaustive (not "contains"), so any grant that
 * drags a neighbouring workspace into either sidebar fails immediately. The
 * route matrix asserts the same decision at the guard, so a hidden item can
 * never remain reachable through the URL bar and vice-versa.
 */
type Grant = [string, string, string];

function canFor(grants: Grant[]): CanFn {
  const set = new Set<string>();
  for (const [module, feature, action] of grants) addGrant(set, module, feature, action);
  return canFromPermissions(set);
}

const HOUSEKEEPER: Grant[] = [
  ["housekeeping", "*", "assigned.view"],
  ["housekeeping", "*", "cleaning.start"],
  ["housekeeping", "*", "cleaning.complete"],
  ["housekeeping", "*", "guest-requests.manage"],
  ["housekeeping", "*", "lost-found.report"],
  ["approvals", "*", "create"],
  ["approvals", "*", "view"],
  ["maintenance", "*", "work-orders.create"],
  ["housekeeping", "*", "supply-need.report"],
  ["tasks", "*", "view"],
];

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

const navFor = (grants: Grant[]) =>
  navigationForAccess(canFor(grants), false, true).flatMap((g) => g.items.map((i) => i.label));

/** Routes both roles are checked against, whether or not they are in the sidebar. */
const ROUTE_MATRIX = [
  "/housekeeping",
  "/housekeeping/my-work",
  "/housekeeping/board",
  "/housekeeping/inspections",
  "/housekeeping/lost-found",
  "/housekeeping/reports",
  "/housekeeping/requisitions",
  "/inventory",
  "/procurement",
  "/maintenance",
  "/pms",
  "/front-office",
] as const;

describe("housekeeper sidebar matches the visibility gates exactly", () => {
  const nav = navFor(HOUSEKEEPER);

  it("shows exactly the personal housekeeping surfaces", () => {
    expect([...nav].sort()).toEqual(
      // "My Work" is the universal personal list every staff account holds;
      // "My Housekeeping Work" is the department surface on top of it.
      ["Dashboard", "Guest Stays", "My Housekeeping Work", "My Work", "Notifications", "Tasks"].sort(),
    );
  });

  it("agrees with the route guard on every audited path", () => {
    const can = canFor(HOUSEKEEPER);
    const verdicts = Object.fromEntries(
      ROUTE_MATRIX.map((p) => [p, { route: canAccessPath(can, p), nav: navItemVisible(can, p) }]),
    );
    expect(verdicts["/housekeeping/my-work"]).toEqual({ route: true, nav: true });
    expect(verdicts["/housekeeping/lost-found"]).toEqual({ route: false, nav: false });
    for (const managerOnly of [
      "/housekeeping",
      "/housekeeping/board",
      "/housekeeping/inspections",
      "/housekeeping/reports",
      "/housekeeping/requisitions",
    ]) {
      expect(verdicts[managerOnly], `${managerOnly} is manager-only`).toEqual({
        route: false,
        nav: false,
      });
    }
    for (const foreign of ["/inventory", "/procurement", "/maintenance", "/pms", "/front-office"]) {
      expect(verdicts[foreign]?.nav, `${foreign} is not a housekeeper surface`).toBe(false);
    }
  });
});

describe("a nav-visible surface is always route-accessible", () => {
  /**
   * The regression this pins: the sidebar offered My Housekeeping Work through
   * `housekeeping.assigned.view` while the page guard demanded
   * `housekeeping.my-work.view`, so the housekeeper clicked their own surface
   * and was refused. Nav and guard now ask the shared registry the same
   * question, and this walks every route to prove it for both roles.
   */
  for (const [role, grants] of [
    ["housekeeper", HOUSEKEEPER],
    ["housekeeping manager", HOUSEKEEPING_MANAGER],
  ] as const) {
    it(`never shows ${role} a surface the route guard would deny`, () => {
      const can = canFor(grants);
      for (const path of ROUTE_MATRIX) {
        if (navItemVisible(can, path)) {
          expect(canAccessPath(can, path), `${path} is visible but denied`).toBe(true);
        }
      }
    });
  }

  it("opens /housekeeping/my-work for a housekeeper holding only assigned.view", () => {
    const minimal = canFor([
      ["housekeeping", "*", "assigned.view"],
      ["housekeeping", "*", "cleaning.start"],
      ["housekeeping", "*", "cleaning.complete"],
    ]);
    expect(canAccessPath(minimal, "/housekeeping/my-work")).toBe(true);
    expect(navItemVisible(minimal, "/housekeeping/my-work")).toBe(true);
    // …and still refuses every supervisory capability.
    expect(minimal("housekeeping", "board", "view")).toBe(false);
    expect(minimal("housekeeping", "tasks", "assign")).toBe(false);
    expect(minimal("housekeeping", "inspections", "create")).toBe(false);
    expect(minimal("housekeeping", "inspections", "approve")).toBe(false);
    expect(minimal("housekeeping", "room.ready")).toBe(false);
    expect(minimal("stores", "requisition.create")).toBe(false);
    expect(minimal("stores", "requisition.submit")).toBe(false);
  });
});

describe("housekeeping manager sidebar matches the visibility gates exactly", () => {
  const nav = navFor(HOUSEKEEPING_MANAGER);

  it("shows exactly the housekeeping management surfaces", () => {
    expect([...nav].sort()).toEqual(
      [
        "Approvals",
        "Cleaning History",
        "Dashboard",
        "Guest Stays",
        "Housekeeping",
        "Laundry",
        "Lost & Found",
        "My Housekeeping Work",
        "My Laundry Work",
        "My Work",
        "Notifications",
        "Station Stock",
        "Tasks",
      ].sort(),
    );
  });

  it("keeps the housekeeping routes open and the foreign workspaces out of the sidebar", () => {
    const can = canFor(HOUSEKEEPING_MANAGER);
    for (const hk of [
      "/housekeeping",
      "/housekeeping/my-work",
      "/housekeeping/board",
      "/housekeeping/inspections",
      "/housekeeping/lost-found",
    ]) {
      expect(canAccessPath(can, hk), `${hk} belongs to the manager`).toBe(true);
      expect(navItemVisible(can, hk)).toBe(true);
    }
    for (const foreign of ["/inventory", "/procurement", "/maintenance", "/pms", "/front-office"]) {
      expect(navItemVisible(can, foreign), `${foreign} must stay out of the sidebar`).toBe(false);
    }
  });
});

/**
 * Ordinary housekeepers hold no supervisory authority. These are the exact
 * powers the live role was narrowed to exclude: they report a need, they do not
 * raise or approve a store requisition, assign work, inspect, or mark rooms ready.
 */
describe("ordinary housekeeper holds no supervisory authority", () => {
  const can = canFor(HOUSEKEEPER);

  const forbidden: [string, string, string][] = [
    ["stores", "requisitions", "create"],
    ["stores", "requisitions", "submit"],
    ["stores", "issues", "view"],
    ["housekeeping", "tasks", "assign"],
    ["housekeeping", "rooms", "assign"],
    ["housekeeping", "rooms", "room.ready"],
    ["housekeeping", "inspections", "edit"],
    ["housekeeping", "lost-found", "manage"],
    ["approvals", "requests", "approve"],
  ];

  for (const [module, feature, action] of forbidden) {
    it(`cannot ${module}.${feature}.${action}`, () => {
      expect(can(module, feature, action)).toBe(false);
    });
  }

  const permitted: [string, string][] = [
    ["housekeeping", "assigned.view"],
    ["housekeeping", "cleaning.start"],
    ["housekeeping", "cleaning.complete"],
    ["housekeeping", "supply-need.report"],
    ["housekeeping", "lost-found.report"],
    ["maintenance", "work-orders.create"],
    ["approvals", "create"],
  ];

  for (const [module, action] of permitted) {
    it(`can ${module}.${action}`, () => {
      expect(can(module, action)).toBe(true);
    });
  }

  it("housekeeping manager retains the supervisory powers the housekeeper lacks", () => {
    const mgr = canFor(HOUSEKEEPING_MANAGER);
    expect(mgr("housekeeping", "tasks", "assign")).toBe(true);
    expect(mgr("housekeeping", "room.ready")).toBe(true);
    expect(mgr("housekeeping", "lost-found.manage")).toBe(true);
    expect(mgr("stores", "requisition.create")).toBe(true);
  });
});
