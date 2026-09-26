import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * Lifecycle completion contract.
 *
 * Every operation must be able to reach its real end state, and the workspace
 * must be able to see the ones that have not. The audit is read-only; the
 * finaliser only completes work that needs nothing but a posting or a missing
 * timestamp, and both are reachable from Operational Integrity.
 */
describe("lifecycle completion", () => {
  const hooks = read("src/lib/guard-violations.ts");
  const page = read("src/routes/admin.integrity.tsx");
  const manifest = read("src/lib/rpc-manifest.ts");

  it("exposes the audit and the finaliser as scoped hooks", () => {
    expect(hooks).toContain("export function useLifecycleAudit()");
    expect(hooks).toContain("export function useFinaliseLifecycles()");
    expect(hooks).toContain("neo_lifecycle_audit");
    expect(hooks).toContain("neo_lifecycle_finalise");
  });

  it("scopes both routines to the active property", () => {
    const audit = hooks.slice(hooks.indexOf("export function useLifecycleAudit()"));
    expect(audit).toContain("useActivePropertyFilter()");
    expect(audit).toContain("_branch: branchId");
  });

  it("registers both routines in the RPC manifest", () => {
    expect(manifest).toContain('neo_lifecycle_audit: "authenticated"');
    expect(manifest).toContain('neo_lifecycle_finalise: "authenticated"');
  });

  it("surfaces lifecycle completion on Operational Integrity", () => {
    expect(page).toContain("useLifecycleAudit");
    expect(page).toContain("useFinaliseLifecycles");
    expect(page).toContain("Lifecycle completion");
    expect(page).toContain("Finalise completed work");
    expect(page).toContain("Unfinished operations");
  });

  it("refreshes the integrity views after finalising", () => {
    const finalise = hooks.slice(hooks.indexOf("export function useFinaliseLifecycles()"));
    expect(finalise).toContain('queryKey: ["integrity"]');
  });
});
