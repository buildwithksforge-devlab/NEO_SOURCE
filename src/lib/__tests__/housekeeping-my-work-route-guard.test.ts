import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ROUTE_CAPABILITY_ALTERNATIVES,
  capabilitiesForPath,
  pathPermitted,
} from "@/lib/capabilities";
import { navItemVisible } from "@/lib/nav-permissions";

/**
 * The live defect: the personal Housekeeping screen carried its own guard,
 * `housekeeping.my-work.view`, a key no Housekeeper role holds. The sidebar
 * offered the screen through `housekeeping.assigned.view`, so a housekeeper
 * clicked their own work and was refused. These tests read the real route
 * source so the stale key cannot quietly return.
 */

const ROUTE_PATH = "src/routes/_shell.housekeeping.my-work.tsx";
const source = readFileSync(ROUTE_PATH, "utf8");

const HOUSEKEEPER_GRANTS: Array<[string, string, string]> = [
  ["housekeeping", "*", "assigned.view"],
  ["housekeeping", "*", "cleaning.start"],
  ["housekeeping", "*", "cleaning.complete"],
];

function canFor(grants: Array<[string, string, string]>) {
  return (module: string, featureOrAction?: string, action?: string) => {
    const feature = action === undefined ? "*" : featureOrAction ?? "*";
    const act = action ?? featureOrAction ?? "view";
    return grants.some(
      ([m, f, a]) =>
        m === module &&
        (f === feature || f === "*") &&
        (a === act || a === `${feature}.${act}`),
    );
  };
}

describe("my-work route guard", () => {
  it("no longer contains the stale my-work.view permission key", () => {
    expect(source).not.toContain("my-work.view");
    expect(source).not.toContain('action="my-work.view"');
  });

  it("guards the route through the shared capability registry", () => {
    expect(source).toContain('<OpsGuard path="/housekeeping/my-work">');
  });

  it("resolves that path to the canonical assigned.view capability", () => {
    const primary = capabilitiesForPath("/housekeeping/my-work")[0];
    expect(primary).toMatchObject({ module: "housekeeping", feature: "assigned" });
    expect(primary?.action ?? "view").toBe("view");
  });

  it("lets a housekeeper holding only assigned.view both see and open the screen", () => {
    const can = canFor(HOUSEKEEPER_GRANTS);
    expect(navItemVisible(can, "/housekeeping/my-work")).toBe(true);
    expect(pathPermitted(can, "/housekeeping/my-work")).toBe(true);
  });

  it("keeps every in-page action gate precise", () => {
    expect(source).toContain('can("housekeeping", "cleaning", "start")');
    expect(source).toContain('can("housekeeping", "cleaning", "complete")');
    expect(source).toContain('can("maintenance", "work-orders", "create")');
    expect(source).toContain('can("housekeeping", "lost-found", "report")');
    // Reporting a supply need is a subordinate action, never Stores authority.
    expect(source).toContain('can("housekeeping", "supply-need", "report")');
    expect(source).not.toMatch(/can\("stores"/);
    expect(source).not.toContain("requisition.create");
    expect(source).not.toContain("requisition.submit");
  });

  it("reads only the signed-in user's own work", () => {
    expect(source).toContain("useMyHousekeepingJobs(true)");
    expect(source).toContain("useMyHousekeepingTasks()");
    expect(source).not.toContain("useHousekeepingBoard");
  });

  it("still records my-work.view only as a registry alternative, not a hard gate", () => {
    const alternatives = ROUTE_CAPABILITY_ALTERNATIVES["/housekeeping/my-work"] ?? [];
    const canWithoutAlternative = canFor(HOUSEKEEPER_GRANTS);
    expect(alternatives.length).toBeGreaterThanOrEqual(0);
    expect(pathPermitted(canWithoutAlternative, "/housekeeping/my-work")).toBe(true);
  });
});
