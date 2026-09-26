/**
 * Payslips.
 *
 * A payslip is never a separate calculation: it is the same guarded period
 * computation that the posting routine uses, broken out per person and paired
 * with that person's verified attendance and leave inputs. Nothing is invented
 * here — a figure that has not been entered stays blank.
 *
 * Payslips are withheld until the period has posted to Finance and an
 * authorised person releases them; the release is written to the audit trail.
 * A release timestamp alone is never enough to expose a payslip.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { guardedRpc } from "@/lib/rpc-guard";
import type { Row } from "@/lib/hr";
import type { PayrollComputationRow } from "@/lib/hr-payroll";

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = supabase as any;

export type PayslipLine = { label: string; amount: number; kind: "earning" | "deduction" };

export type Payslip = {
  employee_id: string;
  /** The saved payroll record this payslip was built from, when one exists.
   *  The branded payslip document prints from that record, never from screen state. */
  record_id: string | null;
  full_name: string;
  currency: string;
  pay_frequency: string;
  base_pay: number;
  earnings: PayslipLine[];
  deductions: PayslipLine[];
  gross: number;
  totalDeductions: number;
  net: number;
  missing_compensation: boolean;
  workedHours: number | null;
  overtimeHours: number | null;
  paidLeaveDays: number | null;
  unpaidLeaveDays: number | null;
};

/** Build one person's payslip from the period computation and their inputs. */
export function buildPayslip(row: PayrollComputationRow, input?: Row | null): Payslip {
  const earnings: PayslipLine[] = [
    { label: "Basic pay", amount: Number(row.base_pay ?? 0), kind: "earning" },
  ];
  if (Number(row.allowances ?? 0) !== 0)
    earnings.push({ label: "Allowances", amount: Number(row.allowances), kind: "earning" });
  if (Number(row.bonuses ?? 0) !== 0)
    earnings.push({
      label: "Bonuses and commission",
      amount: Number(row.bonuses),
      kind: "earning",
    });
  if (Number(row.reimbursements ?? 0) !== 0)
    earnings.push({ label: "Reimbursements", amount: Number(row.reimbursements), kind: "earning" });

  const deductions: PayslipLine[] = [];
  if (Number(row.deductions ?? 0) !== 0)
    deductions.push({ label: "Deductions", amount: Number(row.deductions), kind: "deduction" });

  const num = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);

  const recordId = input?.["id"];
  return {
    employee_id: row.employee_id,
    record_id: typeof recordId === "string" ? recordId : null,
    full_name: row.full_name,
    currency: row.currency ?? "KES",
    pay_frequency: row.pay_frequency ?? "",
    base_pay: Number(row.base_pay ?? 0),
    earnings,
    deductions,
    gross: Number(row.gross_pay ?? 0),
    totalDeductions: Number(row.deductions ?? 0),
    net: Number(row.net_pay ?? 0),
    missing_compensation: Boolean(row.missing_compensation),
    workedHours: num(input?.["worked_hours"]),
    overtimeHours: num(input?.["overtime_hours"]),
    paidLeaveDays: num(input?.["paid_leave_days"]),
    unpaidLeaveDays: num(input?.["unpaid_leave_days"]),
  };
}

/** Whether a period's payslips may be shown to staff. */
export function payslipsReleased(period: Row | null | undefined): boolean {
  return Boolean(
    period?.["payslips_released_at"] &&
      period?.["posted_journal_id"] &&
      period?.["posted_at"] &&
      String(period?.["status"] ?? "") === "exported",
  );
}

export function payslipReleaseBlockers(period: Row | null | undefined): string[] {
  const blockers: string[] = [];
  if (!period) return ["Choose a payroll period first."];
  const status = String(period["status"] ?? "");
  if (status !== "exported" || !period["posted_journal_id"] || !period["posted_at"])
    blockers.push("Post this payroll to Finance before releasing payslips.");
  return blockers;
}

/** Release, or withdraw, the payslips of one period. */
export function useReleasePayslips() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { periodId: string; release: boolean }) => {
      const { data, error } = await guardedRpc(db, "neo_hr_payroll_release_payslips", {
        _period: input.periodId,
        _release: input.release,
      });
      if (error) throw error;
      return { ...input, result: data };
    },
    onSuccess: async (input) => {
      void qc.invalidateQueries({ queryKey: ["hr"] });
      toast.success(
        input.release
          ? "Payslips released — staff can now see their own payslip"
          : "Payslips withdrawn from staff view",
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/** The journal a payroll period posted, with its lines, for checking against the ledger. */
export function usePostedPayrollJournal(journalId?: string | null) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["hr", "payroll_journal", organizationId, journalId ?? ""],
    enabled: Boolean(organizationId) && Boolean(journalId),
    queryFn: async () => {
      const { data, error } = await db
        .from("journal_entries")
        .select(
          "id, journal_number, accounting_date, status, total_debit, total_credit, journal_entry_lines(id, debit, credit, description, chart_of_accounts(code, name))",
        )
        .eq("id", journalId)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as Row | null;
    },
  });
}

/** Does what posted to the ledger match what payroll priced? */
export function journalAgrees(
  journal: Row | null | undefined,
  totals: { gross: number; net: number; deductions: number },
): { agrees: boolean; debit: number; credit: number; expected: number } {
  const debit = Number(journal?.["total_debit"] ?? 0);
  const credit = Number(journal?.["total_credit"] ?? 0);
  const expected = Number(totals.gross ?? 0);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    agrees:
      Boolean(journal) &&
      round(debit) === round(credit) &&
      round(debit) === round(expected) &&
      round(totals.net + totals.deductions) === round(expected),
    debit,
    credit,
    expected,
  };
}

/**
 * A person's own payslips. Only periods whose payslips have been released are
 * visible, and the database enforces the same rule.
 */
export function useMyPayslips(employeeId?: string | null) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["hr", "my_payslips", organizationId, employeeId ?? ""],
    enabled: Boolean(organizationId) && Boolean(employeeId),
    queryFn: async () => {
      const { data, error } = await db
        .from("payroll_input_records")
        .select(
          "id, base_pay, gross_pay, net_pay, deductions, allowances, bonuses, reimbursements, currency, worked_hours, overtime_hours, paid_leave_days, unpaid_leave_days, payroll_periods(id, name, period_start, period_end, status, posted_journal_id, posted_at, payslips_released_at)",
        )
        .eq("employee_id", employeeId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return ((data ?? []) as Row[]).filter((r) =>
        payslipsReleased(r["payroll_periods"] as Row | null),
      );
    },
  });
}
