import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useActivePropertyFilter } from "@/lib/branch-filter";

/**
 * Guard violation capture.
 *
 * The lifecycle guards (`neo_pos_lifecycle_guard`, `neo_laundry_completion_guard`,
 * `neo_pos_guard_void_discount`) refuse an impossible write by raising, which
 * rolls the whole statement back — so the refusal cannot be recorded inside the
 * same transaction. Instead the caller reports the refusal afterwards through
 * `neo_log_guard_violation`, which stores the attempted payload and the reason
 * for administrator review. The guard remains the authority; this is only the
 * visible record of what it stopped.
 */

export type GuardViolation = {
  id: string;
  created_at: string;
  guard_name: string;
  source_table: string;
  operation: string;
  record_id: string | null;
  record_label: string | null;
  attempted_payload: Record<string, unknown>;
  reason: string;
  error_code: string | null;
  actor_name: string | null;
  status: string;
  reviewed_at: string | null;
  review_note: string | null;
};

export type LifecycleRepair = {
  id: string;
  created_at: string;
  action: string;
  module: string | null;
  record_id: string | null;
  actor_name: string | null;
  reason: string | null;
  previous_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  guard_rule: string;
};

export type IntegrityRun = {
  id: string;
  run_at: string;
  check_key: string;
  check_label: string;
  status: string;
  anomaly_count: number;
  details: unknown[];
  triggered_by: string;
};

/** Error codes the lifecycle guards use when refusing a write. */
const GUARD_CODES = new Set(["23514", "42501"]);

export const guardLabels: Record<string, string> = {
  neo_pos_lifecycle_guard: "Restaurant order lifecycle",
  neo_laundry_completion_guard: "Laundry completion",
  neo_pos_guard_void_discount: "Void & discount authority",
};

function guardReason(message: string): string {
  if (message.includes("void_requires_authority"))
    return "Voiding or cancelling a restaurant order requires explicit void authority.";
  if (message.includes("discount_requires_authority"))
    return "Applying or increasing a discount requires explicit override authority.";
  return message;
}

/**
 * Records a refused write. Never throws: a failure to log must not mask the
 * original refusal the caller is already surfacing to the user.
 */
export async function reportGuardViolation(input: {
  guard: string;
  table: string;
  reason: string;
  payload?: Record<string, unknown>;
  recordId?: string | null;
  recordLabel?: string | null;
  operation?: string;
  errorCode?: string | null;
  branchId?: string | null;
}): Promise<void> {
  try {
    await guardedRpc(supabase, "neo_log_guard_violation" as never, {
      _guard: input.guard,
      _source_table: input.table,
      _reason: guardReason(input.reason),
      _payload: input.payload ?? {},
      _record_id: input.recordId ?? null,
      _record_label: input.recordLabel ?? null,
      _operation: input.operation ?? "update",
      _error_code: input.errorCode ?? null,
      _branch: input.branchId ?? null,
    } as never);
  } catch {
    /* logging is best-effort */
  }
}

/**
 * Wraps a write so a guard refusal is recorded before the error is rethrown.
 */
export async function withGuardCapture<T>(
  meta: {
    guard: string;
    table: string;
    payload?: Record<string, unknown>;
    recordId?: string | null;
    recordLabel?: string | null;
    operation?: string;
  },
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const err = error as { code?: string; message?: string };
    const message = err?.message ?? String(error);
    if (GUARD_CODES.has(err?.code ?? "") || /authority|cannot|guard/i.test(message)) {
      await reportGuardViolation({
        guard: meta.guard,
        table: meta.table,
        reason: message,
        ...(meta.payload ? { payload: meta.payload } : {}),
        recordId: meta.recordId ?? null,
        recordLabel: meta.recordLabel ?? null,
        operation: meta.operation ?? "update",
        errorCode: err?.code ?? null,
      });
    }
    throw error;
  }
}

