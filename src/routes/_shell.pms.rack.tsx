import { guardedRpc } from "@/lib/rpc-guard";
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import {
  HOUSEKEEPING_STATUSES,
  MAINTENANCE_STATUSES,
  ROOM_CONDITIONS,
  roomConditionTone,
  titleCase,
} from "@/lib/pms";
import { housekeepingLabel, roomHousekeepingState } from "@/lib/operations";
import { useRoomState } from "@/lib/operations-data";
import { EmptyState, PmsGuard, QueryState, RoomConditionBadge } from "@/components/pms/PmsShared";
import { RoomReadinessBadge, RoomReadinessLegend } from "@/components/common/RoomReadiness";
import { CalendarDayLegend, CalendarDayStateBadge } from "@/components/common/CalendarSurface";
import {
  InspectorField,
  InspectorSection,
  InspectorSheet,
} from "@/components/common/InspectorSheet";

export const Route = createFileRoute("/_shell/pms/rack")({
  head: () => ({
    meta: [
      { title: "Room Rack — NEØ" },
      {
        name: "description",
        content: "Live room status board with housekeeping condition and one-tap status changes.",
      },
      { property: "og:title", content: "Room Rack — NEØ" },
      {
        property: "og:description",
        content: "Live room status board with housekeeping condition and one-tap status changes.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PmsGuard action="rack.view">
      <RoomRack />
    </PmsGuard>
  ),
});

type RoomRow = {
  id: string;
  room_number: string;
  floor: string | null;
  building: string | null;
  room_condition: string;
  housekeeping_status: string;
  housekeeping_state?: string;
  sellable_now?: boolean;
  exclusion_reasons?: string[] | null;
  maintenance_status: string;
  occupancy_status: string;
  sellable: boolean;
  status: string;
  sellability_reason?: string | null;
  room_types: { name: string } | null;
};

function RoomRack() {
  const { organizationId, user, profile, can } = useAuth();
  const qc = useQueryClient();
  const rooms = useRoomState();
  const [filter, setFilter] = useState("all");
  const [inspected, setInspected] = useState<RoomRow | null>(null);
  const [search, setSearch] = useState("");

  const rows = (rooms.data ?? []) as unknown as RoomRow[];
  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (filter === "all" || r.room_condition === filter) &&
          (!search.trim() || r.room_number.toLowerCase().includes(search.trim().toLowerCase())),
      ),
    [rows, filter, search],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.room_condition] = (c[r.room_condition] ?? 0) + 1;
    return c;
  }, [rows]);

  const setCondition = useMutation({
    mutationFn: async ({
      room,
      field,
      value,
    }: {
      room: RoomRow;
      field: "housekeeping_status" | "maintenance_status";
      value: string;
    }) => {
      const previous =
        field === "housekeeping_status" ? room.housekeeping_status : room.maintenance_status;
      const { error } = await guardedRpc(supabase, "ops_set_room_status", {
        _room: room.id,
        _housekeeping_status: field === "housekeeping_status" ? value : null,
        _maintenance_status: field === "maintenance_status" ? value : null,
        _reason: null,
        _source_module: "front-office",
        _reference: null,
        _occupancy_status: null,
      } as never);
      if (error) throw error;
      if (organizationId) {
        await logAudit({
          organizationId,
          userId: user?.id ?? null,
          userName: profile?.full_name,
          action: "pms.room.status_changed",
          module: "front-office",
          recordId: room.id,
          previousValue: { [field]: previous },
          newValue: { [field]: value },
        });
      }
    },
    onSuccess: () => {
      toast.success("Room status updated");
      void qc.invalidateQueries({ queryKey: ["pms"] });
      void qc.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader
        eyebrow="Front Office"
        title="Room rack"
        description="Every room in the property with its live condition. Housekeeping and maintenance see the same board."
        actions={
          <div className="flex flex-wrap gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Room number"
              className="w-40"
            />
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All conditions</SelectItem>
                {ROOM_CONDITIONS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {titleCase(c)} ({counts[c] ?? 0})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />

      <SectionCard
        title={`${filtered.length} room(s)`}
        description="Select a status to change the room condition."
      >
        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2">
          <RoomReadinessLegend />
          <CalendarDayLegend states={["available", "limited", "unavailable"]} />
        </div>
        <QueryState
          isLoading={rooms.isLoading}
          error={rooms.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No rooms configured"
              description="Add room types and rooms first — availability, check-in and housekeeping all depend on them."
            />
          }
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((room) => {
              const sellable = room.sellable_now ?? room.sellable;
              return (
                <div
                  key={room.id}
                  className={`min-w-0 rounded-xl border p-4 ${
                    roomConditionTone(room.room_condition) === "destructive"
                      ? "border-destructive/40 bg-destructive/5"
                      : "border-border/70 bg-card"
                  }`}
                >
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-lg font-semibold">{room.room_number}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {room.room_types?.name ?? "No type"}
                        {room.floor ? ` · Floor ${room.floor}` : ""}
                      </p>
                    </div>
                    <RoomConditionBadge condition={room.room_condition} />
                  </div>

                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <RoomReadinessBadge status={roomHousekeepingState(room)} compact />
                    <CalendarDayStateBadge
                      state={sellable ? "available" : "unavailable"}
                      label={sellable ? "Sellable now" : "Not sellable"}
                    />
                  </div>

                  {/*
                    Secondary status and every control live in the inspector on a
                    phone: a day/room cell shows identity and one state, and never
                    overflows with occupancy text and two selects.
                  */}
                  <div className="mt-1 hidden text-xs text-muted-foreground sm:block">
                    <p className="truncate">{titleCase(room.occupancy_status)}</p>
                    {!sellable && room.sellability_reason ? (
                      <p className="mt-1 line-clamp-2">{room.sellability_reason}</p>
                    ) : null}
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setInspected(room)}
                    >
                      Details
                    </Button>
                  </div>

                  {can("pms", "rack.edit") ? (
                    <div className="mt-3 hidden gap-2 sm:grid">
                      <Select
                        value={room.housekeeping_status}
                        onValueChange={(v) =>
                          setCondition.mutate({ room, field: "housekeeping_status", value: v })
                        }
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {HOUSEKEEPING_STATUSES.map((c) => (
                            <SelectItem key={c} value={c}>
                              Housekeeping: {titleCase(c)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={room.maintenance_status}
                        onValueChange={(v) =>
                          setCondition.mutate({ room, field: "maintenance_status", value: v })
                        }
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {MAINTENANCE_STATUSES.map((c) => (
                            <SelectItem key={c} value={c}>
                              Maintenance: {titleCase(c)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </QueryState>
      </SectionCard>

      <InspectorSheet
        open={!!inspected}
        onOpenChange={(open) => {
          if (!open) setInspected(null);
        }}
        title={inspected ? `Room ${inspected.room_number}` : "Room"}
        subtitle={inspected?.room_types?.name ?? "No room type"}
        chips={
          inspected ? (
            <>
              <RoomReadinessBadge status={roomHousekeepingState(inspected)} compact />
              <CalendarDayStateBadge
                state={(inspected.sellable_now ?? inspected.sellable) ? "available" : "unavailable"}
                label={
                  (inspected.sellable_now ?? inspected.sellable) ? "Sellable now" : "Not sellable"
                }
              />
            </>
          ) : null
        }
      >
        {inspected ? (
          <>
            <InspectorSection title="Status">
              <InspectorField label="Condition">
                {titleCase(inspected.room_condition)}
              </InspectorField>
              <InspectorField label="Housekeeping">
                {housekeepingLabel(roomHousekeepingState(inspected))}
              </InspectorField>
              <InspectorField label="Maintenance">
                {titleCase(inspected.maintenance_status)}
              </InspectorField>
              <InspectorField label="Occupancy">
                {titleCase(inspected.occupancy_status)}
              </InspectorField>
              <InspectorField label="Location">
                {[inspected.building, inspected.floor ? `Floor ${inspected.floor}` : null]
                  .filter(Boolean)
                  .join(" · ") || "Not recorded"}
              </InspectorField>
              {inspected.sellability_reason ? (
                <InspectorField label="Why not sellable">
                  {inspected.sellability_reason}
                </InspectorField>
              ) : null}
            </InspectorSection>

            {can("pms", "rack.edit") ? (
              <InspectorSection title="Change status">
                <div className="grid gap-2">
                  <Select
                    value={inspected.housekeeping_status}
                    onValueChange={(v) => {
                      setCondition.mutate({
                        room: inspected,
                        field: "housekeeping_status",
                        value: v,
                      });
                      setInspected({ ...inspected, housekeeping_status: v });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {HOUSEKEEPING_STATUSES.map((c) => (
                        <SelectItem key={c} value={c}>
                          Housekeeping: {titleCase(c)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={inspected.maintenance_status}
                    onValueChange={(v) => {
                      setCondition.mutate({
                        room: inspected,
                        field: "maintenance_status",
                        value: v,
                      });
                      setInspected({ ...inspected, maintenance_status: v });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MAINTENANCE_STATUSES.map((c) => (
                        <SelectItem key={c} value={c}>
                          Maintenance: {titleCase(c)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </InspectorSection>
            ) : null}
          </>
        ) : null}
      </InspectorSheet>
    </div>
  );
}

