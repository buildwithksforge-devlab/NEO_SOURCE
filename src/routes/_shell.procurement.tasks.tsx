import { useState } from "react";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ClipboardList } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, QueryState } from "@/components/pms/PmsShared";
import { OpsGuard } from "@/components/operations/OpsShared";
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
import { titleCase } from "@/lib/procurement";
import {
  str,
  useCreateProcurementTask,
  useProcurementTasks,
  useUpdateProcurementTask,
  type ProcRow,
} from "@/lib/procurement-department";

export const Route = createFileRoute("/_shell/procurement/tasks")({
  head: () => ({
    meta: [
      { title: "Procurement Tasks — NEØ" },
      {
        name: "description",
        content:
          "Supplier follow-ups, contract renewals and sourcing work tracked as dated procurement tasks.",
      },
      { property: "og:title", content: "Procurement Tasks — NEØ" },
      {
        property: "og:description",
        content:
          "A working list for the procurement office: follow-ups, renewals and sourcing deadlines.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="procurement" action="view">
      <ProcurementTasksPage />
    </OpsGuard>
  ),
});

const TONE: Record<string, "default" | "success" | "warning" | "info" | "destructive"> = {
  open: "warning",
  "in-progress": "info",
  completed: "success",
  cancelled: "default",
};

const FILTERS = [
  { key: "open", label: "Open" },
  { key: "overdue", label: "Overdue" },
  { key: "completed", label: "Completed" },
  { key: "all", label: "All" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

/** Overdue = still open work whose due date has passed. */
function isOverdue(row: ProcRow): boolean {
  const status = str(row["status"], "open");
  if (status === "completed" || status === "cancelled") return false;
  const due = row["due_at"] ? new Date(String(row["due_at"])).getTime() : NaN;
  return Number.isFinite(due) && due < Date.now();
}

function ProcurementTasksPage() {
  const tasks = useProcurementTasks();
  const create = useCreateProcurementTask();
  const update = useUpdateProcurementTask();

  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [filter, setFilter] = useState<FilterKey>("open");

  const rows = (tasks.data ?? []) as ProcRow[];
  const matches = (row: ProcRow, key: FilterKey): boolean => {
    const status = str(row["status"], "open");
    if (key === "all") return true;
    if (key === "overdue") return isOverdue(row);
    if (key === "completed") return status === "completed";
    return status !== "completed" && status !== "cancelled";
  };
  const counts = Object.fromEntries(
    FILTERS.map((f) => [f.key, rows.filter((r) => matches(r, f.key)).length]),
  ) as Record<FilterKey, number>;
  const visible = rows.filter((r) => matches(r, filter));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Procurement"
        title="Procurement tasks"
        description="Supplier follow-ups, contract renewals, price reviews and sourcing deadlines, each with an owner and a due date."
      />

      <SectionCard title="Add a task">
        <div className="grid gap-3 md:grid-cols-4">
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="task-title">Task</Label>
            <Input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Chase linen supplier on overdue delivery"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-due">Due</Label>
            <NeoDatePicker id="task-due" value={dueAt} onChange={setDueAt} />
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

      <SectionCard
        title="Task history"
        description="Soonest due first. Completed work stays on the record with the order it belonged to."
        actions={
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <Button
                key={f.key}
                size="sm"
                variant={filter === f.key ? "default" : "outline"}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                <span className="ml-1 text-xs opacity-70">{counts[f.key]}</span>
              </Button>
            ))}
          </div>
        }
      >
        <QueryState
          isLoading={tasks.isLoading}
          error={tasks.error}
          isEmpty={visible.length === 0}
          empty={
            <EmptyState
              title="Nothing in this view"
              description="Add follow-ups and renewals so nothing falls through between orders."
              icon={ClipboardList}
            />
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Task</TableHead>
                  <TableHead>Purchase order</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((row) => {
                  const status = str(row["status"], "open");
                  const order = (row["purchase_order"] ?? null) as ProcRow | null;
                  const overdue = isOverdue(row);
                  return (
                    <TableRow key={String(row["id"])}>
                      <TableCell className="font-medium">
                        {str(row["title"])}
                        {status === "completed" && order ? (
                          <p className="mt-0.5 text-xs font-normal text-muted-foreground">
                            Closed automatically — order {titleCase(str(order["status"], "closed"))}
                            {order["closed_at"]
                              ? ` on ${String(order["closed_at"]).slice(0, 10)}`
                              : ""}
                            {order["close_reason"] ? ` · ${str(order["close_reason"])}` : ""}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {order ? (
                          <Link
                            className="underline underline-offset-2"
                            to="/lpos/$id"
                            params={{ id: String(order["id"]) }}
                          >
                            {str(order["order_number"])}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        {str((order?.["suppliers"] as ProcRow | null)?.["name"] ?? null)}
                      </TableCell>
                      <TableCell>{String(row["due_at"] ?? "").slice(0, 10) || "—"}</TableCell>
                      <TableCell>{titleCase(str(row["priority"], "normal"))}</TableCell>
                      <TableCell>
                        <StatusPill tone={overdue ? "destructive" : (TONE[status] ?? "default")}>
                          {overdue ? "Overdue" : titleCase(status)}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="text-right">
                        {status === "completed" ? (
                          <span className="text-xs text-muted-foreground">
                            Done
                            {row["completed_at"]
                              ? ` ${String(row["completed_at"]).slice(0, 10)}`
                              : ""}
                          </span>
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
