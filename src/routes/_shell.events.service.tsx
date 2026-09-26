/**
 * Banquet service board.
 *
 * Shows every banquet order's planned set-up, service and clear-down times
 * next to the real moments the floor stamped. Planned and actual are never
 * merged: an event that started late should read as started late, not as a
 * tidy plan. Stamping is guarded in the database and written to the audit
 * trail with the person who recorded it.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { ClipboardCheck, PlayCircle, Square, Sparkles } from "lucide-react";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import {
  DataTable,
  EventsEmpty,
  EventsGuard,
  EventsQueryState,
  Pill,
} from "@/components/events/EventsShared";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { useBanquetService, useStampBanquetMoment } from "@/lib/events-data";
import type { Row } from "@/lib/events";

export const Route = createFileRoute("/_shell/events/service")({
  head: () => ({
    meta: [
      { title: "Banquet Service — NEØ" },
      {
        name: "description",
        content:
          "Set-up, service and clear-down times for every banquet, with the real start and finish recorded on the floor.",
      },
      { property: "og:title", content: "Banquet Service — NEØ" },
      {
        property: "og:description",
        content: "Planned and actual banquet set-up, service and clear-down times.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <EventsGuard feature="banqueting">
      <Page />
    </EventsGuard>
  ),
});

function when(value: unknown) {
  if (!value) return "—";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function durationLabel(start: unknown, end: unknown) {
  if (!start || !end) return "—";
  const a = new Date(String(start)).getTime();
  const b = new Date(String(end)).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return "—";
  const minutes = Math.round((b - a) / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function Page() {
  const { can } = useAuth();
  const mayStamp = can("events", "banqueting", "update");
  const service = useBanquetService();
  const stamp = useStampBanquetMoment();
  const rows = (service.data ?? []) as Row[];

  const inService = rows.filter((r) => r["service_started_at"] && !r["service_ended_at"]).length;
  const awaiting = rows.filter((r) => !r["service_started_at"]).length;
  const cleared = rows.filter((r) => r["cleanup_done_at"]).length;

  function stampRow(id: string, moment: string) {
    stamp.mutate({ beoId: id, moment });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ClipboardCheck}
        eyebrow="Events"
        title="Banquet service"
        description="Planned set-up, service and clear-down against the real times recorded on the floor."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/events/banqueting">Banquet orders</Link>
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Banquets in service" value={String(inService)} icon={PlayCircle} />
        <StatCard label="Not yet started" value={String(awaiting)} icon={Square} />
        <StatCard label="Cleared down" value={String(cleared)} icon={Sparkles} />
      </div>

      <SectionCard
        title="Banquet orders"
        description="Each row shows what was planned and what actually happened. Times are recorded one step at a time: set-up complete, service start, service finish, then cleared."
      >
        <EventsQueryState
          query={service}
          isLoading={service.isLoading}
          error={service.error}
          isEmpty={rows.length === 0}
          empty={
            <EventsEmpty
              title="No banquet orders at this property"
              description="Raise and publish a banquet order from an event booking and it will appear here for the floor to run."
            />
          }
        >
          {(
            <DataTable
              unit="banquet orders"
              head={[
                "Banquet",
                "Event",
                "Planned set-up",
                "Planned service",
                "Planned clear",
                "Actual set-up done",
                "Actual service",
                "Actual clear",
                "On floor",
                "Record",
              ]}
            >
              {rows.map((r) => {
                const booking = (r["event_bookings"] ?? {}) as Row;
                const id = String(r["id"]);
                const started = Boolean(r["service_started_at"]);
                const ended = Boolean(r["service_ended_at"]);
                const clearedDown = Boolean(r["cleanup_done_at"]);
                return (
                  <tr key={id} className="border-b border-border/60 last:border-0">
                    <td className="py-2 pr-4">
                      <div className="font-medium">{String(r["beo_number"] ?? "—")}</div>
                      <div className="text-xs text-muted-foreground">
                        rev {String(r["revision"] ?? 1)} · <Pill tone="default" value={String(r["status"] ?? "draft")} />
                      </div>
                    </td>
                    <td className="py-2 pr-4">
                      <div>{String(booking["event_name"] ?? "—")}</div>
                      <div className="text-xs text-muted-foreground">
                        {String(booking["event_reference"] ?? "")}
                      </div>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{when(r["setup_at"])}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {when(r["start_at"])} → {when(r["end_at"])}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{when(r["breakdown_at"])}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{when(r["setup_done_at"])}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {when(r["service_started_at"])} → {when(r["service_ended_at"])}
                      <div className="text-xs text-muted-foreground">
                        {durationLabel(r["service_started_at"], r["service_ended_at"])}
                      </div>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{when(r["cleanup_done_at"])}</td>
                    <td className="py-2 pr-4">
                      {clearedDown ? (
                        <Pill tone="success" value="Cleared" />
                      ) : ended ? (
                        <Pill tone="warning" value="Service finished" />
                      ) : started ? (
                        <Pill tone="info" value="In service" />
                      ) : r["setup_done_at"] ? (
                        <Pill tone="default" value="Set up" />
                      ) : (
                        <Pill tone="default" value="Not started" />
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {!mayStamp ? (
                        <span className="text-xs text-muted-foreground">View only</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {!r["setup_done_at"] ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={stamp.isPending}
                              onClick={() => stampRow(id, "setup_done")}
                            >
                              Set-up done
                            </Button>
                          ) : null}
                          {!started ? (
                            <Button size="sm" disabled={stamp.isPending} onClick={() => stampRow(id, "service_started")}>
                              Start service
                            </Button>
                          ) : null}
                          {started && !ended ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={stamp.isPending}
                              onClick={() => stampRow(id, "service_ended")}
                            >
                              Finish service
                            </Button>
                          ) : null}
                          {ended && !clearedDown ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={stamp.isPending}
                              onClick={() => stampRow(id, "cleanup_done")}
                            >
                              Cleared
                            </Button>
                          ) : null}
                          {clearedDown ? <span className="text-xs text-muted-foreground">Complete</span> : null}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          )}
        </EventsQueryState>
      </SectionCard>
    </div>
  );
}
