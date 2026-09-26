/**
 * Laundry department layer.
 *
 * The department has a Laundry Manager who receives linen handovers from
 * Housekeeping, assigns batches to attendants, reconciles what comes back and
 * decides on damaged or missing linen; and Laundry Attendants who only ever see
 * the batches assigned to them, move their own work along the conveyor, and
 * report supply needs, damage and equipment faults upward.
 *
 * Every write goes through the authoritative laundry routines — this module
 * adds the department-scoped reads and mutations, never a second source of
 * truth.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useScopedDepartmentByKey, useScopedWorkerOptions } from "@/lib/scoped-options";
import { applyStockNeedStatus } from "@/lib/stock-needs";

// The laundry trail spans many generated table types; call sites narrow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type LaundryRow = Record<string, unknown>;

/** The conveyor, in order. A batch never skips backwards without the manager. */
export const LAUNDRY_BATCH_FLOW = [
  "received",
  "washing",
  "drying",
  "finishing",
  "ready",
  "handed-over",
  "completed",
] as const;

export type LaundryBatchStatus = (typeof LAUNDRY_BATCH_FLOW)[number];

export const LAUNDRY_BATCH_KINDS = [
  { key: "linen", label: "Room linen" },
  { key: "f&b", label: "F&B linen" },
  { key: "uniform", label: "Staff uniforms" },
  { key: "guest", label: "Guest laundry" },
] as const;

export const LAUNDRY_INCIDENT_CONDITIONS = ["damaged", "stained", "missing", "worn-out"] as const;

export const LAUNDRY_SUPPLY_SUGGESTIONS = [
  "Detergent",
  "Fabric softener",
  "Bleach",
  "Stain remover",
  "Starch",
  "Laundry bags",
  "Hangers",
] as const;

export const LAUNDRY_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export function str(value: unknown, fallback = "—"): string {
  const s = value === null || value === undefined ? "" : String(value);
  return s.trim() === "" ? fallback : s;
}

export function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function nextLaundryStatus(current: string): LaundryBatchStatus | null {
  const index = LAUNDRY_BATCH_FLOW.indexOf(current as LaundryBatchStatus);
  if (index < 0 || index >= LAUNDRY_BATCH_FLOW.length - 1) return null;
  return LAUNDRY_BATCH_FLOW[index + 1] ?? null;
}

export function laundryBatchTone(status: string): "success" | "warning" | "destructive" | "default" {
  if (status === "completed" || status === "handed-over") return "success";
  if (status === "ready") return "default";
  if (status === "received") return "warning";
  return "default";
}

export function useLaundryContext() {
  const { organizationId, profile } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const fallback = (profile as { branch_id?: string | null } | null)?.branch_id ?? null;
  return { organizationId, branchId: branchId ?? fallback };
}

function useLaundryInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["laundry-department"] });
    void qc.invalidateQueries({ queryKey: ["ops"] });
  };
}

/** The Laundry department row, used to scope staff, tasks and requisitions. */
export function useLaundryDepartment() {
  return useScopedDepartmentByKey("laundry|linen");
}

/* ------------------------------------------------------------------ *
 * Linen catalogue
 * ------------------------------------------------------------------ */

export function useLinenItems() {
  const { organizationId, branchId } = useLaundryContext();
  return useQuery({
    queryKey: ["laundry-department", "linen-items", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("linen_items")
        .select("id, name, category, unit, par_level, replacement_cost, branch_id, active")
        .order("name")
        .limit(300);
      if (branchId) q = q.or(`branch_id.eq.${branchId},branch_id.is.null`);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return ((data ?? []) as LaundryRow[]).filter((r) => r["active"] !== false);
    },
  });
}

/* ------------------------------------------------------------------ *
 * Batches — the manager sees the whole property, attendants see their own
 * ------------------------------------------------------------------ */

const BATCH_SELECT =
  "id, batch_number, batch_kind, status, branch_id, source_department_id, guest_order_id, attendant_id, machine, cycle_type, weight_kg, quality_result, received_at, started_at, completed_at, notes, created_at";

export function useLaundryBatches(status = "open") {
  const { organizationId, branchId } = useLaundryContext();
  return useQuery({
    queryKey: ["laundry-department", "batches", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db.from("laundry_batches").select(BATCH_SELECT).order("received_at", { ascending: false }).limit(300);
      if (branchId) q = q.eq("branch_id", branchId);
      if (status === "open") q = q.not("status", "in", "(completed,cancelled)");
      else if (status !== "all") q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as LaundryRow[];
    },
  });
}

