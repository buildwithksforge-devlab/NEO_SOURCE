/**
 * Procurement department layer.
 *
 * Procurement is a one-role department: the Procurement Manager sources,
 * quotes, compares, orders and follows suppliers. They never receive their own
 * delivery (that is the Receiving Clerk), never move stock balances and never
 * pay a supplier. Those boundaries are enforced in the database as well as
 * here, so this layer only ever reads receiving and payment status.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type ProcRow = Record<string, unknown>;

export const PROCUREMENT_SUPPLY_SUGGESTIONS = [
  "Stationery",
  "Printing supplies",
  "Order files",
  "Procurement office consumables",
] as const;

export function str(value: unknown, fallback = "—"): string {
  const s = value === null || value === undefined ? "" : String(value);
  return s.trim() === "" ? fallback : s;
}

export function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function useProcurementContext() {
  const { organizationId, profile } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const fallback = (profile as { branch_id?: string | null } | null)?.branch_id ?? null;
  return { organizationId, branchId: branchId ?? fallback };
}

function useProcurementInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["procurement-department"] });
    void qc.invalidateQueries({ queryKey: ["inventory"] });
  };
}

import { useScopedDepartmentByKey } from "@/lib/scoped-options";
import { applyStockNeedStatus } from "@/lib/stock-needs";
export function useProcurementDepartment() {
  return useScopedDepartmentByKey("procure|purchas|supply.?chain");
}

/* ------------------------------------------------------------------ *
 * Quotations and comparison
 * ------------------------------------------------------------------ */

