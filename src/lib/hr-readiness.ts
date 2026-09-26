/**
 * HR record readiness.
 *
 * The directory can be reconciled from staff accounts, but a reconciled record
 * is deliberately incomplete: employment dates, contract terms, grade, the
 * reporting line and statutory identifiers are human-entered facts and the
 * system never guesses them. This module states, per employee, exactly which
 * of those facts are still missing so HR sees "Needs completion" instead of a
 * plausible-looking but invented record.
 *
 * Pure functions only — no database access — so the rules are testable and the
 * same wording is used everywhere the readiness is shown.
 */

import type { Row } from "@/lib/hr";

export type ReadinessSectionKey = "identity" | "assignment" | "employment" | "payroll" | "access";

export type ReadinessItem = {
  section: ReadinessSectionKey;
  field: string;
  label: string;
  /** Blocks payroll from being run for this employee. */
  blocksPayroll: boolean;
};

export type EmployeeReadiness = {
  complete: boolean;
  /** 0–100, share of tracked facts present. */
  percent: number;
  missing: ReadinessItem[];
  /** Missing facts that must exist before payroll can include this person. */
  payrollBlockers: ReadinessItem[];
  payrollReady: boolean;
  /** Plain-language state for a badge. */
  label: "Complete" | "Needs completion" | "Not payroll ready";
  tone: "success" | "warning" | "destructive";
};

export const READINESS_SECTION_LABELS: Record<ReadinessSectionKey, string> = {
  identity: "Personal details",
  assignment: "Placement",
  employment: "Employment terms",
  payroll: "Payroll readiness",
  access: "System access",
};

type Check = {
  section: ReadinessSectionKey;
  field: string;
  label: string;
  blocksPayroll: boolean;
  /** Custom presence rule when a non-empty value is not the same as "recorded". */
  isPresent?: (value: unknown, employee: Row) => boolean;
};

/**
 * The facts a complete employee record must carry. Every one of them is
 * entered by a person — nothing here can be derived, so nothing here is ever
 * auto-filled.
 */
export const READINESS_CHECKS: Check[] = [
  { section: "identity", field: "full_name", label: "Full name", blocksPayroll: true },
  { section: "identity", field: "phone", label: "Contact number", blocksPayroll: false },
  { section: "identity", field: "work_email", label: "Work email", blocksPayroll: false },
  { section: "assignment", field: "branch_id", label: "Branch", blocksPayroll: true },
  { section: "assignment", field: "department_id", label: "Department", blocksPayroll: true },
  { section: "assignment", field: "job_title", label: "Job title", blocksPayroll: true },
  { section: "assignment", field: "reporting_manager_id", label: "Reporting line", blocksPayroll: false },
  { section: "employment", field: "employment_type", label: "Employment type", blocksPayroll: true },
  { section: "employment", field: "employment_date", label: "Employment date", blocksPayroll: true },
  { section: "employment", field: "position_grade", label: "Position grade", blocksPayroll: false },
  { section: "employment", field: "contract_start", label: "Contract start", blocksPayroll: false },
  {
    section: "payroll",
    field: "payroll_status",
    label: "Payroll enrolment",
    blocksPayroll: false,
    isPresent: (_value, employee) => isPayrollApproved(employee),
  },
  {
    section: "payroll",
    field: "payroll_effective_from",
    label: "Payroll effective date",
    blocksPayroll: false,
  },
];

