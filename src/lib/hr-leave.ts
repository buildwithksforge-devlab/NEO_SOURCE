/**
 * Leave policy, entitlement and application layer.
 *
 * The database is the authority: `neo_hr_leave_sync_entitlements` recalculates
 * every balance from the policy plus the employee's joining date,
 * `neo_hr_leave_apply` validates an application against the policy, and
 * `neo_hr_leave_decide` moves the days. The helpers below mirror that maths
 * client-side for the live preview only — they never write a balance.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";
import { useHrInvalidate, useHrList } from "@/lib/hr-data";
import type { Row } from "@/lib/hr";

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = supabase as any;

/* ------------------------------ vocabulary ------------------------------- */

export const LEAVE_CATEGORIES = [
  { key: "annual", label: "Annual leave" },
  { key: "sick", label: "Sick leave" },
  { key: "maternity", label: "Maternity leave" },
  { key: "paternity", label: "Paternity leave" },
  { key: "compassionate", label: "Compassionate leave" },
  { key: "study", label: "Study leave" },
  { key: "unpaid", label: "Unpaid leave" },
  { key: "time_off", label: "Off days / time off" },
  { key: "other", label: "Other company leave" },
] as const;

export const ACCRUAL_METHODS = [
  { key: "annual", label: "Granted in full each leave year" },
  { key: "monthly", label: "Accrues monthly" },
] as const;

export const APPROVAL_ROUTES = [
  { key: "supervisor", label: "Supervisor only" },
  { key: "hr", label: "HR only" },
  { key: "supervisor_then_hr", label: "Supervisor, then HR" },
] as const;

export const LEAVE_REQUEST_TABS = [
  { key: "submitted", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "returned", label: "Returned" },
  { key: "cancelled", label: "Cancelled" },
  { key: "taken", label: "Taken" },
] as const;

/* ------------------------------ pure maths ------------------------------- */

export type LeavePolicyShape = {
  counts_weekends?: boolean | null;
  counts_public_holidays?: boolean | null;
};

/** Days between two ISO dates, honouring the weekend/holiday rules of a policy. */
export function countLeaveDays(
  from: string,
  to: string,
  policy: LeavePolicyShape,
  holidays: readonly string[] = [],
): number {
  if (!from || !to) return 0;
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;

  const countsWeekends = policy.counts_weekends !== false;
  const countsHolidays = policy.counts_public_holidays !== false;
  const holidaySet = new Set(holidays);

  let days = 0;
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    if (!countsWeekends && weekend) continue;
    if (!countsHolidays && holidaySet.has(iso)) continue;
    days += 1;
  }
  return days;
}

export type BalanceShape = {
  entitlement_days?: number | null;
  carried_forward_days?: number | null;
  adjustment_days?: number | null;
  taken_days?: number | null;
  pending_days?: number | null;
};

function n(value: unknown): number {
  const v = Number(value);
  return Number.isFinite(v) ? v : 0;
}

/** Days the employee may still commit: entitlement + carried + adjustment − taken − pending. */
export function availableDays(balance: BalanceShape | null | undefined): number {
  if (!balance) return 0;
  return Math.max(
    0,
    n(balance.entitlement_days) +
      n(balance.carried_forward_days) +
      n(balance.adjustment_days) -
      n(balance.taken_days) -
      n(balance.pending_days),
  );
}

/** The three figures shown to the applicant before they submit. */
export function balancePreview(balance: BalanceShape | null | undefined, requested: number) {
  const available = availableDays(balance);
  return {
    available,
    requested,
    after: Math.max(0, available - Math.max(0, requested)),
    exceeds: requested > available,
  };
}

