import { useState } from "react";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { createFileRoute } from "@tanstack/react-router";
import { FileText, ShieldAlert } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
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
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/operations";
import { useEmployees, useHrSettings } from "@/lib/hr-data";
import {
  DOCUMENT_CATEGORIES,
  documentExpiry,
  str,
  useHrDocumentAlerts,
  useRecordEmployeeDocument,
  type HrRow,
} from "@/lib/hr-department";

export const Route = createFileRoute("/_shell/hr/documents")({
  head: () => ({
    meta: [
      { title: "Employee Documents — NEØ" },
      {
        name: "description",
        content:
          "The official document file for every employee: contracts, certificates, statutory papers and their expiry status.",
      },
      { property: "og:title", content: "Employee Documents — NEØ" },
      {
        property: "og:description",
        content:
          "Versioned employee documents with issue and expiry tracking. Replacements supersede, never delete.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="human-resources" action="documents.view">
      <HrDocumentsPage />
    </OpsGuard>
  ),
});

const EXPIRY_TONE = {
  expired: "destructive",
  expiring: "warning",
  valid: "success",
  none: "default",
} as const;

function HrDocumentsPage() {
  const { can } = useAuth();
  const mayRecord =
    can("human-resources", "documents.create") || can("human-resources", "employees.edit");

  const alerts = useHrDocumentAlerts();
  const employees = useEmployees({ status: "active" });
  const record = useRecordEmployeeDocument();

  const [employeeId, setEmployeeId] = useState("");
  const [category, setCategory] = useState<string>(DOCUMENT_CATEGORIES[0]);
  const [title, setTitle] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [search, setSearch] = useState("");

  // Retention comes from HR settings; nothing is assumed when it is not configured.
  const hrSettings = useHrSettings();
  const retentionMonths = Number(
    (hrSettings.data as HrRow | null | undefined)?.["document_retention_months"] ?? 0,
  );
  const retentionUntil = (row: HrRow) => {
    const basis = str(row["issue_date"], "") || String(row["created_at"] ?? "").slice(0, 10);
    if (!retentionMonths || !basis) return "Not configured";
    const start = new Date(`${basis}T00:00:00`);
    if (Number.isNaN(start.getTime())) return "Not configured";
    const until = new Date(start);
    until.setMonth(until.getMonth() + retentionMonths);
    return until.toISOString().slice(0, 10);
  };

  const rows = alerts.rows.filter((row) => {
    if (!search.trim()) return true;
    const emp = (row["employees"] ?? {}) as HrRow;
    const hay = `${str(emp["full_name"], "")} ${str(emp["employee_number"], "")} ${str(row["title"], "")} ${str(row["category"], "")}`;
    return hay.toLowerCase().includes(search.trim().toLowerCase());
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Human Resources"
        title="Employee documents"
        description="One official file per employee. Uploading a replacement creates a new version and supersedes the previous one — nothing is erased."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Active documents" value={String(alerts.rows.length)} icon={FileText} />
        <StatCard
          label="Expiring within 45 days"
          value={String(alerts.expiring.length)}
          tone="warning"
          icon={ShieldAlert}
        />
        <StatCard
          label="Expired"
          value={String(alerts.expired.length)}
          tone="warning"
          icon={ShieldAlert}
        />
      </div>

      {mayRecord ? (
        <SectionCard
          title="Record a document"
          description="Register the document against the employee file with its issue and expiry dates."
        >
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="doc-employee">Employee</Label>
              <select
                id="doc-employee"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
              >
                <option value="">Select employee…</option>
                {((employees.data ?? []) as HrRow[]).map((emp) => (
                  <option key={String(emp["id"])} value={String(emp["id"])}>
                    {str(emp["full_name"])} — {str(emp["employee_number"], "no number")}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="doc-category">Category</Label>
              <select
                id="doc-category"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {DOCUMENT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {titleCase(c)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="doc-title">Document title</Label>
              <Input
                id="doc-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Food handling certificate"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="doc-issue">Issued</Label>
              <NeoDatePicker id="doc-issue" value={issueDate} onChange={setIssueDate} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="doc-expiry">Expires</Label>
              <NeoDatePicker id="doc-expiry" value={expiryDate} onChange={setExpiryDate} />
            </div>
            <div className="flex items-end">
              <Button
                className="w-full"
                disabled={!employeeId || !title.trim() || record.isPending}
                onClick={() =>
                  record.mutate(
                    { employeeId, category, title, issueDate, expiryDate },
                    {
                      onSuccess: () => {
                        setTitle("");
                        setIssueDate("");
                        setExpiryDate("");
                      },
                    },
                  )
                }
              >
                Record document
              </Button>
            </div>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Document register"
        description="Active documents across the workforce, soonest expiry first."
        actions={
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search employee or document"
            className="w-56"
          />
        }
      >
        <QueryState
          isLoading={alerts.isLoading}
          error={alerts.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No documents recorded"
              description="Employee documents recorded by HR appear here with their expiry status."
              icon={FileText}
            />
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Document</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Issued</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Keep until</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const emp = (row["employees"] ?? {}) as HrRow;
                  const expiry = documentExpiry(row["expiry_date"]);
                  return (
                    <TableRow key={String(row["id"])}>
                      <TableCell className="font-medium">
                        {str(emp["full_name"])}
                        <span className="block text-xs text-muted-foreground">
                          {str(emp["employee_number"], "")}
                        </span>
                      </TableCell>
                      <TableCell>{str(row["title"])}</TableCell>
                      <TableCell>{titleCase(str(row["category"], "other"))}</TableCell>
                      <TableCell>v{str(row["version"], "1")}</TableCell>
                      <TableCell>{str(row["issue_date"])}</TableCell>
                      <TableCell>{str(row["expiry_date"])}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {retentionUntil(row)}
                      </TableCell>
                      <TableCell>
                        <StatusPill tone={EXPIRY_TONE[expiry.state]}>
                          {expiry.state === "none"
                            ? "No expiry"
                            : expiry.state === "expired"
                              ? `Expired ${Math.abs(expiry.days ?? 0)}d ago`
                              : expiry.state === "expiring"
                                ? `Expires in ${expiry.days}d`
                                : "Valid"}
                        </StatusPill>
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
