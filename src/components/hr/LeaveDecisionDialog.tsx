import { useState } from "react";
import { CalendarClock, Users } from "lucide-react";
import { FormDialog } from "@/components/common/FormDialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { HrBadge } from "@/components/hr/HrShared";
import {
  availableDays,
  useDecideLeaveRequest,
  useLeaveLedger,
  useTeamLeaveOverlap,
  type LeaveDecision,
} from "@/lib/hr-leave";
import { useLeaveBalances, useLeaveRequests } from "@/lib/hr-data";
import {
  LEAVE_STATUSES,
  labelFor,
  shortDate,
  shortDateTime,
  titleCase,
  toneFor,
  type Row,
} from "@/lib/hr";

const DECISIONS: { key: LeaveDecision; label: string; variant: "default" | "outline" }[] = [
  { key: "approve", label: "Approve", variant: "default" },
  { key: "reject", label: "Reject", variant: "outline" },
  { key: "return", label: "Return for amendment", variant: "outline" },
  { key: "cancel", label: "Cancel request", variant: "outline" },
];

function Line({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border/50 py-1.5 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

/**
 * Decision panel: the request is never judged in isolation — the employee's
 * balance, their recent leave and everyone else in the department already away
 * over the same dates are all on screen before a decision is taken.
 */
export function LeaveDecisionDialog({
  request,
  onOpenChange,
}: {
  request: Row | null;
  onOpenChange: (v: boolean) => void;
}) {
  const [note, setNote] = useState("");
  const decide = useDecideLeaveRequest();

  const employeeId = request ? String(request["employee_id"]) : undefined;
  const balances = useLeaveBalances(employeeId);
  const history = useLeaveRequests(employeeId);
  const overlap = useTeamLeaveOverlap(
    request?.["department_id"] as string | null,
    String(request?.["start_date"] ?? ""),
    String(request?.["end_date"] ?? ""),
  );
  const ledger = useLeaveLedger(request ? String(request["id"]) : undefined);

  if (!request) return null;

  const balance =
    (balances.data ?? []).find(
      (b) => String(b["leave_type_id"]) === String(request["leave_type_id"]),
    ) ?? null;
  const others = (overlap.data ?? []).filter((r) => String(r["id"]) !== String(request["id"]));
  const previous = (history.data ?? []).filter((r) => String(r["id"]) !== String(request["id"]));

  function act(decision: LeaveDecision) {
    decide.mutate(
      { requestId: String(request!["id"]), decision, note: note.trim() },
      {
        onSuccess: () => {
          setNote("");
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <FormDialog
      open={Boolean(request)}
      onOpenChange={onOpenChange}
      size="xl"
      title={`Leave request — ${String((request["employees"] as Row | null)?.["full_name"] ?? "")}`}
      description="Approving moves the days automatically; the ledger and audit trail record the decision."
      submitLabel="Approve"
      busy={decide.isPending}
      busyLabel="Recording…"
      onSubmit={() => act("approve")}
      extraActions={
        <>
          {DECISIONS.filter((d) => d.key !== "approve").map((d) => (
            <Button
              key={d.key}
              type="button"
              variant={d.variant}
              disabled={decide.isPending}
              onClick={() => act(d.key)}
            >
              {d.label}
            </Button>
          ))}
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <Line label="Leave type" value={String((request["leave_types"] as Row | null)?.["name"] ?? "—")} />
          <Line
            label="Dates"
            value={`${shortDate(request["start_date"])} → ${shortDate(request["end_date"])}`}
          />
          <Line label="Days requested" value={`${Number(request["days"] ?? 0)}`} />
          <Line
            label="Department"
            value={String((request["departments"] as Row | null)?.["name"] ?? "—")}
          />
          <Line
            label="Status"
            value={
              <HrBadge
                value={labelFor(LEAVE_STATUSES, request["status"])}
                tone={toneFor(LEAVE_STATUSES, request["status"])}
              />
            }
          />
          <Line label="Balance available" value={`${availableDays(balance)} days`} />
          <Line label="Reason" value={String(request["reason"] ?? "—")} />
          <Line label="Handover" value={String(request["handover_notes"] ?? "—")} />
        </div>

        <div className="space-y-4">
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Users className="size-3.5" aria-hidden /> Also away on these dates
            </p>
            {others.length ? (
              <ul className="space-y-1 text-sm">
                {others.map((o) => (
                  <li key={String(o["id"])} className="flex justify-between gap-3">
                    <span className="truncate">
                      {String((o["employees"] as Row | null)?.["full_name"] ?? "—")}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {shortDate(o["start_date"])} → {shortDate(o["end_date"])}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nobody else in this department is away over these dates.
              </p>
            )}
          </div>

          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <CalendarClock className="size-3.5" aria-hidden /> Previous leave
            </p>
            {previous.length ? (
              <ul className="space-y-1 text-sm">
                {previous.slice(0, 5).map((p) => (
                  <li key={String(p["id"])} className="flex justify-between gap-3">
                    <span className="truncate">
                      {String((p["leave_types"] as Row | null)?.["name"] ?? "—")} ·{" "}
                      {Number(p["days"] ?? 0)}d
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {labelFor(LEAVE_STATUSES, p["status"])}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No earlier leave on record.</p>
            )}
          </div>

          {(ledger.data ?? []).length ? (
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Movement history
              </p>
              <ul className="space-y-1 text-sm">
                {(ledger.data ?? []).map((t) => (
                  <li key={String(t["id"])} className="flex justify-between gap-3">
                    <span className="truncate">
                      {titleCase(t["transaction_type"])} · {Number(t["days"] ?? 0)}d
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {shortDateTime(t["created_at"])}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="decision-note">Decision comment</Label>
        <Textarea
          id="decision-note"
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Recorded against the request and the audit trail."
        />
      </div>
    </FormDialog>
  );
}
