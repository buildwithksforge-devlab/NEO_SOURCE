import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatCard, TableScroll } from "@/components/common/DataDisplay";
import { EmptyState, HrBadge, HrGuard, QueryState } from "@/components/hr/HrShared";
import {
  TrainingAssignDialog,
  TrainingCompletionDialog,
  TrainingCourseDialog,
  TrainingSessionDialog,
} from "@/components/hr/TrainingDialogs";
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
import { useAuth } from "@/lib/auth";
import {
  useCertifications,
  useTrainingCourses,
  useTrainingParticipants,
  useTrainingSessions,
} from "@/lib/hr-data";
import { HR_MODULES, shortDate, titleCase, type Row } from "@/lib/hr";

export const Route = createFileRoute("/_shell/hr/training")({
  head: () => ({
    meta: [
      { title: "Training & Certification — HOS Human Resources" },
      {
        name: "description",
        content: "Course catalogue, scheduled sessions and certification expiry tracking.",
      },
      { property: "og:title", content: "Training & Certification — HOS Human Resources" },
      {
        property: "og:description",
        content: "Course catalogue, scheduled sessions and certification expiry tracking.",
      },
    ],
  }),
  component: () => (
    <HrGuard module={HR_MODULES.training} action="view">
      <TrainingScreen />
    </HrGuard>
  ),
});

