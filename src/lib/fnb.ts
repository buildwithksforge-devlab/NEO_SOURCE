/**
 * Food & Beverage department layer.
 *
 * Two things the department owns and Stores does not: the requisitions it
 * raises against Stores, and the wastage it records. Every write goes through
 * a transactional database routine that checks the caller's own capability and
 * property scope, so F&B can request stock and log wastage without ever being
 * able to move a Stores balance itself.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { isSchemaMismatch, reportQueryError } from "@/lib/query-telemetry";

// The F&B trail spans many generated table types; call sites narrow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type FnbRow = Record<string, unknown>;

export type StockItemOption = {
  id: string;
  name: string;
  base_unit: string;
  category_id: string | null;
};

export function useFnbContext() {
  const { organizationId, profile } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const fallback = (profile as { branch_id?: string | null } | null)?.branch_id ?? null;
  return { organizationId, branchId: branchId ?? fallback };
}

export const str = (v: unknown, fallback = "—") =>
  v === null || v === undefined || v === "" ? fallback : String(v);

export const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);

/* ------------------------------- requisitions ------------------------------ */

export type RequisitionLineInput = {
  stock_item_id?: string | null;
  description?: string;
  unit?: string;
  quantity_requested: number;
  notes?: string;
};

/** Stock item list, plus the flag call sites use to render a recovery notice. */
export type StockItemOptions = StockItemOption[] & { degraded?: boolean };

/** True when the picker is running on a reduced projection. */
export function isDegradedStockItems(data: unknown): boolean {
  return Boolean((data as { degraded?: boolean } | undefined)?.degraded);
}

export function useStockItemOptions() {
  const { organizationId } = useFnbContext();
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery<StockItemOptions>({
    queryKey: ["fnb", "stock-items", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        db.from("stock_items").select("id, name, base_unit, category_id").order("name"),
        "stock_items",
      ).limit(500);
      if (!error) return (data ?? []) as StockItemOptions;

      reportQueryError("inventory.stock_items", error);
      if (!isSchemaMismatch(error)) throw error;

      // The catalogue projection drifted from the schema. Fall back to the
      // minimum every stock item is guaranteed to carry so staff can still
      // pick an item (unit typed by hand) instead of hitting a page error.
      const fallback = await applyTo(
        db.from("stock_items").select("id, name").order("name"),
        "stock_items",
      ).limit(500);
      if (fallback.error) {
        reportQueryError("inventory.stock_items.fallback", fallback.error);
        throw fallback.error;
      }
      const rows = ((fallback.data ?? []) as { id: string; name: string }[]).map((r) => ({
        id: r.id,
        name: r.name,
        base_unit: "",
        category_id: null,
      })) as StockItemOptions;
      rows.degraded = true;
      return rows;
    },
  });
}


export function useDepartmentRequisitions(status?: string) {
  const { organizationId, branchId } = useFnbContext();
  return useQuery({
    queryKey: ["fnb", "requisitions", organizationId, branchId, status ?? "all"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("internal_requisitions")
        .select("*, internal_requisition_lines(*), departments(name)")
        .order("created_at", { ascending: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      if (status && status !== "all") q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as FnbRow[];
    },
  });
}

function useFnbInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["fnb"] });
    void qc.invalidateQueries({ queryKey: ["inventory"] });
  };
}

export function useRaiseRequisition() {
  const invalidate = useFnbInvalidate();
  const { branchId } = useFnbContext();
  return useMutation({
    mutationFn: async (input: {
      lines: RequisitionLineInput[];
      requiredDate?: string | null;
      priority?: string;
      reason?: string;
      departmentId?: string | null;
    }) => {
      if (!branchId) throw new Error("Select a property before raising a requisition");
      const { data, error } = await guardedRpc(db, "neo_department_requisition_create", {
        _branch: branchId,
        _lines: input.lines,
        _department: input.departmentId ?? null,
        _required_date: input.requiredDate ?? null,
        _priority: input.priority ?? "normal",
        _reason: input.reason ?? null,
        _destination: null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as FnbRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Requisition ${str(data["request_number"], "")} sent to Stores`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useConfirmRequisitionReceipt() {
  const invalidate = useFnbInvalidate();
  return useMutation({
    mutationFn: async (input: {
      requisitionId: string;
      lines: { id: string; quantity_received: number; condition?: string; notes?: string }[];
    }) => {
      const { data, error } = await guardedRpc(db, "req_confirm_receipt", {
        _requisition: input.requisitionId,
        _lines: input.lines,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as FnbRow;
    },
    onSuccess: (data) => {
      invalidate();
      if (data["discrepancy"] === true) toast.warning("Receipt recorded with a discrepancy for Stores to resolve");
      else toast.success("Receipt confirmed");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* --------------------------------- wastage -------------------------------- */

export function useWasteRecords(status?: string) {
  const { organizationId, branchId } = useFnbContext();
  return useQuery({
    queryKey: ["fnb", "waste", organizationId, branchId, status ?? "all"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("waste_records")
        .select("*")
        .order("occurred_at", { ascending: false })
        .limit(300);
      if (branchId) q = q.eq("branch_id", branchId);
      if (status && status !== "all") q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as FnbRow[];
    },
  });
}

export function useRecordWaste() {
  const invalidate = useFnbInvalidate();
  const { branchId } = useFnbContext();
  return useMutation({
    mutationFn: async (input: {
      item: string;
      quantity: number;
      unit?: string;
      category?: string;
      reason: string;
      estimatedCost?: number | null;
    }) => {
      if (!branchId) throw new Error("Select a property before recording wastage");
      const { data, error } = await guardedRpc(db, "neo_waste_record", {
        _branch: branchId,
        _item: input.item,
        _quantity: input.quantity,
        _unit: input.unit ?? null,
        _category: input.category ?? "preparation",
        _reason: input.reason,
        _estimated_cost: input.estimatedCost ?? null,
        _station: null,
        _menu_item: null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as FnbRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Wastage ${str(data["waste_number"], "")} logged for review`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReviewWaste() {
  const invalidate = useFnbInvalidate();
  return useMutation({
    mutationFn: async (input: { wasteId: string; decision: "approve" | "reject"; notes?: string }) => {
      const { data, error } = await guardedRpc(db, "neo_waste_review", {
        _waste: input.wasteId,
        _decision: input.decision,
        _notes: input.notes ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as FnbRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Wastage ${str(data["status"], "reviewed")}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Wastage totals for the period the caller can see. */
export function summariseWaste(rows: FnbRow[]) {
  const cost = rows.reduce((t, r) => t + num(r["estimated_cost"]), 0);
  const pending = rows.filter((r) => r["status"] === "pending").length;
  const approved = rows.filter((r) => r["status"] === "approved").length;
  const byCategory = new Map<string, number>();
  for (const r of rows) {
    const key = str(r["category"], "other");
    byCategory.set(key, (byCategory.get(key) ?? 0) + num(r["estimated_cost"]));
  }
  return { cost, pending, approved, count: rows.length, byCategory };
}
