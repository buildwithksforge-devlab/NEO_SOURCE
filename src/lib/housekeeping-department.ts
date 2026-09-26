/**
 * Housekeeping department layer.
 *
 * The department has one manager who sees every room in the property, assigns
 * cleaning work and inspects it, and housekeepers who only ever see the rooms
 * and tasks assigned to them. Housekeepers report supply needs and room faults
 * upward; they never assign work, never raise a Stores requisition and never
 * pass their own inspection.
 *
 * All reads and writes go through the existing authoritative housekeeping
 * records — this module adds the department-scoped views, not a second source
 * of truth.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useScopedDepartmentByKey, useScopedWorkerOptions } from "@/lib/scoped-options";
import { applyStockNeedStatus } from "@/lib/stock-needs";

// The housekeeping trail spans many generated table types; call sites narrow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type HkRow = Record<string, unknown>;

export const HK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export const HK_SUPPLY_SUGGESTIONS = [
  "Bed linen",
  "Towels",
  "Toiletries",
  "Cleaning chemicals",
  "Bin liners",
  "Guest amenities",
] as const;

export const HK_FAULT_CATEGORIES = [
  "plumbing",
  "electrical",
  "furniture",
  "appliance",
  "damage",
  "other",
] as const;

export function str(value: unknown, fallback = "—"): string {
  const s = value === null || value === undefined ? "" : String(value);
  return s.trim() === "" ? fallback : s;
}

export function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function useHousekeepingContext() {
  const { organizationId, profile } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const fallback = (profile as { branch_id?: string | null } | null)?.branch_id ?? null;
  return { organizationId, branchId: branchId ?? fallback };
}

function useHkInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["housekeeping-department"] });
    void qc.invalidateQueries({ queryKey: ["ops"] });
    void qc.invalidateQueries({ queryKey: ["fnb"] });
  };
}

/**
 * The assigned worker's own control over one of their tasks.
 *
 * A housekeeper may start their task and mark it done or submitted for their
 * supervisor's inspection. They cannot inspect, release or reassign it — those
 * stay with the manager — and the update is scoped to the row they are the
 * assignee of, so RLS refuses anyone else's work.
 */
