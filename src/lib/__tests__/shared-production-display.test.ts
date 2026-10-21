// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), signOut: vi.fn(), getSession: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { signOut: mocks.signOut, getSession: mocks.getSession } },
}));
vi.mock("@/lib/rpc-guard", () => ({ guardedRpc: mocks.rpc }));
import {
  ensureSharedScreenSignedOut,
  actOnSharedDisplay,
  productionActions,
  pairSharedDisplay,
  DISPLAY_TOKEN_STORAGE_KEY,
} from "@/lib/shared-production-display";

describe("restricted shared display client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });
  it("signs out a supervisor who returns from controls before showing the shared screen", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "supervisor" } },
      error: null,
    });
    mocks.signOut.mockResolvedValue({ error: null });
    await ensureSharedScreenSignedOut();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
  it("refuses shared mode when the remaining supervisor session cannot sign out", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "supervisor" } },
      error: null,
    });
    mocks.signOut.mockResolvedValue({ error: new Error("failed") });
    await expect(ensureSharedScreenSignedOut()).rejects.toThrow("Sign out of the staff account");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("offers production work only, leaving service and cancellation outside the shared screen", () => {
    expect(productionActions("new")).toEqual(["accepted"]);
    expect(productionActions("accepted")).toEqual(["preparing"]);
    expect(productionActions("preparing")).toEqual(["ready"]);
    for (const state of ["ready", "served", "completed", "cancelled", "unknown"])
      expect(productionActions(state)).toEqual([]);
  });
  it("keeps the same request ID and expected status when retrying an uncertain network action", async () => {
    const action = {
      ticketId: "ticket",
      to: "accepted",
      expected: "new",
      requestId: "same-request",
      reason: "",
    };
    mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
    await actOnSharedDisplay("restricted-token", " scn-kit-005 ", "816294", action);
    await actOnSharedDisplay("restricted-token", "scn-kit-005", "816294", action);
    expect(mocks.rpc.mock.calls[0]?.[2]).toEqual(mocks.rpc.mock.calls[1]?.[2]);
    expect(mocks.rpc.mock.calls[0]?.[2]).toMatchObject({
      _request: "same-request",
      _expected: "new",
      _code: "SCN-KIT-005",
    });
    expect(sessionStorage.length).toBe(0);
  });
  it("removes a token and revokes the new screen if supervisor sign-out fails", async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: { ok: true, token: "restricted-token", session_id: "session" },
        error: null,
      })
      .mockResolvedValueOnce({ data: { ok: true }, error: null });
    mocks.signOut.mockResolvedValue({ error: new Error("Sign-out failed") });
    await expect(pairSharedDisplay("property", ["station"], "Kitchen", false)).rejects.toThrow(
      "Sign-out failed",
    );
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(sessionStorage.getItem(DISPLAY_TOKEN_STORAGE_KEY)).toBeNull();
    expect(mocks.rpc.mock.calls[1]?.[1]).toBe("neo_production_display_manage");
    expect(mocks.rpc.mock.calls[1]?.[2]).toEqual({ _close: "session" });
  });
  it("does not sign out or create local access if pairing is refused", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "Outside your station scope" } });
    await expect(
      pairSharedDisplay("other-property", ["station"], "Kitchen", false),
    ).rejects.toThrow("Outside your station scope");
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });
});
