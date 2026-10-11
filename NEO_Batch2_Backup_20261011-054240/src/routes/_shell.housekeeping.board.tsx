import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { BedDouble } from "lucide-react";
import { PageHeader } from "@/components/common/DataDisplay";
import { EmptyState, OpsBadge, OpsGuard, QueryState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  HOUSEKEEPING_STATUSES,
  housekeepingLabel,
  roomHousekeepingState,
  housekeepingTone,
  maintenanceRoomLabel,
  maintenanceRoomTone,
  shortDateTime,
  titleCase,
  type Row,
} from "@/lib/operations";
import { scopeWorkers, workerLabel, type ScopedWorker } from "@/lib/scoped-options";
import {
  useCreateJob,
  useHousekeepingJobs,
  useRoomBoard,
  useStaffLite,
  useTodayMovements,
} from "@/lib/operations-data";

export const Route = createFileRoute("/_shell/housekeeping/board")({
  head: () => ({
    meta: [
      { title: "Room Board — Housekeeping — HOS" },
      {
        name: "description",
        content: "Live room-by-room readiness with cleaning, inspection and maintenance state.",
      },
      { property: "og:title", content: "Room Board — Housekeeping — HOS" },
      {
        property: "og:description",
        content: "Live room-by-room readiness with cleaning, inspection and maintenance state.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function Page() {
  const board = useRoomBoard();
  const jobs = useHousekeepingJobs();
  const movements = useTodayMovements();
  const createJob = useCreateJob();
  const staff = useStaffLite("housekeeping");

  const [search, setSearch] = useState("");
  const [floor, setFloor] = useState("all");
  const [status, setStatus] = useState("all");
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [selectedRoom, setSelectedRoom] = useState<Row | null>(null);
  const [jobType, setJobType] = useState("stayover-cleaning");
  const [priority, setPriority] = useState("normal");
  const [assignee, setAssignee] = useState("");
  const [reason, setReason] = useState("");

  const eligibleStaff = useMemo(
    () =>
      scopeWorkers(
        (staff.data ?? []) as unknown as ScopedWorker[],
        selectedRoom?.["branch_id"] ? String(selectedRoom["branch_id"]) : null,
        null,
        "housekeeping",
      ),
    [staff.data, selectedRoom],
  );

  // A dependent selection never survives a change of property scope.
  useEffect(() => {
    if (assignee && !eligibleStaff.some((m) => m.id === assignee)) setAssignee("");
  }, [eligibleStaff, assignee]);

  const jobByRoom = useMemo(() => {
    const map = new Map<string, Row>();
    for (const j of jobs.data ?? []) {
      const room = j["room_id"] ? String(j["room_id"]) : null;
      if (!room) continue;
      if (["completed", "cancelled"].includes(String(j["status"]))) continue;
      map.set(room, j);
    }
    return map;
  }, [jobs.data]);

  const arrivalsByRoom = useMemo(() => {
    const map = new Map<string, Row>();
    const today = new Date().toISOString().slice(0, 10);
    for (const r of movements.data ?? []) {
      if (r["room_id"] && r["arrival_date"] === today) map.set(String(r["room_id"]), r);
    }
    return map;
  }, [movements.data]);

  const floors = useMemo(
    () =>
      Array.from(
        new Set((board.data ?? []).map((r) => String(r["floor"] ?? "")).filter(Boolean)),
      ).sort(),
    [board.data],
  );

  const rooms = useMemo(() => {
    return (board.data ?? []).filter((r) => {
      if (search && !String(r["room_number"]).toLowerCase().includes(search.toLowerCase()))
        return false;
      if (floor !== "all" && String(r["floor"] ?? "") !== floor) return false;
      // Filtering uses the derived readiness state, the same vocabulary the
      // dashboard, Room Rack and Availability read.
      if (status !== "all" && roomHousekeepingState(r) !== status) return false;
      if (onlyIssues) {
        const blocked = ["out-of-order", "out-of-service", "under-maintenance"].includes(
          String(r["maintenance_status"] ?? ""),
        );
        const needsWork = roomHousekeepingState(r) !== "ready";
        if (!blocked && !needsWork) return false;
      }
      return true;
    });
  }, [board.data, search, floor, status, onlyIssues]);

  return (
    <OpsGuard module="housekeeping">
      <PageHeader
        eyebrow="Housekeeping"
        title="Room Board"
        description="One authoritative status per room. Changes are written to the room record and its immutable history."
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Input
          placeholder="Search room number"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select value={floor} onValueChange={setFloor}>
          <SelectTrigger>
            <SelectValue placeholder="Floor" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All floors</SelectItem>
            {floors.map((f) => (
              <SelectItem key={f} value={f}>
                Floor {f}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger>
            <SelectValue placeholder="Housekeeping status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {HOUSEKEEPING_STATUSES.map((s) => (
              <SelectItem key={s.key} value={s.key}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={onlyIssues ? "default" : "outline"}
          onClick={() => setOnlyIssues((v) => !v)}
        >
          {onlyIssues ? "Showing attention only" : "Needs attention"}
        </Button>
      </div>

      <QueryState
        isLoading={board.isLoading}
        error={board.error ?? movements.error}
        isEmpty={rooms.length === 0}
        empty={
          <EmptyState
            title="No rooms match"
            description="Adjust the filters, or set up rooms in Front Office → Rooms & Types first."
            icon={BedDouble}
          />
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {rooms.map((room) => {
            const job = jobByRoom.get(String(room["id"]));
            const arrival = arrivalsByRoom.get(String(room["id"]));
            return (
              <Card key={String(room["id"])} className="surface-panel">
                <CardContent className="space-y-3 py-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-lg font-semibold">Room {String(room["room_number"])}</p>
                      <p className="text-xs text-muted-foreground">
                        {room["room_types"]?.name ?? "Room"} · Floor {room["floor"] ?? "—"}
                      </p>
                    </div>
                    <OpsBadge
                      value={housekeepingLabel(roomHousekeepingState(room))}
                      tone={housekeepingTone(roomHousekeepingState(room))}
                    />
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    <OpsBadge
                      value={maintenanceRoomLabel(room["maintenance_status"])}
                      tone={maintenanceRoomTone(room["maintenance_status"])}
                    />
                    {room["occupancy_status"] ? (
                      <OpsBadge value={titleCase(room["occupancy_status"])} tone="default" />
                    ) : null}
                    {arrival ? <OpsBadge value="Arrival today" tone="info" /> : null}
                    {job?.["dnd"] ? <OpsBadge value="Do not disturb" tone="warning" /> : null}
                  </div>

                  <dl className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
                    <div>
                      <dt>Last cleaned</dt>
                      <dd className="text-foreground">{shortDateTime(room["last_cleaned_at"])}</dd>
                    </div>
                    <div>
                      <dt>Last inspected</dt>
                      <dd className="text-foreground">
                        {shortDateTime(room["last_inspected_at"])}
                      </dd>
                    </div>
                  </dl>

                  {job ? (
                    <p className="rounded-lg bg-muted/60 px-2 py-1.5 text-xs">
                      {titleCase(job["job_type"])} · {titleCase(job["status"])}
                    </p>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      disabled={createJob.isPending}
                      onClick={() => {
                        setSelectedRoom(room);
                        setJobType(
                          room["occupancy_status"] === "occupied"
                            ? "stayover-cleaning"
                            : "checkout-cleaning",
                        );
                        setPriority("normal");
                        setAssignee("");
                        setReason("");
                      }}
                    >
                      Raise cleaning task
                    </Button>
                  )}

                  {room["out_of_order_reason"] ? (
                    <p className="text-xs text-destructive">
                      Blocked: {String(room["out_of_order_reason"])}
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </QueryState>

      <Dialog open={Boolean(selectedRoom)} onOpenChange={(next) => !next && setSelectedRoom(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Raise cleaning task</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Room {String(selectedRoom?.["room_number"] ?? "")} ·{" "}
              {titleCase(selectedRoom?.["occupancy_status"])}
            </p>
            <div className="space-y-1.5">
              <Label>Cleaning type</Label>
              <Select value={jobType} onValueChange={setJobType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="checkout-cleaning">Departure cleaning</SelectItem>
                  <SelectItem value="stayover-cleaning">Stay-over cleaning</SelectItem>
                  <SelectItem value="deep-cleaning">Deep cleaning</SelectItem>
                  <SelectItem value="touch-up">Touch-up</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Priority</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["low", "normal", "high", "urgent"].map((value) => (
                    <SelectItem key={value} value={value}>
                      {titleCase(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Assign attendant</Label>
              <Select value={assignee} onValueChange={setAssignee}>
                <SelectTrigger>
                  <SelectValue placeholder="Leave in team queue" />
                </SelectTrigger>
                <SelectContent>
                  {/* Selected-room property + Housekeeping department scoped; the value is the canonical profile id. */}
                  {eligibleStaff.map((member) => (
                    <SelectItem key={String(member["id"])} value={String(member["id"])}>
                      {workerLabel(member as unknown as ScopedWorker, !selectedRoom?.["branch_id"])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Reason</Label>
              <Textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why this cleaning task is required"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              disabled={!selectedRoom || !reason.trim() || createJob.isPending}
              onClick={() =>
                selectedRoom &&
                createJob.mutate(
                  {
                    room: String(selectedRoom["id"]),
                    jobType,
                    priority,
                    assignee: assignee || null,
                    assignedTeam: assignee ? null : "Housekeeping",
                    notes: reason.trim(),
                    source: "manual",
                    idempotencyKey: `manual:${selectedRoom["id"]}:${crypto.randomUUID()}`,
                  },
                  { onSuccess: () => setSelectedRoom(null) },
                )
              }
            >
              {createJob.isPending ? "Creating…" : "Create cleaning task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </OpsGuard>
  );
}
