/**
 * Phase 12 data layer — Housekeeping, Laundry, Maintenance & Internal Requisitions.
 *
 * Every read goes through RLS-scoped Supabase queries; every state change that must
 * stay transactional (room status, laundry folio posting, stock issue, receipt
 * confirmation, preventive generation) goes through a security-definer database
 * function rather than a direct table write.
 */

import { stableIdempotencyKey } from "@/lib/transaction-scope";
import { useScopedRealtime } from "@/lib/realtime-scope";
import { guardedRpc } from "@/lib/rpc-guard";
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { withGuardCapture } from "@/lib/guard-violations";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { isAssetStatusTransitionAllowed, type Row } from "@/lib/operations";
import { useScopedDepartments, useScopedWorkers } from "@/lib/scoped-options";
import { useActivePropertyFilter, useWriteBranchId } from "@/lib/branch-filter";
import { auditWindowFrom } from "@/lib/audit-window";
import { logAudit } from "@/lib/audit";

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = supabase as any;

function useCtx() {
  const { organizationId, profile, user } = useAuth();
  const writeBranchId = useWriteBranchId();
  return {
    organizationId,
    organization_id: organizationId as string,
    branch_id: writeBranchId,
    department_id: (profile as { department_id?: string | null } | null)?.department_id ?? null,
    userId: user?.id ?? null,
  };
}

function rows(data: unknown): Row[] {
  return (data ?? []) as Row[];
}

/* ------------------------------- metrics -------------------------------- */

export function useOpsMetrics(branch?: string | null) {
  const { branchId, filterKey } = useActivePropertyFilter();
  const { organizationId } = useCtx();
  const scopedBranch = branch !== undefined ? branch : branchId;
  return useQuery({
    queryKey: ["ops", "metrics", organizationId, scopedBranch ?? null, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "ops_metrics", { _branch: scopedBranch ?? null });
      if (error) throw error;
      return (data ?? {}) as Record<string, number>;
    },
  });
}

/* ------------------------------ room board ------------------------------ */

/**
 * The single authoritative room operational-state read model.
 *
 * Front Office, Room Rack, Housekeeping dashboard, Room Board, cleaning-task
 * forms, inspections, maintenance and laundry all consume this one service so
 * every screen sees exactly the same room UUIDs, conditions and sellability
 * reasons. No page recomputes room status locally.
 */
export function useRoomState(branch?: string | null) {
  const { branchId, filterKey } = useActivePropertyFilter();
  const { organizationId } = useCtx();
  const scopedBranch = branch !== undefined ? branch : branchId;
  return useQuery({
    queryKey: ["ops", "room-state", organizationId, scopedBranch ?? null, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "ops_room_state", { _branch: scopedBranch ?? null });
      if (error) throw error;
      // Legacy field aliases so existing consumers keep working unchanged.
      return ((data ?? []) as Row[]).map((r) => ({
        ...r,
        id: r["room_id"],
        branch_id: r["property_id"],
        room_types: { name: r["room_type_name"] },
      })) as Row[];
    },
  });
}

/** Back-compatible alias — same authoritative service. */
export const useRoomBoard = useRoomState;

/**
 * Availability for a requested interval, derived from the same room state plus
 * reservations, assignments, blocks, holds and out-of-order periods.
 */
export function useRoomAvailabilityWindow(branch: string | null, from: string, to: string, enabled = true) {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "room-availability", organizationId, branch, from, to],
    enabled: Boolean(organizationId) && enabled,
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "ops_room_availability", { _branch: branch, _from: from, _to: to });
      if (error) throw error;
      return rows(data);
    },
  });
}

/**
 * Safe reconciliation report: rooms whose stored state disagrees with the
 * cleaning-task, inspection or maintenance evidence. Read-only — it never
 * mutates a room, a task or a document number.
 */
export function useRoomStateReconciliation(branch?: string | null) {
  const { branchId, filterKey } = useActivePropertyFilter();
  const { organizationId } = useCtx();
  const scopedBranch = branch !== undefined ? branch : branchId;
  return useQuery({
    queryKey: ["ops", "room-reconciliation", organizationId, scopedBranch ?? null, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "ops_room_state_reconciliation", { _branch: scopedBranch ?? null });
      if (error) throw error;
      return rows(data);
    },
  });
}


export function useTodayMovements() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useCtx();
  const today = new Date().toISOString().slice(0, 10);
  return useQuery({
    queryKey: ["ops", "movements", organizationId, today, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(db.from("reservations").select("id, confirmation_number, room_id, arrival_date, departure_date, status, eta, is_vip, adults, children"), "reservations")
        .or(`arrival_date.eq.${today},departure_date.eq.${today}`);
      if (error) throw error;
      return rows(data);
    },
  });
}


/* ---------------------------- housekeeping ------------------------------ */

export function useHousekeepingJobs(filters?: { status?: string; assignee?: string }) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "hk-jobs", organizationId, filterKey, filters?.status ?? null, filters?.assignee ?? null],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(
        db
          .from("housekeeping_jobs")
          .select(
            "id, job_number, job_type, status, priority, branch_id, department_id, station_id, room_id, location_label, assignee_id, due_at, started_at, completed_at, inspection_required, inspection_status, rework_count, dnd, notes, created_at, template_name, template_version, checklist_snapshot, rooms(room_number, floor), tasks(id, title)",
          ),
        "housekeeping_jobs",
      )
        .order("created_at", { ascending: false })
        .limit(300);
      if (filters?.status) q = q.eq("status", filters.status);
      if (filters?.assignee) q = q.eq("assignee_id", filters.assignee);
      const { data, error } = await q;
      if (error) throw error;
      return rows(data);
    },
  });
}

/**
 * Superseded cleaning history.
 *
 * When a second cleaning request is raised for a room that already has active
 * work, the older job is superseded rather than deleted. This read surfaces
 * that trail — which job replaced it, when, and the recorded reason — so a
 * supervisor can see exactly why a task disappeared from the live board.
 */
export function useSupersededHousekeepingJobs(filters?: { roomId?: string }) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "hk-superseded", organizationId, filterKey, filters?.roomId ?? null],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(
        db
          .from("housekeeping_jobs")
          .select(
            "id, job_number, job_type, status, priority, room_id, location_label, assignee_id, due_at, created_at, notes, superseded_by, superseded_at, supersede_reason, rooms(room_number, floor)",
          ),
        "housekeeping_jobs",
      )
        .not("superseded_by", "is", null)
        .order("superseded_at", { ascending: false })
        .limit(300);
      if (filters?.roomId) q = q.eq("room_id", filters.roomId);
      const { data, error } = await q;
      if (error) throw error;
      return rows(data);
    },
  });
}

