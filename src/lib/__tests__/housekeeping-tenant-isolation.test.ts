import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Housekeeping surfaces must never read across a tenant or a property.
 *
 * Every housekeeping read is keyed by the active organisation and branch and
 * filtered by the same branch, so switching property cannot serve a cached
 * answer from the previous one, and a query can never omit the filter while
 * still looking correct in the cache.
 */
const dept = readFileSync("src/lib/housekeeping-department.ts", "utf8");
const myWork = readFileSync("src/routes/_shell.housekeeping.my-work.tsx", "utf8");

// Read query keys only; the single-segment keys are cache invalidation prefixes.
const queryKeys = [...dept.matchAll(/queryKey:\s*\[([^\]]+)\]/g)]
  .map((m) => m[1] ?? "")
  .filter((key) => key.includes(","));

describe("housekeeping reads are scoped to the active tenant and property", () => {
  it("keys every housekeeping query by organisation and branch", () => {
    expect(queryKeys.length).toBeGreaterThan(0);
    for (const key of queryKeys) {
      expect(key, `query key must include the organisation: ${key}`).toContain("organizationId");
      expect(key, `query key must include the property: ${key}`).toContain("branchId");
    }
  });

  it("filters the personal job and task reads by branch and by the signed-in user", () => {
    expect(dept).toContain('q.eq("branch_id", branchId)');
    expect(dept).toContain('"assignee_id"');
    // Personal reads are never widened to a department-wide fetch.
    expect(dept).not.toMatch(/from\("housekeeping_jobs"\)[\s\S]{0,400}?\.limit\(\d+\)\s*;\s*\n\s*return/);
  });

  it("stamps writes with the active organisation and branch", () => {
    expect(dept).toContain("organization_id: organizationId");
    expect(dept).toContain("branch_id: branchId");
  });
});

describe("the personal work surface reads only the housekeeper's own jobs", () => {
  it("renders from the personal hooks, never from a department board query", () => {
    expect(myWork).toContain("useMyHousekeepingJobs");
    expect(myWork).toContain("useMyHousekeepingTasks");
    expect(myWork).not.toContain("useHousekeepingBoard");
    expect(myWork).not.toContain("useDepartmentJobs");
  });
});
