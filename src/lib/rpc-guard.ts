/**
 * Drop-in guarded replacement for `client.rpc(...)`.
 *
 * `invokeRpc` gives callers that want exceptions a guarded path, but the great
 * majority of call sites in this app read the PostgREST `{ data, error }`
 * shape. Rewriting them all to throw would have touched settlement, folio,
 * posting and inventory-ledger code that must not change behaviour, so this
 * wrapper keeps the exact same result shape while adding the two things that
 * were missing everywhere:
 *
 *  - an authenticated routine is never dispatched while the browser is
 *    anonymous (so `anon` can never reach a permission-scoped routine
 *    indirectly, through any module), and
 *  - every call — success or failure — records one structured metric with the
 *    executing role, which feeds the administration monitor and its alerts.
 */

import {
  REAUTH_MESSAGE,
  isPermissionDeniedError,
  recordRpcMetric,
  requiredCallerFor,
  resolveExecutingRole,
} from "@/lib/rpc-telemetry";

/* eslint-disable @typescript-eslint/no-explicit-any */
type RpcCapableClient = { rpc: (...args: any[]) => PromiseLike<any> };

/** PostgREST-compatible error shape returned to existing call sites. */
export type GuardedRpcError = { code?: string | null; message: string; details?: string | null };

/**
 * Same signature and same resolved shape as `client.rpc(name, args)` — the
 * generated Supabase types flow straight through, so no call site changes its
 * result handling. Never throws for an authorisation problem: it returns the
 * PostgREST-style error every existing caller already handles.
 */
export async function guardedRpc<T = any>(
  client: RpcCapableClient,
  name: string,
  args?: Record<string, unknown> | undefined,
  options?: unknown,
): Promise<{ data: T; error: GuardedRpcError | null }> {
  const required = requiredCallerFor(name);
  const role = await resolveExecutingRole();
  const started = Date.now();

  if (required !== "anon" && role !== "authenticated") {
    recordRpcMetric({
      rpc: name,
      required,
      role,
      outcome: "auth_required",
      durationMs: 0,
      code: "no_session",
      message: "No authenticated session; call not dispatched.",
      at: started,
    });
    return { data: null as T, error: { code: "no_session", message: REAUTH_MESSAGE } };
  }

  const result = (await (options === undefined
    ? client.rpc(name, args)
    : client.rpc(name, args, options))) as {
    data: T;
    error?: { code?: string | null; message?: string | null } | null;
  };
  const durationMs = Date.now() - started;
  const error = result?.error ?? null;

  recordRpcMetric({
    rpc: name,
    required,
    role,
    outcome: error ? (isPermissionDeniedError(error) ? "permission_denied" : "error") : "ok",
    durationMs,
    code: error?.code ?? null,
    message: error?.message ?? null,
    at: started,
  });

  return { data: result?.data as T, error: error ? { ...error, message: error.message ?? `${name} failed.` } : null };
}

/**
 * Server-side counterpart for a trusted service-role client (webhooks, server
 * routes). There is no browser session to resolve there, so the session guard
 * would refuse every call; the caller has already been authenticated by other
 * means (a per-tenant callback token, a verified signature). The call is
 * dispatched directly and still returns the PostgREST `{ data, error }` shape.
 */
export async function trustedRpc<T = any>(
  client: RpcCapableClient,
  name: string,
  args?: Record<string, unknown> | undefined,
): Promise<{ data: T; error: GuardedRpcError | null }> {
  const result = (await client.rpc(name, args)) as {
    data: T;
    error?: { code?: string | null; message?: string | null } | null;
  };
  const error = result?.error ?? null;
  return { data: result?.data as T, error: error ? { ...error, message: error.message ?? `${name} failed.` } : null };
}
