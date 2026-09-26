import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { PageHeader, StatusPill } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import {
  InspectorField,
  InspectorSection,
  InspectorSheet,
} from "@/components/common/InspectorSheet";
import { EmptyState, KitchenGuard, QueryState } from "@/components/kitchen/KitchenShared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/kitchen";
import { useStaffLite } from "@/lib/operations-data";
import {
  BREAKAGE_UNITS,
  HYGIENE_CHECKLISTS,
  kitchenNum,
  kitchenStr,
  nextTaskStatus,
  taskTone,
  useAdvanceKitchenTask,
  useCreateKitchenTask,
  useHygieneChecks,
  useKitchenBreakages,
  useMyKitchenTasks,
  useRecordBreakage,
  useReviewBreakage,
  useSubmitHygieneCheck,
  type KitchenRow,
} from "@/lib/main-kitchen";

export const Route = createFileRoute("/_shell/kitchen/stewarding")({
  head: () => ({
    meta: [
      { title: "Stewarding, Hygiene & Breakages — NEØ" },
      {
        name: "description",
        content:
          "Kitchen Steward tasks, hygiene and sanitation checklists, and breakage reporting for the Main Kitchen.",
      },
      { property: "og:title", content: "Stewarding, Hygiene & Breakages — NEØ" },
      {
        property: "og:description",
        content:
          "Dishwashing and cleaning tasks, hygiene checklists and breakage records in one place.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <KitchenGuard action="stewarding.view">
      <StewardingPage />
    </KitchenGuard>
  ),
});

type Item = {
  kind: "task" | "check" | "breakage";
  id: string;
  row: KitchenRow;
};

type Lens = "none" | "tasks" | "breakages";

function breakageTone(status: string): "warning" | "destructive" | "success" {
  if (status === "reported") return "warning";
  if (status === "rejected") return "destructive";
  return "success";
}

function StewardingPage() {
  const { can } = useAuth();
  const tasks = useMyKitchenTasks();
  const advance = useAdvanceKitchenTask();
  const createTask = useCreateKitchenTask();
  const checks = useHygieneChecks();
  const submitCheck = useSubmitHygieneCheck();
  const breakages = useKitchenBreakages();
  const recordBreakage = useRecordBreakage();
  const reviewBreakage = useReviewBreakage();
  const staff = useStaffLite("main-kitchen");

  const mayAssign = can("kitchen", "stewarding", "edit");
  const mayReview = can("kitchen", "waste", "edit");

  const [assignOpen, setAssignOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [description, setDescription] = useState("");

  const [checkOpen, setCheckOpen] = useState(false);
  const [checkType, setCheckType] = useState("hygiene");
  const [area, setArea] = useState("");
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [checkNotes, setCheckNotes] = useState("");

  const [breakOpen, setBreakOpen] = useState(false);
  const [item, setItem] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState("piece");
  const [reason, setReason] = useState("");

  const [lens, setLens] = useState<Lens>("none");
  const [inspect, setInspect] = useState<Item | null>(null);

  const taskRows = (tasks.data ?? []) as KitchenRow[];
  const checkRows = (checks.data ?? []) as KitchenRow[];
  const breakRows = (breakages.data ?? []) as KitchenRow[];
  const checklist = HYGIENE_CHECKLISTS[checkType] ?? [];

  const openTasks = taskRows.filter((r) => String(r["status"]) !== "completed");
  const checklistsToday = checkRows.filter(
    (r) => new Date(String(r["completed_at"])).toDateString() === new Date().toDateString(),
  );
  const breakagesAwaiting = breakRows.filter((r) => String(r["status"]) === "reported");

  const toggleLens = (next: Lens) => setLens((prev) => (prev === next ? "none" : next));

  const isLoading = tasks.isLoading || checks.isLoading || breakages.isLoading;
  const hasError = tasks.error || checks.error || breakages.error;
  const isEmpty =
    !isLoading && !hasError && taskRows.length === 0 && checkRows.length === 0 && breakRows.length === 0;

  const showTasks = lens !== "breakages";
  const showBreakages = lens !== "tasks";

  const submitChecklist = () =>
    submitCheck.mutate(
      {
        area,
        checkType,
        items: checklist.map((label) => ({ label, done: Boolean(ticked[label]) })),
        notes: checkNotes,
      },
      {
        onSuccess: () => {
          setCheckOpen(false);
          setArea("");
          setTicked({});
          setCheckNotes("");
        },
      },
    );

  const leadFigure: SummaryFigure = {
    id: "open-tasks",
    label: "My open tasks",
    value: isLoading ? "…" : openTasks.length,
  };
  const figures: SummaryFigure[] = [
    {
      id: "tasks",
      label: "Open tasks",
      value: isLoading ? "…" : openTasks.length,
      onSelect: () => toggleLens("tasks"),
      active: lens === "tasks",
    },
    {
      id: "checklists",
      label: "Checklists today",
      value: isLoading ? "…" : checklistsToday.length,
      tone: "success",
    },
    {
      id: "breakages",
      label: "Breakages awaiting review",
      value: isLoading ? "…" : breakagesAwaiting.length,
      tone: breakagesAwaiting.length ? "warning" : "success",
      onSelect: () => toggleLens("breakages"),
      active: lens === "breakages",
    },
  ];

  const inspectRow = inspect?.row;
  const inspectStatus = inspectRow ? String(inspectRow["status"] ?? "") : "";

  return (
    <div>
      <PageHeader
        eyebrow="Main Kitchen"
        title="Stewarding, hygiene & breakages"
        description="Dishwashing, cleaning and sanitation work, the checklists that prove it was done, and every breakage recorded rather than absorbed."
        actions={
          <div className="flex gap-2">
            {mayAssign ? (
              <Button variant="outline" onClick={() => setAssignOpen(true)}>
                <Plus className="mr-2 h-4 w-4" /> Assign task
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => setBreakOpen(true)}>
              Report breakage
            </Button>
            <Button onClick={() => setCheckOpen(true)}>Complete checklist</Button>
          </div>
        }
      />

      <SummaryStrip lead={leadFigure} figures={figures} />

      <QueryState
        isLoading={isLoading}
        error={hasError}
        isEmpty={isEmpty}
        empty={
          <EmptyState
            title="Nothing here yet"
            description="Assigned tasks, hygiene checklists and breakages will appear here."
          />
        }
      >
        <div className="surface-panel space-y-5 rounded-2xl p-3">
          {showTasks ? (
            <section>
              <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                My tasks
              </h3>
              {taskRows.length === 0 ? (
                <p className="px-1 text-sm text-muted-foreground">Nothing assigned to you.</p>
              ) : (
                <div className="space-y-1.5">
                  {taskRows.map((r) => {
                    const status = String(r["status"] ?? "open");
                    const next = nextTaskStatus(status);
                    return (
                      <div
                        key={String(r["id"])}
                        className="flex min-w-0 items-center gap-3 rounded-xl border border-transparent p-2.5 hover:border-outline-subtle hover:bg-muted/40"
                      >
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
                          onClick={() => setInspect({ kind: "task", id: String(r["id"]), row: r })}
                        >
                          <div className="min-w-0">
                            <p className="neo-line-1 font-medium">{kitchenStr(r["title"])}</p>
                            <p className="neo-line-1 text-sm text-muted-foreground">
                              {titleCase(kitchenStr(r["priority"], "normal"))} ·{" "}
                              {r["due_at"] ? new Date(String(r["due_at"])).toLocaleString() : "No due time"}
                            </p>
                          </div>
                          <StatusPill tone={taskTone(status)}>{titleCase(status.replace(/-/g, " "))}</StatusPill>
                        </button>
                        {next ? (
                          <Button
                            size="sm"
                            disabled={advance.isPending}
                            onClick={() => advance.mutate({ taskId: String(r["id"]), status: next })}
                          >
                            {next === "in-progress" ? "Start" : "Complete"}
                          </Button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}

          <section>
            <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Hygiene &amp; sanitation checks
            </h3>
            {checkRows.length === 0 ? (
              <p className="px-1 text-sm text-muted-foreground">No checklists yet.</p>
            ) : (
              <div className="space-y-1.5">
                {checkRows.slice(0, 20).map((r) => (
                  <button
                    key={String(r["id"])}
                    type="button"
                    className="flex w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-transparent p-2.5 text-left hover:border-outline-subtle hover:bg-muted/40"
                    onClick={() => setInspect({ kind: "check", id: String(r["id"]), row: r })}
                  >
                    <div className="min-w-0">
                      <p className="neo-line-1 font-medium">{kitchenStr(r["area"])}</p>
                      <p className="neo-line-1 text-sm text-muted-foreground">
                        {titleCase(kitchenStr(r["check_type"], "hygiene"))}
                      </p>
                    </div>
                    <span className="neo-line-1 text-xs text-muted-foreground">
                      {r["completed_at"] ? new Date(String(r["completed_at"])).toLocaleString() : "—"}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {showBreakages ? (
            <section>
              <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Breakages
              </h3>
              {breakRows.length === 0 ? (
                <p className="px-1 text-sm text-muted-foreground">No breakages recorded.</p>
              ) : (
                <div className="space-y-1.5">
                  {breakRows.slice(0, 20).map((r) => {
                    const status = String(r["status"] ?? "reported");
                    return (
                      <button
                        key={String(r["id"])}
                        type="button"
                        className="flex w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-transparent p-2.5 text-left hover:border-outline-subtle hover:bg-muted/40"
                        onClick={() => setInspect({ kind: "breakage", id: String(r["id"]), row: r })}
                      >
                        <div className="min-w-0">
                          <p className="neo-line-1 font-medium">
                            {kitchenStr(r["item"])} × {kitchenNum(r["quantity"])} {kitchenStr(r["unit"], "piece")}
                          </p>
                          <p className="neo-line-1 text-sm text-muted-foreground">
                            {kitchenStr(r["reason"], "No reason given")}
                          </p>
                        </div>
                        <StatusPill tone={breakageTone(status)}>{titleCase(status.replace(/-/g, " "))}</StatusPill>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}
        </div>
      </QueryState>

      <InspectorSheet
        open={Boolean(inspect)}
        onOpenChange={(next) => !next && setInspect(null)}
        title={
          inspect?.kind === "task"
            ? kitchenStr(inspectRow?.["title"])
            : inspect?.kind === "check"
              ? kitchenStr(inspectRow?.["area"])
              : inspect?.kind === "breakage"
                ? kitchenStr(inspectRow?.["item"])
                : ""
        }
        subtitle={
          inspect?.kind === "task"
            ? "Stewarding task"
            : inspect?.kind === "check"
              ? titleCase(kitchenStr(inspectRow?.["check_type"], "hygiene"))
              : inspect?.kind === "breakage"
                ? `${kitchenNum(inspectRow?.["quantity"])} ${kitchenStr(inspectRow?.["unit"], "piece")}`
                : undefined
        }
        chips={
          inspect?.kind === "task" ? (
            <StatusPill tone={taskTone(inspectStatus)}>{titleCase(inspectStatus.replace(/-/g, " "))}</StatusPill>
          ) : inspect?.kind === "breakage" ? (
            <StatusPill tone={breakageTone(inspectStatus)}>{titleCase(inspectStatus.replace(/-/g, " "))}</StatusPill>
          ) : null
        }
        footer={
          inspect?.kind === "task" && nextTaskStatus(inspectStatus) ? (
            <Button
              disabled={advance.isPending}
              onClick={() => advance.mutate({ taskId: inspect.id, status: nextTaskStatus(inspectStatus)! })}
            >
              {nextTaskStatus(inspectStatus) === "in-progress" ? "Start" : "Complete"}
            </Button>
          ) : inspect?.kind === "breakage" && mayReview && inspectStatus === "reported" ? (
            <>
              <Button
                variant="outline"
                disabled={reviewBreakage.isPending}
                onClick={() => reviewBreakage.mutate({ breakageId: inspect.id, decision: "acknowledged" })}
              >
                Acknowledge
              </Button>
              <Button
                disabled={reviewBreakage.isPending}
                onClick={() => reviewBreakage.mutate({ breakageId: inspect.id, decision: "written-off" })}
              >
                Write off
              </Button>
            </>
          ) : null
        }
      >
        {inspect?.kind === "task" ? (
          <InspectorSection title="Details">
            <InspectorField label="Priority">{titleCase(kitchenStr(inspectRow?.["priority"], "normal"))}</InspectorField>
            <InspectorField label="Due">
              {inspectRow?.["due_at"] ? new Date(String(inspectRow["due_at"])).toLocaleString() : "No due time"}
            </InspectorField>
            <InspectorField label="Detail">{kitchenStr(inspectRow?.["description"], "No detail given")}</InspectorField>
          </InspectorSection>
        ) : null}
        {inspect?.kind === "check" ? (
          <InspectorSection title="Checklist">
            <InspectorField label="Completed">
              {inspectRow?.["completed_at"] ? new Date(String(inspectRow["completed_at"])).toLocaleString() : "—"}
            </InspectorField>
            <InspectorField label="Notes">{kitchenStr(inspectRow?.["notes"], "No notes given")}</InspectorField>
          </InspectorSection>
        ) : null}
        {inspect?.kind === "breakage" ? (
          <InspectorSection title="Breakage">
            <InspectorField label="Reason">{kitchenStr(inspectRow?.["reason"], "No reason given")}</InspectorField>
            <InspectorField label="Reported">
              {inspectRow?.["created_at"] ? new Date(String(inspectRow["created_at"])).toLocaleString() : "—"}
            </InspectorField>
          </InspectorSection>
        ) : null}
      </InspectorSheet>

      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign a kitchen task</DialogTitle>
            <DialogDescription>
              Stewarding, cleaning or waste-handling work for one person.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="task-title">Task</Label>
              <Input
                id="task-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Deep clean the dishwashing area"
              />
            </div>
            <div>
              <Label>Assign to</Label>
              <Select value={assignee} onValueChange={setAssignee}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a team member" />
                </SelectTrigger>
                <SelectContent>
                  {(staff.data ?? []).map((s) => (
                    <SelectItem key={String(s["id"])} value={String(s["id"])}>
                      {kitchenStr(s["full_name"])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="task-desc">Detail</Label>
              <Textarea
                id="task-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={createTask.isPending || !title.trim() || !assignee}
              onClick={() =>
                createTask.mutate(
                  { title, assigneeId: assignee, description },
                  {
                    onSuccess: () => {
                      setAssignOpen(false);
                      setTitle("");
                      setDescription("");
                    },
                  },
                )
              }
            >
              Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={checkOpen} onOpenChange={setCheckOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Complete a checklist</DialogTitle>
            <DialogDescription>
              The record is kept for the Supervisor and Head Chef.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Checklist</Label>
                <Select
                  value={checkType}
                  onValueChange={(v) => {
                    setCheckType(v);
                    setTicked({});
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.keys(HYGIENE_CHECKLISTS).map((k) => (
                      <SelectItem key={k} value={k}>
                        {titleCase(k)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="area">Area</Label>
                <Input
                  id="area"
                  value={area}
                  onChange={(e) => setArea(e.target.value)}
                  placeholder="e.g. Dishwashing bay"
                />
              </div>
            </div>
            <div className="space-y-2">
              {checklist.map((label) => (
                <label key={label} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={Boolean(ticked[label])}
                    onCheckedChange={(v) => setTicked((prev) => ({ ...prev, [label]: Boolean(v) }))}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div>
              <Label htmlFor="check-notes">Notes</Label>
              <Textarea
                id="check-notes"
                value={checkNotes}
                onChange={(e) => setCheckNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCheckOpen(false)}>
              Cancel
            </Button>
            <Button disabled={submitCheck.isPending || !area.trim()} onClick={submitChecklist}>
              Submit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={breakOpen} onOpenChange={setBreakOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report a breakage</DialogTitle>
            <DialogDescription>
              Recorded against you and reviewed by the Supervisor or Head Chef.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="break-item">What was broken</Label>
              <Input
                id="break-item"
                value={item}
                onChange={(e) => setItem(e.target.value)}
                placeholder="e.g. Dinner plates"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="break-qty">Quantity</Label>
                <Input
                  id="break-qty"
                  type="number"
                  min="1"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </div>
              <div>
                <Label>Unit</Label>
                <Select value={unit} onValueChange={setUnit}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BREAKAGE_UNITS.map((u) => (
                      <SelectItem key={u} value={u}>
                        {titleCase(u)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label htmlFor="break-reason">How it happened</Label>
              <Textarea
                id="break-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBreakOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={recordBreakage.isPending || !item.trim()}
              onClick={() =>
                recordBreakage.mutate(
                  { item, quantity: Number(quantity) || 1, unit, reason },
                  {
                    onSuccess: () => {
                      setBreakOpen(false);
                      setItem("");
                      setQuantity("1");
                      setReason("");
                    },
                  },
                )
              }
            >
              Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
