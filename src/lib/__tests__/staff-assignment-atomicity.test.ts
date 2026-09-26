/**
 * Regression guard for the staff assignment write path.
 *
 * A station-only change once wiped an employee's role, because the write
 * deleted the role set, then failed on a later step with nothing to roll it
 * back. The whole assignment is now written by one database routine, so the
 * client must send the *complete* assignment on every save — never a partial
 * patch — and the directory must refresh from the same canonical keys.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const users = readFileSync(resolve(process.cwd(), "src/lib/users.functions.ts"), "utf8");
const screen = readFileSync(resolve(process.cwd(), "src/routes/_shell.users.tsx"), "utf8");

describe("staff assignment save", () => {
  it("writes property, department, roles and station through one atomic routine", () => {
    expect(users).toContain("neo_staff_assignment_save");
    for (const arg of ["_branch:", "_department:", "_role_ids:", "_station:"]) {
      expect(users).toContain(arg);
    }
  });

  it("no longer deletes role, branch, department or station rows one by one", () => {
    const assignment = users.slice(
      users.indexOf("export const updateStaffAssignment"),
      users.indexOf("export const resetStaffPassword"),
    );
    for (const table of ["user_roles", "user_branches", "user_departments", "user_stations"]) {
      expect(assignment).not.toContain(`.from("${table}")`);
    }
  });

  it("validates the reporting line before anything is written", () => {
    const assignment = users.slice(
      users.indexOf("export const updateStaffAssignment"),
      users.indexOf("export const resetStaffPassword"),
    );
    expect(assignment.indexOf("neo_reporting_candidates")).toBeLessThan(
      assignment.indexOf("neo_staff_assignment_save"),
    );
  });

  it("refreshes the directory with the same keys the directory reads", () => {
    // The lists are keyed ["profiles", organizationId, filterKey]; invalidating
    // with ["profiles", filterKey] matched nothing, so the saved role kept
    // showing as "—".
    expect(screen).not.toMatch(/invalidateQueries\(\{ queryKey: \["[a-z_-]+", filterKey\] \}\)/);
    for (const key of ["profiles", "user-roles", "user-stations"]) {
      expect(screen).toContain(`invalidateQueries({ queryKey: ["${key}"] })`);
    }
  });
});
