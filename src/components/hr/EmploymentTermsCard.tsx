import { useEffect, useMemo, useState } from "react";
import { FileSignature } from "lucide-react";
import { SectionCard } from "@/components/common/DataDisplay";
import { FormDialog } from "@/components/common/FormDialog";
import { FieldGrid } from "@/components/common/FormFields";
import { NeoDatePicker } from "@/components/common/DatePicker";
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
import { useAuth } from "@/lib/auth";
import { useBranchesLookup, useDepartmentsLookup, useEmployees } from "@/lib/hr-data";
import {
  GENDER_OPTIONS,
  gradeLabel,
  usePositionGrades,
  useSetEmploymentTerms,
  useStationsLookup,
} from "@/lib/hr-terms";
import { EMPLOYMENT_TYPES, HR_MODULES, labelFor, shortDate, type Row } from "@/lib/hr";

const NONE = "none";

type Draft = {
  employment_date: string;
  employment_type: string;
  position_grade: string;
  contract_start: string;
  contract_end: string;
  probation_start: string;
  probation_end: string;
  reporting_manager_id: string;
  department_id: string;
  branch_id: string;
  station_id: string;
  job_title: string;
  gender: string;
  reason: string;
};

function draftFrom(e: Row): Draft {
  const s = (key: string) => String(e[key] ?? "");
  return {
    employment_date: s("employment_date"),
    employment_type: s("employment_type") || "permanent",
    position_grade: s("position_grade") || NONE,
    contract_start: s("contract_start"),
    contract_end: s("contract_end"),
    probation_start: s("probation_start_date"),
    probation_end: s("probation_end_date"),
    reporting_manager_id: s("reporting_manager_id") || NONE,
    department_id: s("department_id") || NONE,
    branch_id: s("branch_id") || NONE,
    station_id: s("station_id") || NONE,
    job_title: s("job_title"),
    gender: s("gender") || NONE,
    reason: "",
  };
}

const orNull = (v: string) => (v === NONE || v.trim() === "" ? null : v.trim());

/**
 * The employment record established between creating a person and changing
 * their facts later. Everything here is entered by HR; nothing is guessed, and
 * every save is written to the employee's dated history.
 */
export function EmploymentTermsCard({ employee }: { employee: Row }) {
  const { can } = useAuth();
  const mayEdit = can(HR_MODULES.employees, "edit");
  const [open, setOpen] = useState(false);

  const grades = usePositionGrades();
  const gradeRows = (grades.data ?? []) as Row[];
  const joined = employee["employment_date"];
  const createdAt = employee["created_at"];

  return (
    <SectionCard
      title="Employment terms"
      description="When the employee actually joined, on what basis, at which grade and under which contract. Changes after this are recorded as movements."
      actions={
        mayEdit ? (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <FileSignature className="mr-2 size-4" aria-hidden />
            {joined ? "Edit employment terms" : "Establish employment terms"}
          </Button>
        ) : null
      }
    >
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Employment date" value={shortDate(joined)} />
        <Fact
          label="Employment type"
          value={labelFor(EMPLOYMENT_TYPES, employee["employment_type"])}
        />
        <Fact label="Position grade" value={gradeLabel(gradeRows, employee["position_grade"])} />
        <Fact label="Contract start" value={shortDate(employee["contract_start"])} />
        <Fact
          label="Contract expiry"
          value={employee["contract_end"] ? shortDate(employee["contract_end"]) : "Not applicable"}
        />
        <Fact label="Probation starts" value={shortDate(employee["probation_start_date"])} />
        <Fact label="Probation ends" value={shortDate(employee["probation_end_date"])} />
        <Fact
          label="Reporting manager"
          value={String((employee["reporting_manager"] as Row | null)?.["full_name"] ?? "—")}
        />
        <Fact
          label="Department"
          value={String((employee["departments"] as Row | null)?.["name"] ?? "—")}
        />
        <Fact label="Job title" value={String(employee["job_title"] || "—")} />
        <Fact
          label="Property"
          value={String((employee["branches"] as Row | null)?.["name"] ?? "—")}
        />
        <Fact
          label="Station"
          value={String((employee["stations"] as Row | null)?.["name"] ?? "—")}
        />
      </dl>

      <p className="mt-3 text-xs text-muted-foreground">
        Record added to NEØ on {shortDate(createdAt)} — that is not the employment date and is never
        used as one.
      </p>

      {open ? (
        <EmploymentTermsDialog
          open={open}
          onOpenChange={setOpen}
          employee={employee}
          grades={gradeRows}
        />
      ) : null}
    </SectionCard>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-medium text-foreground">{value || "—"}</dd>
    </div>
  );
}

