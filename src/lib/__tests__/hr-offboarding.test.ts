/**
 * HR depth: record readiness and the offboarding safety contract.
 *
 * Two defects are guarded here:
 *  1. A reconciled employee record must never read as finished — missing
 *     human-entered facts stay visible and block payroll readiness.
 *  2. Ending employment must close system access without destroying HR
 *     history, and only a user with employee-edit authority may do it.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  READINESS_CHECKS,
  employeeReadiness,
  isPayrollApproved,
  workforceReadiness,
} from "@/lib/hr-readiness";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";

const complete: Record<string, unknown> = Object.fromEntries(
  READINESS_CHECKS.map((c) => [c.field, "recorded"]),
);

describe("employee record readiness", () => {
  it("treats a reconciled record with no employment terms as incomplete", () => {
    const r = employeeReadiness({ full_name: "A Person", branch_id: "b", department_id: "d" });
    expect(r.complete).toBe(false);
    expect(r.percent).toBeLessThan(100);
    expect(r.missing.map((m) => m.field)).toContain("employment_date");
    expect(r.missing.map((m) => m.field)).toContain("employment_type");
  });

  it("never reports payroll ready while a payroll-blocking fact is missing", () => {
    const r = employeeReadiness({ ...complete, employment_date: null, payroll_status: "ready" });
    expect(r.payrollReady).toBe(false);
    expect(r.label).toBe("Not payroll ready");
    expect(r.payrollBlockers.map((m) => m.field)).toContain("employment_date");
  });

  it("counts payroll enrolment as a tracked fact and needs a human approval", () => {
    const withoutApproval = employeeReadiness({ ...complete, payroll_status: "not_ready" });
    expect(withoutApproval.complete).toBe(false);
    expect(withoutApproval.payrollReady).toBe(false);
    expect(withoutApproval.missing.map((m) => m.field)).toContain("payroll_status");

    const approved = employeeReadiness({ ...complete, payroll_status: "ready" });
    expect(approved.payrollReady).toBe(true);
    expect(approved.complete).toBe(true);
    expect(approved.percent).toBe(100);
    expect(approved.label).toBe("Complete");
  });

  it("raises the completion percentage when someone is put on payroll", () => {
    const base = { ...complete, payroll_status: "not_ready" };
    const before = employeeReadiness(base).percent;
    const after = employeeReadiness({ ...base, payroll_status: "active" }).percent;
    expect(after).toBeGreaterThan(before);
  });

  it("counts blank strings as missing rather than recorded", () => {
    const r = employeeReadiness({ ...complete, job_title: "   " });
    expect(r.missing.map((m) => m.field)).toContain("job_title");
  });

  it("only accepts an explicit payroll approval state", () => {
    expect(isPayrollApproved({ payroll_status: "ready" })).toBe(true);
    expect(isPayrollApproved({ payroll_status: "not_ready" })).toBe(false);
    expect(isPayrollApproved({})).toBe(false);
  });

  it("rolls the directory up without counting leavers as outstanding work", () => {
    const roll = workforceReadiness([
      { ...complete, payroll_status: "ready" },
      { full_name: "Incomplete" },
      { ...complete, employment_status: "exited" },
    ]);
    expect(roll.total).toBe(2);
    expect(roll.exited).toBe(1);
    expect(roll.complete).toBe(1);
    expect(roll.payrollReady).toBe(1);
    // Incomplete is the plain complement of complete — never 0 while a row is short.
    expect(roll.incomplete).toBe(1);
    expect(roll.notPayrollReady).toBe(1);
  });
});

describe("offboarding contract", () => {
  const sql = readFileSync(
    join(process.cwd(), "src/lib/__tests__/fixtures/hr-offboarding.sql"),
    "utf8",
  );

  it("is registered as an authenticated RPC, not a public one", () => {
    expect(RPC_MANIFEST["neo_hr_offboard_employee"]).toBe("authenticated");
  });

  it("refuses an offboarding without employee-edit authority", () => {
    expect(sql).toContain("has_permission('hr-employees', 'edit')");
    expect(sql).toContain("Not authorised to offboard an employee");
  });

  it("removes live system access when access revocation is requested", () => {
    expect(sql).toContain("DELETE FROM public.user_roles");
    expect(sql).toContain("account_status = 'inactive'");
  });

  it("keeps the HR record and writes the separation to history", () => {
    expect(sql).not.toMatch(/DELETE FROM public\.employees/);
    expect(sql).toContain("INSERT INTO public.employment_history");
    expect(sql).toContain("employee_exit_clearances");
    expect(sql).toContain("'hr.employee.offboarded'");
  });

  it("never leaves a leaver payroll-ready and is safe to repeat", () => {
    expect(sql).toContain("payroll_status = 'not_ready'");
    expect(sql).toContain("already_exited");
  });
});
