import { describe, expect, it } from "vitest";
import { resolveWorkHome } from "@/lib/work-home";

const canOnly =
  (...modules: string[]) =>
  (module: string) =>
    modules.includes(module);

describe("canonical work home", () => {
  it("sends oversight scopes to their dashboard", () => {
    for (const accessScope of ["organisation", "branch", "technical"] as const) {
      expect(
        resolveWorkHome({ accessScope, dashboardKey: "owner", canModule: () => true }).route,
      ).toBe("/workspace");
    }
  });

  it("sends a single-department employee straight to their own work", () => {
    expect(
      resolveWorkHome({
        accessScope: "self",
        dashboardKey: "staff",
        canModule: canOnly("housekeeping"),
      }).route,
    ).toBe("/housekeeping/my-work");
  });

  it("sends an employee holding several modules to the shared work board", () => {
    expect(
      resolveWorkHome({
        accessScope: "team",
        dashboardKey: "staff",
        canModule: canOnly("kitchen", "pos"),
      }).route,
    ).toBe("/my-work");
  });

  it("never invents access for an employee holding no module entry", () => {
    expect(
      resolveWorkHome({ accessScope: "self", dashboardKey: null, canModule: () => false }).route,
    ).toBe("/my-work");
  });
});
