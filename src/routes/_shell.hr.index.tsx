import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarCheck, ClipboardList, GraduationCap, UserCog, Users, Clock } from "lucide-react";
import { PageHeader, SectionCard, StatCard, TableScroll } from "@/components/common/DataDisplay";
import {
  HrAssistant,
  HrBadge,
  IdentitySeparationNotice,
  QueryState,
  EmptyState,
} from "@/components/hr/HrShared";
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
  useLeaveRequests,
  useMyEmployee,
  useMyOpenShift,
  useWorkforceOverview,
  useClockIn,
  useClockOut,
} from "@/lib/hr-data";
import {
  LEAVE_STATUSES,
  clockTime,
  labelFor,
  shortDate,
  toneFor,
  workforceInsights,
  type Row,
} from "@/lib/hr";

export const Route = createFileRoute("/_shell/hr/")({
  head: () => ({
    meta: [
      { title: "Workforce Dashboard — HOS Human Resources" },
      {
        name: "description",
        content: "Headcount, attendance, leave and workforce risk at a glance.",
      },
      { property: "og:title", content: "Workforce Dashboard — HOS Human Resources" },
      {
        property: "og:description",
        content: "Headcount, attendance, leave and workforce risk at a glance.",
      },
    ],
  }),
  component: GuardedPage,
});

function HrDashboard() {
  const { summary, isLoading, error } = useWorkforceOverview();
  const leave = useLeaveRequests();
  const me = useMyEmployee();
  const openShift = useMyOpenShift(me.data?.["id"]);
  const clockIn = useClockIn();
  const clockOut = useClockOut();

  const pending = (leave.data ?? []).filter((l) =>
    ["submitted", "supervisor_approved"].includes(String(l["status"])),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Human Resources"
        title="Workforce Dashboard"
        description="Live headcount, attendance and workforce risk across the property. Employee data is shown only to the extent your permissions allow."
        actions={
          me.data ? (
            openShift.data ? (
              <Button
                onClick={() => clockOut.mutate({ record: openShift.data as Row })}
                disabled={clockOut.isPending}
              >
                <Clock className="mr-2 size-4" />
                Clock out ({clockTime(openShift.data["clock_in_at"])})
              </Button>
            ) : (
              <Button
                onClick={() => clockIn.mutate({ employee: me.data as Row })}
                disabled={clockIn.isPending}
              >
                <Clock className="mr-2 size-4" />
                Clock in
              </Button>
            )
          ) : null
        }
      />

      <div className="neo-kpi-grid">
        <StatCard
          lead
          label="Active headcount"
          value={String(summary.headcount)}
          icon={Users}
          hint="Excludes exited staff"
        />
        <StatCard
          label="Present today"
          value={String(summary.presentToday)}
          icon={Clock}
          tone="success"
          hint="Clocked in"
        />
        <StatCard
          label="Leave awaiting decision"
          value={String(summary.pendingLeave)}
          icon={CalendarCheck}
          tone="warning"
        />
        <StatCard
          label="Unfilled shifts"
          value={String(summary.openShifts)}
          icon={ClipboardList}
          tone="warning"
        />
      </div>

      <div className="neo-kpi-grid">
        <StatCard label="On probation" value={String(summary.onProbation)} icon={UserCog} />
        <StatCard
          label="Probation reviews due"
          value={String(summary.probationDue)}
          tone="warning"
        />
        <StatCard
          label="Contracts expiring"
          value={String(summary.contractsExpiring)}
          tone="warning"
        />
        <StatCard
          label="Certificates expiring"
          value={String(summary.expiringCertificates)}
          icon={GraduationCap}
          tone="warning"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          title="Leave awaiting a decision"
          description="Approve or decline from the Leave workspace. Balances update only when a request is approved."
          actions={
            <Button variant="outline" size="sm" asChild>
              <Link to="/hr/leave">Open leave</Link>
            </Button>
          }
        >
          <QueryState
            isLoading={isLoading || leave.isLoading}
            error={error ?? leave.error}
            isEmpty={pending.length === 0}
            empty={
              <EmptyState
                title="Nothing waiting"
                description="No leave requests are pending a decision."
              />
            }
          >
            <TableScroll>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Dates</TableHead>
                    <TableHead className="text-right">Days</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pending.slice(0, 8).map((r) => (
                    <TableRow key={String(r["id"])}>
                      <TableCell className="font-medium">
                        {(r["employees"] as Row | null)?.["full_name"] ?? "—"}
                      </TableCell>
                      <TableCell>{(r["leave_types"] as Row | null)?.["name"] ?? "—"}</TableCell>
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
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableScroll>
          </QueryState>
        </SectionCard>

        <div className="space-y-4">
          <HrAssistant insights={workforceInsights(summary)} />
          <IdentitySeparationNotice />
        </div>
      </div>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/hr">
      <HrDashboard />
    </OpsGuard>
  );
}
