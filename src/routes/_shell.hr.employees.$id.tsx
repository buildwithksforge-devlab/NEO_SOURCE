import { useMemo, useState } from "react";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, CalendarPlus } from "lucide-react";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import { EmptyState, HrBadge, HrGuard, QueryState, SensitiveBlock } from "@/components/hr/HrShared";
import { ExitClearancePanel } from "@/components/hr/ExitClearancePanel";
import { EmployeeReadinessCard } from "@/components/hr/EmployeeReadiness";
import { StaffPhotoCard } from "@/components/hr/StaffPhotoCard";
import { EmployeeDocumentsPanel } from "@/components/hr/EmployeeDocumentsPanel";
import { EmployeeTimeline } from "@/components/hr/EmployeeTimeline";
import { LeaveApplyDialog } from "@/components/hr/LeaveApplyDialog";
import { EmployeePayCard } from "@/components/hr/EmployeePayCard";
import { PayrollSetupCard } from "@/components/hr/PayrollSetupCard";
import { EmploymentTermsCard } from "@/components/hr/EmploymentTermsCard";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  useEmployee,
  useEmployeeChildren,
  useEmployeeIdentifiers,
  useEmploymentHistory,
  useHrList,
  useLeaveBalances,
  useLeaveRequests,
  usePerformanceReviews,
  useRosterAssignments,
  useTrainingParticipants,
  useAttendance,
} from "@/lib/hr-data";
import { availableDays, useEntitlementsUpToDate } from "@/lib/hr-leave";
import { buildEmployeeTimeline } from "@/lib/hr-timeline";
import {
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_TYPES,
  HR_MODULES,
  LEAVE_STATUSES,
  clockTime,
  hoursFromMinutes,
  labelFor,
  shortDate,
  titleCase,
  today,
  toneFor,
  type Row,
} from "@/lib/hr";

