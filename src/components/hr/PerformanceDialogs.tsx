/**
 * Performance lifecycle dialogs.
 *
 * Cycles, appraisals and their outcomes are written to the same records the
 * profile and timeline read, so a rating recorded here is the rating the
 * employee's file shows. Nothing is graded automatically.
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
  usePerformanceCycles,
} from "@/lib/hr-data";
import { today, type Row } from "@/lib/hr";

const CYCLE_TYPES = [
  { value: "probation", label: "Probation" },
  { value: "quarterly", label: "Quarterly" },
  { value: "mid_year", label: "Mid-year" },
  { value: "annual", label: "Annual" },
] as const;

/** Open a review cycle before any appraisal can be raised against it. */
export function PerformanceCycleDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const departments = useDepartmentsLookup();
  const branches = useBranchesLookup();
  const write = useHrWrite("performance_cycles", { action: "hr.performance.cycle_created" });

  const [name, setName] = useState("");
  const [cycleType, setCycleType] = useState<string>("annual");
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState(today());
  const [departmentId, setDepartmentId] = useState("");
  const [branchId, setBranchId] = useState("");

  const canSubmit = Boolean(name.trim()) && end >= start;

  const submit = () => {
    write.mutate(
      {
        values: {
          name: name.trim(),
          cycle_type: cycleType,
          period_start: start,
          period_end: end,
          department_id: departmentId || null,
          branch_id: branchId || null,
          status: "planned",
        },
      },
      {
        onSuccess: () => {
          toast.success("Review cycle created");
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
      title="New review cycle"
      description="A cycle groups appraisals for one period. Leaving department or property blank covers everyone."
      submitLabel="Create cycle"
      canSubmit={canSubmit && !write.isPending}
      busy={write.isPending}
      onSubmit={submit}
      size="md"
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label>Cycle name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Annual appraisal 2026"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label>Cycle type</Label>
            <Select value={cycleType} onValueChange={setCycleType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CYCLE_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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

/** Raise an appraisal for one employee inside a cycle. */
export function PerformanceReviewDialog({
  open,
  onOpenChange,
  employeeId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  employeeId?: string;
}) {
  const employees = useEmployees({ status: "active" });
  const cycles = usePerformanceCycles();
  const write = useHrWrite("performance_reviews", { action: "hr.performance.review_created" });

  const [employee, setEmployee] = useState(employeeId ?? "");
  const [cycleId, setCycleId] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [dueDate, setDueDate] = useState(today());

  const chosen = useMemo(
    () => (employees.data ?? []).find((e) => String(e["id"]) === employee) ?? null,
    [employees.data, employee],
  );
  const cycle = useMemo(
    () => (cycles.data ?? []).find((c) => String(c["id"]) === cycleId) ?? null,
    [cycles.data, cycleId],
  );

  const canSubmit = Boolean(employee);

  const submit = () => {
    write.mutate(
      {
        values: {
          employee_id: employee,
          cycle_id: cycleId || null,
          reviewer_id: reviewerId || (chosen?.["reporting_manager_id"] ?? null),
          department_id: chosen?.["department_id"] ?? null,
          review_type: String(cycle?.["cycle_type"] ?? "annual"),
          due_date: dueDate || null,
          status: "draft",
        },
      },
      {
        onSuccess: () => {
          toast.success("Appraisal opened as a draft");
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Open an appraisal"
      description="The appraisal stays a draft until the reviewer records the outcome."
      submitLabel="Open appraisal"
      canSubmit={canSubmit && !write.isPending}
      busy={write.isPending}
      onSubmit={submit}
      size="md"
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label>Employee</Label>
          <Select value={employee} onValueChange={setEmployee}>
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
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label>Cycle (optional)</Label>
            <Select value={cycleId} onValueChange={setCycleId}>
              <SelectTrigger>
                <SelectValue placeholder="No cycle" />
              </SelectTrigger>
              <SelectContent>
                {(cycles.data ?? []).map((c) => (
                  <SelectItem key={String(c["id"])} value={String(c["id"])}>
                    {String(c["name"])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Reviewer</Label>
            <Select value={reviewerId} onValueChange={setReviewerId}>
              <SelectTrigger>
                <SelectValue placeholder="Reporting manager" />
              </SelectTrigger>
              <SelectContent>
                {(employees.data ?? []).map((e) => (
                  <SelectItem key={String(e["id"])} value={String(e["id"])}>
                    {String(e["full_name"])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Due date</Label>
            <NeoDatePicker value={dueDate} onChange={(v) => setDueDate(v ?? today())} />
          </div>
        </div>
      </div>
    </FormDialog>
  );
}

/** Record the outcome of an appraisal and decide whether the employee sees it. */
export function PerformanceOutcomeDialog({
  open,
  onOpenChange,
  review,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  review: Row;
}) {
  const write = useHrWrite("performance_reviews", { action: "hr.performance.review_completed" });

  const [rating, setRating] = useState(
    review["final_rating"] == null ? "" : String(review["final_rating"]),
  );
  const [assessment, setAssessment] = useState(String(review["supervisor_assessment"] ?? ""));
  const [plan, setPlan] = useState(String(review["development_plan"] ?? ""));
  const [release, setRelease] = useState(Boolean(review["released_to_employee"]));

  const ratingValue = rating.trim() === "" ? null : Number(rating);
  const ratingValid =
    ratingValue == null || (Number.isFinite(ratingValue) && ratingValue >= 0 && ratingValue <= 5);
  const canSubmit = Boolean(assessment.trim()) && ratingValid;

  const submit = () => {
    write.mutate(
      {
        id: String(review["id"]),
        values: {
          final_rating: ratingValue,
          supervisor_assessment: assessment.trim(),
          development_plan: plan.trim(),
          released_to_employee: release,
          status: "completed",
          updated_at: new Date().toISOString(),
        },
        reason: "Appraisal outcome recorded",
      },
      {
        onSuccess: () => {
          toast.success(
            release ? "Appraisal completed and released" : "Appraisal completed, not yet released",
          );
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Record appraisal outcome"
      description="The rating and comments become part of the employee's permanent file."
      submitLabel="Complete appraisal"
      canSubmit={canSubmit && !write.isPending}
      busy={write.isPending}
      onSubmit={submit}
      size="md"
      footerNote={ratingValid ? undefined : "Rating must be between 0 and 5."}
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label>Overall rating (0–5, optional)</Label>
          <Input
            value={rating}
            onChange={(e) => setRating(e.target.value)}
            inputMode="decimal"
            placeholder="e.g. 4.2"
          />
        </div>
        <div className="grid gap-2">
          <Label>Supervisor assessment</Label>
          <Textarea
            rows={4}
            value={assessment}
            onChange={(e) => setAssessment(e.target.value)}
            placeholder="What the employee did well and where they must improve"
          />
        </div>
        <div className="grid gap-2">
          <Label>Development plan</Label>
          <Textarea
            rows={3}
            value={plan}
            onChange={(e) => setPlan(e.target.value)}
            placeholder="Agreed training, coaching or targets"
          />
        </div>
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-medium">Release to the employee</p>
            <p className="text-xs text-muted-foreground">
              Until released, only HR and the reviewer can read the outcome.
            </p>
          </div>
          <Switch checked={release} onCheckedChange={setRelease} />
        </div>
      </div>
    </FormDialog>
  );
}
