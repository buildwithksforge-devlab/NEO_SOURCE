import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Info, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { FormDialog } from "@/components/common/FormDialog";
import { FieldGrid } from "@/components/common/FormFields";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import { useEmployees, useLeaveBalances, useLeaveTypes } from "@/lib/hr-data";
import {
  balancePreview,
  countLeaveDays,
  policyBreaches,
  useApplyForLeave,
  useHolidayDates,
  uploadLeaveDocument,
} from "@/lib/hr-leave";
import { eligibleLeavePolicies, leaveApplicability } from "@/lib/hr-leave-eligibility";
import type { Row } from "@/lib/hr";

/**
 * Leave application.
 *
 * The days are counted for the applicant from the policy's own weekend and
 * public-holiday rules, the balance after approval is shown before anything is
 * submitted, and a request that breaks policy is named rather than silently
 * accepted. The database repeats every one of these checks on submit.
 */
export function LeaveApplyDialog({
  open,
  onOpenChange,
  employee,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  employee: Row;
}) {
  const { organizationId } = useAuth();
  const types = useLeaveTypes();
  const balances = useLeaveBalances(String(employee["id"]));
  const holidays = useHolidayDates();
  const colleagues = useEmployees({ status: "active" });
  const apply = useApplyForLeave();
  const fileInput = useRef<HTMLInputElement>(null);

  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");
  const [handover, setHandover] = useState("");
  const [actingId, setActingId] = useState("none");
  const [contact, setContact] = useState(String(employee["phone"] ?? ""));
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  // Only policies this person actually qualifies for are offered, judged by the
  // same applicability rules the database enforces on submit: employment type,
  // department, property, sex where the rule is statutory, minimum service and
  // the dates the policy is in force.
  const eligibleTypes = useMemo(
    () => eligibleLeavePolicies(employee, types.data ?? []),
    [types.data, employee],
  );
  const excluded = useMemo(
    () =>
      (types.data ?? [])
        .map((t) => ({ policy: t, fit: leaveApplicability(employee, t) }))
        .filter((x) => !x.fit.eligible && x.policy["active"] !== false),
    [types.data, employee],
  );

  const policy = useMemo(
    () => eligibleTypes.find((t) => String(t["id"]) === leaveTypeId) ?? null,
    [eligibleTypes, leaveTypeId],
  );
  const balance = useMemo(
    () => (balances.data ?? []).find((b) => String(b["leave_type_id"]) === leaveTypeId) ?? null,
    [balances.data, leaveTypeId],
  );

  const days = policy ? countLeaveDays(startDate, endDate, policy, holidays) : 0;
  const preview = balancePreview(balance, days);
  const breaches = policyBreaches({
    policy,
    balance,
    requestedDays: days,
    startDate,
    hasDocument: Boolean(file),
  });
  const blocked = breaches.some((b) => b.blocking);
  const ready = Boolean(leaveTypeId && startDate && endDate && days > 0 && reason.trim());

  function reset() {
    setLeaveTypeId("");
    setStartDate("");
    setEndDate("");
    setReason("");
    setHandover("");
    setActingId("none");
    setFile(null);
  }

  async function submit() {
    if (!ready || blocked || !organizationId) return;
    setBusy(true);
    try {
      let documentPath: string | null = null;
      if (file) {
        documentPath = await uploadLeaveDocument(organizationId, String(employee["id"]), file);
      }
      await apply.mutateAsync({
        employeeId: String(employee["id"]),
        leaveTypeId,
        startDate,
        endDate,
        reason: reason.trim(),
        handover: handover.trim(),
        actingEmployeeId: actingId === "none" ? null : actingId,
        documentPath,
        contact: contact.trim(),
      });
      reset();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not submit the request");
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Apply for leave"
      description="Days are counted from the rules of the leave type you choose."
      submitLabel="Submit request"
      busy={busy || apply.isPending}
      busyLabel="Submitting…"
      canSubmit={ready && !blocked}
      onSubmit={() => void submit()}
      footerNote={
        blocked
          ? "This request breaks company policy and cannot be submitted as it stands."
          : undefined
      }
    >
      <FieldGrid>
        <div className="space-y-1.5">
          <Label htmlFor="leave-type">Leave type</Label>
          <Select value={leaveTypeId} onValueChange={setLeaveTypeId}>
            <SelectTrigger id="leave-type">
              <SelectValue placeholder="Select leave type" />
            </SelectTrigger>
            <SelectContent>
              {eligibleTypes.map((t) => (
                <SelectItem key={String(t["id"])} value={String(t["id"])}>
                  {String(t["name"])} {t["paid"] ? "" : "(unpaid)"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {excluded.length ? (
            <p className="text-xs text-muted-foreground">
              Not offered here:{" "}
              {excluded
                .map((x) => `${String(x.policy["name"])} — ${x.fit.reasons[0]}`)
                .join("; ")}
              .
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="leave-contact">Contact while away</Label>
          <Input
            id="leave-contact"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            placeholder="Phone number"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="leave-start">First day</Label>
          <NeoDatePicker id="leave-start" value={startDate} onChange={setStartDate} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="leave-end">Last day</Label>
          <NeoDatePicker
            id="leave-end"
            value={endDate}
            onChange={setEndDate}
            min={startDate || undefined}
          />
        </div>
      </FieldGrid>

      <div className="space-y-1.5">
        <Label htmlFor="leave-reason">Reason</Label>
        <Textarea
          id="leave-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
        />
      </div>

      <FieldGrid>
        <div className="space-y-1.5">
          <Label htmlFor="leave-cover">Covering my duties</Label>
          <Select value={actingId} onValueChange={setActingId}>
            <SelectTrigger id="leave-cover">
              <SelectValue placeholder="Nobody assigned" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Nobody assigned</SelectItem>
              {(colleagues.data ?? [])
                .filter((c) => String(c["id"]) !== String(employee["id"]))
                .map((c) => (
                  <SelectItem key={String(c["id"])} value={String(c["id"])}>
                    {String(c["full_name"])}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="leave-doc">
            Supporting document {policy?.["requires_document"] ? "(required)" : "(optional)"}
          </Label>
          <input
            ref={fileInput}
            id="leave-doc"
            type="file"
            className="sr-only"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <Button
            type="button"
            variant="outline"
            className="w-full justify-start font-normal"
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip className="mr-2 size-4" aria-hidden />
            <span className="truncate">{file ? file.name : "Attach a file"}</span>
          </Button>
        </div>
      </FieldGrid>

      <div className="space-y-1.5">
        <Label htmlFor="leave-handover">Handover notes</Label>
        <Textarea
          id="leave-handover"
          value={handover}
          onChange={(e) => setHandover(e.target.value)}
          rows={2}
          placeholder="What the person covering needs to know."
        />
      </div>

      {leaveTypeId ? (
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
          <div className="flex justify-between py-0.5">
            <span className="text-muted-foreground">Available balance</span>
            <span className="font-medium">{preview.available} days</span>
          </div>
          <div className="flex justify-between py-0.5">
            <span className="text-muted-foreground">Requested</span>
            <span className="font-medium">{preview.requested} days</span>
          </div>
          <div className="flex justify-between border-t border-border/60 pt-1.5">
            <span className="text-muted-foreground">Balance after approval</span>
            <span className="font-semibold">{preview.after} days</span>
          </div>
          <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {policy?.["counts_weekends"] === false ? "Weekends are not counted. " : ""}
            {policy?.["counts_public_holidays"] === false
              ? "Configured public holidays are not counted."
              : "Every calendar day in the range is counted."}
          </p>
        </div>
      ) : null}

      {breaches.length ? (
        <ul className="space-y-1.5">
          {breaches.map((b) => (
            <li
              key={b.code}
              className={
                b.blocking
                  ? "flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
                  : "flex items-start gap-2 rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground"
              }
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                {b.detail}
                {b.blocking ? "" : " The approver will see this flagged."}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </FormDialog>
  );
}
