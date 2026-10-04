/**
 * Pastry & Bakery department layer.
 *
 * The department runs on two tiers and the boundaries below mirror that
 * contract exactly:
 *
 *  - The Head Pastry Chef owns the production schedule, assigns Pastry Chefs,
 *    takes and prices custom cake orders, reviews wastage, and is the only
 *    role that may turn reported needs into a Stores requisition.
 *  - A Pastry Chef sees only the production assigned to them — product,
 *    quantity, due time, flavour, cake message and finishing instructions —
 *    and never the customer's money. They may report a stock need and record
 *    wastage; they may not approve either.
 *
 * Unlike the hot kitchen, pastry production is planned ahead of the order, so
 * the unit of work is a dated production plan rather than a live ticket.
 * Every write goes through a security-definer routine, so the database — not
 * the screen — enforces this.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useScopedWorkerOptions } from "@/lib/scoped-options";
import { applyStockNeedStatus } from "@/lib/stock-needs";

// The pastry trail spans several generated table types; call sites narrow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type PastryRow = Record<string, unknown>;

export const PASTRY_UNITS = ["piece", "tray", "loaf", "batch", "kg", "g", "litre"] as const;
export const PASTRY_NEED_UNITS = ["kg", "g", "litre", "ml", "piece", "pack", "tray"] as const;
export const CAKE_FLAVOURS = [
  "Vanilla",
  "Chocolate",
  "Red velvet",
  "Black forest",
  "Carrot",
  "Lemon",
  "Marble",
  "Fruit",
] as const;

export function pastryStr(value: unknown, fallback = "—"): string {
  const s = value === null || value === undefined ? "" : String(value);
  return s.trim() === "" ? fallback : s;
}

export function pastryNum(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function pastryTone(status: string): "success" | "warning" | "info" | "destructive" | "default" {
  if (status === "ready" || status === "completed" || status === "collected") return "success";
  if (status === "decorating") return "info";
  if (status === "in-preparation" || status === "assigned") return "warning";
  if (status === "cancelled") return "destructive";
  return "default";
}

/** Forward-only production lifecycle, identical to the database guard. */
export function nextPastryStatus(status: string): string | null {
  switch (status) {
    case "planned":
    case "assigned":
      return "in-preparation";
    case "in-preparation":
      return "decorating";
    case "decorating":
      return "ready";
    default:
      return null;
  }
}

export function nextCustomCakeStatus(status: string): string | null {
  switch (status) {
    case "assigned":
      return "in-preparation";
    case "in-preparation":
      return "decorating";
    case "decorating":
      return "ready";
    default:
      return null;
  }
}

export function usePastryContext() {
  const { organizationId, profile, user } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const fallback = (profile as { branch_id?: string | null } | null)?.branch_id ?? null;
  return { organizationId, branchId: branchId ?? fallback, userId: user?.id ?? null };
}

function usePastryInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["pastry"] });
  };
}

/* ------------------------------------------------------------------ *
 * Production plans and planned items — Head Pastry Chef
 * ------------------------------------------------------------------ */

export function usePastryPlans(limit = 30) {
  const { organizationId, branchId } = usePastryContext();
  return useQuery({
    queryKey: ["pastry", "plans", organizationId, branchId, limit],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("pastry_production_plans")
        .select("*")
        .order("plan_date", { ascending: false })
        .limit(limit);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as PastryRow[];
    },
  });
}

export function usePastryProductionItems(planId?: string | null) {
  const { organizationId, branchId } = usePastryContext();
  return useQuery({
    queryKey: ["pastry", "items", organizationId, branchId, planId ?? "all"],
    enabled: Boolean(organizationId),
    refetchInterval: 30_000,
    queryFn: async () => {
      let q = db
        .from("pastry_production_items")
        .select("*")
        .order("due_at", { ascending: true, nullsFirst: false })
        .limit(300);
      if (planId) q = q.eq("plan_id", planId);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as PastryRow[];
    },
  });
}

