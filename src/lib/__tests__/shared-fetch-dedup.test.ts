/**
 * Guards for the shared workspace fetch contract.
 *
 * These lock in the de-duplication only — never a weakening of authority:
 * the shared fingerprint must be dropped the moment authority can change, the
 * property list must stay organisation-keyed, and module property pickers must
 * keep reading the one shared list instead of issuing their own query.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/rpc-guard", () => ({ guardedRpc: (...args: unknown[]) => rpc(...args) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  readPermissionFingerprint,
  resetPermissionFingerprint,
} from "@/lib/permission-fingerprint";
import { branchesQueryKey } from "@/lib/branches";

const src = (file: string) => readFileSync(join(process.cwd(), "src/lib", file), "utf8");

describe("shared permission fingerprint", () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: "v1", error: null });
    resetPermissionFingerprint();
  });

  it("shares one request between callers asking at the same time", async () => {
    const [a, b] = await Promise.all([
      readPermissionFingerprint(),
      readPermissionFingerprint(),
    ]);
    expect(a.value).toBe("v1");
    expect(b.value).toBe("v1");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("asks the database again once authority may have changed", async () => {
    await readPermissionFingerprint();
    resetPermissionFingerprint();
    await readPermissionFingerprint();
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("never remembers a failed answer", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "denied" } });
    const first = await readPermissionFingerprint();
    expect(first.error).toBeTruthy();
    await readPermissionFingerprint();
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});

describe("shared property list", () => {
  it("keys the property list by organisation", () => {
    expect(branchesQueryKey("org-a")).toEqual(["branches", "org-a"]);
    expect(branchesQueryKey("org-a")).not.toEqual(branchesQueryKey("org-b"));
  });

  it("keeps module property pickers on the shared list", () => {
    for (const file of [
      "pos-data.ts",
      "delivery-data.ts",
      "packages-data.ts",
      "analytics-data.ts",
    ]) {
      const text = src(file);
      expect(text).toMatch(/from "@\/lib\/branches"/);
      expect(text).not.toMatch(/from\("branches"\)/);
    }
  });

  it("drops the shared fingerprint whenever the workspace is cleared", () => {
    const auth = src("auth.tsx");
    expect(auth).toMatch(/resetPermissionFingerprint\(\)/);
    expect(auth).toMatch(/inflightContext\.current = null/);
  });
});
