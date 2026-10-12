/**
 * Stores â†” Procurement lifecycle.
 *
 * Requisition â†’ approval â†’ purchase order â†’ receipt â†’ stock, plus store issues
 * and returns. Every write goes through one transactional database routine that
 * checks capability and property scope itself, and every submission carries a
 * fresh attempt key so a retry replays the original outcome instead of creating
 * a second document or a second stock movement.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

// The procurement trail spans many generated table types; call sites narrow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type LifecycleResult = Record<string, unknown>;

/** One key per user submission, not per attempt â€” retries must reuse it. */
export function newAttemptKey(): string {
  return crypto.randomUUID();
}

export type ReceiptLineInput = {
  order_line_id: string;
  quantity_received: number;
  quantity_rejected?: number;
  rejection_reason?: string;
  quantity_damaged?: number;
  unit_price?: number;
  batch_number?: string;
  expiry_date?: string;
  notes?: string;
  /** Written justification for exceeding the outstanding quantity on THIS line. */
  over_receipt_reason?: string;
};

export type IssueLineInput = { stock_item_id: string; quantity: number; unit?: string };

function useLifecycleInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["procurement"] });
    void qc.invalidateQueries({ queryKey: ["inventory"] });
    void qc.invalidateQueries({ queryKey: ["reconciliation"] });
  };
}

function replayNote(data: LifecycleResult, message: string) {
  if (data["replayed"] === true) toast.info("Already recorded â€” showing the original result.");
  else toast.success(message);
}

/* ------------------------------ requisitions ------------------------------ */

export function useSubmitRequisition() {
  const invalidate = useLifecycleInvalidate();
  return useMutation({
    mutationFn: async ({ requestId, attemptKey }: { requestId: string; attemptKey: string }) => {
      const { data, error } = await guardedRpc(db, "neo_procurement_request_submit", {
        _request: requestId,
        _attempt: attemptKey,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as LifecycleResult;
    },
    onSuccess: (data) => {
      invalidate();
      replayNote(data, `Requisition ${String(data["request_number"] ?? "")} sent for approval`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useDecideRequisition() {
  const invalidate = useLifecycleInvalidate();
  return useMutation({
    mutationFn: async ({
      requestId,
      decision,
      reason,
    }: {
      requestId: string;
      decision: "approve" | "reject";
      reason?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_procurement_request_decide", {
        _request: requestId,
        _decision: decision,
        _reason: reason ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as LifecycleResult;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Requisition ${String(data["status"] ?? "updated")}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useCreateOrderFromRequest() {
  const invalidate = useLifecycleInvalidate();
  return useMutation({
    mutationFn: async (input: {
      requestId: string;
      supplierId: string;
      expectedDate?: string | null;
      locationId?: string | null;
      attemptKey: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_procurement_order_from_request", {
        _request: input.requestId,
        _supplier: input.supplierId,
        _expected: input.expectedDate ?? null,
        _attempt: input.attemptKey,
        _location: input.locationId ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as LifecycleResult;
    },
    onSuccess: (data) => {
      invalidate();
      replayNote(data, `Purchase order ${String(data["order_number"] ?? "")} raised`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useApproveOrder() {
  const invalidate = useLifecycleInvalidate();
  return useMutation({
    mutationFn: async ({ orderId, reason }: { orderId: string; reason?: string }) => {
      const { data, error } = await guardedRpc(db, "neo_procurement_order_approve", {
        _order: orderId,
        _reason: reason ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as LifecycleResult;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Purchase order approved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Procurement prices a requested line before the request goes for approval.
 * The request total is recalculated by the database, never by the screen.
 */
export function useSetRequestLinePrice() {
  const invalidate = useLifecycleInvalidate();
  return useMutation({
    mutationFn: async ({ lineId, unitPrice }: { lineId: string; unitPrice: number }) => {
      const { data, error } = await guardedRpc(db, "neo_procurement_request_price_line", {
        _line: lineId,
        _price: unitPrice,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as LifecycleResult;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Estimated price saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* -------------------------------- receiving ------------------------------- */

export function useReceiveGoods() {
  const invalidate = useLifecycleInvalidate();
  return useMutation({
    mutationFn: async (input: {
      orderId: string;
      locationId: string;
      lines: ReceiptLineInput[];
      attemptKey: string;
      notes?: string;
      overReceiptReason?: string;
      deliveryNoteNumber?: string;
      supplierInvoiceNumber?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_stores_receive_goods", {
        _order: input.orderId,
        _location: input.locationId,
        _lines: input.lines,
        _attempt: input.attemptKey,
        _notes: input.notes ?? null,
        _over_receipt_reason: input.overReceiptReason ?? null,
        _delivery_note: input.deliveryNoteNumber ?? null,
        _supplier_invoice: input.supplierInvoiceNumber ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as LifecycleResult;
    },
    onSuccess: (data) => {
      invalidate();
      replayNote(
        data,
        `${String(data["grn_number"] ?? "Delivery")} received${data["partial"] === true ? " (partial)" : ""} and posted to stock`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* --------------------------- issues and returns --------------------------- */

export function useStoreIssue() {
  const invalidate = useLifecycleInvalidate();
  return useMutation({
    mutationFn: async (input: {
      locationId: string;
      lines: IssueLineInput[];
      attemptKey: string;
      departmentId?: string | null;
      reason: string;
      direction: "issue" | "return";
    }) => {
      const { data, error } = await guardedRpc(db, "neo_stores_issue", {
        _location: input.locationId,
        _lines: input.lines,
        _attempt: input.attemptKey,
        _department: input.departmentId ?? null,
        _reason: input.reason,
        _direction: input.direction,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as LifecycleResult;
    },
    onSuccess: (data) => {
      invalidate();
      replayNote(data, data["direction"] === "return" ? "Return posted to stock" : "Issue posted from stock");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------- low stock -------------------------------- */

export function useLowStockScan() {
  const { branchId } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_stores_low_stock_scan", { _branch: branchId ?? null });
      if (error) throw new Error(error.message);
      return (data ?? {}) as LifecycleResult;
    },
    onSuccess: (data) => {
      const found = Number(data["items_below_minimum"] ?? 0);
      if (found === 0) toast.success("Nothing is below its minimum level");
      else toast.warning(`${found} item${found === 1 ? "" : "s"} below minimum â€” buyers notified`);
    },
    onError: (e: Error) => toast.error(e.message),
    meta: { organizationId },
  });
}

/* --------------------------------- reads ---------------------------------- */

/** Purchase orders that are open for receiving, with their outstanding lines. */
export function useReceivableOrders() {
  const { organizationId } = useAuth();
  const { branchId, filterKey } = useActivePropertyFilter();

  return useQuery({
    queryKey: ["procurement", "blind-receiving", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(
        db,
        "neo_blind_receiving_orders",
        {},
      );

      if (error) throw new Error(error.message);

      const rows = Array.isArray(data) ? data : [];

      return rows
        .filter((order: any) =>
          !branchId || order.branch_id === branchId
        )
        .map((order: any) => ({
          id: order.id,
          order_number: order.order_number,
          supplier_name: order.supplier_name,
          branch_id: order.branch_id,
          deliver_to_location_id: order.deliver_to_location_id,
          items: Array.isArray(order.items) ? order.items : [],
        }));
    },
  });
}

export function outstandingOf(line: Record<string, unknown>): number {
  const ordered = Number(line["quantity"] ?? 0);
  const cancelled = Number(line["cancelled_quantity"] ?? 0);
  const received = Number(line["received_quantity"] ?? 0);
  return Math.max(ordered - cancelled - received, 0);
}
