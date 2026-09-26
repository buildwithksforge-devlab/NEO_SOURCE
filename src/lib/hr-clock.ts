/**
 * Clock in / clock out arithmetic and the reads the clock screen needs.
 *
 * The attendance record written by the clock is the same record HR reads, so
 * there is no second store of times. Scheduled hours come from the published
 * roster; anything worked beyond them is shown as *unapproved* extra time and
 * must still be raised and approved as overtime before payroll sees it. No
 * time is ever inferred: with no published shift, scheduled hours are simply
 * unknown and the screen says so.
 */

import { useHrList } from "@/lib/hr-data";
import { today, type Row } from "@/lib/hr";

/** Minutes between a clock-in instant and now (never negative). */
export function elapsedMinutes(clockInAt: unknown, now: Date = new Date()): number {
  if (!clockInAt) return 0;
  const started = new Date(String(clockInAt)).getTime();
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.round((now.getTime() - started) / 60000));
}

function timeToMinutes(value: unknown): number | null {
  const text = String(value ?? "");
  const match = /^(\d{1,2}):(\d{2})/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

/** Length of a shift in minutes, handling shifts that run past midnight. */
export function shiftMinutes(startTime: unknown, endTime: unknown): number | null {
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  if (start === null || end === null) return null;
  const span = end >= start ? end - start : 24 * 60 - start + end;
  return span;
}

/** Scheduled minutes for a roster assignment, or null when nothing is published. */
export function scheduledMinutes(assignment: Row | null | undefined): number | null {
  if (!assignment) return null;
  const template = assignment["shift_templates"] as Row | undefined;
  const direct = shiftMinutes(assignment["start_time"], assignment["end_time"]);
  if (direct !== null) return direct;
  return shiftMinutes(template?.["start_time"], template?.["end_time"]);
}

/** Minutes worked beyond the published shift. Unknown schedule means no claim. */
export function extraMinutes(worked: number, scheduled: number | null): number {
  if (scheduled === null) return 0;
  return Math.max(0, worked - scheduled);
}

export type ClockState = "off" | "on_shift" | "over_schedule";

export function clockState(open: Row | null, scheduled: number | null, now = new Date()): ClockState {
  if (!open) return "off";
  return extraMinutes(elapsedMinutes(open["clock_in_at"], now), scheduled) > 0
    ? "over_schedule"
    : "on_shift";
}

/* ------------------------------- reads ---------------------------------- */

/** Today's published shift for one employee, if a roster covers today. */
export function useMyShiftToday(employeeId?: string) {
  return useHrList(
    "roster_assignments",
    "*, shift_templates(name, start_time, end_time), rosters(status, name)",
    (q) => q.eq("employee_id", employeeId).eq("shift_date", today()),
    ["clock-shift", employeeId ?? "none"],
    Boolean(employeeId),
  );
}

/** Recent attendance for one employee, most recent first. */
export function useMyAttendance(employeeId: string | undefined, days = 14) {
  const from = new Date();
  from.setDate(from.getDate() - days);
  const fromDate = from.toISOString().slice(0, 10);
  return useHrList(
    "attendance_records",
    "*",
    (q) => q.eq("employee_id", employeeId).gte("work_date", fromDate).order("work_date", { ascending: false }),
    ["clock-history", employeeId ?? "none", fromDate],
    Boolean(employeeId),
  );
}

/** Overtime claims raised by one employee. */
export function useMyOvertime(employeeId?: string) {
  return useHrList(
    "overtime_requests",
    "*",
    (q) => q.eq("employee_id", employeeId).order("overtime_date", { ascending: false }).limit(20),
    ["clock-overtime", employeeId ?? "none"],
    Boolean(employeeId),
  );
}