export function useUpsertPastryPlan() {
  const invalidate = usePastryInvalidate();
  const { branchId } = usePastryContext();
  return useMutation({
    mutationFn: async (input: { planDate?: string | null; notes?: string }) => {
      const { data, error } = await guardedRpc(db, "neo_pastry_plan_upsert", {
        _plan_date: input.planDate ?? null,
        _branch: branchId ?? null,
        _notes: input.notes ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as PastryRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Production plan ready");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAddPastryPlanItem() {
  const invalidate = usePastryInvalidate();
  return useMutation({
    mutationFn: async (input: {
      planId: string;
      product: string;
      quantity: number;
      unit?: string;
      assigneeId?: string | null;
      dueAt?: string | null;
      instructions?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_pastry_plan_item_add", {
        _plan: input.planId,
        _product: input.product,
        _quantity: input.quantity,
        _unit: input.unit ?? "piece",
        _assignee: input.assigneeId ?? null,
        _due: input.dueAt ?? null,
        _instructions: input.instructions ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as PastryRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Added to the production plan");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAssignPastryItem() {
  const invalidate = usePastryInvalidate();
  return useMutation({
    mutationFn: async (input: { itemId: string; assigneeId: string }) => {
      const { data, error } = await guardedRpc(db, "neo_pastry_item_assign", {
        _item: input.itemId,
        _assignee: input.assigneeId,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as PastryRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Pastry Chef assigned");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAdvancePastryItem() {
  const invalidate = usePastryInvalidate();
  return useMutation({
    mutationFn: async (input: { itemId: string; status: string; produced?: number | null }) => {
      const { data, error } = await guardedRpc(db, "neo_pastry_item_advance", {
        _item: input.itemId,
        _status: input.status,
        _produced: input.produced ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as PastryRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Production updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Head Pastry Chef only: reconcile what was produced against sold and wasted. */
export function useRecordPastrySales() {
  const invalidate = usePastryInvalidate();
  return useMutation({
    mutationFn: async (input: { itemId: string; sold: number; wasted?: number | null }) => {
      const { data, error } = await guardedRpc(db, "neo_pastry_item_record_sales", {
        _item: input.itemId,
        _sold: input.sold,
        _wasted: input.wasted ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as PastryRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Production reconciled");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * A Pastry Chef's own work — no customer money is ever returned
 * ------------------------------------------------------------------ */

export function useMyPastryWork() {
  const { organizationId, branchId } = usePastryContext();
  return useQuery({
    queryKey: ["pastry", "my-work", organizationId, branchId],
    enabled: Boolean(organizationId),
    refetchInterval: 20_000,
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_pastry_my_production", { _branch: branchId ?? null });
      if (error) throw new Error(error.message);
      return (data ?? []) as PastryRow[];
    },
  });
}

/* ------------------------------------------------------------------ *
 * Custom cake orders
 * ------------------------------------------------------------------ */

export function useCustomCakeOrders(status = "all") {
  const { organizationId, branchId } = usePastryContext();
  return useQuery({
    queryKey: ["pastry", "custom-orders", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("pastry_custom_orders")
        .select("*")
        .order("required_at", { ascending: true, nullsFirst: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      q = applyStockNeedStatus(q, status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as PastryRow[];
    },
  });
}

export function useCreateCustomCakeOrder() {
  const invalidate = usePastryInvalidate();
  const { branchId } = usePastryContext();
  return useMutation({
    mutationFn: async (input: {
      customerName: string;
      product: string;
      requiredAt?: string | null;
      sizeKg?: number | null;
      flavour?: string;
      cakeMessage?: string;
      customerPhone?: string;
      decorationNotes?: string;
      quotedAmount?: number | null;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_pastry_custom_order_create", {
        _customer_name: input.customerName,
        _product: input.product,
        _required_at: input.requiredAt ?? null,
        _size_kg: input.sizeKg ?? null,
        _flavour: input.flavour ?? null,
        _cake_message: input.cakeMessage ?? null,
        _customer_phone: input.customerPhone ?? null,
        _decoration_notes: input.decorationNotes ?? null,
        _quoted_amount: input.quotedAmount ?? null,
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as PastryRow;
    },
    onSuccess: (row) => {
      invalidate();
      toast.success(`Custom cake ${pastryStr(row["order_number"], "")} recorded`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAssignCustomCake() {
  const invalidate = usePastryInvalidate();
  return useMutation({
    mutationFn: async (input: { orderId: string; assigneeId: string }) => {
      const { data, error } = await guardedRpc(db, "neo_pastry_custom_order_assign", {
        _order: input.orderId,
        _assignee: input.assigneeId,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as PastryRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Cake assigned to a Pastry Chef");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAdvanceCustomCake() {
  const invalidate = usePastryInvalidate();
  return useMutation({
    mutationFn: async (input: { orderId: string; status: string; note?: string }) => {
      const { data, error } = await guardedRpc(db, "neo_pastry_custom_order_advance", {
        _order: input.orderId,
        _status: input.status,
        _note: input.note ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as PastryRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Cake order updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Wastage — both roles record, only the Head Pastry Chef reviews
 * ------------------------------------------------------------------ */

export function usePastryWaste() {
  const { organizationId, branchId } = usePastryContext();
  return useQuery({
    queryKey: ["pastry", "waste", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("waste_records")
        .select("*")
        .eq("category", "pastry")
        .order("occurred_at", { ascending: false })
        .limit(150);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as PastryRow[];
    },
  });
}

export function useRecordPastryWaste() {
  const invalidate = usePastryInvalidate();
  const { branchId } = usePastryContext();
  return useMutation({
    mutationFn: async (input: {
      item: string;
      quantity: number;
      unit?: string;
      reason?: string;
      estimatedCost?: number | null;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_pastry_waste_record", {
        _item: input.item,
        _quantity: input.quantity,
        _unit: input.unit ?? "piece",
        _reason: input.reason ?? null,
        _estimated_cost: input.estimatedCost ?? null,
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as PastryRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Wastage sent to the Head Pastry Chef");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReviewPastryWaste() {
  const invalidate = usePastryInvalidate();
  return useMutation({
    mutationFn: async (input: { recordId: string; decision: "approved" | "rejected"; comment?: string }) => {
      const { data, error } = await guardedRpc(db, "neo_pastry_waste_review", {
        _record: input.recordId,
        _decision: input.decision,
        _comment: input.comment ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as PastryRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Wastage reviewed");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Stock needs and the Head Pastry Chef's requisition
 * ------------------------------------------------------------------ */

export function usePastryStockNeeds(status = "all") {
  const { organizationId, branchId } = usePastryContext();
  return useQuery({
    queryKey: ["pastry", "needs", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("department_stock_needs")
        .select("*")
        .eq("module", "pastry")
        .order("created_at", { ascending: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      q = applyStockNeedStatus(q, status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as PastryRow[];
    },
  });
}

export function useReportPastryNeed() {
  const invalidate = usePastryInvalidate();
  const { branchId } = usePastryContext();
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
        _unit: input.unit ?? "kg",
        _priority: input.priority ?? "normal",
        _notes: input.notes ?? null,
        _module: "pastry",
        _department: null,
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Need sent up to the Head Pastry Chef");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Head Pastry Chef only: consolidate the selected needs into one requisition. */
export function useRequisitionPastryNeeds() {
  const invalidate = usePastryInvalidate();
  return useMutation({
    mutationFn: async (input: {
      needIds: string[];
      requiredDate?: string | null;
      priority?: string;
      reason?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_pastry_requisition_from_needs", {
        _needs: input.needIds,
        _required_date: input.requiredDate ?? null,
        _priority: input.priority ?? "normal",
        _reason: input.reason ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as PastryRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Requisition ${pastryStr(data["request_number"], "")} sent to Stores`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function usePastryRequisitions() {
  const { organizationId, branchId } = usePastryContext();
  return useQuery({
    queryKey: ["pastry", "requisitions", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("internal_requisitions")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as PastryRow[];
    },
  });
}

/** Pastry staff available for assignment. */
export function usePastryStaff() {
  // Property-scoped canonical workers; pastry job titles are preferred but the
  // rest of the property's staff stay selectable.
  return useScopedWorkerOptions({ departmentKey: "pastry-and-bakery", jobTitlePattern: "pastry|baker|patiss" });
}
