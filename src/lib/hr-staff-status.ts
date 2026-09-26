/**
 * Staff status for the board.
 *
 * One row per employee joining three ledgers that already exist: today's
 * attendance record, today's rostered shift and the leave the person has
 * approved plus what remains of their entitlement. Nothing is estimated —
 * an employee with no record for today simply reads "Not recorded".
 */

import { useMemo } from "react";
import {
  useHrList,
  useAttendance,
  useLeaveBalances,
  useLeaveRequests,
  usePerformanceReviews,
  useTrainingParticipants,
} from "@/lib/hr-data";
import { availableDays } from "@/lib/hr-leave";
import { today, type Row } from "@/lib/hr";

const str = (v: unknown, fallback = "") => (v == null ? fallback : String(v));
const num = (v: unknown) => (v == null ? 0 : Number(v) || 0);

export type ShiftState = "off" | "rostered" | "on-shift" | "finished" | "leave" | "absent";

export type StaffStatusRow = {
  id: string;
  name: string;
  number: string;
  jobTitle: string;
  department: string;
  /** Rostered shift for today, when a roster covers this person. */
  shiftLabel: string | null;
  shiftState: ShiftState;
  /** Attendance figures for today, when a record exists. */
  clockIn: string | null;
  clockOut: string | null;
  workedMinutes: number | null;
  lateMinutes: number;
  attendanceStatus: string | null;
  /** Remaining entitlement across all leave types for the current year. */
  leaveRemaining: number;
  leaveEntitled: number;
  leaveUnit: string;
  onLeaveType: string | null;
  /** Rolling 30-day performance figures, read from the same records. */
  overtimeMinutes30: number;
  lateMinutes30: number;
  lateDays30: number;
  absentDays30: number;
  daysWorked30: number;
  leaveDaysApproved30: number;
  /** Most recent completed appraisal, read from the performance record. */
  lastReviewDate: string | null;
  lastReviewRating: number | null;
  openReviews: number;
  /** Training booked against this person. */
  trainingCompleted: number;
  trainingOutstanding: number;
};

/** Days of the window this leave request covers, counting whole days only. */
function leaveDaysInWindow(row: Row, from: string, to: string): number {
  const start = str(row["start_date"]);
  if (!start) return 0;
  const end = str(row["end_date"]) || start;
  const a = start > from ? start : from;
  const b = end < to ? end : to;
  if (a > b) return 0;
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  if (!Number.isFinite(ms)) return 0;
  return Math.floor(ms / 86_400_000) + 1;
}

