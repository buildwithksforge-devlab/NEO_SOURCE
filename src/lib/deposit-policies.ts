/**
 * Deposit policy and deposit reconciliation.
 *
 * A property states once how a pre-arrival deposit is calculated; every
 * reservation then reads the same rule, so the amount shown at the desk and
 * the amount enforced at check-in cannot drift apart. Reconciliation reads the
 * database view of each deposit together with its Finance posting and journal.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { guardedRpc } from "@/lib/rpc-guard";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type DepositBasis = "percentage" | "flat" | "nights";

export type DepositPolicy = {
  id: string;
  branch_id: string | null;
  rate_plan_id: string | null;
  name: string;
  basis: DepositBasis;
  value: number;
  minimum_amount: number;
  reason: string;
  priority: number;
  active: boolean;
};


export type DepositReconciliationRow = {
  deposit_id: string;
  reservation_id: string | null;
  confirmation_number: string | null;
  guest_name: string;
  property: string | null;
  arrival_date: string | null;
  departure_date: string | null;
  reservation_status: string | null;
  amount: number;
  currency: string;
  method: string | null;
  reference: string | null;
  deposit_status: string;
  received_at: string | null;
  required_amount: number;
  paid_amount: number;
  outstanding_amount: number;
  applied_folio_id: string | null;
  applied_at: string | null;
  posting_status: string | null;
  posting_receipt_id: string | null;
  posting_error: string | null;
  journal_id: string | null;
  journal_number: string | null;
  journal_debit: number;
  journal_credit: number;
  journal_status: string | null;
};

/** How a policy reads to the desk, in words rather than in configuration. */
export function describePolicy(policy: Pick<DepositPolicy, "basis" | "value" | "minimum_amount">) {
  const base =
    policy.basis === "percentage"
      ? `${policy.value}% of the stay value`
      : policy.basis === "nights"
        ? `${policy.value} night(s) at the nightly rate`
        : `A flat ${policy.value}`;
  return policy.minimum_amount > 0 ? `${base}, minimum ${policy.minimum_amount}` : base;
}

export function useDepositPolicies() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pms", "deposit-policies", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async (): Promise<DepositPolicy[]> => {
      const { data, error } = await db
        .from("deposit_policies")
        .select("*")
        .order("priority", { ascending: true });
      if (error) throw new Error(error.message);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ((data ?? []) as any[]).map((r) => ({
        id: String(r.id),
        branch_id: r.branch_id ?? null,
        rate_plan_id: r.rate_plan_id ?? null,

        name: String(r.name ?? ""),
        basis: (r.basis ?? "percentage") as DepositBasis,
        value: Number(r.value ?? 0),
        minimum_amount: Number(r.minimum_amount ?? 0),
        reason: String(r.reason ?? ""),
        priority: Number(r.priority ?? 100),
        active: Boolean(r.active),
      }));
    },
  });
}

export function useSaveDepositPolicy() {
  const { organizationId } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<DepositPolicy> & { name: string }) => {
      const payload = {
        organization_id: organizationId,
        branch_id: input.branch_id ?? null,
        rate_plan_id: input.rate_plan_id ?? null,

        name: input.name,
        basis: input.basis ?? "percentage",
        value: Number(input.value ?? 0),
        minimum_amount: Number(input.minimum_amount ?? 0),
        reason: input.reason ?? "Standard pre-arrival deposit",
        priority: Number(input.priority ?? 100),
        active: input.active ?? true,
      };
      const q = input.id
        ? db.from("deposit_policies").update(payload).eq("id", input.id)
        : db.from("deposit_policies").insert(payload);
      const { error } = await q;
      if (error) throw new Error(error.message);
      return true;
    },
    onSuccess: () => {
      toast.success("Deposit policy saved");
      void qc.invalidateQueries({ queryKey: ["pms"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useDeleteDepositPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db.from("deposit_policies").delete().eq("id", id);
      if (error) throw new Error(error.message);
      return true;
    },
    onSuccess: () => {
      toast.success("Deposit policy removed");
      void qc.invalidateQueries({ queryKey: ["pms"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Re-runs the Finance recognition for a deposit. The routine is repeat-safe:
 * a deposit already carrying a journal returns that journal rather than a
 * second entry.
 */
export function usePostDeposit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (depositId: string) => {
      const { data, error } = await guardedRpc(db, "neo_deposit_post", { _deposit: depositId });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as { ok?: boolean; reason?: string; detail?: string };
      if (result.ok === false) {
        throw new Error(result.detail ?? result.reason ?? "The deposit could not be posted.");
      }
      return result;
    },
    onSuccess: (r) => {
      toast.success(
        r.reason === "already_posted"
          ? "This deposit is already recognised in Finance"
          : "Deposit posted to Finance",
      );
      void qc.invalidateQueries({ queryKey: ["finance"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}



export function useDepositReconciliation() {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["finance", "deposit-reconciliation", organizationId, branchId ?? "all"],
    enabled: Boolean(organizationId),
    queryFn: async (): Promise<DepositReconciliationRow[]> => {
      const { data, error } = await guardedRpc(db, "neo_deposit_reconciliation", {
        _branch: branchId,
      });
      if (error) throw new Error(error.message);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ((data ?? []) as any[]).map((r) => ({
        deposit_id: String(r.deposit_id),
        reservation_id: r.reservation_id ?? null,
        confirmation_number: r.confirmation_number ?? null,
        guest_name: String(r.guest_name ?? "Guest"),
        property: r.property ?? null,
        arrival_date: r.arrival_date ?? null,
        departure_date: r.departure_date ?? null,
        reservation_status: r.reservation_status ?? null,
        amount: Number(r.amount ?? 0),
        currency: String(r.currency ?? "KES"),
        method: r.method ?? null,
        reference: r.reference ?? null,
        deposit_status: String(r.deposit_status ?? "held"),
        received_at: r.received_at ?? null,
        required_amount: Number(r.required_amount ?? 0),
        paid_amount: Number(r.paid_amount ?? 0),
        outstanding_amount: Number(r.outstanding_amount ?? 0),
        applied_folio_id: r.applied_folio_id ?? null,
        applied_at: r.applied_at ?? null,
        posting_status: r.posting_status ?? null,
        posting_receipt_id: r.posting_receipt_id ?? null,
        posting_error: r.posting_error ?? null,
        journal_id: r.journal_id ?? null,
        journal_number: r.journal_number ?? null,
        journal_debit: Number(r.journal_debit ?? 0),
        journal_credit: Number(r.journal_credit ?? 0),
        journal_status: r.journal_status ?? null,
      }));
    },
  });
}
