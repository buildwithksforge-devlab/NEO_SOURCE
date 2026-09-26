import { usePagePermitted } from "@/components/common/PermittedLink";

import { useEffect, useRef, useState } from "react";
import { Link, getRouteApi } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import { RoomReadinessBadge } from "@/components/common/RoomReadiness";
import { CalendarDayLegend, CalendarDayStateBadge } from "@/components/common/CalendarSurface";
import {
  InspectorField,
  InspectorSection,
  InspectorSheet,
} from "@/components/common/InspectorSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NeoDateRangePicker } from "@/components/common/DatePicker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useAvailability, useRoomTypes, type AvailableRoom } from "@/lib/pms-data";
import { housekeepingLabel } from "@/lib/operations";
import { EmptyState } from "@/components/pms/PmsShared";
import { ISO_DATE as DATE, calendarNights, resolveAvailabilitySearch } from "@/lib/availability-search";

/**
 * Availability search page.
 *
 * Navigation and search reading are bound to the availability route itself
 * through `getRouteApi`, so a submit updates this route's own search params
 * instead of navigating to an unscoped path that drops them. The URL is the
 * single source of truth: refresh, back and forward all reconstruct the exact
 * committed search.
 */
export const AVAILABILITY_ROUTE_ID = "/_shell/pms/availability";
const routeApi = getRouteApi(AVAILABILITY_ROUTE_ID);