export const Route = createFileRoute("/_shell/hr/employees/$id")({
  head: () => ({
    meta: [
      { title: "Employee 360° Record — HOS Human Resources" },
      {
        name: "description",
        content:
          "One employee record: employment, documents, recruitment, leave, attendance, pay, conduct, assets, exit and timeline.",
      },
      { property: "og:title", content: "Employee 360° Record — HOS Human Resources" },
      {
        property: "og:description",
        content:
          "One employee record: employment, documents, recruitment, leave, attendance, pay, conduct, assets, exit and timeline.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <HrGuard module={HR_MODULES.employees} action="directory.view">
      <EmployeeProfile />
    </HrGuard>
  ),
});

function EmployeeProfile() {
  const { id } = useParams({ from: "/_shell/hr/employees/$id" });
  const { can } = useAuth();
  const [applying, setApplying] = useState(false);

  const employee = useEmployee(id);
  const identifiers = useEmployeeIdentifiers(id);
  const contacts = useEmployeeChildren("employee_emergency_contacts", id);
  const certifications = useEmployeeChildren("employee_certifications", id);
  const assets = useEmployeeChildren("employee_assets", id);
  const documents = useEmployeeChildren("employee_documents", id);
  const cases = useEmployeeChildren("disciplinary_cases", id);
  const clearances = useEmployeeChildren("employee_exit_clearances", id);
  const payroll = useEmployeeChildren(
    "payroll_input_records",
    id,
    "*, payroll_periods(name, period_end)",
  );
  const history = useEmploymentHistory(id);
  const balances = useLeaveBalances(id);
  const leaveRequests = useLeaveRequests(id);
  const reviews = usePerformanceReviews(id);
  const training = useTrainingParticipants(undefined, id);
  const roster = useRosterAssignments(undefined, id);
  const attendance = useAttendance(
    { from: new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10), to: today() },
    id,
  );

  const e = employee.data;
  const candidateId = (e?.["candidate_id"] as string | null) ?? null;

  // The recruitment file follows the person into employment.
  const candidates = useHrList(
    "candidates",
    "*, vacancies(job_title, department_id)",
    (q) => q.or(`converted_employee_id.eq.${id}${candidateId ? `,id.eq.${candidateId}` : ""}`),
    [id, candidateId ?? "none"],
    Boolean(id),
  );
  const candidateIds = (candidates.data ?? []).map((c) => String(c["id"]));
  const interviews = useHrList(
    "interviews",
    "*",
    (q) => q.in("candidate_id", candidateIds).order("scheduled_at", { ascending: false }),
    [candidateIds.join(",")],
    candidateIds.length > 0,
  );
  const offers = useHrList(
    "employment_offers",
    "*",
    (q) => q.in("candidate_id", candidateIds).order("created_at", { ascending: false }),
    [candidateIds.join(",")],
    candidateIds.length > 0,
  );

  useEntitlementsUpToDate(id, Boolean(id));

  const timeline = useMemo(
    () =>
      buildEmployeeTimeline({
        employee: e ?? null,
        history: history.data ?? [],
        leave: leaveRequests.data ?? [],
        documents: documents.data ?? [],
        training: training.data ?? [],
        reviews: reviews.data ?? [],
        cases: cases.data ?? [],
        assets: assets.data ?? [],
        clearances: clearances.data ?? [],
        candidate: (candidates.data ?? [])[0] ?? null,
        attendance: attendance.data ?? [],
        shifts: roster.data ?? [],
      }),
    [
      e,
      history.data,
      leaveRequests.data,
      documents.data,
      training.data,
      reviews.data,
      cases.data,
      assets.data,
      clearances.data,
      candidates.data,
      attendance.data,
      roster.data,
    ],
  );

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link to="/hr/employees">
          <ArrowLeft className="mr-2 size-4" />
          Back to directory
        </Link>
      </Button>

      <QueryState
        isLoading={employee.isLoading}
        error={employee.error}
        isEmpty={!e}
        empty={
          <EmptyState
            title="Record not available"
            description="This employee record does not exist or you may not view it."
          />
        }
      >
        {e ? (
          <>
            <PageHeader
              eyebrow={`Employee ${String(e["employee_number"])}`}
              title={String(e["full_name"])}
              description={[
                String(e["job_title"] || "No job title"),
                String((e["departments"] as Row | null)?.["name"] ?? "Unassigned department"),
                String((e["branches"] as Row | null)?.["name"] ?? "No property"),
                labelFor(EMPLOYMENT_TYPES, e["employment_type"]),
              ].join(" · ")}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <HrBadge
                    value={labelFor(EMPLOYMENT_STATUSES, e["employment_status"])}
                    tone={toneFor(EMPLOYMENT_STATUSES, e["employment_status"])}
                  />
                  {can(HR_MODULES.leave, "approve") ? (
                    <Button size="sm" variant="outline" onClick={() => setApplying(true)}>
                      <CalendarPlus className="mr-2 size-4" aria-hidden />
                      Record leave request
                    </Button>
                  ) : null}
                </div>
              }
            />

            <Tabs defaultValue="overview">
              <TabsList className="flex flex-wrap">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="documents">Documents</TabsTrigger>
                <TabsTrigger value="recruitment">Recruitment</TabsTrigger>
                <TabsTrigger value="leave">Leave</TabsTrigger>
                <TabsTrigger value="attendance">Attendance & shifts</TabsTrigger>
                <TabsTrigger value="pay">Pay</TabsTrigger>
                <TabsTrigger value="growth">Performance & training</TabsTrigger>
                <TabsTrigger value="conduct">Conduct</TabsTrigger>
                <TabsTrigger value="assets">Assets</TabsTrigger>
                <TabsTrigger value="exit">Exit</TabsTrigger>
                <TabsTrigger value="timeline">Timeline</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="mt-4 space-y-4">
                <EmployeeReadinessCard employee={e} />
                <StaffPhotoCard
                  employeeId={id}
                  profileId={(e["profile_id"] as string | null) ?? null}
                  fullName={String(e["full_name"])}
                  avatarPath={(e["avatar_url"] as string | null) ?? null}
                  phone={(e["phone"] as string | null) ?? null}
                />
                <EmploymentTermsCard employee={e} />
                <SectionCard title="Personal & employment information">
                  <DetailGrid
                    items={[
                      ["Preferred name", String(e["preferred_name"] || "—")],
                      ["Phone", String(e["phone"] || "—")],
                      ["Personal email", String(e["personal_email"] || "—")],
                      ["Work email", String(e["work_email"] || "—")],
                      ["Department", String((e["departments"] as Row | null)?.["name"] ?? "—")],
                      ["Job title", String(e["job_title"] || "—")],
                      ["Station", String((e["stations"] as Row | null)?.["name"] ?? "—")],
                      ["Property", String((e["branches"] as Row | null)?.["name"] ?? "—")],
                      [
                        "Reporting manager",
                        String((e["reporting_manager"] as Row | null)?.["full_name"] ?? "—"),
                      ],
                      ["Employment type", labelFor(EMPLOYMENT_TYPES, e["employment_type"])],
                      ["Employment status", labelFor(EMPLOYMENT_STATUSES, e["employment_status"])],
                      ["Date joined", shortDate(e["employment_date"])],
                      ["Probation starts", shortDate(e["probation_start_date"])],
                      ["Probation ends", shortDate(e["probation_end_date"])],
                      ["Contract start", shortDate(e["contract_start"])],
                      ["Contract expiry", shortDate(e["contract_end"])],
                      [
                        "System access",
                        e["profile_id"] ? "Linked login account" : "No login account",
                      ],
                      ["Payroll readiness", titleCase(e["payroll_status"])],
                    ]}
                  />
                </SectionCard>
                <SectionCard title="Emergency contacts">
                  <SimpleTable
                    query={contacts}
                    columns={["Name", "Relationship", "Phone", "Next of kin"]}
                    render={(c) => [
                      String(c["contact_name"]),
                      String(c["relationship"] || "—"),
                      String(c["phone"] || "—"),
                      c["is_next_of_kin"] ? "Yes" : "No",
                    ]}
                    emptyTitle="No emergency contacts recorded"
                  />
                </SectionCard>
                <SectionCard
                  title="Statutory & banking identifiers"
                  description="Restricted personal data."
                >
                  <SensitiveBlock
                    module={HR_MODULES.employees}
                    action="statutory.view"
                    label="Statutory information"
                  >
                    <DetailGrid
                      items={[
                        ["National ID", String(identifiers.data?.["national_id"] || "—")],
                        ["Passport", String(identifiers.data?.["passport_number"] || "—")],
                        ["Tax PIN", String(identifiers.data?.["tax_pin"] || "—")],
                        [
                          "Social security",
                          String(identifiers.data?.["social_security_number"] || "—"),
                        ],
                        [
                          "Health insurance",
                          String(identifiers.data?.["health_insurance_number"] || "—"),
                        ],
                        ["Bank", String(identifiers.data?.["bank_name"] || "—")],
                      ]}
                    />
                  </SensitiveBlock>
                </SectionCard>
                <SectionCard
                  title="Employment history"
                  description="Every promotion, transfer and status change with its effective date."
                >
                  <SimpleTable
                    query={history}
                    columns={["Change", "Effective", "Reason"]}
                    render={(h) => [
                      titleCase(h["change_type"]),
                      shortDate(h["effective_date"]),
                      String(h["reason"] || "—"),
                    ]}
                    emptyTitle="No recorded changes"
                  />
                </SectionCard>
              </TabsContent>

              <TabsContent value="documents" className="mt-4 space-y-4">
                <EmployeeDocumentsPanel employee={e} />
                <SectionCard
                  title="Certifications"
                  description="Licences and certificates with renewal dates."
                >
                  <SimpleTable
                    query={certifications}
                    columns={["Certificate", "Issuer", "Expiry", "Verification"]}
                    render={(c) => [
                      String(c["certificate_name"]),
                      String(c["issuing_body"] || "—"),
                      shortDate(c["expiry_date"]),
                      titleCase(c["verification_status"]),
                    ]}
                    emptyTitle="No certifications recorded"
                  />
                </SectionCard>
              </TabsContent>

              <TabsContent value="recruitment" className="mt-4 space-y-4">
                <SectionCard
                  title="Applications"
                  description="The recruitment file follows the person: every position applied for, with the CV submitted at the time."
                >
                  <SimpleTable
                    query={candidates}
                    columns={["Position", "Applied", "Status", "Score", "CV"]}
                    render={(c) => [
                      String((c["vacancies"] as Row | null)?.["job_title"] ?? "—"),
                      shortDate(c["created_at"]),
                      titleCase(c["status"]),
                      c["interview_score"] == null ? "—" : String(c["interview_score"]),
                      c["cv_path"] ? "On file" : "—",
                    ]}
                    emptyTitle="No recruitment record linked"
                  />
                </SectionCard>
                <SectionCard title="Interviews">
                  <SimpleTable
                    query={interviews}
                    columns={["Scheduled", "Type", "Panel", "Recommendation", "Notes"]}
                    render={(i) => [
                      shortDate(i["scheduled_at"]),
                      titleCase(i["interview_type"]),
                      String((i["panel_profile_ids"] as unknown[] | null)?.length ?? 0),
                      titleCase(i["recommendation"] ?? "—"),
                      String(i["notes"] ?? "—"),
                    ]}
                    emptyTitle="No interviews recorded"
                  />
                </SectionCard>
                <SectionCard title="Offers">
                  <SimpleTable
                    query={offers}
                    columns={["Position", "Issued", "Approval", "Acceptance", "Proposed start"]}
                    render={(o) => [
                      String(o["job_title"] ?? "—"),
                      shortDate(o["created_at"]),
                      titleCase(o["approval_status"]),
                      titleCase(o["acceptance_status"]),
                      shortDate(o["proposed_start_date"]),
                    ]}
                    emptyTitle="No offer recorded"
                  />
                </SectionCard>
              </TabsContent>

              <TabsContent value="leave" className="mt-4 space-y-4">
                <SectionCard
                  title="Leave balances"
                  description={`Calculated for ${new Date().getFullYear()} from the company leave policies and the joining date.`}
                >
                  <SimpleTable
                    query={balances}
                    columns={[
                      "Leave type",
                      "Entitlement",
                      "Accrued",
                      "Carried",
                      "Used",
                      "Pending",
                      "Expired",
                      "Available",
                    ]}
                    render={(b) => [
                      String((b["leave_types"] as Row | null)?.["name"] ?? "—"),
                      String(Number(b["entitlement_days"] ?? 0)),
                      String(Number(b["accrued_days"] ?? 0)),
                      String(Number(b["carried_forward_days"] ?? 0)),
                      String(Number(b["taken_days"] ?? 0)),
                      String(Number(b["pending_days"] ?? 0)),
                      String(Number(b["expired_days"] ?? 0)),
                      String(availableDays(b)),
                    ]}
                    emptyTitle="No leave balances yet"
                  />
                </SectionCard>
                <SectionCard
                  title="Leave history"
                  description="Every request with its dates, days, status and approver."
                >
                  <SimpleTable
                    query={leaveRequests}
                    columns={["Type", "From", "To", "Days", "Status", "Decision"]}
                    render={(r) => [
                      String((r["leave_types"] as Row | null)?.["name"] ?? "—"),
                      shortDate(r["start_date"]),
                      shortDate(r["end_date"]),
                      String(Number(r["days"] ?? 0)),
                      labelFor(LEAVE_STATUSES, r["status"]),
                      String(r["decision_notes"] ?? r["return_comment"] ?? "—"),
                    ]}
                    emptyTitle="No leave requests"
                  />
                </SectionCard>
              </TabsContent>

              <TabsContent value="attendance" className="mt-4 space-y-4">
                <AttendanceKpis attendance={attendance.data ?? []} roster={roster.data ?? []} />
                <SectionCard title="Recent attendance" description="The last 30 days.">

                  <SimpleTable
                    query={attendance}
                    columns={["Date", "In", "Out", "Worked", "Status"]}
                    render={(a) => [
                      shortDate(a["work_date"]),
                      clockTime(a["clock_in_at"]),
                      clockTime(a["clock_out_at"]),
                      hoursFromMinutes(a["worked_minutes"]),
                      titleCase(a["status"]),
                    ]}
                    emptyTitle="No attendance recorded"
                  />
                </SectionCard>
                <SectionCard title="Shifts & off days">
                  <SimpleTable
                    query={roster}
                    columns={["Date", "Shift", "Status"]}
                    render={(s) => [
                      shortDate(s["shift_date"]),
                      String(s["role_hint"] ?? "—"),
                      titleCase(s["status"]),
                    ]}
                    emptyTitle="No shifts assigned"
                  />
                </SectionCard>
              </TabsContent>

              <TabsContent value="pay" className="mt-4 space-y-4">
                <SensitiveBlock
                  module={HR_MODULES.payroll}
                  action="view"
                  label="Pay information"
                >
                  <EmployeePayCard
                    employeeId={id}
                    branchId={(e?.["branch_id"] as string | null) ?? null}
                  />
                  {e ? (
                    <PayrollSetupCard
                      employee={e}
                      branchId={(e["branch_id"] as string | null) ?? null}
                    />
                  ) : null}
                </SensitiveBlock>
                <SectionCard

                  title="Payroll inputs"
                  description="Read-only. Amounts come from the payroll period they were computed in."
                >
                  <SensitiveBlock
                    module={HR_MODULES.payroll}
                    action="view"
                    label="Payroll information"
                  >
                    <SimpleTable
                      query={payroll}
                      columns={[
                        "Period",
                        "Days worked",
                        "Overtime hours",
                        "Paid leave",
                        "Unpaid leave",
                        "Allowances",
                        "Deductions",
                      ]}
                      render={(p) => [
                        String((p["payroll_periods"] as Row | null)?.["name"] ?? "—"),
                        String(p["worked_days"] ?? "—"),
                        String(p["overtime_hours"] ?? "—"),
                        String(p["paid_leave_days"] ?? "—"),
                        String(p["unpaid_leave_days"] ?? "—"),
                        String(p["allowances"] ?? "—"),
                        String(p["deductions"] ?? "—"),
                      ]}
                      emptyTitle="No payroll inputs recorded"
                    />
                  </SensitiveBlock>
                </SectionCard>
              </TabsContent>

              <TabsContent value="growth" className="mt-4 space-y-4">
                <SectionCard
                  title="Performance reviews"
                  description="Only released reviews are visible to the employee."
                >
                  <SimpleTable
                    query={reviews}
                    columns={["Cycle", "Type", "Due", "Rating", "Status"]}
                    render={(r) => [
                      String((r["performance_cycles"] as Row | null)?.["name"] ?? "—"),
                      titleCase(r["review_type"]),
                      shortDate(r["due_date"]),
                      r["final_rating"] == null ? "—" : String(r["final_rating"]),
                      titleCase(r["status"]),
                    ]}
                    emptyTitle="No reviews recorded"
                  />
                </SectionCard>
                <SectionCard title="Training record">
                  <SimpleTable
                    query={training}
                    columns={["Course", "Attendance", "Completion", "Score"]}
                    render={(t) => [
                      String(
                        (
                          (t["training_sessions"] as Row | null)?.["training_courses"] as Row | null
                        )?.["name"] ?? "—",
                      ),
                      titleCase(t["attendance_status"]),
                      titleCase(t["completion_status"]),
                      t["score"] == null ? "—" : String(t["score"]),
                    ]}
                    emptyTitle="No training assigned"
                  />
                </SectionCard>
              </TabsContent>

              <TabsContent value="conduct" className="mt-4">
                <SectionCard
                  title="Disciplinary, warnings & grievances"
                  description="Confidential conduct record."
                >
                  <SensitiveBlock
                    module={HR_MODULES.employees}
                    action="statutory.view"
                    label="Conduct record"
                  >
                    <SimpleTable
                      query={cases}
                      columns={["Case", "Incident", "Status", "Decision", "Action"]}
                      render={(c) => [
                        String(c["case_number"] ?? titleCase(c["case_type"])),
                        shortDate(c["incident_date"]),
                        titleCase(c["status"]),
                        titleCase(c["decision"] ?? "—"),
                        String(c["action_taken"] ?? "—"),
                      ]}
                      emptyTitle="No conduct records"
                    />
                  </SensitiveBlock>
                </SectionCard>
              </TabsContent>

              <TabsContent value="assets" className="mt-4">
                <SectionCard
                  title="Issued items"
                  description="Uniforms, keys, devices and other property issued to this employee."
                >
                  <SimpleTable
                    query={assets}
                    columns={["Item", "Issued", "Return due", "Status"]}
                    render={(a) => [
                      String(a["item_name"]),
                      shortDate(a["issue_date"]),
                      shortDate(a["expected_return_date"]),
                      titleCase(a["status"]),
                    ]}
                    emptyTitle="Nothing issued"
                  />
                </SectionCard>
              </TabsContent>

              <TabsContent value="exit" className="mt-4">
                <SectionCard
                  title="Separation & clearance"
                  description="Exit type, last working day and the clearance checklist."
                >
                  <ExitClearancePanel query={clearances} />
                </SectionCard>
              </TabsContent>

              <TabsContent value="timeline" className="mt-4">
                <SectionCard
                  title="Employee timeline"
                  description="Assembled from the records themselves, newest first."
                >
                  <EmployeeTimeline events={timeline} />
                </SectionCard>
              </TabsContent>
            </Tabs>

            <LeaveApplyDialog open={applying} onOpenChange={setApplying} employee={e} />
          </>
        ) : null}
      </QueryState>
    </div>
  );
}

