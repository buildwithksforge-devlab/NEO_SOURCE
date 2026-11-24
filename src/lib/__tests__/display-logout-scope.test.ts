import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  signOut: vi.fn(),
  forget: vi.fn(),
  clearPin: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: { signOut: m.signOut } } }));
vi.mock("@/lib/continue-context", () => ({ forgetContext: m.forget }));
vi.mock("@/lib/staff-pin-login", () => ({
  clearStaffPinSession: m.clearPin,
  isStaffPinSession: () => false,
}));
import { neoSignOut } from "@/lib/session-exit";
beforeEach(() => {
  vi.clearAllMocks();
  m.signOut.mockResolvedValue({ error: null });
  vi.stubGlobal("window", { location: { replace: m.replace } });
});
afterEach(() => vi.unstubAllGlobals());
describe("shared-terminal logout scope", () => {
  it("exits only this browser while clearing its private cache and context", async () => {
    const client = { cancelQueries: vi.fn().mockResolvedValue(undefined), clear: vi.fn() };
    await neoSignOut(client as any, { to: "/auth", scope: "local" });
    expect(m.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(client.cancelQueries).toHaveBeenCalledOnce();
    expect(client.clear).toHaveBeenCalledOnce();
    expect(m.forget).toHaveBeenCalledOnce();
    expect(m.clearPin).toHaveBeenCalledOnce();
    expect(m.replace).toHaveBeenCalledWith("/auth");
  });
  it("preserves the existing default account logout behavior", async () => {
    await neoSignOut(null);
    expect(m.signOut).toHaveBeenCalledWith();
    expect(m.replace).toHaveBeenCalledWith("/");
  });
});
