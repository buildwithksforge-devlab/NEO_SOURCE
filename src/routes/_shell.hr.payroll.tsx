import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import { EmptyState, HrBadge, HrGuard, QueryState } from "@/components/hr/HrShared";
import { PayrollPostingPanel } from "@/components/hr/PayrollPostingPanel";
import { PayrollPeriodDialog } from "@/components/hr/PayrollPeriodDialog";
import { BulkPayrollOnboardingDialog } from "@/components/hr/BulkPayrollOnboardingDialog";
import { PayrollOnboardingDialog } from "@/components/hr/PayrollOnboardingDialog";

import { Button } from "@/components/ui/button";
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
import {
  useBuildPayrollInputs,
  useHrSettings,
  useHrWrite,
  usePayrollInputs,
  usePayrollPeriods,
} from "@/lib/hr-data";
import { payrollTotals, usePayrollComputation, usePayrollEnrolment } from "@/lib/hr-payroll";
import { formatMoneyExact } from "@/lib/money-format";
import { useAuth } from "@/lib/auth";
import { HR_MODULES, PAYROLL_STATUSES, labelFor, shortDate, toneFor, type Row } from "@/lib/hr";


export const Route = createFileRoute("/_shell/hr/payroll")({
  head: () => ({
    meta: [
      { title: "Payroll — HOS Human Resources" },
      {
        name: "description",
        content:
          "Payroll enrolment, verified attendance and leave inputs, period approval and posting.",
      },
      { property: "og:title", content: "Payroll — HOS Human Resources" },
      {
        property: "og:description",
        content: "Prepare verified attendance, overtime and leave inputs for payroll processing.",
      },
    ],
  }),
  component: () => (
    <HrGuard module={HR_MODULES.payroll} action="inputs.view">
      <PayrollScreen />
    </HrGuard>
  ),
});

