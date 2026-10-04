/**
 * Security department layer.
 *
 * The department runs on two tiers and the boundaries below mirror that
 * contract exactly:
 *
 *  - The Security Supervisor owns the whole operation: posts, guard
 *    assignments, patrol requirements, every incident, visitor and contractor
 *    records, handovers, security tasks, departmental supplies and reporting.
 *    They alone review, escalate and close an incident, and they alone turn a
 *    reported need into a Stores requisition.
 *  - A Security Guard sees a focused operational workspace: their post, their
 *    shift, their patrols, their tasks, the visitor records they take and the
 *    incidents they reported. No guest money, no finance, no HR file, no
 *    inventory balance, no user administration.
 *
 * Security history is permanent — no route here deletes an incident, a patrol
 * record or a handover. Every write goes through a security-definer routine so
 * the database, not the screen, enforces this.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useScopedWorkerOptions } from "@/lib/scoped-options";
import { applyStockNeedStatus } from "@/lib/stock-needs";

// The security trail spans several generated table types; call sites narrow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type SecurityRow = Record<string, unknown>;

export const INCIDENT_CATEGORIES = [
  "theft-or-loss",
  "unauthorised-access",
  "property-damage",
  "guest-disturbance",
  "staff-incident",
  "suspicious-activity",
  "vehicle-incident",
  "safety-hazard",
  "emergency",
  "lost-property",
  "other",
] as const;

export const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const SHIFT_LABELS = ["day", "evening", "night"] as const;
export const SECURITY_NEED_UNITS = ["piece", "pack", "box", "pair", "set", "litre"] as const;

export function securityStr(value: unknown, fallback = "—"): string {
  const s = value === null || value === undefined ? "" : String(value);
  return s.trim() === "" ? fallback : s;
}

export function securityNum(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function securityTone(
  status: string,
): "success" | "warning" | "info" | "destructive" | "default" {
  if (["completed", "closed", "resolved", "acknowledged"].includes(status)) return "success";
  if (["in-progress", "under-review"].includes(status)) return "info";
  if (["assigned", "open", "reported", "submitted"].includes(status)) return "warning";
  if (["escalated", "cancelled"].includes(status)) return "destructive";
  return "default";
}

export function severityTone(severity: string): "success" | "warning" | "destructive" | "default" {
  if (severity === "critical" || severity === "high") return "destructive";
  if (severity === "medium") return "warning";
  if (severity === "low") return "success";
  return "default";
}

/** Forward-only incident lifecycle, identical to the database guard. */
export function nextIncidentStatuses(status: string): string[] {
  switch (status) {
    case "reported":
      return ["under-review", "escalated", "resolved"];
    case "under-review":
      return ["escalated", "resolved"];
    case "escalated":
      return ["resolved"];
    case "resolved":
      return ["closed"];
    default:
      return [];
  }
}

export type PatrolCheckpoint = { area: string; due?: string | null; done_at?: string | null };

export function patrolCheckpoints(value: unknown): PatrolCheckpoint[] {
  if (!Array.isArray(value)) return [];
  return value.map((c) => {
    const row = (c ?? {}) as Record<string, unknown>;
    return {
      area: securityStr(row["area"], "Checkpoint"),
      due: row["due"] ? String(row["due"]) : null,
      done_at: row["done_at"] ? String(row["done_at"]) : null,
    };
  });
}

export function patrolProgress(value: unknown): { done: number; total: number } {
  const points = patrolCheckpoints(value);
  return { done: points.filter((p) => p.done_at).length, total: points.length };
}

export function useSecurityContext() {
  const { organizationId, profile, user } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const fallback = (profile as { branch_id?: string | null } | null)?.branch_id ?? null;
  return { organizationId, branchId: branchId ?? fallback, userId: user?.id ?? null };
}

function useSecurityInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["security"] });
  };
}

/* ------------------------------------------------------------------ *
 * Posts and guard assignments — Security Supervisor
 * ------------------------------------------------------------------ */

