/**
 * Inventory & Stores department layer.
 *
 * The department has two roles. The Storekeeper controls what is held in
 * Stores: they receive department requisitions, check availability, issue in
 * full or in part, return a request with a reason, run stock counts and route
 * shortages to Procurement as a purchase request. The Receiving Clerk works
 * only on stock coming INTO the organisation — supplier deliveries against an
 * approved order — and never issues stock or approves an exception.
 *
 * Every write goes through an existing authoritative routine (req_issue,
 * req_approve, neo_stores_requisition_reject, neo_stores_count_submit_variance)
 * so stock balances and the audit trail stay owned by the database.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useScopedDepartmentByKey, useScopedWorkerOptions } from "@/lib/scoped-options";
import { applyStockNeedStatus } from "@/lib/stock-needs";

// The Stores trail spans many generated table types; call sites narrow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type StoresRow = Record<string, unknown>;

/** Requisition states that are visible in the Stores queue. */
export const STORES_OPEN_STATUSES = [
  "pending-supervisor",
  "awaiting-stores",
  "approved",
  "partially-approved",
  "ready-for-issue",
  "partially-issued",
] as const;

export function str(value: unknown, fallback = "—"): string {
  const s = value === null || value === undefined ? "" : String(value);
  return s.trim() === "" ? fallback : s;
}

export function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function useStoresContext() {
  const { organizationId, profile } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const fallback = (profile as { branch_id?: string | null } | null)?.branch_id ?? null;
  return { organizationId, branchId: branchId ?? fallback };
}

function useStoresInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["stores-department"] });
    void qc.invalidateQueries({ queryKey: ["inventory"] });
    void qc.invalidateQueries({ queryKey: ["procurement"] });
    void qc.invalidateQueries({ queryKey: ["ops"] });
  };
}

/* ------------------------------------------------------------------ *
 * Department requisitions — the Storekeeper's inbox
 * ------------------------------------------------------------------ */

