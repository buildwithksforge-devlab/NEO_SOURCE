import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { CalendarPlus, Clock } from "lucide-react";
import { PageHeader, SectionCard, StatCard, TableScroll } from "@/components/common/DataDisplay";
import { useMyPayslips } from "@/lib/hr-payslips";
import { formatMoneyExact } from "@/lib/money-format";
import {
  EmptyState,
  HrBadge,
  IdentitySeparationNotice,
  QueryState,
} from "@/components/hr/HrShared";
import { AttendanceCorrectionDialog } from "@/components/hr/AttendanceCorrectionDialog";
import { LeaveApplyDialog } from "@/components/hr/LeaveApplyDialog";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useAttendance,
  useClockIn,
  useClockOut,
  useLeaveBalances,
  useLeaveRequests,
  useMyEmployee,
  useMyOpenShift,
  useRosterAssignments,
} from "@/lib/hr-data";
import { availableDays, useEntitlementsUpToDate } from "@/lib/hr-leave";
import {
  LEAVE_STATUSES,
  clockTime,
  hoursFromMinutes,
  labelFor,
  shortDate,
  today,
  toneFor,
  type Row,
} from "@/lib/hr";

export const Route = createFileRoute("/_shell/hr/me")({
  head: () => ({
    meta: [
      { title: "My HR — HOS Employee Self-Service" },
      {
        name: "description",
        content:
          "Your schedule, attendance, calculated leave balances and leave applications.",
      },
      { property: "og:title", content: "My HR — HOS Employee Self-Service" },
      {
        property: "og:description",
        content:
          "Your schedule, attendance, calculated leave balances and leave applications.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SelfService,
});

function SelfService() {
  const me = useMyEmployee();
  const employeeId = me.data?.["id"] as string | undefined;
  const openShift = useMyOpenShift(employeeId);
  const clockIn = useClockIn();
  const clockOut = useClockOut();
  const attendance = useAttendance(
    { from: new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10), to: today() },
    employeeId,
  );
  const leave = useLeaveRequests(employeeId);
  const balances = useLeaveBalances(employeeId);
  const shifts = useRosterAssignments(undefined, employeeId);
  const payslips = useMyPayslips(employeeId);
  const [applying, setApplying] = useState(false);
  const [correcting, setCorrecting] = useState<Row | null>(null);

  // Balances are recalculated from policy whenever this screen opens.
  useEntitlementsUpToDate(employeeId ?? null, Boolean(employeeId));

  if (!me.isLoading && !me.data) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Human Resources" title="My HR" />
        <EmptyState
          title="No employee record linked to your login"
          description="Your login account is not yet linked to an employee record. Ask HR to link it — login accounts and HR records are deliberately separate."
        />
      </div>
    );
  }

  const worked = (attendance.data ?? []).reduce((s, r) => s + Number(r["worked_minutes"] ?? 0), 0);
  const availableTotal = (balances.data ?? []).reduce((s, b) => s + availableDays(b), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Human Resources"
        title="My HR"
        description="Everything here is your own record only. You cannot see colleagues' personal data from this screen."
        actions={
          me.data ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setApplying(true)}>
                <CalendarPlus className="mr-2 size-4" aria-hidden />
                Apply for leave
              </Button>
              {openShift.data ? (
                <Button
                  onClick={() => clockOut.mutate({ record: openShift.data as Row })}
                  disabled={clockOut.isPending}
                >
                  <Clock className="mr-2 size-4" />
                  Clock out (in at {clockTime(openShift.data["clock_in_at"])})
                </Button>
              ) : (
                <Button
                  onClick={() => clockIn.mutate({ employee: me.data as Row })}
                  disabled={clockIn.isPending}
                >
                  <Clock className="mr-2 size-4" />
                  Clock in
                </Button>
              )}
            </div>
          ) : null
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Hours (30 days)" value={hoursFromMinutes(worked)} icon={Clock} />
        <StatCard label="Leave days available" value={String(availableTotal)} tone="success" />
        <StatCard
          label="Upcoming shifts"
          value={String(
            (shifts.data ?? []).filter((s) => String(s["shift_date"]) >= today()).length,
          )}
        />
        <StatCard label="Leave requests" value={String((leave.data ?? []).length)} />
      </div>

      <IdentitySeparationNotice />

      <SectionCard
        title="My leave balances"
        description={`Calculated for ${new Date().getFullYear()} from the company leave policies and your joining date.`}
      >
        <QueryState
          isLoading={balances.isLoading}
          error={balances.error}
          isEmpty={(balances.data ?? []).length === 0}
          empty={
            <EmptyState
              title="No balances yet"
              description="Balances appear once HR has configured the company leave policies."
            />
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Entitlement</TableHead>
                  <TableHead className="text-right">Carried</TableHead>
                  <TableHead className="text-right">Used</TableHead>
                  <TableHead className="text-right">Pending</TableHead>
                  <TableHead className="text-right">Available</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(balances.data ?? []).map((b) => (
                  <TableRow key={String(b["id"])}>
                    <TableCell className="font-medium">
                      {(b["leave_types"] as Row | null)?.["name"] ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {Number(b["entitlement_days"] ?? 0)}
                    </TableCell>
                    <TableCell className="text-right">
                      {Number(b["carried_forward_days"] ?? 0)}
                    </TableCell>
                    <TableCell className="text-right">{Number(b["taken_days"] ?? 0)}</TableCell>
                    <TableCell className="text-right">{Number(b["pending_days"] ?? 0)}</TableCell>
                    <TableCell className="text-right font-semibold">{availableDays(b)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>

      <SectionCard title="My leave requests">
        <QueryState
          isLoading={leave.isLoading}
          error={leave.error}
          isEmpty={(leave.data ?? []).length === 0}
          empty={
            <EmptyState
              title="No leave requests"
              description="Your submitted requests and their decisions appear here."
            />
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Dates</TableHead>
                  <TableHead className="text-right">Days</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Decision note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(leave.data ?? []).map((r) => (
                  <TableRow key={String(r["id"])}>
                    <TableCell className="font-medium">
                      {(r["leave_types"] as Row | null)?.["name"] ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {shortDate(r["start_date"])} → {shortDate(r["end_date"])}
                    </TableCell>
                    <TableCell className="text-right">{Number(r["days"] ?? 0)}</TableCell>
                    <TableCell>
                      <HrBadge
                        value={labelFor(LEAVE_STATUSES, r["status"])}
                        tone={toneFor(LEAVE_STATUSES, r["status"])}
                      />
                    </TableCell>
                    <TableCell className="max-w-[18rem] truncate text-sm text-muted-foreground">
                      {String(r["return_comment"] ?? r["decision_notes"] ?? "—")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>

      <SectionCard title="My recent attendance">
        <QueryState
          isLoading={attendance.isLoading}
          error={attendance.error}
          isEmpty={(attendance.data ?? []).length === 0}
          empty={
            <EmptyState
              title="No attendance yet"
              description="Clock in to start building your attendance record."
            />
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>In</TableHead>
                  <TableHead>Out</TableHead>
                  <TableHead className="text-right">Worked</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Correction</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(attendance.data ?? []).map((a) => (
                  <TableRow key={String(a["id"])}>
                    <TableCell className="font-medium">{shortDate(a["work_date"])}</TableCell>
                    <TableCell>{clockTime(a["clock_in_at"])}</TableCell>
                    <TableCell>{clockTime(a["clock_out_at"])}</TableCell>
                    <TableCell className="text-right">
                      {hoursFromMinutes(a["worked_minutes"])}
                    </TableCell>
                    <TableCell>
                      <HrBadge
                        value={a["status"]}
                        tone={a["status"] === "approved" ? "success" : "warning"}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => setCorrecting(a)}>
                        Request correction
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>

      <SectionCard
        title="My payslips"
        description="Your pay for each period, once HR has released the payslips."
      >
        <QueryState
          isLoading={payslips.isLoading}
          error={payslips.error}
          isEmpty={(payslips.data ?? []).length === 0}
          query={payslips}
          empty={
            <EmptyState
              title="No payslips released yet"
              description="A payslip appears here once the payroll period is approved and HR releases it."
            />
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right">Deductions</TableHead>
                  <TableHead className="text-right">Net pay</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(payslips.data ?? []).map((slip) => {
                  const currency = String(slip["currency"] ?? "KES");
                  const period = slip["payroll_periods"] as Row | null;
                  return (
                    <TableRow key={String(slip["id"])}>
                      <TableCell className="font-medium">
                        {String(period?.["name"] ?? "Period")}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatMoneyExact(Number(slip["gross_pay"] ?? 0), currency)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatMoneyExact(Number(slip["deductions"] ?? 0), currency)}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatMoneyExact(Number(slip["net_pay"] ?? 0), currency)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>

      {me.data ? (
        <>
          <AttendanceCorrectionDialog
            open={Boolean(correcting)}
            onOpenChange={(v) => {
              if (!v) setCorrecting(null);
            }}
            record={correcting}
            employee={me.data as Row}
          />
          <LeaveApplyDialog open={applying} onOpenChange={setApplying} employee={me.data as Row} />
        </>
      ) : null}
    </div>
  );
}
