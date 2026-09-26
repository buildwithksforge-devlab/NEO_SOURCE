import { describe, expect, it } from "vitest";
import { buildPayslip, journalAgrees, payslipReleaseBlockers, payslipsReleased } from "@/lib/hr-payslips";
import type { PayrollComputationRow } from "@/lib/hr-payroll";

const row = {
  employee_id: "e1",
  full_name: "Lydia Chebet",
  currency: "KES",
  pay_frequency: "monthly",
  base_pay: 80000,
  allowances: 5000,
  bonuses: 0,
  reimbursements: 0,
  deductions: 12000,
  gross_pay: 85000,
  net_pay: 73000,
  missing_compensation: false,
} as unknown as PayrollComputationRow;

describe("payslips", () => {
  it("builds earnings and deductions without inventing lines", () => {
    const slip = buildPayslip(row, { worked_hours: 160, overtime_hours: null });
    expect(slip.earnings.map((l) => l.label)).toEqual(["Basic pay", "Allowances"]);
    expect(slip.deductions).toHaveLength(1);
    expect(slip.net).toBe(73000);
    expect(slip.workedHours).toBe(160);
    expect(slip.overtimeHours).toBeNull();
  });

  it("withholds payslips until payroll is posted to Finance and released", () => {
    expect(payslipReleaseBlockers({ status: "draft" })).toHaveLength(1);
    expect(payslipReleaseBlockers({ status: "approved" })).toHaveLength(1);
    expect(payslipReleaseBlockers({ status: "locked" })).toHaveLength(1);
    expect(
      payslipReleaseBlockers({
        status: "exported",
        posted_journal_id: "j1",
        posted_at: "2026-10-01T00:00:00Z",
      }),
    ).toHaveLength(0);
    expect(payslipsReleased({ payslips_released_at: null })).toBe(false);
    expect(payslipsReleased({ payslips_released_at: "2026-10-01T00:00:00Z" })).toBe(false);
    expect(
      payslipsReleased({
        status: "exported",
        posted_journal_id: "j1",
        posted_at: "2026-10-01T00:00:00Z",
        payslips_released_at: "2026-10-01T00:05:00Z",
      }),
    ).toBe(true);
  });

  it("only agrees when the ledger balances to payroll gross", () => {
    const totals = { gross: 85000, net: 73000, deductions: 12000 };
    expect(journalAgrees({ total_debit: 85000, total_credit: 85000 }, totals).agrees).toBe(true);
    expect(journalAgrees({ total_debit: 84000, total_credit: 84000 }, totals).agrees).toBe(false);
    expect(journalAgrees(null, totals).agrees).toBe(false);
  });
});
