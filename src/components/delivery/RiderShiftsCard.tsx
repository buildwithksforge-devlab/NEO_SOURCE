/**
 * Rider shift scheduling. Overlap protection, scope and notification are all
 * enforced by the database routines; the browser only submits intent.
 */
import { useState } from "react";
import { toast } from "sonner";
import { CalendarClock } from "lucide-react";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, QueryState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import { useTenant } from "@/lib/tenant";
import { shortDateTime, titleCase, zonedInputToUtcIso } from "@/lib/delivery";
import { useCancelShift, useRiderShifts, useRiders, useScheduleShift } from "@/lib/delivery-data";

type Row = Record<string, unknown>;

const STATUS_TONE: Record<string, "success" | "warning" | "destructive" | "default"> = {
  scheduled: "default",
  active: "success",
  completed: "success",
  cancelled: "destructive",
};

export function RiderShiftsCard({ branchId }: { branchId?: string | null | undefined }) {
  const { can } = useAuth();
  const manage = can("delivery", "riders.manage");
  const shifts = useRiderShifts(branchId);
  const rows = (shifts.data ?? []) as Row[];

  return (
    <SectionCard
      title="Rider shifts"
      description="Planned cover for the dispatch board. Riders are notified when a shift is scheduled or cancelled."
      actions={manage ? <ScheduleShiftDialog branchId={branchId} /> : undefined}
    >
      <QueryState
        isLoading={shifts.isLoading}
        error={shifts.error}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            title="No shifts scheduled"
            description="Schedule cover so dispatch can see who is expected on the road."
          />
        }
      >
        <div className="space-y-2">
          {rows.map((s) => {
            const rider = (s["rider_profiles"] ?? {}) as Row;
            const status = String(s["status"] ?? "scheduled");
            return (
              <div
                key={String(s["id"])}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/40 p-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    <CalendarClock className="mr-1 inline h-3.5 w-3.5" />
                    {String(rider["display_name"] ?? "Rider")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {shortDateTime(String(s["starts_at"]))} → {shortDateTime(String(s["ends_at"]))}
                    {s["cancelled_reason"] ? ` · ${String(s["cancelled_reason"])}` : ""}
                    {s["notes"] ? ` · ${String(s["notes"])}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusPill tone={STATUS_TONE[status] ?? "default"}>{titleCase(status)}</StatusPill>
                  {manage && (status === "scheduled" || status === "active") ? (
                    <CancelShiftDialog shiftId={String(s["id"])} />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </QueryState>
    </SectionCard>
  );
}

function ScheduleShiftDialog({ branchId }: { branchId?: string | null | undefined }) {
  const [open, setOpen] = useState(false);
  const [riderId, setRiderId] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<{ rider?: string; starts_at?: string; ends_at?: string }>({});
  const riders = useRiders(branchId ?? null);
  const schedule = useScheduleShift();
  const { tenant } = useTenant();
  const timeZone = tenant.regional.timezone || "Africa/Nairobi";

  const reset = () => {
    setRiderId("");
    setStartsAt("");
    setEndsAt("");
    setNotes("");
    setErrors({});
  };

  const submit = (form: HTMLFormElement) => {
    /**
     * Read the values straight off the form as well as from state. The two
     * agree in normal use; reading the form means a value the browser filled in
     * (autofill, a picker that never fired a change event) is still submitted
     * instead of arriving empty.
     */
    const data = new FormData(form);
    const startLocal = String(data.get("starts_at") ?? "") || startsAt;
    const endLocal = String(data.get("ends_at") ?? "") || endsAt;
    const noteValue = String(data.get("notes") ?? "") || notes;

    const next: typeof errors = {};
    if (!riderId) next.rider = "Choose a rider.";
    if (!startLocal) next.starts_at = "Enter when the shift starts.";
    if (!endLocal) next.ends_at = "Enter when the shift ends.";

    const startIso = startLocal ? zonedInputToUtcIso(startLocal, timeZone) : null;
    const endIso = endLocal ? zonedInputToUtcIso(endLocal, timeZone) : null;
    if (startLocal && !startIso) next.starts_at = "That start time could not be read.";
    if (endLocal && !endIso) next.ends_at = "That end time could not be read.";
    if (startIso && endIso && new Date(endIso) <= new Date(startIso)) {
      next.ends_at = "The shift must end after it starts.";
    }

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    schedule.mutate(
      {
        riderId,
        startsAt: startIso!,
        endsAt: endIso!,
        branchId: branchId ?? null,
        notes: noteValue.trim() || undefined,
      },
      {
        onSuccess: () => {
          setOpen(false);
          reset();
        },
        onError: (error: Error) => setErrors({ starts_at: error.message }),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen && !schedule.isPending) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">Schedule shift</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule a rider shift</DialogTitle>
          <DialogDescription>
            Times are read in {timeZone.replace(/_/g, " ")}. The database refuses overlapping shifts
            and shifts for retired riders.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit(event.currentTarget);
          }}
        >
          <div className="space-y-1.5">
            <Label>Rider</Label>
            <Select value={riderId} onValueChange={setRiderId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a rider" />
              </SelectTrigger>
              <SelectContent>
                {(riders.data ?? []).filter((r) => r.active).map((r) => (
                  <SelectItem key={r.rider_id} value={r.rider_id}>
                    {r.display_name ?? "Rider"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.rider ? <p className="text-xs text-destructive">{errors.rider}</p> : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="shift-start">Starts</Label>
              <Input
                id="shift-start"
                name="starts_at"
                type="datetime-local"
                value={startsAt}
                onChange={(event) => setStartsAt(event.target.value)}
              />
              {errors.starts_at ? <p className="text-xs text-destructive">{errors.starts_at}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="shift-end">Ends</Label>
              <Input
                id="shift-end"
                name="ends_at"
                type="datetime-local"
                value={endsAt}
                onChange={(event) => setEndsAt(event.target.value)}
              />
              {errors.ends_at ? <p className="text-xs text-destructive">{errors.ends_at}</p> : null}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="shift-notes">Notes (optional)</Label>
            <Textarea
              id="shift-notes"
              name="notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={2}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={schedule.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={schedule.isPending}>
              {schedule.isPending ? "Scheduling…" : "Schedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CancelShiftDialog({ shiftId }: { shiftId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const cancel = useCancelShift();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Cancel
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel this shift</DialogTitle>
          <DialogDescription>A written reason is required and is kept in the audit trail.</DialogDescription>
        </DialogHeader>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Reason" />
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Keep shift
          </Button>
          <Button
            variant="destructive"
            disabled={!reason.trim() || cancel.isPending}
            onClick={() =>
              cancel.mutate({ shiftId, reason: reason.trim() }, { onSuccess: () => { setOpen(false); setReason(""); } })
            }
          >
            Cancel shift
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
