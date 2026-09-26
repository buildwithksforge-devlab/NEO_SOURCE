import { useState } from "react";
import { toast } from "sonner";
import { FormDialog } from "@/components/common/FormDialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useHrWrite } from "@/lib/hr-data";
import { clockTime, shortDate, type Row } from "@/lib/hr";

function timeValue(value: unknown): string {
  if (!value) return "";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Employee-raised attendance correction.
 *
 * The employee asks for the times they believe are right and says why. Nothing
 * on the attendance record itself changes here — a supervisor decides, and the
 * request keeps both the recorded and requested values for the audit trail.
 */
export function AttendanceCorrectionDialog({
  open,
  onOpenChange,
  record,
  employee,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  record: Row | null;
  employee: Row;
}) {
  const write = useHrWrite("attendance_corrections", { action: "hr.attendance.correction_requested" });
  const workDate = record ? String(record["work_date"]) : "";
  const [inTime, setInTime] = useState("");
  const [outTime, setOutTime] = useState("");
  const [reason, setReason] = useState("");

  const reset = () => {
    setInTime("");
    setOutTime("");
    setReason("");
  };

  const canSubmit = Boolean(record) && reason.trim().length > 0 && (Boolean(inTime) || Boolean(outTime));

  const submit = () => {
    if (!record) return;
    const requestedIn = inTime ? new Date(`${workDate}T${inTime}:00`).toISOString() : null;
    const requestedOut = outTime ? new Date(`${workDate}T${outTime}:00`).toISOString() : null;
    write.mutate(
      {
        values: {
          attendance_id: record["id"],
          employee_id: employee["id"],
          correction_type:
            requestedIn && requestedOut ? "both" : requestedIn ? "clock_in" : "clock_out",
          work_date: workDate,
          requested_clock_in: requestedIn,
          requested_clock_out: requestedOut,
          previous_value: {
            clock_in_at: record["clock_in_at"] ?? null,
            clock_out_at: record["clock_out_at"] ?? null,
          },
          new_value: { clock_in_at: requestedIn, clock_out_at: requestedOut },
          reason: reason.trim(),
          status: "pending_supervisor",
        } as Row,
        reason: reason.trim(),
      },
      {
        onSuccess: () => {
          toast.success("Correction request sent to your supervisor");
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
      title="Request an attendance correction"
      description={
        record
          ? `Recorded on ${shortDate(record["work_date"])}: in ${clockTime(record["clock_in_at"])}, out ${clockTime(record["clock_out_at"])}.`
          : ""
      }
      submitLabel="Send request"
      canSubmit={canSubmit && !write.isPending}
      busy={write.isPending}
      onSubmit={submit}
      footerNote="Your supervisor decides. The recorded times stay unchanged until then."
      size="md"
    >
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label>Correct clock in</Label>
            <Input
              type="time"
              value={inTime}
              onChange={(e) => setInTime(e.target.value)}
              placeholder={timeValue(record?.["clock_in_at"])}
            />
          </div>
          <div className="grid gap-2">
            <Label>Correct clock out</Label>
            <Input type="time" value={outTime} onChange={(e) => setOutTime(e.target.value)} />
          </div>
        </div>
        <div className="grid gap-2">
          <Label>Why this needs correcting</Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Explain what happened on the day."
          />
        </div>
      </div>
    </FormDialog>
  );
}
