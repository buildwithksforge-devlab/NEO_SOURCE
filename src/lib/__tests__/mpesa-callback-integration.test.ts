/**
 * M-Pesa callback integration contract.
 *
 * Simulates Safaricom posting an STK result to the tenant callback URL and
 * proves the whole chain: the tenant token is resolved, the matching
 * transaction is found, the apply routine is dispatched on the trusted
 * service-role client (never blocked by the browser session guard) with the
 * values the provider sent, and the provider is only acknowledged when the
 * payment was actually applied to its folio/order transaction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Insert = Record<string, unknown>;

const inserts: { table: string; row: Insert }[] = [];
const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
let applyResult: { data: unknown; error: { message: string } | null } = {
  data: { applied: true, status: "success" },
  error: null,
};

function makeAdmin() {
  const builder = (table: string) => {
    const state: Record<string, unknown> = {};
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        state[col] = val;
        return api;
      },
      insert: async (row: Insert) => {
        inserts.push({ table, row });
        return { data: null, error: null };
      },
      maybeSingle: async () => {
        if (table === "mpesa_settings") {
          return state["callback_token"] === "tenant-token-1234567890"
            ? { data: { organization_id: "org-1" }, error: null }
            : { data: null, error: null };
        }
        if (table === "mpesa_transactions") {
          return state["checkout_request_id"] === "ws_CO_1"
            ? { data: { id: "txn-1", applied_at: null }, error: null }
            : { data: null, error: null };
        }
        return { data: null, error: null };
      },
    };
    return api;
  };
  return {
    from: (table: string) => builder(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return applyResult;
    },
  };
}

vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return makeAdmin();
  },
}));

const payload = (resultCode: number) => ({
  Body: {
    stkCallback: {
      MerchantRequestID: "mr-1",
      CheckoutRequestID: "ws_CO_1",
      ResultCode: resultCode,
      ResultDesc: resultCode === 0 ? "The service request is processed successfully." : "Request cancelled by user",
      CallbackMetadata: {
        Item: [
          { Name: "Amount", Value: 2500 },
          { Name: "MpesaReceiptNumber", Value: "SFG1A2B3C4" },
          { Name: "TransactionDate", Value: 20260830124500 },
          { Name: "PhoneNumber", Value: 254712345678 },
        ],
      },
    },
  },
});

async function post(token: string, body: unknown) {
  const { Route } = await import("@/routes/api/public/mpesa.callback.$token");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = (Route.options as any).server.handlers.POST;
  return (await handler({
    request: new Request("https://example.test/api/public/mpesa/callback/x", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    params: { token },
  })) as Response;
}

describe("M-Pesa STK callback", () => {
  beforeEach(() => {
    inserts.length = 0;
    rpcCalls.length = 0;
    applyResult = { data: { applied: true, status: "success" }, error: null };
  });

  it("rejects an unknown tenant token before reading anything", async () => {
    const res = await post("not-a-real-token-xx", payload(0));
    expect(res.status).toBe(401);
    expect(rpcCalls).toHaveLength(0);
  });

  it("applies a successful payment to its transaction and acknowledges the provider", async () => {
    const res = await post("tenant-token-1234567890", payload(0));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ResultCode: 0 });

    expect(rpcCalls).toHaveLength(1);
    const call = rpcCalls[0]!;
    expect(call.name).toBe("neo_mpesa_apply_result");
    expect(call.args["_transaction"]).toBe("txn-1");
    expect(call.args["_result_code"]).toBe(0);
    expect(call.args["_receipt"]).toBe("SFG1A2B3C4");
    expect(call.args["_source"]).toBe("callback");
  });

  it("applies a cancelled result rather than dropping it", async () => {
    await post("tenant-token-1234567890", payload(1032));
    expect(rpcCalls[0]!.args["_result_code"]).toBe(1032);
  });

  it("records a retryable audit entry and asks the provider to retry when applying fails", async () => {
    applyResult = { data: null, error: { message: "deadlock detected" } };
    const res = await post("tenant-token-1234567890", payload(0));

    expect(res.status).toBe(500);
    const event = inserts.find((i) => i.table === "mpesa_callback_events");
    expect(event).toBeTruthy();
    expect(event!.row["accepted"]).toBe(false);
    expect(event!.row["retryable"]).toBe(true);
    expect(event!.row["transaction_id"]).toBe("txn-1");
    expect(String(event!.row["detail"])).toContain("deadlock detected");
  });

  it("logs an unmatched confirmation as not retryable and still acknowledges", async () => {
    const body = payload(0);
    body.Body.stkCallback.CheckoutRequestID = "ws_CO_unknown";
    const res = await post("tenant-token-1234567890", body);

    expect(res.status).toBe(200);
    const event = inserts.find((i) => i.table === "mpesa_callback_events");
    expect(event!.row["retryable"]).toBe(false);
    expect(rpcCalls).toHaveLength(0);
  });
});