function TrainingScreen() {
  const courses = useTrainingCourses();
  const sessions = useTrainingSessions();
  const certs = useCertifications();
  const participants = useTrainingParticipants();
  const { can } = useAuth();
  const mayCreate = can(HR_MODULES.training, "create");
  const mayAssign = can(HR_MODULES.training, "assign");
  const mayRecord = can(HR_MODULES.training, "manage") || can(HR_MODULES.training, "edit");

  const [courseOpen, setCourseOpen] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [assignTo, setAssignTo] = useState<Row | null>(null);
  const [outcomeFor, setOutcomeFor] = useState<Row | null>(null);

  const expiringSoon = (certs.data ?? []).filter((c) => {
    if (!c["expiry_date"]) return false;
    const t = new Date(String(c["expiry_date"])).getTime();
    return t <= Date.now() + 60 * 86_400_000;
  });
  const completed = (participants.data ?? []).filter(
    (p) => p["completion_status"] === "completed",
  ).length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Human Resources"
        title="Training & Certification"
        description="Mandatory food safety, fire and service training with automatic visibility of expiring certificates."
        actions={
          mayCreate ? (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setCourseOpen(true)}>
                New course
              </Button>
              <Button onClick={() => setSessionOpen(true)}>Schedule session</Button>
            </div>
          ) : null
        }
      />

      <TrainingCourseDialog open={courseOpen} onOpenChange={setCourseOpen} />
      <TrainingSessionDialog open={sessionOpen} onOpenChange={setSessionOpen} />
      {assignTo ? (
        <TrainingAssignDialog
          open={Boolean(assignTo)}
          onOpenChange={(v) => !v && setAssignTo(null)}
          session={assignTo}
        />
      ) : null}
      {outcomeFor ? (
        <TrainingCompletionDialog
          open={Boolean(outcomeFor)}
          onOpenChange={(v) => !v && setOutcomeFor(null)}
          participant={outcomeFor}
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Courses" value={String((courses.data ?? []).length)} />
        <StatCard label="Sessions" value={String((sessions.data ?? []).length)} />
        <StatCard label="Completed by staff" value={String(completed)} tone="success" />
        <StatCard label="Expiring in 60 days" value={String(expiringSoon.length)} tone="warning" />
      </div>

      <Tabs defaultValue="sessions">
        <TabsList>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="attendees">Attendees</TabsTrigger>
          <TabsTrigger value="courses">Courses</TabsTrigger>
          <TabsTrigger value="certificates">Certificates</TabsTrigger>
        </TabsList>

        <TabsContent value="sessions" className="mt-4">
          <SectionCard title="Scheduled sessions">
            <QueryState
              isLoading={sessions.isLoading}
              error={sessions.error}
              isEmpty={(sessions.data ?? []).length === 0}
              empty={
                <EmptyState
                  title="No sessions scheduled"
                  description="Schedule a session against a course to assign attendees."
                />
              }
            >
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Course</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Trainer</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Attendees</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(sessions.data ?? []).map((s) => {
                      const booked = (participants.data ?? []).filter(
                        (p) => String(p["session_id"]) === String(s["id"]),
                      ).length;
                      return (
                        <TableRow key={String(s["id"])}>
                          <TableCell className="font-medium">
                            {(s["training_courses"] as Row | null)?.["name"] ?? "—"}
                          </TableCell>
                          <TableCell>{shortDate(s["session_date"])}</TableCell>
                          <TableCell>{String(s["trainer"] || "—")}</TableCell>
                          <TableCell>
                            <HrBadge value={s["status"]} tone="info" />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {booked} / {Number(s["capacity"] ?? 0)}
                          </TableCell>
                          <TableCell className="text-right">
                            {mayAssign ? (
                              <Button size="sm" variant="outline" onClick={() => setAssignTo(s)}>
                                Add attendee
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
        </TabsContent>

        <TabsContent value="attendees" className="mt-4">
          <SectionCard
            title="Attendees"
            description="Who is booked on which session, and what they achieved."
          >
            <QueryState
              isLoading={participants.isLoading}
              error={participants.error}
              isEmpty={(participants.data ?? []).length === 0}
              empty={
                <EmptyState
                  title="Nobody booked yet"
                  description="Add attendees to a scheduled session."
                />
              }
            >
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Employee</TableHead>
                      <TableHead>Course</TableHead>
                      <TableHead>Session</TableHead>
                      <TableHead>Attendance</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(participants.data ?? []).map((p) => {
                      const session = (p["training_sessions"] ?? null) as Row | null;
                      const course = (session?.["training_courses"] ?? null) as Row | null;
                      const done = p["completion_status"] === "completed";
                      return (
                        <TableRow key={String(p["id"])}>
                          <TableCell className="font-medium">
                            {(p["employees"] as Row | null)?.["full_name"] ?? "—"}
                          </TableCell>
                          <TableCell>{String(course?.["name"] ?? "—")}</TableCell>
                          <TableCell>{shortDate(session?.["session_date"])}</TableCell>
                          <TableCell>{titleCase(p["attendance_status"])}</TableCell>
                          <TableCell>
                            <HrBadge
                              value={p["completion_status"]}
                              tone={done ? "success" : "warning"}
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            {mayRecord ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setOutcomeFor(p)}
                              >
                                {done ? "Amend" : "Record outcome"}
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
        </TabsContent>

        <TabsContent value="courses" className="mt-4">
          <SectionCard title="Course catalogue">
            <QueryState
              isLoading={courses.isLoading}
              error={courses.error}
              isEmpty={(courses.data ?? []).length === 0}
              empty={
                <EmptyState
                  title="No courses"
                  description="Add induction, safety and service courses."
                />
              }
            >
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Course</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Mandatory</TableHead>
                      <TableHead className="text-right">Valid (months)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(courses.data ?? []).map((c) => (
                      <TableRow key={String(c["id"])}>
                        <TableCell className="font-medium">{String(c["name"])}</TableCell>
                        <TableCell>{titleCase(c["training_type"])}</TableCell>
                        <TableCell>{c["mandatory"] ? "Yes" : "No"}</TableCell>
                        <TableCell className="text-right">
                          {Number(c["validity_months"] ?? 0)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </QueryState>
          </SectionCard>
        </TabsContent>

        <TabsContent value="certificates" className="mt-4">
          <SectionCard
            title="Certificates"
            description="Sorted by the earliest expiry so renewals never lapse silently."
          >
            <QueryState
              isLoading={certs.isLoading}
              error={certs.error}
              isEmpty={(certs.data ?? []).length === 0}
              empty={
                <EmptyState
                  title="No certificates recorded"
                  description="Add certificates on the employee record."
                />
              }
            >
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Employee</TableHead>
                      <TableHead>Certificate</TableHead>
                      <TableHead>Expiry</TableHead>
                      <TableHead>Verification</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(certs.data ?? []).map((c) => (
                      <TableRow key={String(c["id"])}>
                        <TableCell className="font-medium">
                          {(c["employees"] as Row | null)?.["full_name"] ?? "—"}
                        </TableCell>
                        <TableCell>{String(c["certificate_name"])}</TableCell>
                        <TableCell>{shortDate(c["expiry_date"])}</TableCell>
                        <TableCell>
                          <HrBadge
                            value={c["verification_status"]}
                            tone={c["verification_status"] === "verified" ? "success" : "warning"}
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
    </div>
  );
}
