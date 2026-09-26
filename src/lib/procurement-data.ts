import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { logAudit } from "@/lib/audit";
import type { Row } from "@/lib/procurement";

// The procurement trail spans many generated table types; call sites narrow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export function useProcurementCtx() {
  const { organizationId, profile, user } = useAuth();
  const { branchId: activeBranchId } = useActivePropertyFilter();
  return {
    organizationId,
    branchId: activeBranchId ?? (profile as { branch_id?: string | null } | null)?.branch_id ?? null,
    userId: user?.id ?? null,
    userName: (profile as { full_name?: string } | null)?.full_name ?? "",
  };
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["procurement"] });
    void qc.invalidateQueries({ queryKey: ["inventory"] });
  };
}

/* --------------------------------- reads --------------------------------- */

/** Every LPO ever raised, including received, closed, cancelled and voided ones. */
export function useLpos(filters?: { status?: string; supplierId?: string | null; from?: string; to?: string }) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useProcurementCtx();
  return useQuery({
    queryKey: ["procurement", "lpos", organizationId, filterKey, filters?.status, filters?.supplierId, filters?.from, filters?.to],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(db.from("purchase_orders").select("*, suppliers(name), departments(name), purchase_order_lines(*)"), "purchase_orders")
        .order("created_at", { ascending: false })
        .limit(300);
      if (filters?.status && filters.status !== "all") q = q.eq("status", filters.status);
      if (filters?.supplierId) q = q.eq("supplier_id", filters.supplierId);
      if (filters?.from) q = q.gte("created_at", filters.from);
      if (filters?.to) q = q.lte("created_at", `${filters.to}T23:59:59`);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}

/** Full requisition-to-payment trail for one LPO. */
export function useDocumentTrail(orderId: string | null) {
  const { organizationId } = useProcurementCtx();
  return useQuery({
    queryKey: ["procurement", "trail", organizationId, orderId],
    enabled: Boolean(organizationId && orderId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "proc_document_trail", { _order: orderId });
      if (error) throw error;
      return (data ?? {}) as Row;
    },
  });
}

