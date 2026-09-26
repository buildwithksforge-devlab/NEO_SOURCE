import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({}), rpc: () => ({}) },
}));

import { bootPrefetchJobs } from "../boot-prefetch";
import { BRAND_BOOT_SCRIPT, BRAND_CACHE_KEY } from "../brand-cache";

describe("boot-gate prefetch", () => {
  it("warms the same cache entries the dashboard hooks read", () => {
    const keys = bootPrefetchJobs({ organizationId: "org-1", branchId: "branch-1" }).map((j) =>
      JSON.stringify(j.queryKey),
    );
    expect(keys).toContain(JSON.stringify(["my-dashboards"]));
    expect(keys).toContain(JSON.stringify(["dashboard-alerts", "branch-1"]));
    expect(keys).toContain(JSON.stringify(["dashboard-approvals", "branch-1", null]));
    expect(keys).toContain(JSON.stringify(["department-workload"]));
    expect(keys).toContain(JSON.stringify(["branches", "org-1"]));
    // The shell inbox already reads notifications on every route; prefetching
    // the dashboard panel copy duplicated that request on every page.
    expect(keys).not.toContain(JSON.stringify(["dashboard-notifications", "branch-1"]));
  });

  it("never prefetches tenant branches without a resolved organisation", () => {
    const keys = bootPrefetchJobs({ organizationId: null, branchId: null }).map((j) =>
      JSON.stringify(j.queryKey),
    );
    expect(keys.some((k) => k.includes("branches"))).toBe(false);
  });
});

describe("brand pre-paint cache", () => {
  it("reads the cached palette from the same key the provider writes", () => {
    expect(BRAND_BOOT_SCRIPT).toContain(JSON.stringify(BRAND_CACHE_KEY));
    expect(BRAND_BOOT_SCRIPT).toContain("--brand");
    expect(BRAND_BOOT_SCRIPT).toContain("--font-sans");
  });
});
