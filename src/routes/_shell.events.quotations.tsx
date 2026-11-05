import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
const db = supabase as any;
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
      { title: "Event Quotations ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â NEÃƒÆ’Ã‹Å“" },
      {
        name: "description",
        content:
          "Versioned event quotations with deposits, balances and conversion to confirmed events.",
      },
      { property: "og:title", content: "Event Quotations ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â NEÃƒÆ’Ã‹Å“" },
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


// E1C_QUOTATION_PRICING
type QuotationLine = {
  description: string;
  category: string;
  quantity: number;
  unit_price: number;
  unit: string;
  taxable: boolean;
};

function QuotationPricingEditor({
  quotation,
  onClose,
}: {
  quotation: Row;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const existing = (quotation["event_quotation_items"] ?? []) as Row[];

  const [lines, setLines] = useState<QuotationLine[]>(
    existing.length
      ? existing.map((item) => ({
          description: String(item["description"] ?? ""),
          category: String(item["category"] ?? "other"),
          quantity: Number(item["quantity"] ?? 1),
          unit_price: Number(item["unit_price"] ?? 0),
          unit: String(item["unit"] ?? "unit"),
          taxable: Boolean(item["taxable"] ?? true),
        }))
      : [{ description: "", category: "other", quantity: 1, unit_price: 0, unit: "unit", taxable: true }],
  );

  const [discount, setDiscount] = useState(Number(quotation["discount_amount"] ?? 0));
  const [taxRate, setTaxRate] = useState(Number(quotation["tax_rate"] ?? 0));
  const [serviceRate, setServiceRate] = useState(Number(quotation["service_charge_rate"] ?? 0));
  const [depositPercent, setDepositPercent] = useState(Number(quotation["deposit_percent"] ?? 50));

  const save = useMutation({
    mutationFn: async () => {
      if (!lines.length) throw new Error("Add at least one quotation item.");
      for (const line of lines) {
        if (!line.description.trim()) throw new Error("Each quotation item needs a description.");
        if (!Number.isFinite(line.quantity) || line.quantity <= 0)
          throw new Error("Item quantity must be greater than zero.");
        if (!Number.isFinite(line.unit_price) || line.unit_price < 0)
          throw new Error("Item price cannot be negative.");
      }

      for (const [value, label] of [
        [taxRate, "Tax"],
        [serviceRate, "Service charge"],
        [depositPercent, "Deposit"],
      ] as const) {
        if (!Number.isFinite(value) || value < 0 || value > 100)
          throw new Error(`${label} percentage must be between 0 and 100.`);
      }

      if (!Number.isFinite(discount) || discount < 0)
        throw new Error("Discount cannot be negative.");

      const { data, error } = await guardedRpc(supabase, "neo_event_quotation_price", {
        _quotation: String(quotation["id"]),
        _items: lines,
        _discount: discount,
        _tax_rate: taxRate,
        _service_rate: serviceRate,
        _deposit_percent: depositPercent,
      } as never);

      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      toast.success("Quotation pricing saved");
      onClose();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const subtotal = lines.reduce(
    (sum, line) => sum + line.quantity * line.unit_price,
    0,
  );

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {lines.map((line, index) => (
          <div key={index} className="grid grid-cols-12 gap-2 rounded-md border p-3">
            <Input
              className="col-span-12 sm:col-span-5"
              placeholder="Service or item description"
              value={line.description}
              onChange={(e) =>
                setLines((previous) =>
                  previous.map((item, i) =>
                    i === index ? { ...item, description: e.target.value } : item,
                  ),
                )
              }
            />
            <Input
              className="col-span-4 sm:col-span-2"
              type="number"
              min="0.01"
              step="0.01"
              value={line.quantity}
              onChange={(e) =>
                setLines((previous) =>
                  previous.map((item, i) =>
                    i === index ? { ...item, quantity: Number(e.target.value) } : item,
                  ),
                )
              }
            />
            <Input
              className="col-span-4 sm:col-span-3"
              type="number"
              min="0"
              step="0.01"
              value={line.unit_price}
              onChange={(e) =>
                setLines((previous) =>
                  previous.map((item, i) =>
                    i === index ? { ...item, unit_price: Number(e.target.value) } : item,
                  ),
                )
              }
            />
            <Button
              className="col-span-4 sm:col-span-2"
              variant="outline"
              type="button"
              disabled={lines.length === 1}
              onClick={() => setLines((previous) => previous.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>

      <Button
        type="button"
        variant="outline"
        onClick={() =>
          setLines((previous) => [
            ...previous,
            { description: "", category: "other", quantity: 1, unit_price: 0, unit: "unit", taxable: true },
          ])
        }
      >
        Add quotation item
      </Button>

      <div className="grid grid-cols-2 gap-3">
        {([
          ["Discount (KES)", discount, setDiscount],
          ["Tax (%)", taxRate, setTaxRate],
          ["Service charge (%)", serviceRate, setServiceRate],
          ["Deposit (%)", depositPercent, setDepositPercent],
        ] as const).map(([label, value, setter]) => (
          <label key={label} className="space-y-1 text-sm">
            <span>{label}</span>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={value}
              onChange={(e) => setter(Number(e.target.value))}
            />
          </label>
        ))}
      </div>

      <p className="text-sm font-medium">
        Item subtotal: KES {subtotal.toLocaleString("en-KE", { minimumFractionDigits: 2 })}
      </p>

      <Button
        type="button"
        disabled={save.isPending}
        onClick={() => save.mutate()}
      >
        {save.isPending ? "Saving..." : "Save quotation pricing"}
      </Button>
    </div>
  );
}
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
  const [pricingQuotation, setPricingQuotation] = useState<Row | null>(null);
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
        description="Sent quotations are never overwritten ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a revision supersedes the previous version and keeps its history."
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
                  <td className="py-2 pr-4">{String(q["title"] || "ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â")}</td>
                  <td className="py-2 pr-4">
                    {String((q["customers"] as Row | null)?.["full_name"] ?? "ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â")}
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
                    {canEdit && String(q["status"]) === "draft" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setPricingQuotation(q)}
                      >
                        Price quotation
                      </Button>
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

      {pricingQuotation ? (
        <SectionCard
          title={`Price quotation ${String(pricingQuotation["quotation_number"] ?? "")}`}
          description="Edit itemized prices while the quotation is in draft."
        >
          <QuotationPricingEditor
            key={String(pricingQuotation["id"])}
            quotation={pricingQuotation}
            onClose={() => setPricingQuotation(null)}
          />
          <Button
            type="button"
            variant="ghost"
            onClick={() => setPricingQuotation(null)}
          >
            Close editor
          </Button>
        </SectionCard>
      ) : null}
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
