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
  useConversionLinks,
  useConvertQuotation,
  useQuotations,
  useReviseQuotation,
} from "@/lib/events-data";

export const Route = createFileRoute("/_shell/events/quotations")({
  head: () => ({
    meta: [
      { title: "Event Quotations — NEØ" },
      {
        name: "description",
        content:
          "Versioned event quotations with deposits, balances and conversion to confirmed events.",
      },
      { property: "og:title", content: "Event Quotations — NEØ" },
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
  const quotations = useQuotations();
  const convert = useConvertQuotation();
  const revise = useReviseQuotation();
  const links = useConversionLinks();

  const rows = (quotations.data ?? []) as Row[];
  const canConvert = can("events", "quotations", "convert");
  const canEdit = can("events", "quotations", "edit");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Events & Banqueting"
        title="Quotations"
        description="Sent quotations are never overwritten — a revision supersedes the previous version and keeps its history."
      />

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
                  <td className="py-2 pr-4">{String(q["title"] || "—")}</td>
                  <td className="py-2 pr-4">
                    {String((q["customers"] as Row | null)?.["full_name"] ?? "—")}
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
