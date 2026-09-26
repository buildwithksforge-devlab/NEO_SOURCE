import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { capabilitiesForPath } from "@/lib/capabilities";
import { ROLE_FEATURE_TEMPLATES } from "@/lib/role-templates";

const myWork = readFileSync("src/routes/_shell.housekeeping.my-work.tsx", "utf8");
const register = readFileSync("src/routes/_shell.housekeeping.lost-found.tsx", "utf8");

describe("housekeeping lost & found authority split", () => {
  it("guards the central register on explicit manage authority only", () => {
    const caps = capabilitiesForPath("/housekeeping/lost-found");
    expect(caps[0]).toMatchObject({
      module: "housekeeping",
      feature: "lost-found",
      action: "manage",
    });
    expect(caps.map((c) => c.action).sort()).toEqual(["edit", "manage"]);
    expect(caps.some((c) => c.action === "report")).toBe(false);
  });

  it("routes the register page through the shared path guard", () => {
    expect(register).toContain('<OpsGuard path="/housekeeping/lost-found">');
    expect(register).not.toContain('<OpsGuard module="housekeeping">');
  });

  it("gives My Work a report-only action, never a link into the register", () => {
    expect(myWork).toContain('can("housekeeping", "lost-found", "report")');
    expect(myWork).not.toContain('"lost-found", "manage"');
    expect(myWork).not.toContain('to="/housekeeping/lost-found"');
  });

  it("keeps the register surface out of the ordinary housekeeper template", () => {
    expect(ROLE_FEATURE_TEMPLATES["housekeeper"]).not.toContain("housekeeping.lost-found");
    expect(ROLE_FEATURE_TEMPLATES["housekeeper"]).toContain("housekeeping.my-work");
  });
});