export function useSecurityPosts() {
  const { organizationId, branchId } = useSecurityContext();
  return useQuery({
    queryKey: ["security", "posts", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db.from("security_posts").select("*").order("name").limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as SecurityRow[];
    },
  });
}

export function useUpsertSecurityPost() {
  const invalidate = useSecurityInvalidate();
  const { branchId } = useSecurityContext();
  return useMutation({
    mutationFn: async (input: {
      name: string;
      area?: string;
      notes?: string;
      postId?: string | null;
      active?: boolean;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_security_post_upsert", {
        _name: input.name,
        _area: input.area ?? null,
        _notes: input.notes ?? null,
        _branch: branchId ?? null,
        _post: input.postId ?? null,
        _active: input.active ?? true,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as SecurityRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Security post saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useSecurityAssignments(shiftDate?: string) {
  const { organizationId, branchId } = useSecurityContext();
  return useQuery({
    queryKey: ["security", "assignments", organizationId, branchId, shiftDate ?? "all"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("security_post_assignments")
        .select("*, security_posts(name, area)")
        .order("shift_date", { ascending: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      if (shiftDate) q = q.eq("shift_date", shiftDate);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as SecurityRow[];
    },
  });
}

export function useAssignGuardToPost() {
  const invalidate = useSecurityInvalidate();
  return useMutation({
    mutationFn: async (input: {
      postId: string;
      guardId: string;
      shiftDate?: string | null;
      shiftLabel?: string;
      startsAt?: string | null;
      endsAt?: string | null;
      notes?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_security_assign_post", {
        _post: input.postId,
        _guard: input.guardId,
        _shift_date: input.shiftDate ?? null,
        _shift_label: input.shiftLabel ?? "day",
        _starts: input.startsAt ?? null,
        _ends: input.endsAt ?? null,
        _notes: input.notes ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as SecurityRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Guard assigned to post");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Guards available to assign, read from the department's staff records. */
export function useSecurityStaff() {
  return useScopedWorkerOptions({ departmentKey: "security", jobTitlePattern: "security|guard|patrol" });
}

/* ------------------------------------------------------------------ *
 * Incidents
 * ------------------------------------------------------------------ */

export function useSecurityIncidents(status = "all") {
  const { organizationId, branchId } = useSecurityContext();
  return useQuery({
    queryKey: ["security", "incidents", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("security_incidents")
        .select("*")
        .order("occurred_at", { ascending: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      q = applyStockNeedStatus(q, status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as SecurityRow[];
    },
  });
}

export function useReportIncident() {
  const invalidate = useSecurityInvalidate();
  const { branchId } = useSecurityContext();
  return useMutation({
    mutationFn: async (input: {
      category: string;
      description: string;
      location?: string;
      severity?: string;
      occurredAt?: string | null;
      people?: string;
      witnesses?: string;
      action?: string;
      postId?: string | null;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_security_incident_create", {
        _category: input.category,
        _description: input.description,
        _location: input.location ?? null,
        _severity: input.severity ?? "low",
        _occurred_at: input.occurredAt ?? null,
        _people: input.people ?? null,
        _witnesses: input.witnesses ?? null,
        _action: input.action ?? null,
        _post: input.postId ?? null,
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as SecurityRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Incident report filed");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Supervisor only: review, escalate, resolve and close. */
export function useReviewIncident() {
  const invalidate = useSecurityInvalidate();
  return useMutation({
    mutationFn: async (input: {
      incidentId: string;
      status: string;
      action?: string;
      escalationNotes?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_security_incident_review", {
        _incident: input.incidentId,
        _status: input.status,
        _action: input.action ?? null,
        _escalation_notes: input.escalationNotes ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as SecurityRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Incident updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Patrols
 * ------------------------------------------------------------------ */

export function useSecurityPatrols(status = "all") {
  const { organizationId, branchId } = useSecurityContext();
  return useQuery({
    queryKey: ["security", "patrols", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("security_patrols")
        .select("*")
        .order("scheduled_for", { ascending: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      q = applyStockNeedStatus(q, status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as SecurityRow[];
    },
  });
}

export function useCreatePatrol() {
  const invalidate = useSecurityInvalidate();
  const { branchId } = useSecurityContext();
  return useMutation({
    mutationFn: async (input: {
      title: string;
      scheduledFor?: string | null;
      checkpoints: { area: string; due?: string | null }[];
      assigneeId?: string | null;
      notes?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_security_patrol_create", {
        _title: input.title,
        _scheduled: input.scheduledFor ?? null,
        _checkpoints: input.checkpoints,
        _assignee: input.assigneeId ?? null,
        _branch: branchId ?? null,
        _notes: input.notes ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as SecurityRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Patrol scheduled");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAssignPatrol() {
  const invalidate = useSecurityInvalidate();
  return useMutation({
    mutationFn: async (input: { patrolId: string; guardId: string }) => {
      const { data, error } = await guardedRpc(db, "neo_security_patrol_assign", {
        _patrol: input.patrolId,
        _guard: input.guardId,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as SecurityRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Patrol assigned");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRecordCheckpoint() {
  const invalidate = useSecurityInvalidate();
  return useMutation({
    mutationFn: async (input: { patrolId: string; index: number }) => {
      const { data, error } = await guardedRpc(db, "neo_security_patrol_checkpoint", {
        _patrol: input.patrolId,
        _index: input.index,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as SecurityRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Checkpoint recorded");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useCompletePatrol() {
  const invalidate = useSecurityInvalidate();
  return useMutation({
    mutationFn: async (input: { patrolId: string; notes?: string }) => {
      const { data, error } = await guardedRpc(db, "neo_security_patrol_complete", {
        _patrol: input.patrolId,
        _notes: input.notes ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as SecurityRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Patrol completed");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Visitor and contractor access
 * ------------------------------------------------------------------ */

export function useVisitorLogs(onSiteOnly = false) {
  const { organizationId, branchId } = useSecurityContext();
  return useQuery({
    queryKey: ["security", "visitors", organizationId, branchId, onSiteOnly],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("security_visitor_logs")
        .select("*")
        .order("time_in", { ascending: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      if (onSiteOnly) q = q.is("time_out", null);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as SecurityRow[];
    },
  });
}

export function useRecordVisitor() {
  const invalidate = useSecurityInvalidate();
  const { branchId } = useSecurityContext();
  return useMutation({
    mutationFn: async (input: {
      visitorName: string;
      company?: string;
      visitingPerson?: string;
      visitingDepartment?: string;
      purpose?: string;
      vehicle?: string;
      postId?: string | null;
      notes?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_security_visitor_record", {
        _visitor_name: input.visitorName,
        _company: input.company ?? null,
        _visiting_person: input.visitingPerson ?? null,
        _visiting_department: input.visitingDepartment ?? null,
        _purpose: input.purpose ?? null,
        _vehicle: input.vehicle ?? null,
        _post: input.postId ?? null,
        _branch: branchId ?? null,
        _notes: input.notes ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as SecurityRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Visitor recorded");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useCheckOutVisitor() {
  const invalidate = useSecurityInvalidate();
  return useMutation({
    mutationFn: async (recordId: string) => {
      const { data, error } = await guardedRpc(db, "neo_security_visitor_checkout", { _record: recordId });
      if (error) throw new Error(error.message);
      return (data ?? {}) as SecurityRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Visitor signed out");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Shift handovers
 * ------------------------------------------------------------------ */

export function useSecurityHandovers() {
  const { organizationId, branchId } = useSecurityContext();
  return useQuery({
    queryKey: ["security", "handovers", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("security_handovers")
        .select("*, security_posts(name)")
        .order("created_at", { ascending: false })
        .limit(100);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as SecurityRow[];
    },
  });
}

export function useSubmitHandover() {
  const invalidate = useSecurityInvalidate();
  const { branchId } = useSecurityContext();
  return useMutation({
    mutationFn: async (input: {
      postId?: string | null;
      shiftLabel?: string;
      incomingId?: string | null;
      openIncidents?: number;
      vehicles?: number;
      equipment?: string;
      notes?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_security_handover_submit", {
        _post: input.postId ?? null,
        _shift_label: input.shiftLabel ?? "day",
        _incoming: input.incomingId ?? null,
        _open_incidents: input.openIncidents ?? 0,
        _vehicles: input.vehicles ?? 0,
        _equipment: input.equipment ?? null,
        _notes: input.notes ?? null,
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as SecurityRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Handover recorded");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAcknowledgeHandover() {
  const invalidate = useSecurityInvalidate();
  return useMutation({
    mutationFn: async (handoverId: string) => {
      const { data, error } = await guardedRpc(db, "neo_security_handover_acknowledge", {
        _handover: handoverId,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as SecurityRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Handover acknowledged");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Security tasks and a guard's own workspace
 * ------------------------------------------------------------------ */

export function useSecurityTasks(status = "all") {
  const { organizationId, branchId } = useSecurityContext();
  return useQuery({
    queryKey: ["security", "tasks", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("security_tasks")
        .select("*")
        .order("due_at", { ascending: true, nullsFirst: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      q = applyStockNeedStatus(q, status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as SecurityRow[];
    },
  });
}

export function useCreateSecurityTask() {
  const invalidate = useSecurityInvalidate();
  const { branchId } = useSecurityContext();
  return useMutation({
    mutationFn: async (input: {
      title: string;
      assigneeId?: string | null;
      details?: string;
      dueAt?: string | null;
      postId?: string | null;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_security_task_create", {
        _title: input.title,
        _assignee: input.assigneeId ?? null,
        _details: input.details ?? null,
        _due: input.dueAt ?? null,
        _post: input.postId ?? null,
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as SecurityRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Task assigned");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAdvanceSecurityTask() {
  const invalidate = useSecurityInvalidate();
  return useMutation({
    mutationFn: async (input: { taskId: string; status: string }) => {
      const { data, error } = await guardedRpc(db, "neo_security_task_advance", {
        _task: input.taskId,
        _status: input.status,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as SecurityRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Task updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** A guard's own post, patrols and tasks — nothing else. */
export function useMySecurityWork() {
  const { organizationId, branchId, userId } = useSecurityContext();
  return useQuery({
    queryKey: ["security", "my-work", organizationId, branchId, userId],
    enabled: Boolean(organizationId && userId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_security_my_work", { _branch: branchId ?? null });
      if (error) throw new Error(error.message);
      return (data ?? []) as SecurityRow[];
    },
  });
}

/* ------------------------------------------------------------------ *
 * Stock needs and the Supervisor's requisition
 * ------------------------------------------------------------------ */

export function useSecurityStockNeeds(status = "all") {
  const { organizationId, branchId } = useSecurityContext();
  return useQuery({
    queryKey: ["security", "needs", organizationId, branchId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("department_stock_needs")
        .select("*")
        .eq("module", "security")
        .order("created_at", { ascending: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      q = applyStockNeedStatus(q, status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as SecurityRow[];
    },
  });
}

export function useReportSecurityNeed() {
  const invalidate = useSecurityInvalidate();
  const { branchId } = useSecurityContext();
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
        _unit: input.unit ?? "piece",
        _priority: input.priority ?? "normal",
        _notes: input.notes ?? null,
        _module: "security",
        _department: null,
        _branch: branchId ?? null,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Need sent up to the Security Supervisor");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Supervisor only: consolidate the selected needs into one requisition. */
export function useRequisitionSecurityNeeds() {
  const invalidate = useSecurityInvalidate();
  return useMutation({
    mutationFn: async (input: {
      needIds: string[];
      requiredDate?: string | null;
      priority?: string;
      reason?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_security_requisition_from_needs", {
        _needs: input.needIds,
        _required_date: input.requiredDate ?? null,
        _priority: input.priority ?? "normal",
        _reason: input.reason ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as SecurityRow;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Requisition sent to Stores");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
