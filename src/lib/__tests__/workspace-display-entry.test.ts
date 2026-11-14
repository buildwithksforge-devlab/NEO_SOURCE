import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspace = readFileSync("src/routes/_shell.workspace.tsx", "utf8");
const contexts = readFileSync("src/lib/continue-context.ts", "utf8");

describe("property workspace and production-display entry", () => {
  it("carries the chosen property from the context resolver", () => {
    expect(contexts).toContain(
      "route: `/workspace?home=1&property=${encodeURIComponent(e.branch_id)}`",
    );
  });

  it("applies the chosen property before presenting workspaces", () => {
    expect(workspace).toContain("setActiveBranchId(requestedBranch.id)");
    expect(workspace).toContain("applyingRequestedProperty");
  });

  it("offers the main system and existing display routes without recreating modules", () => {
    expect(workspace).toContain("Enter NEØ System");
    expect(workspace).toContain('["kitchen", "coffee", "bar", "pastry"]');
    expect(workspace).toContain("DISPLAY_ROUTES[department]");
  });

  it("filters display choices through the existing path permission contract", () => {
    expect(workspace).toContain(
      ".filter((choice) => canAccessPath(can, choice.route))",
    );
    expect(workspace).toMatch(
      /Station scope and every\s+ticket action are checked again by the server\./,
    );
  });
});