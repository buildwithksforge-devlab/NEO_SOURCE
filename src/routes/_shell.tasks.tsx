import { guardedRpc } from "@/lib/rpc-guard";
import { useState } from "react";
import { useDataScope } from "@/lib/data-scope";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  CalendarDayLegend,
  CalendarMonthGrid,
  CalendarMonthSkeleton,
  CalendarToolbar,
  monthCells,
} from "@/components/common/CalendarSurface";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { DocumentPrintButton } from "@/components/common/DocumentPrintButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useScopedDepartments, useScopedWorkerOptions } from "@/lib/scoped-options";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/StateSystem";

export const Route = createFileRoute("/_shell/tasks")({
  head: () => ({
    meta: [
      { title: "Tasks — NEØ" },
      {
        name: "description",
        content: "Assign, track and escalate operational tasks across every department.",
      },
      { property: "og:title", content: "Tasks — NEØ" },
      {
        property: "og:description",
        content: "Assign, track and escalate operational tasks across every department.",
      },
    ],
  }),
  component: TasksPage,
});

type Task = {
  id: string;
  reference: string;
  title: string;
  description: string;
  assignee_id: string | null;
  created_by: string | null;
  department_id: string | null;
  due_at: string | null;
  priority: string;
  status: string;
  progress: number;
};

const STATUSES = ["new", "assigned", "in-progress", "waiting", "completed", "cancelled"];
const PRIORITIES = ["low", "normal", "high", "urgent"];

/** Statuses that keep a task in an actionable queue. */
export const ACTIONABLE_TASK_STATUSES = ["new", "open", "assigned", "in-progress", "waiting"];
/** Statuses that remove a task from actionable queues automatically. */
export const CLOSED_TASK_STATUSES = ["completed", "cancelled", "rejected", "superseded"];

export function isActionable(t: { status: string }) {
  return !CLOSED_TASK_STATUSES.includes(t.status);
}

const priorityTone = (p: string) =>
  p === "urgent" ? "destructive" : p === "high" ? "warning" : p === "low" ? "default" : "info";

function isOverdue(t: Task) {
  return t.due_at !== null && new Date(t.due_at).getTime() < Date.now() && isActionable(t);
}

