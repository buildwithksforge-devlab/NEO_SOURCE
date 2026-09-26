import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Users } from "lucide-react";
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
import { useAuth } from "@/lib/auth";
import {
  BANQUET_TASK_LABELS,
  BANQUET_TASK_SUGGESTIONS,
  sevStr,
  taskTone,
  useAssignBanquetingStaff,
  useBanquetEventOptions,
  useBanquetTasks,
  useBanquetingStaffOptions,
  useCreateBanquetTask,
  useEventIssues,
  useEventStaffAssignments,
  useRemoveBanquetingAssignment,
  useResolveEventIssue,
  type SevRow,
} from "@/lib/sales-events-department";
import { BanquetingCommandCentre } from "@/components/events/BanquetingCommandCentre";
import { BanquetSetupCard } from "@/components/events/BanquetSetupCard";

export const Route = createFileRoute("/_shell/events/banqueting")({
  head: () => ({
    meta: [
      { title: "Banqueting Console — NEØ" },
      {
        name: "description",
        content:
          "Assign banqueting staff to events, set up the task board for each function and clear the issues raised on the floor.",
      },
      { property: "og:title", content: "Banqueting Console — NEØ" },
      {
        property: "og:description",
        content:
          "Stations, duties and setup tasks for every confirmed event, owned by the Sales & Events Manager.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="events" action="banqueting.view">
      <BanquetingConsolePage />
    </OpsGuard>
  ),
});

function BanquetingConsolePage() {
  const { can } = useAuth();
  const mayAssign = can("events", "banqueting.assign");
  const mayResolve = can("events", "banqueting.assign");

  const events = useBanquetEventOptions();
  const staff = useBanquetingStaffOptions();
  const [bookingId, setBookingId] = useState<string>("");

  const assignments = useEventStaffAssignments(bookingId || null);
  const tasks = useBanquetTasks(bookingId || null);
  const issues = useEventIssues("open");

  const assign = useAssignBanquetingStaff();
  const removeAssignment = useRemoveBanquetingAssignment();
  const createTask = useCreateBanquetTask();
  const resolveIssue = useResolveEventIssue();

  const [staffId, setStaffId] = useState("");
  const [station, setStation] = useState("");
  const [duties, setDuties] = useState("");

  const [taskTitle, setTaskTitle] = useState("");
  const [taskAssignee, setTaskAssignee] = useState("unassigned");
  const [taskInstruction, setTaskInstruction] = useState("");

  const eventRows = (events.data ?? []) as SevRow[];
  const staffRows = staff.data ?? [];
  const assignmentRows = (assignments.data ?? []) as SevRow[];
  const taskRows = (tasks.data ?? []) as SevRow[];
  const issueRows = (issues.data ?? []) as SevRow[];

  const assignedStaff = useMemo(
    () =>
      assignmentRows.map((a) => ({
        id: sevStr(a["staff_user_id"], ""),
        name:
          staffRows.find((s) => s.id === a["staff_user_id"])?.name ??
          sevStr(a["staff_name"], "Assigned staff"),
      })),
    [assignmentRows, staffRows],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Sales, Events & Banqueting"
        title="Banqueting console"
        description="Choose an event, put staff on stations and break the setup into tasks. Banqueting staff only ever see the events they are assigned to."
      />

      <SectionCard
        title="Event"
        description="Confirmed and planned functions for the active property."
      >
        <QueryState isLoading={events.isLoading} error={events.error} isEmpty={false} empty={null}>
          {eventRows.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No events yet"
              description="Create a booking in Events before assigning banqueting staff."
            />
          ) : (
            <Select value={bookingId} onValueChange={setBookingId}>
              <SelectTrigger className="md:w-[420px]">
                <SelectValue placeholder="Select an event" />
              </SelectTrigger>
              <SelectContent>
                {eventRows.map((e) => (
                  <SelectItem key={sevStr(e["id"], "")} value={sevStr(e["id"], "")}>
                    {sevStr(e["event_name"], sevStr(e["event_reference"], "Event"))} ·{" "}
                    {sevStr(e["event_date"], "")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </QueryState>
      </SectionCard>

      {bookingId ? (
        <>
          <BanquetingCommandCentre
            bookingId={bookingId}
            tasks={taskRows}
            assignments={assignmentRows}
            openIssues={issueRows}
          />
          <BanquetSetupCard bookingId={bookingId} />
          {mayAssign ? (
            <SectionCard
              title="Assign staff"
              description="Station and duties are what the staff member will see."
            >
              <div className="grid gap-3 md:grid-cols-4">
                <div className="space-y-1.5">
                  <Label>Staff member</Label>
                  <Select value={staffId} onValueChange={setStaffId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select staff" />
                    </SelectTrigger>
                    <SelectContent>
                      {staffRows.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="station">Station</Label>
                  <Input
                    id="station"
                    value={station}
                    onChange={(e) => setStation(e.target.value)}
                    placeholder="High table / Buffet line"
                  />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label htmlFor="duties">Duties</Label>
                  <Input
                    id="duties"
                    value={duties}
                    onChange={(e) => setDuties(e.target.value)}
                    placeholder="Table setting, water service, clearing"
                  />
                </div>
              </div>
              <div className="mt-3">
                <Button
                  disabled={!staffId || assign.isPending}
                  onClick={() =>
                    assign.mutate(
                      { bookingId, staffId, station, duties },
                      {
                        onSuccess: () => {
                          setStaffId("");
                          setStation("");
                          setDuties("");
                        },
                      },
                    )
                  }
                >
                  Assign to event
                </Button>
              </div>
            </SectionCard>
          ) : null}

          <SectionCard title="Assigned team" description="Everyone rostered onto this function.">
            <QueryState
              isLoading={assignments.isLoading}
              error={assignments.error}
              isEmpty={false}
              empty={null}
            >
              {assignmentRows.length === 0 ? (
                <EmptyState
                  icon={Users}
                  title="Nobody assigned"
                  description="Assign banqueting staff to this event."
                />
              ) : (
                <TableScroll>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Staff</TableHead>
                        <TableHead>Station</TableHead>
                        <TableHead>Duties</TableHead>
                        <TableHead className="text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {assignmentRows.map((a) => (
                        <TableRow key={sevStr(a["id"], "")}>
                          <TableCell>
                            {staffRows.find((s) => s.id === a["staff_user_id"])?.name ??
                              sevStr(a["staff_user_id"])}
                          </TableCell>
                          <TableCell>{sevStr(a["station"])}</TableCell>
                          <TableCell className="max-w-[320px] truncate">
                            {sevStr(a["duties"])}
                          </TableCell>
                          <TableCell className="text-right">
                            {mayAssign ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={removeAssignment.isPending}
                                onClick={() => removeAssignment.mutate(sevStr(a["id"], ""))}
                              >
                                Remove
                              </Button>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableScroll>
              )}
            </QueryState>
          </SectionCard>

          {mayAssign ? (
            <SectionCard
              title="Add a setup task"
              description={`Common tasks: ${BANQUET_TASK_SUGGESTIONS.join(", ")}.`}
            >
              <div className="grid gap-3 md:grid-cols-4">
                <div className="space-y-1.5 md:col-span-2">
                  <Label htmlFor="task-title">Task</Label>
                  <Input
                    id="task-title"
                    value={taskTitle}
                    onChange={(e) => setTaskTitle(e.target.value)}
                    placeholder="Set guest tables"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Assign to</Label>
                  <Select value={taskAssignee} onValueChange={setTaskAssignee}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unassigned">Unassigned</SelectItem>
                      {assignedStaff
                        .filter((s) => s.id)
                        .map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end">
                  <Button
                    className="w-full"
                    disabled={!taskTitle.trim() || createTask.isPending}
                    onClick={() =>
                      createTask.mutate(
                        {
                          bookingId,
                          title: taskTitle,
                          assigneeId: taskAssignee === "unassigned" ? null : taskAssignee,
                          instruction: taskInstruction,
                        },
                        {
                          onSuccess: () => {
                            setTaskTitle("");
                            setTaskInstruction("");
                            setTaskAssignee("unassigned");
                          },
                        },
                      )
                    }
                  >
                    Add task
                  </Button>
                </div>
                <div className="space-y-1.5 md:col-span-4">
                  <Label htmlFor="task-instruction">Instruction</Label>
                  <Textarea
                    id="task-instruction"
                    value={taskInstruction}
                    onChange={(e) => setTaskInstruction(e.target.value)}
                    placeholder="What good looks like for this task"
                  />
                </div>
              </div>
            </SectionCard>
          ) : null}

          <SectionCard
            title="Task board"
            description="Progress reported by the floor, forward only."
          >
            <QueryState
              isLoading={tasks.isLoading}
              error={tasks.error}
              isEmpty={false}
              empty={null}
            >
              {taskRows.length === 0 ? (
                <EmptyState
                  icon={Users}
                  title="No tasks yet"
                  description="Break the setup down into tasks."
                />
              ) : (
                <TableScroll>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Task</TableHead>
                        <TableHead>Assignee</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Blocker</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {taskRows.map((t) => (
                        <TableRow key={sevStr(t["id"], "")}>
                          <TableCell className="font-medium">{sevStr(t["title"])}</TableCell>
                          <TableCell>
                            {staffRows.find((s) => s.id === t["assignee_user_id"])?.name ??
                              sevStr(t["assignee_user_id"], "Unassigned")}
                          </TableCell>
                          <TableCell>
                            <StatusPill tone={taskTone(sevStr(t["status"], ""))}>
                              {BANQUET_TASK_LABELS[sevStr(t["status"], "")] ?? sevStr(t["status"])}
                            </StatusPill>
                          </TableCell>
                          <TableCell className="max-w-[280px] truncate">
                            {sevStr(t["blocker_note"])}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableScroll>
              )}
            </QueryState>
          </SectionCard>
        </>
      ) : null}

      <SectionCard
        title="Open issues"
        description="Raised by banqueting staff and routed to the owning department."
      >
        <QueryState isLoading={issues.isLoading} error={issues.error} isEmpty={false} empty={null}>
          {issueRows.length === 0 ? (
            <EmptyState
              icon={Users}
              title="Nothing outstanding"
              description="No open issues on the floor."
            />
          ) : (
            <TableScroll>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead>Detail</TableHead>
                    <TableHead>Routed to</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {issueRows.map((i) => (
                    <TableRow key={sevStr(i["id"], "")}>
                      <TableCell>{sevStr(i["category"])}</TableCell>
                      <TableCell className="max-w-[360px] truncate">
                        {sevStr(i["detail"])}
                      </TableCell>
                      <TableCell>{sevStr(i["route_to"])}</TableCell>
                      <TableCell className="text-right">
                        {mayResolve ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={resolveIssue.isPending}
                            onClick={() =>
                              resolveIssue.mutate({
                                issueId: sevStr(i["id"], ""),
                                status: "resolved",
                              })
                            }
                          >
                            Resolve
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableScroll>
          )}
        </QueryState>
      </SectionCard>
    </div>
  );
}
