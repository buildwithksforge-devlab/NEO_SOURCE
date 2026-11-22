import { describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/api/public/payments.callback.$token";

const { apply } = vi.hoisted(() => ({ apply: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/rpc-guard", () => ({ trustedRpc: apply }));

type CallbackHandler = (input: { request: Request; params: { token: string } }) => Promise<Response>;
const handler = (Route.options as unknown as { server: { handlers: { POST: CallbackHandler } } }).server.handlers.POST;
const token = "fixture-callback-token";
const receive = (body: string) => handler({
  params: { token }, request: new Request("https://hotel.invalid/callback", { method: "POST", body }),
});

describe("payment callback request handling", () => {
  it.each(["null", "[]", '"approved"', '{"outcome":["approved"]}', '{"status":true}',
    '{"status":"approved","reference":{}}', '{"status":"approved","detail":[]}', "{"])(
    "returns 400 without applying an invalid payload %s", async (body) => {
      apply.mockClear();
      expect((await receive(body)).status).toBe(400);
      expect(apply).not.toHaveBeenCalled();
    },
  );

  it("reports that Finance reconciliation is required without presenting a refund as posted", async () => {
    apply.mockResolvedValueOnce({ data: { ok: true, state: "confirmed", refund_reconciliation_required: true }, error: null });
    const result = await receive('{"status":"refunded","reference":"fixture-refund"}');
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true, state: "confirmed", refund_reconciliation_required: true });
  });
});
