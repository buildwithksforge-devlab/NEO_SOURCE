import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus, UserPlus, Users } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { Avatar } from "@/components/common/AvatarDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import {
  CatalogueGroup,
  CatalogueQueryBar,
  CatalogueRail,
  CatalogueRow,
  CatalogueWorkspace,
  type ActiveFilterChip,
} from "@/components/common/CatalogueWorkspace";
import {
  InspectorField,
  InspectorSection,
  InspectorSheet,
} from "@/components/common/InspectorSheet";
import {
  EmptyState,
  HrBadge,
  HrGuard,
  IdentitySeparationNotice,
  QueryState,
} from "@/components/hr/HrShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import {
  useBranchesLookup,
  useDepartmentsLookup,
  useEmployees,
  useHrCtx,
  useHrReconcilePreview,
  useHrReconcileStaff,
  useHrWrite,
} from "@/lib/hr-data";
import {
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_TYPES,
  HR_MODULES,
  labelFor,
  shortDate,
  toneFor,
  type Row,
} from "@/lib/hr";
import { employeeReadiness, malformedFields, workforceReadiness } from "@/lib/hr-readiness";

export const Route = createFileRoute("/_shell/hr/employees/")({
  head: () => ({
    meta: [
      { title: "Employee Directory — HOS Human Resources" },
      {
        name: "description",
        content: "Search, filter and manage every employee record across branches and departments.",
      },
      { property: "og:title", content: "Employee Directory — HOS Human Resources" },
      {
        property: "og:description",
        content: "Search, filter and manage every employee record across branches and departments.",
      },
    ],
  }),
  component: () => (
    <HrGuard module={HR_MODULES.employees} action="directory.view">
      <EmployeeDirectory />
    </HrGuard>
  ),
});

/** Data-quality lenses surfaced by the summary strip. */
type Lens = "none" | "incomplete" | "notPayrollReady" | "noAccess" | "exited" | "checkDetails";

const LENS_LABELS: Record<Exclude<Lens, "none">, string> = {
  incomplete: "Incomplete record",
  notPayrollReady: "Not payroll ready",
  noAccess: "No system access",
  exited: "Exited",
  checkDetails: "Details need checking",
};