export function AvailabilityPage() {
  const { branchId } = useActivePropertyFilter();
  const search = routeApi.useSearch();


  const roomTypes = useRoomTypes();

  /**
   * The URL is the source of truth, but a missing param is NOT an error: the
   * canonical default contract lives in `resolveAvailabilitySearch`, which
   * opens a bare URL on property-local today -> today + 1 night. An explicitly
   * supplied bad range is preserved and stays visible as invalid.
   */
  const resolved = resolveAvailabilitySearch(search);
  const committed = resolved.values;

  // Canonicalize a bare/partial URL once, via replace, so reload, back and
  // forward all reproduce the same search. Guarded by the URL itself: after
  // the replace nothing is missing, so this cannot loop.
  const navigate = routeApi.useNavigate();
  useEffect(() => {
    if (!resolved.needsCanonicalUrl) return;
    void navigate({ search: (prev) => ({ ...prev, ...committed }), replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved.needsCanonicalUrl, committed.arrival, committed.departure, committed.roomType, committed.adults, committed.children]);

  const [draft, setDraft] = useState(committed);
  const lastUrl = useRef(JSON.stringify(committed));
  useEffect(() => {
    const key = JSON.stringify(committed);
    if (key === lastUrl.current) return;
    lastUrl.current = key;
    setDraft(committed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed.arrival, committed.departure, committed.roomType, committed.adults, committed.children]);

  const [formError, setFormError] = useState<string | null>(null);
  const [inspected, setInspected] = useState<AvailableRoom | null>(null);

  const nights = calendarNights(committed.arrival, committed.departure);
  const draftNights = calendarNights(draft.arrival, draft.departure);

  const availability = useAvailability({
    branch: branchId,
    arrival: committed.arrival,
    departure: committed.departure,
    roomType: committed.roomType === "all" ? null : committed.roomType,
    adults: committed.adults,
    children: committed.children,
    enabled: nights > 0,
  });

  /**
   * Validation only. Returns true when the draft is invalid and the submit must
   * be cancelled so the operator keeps their visible input and the error.
   *
   * A valid submit is deliberately NOT intercepted: no `preventDefault()` and no
   * router navigation. The browser performs the native `GET /pms/availability`,
   * serialising the named controls from the current draft, and the route's typed
   * search params rebuild the committed state on the resulting page.
   */
  function draftIsInvalid(): boolean {
    if (!DATE.test(draft.arrival) || !DATE.test(draft.departure)) {
      setFormError("Enter a valid arrival and departure date.");
      return true;
    }
    if (draftNights <= 0) {
      setFormError("Departure must be at least one night after arrival.");
      return true;
    }
    if (draft.adults < 1) {
      setFormError("At least one adult is required.");
      return true;
    }
    setFormError(null);
    return false;
  }




  const rooms = availability.data ?? [];
  const byType = rooms.reduce<Record<string, number>>((acc, r) => {
    acc[r.room_type_name] = (acc[r.room_type_name] ?? 0) + 1;
    return acc;
  }, {});

  // Handoffs into booking and waitlist obey the same page permission the route
  // guard applies, so the desk is never offered a screen it cannot open.
  const pagePermitted = usePagePermitted();
  const canBook = pagePermitted("/pms/reservations/new");
  const canWaitlist = pagePermitted("/pms/waitlist");
  const handoff = {
    arrival: committed.arrival,
    departure: committed.departure,
    roomType: committed.roomType,
    adults: committed.adults,
    children: committed.children,
  } as const;

  const groups = groupByProperty(rooms);
  const showCounts = !availability.isLoading && !availability.error;

  return (
    <div>
      <PageHeader
        eyebrow="Front Office"
        title="Availability"
        description="Rooms already assigned, blocked, held or out of order are excluded — this is real availability, not an estimate."
      />

      <SectionCard title="Search" description="">
        {/*
          A real GET form. Every control carries a `name`, the action points at
          this route, and a VALID submit is left entirely to the browser: the
          native GET serialises the current draft into the URL, which is the
          single source of truth for the search. React only cancels the submit
          when the draft is invalid.
        */}
        <form
          method="get"
          action="/pms/availability"
          data-testid="availability-form"
          onSubmit={(e) => {
            if (draftIsInvalid()) e.preventDefault();
          }}
        >


          <div className="grid gap-4 md:grid-cols-5">
            <div className="space-y-2 md:col-span-2">
              <Label>Stay dates</Label>
              {/*
                The native fields stay in the form (visually hidden) so the
                plain GET submit keeps serialising `arrival`/`departure`, and
                keyboard/assistive users retain a direct date entry path
                alongside the calendar.
              */}
              <input
                type="date"
                name="arrival"
                aria-label="Arrival"
                className="sr-only"
                value={draft.arrival}
                onChange={(e) => setDraft((d) => ({ ...d, arrival: e.target.value }))}
              />
              <input
                type="date"
                name="departure"
                aria-label="Departure"
                className="sr-only"
                value={draft.departure}
                onChange={(e) => setDraft((d) => ({ ...d, departure: e.target.value }))}
              />

              <NeoDateRangePicker
                from={draft.arrival}
                to={draft.departure}
                onChange={({ from, to }) => setDraft((d) => ({ ...d, arrival: from, departure: to }))}
                fromLabel="Arrival"
                toLabel="Departure"
                showNights
              />
            </div>
            <div className="space-y-2">
              <Label>Room type</Label>
              <input type="hidden" name="roomType" value={draft.roomType} />
              <Select value={draft.roomType} onValueChange={(v) => setDraft((d) => ({ ...d, roomType: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any type</SelectItem>
                  {(roomTypes.data ?? []).map((rt) => (
                    <SelectItem key={rt.id} value={rt.id}>
                      {rt.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="av-adults">Adults</Label>
              <Input
                id="av-adults"
                name="adults"
                type="number"
                min={1}
                value={draft.adults}
                onChange={(e) => setDraft((d) => ({ ...d, adults: Number(e.target.value) }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="av-children">Children</Label>
              <Input
                id="av-children"
                name="children"
                type="number"
                min={0}
                value={draft.children}
                onChange={(e) => setDraft((d) => ({ ...d, children: Number(e.target.value) }))}
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button type="submit">Search</Button>
            <p className="text-xs text-muted-foreground">
              {draftNights > 0 ? `${draftNights} night(s) selected` : "Departure must be later than arrival"}
            </p>
          </div>
          {formError ? (
            <p role="alert" className="mt-2 text-sm font-medium text-destructive">
              {formError}
            </p>
          ) : null}
        </form>
      </SectionCard>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Rooms available"
          value={availability.isLoading ? "…" : availability.error ? "—" : String(rooms.length)}
          hint={`${nights} night(s)`}
        />
        {showCounts
          ? Object.entries(byType)
              .slice(0, 3)
              .map(([name, count]) => <StatCard key={name} label={name} value={String(count)} hint="available" />)
          : null}
      </div>

      <div className="mt-6">
        <SectionCard title="Available rooms" description={`${committed.arrival} → ${committed.departure}`}>
          <CalendarDayLegend
            className="mb-4"
            states={["available", "limited", "unavailable"]}
          />
          {nights <= 0 ? (
            <EmptyState
              title="Choose a valid date range"
              description="Departure must be at least one night after arrival."
            />
          ) : availability.isLoading ? (
            <div data-testid="availability-loading" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="rounded-lg border border-border p-4">
                  <Skeleton className="h-5 w-24" />
                  <Skeleton className="mt-3 h-4 w-40" />
                  <Skeleton className="mt-2 h-4 w-32" />
                  <Skeleton className="mt-4 h-9 w-full" />
                </div>
              ))}
            </div>
          ) : availability.error ? (
            <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
              <p className="text-sm font-medium text-destructive">Availability could not be loaded</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {(availability.error as Error).message}
              </p>
              <Button className="mt-3" size="sm" variant="outline" onClick={() => void availability.refetch()}>
                Try again
              </Button>
            </div>
          ) : rooms.length === 0 ? (
            <EmptyState
              title="Nothing available for these dates"
              description="No sellable room is free for this stay. Try a different date range or room type, release a block, or add the guest to the waitlist."
              action={
                canWaitlist ? (
                  <Button asChild size="sm" variant="outline">
                    <Link to="/pms/waitlist" search={handoff}>
                      Open waitlist
                    </Link>
                  </Button>
                ) : null
              }
            />
          ) : (
            <div className="space-y-6">
              {canBook ? (
                <div className="flex justify-end">
                  <Button asChild size="sm">
                    <Link to="/pms/reservations/new" search={handoff}>
                      Create reservation with these dates
                    </Link>
                  </Button>
                </div>
              ) : null}
              {groups.map((group) => (
                <div key={group.key}>
                  {groups.length > 1 || !branchId ? (
                    <h3 className="mb-3 text-sm font-semibold text-foreground">
                      {group.label}{" "}
                      <span className="font-normal text-muted-foreground">({group.rooms.length})</span>
                    </h3>
                  ) : null}
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {group.rooms.map((room) => (
                      <RoomCard
                        key={room.room_id}
                        room={room}
                        nights={nights}
                        handoff={handoff}
                        onInspect={() => setInspected(room)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      {/*
        Secondary qualification detail and the reservation action move into the
        inspector on a phone, so a room card never overflows with four
        definition rows and a full-width button.
      */}
      <InspectorSheet
        open={!!inspected}
        onOpenChange={(open) => {
          if (!open) setInspected(null);
        }}
        title={inspected ? `Room ${inspected.room_number}` : "Room"}
        subtitle={inspected?.room_type_name ?? undefined}
        chips={
          inspected ? (
            <>
              <RoomReadinessBadge status={inspected.readiness} />
              <CalendarDayStateBadge state="available" label={`${inspected.nights ?? nights} night(s)`} />
            </>
          ) : null
        }
        footer={
          inspected && canBook ? (
            <Button asChild size="sm">
              <Link
                to="/pms/reservations/new"
                search={{ ...handoff, roomId: inspected.room_id }}
              >
                Create reservation
              </Link>
            </Button>
          ) : null
        }
      >
        {inspected ? (
          <InspectorSection title="Room detail">
            <InspectorField label="Property">
              {inspected.branch_name ?? "Property not set"}
            </InspectorField>
            <InspectorField label="Floor">{inspected.floor || "—"}</InspectorField>
            <InspectorField label="Sleeps">
              {inspected.max_occupancy ? `${inspected.max_occupancy} guest(s)` : "Not set"}
            </InspectorField>
            <InspectorField label="Maintenance">
              {(inspected.maintenance_status ?? "operational").replace(/-/g, " ")}
            </InspectorField>
            <InspectorField label="Qualification">
              {inspected.qualification ?? "Sellable for the selected stay."}
            </InspectorField>
          </InspectorSection>
        ) : null}
      </InspectorSheet>
    </div>
  );
}

export function groupByProperty(rooms: AvailableRoom[]) {
  const map = new Map<string, { key: string; label: string; rooms: AvailableRoom[] }>();
  for (const room of rooms) {
    const key = room.branch_id ?? "unassigned";
    const label = room.branch_name ?? "Property not set";
    const existing = map.get(key);
    if (existing) existing.rooms.push(room);
    else map.set(key, { key, label, rooms: [room] });
  }
  return [...map.values()];
}

function RoomCard({
  room,
  nights,
  handoff,
  onInspect,
}: {
  room: AvailableRoom;
  nights: number;
  handoff: {
    arrival: string;
    departure: string;
    roomType: string;
    adults: number;
    children: number;
  };
  onInspect: () => void;
}) {
  const bookPermitted = usePagePermitted()("/pms/reservations/new");
  const maintenance = room.maintenance_status ?? "operational";
  return (
    <article className="flex h-full min-w-0 flex-col rounded-lg border border-border bg-card p-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs uppercase tracking-wide text-muted-foreground">
            {room.branch_name ?? "Property not set"}
          </p>
          <p className="truncate text-lg font-semibold text-foreground">Room {room.room_number}</p>
          <p className="truncate text-sm text-muted-foreground">{room.room_type_name}</p>
        </div>
        <RoomReadinessBadge status={room.readiness} />
      </div>

      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
        <CalendarDayStateBadge state="available" label={`${room.nights ?? nights} night(s)`} />
      </div>

      {/* Secondary metadata is desktop-only; the inspector carries it on a phone. */}
      <dl className="mt-3 hidden grid-cols-2 gap-2 text-sm sm:grid">
        <div>
          <dt className="text-muted-foreground">Floor</dt>
          <dd className="font-medium">{room.floor || "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Sleeps</dt>
          <dd className="font-medium">{room.max_occupancy ? `${room.max_occupancy} guest(s)` : "Not set"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Maintenance</dt>
          <dd className="font-medium capitalize">{maintenance.replace(/-/g, " ")}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Nights</dt>
          <dd className="font-medium">{room.nights ?? nights}</dd>
        </div>
      </dl>

      <p className="mt-3 hidden text-xs text-muted-foreground sm:block">
        {room.qualification ?? "Sellable for the selected stay."}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onInspect}>
          Details
        </Button>
        {bookPermitted ? (
          <Button asChild size="sm" className="min-w-0 flex-1">
            <Link to="/pms/reservations/new" search={{ ...handoff, roomId: room.room_id }}>
              Create reservation
            </Link>
          </Button>
        ) : null}
      </div>
    </article>
  );
}

