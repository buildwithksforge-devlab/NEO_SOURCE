/**
 * Courier dispatch callback receiver.
 *
 * The URL carries the single-use token minted when the dispatch was requested.
 * An unknown token is rejected before anything is read, and an answer can only
 * ever move the one delivery that token belongs to — never another workspace's
 * order. The same answer arriving twice is accepted and changes nothing.
 */
import { createFileRoute } from "@tanstack/react-router";
import { trustedRpc } from "@/lib/rpc-guard";

type Body = {
  outcome?: string;
  status?: string;
  reference?: string;
  tracking_reference?: string;
  detail?: string;
  message?: string;
};

export const Route = createFileRoute("/api/public/delivery/callback/$token")({
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

        const applied = await trustedRpc(admin, "neo_delivery_dispatch_apply", {
          _token: token,
          _outcome: outcome,
          _provider_reference: body.reference ?? body.tracking_reference ?? null,
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
