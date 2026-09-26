import { describe, it, expect } from "vitest";
import {
  TABLE_SCOPE_COLUMNS,
  hasSelfScope,
  selfScopeFilter,
} from "@/lib/data-scope";
import { resolveVisibility, applyRecordFilter, type VisibilityFacts } from "@/lib/visibility-contract";

const base = (over: Partial<VisibilityFacts>): VisibilityFacts => ({
  userId: "u-self",
  accountType: "staff",
  accountStatus: "active",
  organizationId: "org-1",
  accessScope: "self",
  branchIds: ["prop-a"],
  departmentIds: ["dep-fb"],
  stationIds: [],
  grants: new Set<string>(),
  entitlements: {},
  setupComplete: true,
  ...over,
});

/** Minimal Postgrest-shaped recorder so we can assert the exact filters sent. */
function recorder() {
  const calls: string[] = [];
  const q: Record<string, unknown> = {};
  q['eq'] = (c: string, v: unknown) => (calls.push(`eq:${c}=${String(v)}`), q);
  q['in'] = (c: string, v: readonly unknown[]) => (calls.push(`in:${c}=${v.join("|")}`), q);
  q['or'] = (f: string) => (calls.push(`or:${f}`), q);
  return { q, calls };
}

describe("self scope — peers are invisible", () => {
  it("narrows a waiter to their own POS bills", () => {
    const filter = resolveVisibility(base({})).recordFilter();
    expect(filter.level).toBe("personal");
    expect(selfScopeFilter("pos_orders", filter.userIds)).toBe(
      "waiter_id.eq.u-self,created_by.eq.u-self",
    );
  });

  it("hides a peer's order and job even in the same property and department", () => {
    const v = resolveVisibility(base({}));
    const peer = { organizationId: "org-1", branchId: "prop-a", departmentId: "dep-fb" };
    expect(v.canSeeRecord({ ...peer, assignedUserId: "u-peer" })).toBe(false);
    expect(v.canSeeRecord({ ...peer, assignedUserId: "u-self" })).toBe(true);
  });

  it("covers every line-staff work surface", () => {
    for (const t of [
      "pos_orders",
      "housekeeping_jobs",
      "guest_laundry_orders",
      "delivery_orders",
      "rider_shifts",
      "maintenance_work_orders",
      "station_tickets",
      "tasks",
      "attendance_records",
      "leave_requests",
    ])
      expect(hasSelfScope(t)).toBe(true);
  });
});

describe("department scope — team inside one property", () => {
  const facts = base({ accessScope: "department", departmentIds: ["dep-fb"] });

  it("sees a team member's row but not another department's", () => {
    const v = resolveVisibility(facts);
    expect(v.level).toBe("department");
    expect(
      v.canSeeRecord({
        organizationId: "org-1",
        branchId: "prop-a",
        departmentId: "dep-fb",
        assignedUserId: "u-peer",
      }),
    ).toBe(true);
    expect(
      v.canSeeRecord({
        organizationId: "org-1",
        branchId: "prop-a",
        departmentId: "dep-housekeeping",
        assignedUserId: "u-peer",
      }),
    ).toBe(false);
  });

  it("stops at the property boundary even for its own department id", () => {
    const v = resolveVisibility(facts);
    expect(
      v.canSeeRecord({
        organizationId: "org-1",
        branchId: "prop-b",
        departmentId: "dep-fb",
        assignedUserId: "u-peer",
      }),
    ).toBe(false);
  });

  it("applies branch before department in the query filter", () => {
    const { q, calls } = recorder();
    applyRecordFilter(q as never, resolveVisibility(facts).recordFilter(), {
      organization: "organization_id",
      branch: "branch_id",
      department: "department_id",
    });
    expect(calls).toEqual([
      "eq:organization_id=org-1",
      "in:branch_id=prop-a",
      "in:department_id=dep-fb",
    ]);
  });
});

describe("organisation scope — Owner and System Administration", () => {
  it("is unbounded by property or department", () => {
    for (const scope of ["organization", "technical"]) {
      const v = resolveVisibility(base({ accessScope: scope, branchIds: ["prop-a"] }));
      expect(
        v.canSeeRecord({
          organizationId: "org-1",
          branchId: "prop-z",
          departmentId: "dep-other",
          assignedUserId: "u-peer",
        }),
      ).toBe(true);
    }
  });

  it("never crosses the tenant boundary", () => {
    const v = resolveVisibility(base({ accessScope: "organization" }));
    expect(v.canSeeRecord({ organizationId: "org-2", branchId: "prop-a" })).toBe(false);
  });

  it("sends no property or department narrowing", () => {
    const { q, calls } = recorder();
    applyRecordFilter(q as never, resolveVisibility(base({ accessScope: "organization" })).recordFilter(), {
      organization: "organization_id",
      branch: "branch_id",
      department: "department_id",
    });
    expect(calls).toEqual(["eq:organization_id=org-1"]);
  });
});

describe("scope column map integrity", () => {
  it("declares a branch column for every scoped table", () => {
    for (const [table, cols] of Object.entries(TABLE_SCOPE_COLUMNS))
      expect(cols.branch, table).toBeTruthy();
  });

  it("never returns a self filter without a user", () => {
    expect(selfScopeFilter("pos_orders", [])).toBeNull();
    expect(selfScopeFilter("rooms", ["u-self"])).toBeNull();
  });
});
