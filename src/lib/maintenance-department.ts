/**
 * Maintenance & Landscaping department layer.
 *
 * The department runs on three tiers and the boundaries below mirror that
 * contract exactly:
 *
 *  - The Maintenance Manager owns the department: the work-order board, the
 *    landscaping programme, who is assigned to what, and whether a reported
 *    material need becomes a Stores requisition.
 *  - Maintenance Officers / Technicians work their own assigned jobs: accept,
 *    start, record a diagnosis and the materials used, and mark the job ready.
 *    They never verify or close their own work.
 *  - Ground Workers see only their own grounds tasks and move them forward one
 *    stage at a time, or report a blocker.
 *
 * Neither an officer nor a ground worker raises a Stores requisition directly —
 * they report a material need and the Manager decides. Every write goes through
 * a security-definer routine so the database, not the screen, enforces this.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

// The maintenance trail spans several generated table types; call sites narrow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type MaintRow = Record<string, unknown>;

export const GROUNDS_STATUSES = [
  "not-started",
  "in-progress",
  "ready",
  "completed",
  "blocked",
] as const;
export type GroundsStatus = (typeof GROUNDS_STATUSES)[number];

export const GROUNDS_STATUS_LABELS: Record<string, string> = {
  "not-started": "Not started",
  "in-progress": "In progress",
  ready: "Ready for check",
  completed: "Completed",
  blocked: "Blocked",
};

export const LANDSCAPING_FREQUENCIES = [
  { value: "daily", label: "Daily", days: 1 },
  { value: "twice-weekly", label: "Twice weekly", days: 3 },
  { value: "weekly", label: "Weekly", days: 7 },
  { value: "fortnightly", label: "Fortnightly", days: 14 },
  { value: "monthly", label: "Monthly", days: 30 },
  { value: "quarterly", label: "Quarterly", days: 90 },
] as const;

/**
 * Starting points offered only while a property has configured no grounds areas
 * of its own. They are never written on their own — choosing one still creates
 * a real `grounds_areas` record the hotel owns and can rename.
 */
export const GROUNDS_AREA_SUGGESTIONS = [
  "Main lawn",
  "Car park",
  "Pool surround",
  "Walkways",
  "Hedges and borders",
  "Garden beds",
  "Perimeter fence line",
  "Back of house yard",
] as const;

export const MAINTENANCE_MATERIALS = [
  "Light bulbs",
  "Fuses",
  "Plumbing fittings",
  "Paint",
  "Sandpaper",
  "Cleaning solvents",
  "Fuel for mower",
  "Garden tools",
  "Safety gloves",
] as const;

export const JOB_STAGES = ["accepted", "in-progress", "waiting-parts", "waiting-supplier", "completed"] as const;

export function maintStr(value: unknown, fallback = "—"): string {
  const s = value === null || value === undefined ? "" : String(value);
  return s.trim() === "" ? fallback : s;
}

export function groundsTone(status: string): "success" | "warning" | "destructive" | "default" {
  if (status === "completed" || status === "ready") return "success";
  if (status === "blocked") return "destructive";
  if (status === "in-progress") return "warning";
  return "default";
}

/** The next stage a grounds task may move to, or null when it is finished. */
export function nextGroundsStatus(status: string): GroundsStatus | null {
  switch (status) {
    case "not-started":
      return "in-progress";
    case "in-progress":
      return "ready";
    case "ready":
      return "completed";
    case "blocked":
      return "in-progress";
    default:
      return null;
  }
}

export function useMaintenanceContext() {
  const { organizationId, profile, user } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const fallback = (profile as { branch_id?: string | null } | null)?.branch_id ?? null;
  return { organizationId, branchId: branchId ?? fallback, userId: user?.id ?? null };
}

/**
 * The one list of people who may receive maintenance work.
 *
 * Eligibility is decided in the database (`neo_maintenance_technicians`), by
 * the same rule the assignment guard applies on write: an active staff account
 * with an active employee record at the property in scope, holding the
 * Maintenance "My jobs" capability. Every selector — ordinary work orders,
 * preventive plans, reassignment — reads this, so a screen can never offer a
 * name the save would refuse.
 */
export type MaintenanceTechnician = {
  id: string;
  full_name: string;
  staff_id: string | null;
  job_title: string | null;
  department_name: string | null;
  branch_id: string | null;
  branch_name: string | null;
};

export function useMaintenanceTechnicians() {
  const { organizationId, branchId } = useMaintenanceContext();
  return useQuery({
    queryKey: ["maintenance-dept", "technicians", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_maintenance_technicians", {
        _branch: branchId,
      });
      if (error) throw new Error(error.message);
      return ((data ?? []) as MaintenanceTechnician[]).sort((a, b) =>
        String(a.full_name ?? "").localeCompare(String(b.full_name ?? "")),
      );
    },
  });
}

function useMaintInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["maintenance-dept"] });
    void qc.invalidateQueries({ queryKey: ["ops"] });
  };
}

/* ------------------------------------------------------------------ *
 * Grounds areas — the hotel's own list, configured in the Configuration Centre
 * ------------------------------------------------------------------ */

export function useGroundsAreas() {
  const { organizationId, branchId } = useMaintenanceContext();
  return useQuery({
    queryKey: ["maintenance-dept", "grounds-areas", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db.from("grounds_areas").select("*").order("name").limit(300);
      if (branchId) q = q.or(`branch_id.is.null,branch_id.eq.${branchId}`);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as MaintRow[];
    },
  });
}

/**
 * Creates a grounds area from the board without leaving the job half-written.
 * The record is a normal configuration record — it appears in the Configuration
 * Centre and can be renamed or retired there.
 */
export function useCreateGroundsArea() {
  const invalidate = useMaintInvalidate();
  const { organizationId, branchId, userId } = useMaintenanceContext();
  return useMutation({
    mutationFn: async (input: { name: string }) => {
      const name = input.name.trim();
      if (!name) throw new Error("Name the area");
      if (!branchId) throw new Error("Select a property before adding a grounds area");
      const { data, error } = await db
        .from("grounds_areas")
        .insert({ organization_id: organizationId, branch_id: branchId, name, created_by: userId })
        .select("*")
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error("The area was not saved");
      return data as MaintRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Grounds area added");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Landscaping schedules
 * ------------------------------------------------------------------ */

export function useLandscapingSchedules() {
  const { organizationId, branchId } = useMaintenanceContext();
  return useQuery({
    queryKey: ["maintenance-dept", "schedules", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("landscaping_schedules")
        .select("*")
        .order("next_due_date", { ascending: true })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as MaintRow[];
    },
  });
}

export function useSaveLandscapingSchedule() {
  const invalidate = useMaintInvalidate();
  const { branchId } = useMaintenanceContext();
  return useMutation({
    mutationFn: async (input: {
      id?: string | null;
      name: string;
      area?: string;
      frequency?: string;
      intervalDays?: number;
      nextDue?: string | null;
      instructions?: string;
      assigneeId?: string | null;
      active?: boolean;
      areaId?: string | null;
      equipmentAssetId?: string | null;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_landscaping_schedule_save", {
        _name: input.name,
        _area: input.area ?? "",
        _frequency: input.frequency ?? "weekly",
        _interval_days: input.intervalDays ?? 7,
        _next_due: input.nextDue || null,
        _instructions: input.instructions ?? "",
        _assignee: input.assigneeId || null,
        _branch: branchId,
        _id: input.id || null,
        _active: input.active ?? true,
        _area_id: input.areaId || null,
        _equipment: input.equipmentAssetId || null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as MaintRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Landscaping schedule saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useGenerateLandscapingWork() {
  const invalidate = useMaintInvalidate();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_landscaping_generate_due");
      if (error) throw new Error(error.message);
      return (data ?? {}) as { created?: number };
    },
    onSuccess: (data) => {
      invalidate();
      const n = Number(data?.created ?? 0);
      toast.success(
        n > 0 ? `${n} grounds task${n === 1 ? "" : "s"} raised` : "Nothing was due today",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Grounds tasks
 * ------------------------------------------------------------------ */

export function useGroundsTasks(status = "all") {
  const { organizationId, branchId } = useMaintenanceContext();
  return useQuery({
    queryKey: ["maintenance-dept", "grounds", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("grounds_tasks")
        .select("*")
        .order("service_date", { ascending: false })
        .limit(300);
      if (branchId) q = q.eq("branch_id", branchId);
      if (status !== "all") q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as MaintRow[];
    },
  });
}

export function useMyGroundsTasks() {
  const { organizationId, userId } = useMaintenanceContext();
  return useQuery({
    queryKey: ["maintenance-dept", "my-grounds", organizationId, userId],
    enabled: Boolean(organizationId && userId),
    queryFn: async () => {
      const { data, error } = await db
        .from("grounds_tasks")
        .select("*")
        .eq("assignee_user_id", userId)
        .order("service_date", { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);
      return (data ?? []) as MaintRow[];
    },
  });
}

export function useCreateGroundsTask() {
  const invalidate = useMaintInvalidate();
  const { branchId } = useMaintenanceContext();
  return useMutation({
    mutationFn: async (input: {
      title: string;
      area?: string;
      instruction?: string;
      assigneeId?: string | null;
      priority?: string;
      dueAt?: string | null;
      areaId?: string | null;
      equipmentAssetId?: string | null;
    }) => {
      if (!input.title.trim()) throw new Error("Describe the grounds work");
      const { data, error } = await guardedRpc(db, "neo_grounds_task_create", {
        _title: input.title.trim(),
        _area: input.area ?? "",
        _instruction: input.instruction ?? "",
        _assignee: input.assigneeId || null,
        _priority: input.priority ?? "normal",
        _due: input.dueAt || null,
        _branch: branchId,
        _area_id: input.areaId || null,
        _equipment: input.equipmentAssetId || null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as MaintRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Grounds task created");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAssignGroundsTask() {
  const invalidate = useMaintInvalidate();
  return useMutation({
    mutationFn: async (input: { taskId: string; assigneeId: string }) => {
      const { data, error } = await guardedRpc(db, "neo_grounds_task_assign", {
        _task: input.taskId,
        _assignee: input.assigneeId,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as MaintRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Grounds task assigned");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAdvanceGroundsTask() {
  const invalidate = useMaintInvalidate();
  return useMutation({
    mutationFn: async (input: { taskId: string; status: GroundsStatus; note?: string }) => {
      const { data, error } = await guardedRpc(db, "neo_grounds_task_advance", {
        _task: input.taskId,
        _status: input.status,
        _note: input.note ?? "",
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as MaintRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(
        `Task marked ${GROUNDS_STATUS_LABELS[maintStr(data["status"], "")] ?? "updated"}`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * A technician's own jobs
 * ------------------------------------------------------------------ */

export function useMyMaintenanceJobs() {
  const { organizationId, userId } = useMaintenanceContext();
  return useQuery({
    queryKey: ["maintenance-dept", "my-jobs", organizationId, userId],
    enabled: Boolean(organizationId && userId),
    queryFn: async () => {
      const { data, error } = await db
        .from("maintenance_work_orders")
        .select("*")
        .eq("assigned_to", userId)
        .order("reported_at", { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);
      return (data ?? []) as MaintRow[];
    },
  });
}

export function useWorkOrderParts(workOrderId: string | null) {
  const { organizationId } = useMaintenanceContext();
  return useQuery({
    queryKey: ["maintenance-dept", "parts", organizationId, workOrderId],
    enabled: Boolean(organizationId && workOrderId),
    queryFn: async () => {
      const { data, error } = await db
        .from("work_order_parts")
        .select("*")
        .eq("work_order_id", workOrderId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw new Error(error.message);
      return (data ?? []) as MaintRow[];
    },
  });
}

export function useAdvanceMaintenanceJob() {
  const invalidate = useMaintInvalidate();
  return useMutation({
    mutationFn: async (input: {
      workOrderId: string;
      status: string;
      note?: string;
      diagnosis?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_maint_job_advance", {
        _work_order: input.workOrderId,
        _status: input.status,
        _note: input.note ?? "",
        _diagnosis: input.diagnosis ?? "",
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as MaintRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Job updated — ${maintStr(data["status"], "saved")}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRecordJobMaterials() {
  const invalidate = useMaintInvalidate();
  return useMutation({
    mutationFn: async (input: {
      workOrderId: string;
      description: string;
      quantity: number;
      unit?: string;
    }) => {
      if (!input.description.trim()) throw new Error("Describe the material used");
      const { data, error } = await guardedRpc(db, "neo_maint_record_parts", {
        _work_order: input.workOrderId,
        _description: input.description.trim(),
        _quantity: input.quantity,
        _unit: input.unit ?? "unit",
        _stock_item: null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as MaintRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Material recorded against the job");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Material needs — reported to the Manager, never straight to Stores
 * ------------------------------------------------------------------ */

export function useMaintenanceMaterialNeeds() {
  const { organizationId, branchId } = useMaintenanceContext();
  return useQuery({
    queryKey: ["maintenance-dept", "needs", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("department_stock_needs")
        .select("*")
        .eq("module", "maintenance")
        .order("created_at", { ascending: false })
        .limit(200);
      if (branchId) {
        q = q.or(
          `branch_id.eq.${branchId},branch_id.is.null`,
        );
      }
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as MaintRow[];
    },
  });
}

export function useReportMaintenanceNeed() {
  const invalidate = useMaintInvalidate();
  const { branchId } = useMaintenanceContext();
  return useMutation({
    mutationFn: async (input: {
      item: string;
      quantity: number;
      unit?: string;
      priority?: string;
      notes?: string;
    }) => {
      if (!input.item.trim()) throw new Error("Name the material you need");
      const { data, error } = await guardedRpc(db, "neo_department_stock_need_create", {
        _item: input.item.trim(),
        _quantity: input.quantity,
        _unit: input.unit ?? "unit",
        _priority: input.priority ?? "normal",
        _notes: input.notes ?? null,
        _module: "maintenance",
        _department: null,
        _branch: branchId,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Need reported to the Maintenance Manager");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReviewMaintenanceNeed() {
  const invalidate = useMaintInvalidate();
  return useMutation({
    mutationFn: async (input: { needId: string; decision: string; notes?: string }) => {
      const { data, error } = await guardedRpc(db, "neo_department_stock_need_review", {
        _need: input.needId,
        _decision: input.decision,
        _notes: input.notes ?? null,
        _requisition: null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as MaintRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Material need updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Fault categories — the hotel's own list, not a fixed developer list
 * ------------------------------------------------------------------ */

export function useMaintenanceCategories() {
  const { organizationId } = useMaintenanceContext();
  return useQuery({
    queryKey: ["maintenance-dept", "categories", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db
        .from("maintenance_categories")
        .select(
          "id, name, code, default_priority, response_target_minutes, resolution_target_minutes, active",
        )
        .order("name")
        .limit(200);
      if (error) throw new Error(error.message);
      return (data ?? []) as MaintRow[];
    },
  });
}

/* ------------------------------------------------------------------ *
 * Spare parts taken from Stores
 *
 * Recording a part on the job is not the same as taking it off the shelf. This
 * consumes the item from a real store location, so the stock figure, the job
 * cost and the maintenance record agree.
 * ------------------------------------------------------------------ */

export function useConsumeStockPart() {
  const invalidate = useMaintInvalidate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      workOrderId: string;
      stockItemId: string;
      locationId: string;
      quantity: number;
      unit?: string;
      description?: string;
      /** One-time reference so a repeated tap cannot issue the part twice. */
      idempotencyKey?: string;
    }) => {
      if (!input.stockItemId) throw new Error("Choose the stock item used");
      if (!input.locationId) throw new Error("Choose the store it came from");
      if (!(input.quantity > 0)) throw new Error("Enter how much was used");
      const { data, error } = await guardedRpc(db, "neo_maint_consume_part", {
        _work_order: input.workOrderId,
        _stock_item: input.stockItemId,
        _location: input.locationId,
        _quantity: input.quantity,
        _unit: input.unit ?? null,
        _description: input.description ?? null,
        _idempotency_key: input.idempotencyKey ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as MaintRow;
    },
    onSuccess: (data) => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ["inventory"] });
      toast.success(
        data["duplicate"]
          ? "That part was already recorded — nothing was issued twice"
          : data["valued"]
            ? "Part issued from stores and costed to the job"
            : "Part issued from stores — the item has no recorded cost yet",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export type IssuableStock = {
  stock_item_id: string;
  item_name: string;
  base_unit: string | null;
  location_id: string;
  location_name: string;
  quantity_on_hand: number;
};

/**
 * What this job can actually draw on: items with stock on hand, in an active
 * store of the work order's own property. Offering anything else invites a
 * refusal the technician cannot act on.
 */
export function useIssuableStockForJob(workOrderId?: string | null) {
  return useQuery({
    queryKey: ["maintenance-dept", "issuable-stock", workOrderId ?? null],
    enabled: Boolean(workOrderId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_maint_issuable_stock", {
        _work_order: workOrderId,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as IssuableStock[];
    },
  });
}

/* ------------------------------------------------------------------ *
 * Overdue work escalates through the existing notification architecture
 * ------------------------------------------------------------------ */

export function useMaintenanceEscalationScan() {
  const invalidate = useMaintInvalidate();
  const { branchId } = useMaintenanceContext();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_maint_escalation_scan", {
        _branch: branchId,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as { raised?: number };
    },
    onSuccess: (data) => {
      invalidate();
      const n = Number(data?.raised ?? 0);
      toast.success(
        n > 0
          ? `${n} overdue job${n === 1 ? "" : "s"} escalated`
          : "Nothing is past its response or resolution target",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Completed work kept against the canonical asset. */
export function useAssetServiceHistory(assetId?: string | null) {
  return useQuery({
    queryKey: ["maintenance-dept", "asset-service", assetId ?? null],
    enabled: Boolean(assetId),
    queryFn: async () => {
      const { data, error } = await db
        .from("asset_service_history")
        .select("*")
        .eq("asset_id", assetId)
        .order("service_date", { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);
      return (data ?? []) as MaintRow[];
    },
  });
}
