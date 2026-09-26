/**
 * Recruitment actions — the clickable half of the Applicant → Employee chain.
 *
 * Every dialog writes through the same RLS-scoped, audited `useHrWrite` helper
 * the rest of HR uses. Nothing here invents a person, a salary or a decision:
 * each field is typed by the recruiter, and hiring only converts a candidate
 * whose offer has actually been accepted.
 */

import { useState } from "react";
import { toast } from "sonner";
import { FormDialog } from "@/components/common/FormDialog";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { Button } from "@/components/ui/button";
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
import { guardedRpc } from "@/lib/rpc-guard";
import { supabase } from "@/integrations/supabase/client";
import {
  useBranchesLookup,
  useCandidates,
  useConvertCandidate,
  useDepartmentsLookup,
  useHrWrite,
  useVacancies,
} from "@/lib/hr-data";
import { EMPLOYMENT_TYPES, today, type Row } from "@/lib/hr";

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = supabase as any;

async function reference(docType: string, prefix: string): Promise<string> {
  const { data, error } = await guardedRpc(db, "next_document_number", {
    _doc_type: docType,
    _prefix: prefix,
  });
  if (error) throw error;
  if (!data) throw new Error("Could not allocate a reference number.");
  return String(data);
}

/* -------------------------------- vacancy -------------------------------- */

