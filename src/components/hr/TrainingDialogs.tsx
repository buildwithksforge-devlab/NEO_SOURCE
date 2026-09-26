/**
 * Training lifecycle dialogs.
 *
 * Courses, sessions, attendance lists and completion all write to the training
 * records the employee profile and timeline read, so a completed course shows
 * on the person's file without a second entry.
 */

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { FormDialog } from "@/components/common/FormDialog";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
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
  useTrainingCourses,
  useTrainingParticipants,
} from "@/lib/hr-data";
import { today, type Row } from "@/lib/hr";

const TRAINING_TYPES = [
  { value: "orientation", label: "Orientation" },
  { value: "safety", label: "Safety" },
  { value: "service", label: "Service" },
  { value: "compliance", label: "Compliance" },
  { value: "technical", label: "Technical" },
  { value: "leadership", label: "Leadership" },
] as const;

/** Add a course to the catalogue. */
export function TrainingCourseDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const write = useHrWrite("training_courses", { action: "hr.training.course_created" });

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("orientation");
  const [provider, setProvider] = useState("");
  const [description, setDescription] = useState("");
  const [mandatory, setMandatory] = useState(false);
  const [validity, setValidity] = useState("");

  const months = validity.trim() === "" ? 0 : Number(validity);
  const canSubmit =
    Boolean(code.trim()) && Boolean(name.trim()) && Number.isFinite(months) && months >= 0;

  const submit = () => {
    write.mutate(
      {
        values: {
          code: code.trim().toUpperCase(),
          name: name.trim(),
          training_type: type,
          provider: provider.trim(),
          description: description.trim(),
          mandatory,
          validity_months: Math.round(months),
        },
      },
      {
        onSuccess: () => {
          toast.success("Course added");
          setCode("");
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
      title="New course"
      description="Courses are reusable. Sessions schedule a course on a date with a trainer."
      submitLabel="Add course"
      canSubmit={canSubmit && !write.isPending}
      busy={write.isPending}
      onSubmit={submit}
      size="md"
    >
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label>Course code</Label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. FS-01"
            />
          </div>
          <div className="grid gap-2">
            <Label>Course name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Food safety level 1"
            />
          </div>
          <div className="grid gap-2">
            <Label>Type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRAINING_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Valid for (months, 0 = no expiry)</Label>
            <Input
              value={validity}
              onChange={(e) => setValidity(e.target.value)}
              inputMode="numeric"
              placeholder="e.g. 12"
            />
          </div>
          <div className="grid gap-2">
            <Label>Provider (optional)</Label>
            <Input value={provider} onChange={(e) => setProvider(e.target.value)} />
          </div>
        </div>
        <div className="grid gap-2">
          <Label>Description (optional)</Label>
          <Textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-medium">Mandatory course</p>
            <p className="text-xs text-muted-foreground">
              Mandatory courses are tracked as outstanding until every employee completes them.
            </p>
          </div>
          <Switch checked={mandatory} onCheckedChange={setMandatory} />
        </div>
      </div>
    </FormDialog>
  );
}

/** Schedule a course on a date. */
export function TrainingSessionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const courses = useTrainingCourses();
  const departments = useDepartmentsLookup();
  const branches = useBranchesLookup();
  const write = useHrWrite("training_sessions", { action: "hr.training.session_scheduled" });

  const [courseId, setCourseId] = useState("");
  const [date, setDate] = useState(today());
  const [time, setTime] = useState("");
  const [location, setLocation] = useState("");
  const [trainer, setTrainer] = useState("");
  const [capacity, setCapacity] = useState("20");
  const [departmentId, setDepartmentId] = useState("");
  const [branchId, setBranchId] = useState("");

  const seats = Number(capacity);
  const canSubmit = Boolean(courseId) && Number.isFinite(seats) && seats > 0;

  const submit = () => {
    write.mutate(
      {
        values: {
          course_id: courseId,
          session_date: date,
          session_time: time || null,
          location: location.trim(),
          trainer: trainer.trim(),
          capacity: Math.round(seats),
          department_id: departmentId || null,
          branch_id: branchId || null,
          status: "scheduled",
        },
      },
      {
        onSuccess: () => {
          toast.success("Session scheduled");
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Schedule a session"
      submitLabel="Schedule session"
      canSubmit={canSubmit && !write.isPending}
      busy={write.isPending}
      onSubmit={submit}
      size="md"
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label>Course</Label>
          <Select value={courseId} onValueChange={setCourseId}>
            <SelectTrigger>
              <SelectValue placeholder="Select course" />
            </SelectTrigger>
            <SelectContent>
              {(courses.data ?? []).map((c) => (
                <SelectItem key={String(c["id"])} value={String(c["id"])}>
                  {String(c["name"])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label>Date</Label>
            <NeoDatePicker value={date} onChange={(v) => setDate(v ?? today())} />
          </div>
          <div className="grid gap-2">
            <Label>Start time (optional)</Label>
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>Trainer</Label>
            <Input value={trainer} onChange={(e) => setTrainer(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>Location</Label>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>Seats</Label>
            <Input
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              inputMode="numeric"
            />
          </div>
          <div className="grid gap-2">
            <Label>Department (optional)</Label>
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger>
                <SelectValue placeholder="All departments" />
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
            <Label>Property (optional)</Label>
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger>
                <SelectValue placeholder="All properties" />
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
      </div>
    </FormDialog>
  );
}

/** Put an employee on a scheduled session. */
export function TrainingAssignDialog({
  open,
  onOpenChange,
  session,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  session: Row;
}) {
  const employees = useEmployees({ status: "active" });
  const participants = useTrainingParticipants(String(session["id"]));
  const write = useHrWrite("training_participants", { action: "hr.training.participant_assigned" });

  const [employeeId, setEmployeeId] = useState("");

  const taken = useMemo(
    () => new Set((participants.data ?? []).map((p) => String(p["employee_id"]))),
    [participants.data],
  );
  const seatsLeft = Number(session["capacity"] ?? 0) - (participants.data ?? []).length;
  const already = taken.has(employeeId);
  const canSubmit = Boolean(employeeId) && !already && seatsLeft > 0;

  const submit = () => {
    write.mutate(
      {
        values: {
          session_id: session["id"],
          employee_id: employeeId,
          attendance_status: "assigned",
          completion_status: "pending",
        },
      },
      {
        onSuccess: () => {
          toast.success("Employee added to the session");
          setEmployeeId("");
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add an attendee"
      description={`${Math.max(seatsLeft, 0)} seat(s) remaining on this session.`}
      submitLabel="Add attendee"
      canSubmit={canSubmit && !write.isPending}
      busy={write.isPending}
      onSubmit={submit}
      size="md"
      footerNote={
        already
          ? "This employee is already on the session."
          : seatsLeft <= 0
            ? "The session is full — raise the seat count first."
            : undefined
      }
    >
      <div className="grid gap-2">
        <Label>Employee</Label>
        <Select value={employeeId} onValueChange={setEmployeeId}>
          <SelectTrigger>
            <SelectValue placeholder="Select employee" />
          </SelectTrigger>
          <SelectContent>
            {(employees.data ?? []).map((e) => (
              <SelectItem key={String(e["id"])} value={String(e["id"])}>
                {String(e["full_name"])} — {String(e["job_title"] ?? "no title")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </FormDialog>
  );
}

/** Record what actually happened for one attendee. */
export function TrainingCompletionDialog({
  open,
  onOpenChange,
  participant,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  participant: Row;
}) {
  const write = useHrWrite("training_participants", { action: "hr.training.completion_recorded" });

  const [attendance, setAttendance] = useState(
    String(participant["attendance_status"] ?? "attended"),
  );
  const [completion, setCompletion] = useState(
    String(participant["completion_status"] ?? "completed"),
  );
  const [score, setScore] = useState(
    participant["score"] == null ? "" : String(participant["score"]),
  );
  const [expiry, setExpiry] = useState(String(participant["certificate_expiry"] ?? ""));
  const [feedback, setFeedback] = useState(String(participant["feedback"] ?? ""));

  const scoreValue = score.trim() === "" ? null : Number(score);
  const scoreValid = scoreValue == null || (Number.isFinite(scoreValue) && scoreValue >= 0);
  const canSubmit = scoreValid;

  const submit = () => {
    write.mutate(
      {
        id: String(participant["id"]),
        values: {
          attendance_status: attendance,
          completion_status: completion,
          score: scoreValue,
          certificate_expiry: expiry || null,
          feedback: feedback.trim(),
          completed_at: completion === "completed" ? new Date().toISOString() : null,
        },
        reason: "Training outcome recorded",
      },
      {
        onSuccess: () => {
          toast.success("Training record updated");
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Record training outcome"
      submitLabel="Save outcome"
      canSubmit={canSubmit && !write.isPending}
      busy={write.isPending}
      onSubmit={submit}
      size="md"
      footerNote={scoreValid ? undefined : "Score must be a number."}
    >
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label>Attendance</Label>
            <Select value={attendance} onValueChange={setAttendance}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="assigned">Assigned</SelectItem>
                <SelectItem value="attended">Attended</SelectItem>
                <SelectItem value="absent">Did not attend</SelectItem>
                <SelectItem value="excused">Excused</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Outcome</Label>
            <Select value={completion} onValueChange={setCompletion}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Not passed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Score (optional)</Label>
            <Input value={score} onChange={(e) => setScore(e.target.value)} inputMode="decimal" />
          </div>
          <div className="grid gap-2">
            <Label>Certificate expiry (optional)</Label>
            <NeoDatePicker value={expiry} onChange={(v) => setExpiry(v ?? "")} />
          </div>
        </div>
        <div className="grid gap-2">
          <Label>Notes (optional)</Label>
          <Textarea rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        </div>
      </div>
    </FormDialog>
  );
}
