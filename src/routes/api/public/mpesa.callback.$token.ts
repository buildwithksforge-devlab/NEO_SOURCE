/**
 * Safaricom Daraja STK callback receiver.
 *
 * The URL carries a per-tenant secret token: an unknown token is rejected before
 * anything is read, and the payload is only applied to a transaction that
 * belongs to the tenant that owns the token. Safaricom always receives a 200 so
 * it does not retry a payload we have already stored.
 */
import { trustedRpc } from "@/lib/rpc-guard";
import { createFileRoute } from "@tanstack/react-router";

const ACK = () => Response.json({ ResultCode: 0, ResultDesc: "Accepted" });

export const Route = createFileRoute("/api/public/mpesa/callback/$token")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const token = String(params.token ?? "").trim();
        if (token.length < 16) return new Response("Invalid callback token", { status: 401 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const admin = supabaseAdmin as unknown as {
          from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
          rpc: (
            fn: string,
            args?: Record<string, unknown>,
          ) => Promise<{ data: any; error: { message: string } | null }>; // eslint-disable-line @typescript-eslint/no-explicit-any
        };

        const settings = await admin
          .from("mpesa_settings")
          .select("organization_id")
          .eq("callback_token", token)
          .maybeSingle();
        const organizationId = settings?.data?.organization_id as string | undefined;
        if (!organizationId) return new Response("Invalid callback token", { status: 401 });

        let payload: unknown = null;
        try {
          payload = await request.json();
        } catch {
          return new Response("Invalid payload", { status: 400 });
        }

        const { readStkCallback } = await import("@/lib/mpesa.server");
        const parsed = readStkCallback(payload);

        if (!parsed.checkoutRequestId) {
          await admin.from("mpesa_callback_events").insert({
            organization_id: organizationId,
            payload: payload as Record<string, unknown>,
            accepted: false,
            detail: "No CheckoutRequestID in payload",
          });
          return ACK();
        }

        const txn = await admin
          .from("mpesa_transactions")
          .select("id, applied_at, amount, merchant_request_id")
          .eq("organization_id", organizationId)
          .eq("checkout_request_id", parsed.checkoutRequestId)
          .maybeSingle();
        const transactionId = txn?.data?.id as string | undefined;

        if (!transactionId) {
          await admin.from("mpesa_callback_events").insert({
            organization_id: organizationId,
            checkout_request_id: parsed.checkoutRequestId,
            payload: payload as Record<string, unknown>,
            accepted: false,
            detail: "No matching transaction for this workspace",
            retryable: false,
          });
          return ACK();
        }

        if (txn.data.applied_at) return ACK();

        const { loadMpesaCredentials, stkQuery } = await import("@/lib/mpesa.server");
        const credentials = await loadMpesaCredentials(organizationId);
        if (!credentials) {
          await admin.from("mpesa_callback_events").insert({
            organization_id: organizationId,
            checkout_request_id: parsed.checkoutRequestId,
            payload: payload as Record<string, unknown>,
            accepted: false,
            transaction_id: transactionId,
            detail: "Could not verify callback: M-Pesa credentials are incomplete.",
            retryable: true,
          });
          return new Response("Payment verification is unavailable", { status: 503 });
        }

        const verification = await stkQuery(credentials, parsed.checkoutRequestId);
        if (!verification.ok || verification.data.ResultCode === undefined) {
          await admin.from("mpesa_callback_events").insert({
            organization_id: organizationId,
            checkout_request_id: parsed.checkoutRequestId,
            payload: payload as Record<string, unknown>,
            accepted: false,
            transaction_id: transactionId,
            detail: "Could not verify callback with Daraja.",
            retryable: true,
          });
          return new Response("Payment verification is unavailable", { status: 503 });
        }

        const verifiedCode = Number(verification.data.ResultCode);
        const verifiedCheckoutId = verification.data.CheckoutRequestID;
        const verifiedMerchantId = verification.data.MerchantRequestID;
        const storedMerchantId = txn.data.merchant_request_id as string | null;
        if (
          !Number.isInteger(verifiedCode) ||
          verifiedCode !== parsed.resultCode ||
          (verifiedCheckoutId && verifiedCheckoutId !== parsed.checkoutRequestId) ||
          (verifiedMerchantId && storedMerchantId && verifiedMerchantId !== storedMerchantId) ||
          (verifiedMerchantId &&
            parsed.merchantRequestId &&
            verifiedMerchantId !== parsed.merchantRequestId) ||
          (storedMerchantId &&
            parsed.merchantRequestId &&
            storedMerchantId !== parsed.merchantRequestId) ||
          (verifiedCode === 0 &&
            (parsed.amount === null ||
              !Number.isFinite(parsed.amount) ||
              Math.round(parsed.amount) !== Math.round(Number(txn.data.amount))))
        ) {
          await admin.from("mpesa_callback_events").insert({
            organization_id: organizationId,
            checkout_request_id: parsed.checkoutRequestId,
            payload: payload as Record<string, unknown>,
            accepted: false,
            transaction_id: transactionId,
            detail: "Callback did not match the Daraja status and transaction record.",
            retryable: false,
          });
          return ACK();
        }

        const applied = await trustedRpc(admin, "neo_mpesa_apply_result", {
          _transaction: transactionId,
          _result_code: verifiedCode,
          _result_desc: verification.data.ResultDesc ?? parsed.resultDesc,
          _receipt: parsed.receipt,
          _transaction_date: parsed.transactionDate,
          _payload: {
            callback: payload as Record<string, unknown>,
            verification: verification.data as Record<string, unknown>,
          },
          _source: "callback",
        });

        if (applied.error) {
          // Record the failure so it can be reconciled, and let Safaricom retry.
          await admin.from("mpesa_callback_events").insert({
            organization_id: organizationId,
            checkout_request_id: parsed.checkoutRequestId,
            payload: payload as Record<string, unknown>,
            accepted: false,
            transaction_id: transactionId,
            detail: `Could not apply result: ${applied.error.message}`,
            retryable: true,
          });
          return new Response("Could not apply callback", { status: 500 });
        }

        return ACK();
      },
    },
  },
});