function DetailGrid({ items }: { items: [string, string][] }) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </dt>
          <dd className="mt-1 text-sm text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SimpleTable({
  query,
  columns,
  render,
  emptyTitle,
}: {
  query: { data: Row[] | undefined; isLoading: boolean; error: unknown };
  columns: string[];
  render: (row: Row) => string[];
  emptyTitle: string;
}) {
  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.error}
      isEmpty={(query.data ?? []).length === 0}
      empty={
        <EmptyState title={emptyTitle} description="Records appear here as they are captured." />
      }
    >
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead key={c}>{c}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(query.data ?? []).map((row) => (
              <TableRow key={String(row["id"])}>
                {render(row).map((cell, i) => (
                  <TableCell key={columns[i]} className={i === 0 ? "font-medium" : undefined}>
                    {cell}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </QueryState>
  );
}

/**
 * Working-pattern KPIs for the last 30 days, read from the attendance and
 * roster records already on screen — no target, score or figure is invented.
 */
function AttendanceKpis({ attendance, roster }: { attendance: Row[]; roster: Row[] }) {
  const workedMinutes = attendance.reduce((sum, a) => sum + Number(a["worked_minutes"] ?? 0), 0);
  const lateDays = attendance.filter((a) => Number(a["late_minutes"] ?? 0) > 0).length;
  const overtimeMinutes = attendance.reduce(
    (sum, a) => sum + Number(a["overtime_minutes"] ?? 0),
    0,
  );
  const upcoming = roster.filter(
    (s) => String(s["shift_date"] ?? "") >= today() && String(s["status"] ?? "") !== "cancelled",
  ).length;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard label="Days attended (30d)" value={String(attendance.length)} />
      <StatCard label="Hours worked (30d)" value={hoursFromMinutes(workedMinutes)} />
      <StatCard
        label="Late arrivals (30d)"
        value={String(lateDays)}
        tone={lateDays ? "warning" : "default"}
      />
      <StatCard
        label="Upcoming shifts"
        value={String(upcoming)}
        {...(overtimeMinutes ? { hint: `${hoursFromMinutes(overtimeMinutes)} overtime` } : {})}
      />
    </div>
  );
}
