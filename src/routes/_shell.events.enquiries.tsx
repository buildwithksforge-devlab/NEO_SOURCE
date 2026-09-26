import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import {
  clearFormDraft,
  DataTable,
  EventsEmpty,
  EventsGuard,
  EventsQueryState,
  ConversionBlocked,
  ConvertedEvent,
  FormDialog,
  Pill,
  PropertyRequired,
  RecordForm,
} from "@/components/events/EventsShared";
import { useAuth } from "@/lib/auth";
import { useTenant } from "@/lib/tenant";
import {
  ENQUIRY_STATUSES,
  LEAD_SOURCES,
  enquiryTone,
  formatDate,
  formatMoney,
  num,
  titleCase,
  type Row,
} from "@/lib/events";
import {
  nextNumber,
  useConversionLinks,
  useConvertEnquiry,
  useCustomersLite,
  useEnquiries,
  useEventInsert,
  useEventTypes,
  useEventUpdate,
  useEventsCtx,
  useVenues,
} from "@/lib/events-data";
import { Pencil } from "lucide-react";

/** Required before an enquiry can ever become an event. */
function enquiryProblem(values: Record<string, unknown>): string | null {
  if (!String(values["contact_name"] ?? "").trim()) return "A contact name is required.";
  if (!String(values["proposed_date"] ?? "").trim())
    return "An event date is required — an enquiry cannot become an event without one.";
  return null;
}

/** An enquiry with no event date cannot be converted. */
function missingDate(row: Record<string, unknown>): boolean {
  return !String(row["proposed_date"] ?? "").trim();
}

/** Only the date part of a stored value, so a date input shows it. */
function dateValue(v: unknown): string {
  const s = String(v ?? "");
  return s ? s.slice(0, 10) : "";
}

/** Trim a stored timestamp to what a datetime-local input accepts. */
function localValue(v: unknown): string {
  const s = String(v ?? "");
  return s ? s.slice(0, 16).replace(" ", "T") : "";
}

