/**
 * Courier dispatch hand-off.
 *
 * NEØ speaks one contract to any courier service — the same shape the card
 * terminal and QR processors answer on — so a courier can be plugged in with a
 * URL and a key rather than a code change:
 *
 *   POST <endpoint_url>
 *   Authorization: Bearer <secret>            (only when a secret name is configured)
 *   {
 *     "job_id":       "<uuid>",               our reference for this request
 *     "order_number": "DL-000123",
 *     "contact":      { "name": "...", "phone": "..." },
 *     "address":      { ... },                the address snapshot on the order
 *     "amount":       1500.00,
 *     "currency":     "KES",
 *     "payment":      { "method": "cash", "status": "pending" },
 *     "callback_url": "https://<this site>/api/public/delivery/callback/<token>",
 *     "environment":  "sandbox" | "production"
 *   }
 *
 * The courier may answer straight away:
 *   { "status": "accepted" | "picked_up" | "delivered" | "failed" | "cancelled",
 *     "reference": "<their own reference>", "message": "..." }
 * or answer later by calling the callback_url with the same shape. Either way the
 * order only moves on the courier's own answer — never because NEØ sent a request.
 *
 * Nothing here invents a courier. With no connected, enabled integration the
 * request is refused with the exact reason, and the dispatch board says so.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type CourierDispatchResult = {
  ok: boolean;
  reason?: string;
  detail?: string;
  state?: string;
  providerReference?: string | null;
};

type JobRow = {
  id: string;
  branch_id: string | null;
  state: string;
  environment: string | null;
  callback_token: string | null;
  request_payload: Record<string, unknown> | null;
  provider_code: string;
};

type ConnectionRow = {
  enabled: boolean;
  status: string;
  environment: string | null;
  configuration: Record<string, unknown> | null;
};

const COURIER_OUTCOMES = new Set(["accepted", "assigned", "picked_up", "collected", "delivered", "failed", "declined", "rejected", "cancelled"]);

function callbackBase(): string | null {
  const configured = process.env["PUBLIC_SITE_URL"];
  if (configured) return configured.replace(/\/$/, "");
  const origin = getRequest()?.headers.get("origin") ?? getRequest()?.headers.get("host");
  if (!origin) return null;
  return origin.startsWith("http") ? origin.replace(/\/$/, "") : `https://${origin}`;
}

type RpcClient = { rpc: (fn: string, args?: Record<string, unknown>) => Promise<unknown> };

async function markSent(
  client: unknown,
  jobId: string,
  opts: { reference?: string | undefined; detail?: string | undefined; failed: boolean },
) {
  await (client as RpcClient).rpc("neo_delivery_dispatch_mark_sent", {
    _job: jobId,
    ...(opts.reference ? { _provider_reference: opts.reference } : {}),
    ...(opts.detail ? { _detail: opts.detail } : {}),
    _failed: opts.failed,
  });
}

export const dispatchCourierJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { jobId: string }) => {
    if (!input?.jobId) throw new Error("A dispatch job is required");
    return input;
  })
  .handler(async ({ data, context }): Promise<CourierDispatchResult> => {
    const { supabase } = context;

    const { data: found } = await supabase
      .from("delivery_dispatch_jobs")
      .select("id, branch_id, state, environment, callback_token, request_payload, provider_code")
      .eq("id", data.jobId)
      .maybeSingle();

    const job = found as JobRow | null;
    if (!job) return { ok: false, reason: "job_not_found" };
    if (job.state !== "requested") {
      return { ok: true, state: job.state, detail: "This dispatch has already been sent." };
    }

    const { data: conn } = await supabase
      .from("integration_connections")
      .select("enabled, status, environment, configuration")
      .eq("provider_code", job.provider_code)
      .order("branch_id", { ascending: true, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    const connection = conn as ConnectionRow | null;
    if (!connection || !connection.enabled || connection.status !== "connected") {
      return {
        ok: false,
        reason: "provider_not_connected",
        detail: "No courier service is connected, so nothing can be sent.",
      };
    }

    const config = (connection.configuration ?? {}) as Record<string, unknown>;
    const endpoint = String(config["endpoint_url"] ?? "").trim();
    if (!endpoint.startsWith("https://")) {
      return {
        ok: false,
        reason: "endpoint_missing",
        detail: "The courier has no secure request address configured yet.",
      };
    }

    const base = callbackBase();
    if (!base || !job.callback_token) {
      return { ok: false, reason: "callback_unavailable", detail: "This dispatch has no answer address." };
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
        detail: `The courier key ${secretName} has not been saved for this workspace.`,
      };
    }

    const req = (job.request_payload ?? {}) as Record<string, unknown>;
    const payload = {
      job_id: job.id,
      order_number: req["order_number"] ?? null,
      contact: { name: req["contact_name"] ?? null, phone: req["contact_phone"] ?? null },
      address: req["address"] ?? null,
      latitude: req["latitude"] ?? null,
      longitude: req["longitude"] ?? null,
      amount: Number(req["grand_total"] ?? 0),
      currency: req["currency"] ?? "KES",
      payment: { method: req["payment_method"] ?? null, status: req["payment_status"] ?? null },
      merchant_id: config["merchant_id"] ?? null,
      callback_url: `${base}/api/public/delivery/callback/${job.callback_token}`,
      environment: job.environment ?? connection.environment ?? "sandbox",
    };

    let answer: { status?: string; reference?: string; message?: string } = {};
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
        await markSent(supabase, job.id, {
          reference: answer.reference,
          detail: `The courier refused the request (${res.status}).`,
          failed: true,
        });
        return { ok: false, reason: "provider_rejected", detail: `Courier returned ${res.status}.`, state: "failed" };
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : "The courier could not be reached.";
      await markSent(supabase, job.id, { detail, failed: true });
      return { ok: false, reason: "provider_unreachable", detail, state: "failed" };
    }

    const status = String(answer.status ?? "pending").toLowerCase();

    // A courier that answers on the spot is still the courier answering, so that
    // answer travels the same path as the webhook rather than a shortcut.
    if (COURIER_OUTCOMES.has(status)) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const admin = supabaseAdmin as unknown as {
        rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
      };
      await admin.rpc("neo_delivery_dispatch_apply", {
        _token: job.callback_token,
        _outcome: status,
        _provider_reference: answer.reference ?? undefined,
        _detail: answer.message ?? null,
        _payload: answer as Record<string, unknown>,
      });
      return { ok: true, state: status, providerReference: answer.reference ?? null };
    }

    await markSent(supabase, job.id, {
      reference: answer.reference,
      detail: answer.message,
      failed: false,
    });
    return { ok: true, state: "sent", providerReference: answer.reference ?? null };
  });
