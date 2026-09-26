import { useMemo, useState } from "react";
import { toast } from "sonner";
import { FormDialog } from "@/components/common/FormDialog";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useBranchesLookup,
  useDepartmentsLookup,
  useEmployees,
  useHrWrite,
  useShiftTemplates,
} from "@/lib/hr-data";
import { today, type Row } from "@/lib/hr";

/** Create a roster period for a department before any shift is assigned. */
export function RosterCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const departments = useDepartmentsLookup();
  const branches = useBranchesLookup();
  const write = useHrWrite("rosters", { action: "hr.roster.created" });

  const [name, setName] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState(today());

  const canSubmit = Boolean(name.trim()) && Boolean(departmentId) && end >= start;

  const submit = () => {
    write.mutate(
      {
        values: {
          name: name.trim(),
          department_id: departmentId,
          branch_id: branchId || null,
          period_start: start,
          period_end: end,
          status: "draft",
        },
      },
      {
        onSuccess: () => {
          toast.success("Roster created as a draft");
          setName("");
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New roster"
      description="A roster covers one department for one period. Staff only see it once it is published."
      submitLabel="Create roster"
      canSubmit={canSubmit && !write.isPending}
      busy={write.isPending}
      onSubmit={submit}
      size="md"
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label>Roster name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Front Office — week 38" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label>Department</Label>
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger>
                <SelectValue placeholder="Select department" />
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
          <div className="grid gap-2">
            <Label>Property</Label>
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger>
                <SelectValue placeholder="Select property" />
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
          <div className="grid gap-2">
            <Label>Period start</Label>
            <NeoDatePicker value={start} onChange={(v) => setStart(v ?? today())} />
          </div>
          <div className="grid gap-2">
            <Label>Period end</Label>
            <NeoDatePicker value={end} onChange={(v) => setEnd(v ?? today())} />
          </div>
        </div>
      </div>
    </FormDialog>
  );
}

/** Assign one employee to one shift on one date inside an existing roster. */
export function ShiftAssignDialog({
  open,
  onOpenChange,
  roster,
  existing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  roster: Row;
  existing?: readonly Row[];
}) {
  const employees = useEmployees({ status: "active" });
  const templates = useShiftTemplates();
  const write = useHrWrite("roster_assignments", { action: "hr.roster.shift_assigned" });

  const [employeeId, setEmployeeId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [shiftDate, setShiftDate] = useState(String(roster["period_start"] ?? today()));
  const [notes, setNotes] = useState("");

  const periodStart = String(roster["period_start"] ?? "");
  const periodEnd = String(roster["period_end"] ?? "");
  const inPeriod = shiftDate >= periodStart && shiftDate <= periodEnd;

  const template = useMemo(
    () => (templates.data ?? []).find((t) => String(t["id"]) === templateId) ?? null,
    [templates.data, templateId],
  );
  const employee = useMemo(
    () => (employees.data ?? []).find((e) => String(e["id"]) === employeeId) ?? null,
    [employees.data, employeeId],
  );

  const clash = (existing ?? []).find(
    (a) => String(a["employee_id"]) === employeeId && String(a["shift_date"]) === shiftDate,
  );

  const canSubmit = Boolean(employeeId) && Boolean(templateId) && inPeriod && !clash;

  const submit = () => {
    if (!template || !employee) return;
    const startsAt = template["start_time"]
      ? new Date(`${shiftDate}T${String(template["start_time"]).slice(0, 8)}`).toISOString()
      : null;
    const endsAt = template["end_time"]
      ? new Date(`${shiftDate}T${String(template["end_time"]).slice(0, 8)}`).toISOString()
      : null;
    write.mutate(
      {
        values: {
          roster_id: roster["id"],
          employee_id: employeeId,
          shift_template_id: templateId,
          branch_id: roster["branch_id"] ?? employee["branch_id"] ?? null,
          department_id: roster["department_id"] ?? employee["department_id"] ?? null,
          shift_date: shiftDate,
          starts_at: startsAt,
          ends_at: endsAt,
          status: "scheduled",
          is_open_shift: false,
          notes: notes.trim(),
        },
      },
      {
        onSuccess: () => {
          toast.success("Shift assigned");
          setEmployeeId("");
          setNotes("");
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Assign a shift"
      description={`${String(roster["name"] ?? "Roster")} · ${periodStart} → ${periodEnd}`}
      submitLabel="Assign shift"
      canSubmit={canSubmit && !write.isPending}
      busy={write.isPending}
      onSubmit={submit}
      footerNote={
        clash
          ? "This employee already has a shift on that date in this roster."
          : !inPeriod
            ? "The date must fall inside the roster period."
            : undefined
      }
      size="md"
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label>Employee</Label>
          <Select value={employeeId} onValueChange={setEmployeeId}>
            <SelectTrigger>
              <SelectValue placeholder="Select an employee" />
            </SelectTrigger>
            <SelectContent>
              {(employees.data ?? []).map((e) => (
                <SelectItem key={String(e["id"])} value={String(e["id"])}>
                  {String(e["full_name"])} · {String(e["employee_number"] ?? "")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label>Shift</Label>
            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a shift template" />
              </SelectTrigger>
              <SelectContent>
                {(templates.data ?? []).map((t) => (
                  <SelectItem key={String(t["id"])} value={String(t["id"])}>
                    {String(t["name"])} · {String(t["start_time"])}–{String(t["end_time"])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Date</Label>
            <NeoDatePicker value={shiftDate} onChange={(v) => setShiftDate(v ?? periodStart)} />
          </div>
        </div>
        <div className="grid gap-2">
          <Label>Notes</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </div>
      </div>
    </FormDialog>
  );
}

/**
 * Define a reusable shift pattern.
 *
 * Without at least one template a roster cannot be scheduled at all, so this
 * is the first step of the scheduling chain rather than an optional extra.
 */
export function ShiftTemplateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const departments = useDepartmentsLookup();
  const branches = useBranchesLookup();
  const write = useHrWrite("shift_templates", { action: "hr.shift-template.created" });

  const [name, setName] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [startTime, setStartTime] = useState("08:00");
  const [endTime, setEndTime] = useState("17:00");
  const [breakMinutes, setBreakMinutes] = useState("30");
  const [graceMinutes, setGraceMinutes] = useState("10");
  const [minStaff, setMinStaff] = useState("1");

  const overnight = endTime <= startTime;
  const canSubmit =
    Boolean(name.trim()) &&
    Boolean(departmentId) &&
    /^\d{2}:\d{2}$/.test(startTime) &&
    /^\d{2}:\d{2}$/.test(endTime) &&
    startTime !== endTime;

  const submit = () => {
    write.mutate(
      {
        values: {
          name: name.trim(),
          department_id: departmentId,
          branch_id: branchId || null,
          start_time: startTime,
          end_time: endTime,
          break_minutes: Number(breakMinutes) || 0,
          grace_minutes: Number(graceMinutes) || 0,
          min_staff: Number(minStaff) || 1,
          overnight,
          status: "active",
        },
      },
      {
        onSuccess: () => {
          toast.success("Shift template saved");
          setName("");
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New shift template"
      description="A shift pattern belongs to one department. Overnight shifts are detected from the times."
      submitLabel="Save template"
      canSubmit={canSubmit && !write.isPending}
      busy={write.isPending}
      onSubmit={submit}
      size="md"
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label>Template name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Housekeeping — morning"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label>Department</Label>
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger>
                <SelectValue placeholder="Select department" />
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
          <div className="grid gap-2">
            <Label>Property</Label>
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger>
                <SelectValue placeholder="Select property" />
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
          <div className="grid gap-2">
            <Label>Start time</Label>
            <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>End time</Label>
            <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>Break (minutes)</Label>
            <Input
              type="number"
              min={0}
              value={breakMinutes}
              onChange={(e) => setBreakMinutes(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label>Grace (minutes)</Label>
            <Input
              type="number"
              min={0}
              value={graceMinutes}
              onChange={(e) => setGraceMinutes(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label>Minimum staff</Label>
            <Input
              type="number"
              min={1}
              value={minStaff}
              onChange={(e) => setMinStaff(e.target.value)}
            />
          </div>
        </div>
        {overnight ? (
          <p className="text-xs text-muted-foreground">
            This pattern ends on the following day and is recorded as an overnight shift.
          </p>
        ) : null}
      </div>
    </FormDialog>
  );
}
