/**
 * Front-line workers must be able to reach their own work.
 *
 * Both regressions here were found by walking real granted permissions role by
 * role: a provisioned rider could not open the rider workspace, and a
 * maintenance technician saw no maintenance screen at all because the surface
 * gate demanded a supervisor's work-order authority.
 */
import { describe, expect, it } from "vitest";
import { addGrant, canFromPermissions } from "@/lib/permissions";
import { navItemVisible } from "@/lib/nav-permissions";

function can(grants: Array<[string, string, string]>) {
  const set = new Set<string>();
  for (const [module, feature, action] of grants) addGrant(set, module, feature, action);
  return canFromPermissions(set);
}

const RIDER: Array<[string, string, string]> = [
  ["delivery", "orders", "view-own"],
  ["delivery", "rider.assignment", "view"],
  ["delivery", "rider", "pickup"],
  ["delivery", "rider", "proof"],
];

const TECHNICIAN: Array<[string, string, string]> = [
  ["maintenance", "my-jobs", "view"],
  ["maintenance", "my-jobs", "edit"],
  ["maintenance", "overview", "view"],
];

describe("worker access to their own surfaces", () => {
  it("a rider reaches the rider workspace", () => {
    expect(navItemVisible(can(RIDER), "/rider")).toBe(true);
  });

  it("a rider still cannot reach dispatch or delivery reports", () => {
    const riderCan = can(RIDER);
    expect(navItemVisible(riderCan, "/delivery/queue")).toBe(false);
    expect(navItemVisible(riderCan, "/delivery/reports")).toBe(false);
  });

  it("a technician reaches their maintenance jobs", () => {
    const techCan = can(TECHNICIAN);
    expect(navItemVisible(techCan, "/maintenance/my-jobs")).toBe(true);
    expect(navItemVisible(techCan, "/maintenance")).toBe(true);
  });

  it("someone who may only report a fault still gets no maintenance workspace", () => {
    const reporterCan = can([["maintenance", "requests", "create"]]);
    expect(navItemVisible(reporterCan, "/maintenance")).toBe(false);
    expect(navItemVisible(reporterCan, "/maintenance/my-jobs")).toBe(false);
  });
});
