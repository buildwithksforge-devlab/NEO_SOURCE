import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpDown, CalendarPlus, CircleDot, LogIn, LogOut, Star, Users } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/common/DataDisplay";
import {
  CatalogueGroup,
  CatalogueQueryBar,
  CatalogueRail,
  CatalogueRow,
  CatalogueWorkspace,
  type ActiveFilterChip,
} from "@/components/common/CatalogueWorkspace";
import {
  InspectorField,
  InspectorSection,
  InspectorSheet,
} from "@/components/common/InspectorSheet";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NeoDateRangePicker } from "@/components/common/DatePicker";
import { RESERVATION_STATUSES, formatDate, money, titleCase } from "@/lib/pms";
import { useReservations } from "@/lib/pms-data";
import {
  EmptyState,
  PmsGuard,
  QueryState,
  ReservationStatusBadge,
} from "@/components/pms/PmsShared";
import type { ReservationRow } from "@/components/pms/MovementBoard";

export const Route = createFileRoute("/_shell/pms/reservations/")({
  head: () => ({
    meta: [
      { title: "Reservations — NEØ" },
      {
        name: "description",
        content: "Search, filter and manage every booking from enquiry through to departure.",
      },
      { property: "og:title", content: "Reservations — NEØ" },
      {
        property: "og:description",
        content: "Search, filter and manage every booking from enquiry through to departure.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PmsGuard action="reservations.view">
      <ReservationDirectory />
    </PmsGuard>
  ),
});

/**
 * Front Office reservation directory.
 *
 * The subject is the booking, so the page leads with the day's movement
 * figures — each one a filter, not a read-only tile — then a single
 * identity-led list grouped by arrival date. Selecting a booking opens the
 * inspector beside the list so the receptionist keeps their filters and their
 * place; the full record is one click further on.
 */
function ReservationDirectory() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const query = useReservations({ scope: "all", status, search, from, to });
  const rows = (query.data ?? []) as unknown as ReservationRow[];

  const today = new Date().toISOString().slice(0, 10);

  const counts = useMemo(() => {
    let arrivals = 0;
    let departures = 0;
    let inHouse = 0;
    let unassigned = 0;
    for (const r of rows) {
      if (r.arrival_date === today) arrivals += 1;
      if (r.departure_date === today) departures += 1;
      if (r.status === "checked-in" || r.status === "in-house") inHouse += 1;
      if (!r.rooms?.room_number) unassigned += 1;
    }
    return { arrivals, departures, inHouse, unassigned, vip: rows.filter((r) => r.is_vip).length };
  }, [rows, today]);

  const statusRail = useMemo(
    () =>
      RESERVATION_STATUSES.map((s) => ({
        id: s,
        label: titleCase(s),
        count: rows.filter((r) => r.status === s).length,
      })),
    [rows],
  );

  /** Client-side lens over the already-scoped server result. */
  const [lens, setLens] = useState<
    "all" | "arrivals" | "departures" | "in-house" | "unassigned" | "vip"
  >("all");

  /** How the directory is ranked. Arrival order is the operational default. */
  const [sort, setSort] = useState<"arrival" | "newest" | "guest" | "value">("arrival");

  const visible = useMemo(() => {
    switch (lens) {
      case "arrivals":
        return rows.filter((r) => r.arrival_date === today);
      case "departures":
        return rows.filter((r) => r.departure_date === today);
      case "in-house":
        return rows.filter((r) => r.status === "checked-in" || r.status === "in-house");
      case "unassigned":
        return rows.filter((r) => !r.rooms?.room_number);
      case "vip":
        return rows.filter((r) => r.is_vip);
      default:
        return rows;
    }
  }, [rows, lens, today]);

  const ordered = useMemo(() => {
    const list = [...visible];
    switch (sort) {
      case "newest":
        return list.sort((a, b) =>
          String((b as { created_at?: string }).created_at ?? "").localeCompare(
            String((a as { created_at?: string }).created_at ?? ""),
          ),
        );
      case "guest":
        return list.sort((a, b) =>
          (a.customers?.full_name ?? "").localeCompare(b.customers?.full_name ?? ""),
        );
      case "value":
        return list.sort((a, b) => Number(b.total_amount ?? 0) - Number(a.total_amount ?? 0));
      default:
        return list.sort((a, b) => (a.arrival_date ?? "").localeCompare(b.arrival_date ?? ""));
    }
  }, [visible, sort]);

  const grouped = useMemo(() => {
    if (sort !== "arrival") {
      return [[SORT_LABEL[sort], ordered]] as [string, ReservationRow[]][];
    }
    const map = new Map<string, ReservationRow[]>();
    for (const r of ordered) {
      const key = r.arrival_date ?? "unscheduled";
      const bucket = map.get(key);
      if (bucket) bucket.push(r);
      else map.set(key, [r]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [ordered, sort]);

  const figures: SummaryFigure[] = [
    {
      id: "arrivals",
      label: "Arriving today",
      value: counts.arrivals,
      tone: "info",
      icon: LogIn,
      active: lens === "arrivals",
      onSelect: () => setLens((l) => (l === "arrivals" ? "all" : "arrivals")),
    },
    {
      id: "departures",
      label: "Departing today",
      value: counts.departures,
      tone: "warning",
      icon: LogOut,
      active: lens === "departures",
      onSelect: () => setLens((l) => (l === "departures" ? "all" : "departures")),
    },
    {
      id: "in-house",
      label: "In house",
      value: counts.inHouse,
      tone: "success",
      icon: Users,
      active: lens === "in-house",
      onSelect: () => setLens((l) => (l === "in-house" ? "all" : "in-house")),
    },
    {
      id: "vip",
      label: "VIP & priority",
      value: counts.vip,
      tone: "accent",
      icon: Star,
      active: lens === "vip",
      onSelect: () => setLens((l) => (l === "vip" ? "all" : "vip")),
    },
    {
      id: "unassigned",
      label: "No room yet",
      value: counts.unassigned,
      tone: counts.unassigned > 0 ? "warning" : "default",
      icon: CircleDot,
      active: lens === "unassigned",
      onSelect: () => setLens((l) => (l === "unassigned" ? "all" : "unassigned")),
    },
  ];

  const activeFilters: ActiveFilterChip[] = [
    ...(from ? [{ id: "from", label: `From ${formatDate(from)}`, onClear: () => setFrom("") }] : []),
    ...(to ? [{ id: "to", label: `To ${formatDate(to)}`, onClear: () => setTo("") }] : []),
    ...(lens !== "all"
      ? [{ id: "lens", label: titleCase(lens), onClear: () => setLens("all") }]
      : []),
  ];

  const selected = visible.find((r) => r.id === selectedId) ?? null;

  return (
    <div>
      <PageHeader
        eyebrow="Front Office"
        title="Reservations"
        description="The single reservation record every other module reads from — CRM, folios, housekeeping and reports."
        actions={
          <Button asChild size="sm">
            <Link to="/pms/reservations/new">
              <CalendarPlus className="mr-2 size-4" /> New reservation
            </Link>
          </Button>
        }
      />

      <SummaryStrip
        lead={{
          id: "total",
          label: "Reservations in view",
          value: visible.length,
          hint: lens === "all" ? "All matching bookings" : "Filtered by the selected figure",
          active: lens === "all",
          onSelect: () => setLens("all"),
        }}
        figures={figures}
      />

      <CatalogueWorkspace
        rail={
          <CatalogueRail
            title="Status"
            items={statusRail}
            value={status}
            onChange={setStatus}
            allLabel="All statuses"
            allCount={rows.length}
          />
        }
      >
        <CatalogueQueryBar
          search={search}
          onSearch={setSearch}
          placeholder="Confirmation number, reference or guest"
          actions={
            <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
              <SelectTrigger className="w-48" aria-label="Sort reservations">
                <ArrowUpDown className="mr-1 size-3.5 shrink-0 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="arrival">Arrival date</SelectItem>
                <SelectItem value="newest">Newest booked</SelectItem>
                <SelectItem value="guest">Guest A–Z</SelectItem>
                <SelectItem value="value">Highest value</SelectItem>
              </SelectContent>
            </Select>
          }
          activeFilters={activeFilters}
          onClearAll={
            activeFilters.length
              ? () => {
                  setFrom("");
                  setTo("");
                  setLens("all");
                }
              : undefined
          }
          filters={
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label>Arrival range</Label>
                <NeoDateRangePicker
                  from={from}
                  to={to}
                  onChange={({ from, to }) => {
                    setFrom(from);
                    setTo(to);
                  }}
                  fromLabel="Arrival from"
                  toLabel="Arrival to"
                  quick={["today", "tomorrow", "next-7", "this-month"]}
                />
              </div>
            </div>
          }
        />

        <QueryState
          isLoading={query.isLoading}
          error={query.error}
          isEmpty={visible.length === 0}
          empty={
            <EmptyState
              title={rows.length ? "Nothing matches this view" : "No reservations yet"}
              description={
                rows.length
                  ? "Clear the selected figure or filters to see the rest of the directory."
                  : "Create the first booking and it will flow into arrivals, folios, housekeeping and the guest profile."
              }
              action={
                rows.length ? (
                  <Button size="sm" variant="outline" onClick={() => setLens("all")}>
                    Show all
                  </Button>
                ) : (
                  <Button asChild size="sm">
                    <Link to="/pms/reservations/new">New reservation</Link>
                  </Button>
                )
              }
            />
          }
        >
          <div>
            {grouped.map(([day, items]) => (
              <CatalogueGroup
                key={day}
                label={
                  sort !== "arrival"
                    ? day
                    : day === "unscheduled"
                      ? "Unscheduled"
                      : formatDate(day)
                }
                count={items.length}
              >
                {items.map((r) => {
                  const guest = r.customers?.full_name ?? "Unnamed guest";
                  const initials =
                    guest
                      .split(/\s+/)
                      .filter(Boolean)
                      .slice(0, 2)
                      .map((p) => p[0])
                      .join("") || "?";
                  const accent = r.is_vip
                    ? "accent"
                    : !r.rooms?.room_number
                      ? "warning"
                      : r.status === "checked-in" || r.status === "in-house"
                        ? "success"
                        : r.arrival_date === today
                          ? "info"
                          : "default";
                  return (
                    <CatalogueRow
                      key={r.id}
                      title={guest}
                      monogram={initials}
                      accent={accent}
                      subtitle={`${r.confirmation_number} · ${r.nights} night(s) · ${
                        r.rooms?.room_number
                          ? `Room ${r.rooms.room_number}`
                          : "Room not assigned"
                      }`}
                      selected={selectedId === r.id}
                      onOpen={() => setSelectedId(r.id)}
                      chips={
                        <>
                          <ReservationStatusBadge status={r.status} />
                          {r.is_vip ? <Badge variant="vip">VIP</Badge> : null}
                          {r.arrival_date === today ? (
                            <Badge variant="secondary">Arriving today</Badge>
                          ) : null}
                          {r.departure_date === today ? (
                            <Badge variant="secondary">Departing today</Badge>
                          ) : null}
                        </>
                      }
                      trailing={money(r.total_amount)}
                      trailingLabel="Stay total"
                    />
                  );
                })}

              </CatalogueGroup>
            ))}
          </div>
        </QueryState>
      </CatalogueWorkspace>

      <InspectorSheet
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        title={selected?.customers?.full_name ?? "Reservation"}
        subtitle={selected?.confirmation_number ?? undefined}
        chips={
          selected ? (
            <>
              <ReservationStatusBadge status={selected.status} />
              {selected.is_vip ? <Badge variant="vip">VIP</Badge> : null}
            </>
          ) : null
        }
        footer={
          selected ? (
            <Button asChild size="sm">
              <Link to="/pms/reservations/$id" params={{ id: selected.id }}>
                Open full reservation
              </Link>
            </Button>
          ) : null
        }
      >
        {selected ? (
          <>
            <InspectorSection title="Stay">
              <InspectorField label="Arrival">{formatDate(selected.arrival_date)}</InspectorField>
              <InspectorField label="Departure">
                {formatDate(selected.departure_date)}
              </InspectorField>
              <InspectorField label="Nights">{selected.nights}</InspectorField>
              <InspectorField label="Room">
                {selected.rooms?.room_number ?? "Not assigned"}
              </InspectorField>
              <InspectorField label="Room type">{selected.room_types?.name ?? "—"}</InspectorField>
            </InspectorSection>
            <InspectorSection title="Commercial">
              <InspectorField label="Source">{titleCase(selected.booking_source)}</InspectorField>
              <InspectorField label="Total">{money(selected.total_amount)}</InspectorField>
            </InspectorSection>
          </>
        ) : null}
      </InspectorSheet>
    </div>
  );
}

const SORT_LABEL: Record<"newest" | "guest" | "value", string> = {
  newest: "Newest booked first",
  guest: "Guest A–Z",
  value: "Highest value first",
};