function EmployeeDirectory() {
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [department, setDepartment] = useState("all");
  const [lens, setLens] = useState<Lens>("none");
  const [inspectId, setInspectId] = useState<string | null>(null);
  // Fetched once for the current search / status. The department choice is
  // applied here rather than in the query so the department badges can keep
  // showing every department's real count while one of them is selected.
  const employees = useEmployees({ search, status });
  const departments = useDepartmentsLookup();

  const scopeRows = useMemo(() => employees.data ?? [], [employees.data]);
  const allRows = useMemo(
    () =>
      department === "all"
        ? scopeRows
        : scopeRows.filter((e) => String(e["department_id"] ?? "") === department),
    [scopeRows, department],
  );
  const roll = useMemo(() => workforceReadiness(allRows), [allRows]);
  const checkDetailsCount = useMemo(
    () => allRows.filter((e) => malformedFields(e).length > 0).length,
    [allRows],
  );

  const toggleLens = (next: Lens) => setLens((prev) => (prev === next ? "none" : next));

  const filtered = useMemo(() => {
    if (lens === "none") return allRows;
    return allRows.filter((e) => {
      const exited = String(e["employment_status"] ?? "") === "exited";
      if (lens === "exited") return exited;
      if (lens === "checkDetails") return malformedFields(e).length > 0;
      if (exited) return false;
      const r = employeeReadiness(e);
      if (lens === "incomplete") return !r.complete;
      if (lens === "notPayrollReady") return !r.payrollReady;
      if (lens === "noAccess") return !e["profile_id"];
      return true;
    });
  }, [allRows, lens]);

  const grouped = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const row of filtered) {
      const key = (row["departments"] as Row | null)?.["name"]
        ? String((row["departments"] as Row)["name"])
        : "No department";
      const bucket = map.get(key);
      if (bucket) bucket.push(row);
      else map.set(key, [row]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  // Counted on department_id from the employee row itself — the joined
  // department object only carries a name, so matching on it always read zero —
  // and over the department-unfiltered set, so choosing one department does not
  // zero every other badge.
  const railItems = (departments.data ?? []).map((d) => ({
    id: String(d["id"]),
    label: String(d["name"]),
    count: scopeRows.filter((e) => String(e["department_id"] ?? "") === String(d["id"])).length,
  }));


  const activeFilters: ActiveFilterChip[] = [];
  if (status !== "all")
    activeFilters.push({
      id: "status",
      label: labelFor(EMPLOYMENT_STATUSES, status),
      onClear: () => setStatus("all"),
    });
  if (lens !== "none")
    activeFilters.push({
      id: "lens",
      label: LENS_LABELS[lens],
      onClear: () => setLens("none"),
    });

  const clearAll = () => {
    setStatus("all");
    setLens("none");
  };

  const inspected = filtered.find((e) => String(e["id"]) === inspectId) ?? null;
  const inspectedReadiness = inspected ? employeeReadiness(inspected) : null;

  const leadFigure: SummaryFigure = {
    id: "total",
    label: "Active employees",
    value: employees.isLoading ? "…" : roll.total,
    hint: roll.exited
      ? `${roll.exited} exited record(s) also match — counted separately`
      : "Records matching the current filters",
  };
  const figures: SummaryFigure[] = [
    {
      id: "complete",
      label: "Complete record",
      value: employees.isLoading ? "…" : roll.complete,
      tone: "success",
    },
    {
      id: "incomplete",
      label: "Incomplete record",
      value: employees.isLoading ? "…" : roll.incomplete,
      tone: roll.incomplete ? "warning" : "default",
      onSelect: () => toggleLens("incomplete"),
      active: lens === "incomplete",
    },
    {
      id: "notPayrollReady",
      label: "Not payroll ready",
      value: employees.isLoading ? "…" : roll.notPayrollReady,
      hint: employees.isLoading
        ? "…"
        : `${roll.notEnrolled} not enrolled · ${roll.payrollBlocked} missing a fact payroll needs`,
      tone: roll.notPayrollReady ? "destructive" : "default",
      onSelect: () => toggleLens("notPayrollReady"),
      active: lens === "notPayrollReady",
    },
    {
      id: "noAccess",
      label: "No system access",
      value: employees.isLoading ? "…" : roll.noAccess,
      tone: "info",
      onSelect: () => toggleLens("noAccess"),
      active: lens === "noAccess",
    },
    {
      id: "exited",
      label: "Exited",
      value: employees.isLoading ? "…" : roll.exited,
      tone: "default",
      onSelect: () => toggleLens("exited"),
      active: lens === "exited",
    },
    {
      id: "checkDetails",
      label: "Details need checking",
      value: employees.isLoading ? "…" : checkDetailsCount,
      tone: checkDetailsCount ? "warning" : "default",
      onSelect: () => toggleLens("checkDetails"),
      active: lens === "checkDetails",
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Human Resources"
        title="Employee Directory"
        description="The authoritative record of everyone employed by the organization. Separate from guest profiles and from platform login accounts."
        actions={can(HR_MODULES.employees, "create") ? <NewEmployeeDialog /> : null}
      />

      <IdentitySeparationNotice />

      {can(HR_MODULES.employees, "create") ? <ReconcileStaffCard /> : null}

      <SummaryStrip lead={leadFigure} figures={figures} />

      <CatalogueWorkspace
        rail={
          <CatalogueRail
            title="Department"
            items={railItems}
            value={department}
            onChange={setDepartment}
            allLabel="All departments"
            allCount={scopeRows.length}
          />
        }
      >
        <CatalogueQueryBar
          search={search}
          onSearch={setSearch}
          placeholder="Search name, employee number or job title"
          activeFilters={activeFilters}
          onClearAll={activeFilters.length ? clearAll : undefined}
          filters={
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger aria-label="Filter by employment status">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {EMPLOYMENT_STATUSES.map((s) => (
                    <SelectItem key={s.key} value={s.key}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          }
        />

        <QueryState
          isLoading={employees.isLoading}
          error={employees.error}
          isEmpty={allRows.length === 0}
          empty={
            <EmptyState
              icon={Users}
              title="No employee records yet"
              description="Create the first employee record, or convert a hired candidate from Recruitment."
            />
          }
        >
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No employees match the current filters.
            </p>
          ) : (
            <div className="min-w-0">
              {grouped.map(([groupName, rows]) => (
                <CatalogueGroup key={groupName} label={groupName} count={rows.length}>
                  {rows.map((e) => {
                    const r = employeeReadiness(e);
                    const malformed = malformedFields(e);
                    return (
                      <CatalogueRow
                        key={String(e["id"])}
                        selected={inspectId === String(e["id"])}
                        onOpen={() => setInspectId(String(e["id"]))}
                        media={
                          <Avatar
                            path={(e["avatar_url"] as string | null) ?? null}
                            name={String(e["full_name"])}
                            size={40}
                          />
                        }
                        title={String(e["full_name"])}
                        subtitle={[e["employee_number"], e["job_title"]].filter(Boolean).join(" · ")}
                        chips={
                          <>
                            {/* Four separate facts, never merged into one badge. */}
                            <StatusPill tone={toneFor(EMPLOYMENT_STATUSES, e["employment_status"])}>
                              {labelFor(EMPLOYMENT_STATUSES, e["employment_status"])}
                            </StatusPill>
                            <StatusPill tone={r.complete ? "success" : "warning"}>
                              {r.complete ? "Record complete" : `${r.percent}% recorded`}
                            </StatusPill>
                            <StatusPill tone={r.payrollReady ? "success" : "destructive"}>
                              {r.payrollReady ? "Payroll ready" : "Not payroll ready"}
                            </StatusPill>
                            <StatusPill tone={e["profile_id"] ? "info" : "default"}>
                              {e["profile_id"] ? "Linked" : "No login"}
                            </StatusPill>
                            {malformed.length ? (
                              <StatusPill tone="warning">
                                Check {malformed.join(" and ").toLowerCase()}
                              </StatusPill>
                            ) : null}
                          </>
                        }
                        trailing={shortDate(e["employment_date"])}
                      />
                    );
                  })}
                </CatalogueGroup>
              ))}
            </div>
          )}
        </QueryState>
      </CatalogueWorkspace>

      <InspectorSheet
        open={Boolean(inspected)}
        onOpenChange={(o) => !o && setInspectId(null)}
        title={inspected ? String(inspected["full_name"]) : ""}
        subtitle={inspected ? String(inspected["employee_number"]) : undefined}
        media={
          inspected ? (
            <Avatar
              path={(inspected["avatar_url"] as string | null) ?? null}
              name={String(inspected["full_name"])}
              size={44}
            />
          ) : null
        }
        chips={
          inspected ? (
            <>
              <StatusPill tone={toneFor(EMPLOYMENT_STATUSES, inspected["employment_status"])}>
                {labelFor(EMPLOYMENT_STATUSES, inspected["employment_status"])}
              </StatusPill>
              {inspectedReadiness ? (
                <>
                  <StatusPill tone={inspectedReadiness.complete ? "success" : "warning"}>
                    {inspectedReadiness.complete
                      ? "Record complete"
                      : `${inspectedReadiness.percent}% recorded`}
                  </StatusPill>
                  <StatusPill tone={inspectedReadiness.payrollReady ? "success" : "destructive"}>
                    {inspectedReadiness.payrollReady ? "Payroll ready" : "Not payroll ready"}
                  </StatusPill>
                </>
              ) : null}
            </>
          ) : null
        }
        footer={
          inspected ? (
            <Button asChild>
              <Link to="/hr/employees/$id" params={{ id: String(inspected["id"]) }}>
                Open full profile
              </Link>
            </Button>
          ) : null
        }
      >
        {inspected ? (
          <>
            <InspectorSection title="Placement">
              <InspectorField label="Job title">{String(inspected["job_title"] || "—")}</InspectorField>
              <InspectorField label="Department">
                {(inspected["departments"] as Row | null)?.["name"] ?? "—"}
              </InspectorField>
              <InspectorField label="Type">
                {labelFor(EMPLOYMENT_TYPES, inspected["employment_type"])}
              </InspectorField>
              <InspectorField label="Employed">{shortDate(inspected["employment_date"])}</InspectorField>
            </InspectorSection>
            <InspectorSection title="System access">
              <InspectorField label="Login account">
                {inspected["profile_id"] ? "Linked" : "No login"}
              </InspectorField>
              <InspectorField label="Record readiness">
                {inspectedReadiness
                  ? inspectedReadiness.complete
                    ? "All tracked facts recorded"
                    : `${inspectedReadiness.missing.length} field(s) outstanding`
                  : "—"}
              </InspectorField>
              <InspectorField label="Payroll">
                {inspectedReadiness?.payrollReady
                  ? "Enrolled and payroll ready"
                  : "Not enrolled in payroll"}
              </InspectorField>
            </InspectorSection>
            {malformedFields(inspected).length ? (
              <InspectorSection title="Details need checking">
                <InspectorField label="Wrong value stored">
                  {malformedFields(inspected).join(", ")} — an email address is stored here instead
                  of the real value. Correct it on the full profile; nothing is changed for you.
                </InspectorField>
              </InspectorSection>
            ) : null}
          </>
        ) : null}
      </InspectorSheet>
    </div>
  );
}

/**
 * Staff accounts that hold a role but have no HR record.
 *
 * HR only becomes usable once the people who already work here appear in the
 * directory. Reconciling copies across nothing but the facts the staff account
 * already holds — no employment dates, contracts, grades or salaries are
 * invented, and each created record stays "not ready" for payroll until HR
 * completes it.
 */
function ReconcileStaffCard() {
  const preview = useHrReconcilePreview();
  const reconcile = useHrReconcileStaff();
  const pending = Number(preview.data?.pending ?? 0);

  if (preview.isLoading || preview.isError || pending === 0) return null;

  return (
    <SectionCard
      title="Staff accounts without an HR record"
      description={`${pending} colleague(s) already have a login and a role here but no employee record.`}
      actions={
        <Button onClick={() => reconcile.mutate()} disabled={reconcile.isPending}>
          <UserPlus className="mr-2 size-4" />
          {reconcile.isPending ? "Reconciling…" : `Reconcile ${pending} record(s)`}
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">
        Only the name, staff number, contact details, job title, department and branch already held
        on the staff account are copied. Employment date, contract, grade, salary and reporting line
        are left blank and every new record is held back from payroll until HR completes it.
      </p>
      {preview.data?.sample?.length ? (
        <p className="mt-3 text-xs text-muted-foreground">
          For example:{" "}
          {preview.data.sample
            .slice(0, 5)
            .map((s) => s.name)
            .join(", ")}
          {pending > 5 ? ` and ${pending - 5} more` : ""}.
        </p>
      ) : null}
    </SectionCard>
  );
}

function NewEmployeeDialog() {
  const ctx = useHrCtx();
  const create = useHrWrite("employees", { action: "hr.employee.created" });
  const departments = useDepartmentsLookup();
  const branches = useBranchesLookup();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    full_name: "",
    phone: "",
    personal_email: "",
    job_title: "",
    employment_type: "permanent",
    employment_status: "onboarding",
    employment_date: "",
    department_id: "",
    branch_id: "",
  });

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = () => {
    // The employee number is allocated by the database, never typed here.
    if (!form.full_name.trim()) return;
    create.mutate(
      {
        values: {
          ...form,
          employment_date: form.employment_date || null,
          department_id: form.department_id || null,
          branch_id: form.branch_id || ctx.branch_id,
          created_by: ctx.userId,
        },
      },
      { onSuccess: () => setOpen(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 size-4" />
          New employee
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create employee record</DialogTitle>
          <DialogDescription>
            This creates an HR record only. It does not create a login account and never touches
            guest data.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Employee number</Label>
            <Input
              value="System generated"
              readOnly
              disabled
              aria-readonly="true"
              className="font-mono text-muted-foreground"
            />
            <p className="text-xs text-muted-foreground">
              Issued automatically on save and cannot be edited.
            </p>
          </div>

          <Field label="Full name" value={form.full_name} onChange={set("full_name")} />
          <Field label="Phone" value={form.phone} onChange={set("phone")} />
          <Field
            label="Personal email"
            value={form.personal_email}
            onChange={set("personal_email")}
            type="email"
          />
          <Field label="Job title" value={form.job_title} onChange={set("job_title")} />
          <Field
            label="Employment date"
            value={form.employment_date}
            onChange={set("employment_date")}
            type="date"
          />
          <div className="space-y-2">
            <Label>Employment type</Label>
            <Select value={form.employment_type} onValueChange={set("employment_type")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EMPLOYMENT_TYPES.map((t) => (
                  <SelectItem key={t.key} value={t.key}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={form.employment_status} onValueChange={set("employment_status")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EMPLOYMENT_STATUSES.map((t) => (
                  <SelectItem key={t.key} value={t.key}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Department</Label>
            <Select value={form.department_id} onValueChange={set("department_id")}>
              <SelectTrigger>
                <SelectValue placeholder="Select" />
              </SelectTrigger>
              <SelectContent>
                {(departments.data ?? []).map((d) => (
                  <SelectItem key={String(d["id"])} value={String(d["id"])}>
                    {String(d["name"])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Branch</Label>
            <Select value={form.branch_id} onValueChange={set("branch_id")}>
              <SelectTrigger>
                <SelectValue placeholder="Select" />
              </SelectTrigger>
              <SelectContent>
                {(branches.data ?? []).map((b) => (
                  <SelectItem key={String(b["id"])} value={String(b["id"])}>
                    {String(b["name"])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            Create record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {type === "date" ? (
        <NeoDatePicker value={value} onChange={onChange} />
      ) : (
        <Input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}
