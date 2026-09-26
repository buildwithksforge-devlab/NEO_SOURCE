import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import {
  DataTable,
  EventsEmpty,
  EventsGuard,
  EventsQueryState,
  FormDialog,
  Pill,
  PropertyRequired,
  RecordForm,
} from "@/components/events/EventsShared";
import { useAuth } from "@/lib/auth";
import { SITE_VISIT_STATUSES, formatDateTime, titleCase, type Row } from "@/lib/events";
import {
  useCustomersLite,
  useEnquiries,
  useEventInsert,
  useEventsCtx,
  useSiteVisits,
  useVenues,
} from "@/lib/events-data";

export const Route = createFileRoute("/_shell/events/site-visits")({
  head: () => ({
    meta: [
      { title: "Event Site Visits — NEØ" },
      {
        name: "description",
        content: "Schedule and record client site visits for the selected property.",
      },
      { property: "og:title", content: "Event Site Visits — NEØ" },
      {
        property: "og:description",
        content: "Schedule and record client site visits for the selected property.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <EventsGuard feature="site-visits">
      <Page />
    </EventsGuard>
  ),
});

function Page() {
  const { can } = useAuth();
  const { branchId } = useEventsCtx();
  const visits = useSiteVisits();
  const venues = useVenues();
  const enquiries = useEnquiries();
  const customers = useCustomersLite();
  const create = useEventInsert("site_visits", "Site visit");

  const rows = (visits.data ?? []) as Row[];
  const canCreate = can("events", "site-visits", "create");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Events & Banqueting"
        title="Site Visits"
        description="Every visit is booked against a property and links back to its enquiry."
        actions={
          canCreate && branchId ? (
            <FormDialog
              title="Schedule site visit"
              description="Booked at the property selected in the header."
            >
              {(close) => (
                <RecordForm
                  submitLabel="Schedule visit"
                  busy={create.isPending}
                  fields={[
                    {
                      name: "visit_at",
                      label: "Visit date and time",
                      type: "datetime-local",
                      required: true,
                    },
                    {
                      name: "enquiry_id",
                      label: "Enquiry",
                      type: "select",
                      options: ((enquiries.data ?? []) as Row[]).map((e) => ({
                        value: String(e["id"]),
                        label: `${String(e["enquiry_number"])} · ${String(e["contact_name"] ?? "")}`,
                      })),
                    },
                    {
                      name: "customer_id",
                      label: "Client",
                      type: "select",
                      options: ((customers.data ?? []) as Row[]).map((c) => ({
                        value: String(c["id"]),
                        label: String(c["full_name"]),
                      })),
                    },
                    {
                      name: "venue_id",
                      label: "Venue to view",
                      type: "select",
                      options: ((venues.data ?? []) as Row[]).map((v) => ({
                        value: String(v["id"]),
                        label: String(v["name"]),
                      })),
                    },
                    { name: "attendees", label: "Attendees" },
                    {
                      name: "client_requirements",
                      label: "Client requirements",
                      type: "textarea",
                      span: true,
                    },
                    {
                      name: "preparation_notes",
                      label: "Preparation notes",
                      type: "textarea",
                      span: true,
                    },
                  ]}
                  onSubmit={(values) =>
                    create.mutate({ ...values, status: "scheduled" }, { onSuccess: () => close() })
                  }
                />
              )}
            </FormDialog>
          ) : null
        }
      />

      {canCreate && !branchId ? <PropertyRequired what="A site visit" /> : null}

      <SectionCard
        title="Scheduled and completed visits"
        description={`${rows.length} visits for the selected property`}
      >
        <EventsQueryState
          isLoading={visits.isLoading}
          error={visits.error}
          isEmpty={rows.length === 0}
          empty={
            <EventsEmpty
              title="No site visits scheduled"
              description="Schedule a visit from an enquiry to start."
            />
          }
        >
          <DataTable head={["When", "Enquiry", "Venue", "Attendees", "Outcome", "Status"]}>
            {rows.map((v) => (
              <tr key={String(v["id"])}>
                <td className="py-2 pr-4 font-medium">{formatDateTime(v["visit_at"])}</td>
                <td className="py-2 pr-4">
                  {String((v["event_enquiries"] as Row | null)?.["enquiry_number"] ?? "—")}
                  <div className="text-xs text-muted-foreground">
                    {String((v["event_enquiries"] as Row | null)?.["contact_name"] ?? "")}
                  </div>
                </td>
                <td className="py-2 pr-4">
                  {String((v["event_venues"] as Row | null)?.["name"] ?? "—")}
                </td>
                <td className="py-2 pr-4">{String(v["attendees"] || "—")}</td>
                <td className="py-2 pr-4">{String(v["outcome"] || "—")}</td>
                <td className="py-2 pr-4">
                  <Pill
                    tone={String(v["status"]) === "completed" ? "success" : "info"}
                    value={String(v["status"])}
                  />
                </td>
              </tr>
            ))}
          </DataTable>
        </EventsQueryState>
      </SectionCard>

      <SectionCard title="Visit statuses" description="Lifecycle used across the module">
        <div className="flex flex-wrap gap-2">
          {SITE_VISIT_STATUSES.map((s) => (
            <Pill key={s} tone={s === "completed" ? "success" : "info"} value={titleCase(s)} />
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
