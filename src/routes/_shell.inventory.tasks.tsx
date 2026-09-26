import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ListChecks } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, OpsGuard, QueryState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/operations";
import {
  str,
  useCreateStoresTask,
  useStoresStaffOptions,
  useStoresTasks,
  useUpdateStoresTask,
  type StoresRow,
} from "@/lib/stores-department";

export const Route = createFileRoute("/_shell/inventory/tasks")({
  head: () => ({
    meta: [
      { title: "Stores tasks — NEØ" },
      {
        name: "description",
        content:
          "Assign and track Stores work: counts to run, deliveries to check in, shelves to tidy and requisitions to chase.",
      },
      { property: "og:title", content: "Stores tasks — NEØ" },
      {
        property: "og:description",
        content: "Day-to-day task board for the Inventory & Stores department.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="stores" action="tasks.view">
      <StoresTasksPage />
    </OpsGuard>
  ),
});

const TASK_TONE: Record<string, "success" | "warning" | "info" | "default"> = {
  open: "info",
  "in-progress": "warning",
  completed: "success",
  done: "success",
};

function StoresTasksPage() {
  const { can } = useAuth();
  const mayAssign = can("stores", "tasks.create") || can("stores", "tasks.edit");

  const [scope, setScope] = useState<"department" | "mine">(mayAssign ? "department" : "mine");
  const tasks = useStoresTasks(scope);
  const staff = useStoresStaffOptions();
  const create = useCreateStoresTask();
  const update = useUpdateStoresTask();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [dueAt, setDueAt] = useState("");

  const rows = (tasks.data ?? []) as StoresRow[];
  const staffRows = (staff.data ?? []) as StoresRow[];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Inventory & Stores"
        title="Stores tasks"
        description="Work the Storekeeper hands out and the department completes — counts, deliveries, put-aways and chased requisitions."
        actions={
          mayAssign ? (
            <Tabs value={scope} onValueChange={(v) => setScope(v as "department" | "mine")}>
              <TabsList>
                <TabsTrigger value="department">Department</TabsTrigger>
                <TabsTrigger value="mine">Mine</TabsTrigger>
              </TabsList>
            </Tabs>
          ) : null
        }
      />

      {mayAssign ? (
        <SectionCard
          title="Assign a task"
          description="Only active Stores staff at this property can be assigned."
        >
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="space-y-2 sm:col-span-2">
              <Label>Task</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Cycle count dry store"
              />
            </div>
            <div className="space-y-2">
              <Label>Assign to</Label>
              <Select value={assigneeId} onValueChange={setAssigneeId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose staff" />
                </SelectTrigger>
                <SelectContent>
                  {staffRows.map((row) => (
                    <SelectItem key={String(row["id"])} value={String(row["id"])}>
                      {str(row["full_name"], "Staff")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Due</Label>
              <Input
                type="datetime-local"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
              />
            </div>
            <div className="space-y-2 sm:col-span-4">
              <Label>Description</Label>
              <Textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What exactly should be done, where, and what counts as finished"
              />
            </div>
          </div>
          <Button
            className="mt-4"
            disabled={
              create.isPending || title.trim() === "" || description.trim() === "" || !assigneeId
            }
            onClick={() =>
              create.mutate(
                {
                  title: title.trim(),
                  description: description.trim(),
                  assigneeId,
                  dueAt: dueAt ? new Date(dueAt).toISOString() : null,
                },
                {
                  onSuccess: () => {
                    setTitle("");
                    setDescription("");
                    setAssigneeId("");
                    setDueAt("");
                  },
                },
              )
            }
          >
            Assign task
          </Button>
        </SectionCard>
      ) : null}

      <QueryState
        isLoading={tasks.isLoading}
        error={tasks.error}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            icon={ListChecks}
            title="No tasks"
            description="Nothing is outstanding for Stores right now."
          />
        }
      >
        <div className="space-y-3">
          {rows.map((row) => {
            const id = String(row["id"]);
            const status = str(row["status"], "open");
            const done = status === "completed" || status === "done";
            return (
              <div
                key={id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4"
              >
                <div>
                  <p className="font-medium">{str(row["title"], "Task")}</p>
                  <p className="text-xs text-muted-foreground">
                    {row["due_at"]
                      ? `Due ${new Date(String(row["due_at"])).toLocaleString()}`
                      : "No due date"}{" "}
                    · {titleCase(str(row["priority"], "normal"))} priority
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill tone={TASK_TONE[status] ?? "default"}>{titleCase(status)}</StatusPill>
                  {!done ? (
                    <>
                      {status === "open" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={update.isPending}
                          onClick={() => update.mutate({ taskId: id, status: "in-progress" })}
                        >
                          Start
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        disabled={update.isPending}
                        onClick={() => update.mutate({ taskId: id, status: "completed" })}
                      >
                        Complete
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </QueryState>
    </div>
  );
}
