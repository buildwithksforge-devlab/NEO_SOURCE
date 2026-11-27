import { processAuthenticatedMpesaCallback } from "@/lib/mpesa-callback-processing.server";
/**
 * Safaricom Daraja STK callback receiver.
 *
 * The URL carries a per-tenant secret token: an unknown token is rejected before
 * anything is read, and the payload is only applied to a transaction that
 * belongs to the tenant that owns the token. Applied/duplicate outcomes are
 * acknowledged; tracking, verification and posting failures stay unresolved.
 */

import { createFileRoute } from "@tanstack/react-router";



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
        if (settings.error) return new Response("Callback lookup is unavailable", { status: 503 });
        const organizationId = settings?.data?.organization_id as string | undefined;
        if (!organizationId) return new Response("Invalid callback token", { status: 401 });

        let payload: unknown = null;
        try {
          payload = await request.json();
        } catch {
          return new Response("Invalid payload", { status: 400 });
        }        // Disabled until durable intake and consumer deployment are verified.
        // Never fall back to synchronous settlement after uncertain acceptance.

        if (process.env["NEO_DURABLE_MPESA_CALLBACKS_ENABLED"] === "true") {

          try {

            const {
              createMpesaCallbackEnvelope,
              acceptAuthenticatedCallback,
            } = await import("@/lib/payment-callback-inbox.server");

            const envelope = await createMpesaCallbackEnvelope(
              organizationId,
              payload,
            );

            await acceptAuthenticatedCallback(
              admin,
              envelope,
            );

            return Response.json({
              ResultCode: 0,
              ResultDesc: "Accepted",
            });

          } catch {

            return new Response(
              "Durable callback acceptance is unavailable",
              { status: 503 },
            );

          }

        }

        return processAuthenticatedMpesaCallback(admin, organizationId, payload);
      },
    },
  },
});
