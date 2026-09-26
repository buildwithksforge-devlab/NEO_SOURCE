/**
 * Salary slip.
 *
 * The employee-facing view of one pay period, printed on the canonical NEØ
 * document template. Every money figure comes from the same guarded payroll
 * routine that posts the period to the books, and the day and overtime counts
 * come from the payroll inputs HR prepared from approved attendance and leave.
 * Nothing here is recalculated or estimated.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DocumentPreview } from "@/components/documents/DocumentPreview";
import { supabase } from "@/integrations/supabase/client";
import { formatMoneyExact } from "@/lib/money-format";
import { shortDate, titleCase, type Row } from "@/lib/hr";
import type { PayrollComputationRow } from "@/lib/hr-payroll";

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = supabase as any;

function useSlipInputs(periodId: string | null, employeeId: string | null) {
  return useQuery({
    queryKey: ["hr", "payroll-slip-input", periodId ?? "", employeeId ?? ""],
    enabled: Boolean(periodId && employeeId),
    queryFn: async () => {
      const { data, error } = await db
        .from("payroll_input_records")
        .select("*")
        .eq("period_id", periodId)
        .eq("employee_id", employeeId)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as Row | null;
    },
  });
}

const num = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export function SalarySlipBody({
  period,
  employee,
}: {
  period: Row;
  employee: PayrollComputationRow;
}) {
  const inputs = useSlipInputs(String(period["id"]), employee.employee_id);
  const currency = employee.currency || "KES";
  const input = inputs.data;

  const earnings = [
    { key: "basic", label: "Basic pay", amount: employee.base_pay },
    { key: "allowances", label: "Allowances", amount: employee.allowances },
    { key: "bonuses", label: "Bonuses", amount: employee.bonuses },
    { key: "reimbursements", label: "Reimbursements", amount: employee.reimbursements },
  ].filter((line) => line.amount !== 0);

  const rows = [
    ...earnings.map((line) => ({
      item: line.label,
      type: "Earning",
      amount: formatMoneyExact(line.amount, currency),
    })),
    ...(employee.deductions
      ? [
          {
            item: "Deductions",
            type: "Deduction",
            amount: `- ${formatMoneyExact(employee.deductions, currency)}`,
          },
        ]
      : []),
  ];

  const posted = Boolean(period["posted_journal_id"]);

  return (
    <DocumentPreview
      documentType="Salary slip"
      numberLabel="Pay period"
      documentNumber={String(period["name"] ?? "Pay period")}
      meta={[
        {
          label: "Period",
          value: `${shortDate(period["period_start"])} → ${shortDate(period["period_end"])}`,
        },
        { label: "Pay frequency", value: titleCase(employee.pay_frequency || "—") },
        { label: "Currency", value: currency },
        {
          label: "Posting",
          value: posted ? `Posted ${shortDate(period["posted_at"])}` : "Not yet posted",
        },
      ]}
      addressedTo={{
        title: "Paid to",
        lines: [
          employee.full_name,
          input?.["cost_centre"] ? `Cost centre ${String(input["cost_centre"])}` : "",
          input
            ? `Worked ${num(input["worked_days"])} of ${num(input["scheduled_days"])} scheduled days`
            : "Attendance inputs not prepared for this period",
          input ? `Overtime ${num(input["overtime_hours"])} hours` : "",
          input
            ? `Paid leave ${num(input["paid_leave_days"])} days · unpaid ${num(input["unpaid_leave_days"])} days`
            : "",
          input ? `Absence ${num(input["absence_days"])} days · lateness ${num(input["late_minutes"])} minutes` : "",
        ].filter(Boolean),
      }}
      columns={[
        { key: "item", label: "Item" },
        { key: "type", label: "Type" },
        { key: "amount", label: "Amount", align: "right" },
      ]}
      rows={rows}
      totals={[
        { label: "Gross pay", value: formatMoneyExact(employee.gross_pay, currency) },
        { label: "Total deductions", value: formatMoneyExact(employee.deductions, currency) },
      ]}
      headline={{ label: "Net pay", value: formatMoneyExact(employee.net_pay, currency) }}
      notes={
        employee.missing_compensation
          ? "This employee has no pay record on their profile, so this slip is incomplete until HR records their pay."
          : posted
            ? "These figures are the ones posted to the finance books for this period."
            : "These figures are the ones that will post to the finance books when this period is posted."
      }
      notesLabel="Payroll note"
      emptyMessage="No pay figures have been recorded for this employee in this period."
    />
  );
}

export function SalarySlipDialog({
  period,
  employee,
  onOpenChange,
}: {
  period: Row | null;
  employee: PayrollComputationRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = Boolean(period && employee);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl" data-salary-slip-dialog>
        <DialogHeader>
          <DialogTitle>
            Salary slip{employee ? ` · ${employee.full_name}` : ""}
          </DialogTitle>
          <DialogDescription>
            One pay period on the active property&apos;s branding, from the figures payroll posts.
          </DialogDescription>
        </DialogHeader>
        {period && employee ? <SalarySlipBody period={period} employee={employee} /> : null}
      </DialogContent>
    </Dialog>
  );
}