function present(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

/** True when the record has been marked payroll-ready by a person. */
export function isPayrollApproved(employee: Row | null | undefined): boolean {
  const status = String(employee?.["payroll_status"] ?? "").toLowerCase();
  return status === "ready" || status === "active" || status === "approved";
}

export function employeeReadiness(employee: Row | null | undefined): EmployeeReadiness {
  const record = employee ?? {};
  const missing: ReadinessItem[] = READINESS_CHECKS.filter((c) =>
    c.isPresent ? !c.isPresent(record[c.field], record) : !present(record[c.field]),
  ).map((c) => ({
    section: c.section,
    field: c.field,
    label: c.label,
    blocksPayroll: c.blocksPayroll,
  }));

  const payrollBlockers = missing.filter((m) => m.blocksPayroll);
  const complete = missing.length === 0;
  const percent = Math.round(((READINESS_CHECKS.length - missing.length) / READINESS_CHECKS.length) * 100);
  const payrollReady = payrollBlockers.length === 0 && isPayrollApproved(record);

  const label: EmployeeReadiness["label"] = complete
    ? "Complete"
    : payrollBlockers.length > 0
      ? "Not payroll ready"
      : "Needs completion";

  return {
    complete,
    percent,
    missing,
    payrollBlockers,
    payrollReady,
    label,
    tone: complete ? "success" : payrollBlockers.length > 0 ? "destructive" : "warning",
  };
}

/**
 * Directory-level rollup.
 *
 * Four separate facts, never collapsed into one status:
 * - `complete` / `incomplete` — is every tracked employment fact recorded?
 * - `payrollReady` / `notPayrollReady` — is this person actually enrolled in
 *   payroll (approved status) with no fact missing that payroll depends on?
 * - `noAccess` — is there a login account linked to the record?
 * - `exited` — employment status, reported separately and never counted as
 *   outstanding work.
 */
export function workforceReadiness(employees: Row[]): {
  /** Active (non-exited) records in the supplied set. */
  total: number;
  exited: number;
  complete: number;
  /** Every active record below 100% — the plain complement of `complete`. */
  incomplete: number;
  notPayrollReady: number;
  payrollReady: number;
  /** Not payroll ready purely because nobody has enrolled them yet. */
  notEnrolled: number;
  /** Not payroll ready because a fact payroll depends on is still missing. */
  payrollBlocked: number;
  noAccess: number;
} {
  const exited = employees.filter((e) => String(e["employment_status"] ?? "") === "exited").length;
  const active = employees.filter((e) => String(e["employment_status"] ?? "") !== "exited");
  let complete = 0;
  let payrollReady = 0;
  let notEnrolled = 0;
  let payrollBlocked = 0;
  let noAccess = 0;
  for (const e of active) {
    const r = employeeReadiness(e);
    if (r.complete) complete += 1;
    if (r.payrollReady) payrollReady += 1;
    else if (r.payrollBlockers.length > 0) payrollBlocked += 1;
    else notEnrolled += 1;
    if (!e["profile_id"]) noAccess += 1;
  }
  return {
    total: active.length,
    exited,
    complete,
    incomplete: active.length - complete,
    notPayrollReady: active.length - payrollReady,
    payrollReady,
    notEnrolled,
    payrollBlocked,
    noAccess,
  };
}

/**
 * A display field that is holding an email address instead of its own value —
 * seen on records created by earlier account provisioning. Flagged so HR can
 * correct them by hand; nothing is rewritten automatically.
 */
export function looksLikeEmail(value: unknown): boolean {
  return typeof value === "string" && /\S+@\S+\.\S+/.test(value);
}

/** Display fields on this record that are provably holding the wrong value. */
export function malformedFields(employee: Row | null | undefined): string[] {
  const out: string[] = [];
  if (looksLikeEmail(employee?.["full_name"])) out.push("Full name");
  if (looksLikeEmail(employee?.["job_title"])) out.push("Job title");
  return out;
}

/** Short sentence for a tooltip or a caption. */
export function readinessSummary(readiness: EmployeeReadiness): string {
  if (readiness.complete) return "All tracked employment facts are recorded.";
  const names = readiness.missing.map((m) => m.label);
  const head = names.slice(0, 3).join(", ");
  const rest = names.length > 3 ? ` and ${names.length - 3} more` : "";
  return `Still needs: ${head}${rest}.`;
}
