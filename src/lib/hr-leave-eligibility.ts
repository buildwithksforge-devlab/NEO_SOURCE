/**
 * Leave policy applicability.
 *
 * Entitlement answers "how many days"; applicability answers the earlier
 * question — "does this policy apply to this person at all". A policy may be
 * limited to employment types, departments, one property, a sex where the rule
 * is statutory (maternity, paternity), a minimum service period, and a date
 * range during which the policy is in force.
 *
 * A policy that sets none of those applies to everyone, so Annual and Sick
 * leave behave exactly as before.
 *
 * This module is a mirror of `neo_hr_leave_applicability` in the database so a
 * screen can explain itself before anything is submitted. The database repeats
 * every check on apply and when balances are calculated — the client copy is
 * never the authority.
 */

import type { Row } from "@/lib/hr";

export type Applicability = { eligible: boolean; reasons: string[] };

const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();

function asArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v)).filter((v) => v.trim() !== "");
}

function dayDiff(from: string, to: Date): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  if (Number.isNaN(a)) return 0;
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.floor((b - a) / 86_400_000);
}

const dateLabel = (iso: unknown) => {
  const d = new Date(`${String(iso)}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? String(iso)
    : d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
};

/**
 * Whether one employee qualifies for one leave policy on a given date, with
 * the reasons they do not.
 */
export function leaveApplicability(
  employee: Row | null | undefined,
  policy: Row | null | undefined,
  on: Date = new Date(),
): Applicability {
  if (!employee || !policy) return { eligible: false, reasons: ["Record not available"] };
  const reasons: string[] = [];

  if (policy["active"] === false) reasons.push("This leave policy is not active");

  const from = policy["effective_from"] ? String(policy["effective_from"]) : "";
  const to = policy["effective_to"] ? String(policy["effective_to"]) : "";
  const today = on.toISOString().slice(0, 10);
  if (from && today < from) reasons.push(`This policy starts on ${dateLabel(from)}`);
  if (to && today > to) reasons.push(`This policy ended on ${dateLabel(to)}`);

  const policyBranch = policy["branch_id"] ? String(policy["branch_id"]) : "";
  const employeeBranch = employee["branch_id"] ? String(employee["branch_id"]) : "";
  if (policyBranch && employeeBranch && policyBranch !== employeeBranch)
    reasons.push("This policy applies to another property");

  const departments = asArray(policy["department_ids"]);
  if (departments.length) {
    const dept = employee["department_id"] ? String(employee["department_id"]) : "";
    if (!dept || !departments.includes(dept))
      reasons.push("This policy applies to selected departments only");
  }

  const types = asArray(policy["employment_types"]).map(lower);
  if (types.length) {
    const type = lower(employee["employment_type"]) || "unset";
    if (!types.includes(type))
      reasons.push("This policy applies to selected employment types only");
  }

  const scope = lower(policy["gender_scope"]) || "any";
  if (scope !== "any") {
    const gender = lower(employee["gender"]);
    if (!gender)
      reasons.push(
        "This policy applies to a specific sex; the employee record does not record one",
      );
    else if (gender !== scope) reasons.push(`This policy applies to ${scope} staff only`);
  }

  const minimumDays = Number(policy["minimum_service_days"] ?? 0);
  if (minimumDays > 0) {
    const served = employee["employment_date"]
      ? dayDiff(String(employee["employment_date"]), on)
      : 0;
    if (served < minimumDays) reasons.push(`Requires ${minimumDays} day(s) of service`);
  }

  return { eligible: reasons.length === 0, reasons };
}

/** The policies one employee may actually apply under. */
export function eligibleLeavePolicies(
  employee: Row | null | undefined,
  policies: Row[],
  on: Date = new Date(),
): Row[] {
  return policies.filter((p) => leaveApplicability(employee, p, on).eligible);
}
