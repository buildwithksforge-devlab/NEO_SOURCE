/**
 * Phase 13 — Human Resources & Workforce Management vocabulary.
 *
 * IDENTITY SEPARATION (non-negotiable):
 *  - `customers`        → guests and clients. Never an employee.
 *  - `employees`        → the HR record of a person employed by the organization.
 *  - `profiles`         → the login account that can sign in to the platform.
 * An employee record may optionally be linked to exactly one login account
 * (`employees.profile_id`), but the two are never the same object and an
 * employee can exist with no system access at all.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Row = Record<string, any>;

export type Tone = "default" | "success" | "warning" | "info" | "destructive";

/* ------------------------------ formatting ------------------------------ */

export function titleCase(value: unknown): string {
  return String(value ?? "")
    .replace(/[-_.]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function shortDate(value: unknown): string {
  if (!value) return "—";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function shortDateTime(value: unknown): string {
  if (!value) return "—";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function clockTime(value: unknown): string {
  if (!value) return "—";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function hoursFromMinutes(minutes: unknown): string {
  const m = Math.max(0, Math.round(num(minutes)));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function initials(name: unknown): string {
  return String(name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function daysBetween(from: unknown, to: unknown): number {
  const a = new Date(String(from)).getTime();
  const b = new Date(String(to)).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000) + 1);
}

/* ------------------------------ vocabulary ------------------------------ */

export const EMPLOYMENT_TYPES = [
  { key: "permanent", label: "Permanent" },
  { key: "contract", label: "Contract" },
  { key: "casual", label: "Casual" },
  { key: "part_time", label: "Part Time" },
  { key: "intern", label: "Intern" },
  { key: "probation", label: "Probation" },
  { key: "seasonal", label: "Seasonal" },
] as const;

export const EMPLOYMENT_STATUSES = [
  { key: "onboarding", label: "Onboarding", tone: "info" },
  { key: "probation", label: "On Probation", tone: "warning" },
  { key: "active", label: "Active", tone: "success" },
  { key: "suspended", label: "Suspended", tone: "destructive" },
  { key: "on_leave", label: "On Leave", tone: "info" },
  { key: "notice", label: "Serving Notice", tone: "warning" },
  { key: "exited", label: "Exited", tone: "default" },
] as const;

export const ATTENDANCE_STATUSES = [
  { key: "in_progress", label: "On Shift", tone: "info" },
  { key: "pending_review", label: "Pending Review", tone: "warning" },
  { key: "approved", label: "Approved", tone: "success" },
  { key: "incomplete", label: "Incomplete", tone: "destructive" },
  { key: "absent", label: "Absent", tone: "destructive" },
] as const;

export const LEAVE_STATUSES = [
  { key: "draft", label: "Draft", tone: "default" },
  { key: "submitted", label: "Awaiting Supervisor", tone: "warning" },
  { key: "supervisor_approved", label: "Awaiting HR", tone: "warning" },
  { key: "approved", label: "Approved", tone: "success" },
  { key: "rejected", label: "Rejected", tone: "destructive" },
  { key: "cancelled", label: "Cancelled", tone: "default" },
] as const;

export const VACANCY_STATUSES = [
  { key: "draft", label: "Draft", tone: "default" },
  { key: "pending_approval", label: "Pending Approval", tone: "warning" },
  { key: "approved", label: "Approved", tone: "info" },
  { key: "open", label: "Open", tone: "success" },
  { key: "shortlisting", label: "Shortlisting", tone: "info" },
  { key: "closed", label: "Closed", tone: "default" },
  { key: "filled", label: "Filled", tone: "success" },
] as const;

export const CANDIDATE_STAGES = [
  { key: "applied", label: "Applied", tone: "default" },
  { key: "screening", label: "Screening", tone: "info" },
  { key: "shortlisted", label: "Shortlisted", tone: "info" },
  { key: "interviewing", label: "Interviewing", tone: "warning" },
  { key: "offer", label: "Offer", tone: "warning" },
  { key: "hired", label: "Hired", tone: "success" },
  { key: "rejected", label: "Rejected", tone: "destructive" },
  { key: "withdrawn", label: "Withdrawn", tone: "default" },
] as const;

export const REVIEW_STATUSES = [
  { key: "draft", label: "Draft", tone: "default" },
  { key: "self_assessment", label: "Self Assessment", tone: "info" },
  { key: "supervisor_review", label: "Supervisor Review", tone: "warning" },
  { key: "calibration", label: "Calibration", tone: "warning" },
  { key: "completed", label: "Completed", tone: "success" },
] as const;

export const PAYROLL_STATUSES = [
  { key: "draft", label: "Draft", tone: "default" },
  { key: "hr_review", label: "HR Review", tone: "warning" },
  { key: "approved", label: "Approved", tone: "success" },
  { key: "locked", label: "Locked", tone: "info" },
  { key: "exported", label: "Exported", tone: "success" },
] as const;

type Vocab = readonly { key: string; label: string; tone?: string }[];

export function labelFor(vocab: Vocab, key: unknown, fallback?: string): string {
  return vocab.find((v) => v.key === key)?.label ?? fallback ?? titleCase(key);
}

export function toneFor(vocab: Vocab, key: unknown): Tone {
  return (vocab.find((v) => v.key === key)?.tone as Tone) ?? "default";
}

/* ------------------------------ HR modules ------------------------------ */

export const HR_MODULES = {
  employees: "hr-employees",
  recruitment: "hr-recruitment",
  attendance: "hr-attendance",
  scheduling: "hr-scheduling",
  leave: "hr-leave",
  performance: "hr-performance",
  training: "hr-training",
  payroll: "hr-payroll",
  reports: "hr-reports",
  announcements: "hr-announcements",
} as const;

/* --------------------------- advisory AI panel --------------------------- */

export type HrInsight = { title: string; detail: string; tone: Tone };

/**
 * Deterministic workforce advisories. Advisory only — the assistant never
 * approves leave, alters attendance, decides hiring or changes pay.
 */
export function workforceInsights(input: {
  openShifts: number;
  pendingLeave: number;
  attendanceExceptions: number;
  expiringCertificates: number;
  probationDue: number;
  contractsExpiring: number;
}): HrInsight[] {
  const out: HrInsight[] = [];
  if (input.openShifts > 0)
    out.push({
      title: `${input.openShifts} unfilled shift${input.openShifts === 1 ? "" : "s"}`,
      detail: "Published rosters still contain open shifts. Assign cover or publish them for pick-up.",
      tone: "warning",
    });
  if (input.attendanceExceptions > 0)
    out.push({
      title: `${input.attendanceExceptions} attendance exception${input.attendanceExceptions === 1 ? "" : "s"}`,
      detail: "Missed clock-outs and late arrivals must be resolved before the payroll period is locked.",
      tone: "destructive",
    });
  if (input.pendingLeave > 0)
    out.push({
      title: `${input.pendingLeave} leave request${input.pendingLeave === 1 ? "" : "s"} awaiting decision`,
      detail: "Delayed decisions push staffing risk into the roster. Review with department cover in mind.",
      tone: "warning",
    });
  if (input.expiringCertificates > 0)
    out.push({
      title: `${input.expiringCertificates} certification${input.expiringCertificates === 1 ? "" : "s"} expiring`,
      detail: "Food handling and safety certificates lapse soon. Schedule renewals to stay compliant.",
      tone: "warning",
    });
  if (input.probationDue > 0)
    out.push({
      title: `${input.probationDue} probation review${input.probationDue === 1 ? "" : "s"} due`,
      detail: "Confirm, extend or end probation before the end date to avoid automatic confirmation disputes.",
      tone: "info",
    });
  if (input.contractsExpiring > 0)
    out.push({
      title: `${input.contractsExpiring} contract${input.contractsExpiring === 1 ? "" : "s"} expiring`,
      detail: "Start renewal or exit planning now so departments are not left short-staffed.",
      tone: "info",
    });
  if (!out.length)
    out.push({
      title: "Workforce operating normally",
      detail: "No unfilled shifts, unresolved attendance exceptions or overdue HR actions detected.",
      tone: "success",
    });
  return out;
}
