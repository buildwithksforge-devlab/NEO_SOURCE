import { createFileRoute } from "@tanstack/react-router";
import { BedDouble, ClipboardCheck, Search, Sparkles, TriangleAlert, Wrench } from "lucide-react";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import {
  OpsAssistant,
  OpsBadge,
  OpsGuard,
  QueryState,
  EmptyState,
} from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import {
  useCreateJob,
  useHousekeepingJobs,
  useOpsMetrics,
  useRoomState,
  useRoomStateReconciliation,
  useWorkOrders,
} from "@/lib/operations-data";
import {
  buildOperationsInsights,
  jobStatusTone,
  num,
  roomHousekeepingState,
  shortDateTime,
  titleCase,
} from "@/lib/operations";

export const Route = createFileRoute("/_shell/housekeeping/")({
  head: () => ({
    meta: [
      { title: "Housekeeping Dashboard — HOS" },
      {
        name: "description",
        content: "Room readiness, cleaning progress, inspections and workload at a glance.",
      },
      { property: "og:title", content: "Housekeeping Dashboard — HOS" },
      {
        property: "og:description",
        content: "Room readiness, cleaning progress, inspections and workload at a glance.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

/**
 * Contradictions a cleaning task actually resolves: the room is soiled or was
 * failed on inspection, and nothing is scheduled to put it right.
 */
function needsCleaningTask(issue: string): boolean {
  const key = issue.toLowerCase().replace(/_/g, "-");
  return (
    key.includes("without-cleaning-task") ||
    key.includes("no-cleaning-task") ||
    key === "dirty-without-task"
  );
}

function Page() {
  const createJob = useCreateJob();
  const metrics = useOpsMetrics();
  const jobs = useHousekeepingJobs();
  const workOrders = useWorkOrders();
  const roomState = useRoomState();
  const reconciliation = useRoomStateReconciliation();
  const m = metrics.data ?? {};

  const insights = buildOperationsInsights(m, workOrders.data ?? [], jobs.data ?? []);
  const active = (jobs.data ?? []).filter(
    (j) => ![
      "completed",
      "inspected",
      "closed",
      "cancelled",
      "superseded",
    ].includes(
      String(j["status"] ?? "").trim().toLowerCase(),
    ),
  );

  /**
   * Room counts come from the one authoritative room read model, using its
   * derived readiness state — never from a locally recomputed status. Until
   * that query resolves we show a loading marker, never a false zero.
   */
  const roomsPending = roomState.isLoading;
  const rooms = (roomState.data ?? []) as Record<string, unknown>[];
  const countCondition = (key: string) =>
    rooms.filter((r) => roomHousekeepingState(r) === key).length;
  /**
   * Maintenance state is reported on its own axis: a room blocked for
   * maintenance keeps whatever housekeeping condition it has, so the two are
   * never merged into a single figure.
   */
  const maintenanceOf = (r: Record<string, unknown>) =>
    String(r["maintenance_status"] ?? "operational");
  const countMaintenance = (keys: string[]) =>
    rooms.filter((r) => keys.includes(maintenanceOf(r))).length;
  const sellableNow = rooms.filter((r) => Boolean(r["sellable_now"])).length;
  const roomStat = (value: number) => (roomsPending ? "…" : roomState.error ? "—" : String(value));
  const metricStat = (key: string) =>
    metrics.isLoading ? "…" : metrics.error ? "—" : String(num(m[key]));

  return (
    <OpsGuard module="housekeeping">
      <PageHeader
        eyebrow="Operations"
        title="Housekeeping"
        description="Live readiness for every room, backed by the property's authoritative room record."
      />

      <div className="neo-kpi-grid">
        <StatCard lead label="Total rooms" value={roomStat(rooms.length)} icon={BedDouble} />
        <StatCard
          label="Ready / sellable now"
          value={roomStat(sellableNow)}
          icon={BedDouble}
          tone="success"
        />
        <StatCard
          label="Dirty"
          value={roomStat(countCondition("dirty"))}
          icon={BedDouble}
          tone="warning"
        />
        <StatCard
          label="Cleaning queued"
          value={roomStat(countCondition("cleaning_queued"))}
          icon={Sparkles}
        />
        <StatCard
          label="Cleaning in progress"
          value={roomStat(countCondition("cleaning_in_progress"))}
          icon={Sparkles}
        />
        <StatCard
          label="Awaiting inspection"
          value={roomStat(countCondition("awaiting_inspection"))}
          icon={ClipboardCheck}
          tone="warning"
        />
        <StatCard
          label="Maintenance blocked"
          value={roomStat(countMaintenance(["under-maintenance", "out-of-order"]))}
          icon={Wrench}
          tone="warning"
        />
        <StatCard
          label="Out of service"
          value={roomStat(countMaintenance(["out-of-service"]))}
          icon={Wrench}
          tone="warning"
        />
        <StatCard
          label="Rework required"
          value={roomStat(countCondition("rework_required"))}
          icon={TriangleAlert}
          tone="warning"
        />
        <StatCard
          label="Failed inspections"
          value={metricStat("failed_inspections")}
          icon={ClipboardCheck}
        />
        <StatCard label="Lost & Found open" value={metricStat("lost_found_open")} icon={Search} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SectionCard
            title="Open cleaning work"
            description="Everything not yet completed across the property."
          >
            <QueryState
              isLoading={jobs.isLoading}
              error={jobs.error}
              isEmpty={active.length === 0}
              empty={
                <EmptyState
                  title="No open cleaning work"
                  description="Cleaning tasks appear here automatically when a guest checks out or a supervisor schedules work."
                />
              }
            >
              <ul className="divide-y divide-border">
                {active.slice(0, 12).map((job) => (
                  <li
                    key={String(job["id"])}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div>
                      <p className="text-sm font-medium">
                        {job["rooms"]?.room_number
                          ? `Room ${job["rooms"].room_number}`
                          : (job["location_label"] ?? "Area")}{" "}
                        · {titleCase(job["job_type"])}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {job["job_number"] ?? "—"} · due {shortDateTime(job["due_at"])}
                      </p>
                    </div>
                    <OpsBadge value={job["status"]} tone={jobStatusTone(job["status"])} />
                  </li>
                ))}
              </ul>
            </QueryState>
          </SectionCard>
        </div>
        <OpsAssistant insights={insights} />
      </div>

      <div className="mt-6">
        <SectionCard
          title="State reconciliation"
          description="Rooms whose stored state disagrees with the cleaning, inspection or maintenance evidence. A dirty room with no cleaning task can be given one from here."
        >
          <QueryState
            isLoading={reconciliation.isLoading}
            error={reconciliation.error}
            isEmpty={(reconciliation.data ?? []).length === 0}
            empty={
              <EmptyState
                title="No contradictions found"
                description="Every room's condition agrees with its open tasks, inspections and maintenance blocks."
              />
            }
          >
            <ul className="divide-y divide-border">
              {(reconciliation.data ?? []).map((issue, i) => (
                <li
                  key={`${String(issue["room_id"])}-${i}`}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div>
                    <p className="text-sm font-medium">
                      Room {String(issue["room_number"])} ·{" "}
                      {titleCase(String(issue["issue"]).replace(/-/g, " "))}
                    </p>
                    <p className="text-xs text-muted-foreground">{String(issue["detail"])}</p>
                  </div>
                  {needsCleaningTask(String(issue["issue"])) && issue["room_id"] ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={createJob.isPending}
                      onClick={() =>
                        createJob.mutate({
                          room: String(issue["room_id"]),
                          // "recovery" is the canonical task type the database
                          // accepts here, and unlike checkout cleaning it is
                          // valid whether or not the room is still occupied.
                          jobType: "recovery",
                          priority: "high",
                          notes: `Recovery: ${String(issue["detail"] ?? "room dirty with no cleaning task")}`,
                          source: "state-reconciliation",
                          sourceRecord: String(issue["room_id"]),
                          // One recovery task per room per contradiction, so a
                          // double click cannot open two cleaning jobs.
                          idempotencyKey: `hk:recovery:${String(issue["issue"])}:${String(issue["room_id"])}`,
                        })
                      }
                    >
                      Raise cleaning task
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </QueryState>
        </SectionCard>
      </div>
    </OpsGuard>
  );
}