/**
 * Completed cleaning history.
 *
 * The finished work itself — who cleaned which room, when they started and
 * finished, whether inspection passed and how often the job came back as
 * rework. Read-only: nothing here writes to the operational board.
 */
export function useCompletedHousekeepingJobs(range?: { from?: string; to?: string }) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useCtx();
  const from = range?.from ?? "";
  const to = range?.to ?? "";
  return useQuery({
    queryKey: ["ops", "hk-completed", organizationId, filterKey, from, to],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(
        db
          .from("housekeeping_jobs")
          .select(
            "id, job_number, job_type, status, priority, branch_id, room_id, location_label, assignee_id, assigned_team, due_at, started_at, completed_at, estimated_minutes, inspection_required, inspection_status, rework_count, notes, created_at, rooms(room_number, floor)",
          ),
        "housekeeping_jobs",
      )
        .not("completed_at", "is", null)
        .order("completed_at", { ascending: false })
        .limit(500);
      if (from) q = q.gte("completed_at", new Date(`${from}T00:00:00`).toISOString());
      if (to) q = q.lte("completed_at", new Date(`${to}T23:59:59`).toISOString());
      const { data, error } = await q;
      if (error) throw error;
      return rows(data);
    },
  });
}


/**
 * Immutable supersession evidence for a single cleaning job.
 *
 * The supersession trigger writes an audit entry against the superseded job,
 * so this read returns the actor, the timestamp and the recorded reason
 * exactly as they were written — nothing here can edit that trail.
 */
export function useHousekeepingSupersedeAudit(jobId: string | null) {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "hk-supersede-audit", organizationId, jobId],
    enabled: Boolean(organizationId && jobId),
    queryFn: async () => {
      const { data, error } = await db
        .from("audit_logs")
        .select("id, action, module, record_id, user_id, user_name, reason, previous_value, new_value, created_at")
        .eq("module", "housekeeping")
        .eq("action", "housekeeping.job.superseded")
        .eq("record_id", String(jobId))
        .gte("created_at", auditWindowFrom(90))
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return rows(data);
    },
  });
}


export function useChecklistTemplates() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "hk-templates", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(db.from("housekeeping_checklist_templates").select("id, name, description, cleaning_type, area_scope, requires_inspection, active, branch_id, room_type_id, version, updated_at"), "housekeeping_checklist_templates")
        .order("name");
      if (error) throw error;
      return rows(data);
    },
  });
}

export function useChecklistItems(templateId?: string | null) {
  return useQuery({
    queryKey: ["ops", "hk-template-items", templateId ?? null],
    enabled: Boolean(templateId),
    queryFn: async () => {
      const { data, error } = await db
        .from("housekeeping_checklist_items")
        .select(
          "id, template_id, label, instructions, applies_to, response_type, requires_photo, requires_comment, allows_defect, mandatory, sort_order",
        )
        .eq("template_id", templateId)
        .order("sort_order");
      if (error) throw error;
      return rows(data);
    },
  });
}

/**
 * The hotel's own cleaning standards. Templates and their ordered steps are
 * configuration, owned by the hotel — NEØ owns only the workflow that applies
 * them. Saving a step bumps the template version, so a job raised afterwards
 * takes the new copy while jobs already raised keep theirs.
 */
export function useSaveChecklistTemplate() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (input: Row & { id?: string | null }) => {
      const { id, ...values } = input;
      const payload = { ...values, organization_id: ctx.organization_id };
      const query = id
        ? db.from("housekeeping_checklist_templates").update(values).eq("id", id)
        : db.from("housekeeping_checklist_templates").insert(payload);
      const { data, error } = await query.select("id").maybeSingle();
      if (error) throw error;
      await logAudit({
        action: id ? "housekeeping.checklist-template.updated" : "housekeeping.checklist-template.created",
        module: "housekeeping",
        recordId: String(id ?? (data as Row | null)?.["id"] ?? ""),
        newValue: values,
      });
      return data as Row | null;
    },
    onSuccess: () => {
      toast.success("Cleaning standard saved");
      void qc.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useSaveChecklistItem() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (input: Row & { id?: string | null }) => {
      const { id, ...values } = input;
      const payload = { ...values, organization_id: ctx.organization_id };
      const query = id
        ? db.from("housekeeping_checklist_items").update(values).eq("id", id)
        : db.from("housekeeping_checklist_items").insert(payload);
      const { error } = await query;
      if (error) throw error;
      return true;
    },
    onSuccess: () => {
      toast.success("Step saved");
      void qc.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useDeleteChecklistItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db.from("housekeeping_checklist_items").delete().eq("id", id);
      if (error) throw error;
      return true;
    },
    onSuccess: () => {
      toast.success("Step removed");
      void qc.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRoomInspections() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "inspections", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(db.from("room_inspections").select("id, inspection_type, result, notes, rework_required, inspected_at, released_at, room_id, rooms(room_number)"), "room_inspections")
        .order("inspected_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return rows(data);
    },
  });
}

/**
 * The checklist lines an attendant recorded for one cleaning job. The
 * supervisor sees exactly what was done and what was declared not applicable,
 * with the reason given, before signing the room back to sale.
 */
export function useJobChecklistResults(jobId: string | null) {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "job-results", organizationId, jobId],
    enabled: Boolean(organizationId && jobId),
    queryFn: async () => {
      const { data, error } = await db
        .from("housekeeping_job_results")
        .select("id, label, result, comment, defect_reported, created_at")
        .eq("job_id", jobId as string)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return rows(data);
    },
  });
}

export function useDeepCleanSchedules() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "deep-clean", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(db.from("deep_cleaning_schedules").select("id, schedule_type, frequency, after_stays, last_done_on, next_due_on, active, notes, room_id, rooms(room_number)"), "deep_cleaning_schedules")
        .order("next_due_on", { nullsFirst: false });
      if (error) throw error;
      return rows(data);
    },
  });
}