export function useInvoiceDiscrepancies(invoiceId?: string | null) {
  const { organizationId } = useProcurementCtx();
  return useQuery({
    queryKey: ["procurement", "discrepancies", organizationId, invoiceId ?? "all"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("supplier_invoice_discrepancies")
        .select("*, supplier_invoices(invoice_number, amount, suppliers(name))")
        .eq("resolved", false)
        .order("created_at", { ascending: false })
        .limit(300);
      if (invoiceId) q = q.eq("supplier_invoice_id", invoiceId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}

export function useSupplierInvoices() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useProcurementCtx();
  return useQuery({
    queryKey: ["procurement", "invoices", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(db.from("supplier_invoices").select("*, suppliers(name), purchase_orders(order_number)"), "supplier_invoices")
        .order("invoice_date", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}

/* ------------------------------- mutations ------------------------------- */

/** Controlled lifecycle change; the database refuses without a reason. */
export function useLpoAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ orderId, action, reason }: { orderId: string; action: string; reason: string }) => {
      const { data, error } = await guardedRpc(db, "proc_lpo_action", { _order: orderId, _action: action, _reason: reason });
      if (error) throw error;
      return data as Row;
    },
    onSuccess: (_d, vars) => {
      invalidate();
      toast.success(`Purchase order ${vars.action === "check" ? "checked" : `${vars.action}${vars.action.endsWith("e") ? "d" : "ed"}`}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useThreeWayMatch() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const { data, error } = await guardedRpc(db, "proc_three_way_match", { _invoice: invoiceId });
      if (error) throw error;
      return (data ?? {}) as Row;
    },
    onSuccess: (data) => {
      invalidate();
      const critical = Number(data["critical"] ?? 0);
      const total = Number(data["discrepancies"] ?? 0);
      if (critical > 0) toast.error(`Held for review — ${critical} critical of ${total} discrepancies`);
      else if (total > 0) toast.warning(`${total} discrepancy(ies) flagged for review`);
      else toast.success("Matched — order, delivery and invoice agree");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useResolveDiscrepancy() {
  const ctx = useProcurementCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { data, error } = await db
        .from("supplier_invoice_discrepancies")
        .update({ resolved: true, resolved_by: ctx.userId, resolved_at: new Date().toISOString(), resolution_reason: reason })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as Row;
    },
    onSuccess: async (data, vars) => {
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: "procurement.discrepancy.resolved",
        module: "procurement",
        recordId: String((data as Row)["id"] ?? ""),
        newValue: data,
        reason: vars.reason,
      });
      invalidate();
      toast.success("Discrepancy explained and recorded");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------- complimentary & special-price register ------------------- */

export function useComplimentaryRegister(filters?: { from?: string; to?: string; pricingType?: string }) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useProcurementCtx();
  return useQuery({
    queryKey: ["procurement", "complimentary", organizationId, filters?.from, filters?.to, filters?.pricingType, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(db.from("complimentary_register").select("*, departments(name), branches(name)"), "complimentary_register")
        .order("created_at", { ascending: false })
        .limit(300);
      if (filters?.from) q = q.gte("created_at", filters.from);
      if (filters?.to) q = q.lte("created_at", `${filters.to}T23:59:59`);
      if (filters?.pricingType && filters.pricingType !== "all") q = q.eq("pricing_type", filters.pricingType);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}

export function useSaveComplimentary() {
  const ctx = useProcurementCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (values: Row) => {
      const { data, error } = await db
        .from("complimentary_register")
        .insert({
          ...values,
          organization_id: ctx.organizationId,
          branch_id: values["branch_id"] ?? ctx.branchId,
          requested_by: ctx.userId,
          created_by: ctx.userId,
        })
        .select()
        .single();
      if (error) throw error;
      return data as Row;
    },
    onSuccess: async (data) => {
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: "revenue.complimentary.recorded",
        module: "restaurant",
        recordId: String((data as Row)["id"] ?? ""),
        newValue: data,
        reason: String((data as Row)["reason"] ?? ""),
      });
      invalidate();
      toast.success("Recorded — awaiting approval");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useApproveComplimentary() {
  const ctx = useProcurementCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ id, approve, reason }: { id: string; approve: boolean; reason?: string }) => {
      const { data, error } = await db
        .from("complimentary_register")
        .update({
          status: approve ? "approved" : "rejected",
          approved_by: ctx.userId,
          approved_at: new Date().toISOString(),
          notes: reason ?? null,
        })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as Row;
    },
    onSuccess: async (data, vars) => {
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: vars.approve ? "revenue.complimentary.approved" : "revenue.complimentary.rejected",
        module: "restaurant",
        recordId: vars.id,
        newValue: data,
        reason: vars.reason ?? null,
      });
      invalidate();
      toast.success(vars.approve ? "Approved" : "Rejected");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------- accounting ------------------------------- */

/** A QuickBooks connection only counts when a real credentialed record exists. */
export function useQuickBooksConnection() {
  const { organizationId } = useProcurementCtx();
  return useQuery({
    queryKey: ["procurement", "quickbooks", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db
        .from("integration_connections")
        .select("*")
        .eq("provider_code", "quickbooks")
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as Row | null;
    },
  });
}

export function useAccountingSyncLog() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useProcurementCtx();
  return useQuery({
    queryKey: ["procurement", "sync-log", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(db.from("accounting_sync_log").select("*"), "accounting_sync_log")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}

/* ----------------- supplier invoice capture, matching, payables ----------------- */

export type InvoiceLineDraft = {
  description: string;
  stockItemId?: string | null;
  quantity: number;
  unitPrice: number;
  taxAmount?: number;
  discountAmount?: number;
};

export type InvoiceCapture = {
  supplierId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate?: string | null;
  orderId?: string | null;
  receiptId?: string | null;
  notes?: string | null;
  allowDuplicate?: boolean;
  lines: InvoiceLineDraft[];
};

/**
 * Supplier invoice capture is the document Finance validates before a payable
 * exists. The database refuses a repeat of the same supplier + invoice number,
 * and runs matching immediately, so a variance can never slip through unseen.
 */
export function useCaptureSupplierInvoice() {
  const ctx = useProcurementCtx();
  const invalidate = useInvalidate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: InvoiceCapture) => {
      const { data, error } = await guardedRpc(db, "neo_supplier_invoice_capture", {
        _payload: {
          branch_id: ctx.branchId,
          supplier_id: input.supplierId,
          invoice_number: input.invoiceNumber,
          invoice_date: input.invoiceDate,
          due_date: input.dueDate || null,
          order_id: input.orderId || null,
          receipt_id: input.receiptId || null,
          notes: input.notes || null,
          allow_duplicate: Boolean(input.allowDuplicate),
          lines: input.lines.map((l) => ({
            description: l.description,
            stock_item_id: l.stockItemId || null,
            quantity: l.quantity,
            unit_price: l.unitPrice,
            tax_amount: l.taxAmount ?? 0,
            discount_amount: l.discountAmount ?? 0,
          })),
        },
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Row;
    },
    onSuccess: async (data) => {
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: "procurement.supplier_invoice.captured",
        module: "finance",
        recordId: String(data["invoice_id"] ?? ""),
        newValue: data,
      });
      invalidate();
      void qc.invalidateQueries({ queryKey: ["finance"] });
      const match = (data["match"] ?? {}) as Row;
      const critical = Number(match["critical"] ?? 0);
      if (critical > 0) toast.error(`Invoice captured and held — ${critical} critical matching issue(s)`);
      else if (Number(match["discrepancies"] ?? 0) > 0) toast.warning("Invoice captured — variances flagged for review");
      else toast.success("Invoice captured and matched");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Accepting an invoice clears goods-received-not-invoiced and raises the payable. */
export function useAcceptSupplierInvoice() {
  const ctx = useProcurementCtx();
  const invalidate = useInvalidate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ invoiceId, reason }: { invoiceId: string; reason?: string }) => {
      const { data, error } = await guardedRpc(db, "neo_supplier_invoice_accept", {
        _invoice: invoiceId,
        _reason: reason ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Row;
    },
    onSuccess: async (data, vars) => {
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: "finance.supplier_invoice.accepted",
        module: "finance",
        recordId: vars.invoiceId,
        newValue: data,
        reason: vars.reason ?? null,
      });
      invalidate();
      void qc.invalidateQueries({ queryKey: ["finance"] });
      toast.success("Payable raised and posted to the ledger");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Re-attempts only the finance side of a delivery whose stock already posted.
 * The stock movement is never repeated: the routine is a no-op once a journal exists.
 */
export function useRetryReceiptAccrual() {
  const ctx = useProcurementCtx();
  const invalidate = useInvalidate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ receiptId }: { receiptId: string }) => {
      const { data, error } = await guardedRpc(db, "neo_grn_retry_accrual", {
        _receipt: receiptId,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Row;
    },
    onSuccess: async (data, vars) => {
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: "finance.goods_receipt.accrual_retried",
        module: "finance",
        recordId: vars.receiptId,
        newValue: data,
        reason: null,
      });
      invalidate();
      void qc.invalidateQueries({ queryKey: ["finance"] });
      toast.success("Delivery posted to the ledger");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Reverses a posted goods receipt: stock out, accrual reversed, order corrected. */
export function useReverseGoodsReceipt() {
  const ctx = useProcurementCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ receiptId, reason }: { receiptId: string; reason: string }) => {
      const { data, error } = await guardedRpc(db, "neo_grn_reverse", {
        _receipt: receiptId,
        _reason: reason,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Row;
    },
    onSuccess: async (data, vars) => {
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: "procurement.goods_receipt.reversed",
        module: "procurement",
        recordId: vars.receiptId,
        newValue: data,
        reason: vars.reason,
      });
      invalidate();
      toast.success("Receipt reversed — stock and accrual corrected");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Orders that can still legitimately receive an invoice. */
export function useInvoiceableOrders() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useProcurementCtx();
  return useQuery({
    queryKey: ["procurement", "invoiceable-orders", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        db
          .from("purchase_orders")
          .select("id, order_number, status, supplier_id, total_amount, currency, purchase_order_lines(id, description, stock_item_id, quantity, accepted_quantity, invoiced_quantity, unit_price)"),
        "purchase_orders",
      )
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}

/** Posted receipts for one order, so an invoice can name what it is paying for. */
export function useOrderReceipts(orderId?: string | null) {
  const { organizationId } = useProcurementCtx();
  return useQuery({
    queryKey: ["procurement", "order-receipts", organizationId, orderId ?? "none"],
    enabled: Boolean(organizationId && orderId),
    queryFn: async () => {
      const { data, error } = await db
        .from("goods_receipts")
        .select("id, grn_number, status, received_at, total_value, accrual_journal_id, accrued_value")
        .eq("order_id", orderId)
        .order("received_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}

export type MatchingPolicy = {
  id?: string;
  match_mode: "two-way" | "three-way";
  price_tolerance_pct: number;
  price_tolerance_amount: number;
  quantity_tolerance_pct: number;
};

/** The configured matching policy for the active property (org default applies otherwise). */
export function useMatchingPolicy() {
  const { organizationId, branchId } = useProcurementCtx();
  return useQuery({
    queryKey: ["procurement", "matching-policy", organizationId, branchId ?? "org"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_matching_policy", {
        _org: organizationId,
        _branch: branchId,
      });
      if (error) throw new Error(error.message);
      return (data ?? null) as Row | null;
    },
  });
}

export function useSaveMatchingPolicy() {
  const ctx = useProcurementCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (values: MatchingPolicy) => {
      const payload = {
        organization_id: ctx.organizationId,
        branch_id: ctx.branchId,
        match_mode: values.match_mode,
        price_tolerance_pct: values.price_tolerance_pct,
        price_tolerance_amount: values.price_tolerance_amount,
        quantity_tolerance_pct: values.quantity_tolerance_pct,
      };
      const { data, error } = await db
        .from("procurement_matching_policies")
        .upsert(payload, { onConflict: "organization_id,branch_id" })
        .select()
        .single();
      if (error) throw error;
      return data as Row;
    },
    onSuccess: async (data) => {
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: "procurement.matching_policy.saved",
        module: "finance",
        recordId: String((data as Row)["id"] ?? ""),
        newValue: data,
      });
      invalidate();
      toast.success("Matching policy saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Recent goods receipts with the accounting consequence each one produced. */
export function useRecentGoodsReceipts(limit = 25) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useProcurementCtx();
  return useQuery({
    queryKey: ["procurement", "recent-receipts", organizationId, filterKey, limit],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        db
          .from("goods_receipts")
          .select(
            "id, grn_number, status, received_at, total_value, accrued_value, accrual_journal_id, accrual_error, reversal_journal_id, reversed_at, reversal_reason, suppliers(name), purchase_orders(order_number)",
          ),
        "goods_receipts",
      )
        .order("received_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}
