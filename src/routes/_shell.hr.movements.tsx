import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowRightLeft } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { EmptyState, QueryState } from "@/components/pms/PmsShared";
import { OpsGuard } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/operations";
import { useBranchesLookup, useDepartmentsLookup, useEmployees } from "@/lib/hr-data";
import { usePositionGrades } from "@/lib/hr-terms";
import {
  MOVEMENT_TYPES,
  str,
  useEmploymentHistory,
  useRecordEmploymentMovement,
  type HrRow,
} from "@/lib/hr-department";

export const Route = createFileRoute("/_shell/hr/movements")({
  head: () => ({
    meta: [
      { title: "Employment Movements — NEØ" },
      {
        name: "description",
        content:
          "Promotions, transfers, role changes and confirmations recorded as employment history rather than silent edits.",
      },
      { property: "og:title", content: "Employment Movements — NEØ" },
      {
        property: "og:description",
        content:
          "Every promotion, transfer and role change writes a dated entry to the employee's official history.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="human-resources" action="employees.view">
      <HrMovementsPage />
    </OpsGuard>
  ),
});

function HrMovementsPage() {
  const { can } = useAuth();
  const mayRecord = can("human-resources", "employees.edit");

  const employees = useEmployees({ status: "active" });
  const departments = useDepartmentsLookup();
  const branches = useBranchesLookup();
  const grades = usePositionGrades();
  const history = useEmploymentHistory(null);
  const record = useRecordEmploymentMovement();

  const [employeeId, setEmployeeId] = useState("");
  const [changeType, setChangeType] = useState<string>(MOVEMENT_TYPES[0].key);
  const [effectiveDate, setEffectiveDate] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [positionGrade, setPositionGrade] = useState("");
  const [reason, setReason] = useState("");

  const reset = () => {
    setJobTitle("");
    setDepartmentId("");
    setBranchId("");
    setPositionGrade("");
    setReason("");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Human Resources"
        title="Employment movements"
        description="Promotions, transfers, role changes and confirmations. HR records the employment change; system permissions are still granted separately by System Administration."
      />

      {mayRecord ? (
        <SectionCard
          title="Record a movement"
          description="Leave a field blank to keep the employee's current value."
        >
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="mv-employee">Employee</Label>
              <select
                id="mv-employee"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
              >
                <option value="">Select employee…</option>
                {((employees.data ?? []) as HrRow[]).map((emp) => (
                  <option key={String(emp["id"])} value={String(emp["id"])}>
                    {str(emp["full_name"])} — {str(emp["job_title"], "no title")}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mv-type">Movement</Label>
              <select
                id="mv-type"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={changeType}
                onChange={(e) => setChangeType(e.target.value)}
              >
                {MOVEMENT_TYPES.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mv-date">Effective date</Label>
              <NeoDatePicker id="mv-date" value={effectiveDate} onChange={setEffectiveDate} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mv-title">New job title</Label>
              <Input
                id="mv-title"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                placeholder="Unchanged"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mv-dept">New department</Label>
              <select
                id="mv-dept"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}
              >
                <option value="">Unchanged</option>
                {((departments.data ?? []) as HrRow[]).map((d) => (
                  <option key={String(d["id"])} value={String(d["id"])}>
                    {str(d["name"])}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mv-branch">New property</Label>
              <select
                id="mv-branch"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
              >
                <option value="">Unchanged</option>
                {((branches.data ?? []) as HrRow[]).map((b) => (
                  <option key={String(b["id"])} value={String(b["id"])}>
                    {str(b["name"])}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mv-grade">New position grade</Label>
              <select
                id="mv-grade"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={positionGrade}
                onChange={(e) => setPositionGrade(e.target.value)}
              >
                <option value="">Unchanged</option>
                {((grades.data ?? []) as HrRow[]).map((g) => (
                  <option key={String(g["id"])} value={String(g["code"])}>
                    {str(g["code"])} — {str(g["name"])}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                The previous grade is kept in the employee's history, never overwritten silently.
              </p>
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="mv-reason">Reason</Label>
              <Textarea
                id="mv-reason"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why this movement was approved"
              />
            </div>
            <div className="flex items-end">
              <Button
                className="w-full"
                disabled={!employeeId || record.isPending}
                onClick={() =>
                  record.mutate(
                    {
                      employeeId,
                      changeType,
                      effectiveDate,
                      reason,
                      jobTitle,
                      departmentId,
                      branchId,
                      positionGrade,
                    },
                    { onSuccess: reset },
                  )
                }
              >
                Record movement
              </Button>
            </div>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Employment history"
        description="Most recent movements across the workforce."
      >
        <QueryState
          isLoading={history.isLoading}
          error={history.error}
          isEmpty={(history.data ?? []).length === 0}
          empty={
            <EmptyState
              title="No movements recorded"
              description="Promotions, transfers and role changes appear here once HR records them."
              icon={ArrowRightLeft}
            />
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Effective</TableHead>
                  <TableHead>Employee</TableHead>
                  <TableHead>Movement</TableHead>
                  <TableHead>Change</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {((history.data ?? []) as HrRow[]).map((row) => {
                  const emp = (row["employees"] ?? {}) as HrRow;
                  const prev = (row["previous_value"] ?? {}) as Record<string, unknown>;
                  const next = (row["new_value"] ?? {}) as Record<string, unknown>;
                  const changed = Object.keys(next).filter(
                    (k) => String(next[k] ?? "") !== String(prev[k] ?? ""),
                  );
                  return (
                    <TableRow key={String(row["id"])}>
                      <TableCell>{str(row["effective_date"])}</TableCell>
                      <TableCell className="font-medium">
                        {str(emp["full_name"])}
                        <span className="block text-xs text-muted-foreground">
                          {str(emp["employee_number"], "")}
                        </span>
                      </TableCell>
                      <TableCell>
                        <StatusPill tone="info">
                          {titleCase(str(row["change_type"], "change"))}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {changed.length === 0
                          ? "No field change"
                          : changed
                              .map(
                                (k) =>
                                  `${titleCase(k)}: ${str(prev[k], "—")} → ${str(next[k], "—")}`,
                              )
                              .join(" · ")}
                      </TableCell>
                      <TableCell className="max-w-[18rem] text-sm text-muted-foreground">
                        {str(row["reason"])}
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
