import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ClipboardList, Plus } from "lucide-react";
import { PageHeader, StatusPill } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { Lane, LaneBoard } from "@/components/common/LaneBoard";
import {
  InspectorField,
  InspectorSection,
  InspectorSheet,
} from "@/components/common/InspectorSheet";

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
import { DeliveryGuard, EmptyState, QueryState } from "@/components/delivery/DeliveryGuard";
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/pos";
import {
  SUPPLY_PRIORITIES,
  str,
  useCreateDeliveryTask,
  useDeliveryRiderOptions,
  useDeliveryTasks,
  useUpdateDeliveryTask,
  type DeliveryRow,
} from "@/lib/delivery-department";

export const Route = createFileRoute("/_shell/delivery/tasks")({
  head: () => ({
    meta: [
      { title: "Delivery Tasks & Rider Assignments — NEØ" },
      {
        name: "description",
        content:
          "Assign delivery department tasks to riders and follow each one to completion. Riders see only the tasks assigned to them.",
      },
      { property: "og:title", content: "Delivery Tasks & Rider Assignments — NEØ" },
      {
        property: "og:description",
        content: "Delivery Manager task board for rider assignments, briefings and follow-up.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <DeliveryGuard action="tasks.view">
      <DeliveryTasksPage />
    </DeliveryGuard>
  ),
});

const TONE: Record<string, "success" | "warning" | "destructive" | "default"> = {
  completed: "success",
  "in-progress": "warning",
  open: "warning",
  blocked: "destructive",
  cancelled: "destructive",
};

const LANES: { id: string; label: string; statuses: string[] }[] = [
  { id: "open", label: "Open", statuses: ["open"] },
  { id: "in-progress", label: "In progress", statuses: ["in-progress"] },
  { id: "blocked", label: "Blocked", statuses: ["blocked"] },
  { id: "completed", label: "Completed", statuses: ["completed", "cancelled"] },
];

function DeliveryTasksPage() {
  const { can } = useAuth();
  const tasks = useDeliveryTasks("department");
  const riders = useDeliveryRiderOptions();
  const create = useCreateDeliveryTask();
  const update = useUpdateDeliveryTask();
  const mayAssign = can("delivery", "tasks.assign");

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [priority, setPriority] = useState("normal");
  const [statusFocus, setStatusFocus] = useState<string | null>(null);
  const [inspectId, setInspectId] = useState<string | null>(null);

  const rows = (tasks.data ?? []) as DeliveryRow[];
  const riderRows = (riders.data ?? []) as DeliveryRow[];
  const riderName = (id: unknown) => {
    const match = riderRows.find((r) => String(r["profile_id"]) === String(id));
    return match ? str(match["full_name"] ?? match["rider_code"]) : "—";
  };

  const openCount = rows.filter((r) => String(r["status"]) === "open").length;
  const inProgressCount = rows.filter((r) => String(r["status"]) === "in-progress").length;
  const completedCount = rows.filter((r) => String(r["status"]) === "completed").length;

  const filtered = useMemo(
    () => (statusFocus ? rows.filter((r) => String(r["status"]) === statusFocus) : rows),
    [rows, statusFocus],
  );

  const lanes: Lane<DeliveryRow>[] = LANES.map((lane) => ({
    id: lane.id,
    label: lane.label,
    tone: TONE[lane.statuses[0] ?? ""] ?? "default",
    items: filtered.filter((r) => lane.statuses.includes(String(r["status"] ?? "open"))),
  }));

  const inspected = rows.find((r) => String(r["id"]) === inspectId) ?? null;
  const inspectedStatus = inspected ? String(inspected["status"] ?? "open") : "open";

  const toggleFocus = (status: string) =>
    setStatusFocus((prev) => (prev === status ? null : status));

  const leadFigure: SummaryFigure = {
    id: "total",
    label: "Tasks",
    value: rows.length,
    hint: "in the department board",
  };
  const figures: SummaryFigure[] = [
    {
      id: "open",
      label: "Open",
      value: openCount,
      hint: "Not started by a rider yet",
      tone: openCount ? "warning" : "default",
      onSelect: () => toggleFocus("open"),
      active: statusFocus === "open",
    },
    {
      id: "in-progress",
      label: "In progress",
      value: inProgressCount,
      hint: "Accepted and being worked",
      tone: "info",
      onSelect: () => toggleFocus("in-progress"),
      active: statusFocus === "in-progress",
    },
    {
      id: "completed",
      label: "Completed",
      value: completedCount,
      hint: "Closed by the assignee",
      tone: "success",
      onSelect: () => toggleFocus("completed"),
      active: statusFocus === "completed",
    },
  ];

  const submit = () =>
    create.mutate(
      { title, description, assigneeId: assignee, dueAt: dueAt || null, priority },
      {
        onSuccess: () => {
          setOpen(false);
          setTitle("");
          setDescription("");
          setDueAt("");
        },
      },
    );

  return (
    <div>
      <PageHeader
        eyebrow="Delivery Department"
        title="Tasks & Rider Assignments"
        icon={ClipboardList}
        description="Department task board. A rider only ever sees the tasks assigned to them, in their own workspace."
        actions={
          mayAssign ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> Assign task
            </Button>
          ) : null
        }
      />

      <SummaryStrip lead={leadFigure} figures={figures} />

      <QueryState
        isLoading={tasks.isLoading}
        error={tasks.error}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            title="No delivery tasks"
            description="Assign a task — a zone briefing, a cash remittance, an equipment check — and it appears in that rider's workspace."
          />
        }
      >
        <LaneBoard
          lanes={lanes}
          getKey={(r) => String(r["id"])}
          emptyLaneLabel="Nothing here"
          renderItem={(r) => {
            const status = String(r["status"] ?? "open");
            return (
              <button
                type="button"
                data-touch-target
                onClick={() => setInspectId(String(r["id"]))}
                className="w-full min-w-0 text-left"
              >
                <p className="neo-line-1 text-sm font-semibold">{str(r["title"])}</p>
                <p className="neo-line-1 mt-0.5 text-xs text-muted-foreground">
                  {riderName(r["assignee_id"])}
                </p>
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {r["due_at"] ? new Date(String(r["due_at"])).toLocaleDateString() : "No due date"}
                  </span>
                  <StatusPill tone={TONE[status] ?? "default"}>
                    {titleCase(status.replace(/-/g, " "))}
                  </StatusPill>
                </div>
              </button>
            );
          }}
        />
      </QueryState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign a delivery task</DialogTitle>
            <DialogDescription>
              Only the assigned rider will see this task in their workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="title">Task</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Remit COD float"
              />
            </div>
            <div>
              <Label>Rider</Label>
              <Select value={assignee} onValueChange={setAssignee}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a rider" />
                </SelectTrigger>
                <SelectContent>
                  {riderRows.map((r) => (
                    <SelectItem key={String(r["profile_id"])} value={String(r["profile_id"])}>
                      {str(r["full_name"] ?? r["rider_code"])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="due">Due</Label>
                <Input
                  id="due"
                  type="datetime-local"
                  value={dueAt}
                  onChange={(e) => setDueAt(e.target.value)}
                />
              </div>
              <div>
                <Label>Priority</Label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUPPLY_PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>
                        {titleCase(p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label htmlFor="brief">Briefing</Label>
              <Textarea
                id="brief"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={create.isPending || !title.trim() || !assignee}>
              Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <InspectorSheet
        open={Boolean(inspected)}
        onOpenChange={(o) => !o && setInspectId(null)}
        title={inspected ? str(inspected["title"]) : "Task"}
        subtitle={inspected ? riderName(inspected["assignee_id"]) : undefined}
        chips={
          inspected ? (
            <StatusPill tone={TONE[inspectedStatus] ?? "default"}>
              {titleCase(inspectedStatus.replace(/-/g, " "))}
            </StatusPill>
          ) : undefined
        }
        footer={
          inspected && mayAssign && inspectedStatus !== "completed" && inspectedStatus !== "cancelled" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={update.isPending}
              onClick={() => update.mutate({ taskId: String(inspected["id"]), status: "completed" })}
            >
              Close task
            </Button>
          ) : null
        }
      >
        {inspected ? (
          <>
            <InspectorSection title="Briefing">
              <p className="text-sm text-foreground">
                {str(inspected["description"], "No briefing notes were provided.")}
              </p>
            </InspectorSection>
            <InspectorSection title="Details">
              <InspectorField label="Rider">{riderName(inspected["assignee_id"])}</InspectorField>
              <InspectorField label="Priority">
                {titleCase(str(inspected["priority"], "normal"))}
              </InspectorField>
              <InspectorField label="Due">
                {inspected["due_at"] ? new Date(String(inspected["due_at"])).toLocaleString() : "—"}
              </InspectorField>
              <InspectorField label="Completed">
                {inspected["completed_at"]
                  ? new Date(String(inspected["completed_at"])).toLocaleString()
                  : "—"}
              </InspectorField>
            </InspectorSection>
          </>
        ) : null}
      </InspectorSheet>
    </div>
  );
}