/** Whole days of notice given between today and the first day of leave. */
export function noticeDays(start: string, from = new Date()): number {
  if (!start) return 0;
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = new Date(`${start}T00:00:00Z`).getTime();
  if (Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export type PolicyBreach = { code: string; detail: string; blocking: boolean };

/** Client-side mirror of the policy checks, so the form explains itself before submitting. */
export function policyBreaches(input: {
  policy: Row | null | undefined;
  balance: BalanceShape | null | undefined;
  requestedDays: number;
  startDate: string;
  hasDocument: boolean;
}): PolicyBreach[] {
  const out: PolicyBreach[] = [];
  const p = input.policy;
  if (!p) return out;

  if (p["requires_document"] && !input.hasDocument) {
    out.push({
      code: "document_required",
      detail: "This leave type needs a supporting document attached.",
      blocking: true,
    });
  }

  const maxRun = p["max_consecutive_days"] as number | null;
  if (maxRun != null && input.requestedDays > Number(maxRun)) {
    out.push({
      code: "too_long",
      detail: `This policy allows at most ${maxRun} consecutive day(s).`,
      blocking: true,
    });
  }

  const preview = balancePreview(input.balance, input.requestedDays);
  if (preview.exceeds) {
    out.push({
      code: "over_balance",
      detail: `Requested ${input.requestedDays} day(s) against ${preview.available} available.`,
      blocking: Boolean(p["paid"]),
    });
  }

  const notice = Number(p["minimum_notice_days"] ?? 0);
  if (notice > 0 && noticeDays(input.startDate) < notice) {
    out.push({
      code: "short_notice",
      detail: `Policy asks for ${notice} day(s) notice; this request gives ${Math.max(0, noticeDays(input.startDate))}.`,
      blocking: false,
    });
  }

  return out;
}

/* --------------------------------- reads --------------------------------- */

export function useLeavePolicies() {
  return useHrList("leave_types", "*, branches(name)", (q) => q.order("name"));
}

/**
 * Public holidays, either for one calendar year or for every year on record.
 *
 * The list used to be pinned to the current calendar year with no way to change
 * it, so a holiday entered for next year saved correctly and then vanished from
 * the table — which read as "Add does nothing".
 */
export function usePublicHolidays(year?: number | "all") {
  const y = year ?? new Date().getFullYear();
  return useHrList(
    "public_holidays",
    "*",
    (q) =>
      y === "all"
        ? q.order("holiday_date")
        : q
            .gte("holiday_date", `${y}-01-01`)
            .lte("holiday_date", `${y}-12-31`)
            .order("holiday_date"),
    [String(y)],
  );
}

/**
 * Dates (ISO) observed as public holidays. Every year on record is read, so a
 * leave request that crosses a year boundary still skips the right days.
 */
export function useHolidayDates(): string[] {
  const holidays = usePublicHolidays("all");
  return (holidays.data ?? [])
    .filter((h) => h["observed"] !== false)
    .map((h) => String(h["holiday_date"]));
}

/** Colleagues in the same department already away over a date window. */
export function useTeamLeaveOverlap(
  departmentId: string | null | undefined,
  from: string,
  to: string,
  excludeRequestId?: string,
) {
  return useHrList(
    "leave_requests",
    "id, start_date, end_date, days, status, employee_id, employees:employees!leave_requests_employee_id_fkey(full_name, job_title), leave_types(name)",
    (q) =>
      q
        .eq("department_id", departmentId)
        .in("status", ["approved", "taken", "submitted", "supervisor_approved"])
        .lte("start_date", to)
        .gte("end_date", from)
        .order("start_date"),
    [departmentId ?? "none", from, to, excludeRequestId ?? "none"],
    Boolean(departmentId && from && to),
  );
}

/** The leave ledger entries behind one request — its full movement history. */
export function useLeaveLedger(requestId: string | undefined) {
  return useHrList(
    "leave_transactions",
    "*",
    (q) => q.eq("leave_request_id", requestId).order("created_at"),
    [requestId ?? ""],
    Boolean(requestId),
  );
}

/* -------------------------------- writes --------------------------------- */

/** Recalculates entitlement for one employee (or the whole workspace). */
export function useSyncEntitlements() {
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async (input?: { employeeId?: string | null; year?: number }) => {
      const { data, error } = await guardedRpc(db, "neo_hr_leave_sync_entitlements", {
        _employee: input?.employeeId ?? null,
        _year: input?.year ?? null,
      });
      if (error) throw new Error(error.message);
      return data as Row;
    },
    onSuccess: () => invalidate(),
  });
}

/** Keeps balances current whenever a leave surface is open. */
export function useEntitlementsUpToDate(employeeId?: string | null, enabled = true) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["hr", "leave-sync", organizationId, employeeId ?? "all"],
    enabled: Boolean(organizationId) && enabled,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_hr_leave_sync_entitlements", {
        _employee: employeeId ?? null,
        _year: null,
      });
      if (error) throw new Error(error.message);
      return data as Row;
    },
  });
}

export type LeaveApplication = {
  employeeId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  reason: string;
  handover: string;
  actingEmployeeId: string | null;
  documentPath: string | null;
  contact: string;
};

export function useApplyForLeave() {
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async (input: LeaveApplication) => {
      const { data, error } = await guardedRpc(db, "neo_hr_leave_apply", {
        _employee: input.employeeId,
        _leave_type: input.leaveTypeId,
        _start: input.startDate,
        _end: input.endDate,
        _reason: input.reason,
        _handover: input.handover,
        _acting_employee: input.actingEmployeeId,
        _document_path: input.documentPath,
        _contact: input.contact,
      });
      if (error) throw new Error(error.message);
      return data as Row;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Leave request ${String(data?.["reference"] ?? "")} submitted`);
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export type LeaveDecision = "approve" | "reject" | "return" | "cancel" | "taken";

const DECISION_MESSAGE: Record<LeaveDecision, string> = {
  approve: "Leave approved and the balance updated",
  reject: "Leave rejected",
  return: "Returned to the employee for amendment",
  cancel: "Leave request cancelled",
  taken: "Marked as taken",
};

export function useDecideLeaveRequest() {
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async (input: { requestId: string; decision: LeaveDecision; note: string }) => {
      const { data, error } = await guardedRpc(db, "neo_hr_leave_decide", {
        _request: input.requestId,
        _decision: input.decision,
        _note: input.note,
      });
      if (error) throw new Error(error.message);
      return data as Row;
    },
    onSuccess: (_data, input) => {
      invalidate();
      toast.success(DECISION_MESSAGE[input.decision]);
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/** Uploads a supporting document for a leave application. */
export async function uploadLeaveDocument(
  organizationId: string,
  employeeId: string,
  file: File,
): Promise<string> {
  if (file.size > 10 * 1024 * 1024) throw new Error("Attachment is larger than 10 MB.");
  const extension = (file.name.split(".").pop() ?? "pdf").toLowerCase().slice(0, 6);
  const path = `${organizationId}/${employeeId}/leave/${Date.now()}.${extension}`;
  const { error } = await supabase.storage
    .from("hr-documents")
    .upload(path, file, { upsert: false, contentType: file.type });
  if (error) throw new Error(error.message);
  return path;
}
