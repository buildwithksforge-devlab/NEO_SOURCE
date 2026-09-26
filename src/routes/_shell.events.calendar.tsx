import { useMemo, useState } from "react";

import { useStableValue } from "@/lib/calendar-view";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  CalendarDayLegend,
  CalendarMonthGrid,
  CalendarMonthSkeleton,
  CalendarToolbar,
} from "@/components/common/CalendarSurface";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { EventsEmpty, EventsGuard, EventsQueryState, Pill } from "@/components/events/EventsShared";
import { bookingTone, num } from "@/lib/events";
import { useEventWorkspace, type EventWorkspaceRow } from "@/lib/events-data";

export const Route = createFileRoute("/_shell/events/calendar")({
  head: () => ({
    meta: [
      { title: "Events Calendar — NEØ" },
      {
        name: "description",
        content: "Month view of every confirmed and provisional function at the selected property.",
      },
      { property: "og:title", content: "Events Calendar — NEØ" },
      {
        property: "og:description",
        content: "Month view of every confirmed and provisional function.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <EventsGuard feature="calendar">
      <Page />
    </EventsGuard>
  ),
});

const iso = (d: Date) => d.toISOString().slice(0, 10);

function Page() {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  });

  const start = useMemo(
    () => new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1)),
    [cursor],
  );
  const end = useMemo(
    () => new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)),
    [cursor],
  );

  const workspace = useEventWorkspace({ from: iso(start), to: iso(end) });
  const rows = workspace.data ?? [];

  const byDay = useMemo(() => {
    const map = new Map<string, EventWorkspaceRow[]>();
    for (const r of rows) {
      const key = String(r.event_date).slice(0, 10);
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    return map;
  }, [rows]);

  const todayIso = new Date().toISOString().slice(0, 10);

  const dayKeys = useMemo<(string | null)[]>(() => {
    const leading = start.getUTCDay();
    const days = end.getUTCDate();
    return [
      ...Array.from({ length: leading }, () => null),
      ...Array.from({ length: days }, (_, i) =>
        iso(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), i + 1))),
      ),
    ];
  }, [start, end]);
  const monthLabel = start.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  /**
   * Cells are derived once per month + dataset, and retained while a refetch is
   * in flight, so rapid Prev/Next navigation keeps the current day states (and
   * the selected day) stable instead of collapsing to an empty grid.
   */
  const derivedCells = useMemo(
    () =>
      dayKeys.map((day, i) => {
        const entries = day ? (byDay.get(day) ?? []) : [];
        return {
          key: day ?? `pad-${i}`,
          day: day ? Number(day.slice(8)) : null,
          today: day === todayIso,
          count: entries.length,
          content: entries.map((e) => (
            <Link
              key={e.booking_id}
              to="/events/bookings/$id"
              params={{ id: e.booking_id }}
              className="block min-w-0 rounded border border-border bg-muted/50 px-1.5 py-1 text-xs hover:bg-muted"
            >
              <span className="block truncate font-medium">
                {e.event_name ?? e.event_reference}
              </span>
              <span className="block truncate text-[10px] text-muted-foreground">
                {e.venue_name ?? "Venue not set"} ·{" "}
                {num(e.final_guests) || num(e.guaranteed_guests) || num(e.expected_guests)}{" "}
                guests
              </span>
              <Pill tone={bookingTone(e.status)} value={e.status} />
            </Link>
          )),
        };
      }),

    [dayKeys, byDay, todayIso],
  );
  const monthCells = useStableValue(
    derivedCells,
    workspace.isFetching && !workspace.isLoading,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Events & Banqueting"
        title="Events Calendar"
        description="Reads the same authoritative event records as the dashboard and bookings register."
        actions={
          <CalendarToolbar
            label={monthLabel}
            prevLabel="Previous month"
            nextLabel="Next month"
            onPrev={() =>
              setCursor(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1)))
            }
            onNext={() =>
              setCursor(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)))
            }
            onToday={() => {
              const now = new Date();
              setCursor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
            }}
          />
        }
      />

      <SectionCard title={monthLabel} description={`${rows.length} events scheduled this month`}>
        <EventsQueryState
          isLoading={workspace.isLoading}
          error={workspace.error}
          isEmpty={false}
          empty={
            <EventsEmpty
              title="Nothing scheduled"
              description="Confirmed events appear on the day they run."
            />
          }
        >
          <CalendarDayLegend className="mb-3" states={["today", "available", "limited"]} />
          {workspace.isLoading ? <CalendarMonthSkeleton /> : null}
          <CalendarMonthGrid
            ariaLabel={monthLabel}
            cells={monthCells}
          />
        </EventsQueryState>
      </SectionCard>
    </div>
  );
}
