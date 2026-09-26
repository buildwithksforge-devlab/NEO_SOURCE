import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Clock, LogIn, LogOut, Timer } from "lucide-react";
import { PageHeader, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { EmptyState, HrGuard, QueryState } from "@/components/hr/HrShared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useClockIn,
  useClockOut,
  useHrWrite,
  useMyEmployee,
  useMyOpenShift,
} from "@/lib/hr-data";
import {
  clockState,
  elapsedMinutes,
  extraMinutes,
  scheduledMinutes,
  useMyAttendance,
  useMyOvertime,
  useMyShiftToday,
} from "@/lib/hr-clock";
import {
  ATTENDANCE_STATUSES,
  HR_MODULES,
  clockTime,
  hoursFromMinutes,
  labelFor,
  shortDate,
  titleCase,
  today,
  toneFor,
  type Row,
} from "@/lib/hr";

export const Route = createFileRoute("/_shell/hr/clock")({
  head: () => ({
    meta: [
      { title: "Time Clock — HOS Human Resources" },
      {
        name: "description",
        content:
          "Clock in and out against your published shift, see worked hours, extra time and your recent attendance.",
      },
      { property: "og:title", content: "Time Clock — HOS Human Resources" },
      {
        property: "og:description",
        content: "Clock in and out against your published shift and track worked and extra hours.",
      },
    ],
  }),
  component: () => (
    <HrGuard module={HR_MODULES.attendance} action="self.view">
      <ClockScreen />
    </HrGuard>
  ),
});

