import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  rpc: vi.fn(),
  claim: vi.fn(),
  save: vi.fn(),
  push: vi.fn(),
  load: vi.fn(),
  preflight: vi.fn(),
}));
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
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: mock.claim,
    from: () => ({ update: () => ({ eq: () => ({ is: mock.save }) }) }),
  },
}));
vi.mock("@/lib/mpesa.server", () => ({
  loadMpesaCredentials: mock.load,
  normaliseMsisdn: () => "254712345678",
  stkPush: mock.push,
  verifyMpesaServerAccess: mock.preflight,
}));
import {
  chargeGuestFolioWithMpesa,
  chargeGuestDepositWithMpesa,
  chargeWithMpesa,
  chargeDeliveryWithMpesa,
} from "@/lib/mpesa.functions";

const context = {
  userId: "staff",
  supabase: {
    rpc: mock.rpc,
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { organization_id: "org" } }) }),
      }),
    }),
  },
};
type Result = { ok: boolean; status: string; reused?: boolean; detail: string };
type Handler = (input: {
  data: Record<string, unknown>;
  context: typeof context;
}) => Promise<Result>;
const guest = chargeGuestFolioWithMpesa as unknown as Handler;
const staff = chargeWithMpesa as unknown as Handler;
const deposit = chargeGuestDepositWithMpesa as unknown as Handler;
const delivery = chargeDeliveryWithMpesa as unknown as Handler;
const guestData = { organizationId: "org", folioId: "folio", msisdn: "0712345678", amount: 25 };
const staffData = {
  sourceModule: "folio",
  sourceRecordId: "folio",
  msisdn: "0712345678",
  amount: 25,
};

beforeEach(() => {
  vi.resetAllMocks();
  mock.rpc.mockResolvedValue({
    data: {
      transaction_id: "txn",
      organization_id: "org",
      amount: 25,
      account_reference: "FOLIO",
      reused: false,
    },
    error: null,
  });
  mock.claim.mockResolvedValue({ data: { claimed: true, status: "initiated" }, error: null });
  mock.save.mockResolvedValue({ error: null });
  mock.load.mockResolvedValue({
    organizationId: "org",
    enabled: true,
    callbackBaseUrl: "https://example.invalid",
    callbackToken: "synthetic-token",
  });
  mock.push.mockResolvedValue({
    ok: true,
    data: { CheckoutRequestID: "checkout", MerchantRequestID: "merchant", request: {} },
  });
});

describe("M-Pesa handler dispatch boundaries", () => {
  it.each([
    ["folio", guest, guestData],
    ["deposit", deposit, { organizationId: "org", reference: "RES-TEST", msisdn: "0712345678" }],
    ["delivery", delivery, { orderId: "order", msisdn: "0712345678" }],
  ] as const)(
    "does not reserve a guest %s balance when server preflight fails",
    async (_name, handler, data) => {
      mock.preflight.mockRejectedValueOnce(new Error("Invalid API key"));
      await expect(handler({ data, context })).rejects.toThrow("Invalid API key");
      expect(mock.rpc).not.toHaveBeenCalled();
      expect(mock.claim).not.toHaveBeenCalled();
      expect(mock.push).not.toHaveBeenCalled();
    },
  );
  it("creates no pending staff payment or provider request when the server key is rejected", async () => {
    mock.load.mockRejectedValueOnce(new Error("The app's Supabase server key is invalid."));
    await expect(staff({ data: staffData, context })).rejects.toThrow("server key is invalid");
    expect(mock.rpc).not.toHaveBeenCalled();
    expect(mock.claim).not.toHaveBeenCalled();
    expect(mock.push).not.toHaveBeenCalled();
  });
  it("claims before dispatching and records tracking after provider acceptance", async () => {
    expect(await guest({ data: guestData, context })).toMatchObject({
      ok: true,
      status: "pending",
    });
    expect(mock.claim).toHaveBeenCalledWith("neo_mpesa_claim_dispatch", {
      _transaction: "txn",
      _organization: "org",
    });
    expect(mock.claim.mock.invocationCallOrder[0]).toBeLessThan(
      mock.push.mock.invocationCallOrder[0]!,
    );
    expect(mock.push.mock.invocationCallOrder[0]).toBeLessThan(
      mock.save.mock.invocationCallOrder[0]!,
    );
  });
  it.each([
    ["guest", guest, guestData],
    ["staff", staff, staffData],
  ] as const)("does not dispatch a reused %s collection", async (_name, handler, data) => {
    mock.rpc.mockResolvedValue({
      data: { transaction_id: "txn", amount: 25, reused: true, status: "unknown" },
      error: null,
    });
    expect(await handler({ data, context })).toMatchObject({ status: "unknown", reused: true });
    expect(mock.push).not.toHaveBeenCalled();
    expect(mock.claim).not.toHaveBeenCalled();
  });
  it("sends no prompt if another request already claimed the transaction", async () => {
    mock.claim.mockResolvedValue({ data: { claimed: false, status: "pending" }, error: null });
    expect(await guest({ data: guestData, context })).toMatchObject({
      reused: true,
      status: "pending",
    });
    expect(mock.push).not.toHaveBeenCalled();
  });
  it("fails closed if the dispatch migration or server connection is unavailable", async () => {
    mock.claim.mockResolvedValue({ data: null, error: { message: "Missing RPC" } });
    expect(await guest({ data: guestData, context })).toMatchObject({
      ok: false,
      status: "dispatch-blocked",
    });
    expect(mock.push).not.toHaveBeenCalled();
  });
  it("does not report an accepted prompt as safely tracked when saving its identifiers fails", async () => {
    mock.save.mockResolvedValue({ error: { message: "Connection lost" } });
    const result = await guest({ data: guestData, context });
    expect(result).toMatchObject({ ok: true, status: "unknown" });
    expect(result.detail).toContain("Do not send another prompt");
    expect(mock.push).toHaveBeenCalledOnce();
  });
  it("does not reload credentials or dispatch a reused ambiguous deposit", async () => {
    mock.rpc.mockResolvedValue({
      data: { transaction_id: "txn", amount: 25, reused: true, status: "unknown" },
      error: null,
    });
    expect(
      await deposit({
        data: { organizationId: "org", reference: "RES-TEST", msisdn: "0712345678" },
        context,
      }),
    ).toMatchObject({ status: "unknown", reused: true });
    expect(mock.load).not.toHaveBeenCalled();
    expect(mock.push).not.toHaveBeenCalled();
  });
});