export function VacancyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const departments = useDepartmentsLookup();
  const branches = useBranchesLookup();
  const write = useHrWrite("vacancies", { action: "hr.vacancy.created" });

  const [jobTitle, setJobTitle] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [positions, setPositions] = useState("1");
  const [employmentType, setEmploymentType] = useState("permanent");
  const [targetStart, setTargetStart] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const count = Number(positions);
  const canSubmit =
    Boolean(jobTitle.trim()) &&
    Boolean(departmentId) &&
    Number.isInteger(count) &&
    count > 0 &&
    Boolean(reason.trim());

  const submit = async () => {
    setBusy(true);
    try {
      const number = await reference("vacancy", "VAC");
      write.mutate(
        {
          values: {
            vacancy_number: number,
            job_title: jobTitle.trim(),
            department_id: departmentId,
            branch_id: branchId || null,
            positions: count,
            employment_type: employmentType,
            target_start_date: targetStart,
            reason: reason.trim(),
            status: "draft",
          },
        },
        {
          onSuccess: () => {
            toast.success(`Vacancy ${number} raised as a draft`);
            setJobTitle("");
            setReason("");
            onOpenChange(false);
          },
        },
      );
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Raise a vacancy"
      description="A vacancy belongs to one department and is approved before it is opened to candidates."
      submitLabel="Raise vacancy"
      canSubmit={canSubmit && !busy && !write.isPending}
      busy={busy || write.isPending}
      onSubmit={submit}
      size="md"
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label>Position title</Label>
          <Input
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
            placeholder="e.g. Night Receptionist"
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
            <Label>Positions</Label>
            <Input
              type="number"
              min={1}
              value={positions}
              onChange={(e) => setPositions(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label>Employment type</Label>
            <Select value={employmentType} onValueChange={setEmploymentType}>
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
          <div className="grid gap-2">
            <Label>Target start date</Label>
            <NeoDatePicker value={targetStart} onChange={(v) => setTargetStart(v ?? null)} />
          </div>
        </div>
        <div className="grid gap-2">
          <Label>Reason for the vacancy</Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Replacement, new position, seasonal cover…"
            rows={3}
          />
        </div>
      </div>
    </FormDialog>
  );
}

/* ------------------------------- candidate ------------------------------- */

const CANDIDATE_SOURCES = ["direct", "referral", "agency", "walk_in", "website", "internal"];

export function CandidateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const vacancies = useVacancies();
  const write = useHrWrite("candidates", { action: "hr.candidate.created" });

  const [vacancyId, setVacancyId] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [source, setSource] = useState("direct");
  const [qualifications, setQualifications] = useState("");
  const [busy, setBusy] = useState(false);

  const canSubmit = Boolean(fullName.trim()) && Boolean(vacancyId);

  const submit = async () => {
    setBusy(true);
    try {
      const number = await reference("candidate", "CAN");
      write.mutate(
        {
          values: {
            candidate_number: number,
            vacancy_id: vacancyId,
            full_name: fullName.trim(),
            email: email.trim(),
            phone: phone.trim(),
            source,
            qualifications: qualifications.trim(),
            status: "applied",
          },
        },
        {
          onSuccess: () => {
            toast.success(`Candidate ${number} captured`);
            setFullName("");
            setEmail("");
            setPhone("");
            setQualifications("");
            onOpenChange(false);
          },
        },
      );
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Capture a candidate"
      description="A candidate is not an employee and never receives a login. Only an accepted offer creates an employee record."
      submitLabel="Capture candidate"
      canSubmit={canSubmit && !busy && !write.isPending}
      busy={busy || write.isPending}
      onSubmit={submit}
      size="md"
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label>Applied for</Label>
          <Select value={vacancyId} onValueChange={setVacancyId}>
            <SelectTrigger>
              <SelectValue placeholder="Select vacancy" />
            </SelectTrigger>
            <SelectContent>
              {(vacancies.data ?? []).map((v) => (
                <SelectItem key={String(v["id"])} value={String(v["id"])}>
                  {String(v["vacancy_number"])} — {String(v["job_title"])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label>Full name</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>Source</Label>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CANDIDATE_SOURCES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Email</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
          </div>
          <div className="grid gap-2">
            <Label>Phone</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
        </div>
        <div className="grid gap-2">
          <Label>Qualifications</Label>
          <Textarea
            value={qualifications}
            onChange={(e) => setQualifications(e.target.value)}
            rows={3}
          />
        </div>
      </div>
    </FormDialog>
  );
}

/* ------------------------------- interview ------------------------------- */

const INTERVIEW_TYPES = ["in_person", "phone", "video", "panel", "practical"];

export function InterviewDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const candidates = useCandidates();
  const write = useHrWrite("interviews", { action: "hr.interview.scheduled" });

  const [candidateId, setCandidateId] = useState("");
  const [date, setDate] = useState<string | null>(today());
  const [time, setTime] = useState("09:00");
  const [type, setType] = useState("in_person");
  const [duration, setDuration] = useState("45");
  const [location, setLocation] = useState("");

  const minutes = Number(duration);
  const canSubmit =
    Boolean(candidateId) && Boolean(date) && /^\d{2}:\d{2}$/.test(time) && minutes > 0;

  const submit = () => {
    const when = new Date(`${date}T${time}:00`);
    if (Number.isNaN(when.getTime())) {
      toast.error("Enter a valid interview date and time.");
      return;
    }
    write.mutate(
      {
        values: {
          candidate_id: candidateId,
          scheduled_at: when.toISOString(),
          interview_type: type,
          duration_minutes: minutes,
          location: location.trim(),
          status: "scheduled",
        },
      },
      {
        onSuccess: () => {
          toast.success("Interview scheduled");
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Schedule an interview"
      description="Panel members only see the interviews they sit on."
      submitLabel="Schedule interview"
      canSubmit={canSubmit && !write.isPending}
      busy={write.isPending}
      onSubmit={submit}
      size="md"
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label>Candidate</Label>
          <Select value={candidateId} onValueChange={setCandidateId}>
            <SelectTrigger>
              <SelectValue placeholder="Select candidate" />
            </SelectTrigger>
            <SelectContent>
              {(candidates.data ?? []).map((c) => (
                <SelectItem key={String(c["id"])} value={String(c["id"])}>
                  {String(c["full_name"])}
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
            <Label>Time</Label>
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>Interview type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTERVIEW_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Duration (minutes)</Label>
            <Input
              type="number"
              min={5}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </div>
        </div>
        <div className="grid gap-2">
          <Label>Location or link</Label>
          <Input value={location} onChange={(e) => setLocation(e.target.value)} />
        </div>
      </div>
    </FormDialog>
  );
}

/* --------------------------------- offer --------------------------------- */

export function OfferDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const candidates = useCandidates();
  const departments = useDepartmentsLookup();
  const branches = useBranchesLookup();
  const write = useHrWrite("employment_offers", { action: "hr.offer.created" });

  const [candidateId, setCandidateId] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [employmentType, setEmploymentType] = useState("permanent");
  const [start, setStart] = useState<string | null>(today());
  const [departmentId, setDepartmentId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [probation, setProbation] = useState("3");
  const [compensation, setCompensation] = useState("");

  const chosen = (candidates.data ?? []).find((c) => String(c["id"]) === candidateId) ?? null;
  const vacancyId = (chosen?.["vacancy_id"] as string | undefined) ?? null;
  const canSubmit = Boolean(candidateId) && Boolean(jobTitle.trim()) && Boolean(start);

  const submit = () => {
    write.mutate(
      {
        values: {
          candidate_id: candidateId,
          vacancy_id: vacancyId,
          job_title: jobTitle.trim(),
          employment_type: employmentType,
          proposed_start_date: start,
          department_id: departmentId || null,
          branch_id: branchId || null,
          probation_months: Number(probation) || 0,
          compensation_summary: compensation.trim(),
          approval_status: "draft",
          acceptance_status: "pending",
        },
      },
      {
        onSuccess: async () => {
          await db.from("candidates").update({ status: "offer" }).eq("id", candidateId);
          toast.success("Offer drafted");
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Issue an offer"
      description="An offer is approved first, then recorded as accepted or declined by the candidate."
      submitLabel="Create offer"
      canSubmit={canSubmit && !write.isPending}
      busy={write.isPending}
      onSubmit={submit}
      size="md"
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label>Candidate</Label>
          <Select value={candidateId} onValueChange={setCandidateId}>
            <SelectTrigger>
              <SelectValue placeholder="Select candidate" />
            </SelectTrigger>
            <SelectContent>
              {(candidates.data ?? []).map((c) => (
                <SelectItem key={String(c["id"])} value={String(c["id"])}>
                  {String(c["full_name"])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label>Position title</Label>
            <Input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>Employment type</Label>
            <Select value={employmentType} onValueChange={setEmploymentType}>
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
          <div className="grid gap-2">
            <Label>Proposed start date</Label>
            <NeoDatePicker value={start} onChange={(v) => setStart(v ?? today())} />
          </div>
          <div className="grid gap-2">
            <Label>Probation (months)</Label>
            <Input
              type="number"
              min={0}
              value={probation}
              onChange={(e) => setProbation(e.target.value)}
            />
          </div>
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
        </div>
        <div className="grid gap-2">
          <Label>Compensation summary</Label>
          <Textarea
            value={compensation}
            onChange={(e) => setCompensation(e.target.value)}
            rows={3}
            placeholder="Recorded exactly as offered — pay is never derived by the system."
          />
        </div>
      </div>
    </FormDialog>
  );
}

/* ---------------------------------- hire --------------------------------- */

/** Convert an accepted offer into an employee record. Never creates a login. */
export function HireDialog({
  offer,
  candidate,
  open,
  onOpenChange,
}: {
  offer: Row;
  candidate: Row | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const convert = useConvertCandidate();
  const [employeeNumber, setEmployeeNumber] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!candidate) {
      toast.error("This offer has no candidate record to convert.");
      return;
    }
    setBusy(true);
    try {
      const number = employeeNumber.trim() || (await reference("employee", "EMP"));
      convert.mutate(
        { candidate, offer, employeeNumber: number },
        { onSuccess: () => onOpenChange(false) },
      );
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Hire into an employee record"
      description="The employee record starts in onboarding and is held back from payroll until HR completes the employment terms. No login is created."
      submitLabel="Create employee record"
      canSubmit={Boolean(candidate) && !busy && !convert.isPending}
      busy={busy || convert.isPending}
      onSubmit={submit}
      size="md"
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label>Staff number</Label>
          <Input
            value={employeeNumber}
            onChange={(e) => setEmployeeNumber(e.target.value)}
            placeholder="Leave blank to allocate the next reference"
          />
        </div>
        <p className="rounded-lg border border-dashed border-border/70 bg-muted/40 p-3 text-xs text-muted-foreground">
          {candidate ? String(candidate["full_name"]) : "This candidate"} will be created as an
          employee for {String(offer["job_title"] ?? "the offered position")}, starting{" "}
          {String(offer["proposed_start_date"] ?? "on a date HR confirms")}.
        </p>
      </div>
    </FormDialog>
  );
}

/** Small inline status action used in the recruitment tables. */
export function RowAction({
  label,
  onClick,
  busy,
}: {
  label: string;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <Button size="sm" variant="outline" onClick={onClick} disabled={busy}>
      {label}
    </Button>
  );
}
