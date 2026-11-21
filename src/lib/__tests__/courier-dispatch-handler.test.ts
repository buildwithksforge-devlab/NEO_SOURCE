import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const chain = {
      middleware: () => chain,
      inputValidator: () => chain,
      handler: (handler: unknown) => handler,
    };
    return chain;
  },
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("https://hotel.example", { headers: { host: "hotel.example" } }),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

const { dispatchCourierJob } = await import("../delivery-gateway.functions");
const handle = dispatchCourierJob as unknown as (input: {
  data: { jobId: string };
  context: { supabase: ReturnType<typeof dispatchFixture>["supabase"] };
}) => Promise<{ ok: boolean; reason?: string; state?: string }>;

function dispatchFixture(options: { branch?: string | null; environment?: string; saved?: boolean } = {}) {
  const job = {
    id: "dispatch",
    organization_id: "hotel",
    branch_id: options.branch === undefined ? "nairobi" : options.branch,
    provider_code: "courier_gateway",
    environment: "sandbox",
    state: "requested",
    callback_token: "fixture-token",
    request_payload: {},
  };
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: {
        enabled: true,
        status: "connected",
        environment: options.environment ?? "sandbox",
        configuration: { endpoint_url: "https://courier.example/dispatch" },
      },
      error: null,
    }),
  };
  const supabase = {
    from: (table: string) => table === "integration_connections" ? query : {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: job }) }) }),
    },
    rpc: vi.fn().mockResolvedValue({ data: { ok: options.saved ?? true, state: "sent" }, error: null }),
  };
  const fetch = vi.fn().mockResolvedValue(new Response('{"status":"pending"}'));
  vi.stubGlobal("fetch", fetch);
  return { supabase, query, fetch, dispatch: () => handle({ data: { jobId: job.id }, context: { supabase } }) };
}

describe("courier dispatch connection and saved state", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("limits the connection to the dispatch organisation, property and its workspace default", async () => {
    const { query, dispatch, fetch, supabase } = dispatchFixture();
    await expect(dispatch()).resolves.toMatchObject({ ok: true, state: "sent" });
    expect(query.eq).toHaveBeenCalledWith("organization_id", "hotel");
    expect(query.eq).toHaveBeenCalledWith("provider_code", "courier_gateway");
    expect(query.or).toHaveBeenCalledWith("branch_id.eq.nairobi,branch_id.is.null");
    expect(query.order).toHaveBeenCalledWith("branch_id", { ascending: true, nullsFirst: false });
    expect(fetch).toHaveBeenCalledWith("https://courier.example/dispatch", expect.objectContaining({ redirect: "error" }));
    expect(supabase.rpc).toHaveBeenCalledWith("neo_delivery_dispatch_mark_sent", expect.objectContaining({ _job: "dispatch" }));
  });

  it("uses a workspace-level connection only for an unassigned property", async () => {
    const { query, dispatch } = dispatchFixture({ branch: null });
    await dispatch();
    expect(query.is).toHaveBeenCalledWith("branch_id", null);
    expect(query.or).not.toHaveBeenCalled();
  });

  it("keeps a sandbox dispatch away from a connection switched to production", async () => {
    const { dispatch, fetch } = dispatchFixture({ environment: "production" });
    await expect(dispatch()).resolves.toMatchObject({ ok: false, reason: "provider_environment_changed" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires the saved status before reporting that the dispatch was sent", async () => {
    const { dispatch } = dispatchFixture({ saved: false });
    await expect(dispatch()).resolves.toMatchObject({ ok: false, reason: "courier_state_unconfirmed" });
  });
});
