import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";

/**
 * Cash routing and till ownership.
 *
 * Billing (who raises the charge) and cash handling (who physically takes the
 * notes) are separate acts. A user who holds their own open till settles
 * directly; anyone else raises a cash request that is routed to an active till,
 * and the cashier confirms the money was physically received. Confirmation is
 * atomic and repeat-safe in the database: payment, receipt, folio settlement,
 * till attribution and audit either all happen once, or not at all.
 */

// The generated RPC union is large; bind through an untyped handle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = supabase as any;

async function unwrap<T>(
  call: Promise<{ data: T; error: { message: string } | null }>,
): Promise<T> {
  const { data, error } = await call;
  if (error) throw new Error(error.message);
  return data;
}

export type TillContext = {
  can_open_drawer: boolean;
  can_confirm_cash: boolean;
  my_shift_id: string | null;
  my_shift_number: string | null;
  self_service: boolean;
  active_tills: {
    shift_id: string;
    shift_number: string | null;
    cashier_id: string;
    cashier_name: string;
    branch_id: string | null;
    opened_at: string;
  }[];
};

export type CashRequest = {
  id: string;
  branch_id: string | null;
  folio_id: string | null;
  amount: number;
  currency: string;
  method: string;
  reference: string | null;
  notes: string | null;
  status: "pending" | "confirmed" | "cancelled" | "failed";
  requested_by: string | null;
  assigned_shift_id: string | null;
  assigned_cashier_id: string | null;
  payment_id: string | null;
  receipt_number: string | null;
  confirmed_at: string | null;
  cancelled_reason: string | null;
  created_at: string;
};

export type CashRequestResult = {
  status: "confirmed" | "pending" | "cancelled" | "no_till";
  request_id?: string;
  payment_id?: string;
  receipt_number?: string;
  amount?: number;
  message?: string;
  assigned_cashier_id?: string;
};

export function useTillContext(branchId?: string | null) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["cash", "till-context", organizationId, branchId ?? "all"],
    enabled: Boolean(organizationId),
    queryFn: () =>
      unwrap(
        guardedRpc<TillContext>(client, "neo_cash_till_context", { _branch: branchId ?? null }),
      ),
    refetchInterval: 30_000,
  });
}

function useInvalidateCash() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["cash"] });
    void qc.invalidateQueries({ queryKey: ["pms"] });
    void qc.invalidateQueries({ queryKey: ["finance"] });
    void qc.invalidateQueries({ queryKey: ["pos"] });
  };
}