export function useCreateJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      room: string;
      jobType: string;
      reservation?: string | null;
      priority?: string;
      dueAt?: string | null;
      notes?: string | null;
      idempotencyKey?: string | null;
      assignee?: string | null;
      assignedTeam?: string | null;
      source?: string;
      sourceRecord?: string | null;
      correlationId?: string | null;
    }) => {
      const { data, error } = await guardedRpc(db, "hk_raise_cleaning_task", {
        _room: input.room,
        _job_type: input.jobType,
        _reason: input.notes ?? "Manual cleaning request",
        _reservation: input.reservation ?? null,
        _priority: input.priority ?? "normal",
        _due_at: input.dueAt ?? null,
        _assignee: input.assignee ?? null,
        _assigned_team: input.assignedTeam ?? null,
        _source: input.source ?? "manual",
        _source_record: input.sourceRecord ?? null,
        _idempotency_key: input.idempotencyKey ?? null,
        _correlation: input.correlationId ?? crypto.randomUUID(),
      });
      if (error) throw error;
      const result = data as Row;
      if (!result?.["ok"] || !result["job_id"] || !result["task_id"] || !result["workflow_event_id"] || !result["audit_event_id"]) {
        throw new Error("The backend did not confirm the complete housekeeping workflow. Nothing is reported as complete.");
      }
      return result;
    },
    onSuccess: () => {
      toast.success("Cleaning task created");
      void qc.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Assignment goes through the authoritative routine so the attendant is
 * validated, the linked task follows, and the notification plus audit record
 * are written. A direct table update would silently skip all of that.
 */
export function useAssignJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, assignee, reason }: { id: string; assignee: string; reason?: string }) => {
      const { data, error } = await guardedRpc(db, "hk_assign_job", {
        _job: id,
        _assignee: assignee,
        _reason: reason ?? null,
        _correlation: crypto.randomUUID(),
      });
      if (error) throw error;
      const result = data as Row;
      if (!result?.["ok"]) {
        throw new Error("The backend did not confirm the assignment. Nothing has been assigned.");
      }
      if (result["confirmed_assignee_id"] && result["confirmed_assignee_id"] !== assignee) {
        throw new Error("The backend did not confirm the selected attendant on the cleaning job.");
      }
      if (result["confirmed_task_assignee_id"] && result["confirmed_task_assignee_id"] !== assignee) {
        throw new Error("The backend did not confirm the selected attendant on the linked task.");
      }
      return result;
    },
    onSuccess: (result) => {
      toast.success(result?.["idempotent"] ? "Already assigned to this attendant" : "Task assigned");
      void qc.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}


export function useStartJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (job: Row) => {
      const { data, error } = await guardedRpc(db, "hk_start_job", {
        _job: String(job["id"]),
        _correlation: crypto.randomUUID(),
      });
      if (error) throw error;
      const result = data as Row;
      if (!result?.["ok"] || !result["workflow_event_id"] || !result["audit_event_id"]) {
        throw new Error("The backend did not confirm that cleaning started.");
      }
      return result;
    },
    onSuccess: () => {
      toast.success("Cleaning started");
      void qc.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useCompleteJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, notes, results }: { id: string; notes?: string; results?: Row[] }) => {
      if (results?.length) {
        const { error: rErr } = await db
          .from("housekeeping_job_results")
          .upsert(results, { onConflict: "job_id,label" });
        if (rErr) throw rErr;
      }
      const { data, error } = await guardedRpc(db, "hk_complete_job", {
        _job: id,
        _notes: notes ?? null,
        _correlation: crypto.randomUUID(),
      });
      if (error) throw error;
      const result = data as Row;
      if (!result?.["ok"] || !result["workflow_event_id"] || !result["audit_event_id"]) {
        throw new Error("The backend did not confirm cleaning completion.");
      }
      return result;
    },
    onSuccess: (data) => {
      toast.success(data?.["inspection_required"] ? "Sent for supervisor inspection" : "Cleaning completed");
      void qc.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRecordInspection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { job: string; result: string; notes?: string; type?: string; defects?: Row[] }) => {
      const { data, error } = await guardedRpc(db, "hk_record_inspection", {
        _job: input.job,
        _result: input.result,
        _notes: input.notes ?? null,
        _defects: input.defects ?? [],
        _inspection_type: input.type ?? "standard",
        _correlation: crypto.randomUUID(),
      });
      if (error) throw error;
      const result = data as Row;
      if (!result?.["ok"] || !result["inspection_id"] || !result["workflow_event_id"] || !result["audit_event_id"]) {
        throw new Error("The backend did not confirm the inspection outcome.");
      }
      return result;
    },
    onSuccess: (data) => {
      toast.success(`Inspection recorded — ${String(data?.["result"] ?? "")}`);
      void qc.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------ lost & found ---------------------------- */

export function useLostFound() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "lost-found", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db
        .from("lost_found_items")
        .select(
          "id, reference, description, category, sensitive, status, found_at, location_found, storage_location, claimant_name, notes, room_id, rooms(room_number)",
        )
        .order("found_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return rows(data);
    },
  });
}

/**
 * Canonical Lost & Found audit trail. `lost_found_custody_history` is written
 * by the `lf_track_custody` trigger on every registration, status change and
 * custody hand-over — this is a read of that record, never a second log.
 */
export function useLostFoundHistory(itemId: string | null) {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "lost-found", "history", organizationId, itemId],
    enabled: Boolean(organizationId && itemId),
    queryFn: async () => {
      const { data, error } = await db
        .from("lost_found_custody_history")
        .select(
          "id, item_id, action, previous_status, new_status, previous_custodian, new_custodian, reason, performed_by, created_at",
        )
        .eq("item_id", itemId as string)
        .order("created_at", { ascending: true })
        .limit(200);
      if (error) throw error;
      return rows(data);
    },
  });
}



export function useSaveLostFound() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (input: Row) => {
      if (input["id"]) {
        const { id, ...patch } = input;
        const { error } = await db.from("lost_found_items").update(patch).eq("id", id);
        if (error) throw error;
        return;
      }
      const { error } = await db.from("lost_found_items").insert({
        ...input,
        organization_id: ctx.organization_id,
        branch_id: ctx.branch_id,
        found_by: ctx.userId,
        created_by: ctx.userId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Lost & Found record saved");
      void qc.invalidateQueries({ queryKey: ["ops", "lost-found"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* --------------------------------- laundry ------------------------------ */

export function useLaundryPrices() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "laundry-prices", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(db.from("laundry_price_items").select("id, name, service_type, normal_price, express_price, turnaround_hours, tax_rate, active"), "laundry_price_items")
        .order("name");
      if (error) throw error;
      return rows(data);
    },
  });
}

export function useGuestLaundryOrders() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "laundry-orders", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db
        .from("guest_laundry_orders")
        .select(
          "id, organization_id, branch_id, laundry_number, status, service_type, express, requested_at, collected_at, required_delivery_at, delivered_at, subtotal, tax_amount, total, posting_status, discrepancy_notes, room_id, reservation_id, rooms(room_number), guest_laundry_items(id, description, quantity, counted_quantity, unit_price, line_total, service_type)",
        )
        .order("requested_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return rows(data);
    },
  });
}