export function useSupplierQuotations(requestId: string | null) {
  const { organizationId } = useProcurementContext();
  return useQuery({
    queryKey: ["procurement-department", "quotations", organizationId, requestId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("supplier_quotations")
        .select("*, suppliers:supplier_id(id, name, payment_terms, credit_terms_days, rating, on_time_deliveries, late_deliveries)")
        .order("created_at", { ascending: false })
        .limit(200);
      if (requestId) q = q.eq("request_id", requestId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as ProcRow[];
    },
  });
}

export function useQuotationLines(quotationId: string | null) {
  return useQuery({
    queryKey: ["procurement-department", "quotation-lines", quotationId],
    enabled: Boolean(quotationId),
    queryFn: async () => {
      const { data, error } = await db
        .from("supplier_quotation_lines")
        .select("*")
        .eq("quotation_id", quotationId)
        .order("created_at")
        .limit(300);
      if (error) throw new Error(error.message);
      return (data ?? []) as ProcRow[];
    },
  });
}

export function useRecordQuotation() {
  const invalidate = useProcurementInvalidate();
  const { organizationId, branchId } = useProcurementContext();
  return useMutation({
    mutationFn: async (input: {
      requestId: string;
      supplierId: string;
      totalAmount: number;
      validUntil?: string | null;
      notes?: string | null;
      quotationNumber?: string | null;
    }) => {
      if (!organizationId) throw new Error("No organisation context");
      if (!input.supplierId) throw new Error("Select the supplier who quoted");
      const { error } = await db.from("supplier_quotations").insert({
        organization_id: organizationId,
        branch_id: branchId ?? null,
        supplier_id: input.supplierId,
        request_id: input.requestId,
        quotation_number:
          input.quotationNumber?.trim() ||
          `QT-${new Date().toISOString().slice(2, 7).replace("-", "")}-${Math.floor(Math.random() * 9000 + 1000)}`,
        status: "received",
        valid_until: input.validUntil || null,
        total_amount: input.totalAmount,
        notes: input.notes ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Quotation recorded for comparison");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Recommend a supplier. Awarding above the buyer's authority still needs approval. */
export function useSelectQuotation() {
  const invalidate = useProcurementInvalidate();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (input: { quotationId: string; requestId: string | null; reason: string }) => {
      if (!input.reason.trim()) throw new Error("Record why this supplier is recommended");
      if (input.requestId) {
        const { error: clearError } = await db
          .from("supplier_quotations")
          .update({ selected: false, updated_at: new Date().toISOString() })
          .eq("request_id", input.requestId);
        if (clearError) throw new Error(clearError.message);
      }
      const { error } = await db
        .from("supplier_quotations")
        .update({
          selected: true,
          status: "selected",
          selected_by: user?.id ?? null,
          selected_at: new Date().toISOString(),
          selection_reason: input.reason.trim(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", input.quotationId);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Supplier recommended — the order still follows the approval rules");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Requests for quotation
 *
 * An RFQ is the invitation that precedes a quotation. Suppliers have no
 * accounts here, so the system never claims to have contacted anyone: an
 * invitation is "prepared" until a person downloads it, marks it sent by hand,
 * or a configured communications provider despatches it.
 * ------------------------------------------------------------------ */

export const RFQ_DISPATCH_STATES = {
  prepared: "Prepared",
  "ready-to-send": "Ready to send",
  downloaded: "Downloaded",
  "marked-sent": "Marked sent manually",
  sent: "Sent by the system",
} as const;

export type RfqDispatchState = keyof typeof RFQ_DISPATCH_STATES;

export function useRfqs(requestId: string | null) {
  const { organizationId } = useProcurementContext();
  return useQuery({
    queryKey: ["procurement-department", "rfqs", organizationId, requestId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("rfqs")
        .select("*, rfq_suppliers(id, supplier_id, dispatch_state, dispatch_channel, dispatched_at, dispatch_note, responded_at, suppliers:supplier_id(id, name, email, phone, whatsapp))")
        .order("created_at", { ascending: false })
        .limit(100);
      if (requestId) q = q.eq("request_id", requestId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as ProcRow[];
    },
  });
}

/** Raise one RFQ against a purchase request and invite one or more suppliers. */
export function useCreateRfq() {
  const invalidate = useProcurementInvalidate();
  const { organizationId, branchId } = useProcurementContext();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (input: {
      requestId: string;
      supplierIds: string[];
      title?: string | null;
      closesAt?: string | null;
      notes?: string | null;
    }) => {
      if (!organizationId) throw new Error("No organisation context");
      if (!input.requestId) throw new Error("Select the purchase request this RFQ sources");
      if (input.supplierIds.length === 0) throw new Error("Invite at least one supplier");

      const { data: seq } = await guardedRpc(db, "next_document_number", { _doc_type: "rfq" });
      const rfqNumber =
        (seq as string | null) ??
        `RFQ-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.floor(Math.random() * 9000 + 1000)}`;

      const { data: rfq, error } = await db
        .from("rfqs")
        .insert({
          organization_id: organizationId,
          branch_id: branchId ?? null,
          request_id: input.requestId,
          rfq_number: rfqNumber,
          title: input.title?.trim() || null,
          status: "issued",
          issued_at: new Date().toISOString(),
          closes_at: input.closesAt || null,
          notes: input.notes ?? null,
          created_by: user?.id ?? null,
        })
        .select("id, rfq_number")
        .single();
      if (error) throw new Error(error.message);

      const { error: inviteError } = await db.from("rfq_suppliers").insert(
        input.supplierIds.map((supplierId) => ({
          organization_id: organizationId,
          rfq_id: (rfq as { id: string }).id,
          supplier_id: supplierId,
          dispatch_state: "prepared",
        })),
      );
      if (inviteError) throw new Error(inviteError.message);
      return rfq as { id: string; rfq_number: string };
    },
    onSuccess: (rfq) => {
      invalidate();
      toast.success(`${rfq.rfq_number} prepared — nothing is sent until you despatch it`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Record how an invitation actually left the building. Never assumed, always stated. */
export function useRecordRfqDispatch() {
  const invalidate = useProcurementInvalidate();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (input: {
      inviteId: string;
      state: RfqDispatchState;
      channel?: string | null;
      note?: string | null;
    }) => {
      if (!(input.state in RFQ_DISPATCH_STATES)) throw new Error("Unknown despatch state");
      const { error } = await db
        .from("rfq_suppliers")
        .update({
          dispatch_state: input.state,
          dispatch_channel: input.channel ?? null,
          dispatch_note: input.note ?? null,
          dispatched_at: input.state === "prepared" ? null : new Date().toISOString(),
          dispatched_by: input.state === "prepared" ? null : (user?.id ?? null),
        })
        .eq("id", input.inviteId);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Supplier communication recorded");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}


/* ------------------------------------------------------------------ *
 * Supplier order follow-up: ordered vs received vs outstanding
 * ------------------------------------------------------------------ */

export function useOrderTracking() {
  const { organizationId, branchId } = useProcurementContext();
  return useQuery({
    queryKey: ["procurement-department", "order-tracking", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("purchase_orders")
        .select(
          "*, suppliers:supplier_id(id, name, phone, email), purchase_order_lines(id, description, quantity, received_quantity, accepted_quantity, unit, unit_price)",
        )
        .in("status", ["approved", "pending-delivery", "sent", "partially-received", "partially-invoiced"])
        .order("expected_date", { ascending: true, nullsFirst: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return ((data ?? []) as ProcRow[]).map((order) => {
        const lines = (order["purchase_order_lines"] ?? []) as ProcRow[];
        const ordered = lines.reduce((sum, l) => sum + num(l["quantity"]), 0);
        const received = lines.reduce(
          (sum, l) => sum + num(l["accepted_quantity"] ?? l["received_quantity"]),
          0,
        );
        const expected = order["expected_date"] ? new Date(String(order["expected_date"])).getTime() : null;
        return {
          ...order,
          ordered_quantity: ordered,
          received_quantity: received,
          outstanding_quantity: Math.max(ordered - received, 0),
          is_overdue: expected !== null && expected < Date.now() && ordered - received > 0,
        } as ProcRow;
      });
    },
  });
}

/** Read-only receiving status — Procurement follows up, never posts a GRN. */
export function useRecentReceipts() {
  const { organizationId, branchId } = useProcurementContext();
  return useQuery({
    queryKey: ["procurement-department", "receipts", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("goods_receipts")
        .select("*, suppliers:supplier_id(id, name)")
        .order("received_at", { ascending: false })
        .limit(50);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as ProcRow[];
    },
  });
}

/* ------------------------------------------------------------------ *
 * Procurement tasks
 * ------------------------------------------------------------------ */

export function useProcurementTasks() {
  const { organizationId, branchId } = useProcurementContext();
  const department = useProcurementDepartment();
  const departmentId = department.data?.["id"] ? String(department.data["id"]) : null;
  return useQuery({
    queryKey: ["procurement-department", "tasks", organizationId, branchId, departmentId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("tasks")
        .select("*")
        .order("due_at", { ascending: true, nullsFirst: false })
        .limit(200);
      if (departmentId) q = q.eq("department_id", departmentId);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as ProcRow[];

      // Automatic follow-ups carry the purchase order in their reference; read
      // the orders once so each task can link to the order and its supplier.
      const orderIds = Array.from(
        new Set(
          rows
            .map((r) => String(r["reference"] ?? ""))
            .filter((ref) => ref.startsWith("po-followup:"))
            .map((ref) => ref.slice("po-followup:".length))
            .filter(Boolean),
        ),
      );
      if (orderIds.length === 0) return rows;

      const { data: orders } = await db
        .from("purchase_orders")
        .select("id, order_number, status, close_reason, closed_at, closed_by, suppliers(name)")
        .in("id", orderIds);
      const byId = new Map<string, ProcRow>(
        ((orders ?? []) as ProcRow[]).map((o) => [String(o["id"]), o]),
      );
      return rows.map((r) => {
        const ref = String(r["reference"] ?? "");
        if (!ref.startsWith("po-followup:")) return r;
        const order = byId.get(ref.slice("po-followup:".length));
        return order ? { ...r, purchase_order: order } : r;
      });
    },
  });
}

export function useCreateProcurementTask() {
  const invalidate = useProcurementInvalidate();
  const { organizationId, branchId } = useProcurementContext();
  const { user } = useAuth();
  const department = useProcurementDepartment();
  return useMutation({
    mutationFn: async (input: { title: string; dueAt?: string | null; priority?: string; description?: string }) => {
      if (!organizationId) throw new Error("No organisation context");
      if (!input.title.trim()) throw new Error("Give the task a title");
      const { error } = await db.from("tasks").insert({
        organization_id: organizationId,
        branch_id: branchId ?? null,
        department_id: department.data?.["id"] ? String(department.data["id"]) : null,
        title: input.title.trim(),
        description: input.description ?? "",
        priority: input.priority ?? "normal",
        status: "open",
        due_at: input.dueAt || null,
        assignee_id: user?.id ?? null,
        created_by: user?.id ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Procurement task created");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUpdateProcurementTask() {
  const invalidate = useProcurementInvalidate();
  return useMutation({
    mutationFn: async (input: { id: string; status: string }) => {
      const { error } = await db
        .from("tasks")
        .update({
          status: input.status,
          completed_at: input.status === "completed" ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", input.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Task updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Procurement's own office supplies — requested from Stores
 * ------------------------------------------------------------------ */

export function useProcurementStockNeeds(status = "all") {
  const { organizationId, branchId } = useProcurementContext();
  return useQuery({
    queryKey: ["procurement-department", "stock-needs", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("department_stock_needs")
        .select("*")
        .eq("module", "procurement")
        .order("created_at", { ascending: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      q = applyStockNeedStatus(q, status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as ProcRow[];
    },
  });
}

export function useReportProcurementStockNeed() {
  const invalidate = useProcurementInvalidate();
  const { branchId } = useProcurementContext();
  const department = useProcurementDepartment();
  return useMutation({
    mutationFn: async (input: {
      item: string;
      quantity: number;
      unit?: string;
      priority?: string;
      notes?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_department_stock_need_create", {
        _item: input.item,
        _quantity: input.quantity,
        _unit: input.unit ?? "unit",
        _priority: input.priority ?? "normal",
        _notes: input.notes ?? null,
        _module: "procurement",
        _department: department.data?.["id"] ? String(department.data["id"]) : null,
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Office supply need recorded for Stores");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
