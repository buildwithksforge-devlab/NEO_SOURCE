import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ from: vi.fn(), narrative: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder: any = {
      middleware: () => builder,
      inputValidator: () => builder,
      handler: (fn: any) => fn,
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mock.from } }));
vi.mock("@/lib/ai-assistant.server", () => ({ generateNarrative: mock.narrative }));
import { generateAiBrief } from "@/lib/automation.functions";
const context = { userId: "staff-a", supabase: { rpc: vi.fn(), from: vi.fn() } };
function query(data: unknown[], error: unknown = null) {
  const q: any = { select: () => q, eq: () => q, gte: () => Promise.resolve({ data, error }) };
  return q;
}
beforeEach(() => {
  vi.resetAllMocks();
  context.supabase.rpc.mockResolvedValue({ data: true });
  context.supabase.from.mockReturnValue({
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: { organization_id: "org-a" } }) }),
    }),
  });
  mock.from.mockImplementation(() => query([]));
  mock.narrative.mockResolvedValue({ status: "ok", provider: "local", text: "Recorded events: 0" });
});
describe("automation brief uses authorised real metrics with local-first summaries", () => {
  it("returns the local provider and supplies actual counts and tenant identity", async () => {
    mock.from.mockImplementation((table) =>
      query(table === "domain_events" ? [{ status: "failed" }, { status: "done" }] : []),
    );
    const result = await (generateAiBrief as any)({ context });
    expect(result).toMatchObject({
      configured: true,
      provider: "local",
      facts: { events: 2, failedEvents: 1 },
    });
    expect(mock.narrative).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.arrayContaining([{ label: "Recorded events", value: "2" }]),
      }),
      "org-a",
    );
  });
  it("does not generate a misleading zero summary when a source query fails", async () => {
    mock.from.mockImplementation(() => query([], { message: "read denied" }));
    await expect((generateAiBrief as any)({ context })).rejects.toThrow("could not be loaded");
    expect(mock.narrative).not.toHaveBeenCalled();
  });
  it("rejects users without permission before fetching privileged figures", async () => {
    context.supabase.rpc.mockResolvedValue({ data: false });
    await expect((generateAiBrief as any)({ context })).rejects.toThrow("permission");
    expect(mock.from).not.toHaveBeenCalled();
    expect(mock.narrative).not.toHaveBeenCalled();
  });
});