export const Route = createFileRoute("/_shell/events/enquiries")({
  head: () => ({
    meta: [
      { title: "Event Enquiries — NEØ" },
      {
        name: "description",
        content: "Capture, qualify and convert event enquiries for the selected property.",
      },
      { property: "og:title", content: "Event Enquiries — NEØ" },
      {
        property: "og:description",
        content: "Capture, qualify and convert event enquiries for the selected property.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <EventsGuard feature="enquiries">
      <Page />
    </EventsGuard>
  ),
});

function Page() {
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;
  const { can } = useAuth();
  const { branchId } = useEventsCtx();
  const enquiries = useEnquiries();
  const venues = useVenues();
  const customers = useCustomersLite();
  const types = useEventTypes();
  const create = useEventInsert("event_enquiries", "Enquiry");
  const update = useEventUpdate("event_enquiries", "Enquiry");
  const convert = useConvertEnquiry();
  const links = useConversionLinks();

  const fields = [
    { name: "contact_name", label: "Contact name", required: true },
    { name: "phone", label: "Phone" },
    { name: "email", label: "Email" },
    {
      name: "event_type_id",
      label: "Event type",
      type: "select" as const,
      options: ((types.data ?? []) as Row[]).map((t) => ({
        value: String(t["id"]),
        label: String(t["name"]),
      })),
    },
    { name: "event_type_label", label: "Event description" },
    { name: "proposed_date", label: "Proposed date", type: "date" as const, required: true },
    { name: "alternative_date", label: "Alternative date", type: "date" as const },
    { name: "start_time", label: "Start time", type: "time" as const },
    { name: "end_time", label: "End time", type: "time" as const },
    { name: "expected_adults", label: "Adults", type: "number" as const },
    { name: "expected_children", label: "Children", type: "number" as const },
    {
      name: "venue_id",
      label: "Preferred venue",
      type: "select" as const,
      options: ((venues.data ?? []) as Row[]).map((v) => ({
        value: String(v["id"]),
        label: String(v["name"]),
      })),
    },
    {
      name: "customer_id",
      label: "Existing client",
      type: "select" as const,
      options: ((customers.data ?? []) as Row[]).map((c) => ({
        value: String(c["id"]),
        label: `${String(c["full_name"])} · ${String(c["customer_number"])}`,
      })),
    },
    { name: "estimated_budget", label: "Estimated budget", type: "number" as const },
    {
      name: "lead_source",
      label: "Lead source",
      type: "select" as const,
      options: LEAD_SOURCES.map((s) => ({ value: s, label: titleCase(s) })),
    },
    { name: "next_followup_at", label: "Next follow-up", type: "datetime-local" as const },
    { name: "requirements", label: "Client requirements", type: "textarea" as const, span: true },
  ];

  const rows = (enquiries.data ?? []) as Row[];
  const canCreate = can("events", "enquiries", "create");
  const canConvert = can("events", "enquiries", "convert");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Events & Banqueting"
        title="Enquiries"
        description="Every enquiry belongs to one property and keeps its own reference through to the event."
        actions={
          canCreate && branchId ? (
            <FormDialog
              title="New enquiry"
              description="Captured against the property selected in the header."
            >
              {(close) => (
                <RecordForm
                  submitLabel="Capture enquiry"
                  busy={create.isPending}
                  draftKey="event-enquiry-new"
                  validate={enquiryProblem}
                  fields={fields}
                  onSubmit={async (values) => {
                    const number = await nextNumber("event_enquiry", "ENQ");
                    create.mutate(
                      {
                        ...values,
                        // Guest counts are stored as whole numbers; a blank box
                        // means "none given yet", not an empty value.
                        expected_adults: num(values["expected_adults"]),
                        expected_children: num(values["expected_children"]),
                        enquiry_number: number,
                        status: "new",
                      },

                      {
                        onSuccess: () => {
                          clearFormDraft("event-enquiry-new");
                          close();
                        },
                      },
                    );
                  }}
                />
              )}
            </FormDialog>
          ) : null
        }
      />

      {canCreate && !branchId ? <PropertyRequired what="An enquiry" /> : null}

      <SectionCard
        title="Enquiry register"
        description={`${rows.length} enquiries for the selected property`}
      >
        <EventsQueryState
          isLoading={enquiries.isLoading}
          error={enquiries.error}
          isEmpty={rows.length === 0}
          empty={
            <EventsEmpty
              title="No enquiries yet"
              description="Captured enquiries appear here with their follow-up dates."
            />
          }
        >
          <DataTable
            head={["Reference", "Contact", "Event", "Date", "Guests", "Budget", "Status", ""]}
          >
            {rows.map((e) => {
              const converted = String(e["status"]) === "converted";
              const link = links.data?.byEnquiry.get(String(e["id"]));
              return (
                <tr key={String(e["id"])}>
                  <td className="py-2 pr-4 font-medium">{String(e["enquiry_number"])}</td>
                  <td className="py-2 pr-4">
                    {String(
                      e["contact_name"] || (e["customers"] as Row | null)?.["full_name"] || "—",
                    )}
                    <div className="text-xs text-muted-foreground">
                      {String(e["phone"] || e["email"] || "")}
                    </div>
                  </td>
                  <td className="py-2 pr-4">{String(e["event_type_label"] || "—")}</td>
                  <td className="py-2 pr-4">{formatDate(e["proposed_date"])}</td>
                  <td className="py-2 pr-4">
                    {num(e["expected_adults"]) + num(e["expected_children"])}
                  </td>
                  <td className="py-2 pr-4">{formatMoney(symbol, e["estimated_budget"])}</td>
                  <td className="py-2 pr-4">
                    <Pill tone={enquiryTone(String(e["status"]))} value={String(e["status"])} />
                  </td>
                  <td className="py-2 pr-4">
                    <div className="flex flex-wrap items-center gap-2">
                      {link ? (
                        <div>
                          <ConvertedEvent link={link} bookingId={link.bookingId} />
                          <ConversionBlocked reference={link.reference} />
                        </div>
                      ) : canConvert ? (
                        missingDate(e) ? (
                          <span className="text-xs text-muted-foreground">
                            Add an event date before converting
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={convert.isPending}
                            onClick={() => convert.mutate({ enquiryId: String(e["id"]) })}
                          >
                            Convert to event
                          </Button>
                        )
                      ) : converted ? (
                        <span className="text-xs text-muted-foreground">Converted</span>
                      ) : null}
                      {canCreate && !link ? (
                        <FormDialog
                          title="Edit enquiry"
                          description="Correct or complete the details captured for this enquiry."
                          trigger={
                            <Button size="sm" variant="ghost">
                              <Pencil className="size-4" />
                              Edit
                            </Button>
                          }
                        >
                          {(close) => (
                            <RecordForm
                              submitLabel="Save enquiry"
                              busy={update.isPending}
                              draftKey={`event-enquiry-${String(e["id"])}`}
                              validate={enquiryProblem}
                              fields={fields}
                              initial={{
                                contact_name: e["contact_name"] ?? "",
                                phone: e["phone"] ?? "",
                                email: e["email"] ?? "",
                                event_type_id: e["event_type_id"] ?? "",
                                event_type_label: e["event_type_label"] ?? "",
                                proposed_date: dateValue(e["proposed_date"]),
                                alternative_date: dateValue(e["alternative_date"]),
                                start_time: String(e["start_time"] ?? "").slice(0, 5),
                                end_time: String(e["end_time"] ?? "").slice(0, 5),
                                expected_adults: e["expected_adults"] ?? "",
                                expected_children: e["expected_children"] ?? "",
                                venue_id: e["venue_id"] ?? "",
                                customer_id: e["customer_id"] ?? "",
                                estimated_budget: e["estimated_budget"] ?? "",
                                lead_source: e["lead_source"] ?? "",
                                next_followup_at: localValue(e["next_followup_at"]),
                                requirements: e["requirements"] ?? "",
                              }}
                              onSubmit={(values) =>
                                update.mutate(
                                  {
                                    id: String(e["id"]),
                                    values: {
                                      ...values,
                                      expected_adults: num(values["expected_adults"]),
                                      expected_children: num(values["expected_children"]),
                                    },
                                  },

                                  {
                                    onSuccess: () => {
                                      clearFormDraft(`event-enquiry-${String(e["id"])}`);
                                      close();
                                    },
                                  },
                                )
                              }
                            />
                          )}
                        </FormDialog>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </DataTable>
        </EventsQueryState>
      </SectionCard>

      <SectionCard title="Enquiry stages" description="Lifecycle used across the module">
        <div className="flex flex-wrap gap-2">
          {ENQUIRY_STATUSES.map((s) => (
            <Pill key={s} tone={enquiryTone(s)} value={s} />
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
