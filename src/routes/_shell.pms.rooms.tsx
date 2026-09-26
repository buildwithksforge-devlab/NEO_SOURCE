import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BedDouble, ChevronRight, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useWriteBranchId } from "@/lib/branch-filter";
import { titleCase } from "@/lib/pms";
import { useRoomTypes, useRooms } from "@/lib/pms-data";
import { useRoomState } from "@/lib/operations-data";
import {
  isSellable,
  roomStage,
  unsellableReason,
  type CanonicalRoomState,
  type RoomStage,
} from "@/lib/room-lifecycle";
import { EmptyState, PmsGuard, QueryState, RoomConditionBadge } from "@/components/pms/PmsShared";

export const Route = createFileRoute("/_shell/pms/rooms")({
  head: () => ({
    meta: [
      { title: "Rooms & Room Types — NEØ" },
      {
        name: "description",
        content: "Configure room types, occupancy limits and the individual room inventory.",
      },
      { property: "og:title", content: "Rooms & Room Types — NEØ" },
      {
        property: "og:description",
        content: "Configure room types, occupancy limits and the individual room inventory.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PmsGuard action="rack.view">
      <RoomsPage />
    </PmsGuard>
  ),
});

type RoomRecord = {
  id: string;
  room_number: string;
  floor: string | null;
  room_condition: string;
  occupancy_status: string;
  /** Derived from the canonical room state, never from a stored flag. */
  sellable: boolean;
  stage: RoomStage;
  reason: string | null;
  room_types: { name: string; code?: string | null; max_occupancy?: number | null } | null;
};

type RoomLens = "all" | "sellable" | "vacant-clean" | "occupied" | "attention";

function RoomsPage() {
  const roomTypes = useRoomTypes();
  const rooms = useRooms();
  const canonical = useRoomState();
  const [lens, setLens] = useState<RoomLens>("all");
  const [search, setSearch] = useState("");

  /**
   * One canonical room state for PMS, Housekeeping, Maintenance and
   * availability: the inventory row supplies identity, `ops_room_state`
   * supplies lifecycle stage and sellability.
   */
  const stateById = new Map<string, CanonicalRoomState>();
  for (const s of (canonical.data ?? []) as unknown as CanonicalRoomState[]) {
    if (s.room_id) stateById.set(String(s.room_id), s);
  }

  const all = ((rooms.data ?? []) as unknown as RoomRecord[]).map((r) => {
    const state = stateById.get(r.id);
    if (!state) return { ...r, stage: "inactive" as RoomStage, sellable: false, reason: null };
    return {
      ...r,
      occupancy_status: state.occupancy_status ?? r.occupancy_status,
      stage: roomStage(state),
      sellable: isSellable(state),
      reason: unsellableReason(state),
    };
  });

  const isAttention = (r: RoomRecord) =>
    r.stage === "out-of-order" ||
    r.stage === "out-of-service" ||
    r.stage === "maintenance-fault" ||
    r.stage === "rework" ||
    r.stage === "vacant-dirty";

  const counts = {
    total: all.length,
    sellable: all.filter((r) => r.sellable).length,
    vacantClean: all.filter((r) => r.stage === "vacant-ready").length,
    occupied: all.filter((r) => r.stage === "occupied" || r.stage === "checkout").length,
    attention: all.filter(isAttention).length,
  };

  const q = search.trim().toLowerCase();
  const visible = all.filter((r) => {
    const matchesLens =
      lens === "all"
        ? true
        : lens === "sellable"
          ? r.sellable
          : lens === "vacant-clean"
            ? r.stage === "vacant-ready"
            : lens === "occupied"
              ? r.stage === "occupied" || r.stage === "checkout"
              : isAttention(r);
    if (!matchesLens) return false;
    if (!q) return true;
    return (
      r.room_number.toLowerCase().includes(q) ||
      (r.room_types?.name ?? "").toLowerCase().includes(q) ||
      (r.floor ?? "").toLowerCase().includes(q)
    );
  });

  /** Rooms read as a floor plan: grouped by floor, then by room number. */
  const byFloor = [
    ...visible
      .reduce((map, r) => {
        const key = r.floor?.trim() ? `Floor ${r.floor}` : "Unassigned floor";
        const bucket = map.get(key);
        if (bucket) bucket.push(r);
        else map.set(key, [r]);
        return map;
      }, new Map<string, RoomRecord[]>())
      .entries(),
  ].sort(([a], [b]) => a.localeCompare(b));

  const roomsPerType = new Map<string, number>();
  for (const r of all) {
    const name = r.room_types?.name;
    if (name) roomsPerType.set(name, (roomsPerType.get(name) ?? 0) + 1);
  }

  return (
    <div>
      <PageHeader
        eyebrow="Front Office"
        title="Rooms & room types"
        icon={BedDouble}
        description="Room types drive availability, pricing and occupancy rules. Rooms are the physical inventory sold and cleaned."
      />

      <Tabs defaultValue="rooms">
        <TabsList>
          <TabsTrigger value="rooms">Rooms ({all.length})</TabsTrigger>
          <TabsTrigger value="types">Room types ({(roomTypes.data ?? []).length})</TabsTrigger>
        </TabsList>

        <TabsContent value="rooms" className="mt-4">
          <SummaryStrip
            lead={{
              id: "total",
              label: "Rooms in inventory",
              value: counts.total,
              hint: lens === "all" ? "Whole property" : "Filtered by the selected figure",
              active: lens === "all",
              onSelect: () => setLens("all"),
            }}
            figures={[
              {
                id: "sellable",
                label: "Sellable",
                value: counts.sellable,
                tone: "info",
                active: lens === "sellable",
                onSelect: () => setLens((l) => (l === "sellable" ? "all" : "sellable")),
              },
              {
                id: "vacant-clean",
                label: "Vacant & ready",
                value: counts.vacantClean,
                tone: "success",
                active: lens === "vacant-clean",
                onSelect: () => setLens((l) => (l === "vacant-clean" ? "all" : "vacant-clean")),
              },
              {
                id: "occupied",
                label: "Occupied",
                value: counts.occupied,
                tone: "accent",
                active: lens === "occupied",
                onSelect: () => setLens((l) => (l === "occupied" ? "all" : "occupied")),
              },
              {
                id: "attention",
                label: "Needs attention",
                value: counts.attention,
                tone: counts.attention > 0 ? "warning" : "default",
                active: lens === "attention",
                onSelect: () => setLens((l) => (l === "attention" ? "all" : "attention")),
              },
            ]}
          />

          <SectionCard
            title="Room inventory"
            description="Grouped by floor, so the list reads the way the building does."
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Room, type or floor"
                  aria-label="Search rooms"
                  className="w-48"
                />
                <RoomDialog />
              </div>
            }
          >
            <QueryState
              isLoading={rooms.isLoading}
              error={rooms.error}
              isEmpty={visible.length === 0}
              empty={
                <EmptyState
                  title={all.length ? "No rooms match this view" : "No rooms yet"}
                  description={
                    all.length
                      ? "Clear the selected figure or search to see the rest of the inventory."
                      : "Create at least one room type, then add the rooms that belong to it."
                  }
                  action={all.length ? undefined : <RoomDialog />}
                />
              }
            >
              <div className="space-y-5">
                {byFloor.map(([floor, list]) => (
                  <section key={floor}>
                    <div className="mb-2 flex items-baseline gap-2 border-b border-outline-subtle pb-1.5">
                      <h3 className="text-sm font-semibold">{floor}</h3>
                      <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
                        {list.length}
                      </span>
                    </div>
                    <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                      {list.map((r) => (
                        <RoomTile key={r.id} room={r} />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </QueryState>
          </SectionCard>
        </TabsContent>

        <TabsContent value="types" className="mt-4">
          <SectionCard
            title="Room types"
            description="Each type is a product: occupancy, beds and the rooms that carry it."
            actions={<RoomTypeDialog />}
          >
            <QueryState
              isLoading={roomTypes.isLoading}
              error={roomTypes.error}
              isEmpty={(roomTypes.data ?? []).length === 0}
              empty={
                <EmptyState
                  title="No room types yet"
                  description="A room type defines occupancy, beds and amenities for a group of rooms."
                  action={<RoomTypeDialog />}
                />
              }
            >
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {(roomTypes.data ?? []).map((rt) => (
                  <article
                    key={rt.id}
                    className="surface-raised relative overflow-hidden rounded-2xl border p-4"
                  >
                    <span aria-hidden className="absolute inset-x-0 top-0 h-1 bg-primary/60" />
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="neo-line-1 font-semibold">{rt.name}</p>
                        <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                          {rt.code}
                        </p>
                      </div>
                      <span className="rounded-full bg-primary-soft px-2.5 py-1 text-xs font-semibold text-primary">
                        Sleeps {rt.max_occupancy}
                      </span>
                    </div>
                    {rt.description ? (
                      <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                        {rt.description}
                      </p>
                    ) : null}
                    <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-outline-subtle pt-3 text-center">
                      <TypeFact label="Adults" value={rt.max_adults} />
                      <TypeFact label="Children" value={rt.max_children} />
                      <TypeFact label="Beds" value={rt.bed_count} />
                    </dl>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {roomsPerType.get(rt.name) ?? 0} room(s) in this type
                    </p>
                  </article>
                ))}
              </div>
            </QueryState>
          </SectionCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function TypeFact({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <dt className="text-[0.65rem] uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums">{value ?? 0}</dd>
    </div>
  );
}

/** One physical room: number first, then the state that decides what happens next. */
function RoomTile({ room }: { room: RoomRecord }) {
  /** A room is a door: the rack is where its stay and housekeeping state live. */
  const attention =
    room.stage === "out-of-order" ||
    room.stage === "out-of-service" ||
    room.stage === "maintenance-fault" ||
    room.stage === "rework";
  const ready = room.stage === "vacant-ready";

  return (
    <Link
      to="/pms/rack"
      search={{ room: room.room_number }}
      aria-label={`Room ${room.room_number} — open in the room rack`}
      className={cn(
        "group relative block min-w-0 overflow-hidden rounded-xl border bg-card/60 p-3 pl-4 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        attention ? "border-warning/40" : ready ? "border-success/35" : "border-outline-subtle",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-1",
          attention ? "bg-warning/80" : ready ? "bg-success/70" : "bg-border",
        )}
      />
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-semibold tabular-nums">{room.room_number}</p>
          <p className="neo-line-1 text-xs text-muted-foreground">
            {room.room_types?.name ?? "No type"}
            {room.room_types?.max_occupancy ? ` · sleeps ${room.room_types.max_occupancy}` : ""}
          </p>
        </div>
        <RoomConditionBadge condition={room.room_condition} />
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
          {titleCase(room.occupancy_status)}
        </span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5",
            room.sellable
              ? "bg-tint-success text-on-tint-success"
              : "bg-tint-warning text-on-tint-warning",
          )}
        >
          {room.sellable ? "Sellable" : (room.reason ?? "Not sellable")}
        </span>
        <span className="ml-auto inline-flex items-center gap-0.5 font-medium text-primary">
          Open in rack
          <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </Link>
  );
}


function RoomTypeDialog() {
  const { organizationId, profile, user, can } = useAuth();
  const writeBranchId = useWriteBranchId();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    code: "",
    description: "",
    max_adults: 2,
    max_children: 1,
    max_occupancy: 3,
    bed_count: 1,
    bed_configuration: "",
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!organizationId) throw new Error("No organisation context");
      const { error } = await supabase.from("room_types").insert({
        organization_id: organizationId,
        branch_id: writeBranchId,
        name: form.name.trim(),
        code: form.code.trim().toUpperCase(),
        description: form.description.trim(),
        max_adults: form.max_adults,
        max_children: form.max_children,
        max_occupancy: form.max_occupancy,
        bed_count: form.bed_count,
        bed_configuration: form.bed_configuration.trim(),
        created_by: user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Room type created");
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["pms"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!can("pms", "rack.edit")) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="mr-1 size-4" /> Room type
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New room type</DialogTitle>
          <DialogDescription>
            Occupancy limits are enforced by the availability engine.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>Code</Label>
            <Input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              placeholder="DLX"
            />
          </div>
          <div className="space-y-2">
            <Label>Beds</Label>
            <Input
              type="number"
              min={1}
              value={form.bed_count}
              onChange={(e) => setForm({ ...form, bed_count: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-2">
            <Label>Max adults</Label>
            <Input
              type="number"
              min={1}
              value={form.max_adults}
              onChange={(e) => setForm({ ...form, max_adults: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-2">
            <Label>Max children</Label>
            <Input
              type="number"
              min={0}
              value={form.max_children}
              onChange={(e) => setForm({ ...form, max_children: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-2">
            <Label>Max occupancy</Label>
            <Input
              type="number"
              min={1}
              value={form.max_occupancy}
              onChange={(e) => setForm({ ...form, max_occupancy: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-2">
            <Label>Bed configuration</Label>
            <Input
              value={form.bed_configuration}
              onChange={(e) => setForm({ ...form, bed_configuration: e.target.value })}
              placeholder="1 king"
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>Description</Label>
            <Textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!form.name.trim() || !form.code.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            Create room type
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RoomDialog() {
  const { organizationId, profile, user, can } = useAuth();
  const writeBranchId = useWriteBranchId();
  const qc = useQueryClient();
  const roomTypes = useRoomTypes();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    room_number: "",
    room_type_id: "",
    floor: "",
    building: "",
    smoking: false,
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!organizationId) throw new Error("No organisation context");
      const branchId = writeBranchId;
      if (!branchId)
        throw new Error(
          "Select a property in the header, or ask an administrator to assign your home property.",
        );
      const { error } = await supabase.from("rooms").insert({
        organization_id: organizationId,
        branch_id: branchId,
        room_number: form.room_number.trim(),
        room_type_id: form.room_type_id,
        floor: form.floor.trim(),
        building: form.building.trim(),
        maintenance_status: "operational",
        smoking: form.smoking ? "smoking" : "non-smoking",
        created_by: user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Room added");
      setOpen(false);
      setForm({ ...form, room_number: "" });
      void qc.invalidateQueries({ queryKey: ["pms"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!can("pms", "rack.edit")) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1 size-4" /> Room
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a room</DialogTitle>
          <DialogDescription>
            New rooms start vacant and clean, and become sellable immediately.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Room number</Label>
            <Input
              value={form.room_number}
              onChange={(e) => setForm({ ...form, room_number: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>Room type</Label>
            <Select
              value={form.room_type_id}
              onValueChange={(v) => setForm({ ...form, room_type_id: v })}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    (roomTypes.data ?? []).length ? "Select" : "Create a room type first"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {(roomTypes.data ?? []).map((rt) => (
                  <SelectItem key={rt.id} value={rt.id}>
                    {rt.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Floor</Label>
            <Input
              value={form.floor}
              onChange={(e) => setForm({ ...form, floor: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>Building / block</Label>
            <Input
              value={form.building}
              onChange={(e) => setForm({ ...form, building: e.target.value })}
            />
          </div>
          <p className="rounded-lg border border-border/70 p-3 text-xs text-muted-foreground sm:col-span-2">
            Sellability is derived from the room&apos;s maintenance state — a new room is sellable
            until it is placed under maintenance, out of service or out of order from the Room Rack,
            Housekeeping or Maintenance.
          </p>
          <div className="flex items-center justify-between rounded-lg border border-border/70 p-3 sm:col-span-2">
            <Label>Smoking room</Label>
            <Switch
              checked={form.smoking}
              onCheckedChange={(v) => setForm({ ...form, smoking: v })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!form.room_number.trim() || !form.room_type_id || save.isPending}
            onClick={() => save.mutate()}
          >
            Add room
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
