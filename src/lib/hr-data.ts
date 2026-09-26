/**
 * Phase 13 data layer — Human Resources & Workforce Management.
 *
 * Every read and write goes through RLS-scoped Supabase queries, so the database
 * — not the UI — decides whether the signed-in user may see a colleague's record,
 * statutory identifiers, medical leave documents or payroll inputs.
 */

import { guardedRpc } from "@/lib/rpc-guard";
import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { HR_MODULES, today, type Row } from "@/lib/hr";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useWorkforceSummary } from "@/lib/workforce";

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = supabase as any;

function rows(data: unknown): Row[] {
  return (data ?? []) as Row[];
}

export function useHrCtx() {
  const { organizationId, profile, user } = useAuth();
  const p = profile as { branch_id?: string | null; department_id?: string | null } | null;
  return {
    organizationId,
    organization_id: organizationId as string,
    branch_id: p?.branch_id ?? null,
    department_id: p?.department_id ?? null,
    userId: user?.id ?? null,
    userName: (profile as { full_name?: string } | null)?.full_name ?? "",
  };
}

/* --------------------------- generic list hook --------------------------- */

type Build = (q: any) => any;

export function useHrList(table: string, select: string, build?: Build, deps: unknown[] = [], enabled = true) {
  const { organizationId } = useHrCtx();
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    // The active property is part of the identity of the result, so switching
    // property can never serve another property's cached rows.
    queryKey: ["hr", table, organizationId, filterKey, ...deps],
    enabled: Boolean(organizationId) && enabled,
    queryFn: async () => {
      let q = applyTo(db.from(table).select(select), table);
      if (build) q = build(q);
      const { data, error } = await q;
      if (error) throw error;
      return rows(data);
    },
  });
}

export function useHrInvalidate() {
  const qc = useQueryClient();
  return useCallback(() => void qc.invalidateQueries({ queryKey: ["hr"] }), [qc]);
}

/** Insert/update helper that keeps audit logging and cache busting in one place. */
export function useHrWrite(table: string, options?: { action?: string; module?: string }) {
  const ctx = useHrCtx();
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async (input: { id?: string; values: Row; reason?: string }) => {
      if (input.id) {
        const { data, error } = await db.from(table).update(input.values).eq("id", input.id).select().single();
        if (error) throw error;
        return data as Row;
      }
      const { data, error } = await db
        .from(table)
        .insert({ organization_id: ctx.organization_id, ...input.values })
        .select()
        .single();
      if (error) throw error;
      return data as Row;
    },
    onSuccess: async (data, input) => {
      invalidate();
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: options?.action ?? `${table}.${input.id ? "update" : "create"}`,
        module: options?.module ?? "human-resources",
        recordId: (data as Row)?.["id"] ?? null,
        newValue: input.values,
        reason: input.reason ?? null,
        branchId: ctx.branch_id,
        departmentId: ctx.department_id,
      });
      toast.success(input.id ? "Saved" : "Created");
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/* ------------------------------- employees ------------------------------- */

const EMPLOYEE_SELECT =
  "id, employee_number, full_name, preferred_name, avatar_url, phone, work_email, personal_email, job_title, gender, position_grade, employment_type, employment_status, employment_date, confirmation_date, probation_start_date, probation_end_date, contract_start, contract_end, branch_id, department_id, station_id, candidate_id, reporting_manager_id, profile_id, system_access_status, payroll_status, payroll_effective_from, work_location, created_at, branches(name), departments(name), stations:operational_stations(name), reporting_manager:reporting_manager_id(full_name)";

export function useEmployees(filters?: { status?: string; department?: string; search?: string }) {
  return useHrList(
    "employees",
    EMPLOYEE_SELECT,
    (q) => {
      let out = q.order("full_name");
      if (filters?.status && filters.status !== "all") out = out.eq("employment_status", filters.status);
      if (filters?.department && filters.department !== "all") out = out.eq("department_id", filters.department);
      if (filters?.search)
        out = out.or(
          `full_name.ilike.%${filters.search}%,employee_number.ilike.%${filters.search}%,job_title.ilike.%${filters.search}%`,
        );
      return out;
    },
    [filters?.status ?? "all", filters?.department ?? "all", filters?.search ?? ""],
  );
}

