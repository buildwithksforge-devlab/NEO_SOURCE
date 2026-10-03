import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

/**
 * Finance Department controls.
 *
 * Pending Collections, the cashier till, cashier-session oversight and the
 * automated End-of-Day (night audit) all read through database routines that
 * re-apply the same organisation, property and capability rules the interface
 * shows. Nothing here decides authority on its own.
 */

// The generated RPC union is large enough to blow the type instantiation
// budget, so bind through an untyped handle and narrow at each call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rpcClient = supabase as any;
const rpc = rpcClient.rpc.bind(rpcClient) as (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

async function callRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

function useInvalidate(keys: string[]) {
  const qc = useQueryClient();
  return () => keys.forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));
}

/* ---------------------------- pending collections --------------------------- */

export type PendingCollection = {
  source: string;
  source_id: string;
  reference: string | null;
  customer: string | null;
  department: string | null;
  gross: number;
  adjustments: number;
  deposit: number;
  balance: number;
  payment_status: string | null;
  approval_status: string | null;
  occurred_at: string;
};

export const COLLECTION_SOURCES: Record<string, string> = {
  "front-office": "Front Office",
  restaurant: "Restaurant & Bar",
  events: "Events & Banqueting",
  delivery: "Delivery",
};

export function usePendingCollections() {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["finance", "pending-collections", organizationId, branchId],
    enabled: Boolean(organizationId),
    refetchInterval: 60_000,
    queryFn: async () =>
      (await callRpc<PendingCollection[]>("neo_pending_collections", { _branch: branchId ?? null })) ??
      [],
  });
}

export type SettleInput = {
  source: string;
  source_id: string;
  amount: number;
  method: string;
  reference: string;
  /** Cash handed over, so the change given is recorded with the collection. */
  tendered?: number | null;
  shift_id?: string | null;
  /** Canonical collection intent — one key per act of collection. */
  intent_key?: string | null;
};

/**
 * Settlement is always the department's own posting routine — Finance confirms
 * the money, it never re-writes another department's bill by hand.
 */
export function useSettleCollection() {
  const invalidate = useInvalidate(["finance", "pos", "pms", "events"]);
  return useMutation({
    mutationFn: async (input: SettleInput) => {
      const intent = input.intent_key ?? null;
      if (input.source === "front-office") {
        return callRpc("pms_record_payment", {
          _folio: input.source_id,
          _amount: input.amount,
          _method: input.method,
          _reference: input.reference || null,
          _intent_key: intent,
        });
      }
      if (input.source === "restaurant") {
        return callRpc("pos_record_payment_attempt", {
          _order_id: input.source_id,
          _amount: input.amount,
          _method: input.method,
          _reference: input.reference || null,
          _tendered: input.tendered ?? null,
          _shift_id: input.shift_id ?? null,
          ...(intent ? { _idempotency_key: intent } : {}),
        });
      }
      if (input.source === "events") {
        return callRpc("neo_event_billing_record_payment", {
          _booking: input.source_id,
          _amount: input.amount,
          _method: input.method,
          _reference: input.reference || null,
        });
      }
      throw new Error("Delivery orders are settled by the rider on delivery or by the payment provider.");
    },
    onSuccess: () => {
      toast.success("Payment recorded and posted to the guest ledger");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------- cashier sessions -------------------------- */

export type CashierSession = {
  id: string;
  shift_number: string | null;
  cashier_id: string | null;
  status: string;
  opening_float: number | null;
  expected_cash: number | null;
  counted_cash: number | null;
  variance: number | null;
  opened_at: string;
  closed_at: string | null;
  profiles?: { full_name?: string | null } | null;
};

export function useCashierSessions() {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["finance", "cashier-sessions", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = supabase
        .from("pos_shifts")
        .select("*, profiles!pos_shifts_cashier_id_fkey(full_name)")
        .order("opened_at", { ascending: false })
        .limit(100);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as CashierSession[];
    },
  });
}

/* --------------------------------- end of day ------------------------------ */

export type NightAuditRun = {
  id: string;
  branch_id: string;
  business_date: string;
  status: string;
  blocking_count: number;
  warning_count: number;
  run_mode: string;
  run_reference: string | null;
  operator_name: string | null;
  stage: "collecting" | "signed" | "failed" | string;
  source_counts: Record<string, number>;
  exception_snapshot: Array<Record<string, unknown>>;
  rerun_count: number;
  result_digest: string | null;
  signed_at: string | null;
  summary: Record<string, unknown>;
  started_at: string;
  completed_at: string | null;
};

export type NightAuditException = {
  id: string;
  run_id: string;
  category: string;
  severity: string;
  reference: string | null;
  detail: string;
  amount: number | null;
};

export const EXCEPTION_LABELS: Record<string, string> = {
  "cashier-session": "Cashier session still open",
  "cash-variance": "Cash variance",
  "unsettled-bill": "Unsettled bill",
  "open-folio": "Guest folio balance",
  "finance-posting": "Finance posting failure",
  approval: "Awaiting approval",
  "revenue-reconciliation": "Revenue vs collections",
};

export function useNightAuditRuns() {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["finance", "night-audit-runs", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = supabase
        .from("night_audit_runs")
        .select("*")
        .order("business_date", { ascending: false })
        .order("started_at", { ascending: false })
        .limit(30);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as NightAuditRun[];
    },
  });
}

