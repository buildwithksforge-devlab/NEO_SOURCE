import { createFileRoute } from "@tanstack/react-router";
import { MessageSquare, Star, TriangleAlert } from "lucide-react";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import {
  DataTable,
  EventsEmpty,
  EventsGuard,
  EventsQueryState,
  Pill,
} from "@/components/events/EventsShared";
import { formatDate, num, type Row } from "@/lib/events";
import { useEventFeedback } from "@/lib/events-data";

export const Route = createFileRoute("/_shell/events/feedback")({
  head: () => ({
    meta: [
      { title: "Event Feedback — NEØ" },
      {
        name: "description",
        content:
          "Client feedback, ratings and open service recovery for events at the selected property.",
      },
      { property: "og:title", content: "Event Feedback — NEØ" },
      {
        property: "og:description",
        content: "Client feedback, ratings and open service recovery for events.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <EventsGuard feature="feedback">
      <Page />
    </EventsGuard>
  ),
});

function Page() {
  const feedback = useEventFeedback();
  const rows = (feedback.data ?? []) as Row[];

  const rated = rows.filter((r) => num(r["rating_overall"]) > 0);
  const average = rated.length
    ? rated.reduce((s, r) => s + num(r["rating_overall"]), 0) / rated.length
    : 0;
  const open = rows.filter((r) => String(r["resolution_status"] ?? "open") === "open").length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Events & Banqueting"
        title="Event Feedback"
        description="Responses recorded against real events — no scores are inferred or simulated."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Responses" value={String(rows.length)} icon={MessageSquare} />
        <StatCard
          label="Average rating"
          value={rated.length ? average.toFixed(1) : "Awaiting Data"}
          icon={Star}
        />
        <StatCard label="Open follow-ups" value={String(open)} icon={TriangleAlert} />
      </div>

      <SectionCard
        title="Responses"
        description={`${rows.length} responses for the selected property`}
      >
        <EventsQueryState
          isLoading={feedback.isLoading}
          error={feedback.error}
          isEmpty={rows.length === 0}
          empty={
            <EventsEmpty
              title="No feedback yet"
              description="Feedback appears once a client responds after an event."
            />
          }
        >
          <DataTable
            head={[
              "Event",
              "Client",
              "Overall",
              "Food",
              "Service",
              "Venue",
              "Comments",
              "Status",
              "Received",
            ]}
          >
            {rows.map((f) => (
              <tr key={String(f["id"])}>
                <td className="py-2 pr-4 font-medium">
                  {String((f["event_bookings"] as Row | null)?.["event_reference"] ?? "—")}
                  <div className="text-xs text-muted-foreground">
                    {String((f["event_bookings"] as Row | null)?.["event_name"] ?? "")}
                  </div>
                </td>
                <td className="py-2 pr-4">
                  {String((f["customers"] as Row | null)?.["full_name"] ?? "—")}
                </td>
                <td className="py-2 pr-4">{num(f["rating_overall"]) || "—"}</td>
                <td className="py-2 pr-4">{num(f["rating_food"]) || "—"}</td>
                <td className="py-2 pr-4">{num(f["rating_service"]) || "—"}</td>
                <td className="py-2 pr-4">{num(f["rating_venue"]) || "—"}</td>
                <td className="max-w-72 py-2 pr-4 text-muted-foreground">
                  {String(f["comments"] || "—")}
                </td>
                <td className="py-2 pr-4">
                  <Pill
                    tone={
                      String(f["resolution_status"] ?? "open") === "resolved"
                        ? "success"
                        : "warning"
                    }
                    value={String(f["resolution_status"] ?? "open")}
                  />
                </td>
                <td className="py-2 pr-4">{formatDate(f["created_at"])}</td>
              </tr>
            ))}
          </DataTable>
        </EventsQueryState>
      </SectionCard>
    </div>
  );
}