export function useEmployee(id: string | undefined) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useHrCtx();
  return useQuery({
    queryKey: ["hr", "employee", organizationId, id, filterKey],
    enabled: Boolean(organizationId && id),
    queryFn: async () => {
      const { data, error } = await applyTo(db.from("employees").select(EMPLOYEE_SELECT), "employees").eq("id", id).maybeSingle();
      if (error) throw error;
      return (data ?? null) as Row | null;
    },
  });
}

/** The employee record belonging to the signed-in login account, if any. */
export function useMyEmployee() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId, userId } = useHrCtx();
  return useQuery({
    queryKey: ["hr", "my-employee", organizationId, userId, filterKey],
    enabled: Boolean(organizationId && userId),
    queryFn: async () => {
      const { data, error } = await applyTo(db.from("employees").select(EMPLOYEE_SELECT), "employees")
        .eq("profile_id", userId)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as Row | null;
    },
  });
}

export function useEmployeeIdentifiers(employeeId: string | undefined) {
  const { organizationId } = useHrCtx();
  return useQuery({
    queryKey: ["hr", "identifiers", organizationId, employeeId],
    enabled: Boolean(organizationId && employeeId),
    retry: false,
    queryFn: async () => {
      const { data, error } = await db
        .from("employee_identifiers")
        .select("*")
        .eq("employee_id", employeeId)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as Row | null;
    },
  });
}

export function useEmployeeChildren(table: string, employeeId: string | undefined, select = "*") {
  return useHrList(
    table,
    select,
    (q) => q.eq("employee_id", employeeId).order("created_at", { ascending: false }),
    [employeeId ?? ""],
    Boolean(employeeId),
  );
}

export function useEmploymentHistory(employeeId: string | undefined) {
  return useHrList(
    "employment_history",
    "*",
    (q) => q.eq("employee_id", employeeId).order("effective_date", { ascending: false }),
    [employeeId ?? ""],
    Boolean(employeeId),
  );
}

/* -------------------------------- lookups -------------------------------- */

export function useDepartmentsLookup() {
  return useHrList("departments", "id, name", (q) => q.order("name"));
}

export function useBranchesLookup() {
  return useHrList("branches", "id, name", (q) => q.order("name"));
}

export function useProfilesLookup() {
  return useHrList("profiles", "id, full_name, email, staff_id", (q) => q.order("full_name"));
}

/* ------------------------------ recruitment ------------------------------ */

export function useVacancies() {
  return useHrList(
    "vacancies",
    "*, departments(name), branches(name)",
    (q) => q.order("created_at", { ascending: false }),
  );
}

export function useCandidates(vacancyId?: string) {
  return useHrList(
    "candidates",
    "*, vacancies(job_title)",
    (q) => {
      const out = q.order("created_at", { ascending: false });
      return vacancyId ? out.eq("vacancy_id", vacancyId) : out;
    },
    [vacancyId ?? "all"],
  );
}

export function useInterviews() {
  return useHrList("interviews", "*, candidates(full_name)", (q) => q.order("scheduled_at", { ascending: false }));
}

export function useOffers() {
  return useHrList("employment_offers", "*, candidates(full_name)", (q) =>
    q.order("created_at", { ascending: false }),
  );
}

