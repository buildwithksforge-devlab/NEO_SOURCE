import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({}), rpc: () => ({}) },
}));

import { bootPrefetchJobs } from "../boot-prefetch";
import { myDashboardsQuery } from "../dashboard-data";
import { BRAND_BOOT_SCRIPT, BRAND_CACHE_KEY } from "../brand-cache";

describe("boot-gate prefetch", () => {
  it("warms the same cache entries the dashboard hooks read", () => {
    const keys = bootPrefetchJobs({ organizationId: "org-1", branchId: "branch-1", userId: "staff-1" }).map((j) =>
      JSON.stringify(j.queryKey),
    );
    expect(keys).toContain(JSON.stringify(myDashboardsQuery("org-1", "staff-1").queryKey));
    expect(keys).toContain(JSON.stringify(["dashboard-alerts", "branch-1"]));
    expect(keys).toContain(JSON.stringify(["dashboard-approvals", "branch-1", null]));
    expect(keys).toContain(JSON.stringify(["department-workload"]));
    expect(keys).toContain(JSON.stringify(["branches", "org-1"]));
    // The shell inbox already reads notifications on every route; prefetching
    // the dashboard panel copy duplicated that request on every page.
    expect(keys).not.toContain(JSON.stringify(["dashboard-notifications", "branch-1"]));
  });

  it("never prefetches tenant branches without a resolved organisation", () => {
    const keys = bootPrefetchJobs({ organizationId: null, branchId: null, userId: "staff-1" }).map((j) =>
      JSON.stringify(j.queryKey),
    );
    expect(keys.some((k) => k.includes("branches"))).toBe(false);
    expect(keys.some((k) => k.includes("my-dashboards"))).toBe(false);
  });

  it("keeps dashboard access cache entries distinct across staff and organisations", () => {
    const key = myDashboardsQuery("org-1", "staff-1").queryKey;
    expect(myDashboardsQuery("org-1", "staff-2").queryKey).not.toEqual(key);
    expect(myDashboardsQuery("org-2", "staff-1").queryKey).not.toEqual(key);
    expect(bootPrefetchJobs({ organizationId: "org-1", branchId: null, userId: null })
      .some((job) => job.queryKey[0] === "my-dashboards")).toBe(false);
  });
});

describe("brand pre-paint cache", () => {
  it("reads the cached palette from the same key the provider writes", () => {
    expect(BRAND_BOOT_SCRIPT).toContain(JSON.stringify(BRAND_CACHE_KEY));
    expect(BRAND_BOOT_SCRIPT).toContain("--brand");
    expect(BRAND_BOOT_SCRIPT).toContain("--font-sans");
  });
});
