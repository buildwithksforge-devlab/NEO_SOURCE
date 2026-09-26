import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NeoDatePicker } from "@/components/common/DatePicker";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, PmsGuard, QueryState } from "@/components/pms/PmsShared";
import { titleCase } from "@/lib/pms";
import {
  str,
  summariseActivity,
  useArrivalRisk,
  useFrontOfficeStockNeeds,
  useFrontOfficeTasks,
  useReceptionistActivity,
  type FrontOfficeRow,
} from "@/lib/front-office-department";

export const Route = createFileRoute("/_shell/pms/reports")({
  head: () => ({
    meta: [
      { title: "Front Office Intelligence — NEØ" },
      {
        name: "description",
        content:
          "Front Office intelligence: arrival risk, desk workload and receptionist activity, all read from live operational records.",
      },
      { property: "og:title", content: "Front Office Intelligence — NEØ" },
      {
        property: "og:description",
        content:
          "Arrival risk, open desk tasks, supply pressure and per-receptionist activity for the selected day.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PmsGuard action="intelligence.view">
      <FrontOfficeReportsPage />
    </PmsGuard>
  ),
});

function today() {
  return new Date().toISOString().slice(0, 10);
}

function FrontOfficeReportsPage() {
  const [date, setDate] = useState(today());
  const risk = useArrivalRisk(date);
  const tasks = useFrontOfficeTasks("department");
  const needs = useFrontOfficeStockNeeds("pending");
  const activity = useReceptionistActivity(date);

  const riskRows = (risk.data ?? []) as FrontOfficeRow[];
  const taskRows = (tasks.data ?? []) as FrontOfficeRow[];
  const needRows = (needs.data ?? []) as FrontOfficeRow[];
  const activityRows = summariseActivity((activity.data ?? []) as FrontOfficeRow[]);

  const openTasks = taskRows.filter(
    (r) => String(r["status"]) !== "completed" && String(r["status"]) !== "cancelled",
  );
  const overdue = openTasks.filter(
    (r) => r["due_at"] && new Date(String(r["due_at"])).getTime() < Date.now(),
  );

  return (
    <div>
      <PageHeader
        eyebrow="Front Office"
        title="Front Office Intelligence"
        description="Desk pressure for the selected day, derived from reservations, rooms, tasks and the audit trail. No figure here is estimated."
        actions={
          <div className="w-48">
            <Label htmlFor="fo-report-date" className="sr-only">
              Business date
            </Label>
            <NeoDatePicker
              id="fo-report-date"
              value={date}
              onChange={(v) => setDate(v || today())}
              clearable={false}
              quick={["today", "tomorrow", "next-7", "this-month"]}
            />
          </div>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SectionCard title="Arrivals at risk">
          <p className="text-3xl font-semibold">{risk.isLoading ? "—" : riskRows.length}</p>
          <p className="text-xs text-muted-foreground">Unassigned or room not released</p>
        </SectionCard>
        <SectionCard title="Open desk tasks">
          <p className="text-3xl font-semibold">{tasks.isLoading ? "—" : openTasks.length}</p>
          <p className="text-xs text-muted-foreground">{overdue.length} past due</p>
        </SectionCard>
        <SectionCard title="Pending stock needs">
          <p className="text-3xl font-semibold">{needs.isLoading ? "—" : needRows.length}</p>
          <p className="text-xs text-muted-foreground">Awaiting manager review</p>
        </SectionCard>
        <SectionCard title="Logged desk actions">
          <p className="text-3xl font-semibold">
            {activity.isLoading ? "—" : (activity.data ?? []).length}
          </p>
          <p className="text-xs text-muted-foreground">Attributed to {activityRows.length} staff</p>
        </SectionCard>
      </div>

      <div className="space-y-6">
        <SectionCard
          title="Arrival risk"
          description="Confirmed arrivals for this date whose room is unassigned or still held by Housekeeping."
        >
          <QueryState
            isLoading={risk.isLoading}
            error={risk.error}
            isEmpty={riskRows.length === 0}
            empty={
              <EmptyState
                title="No arrival risk"
                description="Every arrival for this date has a room assigned and released for check-in."
              />
            }
          >
            <TableScroll>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Confirmation</TableHead>
                    <TableHead>Guest</TableHead>
                    <TableHead>Room</TableHead>
                    <TableHead>Room state</TableHead>
                    <TableHead>Reservation</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {riskRows.map((r) => {
                    const room = (r["rooms"] ?? {}) as FrontOfficeRow;
                    const assigned = Boolean(r["room_id"]);
                    return (
                      <TableRow key={String(r["id"])}>
                        <TableCell className="font-medium">
                          {str(r["confirmation_number"])}
                        </TableCell>
                        <TableCell>
                          {str((r["customers"] as FrontOfficeRow | null)?.["full_name"])}
                        </TableCell>
                        <TableCell>{assigned ? str(room["room_number"]) : "Unassigned"}</TableCell>
                        <TableCell>
                          <StatusPill tone={assigned ? "warning" : "destructive"}>
                            {assigned
                              ? titleCase(
                                  str(
                                    room["housekeeping_status"] ?? room["room_condition"],
                                    "not ready",
                                  ),
                                )
                              : "No room"}
                          </StatusPill>
                        </TableCell>
                        <TableCell>
                          {titleCase(str(r["status"], "confirmed").replace(/-/g, " "))}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableScroll>
          </QueryState>
        </SectionCard>

        <SectionCard
          title="Receptionist activity"
          description="Front Office actions for this date, grouped by the staff member who performed them."
        >
          <QueryState
            isLoading={activity.isLoading}
            error={activity.error}
            isEmpty={activityRows.length === 0}
            empty={
              <EmptyState
                title="No Front Office activity logged"
                description="Check-ins, check-outs and desk actions for this date will appear here attributed to each receptionist."
              />
            }
          >
            <TableScroll>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Staff member</TableHead>
                    <TableHead>Actions</TableHead>
                    <TableHead>Breakdown</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activityRows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">{row.name}</TableCell>
                      <TableCell>{row.total}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {Array.from(row.actions.entries())
                          .map(
                            ([action, count]) =>
                              `${titleCase(action.replace(/[._-]/g, " "))} ×${count}`,
                          )
                          .join(" · ")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableScroll>
          </QueryState>
        </SectionCard>
      </div>
    </div>
  );
}
