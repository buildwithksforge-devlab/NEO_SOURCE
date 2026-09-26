import { describe, expect, it } from "vitest";
import { addGrant } from "@/lib/permissions";
import { moduleFeatures } from "@/lib/capabilities";
import { compileRoleTemplate, ROLE_ACCESS_SCOPES } from "@/lib/role-templates";
import {
  resolveVisibility,
  scopeLevelFor,
  type VisibilityFacts,
} from "@/lib/visibility-contract";

const FEATURES = moduleFeatures();

function facts(partial: Partial<VisibilityFacts> = {}): VisibilityFacts {
  return {
    userId: "u1",
    accountType: "staff",
    accountStatus: "active",
    organizationId: "org1",
    accessScope: "self",
    branchIds: [],
    departmentIds: [],
    stationIds: [],
    grants: new Set<string>(),
    entitlements: {},
    setupComplete: true,
    ...partial,
  };
}

function grantsForRole(roleKey: string) {
  const set = new Set<string>();
  for (const g of compileRoleTemplate(roleKey, FEATURES)) addGrant(set, g.module, g.feature, g.action);
  return set;
}

function contractForRole(roleKey: string, extra: Partial<VisibilityFacts> = {}) {
  return resolveVisibility(
    facts({
      accessScope: ROLE_ACCESS_SCOPES[roleKey] ?? "self",
      grants: grantsForRole(roleKey),
      branchIds: ["b1"],
      departmentIds: ["d1"],
      stationIds: ["s1"],
      ...extra,
    }),
  );
}

describe("visibility contract — scope levels (L.1)", () => {
  it("never falls back to organisation-wide when assignments are missing", () => {
    expect(scopeLevelFor(facts({ accessScope: "branch", branchIds: [] }))).toBe("personal");
    expect(scopeLevelFor(facts({ accessScope: "department", departmentIds: [] }))).toBe("personal");
  });

  it("narrows a department account with only a station assignment to station scope", () => {
    expect(scopeLevelFor(facts({ accessScope: "department", stationIds: ["s1"] }))).toBe("station");
  });

  it("does not infer platform scope from organisation authority", () => {
    const owner = contractForRole("owner");
    expect(owner.level).toBe("organization");
    expect(owner.isPlatformAdmin).toBe(false);
  });
});

describe("visibility contract — selectors (L.2)", () => {
  it("hides All Properties from station and personal scoped users", () => {
    const waiter = contractForRole("waiter");
    expect(waiter.propertySelector().allowAll).toBe(false);
  });

  it("offers All Properties only at organisation scope", () => {
    expect(contractForRole("owner").propertySelector().allowAll).toBe(true);
  });

  it("reports Setup Incomplete rather than defaulting to everything", () => {
    const unassigned = resolveVisibility(facts({ accessScope: "self" }));
    expect(unassigned.propertySelector().setupIncomplete).toBe(true);
    expect(unassigned.propertySelector().allowAll).toBe(false);
  });
});

describe("visibility contract — records, tasks and notifications (L.17)", () => {
  const waiter = contractForRole("waiter", { departmentIds: [], branchIds: [], stationIds: ["s1"] });

  it("shows a line worker only their own or station records", () => {
    expect(waiter.canSeeRecord({ ownerUserId: "u1" })).toBe(true);
    expect(waiter.canSeeRecord({ ownerUserId: "u2", stationId: "s1" })).toBe(true);
    expect(waiter.canSeeRecord({ ownerUserId: "u2", stationId: "s9" })).toBe(false);
  });

  it("keeps same-level colleagues' personal work separate", () => {
    expect(waiter.canSeeRecord({ assignedUserId: "u2", departmentId: "d1" })).toBe(false);
  });

  it("lets a manager see a subordinate's work inside their own scope only", () => {
    const supervisor = contractForRole("housekeeping-supervisor", {
      subordinateUserIds: ["u2"],
      departmentIds: ["d1"],
    });
    expect(supervisor.canSeeRecord({ assignedUserId: "u2", departmentId: "d1" })).toBe(true);
    expect(supervisor.canSeeRecord({ assignedUserId: "u3", departmentId: "d9" })).toBe(false);
  });

  it("routes notifications by audience", () => {
    expect(waiter.receivesNotification({ audience: "personal", userId: "u1" })).toBe(true);
    expect(waiter.receivesNotification({ audience: "personal", userId: "u2" })).toBe(false);
    expect(waiter.receivesNotification({ audience: "station", stationId: "s1" })).toBe(true);
    expect(waiter.receivesNotification({ audience: "organization" })).toBe(false);
  });
});

describe("visibility contract — approvals (L.17)", () => {
  it("blocks self-approval even for an authorised approver", () => {
    const gm = contractForRole("operations-manager");
    expect(gm.canDecide("restaurant", "approvals", "someone-else")).toBe(true);
    expect(gm.canDecide("restaurant", "approvals", "u1")).toBe(false);
  });

  it("does not give a line role decision authority", () => {
    expect(contractForRole("waiter").canDecide("restaurant", "approvals", "u2")).toBe(false);
  });
});

describe("visibility contract — confidential figures (L.18)", () => {
  it("keeps payroll and profitability out of operational roles", () => {
    const chef = contractForRole("head-chef");
    expect(chef.canSeeCost("payroll")).toBe(false);
    expect(chef.canSeeCost("profitability")).toBe(false);
  });
});

describe("visibility contract — status gates", () => {
  it("grants nothing while the account is suspended or incomplete", () => {
    const suspended = resolveVisibility(
      facts({ accountStatus: "suspended", grants: grantsForRole("owner") }),
    );
    expect(suspended.status).toBe("suspended");
    expect(suspended.canSeePage("/users")).toBe(false);

    const incomplete = resolveVisibility(
      facts({ setupComplete: false, grants: grantsForRole("owner") }),
    );
    expect(incomplete.status).toBe("setup-incomplete");
    expect(incomplete.canSeePage("/finance")).toBe(false);
  });
});

describe("visibility contract — pages agree with grants (L.22)", () => {
  it("refuses every page a role was not granted, for every catalogue role", () => {
    for (const roleKey of Object.keys(ROLE_ACCESS_SCOPES)) {
      const contract = contractForRole(roleKey);
      expect(contract.canSeePage("/notifications")).toBe(true); // universal page
      if (roleKey !== "owner" && roleKey !== "it-system-administrator") {
        expect(contract.canSeePage("/platform/environments")).toBe(false);
      }
    }
  });
});
