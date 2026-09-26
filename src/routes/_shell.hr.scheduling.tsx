import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { DocumentPrintButton } from "@/components/common/DocumentPrintButton";
import { PageHeader, SectionCard, StatCard, TableScroll } from "@/components/common/DataDisplay";
import { EmptyState, HrBadge, HrGuard, QueryState } from "@/components/hr/HrShared";
import {
  RosterCreateDialog,
  ShiftAssignDialog,
  ShiftTemplateDialog,
} from "@/components/hr/RosterDialogs";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useHrWrite,
  useOvertimeRequests,
  useRosterAssignments,
  useRosters,
  useShiftTemplates,
  useSwapRequests,
} from "@/lib/hr-data";
import { useAuth } from "@/lib/auth";
import { HR_MODULES, shortDate, titleCase, type Row } from "@/lib/hr";

export const Route = createFileRoute("/_shell/hr/scheduling")({
  head: () => ({
    meta: [
      { title: "Scheduling & Rosters — HOS Human Resources" },
      {
        name: "description",
        content: "Shift templates, published rosters, swap requests and overtime approvals.",
      },
      { property: "og:title", content: "Scheduling & Rosters — HOS Human Resources" },
      {
        property: "og:description",
        content: "Shift templates, published rosters, swap requests and overtime approvals.",
      },
    ],
  }),
  component: () => (
    <HrGuard module={HR_MODULES.scheduling} action="self.view">
      <SchedulingScreen />
    </HrGuard>
  ),
});

