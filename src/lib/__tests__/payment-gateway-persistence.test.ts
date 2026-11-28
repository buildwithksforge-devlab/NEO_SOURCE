import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn<() => Request | null>(() => null) }));

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
vi.mock("@tanstack/react-start/server", () => ({ getRequest: mocks.request }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

import { dispatchPaymentIntent } from "@/lib/payment-gateway.functions";

const intentId = "00000000-0000-4000-8000-000000000003";
const attempt = {
  id: "00000000-0000-4000-8000-000000000004",
  organization_id: "00000000-0000-4000-8000-000000000001",
  branch_id: "00000000-0000-4000-8000-000000000002",
  method: "qr",
  provider_code: "synthetic-qr",
  amount: 1500,
  currency: "KES",
  reference: "SYNTHETIC-ORDER",
  state: "requested",
  environment: "sandbox",
};
const connection = {
  enabled: true,
  status: "connected",
  environment: "sandbox",
  configuration: { endpoint_url: "https://provider.invalid/request" },
  secret_names: null,
};

function database(overrides: Record<string, { data: unknown; error: unknown }> = {}) {
  const rpc = vi.fn(
    async (name: string) =>
      overrides[name] ?? {
        data:
          name === "neo_payment_intent_claim_dispatch"
            ? { ok: true, claimed: true, state: "requested" }
            : name === "neo_payment_intent_set_provider_payload"
              ? { ok: true, attempt_id: attempt.id }
              : { ok: true, state: "pending" },
        error: null,
      },
  );
  const from = vi.fn((table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      or: () => chain,
      is: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({
        data: table === "payment_attempts" ? attempt : connection,
        error: null,
      }),
    };
    return chain;
  });
  return { rpc, from };
}

async function dispatch(supabase: ReturnType<typeof database>) {
  return (
    dispatchPaymentIntent as unknown as (args: unknown) => Promise<{
      ok: boolean;
      reason?: string;
      state?: string;
      qrPayload?: string | null;
    }>
  )({ data: { intentId }, context: { supabase } });
}

beforeEach(() => vi.stubEnv("PUBLIC_SITE_URL", "https://neo-preview.invalid"));
afterEach(() => {
  mocks.request.mockReset().mockReturnValue(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("provider dispatch persistence", () => {
  it("does not show an unsaved QR code when the state write fails", async () => {
    const supabase = database({
      neo_payment_intent_mark_sent: { data: null, error: { message: "synthetic write failure" } },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ status: "pending", qr_payload: "SYNTHETIC-QR" })),
    );
    expect(await dispatch(supabase)).toMatchObject({
      ok: false,
      reason: "dispatch_state_unrecorded",
      state: "pending",
    });
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      "neo_payment_intent_set_provider_payload",
      expect.anything(),
    );
  });

  it("does not return a QR code that could not be saved", async () => {
    const supabase = database({
      neo_payment_intent_set_provider_payload: { data: { ok: false }, error: null },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ status: "pending", qr_payload: "SYNTHETIC-QR" })),
    );
    const result = await dispatch(supabase);
    expect(result).toMatchObject({ ok: false, reason: "qr_payload_unrecorded", state: "pending" });
    expect(result).not.toHaveProperty("qrPayload");
  });

  it("does not return a QR code when a concurrent callback already closed the attempt", async () => {
    const supabase = database({
      neo_payment_intent_set_provider_payload: {
        data: { ok: true, reason: "not_open", state: "posted" },
        error: null,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ status: "pending", qr_payload: "SYNTHETIC-QR" })),
    );
    expect(await dispatch(supabase)).toMatchObject({
      ok: false,
      reason: "qr_payload_unrecorded",
      state: "pending",
    });
  });

  it("returns a QR code only after both writes succeed", async () => {
    const supabase = database();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ status: "pending", qr_payload: "SYNTHETIC-QR" })),
    );
    expect(await dispatch(supabase)).toMatchObject({
      ok: true,
      state: "pending",
      qrPayload: "SYNTHETIC-QR",
    });
    expect(supabase.rpc).toHaveBeenCalledWith(
      "neo_payment_intent_set_provider_payload",
      expect.objectContaining({ _intent: intentId }),
    );
  });

  it("uses the request URL for callbacks rather than a caller-supplied Origin header", async () => {
    vi.stubEnv("PUBLIC_SITE_URL", "");
    mocks.request.mockReturnValue(
      new Request("https://neo-preview.invalid/_serverFn/dispatch", {
        headers: { origin: "https://attacker.invalid", host: "attacker.invalid" },
      }),
    );
    const supabase = database();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ status: "pending" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await dispatch(supabase)).toMatchObject({ ok: true, state: "pending" });
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      callback_url: string;
    };
    expect(payload.callback_url).toMatch(
      /^https:\/\/neo-preview\.invalid\/api\/public\/payments\/callback\//,
    );
    expect(payload.callback_url).not.toContain("attacker.invalid");
  });

  it("keeps a rejected provider request uncertain when its failure cannot be saved", async () => {
    const supabase = database({
      neo_payment_intent_mark_sent: { data: { ok: false }, error: null },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Rejected", { status: 503 })));
    expect(await dispatch(supabase)).toMatchObject({
      ok: false,
      reason: "dispatch_state_unrecorded",
      state: "pending",
    });
  });

  it("keeps a transport failure uncertain when its state cannot be saved", async () => {
    const supabase = database({
      neo_payment_intent_mark_sent: { data: null, error: { message: "synthetic write failure" } },
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("synthetic network failure")));
    expect(await dispatch(supabase)).toMatchObject({
      ok: false,
      reason: "dispatch_state_unrecorded",
      state: "pending",
    });
  });
});
