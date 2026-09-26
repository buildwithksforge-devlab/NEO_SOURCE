import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Clock } from "lucide-react";
import { PageHeader, StatusPill } from "@/components/common/DataDisplay";
import { NeoDateRangePicker } from "@/components/common/DatePicker";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import {
  InspectorField,
  InspectorSection,
  InspectorSheet,
} from "@/components/common/InspectorSheet";
import { AttendanceLogDialog } from "@/components/hr/AttendanceLogDialog";
import { EmptyState, HrBadge, HrGuard, QueryState } from "@/components/hr/HrShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth";
import { useAttendance, useAttendanceCorrections, useHrWrite } from "@/lib/hr-data";
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

export const Route = createFileRoute("/_shell/hr/attendance")({
  head: () => ({
    meta: [
      { title: "Attendance & Time — HOS Human Resources" },
      {
        name: "description",
        content: "Daily clock-in records, exceptions and attendance correction approvals.",
      },
      { property: "og:title", content: "Attendance & Time — HOS Human Resources" },
      {
        property: "og:description",
        content: "Daily clock-in records, exceptions and attendance correction approvals.",
      },
    ],
  }),
  component: () => (
    <HrGuard module={HR_MODULES.attendance} action="self.view">
      <AttendanceScreen />
    </HrGuard>
  ),
});

/** Summary-strip lenses that filter the records surface. */
type Lens = "none" | "exceptions" | "pendingReview";

