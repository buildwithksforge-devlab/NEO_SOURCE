/**
 * Sales, Events & Banqueting department layer.
 *
 * One Sales & Events Manager owns the whole department: leads, quotations,
 * bookings, the BEO, department readiness and every commitment made to a
 * client. Banqueting Staff execute — they see the events they are assigned to,
 * the BEO instructions relevant to their work and their own tasks, and nothing
 * about the client's money.
 *
 * The boundaries encoded here mirror the department contract:
 *  - Banqueting Staff never raise a Stores requisition; they report a need and
 *    the Sales & Events Manager decides whether it becomes one.
 *  - Banqueting Staff never confirm payments, change prices or cancel events.
 *  - Task progress only moves forward, and nobody approves their own request.
 *
 * Writes go through the security-definer RPCs so the database, not the screen,
 * is what enforces those rules.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useScopedWorkerOptions } from "@/lib/scoped-options";
import { applyStockNeedStatus } from "@/lib/stock-needs";

// The banqueting trail spans several generated table types; call sites narrow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type SevRow = Record<string, unknown>;

export const BANQUET_TASK_STATUSES = ["not-started", "in-progress", "ready", "completed", "blocked"] as const;
export type BanquetTaskStatus = (typeof BANQUET_TASK_STATUSES)[number];

export const BANQUET_TASK_LABELS: Record<string, string> = {
  "not-started": "Not started",
  "in-progress": "In progress",
  ready: "Ready",
  completed: "Completed",
  blocked: "Blocked",
};

export const BANQUET_ISSUE_CATEGORIES = [
  { value: "missing-equipment", label: "Missing equipment", routesTo: "Stores" },
  { value: "missing-setup-item", label: "Missing setup item", routesTo: "Stores" },
  { value: "damaged-equipment", label: "Damaged equipment", routesTo: "Maintenance" },
  { value: "maintenance", label: "Maintenance issue", routesTo: "Maintenance" },
  { value: "stock-shortage", label: "Stock shortage", routesTo: "Stores" },
  { value: "guest-service", label: "Guest / service issue", routesTo: "Sales & Events Manager" },
  { value: "safety", label: "Safety issue", routesTo: "Security" },
  { value: "event-delay", label: "Event delay", routesTo: "Sales & Events Manager" },
  { value: "other", label: "Other", routesTo: "Sales & Events Manager" },
] as const;

export const BANQUET_SUPPLY_SUGGESTIONS = [
  "Table linen",
  "Chair covers",
  "Cutlery sets",
  "Glassware",
  "Service trays",
  "Décor materials",
  "Signage",
] as const;

export const BANQUET_TASK_SUGGESTIONS = [
  "Set guest tables",
  "Prepare high table",
  "Place table linen",
  "Prepare service station",
  "Water setup",
  "Venue breakdown and clearing",
] as const;

export function sevStr(value: unknown, fallback = "—"): string {
  const s = value === null || value === undefined ? "" : String(value);
  return s.trim() === "" ? fallback : s;
}

export function sevNum(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function taskTone(status: string): "success" | "warning" | "destructive" | "default" {
  if (status === "completed") return "success";
  if (status === "ready") return "success";
  if (status === "blocked") return "destructive";
  if (status === "in-progress") return "warning";
  return "default";
}

/** The next stage a banqueting task may move to, or null when it is finished. */
export function nextTaskStatus(status: string): BanquetTaskStatus | null {
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

export function useSalesEventsContext() {
  const { organizationId, profile, user } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const fallback = (profile as { branch_id?: string | null } | null)?.branch_id ?? null;
  return { organizationId, branchId: branchId ?? fallback, userId: user?.id ?? null };
}

function useSevInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["sales-events"] });
    void qc.invalidateQueries({ queryKey: ["events"] });
  };
}

/* ------------------------------------------------------------------ *
 * Events the department can plan against
 * ------------------------------------------------------------------ */