function SchedulingScreen() {
  const { can } = useAuth();
  const rosters = useRosters();
  const [createOpen, setCreateOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const rosterStatus = useHrWrite("rosters", { action: "hr.roster.published" });
  const [assignRosterId, setAssignRosterId] = useState<string | null>(null);
  const [openRosterId, setOpenRosterId] = useState<string | null>(null);
  const canSchedule = can(HR_MODULES.scheduling, "roster.create");
  const templates = useShiftTemplates();
  const swaps = useSwapRequests();
  const overtime = useOvertimeRequests();
  const assignments = useRosterAssignments(openRosterId ?? undefined);
  const assignRoster =
    (rosters.data ?? []).find((r) => String(r["id"]) === assignRosterId) ?? null;
  const openRoster = (rosters.data ?? []).find((r) => String(r["id"]) === openRosterId) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Human Resources"
        title="Scheduling & Rosters"
        description="Rosters are drafted, approved and published. Staff only see a schedule once it is published."
        actions={
          canSchedule ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setTemplateOpen(true)}>
                New shift template
              </Button>
              <Button onClick={() => setCreateOpen(true)}>New roster</Button>
            </div>
          ) : undefined
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Rosters" value={String((rosters.data ?? []).length)} />
        <StatCard label="Shift templates" value={String((templates.data ?? []).length)} />
        <StatCard label="Swap requests" value={String((swaps.data ?? []).length)} tone="warning" />
        <StatCard
          label="Overtime requests"
          value={String((overtime.data ?? []).length)}
          tone="warning"
        />
      </div>

      <Tabs defaultValue="rosters">
        <TabsList>
          <TabsTrigger value="rosters">Rosters</TabsTrigger>
          <TabsTrigger value="templates">Shift templates</TabsTrigger>
          <TabsTrigger value="swaps">Swaps</TabsTrigger>
          <TabsTrigger value="overtime">Overtime</TabsTrigger>
        </TabsList>

        <TabsContent value="rosters" className="mt-4">
          <SectionCard title="Rosters">
            <QueryState
              isLoading={rosters.isLoading}
              error={rosters.error}
              isEmpty={(rosters.data ?? []).length === 0}
              empty={
                <EmptyState
                  title="No rosters yet"
                  description="Create a roster period for a department to begin scheduling."
                />
              }
            >
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Roster</TableHead>
                      <TableHead>Department</TableHead>
                      <TableHead>Period</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Schedule</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(rosters.data ?? []).map((r) => (
                      <TableRow key={String(r["id"])}>
                        <TableCell className="font-medium">{String(r["name"])}</TableCell>
                        <TableCell>{(r["departments"] as Row | null)?.["name"] ?? "—"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {shortDate(r["period_start"])} → {shortDate(r["period_end"])}
                        </TableCell>
                        <TableCell>
                          <HrBadge
                            value={r["status"]}
                            tone={r["status"] === "published" ? "success" : "warning"}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                setOpenRosterId((prev) =>
                                  prev === String(r["id"]) ? null : String(r["id"]),
                                )
                              }
                            >
                              {openRosterId === String(r["id"]) ? "Hide shifts" : "View shifts"}
                            </Button>
                            {canSchedule ? (
                              <Button size="sm" onClick={() => setAssignRosterId(String(r["id"]))}>
                                Assign shift
                              </Button>
                            ) : null}
                            {canSchedule && r["status"] !== "published" ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={rosterStatus.isPending}
                                onClick={() =>
                                  rosterStatus.mutate({
                                    id: String(r["id"]),
                                    values: {
                                      status: "published",
                                      published_at: new Date().toISOString(),
                                    },
                                  })
                                }
                              >
                                Publish
                              </Button>
                            ) : null}
                            <DocumentPrintButton
                              type="staff_schedule"
                              id={String(r["id"])}
                              label="Print schedule"
                            />
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </QueryState>
          </SectionCard>

          {openRoster ? (
            <SectionCard
              title={`Shifts — ${String(openRoster["name"])}`}
              description="Every assigned shift also appears on the employee's own profile timeline."
              className="mt-4"
            >
              <QueryState
                isLoading={assignments.isLoading}
                error={assignments.error}
                isEmpty={(assignments.data ?? []).length === 0}
                empty={
                  <EmptyState
                    title="No shifts assigned yet"
                    description="Use Assign shift to place staff on this roster."
                  />
                }
              >
                <TableScroll>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Employee</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Shift</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(assignments.data ?? []).map((a) => (
                        <TableRow key={String(a["id"])}>
                          <TableCell className="font-medium">
                            {(a["employees"] as Row | null)?.["full_name"] ?? "Open shift"}
                          </TableCell>
                          <TableCell>{shortDate(a["shift_date"])}</TableCell>
                          <TableCell>
                            {(a["shift_templates"] as Row | null)?.["name"] ?? "—"}
                          </TableCell>
                          <TableCell>
                            <HrBadge
                              value={a["status"]}
                              tone={a["status"] === "cancelled" ? "destructive" : "info"}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableScroll>
              </QueryState>
            </SectionCard>
          ) : null}
        </TabsContent>

        <TabsContent value="templates" className="mt-4">
          <SectionCard
            title="Shift templates"
            description="Reusable shift patterns with grace periods and minimum staffing."
          >
            <QueryState
              isLoading={templates.isLoading}
              error={templates.error}
              isEmpty={(templates.data ?? []).length === 0}
              empty={
                <EmptyState
                  title="No shift templates"
                  description="Define morning, afternoon and night shifts per department."
                />
              }
            >
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Template</TableHead>
                      <TableHead>Department</TableHead>
                      <TableHead>Hours</TableHead>
                      <TableHead className="text-right">Min staff</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(templates.data ?? []).map((t) => (
                      <TableRow key={String(t["id"])}>
                        <TableCell className="font-medium">{String(t["name"])}</TableCell>
                        <TableCell>{(t["departments"] as Row | null)?.["name"] ?? "—"}</TableCell>
                        <TableCell>
                          {String(t["start_time"])} – {String(t["end_time"])}
                        </TableCell>
                        <TableCell className="text-right">{Number(t["min_staff"] ?? 0)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </QueryState>
          </SectionCard>
        </TabsContent>

        <TabsContent value="swaps" className="mt-4">
          <SectionCard
            title="Shift swap requests"
            description="A swap needs the colleague's acceptance and a supervisor's approval."
          >
            <QueryState
              isLoading={swaps.isLoading}
              error={swaps.error}
              isEmpty={(swaps.data ?? []).length === 0}
              empty={
                <EmptyState
                  title="No swap requests"
                  description="Requests raised by staff appear here."
                />
              }
            >
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Requester</TableHead>
                      <TableHead>Target</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(swaps.data ?? []).map((s) => (
                      <TableRow key={String(s["id"])}>
                        <TableCell className="font-medium">
                          {(s["requester"] as Row | null)?.["full_name"] ?? "—"}
                        </TableCell>
                        <TableCell>
                          {(s["target"] as Row | null)?.["full_name"] ?? "Open"}
                        </TableCell>
                        <TableCell>{titleCase(s["swap_type"])}</TableCell>
                        <TableCell>
                          <HrBadge value={s["status"]} tone="warning" />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </QueryState>
          </SectionCard>
        </TabsContent>

        <TabsContent value="overtime" className="mt-4">
          <SectionCard
            title="Overtime"
            description="Overtime must be approved before it reaches payroll inputs."
          >
            <QueryState
              isLoading={overtime.isLoading}
              error={overtime.error}
              isEmpty={(overtime.data ?? []).length === 0}
              empty={
                <EmptyState
                  title="No overtime recorded"
                  description="Planned and emergency overtime appears here."
                />
              }
            >
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Employee</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Hours</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(overtime.data ?? []).map((o) => (
                      <TableRow key={String(o["id"])}>
                        <TableCell className="font-medium">
                          {(o["employees"] as Row | null)?.["full_name"] ?? "—"}
                        </TableCell>
                        <TableCell>{shortDate(o["overtime_date"])}</TableCell>
                        <TableCell className="text-right">{Number(o["hours"] ?? 0)}</TableCell>
                        <TableCell>
                          <HrBadge
                            value={o["status"]}
                            tone={o["status"] === "approved" ? "success" : "warning"}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </QueryState>
          </SectionCard>
        </TabsContent>
      </Tabs>

      <RosterCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ShiftTemplateDialog open={templateOpen} onOpenChange={setTemplateOpen} />
      {assignRoster ? (
        <ShiftAssignDialog
          open={Boolean(assignRoster)}
          onOpenChange={(v) => !v && setAssignRosterId(null)}
          roster={assignRoster}
          existing={assignments.data ?? []}
        />
      ) : null}
    </div>
  );
}