export function useStoresRequisitions(scope: "open" | "all" = "open") {
  const { organizationId, branchId } = useStoresContext();
  return useQuery({
    queryKey: ["stores-department", "requisitions", organizationId, branchId, scope],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("internal_requisitions")
        .select(
          "id, request_number, status, priority, request_date, required_date, reason, department_id, source_location_id, destination_location_id, requested_by, issued_at, issued_by, shortage_notes, purchase_request_id, departments(name), source_store:stock_locations!internal_requisitions_source_location_id_fkey(name), internal_requisition_lines(id, description, unit, quantity_requested, quantity_approved, quantity_issued, stock_item_id, stock_items(name, base_unit))",
        )
        .order("request_date", { ascending: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      if (scope === "open") q = q.in("status", STORES_OPEN_STATUSES as unknown as string[]);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as StoresRow[];
    },
  });
}

/** On-hand quantity per stock item across the active property's locations. */
export function useStoresAvailability() {
  const { organizationId } = useStoresContext();
  return useQuery({
    queryKey: ["stores-department", "availability", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db
        .from("stock_levels")
        .select("stock_item_id, quantity_on_hand, location_id")
        .limit(5000);
      if (error) throw new Error(error.message);
      const byItem = new Map<string, number>();
      for (const row of (data ?? []) as StoresRow[]) {
        const key = String(row["stock_item_id"] ?? "");
        if (!key) continue;
        byItem.set(key, (byItem.get(key) ?? 0) + num(row["quantity_on_hand"]));
      }
      return byItem;
    },
  });
}

/** Release a requisition still waiting on departmental approval into the Stores queue. */
export function useReleaseRequisitionToStores() {
  const invalidate = useStoresInvalidate();
  return useMutation({
    mutationFn: async (input: { requisitionId: string }) => {
      const { error } = await guardedRpc(db, "req_approve", {
        _requisition: input.requisitionId,
        _lines: [],
        _stage: "supervisor",
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Approved — the request is now with Stores");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Name the store the goods will actually leave from. Stock cannot be issued
 * until this is set, because a movement without an origin is not a movement.
 */
export function useSetIssuingStore() {
  const invalidate = useStoresInvalidate();
  return useMutation({
    mutationFn: async (input: { requisitionId: string; locationId: string }) => {
      const { error } = await db
        .from("internal_requisitions")
        .update({ source_location_id: input.locationId })
        .eq("id", input.requisitionId);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Issuing store set — this request can now be issued");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Map a requisition line to an actual inventory item.
 * This does not deduct stock or approve the requisition.
 */
export function useAssignRequisitionStockItem() {
  const invalidate = useStoresInvalidate();

  return useMutation({
    mutationFn: async (input: {
      requisitionId: string;
      lineId: string;
      stockItemId: string;
    }) => {
      const { data, error } = await guardedRpc(
        db,
        "neo_requisition_assign_stock_item",
        {
          _requisition: input.requisitionId,
          _line: input.lineId,
          _stock_item: input.stockItemId,
        },
      );

      if (error) throw new Error(error.message);

      return data as StoresRow;
    },

    onSuccess: () => {
      invalidate();
      toast.success("Inventory item linked to requisition");
    },

    onError: (error: Error) => {
      toast.error(error.message);
    },
  });
}
/** Confirm the quantities Stores will release, before issuing. */
export function useApproveRequisitionAtStores() {
  const invalidate = useStoresInvalidate();
  return useMutation({
    mutationFn: async (input: { requisitionId: string; lines: { id: string; quantity_approved: number }[] }) => {
      const { error } = await guardedRpc(db, "req_approve", {
        _requisition: input.requisitionId,
        _lines: input.lines,
        _stage: "stores",
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Quantities confirmed — ready to issue");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Issue stock against a requisition, in full or in part. */
export function useIssueRequisition() {
  const invalidate = useStoresInvalidate();
  return useMutation({
    mutationFn: async (input: { requisitionId: string; lines: { id: string; quantity_issued: number }[]; attemptId: string }) => {
      const { data, error } = await guardedRpc(db, "neo_req_issue_safe", {
        _requisition: input.requisitionId,
        _lines: input.lines,
        _attempt: input.attemptId,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as StoresRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(
        data["partial"] === true
          ? "Partly issued — the outstanding quantity stays open"
          : "Issued in full and posted to the stock ledger",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Return a requisition to the department with a written reason. */
export function useRejectRequisition() {
  const invalidate = useStoresInvalidate();
  return useMutation({
    mutationFn: async (input: { requisitionId: string; reason: string }) => {
      const { error } = await guardedRpc(db, "neo_stores_requisition_reject", {
        _requisition: input.requisitionId,
        _reason: input.reason,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Requisition returned to the department");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Route a shortage to Procurement as a purchase request. */
export function useRaiseReplenishment() {
  const invalidate = useStoresInvalidate();
  return useMutation({
    mutationFn: async (input: { requisition: StoresRow; notes: string }) => {
      // The database builds the request and its lines in one statement, so
      // Procurement never receives a purchase request with no items on it.
      const { data, error } = await guardedRpc(db, "neo_stores_shortage_to_pr", {
        _requisition: String(input.requisition["id"]),
        _notes: input.notes,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as StoresRow;
    },
    onSuccess: (data) => {
      invalidate();
      const number = str(data["request_number"], "purchase request");
      toast.success(
        data["created"] === false
          ? `Already with Procurement as ${number}`
          : `Shortage sent to Procurement as ${number} — ${num(data["lines"])} line(s)`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Stock needs reported by departments, across every module
 * ------------------------------------------------------------------ */

export function useAllDepartmentStockNeeds(status = "pending") {
  const { organizationId, branchId } = useStoresContext();
  return useQuery({
    queryKey: ["stores-department", "stock-needs", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("department_stock_needs")
        .select("*, departments(name)")
        .order("created_at", { ascending: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      q = applyStockNeedStatus(q, status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as StoresRow[];
    },
  });
}

/* ------------------------------------------------------------------ *
 * Stock counts and variances — controlled, never silent
 * ------------------------------------------------------------------ */

export function useStoresStockTakes() {
  const { organizationId, branchId } = useStoresContext();
  return useQuery({
    queryKey: ["stores-department", "stock-takes", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("stock_takes")
        .select(
          "id, reference, count_type, status, scheduled_for, started_at, completed_at, variance_value, location_id, notes, created_at, stock_locations(name)",
        )
        .order("created_at", { ascending: false })
        .limit(60);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as StoresRow[];
    },
  });
}

export function useStockTakeLines(takeId: string | null) {
  const { organizationId } = useStoresContext();
  return useQuery({
    queryKey: ["stores-department", "stock-take-lines", organizationId, takeId],
    enabled: Boolean(organizationId) && Boolean(takeId),
    queryFn: async () => {
      const { data, error } = await db
        .from("stock_take_lines")
        .select("id, stock_item_id, system_quantity, counted_quantity, variance, unit, unit_cost, notes, stock_items(name, base_unit)")
        .eq("stock_take_id", takeId)
        .limit(500);
      if (error) throw new Error(error.message);
      return (data ?? []) as StoresRow[];
    },
  });
}

/** Open a count for a store and snapshot the system quantities onto its lines. */
export function useStartStockCount() {
  const invalidate = useStoresInvalidate();
  const { organizationId, branchId } = useStoresContext();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (input: { locationId: string; countType: string; notes?: string }) => {
      if (!organizationId) throw new Error("No organisation context");
      const reference = `CNT-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.floor(Math.random() * 9000 + 1000)}`;
      const { data, error } = await db
        .from("stock_takes")
        .insert({
          organization_id: organizationId,
          branch_id: branchId ?? null,
          reference,
          location_id: input.locationId,
          count_type: input.countType,
          status: "in-progress",
          started_at: new Date().toISOString(),
          counted_by: user?.id ?? null,
          notes: input.notes ?? null,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      const takeId = String((data as StoresRow)["id"]);

      // The count only exists once its snapshot lines exist. If the snapshot
      // fails the header is removed again, so no empty count is left behind.
      try {
        const { data: levels, error: lErr } = await db
          .from("stock_levels")
          .select("stock_item_id, quantity_on_hand, stock_items(base_unit, average_cost)")
          .eq("location_id", input.locationId)
          .limit(1000);
        if (lErr) throw new Error(lErr.message);

        const lines = ((levels ?? []) as StoresRow[]).map((level) => ({
          organization_id: organizationId,
          stock_take_id: takeId,
          stock_item_id: level["stock_item_id"],
          system_quantity: num(level["quantity_on_hand"]),
          unit: str((level["stock_items"] as StoresRow | null)?.["base_unit"], "unit"),
          unit_cost: num((level["stock_items"] as StoresRow | null)?.["average_cost"]),
        }));
        if (lines.length) {
          const { error: insErr } = await db.from("stock_take_lines").insert(lines);
          if (insErr) throw new Error(insErr.message);
        }
      } catch (snapshotError) {
        await db.from("stock_takes").delete().eq("id", takeId);
        throw snapshotError;
      }

      return takeId;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Count opened with the system quantities snapshotted");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Units that cannot be held in fractions — you count whole ones or none. */
const DISCRETE_UNITS = new Set([
  "pc",
  "pcs",
  "piece",
  "pieces",
  "unit",
  "units",
  "each",
  "ea",
  "bottle",
  "bottles",
  "can",
  "cans",
  "packet",
  "packets",
  "pack",
  "packs",
  "box",
  "boxes",
  "carton",
  "cartons",
  "ream",
  "reams",
  "roll",
  "rolls",
  "bag",
  "bags",
  "tin",
  "tins",
  "jar",
  "jars",
  "set",
  "sets",
]);

/** Reject counts that cannot physically exist. Returns an error message, or null. */
export function validateCountedQuantity(counted: number, unit?: string | null): string | null {
  if (!Number.isFinite(counted)) return "Enter a counted quantity";
  if (counted < 0) return "A physical count cannot be negative — enter the quantity actually on the shelf";
  const u = String(unit ?? "").trim().toLowerCase();
  if (DISCRETE_UNITS.has(u) && !Number.isInteger(counted))
    return `Count ${u} in whole numbers — a part ${u} cannot be counted`;
  return null;
}

export function useRecordCountedQuantity() {
  const invalidate = useStoresInvalidate();
  return useMutation({
    mutationFn: async (input: { lineId: string; counted: number; notes?: string; unit?: string | null }) => {
      const problem = validateCountedQuantity(input.counted, input.unit);
      if (problem) throw new Error(problem);
      const { error } = await db
        .from("stock_take_lines")
        .update({ counted_quantity: input.counted, notes: input.notes ?? null })
        .eq("id", input.lineId);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Close the counting stage. Differences do NOT change stock: they raise a
 * stock adjustment that somebody else has to approve.
 */
export function useSubmitCountVariance() {
  const invalidate = useStoresInvalidate();
  return useMutation({
    mutationFn: async (input: { takeId: string; notes?: string }) => {
      const { data, error } = await guardedRpc(db, "neo_stores_count_submit_variance", {
        _take: input.takeId,
        _notes: input.notes ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as StoresRow;
    },
    onSuccess: (data) => {
      invalidate();
      if (str(data["status"], "") === "closed") toast.success("Count closed — no variance found");
      else toast.success(`${num(data["lines"])} variance line(s) sent for approval`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Adjustments raised from counts, damage or expiry, awaiting an approver. */
export function useStoresAdjustments(status = "all") {
  const { organizationId, branchId } = useStoresContext();
  return useQuery({
    queryKey: ["stores-department", "adjustments", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("stock_adjustments")
        .select(
          "id, adjustment_number, reason, status, notes, total_value, requested_by, approved_by, approved_at, created_at, location_id, stock_locations(name), stock_adjustment_lines(id, quantity, unit, reason, stock_items(name))",
        )
        .order("created_at", { ascending: false })
        .limit(100);
      if (branchId) q = q.eq("branch_id", branchId);
      q = applyStockNeedStatus(q, status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as StoresRow[];
    },
  });
}

/* ------------------------------------------------------------------ *
 * Stores tasks — the Storekeeper assigns, the clerk completes
 * ------------------------------------------------------------------ */

export function useStoresDepartment() {
  return useScopedDepartmentByKey("store|inventory");
}

export function useStoresTasks(scope: "department" | "mine" = "department") {
  const { organizationId, branchId } = useStoresContext();
  const { user } = useAuth();
  const department = useStoresDepartment();
  const departmentId = department.data?.["id"] ? String(department.data["id"]) : null;
  return useQuery({
    queryKey: ["stores-department", "tasks", organizationId, branchId, scope, departmentId, user?.id],
    enabled: Boolean(organizationId) && (scope === "mine" ? Boolean(user?.id) : Boolean(departmentId)),
    queryFn: async () => {
      let q = db.from("tasks").select("*").order("due_at", { ascending: true, nullsFirst: false }).limit(200);
      if (scope === "mine") q = q.eq("assignee_id", user!.id);
      else if (departmentId) q = q.eq("department_id", departmentId);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as StoresRow[];
    },
  });
}

export function useStoresStaffOptions() {
  const department = useStoresDepartment();
  const departmentId = department.data?.id ?? null;
  return useScopedWorkerOptions({ departmentId, departmentKey: departmentId ? null : "stores" });
}

export function useCreateStoresTask() {
  const invalidate = useStoresInvalidate();
  const { organizationId, branchId } = useStoresContext();
  const { user } = useAuth();
  const department = useStoresDepartment();
  return useMutation({
    mutationFn: async (input: {
      title: string;
      assigneeId: string;
      dueAt?: string | null;
      priority?: string;
      description: string;
    }) => {
      if (!organizationId) throw new Error("No organisation context");
      // The task record requires instructions, so an empty description is
      // refused here rather than failing in the database.
      const description = input.description.trim();
      if (!description) throw new Error("Describe what the task involves before assigning it.");
      const { error } = await db.from("tasks").insert({
        organization_id: organizationId,
        branch_id: branchId ?? null,
        department_id: department.data?.["id"] ?? null,
        title: input.title,
        description,
        assignee_id: input.assigneeId,
        created_by: user?.id ?? null,
        due_at: input.dueAt || null,
        priority: input.priority ?? "normal",
        status: "open",
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Stores task assigned");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUpdateStoresTask() {
  const invalidate = useStoresInvalidate();
  return useMutation({
    mutationFn: async (input: { taskId: string; status: string }) => {
      const patch: Record<string, unknown> = { status: input.status };
      if (input.status === "completed") patch["completed_at"] = new Date().toISOString();
      const { error } = await db.from("tasks").update(patch).eq("id", input.taskId);
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
 * Count reconciliation and manager decisions on corrections
 * ------------------------------------------------------------------ */

/**
 * Compares every counted line against the live stock ledger, records the
 * difference and flags it as a match, a shortage or an overage. It never
 * changes stock: a correction still has to be approved.
 */
export function useReconcileCountAgainstLedger() {
  const invalidate = useStoresInvalidate();
  return useMutation({
    mutationFn: async (takeId: string) => {
      const { data, error } = await guardedRpc(db, "neo_stores_count_reconcile", { _take: takeId });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as StoresRow;
      if (result["ok"] === false) {
        throw new Error(
          result["reason"] === "not_permitted"
            ? "You do not have permission to reconcile stock counts."
            : "That count could not be reconciled.",
        );
      }
      return result;
    },
    onSuccess: (result) => {
      invalidate();
      const flagged = num(result["shortage"]) + num(result["overage"]);
      toast.success(
        flagged > 0
          ? `${flagged} line(s) differ from the ledger — raise the correction for approval`
          : "Every counted line agrees with the ledger",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** A manager approves the correction (posting it to stock) or declines it with a reason. */
export function useDecideStockAdjustment() {
  const invalidate = useStoresInvalidate();
  return useMutation({
    mutationFn: async (input: { adjustmentId: string; decision: "approve" | "reject"; notes?: string | null }) => {
      const { data, error } = await guardedRpc(db, "neo_stores_adjustment_decide", {
        _adjustment: input.adjustmentId,
        _decision: input.decision,
        _notes: input.notes ?? null,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as StoresRow;
      if (result["ok"] === false) {
        const reason = str(result["reason"], "");
        throw new Error(
          reason === "self_approval"
            ? "You raised this correction, so somebody else has to approve it."
            : reason === "not_permitted"
              ? "You do not have permission to approve stock corrections."
              : reason === "not_pending"
                ? `This correction is already ${str(result["status"], "decided")}.`
                : "That correction could not be decided.",
        );
      }
      return result;
    },
    onSuccess: (result) => {
      invalidate();
      toast.success(
        str(result["decision"], "") === "approve"
          ? "Correction approved and posted to stock"
          : "Correction declined",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
