import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ answer: vi.fn() }));
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
vi.mock("@/lib/intelligence-ask", () => ({ answerQuestion: mock.answer, answerFacts: vi.fn() }));

import { askNeo } from "@/lib/intelligence-ask.functions";

const branchId = "11111111-1111-4111-8111-111111111111";
const current = {
  authorised: true,
  generated_at: "2026-11-22T02:00:00Z",
  period: { from: "2026-11-01", to: "2026-11-07" },
};

beforeEach(() => {
  vi.resetAllMocks();
  mock.answer.mockImplementation((_question, { scope, prior }) => ({
    limitation: "No recorded value",
    scope,
    prior,
    evidence: [],
  }));
});

function client(payload: unknown = current, property: unknown = { name: "Savanna Crown Nairobi" }) {
  const rpc = vi.fn().mockResolvedValue({ data: payload, error: null });
  const maybeSingle = vi.fn().mockResolvedValue({ data: property });
  const from = vi.fn(() => ({
    select: () => ({ eq: () => ({ maybeSingle }) }),
  }));
  return { rpc, from, maybeSingle, context: { userId: "staff-a", supabase: { rpc, from } } };
}

describe("Ask NEØ answer provenance", () => {
  it("uses the scoped database property name instead of a browser-supplied label", async () => {
    const { context, from, rpc } = client();
    const result = await (askNeo as any)({
      data: { question: "What is our occupancy?", branchId, propertyLabel: "Different hotel", compare: false },
      context,
    });
    expect(result.answer.scope.propertyLabel).toBe("Savanna Crown Nairobi");
    expect(from).toHaveBeenCalledWith("branches");
    expect(rpc).toHaveBeenCalledWith("neo_intelligence", {
      _branch: branchId,
      _from: undefined,
      _to: undefined,
    });
  });

  it("uses a neutral label if the property name is unavailable", async () => {
    const { context } = client(current, null);
    const result = await (askNeo as any)({
      data: { question: "What is our occupancy?", branchId, propertyLabel: "Wrong name", compare: false },
      context,
    });
    expect(result.answer.scope.propertyLabel).toBe("Selected property");
  });

  it("does not query a property or compare periods after the RPC refuses access", async () => {
    const { context, rpc, from } = client({ authorised: false, reason: "property_out_of_scope" });
    await (askNeo as any)({
      data: { question: "What is our occupancy?", branchId, propertyLabel: "Wrong name", compare: true },
      context,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
    expect(mock.answer.mock.calls[0]?.[1].scope.propertyLabel).toBe("Selected property");
  });

  it("discards an unauthorised prior period rather than comparing it", async () => {
    const { context, rpc } = client();
    rpc.mockResolvedValueOnce({ data: current, error: null });
    rpc.mockResolvedValueOnce({ data: { authorised: false }, error: null });
    await (askNeo as any)({
      data: { question: "What changed?", branchId: null, compare: true },
      context,
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(mock.answer.mock.calls[0]?.[1].prior).toBeUndefined();
  });
});
