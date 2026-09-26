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
import { useEmployees, useHrWrite } from "@/lib/hr-data";
import { today, type Row } from "@/lib/hr";

type Kind = "worked" | "late" | "absent";

function minutesBetween(date: string, from: string, to: string): number {
  if (!from || !to) return 0;
  const start = new Date(`${date}T${from}:00`);
  const end = new Date(`${date}T${to}:00`);
  let diff = Math.round((end.getTime() - start.getTime()) / 60_000);
  if (diff < 0) diff += 24 * 60; // shift crossed midnight
  return diff;
}

/**
 * Manual attendance entry.
 *
 * Hours, lateness and absence are recorded against a named employee and a work
 * date. Nothing is calculated for the supervisor beyond the arithmetic between
 * the times they entered, and every record is written as a manual source so
 * payroll can tell a keyed record from a clocked one.
 */
export function AttendanceLogDialog({
  open,
  onOpenChange,
  existing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  existing?: readonly Row[];
}) {
  const employees = useEmployees({ status: "active" });
  const write = useHrWrite("attendance_records", { action: "hr.attendance.logged" });

  const [employeeId, setEmployeeId] = useState("");
  const [workDate, setWorkDate] = useState(today());
  const [kind, setKind] = useState<Kind>("worked");
  const [inTime, setInTime] = useState("");
  const [outTime, setOutTime] = useState("");
  const [breakMinutes, setBreakMinutes] = useState("0");
  const [lateMinutes, setLateMinutes] = useState("0");
  const [notes, setNotes] = useState("");

  const employee = useMemo(
    () => (employees.data ?? []).find((e) => String(e["id"]) === employeeId) ?? null,
    [employees.data, employeeId],
  );

  const worked = kind === "absent" ? 0 : minutesBetween(workDate, inTime, outTime);
  const net = Math.max(0, worked - Number(breakMinutes || 0));

  const duplicate = (existing ?? []).find(
    (r) => String(r["employee_id"]) === employeeId && String(r["work_date"]) === workDate,
  );

  const canSubmit =
    Boolean(employeeId) &&
    Boolean(workDate) &&
    (kind === "absent" || (Boolean(inTime) && Boolean(outTime) && net > 0)) &&
    (kind !== "absent" || notes.trim().length > 0);

  const reset = () => {
    setEmployeeId("");
    setWorkDate(today());
    setKind("worked");
    setInTime("");
    setOutTime("");
    setBreakMinutes("0");
    setLateMinutes("0");
    setNotes("");
  };

  const submit = () => {
    if (!employee) return;
    const values: Row = {
      employee_id: employeeId,
      branch_id: employee["branch_id"] ?? null,
      department_id: employee["department_id"] ?? null,
      work_date: workDate,
      source: "manual",
      status: kind === "absent" ? "absent" : "pending_review",
      exception: kind === "absent" ? "absent" : kind === "late" ? "late" : "",
      clock_in_at: kind === "absent" ? null : new Date(`${workDate}T${inTime}:00`).toISOString(),
      clock_out_at: kind === "absent" ? null : new Date(`${workDate}T${outTime}:00`).toISOString(),
      break_minutes: kind === "absent" ? 0 : Number(breakMinutes || 0),
      worked_minutes: net,
      late_minutes: kind === "absent" ? 0 : Number(lateMinutes || 0),
      notes: notes.trim(),
    };
    write.mutate(
      duplicate
        ? notes.trim()
          ? { id: String(duplicate["id"]), values, reason: notes.trim() }
          : { id: String(duplicate["id"]), values }
        : { values },
      {
        onSuccess: () => {
          toast.success(duplicate ? "Attendance record updated" : "Attendance recorded");
          reset();
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
      title="Log attendance"
      description="Record worked hours, lateness or an absence for one employee on one day."
      submitLabel={duplicate ? "Update record" : "Record attendance"}
      canSubmit={canSubmit && !write.isPending}
      busy={write.isPending}
      onSubmit={submit}
      footerNote={
        duplicate
          ? "A record already exists for this employee on this date — it will be updated, and the change is audited."
          : net > 0
            ? `Worked time: ${Math.floor(net / 60)}h ${net % 60}m after breaks.`
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
            <Label>Work date</Label>
            <NeoDatePicker value={workDate} onChange={(v) => setWorkDate(v ?? today())} />
          </div>
          <div className="grid gap-2">
            <Label>Record type</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="worked">Worked shift</SelectItem>
                <SelectItem value="late">Worked shift — arrived late</SelectItem>
                <SelectItem value="absent">Absent</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {kind !== "absent" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>Clock in</Label>
              <Input type="time" value={inTime} onChange={(e) => setInTime(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>Clock out</Label>
              <Input type="time" value={outTime} onChange={(e) => setOutTime(e.target.value)} />
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
              <Label>Late (minutes)</Label>
              <Input
                type="number"
                min={0}
                value={lateMinutes}
                onChange={(e) => setLateMinutes(e.target.value)}
              />
            </div>
          </div>
        ) : null}

        <div className="grid gap-2">
          <Label>{kind === "absent" ? "Reason for absence" : "Notes"}</Label>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={
              kind === "absent"
                ? "Why the employee was absent — this is kept on the record."
                : "Optional context for the supervisor reviewing this record."
            }
          />
        </div>
      </div>
    </FormDialog>
  );
}
