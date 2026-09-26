/**
 * Delivery Department layer.
 *
 * The Delivery Department has exactly two roles: the Delivery Manager, who sees
 * and controls the whole department, and the Rider/Driver, who only ever sees
 * their own assigned work. Every write goes through a database routine that
 * re-checks the caller's `delivery.*` capability (and, for riders, that the
 * record is theirs), so isolation cannot be bypassed from the browser.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useScopedDepartmentByKey } from "@/lib/scoped-options";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type DeliveryRow = Record<string, unknown>;

export const SUPPLY_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const MAINTENANCE_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const FAULT_CATEGORIES = [
  "vehicle",
  "motorcycle",
  "delivery-box",
  "equipment",
  "safety-gear",
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

export function useDeliveryContext() {
  const { organizationId, profile } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const fallback = (profile as { branch_id?: string | null } | null)?.branch_id ?? null;
  return { organizationId, branchId: branchId ?? fallback };
}

function useDeliveryInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["delivery-department"] });
    void qc.invalidateQueries({ queryKey: ["delivery"] });
    void qc.invalidateQueries({ queryKey: ["fnb"] });
  };
}

/** The Delivery department row, used to scope requisitions and tasks. */
export function useDeliveryDepartment() {
  return useScopedDepartmentByKey("delivery|dispatch");
}

/* ------------------------------------------------------------------ *
 * Department performance (Delivery Manager only)
 * ------------------------------------------------------------------ */

export function useDeliveryDepartmentMetrics(from?: string | null, to?: string | null) {
  const { organizationId, branchId } = useDeliveryContext();
  return useQuery({
    queryKey: ["delivery-department", "metrics", organizationId, branchId, from ?? "d", to ?? "d"],
    enabled: Boolean(organizationId),
    refetchInterval: 60_000,
    queryFn: async () => {
      const args: Record<string, unknown> = { _branch: branchId ?? null };
      if (from) args["_from"] = from;
      if (to) args["_to"] = to;
      const { data, error } = await guardedRpc(db, "neo_delivery_department_metrics", args);
      if (error) throw new Error(error.message);
      return (data ?? {}) as DeliveryRow;
    },
  });
}

/**
 * Read a nested group out of the department metrics payload.
 * `neo_delivery_department_metrics` returns
 * `{ window, volume, service, payments, riders, exceptions }` — never a flat map.
 */
export function metricGroup(data: DeliveryRow | undefined | null, group: string): DeliveryRow {
  const value = (data ?? {})[group];
  return value && typeof value === "object" ? (value as DeliveryRow) : {};
}

/** Per-rider throughput for the same period, straight from the rider ledger. */
export function useDeliveryRiderPerformance(from?: string | null, to?: string | null) {
  const { organizationId, branchId } = useDeliveryContext();
  return useQuery({
    queryKey: ["delivery-department", "rider-performance", organizationId, branchId, from ?? "d", to ?? "d"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_delivery_rider_performance", {
        _branch: branchId ?? null,
        _from: from ?? null,
        _to: to ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as DeliveryRow[];
    },
  });
}

/* ------------------------------------------------------------------ *
 * Supply / equipment needs (rider reports → manager reviews)
 * ------------------------------------------------------------------ */

export function useDeliverySupplyRequests(status = "all") {
  const { organizationId } = useDeliveryContext();
  return useQuery({
    queryKey: ["delivery-department", "supply", organizationId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("delivery_supply_requests")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      if (status !== "all") q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as DeliveryRow[];
    },
  });
}

