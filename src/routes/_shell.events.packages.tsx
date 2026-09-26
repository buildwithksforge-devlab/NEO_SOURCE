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
import { formatDate, formatMoney, num, titleCase, type Row } from "@/lib/events";
import {
  useEventDelete,
  useEventInsert,
  useEventRetire,
  useEventTypes,
  useEventUpdate,
  useEventsCtx,
  usePackages,
} from "@/lib/events-data";
import { RowActions } from "@/components/common/RowActions";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_shell/events/packages")({
  head: () => ({
    meta: [
      { title: "Event Packages — NEØ" },
      {
        name: "description",
        content: "Priced event packages, inclusions and validity for the selected property.",
      },
      { property: "og:title", content: "Event Packages — NEØ" },
      { property: "og:description", content: "Priced event packages, inclusions and validity." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <EventsGuard feature="packages">
      <Page />
    </EventsGuard>
  ),
});

const PRICE_BASIS = ["per-person", "per-event", "per-hour", "per-day"];

function Page() {
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;
  const { can, isAdmin } = useAuth();
  const { branchId } = useEventsCtx();
  const packages = usePackages();
  const types = useEventTypes();
  const create = useEventInsert("event_packages", "Package");
  const update = useEventUpdate("event_packages", "Package");
  const retire = useEventRetire("event_packages", "Package");
  const remove = useEventDelete("event_packages", "Package");

  const rows = (packages.data ?? []) as Row[];
  const canCreate = can("events", "packages", "create");
  const canManage = can("events", "packages", "edit");
  const packageFields = (): FieldSpec[] => [
    { name: "name", label: "Package name", required: true, span: true },
    {
      name: "event_type_id",
      label: "Event type",
      type: "select",
      options: ((types.data ?? []) as Row[]).map((t) => ({
        value: String(t["id"]),
        label: String(t["name"]),
      })),
    },
    {
      name: "price_basis",
      label: "Price basis",
      type: "select",
      options: PRICE_BASIS.map((p) => ({ value: p, label: titleCase(p) })),
    },
    { name: "price", label: "Price", type: "number", required: true },
    { name: "tax_rate", label: "Tax rate %", type: "number" },
    { name: "min_guests", label: "Minimum guests", type: "number" },
    { name: "max_guests", label: "Maximum guests", type: "number" },
    { name: "valid_from", label: "Valid from", type: "date" },
    { name: "valid_to", label: "Valid to", type: "date" },
    { name: "description", label: "Inclusions", type: "textarea", span: true },
    { name: "exclusions", label: "Exclusions", type: "textarea", span: true },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Events & Banqueting"
        title="Packages"
        description="Packages are priced per property so quotations always use that property's rates."
        actions={
          canCreate && branchId ? (
            <FormDialog
              title="New package"
              description="Created at the property selected in the header."
            >
              {(close) => (
                <RecordForm
                  submitLabel="Create package"
                  busy={create.isPending}
                  fields={packageFields()}
                  onSubmit={(values) =>
                    create.mutate({ ...values, active: true }, { onSuccess: () => close() })
                  }
                />
              )}
            </FormDialog>
          ) : null
        }
      />

      {canCreate && !branchId ? <PropertyRequired what="A package" /> : null}

      <SectionCard
        title="Package catalogue"
        description={`${rows.length} packages at the selected property`}
      >
        <EventsQueryState
          isLoading={packages.isLoading}
          error={packages.error}
          isEmpty={rows.length === 0}
          empty={
            <EventsEmpty
              title="No packages configured"
              description="Create the packages this property sells."
            />
          }
        >
          <DataTable
            head={[
              "Package",
              "Event type",
              "Basis",
              "Price",
              "Guests",
              "Valid",
              "Components",
              "Status",
              "",
            ]}
          >
            {rows.map((p) => (
              <tr key={String(p["id"])}>
                <td className="py-2 pr-4 font-medium">{String(p["name"])}</td>
                <td className="py-2 pr-4">
                  {String((p["event_types"] as Row | null)?.["name"] ?? "—")}
                </td>
                <td className="py-2 pr-4">{titleCase(String(p["price_basis"] ?? "per-person"))}</td>
                <td className="py-2 pr-4">{formatMoney(symbol, p["price"])}</td>
                <td className="py-2 pr-4">
                  {num(p["min_guests"])}–{num(p["max_guests"]) || "∞"}
                </td>
                <td className="py-2 pr-4">
                  {p["valid_from"] ? formatDate(p["valid_from"]) : "—"} →{" "}
                  {p["valid_to"] ? formatDate(p["valid_to"]) : "open"}
                </td>
                <td className="py-2 pr-4">
                  {((p["event_package_items"] as Row[] | null) ?? []).length}
                </td>
                <td className="py-2 pr-4">
                  <Pill
                    tone={p["active"] ? "success" : "default"}
                    value={p["active"] ? "active" : "inactive"}
                  />
                </td>
                <td className="py-2 text-right">
                  <div className="flex items-center justify-end gap-1">
                    {canManage ? (
                      <FormDialog
                        title="Edit package"
                        description="Changes apply to new quotations; events already quoted keep their agreed price."
                        trigger={
                          <Button size="sm" variant="ghost">
                            Edit
                          </Button>
                        }
                      >
                        {(close) => (
                          <RecordForm
                            submitLabel="Save package"
                            busy={update.isPending}
                            initial={p}
                            fields={packageFields()}
                            onSubmit={(values) =>
                              update.mutate(
                                { id: String(p["id"]), values },
                                { onSuccess: () => close() },
                              )
                            }
                          />
                        )}
                      </FormDialog>
                    ) : null}
                    <RowActions
                      recordName={String(p["name"])}
                      entityLabel="package"
                      canManage={canManage}
                      status={{
                        active: Boolean(p["active"]),
                        pending: retire.isPending,
                        onToggle: (next) => retire.mutate({ id: String(p["id"]), active: next }),
                        deactivateEffect:
                          "It stops appearing on new quotations. Events already sold on this package keep it.",
                      }}
                      remove={isAdmin ? { pending: remove.isPending, disabled: Boolean(p["active"]), onConfirm: () => remove.mutate(String(p["id"])), } : undefined}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </DataTable>
        </EventsQueryState>
      </SectionCard>
    </div>
  );
}