/** Batches assigned to the signed-in attendant, never anybody else's. */
export function useMyLaundryBatches(includeDone = false) {
  const { organizationId, branchId } = useLaundryContext();
  const { user } = useAuth();
  return useQuery({
    queryKey: ["laundry-department", "my-batches", organizationId, branchId, user?.id, includeDone],
    enabled: Boolean(organizationId) && Boolean(user?.id),
    queryFn: async () => {
      let q = db
        .from("laundry_batches")
        .select(BATCH_SELECT)
        .eq("attendant_id", user!.id)
        .order("received_at", { ascending: true })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      if (!includeDone) q = q.not("status", "in", "(completed,cancelled)");
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as LaundryRow[];
    },
  });
}

export function useLaundryBatchItems(batchId: string | null) {
  return useQuery({
    queryKey: ["laundry-department", "batch-items", batchId],
    enabled: Boolean(batchId),
    queryFn: async () => {
      const { data, error } = await db
        .from("laundry_batch_items")
        .select("id, linen_item_id, description, quantity, returned_quantity, damaged_quantity, missing_quantity, linen_items(name)")
        .eq("batch_id", batchId)
        .order("created_at");
      if (error) throw new Error(error.message);
      return (data ?? []) as LaundryRow[];
    },
  });
}

/** Laundry staff available to the manager as assignees, scoped to the property. */
export function useLaundryStaffOptions() {
  const department = useLaundryDepartment();
  const departmentId = department.data?.id ?? null;
  return useScopedWorkerOptions({ departmentId, departmentKey: departmentId ? null : "laundry" });
}

