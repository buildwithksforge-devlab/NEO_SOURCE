/**
 * Card terminal / QR gateway hand-off.
 *
 * NEØ speaks one contract to any processor, so a terminal supplier or QR app can
 * be plugged in with a URL and a key rather than a code change:
 *
 *   POST <endpoint_url>
 *   Authorization: Bearer <secret>            (only when a secret name is configured)
 *   {
 *     "intent_id":    "<uuid>",               our reference for this request
 *     "amount":       1500.00,
 *     "currency":     "KES",
 *     "reference":    "REQ-8A21C4F0",
 *     "method":       "card-terminal" | "qr",
 *     "terminal_id":  "<from configuration, optional>",
 *     "merchant_id":  "<from configuration, optional>",
 *     "callback_url": "https://<this site>/api/public/payments/callback/<token>",
 *     "environment":  "sandbox" | "production"
 *   }
 *
 * The processor may answer straight away:
 *   { "status": "approved" | "declined" | "cancelled" | "pending",
 *     "reference": "<their own reference>", "message": "..." }
 * or answer later by calling the callback_url with the same shape. Either way the
 * money is only ever settled by the processor's own answer — never by NEØ
 * assuming the request succeeded.
 *
 * Nothing here invents a processor. With no connected, enabled integration the
 * request is refused with the exact reason, and the checkout says so.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type GatewayDispatch = {
  ok: boolean;
  reason?: string;
  detail?: string;
  state?: string;
  providerReference?: string | null;
  /** What the guest scans, when a QR provider answered with a code to show. */
  qrPayload?: string | null;
  qrImageUrl?: string | null;
};

type AttemptRow = {
  id: string;
  organization_id: string;
  branch_id: string | null;
  method: string;
  provider_code: string | null;
  amount: number;
  currency: string | null;
  reference: string | null;
  state: string;
  environment: string | null;
  callback_token: string | null;
};

type ConnectionRow = {
  enabled: boolean;
  status: string;
  environment: string | null;
  configuration: Record<string, unknown> | null;
  secret_names: unknown;
};

const TERMINAL_OUTCOMES = new Set(["approved", "declined", "cancelled", "timeout", "reversed"]);

function callbackBase(): string | null {
  const configured = process.env["PUBLIC_SITE_URL"];
  if (configured) return configured.replace(/\/$/, "");
  const origin = getRequest()?.headers.get("origin") ?? getRequest()?.headers.get("host");
  if (!origin) return null;
  return origin.startsWith("http") ? origin.replace(/\/$/, "") : `https://${origin}`;
}

type RpcClient = { rpc: (fn: string, args?: Record<string, unknown>) => Promise<unknown> };

/** Records "sent to the processor" or "could not be sent", never an outcome. */
async function markSent(
  client: unknown,
  intentId: string,
  opts: { reference?: string | undefined; detail?: string | undefined; failed: boolean },
) {
  await (client as RpcClient).rpc("neo_payment_intent_mark_sent", {
    _intent: intentId,
    ...(opts.reference ? { _provider_reference: opts.reference } : {}),
    ...(opts.detail ? { _detail: opts.detail } : {}),
    _failed: opts.failed,
  });
}

