/**
 * Banquet setup times for one event: when the room is dressed, when guests
 * arrive, when service runs and when the room is cleared. The database checks
 * that the sequence makes sense and records who changed it.
 */
import { useEffect, useState } from "react";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useBeos, useSetBeoTimings } from "@/lib/events-data";

type Row = Record<string, unknown>;

/** A timestamp as the browser's date-and-time field expects it (local time). */
function toLocalInput(value: unknown): string {
  if (!value) return "";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function BanquetSetupCard({ bookingId }: { bookingId: string | null }) {
  const beos = useBeos(bookingId);
  const save = useSetBeoTimings();

  const rows = (beos.data ?? []) as Row[];
  const current =
    [...rows]
      .filter(
        (row) =>
          !["superseded", "cancelled"].includes(
            String(row["status"] ?? "").trim().toLowerCase(),
          ),
      )
      .sort(
        (a, b) =>
          Number(b["revision"] ?? 0) -
          Number(a["revision"] ?? 0),
      )[0] ??
    [...rows].sort(
      (a, b) =>
        Number(b["revision"] ?? 0) -
        Number(a["revision"] ?? 0),
    )[0] ??
    null;

  const [setupAt, setSetupAt] = useState("");
  const [arrivalAt, setArrivalAt] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [breakdownAt, setBreakdownAt] = useState("");
  const [serving, setServing] = useState("");
  const [seating, setSeating] = useState("");
  const [reason, setReason] = useState("");

  const beoId = current ? String(current["id"]) : null;

  useEffect(() => {
    if (!current) return;
    setSetupAt(toLocalInput(current["setup_at"]));
    setArrivalAt(toLocalInput(current["guest_arrival_at"]));
    setStartAt(toLocalInput(current["start_at"]));
    setEndAt(toLocalInput(current["end_at"]));
    setBreakdownAt(toLocalInput(current["breakdown_at"]));
    setServing(String(current["serving_times"] ?? ""));
    setSeating(String(current["seating_layout"] ?? ""));
  }, [beoId]);

  if (!bookingId) {
    return (
      <SectionCard title="Banquet setup times">
        <EmptyState title="Choose an event" description="Pick an event above to set its setup and service times." />
      </SectionCard>
    );
  }

  if (!current) {
    return (
      <SectionCard title="Banquet setup times">
        <EmptyState
          title="No banquet order yet"
          description="Raise the banquet order for this event first; its times are set here."
        />
      </SectionCard>
    );
  }

  const locked = Boolean(current["locked"]);

  const field = (label: string, value: string, onChange: (v: string) => void) => (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input type="datetime-local" value={value} disabled={locked} onChange={(e) => onChange(e.target.value)} />
    </div>
  );

  return (
    <SectionCard
      title="Banquet setup times"
      description="Room dressing, guest arrival, service and clear-down for this event."
      actions={
        <StatusPill tone={locked ? "warning" : "info"}>
          {String(current["beo_number"] ?? "Banquet order")} · {locked ? "Locked" : String(current["status"] ?? "draft")}
        </StatusPill>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {field("Room set up by", setupAt, setSetupAt)}
        {field("Guests arrive", arrivalAt, setArrivalAt)}
        {field("Service starts", startAt, setStartAt)}
        {field("Service ends", endAt, setEndAt)}
        {field("Room cleared by", breakdownAt, setBreakdownAt)}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">Serving notes</Label>
          <Textarea
            rows={2}
            value={serving}
            disabled={locked}
            placeholder="e.g. canapés on arrival, main course at 13:00"
            onChange={(e) => setServing(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Seating layout</Label>
          <Textarea
            rows={2}
            value={seating}
            disabled={locked}
            placeholder="e.g. rounds of ten with a head table"
            onChange={(e) => setSeating(e.target.value)}
          />
        </div>
      </div>

      <div className="mt-3 space-y-1">
        <Label className="text-xs">Reason for the change</Label>
        <Input
          value={reason}
          disabled={locked}
          placeholder="Recorded with the change"
          onChange={(e) => setReason(e.target.value)}
        />
      </div>

      <div className="mt-3 flex justify-end">
        <Button
          disabled={locked || save.isPending || !beoId}
          onClick={() =>
            save.mutate({
              beoId: beoId as string,
              setupAt: fromLocalInput(setupAt),
              guestArrivalAt: fromLocalInput(arrivalAt),
              startAt: fromLocalInput(startAt),
              endAt: fromLocalInput(endAt),
              breakdownAt: fromLocalInput(breakdownAt),
              servingTimes: serving.trim() || null,
              seatingLayout: seating.trim() || null,
              reason: reason.trim() || null,
            })
          }
        >
          {save.isPending ? "Saving…" : "Save times"}
        </Button>
      </div>

      {locked ? (
        <p className="mt-2 text-xs text-muted-foreground">
          This banquet order is locked, so its times can no longer be changed here.
        </p>
      ) : null}
    </SectionCard>
  );
}
