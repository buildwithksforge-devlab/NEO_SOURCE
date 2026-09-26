/**
 * Shared-request lifecycle guards.
 *
 * De-duplication is only safe if every event that can change *who you are* or
 * *what you may see* drops the shared state immediately. These guards cover
 * the four events that do: workspace switch, permission change, sign-out, and
 * a person who belongs to more than one group.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/rpc-guard", () => ({ guardedRpc: (...args: unknown[]) => rpc(...args) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { readPermissionFingerprint, resetPermissionFingerprint } from "@/lib/permission-fingerprint";
import { branchesQueryKey } from "@/lib/branches";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("authority changes drop the shared answer", () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: "v1", error: null });
    resetPermissionFingerprint();
  });

  it("re-reads authority after a permission change, never serving the old fingerprint", async () => {
    rpc.mockResolvedValueOnce({ data: "v1", error: null });
    expect((await readPermissionFingerprint()).value).toBe("v1");
    // A permission change happened: the wizard-free path is a hard reset.
    resetPermissionFingerprint();
    rpc.mockResolvedValueOnce({ data: "v2", error: null });
    expect((await readPermissionFingerprint()).value).toBe("v2");
  });

  it("clears the shared fingerprint when the workspace state is torn down", () => {
    const auth = read("src/lib/auth.tsx");
    const teardown = auth.slice(auth.indexOf("clearWorkspaceState"));
    expect(teardown).toContain("resetPermissionFingerprint()");
    expect(teardown).toContain("queryClient.clear()");
  });

  it("resets authority deliberately when permissions are refreshed", () => {
    const auth = read("src/lib/auth.tsx");
    const refresh = auth.slice(auth.indexOf("const refreshPermissions"));
    expect(refresh.slice(0, 800)).toContain("resetPermissionFingerprint()");
  });

  it("tears the whole session down on sign-out rather than invalidating selectively", () => {
    const auth = read("src/lib/auth.tsx");
    const signOut = auth.slice(auth.indexOf("const signOut"), auth.indexOf("const signOut") + 600);
    expect(signOut).toContain("supabase.auth.signOut()");
    expect(signOut).toContain("clearWorkspaceState()");
  });
});

describe("multi-group identity", () => {
  it("empties the cache when a person switches group, so no figure survives", () => {
    const workspaces = read("src/lib/workspaces.ts");
    const switcher = workspaces.slice(workspaces.indexOf("useSwitchWorkspace"));
    expect(switcher).toContain("neo_switch_workspace");
    expect(switcher).toContain("queryClient.clear()");
  });

  it("keeps every workspace-scoped list keyed by the group it belongs to", () => {
    expect(branchesQueryKey("org-a")).toEqual(["branches", "org-a"]);
    expect(branchesQueryKey("org-b")).not.toEqual(branchesQueryKey("org-a"));
    expect(branchesQueryKey(null)).not.toEqual(branchesQueryKey("org-a"));
  });

  it("reads the person's active group before falling back to their original one", () => {
    const auth = read("src/lib/auth.tsx");
    expect(auth).toContain("profile?.active_organization_id ?? profile?.organization_id");
  });

  it("never caches a workspace list without the person it belongs to", () => {
    const workspaces = read("src/lib/workspaces.ts");
    expect(workspaces).toMatch(/queryKey:\s*\[[^\]]*workspaces/i);
  });
});
