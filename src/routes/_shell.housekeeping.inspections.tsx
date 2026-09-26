import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ClipboardCheck } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { EmptyState, OpsBadge, OpsGuard, QueryState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  inspectionLines,
  parseChecklistSnapshot,
} from "@/components/housekeeping/CleaningChecklist";
import {
  INSPECTION_RESULTS,
  INSPECTION_TYPES,
  jobStatusTone,
  shortDateTime,
  titleCase,
  type Row,
} from "@/lib/operations";
import {
  useDeepCleanSchedules,
  useHousekeepingJobs,
  useJobChecklistResults,
  useRecordInspection,
  useRoomInspections,
} from "@/lib/operations-data";

/**
 * The standard that applied to this clean, and what the attendant recorded
 * against it. A supervisor should never sign a room back to sale without seeing
 * both — including the lines declared not applicable, and why.
 */
function ChecklistEvidence({ job }: { job: Row }) {
  const results = useJobChecklistResults(String(job["id"]));
  const rows = results.data ?? [];
  const lines = parseChecklistSnapshot(job["checklist_snapshot"]);
  const checks = inspectionLines(lines);
  const byLabel = new Map(rows.map((r) => [String(r["label"]), r]));
  const skipped = rows.filter((r) => String(r["result"]) === "not-applicable");
  const issues = rows.filter((r) => String(r["result"]) === "issue");

  const standard = job["template_name"]
    ? `${String(job["template_name"])} · version ${String(job["template_version"] ?? 1)}`
    : null;

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border/60 p-3">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Standard applied</p>
        <p className="text-sm font-medium">
          {standard ?? "No cleaning standard was configured when this job was raised"}
        </p>
        {results.isLoading ? (
          <p className="mt-1 text-xs text-muted-foreground">Loading what was recorded…</p>
        ) : rows.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Nothing was recorded against this clean.
          </p>
        ) : (
          <p className="mt-1 text-sm">
            {rows.length - skipped.length - issues.length} of {rows.length} steps done
            {issues.length > 0 ? ` · ${issues.length} issue${issues.length === 1 ? "" : "s"}` : ""}
            {skipped.length > 0 ? ` · ${skipped.length} not applicable` : ""}
          </p>
        )}
        {[...issues, ...skipped].length > 0 ? (
          <ul className="mt-2 space-y-1">
            {[...issues, ...skipped].map((r) => (
              <li key={String(r["id"])} className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{String(r["label"])}</span> —{" "}
                {String(r["result"])}
                {r["comment"] ? `: ${String(r["comment"])}` : " (no reason given)"}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {checks.length > 0 ? (
        <div className="rounded-lg border border-border/60 p-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            What to inspect
          </p>
          <ul className="mt-2 space-y-1.5">
            {checks.map((line) => {
              const recorded = byLabel.get(line.label);
              return (
                <li key={line.label} className="text-xs">
                  <span className="font-medium text-foreground">{line.label}</span>
                  {line.instructions ? (
                    <span className="text-muted-foreground"> — {line.instructions}</span>
                  ) : null}
                  {recorded ? (
                    <span className="text-muted-foreground">
                      {" "}
                      · attendant: {String(recorded["result"])}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export const Route = createFileRoute("/_shell/housekeeping/inspections")({
  head: () => ({
    meta: [
      { title: "Inspections — Housekeeping — HOS" },
      {
        name: "description",
        content: "Supervisor inspections, rework and deep-cleaning schedules for every room.",
      },
      { property: "og:title", content: "Inspections — Housekeeping — HOS" },
      {
        property: "og:description",
        content: "Supervisor inspections, rework and deep-cleaning schedules for every room.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function Page() {
  const jobs = useHousekeepingJobs();
  const inspections = useRoomInspections();
  const deepClean = useDeepCleanSchedules();
  const record = useRecordInspection();

  const [active, setActive] = useState<Row | null>(null);
  const [result, setResult] = useState("passed");
  const [type, setType] = useState("standard");
  const [notes, setNotes] = useState("");

  const queue = useMemo(
    () => (jobs.data ?? []).filter((j) => String(j["status"]) === "awaiting-inspection"),
    [jobs.data],
  );

  return (
    <OpsGuard module="housekeeping" action="inspect">
      <PageHeader
        eyebrow="Housekeeping"
        title="Inspections"
        description="Only a passed inspection releases a room back to Front Office as sellable."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard
          title="Awaiting inspection"
          description="Rooms cleaned and submitted by attendants."
        >
          <QueryState
            isLoading={jobs.isLoading}
            error={jobs.error}
            isEmpty={queue.length === 0}
            empty={
              <EmptyState
                title="Inspection queue is clear"
                description="Nothing is waiting for supervisor sign-off."
                icon={ClipboardCheck}
              />
            }
          >
            <ul className="divide-y divide-border">
              {queue.map((job) => (
                <li
                  key={String(job["id"])}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div>
                    <p className="text-sm font-medium">
                      {job["rooms"]?.room_number
                        ? `Room ${job["rooms"].room_number}`
                        : (job["location_label"] ?? "Area")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {titleCase(job["job_type"])} · completed {shortDateTime(job["completed_at"])}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <OpsBadge value={job["status"]} tone={jobStatusTone(job["status"])} />
                    <Button
                      size="sm"
                      onClick={() => {
                        setActive(job);
                        setResult("passed");
                        setNotes("");
                      }}
                    >
                      Inspect
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </QueryState>
        </SectionCard>

        <SectionCard
          title="Recent inspections"
          description="Immutable record of every supervisor decision."
        >
          <QueryState
            isLoading={inspections.isLoading}
            error={inspections.error}
            isEmpty={(inspections.data ?? []).length === 0}
            empty={
              <EmptyState
                title="No inspections yet"
                description="Inspection outcomes appear here as supervisors sign off rooms."
              />
            }
          >
            <ul className="divide-y divide-border">
              {(inspections.data ?? []).slice(0, 15).map((row) => (
                <li
                  key={String(row["id"])}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <div>
                    <p className="text-sm font-medium">
                      {row["rooms"]?.room_number
                        ? `Room ${row["rooms"].room_number}`
                        : titleCase(row["inspection_type"])}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {shortDateTime(row["inspected_at"])}
                    </p>
                  </div>
                  <OpsBadge
                    value={row["result"]}
                    tone={String(row["result"]).startsWith("passed") ? "success" : "destructive"}
                  />
                </li>
              ))}
            </ul>
          </QueryState>
        </SectionCard>
      </div>

      <div className="mt-6">
        <SectionCard
          title="Deep cleaning schedule"
          description="Planned periodic deep cleans, kept out of the daily turnover."
        >
          <QueryState
            isLoading={deepClean.isLoading}
            error={deepClean.error}
            isEmpty={(deepClean.data ?? []).length === 0}
            empty={
              <EmptyState
                title="No deep-clean schedule"
                description="Create a schedule to rotate rooms through periodic deep cleaning."
              />
            }
          >
            <ul className="divide-y divide-border">
              {(deepClean.data ?? []).map((row) => (
                <li
                  key={String(row["id"])}
                  className="flex items-center justify-between gap-3 py-3 text-sm"
                >
                  <span>
                    {row["rooms"]?.room_number
                      ? `Room ${row["rooms"].room_number}`
                      : String(row["area_label"] ?? "Area")}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {titleCase(row["frequency"])} · next {shortDateTime(row["next_due_date"])}
                  </span>
                </li>
              ))}
            </ul>
          </QueryState>
        </SectionCard>
      </div>

      <Dialog open={Boolean(active)} onOpenChange={(v) => !v && setActive(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record inspection</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {active ? <ChecklistEvidence job={active} /> : null}
            <div>
              <Label>Inspection type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INSPECTION_TYPES.map((t) => (
                    <SelectItem key={t.key} value={t.key}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Result</Label>
              <Select value={result} onValueChange={setResult}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INSPECTION_RESULTS.map((r) => (
                    <SelectItem key={r.key} value={r.key}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Defects, coaching notes or rework reason"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              A failed inspection returns the task to the attendant as rework — the room is never
              released to sale.
            </p>
          </div>
          <DialogFooter>
            <Button
              // A failed inspection sends the attendant back into the room, so
              // it has to say what is wrong.
              disabled={
                record.isPending || (!String(result).startsWith("passed") && !notes.trim())
              }
              onClick={() =>
                active &&
                record.mutate(
                  { job: String(active["id"]), result, notes, type },
                  { onSuccess: () => setActive(null) },
                )
              }
            >
              Save inspection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </OpsGuard>
  );
}
