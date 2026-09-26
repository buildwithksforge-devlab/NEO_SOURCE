/**
 * Payslips.
 *
 * Every figure shown here comes from the same guarded period computation that
 * posts payroll to the finance books, so a payslip, the posting preview and the
 * ledger cannot disagree. Payslips stay withheld from staff until the period is
 * posted to Finance and someone with payroll approval releases them.
 */

import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Send, Undo2 } from "lucide-react";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import { DocumentPrintButton } from "@/components/common/DocumentPrintButton";
import { EmptyState, HrBadge, HrGuard, QueryState } from "@/components/hr/HrShared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import { formatMoneyExact } from "@/lib/money-format";
import { usePayrollInputs, usePayrollPeriods } from "@/lib/hr-data";
import { payrollTotals, usePayrollComputation } from "@/lib/hr-payroll";
import {
  buildPayslip,
  payslipReleaseBlockers,
  payslipsReleased,
  useReleasePayslips,
  type Payslip,
} from "@/lib/hr-payslips";
import { HR_MODULES, shortDate, shortDateTime, type Row } from "@/lib/hr";

export const Route = createFileRoute("/_shell/hr/payslips")({
  head: () => ({
    meta: [
      { title: "Payslips — NEØ Human Resources" },
      {
        name: "description",
        content:
          "Each employee's basic pay, earnings, deductions and net pay for a payroll period, with release routing.",
      },
      { property: "og:title", content: "Payslips — NEØ Human Resources" },
      {
        property: "og:description",
        content: "Period payslips built from the same figures that post to the finance books.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <HrGuard module={HR_MODULES.payroll} action="inputs.view">
      <PayslipsScreen />
    </HrGuard>
  ),
});

function PayslipsScreen() {
  const { can } = useAuth();
  const periods = usePayrollPeriods();
  const [periodId, setPeriodId] = useState("");
  const period =
    (periods.data ?? []).find((p) => String(p["id"]) === periodId) ?? (periods.data ?? [])[0];
  const activeId = period ? String(period["id"]) : undefined;
  const computation = usePayrollComputation(activeId);
  const inputs = usePayrollInputs(activeId);
  const release = useReleasePayslips();
  const [open, setOpen] = useState<Payslip | null>(null);

  const mayRelease = can(HR_MODULES.payroll, "approve");
  const released = payslipsReleased(period);
  const blockers = payslipReleaseBlockers(period);

  const inputByEmployee = useMemo(
    () => new Map((inputs.data ?? []).map((r) => [String(r["employee_id"]), r])),
    [inputs.data],
  );

  const rows = computation.data ?? [];
  const totals = payrollTotals(rows);
  const payslips = useMemo(
    () => rows.map((r) => buildPayslip(r, inputByEmployee.get(r.employee_id) ?? null)),
    [rows, inputByEmployee],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Human Resources"
        title="Payslips"
        description="What each person is paid for the period — basic pay, earnings, deductions and net — taken from the same figures that post to the finance books."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select value={activeId ?? ""} onValueChange={setPeriodId}>
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Choose a period" />
              </SelectTrigger>
              <SelectContent>
                {(periods.data ?? []).map((p) => (
                  <SelectItem key={String(p["id"])} value={String(p["id"])}>
                    {String(p["name"])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {mayRelease && activeId ? (
              released ? (
                <Button
                  variant="outline"
                  disabled={release.isPending}
                  onClick={() => release.mutate({ periodId: activeId, release: false })}
                >
                  <Undo2 className="mr-2 size-4" aria-hidden />
                  Withdraw payslips
                </Button>
              ) : (
                <Button
                  disabled={release.isPending || blockers.length > 0}
                  onClick={() => release.mutate({ periodId: activeId, release: true })}
                >
                  <Send className="mr-2 size-4" aria-hidden />
                  Release payslips
                </Button>
              )
            ) : null}
          </div>
        }
      />

      {period ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Period"
            value={String(period["name"] ?? "")}
            hint={`${shortDate(period["period_start"])} — ${shortDate(period["period_end"])}`}
          />
          <StatCard label="Gross" value={formatMoneyExact(totals.gross, totals.currency)} />
          <StatCard
            label="Deductions"
            value={formatMoneyExact(totals.deductions, totals.currency)}
          />
          <StatCard
            label="Net pay"
            value={formatMoneyExact(totals.net, totals.currency)}
            tone="success"
          />
        </div>
      ) : null}

      <SectionCard
        title="Payslips for the period"
        description={
          released
            ? `Released ${shortDateTime(period?.["payslips_released_at"])} — each person can see their own payslip under My HR.`
            : "Not released. Staff cannot see their payslip until the payroll is posted to Finance and it is released here."
        }
        actions={
          period ? (
            <div className="flex items-center gap-2">
              <HrBadge value={String(period["status"] ?? "")} tone={String(period["status"]) === "locked" ? "success" : "default"} />
              <Badge variant={released ? "default" : "outline"}>
                {released ? "Released" : "Withheld"}
              </Badge>
            </div>
          ) : null
        }
      >
        {!released && blockers.length ? (
          <ul className="mb-4 list-disc space-y-1 rounded-lg border border-dashed border-border/70 bg-muted/40 p-3 pl-8 text-sm text-muted-foreground">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        ) : null}

        <QueryState
          isLoading={computation.isLoading}
          error={computation.error}
          isEmpty={payslips.length === 0}
          query={computation}
          empty={
            <EmptyState
              title="No payslips to show"
              description="Build the period's inputs and record each person's agreed pay; the payslips then appear here."
            />
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead className="text-right">Basic</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right">Deductions</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {payslips.map((p) => (
                  <TableRow key={p.employee_id}>
                    <TableCell className="font-medium">
                      {p.full_name}
                      {p.missing_compensation ? (
                        <Badge variant="outline" className="ml-2">
                          No pay record
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      {p.missing_compensation ? "—" : formatMoneyExact(p.base_pay, p.currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatMoneyExact(p.gross, p.currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatMoneyExact(p.totalDeductions, p.currency)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {p.missing_compensation ? "—" : formatMoneyExact(p.net, p.currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => setOpen(p)}>
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </QueryState>
      </SectionCard>

      <PayslipDialog
        payslip={open}
        period={period}
        onOpenChange={(next) => (next ? null : setOpen(null))}
      />
    </div>
  );
}

export function PayslipDialog({
  payslip,
  period,
  onOpenChange,
}: {
  payslip: Payslip | null;
  period: Row | undefined;
  onOpenChange: (next: boolean) => void;
}) {
  if (!payslip) return null;
  const money = (n: number) => formatMoneyExact(n, payslip.currency);
  return (
    <Dialog open={Boolean(payslip)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{payslip.full_name}</DialogTitle>
          <DialogDescription>
            {period
              ? `${String(period["name"])} · ${shortDate(period["period_start"])} — ${shortDate(period["period_end"])}`
              : "Payslip"}
          </DialogDescription>
        </DialogHeader>

        <div id="payslip-print" className="space-y-4 text-sm">
          {payslip.missing_compensation ? (
            <p className="rounded-lg border border-dashed border-border/70 bg-muted/40 p-3 text-muted-foreground">
              No agreed pay is recorded for this person, so their payslip cannot be completed.
            </p>
          ) : null}

          <div className="space-y-1">
            <p className="font-medium">Earnings</p>
            {payslip.earnings.map((line) => (
              <div key={line.label} className="flex justify-between">
                <span className="text-muted-foreground">{line.label}</span>
                <span>{money(line.amount)}</span>
              </div>
            ))}
            <div className="flex justify-between border-t border-border/70 pt-1 font-medium">
              <span>Gross</span>
              <span>{money(payslip.gross)}</span>
            </div>
          </div>

          <div className="space-y-1">
            <p className="font-medium">Deductions</p>
            {payslip.deductions.length ? (
              payslip.deductions.map((line) => (
                <div key={line.label} className="flex justify-between">
                  <span className="text-muted-foreground">{line.label}</span>
                  <span>{money(line.amount)}</span>
                </div>
              ))
            ) : (
              <p className="text-muted-foreground">None recorded for this period.</p>
            )}
          </div>

          <div className="flex justify-between border-t border-border/70 pt-2 text-base font-semibold">
            <span>Net pay</span>
            <span>{money(payslip.net)}</span>
          </div>

          <div className="space-y-1 border-t border-border/70 pt-2 text-muted-foreground">
            <p className="font-medium text-foreground">Time recorded</p>
            <div className="flex justify-between">
              <span>Hours worked</span>
              <span>{payslip.workedHours ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span>Overtime hours</span>
              <span>{payslip.overtimeHours ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span>Paid leave days</span>
              <span>{payslip.paidLeaveDays ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span>Unpaid leave days</span>
              <span>{payslip.unpaidLeaveDays ?? "—"}</span>
            </div>
          </div>
        </div>

        <DialogFooter>
          {payslip.record_id ? (
            <DocumentPrintButton
              type="payslip"
              id={payslip.record_id}
              label="Print payslip"
              variant="outline"
            />
          ) : null}
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
