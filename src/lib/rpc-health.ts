/**
 * Start-up execute-privilege health check.
 *
 * A routine can be present, correct and still unreachable because its EXECUTE
 * grant was lost when the routine was replaced in the live database. That
 * failure only shows up later as "permission denied for function …" in a
 * screen that then renders as empty. This check asks the database, once per
 * session, whether the critical delivery, HR and payment routines are still
 * executable by the role the manifest says must be able to execute them, and
 * records any divergence.
 */
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { RPC_MANIFEST, type RpcCaller } from "@/lib/rpc-manifest";

/** Routines whose loss blocks a whole workflow — checked at start-up. */
export const CRITICAL_RPCS = [
  "neo_delivery_dispatch_candidates",
  "neo_delivery_rider_candidates",
  "neo_delivery_rider_directory",
  "neo_delivery_rider_roster",
  "neo_delivery_notification_audit",
  "neo_delivery_assign",
  "neo_hr_reconcile_staff",
  "neo_mpesa_apply_result",
  "neo_mpesa_txn_start",
] as const;

export type RpcPrivilegeRow = {
  routine: string;
  arguments: string;
  anon: boolean;
  authenticated: boolean;
  service_role: boolean;
};

export type RpcPrivilegeDivergence = {
  routine: string;
  /** Role the manifest requires. */
  expected: RpcCaller | "missing";
  reason: "missing-routine" | "missing-grant" | "over-granted";
  detail: string;
};

/** Compare live privileges against what the callable-surface manifest declares. */
export function comparePrivileges(
  rows: RpcPrivilegeRow[],
  names: readonly string[] = CRITICAL_RPCS,
): RpcPrivilegeDivergence[] {
  const out: RpcPrivilegeDivergence[] = [];
  for (const name of names) {
    const expected = RPC_MANIFEST[name];
    const row = rows.find((r) => r.routine === name);
    if (!row) {
      out.push({
        routine: name,
        expected: expected ?? "missing",
        reason: "missing-routine",
        detail: `${name} does not exist in the database.`,
      });
      continue;
    }
    if (!expected) continue;

    if (expected === "authenticated" && !row.authenticated) {
      out.push({
        routine: name,
        expected,
        reason: "missing-grant",
        detail: `${name} is no longer executable by signed-in staff.`,
      });
    }
    if (expected === "anon" && !row.anon) {
      out.push({
        routine: name,
        expected,
        reason: "missing-grant",
        detail: `${name} is no longer executable by the public apps.`,
      });
    }
    if (expected === "service_role") {
      if (!row.service_role) {
        out.push({
          routine: name,
          expected,
          reason: "missing-grant",
          detail: `${name} is no longer executable by the trusted server client.`,
        });
      }
      if (row.anon || row.authenticated) {
        out.push({
          routine: name,
          expected,
          reason: "over-granted",
          detail: `${name} is server-only but is executable by ${row.anon ? "anonymous" : "signed-in"} callers.`,
        });
      }
    }
  }
  return out;
}

let lastReport: RpcPrivilegeDivergence[] | null = null;

/** Divergences found by the most recent check, for the administration monitor. */
export function lastPrivilegeReport(): RpcPrivilegeDivergence[] | null {
  return lastReport;
}

/** Test-only. */
export function resetPrivilegeReport() {
  lastReport = null;
}

/**
 * Run the check. Never throws and never blocks start-up: a signed-out or
 * unauthorised session simply produces no report.
 */
export async function runRpcPrivilegeCheck(
  names: readonly string[] = CRITICAL_RPCS,
): Promise<RpcPrivilegeDivergence[]> {
  const { data, error } = await guardedRpc<RpcPrivilegeRow[]>(supabase, "neo_rpc_execute_privileges", {
    _names: [...names],
  });
  if (error) return [];

  const divergences = comparePrivileges(data ?? [], names);
  lastReport = divergences;
  if (divergences.length > 0) {
    // eslint-disable-next-line no-console
    console.error("[rpc-health] execute privileges diverge from the callable-surface manifest", {
      count: divergences.length,
      divergences,
    });
  }
  return divergences;
}