function PayrollScreen() {
  const periods = usePayrollPeriods();
  const [periodId, setPeriodId] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [bulkOnboarding, setBulkOnboarding] = useState(false);
  const active =
    (periods.data ?? []).find((p) => String(p["id"]) === periodId) ?? (periods.data ?? [])[0];
  const inputs = usePayrollInputs(active ? String(active["id"]) : undefined);
  // Salary, deductions and net come from the same guarded routine that posts
  // the period, so the screen and the posting can never disagree.
  const pay = usePayrollComputation(active ? String(active["id"]) : undefined);
  const payRows = pay.data ?? [];
  const totals = payrollTotals(payRows);
  const hoursByEmployee = new Map(
    (inputs.data ?? []).map((r) => [
      String(r["employee_id"]),
      {
        hours: Number(r["worked_hours"] ?? 0),
        overtime: Number(r["overtime_hours"] ?? 0),
        paidLeave: Number(r["paid_leave_days"] ?? 0),
        unpaidLeave: Number(r["unpaid_leave_days"] ?? 0),
        title: ((r["employees"] as Row | null)?.["job_title"] as string | null) ?? null,
      },
    ]),
  );

  const build = useBuildPayrollInputs();
  const { can } = useAuth();
  const mayApprove = can(HR_MODULES.payroll, "approve");
  const setStatus = useHrWrite("payroll_periods", { action: "hr.payroll.period_status" });
  const settings = useHrSettings();
  const externalPayroll = Boolean(
    (settings.data as Row | null)?.["external_payroll_configured"],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Human Resources"
        title="Payroll"
        description={
          externalPayroll
            ? "External payroll mode: HOS prepares enrolment and verified inputs, and an outside payroll service calculates and pays."
            : "Payroll enrolment, verified attendance and leave inputs, period approval and posting to the finance books."
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => setOnboarding(true)}>
              Put someone on payroll
            </Button>
            <Button variant="outline" onClick={() => setBulkOnboarding(true)}>
              Put several people on payroll
            </Button>
            <Button variant="outline" asChild>
              <Link to="/hr/payslips">Payslips</Link>
            </Button>
            <Button variant="outline" onClick={() => setCreating(true)}>
              New period
            </Button>
            {active ? (
              <Button onClick={() => build.mutate(active)} disabled={build.isPending}>
                Build inputs from attendance
              </Button>
            ) : null}
          </div>
        }
      />

      <PayrollPeriodDialog open={creating} onOpenChange={setCreating} />
      <PayrollOnboardingDialog open={onboarding} onOpenChange={setOnboarding} period={active} />
      <BulkPayrollOnboardingDialog open={bulkOnboarding} onOpenChange={setBulkOnboarding} />

      <PayrollEnrolmentCard />



      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Periods" value={String((periods.data ?? []).length)} />
        <StatCard label="Employees in period" value={String((inputs.data ?? []).length)} />
        <StatCard
          label="Overtime hours"
          value={String(
            (inputs.data ?? []).reduce((s, r) => s + Number(r["overtime_hours"] ?? 0), 0),
          )}
          tone="warning"
        />
        <StatCard
          label="Unpaid leave days"
          value={String(
            (inputs.data ?? []).reduce((s, r) => s + Number(r["unpaid_leave_days"] ?? 0), 0),
          )}
        />
      </div>

      <SectionCard
        title="Payroll period"
        description="Locking a period freezes its inputs so payroll cannot shift under a processed run."
        actions={
          <Select value={active ? String(active["id"]) : ""} onValueChange={setPeriodId}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Select period" />
            </SelectTrigger>
            <SelectContent>
              {(periods.data ?? []).map((p) => (
                <SelectItem key={String(p["id"])} value={String(p["id"])}>
                  {String(p["name"])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        {active ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {shortDate(active["period_start"])} → {shortDate(active["period_end"])} ·{" "}
              <HrBadge
                value={labelFor(PAYROLL_STATUSES, active["status"])}
                tone={toneFor(PAYROLL_STATUSES, active["status"])}
              />
            </p>
            {mayApprove ? (
              <div className="flex flex-wrap gap-2">
                {String(active["status"]) === "draft" ? (
                  <Button
                    variant="outline"
                    disabled={setStatus.isPending}
                    onClick={() =>
                      setStatus.mutate({
                        id: String(active["id"]),
                        values: { status: "hr_review" },
                      })
                    }
                  >
                    Send for HR review
                  </Button>
                ) : null}
                {String(active["status"]) === "hr_review" ? (
                  <Button
                    disabled={setStatus.isPending}
                    onClick={() =>
                      setStatus.mutate({ id: String(active["id"]), values: { status: "approved" } })
                    }
                  >
                    Approve period
                  </Button>
                ) : null}
                {String(active["status"]) === "approved" ? (
                  <Button
                    variant="outline"
                    disabled={setStatus.isPending}
                    onClick={() =>
                      setStatus.mutate({
                        id: String(active["id"]),
                        values: { status: "locked", locked_at: new Date().toISOString() },
                      })
                    }
                  >
                    Lock inputs
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyState
            title="No payroll period"
            description="Create a payroll period to start preparing inputs."
          />
        )}
      </SectionCard>

      <PayrollPostingPanel period={active} />

      <SectionCard
        title="Salaries, hours and deductions"
        description="Each person's contracted pay, the hours and leave recorded for this period, the deductions captured and the resulting net figure. Nothing is estimated — an employee with no pay record shows “Not configured”."
      >
        <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Contracted base pay" value={formatMoneyExact(totals.base, totals.currency)} />
          <StatCard label="Deductions" value={formatMoneyExact(totals.deductions, totals.currency)} tone="warning" />
          <StatCard label="Net pay" value={formatMoneyExact(totals.net, totals.currency)} />
          <StatCard
            label="Without a pay record"
            value={String(totals.missing)}
            tone={totals.missing > 0 ? "warning" : "default"}
          />
        </div>
        <QueryState
          isLoading={pay.isLoading}
          error={pay.error}
          isEmpty={payRows.length === 0}
          empty={
            <EmptyState
              title="No pay figures yet"
              description="Build the period's inputs, then record each employee's pay on their profile."
            />
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Job title</TableHead>
                  <TableHead className="text-right">Contracted pay</TableHead>
                  <TableHead className="text-right">Hours</TableHead>
                  <TableHead className="text-right">Overtime</TableHead>
                  <TableHead className="text-right">Leave (paid/unpaid)</TableHead>
                  <TableHead className="text-right">Deductions</TableHead>
                  <TableHead className="text-right">Net pay</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payRows.map((r) => {
                  const worked = hoursByEmployee.get(r.employee_id);
                  return (
                    <TableRow key={r.employee_id}>
                      <TableCell className="font-medium">{r.full_name}</TableCell>
                      <TableCell>{worked?.title ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {r.missing_compensation ? (
                          <span className="text-muted-foreground">Not configured</span>
                        ) : (
                          `${formatMoneyExact(r.base_pay, r.currency)} · ${r.pay_frequency}`
                        )}
                      </TableCell>
                      <TableCell className="text-right">{worked?.hours ?? 0}</TableCell>
                      <TableCell className="text-right">{worked?.overtime ?? 0}</TableCell>
                      <TableCell className="text-right">
                        {worked?.paidLeave ?? 0} / {worked?.unpaidLeave ?? 0}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatMoneyExact(r.deductions, r.currency)}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {r.missing_compensation ? (
                          <span className="text-muted-foreground">Not configured</span>
                        ) : (
                          formatMoneyExact(r.net_pay, r.currency)
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </QueryState>
      </SectionCard>


      <SectionCard title="Employee inputs">

        <QueryState
          isLoading={inputs.isLoading}
          error={inputs.error}
          isEmpty={(inputs.data ?? []).length === 0}
          empty={
            <EmptyState
              title="No inputs yet"
              description="Build inputs from approved attendance, overtime and leave."
            />
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead className="text-right">Days</TableHead>
                  <TableHead className="text-right">Hours</TableHead>
                  <TableHead className="text-right">Overtime</TableHead>
                  <TableHead className="text-right">Paid leave</TableHead>
                  <TableHead className="text-right">Unpaid leave</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(inputs.data ?? []).map((r) => (
                  <TableRow key={String(r["id"])}>
                    <TableCell className="font-medium">
                      {(r["employees"] as Row | null)?.["full_name"] ?? "—"}
                    </TableCell>
                    <TableCell>{(r["departments"] as Row | null)?.["name"] ?? "—"}</TableCell>
                    <TableCell className="text-right">{Number(r["worked_days"] ?? 0)}</TableCell>
                    <TableCell className="text-right">{Number(r["worked_hours"] ?? 0)}</TableCell>
                    <TableCell className="text-right">{Number(r["overtime_hours"] ?? 0)}</TableCell>
                    <TableCell className="text-right">
                      {Number(r["paid_leave_days"] ?? 0)}
                    </TableCell>
                    <TableCell className="text-right">
                      {Number(r["unpaid_leave_days"] ?? 0)}
                    </TableCell>
                    <TableCell>
                      <HrBadge
                        value={r["status"]}
                        tone={r["status"] === "approved" ? "success" : "warning"}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </QueryState>
      </SectionCard>
    </div>
  );
}

/**
 * Payroll enrolment.
 *
 * A login account is not payroll enrolment. Somebody counts as enrolled only
 * once their employee record carries a real pay record, so this card shows the
 * gap plainly and links to the profile where the figure is entered.
 */
function PayrollEnrolmentCard() {
  const enrolment = usePayrollEnrolment();
  const rows = enrolment.data ?? [];
  const enrolled = rows.filter((r) => r.base_amount !== null);
  const missing = rows.filter((r) => r.base_amount === null);

  return (
    <SectionCard
      title="Payroll enrolment"
      description="Every current employee and whether their agreed pay has been recorded. Pay is entered on the person's own profile, so payroll always uses the same employee record — never a second copy of the person."
    >
      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <StatCard label="Current employees" value={String(rows.length)} />
        <StatCard label="Enrolled (pay recorded)" value={String(enrolled.length)} />
        <StatCard
          label="Not yet enrolled"
          value={String(missing.length)}
          tone={missing.length > 0 ? "warning" : "default"}
        />
      </div>
      <QueryState
        isLoading={enrolment.isLoading}
        error={enrolment.error}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            title="No employee records"
            description="Create employee records before enrolling anyone in payroll."
          />
        }
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Staff number</TableHead>
                <TableHead>Job title</TableHead>
                <TableHead>Employment</TableHead>
                <TableHead className="text-right">Agreed pay</TableHead>
                <TableHead>Effective from</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.employee_id}>
                  <TableCell className="font-medium">{r.full_name}</TableCell>
                  <TableCell>{r.employee_number ?? "—"}</TableCell>
                  <TableCell>{r.job_title ?? "—"}</TableCell>
                  <TableCell>
                    <HrBadge
                      value={r.employment_status ?? "unknown"}
                      tone={r.employment_status === "active" ? "success" : "warning"}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    {r.base_amount === null ? (
                      <span className="text-muted-foreground">Not enrolled</span>
                    ) : (
                      `${formatMoneyExact(r.base_amount, r.currency ?? "KES")} · ${r.pay_frequency}`
                    )}
                  </TableCell>
                  <TableCell>{r.effective_from ? shortDate(r.effective_from) : "—"}</TableCell>
                  <TableCell>
                    <Button asChild size="sm" variant="ghost">
                      <Link to="/hr/employees/$id" params={{ id: r.employee_id }}>
                        {r.base_amount === null ? "Enrol" : "Open"}
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </QueryState>
    </SectionCard>
  );
}
