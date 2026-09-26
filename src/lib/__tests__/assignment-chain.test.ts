import { describe, expect, it } from "vitest";
import {
  RECORD_SCOPE_LABELS,
  recordScopeForRoles,
  roleKeysOf,
  requiresReportingManager,
  requiresStation,
  resolveAssignmentChain,
} from "../assignment-chain";

const base = {
  organizationId: "org-1",
  branchIds: ["branch-1"],
  departmentIds: ["dept-1"],
  stationIds: [] as string[],
  reportingManagerId: null as string | null,
};

describe("permanent assignment chain", () => {
  it("keeps a station-bound role inactive until a station is assigned", () => {
    const chain = resolveAssignmentChain({
      ...base,
      roleNames: ["Waiter"],
      reportingManagerId: "mgr-1",
    });
    expect(chain.operationallyActive).toBe(false);
    expect(chain.missing.map((m) => m.key)).toContain("station");
  });

  it("activates the same role once every required link exists", () => {
    const chain = resolveAssignmentChain({
      ...base,
      roleNames: ["Waiter"],
      stationIds: ["station-1"],
      reportingManagerId: "mgr-1",
    });
    expect(chain.operationallyActive).toBe(true);
    expect(chain.missing).toHaveLength(0);
    expect(chain.recordScope).toBe("station");
  });

  it("does not demand a station from a role that is not station-bound", () => {
    expect(requiresStation(roleKeysOf(["Restaurant Manager"]))).toBe(false);
    expect(requiresStation(roleKeysOf(["Barista"]))).toBe(true);
  });

  it("never requires a reporting manager above the top of the line", () => {
    expect(requiresReportingManager(roleKeysOf(["Owner"]))).toBe(false);
    expect(requiresReportingManager(roleKeysOf(["Operations Manager"]))).toBe(true);
  });

  it("resolves an owner to organisation-wide record scope with no property assigned", () => {
    const chain = resolveAssignmentChain({
      organizationId: "org-1",
      branchIds: [],
      departmentIds: [],
      stationIds: [],
      roleNames: ["Owner"],
      reportingManagerId: null,
    });
    expect(chain.recordScope).toBe("organization");
    expect(chain.operationallyActive).toBe(true);
  });

  it("reports no account before an organisation exists", () => {
    const chain = resolveAssignmentChain({
      ...base,
      organizationId: null,
      roleNames: ["Waiter"],
    });
    expect(chain.operationallyActive).toBe(false);
    expect(chain.missing.map((m) => m.key)).toContain("organisation");
  });

  it("narrows record scope by role, never by job title text", () => {
    expect(recordScopeForRoles(roleKeysOf(["Operations Manager"]))).toBe("property");
    expect(recordScopeForRoles(roleKeysOf(["Housekeeping Manager"]))).toBe("department");
    expect(recordScopeForRoles(roleKeysOf(["Unrecognised Title"]))).toBeNull();
    expect(RECORD_SCOPE_LABELS.personal).toMatch(/own assignments/i);
  });

  it("exposes every one of the seven chain steps", () => {
    const chain = resolveAssignmentChain({ ...base, roleNames: ["Waiter"] });
    expect(chain.steps.map((s) => s.key)).toEqual([
      "organisation",
      "property",
      "department",
      "role",
      "station",
      "reporting-manager",
      "record-scope",
    ]);
  });
});
