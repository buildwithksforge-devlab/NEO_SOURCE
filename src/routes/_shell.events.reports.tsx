import { createFileRoute } from "@tanstack/react-router";
import { CalendarCheck, Percent, TrendingUp, Users } from "lucide-react";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import {
  DataTable,
  EventsEmpty,
  EventsGuard,
  EventsQueryState,
  NotConfigured,
} from "@/components/events/EventsShared";
import { useTenant } from "@/lib/tenant";
import { formatMoney, num, titleCase, type Row } from "@/lib/events";
import { useEventReports } from "@/lib/events-data";

export const Route = createFileRoute("/_shell/events/reports")({
  head: () => ({
    meta: [
      { title: "Event Reports — NEØ" },
      {
        name: "description",
        content:
          "Pipeline, conversion, revenue and readiness reporting for events at the selected property.",
      },
      { property: "og:title", content: "Event Reports — NEØ" },
      {
        property: "og:description",
        content: "Pipeline, conversion, revenue and readiness reporting for events.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <EventsGuard feature="reports">
      <Page />
    </EventsGuard>
  ),
});

function Page() {
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;
  const report = useEventReports();
  const data = (report.data ?? {}) as Row;

  const bookings = (data["bookings"] ?? {}) as Row;
  const revenue = (data["revenue"] ?? {}) as Row;
  const pipeline = (data["pipeline"] ?? {}) as Row;
  const readiness = (data["readiness"] ?? {}) as Row;
  const byStatus = (data["by_status"] ?? []) as Row[];
  const byVenue = (data["by_venue"] ?? []) as Row[];

  const conversion =
    num(pipeline["enquiries"]) > 0
      ? Math.round((num(pipeline["converted"]) / num(pipeline["enquiries"])) * 100)
      : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Events & Banqueting"
        title="Event Reports"
        description="Counts and money are computed by the database from the same records every other events screen uses."
      />

      <EventsQueryState
        isLoading={report.isLoading}
        error={report.error}
        isEmpty={false}
        empty={null}
      >
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Events in range"
              value={String(num(bookings["total"]))}
              icon={CalendarCheck}
              hint={`${num(bookings["confirmed"])} confirmed`}
            />
            <StatCard label="Guests" value={String(num(bookings["guests"]))} icon={Users} />
            <StatCard
              label="Contracted revenue"
              value={formatMoney(symbol, revenue["contracted"])}
              icon={TrendingUp}
              hint={`${formatMoney(symbol, revenue["outstanding"])} outstanding`}
            />
            <StatCard
              label="Enquiry conversion"
              value={`${conversion}%`}
              icon={Percent}
              hint={`${num(pipeline["enquiries"])} enquiries`}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <SectionCard title="Events by status" description="Every event in the reporting range">
              {byStatus.length === 0 ? (
                <EventsEmpty
                  title="No events in range"
                  description="Adjust the property selection or create an event."
                />
              ) : (
                <DataTable head={["Status", "Events", "Value"]}>
                  {byStatus.map((s) => (
                    <tr key={String(s["status"])}>
                      <td className="py-2 pr-4 font-medium">{titleCase(String(s["status"]))}</td>
                      <td className="py-2 pr-4">{num(s["count"])}</td>
                      <td className="py-2 pr-4">{formatMoney(symbol, s["value"])}</td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </SectionCard>

            <SectionCard title="Events by venue" description="Utilisation of each function space">
              {byVenue.length === 0 ? (
                <EventsEmpty
                  title="No venue activity"
                  description="Venue usage appears once events are scheduled."
                />
              ) : (
                <DataTable head={["Venue", "Events", "Value"]}>
                  {byVenue.map((v) => (
                    <tr key={String(v["venue"])}>
                      <td className="py-2 pr-4 font-medium">{String(v["venue"])}</td>
                      <td className="py-2 pr-4">{num(v["count"])}</td>
                      <td className="py-2 pr-4">{formatMoney(symbol, v["value"])}</td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </SectionCard>
          </div>

          <SectionCard
            title="Pipeline and readiness"
            description="Enquiry to event, and department preparedness"
          >
            <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
              {[
                ["Enquiries", num(pipeline["enquiries"])],
                ["Converted", num(pipeline["converted"])],
                ["Quotations", num(pipeline["quotations"])],
                ["Accepted", num(pipeline["quotations_accepted"])],
                ["Requirements", num(readiness["total"])],
                ["Blocked", num(readiness["blocked"])],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg border border-border px-3 py-2">
                  <p className="text-xs text-muted-foreground">{String(label)}</p>
                  <p className="text-lg font-semibold">{String(value)}</p>
                </div>
              ))}
            </div>
            {num(readiness["total"]) === 0 ? (
              <div className="mt-3">
                <NotConfigured
                  label="Department requirements"
                  note="No department requirements have been recorded for events in this range, so readiness cannot be reported."
                />
              </div>
            ) : null}
          </SectionCard>
        </div>
      </EventsQueryState>
    </div>
  );
}
