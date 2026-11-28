import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ narrative: vi.fn() }));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder: any = {
      middleware: () => builder,
      inputValidator: () => builder,
      handler: (handler: any) => handler,
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/ai-assistant.server", () => ({ generateNarrative: mocks.narrative }));

import { askAssistant } from "@/lib/ai-assistant.functions";

const propertyA = "11111111-1111-4111-8111-111111111111";
const propertyB = "22222222-2222-4222-8222-222222222222";

function session(scope: string, branches: string[]) {
  const insert = vi.fn().mockResolvedValue({ error: null });
  const rpc = vi.fn(async (name: string) => {
    switch (name) {
      case "has_permission":
        return { data: true, error: null };
      case "is_org_admin":
        return { data: false, error: null };
      case "current_access_scope":
        return { data: scope, error: null };
      case "current_branch_ids":
        return { data: branches, error: null };
      case "bi_kpis":
        return {
          data: { rooms: { sellable_rooms: 10, occupied_room_nights: 3, occupancy_rate: 30 } },
          error: null,
        };
      default:
        throw new Error(`Unexpected RPC: ${name}`);
    }
  });
  const from = vi.fn((name: string) =>
    name === "profiles"
      ? {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { organization_id: "org-a" } }) }),
          }),
        }
      : { insert },
  );
  return { rpc, from, context: { userId: "staff-a", supabase: { rpc, from } } };
}

const data = {
  question: "How many rooms are available tonight?",
  branchId: null,
  from: "2026-11-01",
  to: "2026-11-07",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.narrative.mockResolvedValue({
    text: "Reporting period: 2026-11-01 to 2026-11-07.",
    status: "ok",
    provider: "local",
    model: null,
  });
});

describe("AI assistant property scoping", () => {
  it.each(["organisation", "technical"])(
    "lets a %s-scoped staff user request organisation-wide figures",
    async (scope) => {
      const { context, rpc } = session(scope, []);
      const result = await (askAssistant as any)({ data, context });
      expect(result).toMatchObject({ refused: false, branchScoped: false, scope });
      expect(rpc).toHaveBeenCalledWith("bi_kpis", {
        _branch: null,
        _from: data.from,
        _to: data.to,
      });
    },
  );

  it("uses an assigned property for branch-scoped staff", async () => {
    const { context, rpc } = session("branch", [propertyA]);
    const result = await (askAssistant as any)({ data, context });
    expect(result).toMatchObject({ refused: false, branchScoped: true });
    expect(rpc).toHaveBeenCalledWith("bi_kpis", {
      _branch: propertyA,
      _from: data.from,
      _to: data.to,
    });
  });

  it("refuses another property before reading metrics or calling a provider", async () => {
    const { context, rpc } = session("branch", [propertyA]);
    const result = await (askAssistant as any)({
      data: { ...data, branchId: propertyB },
      context,
    });
    expect(result).toMatchObject({ refused: true, classification: "refusal" });
    expect(rpc).not.toHaveBeenCalledWith("bi_kpis", expect.anything());
    expect(mocks.narrative).not.toHaveBeenCalled();
  });

  it("refuses staff without an assigned property", async () => {
    const { context, rpc } = session("branch", []);
    const result = await (askAssistant as any)({ data, context });
    expect(result).toMatchObject({ refused: true, classification: "refusal" });
    expect(rpc).not.toHaveBeenCalledWith("bi_kpis", expect.anything());
  });
});
