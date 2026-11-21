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
  organization_id: string;
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

const COURIER_OUTCOMES = new Set(["accepted", "assigned", "picked_up", "collected", "delivered", "completed", "failed", "declined", "rejected", "cancelled"]);

function callbackBase(): string | null {
  const configured = process.env["PUBLIC_SITE_URL"];
  if (configured) return configured.replace(/\/$/, "");
  const request = getRequest();
  return request ? new URL(request.url).origin : null;
}

type RpcClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};

let adminModule: Promise<typeof import("@/integrations/supabase/client.server")> | undefined;

function savedDispatchState(result: { data: unknown; error: unknown }): string | null {
  const row = result.data as { ok?: boolean; state?: unknown } | null;
  return !result.error && row?.ok === true && typeof row.state === "string" ? row.state : null;
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
      .select("id, organization_id, branch_id, state, environment, callback_token, request_payload, provider_code")
      .eq("id", data.jobId)
      .maybeSingle();

    const job = found as JobRow | null;
    if (!job) return { ok: false, reason: "job_not_found" };
    // A readable queue record does not grant permission to hand it to a provider.
    const [assign, edit, scope] = await Promise.all([
      supabase.rpc("has_permission", { _module: "delivery", _feature: "dispatch", _action: "assign" }),
      supabase.rpc("has_permission", { _module: "delivery", _action: "edit" }),
      job.branch_id
        ? supabase.rpc("neo_branch_in_scope", { _branch: job.branch_id })
        : Promise.resolve({ data: true, error: null }),
    ]);
    if ((assign.data !== true && edit.data !== true) || scope.error || scope.data !== true) {
      return { ok: false, reason: "dispatch_access_denied", detail: "You cannot dispatch orders for this property." };
    }
    if (job.state !== "requested") {
      return { ok: true, state: job.state, detail: "This dispatch has already been sent." };
    }

    const connections = supabase
      .from("integration_connections")
      .select("enabled, status, environment, configuration")
      .eq("organization_id", job.organization_id)
      .eq("provider_code", job.provider_code);
    const scopedConnections = job.branch_id
      ? connections.or(`branch_id.eq.${job.branch_id},branch_id.is.null`)
      : connections.is("branch_id", null);
    const { data: conn, error: lookupError } = await scopedConnections
      .order("branch_id", { ascending: true, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    const connection = conn as ConnectionRow | null;
    if (lookupError) {
      return { ok: false, reason: "provider_lookup_failed", detail: "The courier connection could not be verified for this property." };
    }
    if (!connection || !connection.enabled || connection.status !== "connected") {
      return {
        ok: false,
        reason: "provider_not_connected",
        detail: "No courier service is connected, so nothing can be sent.",
      };
    }
    if (job.environment !== (connection.environment ?? "sandbox")) {
      return { ok: false, reason: "provider_environment_changed", detail: "The courier environment changed after this dispatch was opened." };
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
      environment: job.environment,
    };

    // Reserve the handoff before crossing the network. The open-job index also
    // covers `sent`, so an interrupted request keeps its original job and token.
    const { data: claimed, error: claimError } = await supabase.rpc("neo_delivery_dispatch_claim", { _job: job.id });
    if (claimError) {
      if (claimError.code === "23514") {
        return { ok: false, reason: "order_no_longer_dispatchable", detail: claimError.message };
      }
      return { ok: false, reason: "dispatch_claim_failed", detail: "NEØ could not reserve this dispatch. Refresh its status before trying again." };
    }
    if (claimed !== true) {
      return { ok: false, reason: "dispatch_already_claimed", detail: "This dispatch is already being handled. Refresh to see the latest status." };
    }

    const { supabaseAdmin } = await (adminModule ??= import("@/integrations/supabase/client.server"));

    const saveAwaitingConfirmation = async (detail: string, reference?: string) => {
      const { error } = await supabaseAdmin.from("delivery_dispatch_jobs")
        .update({ state_detail: detail, ...(reference ? { provider_reference: reference } : {}), updated_at: new Date().toISOString() })
        .eq("id", job.id)
        .eq("organization_id", job.organization_id)
        .eq("state", "sent");
      return !error;
    };

    let answer: { status?: string; reference?: string; message?: string } = {};
    let uncertainDetail: string | undefined;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": job.id,
          ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      try {
        const body = text ? JSON.parse(text) : null;
        if (body && typeof body === "object") {
          answer = {
            ...(typeof body.status === "string" ? { status: body.status } : {}),
            ...(typeof body.reference === "string" ? { reference: body.reference } : {}),
            ...(typeof body.message === "string" ? { message: body.message } : {}),
          };
        }
      } catch {
        answer = {};
      }
      if (!res.ok) {
        uncertainDetail = `The courier returned HTTP ${res.status}. Verify the original handoff with the courier.`;
      }
    } catch {
      uncertainDetail = "No response was received. Verify the original handoff with the courier.";
    }
    if (uncertainDetail) {
      await saveAwaitingConfirmation(uncertainDetail);
      return { ok: false, reason: "courier_confirmation_pending", detail: uncertainDetail, state: "sent" };
    }

    const status = String(answer.status ?? "pending").toLowerCase();

    // A courier that answers on the spot is still the courier answering, so that
    // answer travels the same path as the webhook rather than a shortcut.
    if (COURIER_OUTCOMES.has(status)) {
      const admin = supabaseAdmin as unknown as RpcClient;
      const state = savedDispatchState(await admin.rpc("neo_delivery_dispatch_apply", {
        _token: job.callback_token,
        _outcome: status,
        _provider_reference: answer.reference ?? undefined,
        _detail: answer.message ?? null,
        _payload: answer as Record<string, unknown>,
      }));
      if (!state) {
        return { ok: false, reason: "courier_state_unconfirmed", detail: "The courier answered, but NEØ could not confirm the saved status. Check the dispatch before sending again." };
      }
      if (state === "failed" || state === "cancelled") {
        return { ok: false, reason: "courier_handoff_declined", detail: answer.message || "The courier declined or cancelled this dispatch.", state };
      }
      return { ok: true, state, providerReference: answer.reference ?? null };
    }

    if (!await saveAwaitingConfirmation(answer.message || "Sent to the courier. Waiting for their answer.", answer.reference)) {
      return { ok: false, reason: "courier_state_unconfirmed", detail: "The courier received the request, but NEØ could not confirm the saved status. Check the dispatch before sending again." };
    }
    return { ok: true, state: "sent", providerReference: answer.reference ?? null };
  });
