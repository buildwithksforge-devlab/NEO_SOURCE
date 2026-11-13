import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ load: vi.fn(), token: vi.fn(), query: vi.fn(), apply: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder = {
      middleware: () => builder,
      inputValidator: () => builder,
      handler: (fn: unknown) => fn,
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/mpesa.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mpesa.server")>()),
  loadMpesaCredentials: mock.load,
  darajaToken: mock.token,
  stkQuery: mock.query,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: mock.apply,
    from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }),
  },
}));

import { reconcileMpesaTransaction, testMpesaConnection } from "@/lib/mpesa.functions";

const rpc = vi.fn();
const maybeSingle = vi.fn();
const context = {
  userId: "staff",
  supabase: {
    rpc,
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  },
};
type Result = { ok: boolean; status: string; detail: string };
type TestHandler = (input: {
  data: { environment: string; consumerKey: string | null; consumerSecret: string | null };
  context: typeof context;
}) => Promise<Result>;
const testConnection = testMpesaConnection as unknown as TestHandler;

beforeEach(() => {
  vi.resetAllMocks();
  rpc.mockResolvedValue({ data: { authorised: true, environment: "sandbox" }, error: null });
  maybeSingle.mockResolvedValue({ data: { organization_id: "org" }, error: null });
  mock.token.mockResolvedValue({ ok: true, data: "synthetic-token" });
  mock.load.mockResolvedValue({
    environment: "sandbox",
    consumerKey: "saved-key",
    consumerSecret: "saved-secret",
  });
});

describe("M-Pesa connection dependency boundaries", () => {
  it.each(["", null, undefined])(
    "does not apply status-query result %s as a successful payment",
    async (code) => {
      maybeSingle.mockResolvedValue({
        data: {
          source_module: "pos_order",
          organization_id: "org",
          checkout_request_id: "checkout",
        },
      });
      rpc.mockResolvedValue({ data: true, error: null });
      mock.query.mockResolvedValue({ ok: true, data: { ResultCode: code } });
      const reconcile = reconcileMpesaTransaction as unknown as (input: {
        data: { transactionId: string };
        context: typeof context;
      }) => Promise<Result>;
      expect(await reconcile({ data: { transactionId: "txn" }, context })).toMatchObject({
        ok: false,
        status: "unknown",
      });
      expect(mock.apply).not.toHaveBeenCalled();
    },
  );

  it("applies an explicit successful provider status to the selected transaction", async () => {
    maybeSingle.mockResolvedValue({
      data: { source_module: "pos_order", organization_id: "org", checkout_request_id: "checkout" },
    });
    rpc.mockResolvedValue({ data: true, error: null });
    mock.query.mockResolvedValue({ ok: true, data: { ResultCode: "0", ResultDesc: "Confirmed" } });
    mock.apply.mockResolvedValue({ data: { applied: true, status: "success" }, error: null });
    const reconcile = reconcileMpesaTransaction as unknown as (input: {
      data: { transactionId: string };
      context: typeof context;
    }) => Promise<Result>;
    expect(await reconcile({ data: { transactionId: "txn" }, context })).toMatchObject({
      ok: true,
      status: "success",
    });
    expect(mock.apply).toHaveBeenCalledWith(
      "neo_mpesa_apply_result",
      expect.objectContaining({ _transaction: "txn", _result_code: 0, _source: "status-query" }),
    );
  });
  it.each([null, {}, {applied:false,reason:"not found"}, {ok:false,applied:true,status:"success"}])("does not report an unapplied database result as settled: %j",async(result)=>{
    maybeSingle.mockResolvedValue({data:{source_module:"pos_order",organization_id:"org",checkout_request_id:"checkout"}});
    rpc.mockResolvedValue({data:true,error:null}); mock.query.mockResolvedValue({ok:true,data:{ResultCode:"0"}}); mock.apply.mockResolvedValue({data:result,error:null});
    const run=reconcileMpesaTransaction as unknown as (input:any)=>Promise<Result>;expect(await run({data:{transactionId:"txn"},context})).toMatchObject({ok:false,status:"apply-failed"});
  });
  it("refuses a status query for a different checkout",async()=>{
    maybeSingle.mockResolvedValue({data:{source_module:"pos_order",organization_id:"org",checkout_request_id:"checkout"}});rpc.mockResolvedValue({data:true,error:null});mock.query.mockResolvedValue({ok:true,data:{ResultCode:"0",CheckoutRequestID:"other"}});
    const run=reconcileMpesaTransaction as unknown as (input:any)=>Promise<Result>;expect(await run({data:{transactionId:"txn"},context})).toMatchObject({ok:false,status:"verification-mismatch"});expect(mock.apply).not.toHaveBeenCalled();
  });
  it("tests complete drafts without reading saved secrets or changing saved verification", async () => {
    mock.load.mockRejectedValue(new Error("Invalid API key"));
    const result = await testConnection({
      data: { environment: "production", consumerKey: "draft-key", consumerSecret: "draft-secret" },
      context,
    });
    expect(result.ok).toBe(true);
    expect(mock.load).not.toHaveBeenCalled();
    expect(mock.token).toHaveBeenCalledWith({
      environment: "production",
      consumerKey: "draft-key",
      consumerSecret: "draft-secret",
    });
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain("neo_mpesa_record_check");
    expect(result.detail).toContain("did not save or change settings");
  });

  it("still loads and records verification when testing saved credentials", async () => {
    const result = await testConnection({
      data: { environment: "sandbox", consumerKey: null, consumerSecret: null },
      context,
    });
    expect(result.ok).toBe(true);
    expect(mock.load).toHaveBeenCalledWith("org");
    expect(rpc).toHaveBeenCalledWith(
      "neo_mpesa_record_check",
      expect.objectContaining({ _status: "ok" }),
    );
  });

  it("does not combine a partial draft with credentials from another environment", async () => {
    const result = await testConnection({
      data: { environment: "production", consumerKey: "draft-key", consumerSecret: null },
      context,
    });
    expect(result.status).toBe("credentials-required");
    expect(mock.token).not.toHaveBeenCalled();
  });

  it("requires administrator authority even for a complete draft", async () => {
    rpc.mockResolvedValue({ data: { authorised: false }, error: null });
    const result = await testConnection({
      data: { environment: "sandbox", consumerKey: "draft-key", consumerSecret: "draft-secret" },
      context,
    });
    expect(result.status).toBe("unauthorised");
    expect(mock.token).not.toHaveBeenCalled();
    expect(mock.load).not.toHaveBeenCalled();
  });

  it("does not claim a missing checkout reference proves the provider received nothing", async () => {
    maybeSingle.mockResolvedValue({
      data: { source_module: "pos_order", applied_at: null, checkout_request_id: null },
    });
    rpc.mockResolvedValue({ data: true, error: null });
    const reconcile = reconcileMpesaTransaction as unknown as (input: {
      data: { transactionId: string };
      context: typeof context;
    }) => Promise<Result>;
    const result = await reconcile({ data: { transactionId: "txn" }, context });
    expect(result.status).toBe("no-reference");
    expect(result.detail).toContain("Check the phone and Recent collections");
    expect(result.detail).not.toContain("never reached");
    expect(mock.query).not.toHaveBeenCalled();
    expect(mock.load).not.toHaveBeenCalled();
  });
});
