/**
 * Payroll journal.
 *
 * Finance sees the same per-employee figures HR prepared — basic pay,
 * allowances, bonuses, reimbursements, deductions and net pay — and posts them
 * to the books from here. The computation and the posting are the single
 * guarded routine payroll already uses, so the two screens can never disagree.
 */
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { FinanceEmpty, FinanceGuard, financeHead } from "@/components/finance/FinanceShared";
import { PayrollPostingPanel } from "@/components/hr/PayrollPostingPanel";
import { PayrollReconciliationPanel } from "@/components/hr/PayrollReconciliationPanel";
import { PayrollLedgerCard } from "@/components/hr/PayrollLedgerCard";
import { QueryState } from "@/components/hr/HrShared";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePayrollPeriods } from "@/lib/hr-data";
import { shortDate } from "@/lib/hr";

export const Route = createFileRoute("/_shell/finance/payroll-journal")({
  head: financeHead(
    "Payroll Journal",
    "Per-employee salary, allowances, deductions and net pay, with the posting that writes them to the books.",
  ),
  component: () => (
    <FinanceGuard feature="journals" action="view">
      <PayrollJournalScreen />
    </FinanceGuard>
  ),
});

function PayrollJournalScreen() {
  const periods = usePayrollPeriods();
  const [periodId, setPeriodId] = useState("");
  const list = periods.data ?? [];
  const active = list.find((p) => String(p["id"]) === periodId) ?? list[0];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="Payroll Journal"
        description="Payroll posts once per period. A posted period shows its journal reference and cannot be posted again."
      />

      <SectionCard title="Payroll period">
        <QueryState
          isLoading={periods.isLoading}
          error={periods.error}
          isEmpty={list.length === 0}
          empty={
            <FinanceEmpty
              title="No payroll periods"
              description="Human Resources opens a payroll period before it can be posted."
            />
          }
        >
          <div className="grid max-w-sm gap-2">
            <Label>Period</Label>
            <Select value={active ? String(active["id"]) : ""} onValueChange={setPeriodId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a payroll period" />
              </SelectTrigger>
              <SelectContent>
                {list.map((p) => (
                  <SelectItem key={String(p["id"])} value={String(p["id"])}>
                    {String(p["name"] ?? p["period_label"] ?? "Period")} · {shortDate(p["period_start"])} →{" "}
                    {shortDate(p["period_end"])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </QueryState>
      </SectionCard>

      <PayrollPostingPanel period={active} />

      <PayrollReconciliationPanel period={active} />

      <PayrollLedgerCard periods={list} />
    </div>
  );
}
