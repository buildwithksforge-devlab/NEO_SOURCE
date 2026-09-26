import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: () => getSession() } },
}));

import {
  RpcAccessError,
  getRpcMetrics,
  invokeRpc,
  isPermissionDeniedError,
  requiredCallerFor,
  requiresReauthentication,
  resetRpcTelemetry,
  summariseRpcMetrics,
} from "@/lib/rpc-telemetry";

describe("rpc telemetry and session guard", () => {
  beforeEach(() => {
    resetRpcTelemetry();
    getSession.mockReset();
  });

  const signedIn = () => getSession.mockResolvedValue({ data: { session: { access_token: "t" } } });
  const anonymous = () => getSession.mockResolvedValue({ data: { session: null } });

  it("classifies permission denials from code and message", () => {
    expect(isPermissionDeniedError({ code: "42501", message: "x" })).toBe(true);
    expect(isPermissionDeniedError({ message: "permission denied for function my_effective_access" })).toBe(true);
    expect(isPermissionDeniedError({ code: "22P02", message: "invalid input syntax" })).toBe(false);
  });

  it("never dispatches an authenticated routine while anonymous", async () => {
    anonymous();
    const run = vi.fn();
    await expect(invokeRpc("neo_delivery_dispatch_candidates", run)).rejects.toBeInstanceOf(RpcAccessError);
    expect(run).not.toHaveBeenCalled();
    const [metric] = getRpcMetrics();
    expect(metric?.outcome).toBe("auth_required");
    expect(metric?.role).toBe("anon");
  });

  it("records the executing role on a successful call", async () => {
    signedIn();
    const rows = await invokeRpc<number[]>("my_effective_access", async () => ({ data: [1], error: null }));
    expect(rows).toEqual([1]);
    const [metric] = getRpcMetrics();
    expect(metric).toMatchObject({ rpc: "my_effective_access", role: "authenticated", outcome: "ok" });
  });

  it("surfaces a permission denial as a re-authentication requirement", async () => {
    signedIn();
    const error = { code: "42501", message: "permission denied for function neo_delivery_dispatch_candidates" };
    await expect(
      invokeRpc("neo_delivery_dispatch_candidates", async () => ({ data: null, error })),
    ).rejects.toSatisfy((e: unknown) => requiresReauthentication(e));
    expect(getRpcMetrics()[0]?.outcome).toBe("permission_denied");
  });

  it("keeps ordinary failures out of the re-authentication path", async () => {
    signedIn();
    await expect(
      invokeRpc("my_effective_access", async () => ({ data: null, error: { code: "22P02", message: "bad uuid" } })),
    ).rejects.toThrow("bad uuid");
    expect(requiresReauthentication(new Error("bad uuid"))).toBe(false);
    expect(getRpcMetrics()[0]?.outcome).toBe("error");
  });

  it("summarises calls per routine and executing role for monitoring", async () => {
    signedIn();
    await invokeRpc("my_effective_access", async () => ({ data: 1, error: null }));
    anonymous();
    await invokeRpc("my_effective_access", async () => ({ data: 1, error: null })).catch(() => null);
    const summary = summariseRpcMetrics();
    expect(summary).toHaveLength(2);
    expect(summary.find((r) => r.role === "anon")?.anonCalls).toBe(1);
    expect(summary.find((r) => r.role === "anon")?.failures).toBe(1);
  });

  it("treats both guarded routines as authenticated in the manifest", () => {
    expect(requiredCallerFor("my_effective_access")).toBe("authenticated");
    expect(requiredCallerFor("neo_delivery_dispatch_candidates")).toBe("authenticated");
  });
});