/** Convert an accepted candidate into an employee record (identity stays separate). */
export function useConvertCandidate() {
  const ctx = useHrCtx();
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async (input: { candidate: Row; offer?: Row | null; employeeNumber: string }) => {
      const c = input.candidate;
      const o = input.offer ?? null;
      const { data, error } = await db
        .from("employees")
        .insert({
          organization_id: ctx.organization_id,
          candidate_id: c["id"],
          employee_number: input.employeeNumber,
          full_name: c["full_name"],
          personal_email: c["email"] ?? "",
          phone: c["phone"] ?? "",
          job_title: o?.["job_title"] ?? "",
          employment_type: o?.["employment_type"] ?? "permanent",
          employment_status: "onboarding",
          employment_date: o?.["proposed_start_date"] ?? null,
          branch_id: o?.["branch_id"] ?? ctx.branch_id,
          department_id: o?.["department_id"] ?? null,
          created_by: ctx.userId,
        })
        .select()
        .single();
      if (error) throw error;
      const { error: linkError } = await db
        .from("candidates")
        .update({ status: "hired", converted_employee_id: (data as Row)["id"] })
        .eq("id", c["id"]);
      if (linkError) throw linkError;
      return data as Row;
    },
    onSuccess: async (data) => {
      invalidate();
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: "hr.candidate.converted",
        module: "human-resources",
        recordId: (data as Row)["id"],
        newValue: { employee_number: (data as Row)["employee_number"] },
      });
      toast.success("Employee record created from candidate");
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/* ------------------------------- attendance ------------------------------ */

export function useAttendance(range: { from: string; to: string }, employeeId?: string) {
  return useHrList(
    "attendance_records",
    "*, employees(full_name, employee_number, job_title), departments(name)",
    (q) => {
      let out = q.gte("work_date", range.from).lte("work_date", range.to).order("work_date", { ascending: false });
      if (employeeId) out = out.eq("employee_id", employeeId);
      return out;
    },
    [range.from, range.to, employeeId ?? "all"],
  );
}

export function useMyOpenShift(employeeId: string | undefined) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useHrCtx();
  return useQuery({
    queryKey: ["hr", "open-shift", organizationId, employeeId, filterKey],
    enabled: Boolean(organizationId && employeeId),
    queryFn: async () => {
      const { data, error } = await applyTo(db.from("attendance_records").select("*"), "attendance_records")
        .eq("employee_id", employeeId)
        .is("clock_out_at", null)
        .order("work_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as Row | null;
    },
  });
}

