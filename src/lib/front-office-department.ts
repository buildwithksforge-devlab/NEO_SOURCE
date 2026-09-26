/**
 * Front Office department layer.
 *
 * The department has two roles: the Front Office Manager, who sees and runs the
 * whole desk for their property, and the Receptionist(s), who work a shared
 * operational desk but never assign work, never raise a Stores requisition and
 * never approve anything themselves.
 *
 * Reservations are deliberately NOT isolated per receptionist — the desk is a
 * shared service point — while every action stays attributed to the person who
 * performed it through the existing audit trail.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useScopedDepartmentByKey, useScopedWorkerOptions } from "@/lib/scoped-options";
import { applyStockNeedStatus } from "@/lib/stock-needs";

// The Front Office trail spans many generated table types; call sites narrow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type FrontOfficeRow = Record<string, unknown>;

export const FO_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export const FO_SUPPLY_SUGGESTIONS = [
  "Printing paper",
  "Guest registration cards",
  "Receipt rolls",
  "Key cards",
  "Stationery",
  "Front desk consumables",
] as const;

export function str(value: unknown, fallback = "—"): string {
  const s = value === null || value === undefined ? "" : String(value);
  return s.trim() === "" ? fallback : s;
}

export function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function useFrontOfficeContext() {
  const { organizationId, profile } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const fallback = (profile as { branch_id?: string | null } | null)?.branch_id ?? null;
  return { organizationId, branchId: branchId ?? fallback };
}

function useFrontOfficeInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["front-office-department"] });
    void qc.invalidateQueries({ queryKey: ["pms"] });
    void qc.invalidateQueries({ queryKey: ["fnb"] });
  };
}

/** The Front Office department row, used to scope tasks and requisitions. */
export function useFrontOfficeDepartment() {
  return useScopedDepartmentByKey("front.?office|front.?desk|reception");
}

/* ------------------------------------------------------------------ *
 * Tasks — the manager assigns, a receptionist only sees their own
 * ------------------------------------------------------------------ */

export function useFrontOfficeTasks(scope: "department" | "mine" = "department") {
  const { organizationId, branchId } = useFrontOfficeContext();
  const { user } = useAuth();
  const department = useFrontOfficeDepartment();
  const departmentId = department.data?.["id"] ? String(department.data["id"]) : null;
  return useQuery({
    queryKey: [
      "front-office-department",
      "tasks",
      organizationId,
      branchId,
      scope,
      departmentId,
      user?.id,
    ],
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
      return (data ?? []) as FrontOfficeRow[];
    },
  });
}

/** Receptionists (and other Front Office staff) available as task assignees. */
export function useFrontOfficeStaffOptions() {
  const department = useFrontOfficeDepartment();
  const departmentId = department.data?.id ?? null;
  return useScopedWorkerOptions({ departmentId, departmentKey: departmentId ? null : "front-office" });
}

export function useCreateFrontOfficeTask() {
  const invalidate = useFrontOfficeInvalidate();
  const { organizationId, branchId } = useFrontOfficeContext();
  const { user } = useAuth();
  const department = useFrontOfficeDepartment();
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
      toast.success("Front Office task assigned");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUpdateFrontOfficeTask() {
  const invalidate = useFrontOfficeInvalidate();
  return useMutation({
    mutationFn: async (input: {
      taskId: string;
      status?: string;
      progress?: number;
      assigneeId?: string;
    }) => {
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

/* ------------------------------------------------------------------ *
 * Stock needs — a receptionist reports, the manager requisitions
 * ------------------------------------------------------------------ */

export function useFrontOfficeStockNeeds(status = "all") {
  const { organizationId, branchId } = useFrontOfficeContext();
  return useQuery({
    queryKey: ["front-office-department", "stock-needs", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("department_stock_needs")
        .select("*")
        .eq("module", "front-office")
        .order("created_at", { ascending: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      q = applyStockNeedStatus(q, status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as FrontOfficeRow[];
    },
  });
}

export function useReportStockNeed() {
  const invalidate = useFrontOfficeInvalidate();
  const { branchId } = useFrontOfficeContext();
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
        _module: "front-office",
        _department: null,
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Stock need sent to the Front Office Manager");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReviewStockNeed() {
  const invalidate = useFrontOfficeInvalidate();
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
      return (data ?? {}) as FrontOfficeRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Stock need ${str(data["status"], "reviewed")}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Intelligence — arrival risk and desk pressure, derived from live data
 * ------------------------------------------------------------------ */

export type FrontOfficeIntelligence = {
  arrivalRisk: number;
  unassigned: number;
  notReady: number;
  overdueRequests: number;
  outstandingFolios: number;
};

/**
 * Arrival risk: confirmed arrivals still due today whose room is either
 * unassigned or not yet released by Housekeeping.
 */
export function useArrivalRisk(date: string) {
  const { organizationId, branchId } = useFrontOfficeContext();
  return useQuery({
    queryKey: ["front-office-department", "arrival-risk", organizationId, branchId, date],
    enabled: Boolean(organizationId),
    refetchInterval: 120_000,
    queryFn: async () => {
      let q = db
        .from("reservations")
        .select(
          "id, confirmation_number, arrival_date, status, room_id, customers(full_name), rooms(room_number, room_condition, housekeeping_status)",
        )
        .eq("arrival_date", date)
        .in("status", ["confirmed", "guaranteed", "tentative", "pending-deposit"])
        .order("created_at", { ascending: true })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as FrontOfficeRow[];
      return rows.filter((r) => {
        if (!r["room_id"]) return true;
        const room = (r["rooms"] ?? {}) as FrontOfficeRow;
        const state = `${str(room["room_condition"], "")} ${str(room["housekeeping_status"], "")}`.toLowerCase();
        return /dirty|cleaning|inspection|not-ready|out-of-order|maintenance/.test(state);
      });
    },
  });
}

/** Receptionist activity for the day, read from the shared audit trail. */
export function useReceptionistActivity(date: string) {
  const { organizationId } = useFrontOfficeContext();
  return useQuery({
    queryKey: ["front-office-department", "activity", organizationId, date],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const from = `${date}T00:00:00.000Z`;
      const to = `${date}T23:59:59.999Z`;
      const { data, error } = await db
        .from("audit_logs")
        .select("id, action, module, user_id, user_name, created_at, record_id")
        .eq("module", "front-office")
        .gte("created_at", from)
        .lte("created_at", to)
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) throw new Error(error.message);
      return (data ?? []) as FrontOfficeRow[];
    },
  });
}

/** Group a day of Front Office actions by the staff member who performed them. */
export function summariseActivity(rows: FrontOfficeRow[]) {
  const byUser = new Map<string, { name: string; total: number; actions: Map<string, number> }>();
  for (const r of rows) {
    const key = str(r["user_id"], "unknown");
    const entry =
      byUser.get(key) ?? { name: str(r["user_name"], "Unattributed"), total: 0, actions: new Map() };
    entry.total += 1;
    const action = str(r["action"], "action");
    entry.actions.set(action, (entry.actions.get(action) ?? 0) + 1);
    byUser.set(key, entry);
  }
  return Array.from(byUser.entries())
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.total - a.total);
}
