import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import {
  DataTable,
  EventsEmpty,
  EventsGuard,
  EventsQueryState,
  FormDialog,
  NotConfigured,
  Pill,
  RecordForm,
  type FieldSpec,
} from "@/components/events/EventsShared";
import { useAuth } from "@/lib/auth";
import { DEPARTMENT_KEYS, SERVICE_STYLES, titleCase, type Row } from "@/lib/events";
import {
  useEventDelete,
  useEventInsert,
  useEventRetire,
  useEventTypes,
  useEventUpdate,
  useEventWorkspace,
  useVenues,
} from "@/lib/events-data";
import { RowActions } from "@/components/common/RowActions";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_shell/events/settings")({
  head: () => ({
    meta: [
      { title: "Events Settings — NEØ" },
      {
        name: "description",
        content:
          "Event types, department coverage and property assignment health for the events module.",
      },
      { property: "og:title", content: "Events Settings — NEØ" },
      {
        property: "og:description",
        content: "Event types, department coverage and property assignment health.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <EventsGuard feature="settings" action="edit">
      <Page />
    </EventsGuard>
  ),
});

function Page() {
  const { can, isAdmin } = useAuth();
  const types = useEventTypes();
  const venues = useVenues();
  const workspace = useEventWorkspace();
  const create = useEventInsert("event_types", "Event type");
  const update = useEventUpdate("event_types", "Event type");
  const retire = useEventRetire("event_types", "Event type");
  const remove = useEventDelete("event_types", "Event type");

  const typeRows = (types.data ?? []) as Row[];
  const venueRows = (venues.data ?? []) as Row[];
  const events = workspace.data ?? [];
  const canEdit = can("events", "settings", "edit");
  const typeFields: FieldSpec[] = [
    { name: "name", label: "Name", required: true },
    { name: "key", label: "Key", required: true, placeholder: "wedding" },
    { name: "category", label: "Category" },
    {
      name: "default_service_style",
      label: "Default service style",
      type: "select",
      options: SERVICE_STYLES.map((s) => ({ value: s, label: titleCase(s) })),
    },
    { name: "sort_order", label: "Sort order", type: "number" },
    { name: "description", label: "Description", type: "textarea", span: true },
  ];

  const byProperty = new Map<string, number>();
  for (const e of events)
    byProperty.set(
      e.branch_name ?? "Unassigned",
      (byProperty.get(e.branch_name ?? "Unassigned") ?? 0) + 1,
    );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Events & Banqueting"
        title="Events Settings"
        description="Event types are shared across the organisation; venues, packages and equipment belong to a property."
        actions={
          canEdit ? (
            <FormDialog
              title="New event type"
              description="Available at every property in this organisation."
            >
              {(close) => (
                <RecordForm
                  submitLabel="Create event type"
                  busy={create.isPending}
                  fields={typeFields}
                  onSubmit={(values) =>
                    create.mutate({ ...values, active: true }, { onSuccess: () => close() })
                  }
                />
              )}
            </FormDialog>
          ) : null
        }
      />

      <SectionCard
        title="Event types"
        description="Shared configuration used by enquiries, quotations and events"
      >
        <EventsQueryState
          isLoading={types.isLoading}
          error={types.error}
          isEmpty={typeRows.length === 0}
          empty={
            <EventsEmpty
              title="No event types"
              description="Create the event types this organisation sells."
            />
          }
        >
          <DataTable head={["Name", "Key", "Category", "Default service", "Status", ""]}>
            {typeRows.map((t) => (
              <tr key={String(t["id"])}>
                <td className="py-2 pr-4 font-medium">{String(t["name"])}</td>
                <td className="py-2 pr-4 font-mono text-xs">{String(t["key"])}</td>
                <td className="py-2 pr-4">{String(t["category"] || "—")}</td>
                <td className="py-2 pr-4">
                  {titleCase(String(t["default_service_style"] ?? "—"))}
                </td>
                <td className="py-2 pr-4">
                  <Pill
                    tone={t["active"] ? "success" : "default"}
                    value={t["active"] ? "active" : "inactive"}
                  />
                </td>
                <td className="py-2 text-right">
                  <div className="flex items-center justify-end gap-1">
                    {canEdit ? (
                      <FormDialog
                        title="Edit event type"
                        description="Applies across every property in this organisation."
                        trigger={
                          <Button size="sm" variant="ghost">
                            Edit
                          </Button>
                        }
                      >
                        {(close) => (
                          <RecordForm
                            submitLabel="Save event type"
                            busy={update.isPending}
                            initial={t}
                            fields={typeFields}
                            onSubmit={(values) =>
                              update.mutate(
                                { id: String(t["id"]), values },
                                { onSuccess: () => close() },
                              )
                            }
                          />
                        )}
                      </FormDialog>
                    ) : null}
                    <RowActions
                      recordName={String(t["name"])}
                      entityLabel="event type"
                      canManage={canEdit}
                      status={{
                        active: Boolean(t["active"]),
                        pending: retire.isPending,
                        onToggle: (next) => retire.mutate({ id: String(t["id"]), active: next }),
                        deactivateEffect:
                          "It stops being offered on new enquiries and quotations. Existing events keep their type.",
                      }}
                      remove={isAdmin ? { pending: remove.isPending, disabled: Boolean(t["active"]), onConfirm: () => remove.mutate(String(t["id"])), } : undefined}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </DataTable>
        </EventsQueryState>
      </SectionCard>

      <SectionCard
        title="Property assignment"
        description="Where the events in your current view belong"
      >
        <EventsQueryState
          isLoading={workspace.isLoading}
          error={workspace.error}
          isEmpty={false}
          empty={null}
        >
          {events.length === 0 ? (
            <EventsEmpty
              title="No events yet"
              description="Assignment health appears once events exist."
            />
          ) : (
            <div className="grid gap-2 sm:grid-cols-3">
              {[...byProperty.entries()].map(([name, count]) => (
                <div key={name} className="rounded-lg border border-border px-3 py-2">
                  <p className="text-xs text-muted-foreground">{name}</p>
                  <p className="text-lg font-semibold">{count} events</p>
                </div>
              ))}
            </div>
          )}
        </EventsQueryState>
        {venueRows.length === 0 ? (
          <div className="mt-3">
            <NotConfigured
              label="Venues"
              note="This property has no function spaces yet, so events cannot be allocated a venue. Add venues from the Venues tab."
            />
          </div>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Department coverage"
        description="Departments that receive event requirements and tasks"
      >
        <div className="flex flex-wrap gap-2">
          {DEPARTMENT_KEYS.map((d) => (
            <Pill key={d} tone="info" value={d} />
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
