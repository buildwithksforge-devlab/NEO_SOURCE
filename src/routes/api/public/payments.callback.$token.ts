/**
 * Card terminal / QR provider callback receiver.
 *
 * The URL carries the single-use token minted when the collection was requested.
 * An unknown token is rejected before anything is read, and an answer can only
 * ever change the one request that token belongs to — never another workspace's
 * money. The same answer arriving twice is accepted and changes nothing.
 *
 * No processor is connected today; this is the endpoint a real acquirer or QR
 * provider is pointed at, and it is deliberately live so the wiring can be
 * proven end to end the moment credentials exist.
 */
import { createFileRoute } from "@tanstack/react-router";
import { trustedRpc } from "@/lib/rpc-guard";

type Body = {
  outcome?: string;
  status?: string;
  reference?: string;
  authorization_code?: string;
  detail?: string;
  message?: string;
};

export const Route = createFileRoute("/api/public/payments/callback/$token")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const token = String(params.token ?? "").trim();
        if (token.length < 16) return new Response("Invalid callback token", { status: 401 });

        let body: Body = {};
        try {
          body = (await request.json()) as Body;
        } catch {
          return new Response("Invalid payload", { status: 400 });
        }

        const outcome = String(body.outcome ?? body.status ?? "").trim();
        if (!outcome) return new Response("No outcome in payload", { status: 400 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const admin = supabaseAdmin as unknown as {
          rpc: (
            fn: string,
            args?: Record<string, unknown>,
          ) => Promise<{ data: unknown; error: { message: string } | null }>;
        };

        const applied = await trustedRpc(admin, "neo_payment_intent_apply", {
          _token: token,
          _outcome: outcome,
          _provider_reference: body.reference ?? body.authorization_code ?? null,
          _detail: body.detail ?? body.message ?? null,
          _payload: body as Record<string, unknown>,
        });

        if (applied.error) return new Response("Could not apply result", { status: 500 });

        const result = (applied.data ?? {}) as { ok?: boolean; reason?: string; state?: string };
        if (!result.ok) {
          const status = result.reason === "unknown_token" ? 401 : 409;
          return Response.json({ ok: false, reason: result.reason }, { status });
        }
        return Response.json({ ok: true, state: result.state });
      },
    },
  },
});