export const dispatchPaymentIntent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { intentId: string }) => {
    if (!input?.intentId) throw new Error("An intent is required");
    return input;
  })
  .handler(async ({ data, context }): Promise<GatewayDispatch> => {
    const { supabase } = context;

    const { data: attempt } = await supabase
      .from("payment_attempts")
      .select(
        "id, organization_id, branch_id, method, provider_code, amount, currency, reference, state, environment, callback_token",
      )
      .eq("payment_table", "payment_intents")
      .eq("payment_id", data.intentId)
      .maybeSingle();

    const row = attempt as AttemptRow | null;
    if (!row) return { ok: false, reason: "intent_not_found" };
    if (row.state !== "requested") {
      return { ok: true, state: row.state, detail: "This request has already been sent." };
    }
    if (!row.provider_code) return { ok: false, reason: "not_provider_backed" };

    const { data: conn } = await supabase
      .from("integration_connections")
      .select("enabled, status, environment, configuration, secret_names")
      .eq("provider_code", row.provider_code)
      .order("branch_id", { ascending: true, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    const connection = conn as ConnectionRow | null;
    if (!connection || !connection.enabled || connection.status !== "connected") {
      return {
        ok: false,
        reason: "provider_not_connected",
        detail: "No processor is connected for this method, so nothing can be sent.",
      };
    }

    const config = (connection.configuration ?? {}) as Record<string, unknown>;
    const endpoint = String(config["endpoint_url"] ?? "").trim();
    if (!endpoint.startsWith("https://")) {
      return {
        ok: false,
        reason: "endpoint_missing",
        detail: "The processor has no secure request address configured yet.",
      };
    }

    const base = callbackBase();
    if (!base || !row.callback_token) {
      return { ok: false, reason: "callback_unavailable", detail: "This request has no answer address." };
    }

    const secretName = String(config["secret_name"] ?? "").trim();
    const { resolveConnectorSecret } = await import("@/lib/connector-secret.server");
    const resolvedSecret = resolveConnectorSecret(secretName);
    if (resolvedSecret.status === "invalid") {
      return {
        ok: false,
        reason: "secret_name_not_allowed",
        detail: "Connector secret names must start with NEO_CONNECTOR_.",
      };
    }
    const secret = resolvedSecret.value;
    if (resolvedSecret.status === "missing") {
      return {
        ok: false,
        reason: "secret_missing",
        detail: `The processor key ${secretName} has not been saved for this workspace.`,
      };
    }

    const payload = {
      intent_id: data.intentId,
      amount: Number(row.amount),
      currency: row.currency ?? "KES",
      reference: row.reference,
      method: row.method,
      terminal_id: config["terminal_id"] ?? null,
      merchant_id: config["merchant_id"] ?? null,
      callback_url: `${base}/api/public/payments/callback/${row.callback_token}`,
      environment: row.environment ?? connection.environment ?? "sandbox",
    };

    let answer: {
      status?: string;
      reference?: string;
      message?: string;
      qr_payload?: string;
      qr_string?: string;
      qr_image_url?: string;
    } = {};
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      try {
        answer = text ? (JSON.parse(text) as typeof answer) : {};
      } catch {
        answer = {};
      }
      if (!res.ok) {
        await markSent(supabase, data.intentId, {
          reference: answer.reference,
          detail: `The processor refused the request (${res.status}).`,
          failed: true,
        });
        return { ok: false, reason: "provider_rejected", detail: `Processor returned ${res.status}.`, state: "failed" };
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : "The processor could not be reached.";
      await markSent(supabase, data.intentId, { detail, failed: true });
      return { ok: false, reason: "provider_unreachable", detail, state: "failed" };
    }

    const status = String(answer.status ?? "pending").toLowerCase();

    // Some terminals answer on the spot. That answer is the processor's own, so
    // it settles the payment through the same path the webhook uses.
    if (TERMINAL_OUTCOMES.has(status)) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const admin = supabaseAdmin as unknown as {
        rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
      };
      await admin.rpc("neo_payment_intent_apply", {
        _token: row.callback_token,
        _outcome: status,
        _provider_reference: answer.reference ?? undefined,
        _detail: answer.message ?? null,
        _payload: answer as Record<string, unknown>,
      });
      return { ok: true, state: status, providerReference: answer.reference ?? null };
    }

    await markSent(supabase, data.intentId, {
      reference: answer.reference,
      detail: answer.message,
      failed: false,
    });

    // A QR provider answers with the code the guest scans. It is kept on the
    // attempt so the till can show it again after a refresh, and it is never
    // treated as payment — only the webhook confirms money.
    const qrPayload = answer.qr_payload ?? answer.qr_string ?? null;
    const qrImageUrl = answer.qr_image_url ?? null;
    if (qrPayload || qrImageUrl) {
      await supabase.rpc("neo_payment_intent_set_provider_payload", {
        _intent: data.intentId,
        _payload: { qr_payload: qrPayload, qr_image_url: qrImageUrl, reference: answer.reference ?? null },
      });
    }

    return {
      ok: true,
      state: "pending",
      providerReference: answer.reference ?? null,
      qrPayload,
      qrImageUrl,
    };
  });
