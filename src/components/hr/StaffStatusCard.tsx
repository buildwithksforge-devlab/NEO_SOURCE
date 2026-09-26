/**
 * Staff status on the board.
 *
 * A manager's glance view: who is on shift right now, who clocked in late,
 * who is on leave and how much leave each person still has. Every figure is
 * read from attendance, roster and leave records — nothing is estimated, and
 * an employee with no record for today reads "Not recorded".
 */

import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Users } from "lucide-react";
import { SectionCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { QueryState } from "@/components/common/StateSystem";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  KPI_WINDOW_DAYS,
  SHIFT_STATE_LABEL,
  shiftTone,
  useStaffStatusBoard,
  type StaffStatusRow,
} from "@/lib/hr-staff-status";

function clockTime(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function hours(minutes: number | null): string {
  if (minutes == null || minutes <= 0) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function StaffStatusCard() {
  const board = useStaffStatusBoard();
  const [search, setSearch] = useState("");

  const rows = useMemo<StaffStatusRow[]>(() => {
    const needle = search.trim().toLowerCase();
    const list = needle
      ? board.data.filter((r) =>
          [r.name, r.number, r.jobTitle, r.department].some((v) =>
            v.toLowerCase().includes(needle),
          ),
        )
      : board.data;
    const rank: Record<string, number> = {
      "on-shift": 0,
      rostered: 1,
      absent: 2,
      leave: 3,
      finished: 4,
      off: 5,
    };
    return [...list].sort(
      (a, b) => (rank[a.shiftState] ?? 9) - (rank[b.shiftState] ?? 9) || a.name.localeCompare(b.name),
    );
  }, [board.data, search]);

  const onShift = board.data.filter((r) => r.shiftState === "on-shift").length;
  const onLeave = board.data.filter((r) => r.shiftState === "leave").length;
  const late = board.data.filter((r) => r.lateMinutes > 0).length;
  const notIn = board.data.filter((r) => r.shiftState === "rostered").length;
  const overtime30 = board.data.reduce((t, r) => t + r.overtimeMinutes30, 0);
  const leaveDays30 = board.data.reduce((t, r) => t + r.leaveDaysApproved30, 0);

  return (
    <SectionCard
      title="Staff status today"
      description={`Shift, attendance and remaining leave for every active employee, with overtime, lateness and approved leave over the last ${KPI_WINDOW_DAYS} days.`}
      icon={Users}
      actions={
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, number or role"
          className="h-9 w-56"
        />
      }
    >
      <QueryState
        isLoading={board.isLoading}
        error={board.error}
        isEmpty={board.data.length === 0}
        empty="No active employees to show."
      >
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            {onShift} on shift · {notIn} rostered but not clocked in · {late} clocked in late ·{" "}
            {onLeave} on leave · {hours(overtime30)} overtime and {leaveDays30} leave days in the
            last {KPI_WINDOW_DAYS} days
          </p>
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Shift today</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>In / out</TableHead>
                  <TableHead className="text-right">Worked</TableHead>
                  <TableHead className="text-right">Overtime {KPI_WINDOW_DAYS}d</TableHead>
                  <TableHead className="text-right">Lateness {KPI_WINDOW_DAYS}d</TableHead>
                  <TableHead className="text-right">Leave taken {KPI_WINDOW_DAYS}d</TableHead>
                  <TableHead className="text-right">Leave left</TableHead>
                  <TableHead>Last appraisal</TableHead>
                  <TableHead>Training</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link
                        to="/hr/employees/$id"
                        params={{ id: r.id }}
                        className="font-medium hover:underline"
                      >
                        {r.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {r.number} · {r.jobTitle} · {r.department}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.shiftLabel ?? <span className="text-muted-foreground">Not rostered</span>}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={shiftTone(r.shiftState)}>
                        {r.onLeaveType ?? SHIFT_STATE_LABEL[r.shiftState]}
                      </StatusPill>
                      {r.lateMinutes > 0 ? (
                        <div className="mt-1 text-xs text-warning">{r.lateMinutes} min late</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {r.clockIn || r.clockOut
                        ? `${clockTime(r.clockIn)} → ${clockTime(r.clockOut)}`
                        : "Not recorded"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {hours(r.workedMinutes)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {hours(r.overtimeMinutes30)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.lateMinutes30 > 0 ? (
                        <span>
                          {hours(r.lateMinutes30)}
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({r.lateDays30} {r.lateDays30 === 1 ? "day" : "days"})
                          </span>
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.leaveDaysApproved30 > 0 ? r.leaveDaysApproved30 : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.leaveEntitled > 0 || r.leaveRemaining > 0 ? (
                        <span>
                          {r.leaveRemaining} / {r.leaveEntitled} {r.leaveUnit}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">No entitlement set</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.lastReviewDate ? (
                        <span>
                          {new Date(r.lastReviewDate).toLocaleDateString()}
                          {r.lastReviewRating != null ? ` · ${r.lastReviewRating}` : ""}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Not appraised</span>
                      )}
                      {r.openReviews > 0 ? (
                        <div className="text-xs text-warning">{r.openReviews} open</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.trainingCompleted === 0 && r.trainingOutstanding === 0 ? (
                        <span className="text-muted-foreground">None booked</span>
                      ) : (
                        <span>
                          {r.trainingCompleted} completed
                          {r.trainingOutstanding > 0 ? (
                            <span className="text-warning"> · {r.trainingOutstanding} pending</span>
                          ) : null}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </>
      </QueryState>
    </SectionCard>
  );
}
