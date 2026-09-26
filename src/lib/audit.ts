import { guardedRpc } from "@/lib/rpc-guard";
import { supabase } from "@/integrations/supabase/client";

/**
 * Append-only audit trail helper.
 *
 * Stage 1 — audit accountability: the actor is never supplied by the browser.
 * The database function stamps the authenticated user, their staff profile,
 * roles, organisation, property, department and station, so a historical event
 * stays attributable after a role change or account deactivation.
 */
export async function logAudit(input: {
  organizationId?: string | null | undefined;
  userId?: string | null | undefined;
  userName?: string | undefined;
  action: string;
  module?: string | undefined;
  recordId?: string | null | undefined;
  previousValue?: unknown;
  newValue?: unknown;
  reason?: string | null | undefined;
  branchId?: string | null | undefined;
  departmentId?: string | null | undefined;
  stationId?: string | null | undefined;
  permissionUsed?: string | null | undefined;
  correlationId?: string | null | undefined;
  delegation?: unknown;
}) {
  const device =
    typeof navigator === "undefined"
      ? null
      : `${navigator.platform ?? "web"} · ${navigator.userAgent.slice(0, 90)}`;

  const args: Record<string, unknown> = {
    _action: input.action,
    _module: input.module ?? "administration",
    _record_id: input.recordId ?? null,
    _previous: input.previousValue ?? null,
    _new: input.newValue ?? null,
    _reason: input.reason ?? null,
    _permission_used: input.permissionUsed ?? null,
    _branch: input.branchId ?? null,
    _department: input.departmentId ?? null,
    _station: input.stationId ?? null,
    _correlation: input.correlationId ?? null,
    _delegation: input.delegation ?? null,
    _device: device,
  };

  await guardedRpc(supabase, "log_audit_event", args as never);
}
