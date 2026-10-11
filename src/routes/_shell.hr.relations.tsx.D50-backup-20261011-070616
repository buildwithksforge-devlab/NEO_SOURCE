import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { EmptyState, QueryState } from "@/components/pms/PmsShared";
import { OpsGuard } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { titleCase } from "@/lib/operations";
import { useEmployees } from "@/lib/hr-data";
import { str, useHrCases, useOpenHrCase, useReviewHrCase, type HrRow } from "@/lib/hr-department";

export const Route = createFileRoute("/_shell/hr/relations")({
  head: () => ({
    meta: [
      { title: "Employee Relations — NEØ" },
      {
        name: "description",
        content:
          "Confidential disciplinary and grievance cases handled by HR with a dated, auditable outcome trail.",
      },
      { property: "og:title", content: "Employee Relations — NEØ" },
      {
        property: "og:description",
        content:
          "Disciplinary and grievance handling restricted to HR, with recorded outcomes and no silent edits.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="human-resources" action="relations.view">
      <HrRelationsPage />
    </OpsGuard>
  ),
});

const STATUS_TONE: Record<string, "default" | "success" | "warning" | "info" | "destructive"> = {
  open: "warning",
  investigating: "info",
  "under-review": "info",
  resolved: "success",
  closed: "default",
  escalated: "destructive",
};

function CasePanel({ kind }: { kind: "disciplinary" | "grievance" }) {
  const { can } = useAuth();
  const mayManage = can("human-resources", "relations.manage");
  const cases = useHrCases(kind);
  const employees = useEmployees({ status: "active" });
  const openCase = useOpenHrCase();
  const review = useReviewHrCase();

  const [employeeId, setEmployeeId] = useState("");
  const [subject, setSubject] = useState("");
  const [details, setDetails] = useState("");
  const [incidentDate, setIncidentDate] = useState("");

  const noun = kind === "disciplinary" ? "disciplinary case" : "grievance";

  return (
    <div className="space-y-6">
      {mayManage ? (
        <SectionCard
          title={`Open a ${noun}`}
          description="Kept confidential to HR. Recording it starts the trail — outcomes are added as the case progresses."
        >
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${kind}-employee`}>
                {kind === "disciplinary" ? "Employee concerned" : "Employee raising it"}
              </Label>
              <select
                id={`${kind}-employee`}
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
              <Label htmlFor={`${kind}-date`}>Incident date</Label>
              <NeoDatePicker id={`${kind}-date`} value={incidentDate} onChange={setIncidentDate} />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor={`${kind}-subject`}>Subject</Label>
              <Input
                id={`${kind}-subject`}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Short summary"
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor={`${kind}-details`}>Details</Label>
              <Textarea
                id={`${kind}-details`}
                rows={3}
                value={details}
                onChange={(e) => setDetails(e.target.value)}
              />
            </div>
          </div>
          <Button
            className="mt-3"
            disabled={!employeeId || !subject.trim() || openCase.isPending}
            onClick={() =>
              openCase.mutate(
                { kind, employeeId, subject, details, incidentDate },
                {
                  onSuccess: () => {
                    setSubject("");
                    setDetails("");
                    setIncidentDate("");
                  },
                },
              )
            }
          >
            Open {noun}
          </Button>
        </SectionCard>
      ) : null}

      <SectionCard title={kind === "disciplinary" ? "Disciplinary cases" : "Grievances"}>
        <QueryState
          isLoading={cases.isLoading}
          error={cases.error}
          isEmpty={(cases.data ?? []).length === 0}
          empty={
            <EmptyState
              title={`No ${noun}s recorded`}
              description="Cases opened by HR appear here with their status and outcome."
              icon={ShieldCheck}
            />
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Case</TableHead>
                  <TableHead>Employee</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Outcome</TableHead>
                  {mayManage ? <TableHead className="text-right">Action</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {((cases.data ?? []) as HrRow[]).map((row) => {
                  const emp = (row["employees"] ?? {}) as HrRow;
                  const status = str(row["status"], "open");
                  const closed = status === "closed" || status === "resolved";
                  return (
                    <TableRow key={String(row["id"])}>
                      <TableCell className="font-mono text-xs">{str(row["case_number"])}</TableCell>
                      <TableCell className="font-medium">{str(emp["full_name"])}</TableCell>
                      <TableCell className="max-w-[16rem]">
                        {str(row["subject"] ?? row["title"])}
                      </TableCell>
                      <TableCell>
                        <StatusPill tone={STATUS_TONE[status] ?? "default"}>
                          {titleCase(status)}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="max-w-[16rem] text-sm text-muted-foreground">
                        {str(row["outcome"])}
                      </TableCell>
                      {mayManage ? (
                        <TableCell className="text-right">
                          {closed ? (
                            <span className="text-xs text-muted-foreground">Closed</span>
                          ) : (
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={review.isPending}
                                onClick={() =>
                                  review.mutate({
                                    kind,
                                    caseId: String(row["id"]),
                                    status: "investigating",
                                  })
                                }
                              >
                                Investigate
                              </Button>
                              <Button
                                size="sm"
                                disabled={review.isPending}
                                onClick={() =>
                                  review.mutate({
                                    kind,
                                    caseId: String(row["id"]),
                                    status: "resolved",
                                    outcome: "Resolved by HR",
                                  })
                                }
                              >
                                Resolve
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      ) : null}
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

function HrRelationsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Human Resources"
        title="Employee relations"
        description="Disciplinary matters and grievances are confidential to HR. Every case keeps its own dated trail from opening to outcome."
      />
      <Tabs defaultValue="disciplinary">
        <TabsList>
          <TabsTrigger value="disciplinary">Disciplinary</TabsTrigger>
          <TabsTrigger value="grievance">Grievances</TabsTrigger>
        </TabsList>
        <TabsContent value="disciplinary" className="mt-4">
          <CasePanel kind="disciplinary" />
        </TabsContent>
        <TabsContent value="grievance" className="mt-4">
          <CasePanel kind="grievance" />
        </TabsContent>
      </Tabs>
    </div>
  );
}