export function useNightAuditExceptions(runId: string | null) {
  const { organizationId } = useAuth();
  return useQuery({
    // organisation stays in the key so a workspace switch can never serve
    // another tenant's cached exceptions.
    queryKey: ["finance", "night-audit-exceptions", organizationId, runId],
    enabled: Boolean(runId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("night_audit_exceptions")
        .select("*")
        .eq("run_id", runId!)
        .order("severity", { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as NightAuditException[];
    },
  });
}

export type BusinessDay = {
  id: string;
  branch_id: string;
  business_date: string;
  status: "open" | "closed";
  opened_at: string;
  opened_by: string | null;
  closed_at: string | null;
  closed_by: string | null;
  notes: string | null;
};

export function useBusinessDays() {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["finance", "business-days", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = supabase
        .from("business_days")
        .select("*")
        .order("business_date", { ascending: false })
        .limit(30);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as BusinessDay[];
    },
  });
}

export function useOpenBusinessDay() {
  const invalidate = useInvalidate(["finance"]);
  return useMutation({
    mutationFn: (input: { branch: string; date: string; note?: string }) =>
      callRpc<{ status: string; message?: string; open_business_date?: string }>(
        "neo_open_business_day",
        { _branch: input.branch, _date: input.date, _note: input.note || null },
      ),
    onSuccess: (r) => {
      if (r.status === "open") toast.success("Business day opened");
      else if (r.status === "already_open") toast.info("That business day is already open");
      else if (r.status === "another_day_open") {
        toast.error(r.message ?? `Close ${r.open_business_date ?? "the current business day"} first`);
      } else toast.error(r.message ?? "The business day could not be opened");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRunNightAudit() {
  const invalidate = useInvalidate(["finance"]);
  return useMutation({
    // "Completed" is only reported once the signed run has been read back from
    // the register. A returned payload alone is not evidence of persistence.
    mutationFn: async (input: { branch: string; date: string }) => {
      const result = await callRpc<{
        blocking: number;
        warnings: number;
        status: string;
      }>(
        "neo_night_audit_run",
        { _branch: input.branch, _date: input.date, _mode: "manual" },
      );
      const { data, error } = await supabase
        .from("night_audit_runs")
        .select("id, status, blocking_count, warning_count, completed_at")
        .eq("branch_id", input.branch)
        .eq("business_date", input.date)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data?.["id"] || !data["completed_at"]) {
        throw new Error(
          "The night audit did not persist — no signed end-of-day record was written for this property and date.",
        );
      }
      return {
        ...result,
        blocking: Number(data["blocking_count"] ?? result.blocking ?? 0),
        warnings: Number(data["warning_count"] ?? result.warnings ?? 0),
        status: String(data["status"] ?? result.status),
      };
    },

    onSuccess: (r) => {
      // Run Audit is inspection-only. It reports blockers and warnings but
      // never posts eligible finance work or closes the business day.
      if (Number(r.blocking) > 0) {
        toast.error(
          `END-OF-DAY EXCEPTION — ${r.blocking} blocking item${Number(r.blocking) === 1 ? "" : "s"} for Finance to investigate`,
        );
      } else if (Number(r.warnings) > 0) {
        toast.warning(`Night audit completed with ${r.warnings} item(s) to review`);
      } else {
        toast.success("Night audit completed — the day balances");
      }
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useCloseBusinessDay() {
  const invalidate = useInvalidate(["finance"]);
  return useMutation({
    mutationFn: (input: { branch: string; date: string; note: string }) =>
      callRpc<{ status: string; message?: string; blocking?: number }>("neo_close_business_day", {
        _branch: input.branch,
        _date: input.date,
        _note: input.note || null,
      }),
    onSuccess: (r) => {
      if (r.status === "closed") toast.success("Business day closed and locked");
      else if (r.status === "already_closed") toast.info("That business day is already closed");
      else toast.error(r.message ?? "The business day cannot be closed while exceptions remain");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------ approval limits ---------------------------- */

export type ApprovalType = { id: string; key: string; name: string; active: boolean };

export type ApprovalRule = {
  id: string;
  approval_type: string;
  level: number;
  branch_id: string | null;
  department_id: string | null;
  approver_role_id: string | null;
  approver_user_id: string | null;
  min_amount: number | null;
  max_amount: number | null;
  max_percent: number | null;
  required_approvers: number | null;
  allow_self_approval: boolean;
  escalate_above_limit: boolean;
  active: boolean;
  label: string | null;
  /** Currency the amount band is expressed in; null follows the workspace currency. */
  currency: string | null;
  /** Dates the rule is in force between; null means no start or no end. */
  effective_from: string | null;
  effective_to: string | null;
  require_rejection_reason: boolean;
  require_override_reason: boolean;
};

export function useApprovalTypes() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["finance", "approval-types", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("approval_types")
        .select("id, key, name, active")
        .order("name");
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as ApprovalType[];
    },
  });
}

export function useApprovalRules() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["finance", "approval-rules", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("approval_rules")
        .select("*")
        .order("approval_type")
        .order("level");
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as ApprovalRule[];
    },
  });
}

export type ApprovalRuleInput = {
  id?: string;
  approval_type: string;
  level: number;
  branch_id: string | null;
  approver_role_id: string | null;
  max_amount: number | null;
  max_percent: number | null;
  escalate_above_limit: boolean;
  active: boolean;
  label: string | null;
  /** Optional governance detail; omitted fields keep whatever is already stored. */
  min_amount?: number | null;
  currency?: string | null;
  effective_from?: string | null;
  effective_to?: string | null;
  require_rejection_reason?: boolean;
  require_override_reason?: boolean;
};

export function useSaveApprovalRule() {
  const { organizationId } = useAuth();
  const invalidate = useInvalidate(["finance"]);
  return useMutation({
    mutationFn: async (input: ApprovalRuleInput) => {
      const payload = { ...input, organization_id: organizationId };
      const table = supabase.from("approval_rules");
      const { error } = input.id
        ? await table.update(payload as never).eq("id", input.id)
        : await table.insert(payload as never);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Approval authority saved");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useDeleteApprovalRule() {
  const invalidate = useInvalidate(["finance"]);
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("approval_rules").delete().eq("id", id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Approval authority removed");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* --------------------------- my approval authority -------------------------- */

/**
 * The caller's own configured approval authority, resolved in the database from
 * `approval_rules`. Limits are never hard-coded and a manager can never raise
 * their own: the Owner / System Administrator configures them in
 * Administration → Approval Authority & Limits.
 */
export type MyApprovalAuthority = {
  approval_type: string;
  level: number;
  max_amount: number | null;
  max_percent: number | null;
  escalate_above_limit: boolean;
  unlimited: boolean;
};

export function useMyApprovalAuthority() {
  const { organizationId, user } = useAuth();
  return useQuery({
    queryKey: ["approval-authority", organizationId, user?.id ?? null],
    enabled: Boolean(organizationId && user?.id),
    queryFn: async () =>
      (await callRpc<MyApprovalAuthority[] | null>("neo_my_approval_authority", {})) ?? [],
  });
}

/** Plain-language description of a configured limit. */
export function describeAuthority(a: MyApprovalAuthority): string {
  if (a.unlimited) return "No configured ceiling";
  const parts: string[] = [];
  if (a.max_percent !== null) parts.push(`up to ${a.max_percent}%`);
  if (a.max_amount !== null) parts.push(`up to ${a.max_amount.toLocaleString()}`);
  return parts.length > 0 ? parts.join(" · ") : "No configured ceiling";
}

/**
 * Seed the default governance hierarchy for every approval type that has no
 * configured authority. Everything remains editable afterwards — this is a
 * starting point, never a hard-coded rule.
 */
export function useSeedApprovalAuthority() {
  const invalidate = useInvalidate(["finance"]);
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_approval_seed_authority", { _commit: true });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: (result) => {
      const rules = Number(result["rules"] ?? 0);
      toast.success(
        rules > 0
          ? `${rules} approval authorities created — review and adjust the limits`
          : "Every approval type already has an authority configured",
      );
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
