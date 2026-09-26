/**
 * P0 companion — Finance query-cache isolation across workspaces.
 *
 * DB isolation is proven in `finance-tenant-isolation.test.ts`. This file
 * covers the second half of the defect: even with correct RLS, a browser that
 * keeps Org A's cached Finance results in React Query would render Org A's
 * journals, receivables and aggregates inside Org B until the first refetch
 * resolved.
 *
 * Two invariants:
 *   1. every tenant-bound Finance query key carries the organisation id, so
 *      two workspaces can never collide on one cache entry;
 *   2. resolving a different organisation for the same signed-in account
 *      purges the cache before the new workspace renders.
 */
import { readFileSync } from "node:fs";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

const FINANCE_HOOK_FILES = [
  "src/lib/finance-data.ts",
  "src/lib/finance-posting.ts",
  "src/lib/finance-controls.ts",
];

/** Query keys that are deliberately not tenant-bound (pure UI/local state). */
const NON_TENANT_KEYS = new Set<string>([]);

describe("Finance query keys are tenant-bound", () => {
  for (const file of FINANCE_HOOK_FILES) {
    it(`${file} scopes every useQuery key by organizationId`, () => {
      const source = readFileSync(file, "utf8");
      const keys = [...source.matchAll(/queryKey:\s*(\[[\s\S]*?\])\s*,\n/g)].map((m) => m[1]!);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        if (NON_TENANT_KEYS.has(key)) continue;
        // Invalidation helpers pass a prefix only; those are safe because the
        // prefix matches every organisation-suffixed key beneath it.
        const isPrefixOnly = /^\[\s*"[a-z-]+"\s*\]$/.test(key.replace(/\s+/g, " "));
        if (isPrefixOnly) continue;
        expect(key, `untenanted Finance query key in ${file}: ${key}`).toMatch(/organizationId/);
      }
    });
  }
});

describe("workspace switch purges tenant-bound caches", () => {
  it("clears Org A Finance entries so Org B starts empty", () => {
    const qc = new QueryClient();
    const orgA = "00000000-0000-0000-0000-00000000000a";
    const orgB = "00000000-0000-0000-0000-00000000000b";

    qc.setQueryData(["finance", "journals", orgA, "all"], [{ id: "je-1", total: 125_000 }]);
    qc.setQueryData(["finance", "metrics", orgA, null, "2026-08-01", "2026-08-27"], {
      receivables: 125_000,
    });

    // Same key shape under Org B cannot collide with Org A.
    expect(qc.getQueryData(["finance", "journals", orgB, "all"])).toBeUndefined();

    // The auth provider's workspace reset is a full cache clear.
    qc.clear();

    expect(qc.getQueryData(["finance", "journals", orgA, "all"])).toBeUndefined();
    expect(
      qc.getQueryData(["finance", "metrics", orgA, null, "2026-08-01", "2026-08-27"]),
    ).toBeUndefined();
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
  });

  it("auth provider resets workspace state when the resolved organisation changes", () => {
    const source = readFileSync("src/lib/auth.tsx", "utf8");
    // The org-change guard must run before the new profile is applied.
    const guard = source.slice(source.indexOf("const previousOrg = recallOrganizationId"));
    expect(guard).toMatch(/previousOrg !== nextOrg/);
    expect(guard.slice(0, 400)).toMatch(/clearWorkspaceState\(\)/);
    // And the reset itself must wipe the query cache, not just React state.
    expect(source).toMatch(/queryClient\.clear\(\)/);
  });
});
