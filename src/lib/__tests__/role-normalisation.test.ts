import { describe, expect, it } from "vitest";
import {
  AMBIGUOUS_ROLE_NAMES,
  CATALOGUE_ROLES,
  canonicalRoleName,
  needsHumanDecision,
  resolveCatalogueRoleKey,
} from "@/lib/role-aliases";
import { dashboardKeyForRole } from "@/lib/workspace-preview";

describe("obvious role-name equivalents resolve automatically", () => {
  const cases: [string, string][] = [
    ["HR Manager", "Human Resources Manager"],
    ["hr manager", "Human Resources Manager"],
    ["Waitress", "Waiter / Waitress"],
    ["Hot Kitchen Chef", "Hot-Kitchen Chef"],
    ["FIinance Manager", "Finance Manager"],
    ["Events Manager", "Sales & Events Manager"],
    ["Front Office Manager", "Front Office Manager"],
    ["Front Office Supervisor", "Front Office Supervisor"],
    ["Housekeeping  Supervisor", "Housekeeping Manager"],
  ];

  it.each(cases)("%s → %s", (given, expected) => {
    expect(canonicalRoleName(given)).toBe(expected);
    expect(needsHumanDecision(given)).toBe(false);
  });

  it("keeps genuinely ambiguous titles as human decisions", () => {
    for (const name of AMBIGUOUS_ROLE_NAMES) {
      expect(resolveCatalogueRoleKey(name), `${name} should not be guessed`).toBeNull();
    }
  });

  it("never invents a catalogue role for an unknown title", () => {
    expect(resolveCatalogueRoleKey("Hotel Mascot")).toBeNull();
    expect(canonicalRoleName("Hotel Mascot")).toBe("Hotel Mascot");
  });

  it("is stable: every approved role resolves to itself", () => {
    for (const [key, name] of Object.entries(CATALOGUE_ROLES)) {
      expect(resolveCatalogueRoleKey(name)).toBe(key);
    }
  });
});

describe("dashboard routing stays consistent across refresh and login", () => {
  it("gives equivalent role names the same dashboard", () => {
    expect(dashboardKeyForRole("HR Manager")).toBe(dashboardKeyForRole("Human Resources Manager"));
    expect(dashboardKeyForRole("Waitress")).toBe(dashboardKeyForRole("Waiter / Waitress"));
    expect(dashboardKeyForRole("Events Manager")).toBe(
      dashboardKeyForRole("Sales and Events Manager"),
    );
  });

  it("resolves the Operations Manager dashboard deterministically", () => {
    const first = dashboardKeyForRole("Operations Manager");
    const again = dashboardKeyForRole("Operations Manager");
    expect(first).toBe("general-manager");
    expect(again).toBe(first);
  });

  it("returns a dashboard for every approved role", () => {
    for (const name of Object.values(CATALOGUE_ROLES)) {
      expect(dashboardKeyForRole(name)).toBeTruthy();
    }
  });
});
