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
import {
  RESOURCE_CATEGORIES,
  formatDateTime,
  formatMoney,
  num,
  titleCase,
  type Row,
} from "@/lib/events";
import {
  useEventDelete,
  useEventInsert,
  useEventRetire,
  useEventUpdate,
  useEventsCtx,
  useResourceReservations,
  useResources,
} from "@/lib/events-data";
import { RowActions } from "@/components/common/RowActions";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_shell/events/resources")({
  head: () => ({
    meta: [
      { title: "Event Equipment — NEØ" },
      {
        name: "description",
        content:
          "Event equipment register, hire prices and live reservations for the selected property.",
      },
      { property: "og:title", content: "Event Equipment — NEØ" },
      {
        property: "og:description",
        content: "Event equipment register, hire prices and live reservations.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <EventsGuard feature="resources">
      <Page />
    </EventsGuard>
  ),
});

function Page() {
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;
  const { can, isAdmin } = useAuth();
  const { branchId } = useEventsCtx();
  const resources = useResources();
  const reservations = useResourceReservations();
  const create = useEventInsert("event_resources", "Equipment item");
  const update = useEventUpdate("event_resources", "Equipment item");
  const retire = useEventRetire("event_resources", "Equipment item");
  const remove = useEventDelete("event_resources", "Equipment item");

  const rows = (resources.data ?? []) as Row[];
  const resRows = (reservations.data ?? []) as Row[];
  const canCreate = can("events", "resources", "create");
  const canManage = can("events", "resources", "edit");
  const resourceFields: FieldSpec[] = [
    { name: "name", label: "Item name", required: true },
    {
      name: "category",
      label: "Category",
      type: "select",
      options: RESOURCE_CATEGORIES.map((c) => ({ value: c, label: titleCase(c) })),
    },
    { name: "quantity_owned", label: "Quantity owned", type: "number", required: true },
    { name: "condition", label: "Condition" },
    { name: "location", label: "Stored at" },
    { name: "hire_price", label: "Hire price", type: "number" },
  ];

  const committed = new Map<string, number>();
  for (const r of resRows) {
    const key = String(r["resource_id"]);
    committed.set(key, (committed.get(key) ?? 0) + num(r["quantity"]));
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Events & Banqueting"
        title="Equipment"
        description="Physical equipment lives at one property; reservations reduce what that property can still commit."
        actions={
          canCreate && branchId ? (
            <FormDialog
              title="New equipment item"
              description="Registered at the property selected in the header."
            >
              {(close) => (
                <RecordForm
                  submitLabel="Add equipment"
                  busy={create.isPending}
                  fields={resourceFields}
                  onSubmit={(values) =>
                    create.mutate(
                      { ...values, active: true, maintenance_status: "serviceable" },
                      { onSuccess: () => close() },
                    )
                  }
                />
              )}
            </FormDialog>
          ) : null
        }
      />

      {canCreate && !branchId ? <PropertyRequired what="An equipment item" /> : null}

      <SectionCard
        title="Equipment register"
        description={`${rows.length} items at the selected property`}
      >
        <EventsQueryState
          isLoading={resources.isLoading}
          error={resources.error}
          isEmpty={rows.length === 0}
          empty={
            <EventsEmpty
              title="No equipment registered"
              description="Add the equipment this property can commit to events."
            />
          }
        >
          <DataTable
            head={[
              "Item",
              "Category",
              "Owned",
              "Committed",
              "Free",
              "Hire price",
              "Condition",
              "Status",
              "",
            ]}
          >
            {rows.map((r) => {
              const owned = num(r["quantity_owned"]);
              const used = committed.get(String(r["id"])) ?? 0;
              return (
                <tr key={String(r["id"])}>
                  <td className="py-2 pr-4 font-medium">{String(r["name"])}</td>
                  <td className="py-2 pr-4">{titleCase(String(r["category"] ?? "other"))}</td>
                  <td className="py-2 pr-4">{owned}</td>
                  <td className="py-2 pr-4">{used}</td>
                  <td className="py-2 pr-4">{owned - used}</td>
                  <td className="py-2 pr-4">{formatMoney(symbol, r["hire_price"])}</td>
                  <td className="py-2 pr-4">{String(r["condition"] || "—")}</td>
                  <td className="py-2 pr-4">
                    <Pill
                      tone={
                        String(r["maintenance_status"] ?? "serviceable") === "serviceable"
                          ? "success"
                          : "warning"
                      }
                      value={String(r["maintenance_status"] ?? "serviceable")}
                    />
                  </td>
                  <td className="py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {canManage ? (
                        <FormDialog
                          title="Edit equipment item"
                          description="Corrects the register for this property."
                          trigger={
                            <Button size="sm" variant="ghost">
                              Edit
                            </Button>
                          }
                        >
                          {(close) => (
                            <RecordForm
                              submitLabel="Save item"
                              busy={update.isPending}
                              initial={r}
                              fields={resourceFields}
                              onSubmit={(values) =>
                                update.mutate(
                                  { id: String(r["id"]), values },
                                  { onSuccess: () => close() },
                                )
                              }
                            />
                          )}
                        </FormDialog>
                      ) : null}
                      <RowActions
                        recordName={String(r["name"])}
                        entityLabel="equipment item"
                        canManage={canManage}
                        status={{
                          active: r["active"] !== false,
                          pending: retire.isPending,
                          onToggle: (next) => retire.mutate({ id: String(r["id"]), active: next }),
                          deactivateEffect:
                            "It can no longer be committed to new events. Equipment already reserved for an event stays reserved.",
                        }}
                        remove={isAdmin ? { pending: remove.isPending, disabled: r["active"] !== false, onConfirm: () => remove.mutate(String(r["id"])), } : undefined}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </DataTable>
        </EventsQueryState>
      </SectionCard>

      <SectionCard title="Live reservations" description="Equipment committed to events">
        <EventsQueryState
          isLoading={reservations.isLoading}
          error={reservations.error}
          isEmpty={resRows.length === 0}
          empty={
            <EventsEmpty
              title="Nothing reserved"
              description="Reservations appear when equipment is committed to an event."
            />
          }
        >
          <DataTable head={["Item", "Event", "Quantity", "From", "Until", "Status"]}>
            {resRows.map((r) => (
              <tr key={String(r["id"])}>
                <td className="py-2 pr-4 font-medium">
                  {String((r["event_resources"] as Row | null)?.["name"] ?? "—")}
                </td>
                <td className="py-2 pr-4">
                  {String((r["event_bookings"] as Row | null)?.["event_reference"] ?? "—")}
                </td>
                <td className="py-2 pr-4">{num(r["quantity"])}</td>
                <td className="py-2 pr-4">{formatDateTime(r["starts_at"])}</td>
                <td className="py-2 pr-4">{formatDateTime(r["ends_at"])}</td>
                <td className="py-2 pr-4">
                  <Pill tone="info" value={String(r["status"] ?? "reserved")} />
                </td>
              </tr>
            ))}
          </DataTable>
        </EventsQueryState>
      </SectionCard>
    </div>
  );
}
