import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ClipboardList } from "lucide-react";
import { PageHeader, SectionCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  BANQUET_ISSUE_CATEGORIES,
  BANQUET_TASK_LABELS,
  nextTaskStatus,
  sevStr,
  taskTone,
  useAdvanceBanquetTask,
  useMyBanquetTasks,
  useMyEventAssignments,
  useReportEventIssue,
  type SevRow,
} from "@/lib/sales-events-department";

export const Route = createFileRoute("/_shell/events/my-tasks")({
  head: () => ({
    meta: [
      { title: "My Banqueting Tasks — NEØ" },
      {
        name: "description",
        content:
          "The events you are assigned to, the setup tasks that belong to you and a way to flag what is missing.",
      },
      { property: "og:title", content: "My Banqueting Tasks — NEØ" },
      {
        property: "og:description",
        content:
          "Update task progress and report missing items or delays straight to the department that fixes them.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="events" action="my_tasks.view">
      <MyBanquetingTasksPage />
    </OpsGuard>
  ),
});

function MyBanquetingTasksPage() {
  const assignments = useMyEventAssignments();
  const tasks = useMyBanquetTasks();
  const advance = useAdvanceBanquetTask();
  const report = useReportEventIssue();

  const [issueBooking, setIssueBooking] = useState("none");
  const [category, setCategory] = useState<string>(BANQUET_ISSUE_CATEGORIES[0].value);
  const [detail, setDetail] = useState("");
  const [blockerFor, setBlockerFor] = useState<string | null>(null);
  const [blockerNote, setBlockerNote] = useState("");

  const assignmentRows = (assignments.data ?? []) as SevRow[];
  const taskRows = (tasks.data ?? []) as SevRow[];
  const routesTo =
    BANQUET_ISSUE_CATEGORIES.find((c) => c.value === category)?.routesTo ?? "the manager";

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Banqueting"
        title="My events & tasks"
        description="Only the functions you are assigned to. Update progress as you go — pricing, payments and cancellations stay with the Sales & Events Manager."
      />

      <SectionCard title="My events" description="Station and duties as set by your manager.">
        <QueryState
          isLoading={assignments.isLoading}
          error={assignments.error}
          isEmpty={false}
          empty={null}
        >
          {assignmentRows.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No events assigned"
              description="Your manager has not put you on a function yet."
            />
          ) : (
            <TableScroll>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Event</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Station</TableHead>
                    <TableHead>Duties</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assignmentRows.map((a) => {
                    const b = (a["event_bookings"] ?? {}) as Record<string, unknown>;
                    return (
                      <TableRow key={sevStr(a["id"], "")}>
                        <TableCell className="font-medium">
                          {sevStr(b["event_name"], sevStr(b["event_reference"], "Event"))}
                        </TableCell>
                        <TableCell>{sevStr(b["event_date"])}</TableCell>
                        <TableCell>{sevStr(a["station"])}</TableCell>
                        <TableCell className="max-w-[320px] truncate">
                          {sevStr(a["duties"])}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableScroll>
          )}
        </QueryState>
      </SectionCard>

      <SectionCard
        title="My tasks"
        description="Progress only moves forward. Flag a blocker if you are stuck."
      >
        <QueryState isLoading={tasks.isLoading} error={tasks.error} isEmpty={false} empty={null}>
          {taskRows.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No tasks"
              description="Nothing has been assigned to you yet."
            />
          ) : (
            <TableScroll>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Task</TableHead>
                    <TableHead>Instruction</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Update</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {taskRows.map((t) => {
                    const id = sevStr(t["id"], "");
                    const status = sevStr(t["status"], "not-started");
                    const next = nextTaskStatus(status);
                    return (
                      <TableRow key={id}>
                        <TableCell className="font-medium">{sevStr(t["title"])}</TableCell>
                        <TableCell className="max-w-[320px] truncate">
                          {sevStr(t["instruction"])}
                        </TableCell>
                        <TableCell>
                          <StatusPill tone={taskTone(status)}>
                            {BANQUET_TASK_LABELS[status] ?? status}
                          </StatusPill>
                        </TableCell>
                        <TableCell className="space-x-2 text-right">
                          {next ? (
                            <Button
                              size="sm"
                              disabled={advance.isPending}
                              onClick={() => advance.mutate({ taskId: id, status: next })}
                            >
                              Mark {BANQUET_TASK_LABELS[next]}
                            </Button>
                          ) : null}
                          {status !== "completed" && status !== "blocked" ? (
                            <Button size="sm" variant="outline" onClick={() => setBlockerFor(id)}>
                              Blocked
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableScroll>
          )}
        </QueryState>

        {blockerFor ? (
          <div className="mt-4 grid gap-3 md:grid-cols-4">
            <div className="space-y-1.5 md:col-span-3">
              <Label htmlFor="blocker">What is blocking this task?</Label>
              <Input
                id="blocker"
                value={blockerNote}
                onChange={(e) => setBlockerNote(e.target.value)}
                placeholder="Linen for table 4 has not arrived"
              />
            </div>
            <div className="flex items-end gap-2">
              <Button
                disabled={!blockerNote.trim() || advance.isPending}
                onClick={() =>
                  advance.mutate(
                    { taskId: blockerFor, status: "blocked", blocker: blockerNote },
                    {
                      onSuccess: () => {
                        setBlockerFor(null);
                        setBlockerNote("");
                      },
                    },
                  )
                }
              >
                Report blocker
              </Button>
              <Button variant="ghost" onClick={() => setBlockerFor(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title="Report an issue" description={`This goes to ${routesTo}.`}>
        <div className="grid gap-3 md:grid-cols-4">
          <div className="space-y-1.5">
            <Label>Event</Label>
            <Select value={issueBooking} onValueChange={setIssueBooking}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not event specific</SelectItem>
                {assignmentRows.map((a) => {
                  const b = (a["event_bookings"] ?? {}) as Record<string, unknown>;
                  return (
                    <SelectItem key={sevStr(a["id"], "")} value={sevStr(a["booking_id"], "")}>
                      {sevStr(b["event_name"], sevStr(b["event_reference"], "Event"))}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BANQUET_ISSUE_CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="issue-detail">Detail</Label>
            <Textarea
              id="issue-detail"
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder="Six chair covers are torn on the main hall setup"
            />
          </div>
        </div>
        <div className="mt-3">
          <Button
            disabled={!detail.trim() || report.isPending}
            onClick={() =>
              report.mutate(
                {
                  bookingId: issueBooking === "none" ? null : issueBooking,
                  category,
                  detail,
                },
                { onSuccess: () => setDetail("") },
              )
            }
          >
            Report issue
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}
