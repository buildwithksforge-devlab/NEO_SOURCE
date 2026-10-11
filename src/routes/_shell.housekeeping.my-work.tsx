import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, Luggage, PackagePlus, PlayCircle, Send, Wrench } from "lucide-react";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import { EmptyState, OpsBadge, OpsGuard, QueryState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
  CleaningChecklistForm,
  checklistResultRows,
  cleaningLines,
  outstandingRequired,
  parseChecklistSnapshot,
  type ChecklistEntry,
} from "@/components/housekeeping/CleaningChecklist";
import { useAuth } from "@/lib/auth";
import { jobStatusTone, shortDateTime, titleCase } from "@/lib/operations";
import { useCompleteJob, useSaveLostFound, useStartJob } from "@/lib/operations-data";
import {
  HK_FAULT_CATEGORIES,
  HK_PRIORITIES,
  HK_SUPPLY_SUGGESTIONS,
  str,
  useMyHousekeepingJobs,
  useMyHousekeepingTasks,
  useReportHkStockNeed,
  useAdvanceMyTask,
  useReportRoomFault,
  type HkRow,
} from "@/lib/housekeeping-department";

export const Route = createFileRoute("/_shell/housekeeping/my-work")({
  head: () => ({
    meta: [
      { title: "My Work — Housekeeping — NEØ" },
      {
        name: "description",
        content:
          "The rooms and tasks assigned to you: start cleaning, send a room for inspection, report a fault or a supply need.",
      },
      { property: "og:title", content: "My Work — Housekeeping — NEØ" },
      {
        property: "og:description",
        content:
          "Your assigned rooms and tasks only, with cleaning, inspection handover and reporting actions.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard path="/housekeeping/my-work">
      <MyWorkPage />
    </OpsGuard>
  ),
});

function roomLabel(job: HkRow) {
  const room = (job["rooms"] ?? {}) as HkRow;
  if (room["room_number"]) return `Room ${str(room["room_number"], "")}`;
  return str(job["location_label"], "Area");
}

/** Filters over the housekeeper's *own* jobs — no department-wide fact is read. */
export type MyWorkFilter = "all" | "due" | "overdue" | "in-progress" | "completed-today";

const MY_WORK_FILTERS: { key: MyWorkFilter; label: string; tone?: "warning" | "success" }[] = [
  { key: "all", label: "Assigned to me" },
  { key: "due", label: "Due today" },
  { key: "overdue", label: "Overdue", tone: "warning" },
  { key: "in-progress", label: "In progress" },
  { key: "completed-today", label: "Completed today", tone: "success" },
];

const startOfToday = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate());
const endOfToday = (now: Date) => new Date(startOfToday(now).getTime() + 24 * 60 * 60 * 1000);

/** A task is "open" until the worker has picked it up. */
export const taskStatus = (task: HkRow): string => {
  const s = String(task["status"] ?? "open");
  return ["open", "pending", "assigned", "scheduled", "not-started"].includes(s) ? "open" : s;
};

const TERMINAL_HK_JOB_STATUSES = new Set([
  "completed",
  "inspected",
  "closed",
  "cancelled",
  "superseded",
]);

const jobDone = (job: HkRow): boolean =>
  TERMINAL_HK_JOB_STATUSES.has(
    String(job["status"] ?? "").trim().toLowerCase(),
  );

const jobCompleted = (job: HkRow): boolean =>
  ["completed", "inspected", "closed"].includes(
    String(job["status"] ?? "").trim().toLowerCase(),
  );

/**
 * Pure filter used by the page and by the regression tests. Every predicate is
 * derived from fields already on the housekeeper's own assigned jobs.
 */
export function filterMyJobs(rows: HkRow[], filter: MyWorkFilter, now = new Date()): HkRow[] {
  const dayStart = startOfToday(now);
  const dayEnd = endOfToday(now);
  const at = (value: unknown) => {
    const d = value ? new Date(String(value)) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  };
  switch (filter) {
    case "due": {
      return rows.filter((j) => {
        const due = at(j["due_at"]);
        return !jobDone(j) && due !== null && due >= dayStart && due < dayEnd;
      });
    }
    case "overdue": {
      return rows.filter((j) => {
        const due = at(j["due_at"]);
        return !jobDone(j) && due !== null && due < now;
      });
    }
    case "in-progress":
      return rows.filter((j) => String(j["status"]) === "in-progress");
    case "completed-today": {
      return rows.filter((j) => {
        if (!jobCompleted(j)) return false;

        const done = at(j["completed_at"]);

        return (
          done !== null &&
          done >= dayStart &&
          done < dayEnd
        );
      });
    }
    default:
      return rows.filter((j) => !jobDone(j));
  }
}

function MyWorkPage() {
  const { can } = useAuth();
  // Each action names the precise capability it performs — no action class,
  // no module wildcard, so a button never appears without the authority.
  const mayStart = can("housekeeping", "cleaning", "start");
  const mayComplete = can("housekeeping", "cleaning", "complete");
  const mayReportSupplies = can("housekeeping", "supply-need", "report");
  const mayReportFault = can("maintenance", "work-orders", "create");
  // Reporting a found item is a subordinate action; running the central
  // register is `lost-found.manage` and stays with the supervisor.
  const mayReportLostFound =
    can("housekeeping", "lost-found", "report") || can("housekeeping", "my-work", "edit");

  const jobs = useMyHousekeepingJobs(true);
  const tasks = useMyHousekeepingTasks();
  const start = useStartJob();
  const complete = useCompleteJob();
  const reportNeed = useReportHkStockNeed();
  const reportFault = useReportRoomFault();
  const reportLostFound = useSaveLostFound();
  const advanceTask = useAdvanceMyTask();

  const allRows = (jobs.data ?? []) as HkRow[];
  const openTasks = ((tasks.data ?? []) as HkRow[]).filter(
    (task) =>
      ![
        "completed",
        "cancelled",
        "rejected",
        "superseded",
        "closed",
      ].includes(
        String(task["status"] ?? "open").trim().toLowerCase(),
      ),
  );
  // A task that belongs to a room cleaning job is a reminder, not a second
  // workflow: it closes when the clean does, so it is never actionable here.
  const linkedJobByTask = new Map<string, HkRow>();
  for (const job of allRows) {
    if (job["task_id"]) linkedJobByTask.set(String(job["task_id"]), job);
  }

  const [lostOpen, setLostOpen] = useState(false);
  const [lostDescription, setLostDescription] = useState("");
  const [lostLocation, setLostLocation] = useState("");
  const [filter, setFilter] = useState<MyWorkFilter>("all");
  const rows = filterMyJobs(allRows, filter);

  const counts: Record<MyWorkFilter, number> = {
    all: filterMyJobs(allRows, "all").length,
    due: filterMyJobs(allRows, "due").length,
    overdue: filterMyJobs(allRows, "overdue").length,
    "in-progress": filterMyJobs(allRows, "in-progress").length,
    "completed-today": filterMyJobs(allRows, "completed-today").length,
  };

  const [handover, setHandover] = useState<HkRow | null>(null);
  const [handoverNotes, setHandoverNotes] = useState("");
  // The cleaning standard as it stood when this job was raised — never the
  // template as it reads today, so past evidence is not rewritten.
  const [checklistEntries, setChecklistEntries] = useState<Record<string, ChecklistEntry>>({});
  const handoverLines = handover ? parseChecklistSnapshot(handover["checklist_snapshot"]) : [];
  const handoverOutstanding = outstandingRequired(handoverLines, checklistEntries);

  const [faultFor, setFaultFor] = useState<HkRow | null>(null);
  const [faultDescription, setFaultDescription] = useState("");
  const [faultCategory, setFaultCategory] = useState<string>("other");
  const [faultPriority, setFaultPriority] = useState("normal");

  const [needOpen, setNeedOpen] = useState(false);
  const [item, setItem] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState("unit");
  const [needPriority, setNeedPriority] = useState("normal");
  const [needNotes, setNeedNotes] = useState("");


  const submitHandover = () => {
    if (!handover || handoverOutstanding.length > 0) return;
    const results = checklistResultRows(
      String(handover["id"]),
      handover["organization_id"] ? String(handover["organization_id"]) : null,
      handoverLines,
      checklistEntries,
    );
    complete.mutate(
      {
        id: String(handover["id"]),
        ...(handoverNotes ? { notes: handoverNotes } : {}),
        ...(results.length ? { results } : {}),
      },
      {
        onSuccess: () => {
          setHandover(null);
          setHandoverNotes("");
          setChecklistEntries({});
        },
      },
    );
  };

  const submitFault = () => {
    reportFault.mutate(
      {
        roomId: faultFor?.["room_id"] ? String(faultFor["room_id"]) : null,
        locationLabel: faultFor ? roomLabel(faultFor) : null,
        description: faultDescription,
        faultCategory,
        priority: faultPriority,
        guestImpact: faultPriority === "urgent",
      },
      {
        onSuccess: () => {
          setFaultFor(null);
          setFaultDescription("");
          setFaultCategory("other");
          setFaultPriority("normal");
        },
      },
    );
  };

  const submitLostFound = () => {
    reportLostFound.mutate(
      {
        description: lostDescription,
        location_found: lostLocation || null,
        status: "reported",
        found_at: new Date().toISOString(),
      },
      {
        onSuccess: () => {
          setLostOpen(false);
          setLostDescription("");
          setLostLocation("");
        },
      },
    );
  };

  const submitNeed = () => {
    reportNeed.mutate(
      {
        item,
        quantity: Number(quantity) || 0,
        unit,
        priority: needPriority,
        ...(needNotes ? { notes: needNotes } : {}),
      },
      {
        onSuccess: () => {
          setNeedOpen(false);
          setItem("");
          setQuantity("1");
          setUnit("unit");
          setNeedPriority("normal");
          setNeedNotes("");
        },
      },
    );
  };

  return (
    <div>
      <PageHeader
        eyebrow="Housekeeping"
        title="My work"
        description="Only the rooms and tasks assigned to you. Cleaning you finish goes to your supervisor for inspection before the room is sold."
        actions={
          <div className="flex flex-wrap gap-2">
            {mayReportLostFound ? (
              <Button variant="outline" onClick={() => setLostOpen(true)}>
                <Luggage className="mr-2 h-4 w-4" /> Report lost &amp; found item
              </Button>
            ) : null}
            {mayReportSupplies ? (
              <Button variant="outline" onClick={() => setNeedOpen(true)}>
                <PackagePlus className="mr-2 h-4 w-4" /> Report supply need
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {MY_WORK_FILTERS.map((f) => (
          <button key={f.key} type="button" onClick={() => setFilter(f.key)} className="text-left">
            <StatCard
              label={f.label}
              value={jobs.isLoading ? "…" : String(counts[f.key])}
              {...(f.tone ? { tone: f.tone } : {})}
            />
          </button>
        ))}
      </div>


      <div className="mt-6">
        <SectionCard
          title="My rooms"
          description="Start the clean, then send the room for inspection when it is finished."
        >
          <QueryState
            isLoading={jobs.isLoading}
            error={jobs.error}
            isEmpty={rows.length === 0}
            empty={
              <EmptyState
                title="Nothing assigned to you"
                description="Your supervisor assigns rooms here. Newly vacated rooms appear as soon as they are allocated to you."
              />
            }
          >
            <ul className="divide-y divide-border">
              {rows.map((job) => {
                const status = String(job["status"] ?? "");
                const canStart =
                  mayStart && ["pending", "assigned", "scheduled", "rework"].includes(status);
                const canFinish = mayComplete && status === "in-progress";
                const steps = cleaningLines(parseChecklistSnapshot(job["checklist_snapshot"]));
                return (
                  <li
                    key={String(job["id"])}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div>
                      <p className="text-sm font-medium">
                        {roomLabel(job)} · {titleCase(String(job["job_type"] ?? ""))}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {str(job["job_number"], "—")} · due {shortDateTime(job["due_at"])}
                        {job["rework_count"] ? ` · rework ${String(job["rework_count"])}` : ""}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {steps.length > 0
                          ? `${String(job["template_name"] ?? "Cleaning standard")} · ${steps.length} step${steps.length === 1 ? "" : "s"}`
                          : "No cleaning standard configured"}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <OpsBadge value={job["status"]} tone={jobStatusTone(job["status"])} />
                      {canStart ? (
                        <Button
                          size="sm"
                          onClick={() => start.mutate(job)}
                          disabled={start.isPending}
                        >
                          <PlayCircle className="mr-2 h-4 w-4" /> Start cleaning
                        </Button>
                      ) : null}
                      {canFinish ? (
                        <Button
                          size="sm"
                          onClick={() => {
                            setHandover(job);
                            setHandoverNotes("");
                            setChecklistEntries({});
                          }}
                        >
                          <Send className="mr-2 h-4 w-4" /> Finish clean
                        </Button>
                      ) : null}
                      {mayReportFault ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setFaultFor(job);
                            setFaultDescription("");
                          }}
                        >
                          <Wrench className="mr-2 h-4 w-4" /> Report fault
                        </Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </QueryState>
        </SectionCard>
      </div>

      <div className="mt-6">
        <SectionCard
          title="My tasks"
          description="Everything else your supervisor has asked you to do."
        >
          <QueryState
            isLoading={tasks.isLoading}
            error={tasks.error}
            isEmpty={openTasks.length === 0}
            empty={
              <EmptyState title="No open tasks" description="Tasks assigned to you appear here." />
            }
          >
            <ul className="divide-y divide-border">
              {openTasks.map((task) => {
                const linkedJob = linkedJobByTask.get(String(task["id"])) ?? null;
                return (
                <li
                  key={String(task["id"])}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div>
                    <p className="text-sm font-medium">{str(task["title"], "Task")}</p>
                    <p className="text-xs text-muted-foreground">
                      {titleCase(String(task["priority"] ?? "normal"))} · due{" "}
                      {shortDateTime(task["due_at"])}
                    </p>
                    {linkedJob ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Follows room job {str(linkedJob["job_number"], "")} above — it closes when
                        that clean is finished and inspected.
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <OpsBadge value={task["status"]} tone="default" />
                    {!linkedJob && taskStatus(task) === "open" && mayStart ? (
                      <Button
                        size="sm"
                        disabled={advanceTask.isPending}
                        onClick={() =>
                          advanceTask.mutate({
                            taskId: String(task["id"]),
                            status: "in-progress",
                          })
                        }
                      >
                        <PlayCircle className="mr-2 h-4 w-4" /> Start
                      </Button>
                    ) : null}
                    {!linkedJob && taskStatus(task) === "in-progress" && mayComplete ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={advanceTask.isPending}
                          onClick={() =>
                            advanceTask.mutate({ taskId: String(task["id"]), status: "review" })
                          }
                        >
                          <Send className="mr-2 h-4 w-4" /> Submit for inspection
                        </Button>
                        <Button
                          size="sm"
                          disabled={advanceTask.isPending}
                          onClick={() =>
                            advanceTask.mutate({ taskId: String(task["id"]), status: "completed" })
                          }
                        >
                          <CheckCircle2 className="mr-2 h-4 w-4" /> Complete
                        </Button>
                      </>
                    ) : null}
                  </div>
                </li>
                );
              })}
            </ul>
          </QueryState>
        </SectionCard>
      </div>

      <Dialog open={lostOpen} onOpenChange={setLostOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report a lost or found item</DialogTitle>
            <DialogDescription>
              Hand the item to your supervisor. They hold custody and close the record in the Lost
              &amp; Found register.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="lost-description">What was found</Label>
              <Input
                id="lost-description"
                value={lostDescription}
                onChange={(e) => setLostDescription(e.target.value)}
                placeholder="e.g. Black wallet"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lost-location">Where it was found</Label>
              <Input
                id="lost-location"
                value={lostLocation}
                onChange={(e) => setLostLocation(e.target.value)}
                placeholder="e.g. Room 214 bedside drawer"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLostOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={submitLostFound}
              disabled={!lostDescription.trim() || reportLostFound.isPending}
            >
              Report item
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(handover)} onOpenChange={(open) => !open && setHandover(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Finish {handover ? roomLabel(handover) : "room"}</DialogTitle>
            <DialogDescription>
              {handover?.["template_name"]
                ? `${String(handover["template_name"])} — work through the standard, then send the room for inspection.`
                : "Your supervisor inspects the room before it can be sold. Add anything they should know."}
            </DialogDescription>
          </DialogHeader>

          <CleaningChecklistForm
            lines={handoverLines}
            entries={checklistEntries}
            onChange={(label, entry) =>
              setChecklistEntries((prev) => ({ ...prev, [label]: entry }))
            }
            emptyState={
              <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                No cleaning standard is configured for this kind of clean yet, so there are no steps
                to record. Your manager can set one up in the Configuration Centre.
              </p>
            }
          />

          <div className="space-y-2">
            <Label htmlFor="handover-notes">Notes for the supervisor</Label>
            <Textarea
              id="handover-notes"
              value={handoverNotes}
              onChange={(e) => setHandoverNotes(e.target.value)}
              placeholder="Anything the inspection should check"
            />
          </div>
          {handoverOutstanding.length > 0 ? (
            <p className="text-xs text-destructive">
              Still to record: {handoverOutstanding.join(", ")}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setHandover(null)}>
              Cancel
            </Button>
            <Button
              onClick={submitHandover}
              disabled={complete.isPending || handoverOutstanding.length > 0}
            >
              Send for inspection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(faultFor)} onOpenChange={(open) => !open && setFaultFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Report a fault in {faultFor ? roomLabel(faultFor) : "this room"}
            </DialogTitle>
            <DialogDescription>
              This raises a maintenance work order. Maintenance owns the repair and the room block.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="fault-description">What is wrong?</Label>
              <Textarea
                id="fault-description"
                value={faultDescription}
                onChange={(e) => setFaultDescription(e.target.value)}
                placeholder="Describe the fault or damage"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Category</Label>
                <Select value={faultCategory} onValueChange={setFaultCategory}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HK_FAULT_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {titleCase(c)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Priority</Label>
                <Select value={faultPriority} onValueChange={setFaultPriority}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HK_PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>
                        {titleCase(p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFaultFor(null)}>
              Cancel
            </Button>
            <Button
              onClick={submitFault}
              disabled={reportFault.isPending || !faultDescription.trim()}
            >
              Report to Maintenance
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={needOpen} onOpenChange={setNeedOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report a supply need</DialogTitle>
            <DialogDescription>
              Your manager reviews this and raises the Stores requisition. Stores owns every stock
              balance.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="need-item">Item</Label>
              <Input
                id="need-item"
                value={item}
                onChange={(e) => setItem(e.target.value)}
                list="hk-supply-suggestions"
                placeholder="Bed linen, towels, chemicals…"
              />
              <datalist id="hk-supply-suggestions">
                {HK_SUPPLY_SUGGESTIONS.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="need-qty">Quantity</Label>
                <Input
                  id="need-qty"
                  type="number"
                  min="1"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="need-unit">Unit</Label>
                <Input id="need-unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Priority</Label>
                <Select value={needPriority} onValueChange={setNeedPriority}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HK_PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>
                        {titleCase(p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="need-notes">Notes</Label>
              <Textarea
                id="need-notes"
                value={needNotes}
                onChange={(e) => setNeedNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNeedOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitNeed} disabled={reportNeed.isPending || !item.trim()}>
              Send to manager
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
