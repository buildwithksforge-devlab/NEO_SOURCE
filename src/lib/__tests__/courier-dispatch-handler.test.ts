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
const { adminFrom } = vi.hoisted(() => ({ adminFrom: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: adminFrom } }));

const { dispatchCourierJob } = await import("../delivery-gateway.functions");
const handle = dispatchCourierJob as unknown as (input: {
  data: { jobId: string };
  context: { supabase: ReturnType<typeof dispatchFixture>["supabase"] };
}) => Promise<{ ok: boolean; reason?: string; state?: string }>;

function dispatchFixture(options: {
  branch?: string | null;
  environment?: string;
  saved?: boolean;
  claimError?: boolean;
  canDispatch?: boolean;
  branchInScope?: boolean;
} = {}) {
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
    rpc: vi.fn(async (name: string) => {
      if (name === "has_permission") return { data: options.canDispatch ?? true, error: null };
      if (name === "neo_branch_in_scope") return { data: options.branchInScope ?? true, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    }),
  };
  let claimed = false;
  adminFrom.mockReset().mockImplementation(() => ({
    update: vi.fn((values: { state?: string }) => {
      const update = {
        eq: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        maybeSingle: async () => {
          if (options.claimError) return { data: null, error: new Error("Database unavailable") };
          if (claimed) return { data: null, error: null };
          claimed = true;
          return { data: { id: job.id }, error: null };
        },
      };
      if (!values.state) Object.assign(update, { then: (resolve: (result: unknown) => void) =>
        resolve({ error: options.saved === false ? new Error("Database unavailable") : null }) });
      return update;
    }),
  }));
  const fetch = vi.fn().mockResolvedValue(new Response('{"status":"pending"}'));
  vi.stubGlobal("fetch", fetch);
  return { supabase, query, fetch, dispatch: () => handle({ data: { jobId: job.id }, context: { supabase } }) };
}

describe("courier dispatch connection and saved state", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("limits the connection to the dispatch organisation, property and its workspace default", async () => {
    const { query, dispatch, fetch } = dispatchFixture();
    await expect(dispatch()).resolves.toMatchObject({ ok: true, state: "sent" });
    expect(query.eq).toHaveBeenCalledWith("organization_id", "hotel");
    expect(query.eq).toHaveBeenCalledWith("provider_code", "courier_gateway");
    expect(query.or).toHaveBeenCalledWith("branch_id.eq.nairobi,branch_id.is.null");
    expect(query.order).toHaveBeenCalledWith("branch_id", { ascending: true, nullsFirst: false });
    expect(fetch).toHaveBeenCalledWith("https://courier.example/dispatch", expect.objectContaining({ redirect: "error" }));
    expect(fetch.mock.calls[0]?.[1].headers).toMatchObject({ "idempotency-key": "dispatch" });
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

  it.each([{ canDispatch: false }, { branchInScope: false }])(
    "blocks the external handoff without dispatch authority and property access",
    async (options) => {
      const { dispatch, fetch } = dispatchFixture(options);
      await expect(dispatch()).resolves.toMatchObject({ ok: false, reason: "dispatch_access_denied" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("requires the saved status before reporting that the dispatch was sent", async () => {
    const { dispatch } = dispatchFixture({ saved: false });
    await expect(dispatch()).resolves.toMatchObject({ ok: false, reason: "courier_state_unconfirmed" });
  });

  it("sends once when operators claim the same job concurrently", async () => {
    const { dispatch, fetch } = dispatchFixture();
    const results = await Promise.all([dispatch(), dispatch()]);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ ok: true, state: "sent" }),
      expect.objectContaining({ ok: false, reason: "dispatch_already_claimed" }),
    ]));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not contact the courier if the database cannot reserve the job", async () => {
    const { dispatch, fetch } = dispatchFixture({ claimError: true });
    await expect(dispatch()).resolves.toMatchObject({ ok: false, reason: "dispatch_claim_failed" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the original handoff open after a timeout and prevents a duplicate send", async () => {
    const { dispatch, fetch } = dispatchFixture();
    fetch.mockRejectedValueOnce(new Error("timed out"));
    await expect(dispatch()).resolves.toMatchObject({ ok: false, reason: "courier_confirmation_pending", state: "sent" });
    await expect(dispatch()).resolves.toMatchObject({ ok: false, reason: "dispatch_already_claimed" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