export function useCreateLaundryOrder() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (input: { order: Row; items: Row[] }) => {
      const subtotal = input.items.reduce((s, i) => s + Number(i["quantity"] ?? 0) * Number(i["unit_price"] ?? 0), 0);
      const tax = input.items.reduce(
        (s, i) => s + Number(i["quantity"] ?? 0) * Number(i["unit_price"] ?? 0) * (Number(i["tax_rate"] ?? 0) / 100),
        0,
      );
      const { data, error } = await db
        .from("guest_laundry_orders")
        .insert({
          ...input.order,
          organization_id: ctx.organization_id,
          branch_id: ctx.branch_id,
          created_by: ctx.userId,
          subtotal,
          tax_amount: tax,
          total: subtotal + tax + Number(input.order["express_charge"] ?? 0),
        })
        .select("id")
        .single();
      if (error) throw error;
      const orderId = (data as Row)["id"];
      if (input.items.length) {
        const { error: iErr } = await db.from("guest_laundry_items").insert(
          input.items.map((i) => ({
            ...i,
            organization_id: ctx.organization_id,
            order_id: orderId,
            line_total: Number(i["quantity"] ?? 0) * Number(i["unit_price"] ?? 0),
          })),
        );
        if (iErr) throw iErr;
      }
      return orderId as string;
    },
    onSuccess: () => {
      toast.success("Guest laundry order created");
      void qc.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAdvanceLaundryOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status, note }: { id: string; status: string; note?: string | null }) => {
      const { data, error } = await guardedRpc(db, "neo_laundry_order_advance", {
        _order: id,
        _status: status,
        _note: note ?? null,
      });
      if (error) throw error;
      const result = (data ?? {}) as Row;
      if (result["ok"] === false) {
        throw new Error(String(result["detail"] ?? result["reason"] ?? "Laundry could not advance"));
      }
      return result;
    },
    onSuccess: (data) => {
      const posting = String(data["posting_status"] ?? "");
      toast.success(
        posting === "blocked"
          ? "Laundry updated — Finance posting still needs attention"
          : "Laundry status updated",
      );
      void qc.invalidateQueries({ queryKey: ["ops"] });
      void qc.invalidateQueries({ queryKey: ["laundry-department"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUpdateLaundryOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Row }) => {
      await withGuardCapture(
        {
          guard: "neo_laundry_completion_guard",
          table: "guest_laundry_orders",
          payload: patch as Record<string, unknown>,
          recordId: id,
          recordLabel: String(patch["laundry_number"] ?? id),
        },
        async () => {
          const { error } = await db.from("guest_laundry_orders").update(patch).eq("id", id);
          if (error) throw error;
        },
      );
    },
    onSuccess: () => {
      toast.success("Laundry order updated");
      void qc.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function usePostLaundryCharge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (orderId: string) => {
      // Routed through the retry RPC so a posting that cannot reach a folio
      // leaves the order marked 'blocked' rather than silently 'unposted'.
      const { data, error } = await guardedRpc(db, "neo_laundry_retry_posting", { _order: orderId });
      if (error) throw error;
      const result = data as Row;
      if (result && result["ok"] === false) {
        throw new Error(
          String(result["detail"] ?? result["reason"] ?? "The laundry charge could not be posted."),
        );
      }
      return result;
    },

    onSuccess: (data) => {
      // The message states where the charge actually landed: a guest folio, or
      // the books only when no folio was open for this order.
      const onFolio = data?.["folio_charged"] === true;
      toast.success(
        onFolio
          ? "Charge posted to the guest folio"
          : "Charge recorded in the books — no open guest folio was attached to this order",
      );
      void qc.invalidateQueries({ queryKey: ["ops"] });
    },

    onError: (e: Error) => toast.error(e.message),
  });
}

export function useLinenItems() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "linen-items", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(db.from("linen_items").select("id, name, category, unit, par_level, replacement_cost, active"), "linen_items")
        .order("name");
      if (error) throw error;
      return rows(data);
    },
  });
}

export function useLinenMovements() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "linen-movements", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db
        .from("linen_movements")
        .select(
          "id, from_state, to_state, quantity, received_quantity, discrepancy, reason, confirmed_at, created_at, linen_items(name), from_department_id, to_department_id",
        )
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return rows(data);
    },
  });
}

export function useLinenIncidents() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "linen-incidents", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(db.from("linen_incidents").select("id, quantity, reason, condition, cost, status, replacement_recommended, final_action, created_at, linen_items(name)"), "linen_incidents")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return rows(data);
    },
  });
}

export function useLaundryBatches() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "laundry-batches", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db
        .from("laundry_batches")
        .select(
          "id, batch_number, batch_kind, cycle_type, machine, weight_kg, status, quality_result, rewash_reason, received_at, started_at, completed_at, laundry_batch_items(id, description, quantity, returned_quantity, damaged_quantity, missing_quantity)",
        )
        .order("received_at", { ascending: false })
        .limit(150);
      if (error) throw error;
      return rows(data);
    },
  });
}

/* ------------------------------ maintenance ----------------------------- */

export function useWorkOrders() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "work-orders", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db
        .from("maintenance_work_orders")
        .select(
          // `branch_id` is projected because the maintenance screens scope rows
          // by the active property. Omitting it made every saved work order
          // disappear the moment a property was selected.
          "id, organization_id, branch_id, work_order_number, description, fault_category, category_id, priority, status, guest_impact, reported_at, assigned_to, estimated_completion, completed_at, verified_at, cost_estimate, actual_cost, blocks_room, block_status, room_id, asset_id, location_label, diagnosis, completion_notes, rooms(room_number), assets(name)",
        )

        .order("reported_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return rows(data);
    },
  });
}

/**
 * A work order that says "Room 111" while pointing at Room 112 sends the
 * technician, the room block and the housekeeping handoff to different places.
 * The selected room is the truth; wording that names a different room is
 * refused rather than quietly saved.
 */