export function useAdvanceMyTask() {
  const invalidate = useHkInvalidate();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (input: { taskId: string; status: "in-progress" | "completed" | "review" }) => {
      const patch: Record<string, unknown> = { status: input.status, updated_at: new Date().toISOString() };
      if (input.status === "completed") {
        patch["completed_at"] = new Date().toISOString();
        patch["progress"] = 100;
      }
      const { data, error } = await db
        .from("tasks")
        .update(patch)
        .eq("id", input.taskId)
        .eq("assignee_id", user?.id ?? "")
        .select("id,status")
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error("The task could not be updated — it is no longer assigned to you.");
      return data as HkRow;
    },
    onSuccess: (row) => {
      invalidate();
      toast.success(
        String(row["status"]) === "completed"
          ? "Task completed"
          : String(row["status"]) === "review"
            ? "Task submitted for inspection"
            : "Task started",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** The Housekeeping department row, used to scope tasks, staff and requisitions. */
export function useHousekeepingDepartment() {
  return useScopedDepartmentByKey("housekeep|^hk$");
}

/* ------------------------------------------------------------------ *
 * My Work — strictly the signed-in housekeeper's own assignments
 * ------------------------------------------------------------------ */

/** Cleaning jobs assigned to the signed-in housekeeper, never anybody else's. */
export function useMyHousekeepingJobs(includeDone = false) {
  const { organizationId, branchId } = useHousekeepingContext();
  const { user } = useAuth();
  return useQuery({
    queryKey: ["housekeeping-department", "my-jobs", organizationId, branchId, user?.id, includeDone],
    enabled: Boolean(organizationId) && Boolean(user?.id),
    queryFn: async () => {
      let q = db
        .from("housekeeping_jobs")
        .select(
          "id, organization_id, job_number, job_type, status, priority, room_id, task_id, location_label, assignee_id, due_at, started_at, completed_at, inspection_required, inspection_status, rework_count, dnd, notes, created_at, template_id, template_name, template_version, checklist_snapshot, rooms(room_number, floor, room_condition)",
        )
        .eq("assignee_id", user!.id)
        .order("due_at", { ascending: true, nullsFirst: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      if (!includeDone) q = q.not("status", "in", "(completed,cancelled)");
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as HkRow[];
    },
  });
}

/** Non-cleaning tasks assigned to the signed-in housekeeper. */
export function useMyHousekeepingTasks() {
  const { organizationId, branchId } = useHousekeepingContext();
  const { user } = useAuth();
  return useQuery({
    queryKey: ["housekeeping-department", "my-tasks", organizationId, branchId, user?.id],
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
      return (data ?? []) as HkRow[];
    },
  });
}

/** Housekeepers available to the manager as assignees, scoped to the property. */
export function useHousekeepingStaffOptions() {
  const department = useHousekeepingDepartment();
  const departmentId = department.data?.id ?? null;
  return useScopedWorkerOptions({ departmentId, departmentKey: departmentId ? null : "housekeeping" });
}

/* ------------------------------------------------------------------ *
 * Stock needs — a housekeeper reports, the manager requisitions
 * ------------------------------------------------------------------ */

export function useHousekeepingStockNeeds(status = "all") {
  const { organizationId, branchId } = useHousekeepingContext();
  return useQuery({
    queryKey: ["housekeeping-department", "stock-needs", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("department_stock_needs")
        .select("*")
        .eq("module", "housekeeping")
        .order("created_at", { ascending: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      q = applyStockNeedStatus(q, status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as HkRow[];
    },
  });
}

export function useReportHkStockNeed() {
  const invalidate = useHkInvalidate();
  const { organizationId, branchId } = useHousekeepingContext();
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
        _module: "housekeeping",
        _department: null,
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Supply need sent to the Housekeeping Manager");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReviewHkStockNeed() {
  const invalidate = useHkInvalidate();
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
      return (data ?? {}) as HkRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Supply need ${str(data["status"], "reviewed")}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Room faults — reported from the room, owned by Maintenance
 * ------------------------------------------------------------------ */

export function useReportRoomFault() {
  const invalidate = useHkInvalidate();
  const { organizationId, branchId } = useHousekeepingContext();
  const { user } = useAuth();
  const department = useHousekeepingDepartment();
  return useMutation({
    mutationFn: async (input: {
      roomId?: string | null;
      locationLabel?: string | null;
      description: string;
      faultCategory?: string;
      priority?: string;
      guestImpact?: boolean;
    }) => {
      if (!organizationId) throw new Error("No organisation context");
      if (!input.description.trim()) throw new Error("Describe the fault before reporting it");
      if (!branchId) throw new Error("Select a property before reporting a fault");
      const { data, error } = await guardedRpc(db, "neo_maintenance_work_order_create", {
        _payload: {
          organization_id: organizationId,
          branch_id: branchId,
          room_id: input.roomId ?? null,
          location_label: input.locationLabel ?? null,
          description: input.description.trim(),
          fault_category: input.faultCategory ?? "other",
          priority: input.priority ?? "normal",
          guest_impact: input.guestImpact ?? false,
          blocks_room: Boolean(input.roomId && input.guestImpact),
          block_status: "out-of-order",
          source_module: "housekeeping",
          requesting_department_id: department.data?.["id"] ? String(department.data["id"]) : null,
        },
        _idempotency_key: `housekeeping-fault:${crypto.randomUUID()}`,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as Record<string, unknown>;
      if (result["ok"] !== true || !result["work_order_id"])
        throw new Error("The fault was not persisted by Maintenance");
      return result;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Fault reported to Maintenance");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