function AttendanceScreen() {
  const { can } = useAuth();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [lens, setLens] = useState<Lens>("none");
  const [tab, setTab] = useState("records");
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const attendance = useAttendance({ from, to });
  const corrections = useAttendanceCorrections();
  const updateCorrection = useHrWrite("attendance_corrections", {
    action: "hr.attendance.correction_reviewed",
  });
  const updateRecord = useHrWrite("attendance_records", { action: "hr.attendance.reviewed" });

  const records = attendance.data ?? [];
  const exceptions = records.filter(
    (r) => r["status"] === "incomplete" || Number(r["late_minutes"] ?? 0) > 0,
  );
  const pendingReview = records.filter((r) => r["status"] === "pending_review");
  const pendingCorrections = (corrections.data ?? []).filter((c) =>
    String(c["status"]).startsWith("pending"),
  );
  const canApprove = can(HR_MODULES.attendance, "correct");

  const toggleLens = (next: Lens) => {
    setLens((prev) => (prev === next ? "none" : next));
    setTab("records");
  };

  const visibleRecords = useMemo(() => {
    if (lens === "exceptions") return exceptions;
    if (lens === "pendingReview") return pendingReview;
    return records;
  }, [lens, records, exceptions, pendingReview]);

  const inspected = records.find((r) => String(r["id"]) === inspectId) ?? null;

  const leadFigure: SummaryFigure = {
    id: "records",
    label: "Records in range",
    value: attendance.isLoading ? "…" : records.length,
    hint: "Attendance is stored per employee per shift",
  };
  const figures: SummaryFigure[] = [
    {
      id: "exceptions",
      label: "Exceptions",
      value: attendance.isLoading ? "…" : exceptions.length,
      tone: exceptions.length ? "warning" : "success",
      hint: "Late or incomplete",
      onSelect: () => toggleLens("exceptions"),
      active: lens === "exceptions",
    },
    {
      id: "pendingReview",
      label: "Pending review",
      value: attendance.isLoading ? "…" : pendingReview.length,
      tone: pendingReview.length ? "warning" : "default",
      onSelect: () => toggleLens("pendingReview"),
      active: lens === "pendingReview",
    },
    {
      id: "corrections",
      label: "Corrections pending",
      value: corrections.isLoading ? "…" : pendingCorrections.length,
      tone: pendingCorrections.length ? "warning" : "default",
      onSelect: () => setTab("corrections"),
      active: tab === "corrections",
    },
    {
      id: "hours",
      label: "Hours captured",
      value: attendance.isLoading
        ? "…"
        : hoursFromMinutes(records.reduce((s, r) => s + Number(r["worked_minutes"] ?? 0), 0)),
      tone: "success",
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Human Resources"
        title="Attendance & Time"
        description="Attendance is evidence for payroll. Records can be corrected with a reason, never silently overwritten."
      />

      <SummaryStrip
        lead={leadFigure}
        figures={figures}
        actions={
          <>
            {canApprove ? (
              <Button size="sm" onClick={() => setLogOpen(true)}>
                Log attendance
              </Button>
            ) : null}
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">Period</Label>
              <NeoDateRangePicker
                from={from}
                to={to}
                quick={["today", "this-week", "this-month"]}
                onChange={({ from: f, to: t }) => {
                  setFrom(f);
                  setTo(t);
                }}
              />
            </div>
          </>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="records">Records</TabsTrigger>
          <TabsTrigger value="corrections">Corrections</TabsTrigger>
        </TabsList>

        <TabsContent value="records" className="mt-4">
          <QueryState
            isLoading={attendance.isLoading}
            error={attendance.error}
            isEmpty={visibleRecords.length === 0}
            empty={
              <EmptyState
                title={lens === "none" ? "No attendance in this range" : "Nothing matches this filter"}
                description="Records appear as staff clock in and out."
              />
            }
          >
            <AttendanceTable
              rows={visibleRecords}
              canApprove={canApprove}
              onOpen={(row) => setInspectId(String(row["id"]))}
              onApprove={(row) =>
                updateRecord.mutate({ id: String(row["id"]), values: { status: "approved" } })
              }
            />
          </QueryState>
        </TabsContent>

        <TabsContent value="corrections" className="mt-4">
          <QueryState
            isLoading={corrections.isLoading}
            error={corrections.error}
            isEmpty={(corrections.data ?? []).length === 0}
            empty={
              <EmptyState
                title="No correction requests"
                description="Requests raised from My HR appear here."
              />
            }
          >
            <div className="neo-contain overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Decision</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(corrections.data ?? []).map((c) => (
                    <TableRow key={String(c["id"])}>
                      <TableCell className="font-medium">
                        {(c["employees"] as Row | null)?.["full_name"] ?? "—"}
                      </TableCell>
                      <TableCell>{shortDate(c["work_date"])}</TableCell>
                      <TableCell>{titleCase(c["correction_type"])}</TableCell>
                      <TableCell className="max-w-64 truncate text-sm text-muted-foreground">
                        {String(c["reason"])}
                      </TableCell>
                      <TableCell>
                        <HrBadge
                          value={c["status"]}
                          tone={String(c["status"]).startsWith("pending") ? "warning" : "success"}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        {can(HR_MODULES.attendance, "correction.approve") &&
                        String(c["status"]).startsWith("pending") ? (
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              onClick={() =>
                                updateCorrection.mutate({
                                  id: String(c["id"]),
                                  values: {
                                    status: "approved",
                                    reviewed_at: new Date().toISOString(),
                                  },
                                })
                              }
                            >
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                updateCorrection.mutate({
                                  id: String(c["id"]),
                                  values: {
                                    status: "rejected",
                                    reviewed_at: new Date().toISOString(),
                                  },
                                })
                              }
                            >
                              Reject
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </QueryState>
        </TabsContent>
      </Tabs>

      <AttendanceLogDialog open={logOpen} onOpenChange={setLogOpen} existing={records} />

      <InspectorSheet
        open={Boolean(inspected)}
        onOpenChange={(o) => !o && setInspectId(null)}
        title={inspected ? String((inspected["employees"] as Row | null)?.["full_name"] ?? "Attendance record") : ""}
        subtitle={inspected ? shortDate(inspected["work_date"]) : undefined}
        chips={
          inspected ? (
            <StatusPill tone={toneFor(ATTENDANCE_STATUSES, inspected["status"])}>
              {labelFor(ATTENDANCE_STATUSES, inspected["status"])}
            </StatusPill>
          ) : null
        }
        footer={
          inspected && canApprove && inspected["status"] === "pending_review" ? (
            <Button
              onClick={() => {
                updateRecord.mutate({ id: String(inspected["id"]), values: { status: "approved" } });
                setInspectId(null);
              }}
            >
              Approve
            </Button>
          ) : null
        }
      >
        {inspected ? (
          <InspectorSection title="Shift">
            <InspectorField label="Clock in">{clockTime(inspected["clock_in_at"])}</InspectorField>
            <InspectorField label="Clock out">{clockTime(inspected["clock_out_at"])}</InspectorField>
            <InspectorField label="Worked">{hoursFromMinutes(inspected["worked_minutes"])}</InspectorField>
            <InspectorField label="Late">{Number(inspected["late_minutes"] ?? 0)}m</InspectorField>
          </InspectorSection>
        ) : null}
      </InspectorSheet>
    </div>
  );
}

function AttendanceTable({
  rows,
  canApprove,
  onOpen,
  onApprove,
}: {
  rows: Row[];
  canApprove: boolean;
  onOpen: (row: Row) => void;
  onApprove: (row: Row) => void;
}) {
  return (
    <div className="neo-contain overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Employee</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>In</TableHead>
            <TableHead>Out</TableHead>
            <TableHead className="text-right">Worked</TableHead>
            <TableHead className="text-right">Late</TableHead>
            <TableHead>Status</TableHead>
            {canApprove ? <TableHead className="text-right">Action</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow
              key={String(r["id"])}
              className="cursor-pointer"
              onClick={() => onOpen(r)}
            >
              <TableCell className="font-medium">
                {(r["employees"] as Row | null)?.["full_name"] ?? "—"}
              </TableCell>
              <TableCell>{shortDate(r["work_date"])}</TableCell>
              <TableCell>{clockTime(r["clock_in_at"])}</TableCell>
              <TableCell>{clockTime(r["clock_out_at"])}</TableCell>
              <TableCell className="text-right">{hoursFromMinutes(r["worked_minutes"])}</TableCell>
              <TableCell className="text-right">{Number(r["late_minutes"] ?? 0)}m</TableCell>
              <TableCell>
                <HrBadge
                  value={labelFor(ATTENDANCE_STATUSES, r["status"])}
                  tone={toneFor(ATTENDANCE_STATUSES, r["status"])}
                />
              </TableCell>
              {canApprove ? (
                <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                  {r["status"] === "pending_review" ? (
                    <Button size="sm" variant="outline" onClick={() => onApprove(r)}>
                      Approve
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
