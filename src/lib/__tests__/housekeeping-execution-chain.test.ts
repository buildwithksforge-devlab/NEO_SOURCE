/**
 * Block N — one authoritative housekeeping workflow.
 *
 * A housekeeper must be able to execute the clean assigned to them, and the
 * generic task that shadows a room clean must never be able to complete on its
 * own: only the housekeeping job closes the room.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { capabilitiesForPath } from "@/lib/capabilities";
import { ROLE_FEATURE_TEMPLATES, actionsForScope, ROLE_ACCESS_SCOPES } from "@/lib/role-templates";

const myWork = readFileSync("src/routes/_shell.housekeeping.my-work.tsx", "utf8");
const department = readFileSync("src/lib/housekeeping-department.ts", "utf8");

describe("housekeeper can execute their own clean", () => {
  it("templates the cleaning feature, not the department board", () => {
    const template = ROLE_FEATURE_TEMPLATES["housekeeper"]!;
    expect(template).toContain("housekeeping.cleaning");
    expect(template).toContain("housekeeping.my-work");
    expect(template).not.toContain("housekeeping.board");
    expect(template).not.toContain("housekeeping.tasks");
    expect(template).not.toContain("housekeeping.inspections");
  });

  it("keeps the housekeeper a line role — no approval authority", () => {
    const actions = actionsForScope(ROLE_ACCESS_SCOPES["housekeeper"]!);
    expect(actions).not.toContain("approve");
    expect(actions).not.toContain("delete");
  });

  it("lets the cleaning grant open the personal board", () => {
    const caps = capabilitiesForPath("/housekeeping/my-work");
    expect(
      caps.some((c) => c.module === "housekeeping" && c.feature === "cleaning"),
    ).toBe(true);
  });
});

describe("a task linked to a room clean is derived, never independent", () => {
  it("reads the job's task link", () => {
    expect(department).toContain("task_id");
  });

  it("hides start/complete on linked tasks and explains why", () => {
    expect(myWork).toContain("linkedJobByTask");
    expect(myWork).toContain('!linkedJob && taskStatus(task) === "open" && mayStart');
    expect(myWork).toContain('!linkedJob && taskStatus(task) === "in-progress" && mayComplete');
    expect(myWork).toContain("Follows room job");
  });
});