export function useCreateSupplyRequest() {
  const invalidate = useDeliveryInvalidate();
  const { branchId } = useDeliveryContext();
  return useMutation({
    mutationFn: async (input: {
      item: string;
      quantity: number;
      unit?: string;
      priority?: string;
      notes?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_delivery_supply_request_create", {
        _item: input.item,
        _quantity: input.quantity,
        _unit: input.unit ?? "unit",
        _priority: input.priority ?? "normal",
        _notes: input.notes ?? null,
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Supply need sent to the Delivery Manager");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReviewSupplyRequest() {
  const invalidate = useDeliveryInvalidate();
  return useMutation({
    mutationFn: async (input: { requestId: string; decision: string; notes?: string }) => {
      const { data, error } = await guardedRpc(db, "neo_delivery_supply_request_review", {
        _request: input.requestId,
        _decision: input.decision,
        _notes: input.notes ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as DeliveryRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Supply request ${str(data["status"], "reviewed")}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Maintenance requests for delivery vehicles and equipment
 * ------------------------------------------------------------------ */

export function useDeliveryMaintenanceRequests() {
  const { organizationId, branchId } = useDeliveryContext();
  return useQuery({
    queryKey: ["delivery-department", "maintenance", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_delivery_maintenance_requests", {
        _branch: branchId ?? null,
        _limit: 100,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as DeliveryRow[];
    },
  });
}

export function useCreateDeliveryMaintenanceRequest() {
  const invalidate = useDeliveryInvalidate();
  const { branchId } = useDeliveryContext();
  return useMutation({
    mutationFn: async (input: {
      asset: string;
      description: string;
      priority?: string;
      faultCategory?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_delivery_maintenance_request", {
        _asset_label: input.asset,
        _description: input.description,
        _priority: input.priority ?? "medium",
        _fault_category: input.faultCategory ?? "vehicle",
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Maintenance request raised");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Tasks — the manager assigns, the rider only sees their own
 * ------------------------------------------------------------------ */

export function useDeliveryTasks(scope: "department" | "mine" = "department") {
  const { organizationId, branchId } = useDeliveryContext();
  const { user } = useAuth();
  const department = useDeliveryDepartment();
  const departmentId = department.data?.["id"] ? String(department.data["id"]) : null;
  return useQuery({
    queryKey: ["delivery-department", "tasks", organizationId, branchId, scope, departmentId, user?.id],
    enabled: Boolean(organizationId) && (scope === "mine" ? Boolean(user?.id) : Boolean(departmentId)),
    queryFn: async () => {
      let q = db
        .from("tasks")
        .select("*")
        .order("due_at", { ascending: true, nullsFirst: false })
        .limit(200);
      if (scope === "mine") q = q.eq("assignee_id", user!.id);
      else if (departmentId) q = q.eq("department_id", departmentId);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as DeliveryRow[];
    },
  });
}

/** Riders on the roster, used as the assignee list for delivery tasks. */
export function useDeliveryRiderOptions() {
  const { organizationId, branchId } = useDeliveryContext();
  return useQuery({
    queryKey: ["delivery-department", "rider-options", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_delivery_rider_roster", { _branch: branchId ?? null });
      if (error) throw new Error(error.message);
      return ((data ?? []) as DeliveryRow[]).filter((r) => Boolean(r["profile_id"]));
    },
  });
}

export function useCreateDeliveryTask() {
  const invalidate = useDeliveryInvalidate();
  const { organizationId, branchId } = useDeliveryContext();
  const { user } = useAuth();
  const department = useDeliveryDepartment();
  return useMutation({
    mutationFn: async (input: {
      title: string;
      description?: string;
      assigneeId: string;
      dueAt?: string | null;
      priority?: string;
    }) => {
      if (!organizationId) throw new Error("No organisation context");
      const departmentId = department.data?.["id"] ? String(department.data["id"]) : null;
      const { error } = await db.from("tasks").insert({
        organization_id: organizationId,
        branch_id: branchId ?? null,
        department_id: departmentId,
        title: input.title,
        description: input.description ?? null,
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
      toast.success("Task assigned");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUpdateDeliveryTask() {
  const invalidate = useDeliveryInvalidate();
  return useMutation({
    mutationFn: async (input: { taskId: string; status?: string; progress?: number; assigneeId?: string }) => {
      const patch: Record<string, unknown> = {};
      if (input.status) {
        patch["status"] = input.status;
        if (input.status === "completed") patch["completed_at"] = new Date().toISOString();
      }
      if (typeof input.progress === "number") patch["progress"] = input.progress;
      if (input.assigneeId) patch["assignee_id"] = input.assigneeId;
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
