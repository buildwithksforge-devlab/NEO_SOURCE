import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { History, Sparkles, Users } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { InspectorSheet } from "@/components/common/InspectorSheet";
import { OpsGuard, QueryState } from "@/components/operations/OpsShared";
import { EmptyState } from "@/components/common/StateSystem";
import { Input } from "@/components/ui/input";
import { NeoDateRangePicker } from "@/components/common/DatePicker";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { shortDateTime, titleCase } from "@/lib/operations";
import {
  useCompletedHousekeepingJobs,
  useHousekeepingSupersedeAudit,
  useStaffLite,
  useSupersededHousekeepingJobs,
} from "@/lib/operations-data";

export const Route = createFileRoute("/_shell/housekeeping/history")({
  head: () => ({
    meta: [
      { title: "Cleaning History — Housekeeping — HOS" },
      {
        name: "description",
        content:
          "Completed cleaning work by room and by housekeeper, with duration, inspection outcome, rework and the superseded-task integrity trail.",
      },
      { property: "og:title", content: "Cleaning History — Housekeeping — HOS" },
      {
        property: "og:description",
        content:
          "Completed cleaning work by room and by housekeeper, with duration, inspection outcome, rework and the superseded-task integrity trail.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function text(value: unknown, fallback = "—") {
  const s = value === null || value === undefined ? "" : String(value);
  return s.trim() === "" ? fallback : s;
}

type Row = Record<string, unknown>;

function minutesBetween(start: unknown, end: unknown): number | null {
  if (!start || !end) return null;
  const a = new Date(String(start)).getTime();
  const b = new Date(String(end)).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.round((b - a) / 60000);
}

function formatMinutes(value: number | null): string {
  if (value === null) return "—";
  if (value < 60) return `${value} min`;
  const h = Math.floor(value / 60);
  const m = value % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function roomLabel(row: Row): string {
  const room = (row["rooms"] as { room_number?: unknown } | null)?.room_number;
  return text(room ?? row["location_label"]);
}

function Page() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const completed = useCompletedHousekeepingJobs({ from, to });
  const superseded = useSupersededHousekeepingJobs();
  const staff = useStaffLite("housekeeping");
  const [search, setSearch] = useState("");
  const [worker, setWorker] = useState("");
  const [reason, setReason] = useState("");
  const [selected, setSelected] = useState<Row | null>(null);
  const [detail, setDetail] = useState<Row | null>(null);

  const staffNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of staff.data ?? []) {
      const id = text(member["id"], "");
      const name = text(member["full_name"] ?? member["name"], "");
      if (id && name !== "—" && name !== "") map.set(id, name);
    }
    return map;
  }, [staff.data]);

  const nameFor = (row: Row) => {
    const id = text(row["assignee_id"], "");
    if (id && staffNames.has(id)) return staffNames.get(id)!;
    const team = text(row["assigned_team"], "");
    if (team !== "—") return `${team} (team)`;
    return "Unattributed";
  };

  const cleanRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const workerNeedle = worker.trim().toLowerCase();
    return (completed.data ?? []).filter((row) => {
      if (needle) {
        const hit = [row["job_number"], roomLabel(row), row["job_type"], row["notes"]]
          .map((v) => String(v ?? "").toLowerCase())
          .some((v) => v.includes(needle));
        if (!hit) return false;
      }
      if (workerNeedle && !nameFor(row).toLowerCase().includes(workerNeedle)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completed.data, search, worker, staffNames]);

  const stats = useMemo(() => {
    const durations = cleanRows
      .map((r) => minutesBetween(r["started_at"], r["completed_at"]))
      .filter((v): v is number => v !== null);
    const totalMinutes = durations.reduce((a, b) => a + b, 0);
    const inspected = cleanRows.filter((r) =>
      ["passed", "failed"].includes(String(r["inspection_status"] ?? "")),
    );
    const passed = inspected.filter((r) => String(r["inspection_status"]) === "passed");
    const rework = cleanRows.filter((r) => Number(r["rework_count"] ?? 0) > 0);
    return {
      cleans: cleanRows.length,
      rooms: new Set(cleanRows.map((r) => text(r["room_id"], roomLabel(r)))).size,
      avgMinutes: durations.length ? Math.round(totalMinutes / durations.length) : null,
      totalMinutes,
      housekeepers: new Set(cleanRows.map((r) => nameFor(r))).size,
      passRate: inspected.length ? Math.round((passed.length / inspected.length) * 100) : null,
      reworkRate: cleanRows.length ? Math.round((rework.length / cleanRows.length) * 100) : 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanRows, staffNames]);

  const byWorker = useMemo(() => {
    const map = new Map<
      string,
      { name: string; cleans: number; minutes: number; timed: number; rework: number; inspected: number; passed: number; last: string | null }
    >();
    for (const row of cleanRows) {
      const name = nameFor(row);
      const entry =
        map.get(name) ?? { name, cleans: 0, minutes: 0, timed: 0, rework: 0, inspected: 0, passed: 0, last: null };
      entry.cleans += 1;
      const mins = minutesBetween(row["started_at"], row["completed_at"]);
      if (mins !== null) {
        entry.minutes += mins;
        entry.timed += 1;
      }
      if (Number(row["rework_count"] ?? 0) > 0) entry.rework += 1;
      const inspection = String(row["inspection_status"] ?? "");
      if (inspection === "passed" || inspection === "failed") {
        entry.inspected += 1;
        if (inspection === "passed") entry.passed += 1;
      }
      const done = row["completed_at"] ? String(row["completed_at"]) : null;
      if (done && (!entry.last || done > entry.last)) entry.last = done;
      map.set(name, entry);
    }
    return [...map.values()].sort((a, b) => b.cleans - a.cleans);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanRows, staffNames]);

  const supersededRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const reasonNeedle = reason.trim().toLowerCase();
    const fromTs = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const toTs = to ? new Date(`${to}T23:59:59`).getTime() : null;
    return (superseded.data ?? []).filter((row) => {
      if (needle) {
        const hit = [row["job_number"], roomLabel(row), row["supersede_reason"]]
          .map((v) => String(v ?? "").toLowerCase())
          .some((v) => v.includes(needle));
        if (!hit) return false;
      }
      if (reasonNeedle && !String(row["supersede_reason"] ?? "").toLowerCase().includes(reasonNeedle)) {
        return false;
      }
      if (fromTs || toTs) {
        const at = row["superseded_at"] ? new Date(String(row["superseded_at"])).getTime() : null;
        if (at === null || Number.isNaN(at)) return false;
        if (fromTs && at < fromTs) return false;
        if (toTs && at > toTs) return false;
      }
      return true;
    });
  }, [superseded.data, search, reason, from, to]);

  return (
    <OpsGuard path="/housekeeping/history" module="housekeeping" action="view">
      <PageHeader
        eyebrow="Housekeeping"
        title="Cleaning History"
        description="Every completed clean with the housekeeper who did it, how long it took, how inspection went — plus the superseded-task trail that proves no duplicate request was ever deleted."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Cleans completed" value={String(stats.cleans)} hint="In the selected period" />
        <StatCard label="Rooms cleaned" value={String(stats.rooms)} hint="Distinct rooms or locations" />
        <StatCard
          label="Average clean time"
          value={formatMinutes(stats.avgMinutes)}
          hint={stats.avgMinutes === null ? "No start/finish times recorded" : "Start to completion"}
        />
        <StatCard
          label="Inspection pass rate"
          value={stats.passRate === null ? "Awaiting Data" : `${stats.passRate}%`}
          tone={stats.passRate !== null && stats.passRate >= 90 ? "success" : "default"}
          hint={stats.passRate === null ? "No inspected cleans in this period" : "Of inspected cleans"}
        />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Housekeepers active" value={String(stats.housekeepers)} hint="Credited on completed work" />
        <StatCard label="Cleaning hours logged" value={formatMinutes(stats.totalMinutes || null)} hint="Timed cleans only" />
        <StatCard
          label="Rework rate"
          value={`${stats.reworkRate}%`}
          tone={stats.reworkRate > 10 ? "warning" : "default"}
          hint="Cleans returned at least once"
        />
        <StatCard
          label="Labour cost"
          value="Not Configured"
          hint="Add pay rates to housekeeping roles to cost this work"
        />
      </div>

      <div className="mt-6">
        <SectionCard
          title="Filters"
          description="One period drives the whole page — completed work, team performance and the superseded trail."
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search room, job number or note"
              aria-label="Search cleaning history"
              className="h-9 min-w-0"
            />
            <Input
              value={worker}
              onChange={(e) => setWorker(e.target.value)}
              placeholder="Filter by housekeeper"
              aria-label="Filter cleaning history by housekeeper"
              className="h-9 min-w-0"
            />
            <NeoDateRangePicker
              from={from}
              to={to}
              onChange={(range) => {
                setFrom(range.from ?? "");
                setTo(range.to ?? "");
              }}
              ariaLabel="Cleaning history date range"
              fromLabel="From"
              toLabel="To"
              className="sm:col-span-2 min-w-0"
            />
          </div>
        </SectionCard>
      </div>

      <div className="mt-6">
        <Tabs defaultValue="completed">
          <TabsList>
            <TabsTrigger value="completed">Completed work</TabsTrigger>
            <TabsTrigger value="team">By housekeeper</TabsTrigger>
            <TabsTrigger value="superseded">Superseded trail</TabsTrigger>
          </TabsList>

          <TabsContent value="completed" className="mt-4">
            <SectionCard
              title="Completed cleans"
              description="Each finished clean, who is credited, how long it took against the estimate and how inspection resolved."
            >
              <QueryState
                isLoading={completed.isLoading}
                error={completed.error}
                isEmpty={cleanRows.length === 0}
                empty={
                  <EmptyState
                    icon={Sparkles}
                    title="No completed cleans in this period"
                    description="Completed housekeeping jobs appear here once staff finish work on the board. Widen the date range to see earlier activity."
                  />
                }
              >
                <TableScroll>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Job</TableHead>
                        <TableHead>Room</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Housekeeper</TableHead>
                        <TableHead>Completed</TableHead>
                        <TableHead>Duration</TableHead>
                        <TableHead>Estimate</TableHead>
                        <TableHead>Inspection</TableHead>
                        <TableHead className="text-right">Detail</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {cleanRows.map((row) => {
                        const mins = minutesBetween(row["started_at"], row["completed_at"]);
                        const estimate = Number(row["estimated_minutes"] ?? 0);
                        const over = mins !== null && estimate > 0 && mins > estimate;
                        const inspection = text(row["inspection_status"], "not-required");
                        return (
                          <TableRow key={String(row["id"])}>
                            <TableCell className="font-mono text-xs">{text(row["job_number"])}</TableCell>
                            <TableCell>{roomLabel(row)}</TableCell>
                            <TableCell>{titleCase(text(row["job_type"], "cleaning"))}</TableCell>
                            <TableCell>{nameFor(row)}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {row["completed_at"] ? shortDateTime(row["completed_at"]) : "—"}
                            </TableCell>
                            <TableCell className={over ? "text-sm text-warning" : "text-sm"}>
                              {formatMinutes(mins)}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {estimate > 0 ? formatMinutes(estimate) : "—"}
                            </TableCell>
                            <TableCell>
                              <StatusPill
                                tone={
                                  inspection === "passed"
                                    ? "success"
                                    : inspection === "failed"
                                      ? "destructive"
                                      : "default"
                                }
                              >
                                {titleCase(inspection)}
                              </StatusPill>
                            </TableCell>
                            <TableCell className="text-right">
                              <Button variant="ghost" size="sm" onClick={() => setDetail(row)}>
                                View
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableScroll>
              </QueryState>
            </SectionCard>
          </TabsContent>

          <TabsContent value="team" className="mt-4">
            <SectionCard
              title="Housekeeper performance"
              description="Attribution comes from the assignee recorded on each job. Work finished by a team rather than a named person is shown as a team line, never invented against an individual."
            >
              <QueryState
                isLoading={completed.isLoading}
                error={completed.error}
                isEmpty={byWorker.length === 0}
                empty={
                  <EmptyState
                    icon={Users}
                    title="No attributed cleaning yet"
                    description="Assign cleaning jobs to named housekeepers on the board and their completed work will be summarised here."
                  />
                }
              >
                <TableScroll>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Housekeeper</TableHead>
                        <TableHead className="text-right">Cleans</TableHead>
                        <TableHead className="text-right">Avg time</TableHead>
                        <TableHead className="text-right">Time logged</TableHead>
                        <TableHead className="text-right">Inspection pass</TableHead>
                        <TableHead className="text-right">Rework</TableHead>
                        <TableHead>Last clean</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {byWorker.map((entry) => (
                        <TableRow key={entry.name}>
                          <TableCell className="font-medium">{entry.name}</TableCell>
                          <TableCell className="text-right">{entry.cleans}</TableCell>
                          <TableCell className="text-right">
                            {formatMinutes(entry.timed ? Math.round(entry.minutes / entry.timed) : null)}
                          </TableCell>
                          <TableCell className="text-right">{formatMinutes(entry.minutes || null)}</TableCell>
                          <TableCell className="text-right">
                            {entry.inspected
                              ? `${Math.round((entry.passed / entry.inspected) * 100)}%`
                              : "Awaiting Data"}
                          </TableCell>
                          <TableCell className="text-right">{entry.rework}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {entry.last ? shortDateTime(entry.last) : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableScroll>
              </QueryState>
            </SectionCard>
          </TabsContent>

          <TabsContent value="superseded" className="mt-4">
            <SectionCard
              title="Superseded cleaning tasks"
              description="Duplicate cleaning requests are never deleted. Each row shows the task that was replaced, the job that replaced it and the recorded reason. Open a row for the immutable audit evidence."
            >
              <div className="mb-4 grid gap-3 sm:grid-cols-2">
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Filter by audit reason"
                  aria-label="Filter superseded cleaning tasks by audit reason"
                  className="h-9 min-w-0"
                />
                <div className="flex items-center text-xs text-muted-foreground">
                  {supersededRows.length} superseded · 0 deleted
                </div>
              </div>
              <QueryState
                isLoading={superseded.isLoading}
                error={superseded.error}
                isEmpty={supersededRows.length === 0}
                empty={
                  <EmptyState
                    icon={History}
                    title="No superseded cleaning tasks"
                    description="Every cleaning request for these rooms has stayed the single active task."
                  />
                }
              >
                <TableScroll>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Task</TableHead>
                        <TableHead>Room</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Raised</TableHead>
                        <TableHead>Superseded</TableHead>
                        <TableHead>Replaced by</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Evidence</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {supersededRows.map((row) => (
                        <TableRow key={String(row["id"])}>
                          <TableCell className="font-mono text-xs">{text(row["job_number"])}</TableCell>
                          <TableCell>{roomLabel(row)}</TableCell>
                          <TableCell>{titleCase(text(row["job_type"], "cleaning"))}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {row["created_at"] ? shortDateTime(row["created_at"]) : "—"}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {row["superseded_at"] ? shortDateTime(row["superseded_at"]) : "—"}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{text(row["superseded_by"])}</TableCell>
                          <TableCell className="max-w-72 whitespace-normal text-sm">
                            {text(row["supersede_reason"], "No reason recorded")}
                          </TableCell>
                          <TableCell>
                            <StatusPill tone="default">{titleCase(text(row["status"]))}</StatusPill>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button variant="ghost" size="sm" onClick={() => setSelected(row)}>
                              View
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableScroll>
              </QueryState>
            </SectionCard>
          </TabsContent>
        </Tabs>
      </div>

      <CleanInspector row={detail} name={detail ? nameFor(detail) : ""} onClose={() => setDetail(null)} />
      <SupersedeInspector row={selected} onClose={() => setSelected(null)} />
    </OpsGuard>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[0.65rem] uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <div className="mt-1 break-words text-sm">{value}</div>
    </div>
  );
}

function CleanInspector({ row, name, onClose }: { row: Row | null; name: string; onClose: () => void }) {
  const mins = row ? minutesBetween(row["started_at"], row["completed_at"]) : null;
  return (
    <InspectorSheet
      open={Boolean(row)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Clean ${text(row?.["job_number"])}`}
      subtitle={row ? `Room ${roomLabel(row)} · ${titleCase(text(row["job_type"], "cleaning"))}` : ""}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Housekeeper" value={name || "Unattributed"} />
        <Field label="Priority" value={titleCase(text(row?.["priority"], "normal"))} />
        <Field label="Started" value={row?.["started_at"] ? shortDateTime(row["started_at"]) : "Not recorded"} />
        <Field label="Completed" value={row?.["completed_at"] ? shortDateTime(row["completed_at"]) : "—"} />
        <Field label="Duration" value={formatMinutes(mins)} />
        <Field
          label="Estimate"
          value={Number(row?.["estimated_minutes"] ?? 0) > 0 ? formatMinutes(Number(row?.["estimated_minutes"])) : "Not set"}
        />
        <Field label="Inspection" value={titleCase(text(row?.["inspection_status"], "not-required"))} />
        <Field label="Rework count" value={String(row?.["rework_count"] ?? 0)} />
      </div>
      <div className="mt-4">
        <Field label="Notes" value={text(row?.["notes"], "No notes recorded")} />
      </div>
      <p className="mt-6 text-xs text-muted-foreground">
        Times and attribution are read exactly as recorded on the job. Nothing on this screen can change a
        completed clean.
      </p>
    </InspectorSheet>
  );
}

function SupersedeInspector({ row, onClose }: { row: Record<string, unknown> | null; onClose: () => void }) {
  const jobId = row ? String(row["id"]) : null;
  const audit = useHousekeepingSupersedeAudit(jobId);
  const entry = (audit.data ?? [])[0] as Record<string, unknown> | undefined;

  return (
    <InspectorSheet
      open={Boolean(row)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Cleaning task ${text(row?.["job_number"])}`}
      subtitle={row ? `Room ${roomLabel(row)} · superseded` : ""}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Supersession reason" value={text(row?.["supersede_reason"], "No reason recorded")} />
        <Field label="Replacement task" value={<span className="font-mono text-xs">{text(row?.["superseded_by"])}</span>} />
        <Field
          label="Actor"
          value={text(entry?.["user_name"] ?? (audit.isLoading ? "Loading…" : "System"))}
        />
        <Field
          label="Timestamp"
          value={row?.["superseded_at"] ? shortDateTime(row["superseded_at"]) : "—"}
        />
        <Field label="Audit action" value={<span className="font-mono text-xs">{text(entry?.["action"], "housekeeping.job.superseded")}</span>} />
        <Field
          label="Audit recorded"
          value={entry?.["created_at"] ? shortDateTime(entry["created_at"]) : audit.isLoading ? "Loading…" : "Not found"}
        />
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        This entry is written by the system when a duplicate cleaning request is raised. It cannot be
        edited or deleted from this screen — the original task and its audit record are both retained.
      </p>

      <div className="mt-4">
        <Button asChild variant="outline" size="sm">
          <Link to="/audit-logs">Open immutable audit trail</Link>
        </Button>
      </div>
    </InspectorSheet>
  );
}