export function useBanquetEventOptions() {
  const { organizationId, branchId } = useSalesEventsContext();
  return useQuery({
    queryKey: ["sales-events", "event-options", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("event_bookings")
        .select("id,event_reference,event_name,event_date,status,venue_id,expected_guests")
        .neq("status", "cancelled")
        .order("event_date", { ascending: true })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as SevRow[];
    },
  });
}

/* ------------------------------------------------------------------ *
 * Staff assignments — who is working which event
 * ------------------------------------------------------------------ */

export function useBanquetingStaffOptions() {
  const workers = useScopedWorkerOptions({ departmentKey: "sales-events-banqueting", jobTitlePattern: "banquet|event|sales" });
  const data = (workers.data ?? []).map((w) => ({
    id: w.id,
    name: w.full_name,
    branchId: w.branch_id,
  }));
  return { ...workers, data };
}

export function useEventStaffAssignments(bookingId: string | null = null) {
  const { organizationId, branchId } = useSalesEventsContext();
  return useQuery({
    queryKey: ["sales-events", "assignments", organizationId, branchId, bookingId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("event_staff_assignments")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(400);
      if (bookingId) q = q.eq("booking_id", bookingId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as SevRow[];
    },
  });
}

export function useAssignBanquetingStaff() {
  const invalidate = useSevInvalidate();
  return useMutation({
    mutationFn: async (input: { bookingId: string; staffId: string; station?: string; duties?: string }) => {
      if (!input.bookingId) throw new Error("Choose the event first");
      if (!input.staffId) throw new Error("Choose a banqueting staff member");
      const { data, error } = await guardedRpc(db, "neo_event_assign_staff", {
        _booking: input.bookingId,
        _staff: input.staffId,
        _station: input.station ?? "",
        _duties: input.duties ?? "",
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as SevRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Banqueting staff assigned to the event");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRemoveBanquetingAssignment() {
  const invalidate = useSevInvalidate();
  return useMutation({
    mutationFn: async (assignmentId: string) => {
      const { error } = await db.from("event_staff_assignments").delete().eq("id", assignmentId);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Assignment removed");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Banqueting tasks
 * ------------------------------------------------------------------ */

export function useBanquetTasks(bookingId: string | null = null) {
  const { organizationId, branchId } = useSalesEventsContext();
  return useQuery({
    queryKey: ["sales-events", "tasks", organizationId, branchId, bookingId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("event_banquet_tasks")
        .select("*")
        .order("sequence", { ascending: true })
        .limit(400);
      if (bookingId) q = q.eq("booking_id", bookingId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as SevRow[];
    },
  });
}

/**
 * A banqueting staff member's own board. RLS already limits the rows to the
 * caller's tasks; the explicit filter keeps a manager's console honest too.
 */
export function useMyBanquetTasks() {
  const { organizationId, userId } = useSalesEventsContext();
  return useQuery({
    queryKey: ["sales-events", "my-tasks", organizationId, userId],
    enabled: Boolean(organizationId && userId),
    queryFn: async () => {
      const { data, error } = await db
        .from("event_banquet_tasks")
        .select("*")
        .eq("assignee_user_id", userId)
        .order("sequence", { ascending: true })
        .limit(200);
      if (error) throw new Error(error.message);
      return (data ?? []) as SevRow[];
    },
  });
}

export function useMyEventAssignments() {
  const { organizationId, userId } = useSalesEventsContext();
  return useQuery({
    queryKey: ["sales-events", "my-assignments", organizationId, userId],
    enabled: Boolean(organizationId && userId),
    queryFn: async () => {
      const { data, error } = await db
        .from("event_staff_assignments")
        .select("*, event_bookings(id,event_reference,event_name,event_date,expected_guests,status)")
        .eq("staff_user_id", userId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw new Error(error.message);
      return (data ?? []) as SevRow[];
    },
  });
}

export function useCreateBanquetTask() {
  const invalidate = useSevInvalidate();
  return useMutation({
    mutationFn: async (input: {
      bookingId: string;
      title: string;
      assigneeId?: string | null;
      instruction?: string;
      station?: string;
      dueAt?: string | null;
    }) => {
      if (!input.bookingId) throw new Error("Choose the event first");
      if (!input.title.trim()) throw new Error("Give the task a title");
      const { data, error } = await guardedRpc(db, "neo_event_task_create", {
        _booking: input.bookingId,
        _title: input.title.trim(),
        _assignee: input.assigneeId || null,
        _instruction: input.instruction ?? "",
        _station: input.station ?? "",
        _due: input.dueAt || null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as SevRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Banqueting task created");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAdvanceBanquetTask() {
  const invalidate = useSevInvalidate();
  return useMutation({
    mutationFn: async (input: { taskId: string; status: BanquetTaskStatus; blocker?: string }) => {
      const { data, error } = await guardedRpc(db, "neo_event_task_advance", {
        _task: input.taskId,
        _status: input.status,
        _blocker: input.blocker ?? "",
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as SevRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Task marked ${BANQUET_TASK_LABELS[sevStr(data["status"], "")] ?? "updated"}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Issue reporting — routed to the department that owns the fix
 * ------------------------------------------------------------------ */

export function useEventIssues(status = "all") {
  const { organizationId, branchId } = useSalesEventsContext();
  return useQuery({
    queryKey: ["sales-events", "issues", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("event_issue_reports")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      q = applyStockNeedStatus(q, status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as SevRow[];
    },
  });
}

export function useReportEventIssue() {
  const invalidate = useSevInvalidate();
  return useMutation({
    mutationFn: async (input: { bookingId: string | null; category: string; detail: string; taskId?: string | null }) => {
      if (!input.detail.trim()) throw new Error("Describe the issue");
      const { data, error } = await guardedRpc(db, "neo_event_issue_report", {
        _booking: input.bookingId,
        _category: input.category,
        _detail: input.detail.trim(),
        _task: input.taskId || null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as SevRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Reported — routed to ${sevStr(data["route_to"], "the Sales & Events Manager")}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useResolveEventIssue() {
  const invalidate = useSevInvalidate();
  return useMutation({
    mutationFn: async (input: { issueId: string; status: string; resolution?: string }) => {
      const { data, error } = await guardedRpc(db, "neo_event_issue_resolve", {
        _issue: input.issueId,
        _status: input.status,
        _resolution: input.resolution ?? "",
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as SevRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Issue ${sevStr(data["status"], "updated")}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Supply needs — reported by banqueting, requisitioned by the manager
 * ------------------------------------------------------------------ */

export function useEventStockNeeds(status = "all") {
  const { organizationId, branchId } = useSalesEventsContext();
  return useQuery({
    queryKey: ["sales-events", "stock-needs", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("department_stock_needs")
        .select("*")
        .eq("module", "events")
        .order("created_at", { ascending: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      q = applyStockNeedStatus(q, status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as SevRow[];
    },
  });
}

export function useReportEventStockNeed() {
  const invalidate = useSevInvalidate();
  const { branchId } = useSalesEventsContext();
  return useMutation({
    mutationFn: async (input: {
      item: string;
      quantity: number;
      unit?: string;
      priority?: string;
      notes?: string;
    }) => {
      if (!input.item.trim()) throw new Error("Name the item needed");
      const { data, error } = await guardedRpc(db, "neo_department_stock_need_create", {
        _item: input.item.trim(),
        _quantity: input.quantity,
        _unit: input.unit ?? "unit",
        _priority: input.priority ?? "normal",
        _notes: input.notes ?? null,
        _module: "events",
        _department: null,
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Need sent to the Sales & Events Manager");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReviewEventStockNeed() {
  const invalidate = useSevInvalidate();
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
      return (data ?? {}) as SevRow;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Supply need ${sevStr(data["status"], "reviewed")}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