export function EmploymentTermsDialog({
  open,
  onOpenChange,
  employee,
  grades,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  employee: Row;
  grades: Row[];
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(employee));
  const save = useSetEmploymentTerms();
  const departments = useDepartmentsLookup();
  const branches = useBranchesLookup();
  const colleagues = useEmployees({ status: "active" });
  const stations = useStationsLookup(draft.branch_id === NONE ? null : draft.branch_id);

  useEffect(() => {
    if (open) setDraft(draftFrom(employee));
  }, [open, employee]);

  const managers = useMemo(
    () =>
      ((colleagues.data ?? []) as Row[]).filter((c) => String(c["id"]) !== String(employee["id"])),
    [colleagues.data, employee],
  );

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  const contractInvalid =
    Boolean(draft.contract_start && draft.contract_end) && draft.contract_end < draft.contract_start;
  const probationInvalid =
    Boolean(draft.probation_start && draft.probation_end) &&
    draft.probation_end < draft.probation_start;

  function submit() {
    save.mutate(
      {
        employeeId: String(employee["id"]),
        employmentDate: orNull(draft.employment_date),
        employmentType: orNull(draft.employment_type),
        positionGrade: orNull(draft.position_grade),
        contractStart: orNull(draft.contract_start),
        contractEnd: orNull(draft.contract_end),
        probationStart: orNull(draft.probation_start),
        probationEnd: orNull(draft.probation_end),
        reportingManagerId: orNull(draft.reporting_manager_id),
        departmentId: orNull(draft.department_id),
        branchId: orNull(draft.branch_id),
        stationId: orNull(draft.station_id),
        jobTitle: orNull(draft.job_title),
        gender: orNull(draft.gender),
        reason: orNull(draft.reason) ?? "Employment terms established",
      },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title={`Employment terms — ${String(employee["full_name"])}`}
      description="The starting employment record. Later changes belong in Movements so the history is kept."
      submitLabel="Save employment terms"
      canSubmit={!contractInvalid && !probationInvalid}
      busy={save.isPending}
      onSubmit={submit}
      footerNote={
        contractInvalid
          ? "Contract expiry cannot fall before the contract start."
          : probationInvalid
            ? "Probation end cannot fall before the probation start."
            : "Leave a field blank where it does not apply — nothing is filled in for you."
      }
    >
      <FieldGrid>
        <div className="space-y-1.5">
          <Label htmlFor="terms-joined">Employment date (actual joining date)</Label>
          <NeoDatePicker
            id="terms-joined"
            value={draft.employment_date}
            onChange={(v) => set("employment_date", v)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="terms-type">Employment type</Label>
          <Select value={draft.employment_type} onValueChange={(v) => set("employment_type", v)}>
            <SelectTrigger id="terms-type">
              <SelectValue placeholder="Select type" />
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
        <div className="space-y-1.5">
          <Label htmlFor="terms-grade">Position grade</Label>
          <Select value={draft.position_grade} onValueChange={(v) => set("position_grade", v)}>
            <SelectTrigger id="terms-grade">
              <SelectValue placeholder="Select grade" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Not graded</SelectItem>
              {grades.map((g) => (
                <SelectItem key={String(g["id"])} value={String(g["code"])}>
                  {String(g["code"])} — {String(g["name"])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {grades.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No grades configured yet. HR Settings holds the company grade list.
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="terms-contract-start">Contract start</Label>
          <NeoDatePicker
            id="terms-contract-start"
            value={draft.contract_start}
            onChange={(v) => set("contract_start", v)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="terms-contract-end">Contract expiry (leave blank if permanent)</Label>
          <NeoDatePicker
            id="terms-contract-end"
            value={draft.contract_end}
            min={draft.contract_start || undefined}
            onChange={(v) => set("contract_end", v)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="terms-probation-start">Probation start</Label>
          <NeoDatePicker
            id="terms-probation-start"
            value={draft.probation_start}
            onChange={(v) => set("probation_start", v)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="terms-probation-end">Probation end</Label>
          <NeoDatePicker
            id="terms-probation-end"
            value={draft.probation_end}
            min={draft.probation_start || undefined}
            onChange={(v) => set("probation_end", v)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="terms-manager">Reporting manager</Label>
          <Select
            value={draft.reporting_manager_id}
            onValueChange={(v) => set("reporting_manager_id", v)}
          >
            <SelectTrigger id="terms-manager">
              <SelectValue placeholder="Select manager" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Not recorded</SelectItem>
              {managers.map((m) => (
                <SelectItem key={String(m["id"])} value={String(m["id"])}>
                  {String(m["full_name"])} — {String(m["job_title"] || "no title")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="terms-department">Department</Label>
          <Select value={draft.department_id} onValueChange={(v) => set("department_id", v)}>
            <SelectTrigger id="terms-department">
              <SelectValue placeholder="Select department" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Not assigned</SelectItem>
              {((departments.data ?? []) as Row[]).map((d) => (
                <SelectItem key={String(d["id"])} value={String(d["id"])}>
                  {String(d["name"])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="terms-title">Job title</Label>
          <Input
            id="terms-title"
            value={draft.job_title}
            onChange={(e) => set("job_title", e.target.value)}
            placeholder="Finance Manager"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="terms-branch">Property</Label>
          <Select
            value={draft.branch_id}
            onValueChange={(v) => {
              set("branch_id", v);
              set("station_id", NONE);
            }}
          >
            <SelectTrigger id="terms-branch">
              <SelectValue placeholder="Select property" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Not assigned</SelectItem>
              {((branches.data ?? []) as Row[]).map((b) => (
                <SelectItem key={String(b["id"])} value={String(b["id"])}>
                  {String(b["name"])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="terms-station">Station (if applicable)</Label>
          <Select value={draft.station_id} onValueChange={(v) => set("station_id", v)}>
            <SelectTrigger id="terms-station">
              <SelectValue placeholder="Select station" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Not applicable</SelectItem>
              {((stations.data ?? []) as Row[]).map((s) => (
                <SelectItem key={String(s["id"])} value={String(s["id"])}>
                  {String(s["name"])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="terms-gender">Gender</Label>
          <Select value={draft.gender} onValueChange={(v) => set("gender", v)}>
            <SelectTrigger id="terms-gender">
              <SelectValue placeholder="Not recorded" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Not recorded</SelectItem>
              {GENDER_OPTIONS.map((g) => (
                <SelectItem key={g.key} value={g.key}>
                  {g.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Used only where a leave policy applies to one group, such as maternity or paternity
            leave.
          </p>
        </div>
      </FieldGrid>

      <div className="space-y-1.5">
        <Label htmlFor="terms-reason">Note for the record</Label>
        <Textarea
          id="terms-reason"
          rows={2}
          value={draft.reason}
          onChange={(e) => set("reason", e.target.value)}
          placeholder="Signed contract received and filed"
        />
      </div>
    </FormDialog>
  );
}
