import { useState } from "react";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { createFileRoute } from "@tanstack/react-router";
import { ClipboardList } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, OpsGuard, QueryState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { titleCase } from "@/lib/operations";
import {
  str,
  useCreateMarketingTask,
  useMarketingTasks,
  useUpdateMarketingTask,
  type MktRow,
} from "@/lib/marketing-department";

export const Route = createFileRoute("/_shell/marketing/tasks")({
  head: () => ({
    meta: [
      { title: "Marketing Tasks — NEØ" },
      {
        name: "description",
        content:
          "Campaign deadlines, shoots, partnerships and follow-ups tracked as dated marketing tasks.",
      },
      { property: "og:title", content: "Marketing Tasks — NEØ" },
      {
        property: "og:description",
        content:
          "A working list for the marketing office so campaign deadlines never slip quietly.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="marketing" action="tasks.view">
      <MarketingTasksPage />
    </OpsGuard>
  ),
});

const TONE: Record<string, "default" | "success" | "warning" | "info" | "destructive"> = {
  open: "warning",
  "in-progress": "info",
  completed: "success",
  cancelled: "default",
};

function MarketingTasksPage() {
  const tasks = useMarketingTasks();
  const create = useCreateMarketingTask();
  const update = useUpdateMarketingTask();

  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");

  const rows = (tasks.data ?? []) as MktRow[];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Marketing"
        title="Marketing tasks"
        description="Shoots, campaign deadlines, partner follow-ups and reporting dates, each with an owner and a due date."
      />

      <SectionCard title="Add a task">
        <div className="grid gap-3 md:grid-cols-4">
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="mkt-task-title">Task</Label>
            <Input
              id="mkt-task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Book photographer for the new suite shoot"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mkt-task-due">Due</Label>
            <NeoDatePicker id="mkt-task-due" value={dueAt} onChange={setDueAt} />
          </div>
          <div className="flex items-end">
            <Button
              className="w-full"
              disabled={!title.trim() || create.isPending}
              onClick={() =>
                create.mutate(
                  { title, dueAt },
                  {
                    onSuccess: () => {
                      setTitle("");
                      setDueAt("");
                    },
                  },
                )
              }
            >
              Add task
            </Button>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Open work" description="Soonest due first.">
        <QueryState
          isLoading={tasks.isLoading}
          error={tasks.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No marketing tasks"
              description="Add campaign deadlines and follow-ups so nothing slips between launches."
              icon={ClipboardList}
            />
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Task</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const status = str(row["status"], "open");
                  return (
                    <TableRow key={String(row["id"])}>
                      <TableCell className="font-medium">{str(row["title"])}</TableCell>
                      <TableCell>{String(row["due_at"] ?? "").slice(0, 10) || "—"}</TableCell>
                      <TableCell>{titleCase(str(row["priority"], "normal"))}</TableCell>
                      <TableCell>
                        <StatusPill tone={TONE[status] ?? "default"}>
                          {titleCase(status)}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="text-right">
                        {status === "completed" ? (
                          <span className="text-xs text-muted-foreground">Done</span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={update.isPending}
                            onClick={() =>
                              update.mutate({ id: String(row["id"]), status: "completed" })
                            }
                          >
                            Complete
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </QueryState>
      </SectionCard>
    </div>
  );
}
