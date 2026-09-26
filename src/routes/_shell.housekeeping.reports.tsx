import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import { OpsGuard } from "@/components/operations/OpsShared";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { minutesBetween, num, titleCase } from "@/lib/operations";
import { EmptyState } from "@/components/common/StateSystem";
import {
  useHousekeepingJobs,
  useOpsMetrics,
  useRoomInspections,
  useStaffLite,
} from "@/lib/operations-data";

export const Route = createFileRoute("/_shell/housekeeping/reports")({
  head: () => ({
    meta: [
      { title: "Housekeeping Reports — HOS" },
      {
        name: "description",
        content: "Cleaning productivity, average turnaround, rework rates and inspection outcomes.",
      },
      { property: "og:title", content: "Housekeeping Reports — HOS" },
      {
        property: "og:description",
        content: "Cleaning productivity, average turnaround, rework rates and inspection outcomes.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function Page() {
  const jobs = useHousekeepingJobs();
  const staff = useStaffLite("housekeeping");
  const inspections = useRoomInspections();
  const metrics = useOpsMetrics();

  const completed = useMemo(
    () => (jobs.data ?? []).filter((j) => String(j["status"]) === "completed"),
    [jobs.data],
  );

  const avgMinutes = useMemo(() => {
    const values = completed
      .map((j) => minutesBetween(j["started_at"], j["completed_at"]))
      .filter((v): v is number => v !== null);
    if (!values.length) return null;
    return Math.round(values.reduce((s, v) => s + v, 0) / values.length);
  }, [completed]);

  const byStaff = useMemo(() => {
    const names = new Map((staff.data ?? []).map((s) => [String(s["id"]), String(s["full_name"])]));
    const map = new Map<
      string,
      { name: string; done: number; rework: number; minutes: number[] }
    >();
    for (const job of jobs.data ?? []) {
      const id = job["assignee_id"] ? String(job["assignee_id"]) : null;
      if (!id) continue;
      const entry = map.get(id) ?? {
        name: names.get(id) ?? "Unassigned",
        done: 0,
        rework: 0,
        minutes: [],
      };
      if (String(job["status"]) === "completed") entry.done += 1;
      entry.rework += num(job["rework_count"]);
      const m = minutesBetween(job["started_at"], job["completed_at"]);
      if (m !== null) entry.minutes.push(m);
      map.set(id, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.done - a.done);
  }, [jobs.data, staff.data]);

  const failed = (inspections.data ?? []).filter((i) => String(i["result"]) === "failed").length;
  const passRate = (inspections.data ?? []).length
    ? Math.round(
        (((inspections.data ?? []).length - failed) / (inspections.data ?? []).length) * 100,
      )
    : null;

  return (
    <OpsGuard module="housekeeping" action="view">
      <PageHeader
        eyebrow="Housekeeping"
        title="Reports"
        description="Productivity and quality measured from the same records staff work on — no separate figures."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Tasks completed" value={String(completed.length)} />
        <StatCard
          label="Average turnaround"
          value={avgMinutes === null ? "—" : `${avgMinutes} min`}
        />
        <StatCard
          label="Inspection pass rate"
          value={passRate === null ? "—" : `${passRate}%`}
          tone="success"
        />
        <StatCard
          label="Rooms awaiting cleaning"
          value={String(num((metrics.data ?? {})["rooms_dirty"]))}
          tone="warning"
        />
      </div>

      <div className="mt-6">
        <SectionCard
          title="Attendant productivity"
          description="Completed rooms, rework and average time per room."
        >
          {byStaff.length === 0 ? (
            <EmptyState inline title="No completed cleaning tasks" description="No completed cleaning tasks have been recorded yet." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Attendant</TableHead>
                    <TableHead className="text-right">Rooms completed</TableHead>
                    <TableHead className="text-right">Rework</TableHead>
                    <TableHead className="text-right">Avg minutes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byStaff.map((row) => (
                    <TableRow key={row.name}>
                      <TableCell className="font-medium">{titleCase(row.name)}</TableCell>
                      <TableCell className="text-right">{row.done}</TableCell>
                      <TableCell className="text-right">{row.rework}</TableCell>
                      <TableCell className="text-right">
                        {row.minutes.length
                          ? Math.round(row.minutes.reduce((s, v) => s + v, 0) / row.minutes.length)
                          : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>
      </div>
    </OpsGuard>
  );
}