function ClockScreen() {
  const me = useMyEmployee();
  const employeeId = me.data?.["id"] as string | undefined;
  const openShift = useMyOpenShift(employeeId);
  const shift = useMyShiftToday(employeeId);
  const history = useMyAttendance(employeeId, 14);
  const overtime = useMyOvertime(employeeId);
  const clockIn = useClockIn();
  const clockOut = useClockOut();
  const raiseOvertime = useHrWrite("overtime_requests", { module: "human-resources" });

  const [now, setNow] = useState(() => new Date());
  const [breakMinutes, setBreakMinutes] = useState("0");
  const [otHours, setOtHours] = useState("");
  const [otReason, setOtReason] = useState("");

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const open = (openShift.data ?? null) as Row | null;
  const assignment = (shift.data ?? [])[0] ?? null;
  const scheduled = scheduledMinutes(assignment);
  const worked = open ? Math.max(0, elapsedMinutes(open["clock_in_at"], now) - Number(breakMinutes || 0)) : 0;
  const extra = extraMinutes(worked, scheduled);
  const state = clockState(open, scheduled, now);

  const rows = (history.data ?? []) as Row[];
  const periodWorked = useMemo(
    () => rows.reduce((sum, r) => sum + Number(r["worked_minutes"] ?? 0), 0),
    [rows],
  );
  const pendingReview = rows.filter((r) => r["status"] === "pending_review").length;

  const figures: SummaryFigure[] = [
    {
      id: "scheduled",
      label: "Today's shift",
      value: scheduled === null ? "Not scheduled" : hoursFromMinutes(scheduled),
      hint:
        assignment
          ? `${clockTime(assignment["start_time"] ?? (assignment["shift_templates"] as Row | undefined)?.["start_time"])} start`
          : "No published roster covers today",
      icon: Timer,
    },
    {
      id: "extra",
      label: "Beyond schedule",
      value: extra > 0 ? hoursFromMinutes(extra) : "None",
      hint: "Extra time must be claimed and approved as overtime",
      tone: extra > 0 ? "warning" : "default",
    },
    {
      id: "fortnight",
      label: "Last 14 days",
      value: hoursFromMinutes(periodWorked),
      hint: `${pendingReview} record${pendingReview === 1 ? "" : "s"} awaiting supervisor review`,
    },
  ];

  if (!me.data && !me.isLoading) {
    return (
      <div>
        <PageHeader title="Time clock" icon={Clock} description="Clock in and out against your shift." />
        <EmptyState
          title="No employee record is linked to your login"
          description="Attendance is kept against an employee record. Ask HR to link your account before clocking in."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Time clock"
        icon={Clock}
        eyebrow="Human Resources"
        description="Clock in and out against your published shift. Clocking out sends the day for supervisor review before payroll sees it."
      />

      <SummaryStrip
        lead={{
          id: "state",
          label: "Status",
          value: open ? hoursFromMinutes(worked) : "Not clocked in",
          hint: open ? `On since ${clockTime(open["clock_in_at"])}` : `No open record for ${shortDate(today())}`,
          tone: state === "over_schedule" ? "warning" : open ? "success" : "default",
          icon: Clock,
        }}
        figures={figures}
        actions={
          <Button
            disabled={clockIn.isPending || clockOut.isPending}
            variant={open ? "default" : "outline"}
            className="rounded-xl"
            onClick={() =>
              open
                ? clockOut.mutate({ record: open, breakMinutes: Number(breakMinutes || 0) })
                : clockIn.mutate({ employee: me.data as Row, source: "web" })
            }
          >
            {open ? <LogOut className="mr-1.5 size-4" aria-hidden /> : <LogIn className="mr-1.5 size-4" aria-hidden />}
            {open ? "Clock out" : "Clock in"}
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="surface-panel">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recent attendance</CardTitle>
          </CardHeader>
          <CardContent>
            <QueryState
              query={history}
              isLoading={history.isLoading}
              error={history.error}
              isEmpty={rows.length === 0}
              empty={
                <EmptyState
                  title="No attendance in the last 14 days"
                  description="Records appear here as soon as you clock in."
                />
              }
            >
              {(
                <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>In</TableHead>
                      <TableHead>Out</TableHead>
                      <TableHead>Worked</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={String(r["id"])}>
                        <TableCell>{shortDate(r["work_date"])}</TableCell>
                        <TableCell>{clockTime(r["clock_in_at"])}</TableCell>
                        <TableCell>{r["clock_out_at"] ? clockTime(r["clock_out_at"]) : "—"}</TableCell>
                        <TableCell>{hoursFromMinutes(r["worked_minutes"])}</TableCell>
                        <TableCell>
                          <StatusPill tone={toneFor(ATTENDANCE_STATUSES, r["status"])}>
                            {labelFor(ATTENDANCE_STATUSES, r["status"], titleCase(r["status"]))}
                          </StatusPill>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </TableScroll>
              )}
            </QueryState>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="surface-panel">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Break taken today</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Label htmlFor="break-minutes">Unpaid break (minutes)</Label>
              <Input
                id="break-minutes"
                inputMode="numeric"
                value={breakMinutes}
                onChange={(e) => setBreakMinutes(e.target.value.replace(/[^0-9]/g, ""))}
              />
              <p className="text-xs text-muted-foreground">
                Deducted from worked hours when you clock out. Leave at zero if you took none.
              </p>
            </CardContent>
          </Card>

          <Card className="surface-panel">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Claim overtime</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Time worked beyond your shift is not paid until it is claimed here and approved by your
                supervisor.
              </p>
              <Label htmlFor="ot-hours">Hours</Label>
              <Input
                id="ot-hours"
                inputMode="decimal"
                value={otHours}
                placeholder="e.g. 1.5"
                onChange={(e) => setOtHours(e.target.value.replace(/[^0-9.]/g, ""))}
              />
              <Label htmlFor="ot-reason">Reason</Label>
              <Textarea
                id="ot-reason"
                value={otReason}
                onChange={(e) => setOtReason(e.target.value)}
                placeholder="What kept you past your shift?"
              />
              <Button
                className="w-full rounded-xl"
                disabled={!employeeId || !otHours || !otReason.trim() || raiseOvertime.isPending}
                onClick={() =>
                  raiseOvertime.mutate(
                    {
                      values: {
                        employee_id: employeeId,
                        overtime_date: today(),
                        hours: Number(otHours),
                        reason: otReason.trim(),
                        status: "pending",
                      },
                    },
                    {
                      onSuccess: () => {
                        setOtHours("");
                        setOtReason("");
                      },
                    },
                  )
                }
              >
                Send for approval
              </Button>
            </CardContent>
          </Card>

          <Card className="surface-panel">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">My overtime claims</CardTitle>
            </CardHeader>
            <CardContent>
              <QueryState
                query={overtime}
                isLoading={overtime.isLoading}
                error={overtime.error}
                isEmpty={((overtime.data ?? []) as Row[]).length === 0}
                empty={<p className="text-sm text-muted-foreground">No overtime claimed.</p>}
              >
                {(
                  <ul className="space-y-2 text-sm">
                    {((overtime.data ?? []) as Row[]).map((o) => (
                      <li key={String(o["id"])} className="flex items-center justify-between gap-2">
                        <span>
                          {shortDate(o["overtime_date"])} · {Number(o["hours"] ?? 0)}h
                        </span>
                        <StatusPill tone={o["status"] === "approved" ? "success" : "warning"}>
                          {titleCase(o["status"])}
                        </StatusPill>
                      </li>
                    ))}
                  </ul>
                )}
              </QueryState>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