async function assertRoomWordingMatches(input: Row): Promise<void> {
  const roomId = input["room_id"];
  const text = `${String(input["description"] ?? "")} ${String(input["location_label"] ?? "")}`;
  const mentioned = [...text.matchAll(/\broom\s*#?\s*([0-9]{1,5}[A-Za-z]?)\b/gi)].map((m) =>
    String(m[1]).toUpperCase(),
  );
  if (mentioned.length === 0) return;
  if (!roomId) {
    throw new Error(
      `This describes room ${mentioned[0]} but no room is selected. Pick the room so the block, the job and housekeeping agree.`,
    );
  }
  const { data } = await db
    .from("rooms")
    .select("room_number")
    .eq("id", roomId as string)
    .maybeSingle();
  const selected = String((data as Row | null)?.["room_number"] ?? "").toUpperCase();
  if (!selected) return;
  const conflict = mentioned.find((m) => m !== selected);
  if (conflict) {
    throw new Error(
      `The wording mentions room ${conflict} but room ${selected} is selected. Correct one of them before saving.`,
    );
  }
}

export function useSaveWorkOrder() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (input: Row) => {
      await assertRoomWordingMatches(input);
      if (input["id"]) {
        const { id, ...patch } = input;
        const nextStatus = patch["status"] ? String(patch["status"]) : null;
        // Verification and closure are accountable acts: they carry a named
        // checker and a time, and the officer who did the work is never that
        // person. Without this a job could be closed silently by its own doer.
        if (nextStatus === "awaiting-verification" || nextStatus === "closed") {
          const { data: current, error: readError } = await db
            .from("maintenance_work_orders")
            .select("assigned_to, status, verified_by, verified_at")
            .eq("id", id)
            .maybeSingle();
          if (readError) throw readError;
          if (!current) throw new Error("That work order could not be found.");
          if (current["assigned_to"] && ctx.userId && current["assigned_to"] === ctx.userId) {
            throw new Error(
              "The officer who carried out the work cannot verify or close it. A supervisor must check it first.",
            );
          }
          if (nextStatus === "closed" && String(current["status"]) === "in-progress") {
            throw new Error(
              "This job is still in progress. It must be completed and checked before it can be closed.",
            );
          }
          const now = new Date().toISOString();
          if (!current["verified_by"]) {
            patch["verified_by"] = ctx.userId;
            patch["verified_at"] = now;
          }
          if (nextStatus === "closed") patch["closed_at"] = now;
        }
        // Read the row back so "saved" means the canonical record actually changed.
        const { data, error } = await db
          .from("maintenance_work_orders")
          .update(patch)
          .eq("id", id)
          .select("id, work_order_number")
          .maybeSingle();
        if (error) throw error;
        if (!data) throw new Error("The work order could not be updated — nothing was saved.");
        return data as Row;
      }
      if (!ctx.branch_id) throw new Error("Select a property before creating a work order.");
      const { data, error } = await guardedRpc(db, "neo_maintenance_work_order_create", {
        _payload: {
          ...input,
          branch_id: ctx.branch_id,
          requesting_department_id: ctx.department_id,
          source_module: "maintenance",
        },
        // Derived from the command itself, not from a fresh UUID: a
        // double-click, an impatient retry or a reconnect after a lost
        // response all describe the same work order and converge on one.
        _idempotency_key: stableIdempotencyKey("maintenance", "work_order.create", [
          ctx.organization_id,
          ctx.branch_id,
          input["room_id"] ?? input["asset_id"] ?? input["location_label"],
          input["fault_category"],
          input["description"],
        ]),
      });
      if (error) throw error;
      const result = (data ?? {}) as Row;
      if (result["ok"] !== true || !result["work_order_id"]) {
        throw new Error("The work order was not saved — no persisted record was returned.");
      }
      return {
        id: result["work_order_id"],
        work_order_number: result["work_order_number"],
      } as Row;
    },
    onSuccess: (data) => {
      const ref = data?.["work_order_number"];
      toast.success(ref ? `Work order ${String(ref)} saved` : "Work order saved");
      void qc.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useSetRoomBlock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { workOrder: string; block: boolean; severity?: string; reason?: string }) => {
      const { data, error } = await guardedRpc(db, "wo_set_block", {
        _work_order: input.workOrder,
        _block: input.block,
        _severity: input.severity ?? "out-of-order",
        _reason: input.reason ?? null,
      });
      if (error) throw error;
      return data as Row;
    },
    onSuccess: (data) => {
      toast.success(data?.["blocked"] ? "Room blocked from sale" : "Room released to housekeeping");
      void qc.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function usePmPlans() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "pm-plans", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db
        .from("preventive_maintenance_plans")
        .select(
          // `branch_id` keeps the plan visible to the property scope filter.
          "id, organization_id, branch_id, name, maintenance_type, frequency, interval_days, last_service_date, next_due_date, lead_time_days, assigned_team, assigned_to, estimated_cost, expected_downtime_minutes, vendor, status, asset_id, location_label, assets(name)",
        )

        .order("next_due_date", { nullsFirst: false });
      if (error) throw error;
      return rows(data);
    },
  });
}

export function useSavePmPlan() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (input: Row) => {
      if (input["id"]) {
        const { id, ...patch } = input;
        const { error } = await db.from("preventive_maintenance_plans").update(patch).eq("id", id);
        if (error) throw error;
        return;
      }
      const { error } = await db.from("preventive_maintenance_plans").insert({
        ...input,
        organization_id: ctx.organization_id,
        branch_id: ctx.branch_id,
        created_by: ctx.userId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Preventive plan saved");
      void qc.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useGeneratePreventive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (horizon: number) => {
      const { data, error } = await guardedRpc(db, "pm_generate_due", { _horizon_days: horizon });
      if (error) throw error;
      return Number(data ?? 0);
    },
    onSuccess: (count) => {
      toast.success(count ? `${count} preventive work order(s) generated` : "Nothing due — no duplicates created");
      void qc.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAssets() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "assets", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db
        .from("assets")
        .select(
          "id, asset_tag, name, description, serial_number, model, manufacturer, purchase_date, purchase_cost, quantity, supplier_id, purchase_reference, warranty_start, warranty_expiry, location_label, room_id, custodian_id, condition, status, criticality, last_service_date, next_service_date, department_id, category_id, branch_id, created_at, attachments, asset_categories(name)",
        )
        .order("name")
        // A single imported legacy register already carries several hundred
        // lines; a 500-row ceiling silently truncated the register, so every
        // count, filter and total below it would have been wrong.
        .limit(5000);
      if (error) throw error;
      return rows(data);
    },
  });
}

/**
 * How many register lines each category currently classifies.
 *
 * Configuration needs this to answer the only two questions that matter before
 * renaming or retiring a category: is anything using it, and how much.
 */
export function useAssetCategoryUsage() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "asset-category-usage", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db.from("assets").select("category_id").limit(10000);
      if (error) throw error;
      const counts: Record<string, number> = {};
      for (const row of rows(data)) {
        const key = (row["category_id"] as string) ?? "__none__";
        counts[key] = (counts[key] ?? 0) + 1;
      }
      return counts;
    },
  });
}

