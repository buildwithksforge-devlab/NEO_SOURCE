import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ListChecks } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { EmptyState, OpsBadge, OpsGuard, QueryState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { useAuth } from "@/lib/auth";
import { scopeWorkers, workerLabel, type ScopedWorker } from "@/lib/scoped-options";
import {
  DEFAULT_ROOM_CHECKLIST,
  HK_JOB_STATUSES,
  HK_RAISEABLE_JOB_TYPES,
  PRIORITIES,
  jobStatusTone,
  priorityTone,
  shortDateTime,
  titleCase,
  type Row,
} from "@/lib/operations";
import {
  useCompleteJob,
  useCreateJob,
  useHousekeepingJobs,
  useRoomBoard,
  useStaffLite,
  useStartJob,
  useAssignJob,
  useStaleCleaningTasks,
  useReconcileStaleCleaningTasks,
  useResolveStaleCleaningTask,
  type StaleJobCandidate,
} from "@/lib/operations-data";
import {
  CleaningChecklistForm,
  checklistResultRows,
  cleaningLines,
  outstandingRequired,
  parseChecklistSnapshot,
  type ChecklistEntry,
  type ChecklistLine,
} from "@/components/housekeeping/CleaningChecklist";

export const Route = createFileRoute("/_shell/housekeeping/tasks")({
  head: () => ({
    meta: [
      { title: "Cleaning Tasks — Housekeeping — HOS" },
      {
        name: "description",
        content:
          "Assign, start and complete cleaning work with checklists and supervisor sign-off.",
      },
      { property: "og:title", content: "Cleaning Tasks — Housekeeping — HOS" },
      {
        property: "og:description",
        content:
          "Assign, start and complete cleaning work with checklists and supervisor sign-off.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

/**
 * A checklist line is either done or explicitly not applicable. There is no
 * third, silent state: a room cannot reach inspection with untouched lines.
 *
 * Where the hotel has configured its own cleaning standard, the job carries a
 * frozen copy of it and that copy is what must be recorded — the database
 * enforces exactly those labels. Only a job raised before any standard existed
 * falls back to the generic room lines below.
 */
function fallbackLines(): ChecklistLine[] {
  return DEFAULT_ROOM_CHECKLIST.map((label, index) => ({
    itemId: null,
    label,
    instructions: null,
    appliesTo: "cleaning" as const,
    mandatory: true,
    requiresComment: false,
    requiresPhoto: false,
    allowsDefect: true,
    sortOrder: index,
  }));
}

function Page() {
  const { user, can, organizationId } = useAuth();
  const jobs = useHousekeepingJobs();
  const staff = useStaffLite("housekeeping");
  const rooms = useRoomBoard();
  const createJob = useCreateJob();
  const assignJob = useAssignJob();
  const startJob = useStartJob();
  const completeJob = useCompleteJob();

  const [scope, setScope] = useState<"all" | "mine">(
    can("housekeeping", "tasks.assign") ? "all" : "mine",
  );
  const [status, setStatus] = useState("open");
  const [active, setActive] = useState<Row | null>(null);
  const [entries, setEntries] = useState<Record<string, ChecklistEntry>>({});
  const [notes, setNotes] = useState("");

  const [newRoom, setNewRoom] = useState("");
  const [newType, setNewType] = useState<string>("checkout-cleaning");
  const [newPriority, setNewPriority] = useState("normal");
  const [newAssignee, setNewAssignee] = useState("");
  const [newReason, setNewReason] = useState("");
  const [open, setOpen] = useState(false);

  const selectedNewRoom = useMemo(
    () => (rooms.data ?? []).find((r) => String(r["id"]) === newRoom) ?? null,
    [newRoom, rooms.data],
  );
  const staffRows = useMemo(() => (staff.data ?? []) as unknown as ScopedWorker[], [staff.data]);
  const newTaskStaff = useMemo(
    () =>
      scopeWorkers(
        staffRows,
        selectedNewRoom?.["branch_id"] ? String(selectedNewRoom["branch_id"]) : null,
        null,
        "housekeeping",
      ),
    [staffRows, selectedNewRoom],
  );

  useEffect(() => {
    if (newAssignee && !newTaskStaff.some((member) => member.id === newAssignee))
      setNewAssignee("");
  }, [newAssignee, newTaskStaff]);

  const list = useMemo(() => {
    return (jobs.data ?? []).filter((j) => {
      if (scope === "mine" && j["assignee_id"] !== user?.id) return false;
      if (
        status === "open" &&
        [
          "completed",
          "inspected",
          "closed",
          "cancelled",
          "superseded",
        ].includes(
          String(j["status"] ?? "").trim().toLowerCase(),
        )
      )
        return false;
      if (status !== "open" && status !== "all" && String(j["status"]) !== status) return false;
      return true;
    });
  }, [jobs.data, scope, status, user?.id]);

  const staleCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const mayReconcile = can("housekeeping", "tasks.assign") || can("housekeeping", "tasks.manage");

  const openComplete = (job: Row) => {
    setActive(job);
    setEntries({});
    setNotes("");
  };

  // The standard frozen onto this job, or the generic room lines when the job
  // predates any configured standard.
  const activeLines = useMemo(() => {
    if (!active) return [] as ChecklistLine[];
    const snapshot = parseChecklistSnapshot(active["checklist_snapshot"]);
    return cleaningLines(snapshot).length > 0 ? snapshot : fallbackLines();
  }, [active]);

  // Every required line answered, and every exception carrying a reason.
  const outstanding = outstandingRequired(activeLines, entries);
  const unanswered = cleaningLines(activeLines).filter((line) => !entries[line.label]?.result);
  const checklistReady = outstanding.length === 0 && unanswered.length === 0;

  return (
    <OpsGuard module="housekeeping">
      <PageHeader
        eyebrow="Housekeeping"
        title="Cleaning Tasks"
        description="Mobile-first task cards. Attendants complete the checklist; supervisors release the room."
        actions={
          can("housekeeping", "tasks.create") ? (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button>New task</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create housekeeping task</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <div>
                    <Label>Room</Label>
                    <Select value={newRoom} onValueChange={setNewRoom}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a room" />
                      </SelectTrigger>
                      <SelectContent>
                        {(rooms.data ?? []).map((r) => (
                          <SelectItem key={String(r["id"])} value={String(r["id"])}>
                            Room {String(r["room_number"])}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Assign attendant</Label>
                    <Select value={newAssignee} onValueChange={setNewAssignee}>
                      <SelectTrigger>
                        <SelectValue placeholder="Leave in team queue" />
                      </SelectTrigger>
                      <SelectContent>
                        {newTaskStaff.map((s) => (
                          <SelectItem key={String(s["id"])} value={String(s["id"])}>
                            {workerLabel(
                              s as unknown as ScopedWorker,
                              !selectedNewRoom?.["branch_id"],
                            )}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Reason</Label>
                    <Textarea
                      value={newReason}
                      onChange={(e) => setNewReason(e.target.value)}
                      placeholder="Why this cleaning task is required"
                    />
                  </div>
                  <div>
                    <Label>Task type</Label>
                    <Select value={newType} onValueChange={setNewType}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {HK_RAISEABLE_JOB_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {titleCase(t)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Priority</Label>
                    <Select value={newPriority} onValueChange={setNewPriority}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PRIORITIES.map((p) => (
                          <SelectItem key={p} value={p}>
                            {titleCase(p)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    disabled={!newRoom || !newReason.trim() || createJob.isPending}
                    onClick={() =>
                      createJob.mutate(
                        {
                          room: newRoom,
                          jobType: newType,
                          priority: newPriority,
                          assignee: newAssignee || null,
                          assignedTeam: newAssignee ? null : "Housekeeping",
                          notes: newReason.trim(),
                          source: "manual",
                          idempotencyKey: `manual:${newRoom}:${crypto.randomUUID()}`,
                        },
                        { onSuccess: () => setOpen(false) },
                      )
                    }
                  >
                    Create task
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Select value={scope} onValueChange={(v) => setScope(v as "all" | "mine")}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All rooms</SelectItem>
            <SelectItem value="mine">My assigned rooms</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open work</SelectItem>
            <SelectItem value="all">All statuses</SelectItem>
            {HK_JOB_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {titleCase(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {mayReconcile ? <StaleReconciliation /> : null}

      <QueryState
        isLoading={jobs.isLoading}
        error={jobs.error}
        isEmpty={list.length === 0}
        empty={
          <EmptyState
            title="No cleaning tasks"
            description="Tasks appear automatically at checkout, or you can raise one from the Room Board."
            icon={ListChecks}
          />
        }
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.map((job) => {
            const activityAt = job["started_at"] ?? job["due_at"] ?? job["updated_at"] ?? job["created_at"];
            const activityTime = activityAt ? new Date(String(activityAt)).getTime() : Number.NaN;
            const isStale =
              !["completed", "cancelled"].includes(String(job["status"])) &&
              Number.isFinite(activityTime) &&
              activityTime < staleCutoff;
            const jobStaff = scopeWorkers(
              staffRows,
              job["branch_id"] ? String(job["branch_id"]) : null,
              null,
              "housekeeping",
            );
            return (
              <Card key={String(job["id"])} className="surface-panel">
                <CardContent className="space-y-3 py-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-base font-semibold">
                        {job["rooms"]?.room_number
                          ? `Room ${job["rooms"].room_number}`
                          : (job["location_label"] ?? "Area")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {titleCase(job["job_type"])} · {job["job_number"] ?? "—"}
                      </p>
                    </div>
                    <OpsBadge value={job["status"]} tone={jobStatusTone(job["status"])} />
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    <OpsBadge value={job["priority"]} tone={priorityTone(job["priority"])} />
                    {isStale ? <OpsBadge value="Stale over 24 hours" tone="destructive" /> : null}
                    {job["inspection_required"] ? (
                      <OpsBadge value="Inspection required" tone="warning" />
                    ) : null}
                    {Number(job["rework_count"]) > 0 ? (
                      <OpsBadge value={`Rework ×${job["rework_count"]}`} tone="destructive" />
                    ) : null}
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Due {shortDateTime(job["due_at"])}
                  </p>

                  {can("housekeeping", "tasks.assign") ? (
                    <Select
                      value={job["assignee_id"] ? String(job["assignee_id"]) : ""}
                      onValueChange={(v) =>
                        assignJob.mutate({ id: String(job["id"]), assignee: v })
                      }
                    >
                      <SelectTrigger className="h-9">
                        <SelectValue placeholder="Assign attendant" />
                      </SelectTrigger>
                      <SelectContent>
                        {jobStaff.map((s) => (
                          <SelectItem key={String(s["id"])} value={String(s["id"])}>
                            {workerLabel(s as unknown as ScopedWorker, !job["branch_id"])}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}

                  <div className="flex flex-wrap gap-2">
                    {["pending", "assigned"].includes(String(job["status"])) ||
                    job["status"] === "rework" ? (
                      <>
                        <Button
                          size="sm"
                          onClick={() => startJob.mutate(job)}
                          disabled={startJob.isPending || !job["assignee_id"]}
                        >
                          Start cleaning
                        </Button>
                        {!job["assignee_id"] ? (
                          <p className="text-xs text-muted-foreground">
                            Assign an attendant before cleaning starts, so the room
                            shows who is working on it.
                          </p>
                        ) : null}
                      </>
                    ) : null}
                    {job["status"] === "in-progress" ? (
                      <>
                        <Button size="sm" variant="outline" onClick={() => openComplete(job)}>
                          Complete checklist
                        </Button>
                        {isStale && can("housekeeping", "tasks.assign") ? (
                          <p className="text-xs text-muted-foreground">
                            Review or reassign this task; it will not be closed automatically.
                          </p>
                        ) : null}
                      </>
                    ) : null}
                    {job["status"] === "awaiting-inspection" ? (
                      <p className="text-xs text-muted-foreground">
                        Waiting for supervisor inspection.
                      </p>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </QueryState>

      <Dialog open={Boolean(active)} onOpenChange={(v) => !v && setActive(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Cleaning checklist</DialogTitle>
          </DialogHeader>
          <SectionCard
            title={
              active?.["template_name"]
                ? `${String(active["template_name"])}${active["template_version"] ? ` · v${String(active["template_version"])}` : ""}`
                : "Room checklist"
            }
            description="Every step must be marked done, or flagged with a reason. The supervisor sees both."
          >
            <CleaningChecklistForm
              lines={activeLines}
              entries={entries}
              onChange={(label, entry) => setEntries((prev) => ({ ...prev, [label]: entry }))}
            />
          </SectionCard>
          <div>
            <Label>Notes / defects</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything the supervisor should know"
            />
          </div>
          {!checklistReady ? (
            <p className="text-xs text-muted-foreground">
              {unanswered.length > 0
                ? `${unanswered.length} checklist ${unanswered.length === 1 ? "step is" : "steps are"} still unanswered.`
                : `Give a reason for: ${outstanding.join(", ")}.`}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={completeJob.isPending || !checklistReady}
              onClick={() =>
                active &&
                completeJob.mutate(
                  {
                    id: String(active["id"]),
                    notes,
                    results: checklistResultRows(
                      String(active["id"]),
                      organizationId,
                      activeLines,
                      entries,
                    ) as unknown as Row[],
                  },
                  { onSuccess: () => setActive(null) },
                )
              }
            >
              Submit for inspection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </OpsGuard>
  );
}


/**
 * Tasks left open for more than a day. Where real evidence exists — a passed
 * inspection or a later completed clean of the same room — they can be closed
 * in bulk. Everything else needs a supervisor's decision: finish it, cancel it
 * with a reason, hand it over, or supersede it with a fresh task. Every choice
 * is written to the audit trail with the person who made it.
 */
function StaleReconciliation() {
  const stale = useStaleCleaningTasks(24);
  const reconcile = useReconcileStaleCleaningTasks(24);
  const resolve = useResolveStaleCleaningTask();
  const staff = useStaffLite("housekeeping");
  const rows = (stale.data ?? []) as StaleJobCandidate[];
  const withEvidence = rows.filter((row) => row.evidence !== "none");
  const workers = useMemo(() => (staff.data ?? []) as unknown as ScopedWorker[], [staff.data]);

  const [active, setActive] = useState<StaleJobCandidate | null>(null);
  const [action, setAction] = useState<"complete" | "cancel" | "reassign" | "replace">("complete");
  const [reason, setReason] = useState("");
  const [assignee, setAssignee] = useState("");

  const close = () => {
    setActive(null);
    setReason("");
    setAssignee("");
  };

  const needsReason = action === "cancel" || action === "replace";
  const submitDisabled =
    resolve.isPending ||
    (needsReason && !reason.trim()) ||
    (action === "reassign" && !assignee);

  return (
    <SectionCard
      title="Stale task clean-up"
      description="Tasks open more than a day. Those with cleaning or inspection evidence can be closed together; the rest wait for your decision."
      actions={
        <Button
          size="sm"
          disabled={reconcile.isPending || withEvidence.length === 0}
          onClick={() => reconcile.mutate()}
        >
          {reconcile.isPending ? "Closing…" : `Close ${withEvidence.length} with evidence`}
        </Button>
      }
    >
      <QueryState
        isLoading={stale.isLoading}
        error={stale.error}
        isEmpty={rows.length === 0}
        empty={<p className="py-4 text-sm text-muted-foreground">No cleaning task has been left open past a day.</p>}
      >
        <ul className="divide-y divide-border text-sm">
          {rows.map((row) => (
            <li key={row.job_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="font-medium">
                {row.room_number ? `Room ${row.room_number}` : "Area"} ·{" "}
                {titleCase(String(row.job_type ?? "cleaning"))}
                <span className="ml-2 text-xs text-muted-foreground">
                  {row.job_number ?? "—"} · open since {shortDateTime(row.reference_at)}
                </span>
              </span>
              <span className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  {row.evidence === "inspection"
                    ? `Inspection passed ${shortDateTime(row.evidence_at)}`
                    : row.evidence === "later_clean"
                      ? `Room cleaned again ${shortDateTime(row.evidence_at)}${row.evidence_reference ? ` (${row.evidence_reference})` : ""}`
                      : "No evidence — needs a decision"}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setActive(row);
                    setAction("complete");
                    setReason("");
                    setAssignee("");
                  }}
                >
                  Resolve
                </Button>
              </span>
            </li>
          ))}
        </ul>
      </QueryState>

      <Dialog open={Boolean(active)} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Resolve {active?.job_number ?? "task"}
              {active?.room_number ? ` · Room ${active.room_number}` : ""}
            </DialogTitle>
            <DialogDescription>
              Your decision and reason are recorded against this task.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>What should happen</Label>
              <Select value={action} onValueChange={(v) => setAction(v as typeof action)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="complete">Complete — the work was done</SelectItem>
                  <SelectItem value="cancel">Cancel with a reason</SelectItem>
                  <SelectItem value="reassign">Hand it to someone else</SelectItem>
                  <SelectItem value="replace">Replace with a fresh task</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {(action === "reassign" || action === "replace") && (
              <div>
                <Label>{action === "reassign" ? "New owner" : "Assign the replacement to (optional)"}</Label>
                <Select value={assignee} onValueChange={setAssignee}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a housekeeper" />
                  </SelectTrigger>
                  <SelectContent>
                    {workers.map((member) => (
                      <SelectItem key={member.id} value={member.id}>
                        {workerLabel(member)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div>
              <Label>Reason {needsReason ? "(required)" : "(optional)"}</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="What happened, in your own words"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              disabled={submitDisabled}
              onClick={() =>
                active &&
                resolve.mutate(
                  {
                    jobId: active.job_id,
                    action,
                    reason: reason.trim() || null,
                    assignee: assignee || null,
                  },
                  { onSuccess: close },
                )
              }
            >
              {resolve.isPending ? "Saving…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}