function TasksPage() {
  const { applyScope, scopeKey } = useDataScope();
  const { organizationId, user, profile } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const tasksQuery = useQuery({
    queryKey: ["tasks", organizationId, scopeKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      // Line staff receive only their own tasks, supervisors their department's.
      const { data, error } = await applyScope(
        supabase.from("tasks").select("*, departments(name)"),
        "tasks",
      ).order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  // Canonical profiles.id options for the active property only.
  const staff = useScopedWorkerOptions();

  const departments = useScopedDepartments();

  const update = useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: Partial<Task> & { completed_at?: string | null };
    }) => {
      const { error } = await supabase.from("tasks").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Task updated");
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const all = (tasksQuery.data ?? []) as unknown as (Task & {
    departments: { name: string } | null;
  })[];
  const mine = all.filter((t) => t.assignee_id === user?.id && isActionable(t));
  const dept = all.filter(
    (t) => t.department_id && t.department_id === profile?.department_id && isActionable(t),
  );
  const overdue = all.filter(isOverdue);
  const completed = all.filter((t) => CLOSED_TASK_STATUSES.includes(t.status));

  const nameOf = (id: string | null) =>
    (staff.data ?? []).find((s) => s.id === id)?.full_name ?? "Unassigned";

  const renderList = (items: (Task & { departments: { name: string } | null })[]) =>
    tasksQuery.isLoading ? (
      <LoadingState variant="rows" rows={3} />
    ) : tasksQuery.error ? (
      <ErrorState error={tasksQuery.error} onRetry={() => void tasksQuery.refetch()} inline />
    ) : items.length === 0 ? (
      <EmptyState
        title="Nothing here yet"
        description="No tasks match this list. Create a task to get started."
      />
    ) : (
      <ul className="space-y-3">
        {items.map((t) => (
          <li key={t.id} className="surface-panel p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{t.title}</p>
                  <StatusPill tone={priorityTone(t.priority)}>{t.priority}</StatusPill>
                  {isOverdue(t) ? (
                    <StatusPill tone="destructive">Overdue · escalated</StatusPill>
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t.description || "No description"}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t.reference ? `${t.reference} · ` : ""}
                  {t.departments?.name ?? "No department"} · {nameOf(t.assignee_id)}
                  {t.due_at ? ` · due ${new Date(t.due_at).toLocaleString()}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  value={t.assignee_id ?? ""}
                  onValueChange={(v) =>
                    update.mutate({ id: t.id, patch: { assignee_id: v, status: "assigned" } })
                  }
                >
                  <SelectTrigger className="h-8 w-full sm:w-40" aria-label="Reassign">
                    <SelectValue placeholder="Assign" />
                  </SelectTrigger>
                  <SelectContent>
                    {(staff.data ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.full_name || "Unnamed"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={t.status}
                  onValueChange={(v) =>
                    update.mutate({
                      id: t.id,
                      patch: {
                        status: v,
                        progress: v === "completed" ? 100 : t.progress,
                        completed_at: v === "completed" ? new Date().toISOString() : null,
                      },
                    })
                  }
                >
                  <SelectTrigger className="h-8 w-full sm:w-36" aria-label="Status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Progress value={t.status === "completed" ? 100 : t.progress} className="mt-3" />
          </li>
        ))}
      </ul>
    );

  return (
    <div>
      <PageHeader
        eyebrow="Operations"
        title="Tasks"
        description="Central task board: assignment, due dates, priorities, progress and overdue escalation."
        actions={
          <div className="flex items-center gap-2">
            <DocumentPrintButton
              type="task_sheet"
              id={profile?.department_id ?? null}
              label="Task sheet"
            />
            <Button onClick={() => setOpen(true)}>
              <Plus className="size-4" /> New task
            </Button>
          </div>
        }
      />

      <SectionCard title="Task board" description={`${all.length} task(s)`}>
        <Tabs defaultValue="mine">
          <TabsList className="flex flex-wrap">
            <TabsTrigger value="mine">My tasks ({mine.length})</TabsTrigger>
            <TabsTrigger value="dept">Department ({dept.length})</TabsTrigger>
            <TabsTrigger value="overdue">Overdue ({overdue.length})</TabsTrigger>
            <TabsTrigger value="completed">Completed ({completed.length})</TabsTrigger>
            <TabsTrigger value="all">All ({all.length})</TabsTrigger>
            <TabsTrigger value="calendar">Calendar</TabsTrigger>
          </TabsList>
          <TabsContent value="mine" className="pt-4">
            {renderList(mine)}
          </TabsContent>
          <TabsContent value="dept" className="pt-4">
            {renderList(dept)}
          </TabsContent>
          <TabsContent value="overdue" className="pt-4">
            {renderList(overdue)}
          </TabsContent>
          <TabsContent value="completed" className="pt-4">
            {renderList(completed)}
          </TabsContent>
          <TabsContent value="all" className="pt-4">
            {renderList(all)}
          </TabsContent>
          <TabsContent value="calendar" className="pt-4">
            <TaskDueCalendar tasks={all} isLoading={tasksQuery.isLoading} />
          </TabsContent>
        </Tabs>
      </SectionCard>

      <NewTaskDialog
        open={open}
        onOpenChange={setOpen}
        staff={staff.data ?? []}
        departments={departments.data ?? []}
        onCreate={async (payload) => {
          if (!organizationId || !user) return;
          const { data: ref } = await guardedRpc(supabase, "next_document_number", { _doc_type: "task" });
          const { error } = await supabase.from("tasks").insert({
            organization_id: organizationId,
            created_by: user.id,
            reference: (ref as string) ?? "",
            ...payload,
            status: payload.assignee_id ? "assigned" : "new",
          });
          if (error) throw error;
          if (payload.assignee_id) {
            await supabase.from("notifications").insert({
              organization_id: organizationId,
              user_id: payload.assignee_id,
              category: "task-assignment",
              title: "New task assigned",
              body: payload.title,
              link: "/tasks",
            });
          }
          void qc.invalidateQueries({ queryKey: ["tasks"] });
        }}
      />
    </div>
  );
}

function NewTaskDialog({
  open,
  onOpenChange,
  staff,
  departments,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  staff: { id: string; full_name: string }[];
  departments: { id: string; name: string }[];
  onCreate: (payload: {
    title: string;
    description: string;
    assignee_id: string | null;
    department_id: string | null;
    due_at: string | null;
    priority: string;
  }) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState("");
  const [department, setDepartment] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [priority, setPriority] = useState("normal");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await onCreate({
        title,
        description,
        assignee_id: assignee || null,
        department_id: department || null,
        due_at: dueAt ? new Date(dueAt).toISOString() : null,
        priority,
      });
      toast.success("Task created");
      onOpenChange(false);
      setTitle("");
      setDescription("");
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create task</DialogTitle>
          <DialogDescription>e.g. "Prepare Room 203 before arrival".</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">Title</Label>
            <Input id="title" required value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="desc">Description</Label>
            <Textarea
              id="desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Assign to</Label>
              <Select value={assignee} onValueChange={setAssignee}>
                <SelectTrigger>
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  {staff.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.full_name || "Unnamed"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Department</Label>
              <Select value={department} onValueChange={setDepartment}>
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="due">Due</Label>
              <Input
                id="due"
                type="datetime-local"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Priority</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">
              <CalendarClock className="size-4" /> Create task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Due-date month view over the tasks the operator may already see. It reads no
 * additional data and grants no additional authority — it is the same permitted
 * rows arranged by due date, sized to its container like every other NEØ
 * calendar.
 */
function TaskDueCalendar({ tasks, isLoading = false }: { tasks: Task[]; isLoading?: boolean }) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  });

  const todayIso = new Date().toISOString().slice(0, 10);
  const byDay = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!t.due_at) continue;
    const key = new Date(t.due_at).toISOString().slice(0, 10);
    byDay.set(key, [...(byDay.get(key) ?? []), t]);
  }

  const cells = monthCells(cursor.getUTCFullYear(), cursor.getUTCMonth(), { today: todayIso }).map(
    (cell) => {
      const items = byDay.get(cell.key) ?? [];
      return {
        ...cell,
        count: items.length,
        content: items.map((t) => (
          <div
            key={t.id}
            className="min-w-0 rounded bg-muted/70 px-1.5 py-1 text-[0.65rem] leading-tight"
            title={t.title}
          >
            <p className="truncate font-medium">{t.title}</p>
            <p className="truncate text-muted-foreground">{t.status}</p>
          </div>
        )),
      };
    },
  );

  const monthLabel = cursor.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  const scheduled = tasks.filter((t) => t.due_at).length;

  return (
    <div className="space-y-3">
      <CalendarToolbar
        label={monthLabel}
        prevLabel="Previous month"
        nextLabel="Next month"
        onPrev={() =>
          setCursor(new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - 1, 1)))
        }
        onNext={() =>
          setCursor(new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1)))
        }
        onToday={() => {
          const now = new Date();
          setCursor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
        }}
      >
        <span className="text-xs text-muted-foreground">
          {scheduled} of {tasks.length} task(s) carry a due date
        </span>
      </CalendarToolbar>
      <CalendarDayLegend states={["today", "available", "limited", "unavailable"]} />
      {isLoading ? (
        <CalendarMonthSkeleton />
      ) : (
        <CalendarMonthGrid ariaLabel={monthLabel} cells={cells} />
      )}
    </div>
  );
}