export function useClockIn() {
  const ctx = useHrCtx();
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async (input: { employee: Row; source?: string }) => {
      const { data, error } = await db
        .from("attendance_records")
        .insert({
          organization_id: ctx.organization_id,
          employee_id: input.employee["id"],
          branch_id: input.employee["branch_id"] ?? ctx.branch_id,
          department_id: input.employee["department_id"] ?? null,
          work_date: today(),
          clock_in_at: new Date().toISOString(),
          source: input.source ?? "web",
          status: "in_progress",
        })
        .select()
        .single();
      if (error) throw error;
      return data as Row;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Clocked in");
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useClockOut() {
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async (input: { record: Row; breakMinutes?: number }) => {
      const out = new Date();
      const inAt = new Date(String(input.record["clock_in_at"] ?? out.toISOString()));
      const breaks = Math.max(0, input.breakMinutes ?? Number(input.record["break_minutes"] ?? 0));
      const worked = Math.max(0, Math.round((out.getTime() - inAt.getTime()) / 60000) - breaks);
      const { data, error } = await db
        .from("attendance_records")
        .update({
          clock_out_at: out.toISOString(),
          break_minutes: breaks,
          worked_minutes: worked,
          status: "pending_review",
        })
        .eq("id", input.record["id"])
        .select()
        .single();
      if (error) throw error;
      return data as Row;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Clocked out — sent for supervisor review");
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useAttendanceCorrections() {
  return useHrList("attendance_corrections", "*, employees(full_name, employee_number)", (q) =>
    q.order("created_at", { ascending: false }),
  );
}

/* ------------------------------- scheduling ------------------------------ */

export function useShiftTemplates() {
  return useHrList("shift_templates", "*, departments(name), branches(name)", (q) => q.order("start_time"));
}

export function useRosters() {
  return useHrList("rosters", "*, departments(name), branches(name)", (q) =>
    q.order("period_start", { ascending: false }),
  );
}

export function useRosterAssignments(rosterId?: string, employeeId?: string) {
  return useHrList(
    "roster_assignments",
    "*, employees(full_name, employee_number), shift_templates(name, start_time, end_time)",
    (q) => {
      let out = q.order("shift_date");
      if (rosterId) out = out.eq("roster_id", rosterId);
      if (employeeId) out = out.eq("employee_id", employeeId);
      return out;
    },
    [rosterId ?? "all", employeeId ?? "all"],
    Boolean(rosterId || employeeId),
  );
}

export function useSwapRequests() {
  return useHrList(
    "shift_swap_requests",
    "*, requester:employees!shift_swap_requests_requester_employee_id_fkey(full_name), target:employees!shift_swap_requests_target_employee_id_fkey(full_name)",
    (q) => q.order("created_at", { ascending: false }),
  );
}

export function useOvertimeRequests() {
  return useHrList("overtime_requests", "*, employees(full_name, employee_number)", (q) =>
    q.order("overtime_date", { ascending: false }),
  );
}

/* ---------------------------------- leave -------------------------------- */

export function useLeaveTypes() {
  return useHrList("leave_types", "*", (q) => q.order("name"));
}

export function useLeaveRequests(employeeId?: string) {
  return useHrList(
    "leave_requests",
    // leave_requests has TWO FKs to employees (employee_id, acting_employee_id),
    // so the requester embed must be constraint-qualified to stay unambiguous.
    "*, employees:employees!leave_requests_employee_id_fkey(full_name, employee_number, job_title), leave_types(name, code, paid, medical_sensitive), departments(name)",
    (q) => {
      const out = q.order("start_date", { ascending: false });
      return employeeId ? out.eq("employee_id", employeeId) : out;
    },
    [employeeId ?? "all"],
  );
}

export function useLeaveBalances(employeeId?: string) {
  return useHrList(
    "leave_balances",
    "*, leave_types(name, code, paid), employees(full_name)",
    (q) => {
      const out = q.eq("period_year", new Date().getFullYear());
      return employeeId ? out.eq("employee_id", employeeId) : out;
    },
    [employeeId ?? "all"],
  );
}

/** Approve or reject a leave request and write the balance ledger entry. */
export function useDecideLeave() {
  const ctx = useHrCtx();
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async (input: { request: Row; approve: boolean; note: string }) => {
      const r = input.request;
      const status = input.approve ? "approved" : "rejected";
      const { error } = await db
        .from("leave_requests")
        .update({
          status,
          decision_note: input.note,
          approved_by: ctx.userId,
          approved_at: new Date().toISOString(),
          posted: input.approve,
        })
        .eq("id", r["id"]);
      if (error) throw error;

      if (input.approve) {
        const { error: ledgerError } = await db.from("leave_transactions").insert({
          organization_id: ctx.organization_id,
          employee_id: r["employee_id"],
          leave_type_id: r["leave_type_id"],
          leave_request_id: r["id"],
          period_year: new Date(String(r["start_date"])).getFullYear(),
          transaction_type: "taken",
          days: -Math.abs(Number(r["days"] ?? 0)),
          reason: input.note,
          idempotency_key: `leave-taken-${r["id"]}`,
          created_by: ctx.userId,
        });
        if (ledgerError) throw ledgerError;
      }
      return { id: r["id"] as string, status };
    },
    onSuccess: async (result, input) => {
      invalidate();
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: `hr.leave.${result.status}`,
        module: "human-resources",
        recordId: result.id,
        reason: input.note,
      });
      toast.success(input.approve ? "Leave approved" : "Leave rejected");
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/* ------------------------------- performance ----------------------------- */

export function usePerformanceCycles() {
  return useHrList("performance_cycles", "*", (q) => q.order("period_start", { ascending: false }));
}

export function usePerformanceReviews(employeeId?: string) {
  return useHrList(
    "performance_reviews",
    "*, employees!performance_reviews_employee_id_fkey(full_name, employee_number, job_title), performance_cycles(name)",
    (q) => {
      const out = q.order("created_at", { ascending: false });
      return employeeId ? out.eq("employee_id", employeeId) : out;
    },
    [employeeId ?? "all"],
  );
}

export function useDisciplinaryCases() {
  return useHrList("disciplinary_cases", "*, employees(full_name, employee_number)", (q) =>
    q.order("created_at", { ascending: false }),
  );
}

export function useGrievanceCases() {
  return useHrList("grievance_cases", "*", (q) => q.order("created_at", { ascending: false }));
}

/* -------------------------------- training ------------------------------- */

export function useTrainingCourses() {
  return useHrList("training_courses", "*", (q) => q.order("name"));
}

export function useTrainingSessions() {
  return useHrList("training_sessions", "*, training_courses(name, code, mandatory)", (q) =>
    q.order("session_date", { ascending: false }),
  );
}

export function useTrainingParticipants(sessionId?: string, employeeId?: string) {
  return useHrList(
    "training_participants",
    "*, employees(full_name, employee_number), training_sessions(session_date, training_courses(name))",
    (q) => {
      let out = q.order("created_at", { ascending: false });
      if (sessionId) out = out.eq("session_id", sessionId);
      if (employeeId) out = out.eq("employee_id", employeeId);
      return out;
    },
    [sessionId ?? "all", employeeId ?? "all"],
  );
}

export function useCertifications() {
  return useHrList("employee_certifications", "*, employees(full_name, employee_number)", (q) =>
    q.order("expiry_date", { ascending: true }),
  );
}

/* ---------------------------------- payroll ------------------------------ */

export function usePayrollPeriods() {
  return useHrList("payroll_periods", "*", (q) => q.order("period_start", { ascending: false }));
}

export function usePayrollInputs(periodId?: string) {
  return useHrList(
    "payroll_input_records",
    "*, employees(full_name, employee_number, job_title), departments(name)",
    (q) => q.eq("period_id", periodId).order("created_at"),
    [periodId ?? ""],
    Boolean(periodId),
  );
}

/**
 * Build payroll inputs for a period from approved attendance, overtime and leave.
 * Nothing is calculated as money here — payroll processing stays external.
 */
export function useBuildPayrollInputs() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const ctx = useHrCtx();
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async (period: Row) => {
      const from = String(period["period_start"]);
      const to = String(period["period_end"]);
      const [employees, attendance, overtime, leave] = await Promise.all([
        applyTo(db.from("employees").select("id, branch_id, department_id, employment_status"), "employees"),
        applyTo(db.from("attendance_records").select("employee_id, worked_minutes, late_minutes, status"), "attendance_records").gte("work_date", from).lte("work_date", to),
        applyTo(db.from("overtime_requests").select("employee_id, hours, status"), "overtime_requests").gte("overtime_date", from).lte("overtime_date", to),
        applyTo(db.from("leave_requests").select("employee_id, days, status, leave_types(paid)"), "leave_requests").gte("start_date", from).lte("end_date", to),
      ]);
      if (employees.error) throw employees.error;

      const active = rows(employees.data).filter((e) => e["employment_status"] !== "exited");
      const payload = active.map((e) => {
        const att = rows(attendance.data).filter((a) => a["employee_id"] === e["id"]);
        const ot = rows(overtime.data).filter((o) => o["employee_id"] === e["id"] && o["status"] === "approved");
        const lv = rows(leave.data).filter((l) => l["employee_id"] === e["id"] && l["status"] === "approved");
        const workedMinutes = att.reduce((sum, a) => sum + Number(a["worked_minutes"] ?? 0), 0);
        const paidLeave = lv
          .filter((l) => (l["leave_types"] as Row | null)?.["paid"])
          .reduce((sum, l) => sum + Number(l["days"] ?? 0), 0);
        const unpaidLeave = lv
          .filter((l) => !(l["leave_types"] as Row | null)?.["paid"])
          .reduce((sum, l) => sum + Number(l["days"] ?? 0), 0);
        return {
          organization_id: ctx.organization_id,
          period_id: period["id"],
          employee_id: e["id"],
          branch_id: e["branch_id"] ?? null,
          department_id: e["department_id"] ?? null,
          worked_days: att.length,
          worked_hours: Math.round((workedMinutes / 60) * 100) / 100,
          overtime_hours: ot.reduce((sum, o) => sum + Number(o["hours"] ?? 0), 0),
          paid_leave_days: paidLeave,
          unpaid_leave_days: unpaidLeave,
          late_minutes: att.reduce((sum, a) => sum + Number(a["late_minutes"] ?? 0), 0),
          status: "draft",
        };
      });

      if (!payload.length) throw new Error("No active employees to build payroll inputs for");
      const { error } = await db
        .from("payroll_input_records")
        .upsert(payload, { onConflict: "period_id,employee_id" });
      if (error) throw error;
      return payload.length;
    },
    onSuccess: async (count, period) => {
      invalidate();
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: "hr.payroll.inputs_built",
        module: "human-resources",
        recordId: (period as Row)["id"],
        newValue: { rows: count },
      });
      toast.success(`Prepared payroll inputs for ${count} employees`);
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/* ------------------------------ announcements ---------------------------- */

export function useAnnouncements() {
  return useHrList("staff_announcements", "*", (q) => q.order("publish_at", { ascending: false }));
}

/* -------------------------------- settings ------------------------------- */

export function useHrSettings() {
  const { organizationId } = useHrCtx();
  return useQuery({
    queryKey: ["hr", "settings", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db.from("hr_settings").select("*").maybeSingle();
      if (error) throw error;
      return (data ?? null) as Row | null;
    },
  });
}

/* -------------------------------- dashboard ------------------------------ */

/** Workforce headline numbers, derived from the tables the viewer may read. */
export function useWorkforceOverview() {
  const employees = useEmployees();
  const canonical = useWorkforceSummary();
  const attendance = useAttendance({ from: today(), to: today() });
  const leave = useLeaveRequests();
  const certifications = useCertifications();
  const assignments = useHrList(
    "roster_assignments",
    "id, is_open_shift, shift_date, status",
    (q) => q.gte("shift_date", today()).eq("is_open_shift", true),
    ["open-shifts"],
  );

  const canonicalHeadcount = canonical.headcount;

  const summary = useMemo(() => {
    const staff = employees.data ?? [];
    const soon = (value: unknown, days: number) => {
      if (!value) return false;
      const t = new Date(String(value)).getTime();
      return t >= Date.now() && t <= Date.now() + days * 86_400_000;
    };
    return {
      // Canonical projection wins: HR, dashboards and Users must agree.
      headcount:
        canonicalHeadcount ?? staff.filter((e) => e["employment_status"] !== "exited").length,

      onProbation: staff.filter((e) => e["employment_status"] === "probation").length,
      onLeaveToday: staff.filter((e) => e["employment_status"] === "on_leave").length,
      presentToday: (attendance.data ?? []).filter((a) => a["clock_in_at"]).length,
      attendanceExceptions: (attendance.data ?? []).filter(
        (a) => a["status"] === "incomplete" || Number(a["late_minutes"] ?? 0) > 0,
      ).length,
      pendingLeave: (leave.data ?? []).filter((l) =>
        ["submitted", "supervisor_approved"].includes(String(l["status"])),
      ).length,
      expiringCertificates: (certifications.data ?? []).filter((c) => soon(c["expiry_date"], 60)).length,
      probationDue: staff.filter((e) => soon(e["probation_end_date"], 30)).length,
      contractsExpiring: staff.filter((e) => soon(e["contract_end"], 60)).length,
      openShifts: (assignments.data ?? []).length,
    };
  }, [canonicalHeadcount, employees.data, attendance.data, leave.data, certifications.data, assignments.data]);

  return {
    summary,
    employees,
    isLoading: employees.isLoading || attendance.isLoading || leave.isLoading,
    error: employees.error ?? attendance.error ?? leave.error,
  };
}

/* --------------------- staff → HR directory reconciliation --------------------- */

export type HrReconcileResult = {
  committed: boolean;
  pending: number;
  created: number;
  linked: number;
  sample: Array<{ name: string; staff_id: string | null; job_title: string | null }>;
};

/**
 * Counts staff accounts that hold a role but have no HR record yet.
 *
 * This is a dry run of `neo_hr_reconcile_staff` — the database performs the
 * same scoped query it would use to create records, so the number shown is
 * exactly what the reconcile action would act on. Nothing is written.
 */
export function useHrReconcilePreview() {
  const { organizationId } = useHrCtx();
  const { can } = useAuth();
  const allowed = can(HR_MODULES.employees, "create");
  return useQuery({
    queryKey: ["hr", "reconcile-preview", organizationId],
    enabled: Boolean(organizationId) && allowed,
    retry: false,
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_hr_reconcile_staff", { _commit: false });
      if (error) throw error;
      return data as HrReconcileResult;
    },
  });
}

/**
 * Creates the missing HR records from existing staff accounts.
 *
 * Only facts already held on the staff account are copied across. Employment
 * dates, contract terms, grade, salary and reporting lines are deliberately
 * left blank and every new record is flagged `not_ready` for payroll, so HR
 * must complete them — the system never invents employment history.
 */
export function useHrReconcileStaff() {
  const ctx = useHrCtx();
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_hr_reconcile_staff", { _commit: true });
      if (error) throw error;
      return data as HrReconcileResult;
    },
    onSuccess: async (result) => {
      invalidate();
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: "hr.directory.reconciled",
        module: "human-resources",
        recordId: null,
        newValue: { created: result.created, linked: result.linked },
        reason: "Reconciled staff accounts into the HR employee directory",
        branchId: ctx.branch_id,
        departmentId: ctx.department_id,
      });
      toast.success(
        `${result.created} record(s) created, ${result.linked} linked. Employment details still need completing.`,
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/* ------------------------------- offboarding ------------------------------- */

export type HrOffboardInput = {
  employeeId: string;
  lastWorkingDay?: string | null;
  separationType: string;
  reason?: string | null;
  revokeAccess: boolean;
};

export type HrOffboardResult = {
  employee_id: string;
  already_exited: boolean;
  roles_removed: number;
  account_closed: boolean;
  last_working_day?: string;
};

/**
 * Ends employment and, when asked, closes the person's system access in the
 * same transaction — a leaver must not keep live sign-in rights. The HR record
 * itself is never deleted: the separation is written to employment history and
 * an exit clearance is opened, so the trail survives the account removal.
 */
export function useHrOffboardEmployee() {
  const ctx = useHrCtx();
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async (input: HrOffboardInput) => {
      const { data, error } = await guardedRpc(db, "neo_hr_offboard_employee", {
        _employee: input.employeeId,
        _last_working_day: input.lastWorkingDay || null,
        _separation_type: input.separationType,
        _reason: input.reason || null,
        _revoke_access: input.revokeAccess,
      });
      if (error) throw error;
      return data as HrOffboardResult;
    },
    onSuccess: async (result, input) => {
      invalidate();
      await logAudit({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        userName: ctx.userName,
        action: "hr.employee.offboarded",
        module: "human-resources",
        recordId: input.employeeId,
        newValue: {
          separation_type: input.separationType,
          roles_removed: result.roles_removed,
          access_revoked: input.revokeAccess,
        },
        reason: input.reason ?? "Employment ended",
        branchId: ctx.branch_id,
        departmentId: ctx.department_id,
      });
      toast.success(
        result.already_exited
          ? "This employee had already been offboarded."
          : result.account_closed
            ? `Employment ended. System access closed (${result.roles_removed} role assignment(s) removed).`
            : "Employment ended. System access was left unchanged.",
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