export function useCreateLaundryBatch() {
  const invalidate = useLaundryInvalidate();
  const { branchId } = useLaundryContext();
  return useMutation({
    mutationFn: async (input: {
      kind?: string;
      sourceDepartmentId?: string | null;
      guestOrderId?: string | null;
      notes?: string | null;
      items: { linen_item_id?: string | null; description?: string | null; quantity: number }[];
    }) => {
      if (!branchId) throw new Error("Select a property before receiving linen");
      const { data, error } = await guardedRpc(db, "neo_laundry_batch_create", {
        _branch: branchId,
        _kind: input.kind ?? "linen",
        _items: input.items.filter((i) => Number(i.quantity) > 0),
        _source_department: input.sourceDepartmentId ?? null,
        _guest_order: input.guestOrderId ?? null,
        _notes: input.notes ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as LaundryRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Linen received as ${str(data["batch_number"], "a new batch")}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAssignLaundryBatch() {
  const invalidate = useLaundryInvalidate();
  return useMutation({
    mutationFn: async (input: { batchId: string; attendantId: string }) => {
      const { error } = await guardedRpc(db, "neo_laundry_batch_assign", {
        _batch: input.batchId,
        _attendant: input.attendantId,
        _priority: null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Batch assigned");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAdvanceLaundryBatch() {
  const invalidate = useLaundryInvalidate();
  return useMutation({
    mutationFn: async (input: { batchId: string; status: string }) => {
      const { error } = await guardedRpc(db, "neo_laundry_batch_advance", {
        _batch: input.batchId,
        _status: input.status,
      });
      if (error) throw new Error(error.message);
      return input.status;
    },
    onSuccess: (status) => {
      invalidate();
      toast.success(`Batch moved to ${String(status).replace("-", " ")}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReturnLaundryBatch() {
  const invalidate = useLaundryInvalidate();
  return useMutation({
    mutationFn: async (input: {
      batchId: string;
      lines: { id: string; returned_quantity: number; damaged_quantity: number; notes?: string | null }[];
    }) => {
      const { data, error } = await guardedRpc(db, "neo_laundry_batch_return", {
        _batch: input.batchId,
        _lines: input.lines,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as LaundryRow;
    },
    onSuccess: (data) => {
      invalidate();
      const incidents = num(data["incidents"]);
      toast.success(
        incidents > 0
          ? `Batch handed back — ${incidents} linen incident${incidents === 1 ? "" : "s"} raised`
          : "Batch handed back in full",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Linen incidents — anyone reports, only the manager decides
 * ------------------------------------------------------------------ */

export function useLinenIncidents(status = "all") {
  const { organizationId, branchId } = useLaundryContext();
  return useQuery({
    queryKey: ["laundry-department", "incidents", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("linen_incidents")
        .select(
          "id, linen_item_id, quantity, reason, condition, responsible_process, status, final_action, cost, approval_request_id, reported_by, reviewed_by, reviewed_at, created_at, linen_items(name, replacement_cost)",
        )
        .order("created_at", { ascending: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      q = applyStockNeedStatus(q, status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as LaundryRow[];
    },
  });
}

export function useReportLinenIncident() {
  const invalidate = useLaundryInvalidate();
  const { branchId } = useLaundryContext();
  return useMutation({
    mutationFn: async (input: {
      linenItemId?: string | null;
      quantity: number;
      condition?: string;
      reason: string;
      batchId?: string | null;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_linen_incident_report", {
        _branch: branchId ?? null,
        _linen_item: input.linenItemId ?? null,
        _quantity: input.quantity,
        _condition: input.condition ?? "damaged",
        _reason: input.reason,
        _batch: input.batchId ?? null,
        _photo: null,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Linen incident reported to the Laundry Manager");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReviewLinenIncident() {
  const invalidate = useLaundryInvalidate();
  return useMutation({
    mutationFn: async (input: {
      incidentId: string;
      decision: "write-off" | "repair" | "dismiss" | "reviewed";
      notes?: string | null;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_linen_incident_review", {
        _incident: input.incidentId,
        _decision: input.decision,
        _notes: input.notes ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as LaundryRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(
        data["approval_request"]
          ? "Write-off sent for approval"
          : `Incident marked ${str(data["status"], "reviewed")}`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Supply needs — an attendant reports, the manager requisitions
 * ------------------------------------------------------------------ */

export function useLaundryStockNeeds(status = "all") {
  const { organizationId, branchId } = useLaundryContext();
  return useQuery({
    queryKey: ["laundry-department", "stock-needs", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("department_stock_needs")
        .select("*")
        .eq("module", "laundry")
        .order("created_at", { ascending: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      q = applyStockNeedStatus(q, status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as LaundryRow[];
    },
  });
}

export function useReportLaundryStockNeed() {
  const invalidate = useLaundryInvalidate();
  const { branchId } = useLaundryContext();
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
        _module: "laundry",
        _department: null,
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Supply need sent to the Laundry Manager");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReviewLaundryStockNeed() {
  const invalidate = useLaundryInvalidate();
  return useMutation({
    mutationFn: async (input: {
      needId: string;
      decision: "acknowledge" | "requisition" | "decline" | "close";
      notes?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_department_stock_need_review", {
        _need: input.needId,
        _decision: input.decision,
        _notes: input.notes ?? null,
        _requisition: null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as LaundryRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Supply need ${str(data["status"], "reviewed")}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Tasks assigned to the signed-in laundry attendant
 * ------------------------------------------------------------------ */

export function useMyLaundryTasks() {
  const { organizationId, branchId } = useLaundryContext();
  const { user } = useAuth();
  return useQuery({
    queryKey: ["laundry-department", "my-tasks", organizationId, branchId, user?.id],
    enabled: Boolean(organizationId) && Boolean(user?.id),
    queryFn: async () => {
      let q = db
        .from("tasks")
        .select("*")
        .eq("assignee_id", user!.id)
        .order("due_at", { ascending: true, nullsFirst: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as LaundryRow[];
    },
  });
}

/** Equipment fault raised from Laundry, owned by Maintenance. */
export function useReportLaundryFault() {
  const invalidate = useLaundryInvalidate();
  const { organizationId, branchId } = useLaundryContext();
  const { user } = useAuth();
  const department = useLaundryDepartment();
  return useMutation({
    mutationFn: async (input: { description: string; priority?: string; machine?: string | null }) => {
      if (!organizationId) throw new Error("No organisation context");
      if (!input.description.trim()) throw new Error("Describe the fault before reporting it");
      if (!branchId) throw new Error("Select a property before reporting a fault");
      const { data, error } = await guardedRpc(db, "neo_maintenance_work_order_create", {
        _payload: {
          branch_id: branchId,
          location_label: input.machine ? `Laundry — ${input.machine}` : "Laundry",
          description: input.description.trim(),
          fault_category: "appliance",
          priority: input.priority ?? "normal",
          source_module: "laundry",
          requesting_department_id: department.data?.["id"] ? String(department.data["id"]) : null,
        },
        _idempotency_key: `laundry-fault:${crypto.randomUUID()}`,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as Record<string, unknown>;
      if (result["ok"] !== true || !result["work_order_id"])
        throw new Error("The fault was not persisted by Maintenance");
      return result;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Equipment fault reported to Maintenance");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