/** Maintenance work orders raised against one asset, most recent first. */
export function useAssetWorkOrders(assetId?: string | null) {
  return useQuery({
    queryKey: ["ops", "asset-work-orders", assetId ?? null],
    enabled: Boolean(assetId),
    queryFn: async () => {
      const { data, error } = await db
        .from("maintenance_work_orders")
        .select(
          "id, work_order_number, description, fault_category, priority, status, reported_at, completed_at, actual_cost",
        )
        .eq("asset_id", assetId)
        .order("reported_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return rows(data);
    },
  });
}

/**
 * Proposes the next asset tag in an existing series rather than inventing a
 * scheme. The prefix comes from the tags already in the register, the number
 * from the highest one issued, and the result is re-checked against the
 * database before it is offered, so two people registering at once cannot be
 * handed the same tag.
 */
export async function proposeAssetTag(prefix: string): Promise<string> {
  const clean = prefix.trim().replace(/[-\s]+$/, "");
  if (!clean) throw new Error("A tag prefix is needed before a number can be issued.");
  const { data, error } = await db
    .from("assets")
    .select("asset_tag")
    .ilike("asset_tag", `${clean}-%`)
    .limit(5000);
  if (error) throw error;
  let highest = 0;
  let width = 3;
  for (const row of rows(data)) {
    const tail = String(row["asset_tag"] ?? "").slice(clean.length + 1);
    if (!/^\d+$/.test(tail)) continue;
    width = Math.max(width, tail.length);
    highest = Math.max(highest, Number(tail));
  }
  for (let attempt = 1; attempt <= 25; attempt += 1) {
    const candidate = `${clean}-${String(highest + attempt).padStart(width, "0")}`;
    const { data: clash, error: clashError } = await db
      .from("assets")
      .select("id")
      .eq("asset_tag", candidate)
      .limit(1);
    if (clashError) throw clashError;
    if (!rows(clash).length) return candidate;
  }
  throw new Error("Could not find a free tag in this series — check the register.");
}

/** Tag prefixes already in use, so the generator follows the hotel's own scheme. */
export function useAssetTagPrefixes(assets: Row[]): string[] {
  const seen = new Map<string, number>();
  for (const row of assets) {
    const tag = String(row["asset_tag"] ?? "");
    const match = tag.match(/^(.+)-\d+$/);
    if (!match?.[1]) continue;
    seen.set(match[1], (seen.get(match[1]) ?? 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([prefix]) => prefix);
}

export function useAssetCustodianNames() {
  const { organizationId } = useCtx();

  return useQuery({
    queryKey: ["ops", "asset-custodian-names", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_asset_custodian_names");

      if (error) throw error;

      return rows(data);
    },
  });
}

export function useSaveAsset() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (input: Row) => {
      if (input["id"]) {
        const { id, ...patch } = input;
        const { data: before } = await db.from("assets").select("*").eq("id", id).maybeSingle();
        const { error } = await db.from("assets").update(patch).eq("id", id);
        if (error) throw error;
        await logAudit({
          action: "asset.updated",
          module: "maintenance",
          recordId: String(id),
          previousValue: before ?? null,
          newValue: patch,
          branchId: (before as Row | null)?.["branch_id"] as string | null,
        });
        return;
      }
      const { data: created, error } = await db
        .from("assets")
        .insert({
          ...input,
          organization_id: ctx.organization_id,
          branch_id: ctx.branch_id,
          created_by: ctx.userId,
        })
        .select("id")
        .maybeSingle();
      if (error) throw error;
      await logAudit({
        action: "asset.registered",
        module: "maintenance",
        recordId: created ? String((created as Row)["id"]) : null,
        newValue: input,
        branchId: ctx.branch_id,
      });
    },
    onSuccess: () => {
      toast.success("Asset saved");
      void qc.invalidateQueries({ queryKey: ["ops", "assets"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAssetServiceHistory(assetId?: string | null) {
  return useQuery({
    queryKey: ["ops", "asset-history", assetId ?? null],
    enabled: Boolean(assetId),
    queryFn: async () => {
      const { data, error } = await db
        .from("asset_service_history")
        .select("id, service_date, service_type, description, cost, condition_after, next_service_date")
        .eq("asset_id", assetId)
        .order("service_date", { ascending: false });
      if (error) throw error;
      return rows(data);
    },
  });
}

export function useMoveAsset() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      asset: Row;
      newLocation: string;
      newCustodian?: string | null;
      newDepartmentId?: string | null;
      movementType?: string;
      reason: string;
    }) => {
      const targetDepartment =
        input.newDepartmentId ?? (input.asset["department_id"] as string | null) ?? null;

      const { data, error } = await guardedRpc(db, "neo_asset_move", {
        _asset: input.asset["id"],
        _new_location: input.newLocation,
        _new_department_id: targetDepartment,
        _new_custodian: input.newCustodian ?? null,
        _movement_type: input.movementType ?? "transfer",
        _reason: input.reason,
      });

      if (error) throw error;

      const result = (data ?? {}) as Row;

      if (result["ok"] !== true || !result["movement_id"]) {
        throw new Error("The asset movement was not persisted.");
      }

      const patch: Row = {
        location_label: input.newLocation,
        department_id: targetDepartment,
        custodian_id: input.newCustodian ?? null,
      };

      await logAudit({
        action: "asset.moved",
        module: "maintenance",
        recordId: String(input.asset["id"]),
        previousValue: {
          location_label: input.asset["location_label"] ?? null,
          department_id: input.asset["department_id"] ?? null,
          custodian_id: input.asset["custodian_id"] ?? null,
        },
        newValue: patch,
        reason: input.reason,
        branchId: (input.asset["branch_id"] as string) ?? null,
      });

      return result;
    },
    onSuccess: () => {
      toast.success("Asset movement recorded");
      void qc.invalidateQueries({ queryKey: ["ops", "assets"] });
      void qc.invalidateQueries({ queryKey: ["ops", "asset-movements"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAssetCategories() {
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "asset-categories", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db
        .from("asset_categories")
        .select("id, name, code, active")
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return rows(data);
    },
  });
}

/** Movement/transfer trail for one asset, most recent first. */
export function useAssetMovements(assetId?: string | null) {
  return useQuery({
    queryKey: ["ops", "asset-movements", assetId ?? null],
    enabled: Boolean(assetId),
    queryFn: async () => {
      const { data, error } = await db
        .from("asset_movements")
        .select(
          "id, movement_type, previous_location, new_location, previous_department_id, new_department_id, reason, performed_by, created_at",
        )
        .eq("asset_id", assetId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return rows(data);
    },
  });
}

/**
 * Records a status change (maintenance, out-of-service, lost, disposed …)
 * with a mandatory reason, logged as an asset movement for the audit trail.
 * NOTE: this never posts a Finance journal or computes depreciation/write-off
 * value — asset accounting is a future Finance module extension.
 */
export function useSetAssetStatus() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (input: { asset: Row; status: string; reason: string }) => {
      const previous = String(input.asset["status"] ?? "");
      // The same rule the dialog uses, re-checked here: a register that can be
      // walked backwards out of disposal is not a register.
      if (!isAssetStatusTransitionAllowed(previous, input.status)) {
        throw new Error(`An asset that is ${previous.replace(/-/g, " ")} cannot be moved back to ${input.status.replace(/-/g, " ")}.`);
      }
      const { error } = await db
        .from("assets")
        .update({ status: input.status })
        .eq("id", input.asset["id"]);
      if (error) throw error;
      const { error: mErr } = await db.from("asset_movements").insert({
        organization_id: ctx.organization_id,
        asset_id: input.asset["id"],
        movement_type: "status-change",
        previous_location: input.asset["location_label"] ?? null,
        new_location: input.asset["location_label"] ?? null,
        reason: `${input.status}: ${input.reason}`,
        performed_by: ctx.userId,
      });
      if (mErr) throw mErr;
      await logAudit({
        action: "asset.status_changed",
        module: "maintenance",
        recordId: String(input.asset["id"]),
        previousValue: { status: previous },
        newValue: { status: input.status },
        reason: input.reason,
        branchId: (input.asset["branch_id"] as string) ?? null,
      });
    },
    onSuccess: () => {
      toast.success("Asset status updated");
      void qc.invalidateQueries({ queryKey: ["ops", "assets"] });
      void qc.invalidateQueries({ queryKey: ["ops", "asset-movements"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ----------------------------- requisitions ----------------------------- */

export function useRequisitions(scope: "mine" | "department" | "stores" | "all" = "all") {
  const { organizationId, userId, department_id } = useCtx();
  return useQuery({
    queryKey: ["ops", "requisitions", organizationId, scope, userId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = db
        .from("internal_requisitions")
        .select(
          "id, request_number, status, priority, request_date, required_date, reason, fulfilment_model, department_id, source_location_id, destination_location_id, requested_by, shortage_notes, departments(name), internal_requisition_lines(id, description, unit, quantity_requested, quantity_approved, quantity_issued, quantity_received, controlled, stock_item_id, stock_items(name, base_unit))",
        )
        .order("request_date", { ascending: false })
        .limit(200);
      if (scope === "mine" && userId) q = q.eq("requested_by", userId);
      if (scope === "department" && department_id) q = q.eq("department_id", department_id);
      if (scope === "stores") q = q.in("status", ["awaiting-stores", "approved", "partially-approved", "ready-for-issue", "partially-issued"]);
      const { data, error } = await q;
      if (error) throw error;
      return rows(data);
    },
  });
}

export function useCreateRequisition() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (input: { header: Row; lines: Row[] }) => {
      const { data: seq } = await guardedRpc(db, "next_document_number", { _doc_type: "requisition" });
      const { data, error } = await db
        .from("internal_requisitions")
        .insert({
          ...input.header,
          request_number: seq ?? null,
          organization_id: ctx.organization_id,
          branch_id: ctx.branch_id,
          department_id: input.header["department_id"] ?? ctx.department_id,
          requested_by: ctx.userId,
        })
        .select("id")
        .single();
      if (error) throw error;
      const reqId = (data as Row)["id"];
      if (input.lines.length) {
        const { error: lErr } = await db.from("internal_requisition_lines").insert(
          input.lines.map((l) => ({ ...l, organization_id: ctx.organization_id, requisition_id: reqId })),
        );
        if (lErr) throw lErr;
      }
      return reqId as string;
    },
    onSuccess: () => {
      toast.success("Requisition created");
      void qc.invalidateQueries({ queryKey: ["ops", "requisitions"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRequisitionAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      action: "submit" | "approve" | "issue" | "receive";
      attemptId?: string;
      id: string;
      lines?: Row[];
      stage?: "supervisor" | "stores";
    }) => {
      if (input.action === "submit") {
        const { error } = await guardedRpc(db, "req_submit", { _requisition: input.id });
        if (error) throw error;
        return "Requisition submitted";
      }
      if (input.action === "approve") {
        const { error } = await guardedRpc(db, "req_approve", {
          _requisition: input.id,
          _lines: input.lines ?? [],
          _stage: input.stage ?? "supervisor",
        });
        if (error) throw error;
        return "Requisition approved";
      }
      if (input.action === "issue") {
        if (!input.attemptId) {
          throw new Error("Issue attempt ID is required");
        }
        const { error } = await guardedRpc(db, "neo_req_issue_safe", { _requisition: input.id, _lines: input.lines ?? [], _attempt: input.attemptId });
        if (error) throw error;
        return "Stock issued and posted to the ledger";
      }
      const { data, error } = await guardedRpc(db, "req_confirm_receipt", { _requisition: input.id, _lines: input.lines ?? [] });
      if (error) throw error;
      return (data as Row)?.["discrepancy"] ? "Receipt recorded with a discrepancy — kept open" : "Receipt confirmed";
    },
    onSuccess: (message) => {
      toast.success(message);
      void qc.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRaiseShortagePurchase() {
  const qc = useQueryClient();
  const ctx = useCtx();
  return useMutation({
    mutationFn: async (input: { requisition: Row; notes: string }) => {
      const { data: seq } = await guardedRpc(db, "next_document_number", { _doc_type: "purchase-request" });
      const { data, error } = await db
        .from("purchase_requests")
        .insert({
          organization_id: ctx.organization_id,
          branch_id: ctx.branch_id,
          department_id: input.requisition["department_id"] ?? ctx.department_id,
          request_number: seq ?? null,
          title: `Stores shortage — ${input.requisition["request_number"] ?? "requisition"}`,
          justification: input.notes,
          source: "stores-shortage",
          status: "submitted",
          priority: input.requisition["priority"] ?? "normal",
          requested_by: ctx.userId,
        })
        .select("id")
        .single();
      if (error) throw error;
      const { error: uErr } = await db
        .from("internal_requisitions")
        .update({ purchase_request_id: (data as Row)["id"], shortage_notes: input.notes })
        .eq("id", input.requisition["id"]);
      if (uErr) throw uErr;
    },
    onSuccess: () => {
      toast.success("Shortage routed to Procurement as a purchase request");
      void qc.invalidateQueries({ queryKey: ["ops", "requisitions"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useDepartmentConsumption() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "consumption", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(db.from("department_consumption").select("id, quantity, unit, value, reason, consumed_on, departments(name), stock_items(name), stock_locations(name)"), "department_consumption")
        .order("consumed_on", { ascending: false })
        .limit(300);
      if (error) throw error;
      return rows(data);
    },
  });
}

export function useRecordConsumption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { location: string; item: string; quantity: number; unit?: string; reason?: string }) => {
      const { error } = await guardedRpc(db, "req_record_consumption", {
        _location: input.location,
        _item: input.item,
        _quantity: input.quantity,
        _unit: input.unit ?? null,
        _reason: input.reason ?? null,
        _room: null,
        _work_order: null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Consumption recorded against the mini-store");
      void qc.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* -------------------------- shared lookups ------------------------------ */

export function useStockLocationsLite() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "locations", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(db.from("stock_locations").select("id, name, code, location_type, is_main, is_mini_store, department_id, active"), "stock_locations")
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return rows(data);
    },
  });
}

export function useStockItemsLite() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "items", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(db.from("stock_items").select("id, name, base_unit, average_cost, active"), "stock_items")
        .eq("active", true)
        .order("name")
        .limit(500);
      if (error) throw error;
      return rows(data);
    },
  });
}

/**
 * Canonical, property-scoped worker catalogue.
 *
 * The value returned as `id` is `profiles.id` — the identity every backend
 * routine expects. Options are limited to the property currently selected in
 * the header (and, when a department key is given, to that department for that
 * property, resolving the organisation-wide department record too), so a
 * branch-scoped operator is never offered a worker the database would refuse.
 */
export function useStaffLite(departmentKey?: string | null) {
  const workers = useScopedWorkers(departmentKey ? { departmentKey } : {});
  return {
    ...workers,
    data: (workers.data ?? []) as unknown as Row[],
  } as typeof workers & { data: Row[] };
}

/** Property-scoped, deduplicated departments (organisation-wide duplicates hidden). */
export function useDepartmentsLite() {
  const departments = useScopedDepartments();
  return {
    ...departments,
    data: (departments.data ?? []) as unknown as Row[],
  } as typeof departments & { data: Row[] };
}

/* ------------------------------- realtime ------------------------------- */

/** Live room board / work order updates with a safe polling fallback. */
export function useOperationsRealtime() {
  const qc = useQueryClient();
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["ops"] });
  useScopedRealtime("ops-live", [
    { table: "rooms", onChange: invalidate },
    { table: "housekeeping_jobs", onChange: invalidate },
    { table: "maintenance_work_orders", onChange: invalidate },
  ]);

  useEffect(() => {
    const timer = setInterval(() => {
      void qc.invalidateQueries({ queryKey: ["ops", "room-board"] });
    }, 60000);
    return () => clearInterval(timer);
  }, [qc]);
}

/* ------------------- stale cleaning-task reconciliation ------------------- */

export type StaleJobCandidate = {
  job_id: string;
  job_number: string | null;
  job_type: string | null;
  status: string | null;
  room_number: string | null;
  reference_at: string | null;
  evidence: "inspection" | "later_clean" | "none";
  evidence_at: string | null;
  evidence_reference: string | null;
};

/**
 * Cleaning tasks left open past the chosen age, together with the evidence —
 * a passed inspection, or a later completed clean of the same room — that
 * would justify closing them. Read-only.
 */
export function useStaleCleaningTasks(hours = 24) {
  const { branchId, filterKey } = useActivePropertyFilter();
  const { organizationId } = useCtx();
  return useQuery({
    queryKey: ["ops", "stale-cleaning-tasks", organizationId, branchId ?? null, filterKey, hours],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "hk_stale_job_candidates", {
        _branch: branchId ?? null,
        _hours: hours,
      });
      if (error) throw error;
      const result = (data ?? {}) as Row;
      // Every stale task is returned, with or without evidence: evidence-backed
      // ones can be closed in bulk, the rest need a supervisor's decision.
      return (result["tasks"] ?? []) as StaleJobCandidate[];
    },
  });
}

/**
 * A supervisor's explicit decision on one stale task: finish it, cancel it with
 * a written reason, hand it to someone else, or supersede it with a fresh task.
 * The database checks permission and property scope and writes the audit entry.
 */
export function useResolveStaleCleaningTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      jobId: string;
      action: "complete" | "cancel" | "reassign" | "replace";
      reason?: string | null;
      assignee?: string | null;
    }) => {
      const { data, error } = await guardedRpc(db, "hk_resolve_stale_job", {
        _job: input.jobId,
        _action: input.action,
        _reason: input.reason ?? null,
        _assignee: input.assignee ?? null,
      });
      if (error) throw error;
      const result = (data ?? {}) as Row;
      if (result["ok"] !== true) {
        const reason = String(result["reason"] ?? "");
        throw new Error(
          reason === "not_permitted"
            ? "You do not have permission to resolve cleaning tasks."
            : reason === "already_resolved"
              ? "That task has already been resolved."
              : reason === "not_found"
                ? "That task is no longer available."
                : "Select a property first.",
        );
      }
      return result;
    },
    onSuccess: (_result, input) => {
      toast.success(
        input.action === "complete"
          ? "Task closed and recorded."
          : input.action === "cancel"
            ? "Task cancelled with your reason recorded."
            : input.action === "reassign"
              ? "Task handed over."
              : "Task superseded and a replacement raised.",
      );
      void qc.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}


/**
 * Closes those stale tasks against their evidence. Nothing without evidence is
 * touched, and every closure is written to the audit trail with the person who
 * ran it.
 */
export function useReconcileStaleCleaningTasks(hours = 24) {
  const qc = useQueryClient();
  const { branchId } = useActivePropertyFilter();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(db, "hk_reconcile_stale_jobs", {
        _branch: branchId ?? null,
        _hours: hours,
      });
      if (error) throw error;
      const result = (data ?? {}) as Row;
      if (result["ok"] === false) {
        throw new Error(
          result["reason"] === "not_permitted"
            ? "You do not have permission to close cleaning tasks."
            : "Select a property first.",
        );
      }
      return result;
    },
    onSuccess: (result) => {
      const resolved = Number(result?.["resolved"] ?? 0);
      toast.success(
        resolved > 0
          ? `${resolved} stale task(s) closed against cleaning and inspection evidence`
          : "No stale task has evidence to close it yet",
      );
      void qc.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