export function useGuardViolations(status: "open" | "reviewed" | "all" = "all") {
  return useQuery({
    queryKey: ["integrity", "guard-violations", status],
    queryFn: async () => {
      let query = supabase
        .from("guard_violations" as never)
        .select("*")
        .order("created_at", { ascending: false })
        .limit(300);
      if (status !== "all") query = query.eq("status", status);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as unknown as GuardViolation[];
    },
  });
}

export function useReviewGuardViolation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, note }: { id: string; note?: string }) => {
      const { error } = await guardedRpc(supabase, "neo_review_guard_violation" as never, {
        _id: id,
        _note: note ?? null,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Marked as reviewed");
      void qc.invalidateQueries({ queryKey: ["integrity"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useLifecycleRepairs() {
  return useQuery({
    queryKey: ["integrity", "lifecycle-repairs"],
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_lifecycle_repairs" as never, {
        _limit: 300,
      } as never);
      if (error) throw error;
      return (data ?? []) as unknown as LifecycleRepair[];
    },
  });
}

export function useIntegrityRuns() {
  return useQuery({
    queryKey: ["integrity", "runs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("integrity_check_runs" as never)
        .select("*")
        .order("run_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as IntegrityRun[];
    },
  });
}

export function useRunIntegrityChecks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_run_integrity_checks_now" as never);
      if (error) throw error;
      return data as unknown;
    },
    onSuccess: () => {
      toast.success("Integrity checks completed");
      void qc.invalidateQueries({ queryKey: ["integrity"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Structure & relationships proof: organisation → property → department → role →
 * worker → station → resource. Records duplicates, orphans and cross-property
 * links as an integrity check run.
 */
export function useRunStructureScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_structure_scan" as never, {
        _trigger: "manual",
      } as never);
      if (error) throw error;
      return data as unknown;
    },
    onSuccess: () => {
      toast.success("Structure & relationship check completed");
      void qc.invalidateQueries({ queryKey: ["integrity"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Lifecycle completion.
 *
 * Every operation has a real end state: a reservation departs, a sale reaches
 * the ledger, a ticket is served, a requisition is received. `neo_lifecycle_audit`
 * reports, module by module, how many records are still short of that end state,
 * and `neo_lifecycle_finalise` completes only the ones that need nothing but a
 * posting or a missing timestamp. Anything needing a human decision is reported,
 * never guessed.
 */
export type LifecycleModule = {
  module: string;
  label: string;
  route: string;
  total: number;
  complete: number;
  in_flight: number;
  incomplete: number;
  detail: string;
  status: "ready" | "attention" | "unknown";
};

export type LifecycleAudit = {
  branch_id: string | null;
  generated_at: string;
  incomplete: number;
  status: "ready" | "attention" | "unknown";
  modules: LifecycleModule[];
};

export function useLifecycleAudit() {
  const { branchId, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["integrity", "lifecycle-audit", filterKey],
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_lifecycle_audit" as never, {
        _branch: branchId,
      } as never);
      if (error) throw error;
      return data as unknown as LifecycleAudit;
    },
  });
}

export function useFinaliseLifecycles() {
  const qc = useQueryClient();
  const { branchId } = useActivePropertyFilter();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_lifecycle_finalise" as never, {
        _branch: branchId,
      } as never);
      if (error) throw error;
      return data as unknown as Record<string, number>;
    },
    onSuccess: (result) => {
      const done =
        Number(result["pos_orders_posted"] ?? 0) +
        Number(result["laundry_orders_posted"] ?? 0) +
        Number(result["payments_posted"] ?? 0) +
        Number(result["tickets_stamped"] ?? 0) +
        Number(result["folios_settled"] ?? 0);
      toast.success(
        done === 0
          ? "Nothing left that could be completed automatically"
          : `${done} operation${done === 1 ? "" : "s"} completed`,
      );
      void qc.invalidateQueries({ queryKey: ["integrity"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
