import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import {
  DataTable,
  EventsEmpty,
  EventsGuard,
  EventsQueryState,
  FormDialog,
  type FieldSpec,
  Pill,
  PropertyRequired,
  RecordForm,
} from "@/components/events/EventsShared";
import { useAuth } from "@/lib/auth";
import { useTenant } from "@/lib/tenant";
import { formatDateTime, formatMoney, num, type Row } from "@/lib/events";
import {
  useEventDelete,
  useEventInsert,
  useEventUpdate,
  useEventsCtx,
  useVenueBlocks,
  useVenues,
} from "@/lib/events-data";
import { RowActions } from "@/components/common/RowActions";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_shell/events/venues")({
  head: () => ({
    meta: [
      { title: "Event Venues — NEØ" },
      {
        name: "description",
        content: "Function spaces, capacities, layouts and hire rates for the selected property.",
      },
      { property: "og:title", content: "Event Venues — NEØ" },
      {
        property: "og:description",
        content: "Function spaces, capacities, layouts and hire rates.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <EventsGuard feature="venues">
      <Page />
    </EventsGuard>
  ),
});

function Page() {
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;
  const { can, isAdmin } = useAuth();
  const { branchId } = useEventsCtx();
  const venues = useVenues();
  const blocks = useVenueBlocks();
  const create = useEventInsert("event_venues", "Venue");
  const update = useEventUpdate("event_venues", "Venue");
  const remove = useEventDelete("event_venues", "Venue");

  const rows = (venues.data ?? []) as Row[];
  const blockRows = (blocks.data ?? []) as Row[];
  const canCreate = can("events", "venues", "create");
  const canManage = can("events", "venues", "edit");
  const venueFields: FieldSpec[] = [
    { name: "name", label: "Venue name", required: true },
    { name: "code", label: "Short code" },
    { name: "location", label: "Location on site" },
    { name: "min_capacity", label: "Minimum capacity", type: "number" },
    { name: "max_capacity", label: "Maximum capacity", type: "number" },
    { name: "base_hire_price", label: "Base hire price", type: "number" },
    { name: "tax_rate", label: "Tax rate %", type: "number" },
    { name: "setup_minutes", label: "Setup minutes", type: "number" },
    { name: "breakdown_minutes", label: "Breakdown minutes", type: "number" },
    { name: "opens_at", label: "Opens at", type: "time" },
    { name: "closes_at", label: "Closes at", type: "time" },
    { name: "is_outdoor", label: "Outdoor space", type: "checkbox" },
    { name: "description", label: "Description", type: "textarea", span: true },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Events & Banqueting"
        title="Venues"
        description="A venue always belongs to one property, so it can only be sold at that property."
        actions={
          canCreate && branchId ? (
            <FormDialog
              title="New venue"
              description="Created at the property selected in the header."
            >
              {(close) => (
                <RecordForm
                  submitLabel="Create venue"
                  busy={create.isPending}
                  fields={venueFields}
                  onSubmit={(values) =>
                    create.mutate({ ...values, status: "available" }, { onSuccess: () => close() })
                  }
                />
              )}
            </FormDialog>
          ) : null
        }
      />

      {canCreate && !branchId ? <PropertyRequired what="A venue" /> : null}

      <SectionCard
        title="Venue register"
        description={`${rows.length} spaces at the selected property`}
      >
        <EventsQueryState
          isLoading={venues.isLoading}
          error={venues.error}
          isEmpty={rows.length === 0}
          empty={
            <EventsEmpty
              title="No venues configured"
              description="Add the function spaces this property can sell."
            />
          }
        >
          <DataTable
            head={["Venue", "Location", "Capacity", "Hire price", "Setup", "Type", "Status", ""]}
          >
            {rows.map((v) => (
              <tr key={String(v["id"])}>
                <td className="py-2 pr-4 font-medium">{String(v["name"])}</td>
                <td className="py-2 pr-4">{String(v["location"] || "—")}</td>
                <td className="py-2 pr-4">
                  {num(v["min_capacity"])}–{num(v["max_capacity"])}
                </td>
                <td className="py-2 pr-4">{formatMoney(symbol, v["base_hire_price"])}</td>
                <td className="py-2 pr-4">{num(v["setup_minutes"])} min</td>
                <td className="py-2 pr-4">{v["is_outdoor"] ? "Outdoor" : "Indoor"}</td>
                <td className="py-2 pr-4">
                  <Pill
                    tone={String(v["status"]) === "available" ? "success" : "warning"}
                    value={String(v["status"] ?? "available")}
                  />
                </td>
                <td className="py-2 text-right">
                  <div className="flex items-center justify-end gap-1">
                    {canManage ? (
                      <FormDialog
                        title="Edit venue"
                        description="Corrects the details of this function space."
                        trigger={
                          <Button size="sm" variant="ghost">
                            Edit
                          </Button>
                        }
                      >
                        {(close) => (
                          <RecordForm
                            submitLabel="Save venue"
                            busy={update.isPending}
                            initial={v}
                            fields={venueFields}
                            onSubmit={(values) =>
                              update.mutate(
                                { id: String(v["id"]), values },
                                { onSuccess: () => close() },
                              )
                            }
                          />
                        )}
                      </FormDialog>
                    ) : null}
                    <RowActions
                      recordName={String(v["name"])}
                      entityLabel="venue"
                      canManage={canManage}
                      remove={isAdmin ? { pending: remove.isPending, onConfirm: () => remove.mutate(String(v["id"])), } : undefined}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </DataTable>
        </EventsQueryState>
      </SectionCard>

      <SectionCard
        title="Current venue holds"
        description="Confirmed events and maintenance blocks that remove availability"
      >
        <EventsQueryState
          isLoading={blocks.isLoading}
          error={blocks.error}
          isEmpty={blockRows.length === 0}
          empty={
            <EventsEmpty
              title="No active holds"
              description="Venue holds appear when an event is confirmed."
            />
          }
        >
          <DataTable head={["Venue", "From", "Until", "Type", "Event", "Reason"]}>
            {blockRows.map((b) => (
              <tr key={String(b["id"])}>
                <td className="py-2 pr-4 font-medium">
                  {String((b["event_venues"] as Row | null)?.["name"] ?? "—")}
                </td>
                <td className="py-2 pr-4">{formatDateTime(b["starts_at"])}</td>
                <td className="py-2 pr-4">{formatDateTime(b["ends_at"])}</td>
                <td className="py-2 pr-4">{String(b["block_type"] || "—")}</td>
                <td className="py-2 pr-4">
                  {String((b["event_bookings"] as Row | null)?.["event_reference"] ?? "—")}
                </td>
                <td className="py-2 pr-4">{String(b["reason"] || "—")}</td>
              </tr>
            ))}
          </DataTable>
        </EventsQueryState>
      </SectionCard>
    </div>
  );
}
