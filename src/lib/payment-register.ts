import {VISIBLE_VIEW_REFRESH} from "@/lib/view-freshness";
import {useAuth} from '@/lib/auth';
import {parsePaymentRegister} from '@/lib/payment-register-contract';
/**
 * The one payment register.
 *
 * The database register combines saved payment attempts with source deposits,
 * deduplicating linked collections. No screen needs to manufacture a payment
 * row to show money already collected.
 *
 * The stages are deliberately distinct: a request that was *sent* is never the
 * same thing as money *received*, and money received is not the same thing as
 * money *in the ledger*.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

export const PAYMENT_STATES = [
  "requested",
  "pending",
  "confirmed",
  "posted",
  "failed",
  "cancelled",
  "timed_out",
  "refunded",
  "voided",
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

/** Plain language for each stage — no staff member should have to decode these. */
export const PAYMENT_STATE_LABEL: Record<PaymentState, string> = {
  requested: "Request sent",
  pending: "Awaiting confirmation",
  confirmed: "Money received",
  posted: "In the ledger",
  failed: "Failed",
  cancelled: "Cancelled",
  timed_out: "Timed out",
  refunded: "Refunded",
  voided: "Voided",
};

export const PAYMENT_STATE_HINT: Record<PaymentState, string> = {
  requested: "The collection was started. Nothing has been received.",
  pending: "Waiting for the provider or the cashier to confirm. Not received yet.",
  confirmed: "The money was received and receipted.",
  posted: "Received and recognised in the accounts.",
  failed: "The provider or the till refused it. No money moved.",
  cancelled: "Stopped before any money moved.",
  timed_out: "No answer arrived in time. Treat as not received until proven otherwise.",
  refunded: "The money was returned to the payer.",
  voided: "Cancelled after the fact and reversed.",
};

export type PaymentAttempt = {
  id: string;
  branch_id: string | null;
  source_module: string;
  source_record_id: string | null;
  payment_table: string;
  payment_id: string;
  method: string;
  provider_code: string | null;
  environment: string | null;
  amount: number;
  currency: string | null;
  tendered: number | null;
  change_due: number | null;
  reference: string | null;
  state: PaymentState;
  state_detail: string | null;
  manual_tender: boolean;
  verified_at: string | null;
  posted_journal_id: string | null;
  requested_at: string;
  confirmed_at: string | null;
};

export function usePaymentRegister(input: {
  branchId?: string | null;
  from?: string | null;
  to?: string | null;
  state?: PaymentState | null;
}) {
  const {organizationId,user,phase,permissions,access,permissionsLoaded,accessLoaded}=useAuth();
  const authority=JSON.stringify({permissions:[...permissions].sort(),scope:access.accessScope,branches:[...access.branchIds].sort(),departments:[...access.departmentIds].sort(),stations:[...access.stationIds].sort(),roles:[...access.roleIds].sort()});
  const branch = input.branchId && input.branchId !== "all" ? input.branchId : null;
  return useQuery<PaymentAttempt[]>({
    ...VISIBLE_VIEW_REFRESH,
    queryKey: ["payment-register", organizationId, user?.id, authority, branch, input.from, input.to, input.state ?? null],
    enabled: phase === "ready" && permissionsLoaded && accessLoaded && Boolean(organizationId && user?.id),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_payment_register", {
        _branch: branch,
        _from: input.from ?? null,
        _to: input.to ?? null,
        _state: input.state ?? null,
        _limit: 1000,
      });
      if (error) throw new Error(error.message);
      return parsePaymentRegister(data);
    },
  });
}

/**
 * Records that a person checked a manually recorded tender — a bank transfer
 * reference, a card slip — against the outside evidence. It changes no money;
 * it records who vouched for it and when.
 */
export function useVerifyManualTender() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { attemptId: string; note?: string }) => {
      const { data, error } = await guardedRpc(supabase, "neo_payment_attempt_verify", {
        _attempt: input.attemptId,
        _note: input.note ?? null,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as { ok?: boolean; detail?: string; reason?: string };
      if (!result.ok)
        throw new Error(result.detail ?? result.reason ?? "Could not verify this tender.");
      return result;
    },
    onSuccess: () => {
      toast.success("Tender verified");
      void queryClient.invalidateQueries({ queryKey: ["payment-register"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export type PaymentRegisterTotals = {
  count: number;
  received: number;
  posted: number;
  awaiting: number;
  awaitingCount: number;
  unsuccessful: number;
  unsuccessfulCount: number;
  unverified: number;
};

export function summarisePaymentRegister(rows: PaymentAttempt[]): PaymentRegisterTotals {
  const total = (states: PaymentState[]) =>
    rows.filter((r) => states.includes(r.state)).reduce((a, r) => a + Number(r.amount ?? 0), 0);
  const count = (states: PaymentState[]) => rows.filter((r) => states.includes(r.state)).length;
  return {
    count: rows.length,
    received: total(["confirmed", "posted"]),
    posted: total(["posted"]),
    awaiting: total(["requested", "pending"]),
    awaitingCount: count(["requested", "pending"]),
    unsuccessful: total(["failed", "cancelled", "timed_out"]),
    unsuccessfulCount: count(["failed", "cancelled", "timed_out"]),
    unverified: rows.filter(
      (r) => r.manual_tender && !r.verified_at && (r.state === "confirmed" || r.state === "posted"),
    ).length,
  };
}