/** ISO date `days` before the given day. */
function daysBefore(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** How long the performance figures look back. */
export const KPI_WINDOW_DAYS = 30;

function coversToday(row: Row, day: string): boolean {
  const from = str(row["start_date"]);
  if (!from) return false;
  const to = str(row["end_date"]) || from;
  return from <= day && day <= to;
}

/** Today's attendance, roster and leave position for every active employee. */
export function useStaffStatusBoard() {
  const day = today();
  const employees = useHrList(
    "employees",
    "id, full_name, employee_number, job_title, employment_status, departments(name)",
    (q) => q.eq("employment_status", "active").order("full_name"),
    ["staff-status"],
  );
  const windowFrom = daysBefore(day, KPI_WINDOW_DAYS - 1);
  const attendance = useAttendance({ from: day, to: day });
  const history = useAttendance({ from: windowFrom, to: day });
  const assignments = useHrList(
    "roster_assignments",
    "employee_id, shift_date, status, shift_templates(name, start_time, end_time)",
    (q) => q.eq("shift_date", day),
    ["staff-status", day],
  );
  const balances = useLeaveBalances();
  const requests = useLeaveRequests();
  const reviews = usePerformanceReviews();
  const training = useTrainingParticipants();

  const data = useMemo<StaffStatusRow[]>(() => {
    // Latest completed appraisal and the count of appraisals still open.
    const lastReview = new Map<string, { date: string; rating: number | null }>();
    const openReviews = new Map<string, number>();
    for (const r of reviews.data ?? []) {
      const key = str(r["employee_id"]);
      if (str(r["status"]) === "completed") {
        const when = str(r["updated_at"]) || str(r["due_date"]) || str(r["created_at"]);
        const seen = lastReview.get(key);
        if (!seen || when > seen.date) {
          lastReview.set(key, {
            date: when,
            rating: r["final_rating"] == null ? null : Number(r["final_rating"]),
          });
        }
      } else {
        openReviews.set(key, (openReviews.get(key) ?? 0) + 1);
      }
    }

    const trainingDone = new Map<string, number>();
    const trainingOpen = new Map<string, number>();
    for (const p of training.data ?? []) {
      const key = str(p["employee_id"]);
      if (str(p["completion_status"]) === "completed") {
        trainingDone.set(key, (trainingDone.get(key) ?? 0) + 1);
      } else {
        trainingOpen.set(key, (trainingOpen.get(key) ?? 0) + 1);
      }
    }

    const attByEmployee = new Map<string, Row>();
    for (const a of attendance.data ?? []) attByEmployee.set(str(a["employee_id"]), a);

    const shiftByEmployee = new Map<string, Row>();
    for (const a of assignments.data ?? []) shiftByEmployee.set(str(a["employee_id"]), a);

    const leaveByEmployee = new Map<string, { entitled: number; remaining: number; unit: string }>();
    for (const b of balances.data ?? []) {
      const key = str(b["employee_id"]);
      const bucket = leaveByEmployee.get(key) ?? { entitled: 0, remaining: 0, unit: "days" };
      bucket.entitled += num(b["entitlement_days"]) + num(b["carried_forward_days"]);
      bucket.remaining += availableDays(b as never);
      leaveByEmployee.set(key, bucket);
    }

    const onLeave = new Map<string, string>();
    const leaveDays = new Map<string, number>();
    for (const r of requests.data ?? []) {
      if (str(r["status"]) !== "approved") continue;
      const key = str(r["employee_id"]);
      const covered = leaveDaysInWindow(r, windowFrom, day);
      if (covered > 0) leaveDays.set(key, (leaveDays.get(key) ?? 0) + covered);
      if (!coversToday(r, day)) continue;
      onLeave.set(key, str((r["leave_types"] as Row | undefined)?.["name"], "Leave"));
    }

    /** Rolling-window attendance figures, summed straight from the records. */
    type Kpi = {
      overtime: number;
      late: number;
      lateDays: number;
      absent: number;
      worked: number;
    };
    const kpi = new Map<string, Kpi>();
    for (const a of history.data ?? []) {
      const key = str(a["employee_id"]);
      const bucket = kpi.get(key) ?? { overtime: 0, late: 0, lateDays: 0, absent: 0, worked: 0 };
      const lateMin = num(a["late_minutes"]);
      bucket.overtime += num(a["overtime_minutes"]);
      bucket.late += lateMin;
      if (lateMin > 0) bucket.lateDays += 1;
      if (str(a["status"]) === "absent") bucket.absent += 1;
      if (num(a["worked_minutes"]) > 0) bucket.worked += 1;
      kpi.set(key, bucket);
    }


    return (employees.data ?? []).map((e) => {
      const id = str(e["id"]);
      const att = attByEmployee.get(id);
      const shift = shiftByEmployee.get(id);
      const template = (shift?.["shift_templates"] ?? null) as Row | null;
      const leave = leaveByEmployee.get(id);
      const leaveType = onLeave.get(id) ?? null;

      const clockIn = att ? (att["clock_in_at"] as string | null) : null;
      const clockOut = att ? (att["clock_out_at"] as string | null) : null;
      const attStatus = att ? str(att["status"]) : null;

      let shiftState: ShiftState = "off";
      if (leaveType) shiftState = "leave";
      else if (clockIn && !clockOut) shiftState = "on-shift";
      else if (clockOut) shiftState = "finished";
      else if (attStatus === "absent") shiftState = "absent";
      else if (shift) shiftState = "rostered";

      return {
        id,
        name: str(e["full_name"], "—"),
        number: str(e["employee_number"], "—"),
        jobTitle: str(e["job_title"], "—"),
        department: str((e["departments"] as Row | undefined)?.["name"], "—"),
        shiftLabel: template
          ? `${str(template["name"], "Shift")} · ${str(template["start_time"]).slice(0, 5)}–${str(
              template["end_time"],
            ).slice(0, 5)}`
          : null,
        shiftState,
        clockIn,
        clockOut,
        workedMinutes: att ? num(att["worked_minutes"]) : null,
        lateMinutes: att ? num(att["late_minutes"]) : 0,
        attendanceStatus: attStatus,
        leaveRemaining: leave?.remaining ?? 0,
        leaveEntitled: leave?.entitled ?? 0,
        leaveUnit: leave?.unit ?? "days",
        onLeaveType: leaveType,
        overtimeMinutes30: kpi.get(id)?.overtime ?? 0,
        lateMinutes30: kpi.get(id)?.late ?? 0,
        lateDays30: kpi.get(id)?.lateDays ?? 0,
        absentDays30: kpi.get(id)?.absent ?? 0,
        daysWorked30: kpi.get(id)?.worked ?? 0,
        leaveDaysApproved30: leaveDays.get(id) ?? 0,
        lastReviewDate: lastReview.get(id)?.date ?? null,
        lastReviewRating: lastReview.get(id)?.rating ?? null,
        openReviews: openReviews.get(id) ?? 0,
        trainingCompleted: trainingDone.get(id) ?? 0,
        trainingOutstanding: trainingOpen.get(id) ?? 0,
      };
    });
  }, [
    employees.data,
    attendance.data,
    history.data,
    assignments.data,
    balances.data,
    requests.data,
    reviews.data,
    training.data,
    day,
    windowFrom,
  ]);

  return {
    data,
    isLoading:
      employees.isLoading || attendance.isLoading || assignments.isLoading || balances.isLoading,
    error: employees.error ?? attendance.error ?? assignments.error ?? balances.error ?? null,
    refetch: () => {
      void employees.refetch();
      void attendance.refetch();
      void history.refetch();
      void assignments.refetch();
      void balances.refetch();
      void requests.refetch();
      void reviews.refetch();
      void training.refetch();
    },
  };
}

export const SHIFT_STATE_LABEL: Record<ShiftState, string> = {
  off: "Not rostered",
  rostered: "Rostered, not clocked in",
  "on-shift": "On shift",
  finished: "Shift finished",
  leave: "On leave",
  absent: "Absent",
};

export function shiftTone(
  state: ShiftState,
): "default" | "info" | "success" | "warning" | "destructive" {
  if (state === "on-shift") return "success";
  if (state === "finished") return "info";
  if (state === "leave") return "info";
  if (state === "absent") return "destructive";
  if (state === "rostered") return "warning";
  return "default";
}
