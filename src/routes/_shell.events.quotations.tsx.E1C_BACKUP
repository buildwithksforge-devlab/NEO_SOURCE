import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import {
  DataTable,
  EventsEmpty,
  EventsGuard,
  EventsQueryState,
  ConversionBlocked,
  ConvertedEvent,
  Pill,
  FormDialog,
  RecordForm,
  PropertyRequired,
} from "@/components/events/EventsShared";
import { useAuth } from "@/lib/auth";
import { useTenant } from "@/lib/tenant";
import {
  QUOTATION_STATUSES,
  formatDate,
  formatMoney,
  num,
  quotationTone,
  type Row,
} from "@/lib/events";
import {
  nextNumber,
  useCustomersLite,
  useEnquiries,
  useEventInsert,
  useEventsCtx,
  useVenues,
  useConversionLinks,
  useConvertQuotation,
  useQuotations,
  useReviseQuotation,
} from "@/lib/events-data";

export const Route = createFileRoute("/_shell/events/quotations")({
  head: () => ({
    meta: [
      { title: "Event Quotations â€” NEÃ˜" },
      {
        name: "description",
        content:
          "Versioned event quotations with deposits, balances and conversion to confirmed events.",
      },
      { property: "og:title", content: "Event Quotations â€” NEÃ˜" },
      {
        property: "og:description",
        content: "Versioned event quotations with deposits, balances and conversion.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <EventsGuard feature="quotations">
      <Page />
    </EventsGuard>
  ),
});

function Page() {
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;
  const { can } = useAuth();
  // E1_NEW_QUOTATION_FORM
  const { branchId } = useEventsCtx();
  const enquiries = useEnquiries();
  const customers = useCustomersLite();
  const venues = useVenues();
  const createQuotation = useEventInsert("event_quotations", "Quotation");
  const quotations = useQuotations();
  const convert = useConvertQuotation();
  const revise = useReviseQuotation();
  const links = useConversionLinks();

  const rows = (quotations.data ?? []) as Row[];
  const canConvert = can("events", "quotations", "convert");
  const canEdit = can("events", "quotations", "edit");
  const canCreate = can("events", "quotations", "create");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Events & Banqueting"
        title="Quotations"
        actions={
          canCreate && branchId ? (
            <FormDialog
              title="New event quotation"
              description="Prepare a draft quotation for the selected property."
            >
              {(close) => (
                <RecordForm
                  submitLabel="Save draft quotation"
                  busy={createQuotation.isPending}
                  fields={[
                    { name: "title", label: "Quotation title", required: true },
                    {
                      name: "enquiry_id",
                      label: "Related enquiry",
                      type: "select",
                      options: ((enquiries.data ?? []) as Row[]).map((e) => ({
                        value: String(e["id"]),
                        label: String(e["enquiry_number"] ?? e["contact_name"] ?? "Enquiry"),
                      })),
                    },
                    {
                      name: "customer_id",
                      label: "Client",
                      type: "select",
                      options: ((customers.data ?? []) as Row[]).map((c) => ({
                        value: String(c["id"]),
                        label: String(c["full_name"] ?? "Client"),
                      })),
                    },
                    {
                      name: "venue_id",
                      label: "Venue",
                      type: "select",
                      options: ((venues.data ?? []) as Row[]).map((v) => ({
                        value: String(v["id"]),
                        label: String(v["name"]),
                      })),
                    },
                    { name: "event_date", label: "Event date", type: "date", required: true },
                    { name: "start_time", label: "Start time", type: "time" },
                    { name: "end_time", label: "End time", type: "time" },
                    { name: "guest_count", label: "Expected guests", type: "number", required: true },
                    { name: "subtotal", label: "Quoted amount before tax", type: "number", required: true },
                    { name: "tax_rate", label: "Tax rate (%)", type: "number" },
                    { name: "deposit_percent", label: "Required deposit (%)", type: "number" },
                    { name: "valid_until", label: "Quotation valid until", type: "date" },
                    { name: "client_notes", label: "Client notes", type: "textarea", span: true },
                    { name: "terms", label: "Quotation terms", type: "textarea", span: true },
                  ]}
                  validate={(values) => {
                    if (!String(values["title"] ?? "").trim()) return "Enter a quotation title.";
                    if (!String(values["event_date"] ?? "").trim()) return "Select an event date.";
                    const guests = Number(values["guest_count"] ?? 0);
                    const amount = Number(values["subtotal"] ?? 0);
                    const tax = Number(values["tax_rate"] || 0);
                    const deposit = values["deposit_percent"] === "" ||
                                    values["deposit_percent"] == null
                      ? 50
                      : Number(values["deposit_percent"]);
                    if (!Number.isInteger(guests) || guests <= 0) return "Enter a valid guest count.";
                    if (!Number.isFinite(amount) || amount <= 0) return "Enter a positive quotation amount.";
                    if (!Number.isFinite(tax) || tax < 0 || tax > 100) return "Tax rate must be between 0 and 100.";
                    if (!Number.isFinite(deposit) || deposit < 0 || deposit > 100)
                      return "Deposit percentage must be between 0 and 100.";
                    return null;
                  }}
                  onSubmit={async (values) => {
                    const subtotal = Number(values["subtotal"]);
                    const taxRate = Number(values["tax_rate"] || 0);
                    const depositPercent = values["deposit_percent"] === "" ||
                                           values["deposit_percent"] == null
                      ? 50
                      : Number(values["deposit_percent"]);
                    const taxAmount = Math.round(subtotal * taxRate) / 100;
                    const grandTotal = Math.round((subtotal + taxAmount) * 100) / 100;
                    const depositAmount = Math.round(grandTotal * depositPercent) / 100;
                    const quotationNumber = await nextNumber("event_quotation", "QUO");

                    createQuotation.mutate(
                      {
                        ...values,
                        quotation_number: quotationNumber,
                        version: 1,
                        status: "draft",
                        guest_count: Number(values["guest_count"]),
                        currency: "KES",
                        subtotal,
                        tax_rate: taxRate,
                        tax_amount: taxAmount,
                        service_charge_rate: 0,
                        service_charge_amount: 0,
                        discount_amount: 0,
                        grand_total: grandTotal,
                        deposit_percent: depositPercent,
                        deposit_amount: depositAmount,
                        balance_due: Math.round((grandTotal - depositAmount) * 100) / 100,
                      },
                      {
                        onSuccess: () => close(),
                      },
                    );
                  }}
                />
              )}
            </FormDialog>
          ) : null
        }
        description="Sent quotations are never overwritten â€” a revision supersedes the previous version and keeps its history."
      />

      {canCreate && !branchId ? <PropertyRequired what="A quotation" /> : null}

      <SectionCard
        title="Quotation register"
        description={`${rows.length} quotations for the selected property`}
      >
        <EventsQueryState
          isLoading={quotations.isLoading}
          error={quotations.error}
          isEmpty={rows.length === 0}
          empty={
            <EventsEmpty
              title="No quotations yet"
              description="Quote an enquiry to create the first quotation."
            />
          }
        >
          <DataTable
            head={[
              "Number",
              "Ver",
              "Title",
              "Client",
              "Event date",
              "Guests",
              "Total",
              "Deposit",
              "Status",
              "",
            ]}
          >
            {rows.map((q) => {
              const accepted = ["accepted", "approved"].includes(String(q["status"]));
              const link = links.data?.byQuotation.get(String(q["id"]));
              return (
                <tr key={String(q["id"])}>
                  <td className="py-2 pr-4 font-medium">{String(q["quotation_number"])}</td>
                  <td className="py-2 pr-4">{num(q["version"]) || 1}</td>
                  <td className="py-2 pr-4">{String(q["title"] || "â€”")}</td>
                  <td className="py-2 pr-4">
                    {String((q["customers"] as Row | null)?.["full_name"] ?? "â€”")}
                  </td>
                  <td className="py-2 pr-4">{formatDate(q["event_date"])}</td>
                  <td className="py-2 pr-4">{num(q["guest_count"])}</td>
                  <td className="py-2 pr-4">{formatMoney(symbol, q["grand_total"])}</td>
                  <td className="py-2 pr-4">{formatMoney(symbol, q["deposit_amount"])}</td>
                  <td className="py-2 pr-4">
                    <Pill tone={quotationTone(String(q["status"]))} value={String(q["status"])} />
                  </td>
                  <td className="space-x-2 whitespace-nowrap py-2 pr-4">
                    {link ? (
                      <>
                        <ConvertedEvent link={link} bookingId={link.bookingId} />
                        <ConversionBlocked reference={link.reference} />
                      </>
                    ) : canConvert && accepted ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={convert.isPending}
                        onClick={() => convert.mutate({ quotationId: String(q["id"]) })}
                      >
                        Convert to event
                      </Button>
                    ) : canConvert ? (
                      <span className="text-xs text-muted-foreground">
                        Accept the quotation to convert it
                      </span>
                    ) : null}
                    {canEdit ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={revise.isPending}
                        onClick={() => revise.mutate(q)}
                      >
                        Revise
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </DataTable>
        </EventsQueryState>
      </SectionCard>

      <SectionCard
        title="Quotation statuses"
        description="Only an accepted quotation can become an event"
      >
        <div className="flex flex-wrap gap-2">
          {QUOTATION_STATUSES.map((s) => (
            <Pill key={s} tone={quotationTone(s)} value={s} />
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
