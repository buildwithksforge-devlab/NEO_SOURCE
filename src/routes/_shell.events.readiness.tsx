import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import { AlertTriangle, CheckCircle2, ClipboardList } from "lucide-react";
import {
  DataTable,
  EventsEmpty,
  EventsGuard,
  EventsQueryState,
  Pill,
} from "@/components/events/EventsShared";
import { formatDate, readinessTone } from "@/lib/events";
import { useEventChainStatus, useEventWorkspace } from "@/lib/events-data";

export const Route = createFileRoute("/_shell/events/readiness")({
  head: () => ({
    meta: [
      { title: "Event Department Readiness — NEØ" },
      {
        name: "description",
        content: "Department readiness for every upcoming event at the selected property.",
      },
      { property: "og:title", content: "Event Department Readiness — NEØ" },
      {
        property: "og:description",
        content: "Department readiness for every upcoming event at the selected property.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <EventsGuard feature="readiness">
      <Page />
    </EventsGuard>
  ),
});

const count = (v: number | null | undefined): number => Number(v ?? 0);

function state(row: {
  readiness_total: number | null;
  readiness_ready: number | null;
  readiness_blocked: number | null;
}): string {
  if (count(row.readiness_total) === 0) return "not-started";
  if (count(row.readiness_blocked) > 0) return "blocked";
  if (count(row.readiness_ready) >= count(row.readiness_total)) return "ready";
  return "in-progress";
}

function Page() {
  const workspace = useEventWorkspace();
  const rows = (workspace.data ?? []).filter((r) => !["cancelled"].includes(r.status));

  const blocked = rows.filter((r) => count(r.readiness_blocked) > 0).length;
  const ready = rows.filter(
    (r) => count(r.readiness_total) > 0 && count(r.readiness_ready) >= count(r.readiness_total),
  ).length;
  const missing = rows.filter((r) => count(r.readiness_total) === 0).length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Events & Banqueting"
        title="Department Readiness"
        description="Derived from the department requirements recorded on each event — nothing is estimated."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Events fully ready" value={String(ready)} icon={CheckCircle2} />
        <StatCard label="Events with blockers" value={String(blocked)} icon={AlertTriangle} />
        <StatCard label="No requirements recorded" value={String(missing)} icon={ClipboardList} />
      </div>

      <ChainSection />


      <SectionCard
        title="Readiness by event"
        description={`${rows.length} live events for the selected property`}
      >
        <EventsQueryState
          isLoading={workspace.isLoading}
          error={workspace.error}
          isEmpty={rows.length === 0}
          empty={
            <EventsEmpty
              title="No live events"
              description="Readiness appears once an event exists and its departments have requirements."
            />
          }
        >
          <DataTable
            head={[
              "Reference",
              "Event",
              "Date",
              "Venue",
              "Requirements",
              "Ready",
              "Blocked",
              "State",
            ]}
          >
            {rows.map((r) => (
              <tr key={r.booking_id}>
                <td className="py-2 pr-4">
                  <Link
                    to="/events/bookings/$id"
                    params={{ id: r.booking_id }}
                    className="font-medium text-primary hover:underline"
                  >
                    {r.event_reference}
                  </Link>
                </td>
                <td className="py-2 pr-4">{r.event_name ?? "—"}</td>
                <td className="py-2 pr-4">{formatDate(r.event_date)}</td>
                <td className="py-2 pr-4">{r.venue_name ?? "—"}</td>
                <td className="py-2 pr-4">{count(r.readiness_total)}</td>
                <td className="py-2 pr-4">{count(r.readiness_ready)}</td>
                <td className="py-2 pr-4">{count(r.readiness_blocked)}</td>
                <td className="py-2 pr-4">
                  <Pill tone={readinessTone(state(r))} value={state(r)} />
                </td>
              </tr>
            ))}
          </DataTable>
        </EventsQueryState>
      </SectionCard>
    </div>
  );
}

/**
 * The chain itself: booking → banquet order → kitchen, housekeeping, front
 * office → billing → payment. A handoff that never happened is named here
 * rather than left to be discovered on the day of the event.
 */
function ChainSection() {
  const chain = useEventChainStatus();
  const rows = (chain.data ?? []).filter((r) => r.status !== "cancelled");
  const broken = rows.filter((r) => (r.missing ?? []).length > 0);

  return (
    <SectionCard
      title="Event handoff chain"
      description="Booking → banquet order → kitchen, housekeeping, front office → billing → payment."
    >
      <EventsQueryState
        isLoading={chain.isLoading}
        error={chain.error}
        isEmpty={rows.length === 0}
        empty={
          <EventsEmpty
            title="No events"
            description="The chain appears once an event exists for this property."
          />
        }
      >
        <p className="mb-3 text-sm text-muted-foreground">
          {broken.length === 0
            ? "Every event has been handed to all departments and billed."
            : `${broken.length} of ${rows.length} events are missing at least one handoff.`}
        </p>
        <DataTable
          head={[
            "Reference",
            "Event",
            "Date",
            "Banquet order",
            "Kitchen",
            "Housekeeping",
            "Front office",
            "Venue job",
            "Billing",
            "Paid",
            "Missing",
          ]}
        >
          {rows.map((r) => (
            <tr key={r.booking_id}>
              <td className="py-2 pr-4">
                <Link
                  to="/events/bookings/$id"
                  params={{ id: r.booking_id }}
                  className="font-medium text-primary hover:underline"
                >
                  {r.event_reference}
                </Link>
              </td>
              <td className="py-2 pr-4">{r.event_name ?? "—"}</td>
              <td className="py-2 pr-4">{formatDate(r.event_date)}</td>
              <td className="py-2 pr-4">
                <Pill
                  tone={r.beo_status === "published" ? "success" : "warning"}
                  value={r.beo_status ?? "none"}
                />
              </td>
              <td className="py-2 pr-4">{r.kitchen_handoff ? "Yes" : "No"}</td>
              <td className="py-2 pr-4">{r.housekeeping_handoff ? "Yes" : "No"}</td>
              <td className="py-2 pr-4">{r.front_office_handoff ? "Yes" : "No"}</td>
              <td className="py-2 pr-4">{r.housekeeping_job ? "Yes" : "No"}</td>
              <td className="py-2 pr-4">{r.billing_items}</td>
              <td className="py-2 pr-4">{Number(r.paid_amount ?? 0) > 0 ? "Yes" : "No"}</td>
              <td className="py-2 pr-4 text-muted-foreground">
                {(r.missing ?? []).join(", ") || "—"}
              </td>
            </tr>
          ))}
        </DataTable>
      </EventsQueryState>
    </SectionCard>
  );
}

