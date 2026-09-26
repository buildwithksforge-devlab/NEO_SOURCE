import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { PageHeader, SectionCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, PmsGuard, QueryState } from "@/components/pms/PmsShared";
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/pms";
import {
  FO_PRIORITIES,
  str,
  useCreateFrontOfficeTask,
  useFrontOfficeStaffOptions,
  useFrontOfficeTasks,
  useUpdateFrontOfficeTask,
  type FrontOfficeRow,
} from "@/lib/front-office-department";

export const Route = createFileRoute("/_shell/pms/tasks")({
  head: () => ({
    meta: [
      { title: "Front Office Tasks — NEØ" },
      {
        name: "description",
        content:
          "Front Office Manager task board: assign desk work to receptionists and follow every task through to completion.",
      },
      { property: "og:title", content: "Front Office Tasks — NEØ" },
      {
        property: "og:description",
        content: "Assign and track Front Office desk tasks. Receptionists see only their own work.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PmsGuard action="tasks.view">
      <FrontOfficeTasksPage />
    </PmsGuard>
  ),
});

const TONE: Record<string, "success" | "warning" | "destructive" | "default"> = {
  completed: "success",
  "in-progress": "warning",
  open: "warning",
  blocked: "destructive",
  cancelled: "destructive",
};

function FrontOfficeTasksPage() {
  const { can } = useAuth();
  const mayAssign = can("pms", "tasks.approve");
  const scope = mayAssign ? "department" : "mine";
  const tasks = useFrontOfficeTasks(scope);
  const staff = useFrontOfficeStaffOptions();
  const create = useCreateFrontOfficeTask();
  const update = useUpdateFrontOfficeTask();

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [priority, setPriority] = useState("normal");

  const rows = (tasks.data ?? []) as FrontOfficeRow[];
  const staffRows = (staff.data ?? []) as FrontOfficeRow[];
  const staffName = (id: unknown) => {
    const match = staffRows.find((r) => String(r["id"]) === String(id));
    return match ? str(match["full_name"] ?? match["staff_id"]) : "—";
  };

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
        eyebrow="Front Office"
        title={mayAssign ? "Front Office Tasks" : "My Front Office Tasks"}
        description={
          mayAssign
            ? "Desk work for the whole department. A receptionist sees only the tasks assigned to them."
            : "The desk work assigned to you. Update a task as you progress it."
        }
        actions={
          mayAssign ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> Assign task
            </Button>
          ) : null
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <SectionCard title="Open">
          <p className="text-3xl font-semibold">
            {rows.filter((r) => String(r["status"]) === "open").length}
          </p>
        </SectionCard>
        <SectionCard title="In progress">
          <p className="text-3xl font-semibold">
            {rows.filter((r) => String(r["status"]) === "in-progress").length}
          </p>
        </SectionCard>
        <SectionCard title="Completed">
          <p className="text-3xl font-semibold">
            {rows.filter((r) => String(r["status"]) === "completed").length}
          </p>
        </SectionCard>
      </div>

      <SectionCard title={mayAssign ? "Department tasks" : "My tasks"}>
        <QueryState
          isLoading={tasks.isLoading}
          error={tasks.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No Front Office tasks"
              description={
                mayAssign
                  ? "Assign desk work — an arrival preparation, a guest follow-up, a shift handover check — and it appears in that receptionist's workspace."
                  : "Nothing is assigned to you right now."
              }
            />
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Task</TableHead>
                  {mayAssign ? <TableHead>Receptionist</TableHead> : null}
                  <TableHead>Due</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const id = String(r["id"]);
                  const status = String(r["status"] ?? "open");
                  const done = status === "completed" || status === "cancelled";
                  return (
                    <TableRow key={id}>
                      <TableCell className="font-medium">
                        {str(r["title"])}
                        {r["description"] ? (
                          <div className="text-xs font-normal text-muted-foreground">
                            {str(r["description"], "")}
                          </div>
                        ) : null}
                      </TableCell>
                      {mayAssign ? <TableCell>{staffName(r["assignee_id"])}</TableCell> : null}
                      <TableCell className="text-sm text-muted-foreground">
                        {r["due_at"] ? new Date(String(r["due_at"])).toLocaleString() : "—"}
                      </TableCell>
                      <TableCell>{titleCase(str(r["priority"], "normal"))}</TableCell>
                      <TableCell>
                        <StatusPill tone={TONE[status] ?? "default"}>
                          {titleCase(status.replace(/-/g, " "))}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="space-x-2 text-right">
                        {!done && status !== "in-progress" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={update.isPending}
                            onClick={() => update.mutate({ taskId: id, status: "in-progress" })}
                          >
                            Start
                          </Button>
                        ) : null}
                        {!done ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={update.isPending}
                            onClick={() => update.mutate({ taskId: id, status: "completed" })}
                          >
                            Complete
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign a Front Office task</DialogTitle>
            <DialogDescription>
              Only the assigned receptionist sees this task in their workspace. Every update stays
              attributed to them.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="fo-task-title">Task</Label>
              <Input
                id="fo-task-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Prepare VIP arrival for room 204"
              />
            </div>
            <div>
              <Label>Receptionist</Label>
              <Select value={assignee} onValueChange={setAssignee}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a Front Office staff member" />
                </SelectTrigger>
                <SelectContent>
                  {staffRows.map((r) => (
                    <SelectItem key={String(r["id"])} value={String(r["id"])}>
                      {str(r["full_name"])} · {str(r["job_title"], "Front Office")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="fo-task-due">Due</Label>
                <Input
                  id="fo-task-due"
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
                    {FO_PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>
                        {titleCase(p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label htmlFor="fo-task-brief">Briefing</Label>
              <Textarea
                id="fo-task-brief"
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
    </div>
  );
}