export function useRequestCashPayment() {
  const invalidate = useInvalidateCash();
  return useMutation({
    mutationFn: (input: {
      folio: string;
      amount: number;
      reference?: string;
      notes?: string;
      idempotencyKey?: string;
    }) =>
      unwrap(
        guardedRpc<CashRequestResult>(client, "neo_cash_request_payment", {
          _folio: input.folio,
          _amount: input.amount,
          _reference: input.reference ?? null,
          _notes: input.notes ?? "",
          _idempotency_key: input.idempotencyKey ?? null,
        }),
      ),
    onSuccess: (result) => {
      invalidate();
      if (result.status === "confirmed") {
        toast.success(`Cash received — receipt ${result.receipt_number ?? ""}`.trim());
      } else if (result.status === "pending") {
        toast.success("Sent to the cashier for cash confirmation");
      } else if (result.status === "no_till") {
        toast.error(result.message ?? "No active cash drawer is available.");
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useConfirmCashReceipt() {
  const invalidate = useInvalidateCash();
  return useMutation({
    mutationFn: (request: string) =>
      unwrap(
        guardedRpc<CashRequestResult>(client, "neo_cash_confirm_receipt", { _request: request }),
      ),
    onSuccess: (result) => {
      invalidate();
      toast.success(`Cash confirmed — receipt ${result.receipt_number ?? ""}`.trim());
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useCancelCashRequest() {
  const invalidate = useInvalidateCash();
  return useMutation({
    mutationFn: (input: { request: string; reason: string }) =>
      unwrap(
        guardedRpc<CashRequestResult>(client, "neo_cash_cancel_request", {
          _request: input.request,
          _reason: input.reason,
        }),
      ),
    onSuccess: () => {
      invalidate();
      toast.success("Cash request cancelled");
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/** Requests routed to the signed-in cashier's till, awaiting physical receipt. */
export function useMyCashRequests() {
  const { organizationId, user } = useAuth();
  return useQuery({
    queryKey: ["cash", "requests", "mine", organizationId, user?.id],
    enabled: Boolean(organizationId && user?.id),
    queryFn: async () => {
      const { data, error } = await client
        .from("cash_payment_requests")
        .select("*")
        .eq("assigned_cashier_id", user!.id)
        .eq("status", "pending")
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message as string);
      return (data ?? []) as CashRequest[];
    },
    refetchInterval: 10_000,
  });
}

/** Requests raised against one folio, so the desk can watch confirmation land. */
export function useFolioCashRequests(folioId: string | null) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["cash", "requests", "folio", organizationId, folioId],
    enabled: Boolean(organizationId && folioId),
    queryFn: async () => {
      const { data, error } = await client
        .from("cash_payment_requests")
        .select("*")
        .eq("folio_id", folioId)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw new Error(error.message as string);
      return (data ?? []) as CashRequest[];
    },
    refetchInterval: 10_000,
  });
}

/* ------------------------------------------------------------------ *
 * POS-side routing — a POS cash payment follows exactly the same
 * request → cashier confirmation path as folio billing.
 * ------------------------------------------------------------------ */

export function useRequestPosCashPayment() {
  const invalidate = useInvalidateCash();
  return useMutation({
    mutationFn: (input: {
      order: string;
      amount: number;
      reference?: string;
      notes?: string;
      idempotencyKey?: string;
    }) =>
      unwrap(
        guardedRpc<CashRequestResult>(client, "neo_cash_request_pos_payment", {
          _order: input.order,
          _amount: input.amount,
          _reference: input.reference ?? null,
          _notes: input.notes ?? "",
          _idempotency_key: input.idempotencyKey ?? null,
        }),
      ),
    onSuccess: (result) => {
      invalidate();
      if (result.status === "confirmed") {
        toast.success(`Cash received — receipt ${result.receipt_number ?? ""}`.trim());
      } else if (result.status === "pending") {
        toast.success("Sent to the cashier for cash confirmation");
      } else if (result.status === "no_till") {
        toast.error(result.message ?? "No active cash drawer is available.");
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/* ------------------------------------------------------------------ *
 * Transfers between tills — money only counts in the receiving drawer
 * once that cashier confirms it physically arrived.
 * ------------------------------------------------------------------ */

export type CashTransfer = {
  id: string;
  transfer_number: string;
  amount: number;
  status: "in_transit" | "received" | "cancelled";
  destination: string;
  notes: string | null;
  cancelled_reason: string | null;
  from_shift_id: string | null;
  to_shift_id: string | null;
  sent_at: string | null;
  received_at: string | null;
  sent_by_name: string;
  received_by_name: string | null;
  to_cashier_id: string | null;
  to_cashier_name: string;
  mine_to_confirm: boolean;
};

export function useCashTransfers(branchId?: string | null) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["cash", "transfers", organizationId, branchId ?? "all"],
    enabled: Boolean(organizationId),
    queryFn: async () =>
      (await unwrap(
        guardedRpc<CashTransfer[]>(client, "neo_cash_transfers", { _branch: branchId ?? null }),
      )) ?? [],
    refetchInterval: 20_000,
  });
}

export function useSendCashTransfer() {
  const invalidate = useInvalidateCash();
  return useMutation({
    mutationFn: (input: {
      amount: number;
      toShift?: string | null;
      destination?: string;
      notes?: string;
    }) =>
      unwrap(
        guardedRpc<{ transfer_number: string }>(client, "neo_cash_transfer_send", {
          _amount: input.amount,
          _to_shift: input.toShift ?? null,
          _destination: input.destination ?? "till",
          _notes: input.notes ?? "",
        }),
      ),
    onSuccess: (r) => {
      invalidate();
      toast.success(`Transfer ${r.transfer_number} sent — awaiting confirmation`);
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useConfirmCashTransfer() {
  const invalidate = useInvalidateCash();
  return useMutation({
    mutationFn: (transfer: string) =>
      unwrap(guardedRpc<{ transfer_number: string }>(client, "neo_cash_transfer_confirm", {
        _transfer: transfer,
      })),
    onSuccess: (r) => {
      invalidate();
      toast.success(`Transfer ${r.transfer_number} received into your till`);
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useCancelCashTransfer() {
  const invalidate = useInvalidateCash();
  return useMutation({
    mutationFn: (input: { transfer: string; reason: string }) =>
      unwrap(guardedRpc(client, "neo_cash_transfer_cancel", {
        _transfer: input.transfer,
        _reason: input.reason,
      })),
    onSuccess: () => {
      invalidate();
      toast.success("Transfer cancelled and returned to your till");
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/* ------------------------------------------------------------------ *
 * Refunds — always raised against the original receipt, approved above
 * a configured threshold, and paid out of a named till.
 * ------------------------------------------------------------------ */

export type CashRefund = {
  id: string;
  amount: number;
  currency: string;
  reason: string;
  status: "pending_approval" | "approved" | "rejected" | "settled";
  requires_approval: boolean;
  original_receipt_number: string | null;
  payment_id: string | null;
  folio_id: string | null;
  refund_receipt_number: string | null;
  refund_payment_id: string | null;
  requested_by_name: string;
  approved_by_name: string | null;
  decision_note: string | null;
  created_at: string;
  settled_at: string | null;
  mine: boolean;
};

export function useCashRefunds(branchId?: string | null) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["cash", "refunds", organizationId, branchId ?? "all"],
    enabled: Boolean(organizationId),
    queryFn: async () =>
      (await unwrap(
        guardedRpc<CashRefund[]>(client, "neo_cash_refunds", { _branch: branchId ?? null }),
      )) ?? [],
    refetchInterval: 20_000,
  });
}

export function useRequestCashRefund() {
  const invalidate = useInvalidateCash();
  return useMutation({
    mutationFn: (input: { payment: string; amount: number; reason: string }) =>
      unwrap(
        guardedRpc<{ status: string; threshold: number }>(client, "neo_cash_refund_request", {
          _payment: input.payment,
          _amount: input.amount,
          _reason: input.reason,
        }),
      ),
    onSuccess: (r) => {
      invalidate();
      toast.success(
        r.status === "approved"
          ? "Refund authorised — pay it out from your till"
          : `Refund above the ${r.threshold} approval threshold — sent for approval`,
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useDecideCashRefund() {
  const invalidate = useInvalidateCash();
  return useMutation({
    mutationFn: (input: { refund: string; approve: boolean; note?: string }) =>
      unwrap(
        guardedRpc<{ status: string }>(client, "neo_cash_refund_decide", {
          _refund: input.refund,
          _approve: input.approve,
          _note: input.note ?? null,
        }),
      ),
    onSuccess: (r) => {
      invalidate();
      toast.success(r.status === "approved" ? "Refund approved" : "Refund rejected");
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useSettleCashRefund() {
  const invalidate = useInvalidateCash();
  return useMutation({
    mutationFn: (refund: string) =>
      unwrap(
        guardedRpc<{ refund_receipt_number: string }>(client, "neo_cash_refund_settle", {
          _refund: refund,
        }),
      ),
    onSuccess: (r) => {
      invalidate();
      toast.success(`Refund paid out — receipt ${r.refund_receipt_number ?? ""}`.trim());
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/* ------------------------------------------------------------------ *
 * End-of-shift reconciliation and the single payment trace.
 * ------------------------------------------------------------------ */

export type ShiftReconciliation = {
  shift_id: string;
  shift_number: string | null;
  status: string;
  opened_at: string;
  closed_at: string | null;
  opening_float: number;
  total_drops: number;
  total_paid_outs: number;
  expected_cash: number;
  counted_cash: number | null;
  variance: number | null;
  variance_reason: string | null;
  folio_receipts: {
    payment_id: string;
    receipt_number: string | null;
    amount: number;
    method: string;
    paid_at: string;
    folio_id: string | null;
    source_module: string | null;
    journal_id: string | null;
    journal_number: string | null;
    posting_status: string | null;
  }[];
  pos_receipts: {
    payment_id: string;
    receipt_number: string | null;
    amount: number;
    order_id: string | null;
    paid_at: string;
    journal_id: string | null;
    journal_number: string | null;
    posting_status: string | null;
  }[];
  movements: {
    id: string;
    type: string;
    amount: number;
    reason: string | null;
    reference: string | null;
    created_at: string;
  }[];
  transfers_in: { id: string; transfer_number: string; amount: number; status: string }[];
  transfers_out: { id: string; transfer_number: string; amount: number; status: string }[];
  refunds: {
    id: string;
    amount: number;
    original_receipt_number: string | null;
    refund_receipt_number: string | null;
    reason: string;
    settled_at: string | null;
  }[];
};

export function useShiftReconciliation(shiftId: string | null) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["cash", "reconciliation", organizationId, shiftId],
    enabled: Boolean(organizationId && shiftId),
    queryFn: () =>
      unwrap(
        guardedRpc<ShiftReconciliation>(client, "neo_cash_shift_reconciliation", {
          _shift: shiftId,
        }),
      ),
  });
}

export type PaymentTrace = {
  payment: {
    id: string;
    receipt_number: string | null;
    amount: number;
    method: string | null;
    status: string | null;
    paid_at: string | null;
    folio_id: string | null;
    order_id: string | null;
    currency: string | null;
  };
  request: {
    id: string;
    status: string;
    assigned_cashier_id: string | null;
    confirmed_at: string | null;
    source_module: string | null;
  } | null;
  till: {
    shift_id: string;
    shift_number: string | null;
    cashier_id: string | null;
    status: string;
    opened_at: string;
    closed_at: string | null;
    variance: number | null;
  } | null;
  posting: {
    id: string;
    status: string;
    posting_type: string | null;
    attempts: number | null;
    last_error: string | null;
    posted_at: string | null;
  } | null;
  journal: {
    id: string;
    journal_number: string | null;
    status: string;
    accounting_date: string | null;
    total_debit: number;
    total_credit: number;
    lines: { account_code: string | null; account_name: string | null; debit: number; credit: number }[];
  } | null;
  audit: {
    id: string;
    action: string;
    created_at: string;
    user_name: string | null;
    reason: string | null;
  }[];
};

export function usePaymentTrace(paymentId: string | null) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["cash", "trace", organizationId, paymentId],
    enabled: Boolean(organizationId && paymentId),
    queryFn: () =>
      unwrap(guardedRpc<PaymentTrace>(client, "neo_cash_payment_trace", { _payment: paymentId })),
  });
}
