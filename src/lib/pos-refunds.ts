import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";
import { invalidatePaymentViews } from "@/lib/payment-view-refresh";
import {
  requireRefundDecision,
  requireRefundPayout,
  requireRefundRequest,
  validateRefundAmount,
} from "@/lib/refund-command-result";
export type RefundPayment = {
  id: string;
  receipt_number: string | null;
  amount: number;
  method: string;
  status: string;
  destination_account_id: string | null;
  refunded: number;
  reserved: number;
  refundable: number;
  legacy_review: boolean;
};
export type PosRefundPosition = { order_id: string; payments: RefundPayment[] };
function useRefundRefresh() {
  const qc = useQueryClient();
  return () =>
    Promise.all([invalidatePaymentViews(qc), qc.invalidateQueries({ queryKey: ["pos"] })]);
}
export function usePosRefundPosition(orderId: string) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pos", "refund-position", organizationId, orderId],
    enabled: Boolean(organizationId && orderId),
    refetchInterval: 15000,
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_pos_refund_position", {
        _order: orderId,
      });
      if (error) throw Error(error.message);
      const result = data as PosRefundPosition | null;
      if (!result || result.order_id !== orderId || !Array.isArray(result.payments))
        throw Error("Refund amounts could not be loaded. Refresh before requesting a payout.");
      return result;
    },
  });
}
export function useRequestRefund() {
  const refresh = useRefundRefresh();
  return useMutation({
    mutationFn: async (input: {
      orderId: string;
      paymentId: string;
      amount: number;
      reason: string;
      attempt: string;
    }) => {
      validateRefundAmount(input.amount, input.reason);
      const { data, error } = await guardedRpc(supabase, "neo_pos_refund_request", {
        _order: input.orderId,
        _payment: input.paymentId,
        _amount: input.amount,
        _reason: input.reason.trim(),
        _attempt: input.attempt,
      });
      if (error) throw Error(error.message);
      return requireRefundRequest(data);
    },
    onSuccess: async (r) => {
      await refresh();
      toast.success(
        r["status"] === "processed"
          ? "This refund was already paid out."
          : "Refund request saved for independent approval.",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
export function useDecideRefund() {
  const refresh = useRefundRefresh();
  return useMutation({
    mutationFn: async (input: { id: string; approve: boolean; note?: string }) => {
      const { data, error } = await guardedRpc(supabase, "neo_pos_refund_decide", {
        _request: input.id,
        _approve: input.approve,
        _note: input.note?.trim() || null,
      });
      if (error) throw Error(error.message);
      return requireRefundDecision(data, input.id, input.approve);
    },
    onSuccess: async (r) => {
      await refresh();
      toast.success(
        r["status"] === "approved"
          ? "Refund authorised. Payout is still required."
          : r["status"] === "processed"
            ? "Refund was already paid out."
            : "Refund rejected.",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
export function useRecordElectronicRefund() {
  const refresh = useRefundRefresh();
  return useMutation({
    mutationFn: async (input: {
      requestId: string;
      reference: string;
      accountId: string;
      completed: boolean;
    }) => {
      if (!input.completed || input.reference.trim().length < 3 || !input.accountId)
        throw Error("Confirm the completed bank/provider refund, its reference and its account.");
      const { data, error } = await guardedRpc(supabase, "neo_pos_refund_settle", {
        _request: input.requestId,
        _reference: input.reference.trim(),
        _account: input.accountId,
        _completed_externally: input.completed,
      });
      if (error) throw Error(error.message);
      return requireRefundPayout(data);
    },
    onSuccess: async () => {
      await refresh();
      toast.success("Completed refund recorded with its receipt and posted journal.");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
